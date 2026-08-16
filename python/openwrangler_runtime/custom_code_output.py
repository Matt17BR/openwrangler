from __future__ import annotations

import re
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from io import TextIOBase
from typing import Any, TextIO

MAX_CUSTOM_DIAGNOSTIC_BYTES = 8 * 1024
_TRUNCATED_MARKER = "\n<output truncated>"
_REDACTED_VALUE = "<redacted>"
_UNSAFE_OUTPUT = "<redacted unsafe output>"
_PRIVATE_KEY_OUTPUT = "<redacted private-key output>"

_PRIVATE_KEY_PATTERN = re.compile(r"-{4,5}\s*BEGIN[^\r\n]{0,160}PRIVATE KEY", re.IGNORECASE)
_BEARER_PATTERN = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_URL_CREDENTIAL_PATTERN = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s:/?#]+:)[^\s@/?#]+(@)", re.IGNORECASE)
_SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"(\b(?:authorization|auth|cookie|password|passwd|pwd|passphrase|api[_ -]?key|access[_ -]?token|"
    r"refresh[_ -]?token|secret|credential|token|pat)\b\s*(?::|=|=>|->)\s*)"
    r"(?:\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)",
    re.IGNORECASE,
)
_UNSAFE_CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_SURROGATE_PATTERN = re.compile(r"[\ud800-\udfff]")


class CapturedCustomCodeOutput:
    def __init__(self, state: _CaptureState) -> None:
        self._state = state

    @property
    def stdout(self) -> str:
        return self._state.stdout.value()

    @property
    def stderr(self) -> str:
        return self._state.stderr.value()

    def diagnostic_suffix(self) -> str:
        parts = []
        if self.stdout:
            parts.append(f"stdout:\n{_redact_diagnostic(self.stdout)}")
        if self.stderr:
            parts.append(f"stderr:\n{_redact_diagnostic(self.stderr)}")
        return "" if not parts else "\nCaptured custom-code output:\n" + "\n".join(parts)


class _BoundedTextBuffer:
    def __init__(self, byte_limit: int = MAX_CUSTOM_DIAGNOSTIC_BYTES) -> None:
        self._byte_limit = byte_limit
        self._parts: list[str] = []
        self._retained_bytes = 0
        self._truncated = False

    def write(self, value: Any) -> int:
        if not isinstance(value, str):
            raise TypeError(f"write() argument must be str, not {type(value).__name__}")
        original_length = len(value)
        remaining = self._byte_limit - self._retained_bytes
        if remaining <= 0:
            if value:
                self._truncated = True
            return original_length

        # One Unicode code point requires at least one UTF-8 byte, so this
        # slice bounds encoding work even for a single enormous no-newline
        # write. The incremental prefix keeps the exact byte ceiling.
        candidate = value[:remaining]
        encoded = candidate.encode("utf-8", errors="replace")
        if len(encoded) > remaining:
            encoded = encoded[:remaining]
            while encoded and (encoded[-1] & 0xC0) == 0x80:
                encoded = encoded[:-1]
            candidate = encoded.decode("utf-8", errors="ignore")
            encoded = candidate.encode("utf-8")
        if candidate:
            self._parts.append(candidate)
            self._retained_bytes += len(encoded)
        if len(candidate) < original_length:
            self._truncated = True
        return original_length

    def value(self) -> str:
        retained = "".join(self._parts)
        return f"{retained}{_TRUNCATED_MARKER}" if self._truncated else retained


class _CaptureState:
    def __init__(self) -> None:
        self.stdout = _BoundedTextBuffer()
        self.stderr = _BoundedTextBuffer()

    def write(self, channel: str, value: Any) -> int:
        return (self.stdout if channel == "stdout" else self.stderr).write(value)

class _BinaryCaptureRouter:
    def __init__(self, owner: _TextCaptureRouter) -> None:
        self._owner = owner

    def write(self, value: Any) -> int:
        if not isinstance(value, (bytes, bytearray, memoryview)):
            raise TypeError(f"a bytes-like object is required, not {type(value).__name__}")
        payload = bytes(value)
        state = _current_capture()
        if state is None:
            fallback = getattr(self._owner.fallback, "buffer", None)
            if fallback is None:
                return self._owner.fallback.write(payload.decode("utf-8", errors="replace"))
            return fallback.write(payload)
        state.write(self._owner.channel, payload.decode("utf-8", errors="replace"))
        return len(payload)

    def flush(self) -> None:
        if _current_capture() is None:
            fallback = getattr(self._owner.fallback, "buffer", None)
            if fallback is not None:
                fallback.flush()
            else:
                self._owner.fallback.flush()


class _TextCaptureRouter(TextIOBase):
    def __init__(self, channel: str, fallback: TextIO) -> None:
        self.channel = channel
        self.fallback = fallback
        self._binary = _BinaryCaptureRouter(self)

    @property
    def buffer(self) -> _BinaryCaptureRouter:
        return self._binary

    @property
    def encoding(self) -> str | None:
        return getattr(self.fallback, "encoding", None)

    @property
    def errors(self) -> str | None:
        return getattr(self.fallback, "errors", None)

    def fileno(self) -> int:
        return self.fallback.fileno()

    def isatty(self) -> bool:
        return self.fallback.isatty()

    def writable(self) -> bool:
        return True

    def write(self, value: Any) -> int:
        state = _current_capture()
        return self.fallback.write(value) if state is None else state.write(self.channel, value)

    def flush(self) -> None:
        if _current_capture() is None:
            self.fallback.flush()


