from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
import uuid
import venv
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

PROTOCOL = "openwrangler-dependency-guard-v1"
HELPER = Path(__file__).parents[1] / "openwrangler_runtime" / "dependency_guard.py"
JOURNAL_NAME = ".openwrangler-dependency-journal-v1"
MAX_FRAME_BYTES = 65_536
PROCESS_TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class GuardRuntime:
    root: Path
    executable: Path
    environment: dict[str, Any]
    dependency: dict[str, Any]
    pip_sentinel: Path

    @property
    def journal(self) -> Path:
        return self.root / JOURNAL_NAME


@pytest.fixture(scope="module")
def shared_guard_runtime(tmp_path_factory: pytest.TempPathFactory) -> GuardRuntime:
    temporary = tmp_path_factory.mktemp("dependency-guard-install-frames")
    root = temporary / "selected"
    venv.EnvBuilder(with_pip=False).create(root)
    executable = root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    site_packages = _site_packages(executable)
    _write_fake_dependency(site_packages)
    _write_fake_pip(site_packages)
    return GuardRuntime(
        root=root,
        executable=executable,
        environment=_probe_environment(executable),
        dependency={
            "importModule": "ow_guard_fixture",
            "distribution": "ow-guard-fixture",
            "installSpec": "ow-guard-fixture>=1.0,<2.0",
            "exactVersion": None,
            "minimumVersion": "1.0",
            "maximumVersionExclusive": "2.0",
        },
        pip_sentinel=temporary / "pip-started",
    )


@pytest.fixture
def guard_runtime(shared_guard_runtime: GuardRuntime) -> Iterator[GuardRuntime]:
    assert not shared_guard_runtime.journal.exists()
    assert not shared_guard_runtime.pip_sentinel.exists()
    yield shared_guard_runtime
    if shared_guard_runtime.journal.exists():
        shutil.rmtree(shared_guard_runtime.journal)
    shared_guard_runtime.pip_sentinel.unlink(missing_ok=True)


@pytest.mark.parametrize("case", ["malformed", "oversized", "miscorrelated"])
def test_invalid_go_removes_exact_marker_and_exits_without_pip(guard_runtime: GuardRuntime, case: str) -> None:
    token = str(uuid.uuid4())
    process = _arm_install(guard_runtime, token)
    marker = _only_marker(guard_runtime, token)

    if case == "malformed":
        go_frame = b'{"protocol":\n'
    elif case == "oversized":
        go_frame = _sized_frame(_go_frame(token), MAX_FRAME_BYTES + 1)
    else:
        go_frame = _frame_bytes(_go_frame(str(uuid.uuid4())))
    _write_bytes(process, go_frame)
    code, stdout, stderr = _finish(process)

    assert code == 10
    assert stdout == b""
    assert stderr == b""
    assert not marker.exists()
    assert _marker_paths(guard_runtime) == []
    assert not list(guard_runtime.journal.glob(".pending-*.tmp"))
    assert not guard_runtime.pip_sentinel.exists()


@pytest.mark.parametrize(("pip_exit", "expected_exit"), [("0", 0), ("9", 14)])
def test_authorized_pip_exit_retains_exact_marker_until_validation(
    guard_runtime: GuardRuntime,
    pip_exit: str,
    expected_exit: int,
) -> None:
    token = str(uuid.uuid4())
    process = _arm_install(guard_runtime, token, OW_GUARD_TEST_PIP_EXIT=pip_exit)
    marker = _only_marker(guard_runtime, token)
    before = _marker_snapshot(marker)

    _write_bytes(process, _frame_bytes(_go_frame(token)))
    code, stdout, stderr = _finish(process)

    assert code == expected_exit
    assert stdout == b""
    assert stderr == b""
    assert guard_runtime.pip_sentinel.read_bytes() == b"started"
    assert _marker_paths(guard_runtime) == [marker]
    assert _marker_snapshot(marker) == before

    validation = _run_command(guard_runtime, "validate", _validate_request(guard_runtime, token))
    assert validation.returncode == 0
    assert _output_frames(validation) == [{"kind": "validated", "protocol": PROTOCOL, "token": token}]
    assert validation.stderr == b""
    assert _marker_paths(guard_runtime) == []


