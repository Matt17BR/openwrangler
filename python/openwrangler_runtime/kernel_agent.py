from __future__ import annotations

from collections import OrderedDict
from collections.abc import Mapping
from concurrent.futures import CancelledError
from threading import Lock

from .protocol import (
    MAX_REQUEST_FRAME_BYTES,
    decode_envelope,
    decode_request_payload,
    encode_response_envelope,
    error_response,
    request_id_for_payload,
    response_for_error,
    view_request_id_for_payload,
)
from .response_framing import (
    MAX_RESPONSE_FRAME_BYTES,
    ResponseEncodingError,
    ResponseFrameTooLargeError,
)
from .server import dispatch
from .session import SessionManager

_RECOVERABLE_RESPONSE_ENCODING_KINDS = {
    "initialize",
    "getPage",
    "getSummary",
    "getDatasetStats",
    "getColumnValues",
    "inspectStep",
    "cancelRequest",
}
_COMPLETED_REQUEST_HISTORY_LIMIT = 256


class _DuplicateActiveRequestIdError(RuntimeError):
    """Reject a second envelope without publishing under an active correlation ID."""


class _NotebookRequestRegistry:
    """Track the bounded lifecycle visible to concurrent notebook dispatches."""

    def __init__(self, completed_limit: int = _COMPLETED_REQUEST_HISTORY_LIMIT) -> None:
        self._completed_limit = completed_limit
        self._lock = Lock()
        self._live: dict[str, str] = {}
        self._completed: OrderedDict[str, None] = OrderedDict()

    def admit(self, request_id: str) -> None:
        with self._lock:
            if request_id in self._live:
                raise _DuplicateActiveRequestIdError("requestId is already active in the notebook runtime.")
            self._completed.pop(request_id, None)
            self._live[request_id] = "queued"

    def start(self, request_id: str) -> bool:
        with self._lock:
            state = self._live.get(request_id)
            if state == "cancelled":
                return False
            if state != "queued":
                raise RuntimeError("Notebook request left the queued state before dispatch.")
            self._live[request_id] = "running"
            return True

    def complete(self, request_id: str) -> None:
        with self._lock:
            self._live.pop(request_id, None)
            self._completed[request_id] = None
            self._completed.move_to_end(request_id)
            while len(self._completed) > self._completed_limit:
                self._completed.popitem(last=False)

    def cancel(self, request_id: str) -> str:
        with self._lock:
            state = self._live.get(request_id)
            if state == "queued":
                self._live[request_id] = "cancelled"
                return "cancelled"
            if state is not None:
                return state
            if request_id in self._completed:
                self._completed.move_to_end(request_id)
                return "completed"
            return "unknown"

    def state(self, request_id: str) -> str:
        with self._lock:
            state = self._live.get(request_id)
            if state is not None:
                return state
            return "completed" if request_id in self._completed else "unknown"


_manager = SessionManager()
_request_registry = _NotebookRequestRegistry()


def dispatch_json(payload: str) -> str:
    """Dispatch an Open Wrangler request inside the active Jupyter kernel."""
    request_id = "unknown"
    request_kind: str | None = None
    view_request_id: str | None = None
    admitted = False
    try:
        try:
            decoded = decode_request_payload(
                payload,
                lf_terminated=False,
                maximum_bytes=MAX_REQUEST_FRAME_BYTES,
            )
            candidate_request_id = request_id_for_payload(decoded)
            view_request_id = view_request_id_for_payload(decoded)
            if candidate_request_id is not None:
                request_id = candidate_request_id
                _request_registry.admit(request_id)
                admitted = True
                if not _request_registry.start(request_id):
                    raise CancelledError
            candidate_request_id, _, request = decode_envelope(decoded)
            request_id = candidate_request_id
            request_kind = request["kind"]
            view_request_id = request.get("viewRequestId")
            if request_kind == "cancelRequest":
                response = _cancel_request(request["targetRequestId"])
            else:
                response = dispatch(_manager, request, request_id)
            return _encode_response(request_id, response)
        except _DuplicateActiveRequestIdError:
            # A response carrying the reused ID would be indistinguishable from the
            # original request's authoritative response. Let the duplicate kernel
            # execution fail without publishing a second runtime envelope.
            raise
        except CancelledError:
            response = {"kind": "cancelled", "targetRequestId": request_id}
        except ResponseFrameTooLargeError:
            if request_kind not in _RECOVERABLE_RESPONSE_ENCODING_KINDS:
                raise
            response = error_response(
                "The runtime response exceeds the bounded transport frame limit.",
                code="response_too_large",
            )
        except ResponseEncodingError:
            if request_kind not in _RECOVERABLE_RESPONSE_ENCODING_KINDS:
                raise
            response = error_response(
                "The runtime response could not be encoded as strict JSON.",
                code="response_encoding_failed",
            )
        except Exception as error:
            response = response_for_error(error)
        if view_request_id:
            response["viewRequestId"] = view_request_id
        return _encode_response(request_id, response)
    finally:
        if admitted:
            _request_registry.complete(request_id)


def _cancel_request(target_request_id: str) -> dict[str, object]:
    state = _request_registry.cancel(target_request_id)
    if state == "cancelled":
        return {"kind": "cancelled", "targetRequestId": target_request_id}
    if state == "running":
        message = (
            "The target request is already running and cannot be interrupted; "
            "its original correlated response remains authoritative."
        )
    elif state == "completed":
        message = "The target request has already completed; its original correlated response remains authoritative."
    else:
        message = "The target request is unknown and cannot be cancelled."
    return error_response(message, code="cancellation_unavailable")


def _encode_response(request_id: str, response: Mapping[str, object]) -> str:
    frame = encode_response_envelope(
        request_id,
        response,
        MAX_RESPONSE_FRAME_BYTES,
    )
    return frame[:-1].decode("utf-8")