_router_lock = threading.RLock()
_capture_local = threading.local()
_active_scopes = 0
_persistent_install = False
_stdout_router: _TextCaptureRouter | None = None
_stderr_router: _TextCaptureRouter | None = None
_saved_stdout: TextIO | None = None
_saved_stderr: TextIO | None = None
_saved_dunder_stdout: TextIO | None = None
_saved_dunder_stderr: TextIO | None = None


def _capture_stack() -> list[_CaptureState]:
    stack = getattr(_capture_local, "stack", None)
    if stack is None:
        stack = []
        _capture_local.stack = stack
    return stack


def _current_capture() -> _CaptureState | None:
    stack = getattr(_capture_local, "stack", None)
    return stack[-1] if stack else None


def _install_routers(*, persistent: bool) -> None:
    global _persistent_install, _saved_dunder_stderr, _saved_dunder_stdout
    global _saved_stderr, _saved_stdout, _stderr_router, _stdout_router

    if _stdout_router is None or _stderr_router is None:
        _saved_stdout = sys.stdout
        _saved_stderr = sys.stderr
        _saved_dunder_stdout = sys.__stdout__
        _saved_dunder_stderr = sys.__stderr__
        _stdout_router = _TextCaptureRouter("stdout", sys.stdout)
        _stderr_router = _TextCaptureRouter("stderr", sys.stderr)
    sys.stdout = _stdout_router
    sys.stderr = _stderr_router
    sys.__stdout__ = _stdout_router
    sys.__stderr__ = _stderr_router
    _persistent_install = _persistent_install or persistent


def install_custom_code_output_capture() -> None:
    """Install process-wide Python stream routers for a long-lived runtime.

    The standalone transport calls this before dispatching worker requests.
    Protocol output must retain its separately owned writer rather than write
    through ``sys.stdout`` after installation.
    """

    with _router_lock:
        _install_routers(persistent=True)
        assert _stdout_router is not None
        assert _saved_stderr is not None
        # A write outside an active request is diagnostic output, never a
        # protocol frame. The standalone server keeps its pre-install stdout
        # handle as the sole protocol writer.
        _stdout_router.fallback = _saved_stderr


@contextmanager
def capture_custom_code_output() -> Iterator[CapturedCustomCodeOutput]:
    global _active_scopes

    state = _CaptureState()
    with _router_lock:
        _install_routers(persistent=False)
        _active_scopes += 1
    stack = _capture_stack()
    stack.append(state)
    captured = CapturedCustomCodeOutput(state)
    try:
        yield captured
    finally:
        stack.pop()
        with _router_lock:
            # Arbitrary code may replace the process-global stream attributes.
            # Reassert the routers before releasing this scope so a later
            # request never inherits that replacement.
            assert _stdout_router is not None
            assert _stderr_router is not None
            sys.stdout = _stdout_router
            sys.stderr = _stderr_router
            sys.__stdout__ = _stdout_router
            sys.__stderr__ = _stderr_router
            _active_scopes -= 1
            _restore_transient_routers_if_idle()


def _restore_transient_routers_if_idle() -> None:
    global _saved_dunder_stderr, _saved_dunder_stdout, _saved_stderr, _saved_stdout
    global _stderr_router, _stdout_router

    if _persistent_install or _active_scopes != 0 or _stdout_router is None or _stderr_router is None:
        return
    assert _saved_stdout is not None
    assert _saved_stderr is not None
    assert _saved_dunder_stdout is not None
    assert _saved_dunder_stderr is not None
    sys.stdout = _saved_stdout
    sys.stderr = _saved_stderr
    sys.__stdout__ = _saved_dunder_stdout
    sys.__stderr__ = _saved_dunder_stderr
    _stdout_router = None
    _stderr_router = None
    _saved_stdout = None
    _saved_stderr = None
    _saved_dunder_stdout = None
    _saved_dunder_stderr = None


def custom_code_error_message(engine: str, error: BaseException | str, output: CapturedCustomCodeOutput) -> str:
    message = _redact_diagnostic(str(error))
    return f"Custom {engine} code failed: {message}{output.diagnostic_suffix()}"


def append_custom_code_output(message: str, output: CapturedCustomCodeOutput) -> str:
    return f"{message}{output.diagnostic_suffix()}"


def _redact_diagnostic(value: str) -> str:
    bounded = _bounded_text(value, MAX_CUSTOM_DIAGNOSTIC_BYTES)
    if _PRIVATE_KEY_PATTERN.search(bounded):
        return _PRIVATE_KEY_OUTPUT
    if _UNSAFE_CONTROL_PATTERN.search(bounded) or _SURROGATE_PATTERN.search(bounded):
        return _UNSAFE_OUTPUT
    redacted = _BEARER_PATTERN.sub(f"Bearer {_REDACTED_VALUE}", bounded)
    redacted = _URL_CREDENTIAL_PATTERN.sub(rf"\1{_REDACTED_VALUE}\2", redacted)
    return _SECRET_ASSIGNMENT_PATTERN.sub(rf"\1{_REDACTED_VALUE}", redacted)


def _bounded_text(value: str, byte_limit: int) -> str:
    buffer = _BoundedTextBuffer(byte_limit)
    buffer.write(value)
    return buffer.value()
