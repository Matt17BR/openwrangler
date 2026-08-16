from __future__ import annotations

import json
import subprocess
import sys
import threading
from codecs import getincrementaldecoder
from concurrent.futures import Future
from contextlib import contextmanager, suppress
from importlib.util import find_spec
from io import BytesIO, StringIO, TextIOWrapper
from pathlib import Path
from queue import Empty, Full, Queue
from typing import Any

import pytest

import openwrangler_runtime.server as server


class _PassthroughRequestScope:
    @contextmanager
    def request_scope(self, _request_id: str, _request: dict[str, Any]):
        yield


class _BinaryInput:
    def __init__(self, payload: bytes) -> None:
        self.buffer = BytesIO(payload)


class _ServerOutputPumps:
    def __init__(self, process: subprocess.Popen[str]) -> None:
        stdout = process.stdout
        stderr = process.stderr
        assert stdout is not None
        assert stderr is not None
        self._responses: Queue[str | BaseException | None] = Queue(maxsize=16)
        self._stderr_lock = threading.Lock()
        self._stderr_tail = ""
        self._stdout_error: BaseException | None = None
        self._stderr_error: BaseException | None = None

        def publish_stdout(value: str | BaseException | None) -> None:
            while True:
                try:
                    self._responses.put_nowait(value)
                    return
                except Full:
                    with suppress(Empty):
                        self._responses.get_nowait()

        def read_stdout() -> None:
            try:
                for line in stdout:
                    publish_stdout(line)
            except BaseException as error:  # pragma: no cover - defensive stream failure
                self._stdout_error = error
                publish_stdout(error)
            finally:
                publish_stdout(None)

        def drain_stderr() -> None:
            try:
                assert isinstance(stderr, TextIOWrapper)
                decoder = getincrementaldecoder(stderr.encoding or "utf-8")(errors="replace")
                while chunk := stderr.buffer.read1(4_096):
                    with self._stderr_lock:
                        self._stderr_tail = f"{self._stderr_tail}{decoder.decode(chunk)}"[-16_384:]
                final_text = decoder.decode(b"", final=True)
                if final_text:
                    with self._stderr_lock:
                        self._stderr_tail = f"{self._stderr_tail}{final_text}"[-16_384:]
            except BaseException as error:  # pragma: no cover - defensive stream failure
                self._stderr_error = error
                with self._stderr_lock:
                    self._stderr_tail = f"{self._stderr_tail}\nStderr pump failed: {error}"[-16_384:]

        self._stdout_thread = threading.Thread(target=read_stdout, daemon=True)
        self._stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()

    def stderr_tail(self) -> str:
        with self._stderr_lock:
            return self._stderr_tail

    def read_response(self, timeout: float = 60.0) -> dict[str, Any]:
        try:
            value = self._responses.get(timeout=timeout)
        except Empty as error:
            raise TimeoutError(
                f"Runtime server did not answer within {timeout:g} seconds.\n{self.stderr_tail()}"
            ) from error
        if isinstance(value, BaseException):
            raise value
        if value is None:
            raise AssertionError(f"Runtime server closed stdout before responding.\n{self.stderr_tail()}")
        try:
            return json.loads(value)
        except json.JSONDecodeError as error:
            raise AssertionError(f"Runtime server returned malformed JSON.\n{self.stderr_tail()}") from error

    def join(self, timeout: float = 5.0) -> None:
        self._stdout_thread.join(timeout)
        self._stderr_thread.join(timeout)
        if self._stdout_thread.is_alive() or self._stderr_thread.is_alive():
            raise AssertionError("Runtime server output pumps did not stop after process termination.")
        if self._stdout_error is not None:
            raise AssertionError("Runtime server stdout pump failed.") from self._stdout_error
        if self._stderr_error is not None:
            raise AssertionError("Runtime server stderr pump failed.") from self._stderr_error


def _send_server_envelope(
    process: subprocess.Popen[str],
    output: _ServerOutputPumps,
    envelope: dict[str, Any],
    *,
    timeout: float,
) -> dict[str, Any]:
    assert process.stdin is not None
    process.stdin.write(f"{json.dumps(envelope)}\n")
    process.stdin.flush()
    return output.read_response(timeout)


def _send_server_request(
    process: subprocess.Popen[str],
    output: _ServerOutputPumps,
    request_id: str,
    request: dict[str, Any],
    *,
    timeout: float,
) -> dict[str, Any]:
    envelope = {
        "protocolVersion": 2,
        "requestId": request_id,
        "priority": "interactive",
        "request": request,
    }
    response = _send_server_envelope(process, output, envelope, timeout=timeout)
    assert response["protocolVersion"] == 2
    assert response["requestId"] == request_id
    return response["response"]


def _join_and_close_server_output(process: subprocess.Popen[str], output: _ServerOutputPumps) -> None:
    try:
        output.join()
    finally:
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()


