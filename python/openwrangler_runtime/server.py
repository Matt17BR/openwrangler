from __future__ import annotations

import sys
import threading
from collections.abc import Callable, Iterator, Mapping
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor, wait
from contextlib import suppress
from time import monotonic
from typing import Any

from .custom_code_output import isolate_standalone_protocol_output
from .protocol import (
    MAX_DIAGNOSTIC_BYTES,
    MAX_REQUEST_FRAME_BYTES,
    ProtocolError,
    RequestFrameError,
    bounded_diagnostic,
    decode_envelope,
    decode_request_payload,
    error_response,
    request_id_for_payload,
    response_envelope,
    response_for_error,
    view_request_id_for_payload,
)
from .response_framing import (
    MAX_RESPONSE_FRAME_BYTES,
    ResponseEncodingError,
    ResponseFrameTooLargeError,
    encode_response_frame,
    strict_json_byte_length,
)
from .session import (
    ResponsePayloadError,
    SessionManager,
)

SHUTDOWN_GRACE_SECONDS = 1.5
INTERACTIVE_WORKERS = 4
BACKGROUND_WORKERS = 2
MAX_INTERACTIVE_LIVE_REQUESTS = 64
MAX_BACKGROUND_LIVE_REQUESTS = 32


class _TerminalTransportError(Exception):
    """A framing or correlation failure after which stdin cannot be trusted."""


class _ResponsePublisher:
    """Serialize and publish exact bounded stdout frames through one writer."""

    def __init__(
        self,
        stream: Any,
        write_lock: threading.Lock,
        transport_failed: threading.Event,
        on_terminal_failure: Callable[[_TerminalTransportError], None],
    ) -> None:
        self._stream = stream
        self._write_lock = write_lock
        self._transport_failed = transport_failed
        self._on_terminal_failure = on_terminal_failure

    def publish(self, payload: dict[str, Any]) -> bool:
        failure: _TerminalTransportError | None = None
        with self._write_lock:
            if self._transport_failed.is_set():
                return False
            try:
                frame = encode_response_frame(payload, MAX_RESPONSE_FRAME_BYTES)
            except ResponseFrameTooLargeError:
                failure = _TerminalTransportError(
                    f"response frame exceeds the {MAX_RESPONSE_FRAME_BYTES}-byte limit including LF"
                )
            except ResponseEncodingError:
                failure = _TerminalTransportError("response frame is not valid strict JSON")
            except Exception:
                failure = _TerminalTransportError("response frame is not valid strict JSON")
            else:
                try:
                    self._write_exact_frame(frame)
                except Exception:
                    failure = _TerminalTransportError("response frame could not be published")
            if failure is not None:
                self._transport_failed.set()
                self._close_real_stream()
        if failure is not None:
            self._on_terminal_failure(failure)
            return False
        return True

    def fail(self, error: _TerminalTransportError) -> None:
        should_report = False
        with self._write_lock:
            if not self._transport_failed.is_set():
                self._transport_failed.set()
                self._close_real_stream()
                should_report = True
        if should_report:
            self._on_terminal_failure(error)

    def _write_exact_frame(self, frame: bytes) -> None:
        binary_stream = getattr(self._stream, "buffer", None)
        if binary_stream is not None and callable(getattr(binary_stream, "write", None)):
            written = binary_stream.write(frame)
            if written != len(frame):
                raise OSError("short response-frame write")
            binary_stream.flush()
            return
        text = frame.decode("utf-8")
        written = self._stream.write(text)
        if written != len(text):
            raise OSError("short response-frame write")
        self._stream.flush()

    def _close_real_stream(self) -> None:
        try:
            self._stream.fileno()
        except (AttributeError, OSError):
            return
        binary_stream = getattr(self._stream, "buffer", None)
        raw_stream = getattr(binary_stream, "raw", None)
        if raw_stream is not None and callable(getattr(raw_stream, "close", None)):
            with suppress(Exception):
                # Closing the raw dedicated descriptor avoids flushing a
                # buffered partial frame after publication has already failed.
                raw_stream.close()
            return
        try:
            self._stream.close()
        except Exception:
            return


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
    response_preflight = _mutation_response_preflight(request_id)
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
            request.get("cloneFrom"),
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
            response_preflight=response_preflight,
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
            response_preflight=response_preflight,
        )
    if kind == "discardDraft":
        return manager.discard_draft(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
            response_preflight=response_preflight,
        )
    if kind == "undoStep":
        return manager.undo_step(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
            response_preflight=response_preflight,
        )
    if kind == "exportData":
        return manager.export_data(
            request["sessionId"],
            int(request["revision"]),
            request["path"],
            request["options"],
            request["targetIdentity"],
        )
    if kind == "closeSession":
        return manager.close_session(request["sessionId"], int(request["revision"]))
    raise ProtocolError(f"Unsupported request kind: {kind}")


