from __future__ import annotations

import json
import os
import queue
import shutil
import stat
import subprocess
import threading
import time
import uuid
import venv
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

PROTOCOL = "openwrangler-dependency-guard-v1"
HELPER = Path(__file__).parents[1] / "openwrangler_runtime" / "dependency_guard.py"
JOURNAL_NAME = ".openwrangler-dependency-journal-v1"
FRAME_TIMEOUT_SECONDS = 10
PROCESS_TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class GuardFixture:
    root: Path
    executable: Path
    environment: dict[str, Any]
    dependency: dict[str, Any]
    pip_sentinel: Path

    @property
    def journal(self) -> Path:
        return self.root / JOURNAL_NAME


@pytest.fixture
def guard_fixture(tmp_path: Path) -> GuardFixture:
    root = tmp_path / "selected"
    venv.EnvBuilder(with_pip=False).create(root)
    executable = root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    site_packages = _site_packages(executable)
    _write_fake_dependency(site_packages)
    _write_fake_pip(site_packages)
    environment = _probe_environment(executable)
    return GuardFixture(
        root=root,
        executable=executable,
        environment=environment,
        dependency={
            "importModule": "ow_guard_fixture",
            "distribution": "ow-guard-fixture",
            "installSpec": "ow-guard-fixture>=1.0,<2.0",
            "minimumVersion": "1.0",
            "maximumVersionExclusive": "2.0",
        },
        pip_sentinel=tmp_path / "pip-started.json",
    )