def test_stdio_server_frames_protocol_v2_responses() -> None:
    requests = [
        {
            "protocolVersion": 2,
            "requestId": "initialize",
            "priority": "interactive",
            "request": {"kind": "initialize"},
        },
        {
            "protocolVersion": 2,
            "requestId": "missing-session",
            "priority": "interactive",
            "request": {
                "kind": "getPage",
                "sessionId": "missing",
                "revision": 0,
                "viewRequestId": "view-missing",
                "offset": 0,
                "limit": 20,
                "columnOffset": 0,
                "columnLimit": 64,
                "filterModel": {"logic": "and", "filters": [], "sort": []},
            },
        },
        {
            "protocolVersion": 1,
            "requestId": "invalid",
            "priority": "interactive",
            "request": {"kind": "initialize"},
        },
        {
            "protocolVersion": 2,
            "requestId": "missing-close",
            "priority": "interactive",
            "request": {
                "kind": "closeSession",
                "sessionId": "missing-close-candidate",
                "revision": 0,
            },
        },
    ]
    process = subprocess.Popen(
        [sys.executable, "-m", "openwrangler_runtime.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    output = _ServerOutputPumps(process)
    responses: dict[str, Any] = {}
    return_code: int | None = None
    try:
        for request in requests:
            response = _send_server_envelope(process, output, request, timeout=30.0)
            responses[response["requestId"]] = response
        assert process.stdin is not None
        process.stdin.close()
        return_code = process.wait(timeout=10)
    finally:
        if process.stdin is not None and not process.stdin.closed:
            with suppress(BrokenPipeError):
                process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        _join_and_close_server_output(process, output)

    assert return_code == 0, output.stderr_tail()

    assert responses["initialize"]["protocolVersion"] == 2
    assert responses["initialize"]["response"]["kind"] == "initialized"
    assert responses["invalid"]["response"]["code"] == "invalid_request"
    assert responses["missing-session"]["response"] == {
        "kind": "error",
        "code": "unknown_session",
        "message": "Unknown session: missing",
        "recoverable": True,
        "sessionId": "missing",
        "viewRequestId": "view-missing",
    }
    assert responses["missing-close"]["response"] == {
        "kind": "error",
        "code": "unknown_session",
        "message": "Unknown session: missing-close-candidate",
        "recoverable": True,
        "sessionId": "missing-close-candidate",
    }


def test_stdio_server_opens_polars_then_pandas_in_one_process(tmp_path: Path) -> None:
    if find_spec("polars") is None or find_spec("pandas") is None:
        pytest.skip("The mixed-engine server regression requires both Polars and Pandas.")
    csv_path = tmp_path / "first.csv"
    tsv_path = tmp_path / "second.tsv"
    csv_path.write_text("city,value\nBerlin,12\nParis,7\n", encoding="utf-8")
    tsv_path.write_text("city\tvalue\nRome\t4\nMadrid\t9\n", encoding="utf-8")
    process = subprocess.Popen(
        [sys.executable, "-m", "openwrangler_runtime.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    output = _ServerOutputPumps(process)
    return_code: int | None = None
    try:
        for backend, source_path, session_id in (
            ("polars", csv_path, "mixed-engine-polars"),
            ("pandas", tsv_path, "mixed-engine-pandas"),
        ):
            response = _send_server_request(
                process,
                output,
                f"open-{backend}",
                {
                    "kind": "openSession",
                    "source": {"kind": "file", "label": source_path.name, "path": str(source_path)},
                    "requestedSessionId": session_id,
                    "backend": backend,
                    "mode": "editing",
                    "pageSize": 20,
                    "columnOffset": 0,
                    "columnLimit": 16,
                },
                timeout=60.0,
            )
            assert response["kind"] == "sessionOpened", response
            assert response["metadata"]["sessionId"] == session_id
            assert response["metadata"]["backend"] == backend

        for backend, session_id in (
            ("polars", "mixed-engine-polars"),
            ("pandas", "mixed-engine-pandas"),
        ):
            response = _send_server_request(
                process,
                output,
                f"close-{backend}",
                {"kind": "closeSession", "sessionId": session_id, "revision": 0},
                timeout=30.0,
            )
            assert response == {"kind": "sessionClosed", "sessionId": session_id}

        assert process.stdin is not None
        process.stdin.close()
        return_code = process.wait(timeout=10)
    finally:
        if process.stdin is not None and not process.stdin.closed:
            with suppress(BrokenPipeError):
                process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        _join_and_close_server_output(process, output)

    assert return_code == 0, output.stderr_tail()


def test_stdio_server_opens_polars_excel_in_a_fresh_process(tmp_path: Path) -> None:
    required_modules = ("polars", "fastexcel", "openpyxl")
    if any(find_spec(module_name) is None for module_name in required_modules):
        pytest.skip("The Polars Excel server regression requires Polars, fastexcel, and openpyxl.")
    from openpyxl import Workbook

    workbook_path = tmp_path / "native-reader.xlsx"
    workbook = Workbook()
    worksheet = workbook.active
    assert worksheet is not None
    worksheet.title = "Sales"
    worksheet.append(["city", "sales"])
    worksheet.append(["Berlin", 12])
    worksheet.append(["Paris", 7])
    workbook.save(workbook_path)

    process = subprocess.Popen(
        [sys.executable, "-m", "openwrangler_runtime.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    output = _ServerOutputPumps(process)
    return_code: int | None = None
    try:
        response = _send_server_request(
            process,
            output,
            "open-polars-excel",
            {
                "kind": "openSession",
                "source": {"kind": "file", "label": workbook_path.name, "path": str(workbook_path)},
                "requestedSessionId": "polars-excel",
                "backend": "polars",
                "mode": "editing",
                "pageSize": 20,
                "columnOffset": 0,
                "columnLimit": 16,
            },
            timeout=60.0,
        )
        assert response["kind"] == "sessionOpened", response
        assert response["metadata"]["sessionId"] == "polars-excel"
        assert response["metadata"]["backend"] == "polars"
        assert response["metadata"]["shape"] == {"rows": 2, "columns": 2}

        response = _send_server_request(
            process,
            output,
            "close-polars-excel",
            {"kind": "closeSession", "sessionId": "polars-excel", "revision": 0},
            timeout=30.0,
        )
        assert response == {"kind": "sessionClosed", "sessionId": "polars-excel"}

        assert process.stdin is not None
        process.stdin.close()
        return_code = process.wait(timeout=10)
    finally:
        if process.stdin is not None and not process.stdin.closed:
            with suppress(BrokenPipeError):
                process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        _join_and_close_server_output(process, output)

    assert return_code == 0, output.stderr_tail()


def test_stdio_server_prepares_backend_on_reader_thread_before_dispatch(monkeypatch) -> None:
    reader_thread = threading.current_thread()
    dispatched = threading.Event()

    class TrackingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.prepare_thread: threading.Thread | None = None
            self.dispatch_thread: threading.Thread | None = None

        def prepare_backend(self, source: dict[str, Any], backend: str | None) -> None:
            assert source["path"] == "sample.csv"
            assert backend == "pandas"
            self.prepare_thread = threading.current_thread()

        def open_session(self, *_args: Any) -> dict[str, Any]:
            self.dispatch_thread = threading.current_thread()
            dispatched.set()
            return {"kind": "sessionOpened"}

        def close_all(self) -> None:
            return None

    manager = TrackingManager()
    envelope = {
        "protocolVersion": 2,
        "requestId": "main-thread-prepare",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.csv", "path": "sample.csv"},
            "backend": "pandas",
            "pageSize": 20,
            "columnOffset": 0,
            "columnLimit": 16,
        },
    }

    def input_lines():
        yield f"{json.dumps(envelope)}\n"
        assert dispatched.wait(5)

    output = StringIO()
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_lines())
    monkeypatch.setattr(server.sys, "stdout", output)

    server.main()

    response = json.loads(output.getvalue())
    assert response["requestId"] == "main-thread-prepare"
    assert response["response"]["kind"] == "sessionOpened"
    assert manager.prepare_thread is reader_thread
    assert manager.dispatch_thread is not None
    assert manager.dispatch_thread is not reader_thread


def test_stdio_server_reports_backend_preparation_failure(monkeypatch) -> None:
    class FailingManager(_PassthroughRequestScope):
        def prepare_backend(self, _source: dict[str, Any], _backend: str | None) -> None:
            raise server.EngineError("native import failed")

        def close_all(self) -> None:
            return None

    envelope = {
        "protocolVersion": 2,
        "requestId": "prepare-failed",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.csv", "path": "sample.csv"},
            "backend": "pandas",
            "pageSize": 20,
            "columnOffset": 0,
            "columnLimit": 16,
        },
    }
    output = StringIO()
    monkeypatch.setattr(server, "SessionManager", FailingManager)
    monkeypatch.setattr(server.sys, "stdin", StringIO(f"{json.dumps(envelope)}\n"))
    monkeypatch.setattr(server.sys, "stdout", output)

    server.main()

    response = json.loads(output.getvalue())
    assert response["requestId"] == "prepare-failed"
    assert response["response"]["kind"] == "error"
    assert response["response"]["code"] == "engine_error"
    assert response["response"]["message"] == "native import failed"


def test_stdio_server_reports_ambiguous_view_columns_with_a_structured_code(monkeypatch) -> None:
    class AmbiguousManager(_PassthroughRequestScope):
        def get_page(self, *_args: Any) -> dict[str, Any]:
            raise server.AmbiguousViewColumnError("two Pandas columns share the displayed name '7'")

        def close_all(self) -> None:
            return None

    response_written = threading.Event()

    class SignallingOutput(StringIO):
        def write(self, value: str) -> int:
            result = super().write(value)
            if value.endswith("\n"):
                response_written.set()
            return result

    envelope = {
        "protocolVersion": 2,
        "requestId": "ambiguous-page",
        "priority": "interactive",
        "request": {
            "kind": "getPage",
            "sessionId": "session",
            "revision": 0,
            "viewRequestId": "view-ambiguous",
            "offset": 0,
            "limit": 20,
            "columnOffset": 0,
            "columnLimit": 64,
            "filterModel": {"filters": [], "sort": []},
        },
    }

    def input_lines():
        yield f"{json.dumps(envelope)}\n"
        assert response_written.wait(5)

    output = SignallingOutput()
    monkeypatch.setattr(server, "SessionManager", AmbiguousManager)
    monkeypatch.setattr(server.sys, "stdin", input_lines())
    monkeypatch.setattr(server.sys, "stdout", output)

    server.main()

    response = json.loads(output.getvalue())
    assert response == {
        "protocolVersion": 2,
        "requestId": "ambiguous-page",
        "response": {
            "kind": "error",
            "code": "ambiguous_view_column",
            "message": "two Pandas columns share the displayed name '7'",
            "recoverable": True,
            "viewRequestId": "view-ambiguous",
        },
    }


@pytest.mark.parametrize(
    ("request_payload", "error", "expected_response"),
    [
        (
            {
                "kind": "getPage",
                "sessionId": "spark-session",
                "revision": 0,
                "viewRequestId": "view-live-source",
                "offset": 0,
                "limit": 20,
                "columnOffset": 0,
                "columnLimit": 64,
                "filterModel": {"filters": [], "sort": []},
            },
            server.LiveSourceInvalidatedError("spark-session", "The live PySpark dataframe was replaced."),
            {
                "kind": "error",
                "code": "live_source_invalidated",
                "message": "The live PySpark dataframe was replaced.",
                "recoverable": True,
                "sessionId": "spark-session",
                "viewRequestId": "view-live-source",
            },
        ),
        (
            {
                "kind": "getPage",
                "sessionId": "spark-session",
                "revision": 0,
                "viewRequestId": "view-spark-connect-unavailable",
                "offset": 0,
                "limit": 20,
                "columnOffset": 0,
                "columnLimit": 64,
                "filterModel": {"filters": [], "sort": []},
            },
            server.PySparkConnectUnavailableError(
                "spark-session",
                "Spark Connect is temporarily unavailable.",
            ),
            {
                "kind": "error",
                "code": "pyspark_connect_unavailable",
                "message": "Spark Connect is temporarily unavailable.",
                "recoverable": True,
                "sessionId": "spark-session",
                "viewRequestId": "view-spark-connect-unavailable",
            },
        ),
        (
            {
                "kind": "getPage",
                "sessionId": "spark-session",
                "revision": 0,
                "viewRequestId": "view-spark-connect-state-lost",
                "offset": 0,
                "limit": 20,
                "columnOffset": 0,
                "columnLimit": 64,
                "filterModel": {"filters": [], "sort": []},
            },
            server.PySparkConnectStateLostError(
                "spark-session",
                "The Spark Connect dataframe no longer exists.",
            ),
            {
                "kind": "error",
                "code": "pyspark_connect_state_lost",
                "message": "The Spark Connect dataframe no longer exists.",
                "recoverable": True,
                "sessionId": "spark-session",
                "viewRequestId": "view-spark-connect-state-lost",
            },
        ),
        (
            {"kind": "closeSession", "sessionId": "cleanup-session", "revision": 0},
            server.SessionCleanupError("cleanup-session", "Could not release the Spark cache."),
            {
                "kind": "error",
                "code": "session_cleanup_failed",
                "message": "Could not release the Spark cache.",
                "recoverable": False,
                "sessionId": "cleanup-session",
            },
        ),
    ],
    ids=("live-source", "spark-connect-unavailable", "spark-connect-state-lost", "terminal-cleanup"),
)
def test_stdio_server_preserves_correlated_live_session_errors(
    monkeypatch: pytest.MonkeyPatch,
    request_payload: dict[str, Any],
    error: Exception,
    expected_response: dict[str, Any],
) -> None:
    class FailingManager(_PassthroughRequestScope):
        def get_page(self, *_args: Any) -> dict[str, Any]:
            raise error

        def close_session(self, *_args: Any) -> dict[str, Any]:
            raise error

        def close_all(self) -> None:
            return None

    response_written = threading.Event()

    class SignallingOutput(StringIO):
        def write(self, value: str) -> int:
            result = super().write(value)
            if value.endswith("\n"):
                response_written.set()
            return result

    envelope = {
        "protocolVersion": 2,
        "requestId": "correlated-live-session-error",
        "priority": "interactive",
        "request": request_payload,
    }

    def input_lines():
        yield f"{json.dumps(envelope)}\n"
        assert response_written.wait(5)

    output = SignallingOutput()
    monkeypatch.setattr(server, "SessionManager", FailingManager)
    monkeypatch.setattr(server.sys, "stdin", input_lines())
    monkeypatch.setattr(server.sys, "stdout", output)

    server.main()

    assert json.loads(output.getvalue()) == {
        "protocolVersion": 2,
        "requestId": "correlated-live-session-error",
        "response": expected_response,
    }


def test_stdio_server_closes_all_sessions_when_input_ends(monkeypatch) -> None:
    class TrackingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.closed = False

        def close_all(self) -> None:
            self.closed = True

    manager = TrackingManager()
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", StringIO(""))

    server.main()

    assert manager.closed is True


def test_dispatch_echoes_view_request_id() -> None:
    class PagingManager:
        def get_page(self, *_args: Any) -> dict[str, Any]:
            return {"kind": "page", "revision": 0, "page": {}, "metadata": {}}

    response = server.dispatch(
        PagingManager(),  # type: ignore[arg-type]
        {
            "kind": "getPage",
            "sessionId": "session",
            "revision": 0,
            "viewRequestId": "view-page",
            "offset": 0,
            "limit": 20,
            "columnOffset": 3,
            "columnLimit": 7,
            "filterModel": {"logic": "and", "filters": [], "sort": []},
        },
    )

    assert response["viewRequestId"] == "view-page"


def test_dispatch_binds_the_protocol_request_id_during_session_work() -> None:
    events: list[tuple[str, str]] = []

    class PagingManager:
        @contextmanager
        def request_scope(self, request_id: str, request: dict[str, Any]):
            assert request["sessionId"] == "session"
            events.append(("enter", request_id))
            try:
                yield
            finally:
                events.append(("exit", request_id))

        def get_page(self, *_args: Any) -> dict[str, Any]:
            assert events == [("enter", "d88bc868-b427-4656-923e-849ad39b2768")]
            return {"kind": "page", "revision": 0, "page": {}, "metadata": {}}

    response = server.dispatch(
        PagingManager(),  # type: ignore[arg-type]
        {
            "kind": "getPage",
            "sessionId": "session",
            "revision": 0,
            "viewRequestId": "view-page",
            "offset": 0,
            "limit": 20,
            "columnOffset": 0,
            "columnLimit": 7,
            "filterModel": {"logic": "and", "filters": [], "sort": []},
        },
        "d88bc868-b427-4656-923e-849ad39b2768",
    )

    assert response["kind"] == "page"
    assert events == [
        ("enter", "d88bc868-b427-4656-923e-849ad39b2768"),
        ("exit", "d88bc868-b427-4656-923e-849ad39b2768"),
    ]


def test_dispatch_passes_the_protocol_request_id_into_session_open() -> None:
    class OpeningManager(_PassthroughRequestScope):
        def open_session(self, *args: Any) -> dict[str, Any]:
            assert args[-1] == "bb624815-906d-4f14-8dc4-9fd7546dd07d"
            return {"kind": "sessionOpened"}

    response = server.dispatch(
        OpeningManager(),  # type: ignore[arg-type]
        {
            "kind": "openSession",
            "source": {"kind": "notebookVariable", "variableName": "orders"},
            "backend": "pyspark",
            "pageSize": 20,
            "columnOffset": 0,
            "columnLimit": 8,
        },
        "bb624815-906d-4f14-8dc4-9fd7546dd07d",
    )

    assert response == {"kind": "sessionOpened"}


def test_dispatch_routes_applied_step_inspection_without_view_correlation() -> None:
    class InspectionManager:
        def inspect_step(self, *args: Any) -> dict[str, Any]:
            assert args == ("session", 4, "round-value", 20, 10, 3, 7)
            return {"kind": "stepInspection", "revision": 4, "stepId": "round-value"}

    response = server.dispatch(
        InspectionManager(),  # type: ignore[arg-type]
        {
            "kind": "inspectStep",
            "sessionId": "session",
            "revision": 4,
            "stepId": "round-value",
            "offset": 20,
            "limit": 10,
            "columnOffset": 3,
            "columnLimit": 7,
        },
    )

    assert response == {"kind": "stepInspection", "revision": 4, "stepId": "round-value"}


def test_cancel_pending_future_only_cancels_work_that_has_not_started() -> None:
    pending_lock = threading.Lock()
    queued: Future[dict[str, Any]] = Future()
    running: Future[dict[str, Any]] = Future()
    assert running.set_running_or_notify_cancel() is True
    complete: Future[dict[str, Any]] = Future()
    complete.set_result({"kind": "initialized"})
    pending = {"queued": queued, "running": running, "complete": complete}

    assert server._cancel_pending_future(pending, pending_lock, "queued") is True
    assert queued.cancelled() is True
    assert server._cancel_pending_future(pending, pending_lock, "running") is False
    assert server._cancel_pending_future(pending, pending_lock, "complete") is False
    assert server._cancel_pending_future(pending, pending_lock, "unknown") is False

    running.set_result({"kind": "initialized"})
    assert running.result() == {"kind": "initialized"}


def test_cancel_request_does_not_suppress_an_already_running_result(monkeypatch) -> None:
    class RunningManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.started = threading.Event()
            self.release = threading.Event()

        def get_summary(self, *_args: Any) -> dict[str, Any]:
            self.started.set()
            if not self.release.wait(2):
                raise TimeoutError("Running profile was not released.")
            return {"kind": "summary", "revision": 0, "summaries": []}

        def close_all(self) -> None:
            self.release.set()

    manager = RunningManager()
    profile = {
        "protocolVersion": 2,
        "requestId": "running-profile",
        "priority": "background",
        "request": {
            "kind": "getSummary",
            "sessionId": "session",
            "revision": 0,
            "viewRequestId": "running-view",
            "filterModel": {"logic": "and", "filters": [], "sort": []},
            "columnIds": ["c:value"],
        },
    }
    cancellation = {
        "protocolVersion": 2,
        "requestId": "cancel-running-profile",
        "priority": "interactive",
        "request": {"kind": "cancelRequest", "targetRequestId": "running-profile"},
    }

    def input_after_work_starts():
        yield f"{json.dumps(profile)}\n"
        assert manager.started.wait(1)
        yield f"{json.dumps(cancellation)}\n"
        manager.release.set()

    output = StringIO()
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_after_work_starts())
    monkeypatch.setattr(server.sys, "stdout", output)

    server.main()

    responses = {item["requestId"]: item["response"] for item in map(json.loads, output.getvalue().splitlines())}
    assert responses["cancel-running-profile"]["kind"] == "error"
    assert responses["cancel-running-profile"]["code"] == "cancellation_unavailable"
    assert responses["running-profile"] == {
        "kind": "summary",
        "revision": 0,
        "viewRequestId": "running-view",
        "summaries": [],
    }


def test_interactive_executor_is_not_starved_by_background_profiles(monkeypatch) -> None:
    class BlockingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.release = threading.Event()
            self.interactive_started = threading.Event()

        def get_summary(self, *_args: Any) -> dict[str, Any]:
            if not self.release.wait(3):
                raise TimeoutError("Test background profile was not released.")
            return {"kind": "summary", "revision": 0, "summaries": []}

        def initialize(self) -> dict[str, Any]:
            self.interactive_started.set()
            self.release.set()
            return {"kind": "initialized"}

        def close_all(self) -> None:
            self.release.set()

    manager = BlockingManager()
    requests = [
        {
            "protocolVersion": 2,
            "requestId": f"profile-{index}",
            "priority": "background",
            "request": {
                "kind": "getSummary",
                "sessionId": f"session-{index}",
                "revision": 0,
                "viewRequestId": f"view-profile-{index}",
                "filterModel": {"logic": "and", "filters": [], "sort": []},
                "columnIds": ["c:value"],
            },
        }
        for index in range(4)
    ]
    requests.append(
        {
            "protocolVersion": 2,
            "requestId": "interactive",
            "priority": "interactive",
            "request": {"kind": "initialize"},
        }
    )
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", StringIO("".join(f"{json.dumps(item)}\n" for item in requests)))
    monkeypatch.setattr(server.sys, "stdout", StringIO())

    runner = threading.Thread(target=server.main, daemon=True)
    runner.start()
    started_without_external_release = manager.interactive_started.wait(1)
    if not started_without_external_release:
        manager.release.set()
    runner.join(5)

    assert started_without_external_release is True
    assert runner.is_alive() is False


def test_eof_starts_cleanup_before_active_profiles_finish_and_cancels_queued_profiles(monkeypatch) -> None:
    class BlockingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.lock = threading.Lock()
            self.started = 0
            self.two_started = threading.Event()
            self.release = threading.Event()
            self.close_started = threading.Event()

        def get_summary(self, *_args: Any) -> dict[str, Any]:
            with self.lock:
                self.started += 1
                if self.started == 2:
                    self.two_started.set()
            if not self.release.wait(3):
                raise TimeoutError("Test profile was not released by runtime cleanup.")
            return {"kind": "summary", "revision": 0, "summaries": []}

        def close_all(self) -> None:
            self.close_started.set()
            self.release.set()

    manager = BlockingManager()
    requests = [
        {
            "protocolVersion": 2,
            "requestId": f"profile-{index}",
            "priority": "background",
            "request": {
                "kind": "getSummary",
                "sessionId": "session",
                "revision": 0,
                "viewRequestId": f"view-{index}",
                "filterModel": {"logic": "and", "filters": [], "sort": []},
                "columnIds": ["c:value"],
            },
        }
        for index in range(6)
    ]

    def input_until_workers_are_busy():
        yield from (f"{json.dumps(item)}\n" for item in requests)
        manager.two_started.wait(2)

    existing_threads = {thread.ident for thread in threading.enumerate()}
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_until_workers_are_busy())
    monkeypatch.setattr(server.sys, "stdout", StringIO())

    runner = threading.Thread(target=server.main, daemon=True)
    runner.start()
    assert manager.two_started.wait(1)
    assert manager.close_started.wait(1)
    runner.join(2)

    assert runner.is_alive() is False
    assert manager.started == 2
    runtime_threads = [
        thread
        for thread in threading.enumerate()
        if thread.ident not in existing_threads and thread.name.startswith("openwrangler-")
    ]
    for thread in runtime_threads:
        thread.join(1)
    assert all(not thread.is_alive() for thread in runtime_threads)


def test_eof_wait_for_blocked_cleanup_is_bounded(monkeypatch) -> None:
    class StuckManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.work_started = threading.Event()
            self.release_work = threading.Event()
            self.close_started = threading.Event()
            self.release_close = threading.Event()

        def get_summary(self, *_args: Any) -> dict[str, Any]:
            self.work_started.set()
            self.release_work.wait(3)
            return {"kind": "summary", "revision": 0, "summaries": []}

        def close_all(self) -> None:
            self.close_started.set()
            self.release_close.wait(3)

    manager = StuckManager()
    request = {
        "protocolVersion": 2,
        "requestId": "active-profile",
        "priority": "background",
        "request": {
            "kind": "getSummary",
            "sessionId": "session",
            "revision": 0,
            "viewRequestId": "active-view",
            "filterModel": {"logic": "and", "filters": [], "sort": []},
            "columnIds": ["c:value"],
        },
    }

    def input_after_work_starts():
        yield f"{json.dumps(request)}\n"
        manager.work_started.wait(2)

    existing_threads = {thread.ident for thread in threading.enumerate()}
    monkeypatch.setattr(server, "SHUTDOWN_GRACE_SECONDS", 0.05)
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_after_work_starts())
    monkeypatch.setattr(server.sys, "stdout", StringIO())

    runner = threading.Thread(target=server.main, daemon=True)
    runner.start()
    assert manager.work_started.wait(1)
    assert manager.close_started.wait(1)
    runner.join(0.5)

    assert runner.is_alive() is False

    manager.release_work.set()
    manager.release_close.set()
    runtime_threads = [
        thread
        for thread in threading.enumerate()
        if thread.ident not in existing_threads and thread.name.startswith("openwrangler-")
    ]
    for thread in runtime_threads:
        thread.join(1)
    assert all(not thread.is_alive() for thread in runtime_threads)