def _with_view_request_id(response: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    correlated = dict(response)
    correlated["viewRequestId"] = request["viewRequestId"]
    return correlated


def _mutation_response_preflight(request_id: str | None) -> Callable[[dict[str, Any]], None] | None:
    if request_id is None:
        return None

    def preflight(response: dict[str, Any]) -> None:
        envelope = response_envelope(request_id, response)
        try:
            payload_size = strict_json_byte_length(envelope, MAX_RESPONSE_FRAME_BYTES - 1)
        except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError) as error:
            raise ResponsePayloadError(
                "The correlated mutation response could not be encoded as strict JSON. Request fewer rows or columns.",
                "response_encoding_failed",
            ) from error
        if payload_size + 1 > MAX_RESPONSE_FRAME_BYTES:
            raise ResponsePayloadError(
                "The correlated mutation response exceeds the "
                f"{MAX_RESPONSE_FRAME_BYTES:,}-byte transport frame limit including LF. "
                "Request fewer rows or columns.",
                "response_too_large",
            )

    return preflight


def main() -> int:
    protocol_output = isolate_standalone_protocol_output() if hasattr(sys.stdin, "buffer") else sys.stdout
    manager = SessionManager()
    write_lock = threading.Lock()
    pending_lock = threading.Lock()
    pending: dict[str, Future[dict[str, Any]]] = {}
    live_priorities: dict[str, str] = {}
    live_counts = {"interactive": 0, "background": 0}
    transport_failed = threading.Event()
    terminal_error: _TerminalTransportError | None = None
    terminal_error_lock = threading.Lock()

    def record_terminal_failure(error: _TerminalTransportError) -> None:
        nonlocal terminal_error
        with terminal_error_lock:
            if terminal_error is not None:
                return
            terminal_error = error
        _report_terminal_transport_error(error)

    publisher = _ResponsePublisher(
        protocol_output,
        write_lock,
        transport_failed,
        record_terminal_failure,
    )

    def complete(request_id: str, view_request_id: str | None, future: Future[dict[str, Any]]) -> None:
        try:
            if future.cancelled():
                response = {"kind": "cancelled", "targetRequestId": request_id}
            else:
                try:
                    response = future.result()
                except CancelledError:
                    response = {"kind": "cancelled", "targetRequestId": request_id}
                except Exception as error:
                    response = response_for_error(error)
            if response.get("kind") in {"error", "cancelled"} and view_request_id:
                response["viewRequestId"] = view_request_id
            publisher.publish(response_envelope(request_id, response))
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
    try:
        for payload in _iter_request_payloads(sys.stdin):
            if transport_failed.is_set():
                break
            request_id = request_id_for_payload(payload)
            if request_id is None:
                raise _TerminalTransportError("request frame has no bounded correlation ID")
            view_request_id = view_request_id_for_payload(payload)
            if _is_live_request(live_priorities, pending_lock, request_id):
                raise _TerminalTransportError("request frame reused a live correlation ID")
            admitted = False
            submitted = False
            try:
                request_id, priority, request = decode_envelope(payload)
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
                    if not publisher.publish(response_envelope(request_id, response)):
                        break
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
                    if not publisher.publish(response_envelope(request_id, response)):
                        break
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
                    lambda done, current=request_id, view=view_request_id: complete(current, view, done)
                )
                submitted = True
            except _TerminalTransportError:
                raise
            except Exception as error:
                response = response_for_error(error)
                if view_request_id:
                    response["viewRequestId"] = view_request_id
                if not publisher.publish(response_envelope(request_id, response)):
                    break
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
        publisher.fail(error)
    finally:
        _shutdown_runtime(
            manager,
            (interactive_executor, background_executor),
            pending,
            pending_lock,
        )
    return 1 if transport_failed.is_set() or terminal_error is not None else 0


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
    try:
        return decode_request_payload(
            frame,
            lf_terminated=True,
            maximum_bytes=MAX_REQUEST_FRAME_BYTES,
        )
    except RequestFrameError as error:
        raise _TerminalTransportError(str(error)) from error


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


def _report_terminal_transport_error(error: _TerminalTransportError) -> None:
    diagnostic = bounded_diagnostic(str(error), MAX_DIAGNOSTIC_BYTES)
    try:
        sys.stderr.write(f"Open Wrangler runtime transport error: {diagnostic}\n")
        sys.stderr.flush()
    except Exception:
        return


if __name__ == "__main__":
    raise SystemExit(main())