def test_fresh_install_recovers_after_rejected_go(guard_runtime: GuardRuntime) -> None:
    rejected_token = str(uuid.uuid4())
    rejected = _arm_install(guard_runtime, rejected_token)
    rejected_marker = _only_marker(guard_runtime, rejected_token)
    _write_bytes(rejected, _frame_bytes(_go_frame(str(uuid.uuid4()))))
    assert _finish(rejected) == (10, b"", b"")
    assert not rejected_marker.exists()
    assert _marker_paths(guard_runtime) == []

    recovered_token = str(uuid.uuid4())
    recovered = _arm_install(guard_runtime, recovered_token)
    retained_marker = _only_marker(guard_runtime, recovered_token)
    retained_before = _marker_snapshot(retained_marker)
    _write_bytes(recovered, _frame_bytes(_go_frame(recovered_token)))
    assert _finish(recovered) == (0, b"", b"")
    assert _marker_snapshot(retained_marker) == retained_before

    validation = _run_command(guard_runtime, "validate", _validate_request(guard_runtime, recovered_token))
    assert validation.returncode == 0
    assert _output_frames(validation) == [{"kind": "validated", "protocol": PROTOCOL, "token": recovered_token}]
    assert validation.stderr == b""
    assert _marker_paths(guard_runtime) == []


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
    (module / "__init__.py").write_text("VALUE = 1\n", encoding="utf-8")
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
                "import os",
                "import pathlib",
                "sentinel = pathlib.Path(os.environ['OW_GUARD_TEST_PIP_SENTINEL'])",
                "sentinel.write_bytes(b'started')",
                "raise SystemExit(int(os.environ.get('OW_GUARD_TEST_PIP_EXIT', '0')))",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _arm_install(runtime: GuardRuntime, token: str, **environment_values: str) -> subprocess.Popen[bytes]:
    environment = os.environ.copy()
    environment.update(environment_values)
    environment["OW_GUARD_TEST_PIP_SENTINEL"] = str(runtime.pip_sentinel)
    process = subprocess.Popen(
        [str(runtime.executable), "-I", str(HELPER), "install"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    _write_bytes(process, _frame_bytes(_install_request(runtime, token)))
    assert _read_frame(process) == {"kind": "ready", "protocol": PROTOCOL, "token": token}
    return process


def _install_request(runtime: GuardRuntime, token: str) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "kind": "install",
        "token": token,
        "environment": runtime.environment,
        "dependencies": [runtime.dependency],
    }


def _validate_request(runtime: GuardRuntime, token: str) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "kind": "validate",
        "environment": runtime.environment,
        "expectedToken": token,
    }


def _go_frame(token: str) -> dict[str, Any]:
    return {"protocol": PROTOCOL, "kind": "go", "token": token}


def _frame_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"


def _sized_frame(payload: dict[str, Any], frame_size: int) -> bytes:
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    padding_size = frame_size - len(encoded) - 1
    assert padding_size >= 0
    frame = encoded + (b" " * padding_size) + b"\n"
    assert len(frame) == frame_size
    return frame


def _write_bytes(process: subprocess.Popen[bytes], payload: bytes) -> None:
    assert process.stdin is not None
    process.stdin.write(payload)
    process.stdin.flush()


def _read_frame(process: subprocess.Popen[bytes]) -> dict[str, Any]:
    stdout = process.stdout
    assert stdout is not None
    results: queue.Queue[bytes | BaseException] = queue.Queue(maxsize=1)

    def read() -> None:
        try:
            results.put(stdout.readline())
        except BaseException as error:
            results.put(error)

    threading.Thread(target=read, daemon=True).start()
    try:
        result = results.get(timeout=PROCESS_TIMEOUT_SECONDS)
    except queue.Empty:
        process.kill()
        process.wait(timeout=PROCESS_TIMEOUT_SECONDS)
        raise AssertionError("The dependency guard did not emit READY before the timeout.") from None
    if isinstance(result, BaseException):
        raise result
    decoded = json.loads(result)
    assert isinstance(decoded, dict)
    return decoded


def _finish(process: subprocess.Popen[bytes]) -> tuple[int, bytes, bytes]:
    assert process.stdin is not None
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


def _run_command(
    runtime: GuardRuntime,
    mode: str,
    request: dict[str, Any],
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [str(runtime.executable), "-I", str(HELPER), mode],
        input=_frame_bytes(request),
        capture_output=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )


def _output_frames(result: subprocess.CompletedProcess[bytes]) -> list[dict[str, Any]]:
    frames = [json.loads(line) for line in result.stdout.splitlines()]
    assert all(isinstance(frame, dict) for frame in frames)
    return frames


def _marker_paths(runtime: GuardRuntime) -> list[Path]:
    if not runtime.journal.exists():
        return []
    return sorted(runtime.journal.glob("mutation-*.json"))


def _only_marker(runtime: GuardRuntime, token: str) -> Path:
    marker = runtime.journal / f"mutation-{token}.json"
    assert _marker_paths(runtime) == [marker]
    decoded = json.loads(marker.read_text(encoding="utf-8"))
    assert decoded["token"] == token
    assert decoded["environment"] == runtime.environment
    assert decoded["dependencies"] == [runtime.dependency]
    return marker


def _marker_snapshot(path: Path) -> tuple[bytes, tuple[int, int, int, int]]:
    payload = path.read_bytes()
    observed = path.stat()
    return payload, (observed.st_dev, observed.st_ino, observed.st_size, observed.st_mtime_ns)