def test_stdio_server_parses_an_accepted_frame_exactly_once(monkeypatch: pytest.MonkeyPatch) -> None:
    class InitializingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.initialized = 0

        def initialize(self) -> dict[str, Any]:
            self.initialized += 1
            return {"kind": "initialized"}

        def close_all(self) -> None:
            return None

    manager = InitializingManager()
    envelope = {
        "protocolVersion": 2,
        "requestId": "parse-once",
        "priority": "interactive",
        "request": {"kind": "initialize"},
    }
    original_loads = json.loads
    parse_count = 0

    def counting_loads(value: str):
        nonlocal parse_count
        parse_count += 1
        return original_loads(value)

    output = StringIO()
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.json, "loads", counting_loads)
    monkeypatch.setattr(server.sys, "stdin", StringIO(f"{json.dumps(envelope)}\n"))
    monkeypatch.setattr(server.sys, "stdout", output)

    assert server.main() == 0

    assert parse_count == 1
    assert manager.initialized == 1
    assert original_loads(output.getvalue())["response"] == {"kind": "initialized"}


@pytest.mark.parametrize(
    ("frame", "maximum_bytes", "diagnostic"),
    [
        (b"x" * 64 + b"\n", 64, "exceeds the 64-byte limit"),
        (b'{"requestId":"private-unterminated-marker"}', 128, "ended before its LF terminator"),
        (b'{"requestId":"private-malformed-marker",BROKEN}\n', 128, "not valid JSON"),
    ],
    ids=("oversized", "unterminated", "malformed-json"),
)
def test_terminal_request_frame_failures_are_bounded_and_never_invoke_the_engine(
    monkeypatch: pytest.MonkeyPatch,
    frame: bytes,
    maximum_bytes: int,
    diagnostic: str,
) -> None:
    class TrackingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.prepare_calls = 0
            self.closed = False

        def prepare_backend(self, *_args: Any) -> None:
            self.prepare_calls += 1

        def close_all(self) -> None:
            self.closed = True

    manager = TrackingManager()
    output = StringIO()
    errors = StringIO()
    monkeypatch.setattr(server, "MAX_REQUEST_FRAME_BYTES", maximum_bytes)
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", _BinaryInput(frame))
    monkeypatch.setattr(server.sys, "stdout", output)
    monkeypatch.setattr(server.sys, "stderr", errors)

    assert server.main() == 1

    assert output.getvalue() == ""
    assert manager.prepare_calls == 0
    assert manager.closed is True
    assert diagnostic in errors.getvalue()
    assert "private-unterminated-marker" not in errors.getvalue()
    assert "private-malformed-marker" not in errors.getvalue()
    assert len(errors.getvalue().encode("utf-8")) <= server.MAX_DIAGNOSTIC_BYTES


