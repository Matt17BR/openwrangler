from __future__ import annotations

import os
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
    _frame_bytes,
    _go_frame,
    _install_request,
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

PAYLOAD_SECRET = b"ow-output-failure-payload-must-not-leak"


@pytest.fixture
def guard_runtime(request: pytest.FixtureRequest) -> Iterator[GuardRuntime]:
    runtime: GuardRuntime = request.getfixturevalue("shared_guard_runtime_fixture")
    assert not runtime.journal.exists()
    assert not runtime.pip_sentinel.exists()
    yield runtime
    if runtime.journal.exists():
        shutil.rmtree(runtime.journal)
    runtime.pip_sentinel.unlink(missing_ok=True)


def test_lost_error_frame_preserves_exit_without_payload_leak_and_recovers(guard_runtime: GuardRuntime) -> None:
    process = _start_with_closed_stdout(guard_runtime, "status", PAYLOAD_SECRET + b"\n")

    code, stderr = _finish_without_stdout(process)

    assert code == 10
    assert stderr == b""
    assert PAYLOAD_SECRET not in stderr
    assert not guard_runtime.journal.exists()
    _assert_clean_status(guard_runtime)


def test_lost_ready_frame_removes_marker_without_pip_and_recovers(guard_runtime: GuardRuntime) -> None:
    token = str(uuid.uuid4())
    process = _start_with_closed_stdout(
        guard_runtime,
        "install",
        _frame_bytes(_install_request(guard_runtime, token)),
    )

    code, stderr = _finish_without_stdout(process)

    assert code == 17
    assert stderr == b""
    assert token.encode("ascii") not in stderr
    assert not guard_runtime.pip_sentinel.exists()
    assert _marker_paths(guard_runtime) == []
    assert not list(guard_runtime.journal.glob(".pending-*.tmp"))
    _assert_clean_status(guard_runtime)


def test_broken_stdout_after_ready_rejected_go_removes_exact_marker_and_recovers(
    guard_runtime: GuardRuntime,
) -> None:
    token = str(uuid.uuid4())
    process = _arm_install(guard_runtime, token)
    marker = _only_marker(guard_runtime, token)
    _close_stdout(process)

    _write_bytes(process, PAYLOAD_SECRET + b"\n")
    code, stderr = _finish_without_stdout(process)

    assert code == 10
    assert stderr == b""
    assert PAYLOAD_SECRET not in stderr
    assert not marker.exists()
    assert _marker_paths(guard_runtime) == []
    assert not list(guard_runtime.journal.glob(".pending-*.tmp"))
    assert not guard_runtime.pip_sentinel.exists()
    _assert_clean_status(guard_runtime)


def test_broken_stdout_after_ready_pip_failure_retains_exact_marker_until_validation(
    guard_runtime: GuardRuntime,
) -> None:
    token = str(uuid.uuid4())
    process = _arm_install(guard_runtime, token, OW_GUARD_TEST_PIP_EXIT="9")
    marker = _only_marker(guard_runtime, token)
    before = _marker_snapshot(marker)
    _close_stdout(process)

    _write_bytes(process, _frame_bytes(_go_frame(token)))
    code, stderr = _finish_without_stdout(process)

    assert code == 14
    assert stderr == b""
    assert token.encode("ascii") not in stderr
    assert guard_runtime.pip_sentinel.read_bytes() == b"started"
    assert _marker_paths(guard_runtime) == [marker]
    assert _marker_snapshot(marker) == before

    validation = _run_command(guard_runtime, "validate", _validate_request(guard_runtime, token))
    assert validation.returncode == 0
    assert _output_frames(validation) == [{"kind": "validated", "protocol": PROTOCOL, "token": token}]
    assert validation.stderr == b""
    assert _marker_paths(guard_runtime) == []


def _start_with_closed_stdout(
    runtime: GuardRuntime,
    mode: str,
    request: bytes,
) -> subprocess.Popen[bytes]:
    read_descriptor, write_descriptor = os.pipe()
    environment = os.environ.copy()
    environment["OW_GUARD_TEST_PIP_SENTINEL"] = str(runtime.pip_sentinel)
    try:
        process = subprocess.Popen(
            [str(runtime.executable), "-I", str(HELPER), mode],
            stdin=subprocess.PIPE,
            stdout=write_descriptor,
            stderr=subprocess.PIPE,
            env=environment,
        )
    except BaseException:
        os.close(read_descriptor)
        raise
    finally:
        os.close(write_descriptor)
    os.close(read_descriptor)
    try:
        _write_bytes(process, request)
    except BaseException:
        process.kill()
        process.wait(timeout=PROCESS_TIMEOUT_SECONDS)
        raise
    return process


def _close_stdout(process: subprocess.Popen[bytes]) -> None:
    assert process.stdout is not None
    process.stdout.close()


def _finish_without_stdout(process: subprocess.Popen[bytes]) -> tuple[int, bytes]:
    assert process.stdin is not None
    process.stdin.close()
    process.stdin = None
    try:
        code = process.wait(timeout=PROCESS_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=PROCESS_TIMEOUT_SECONDS)
        raise AssertionError("The dependency guard did not exit before the timeout.") from None
    stderr = process.stderr.read() if process.stderr is not None else b""
    return code, stderr


def _assert_clean_status(runtime: GuardRuntime) -> None:
    status = _run_command(runtime, "status", _status_request(runtime))
    assert status.returncode == 0
    assert _output_frames(status) == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert status.stderr == b""
    assert _marker_paths(runtime) == []


def _status_request(runtime: GuardRuntime) -> dict[str, object]:
    return {"protocol": PROTOCOL, "kind": "status", "environment": runtime.environment}
