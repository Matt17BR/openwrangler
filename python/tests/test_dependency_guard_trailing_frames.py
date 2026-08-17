from __future__ import annotations

import shutil
import subprocess
import uuid
from collections.abc import Iterator

import pytest
from test_dependency_guard_install_frames import (
    HELPER,
    PROCESS_TIMEOUT_SECONDS,
    PROTOCOL,
    GuardRuntime,
    _arm_install,
    _finish,
    _frame_bytes,
    _go_frame,
    _marker_paths,
    _marker_snapshot,
    _only_marker,
    _output_frames,
    _run_command,
    _validate_request,
    _write_bytes,
)
from test_dependency_guard_install_frames import (
    shared_guard_runtime as shared_guard_runtime_fixture,  # noqa: F401
)

INVALID_REQUEST_FRAME = {
    "code": "invalid_request",
    "kind": "error",
    "protocol": PROTOCOL,
}
TRAILING_SECRET = b"ow-trailing-frame-payload-must-not-leak"


@pytest.fixture
def guard_runtime(request: pytest.FixtureRequest) -> Iterator[GuardRuntime]:
    runtime: GuardRuntime = request.getfixturevalue("shared_guard_runtime_fixture")
    assert not runtime.journal.exists()
    assert not runtime.pip_sentinel.exists()
    yield runtime
    if runtime.journal.exists():
        shutil.rmtree(runtime.journal)
    runtime.pip_sentinel.unlink(missing_ok=True)


@pytest.mark.parametrize("trailing", [TRAILING_SECRET, _frame_bytes({"unexpected": True})], ids=["byte", "frame"])
def test_status_rejects_trailing_input_and_recovers(
    guard_runtime: GuardRuntime,
    trailing: bytes,
) -> None:
    result = _run_raw_command(
        guard_runtime,
        "status",
        _frame_bytes(_status_request(guard_runtime)) + trailing,
    )

    assert result.returncode == 10
    assert _output_frames(result) == [INVALID_REQUEST_FRAME]
    assert TRAILING_SECRET not in result.stdout
    assert result.stderr == b""
    assert _marker_paths(guard_runtime) == []
    _assert_clean_status(guard_runtime)


@pytest.mark.parametrize("trailing", [TRAILING_SECRET, _frame_bytes({"unexpected": True})], ids=["byte", "frame"])
def test_validate_rejects_trailing_input_and_retains_exact_marker(
    guard_runtime: GuardRuntime,
    trailing: bytes,
) -> None:
    token = str(uuid.uuid4())
    install = _arm_install(guard_runtime, token)
    marker = _only_marker(guard_runtime, token)
    before = _marker_snapshot(marker)
    _write_bytes(install, _frame_bytes(_go_frame(token)))
    assert _finish(install) == (0, b"", b"")

    rejected = _run_raw_command(
        guard_runtime,
        "validate",
        _frame_bytes(_validate_request(guard_runtime, token)) + trailing,
    )

    assert rejected.returncode == 10
    assert _output_frames(rejected) == [INVALID_REQUEST_FRAME]
    assert TRAILING_SECRET not in rejected.stdout
    assert rejected.stderr == b""
    assert _marker_paths(guard_runtime) == [marker]
    assert _marker_snapshot(marker) == before

    recovered = _run_command(guard_runtime, "validate", _validate_request(guard_runtime, token))
    assert recovered.returncode == 0
    assert _output_frames(recovered) == [{"kind": "validated", "protocol": PROTOCOL, "token": token}]
    assert recovered.stderr == b""
    assert _marker_paths(guard_runtime) == []


@pytest.mark.parametrize("trailing", [TRAILING_SECRET, _frame_bytes({"unexpected": True})], ids=["byte", "frame"])
def test_go_rejects_trailing_input_and_removes_exact_marker_without_pip(
    guard_runtime: GuardRuntime,
    trailing: bytes,
) -> None:
    token = str(uuid.uuid4())
    install = _arm_install(guard_runtime, token)
    marker = _only_marker(guard_runtime, token)

    _write_bytes(install, _frame_bytes(_go_frame(token)) + trailing)
    code, stdout, stderr = _finish(install)

    assert code == 10
    assert stdout == b""
    assert stderr == b""
    assert not marker.exists()
    assert _marker_paths(guard_runtime) == []
    assert not list(guard_runtime.journal.glob(".pending-*.tmp"))
    assert not guard_runtime.pip_sentinel.exists()
    _assert_clean_status(guard_runtime)


def _run_raw_command(
    runtime: GuardRuntime,
    mode: str,
    request: bytes,
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [str(runtime.executable), "-I", str(HELPER), mode],
        input=request,
        capture_output=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )


def _assert_clean_status(runtime: GuardRuntime) -> None:
    result = _run_command(runtime, "status", _status_request(runtime))
    assert result.returncode == 0
    assert _output_frames(result) == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert result.stderr == b""


def _status_request(runtime: GuardRuntime) -> dict[str, object]:
    return {"protocol": PROTOCOL, "kind": "status", "environment": runtime.environment}