def test_request_frame_limit_counts_multibyte_utf8_and_the_lf_terminator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class InitializingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.initialized = 0

        def initialize(self) -> dict[str, Any]:
            self.initialized += 1
            return {"kind": "initialized"}

        def close_all(self) -> None:
            return None

    envelope = {
        "protocolVersion": 2,
        "requestId": "utf8-éééé",
        "priority": "interactive",
        "request": {"kind": "initialize"},
    }
    frame = f"{json.dumps(envelope, ensure_ascii=False, separators=(',', ':'))}\n".encode()
    assert len(frame.decode("utf-8")) < len(frame)

    accepted_manager = InitializingManager()
    accepted_output = StringIO()
    monkeypatch.setattr(server, "MAX_REQUEST_FRAME_BYTES", len(frame))
    monkeypatch.setattr(server, "SessionManager", lambda: accepted_manager)
    monkeypatch.setattr(server.sys, "stdin", _BinaryInput(frame))
    monkeypatch.setattr(server.sys, "stdout", accepted_output)
    assert server.main() == 0
    assert accepted_manager.initialized == 1
    assert json.loads(accepted_output.getvalue())["requestId"] == envelope["requestId"]

    rejected_manager = InitializingManager()
    rejected_output = StringIO()
    monkeypatch.setattr(server, "MAX_REQUEST_FRAME_BYTES", len(frame) - 1)
    monkeypatch.setattr(server, "SessionManager", lambda: rejected_manager)
    monkeypatch.setattr(server.sys, "stdin", _BinaryInput(frame))
    monkeypatch.setattr(server.sys, "stdout", rejected_output)
    assert server.main() == 1
    assert rejected_manager.initialized == 0
    assert rejected_output.getvalue() == ""


