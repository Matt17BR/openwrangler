from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from io import BytesIO, StringIO
from typing import Any

import pytest

import openwrangler_runtime.server as server
from openwrangler_runtime.response_framing import (
    ResponseFrameTooLargeError,
    encode_response_frame,
    strict_json_byte_length,
)


class _BinaryOutput:
    def __init__(self) -> None:
        self.buffer = BytesIO()

    def fileno(self) -> int:
        raise OSError("not a real descriptor")


class _PassthroughRequestScope:
    @contextmanager
    def request_scope(self, _request_id: str, _request: dict[str, Any]):
        yield


def test_response_frame_is_compact_utf8_and_stringifies_each_value_once() -> None:
    class StringifiedOnce:
        def __init__(self) -> None:
            self.calls = 0

        def __str__(self) -> str:
            self.calls += 1
            return "converted"

    value = StringifiedOnce()

    frame = encode_response_frame({"value": value, "unicode": "é"})

    assert frame == b'{"value":"converted","unicode":"\xc3\xa9"}\n'
    assert value.calls == 1
    assert b"\\u00e9" not in frame
    assert b": " not in frame
    with pytest.raises(TypeError):
        strict_json_byte_length({"value": value}, 1_024)
    assert value.calls == 1


def test_response_frame_cap_counts_multibyte_utf8_and_lf_exactly() -> None:
    payload = {"value": "é" * 64}
    expected = (
        json.dumps(payload, default=str, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        + b"\n"
    )

    assert encode_response_frame(payload, len(expected)) == expected
    with pytest.raises(ResponseFrameTooLargeError):
        encode_response_frame(payload, len(expected) - 1)
    assert strict_json_byte_length(payload, len(expected)) == len(expected) - 1


def test_strict_json_byte_length_stops_after_crossing_the_bound() -> None:
    payload = {"secret": "private-response-payload-" + ("x" * 100_000)}

    measured = strict_json_byte_length(payload, 128)

    assert measured > 128
    assert measured <= len(json.dumps(payload, separators=(",", ":")).encode("utf-8"))


def test_response_payload_error_maps_to_a_correlated_recoverable_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class PayloadErrorManager(_PassthroughRequestScope):
        def get_page(self, *_args: Any) -> dict[str, Any]:
            raise server.ResponsePayloadError(
                "The requested page exceeds the strict response payload limit.",
                "response_too_large",
            )

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
        "requestId": "bounded-response-payload",
        "priority": "interactive",
        "request": {
            "kind": "getPage",
            "sessionId": "bounded-session",
            "revision": 0,
            "viewRequestId": "view-response-too-large",
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
    monkeypatch.setattr(server, "SessionManager", PayloadErrorManager)
    monkeypatch.setattr(server.sys, "stdin", input_lines())
    monkeypatch.setattr(server.sys, "stdout", output)

    assert server.main() == 0
    assert json.loads(output.getvalue()) == {
        "protocolVersion": 2,
        "requestId": "bounded-response-payload",
        "response": {
            "kind": "error",
            "code": "response_too_large",
            "message": "The requested page exceeds the strict response payload limit.",
            "recoverable": True,
            "viewRequestId": "view-response-too-large",
        },
    }


def test_response_publisher_writes_one_compact_utf8_frame() -> None:
    output = _BinaryOutput()
    failed = threading.Event()
    failures: list[str] = []
    publisher = server._ResponsePublisher(
        output,
        threading.Lock(),
        failed,
        lambda error: failures.append(str(error)),
    )

    assert publisher.publish({"protocolVersion": 2, "response": {"kind": "page", "value": "é"}}) is True

    assert output.buffer.getvalue() == b'{"protocolVersion":2,"response":{"kind":"page","value":"\xc3\xa9"}}\n'
    assert failed.is_set() is False
    assert failures == []


def test_response_publisher_preflights_the_exact_multibyte_frame_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {"protocolVersion": 2, "response": {"kind": "page", "value": "é" * 32}}
    expected = (
        json.dumps(payload, default=str, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        + b"\n"
    )

    accepted_output = _BinaryOutput()
    accepted_failed = threading.Event()
    monkeypatch.setattr(server, "MAX_RESPONSE_FRAME_BYTES", len(expected))
    accepted = server._ResponsePublisher(
        accepted_output,
        threading.Lock(),
        accepted_failed,
        lambda _error: None,
    )
    assert accepted.publish(payload) is True
    assert accepted_output.buffer.getvalue() == expected

    rejected_output = _BinaryOutput()
    rejected_failed = threading.Event()
    failures: list[str] = []
    monkeypatch.setattr(server, "MAX_RESPONSE_FRAME_BYTES", len(expected) - 1)
    rejected = server._ResponsePublisher(
        rejected_output,
        threading.Lock(),
        rejected_failed,
        lambda error: failures.append(str(error)),
    )
    assert rejected.publish(payload) is False
    assert rejected_output.buffer.getvalue() == b""
    assert rejected_failed.is_set() is True
    assert failures == [f"response frame exceeds the {len(expected) - 1}-byte limit including LF"]


@pytest.mark.parametrize("failure_point", ["write", "short-write", "flush", "encoding"])
def test_response_publisher_failures_are_terminal_and_payload_free(failure_point: str) -> None:
    marker = "private-publication-payload"

    class FailingBuffer:
        def write(self, value: bytes) -> int:
            if failure_point == "write":
                raise OSError(marker)
            if failure_point == "short-write":
                return len(value) - 1
            return len(value)

        def flush(self) -> None:
            if failure_point == "flush":
                raise OSError(marker)

    class FailingOutput:
        def __init__(self) -> None:
            self.buffer = FailingBuffer()
            self.closed = False

        def fileno(self) -> int:
            return 123

        def close(self) -> None:
            self.closed = True

    output = FailingOutput()
    failed = threading.Event()
    failures: list[str] = []
    publisher = server._ResponsePublisher(
        output,
        threading.Lock(),
        failed,
        lambda error: failures.append(str(error)),
    )
    response: dict[str, Any] = {"kind": "error", "message": marker}
    if failure_point == "encoding":
        response["invalid"] = float("nan")

    assert publisher.publish(response) is False

    assert failed.is_set() is True
    assert output.closed is True
    assert len(failures) == 1
    assert failures[0] in {"response frame could not be published", "response frame is not valid strict JSON"}
    assert marker not in failures[0]
    assert publisher.publish({"kind": "initialized"}) is False
    assert len(failures) == 1


def test_async_oversized_mutation_publication_failure_returns_nonzero_without_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class OversizedMutationManager(_PassthroughRequestScope):
        def __init__(self) -> None:
            self.started = threading.Event()
            self.release_result = threading.Event()
            self.closed = False

        def apply_draft(self, *_args: Any) -> dict[str, Any]:
            self.started.set()
            assert self.release_result.wait(5)
            return {
                "kind": "planUpdated",
                "action": "apply",
                "revision": 1,
                "private": "private-mutation-result-" + ("x" * 1_024),
            }

        def close_all(self) -> None:
            self.closed = True

    manager = OversizedMutationManager()
    request = {
        "protocolVersion": 2,
        "requestId": "oversized-running-mutation",
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
    close_started = threading.Event()
    allow_close = threading.Event()
    failure_reported = threading.Event()

    def input_until_publication_fails():
        yield f"{json.dumps(request)}\n"
        assert manager.started.wait(5)
        manager.release_result.set()
        assert close_started.wait(5)

    def delayed_close(_publisher: server._ResponsePublisher) -> None:
        close_started.set()
        assert allow_close.wait(5)

    output = StringIO()
    errors = StringIO()
    monkeypatch.setattr(server, "MAX_RESPONSE_FRAME_BYTES", 256)
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server._ResponsePublisher, "_close_real_stream", delayed_close)
    monkeypatch.setattr(server, "_report_terminal_transport_error", lambda _error: failure_reported.set())
    monkeypatch.setattr(server.sys, "stdin", input_until_publication_fails())
    monkeypatch.setattr(server.sys, "stdout", output)
    monkeypatch.setattr(server.sys, "stderr", errors)

    try:
        exit_code = server.main()
        assert failure_reported.is_set() is False
    finally:
        allow_close.set()

    assert failure_reported.wait(5)
    assert exit_code == 1
    assert manager.closed is True
    assert output.getvalue() == ""
    assert errors.getvalue() == ""
