from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any

import numpy as np
import pytest

import openwrangler_runtime.response_framing as response_framing
import openwrangler_runtime.server as server
from openwrangler_runtime.response_framing import (
    MAX_STRICT_JSON_NESTING_DEPTH,
    ResponseEncodingError,
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


def test_response_frame_is_compact_strict_utf8() -> None:
    frame = encode_response_frame(
        {
            "values": [None, True, False, 0, 1.5, "é"],
            "object": {"nested": "value"},
        }
    )

    assert frame == (b'{"values":[null,true,false,0,1.5,"\xc3\xa9"],"object":{"nested":"value"}}\n')
    assert b"\\u00e9" not in frame
    assert b": " not in frame


def test_response_frame_does_not_invoke_custom_string_coercion() -> None:
    class StringCoercionTrap:
        def __init__(self) -> None:
            self.calls = 0

        def __str__(self) -> str:
            self.calls += 1
            return "private-custom-value"

    value = StringCoercionTrap()

    with pytest.raises(
        ResponseEncodingError,
        match=r"^Response contains a value outside the strict JSON data model\.$",
    ):
        encode_response_frame({"value": value})
    with pytest.raises(ResponseEncodingError):
        strict_json_byte_length({"value": value}, 1_024)

    assert value.calls == 0


@pytest.mark.parametrize(
    ("builtin_type", "value"),
    (
        (str, "value"),
        (int, 1),
        (float, 1.5),
        (dict, {"value": 1}),
        (list, [1]),
    ),
)
def test_response_frame_rejects_subclasses_of_json_builtins(
    builtin_type: type[Any],
    value: object,
) -> None:
    subclass = type(f"Json{builtin_type.__name__}Subclass", (builtin_type,), {})

    with pytest.raises(
        ResponseEncodingError,
        match=r"^Response contains a value outside the strict JSON data model\.$",
    ):
        encode_response_frame(subclass(value))


def test_response_frame_matches_canonical_json_escaping_and_numbers() -> None:
    shared = [1, -0.0, 1e30]
    payload = {
        "escaped": 'quote=" backslash=\\ line=\n tab=\t',
        "emptyObject": {},
        "emptyArray": [],
        "shared": [shared, shared],
    }

    assert encode_response_frame(payload) == (
        json.dumps(
            payload,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
    )


@pytest.mark.parametrize(
    "value",
    (
        Decimal("1.25"),
        date(2026, 8, 20),
        Path("private-path"),
        np.int64(7),
        np.float64(1.5),
        ("tuple-is-not-a-json-array",),
        {1: "non-string-key"},
    ),
    ids=("decimal", "date", "path", "numpy-integer", "numpy-float", "tuple", "object-key"),
)
def test_response_frame_rejects_non_json_values_without_echoing_them(value: Any) -> None:
    with pytest.raises(ResponseEncodingError) as raised:
        encode_response_frame({"private": value})

    diagnostic = str(raised.value)
    assert len(diagnostic.encode("utf-8")) < 128
    assert "private-path" not in diagnostic
    assert "tuple-is-not-a-json-array" not in diagnostic


@pytest.mark.parametrize("value", (float("nan"), float("inf"), float("-inf")))
def test_response_frame_rejects_non_finite_numbers(value: float) -> None:
    with pytest.raises(
        ResponseEncodingError,
        match=r"^Response contains a non-finite JSON number\.$",
    ):
        encode_response_frame({"value": value})


def test_response_frame_rejects_invalid_unicode_in_keys_and_values() -> None:
    for payload in ({"value": "\ud800"}, {"\udfff": "value"}):
        with pytest.raises(
            ResponseEncodingError,
            match=r"^Response contains text that is not valid UTF-8\.$",
        ):
            encode_response_frame(payload)


def test_response_frame_rejects_cycles_without_partial_output() -> None:
    cycle: list[Any] = []
    cycle.append({"cycle": cycle})

    with pytest.raises(
        ResponseEncodingError,
        match=r"^Response contains a cyclic JSON collection\.$",
    ):
        encode_response_frame({"value": cycle})


def test_response_frame_accepts_exact_depth_and_rejects_one_more_level() -> None:
    assert MAX_STRICT_JSON_NESTING_DEPTH == 128
    accepted: Any = "leaf"
    for _ in range(MAX_STRICT_JSON_NESTING_DEPTH):
        accepted = [accepted]
    encode_response_frame(accepted)

    rejected = [accepted]
    with pytest.raises(
        ResponseEncodingError,
        match=rf"^Response exceeds the {MAX_STRICT_JSON_NESTING_DEPTH}-level JSON nesting limit\.$",
    ):
        encode_response_frame(rejected)


def test_response_frame_cap_counts_multibyte_utf8_and_lf_exactly() -> None:
    payload = {"value": "é" * 64}
    expected = json.dumps(payload, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"

    assert encode_response_frame(payload, len(expected)) == expected
    with pytest.raises(ResponseFrameTooLargeError):
        encode_response_frame(payload, len(expected) - 1)
    assert strict_json_byte_length(payload, len(expected)) == len(expected) - 1


@pytest.mark.parametrize(
    "payload",
    (
        {"value": "x" * 64},
        {"value": "é" * 64},
        {"x" * 64: None},
        {"é" * 64: None},
    ),
    ids=("ascii-value", "multibyte-value", "ascii-key", "multibyte-key"),
)
def test_response_frame_cap_is_exact_for_one_string_value_or_key(payload: dict[str, Any]) -> None:
    expected = (
        json.dumps(
            payload,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
    )

    assert encode_response_frame(payload, len(expected)) == expected
    with pytest.raises(ResponseFrameTooLargeError):
        encode_response_frame(payload, len(expected) - 1)


@pytest.mark.parametrize(
    "payload",
    (
        {"value": "x" * 100_000},
        {"value": "é" * 100_000},
        {"x" * 100_000: None},
        {"é" * 100_000: None},
    ),
    ids=("ascii-value", "multibyte-value", "ascii-key", "multibyte-key"),
)
def test_oversized_single_string_is_rejected_without_json_dumps(
    payload: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    serializer_calls = 0

    def serializer_must_not_run(*_args: Any, **_kwargs: Any) -> str:
        nonlocal serializer_calls
        serializer_calls += 1
        raise AssertionError("json.dumps received an oversized string scalar")

    monkeypatch.setattr(response_framing.json, "dumps", serializer_must_not_run)

    with pytest.raises(ResponseFrameTooLargeError):
        encode_response_frame(payload, 128)
    assert strict_json_byte_length(payload, 128) == 129
    assert serializer_calls == 0


def test_string_chunk_boundaries_match_canonical_json_escaping() -> None:
    value = ("x" * (16 * 1024 - 1)) + '\n"\\\t\x01é' + ("z" * (16 * 1024 + 1))
    payload = {value: value}
    expected = json.dumps(payload, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"

    assert encode_response_frame(payload, len(expected)) == expected


def test_oversized_integer_is_rejected_before_decimal_serialization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value = 10**10_000
    serializer_calls = 0

    def serializer_must_not_run(*_args: Any, **_kwargs: Any) -> str:
        nonlocal serializer_calls
        serializer_calls += 1
        raise AssertionError("json.dumps received an oversized integer scalar")

    monkeypatch.setattr(response_framing.json, "dumps", serializer_must_not_run)

    with pytest.raises(ResponseFrameTooLargeError):
        encode_response_frame({"value": value}, 128)
    assert strict_json_byte_length({"value": value}, 128) == 129
    assert serializer_calls == 0


def test_strict_json_byte_length_stops_after_crossing_the_bound() -> None:
    payload = {"secret": "private-response-payload-" + ("x" * 100_000)}

    measured = strict_json_byte_length(payload, 128)

    assert measured == 129


def test_strict_json_byte_length_does_not_traverse_after_crossing_the_bound() -> None:
    class MustNotBeVisited:
        pass

    measured = strict_json_byte_length(
        {"oversized": "x" * 100_000, "later": MustNotBeVisited()},
        128,
    )

    assert measured == 129


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
    expected = json.dumps(payload, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"

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

        def apply_draft(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
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