def test_duplicate_live_request_id_is_terminal_and_does_not_repeat_engine_preparation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BlockingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.prepare_calls = 0
            self.open_calls = 0
            self.started = threading.Event()
            self.release = threading.Event()
            self.closed = False

        def prepare_backend(self, *_args: Any) -> None:
            self.prepare_calls += 1

        def open_session(self, *_args: Any) -> dict[str, Any]:
            self.open_calls += 1
            self.started.set()
            if not self.release.wait(2):
                raise TimeoutError("Duplicate-ID test open was not released.")
            return {"kind": "sessionOpened"}

        def close_all(self) -> None:
            self.closed = True
            self.release.set()

    manager = BlockingManager()
    envelope = {
        "protocolVersion": 2,
        "requestId": "duplicate-live",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.csv", "path": "sample.csv"},
            "backend": "pandas",
            "pageSize": 20,
            "columnOffset": 0,
            "columnLimit": 16,
        },
    }

    def duplicate_after_open_starts():
        yield f"{json.dumps(envelope)}\n"
        assert manager.started.wait(1)
        yield f"{json.dumps(envelope)}\n"

    output = StringIO()
    errors = StringIO()
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", duplicate_after_open_starts())
    monkeypatch.setattr(server.sys, "stdout", output)
    monkeypatch.setattr(server.sys, "stderr", errors)

    assert server.main() == 1

    assert manager.prepare_calls == 1
    assert manager.open_calls == 1
    assert manager.closed is True
    assert output.getvalue() == ""
    assert "reused a live correlation ID" in errors.getvalue()
    assert "duplicate-live" not in errors.getvalue()


