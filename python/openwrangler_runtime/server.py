from __future__ import annotations

import json
import sys
import threading
import traceback
from collections.abc import Iterator, Mapping
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor, wait
from time import monotonic
from typing import Any

from .custom_code_output import isolate_standalone_protocol_output
from .engines import AmbiguousViewColumnError, EngineError
from .engines.base import LivePagePayloadError, validate_live_page_payload
from .protocol import ProtocolError, decode_envelope, error_response, response_envelope
from .session import (
    LiveSourceInvalidatedError,
    PySparkConnectStateLostError,
    PySparkConnectUnavailableError,
    SessionCleanupError,
    SessionManager,
    UnknownSessionError,
)

SHUTDOWN_GRACE_SECONDS = 1.5
MAX_REQUEST_FRAME_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_FRAME_BYTES = 17 * 1024 * 1024
MAX_TRANSPORT_ID_BYTES = 256
MAX_DIAGNOSTIC_BYTES = 4 * 1024
MAX_DIAGNOSTIC_DETAIL_BYTES = 16 * 1024
INTERACTIVE_WORKERS = 4
BACKGROUND_WORKERS = 2
MAX_INTERACTIVE_LIVE_REQUESTS = 64
MAX_BACKGROUND_LIVE_REQUESTS = 32
_RECOVERABLE_RESPONSE_REQUEST_KINDS = frozenset(
    {"initialize", "getPage", "getSummary", "getDatasetStats", "getColumnValues", "inspectStep"}
)


class _TerminalTransportError(Exception):
    """A framing or correlation failure after which stdin cannot be trusted."""


def dispatch(
    manager: SessionManager,
    request: dict[str, Any],
    request_id: str | None = None,
) -> dict[str, Any]:
    if request_id is not None:
        with manager.request_scope(request_id, request):
            return _dispatch(manager, request, request_id)
    return _dispatch(manager, request, None)