def _site_packages(executable: Path) -> Path:
    result = subprocess.run(
        [
            str(executable),
            "-I",
            "-c",
            "import json,site;print(json.dumps(site.getsitepackages(),separators=(',',':')))",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )
    candidates = json.loads(result.stdout)
    assert isinstance(candidates, list) and candidates
    return Path(candidates[0])


def _probe_environment(executable: Path) -> dict[str, Any]:
    program = "\n".join(
        [
            "import json,os,sys",
            "executable=os.path.abspath(sys.executable)",
            "root=os.path.realpath(os.path.abspath(sys.prefix))",
            "executable_stat=os.stat(executable)",
            "root_stat=os.stat(root)",
            "print(json.dumps({",
            "'executable':executable,",
            "'executableIdentity':{",
            "'device':str(executable_stat.st_dev),",
            "'inode':str(executable_stat.st_ino),",
            "'size':str(executable_stat.st_size),",
            "'mtimeNs':str(executable_stat.st_mtime_ns),",
            "'ctimeNs':str(executable_stat.st_ctime_ns),",
            "},",
            "'packageRoot':root,",
            "'packageRootIdentity':{'device':str(root_stat.st_dev),'inode':str(root_stat.st_ino)},",
            "'pythonVersion':'.'.join(str(part) for part in sys.version_info[:3]),",
            "},separators=(',',':')))",
        ]
    )
    result = subprocess.run(
        [str(executable), "-I", "-c", program],
        check=True,
        capture_output=True,
        text=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )
    decoded = json.loads(result.stdout)
    assert isinstance(decoded, dict)
    return decoded


def _write_fake_dependency(site_packages: Path) -> None:
    module = site_packages / "ow_guard_fixture"
    module.mkdir()
    (module / "__init__.py").write_text(
        "\n".join(
            [
                "import os",
                "import sys",
                "replacement = os.environ.get('OW_GUARD_TEST_REPLACE_EXECUTABLE')",
                "if replacement:",
                "    os.replace(replacement, sys.executable)",
                "VALUE = 1",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    metadata = site_packages / "ow_guard_fixture-1.2.3.dist-info"
    metadata.mkdir()
    (metadata / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: ow-guard-fixture\nVersion: 1.2.3\n",
        encoding="utf-8",
    )


def _write_fake_pip(site_packages: Path) -> None:
    package = site_packages / "pip"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "__main__.py").write_text(
        "\n".join(
            [
                "import json",
                "import os",
                "import pathlib",
                "import sys",
                "import time",
                "sentinel = pathlib.Path(os.environ['OW_GUARD_TEST_PIP_SENTINEL'])",
                "sentinel.write_text(json.dumps(sys.argv, separators=(',', ':')), encoding='utf-8')",
                "secret = os.environ.get('OW_GUARD_TEST_SECRET', 'package-output-must-not-escape')",
                "os.write(1, secret.encode('utf-8'))",
                "os.write(2, secret.encode('utf-8'))",
                "time.sleep(float(os.environ.get('OW_GUARD_TEST_PIP_SLEEP', '0')))",
                "raise SystemExit(int(os.environ.get('OW_GUARD_TEST_PIP_EXIT', '0')))",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _request_environment(fixture: GuardFixture) -> dict[str, Any]:
    return json.loads(json.dumps(fixture.environment))


def _install_request(
    fixture: GuardFixture,
    token: str,
    *,
    dependency: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "kind": "install",
        "token": token,
        "environment": _request_environment(fixture),
        "dependencies": [dependency or fixture.dependency],
    }


def _status_request(fixture: GuardFixture) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "kind": "status",
        "environment": _request_environment(fixture),
    }


def _validate_request(fixture: GuardFixture, expected_token: str) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "kind": "validate",
        "environment": _request_environment(fixture),
        "expectedToken": expected_token,
    }


def _go_frame(token: str) -> dict[str, Any]:
    return {"protocol": PROTOCOL, "kind": "go", "token": token}


def _frame_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"


def _process_environment(fixture: GuardFixture, **values: str) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(values)
    environment["OW_GUARD_TEST_PIP_SENTINEL"] = str(fixture.pip_sentinel)
    environment["OW_GUARD_TEST_SECRET"] = "dependency-secret-output"
    return environment


def _start(
    fixture: GuardFixture,
    mode: str,
    *,
    environment: dict[str, str] | None = None,
) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [str(fixture.executable), "-I", str(HELPER), mode],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment or _process_environment(fixture),
    )


def _write_frame(process: subprocess.Popen[bytes], payload: dict[str, Any]) -> None:
    assert process.stdin is not None
    process.stdin.write(_frame_bytes(payload))
    process.stdin.flush()


def _read_line_with_timeout(stream: Any) -> bytes:
    results: queue.Queue[bytes | BaseException] = queue.Queue(maxsize=1)

    def read() -> None:
        try:
            results.put(stream.readline())
        except BaseException as error:
            results.put(error)

    threading.Thread(target=read, daemon=True).start()
    try:
        result = results.get(timeout=FRAME_TIMEOUT_SECONDS)
    except queue.Empty:
        raise AssertionError("The dependency guard did not emit a frame before the timeout.") from None
    if isinstance(result, BaseException):
        raise result
    return result


def _read_frame(process: subprocess.Popen[bytes]) -> dict[str, Any]:
    assert process.stdout is not None
    line = _read_line_with_timeout(process.stdout)
    assert line.endswith(b"\n")
    decoded = json.loads(line)
    assert isinstance(decoded, dict)
    return decoded


def _finish(process: subprocess.Popen[bytes], *, close_stdin: bool = True) -> tuple[int, bytes, bytes]:
    if close_stdin and process.stdin is not None:
        process.stdin.close()
        process.stdin = None
    try:
        code = process.wait(timeout=PROCESS_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=PROCESS_TIMEOUT_SECONDS)
        raise AssertionError("The dependency guard did not exit before the timeout.") from None
    stdout = process.stdout.read() if process.stdout is not None else b""
    stderr = process.stderr.read() if process.stderr is not None else b""
    return code, stdout, stderr


def _run(
    fixture: GuardFixture,
    mode: str,
    request: dict[str, Any],
    *,
    environment: dict[str, str] | None = None,
) -> tuple[int, list[dict[str, Any]], bytes]:
    result = subprocess.run(
        [str(fixture.executable), "-I", str(HELPER), mode],
        input=_frame_bytes(request),
        capture_output=True,
        env=environment or _process_environment(fixture),
        timeout=PROCESS_TIMEOUT_SECONDS,
    )
    frames = [json.loads(line) for line in result.stdout.splitlines()]
    assert all(isinstance(frame, dict) for frame in frames)
    return result.returncode, frames, result.stderr


def _marker_paths(fixture: GuardFixture) -> list[Path]:
    if not fixture.journal.exists():
        return []
    return sorted(fixture.journal.glob("mutation-*.json"))


def _create_manual_journal(fixture: GuardFixture) -> None:
    fixture.journal.mkdir(mode=0o700)
    lock = fixture.journal / "mutation.lock"
    lock.write_bytes(b"")
    if os.name != "nt":
        fixture.journal.chmod(0o700)
        lock.chmod(0o600)


def _arm(
    fixture: GuardFixture,
    token: str,
    *,
    dependency: dict[str, Any] | None = None,
    environment: dict[str, str] | None = None,
) -> subprocess.Popen[bytes]:
    process = _start(fixture, "install", environment=environment)
    _write_frame(process, _install_request(fixture, token, dependency=dependency))
    assert _read_frame(process) == {"kind": "ready", "protocol": PROTOCOL, "token": token}
    return process


def test_status_reports_clean_without_creating_journal_in_read_only_prefix(guard_fixture: GuardFixture) -> None:
    original_mode = stat.S_IMODE(guard_fixture.root.stat().st_mode)
    if os.name != "nt":
        guard_fixture.root.chmod(0o555)
    try:
        code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    finally:
        if os.name != "nt":
            guard_fixture.root.chmod(original_mode)
    assert code == 0
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert stderr == b""
    assert not guard_fixture.journal.exists()


def test_status_establishes_guard_state_on_a_writable_absent_prefix(guard_fixture: GuardFixture) -> None:
    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 0
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert stderr == b""
    assert guard_fixture.journal.is_dir()
    assert (guard_fixture.journal / "mutation.lock").is_file()


def test_status_recovers_an_empty_journal_left_before_lock_creation(guard_fixture: GuardFixture) -> None:
    guard_fixture.journal.mkdir(mode=0o700)
    if os.name != "nt":
        guard_fixture.journal.chmod(0o700)
    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 0
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert stderr == b""
    assert (guard_fixture.journal / "mutation.lock").is_file()


def test_concurrent_status_on_absent_journal_never_misclassifies_clean_state(
    guard_fixture: GuardFixture,
) -> None:
    for _iteration in range(50):
        processes = [_start(guard_fixture, "status"), _start(guard_fixture, "status")]
        for process in processes:
            _write_frame(process, _status_request(guard_fixture))
        results = [_finish(process) for process in processes]
        assert any(code == 0 for code, _stdout, _stderr in results)
        for code, stdout, stderr in results:
            assert code in {0, 11}
            frames = [json.loads(line) for line in stdout.splitlines()]
            if code == 0:
                assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
            else:
                assert frames == [{"code": "busy", "kind": "error", "protocol": PROTOCOL}]
            assert stderr == b""
        lock = guard_fixture.journal / "mutation.lock"
        assert lock.is_file()
        assert _run(guard_fixture, "status", _status_request(guard_fixture))[0] == 0
        lock.unlink()
        guard_fixture.journal.rmdir()


@pytest.mark.parametrize(
    ("updates", "exit_code", "error_code"),
    [
        ({"size": "0"}, 10, "invalid_request"),
        ({"mtimeNs": "0", "ctimeNs": "0"}, 10, "invalid_request"),
        ({"mtimeNs": "-0"}, 10, "invalid_request"),
        ({"mtimeNs": str(-(1 << 127) - 1)}, 10, "invalid_request"),
        ({"ctimeNs": str(1 << 127)}, 10, "invalid_request"),
        ({"mtimeNs": str(-(1 << 127))}, 16, "environment_changed"),
        ({"ctimeNs": str((1 << 127) - 1)}, 16, "environment_changed"),
    ],
)
def test_executable_identity_decoder_is_signed_bounded_and_nonzero(
    guard_fixture: GuardFixture,
    updates: dict[str, str],
    exit_code: int,
    error_code: str,
) -> None:
    request = _status_request(guard_fixture)
    request["environment"]["executableIdentity"].update(updates)
    code, frames, stderr = _run(guard_fixture, "status", request)
    assert code == exit_code
    assert frames == [{"code": error_code, "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert not guard_fixture.journal.exists()


@pytest.mark.parametrize(
    "install_spec",
    [
        "--target=/tmp/openwrangler",
        "https://example.invalid/package.whl",
        "./package.whl",
        "ow-guard-fixture @ https://example.invalid/package.whl",
        "ow-guard-fixture;python_version>='3.10'",
        "ow-guard-fixture[extra]",
        "different-package>=1.0",
    ],
)
def test_install_spec_rejects_options_urls_files_markers_extras_and_name_mismatch(
    guard_fixture: GuardFixture,
    install_spec: str,
) -> None:
    token = str(uuid.uuid4())
    dependency = {**guard_fixture.dependency, "installSpec": install_spec}
    code, frames, stderr = _run(
        guard_fixture,
        "install",
        _install_request(guard_fixture, token, dependency=dependency),
    )
    assert code == 10
    assert frames == [{"code": "invalid_request", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert not guard_fixture.pip_sentinel.exists()
    assert not guard_fixture.journal.exists()


def test_install_spec_distribution_name_uses_normalized_comparison(guard_fixture: GuardFixture) -> None:
    token = str(uuid.uuid4())
    dependency = {
        **guard_fixture.dependency,
        "distribution": "OW.Guard_Fixture",
        "installSpec": "ow-guard-fixture>=1.0,<2.0",
    }
    process = _arm(guard_fixture, token, dependency=dependency)
    assert _finish(process)[0] == 10
    assert _marker_paths(guard_fixture) == []


def test_install_publishes_before_ready_waits_for_go_and_suppresses_pip_output(
    guard_fixture: GuardFixture,
) -> None:
    token = str(uuid.uuid4())
    process = _arm(guard_fixture, token)
    markers = _marker_paths(guard_fixture)
    assert [path.name for path in markers] == [f"mutation-{token}.json"]
    marker = json.loads(markers[0].read_text(encoding="utf-8"))
    assert marker["token"] == token
    assert marker["environment"] == guard_fixture.environment
    assert marker["dependencies"] == [guard_fixture.dependency]
    time.sleep(0.15)
    assert not guard_fixture.pip_sentinel.exists()

    _write_frame(process, _go_frame(token))
    code, stdout, stderr = _finish(process)
    assert code == 0
    assert stdout == b""
    assert stderr == b""
    assert "dependency-secret-output" not in guard_fixture.pip_sentinel.read_text(encoding="utf-8")
    arguments = json.loads(guard_fixture.pip_sentinel.read_text(encoding="utf-8"))
    assert arguments[1:] == [
        "install",
        "--no-input",
        "--no-user",
        "--",
        guard_fixture.dependency["installSpec"],
    ]
    assert _marker_paths(guard_fixture) == markers


def test_eof_before_go_removes_only_own_marker_without_running_pip(guard_fixture: GuardFixture) -> None:
    token = str(uuid.uuid4())
    process = _arm(guard_fixture, token)
    code, stdout, stderr = _finish(process)
    assert code == 10
    assert stdout == b""
    assert stderr == b""
    assert not guard_fixture.pip_sentinel.exists()
    assert _marker_paths(guard_fixture) == []


@pytest.mark.skipif(os.name == "nt", reason="Windows does not permit replacing an executing Python image.")
def test_environment_replacement_between_ready_and_go_never_invokes_pip(guard_fixture: GuardFixture) -> None:
    token = str(uuid.uuid4())
    process = _arm(guard_fixture, token)
    backup = guard_fixture.root.parent / "python-backup"
    shutil.copyfile(guard_fixture.executable, backup)
    guard_fixture.executable.unlink()
    shutil.copyfile(backup, guard_fixture.executable)
    guard_fixture.executable.chmod(0o755)

    _write_frame(process, _go_frame(token))
    code, stdout, stderr = _finish(process)
    assert code == 16
    assert stdout == b""
    assert stderr == b""
    assert not guard_fixture.pip_sentinel.exists()
    assert _marker_paths(guard_fixture) == []


def test_abrupt_termination_releases_lock_and_validator_clears_retained_marker(
    guard_fixture: GuardFixture,
) -> None:
    token = str(uuid.uuid4())
    process = _arm(guard_fixture, token)
    process.kill()
    process.wait(timeout=PROCESS_TIMEOUT_SECONDS)
    assert [path.name for path in _marker_paths(guard_fixture)] == [f"mutation-{token}.json"]

    code, frames, stderr = _run(guard_fixture, "validate", _validate_request(guard_fixture, token))
    assert code == 0
    assert frames == [{"kind": "validated", "protocol": PROTOCOL, "token": token}]
    assert stderr == b""
    assert _marker_paths(guard_fixture) == []


def test_status_and_validation_fail_busy_while_pip_holds_lock(guard_fixture: GuardFixture) -> None:
    token = str(uuid.uuid4())
    process = _arm(
        guard_fixture,
        token,
        environment=_process_environment(guard_fixture, OW_GUARD_TEST_PIP_SLEEP="1.5"),
    )
    _write_frame(process, _go_frame(token))
    deadline = time.monotonic() + FRAME_TIMEOUT_SECONDS
    while not guard_fixture.pip_sentinel.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert guard_fixture.pip_sentinel.exists()

    status_code, status_frames, _stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    validate_code, validate_frames, _stderr = _run(guard_fixture, "validate", _validate_request(guard_fixture, token))
    assert status_code == 11
    assert status_frames == [{"code": "busy", "kind": "error", "protocol": PROTOCOL}]
    assert validate_code == 11
    assert validate_frames == [{"code": "busy", "kind": "error", "protocol": PROTOCOL}]
    assert _finish(process)[0] == 0


def test_concurrent_install_is_busy_and_cannot_replace_first_marker(guard_fixture: GuardFixture) -> None:
    first_token = str(uuid.uuid4())
    second_token = str(uuid.uuid4())
    first = _arm(guard_fixture, first_token)
    code, frames, stderr = _run(
        guard_fixture,
        "install",
        _install_request(guard_fixture, second_token),
    )
    assert code == 11
    assert frames == [{"code": "busy", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert [path.name for path in _marker_paths(guard_fixture)] == [f"mutation-{first_token}.json"]
    assert _finish(first)[0] == 10
    assert _marker_paths(guard_fixture) == []


def test_successful_pip_retains_marker_until_fresh_validation_clears_it(guard_fixture: GuardFixture) -> None:
    token = str(uuid.uuid4())
    process = _arm(guard_fixture, token)
    _write_frame(process, _go_frame(token))
    assert _finish(process)[0] == 0
    assert len(_marker_paths(guard_fixture)) == 1

    status_code, status_frames, status_stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert status_code == 0
    assert status_frames == [{"kind": "status", "protocol": PROTOCOL, "state": "dirty", "token": token}]
    assert status_stderr == b""

    code, frames, stderr = _run(guard_fixture, "validate", _validate_request(guard_fixture, token))
    assert code == 0
    assert frames == [{"kind": "validated", "protocol": PROTOCOL, "token": token}]
    assert stderr == b""
    assert _marker_paths(guard_fixture) == []


@pytest.mark.skipif(os.name == "nt", reason="Windows does not permit replacing an executing Python image.")
def test_environment_change_during_validation_retains_marker(guard_fixture: GuardFixture) -> None:
    token = str(uuid.uuid4())
    process = _arm(guard_fixture, token)
    _write_frame(process, _go_frame(token))
    assert _finish(process)[0] == 0
    marker = _marker_paths(guard_fixture)[0]
    original = marker.read_bytes()
    replacement = guard_fixture.root.parent / "replacement-python"
    shutil.copyfile(guard_fixture.executable, replacement)
    replacement.chmod(0o755)

    code, frames, stderr = _run(
        guard_fixture,
        "validate",
        _validate_request(guard_fixture, token),
        environment=_process_environment(
            guard_fixture,
            OW_GUARD_TEST_REPLACE_EXECUTABLE=str(replacement),
        ),
    )
    assert code == 16
    assert frames == [{"code": "environment_changed", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert marker.read_bytes() == original


def test_failed_pip_retains_marker_and_does_not_expose_output(guard_fixture: GuardFixture) -> None:
    token = str(uuid.uuid4())
    process = _arm(
        guard_fixture,
        token,
        environment=_process_environment(guard_fixture, OW_GUARD_TEST_PIP_EXIT="7"),
    )
    _write_frame(process, _go_frame(token))
    code, stdout, stderr = _finish(process)
    assert code == 14
    assert stdout == b""
    assert stderr == b""
    assert guard_fixture.pip_sentinel.exists()
    assert len(_marker_paths(guard_fixture)) == 1


def test_failed_dependency_validation_retains_exact_marker(guard_fixture: GuardFixture) -> None:
    token = str(uuid.uuid4())
    incompatible = {**guard_fixture.dependency, "minimumVersion": "2.0"}
    process = _arm(guard_fixture, token, dependency=incompatible)
    _write_frame(process, _go_frame(token))
    assert _finish(process)[0] == 0
    marker = _marker_paths(guard_fixture)[0]
    original = marker.read_bytes()

    code, frames, stderr = _run(guard_fixture, "validate", _validate_request(guard_fixture, token))
    assert code == 13
    assert frames == [{"code": "validation_failed", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert marker.read_bytes() == original


def test_stale_validator_token_cannot_clear_a_different_marker(guard_fixture: GuardFixture) -> None:
    token = str(uuid.uuid4())
    process = _arm(guard_fixture, token)
    _write_frame(process, _go_frame(token))
    assert _finish(process)[0] == 0

    code, frames, stderr = _run(guard_fixture, "validate", _validate_request(guard_fixture, str(uuid.uuid4())))
    assert code == 15
    assert frames == [{"code": "stale_or_missing_marker", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert len(_marker_paths(guard_fixture)) == 1


def test_malformed_marker_fails_closed_and_is_retained(guard_fixture: GuardFixture) -> None:
    _create_manual_journal(guard_fixture)
    token = str(uuid.uuid4())
    marker = guard_fixture.journal / f"mutation-{token}.json"
    marker.write_bytes(b'{"protocol":')
    if os.name != "nt":
        marker.chmod(0o600)

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert marker.read_bytes() == b'{"protocol":'


def test_orphaned_prepublish_temp_is_cleaned_only_under_lock(guard_fixture: GuardFixture) -> None:
    _create_manual_journal(guard_fixture)
    temporary = guard_fixture.journal / f".pending-{uuid.uuid4()}.tmp"
    temporary.write_bytes(b"partial")
    if os.name != "nt":
        temporary.chmod(0o600)

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 0
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert stderr == b""
    assert not temporary.exists()


@pytest.mark.skipif(os.name == "nt", reason="Creating Windows symlinks requires host-specific privileges.")
@pytest.mark.parametrize("leaf", ["lock", "temporary", "marker"])
def test_reparse_like_leaf_is_rejected_without_touching_its_target(
    guard_fixture: GuardFixture,
    leaf: str,
) -> None:
    _create_manual_journal(guard_fixture)
    target = guard_fixture.root.parent / f"{leaf}-target"
    target.write_bytes(b"unchanged")
    target.chmod(0o600)
    if leaf == "lock":
        path = guard_fixture.journal / "mutation.lock"
        path.unlink()
    elif leaf == "temporary":
        path = guard_fixture.journal / f".pending-{uuid.uuid4()}.tmp"
    else:
        path = guard_fixture.journal / f"mutation-{uuid.uuid4()}.json"
    path.symlink_to(target)

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert target.read_bytes() == b"unchanged"