def test_terminal_frame_failure_shuts_down_running_mutation_without_synthesizing_a_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BlockingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.apply_calls = 0
            self.started = threading.Event()
            self.release = threading.Event()
            self.closed = False

        def apply_draft(self, *_args: Any) -> dict[str, Any]:
            self.apply_calls += 1
            self.started.set()
            if not self.release.wait(2):
                raise TimeoutError("Terminal-frame mutation was not released.")
            return {"kind": "planUpdated", "action": "applied", "revision": 1}

        def close_all(self) -> None:
            self.closed = True
            self.release.set()

    manager = BlockingManager()
    mutation = {
        "protocolVersion": 2,
        "requestId": "running-mutation",
        "priority": "interactive",
        "request": {
            "kind": "applyDraft",
            "sessionId": "session",
            "revision": 0,
            "offset": 0,
            "limit": 20,
            "columnOffset": 0,
            "columnLimit": 16,
        },
    }
    mutation_frame = f"{json.dumps(mutation)}\n"
    maximum_bytes = len(mutation_frame.encode()) + 8

    def oversized_after_mutation_starts():
        yield mutation_frame
        assert manager.started.wait(1)
        yield ("x" * maximum_bytes) + "\n"

    output = StringIO()
    monkeypatch.setattr(server, "MAX_REQUEST_FRAME_BYTES", maximum_bytes)
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", oversized_after_mutation_starts())
    monkeypatch.setattr(server.sys, "stdout", output)

    assert server.main() == 1

    assert manager.apply_calls == 1
    assert manager.closed is True
    assert output.getvalue() == ""


