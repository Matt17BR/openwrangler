from __future__ import annotations

import json
import traceback
from collections import OrderedDict
from collections.abc import Mapping
from concurrent.futures import CancelledError
from threading import Lock

from .engines import AmbiguousViewColumnError, EngineError
from .protocol import ProtocolError, decode_envelope, error_response, response_envelope
from .response_framing import (
    MAX_RESPONSE_FRAME_BYTES,
    ResponseEncodingError,
    ResponseFrameTooLargeError,
    encode_response_frame,
)
from .server import MAX_TRANSPORT_ID_BYTES, dispatch
from .session import (
    LiveSourceInvalidatedError,
    PySparkConnectStateLostError,
    PySparkConnectUnavailableError,
    ResponsePayloadError,
    SessionCleanupError,
    SessionManager,
    UnknownSessionError,
)

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


class _NotebookRequestRegistry:
    """Track the bounded lifecycle visible to concurrent notebook dispatches."""

    def __init__(self, completed_limit: int = _COMPLETED_REQUEST_HISTORY_LIMIT) -> None:
        self._completed_limit = completed_limit
        self._lock = Lock()
        self._live: dict[str, str] = {}
        self._completed: OrderedDict[str, None] = OrderedDict()

    def queue(self, request_id: str) -> None:
        with self._lock:
            if request_id in self._live:
                raise ProtocolError("requestId is already active in the notebook runtime.")
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
_dispatch_lock = Lock()


def dispatch_json(payload: str) -> str:
    """Dispatch an Open Wrangler request inside the active Jupyter kernel."""
    request_id = _safe_request_id(payload)
    request_kind: str | None = None
    view_request_id = _safe_view_request_id(payload)
    try:
        candidate_request_id, _, request = decode_envelope(json.loads(payload))
        if _bounded_transport_id(candidate_request_id) is None:
            raise ProtocolError(f"requestId must not exceed {MAX_TRANSPORT_ID_BYTES} UTF-8 bytes.")
        request_id = candidate_request_id
        request_kind = request["kind"]
        view_request_id = request.get("viewRequestId")
        if request_kind == "cancelRequest":
            response = _cancel_request(request["targetRequestId"])
        else:
            response = _dispatch_request(request_id, request)
        return _encode_response(request_id, response)
    except CancelledError:
        response = {"kind": "cancelled", "targetRequestId": request_id}
    except ProtocolError as error:
        response = error_response(str(error), code="invalid_request", recoverable=False)
    except UnknownSessionError as error:
        response = error_response(str(error), code="unknown_session", session_id=error.session_id)
    except LiveSourceInvalidatedError as error:
        response = error_response(str(error), code="live_source_invalidated", session_id=error.session_id)
    except PySparkConnectUnavailableError as error:
        response = error_response(str(error), code="pyspark_connect_unavailable", session_id=error.session_id)
    except PySparkConnectStateLostError as error:
        response = error_response(str(error), code="pyspark_connect_state_lost", session_id=error.session_id)
    except SessionCleanupError as error:
        response = error_response(
            str(error),
            code="session_cleanup_failed",
            recoverable=False,
            session_id=error.session_id,
        )
    except ResponsePayloadError as error:
        response = error_response(str(error), code=error.code)
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
    except AmbiguousViewColumnError as error:
        response = error_response(str(error), code="ambiguous_view_column")
    except EngineError as error:
        response = error_response(str(error), code="engine_error")
    except Exception as error:
        response = error_response(str(error), detail=traceback.format_exc())
    if view_request_id:
        response["viewRequestId"] = view_request_id
    return _encode_response(request_id, response)


def _dispatch_request(request_id: str, request: dict[str, object]) -> dict[str, object]:
    _request_registry.queue(request_id)
    try:
        with _dispatch_lock:
            if not _request_registry.start(request_id):
                raise CancelledError
            return dispatch(_manager, request, request_id)
    finally:
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
    frame = encode_response_frame(
        response_envelope(request_id, response),
        MAX_RESPONSE_FRAME_BYTES,
    )
    return frame[:-1].decode("utf-8")


def _safe_request_id(payload: str) -> str:
    try:
        decoded = json.loads(payload)
        if isinstance(decoded, dict):
            request_id = _bounded_transport_id(decoded.get("requestId"))
            if request_id is not None:
                return request_id
    except Exception:
        pass
    return "unknown"


def _bounded_transport_id(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return value if len(value.encode("utf-8")) <= MAX_TRANSPORT_ID_BYTES else None
    except UnicodeEncodeError:
        return None


def _safe_view_request_id(payload: str) -> str | None:
    try:
        decoded = json.loads(payload)
        if isinstance(decoded, dict) and isinstance(decoded.get("request"), dict):
            view_request_id = decoded["request"].get("viewRequestId")
            return _bounded_transport_id(view_request_id)
    except Exception:
        pass
    return None
