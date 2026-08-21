from __future__ import annotations

import errno
import importlib.util
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
from dependency_guard_test_support import create_fake_pip_package

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
    pip_release: Path

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
            "exactVersion": None,
            "minimumVersion": "1.0",
            "maximumVersionExclusive": "2.0",
        },
        pip_sentinel=tmp_path / "pip-started.json",
        pip_release=tmp_path / "pip-release",
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
    (metadata / "RECORD").write_text(
        "ow_guard_fixture/__init__.py,,\n",
        encoding="utf-8",
    )


def _write_legacy_pandas_distribution(site_packages: Path, version: str) -> None:
    module = site_packages / "pandas"
    module.mkdir()
    (module / "__init__.py").write_text("VALUE = 1\n", encoding="utf-8")
    metadata = site_packages / "pandas-legacy.dist-info"
    metadata.mkdir()
    (metadata / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: pandas\nVersion: {version}\n",
        encoding="utf-8",
    )
    (metadata / "RECORD").write_text("pandas/__init__.py,,\n", encoding="utf-8")


def _write_fake_pip(site_packages: Path) -> None:
    package = create_fake_pip_package(site_packages)
    (package / "__main__.py").write_text(
        "\n".join(
            [
                "import json",
                "import os",
                "import pathlib",
                "import sys",
                "import time",
                "if sys.argv[1:] == ['check', '--disable-pip-version-check']:",
                "    checks = os.environ.get('OW_GUARD_TEST_PIP_CHECKS')",
                "    if checks:",
                "        with pathlib.Path(checks).open('a', encoding='utf-8') as stream:",
                "            stream.write('check\\n')",
                "    time.sleep(float(os.environ.get('OW_GUARD_TEST_PIP_CHECK_SLEEP', '0')))",
                "    raise SystemExit(int(os.environ.get('OW_GUARD_TEST_PIP_CHECK_EXIT', '0')))",
                "sentinel = pathlib.Path(os.environ['OW_GUARD_TEST_PIP_SENTINEL'])",
                "sentinel.write_text(json.dumps(sys.argv, separators=(',', ':')), encoding='utf-8')",
                "secret = os.environ.get('OW_GUARD_TEST_SECRET', 'package-output-must-not-escape')",
                "os.write(1, secret.encode('utf-8'))",
                "os.write(2, secret.encode('utf-8'))",
                "release = os.environ.get('OW_GUARD_TEST_PIP_RELEASE')",
                "if release:",
                "    release_path = pathlib.Path(release)",
                "    while not release_path.exists():",
                "        time.sleep(0.01)",
                "else:",
                "    time.sleep(float(os.environ.get('OW_GUARD_TEST_PIP_SLEEP', '0')))",
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


def _create_manual_empty_journal(fixture: GuardFixture) -> None:
    if os.name == "nt":
        guard = _load_dependency_guard()
        assert (
            guard._windows_create_secure_directory(
                fixture.journal,
                allow_permission_failure=False,
                code="malformed_state",
            )
            is True
        )
        guard._validate_private_directory(fixture.journal)
        return
    fixture.journal.mkdir(mode=0o700)
    fixture.journal.chmod(0o700)


def _create_manual_journal(fixture: GuardFixture) -> None:
    if os.name == "nt":
        code, frames, stderr = _run(fixture, "status", _status_request(fixture))
        assert code == 0
        assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
        assert stderr == b""
        return
    _create_manual_empty_journal(fixture)
    lock = fixture.journal / "mutation.lock"
    lock.write_bytes(b"")
    lock.chmod(0o600)


def _write_manual_journal_leaf(path: Path, payload: bytes) -> None:
    if os.name != "nt":
        path.write_bytes(payload)
        path.chmod(0o600)
        return
    guard = _load_dependency_guard()
    descriptor = guard._windows_create_secure_leaf_descriptor(
        path,
        desired_access=(
            guard._WINDOWS_GENERIC_WRITE | guard._WINDOWS_READ_CONTROL | guard._WINDOWS_FILE_READ_ATTRIBUTES
        ),
        share_mode=0,
        descriptor_flags=os.O_WRONLY,
        code="malformed_state",
    )
    try:
        guard._write_all(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    guard._lstat_private_file(path, code="malformed_state")


def _write_legacy_marker(
    fixture: GuardFixture,
    token: str,
    dependency: dict[str, Any] | list[dict[str, Any]],
) -> Path:
    _create_manual_journal(fixture)
    marker = fixture.journal / f"mutation-{token}.json"
    payload = json.dumps(
        {
            "dependencies": dependency if isinstance(dependency, list) else [dependency],
            "environment": fixture.environment,
            "protocol": PROTOCOL,
            "token": token,
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")
    _write_manual_journal_leaf(marker, payload)
    return marker


def _run_icacls(path: Path, *arguments: str) -> None:
    result = subprocess.run(
        ["icacls", str(path), *arguments],
        capture_output=True,
        text=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def _assert_windows_namespace_replace_blocked(
    fixture: GuardFixture,
    source: Path,
    destination: Path,
) -> None:
    program = "\n".join(
        [
            "import errno,json,os,sys",
            "try:",
            "    os.replace(sys.argv[1],sys.argv[2])",
            "except OSError as error:",
            "    print(json.dumps({'errno':error.errno,'winerror':getattr(error,'winerror',None)}))",
            "    raise SystemExit(0)",
            "raise SystemExit(1)",
        ]
    )
    result = subprocess.run(
        [
            str(fixture.executable),
            "-I",
            "-c",
            program,
            str(source),
            str(destination),
        ],
        capture_output=True,
        text=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )
    assert result.returncode == 0, result.stderr
    failure = json.loads(result.stdout)
    assert failure["errno"] in {errno.EACCES, errno.EPERM}
    assert failure["winerror"] in {None, 5, 32}
    assert result.stderr == ""


def _load_dependency_guard() -> Any:
    specification = importlib.util.spec_from_file_location(
        "openwrangler_runtime.dependency_guard",
        HELPER,
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def test_in_process_request_normalization_covers_every_protocol_mode() -> None:
    guard = _load_dependency_guard()
    environment = guard._actual_environment()
    dependency = {
        "importModule": "example.module",
        "distribution": "Example_Package",
        "installSpec": "example-package>=1.2,<2.0",
        "exactVersion": None,
        "minimumVersion": "1.2",
        "maximumVersionExclusive": "2.0",
    }
    token = str(uuid.uuid4())

    install = {
        "protocol": PROTOCOL,
        "kind": "install",
        "token": token,
        "environment": environment,
        "dependencies": [dependency],
    }
    status = {
        "protocol": PROTOCOL,
        "kind": "status",
        "environment": environment,
    }
    validate = {
        "protocol": PROTOCOL,
        "kind": "validate",
        "environment": environment,
        "expectedToken": token,
    }

    assert guard._normalize_request("install", install) == install
    assert guard._normalize_request("status", status) == status
    assert guard._normalize_request("validate", validate) == validate


def test_in_process_request_normalization_rejects_noncanonical_inputs() -> None:
    guard = _load_dependency_guard()
    environment = guard._actual_environment()
    dependency = {
        "importModule": "example.module",
        "distribution": "example-package",
        "installSpec": "example-package>=1.2,<2.0",
        "exactVersion": None,
        "minimumVersion": "1.2",
        "maximumVersionExclusive": "2.0",
    }
    token = str(uuid.uuid4())

    with pytest.raises(guard.GuardError, match="invalid_request"):
        guard._normalize_request("unknown", {})

    wrong_protocol = {
        "protocol": "wrong",
        "kind": "status",
        "environment": environment,
    }
    with pytest.raises(guard.GuardError, match="invalid_request"):
        guard._normalize_request("status", wrong_protocol)

    relative_environment = json.loads(json.dumps(environment))
    relative_environment["packageRoot"] = "relative"
    with pytest.raises(guard.GuardError, match="invalid_request"):
        guard._normalize_environment(
            relative_environment,
            compare_actual=False,
            code="invalid_request",
        )

    duplicate_dependencies = {
        "protocol": PROTOCOL,
        "kind": "install",
        "token": token,
        "environment": environment,
        "dependencies": [dependency, dependency],
    }
    with pytest.raises(guard.GuardError, match="invalid_request"):
        guard._normalize_request("install", duplicate_dependencies)

    mismatched_dependency = dict(dependency)
    mismatched_dependency["installSpec"] = "different-package>=1"
    with pytest.raises(guard.GuardError, match="invalid_request"):
        guard._normalize_dependency(mismatched_dependency, code="invalid_request")


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


def test_journal_lock_exit_preserves_a_primary_body_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    lock = object.__new__(guard._JournalLock)
    close_modes: list[bool] = []

    monkeypatch.setattr(lock, "_release", lambda: None)

    def close(*, suppress_errors: bool = False) -> None:
        close_modes.append(suppress_errors)
        if not suppress_errors:
            raise OSError("simulated close failure")

    monkeypatch.setattr(lock, "_close", close)
    primary = RuntimeError("primary body failure")
    lock.__exit__(RuntimeError, primary, primary.__traceback__)
    assert close_modes == [True]


def test_journal_lock_exit_preserves_body_over_release_and_close_faults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    lock = object.__new__(guard._JournalLock)
    primary = RuntimeError("primary body failure")
    cleanup_calls: list[str] = []

    def release() -> None:
        cleanup_calls.append("release")
        raise OSError("simulated release failure")

    def close(*, suppress_errors: bool = False) -> None:
        cleanup_calls.append(f"close:{suppress_errors}")
        raise OSError("simulated close failure")

    monkeypatch.setattr(lock, "_release", release)
    monkeypatch.setattr(lock, "_close", close)
    lock.__exit__(RuntimeError, primary, primary.__traceback__)
    assert cleanup_calls == ["release", "close:True"]


def test_journal_lock_exit_preserves_a_primary_release_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    lock = object.__new__(guard._JournalLock)
    primary = RuntimeError("primary release failure")
    close_modes: list[bool] = []

    def release() -> None:
        raise primary

    def close(*, suppress_errors: bool = False) -> None:
        close_modes.append(suppress_errors)
        raise OSError("simulated close failure")

    monkeypatch.setattr(lock, "_release", release)
    monkeypatch.setattr(lock, "_close", close)
    with pytest.raises(RuntimeError) as raised:
        lock.__exit__(None, None, None)
    assert raised.value is primary
    assert close_modes == [True]


@pytest.mark.skipif(
    os.name == "nt",
    reason="POSIX mode bits cannot establish the read-only-prefix precondition on Windows.",
)
def test_status_reports_clean_without_creating_journal_in_read_only_prefix(guard_fixture: GuardFixture) -> None:
    original_mode = stat.S_IMODE(guard_fixture.root.stat().st_mode)
    guard_fixture.root.chmod(0o555)
    try:
        code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    finally:
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


@pytest.mark.skipif(os.name == "nt", reason="Requires POSIX flock and EROFS semantics.")
def test_status_locks_an_existing_clean_journal_on_a_read_only_mount(
    guard_fixture: GuardFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    before = lock.stat()
    original_open = guard.os.open
    access_modes: list[int] = []
    frames: list[dict[str, Any]] = []

    def open_with_read_only_mount(path: str | os.PathLike[str], flags: int, mode: int = 0o777) -> int:
        if Path(path) == lock:
            access_mode = flags & os.O_ACCMODE
            access_modes.append(access_mode)
            if access_mode == os.O_RDWR:
                raise OSError(errno.EROFS, "simulated read-only mount")
        return original_open(path, flags, mode)

    monkeypatch.setattr(guard.os, "open", open_with_read_only_mount)
    monkeypatch.setattr(guard, "_emit", frames.append)
    monkeypatch.setattr(guard, "_actual_environment", lambda: _request_environment(guard_fixture))

    assert guard._run_status(_status_request(guard_fixture)) == 0
    after = lock.stat()
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert access_modes == [os.O_RDWR, os.O_RDONLY]
    assert (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    ) == (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    )


@pytest.mark.skipif(os.name == "nt", reason="Requires POSIX flock and EROFS semantics.")
def test_read_only_status_reports_a_valid_retained_marker_as_dirty_without_changing_it(
    guard_fixture: GuardFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    identity = guard._validate_private_directory(guard_fixture.journal)
    token = str(uuid.uuid4())
    marker, _payload, _marker_identity = guard._publish_marker(
        guard_fixture.journal,
        identity,
        token,
        guard_fixture.environment,
        [guard_fixture.dependency],
    )
    before = marker.read_bytes()
    before_stat = marker.stat()
    original_open = guard.os.open
    frames: list[dict[str, Any]] = []

    def open_with_read_only_mount(path: str | os.PathLike[str], flags: int, mode: int = 0o777) -> int:
        if Path(path) == lock and flags & os.O_ACCMODE == os.O_RDWR:
            raise OSError(errno.EROFS, "simulated read-only mount")
        return original_open(path, flags, mode)

    monkeypatch.setattr(guard.os, "open", open_with_read_only_mount)
    monkeypatch.setattr(guard, "_emit", frames.append)
    monkeypatch.setattr(guard, "_actual_environment", lambda: _request_environment(guard_fixture))

    assert guard._run_status(_status_request(guard_fixture)) == 0
    after_stat = marker.stat()
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "dirty", "token": token}]
    assert marker.read_bytes() == before
    assert (
        after_stat.st_dev,
        after_stat.st_ino,
        after_stat.st_mode,
        after_stat.st_size,
        after_stat.st_mtime_ns,
        after_stat.st_ctime_ns,
    ) == (
        before_stat.st_dev,
        before_stat.st_ino,
        before_stat.st_mode,
        before_stat.st_size,
        before_stat.st_mtime_ns,
        before_stat.st_ctime_ns,
    )


@pytest.mark.skipif(os.name == "nt", reason="Requires POSIX EROFS semantics.")
def test_read_only_status_never_accepts_an_existing_journal_without_a_lock(
    guard_fixture: GuardFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_empty_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    original_open = guard.os.open
    access_modes: list[int] = []

    def refuse_lock_creation(path: str | os.PathLike[str], flags: int, mode: int = 0o777) -> int:
        if Path(path) == lock:
            access_modes.append(flags & os.O_ACCMODE)
            raise OSError(errno.EROFS, "simulated read-only mount")
        return original_open(path, flags, mode)

    monkeypatch.setattr(guard.os, "open", refuse_lock_creation)
    monkeypatch.setattr(guard, "_actual_environment", lambda: _request_environment(guard_fixture))

    with pytest.raises(guard.GuardError) as raised:
        guard._run_status(_status_request(guard_fixture))
    assert raised.value.code == "malformed_state"
    assert access_modes == [os.O_RDWR]
    assert not lock.exists()


@pytest.mark.skipif(os.name == "nt", reason="Requires POSIX EROFS semantics.")
def test_read_only_status_never_hides_an_unrecoverable_pending_marker(
    guard_fixture: GuardFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    pending = guard_fixture.journal / f".pending-{uuid.uuid4()}.tmp"
    _write_manual_journal_leaf(pending, b"partial")
    original_open = guard.os.open
    original_unlink = guard.Path.unlink
    frames: list[dict[str, Any]] = []

    def open_with_read_only_mount(path: str | os.PathLike[str], flags: int, mode: int = 0o777) -> int:
        if Path(path) == lock and flags & os.O_ACCMODE == os.O_RDWR:
            raise OSError(errno.EROFS, "simulated read-only mount")
        return original_open(path, flags, mode)

    def unlink_from_read_only_mount(path: Path, *args: Any, **kwargs: Any) -> None:
        if path == pending:
            raise OSError(errno.EROFS, "simulated read-only mount")
        original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(guard.os, "open", open_with_read_only_mount)
    monkeypatch.setattr(guard.Path, "unlink", unlink_from_read_only_mount)
    monkeypatch.setattr(guard, "_emit", frames.append)
    monkeypatch.setattr(guard, "_actual_environment", lambda: _request_environment(guard_fixture))

    with pytest.raises(guard.GuardError) as raised:
        guard._run_status(_status_request(guard_fixture))
    assert raised.value.code == "malformed_state"
    assert frames == []
    assert pending.read_bytes() == b"partial"


@pytest.mark.skipif(os.name == "nt", reason="Requires POSIX EROFS semantics.")
def test_read_only_status_never_hides_an_unknown_journal_leaf(
    guard_fixture: GuardFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    unknown = guard_fixture.journal / "unexpected.json"
    _write_manual_journal_leaf(unknown, b"malformed")
    original_open = guard.os.open
    frames: list[dict[str, Any]] = []

    def open_with_read_only_mount(path: str | os.PathLike[str], flags: int, mode: int = 0o777) -> int:
        if Path(path) == lock and flags & os.O_ACCMODE == os.O_RDWR:
            raise OSError(errno.EROFS, "simulated read-only mount")
        return original_open(path, flags, mode)

    monkeypatch.setattr(guard.os, "open", open_with_read_only_mount)
    monkeypatch.setattr(guard, "_emit", frames.append)
    monkeypatch.setattr(guard, "_actual_environment", lambda: _request_environment(guard_fixture))

    with pytest.raises(guard.GuardError) as raised:
        guard._run_status(_status_request(guard_fixture))
    assert raised.value.code == "malformed_state"
    assert frames == []
    assert unknown.read_bytes() == b"malformed"


@pytest.mark.skipif(os.name == "nt", reason="Requires POSIX errno semantics.")
@pytest.mark.parametrize(
    ("open_errno", "expected_code"),
    [(errno.EACCES, "busy"), (errno.EPERM, "malformed_state")],
    ids=["access-denied", "operation-not-permitted"],
)
def test_status_read_only_fallback_rejects_every_error_except_erofs(
    guard_fixture: GuardFixture,
    monkeypatch: pytest.MonkeyPatch,
    open_errno: int,
    expected_code: str,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    original_open = guard.os.open
    access_modes: list[int] = []

    def refuse_write_access(path: str | os.PathLike[str], flags: int, mode: int = 0o777) -> int:
        if Path(path) == lock:
            access_modes.append(flags & os.O_ACCMODE)
            raise OSError(open_errno, "simulated non-EROFS open failure")
        return original_open(path, flags, mode)

    monkeypatch.setattr(guard.os, "open", refuse_write_access)
    monkeypatch.setattr(guard, "_actual_environment", lambda: _request_environment(guard_fixture))

    with pytest.raises(guard.GuardError) as raised:
        guard._run_status(_status_request(guard_fixture))
    assert raised.value.code == expected_code
    assert access_modes == [os.O_RDWR]
    assert lock.is_file()


@pytest.mark.skipif(os.name == "nt", reason="Requires POSIX inode and EROFS semantics.")
def test_status_read_only_fallback_rejects_lock_replacement_between_opens(
    guard_fixture: GuardFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    displaced = guard_fixture.root / "displaced-lock"
    replacement = guard_fixture.root / "replacement-lock"
    replacement.write_bytes(b"")
    replacement.chmod(0o600)
    original_identity = (lock.stat().st_dev, lock.stat().st_ino)
    replacement_identity = (replacement.stat().st_dev, replacement.stat().st_ino)
    original_open = guard.os.open
    access_modes: list[int] = []

    def swap_before_read_only_open(path: str | os.PathLike[str], flags: int, mode: int = 0o777) -> int:
        if Path(path) == lock:
            access_mode = flags & os.O_ACCMODE
            access_modes.append(access_mode)
            if access_mode == os.O_RDWR:
                lock.replace(displaced)
                replacement.replace(lock)
                raise OSError(errno.EROFS, "simulated read-only mount")
        return original_open(path, flags, mode)

    monkeypatch.setattr(guard.os, "open", swap_before_read_only_open)
    monkeypatch.setattr(guard, "_actual_environment", lambda: _request_environment(guard_fixture))

    with pytest.raises(guard.GuardError) as raised:
        guard._run_status(_status_request(guard_fixture))
    assert raised.value.code == "malformed_state"
    assert access_modes == [os.O_RDWR, os.O_RDONLY]
    assert (displaced.stat().st_dev, displaced.stat().st_ino) == original_identity
    assert (lock.stat().st_dev, lock.stat().st_ino) == replacement_identity


@pytest.mark.skipif(os.name == "nt", reason="Requires POSIX EROFS semantics.")
@pytest.mark.parametrize("operation", ["install", "recovery-validation"])
def test_mutating_dependency_paths_never_use_a_read_only_journal_lock(
    guard_fixture: GuardFixture,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    original_open = guard.os.open
    access_modes: list[int] = []

    def refuse_write_access(path: str | os.PathLike[str], flags: int, mode: int = 0o777) -> int:
        if Path(path) == lock:
            access_modes.append(flags & os.O_ACCMODE)
            raise OSError(errno.EROFS, "simulated read-only mount")
        return original_open(path, flags, mode)

    monkeypatch.setattr(guard.os, "open", refuse_write_access)
    monkeypatch.setattr(guard, "_actual_environment", lambda: _request_environment(guard_fixture))

    token = str(uuid.uuid4())
    with pytest.raises(guard.GuardError) as raised:
        if operation == "install":
            guard._run_install(_install_request(guard_fixture, token))
        else:
            guard._run_validate(_validate_request(guard_fixture, token))
    assert raised.value.code == "malformed_state"
    assert access_modes == [os.O_RDWR]


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows security descriptors.")
def test_windows_status_creates_exact_protected_journal_and_lock_acls(
    guard_fixture: GuardFixture,
) -> None:
    guard = _load_dependency_guard()
    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 0
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert stderr == b""

    guard._validate_private_directory(guard_fixture.journal)
    guard._lstat_private_file(
        guard_fixture.journal / "mutation.lock",
        code="malformed_state",
    )


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows security descriptors.")
def test_windows_secure_state_excludes_broad_parent_inheritance(
    guard_fixture: GuardFixture,
) -> None:
    guard = _load_dependency_guard()
    _run_icacls(
        guard_fixture.root,
        "/grant",
        "*S-1-1-0:(OI)(CI)F",
    )
    inherited_probe = guard_fixture.root / "ordinary-inherited-directory"
    inherited_probe.mkdir()
    with pytest.raises(guard.GuardError) as raised:
        guard._validate_private_directory(inherited_probe)
    assert raised.value.code == "malformed_state"

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 0
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert stderr == b""
    guard._validate_private_directory(guard_fixture.journal)
    guard._lstat_private_file(
        guard_fixture.journal / "mutation.lock",
        code="malformed_state",
    )


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows security descriptors.")
@pytest.mark.parametrize(
    "acl_arguments",
    [
        ("/grant", "*S-1-1-0:F"),
        ("/deny", "*S-1-1-0:W"),
        ("/inheritance:e",),
    ],
    ids=["extra-allow", "deny", "unprotected"],
)
def test_windows_malformed_journal_acl_fails_closed_without_repair(
    guard_fixture: GuardFixture,
    acl_arguments: tuple[str, ...],
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    _run_icacls(guard_fixture.journal, *acl_arguments)

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert guard_fixture.journal.is_dir()
    assert lock.is_file()
    with pytest.raises(guard.GuardError) as raised:
        guard._validate_private_directory(guard_fixture.journal)
    assert raised.value.code == "malformed_state"


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows security descriptors.")
def test_windows_malformed_leaf_acl_fails_closed_without_repair(
    guard_fixture: GuardFixture,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    _run_icacls(lock, "/grant", "*S-1-1-0:R")

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert lock.is_file()
    with pytest.raises(guard.GuardError) as raised:
        guard._lstat_private_file(lock, code="malformed_state")
    assert raised.value.code == "malformed_state"


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows security descriptors.")
def test_windows_expected_principal_mask_downgrade_is_rejected_without_repair(
    guard_fixture: GuardFixture,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    lock = guard_fixture.journal / "mutation.lock"
    user_sid = guard._windows_token_user_sid(code="malformed_state")
    _run_icacls(lock, "/grant:r", f"*{user_sid}:R")

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert lock.is_file()
    with pytest.raises(guard.GuardError) as raised:
        guard._lstat_private_file(lock, code="malformed_state")
    assert raised.value.code == "malformed_state"


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows security descriptors.")
def test_windows_malformed_orphan_temp_acl_is_retained(
    guard_fixture: GuardFixture,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    temporary = guard_fixture.journal / f".pending-{uuid.uuid4()}.tmp"
    _write_manual_journal_leaf(temporary, b"partial")
    _run_icacls(temporary, "/grant", "*S-1-1-0:R")

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert temporary.read_bytes() == b"partial"
    with pytest.raises(guard.GuardError) as raised:
        guard._lstat_private_file(temporary, code="malformed_state")
    assert raised.value.code == "malformed_state"


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows sharing semantics.")
def test_windows_private_directory_handle_blocks_namespace_replacement(
    guard_fixture: GuardFixture,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    replacement = guard_fixture.root / f"{JOURNAL_NAME}-replacement"

    identity = guard._validate_private_directory(guard_fixture.journal)
    with guard._JournalLock(guard_fixture.journal, identity, create=False) as lock:
        os.fstat(lock._windows_journal_descriptor)
        _assert_windows_namespace_replace_blocked(
            guard_fixture,
            guard_fixture.journal,
            replacement,
        )
    assert not replacement.exists()


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows sharing semantics.")
def test_windows_empty_directory_handle_alone_blocks_namespace_replacement(
    guard_fixture: GuardFixture,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_empty_journal(guard_fixture)
    replacement = guard_fixture.root / f"{JOURNAL_NAME}-replacement"

    def attempt_replacement(path: Path) -> None:
        _assert_windows_namespace_replace_blocked(
            guard_fixture,
            path,
            replacement,
        )

    guard._validate_private_directory(
        guard_fixture.journal,
        _while_pinned_for_test=attempt_replacement,
    )
    assert not replacement.exists()


def test_status_recovers_an_empty_journal_left_before_lock_creation(guard_fixture: GuardFixture) -> None:
    _create_manual_empty_journal(guard_fixture)
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


def test_marker_publication_rejects_same_size_post_close_tamper(guard_fixture: GuardFixture) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    journal_identity = guard._validate_private_directory(guard_fixture.journal)
    token = str(uuid.uuid4())

    def tamper(temporary: Path) -> None:
        original = temporary.read_bytes()
        before = temporary.stat()
        replacement = bytes([original[0] ^ 1]) + original[1:]
        assert len(replacement) == len(original)
        with temporary.open("r+b") as stream:
            stream.write(replacement)
            stream.flush()
            os.fsync(stream.fileno())
        os.utime(temporary, ns=(before.st_atime_ns, before.st_mtime_ns))
        assert temporary.stat().st_size == before.st_size

    with pytest.raises(guard.GuardError) as raised:
        guard._publish_marker(
            guard_fixture.journal,
            journal_identity,
            token,
            guard_fixture.environment,
            [guard_fixture.dependency],
            _after_writer_close_for_test=tamper,
        )
    assert raised.value.code == "malformed_state"
    assert _marker_paths(guard_fixture) == []
    assert list(guard_fixture.journal.glob(".pending-*.tmp")) == []


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows security descriptors.")
def test_windows_marker_publication_protects_temp_and_final_leaf_acls(
    guard_fixture: GuardFixture,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    journal_identity = guard._validate_private_directory(guard_fixture.journal)
    token = str(uuid.uuid4())
    observed_temp: list[Path] = []

    def validate_temp(temporary: Path) -> None:
        guard._lstat_private_file(temporary, code="malformed_state")
        observed_temp.append(temporary)

    destination, _payload, _identity = guard._publish_marker(
        guard_fixture.journal,
        journal_identity,
        token,
        guard_fixture.environment,
        [guard_fixture.dependency],
        _after_writer_close_for_test=validate_temp,
    )
    assert observed_temp == [guard_fixture.journal / f".pending-{token}.tmp"]
    assert not observed_temp[0].exists()
    assert destination == guard_fixture.journal / f"mutation-{token}.json"
    guard._lstat_private_file(destination, code="malformed_state")


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows MoveFileEx semantics.")
def test_windows_marker_publication_never_replaces_racing_destination(
    guard_fixture: GuardFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    journal_identity = guard._validate_private_directory(guard_fixture.journal)
    token = str(uuid.uuid4())
    temporary = guard_fixture.journal / f".pending-{token}.tmp"
    destination = guard_fixture.journal / f"mutation-{token}.json"
    retained = b"existing-marker-must-survive"
    durable_replace = guard._durable_replace

    def race_before_replace(source: Path, target: Path) -> None:
        assert source == temporary
        assert target == destination
        _write_manual_journal_leaf(destination, retained)
        durable_replace(source, target)

    monkeypatch.setattr(guard, "_durable_replace", race_before_replace)
    with pytest.raises(guard.GuardError) as raised:
        guard._publish_marker(
            guard_fixture.journal,
            journal_identity,
            token,
            guard_fixture.environment,
            [guard_fixture.dependency],
        )
    assert raised.value.code == "malformed_state"
    assert destination.read_bytes() == retained
    guard._lstat_private_file(destination, code="malformed_state")
    assert not temporary.exists()


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows CreateFile sharing semantics.")
def test_windows_marker_reader_denies_same_size_concurrent_writer(guard_fixture: GuardFixture) -> None:
    guard = _load_dependency_guard()
    _create_manual_journal(guard_fixture)
    token = str(uuid.uuid4())
    expected_marker = {
        "dependencies": [guard_fixture.dependency],
        "environment": guard_fixture.environment,
        "protocol": PROTOCOL,
        "token": token,
    }
    payload = guard._marker_bytes(expected_marker)
    replacement = bytes([payload[0] ^ 1]) + payload[1:]
    marker_path = guard_fixture.journal / f"mutation-{token}.json"
    _write_manual_journal_leaf(marker_path, payload)

    attacker = "\n".join(
        [
            "import errno,json,os,sys",
            "path=sys.argv[1]",
            "replacement=bytes.fromhex(sys.argv[2])",
            "before=os.stat(path)",
            "try:",
            "    descriptor=os.open(path,os.O_WRONLY|getattr(os,'O_BINARY',0))",
            "except OSError as error:",
            "    print(json.dumps({'errno':error.errno,'winerror':getattr(error,'winerror',None)}))",
            "    raise SystemExit(0)",
            "try:",
            "    offset=0",
            "    while offset < len(replacement):",
            "        offset += os.write(descriptor,replacement[offset:])",
            "    os.fsync(descriptor)",
            "finally:",
            "    os.close(descriptor)",
            "os.utime(path,ns=(before.st_atime_ns,before.st_mtime_ns))",
            "raise SystemExit(1)",
        ]
    )

    def attempt_same_size_write(_path: Path) -> None:
        result = subprocess.run(
            [
                str(guard_fixture.executable),
                "-I",
                "-c",
                attacker,
                str(marker_path),
                replacement.hex(),
            ],
            capture_output=True,
            text=True,
            timeout=PROCESS_TIMEOUT_SECONDS,
        )
        assert result.returncode == 0, result.stderr
        failure = json.loads(result.stdout)
        assert failure["errno"] in {errno.EACCES, errno.EPERM}
        assert failure["winerror"] in {None, 5, 32}
        assert result.stderr == ""

    marker, observed_payload, _identity = guard._read_marker(
        marker_path,
        code="malformed_state",
        _after_open_for_test=attempt_same_size_write,
    )
    assert marker == expected_marker
    assert observed_payload == payload
    assert marker_path.read_bytes() == payload


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


def test_shipped_v1_unbounded_journal_recovers_without_weakening_new_requests(
    guard_fixture: GuardFixture,
) -> None:
    token = str(uuid.uuid4())
    legacy_dependency = {
        "importModule": "pandas",
        "distribution": "pandas",
        "installSpec": "pandas",
        "exactVersion": None,
        "minimumVersion": None,
        "maximumVersionExclusive": None,
    }

    code, frames, stderr = _run(
        guard_fixture,
        "install",
        _install_request(guard_fixture, token, dependency=legacy_dependency),
    )
    assert code == 10
    assert frames == [{"code": "invalid_request", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert not guard_fixture.journal.exists()

    _write_legacy_pandas_distribution(_site_packages(guard_fixture.executable), "2.2.0")
    marker = _write_legacy_marker(guard_fixture, token, legacy_dependency)
    retained = marker.read_bytes()

    status_code, status_frames, status_stderr = _run(
        guard_fixture,
        "status",
        _status_request(guard_fixture),
    )
    assert status_code == 0
    assert status_frames == [{"kind": "status", "protocol": PROTOCOL, "state": "dirty", "token": token}]
    assert status_stderr == b""
    assert marker.read_bytes() == retained

    validate_code, validate_frames, validate_stderr = _run(
        guard_fixture,
        "validate",
        _validate_request(guard_fixture, token),
    )
    assert validate_code == 0
    assert validate_frames == [{"kind": "validated", "protocol": PROTOCOL, "token": token}]
    assert validate_stderr == b""
    assert _marker_paths(guard_fixture) == []


def test_shipped_v1_journal_transition_is_exact_allowlist_bound(
    guard_fixture: GuardFixture,
) -> None:
    token = str(uuid.uuid4())
    marker = _write_legacy_marker(
        guard_fixture,
        token,
        {
            "importModule": "pandas",
            "distribution": "pandas",
            "installSpec": "pandas>=1",
            "exactVersion": None,
            "minimumVersion": None,
            "maximumVersionExclusive": None,
        },
    )
    retained = marker.read_bytes()

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))

    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert marker.read_bytes() == retained


def test_actual_six_key_v1_journal_accepts_unbounded_pandas_with_the_released_duckdb_marker(
    guard_fixture: GuardFixture,
) -> None:
    token = str(uuid.uuid4())
    marker = _write_legacy_marker(
        guard_fixture,
        token,
        [
            {
                "importModule": "pandas",
                "distribution": "pandas",
                "installSpec": "pandas",
                "exactVersion": None,
                "minimumVersion": None,
                "maximumVersionExclusive": None,
            },
            {
                "importModule": "duckdb",
                "distribution": "duckdb",
                "installSpec": "duckdb>=1.4.5,<1.6",
                "exactVersion": None,
                "minimumVersion": "1.4.5",
                "maximumVersionExclusive": "1.6",
            },
        ],
    )
    retained = marker.read_bytes()

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))

    assert code == 0
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "dirty", "token": token}]
    assert stderr == b""
    assert marker.read_bytes() == retained


def test_impossible_five_key_v1_journal_shape_is_rejected(
    guard_fixture: GuardFixture,
) -> None:
    token = str(uuid.uuid4())
    marker = _write_legacy_marker(
        guard_fixture,
        token,
        {
            "importModule": "pandas",
            "distribution": "pandas",
            "installSpec": "pandas",
            "minimumVersion": None,
            "maximumVersionExclusive": None,
        },
    )
    retained = marker.read_bytes()

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))

    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert marker.read_bytes() == retained


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
        environment=_process_environment(guard_fixture, OW_GUARD_TEST_PIP_RELEASE=str(guard_fixture.pip_release)),
    )
    try:
        _write_frame(process, _go_frame(token))
        assert process.stdin is not None
        process.stdin.close()
        process.stdin = None
        deadline = time.monotonic() + FRAME_TIMEOUT_SECONDS
        while not guard_fixture.pip_sentinel.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert guard_fixture.pip_sentinel.exists()

        status_code, status_frames, _stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
        validate_code, validate_frames, _stderr = _run(
            guard_fixture, "validate", _validate_request(guard_fixture, token)
        )
    finally:
        guard_fixture.pip_release.touch()
        pip_code = _finish(process)[0]
    assert status_code == 11
    assert status_frames == [{"code": "busy", "kind": "error", "protocol": PROTOCOL}]
    assert validate_code == 11
    assert validate_frames == [{"code": "busy", "kind": "error", "protocol": PROTOCOL}]
    assert pip_code == 0


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
    incompatible = {
        **guard_fixture.dependency,
        "installSpec": "ow-guard-fixture>=2.0,<3.0",
        "minimumVersion": "2.0",
        "maximumVersionExclusive": "3.0",
    }
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


@pytest.mark.parametrize("version", ["1.2.4rc1", "1.2.4.dev1"])
def test_validation_rejects_prerelease_and_development_versions(
    guard_fixture: GuardFixture,
    version: str,
) -> None:
    token = str(uuid.uuid4())
    process = _arm(guard_fixture, token)
    _write_frame(process, _go_frame(token))
    assert _finish(process)[0] == 0
    marker_path = _marker_paths(guard_fixture)[0]
    original = marker_path.read_bytes()
    metadata = _site_packages(guard_fixture.executable) / "ow_guard_fixture-1.2.3.dist-info" / "METADATA"
    metadata.write_text(
        f"Metadata-Version: 2.1\nName: ow-guard-fixture\nVersion: {version}\n",
        encoding="utf-8",
    )

    code, frames, stderr = _run(
        guard_fixture,
        "validate",
        _validate_request(guard_fixture, token),
    )
    assert code == 13
    assert frames == [{"code": "validation_failed", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert marker_path.read_bytes() == original


def test_validation_rejects_a_shadow_module_not_owned_by_the_distribution(
    guard_fixture: GuardFixture,
    tmp_path: Path,
) -> None:
    token = str(uuid.uuid4())
    process = _arm(guard_fixture, token)
    _write_frame(process, _go_frame(token))
    assert _finish(process)[0] == 0
    marker_path = _marker_paths(guard_fixture)[0]
    original = marker_path.read_bytes()
    site_packages = _site_packages(guard_fixture.executable)
    shadow = tmp_path / "shadow-module"
    package = shadow / "ow_guard_fixture"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("VALUE = 2\n", encoding="utf-8")
    (site_packages / "openwrangler-shadow.pth").write_text(
        f"import sys;sys.path.insert(0, {str(shadow)!r})\n",
        encoding="utf-8",
    )

    code, frames, stderr = _run(
        guard_fixture,
        "validate",
        _validate_request(guard_fixture, token),
    )
    assert code == 13
    assert frames == [{"code": "validation_failed", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert marker_path.read_bytes() == original


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
    _write_manual_journal_leaf(marker, b'{"protocol":')

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert marker.read_bytes() == b'{"protocol":'


def test_orphaned_prepublish_temp_is_cleaned_only_under_lock(guard_fixture: GuardFixture) -> None:
    _create_manual_journal(guard_fixture)
    temporary = guard_fixture.journal / f".pending-{uuid.uuid4()}.tmp"
    _write_manual_journal_leaf(temporary, b"partial")

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 0
    assert frames == [{"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None}]
    assert stderr == b""
    assert not temporary.exists()


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows directory junctions.")
def test_windows_journal_junction_is_rejected_without_touching_target(
    guard_fixture: GuardFixture,
) -> None:
    target = guard_fixture.root.parent / "journal-junction-target"
    target.mkdir()
    sentinel = target / "unchanged.txt"
    sentinel.write_bytes(b"unchanged")
    result = subprocess.run(
        [
            os.environ.get("COMSPEC", "cmd.exe"),
            "/d",
            "/c",
            "mklink",
            "/J",
            str(guard_fixture.journal),
            str(target),
        ],
        capture_output=True,
        text=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )
    assert result.returncode == 0, result.stdout + result.stderr

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert sentinel.read_bytes() == b"unchanged"
    assert not (target / "mutation.lock").exists()


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows directory junctions.")
@pytest.mark.parametrize("leaf", ["lock", "temporary", "marker"])
def test_windows_leaf_junction_is_rejected_without_touching_target(
    guard_fixture: GuardFixture,
    leaf: str,
) -> None:
    if leaf == "lock":
        _create_manual_empty_journal(guard_fixture)
    else:
        _create_manual_journal(guard_fixture)
    target = guard_fixture.root.parent / f"{leaf}-junction-target"
    target.mkdir()
    sentinel = target / "unchanged.txt"
    sentinel.write_bytes(b"unchanged")
    if leaf == "lock":
        path = guard_fixture.journal / "mutation.lock"
    elif leaf == "temporary":
        path = guard_fixture.journal / f".pending-{uuid.uuid4()}.tmp"
    else:
        path = guard_fixture.journal / f"mutation-{uuid.uuid4()}.json"
    result = subprocess.run(
        [
            os.environ.get("COMSPEC", "cmd.exe"),
            "/d",
            "/c",
            "mklink",
            "/J",
            str(path),
            str(target),
        ],
        capture_output=True,
        text=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )
    assert result.returncode == 0, result.stdout + result.stderr

    code, frames, stderr = _run(guard_fixture, "status", _status_request(guard_fixture))
    assert code == 12
    assert frames == [{"code": "malformed_state", "kind": "error", "protocol": PROTOCOL}]
    assert stderr == b""
    assert sentinel.read_bytes() == b"unchanged"


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