def test_interactive_admission_cap_rejects_before_backend_preparation(monkeypatch: pytest.MonkeyPatch) -> None:
    class BlockingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.initialized = threading.Event()
            self.release = threading.Event()
            self.prepare_calls = 0

        def initialize(self) -> dict[str, Any]:
            self.initialized.set()
            if not self.release.wait(2):
                raise TimeoutError("Admission-cap test initialization was not released.")
            return {"kind": "initialized"}

        def prepare_backend(self, *_args: Any) -> None:
            self.prepare_calls += 1

        def close_all(self) -> None:
            self.release.set()

    manager = BlockingManager()
    initialize = {
        "protocolVersion": 2,
        "requestId": "occupies-capacity",
        "priority": "interactive",
        "request": {"kind": "initialize"},
    }
    rejected_open = {
        "protocolVersion": 2,
        "requestId": "rejected-open",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "never-opened.csv", "path": "never-opened.csv"},
            "backend": "pandas",
            "pageSize": 20,
            "columnOffset": 0,
            "columnLimit": 16,
        },
    }

    def input_at_capacity():
        yield f"{json.dumps(initialize)}\n"
        assert manager.initialized.wait(1)
        yield f"{json.dumps(rejected_open)}\n"

    output = StringIO()
    monkeypatch.setattr(server, "MAX_INTERACTIVE_LIVE_REQUESTS", 1)
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_at_capacity())
    monkeypatch.setattr(server.sys, "stdout", output)

    assert server.main() == 0

    responses = {item["requestId"]: item["response"] for item in map(json.loads, output.getvalue().splitlines())}
    assert responses["rejected-open"] == {
        "kind": "error",
        "code": "server_busy",
        "message": (
            "The runtime has reached its bounded interactive work limit; retry after an earlier request completes."
        ),
        "recoverable": True,
    }
    assert responses["occupies-capacity"] == {"kind": "initialized"}
    assert manager.prepare_calls == 0