def _dispatch(
    manager: SessionManager,
    request: dict[str, Any],
    request_id: str | None,
) -> dict[str, Any]:
    kind = request.get("kind")
    if kind == "initialize":
        return manager.initialize()
    if kind == "openSession":
        return manager.open_session(
            request["source"],
            request.get("backend"),
            int(request.get("pageSize", 200)),
            request.get("mode"),
            request.get("requestedSessionId"),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
            request_id,
        )
    if kind == "getPage":
        return _with_view_request_id(
            manager.get_page(
                request["sessionId"],
                int(request["revision"]),
                int(request.get("offset", 0)),
                int(request.get("limit", 200)),
                request.get("filterModel", {"filters": [], "sort": []}),
                int(request["columnOffset"]),
                int(request["columnLimit"]),
            ),
            request,
        )
    if kind == "getSummary":
        return _with_view_request_id(
            manager.get_summary(
                request["sessionId"],
                int(request["revision"]),
                request.get("filterModel", {"filters": [], "sort": []}),
                request.get("columnIds"),
            ),
            request,
        )
    if kind == "getDatasetStats":
        return _with_view_request_id(
            manager.get_dataset_stats(
                request["sessionId"],
                int(request["revision"]),
                request.get("filterModel", {"filters": [], "sort": []}),
            ),
            request,
        )
    if kind == "getColumnValues":
        return _with_view_request_id(
            manager.get_column_values(
                request["sessionId"],
                int(request["revision"]),
                request["column"],
                request.get("filterModel", {"filters": [], "sort": []}),
                request.get("search"),
                int(request.get("limit", 100)),
            ),
            request,
        )
    if kind == "previewStep":
        return manager.preview_step(
            request["sessionId"],
            int(request["revision"]),
            request["step"],
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            request.get("replaceStepId"),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "inspectStep":
        return manager.inspect_step(
            request["sessionId"],
            int(request["revision"]),
            request["stepId"],
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "applyDraft":
        return manager.apply_draft(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "discardDraft":
        return manager.discard_draft(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "undoStep":
        return manager.undo_step(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "exportData":
        return manager.export_data(
            request["sessionId"],
            int(request["revision"]),
            request["path"],
            request["format"],
        )
    if kind == "closeSession":
        return manager.close_session(request["sessionId"], int(request["revision"]))
    raise ProtocolError(f"Unsupported request kind: {kind}")


def _with_view_request_id(response: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    correlated = dict(response)
    correlated["viewRequestId"] = request["viewRequestId"]
    return correlated


def main() -> int:
    protocol_output = isolate_standalone_protocol_output() if hasattr(sys.stdin, "buffer") else sys.stdout
    manager = SessionManager()
    write_lock = threading.Lock()
    pending_lock = threading.Lock()
    pending: dict[str, Future[dict[str, Any]]] = {}
    live_priorities: dict[str, str] = {}
    live_counts = {"interactive": 0, "background": 0}
    transport_failed = threading.Event()
    response_transport_errors: list[_TerminalTransportError] = []

    def fail_response_transport(error: _TerminalTransportError) -> None:
        transport_failed.set()
        response_transport_errors.append(error)
        _report_terminal_transport_error(error)
        try:
            protocol_output.close()
        except Exception:
            return

    def write(payload: dict[str, Any], request_kind: str | None) -> None:
        with write_lock:
            if transport_failed.is_set():
                return
            try:
                frame = _prepare_response_frame(
                    payload,
                    allow_recoverable_replacement=request_kind in _RECOVERABLE_RESPONSE_REQUEST_KINDS,
                )
            except _TerminalTransportError as error:
                fail_response_transport(error)
                return
            try:
                _write_response_frame(protocol_output, frame)
                protocol_output.flush()
            except (OSError, ValueError, UnicodeError):
                fail_response_transport(_TerminalTransportError("response frame publication failed"))

    def complete(
        request_id: str,
        view_request_id: str | None,
        request_kind: str,
        future: Future[dict[str, Any]],
    ) -> None:
        try:
            if future.cancelled():
                response = {"kind": "cancelled", "targetRequestId": request_id}
            else:
                try:
                    response = future.result()
                except CancelledError:
                    response = {"kind": "cancelled", "targetRequestId": request_id}
                except Exception as error:
                    response = _response_for_error(error)
            if response.get("kind") in {"error", "cancelled"} and view_request_id:
                response["viewRequestId"] = view_request_id
            write(response_envelope(request_id, response), request_kind)
        finally:
            _release_live_request(
                pending,
                live_priorities,
                live_counts,
                pending_lock,
                request_id,
            )

    interactive_executor = ThreadPoolExecutor(
        max_workers=INTERACTIVE_WORKERS,
        thread_name_prefix="openwrangler-interactive",
    )
    background_executor = ThreadPoolExecutor(
        max_workers=BACKGROUND_WORKERS,
        thread_name_prefix="openwrangler-background",
    )
    terminal_error: _TerminalTransportError | None = None
    try:
        for payload in _iter_request_payloads(sys.stdin):
            if transport_failed.is_set():
                break
            request_id = _request_id_for_payload(payload)
            if request_id is None:
                raise _TerminalTransportError("request frame has no bounded correlation ID")
            view_request_id = _view_request_id_for_payload(payload)
            request_kind: str | None = None
            if _is_live_request(live_priorities, pending_lock, request_id):
                raise _TerminalTransportError("request frame reused a live correlation ID")
            admitted = False
            submitted = False
            try:
                request_id, priority, request = decode_envelope(payload)
                request_kind = str(request["kind"])
                _validate_transport_ids(request_id, request)
                view_request_id = request.get("viewRequestId")
                if request["kind"] == "cancelRequest":
                    target = str(request["targetRequestId"])
                    if _cancel_pending_future(pending, pending_lock, target):
                        response = {"kind": "cancelled", "targetRequestId": target}
                    else:
                        response = error_response(
                            "The target request is already running, complete, or unknown and cannot be cancelled.",
                            code="cancellation_unavailable",
                        )
                    write(response_envelope(request_id, response), request_kind)
                    continue
                admission = _reserve_live_request(
                    live_priorities,
                    live_counts,
                    pending_lock,
                    request_id,
                    priority,
                )
                if admission == "duplicate":
                    raise _TerminalTransportError("request frame reused a live correlation ID")
                if admission == "capacity":
                    response = error_response(
                        f"The runtime has reached its bounded {priority} work limit; "
                        "retry after an earlier request completes.",
                        code="server_busy",
                    )
                    if view_request_id:
                        response["viewRequestId"] = view_request_id
                    write(response_envelope(request_id, response), request_kind)
                    continue
                admitted = True
                if request["kind"] == "openSession":
                    # CPython imports and native backend initialization must
                    # run on this process-owned thread. In particular, loading
                    # Pandas after Polars from a Windows worker can deadlock.
                    manager.prepare_backend(request["source"], request.get("backend"))
                executor = background_executor if priority == "background" else interactive_executor
                future = executor.submit(dispatch, manager, request, request_id)
                with pending_lock:
                    pending[request_id] = future
                future.add_done_callback(
                    lambda done, current=request_id, view=view_request_id, operation=str(request["kind"]): complete(
                        current, view, operation, done
                    )
                )
                submitted = True
            except _TerminalTransportError:
                raise
            except Exception as error:
                response = _response_for_error(error)
                if view_request_id:
                    response["viewRequestId"] = view_request_id
                write(response_envelope(request_id, response), request_kind)
            finally:
                if admitted and not submitted:
                    _release_live_request(
                        pending,
                        live_priorities,
                        live_counts,
                        pending_lock,
                        request_id,
                    )
    except _TerminalTransportError as error:
        terminal_error = error
        transport_failed.set()
        _report_terminal_transport_error(error)
    finally:
        _shutdown_runtime(
            manager,
            (interactive_executor, background_executor),
            pending,
            pending_lock,
        )
    return 1 if terminal_error is not None or response_transport_errors else 0


def _shutdown_runtime(
    manager: SessionManager,
    executors: tuple[ThreadPoolExecutor, ...],
    pending: dict[str, Future[dict[str, Any]]],
    pending_lock: threading.Lock,
) -> None:
    """Begin cleanup immediately at EOF and wait only for the shutdown grace."""
    with pending_lock:
        futures = list(pending.values())

    # Cancel work that has not acquired a worker before session cleanup can
    # dispose its engine. Running work is handled by SessionManager.close_all,
    # which interrupts only engines that explicitly advertise that ability.
    for future in futures:
        future.cancel()
    for executor in executors:
        executor.shutdown(wait=False, cancel_futures=True)

    cleanup_complete = threading.Event()

    def close_manager() -> None:
        try:
            manager.close_all()
        finally:
            cleanup_complete.set()

    cleanup_thread = threading.Thread(
        target=close_manager,
        name="openwrangler-runtime-cleanup",
        daemon=True,
    )
    cleanup_thread.start()

    deadline = monotonic() + SHUTDOWN_GRACE_SECONDS
    cleanup_complete.wait(max(0.0, deadline - monotonic()))
    wait(futures, timeout=max(0.0, deadline - monotonic()))


def _cancel_pending_future(
    pending: dict[str, Future[dict[str, Any]]],
    pending_lock: threading.Lock,
    target_request_id: str,
) -> bool:
    """Cancel only work that has not started; running results remain authoritative."""
    with pending_lock:
        future = pending.get(target_request_id)
    return bool(future is not None and future.cancel())


def _iter_request_payloads(stream: Any) -> Iterator[Any]:
    source = getattr(stream, "buffer", stream)
    readline = getattr(source, "readline", None)
    if callable(readline):
        while True:
            frame = readline(MAX_REQUEST_FRAME_BYTES + 1)
            if frame == b"" or frame == "":
                return
            payload = _decode_request_frame(frame)
            if payload is not None:
                yield payload
    else:
        for frame in source:
            payload = _decode_request_frame(frame)
            if payload is not None:
                yield payload


def _decode_request_frame(frame: Any) -> Any | None:
    if isinstance(frame, str):
        try:
            encoded = frame.encode("utf-8")
        except UnicodeEncodeError as error:
            raise _TerminalTransportError("request frame is not valid UTF-8") from error
    elif isinstance(frame, (bytes, bytearray)):
        encoded = bytes(frame)
    else:
        raise _TerminalTransportError("stdin returned a non-byte request frame")
    if len(encoded) > MAX_REQUEST_FRAME_BYTES:
        raise _TerminalTransportError(f"request frame exceeds the {MAX_REQUEST_FRAME_BYTES}-byte limit including LF")
    if not encoded.endswith(b"\n"):
        raise _TerminalTransportError("request frame ended before its LF terminator")
    try:
        text = encoded.decode("utf-8")
    except UnicodeDecodeError as error:
        raise _TerminalTransportError("request frame is not valid UTF-8") from error
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, RecursionError) as error:
        raise _TerminalTransportError("request frame is not valid JSON") from error


def _request_id_for_payload(payload: Any) -> str | None:
    if not isinstance(payload, Mapping):
        return None
    request_id = payload.get("requestId")
    return request_id if _is_bounded_transport_id(request_id) else None


def _view_request_id_for_payload(payload: Any) -> str | None:
    if not isinstance(payload, Mapping):
        return None
    request = payload.get("request")
    if not isinstance(request, Mapping):
        return None
    view_request_id = request.get("viewRequestId")
    return view_request_id if _is_bounded_transport_id(view_request_id) else None


def _validate_transport_ids(request_id: str, request: Mapping[str, Any]) -> None:
    if not _is_bounded_transport_id(request_id):
        raise ProtocolError(f"requestId must not exceed {MAX_TRANSPORT_ID_BYTES} UTF-8 bytes.")
    for field in ("sessionId", "requestedSessionId", "viewRequestId", "targetRequestId"):
        if field in request and not _is_bounded_transport_id(request[field]):
            raise ProtocolError(f"{field} must not exceed {MAX_TRANSPORT_ID_BYTES} UTF-8 bytes.")


def _is_bounded_transport_id(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return len(value.encode("utf-8")) <= MAX_TRANSPORT_ID_BYTES
    except UnicodeEncodeError:
        return False


def _is_live_request(
    live_priorities: Mapping[str, str],
    pending_lock: threading.Lock,
    request_id: str,
) -> bool:
    with pending_lock:
        return request_id in live_priorities


def _reserve_live_request(
    live_priorities: dict[str, str],
    live_counts: dict[str, int],
    pending_lock: threading.Lock,
    request_id: str,
    priority: str,
) -> str:
    with pending_lock:
        if request_id in live_priorities:
            return "duplicate"
        limit = MAX_BACKGROUND_LIVE_REQUESTS if priority == "background" else MAX_INTERACTIVE_LIVE_REQUESTS
        if live_counts[priority] >= limit:
            return "capacity"
        live_priorities[request_id] = priority
        live_counts[priority] += 1
    return "admitted"


def _release_live_request(
    pending: dict[str, Future[dict[str, Any]]],
    live_priorities: dict[str, str],
    live_counts: dict[str, int],
    pending_lock: threading.Lock,
    request_id: str,
) -> None:
    with pending_lock:
        pending.pop(request_id, None)
        priority = live_priorities.pop(request_id, None)
        if priority is not None:
            live_counts[priority] -= 1


def _response_for_error(error: Exception) -> dict[str, Any]:
    message = _bounded_diagnostic(str(error), MAX_DIAGNOSTIC_BYTES)
    if isinstance(error, ProtocolError):
        return error_response(message, code="invalid_request", recoverable=False)
    if isinstance(error, UnknownSessionError):
        return error_response(message, code="unknown_session", session_id=error.session_id)
    if isinstance(error, LiveSourceInvalidatedError):
        return error_response(message, code="live_source_invalidated", session_id=error.session_id)
    if isinstance(error, PySparkConnectUnavailableError):
        return error_response(message, code="pyspark_connect_unavailable", session_id=error.session_id)
    if isinstance(error, PySparkConnectStateLostError):
        return error_response(message, code="pyspark_connect_state_lost", session_id=error.session_id)
    if isinstance(error, SessionCleanupError):
        return error_response(
            message,
            code="session_cleanup_failed",
            recoverable=False,
            session_id=error.session_id,
        )
    if isinstance(error, AmbiguousViewColumnError):
        return error_response(message, code="ambiguous_view_column")
    if isinstance(error, LivePagePayloadError):
        return error_response(message, code="page_payload_invalid")
    if isinstance(error, EngineError):
        return error_response(message, code="engine_error")
    return error_response(
        message,
        detail=_bounded_diagnostic(traceback.format_exc(), MAX_DIAGNOSTIC_DETAIL_BYTES),
    )


def _validate_outgoing_live_pages(payload: Mapping[str, Any]) -> None:
    response = payload.get("response")
    if not isinstance(response, Mapping):
        return
    for field in ("page", "inputPage", "outputPage"):
        if field in response:
            validate_live_page_payload(response[field])


def _prepare_response_frame(
    payload: Mapping[str, Any],
    *,
    allow_recoverable_replacement: bool,
) -> bytes:
    try:
        _validate_outgoing_live_pages(payload)
    except LivePagePayloadError as error:
        if not allow_recoverable_replacement:
            raise _TerminalTransportError("response page validation failed after mutation-capable work") from error
        payload = _page_payload_error_envelope(payload, error)

    try:
        frame = _serialize_response_frame(payload)
    except (TypeError, ValueError, UnicodeError, RecursionError) as error:
        if not allow_recoverable_replacement:
            raise _TerminalTransportError("response serialization failed after mutation-capable work") from error
        payload = _response_payload_error_envelope(payload)
        frame = _serialize_response_frame(payload)
    if len(frame) <= MAX_RESPONSE_FRAME_BYTES:
        return frame
    if not allow_recoverable_replacement:
        raise _TerminalTransportError("response frame exceeded its bound after mutation-capable work")
    frame = _serialize_response_frame(_response_frame_error_envelope(payload))
    if len(frame) > MAX_RESPONSE_FRAME_BYTES:
        raise _TerminalTransportError("bounded response error exceeded the response-frame limit")
    return frame


def _page_payload_error_envelope(
    payload: Mapping[str, Any],
    error: LivePagePayloadError,
) -> dict[str, Any]:
    request_id = _request_id_for_payload(payload)
    if request_id is None:
        raise _TerminalTransportError("response payload has no bounded correlation ID")
    failure = _response_for_error(error)
    _copy_bounded_view_request_id(payload, failure)
    return response_envelope(request_id, failure)


def _response_payload_error_envelope(payload: Mapping[str, Any]) -> dict[str, Any]:
    request_id = _request_id_for_payload(payload)
    if request_id is None:
        raise _TerminalTransportError("response payload has no bounded correlation ID")
    failure = error_response(
        "The runtime produced a response that is not strict UTF-8 JSON.",
        code="response_payload_invalid",
    )
    _copy_bounded_view_request_id(payload, failure)
    return response_envelope(request_id, failure)


def _response_frame_error_envelope(payload: Mapping[str, Any]) -> dict[str, Any]:
    request_id = _request_id_for_payload(payload)
    if request_id is None:
        raise _TerminalTransportError("response payload has no bounded correlation ID")
    failure = error_response(
        f"The runtime response exceeds the {MAX_RESPONSE_FRAME_BYTES:,}-byte limit including LF. "
        "Request fewer rows or columns, or shorten large values.",
        code="response_frame_too_large",
    )
    _copy_bounded_view_request_id(payload, failure)
    return response_envelope(request_id, failure)


def _copy_bounded_view_request_id(payload: Mapping[str, Any], failure: dict[str, Any]) -> None:
    response = payload.get("response")
    if not isinstance(response, Mapping):
        return
    view_request_id = response.get("viewRequestId")
    if _is_bounded_transport_id(view_request_id):
        failure["viewRequestId"] = view_request_id


def _serialize_response_frame(payload: Mapping[str, Any]) -> bytes:
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return serialized.encode("utf-8") + b"\n"


def _write_response_frame(stream: Any, frame: bytes) -> None:
    binary_stream = getattr(stream, "buffer", None)
    if binary_stream is not None:
        written = binary_stream.write(frame)
        if written != len(frame):
            raise OSError("response frame publication was incomplete")
        return
    text = frame.decode("utf-8")
    written = stream.write(text)
    if written != len(text):
        raise OSError("response frame publication was incomplete")


def _bounded_diagnostic(value: str, maximum_bytes: int) -> str:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= maximum_bytes:
        return value
    suffix = b"...[truncated]"
    prefix = encoded[: maximum_bytes - len(suffix)].decode("utf-8", errors="ignore")
    return f"{prefix}{suffix.decode('ascii')}"


def _report_terminal_transport_error(error: _TerminalTransportError) -> None:
    diagnostic = _bounded_diagnostic(str(error), MAX_DIAGNOSTIC_BYTES)
    try:
        sys.stderr.write(f"Open Wrangler runtime transport error: {diagnostic}\n")
        sys.stderr.flush()
    except Exception:
        return


if __name__ == "__main__":
    raise SystemExit(main())