def test_queued_cancellation_remains_correlated_and_frees_bounded_admission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BlockingManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.lock = threading.Lock()
            self.started = 0
            self.two_started = threading.Event()
            self.three_started = threading.Event()
            self.release = threading.Event()

        def get_summary(self, *_args: Any) -> dict[str, Any]:
            with self.lock:
                self.started += 1
                if self.started == 2:
                    self.two_started.set()
                if self.started == 3:
                    self.three_started.set()
            if not self.release.wait(2):
                raise TimeoutError("Queued-cancellation test profiles were not released.")
            return {"kind": "summary", "revision": 0, "summaries": []}

        def close_all(self) -> None:
            self.release.set()

    manager = BlockingManager()

    def profile(request_id: str) -> dict[str, Any]:
        return {
            "protocolVersion": 2,
            "requestId": request_id,
            "priority": "background",
            "request": {
                "kind": "getSummary",
                "sessionId": "session",
                "revision": 0,
                "viewRequestId": f"view-{request_id}",
                "filterModel": {"filters": [], "sort": []},
                "columnIds": ["c:value"],
            },
        }

    cancellation = {
        "protocolVersion": 2,
        "requestId": "cancel-profile-2",
        "priority": "interactive",
        "request": {"kind": "cancelRequest", "targetRequestId": "profile-2"},
    }

    def input_with_queued_cancellation():
        yield f"{json.dumps(profile('profile-0'))}\n"
        yield f"{json.dumps(profile('profile-1'))}\n"
        assert manager.two_started.wait(1)
        yield f"{json.dumps(profile('profile-2'))}\n"
        yield f"{json.dumps(cancellation)}\n"
        yield f"{json.dumps(profile('profile-3'))}\n"
        manager.release.set()
        assert manager.three_started.wait(1)

    output = StringIO()
    monkeypatch.setattr(server, "MAX_BACKGROUND_LIVE_REQUESTS", 3)
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_with_queued_cancellation())
    monkeypatch.setattr(server.sys, "stdout", output)

    assert server.main() == 0

    responses = {item["requestId"]: item["response"] for item in map(json.loads, output.getvalue().splitlines())}
    assert responses["profile-2"] == {
        "kind": "cancelled",
        "targetRequestId": "profile-2",
        "viewRequestId": "view-profile-2",
    }
    assert responses["cancel-profile-2"] == {"kind": "cancelled", "targetRequestId": "profile-2"}
    assert responses["profile-3"]["kind"] == "summary"
    assert manager.started == 3


def test_server_bounds_user_controlled_engine_diagnostics(monkeypatch: pytest.MonkeyPatch) -> None:
    marker = "private-engine-payload-"

    class FailingManager(_PassthroughRequestScope):
        def prepare_backend(self, *_args: Any) -> None:
            raise server.EngineError(marker + ("é" * 20_000))

        def close_all(self) -> None:
            return None

    envelope = {
        "protocolVersion": 2,
        "requestId": "bounded-engine-error",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.csv", "path": "sample.csv"},
            "backend": "pandas",
            "pageSize": 20,
            "columnOffset": 0,
            "columnLimit": 16,
        },
    }
    output = StringIO()
    monkeypatch.setattr(server, "SessionManager", FailingManager)
    monkeypatch.setattr(server.sys, "stdin", StringIO(f"{json.dumps(envelope)}\n"))
    monkeypatch.setattr(server.sys, "stdout", output)

    assert server.main() == 0

    response = json.loads(output.getvalue())["response"]
    assert response["code"] == "engine_error"
    assert response["message"].startswith(marker)
    assert response["message"].endswith("...[truncated]")
    assert len(response["message"].encode("utf-8")) <= server.MAX_DIAGNOSTIC_BYTES
