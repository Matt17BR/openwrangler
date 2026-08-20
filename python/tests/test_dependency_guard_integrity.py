from __future__ import annotations

import json
import os
import shutil
import subprocess
import uuid
import venv
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from dependency_guard_test_support import create_fake_pip_package

PROTOCOL = "openwrangler-dependency-guard-v1"
INTEGRITY_PROTOCOL = "openwrangler-dependency-integrity-v1"
RUNTIME_SOURCE = Path(__file__).parents[1] / "openwrangler_runtime"
PROCESS_TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class IntegrityRuntime:
    root: Path
    executable: Path
    helper: Path
    integrity_helper: Path
    environment: dict[str, Any]
    dependency: dict[str, Any]
    state: Path
    checks: Path
    pip_started: Path

    @property
    def journal(self) -> Path:
        return self.root / ".openwrangler-dependency-journal-v1"


@pytest.fixture
def integrity_runtime(tmp_path: Path) -> IntegrityRuntime:
    root = tmp_path / "selected"
    venv.EnvBuilder(with_pip=False).create(root)
    executable = root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    site_packages = _site_packages(executable)
    _write_dependency(site_packages)
    _write_fake_pip(site_packages)
    helpers = tmp_path / "helpers"
    helpers.mkdir()
    helper = helpers / "dependency_guard.py"
    integrity_helper = helpers / "dependency_integrity.py"
    shutil.copy2(RUNTIME_SOURCE / helper.name, helper)
    shutil.copy2(RUNTIME_SOURCE / integrity_helper.name, integrity_helper)
    state = tmp_path / "integrity-state"
    state.write_text("clean", encoding="utf-8")
    return IntegrityRuntime(
        root=root,
        executable=executable,
        helper=helper,
        integrity_helper=integrity_helper,
        environment=_probe_environment(executable),
        dependency={
            "importModule": "ow_integrity_fixture",
            "distribution": "ow-integrity-fixture",
            "installSpec": "ow-integrity-fixture>=1,<2",
            "exactVersion": None,
            "minimumVersion": "1",
            "maximumVersionExclusive": "2",
        },
        state=state,
        checks=tmp_path / "integrity-checks",
        pip_started=tmp_path / "pip-started",
    )


def test_preexisting_conflict_waits_for_go_then_stops_before_package_write(
    integrity_runtime: IntegrityRuntime,
) -> None:
    integrity_runtime.state.write_text("inconsistent", encoding="utf-8")
    token = str(uuid.uuid4())
    process = _arm_install(integrity_runtime, token)
    marker = _only_marker(integrity_runtime, token)

    assert not integrity_runtime.checks.exists()
    assert not integrity_runtime.pip_started.exists()
    _authorize(process, token)

    assert _finish(process) == (18, b"", b"")
    assert not marker.exists()
    assert _check_count(integrity_runtime) == 1
    assert not integrity_runtime.pip_started.exists()


def test_clean_install_and_validation_require_three_consistent_checks(integrity_runtime: IntegrityRuntime) -> None:
    token = str(uuid.uuid4())
    process = _arm_install(integrity_runtime, token)
    marker = _only_marker(integrity_runtime, token)
    _authorize(process, token)

    assert _finish(process) == (0, b"", b"")
    assert marker.exists()
    assert _check_count(integrity_runtime) == 2
    assert json.loads(integrity_runtime.pip_started.read_text(encoding="utf-8"))[1:] == [
        "install",
        "--no-input",
        "--no-user",
        "--",
        "ow-integrity-fixture>=1,<2",
    ]

    validation = _run(integrity_runtime, "validate", _validate_request(integrity_runtime, token))
    assert validation.returncode == 0
    assert _frames(validation.stdout) == [{"kind": "validated", "protocol": PROTOCOL, "token": token}]
    assert validation.stderr == b""
    assert _check_count(integrity_runtime) == 3
    assert not marker.exists()


def test_new_conflict_retains_marker_until_manual_repair_and_validation(
    integrity_runtime: IntegrityRuntime,
) -> None:
    token = str(uuid.uuid4())
    process = _arm_install(integrity_runtime, token, OW_INTEGRITY_POST_STATE="inconsistent")
    marker = _only_marker(integrity_runtime, token)
    before = marker.read_bytes()
    _authorize(process, token)

    assert _finish(process) == (19, b"", b"")
    assert marker.read_bytes() == before
    assert _check_count(integrity_runtime) == 2

    rejected = _run(integrity_runtime, "validate", _validate_request(integrity_runtime, token))
    assert rejected.returncode == 19
    assert _frames(rejected.stdout) == [{"code": "post_install_inconsistent", "kind": "error", "protocol": PROTOCOL}]
    assert marker.read_bytes() == before

    integrity_runtime.state.write_text("clean", encoding="utf-8")
    repaired = _run(integrity_runtime, "validate", _validate_request(integrity_runtime, token))
    assert repaired.returncode == 0
    assert _frames(repaired.stdout) == [{"kind": "validated", "protocol": PROTOCOL, "token": token}]
    assert _check_count(integrity_runtime) == 4
    assert not marker.exists()


def test_pip_failure_is_not_success_and_retains_marker_without_postcheck(integrity_runtime: IntegrityRuntime) -> None:
    token = str(uuid.uuid4())
    process = _arm_install(integrity_runtime, token, OW_INTEGRITY_PIP_EXIT="9")
    marker = _only_marker(integrity_runtime, token)
    before = marker.read_bytes()
    _authorize(process, token)

    assert _finish(process) == (14, b"", b"")
    assert marker.read_bytes() == before
    assert _check_count(integrity_runtime) == 1

    repaired = _run(integrity_runtime, "validate", _validate_request(integrity_runtime, token))
    assert repaired.returncode == 0
    assert _check_count(integrity_runtime) == 2
    assert not marker.exists()


def test_eof_before_go_runs_no_pip_owned_command(integrity_runtime: IntegrityRuntime) -> None:
    token = str(uuid.uuid4())
    process = _arm_install(integrity_runtime, token)
    marker = _only_marker(integrity_runtime, token)
    assert process.stdin is not None
    process.stdin.close()

    assert _finish(process) == (10, b"", b"")
    assert not marker.exists()
    assert not integrity_runtime.checks.exists()
    assert not integrity_runtime.pip_started.exists()


@pytest.mark.skipif(os.name == "nt", reason="Windows does not permit replacing its running interpreter image")
def test_executable_replacement_after_baseline_check_prevents_package_write(
    integrity_runtime: IntegrityRuntime,
) -> None:
    replacement = integrity_runtime.root.parent / "replacement-python"
    shutil.copy2(integrity_runtime.executable, replacement)
    token = str(uuid.uuid4())
    process = _arm_install(integrity_runtime, token, OW_INTEGRITY_REPLACE_ON_CHECK=str(replacement))
    marker = _only_marker(integrity_runtime, token)
    _authorize(process, token)

    assert _finish(process) == (16, b"", b"")
    assert _check_count(integrity_runtime) == 1
    assert not integrity_runtime.pip_started.exists()
    assert not marker.exists()


@pytest.mark.parametrize(
    "payload",
    [
        b'{"kind":\n',
        b'{"kind":"integrity","kind":"integrity","protocol":"openwrangler-dependency-integrity-v1","state":"clean"}\n',
        b'{"kind":"integrity","protocol":"openwrangler-dependency-integrity-v1","state":"clean"}\r\n',
        b'{"kind":"integrity","protocol":"openwrangler-dependency-integrity-v1","state":"clean"}\ntrailing-secret',
        b"\xff\n",
        b"x" * 65_537,
    ],
    ids=["malformed", "duplicate", "crlf", "trailing", "invalid-utf8", "oversized"],
)
def test_malformed_integrity_output_fails_closed_without_payload_leak(
    integrity_runtime: IntegrityRuntime,
    payload: bytes,
) -> None:
    _replace_integrity_helper(integrity_runtime, payload)
    token = str(uuid.uuid4())
    process = _arm_install(integrity_runtime, token)
    marker = _only_marker(integrity_runtime, token)
    _authorize(process, token)

    assert _finish(process) == (20, b"", b"")
    assert not marker.exists()
    assert not integrity_runtime.pip_started.exists()


def test_integrity_timeout_kills_worker_and_stops_before_package_write(integrity_runtime: IntegrityRuntime) -> None:
    source = integrity_runtime.helper.read_text(encoding="utf-8").replace(
        "INTEGRITY_CHECK_TIMEOUT_SECONDS = 20", "INTEGRITY_CHECK_TIMEOUT_SECONDS = 0.1"
    )
    integrity_runtime.helper.write_text(source, encoding="utf-8")
    integrity_runtime.integrity_helper.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
    token = str(uuid.uuid4())
    process = _arm_install(integrity_runtime, token)
    marker = _only_marker(integrity_runtime, token)
    _authorize(process, token)

    assert _finish(process) == (20, b"", b"")
    assert not marker.exists()
    assert not integrity_runtime.pip_started.exists()


def test_worker_failure_state_is_rejected_without_package_write(integrity_runtime: IntegrityRuntime) -> None:
    integrity_runtime.state.write_text("failed", encoding="utf-8")
    token = str(uuid.uuid4())
    process = _arm_install(integrity_runtime, token)
    _authorize(process, token)

    assert _finish(process) == (20, b"", b"")
    assert not integrity_runtime.pip_started.exists()
    assert not list(integrity_runtime.journal.glob("mutation-*.json"))


@pytest.mark.parametrize("consumer", ["s3fs", "gcsfs"])
def test_real_pip_check_catches_fsspec_conflicts(tmp_path: Path, consumer: str) -> None:
    root = tmp_path / "selected"
    venv.EnvBuilder(with_pip=True).create(root)
    executable = root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    site_packages = _site_packages(executable)
    _write_distribution(site_packages, "fsspec", "2026.3.0")
    _write_distribution(site_packages, consumer, "2026.3.0", requires="fsspec==2026.3.0")

    clean = _run_integrity_helper(executable)
    assert clean == {"kind": "integrity", "protocol": INTEGRITY_PROTOCOL, "state": "clean"}

    fsspec_metadata = site_packages / "fsspec-2026.3.0.dist-info"
    (fsspec_metadata / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: fsspec\nVersion: 2026.7.0\n",
        encoding="utf-8",
    )
    fsspec_metadata.rename(site_packages / "fsspec-2026.7.0.dist-info")
    broken = _run_integrity_helper(executable)
    assert broken == {"kind": "integrity", "protocol": INTEGRITY_PROTOCOL, "state": "inconsistent"}


def _write_dependency(site_packages: Path) -> None:
    package = site_packages / "ow_integrity_fixture"
    package.mkdir()
    (package / "__init__.py").write_text("VALUE = 1\n", encoding="utf-8")
    _write_distribution(site_packages, "ow-integrity-fixture", "1.2.3")


def _write_distribution(site_packages: Path, name: str, version: str, *, requires: str | None = None) -> None:
    metadata = site_packages / f"{name.replace('-', '_')}-{version}.dist-info"
    metadata.mkdir()
    lines = ["Metadata-Version: 2.1", f"Name: {name}", f"Version: {version}"]
    if requires is not None:
        lines.append(f"Requires-Dist: {requires}")
    (metadata / "METADATA").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_fake_pip(site_packages: Path) -> None:
    package = create_fake_pip_package(site_packages)
    (package / "__main__.py").write_text(
        "\n".join(
            [
                "import json",
                "import os",
                "import pathlib",
                "import sys",
                "state_path = pathlib.Path(os.environ['OW_INTEGRITY_STATE'])",
                "if sys.argv[1:] == ['check', '--disable-pip-version-check']:",
                "    checks_path = pathlib.Path(os.environ['OW_INTEGRITY_CHECKS'])",
                "    with checks_path.open('a', encoding='utf-8') as stream:",
                "        stream.write('check\\n')",
                "    os.write(1, b'integrity-payload-must-not-escape')",
                "    os.write(2, b'integrity-payload-must-not-escape')",
                "    replacement = os.environ.get('OW_INTEGRITY_REPLACE_ON_CHECK')",
                "    if replacement:",
                "        os.replace(replacement, sys.executable)",
                "    state = state_path.read_text(encoding='utf-8')",
                "    raise SystemExit({'clean': 0, 'inconsistent': 1}.get(state, 7))",
                "pathlib.Path(os.environ['OW_INTEGRITY_PIP_STARTED']).write_text(",
                "    json.dumps(sys.argv, separators=(',', ':')), encoding='utf-8'",
                ")",
                "post_state = os.environ.get('OW_INTEGRITY_POST_STATE')",
                "if post_state:",
                "    state_path.write_text(post_state, encoding='utf-8')",
                "raise SystemExit(int(os.environ.get('OW_INTEGRITY_PIP_EXIT', '0')))",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _site_packages(executable: Path) -> Path:
    result = subprocess.run(
        [str(executable), "-I", "-c", "import sysconfig;print(sysconfig.get_path('purelib'))"],
        check=True,
        capture_output=True,
        text=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )
    return Path(result.stdout.strip())


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
            "'executableIdentity':{'device':str(executable_stat.st_dev),'inode':str(executable_stat.st_ino),",
            "'size':str(executable_stat.st_size),'mtimeNs':str(executable_stat.st_mtime_ns),",
            "'ctimeNs':str(executable_stat.st_ctime_ns)},",
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
    return json.loads(result.stdout)


def _environment(runtime: IntegrityRuntime, **values: str) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(values)
    environment.update(
        {
            "OW_INTEGRITY_STATE": str(runtime.state),
            "OW_INTEGRITY_CHECKS": str(runtime.checks),
            "OW_INTEGRITY_PIP_STARTED": str(runtime.pip_started),
        }
    )
    return environment


def _install_request(runtime: IntegrityRuntime, token: str) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "kind": "install",
        "token": token,
        "environment": runtime.environment,
        "dependencies": [runtime.dependency],
    }


def _validate_request(runtime: IntegrityRuntime, token: str) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "kind": "validate",
        "environment": runtime.environment,
        "expectedToken": token,
    }


def _frame(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"


def _arm_install(runtime: IntegrityRuntime, token: str, **values: str) -> subprocess.Popen[bytes]:
    process = subprocess.Popen(
        [str(runtime.executable), "-I", str(runtime.helper), "install"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_environment(runtime, **values),
    )
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(_frame(_install_request(runtime, token)))
    process.stdin.flush()
    assert json.loads(process.stdout.readline()) == {"kind": "ready", "protocol": PROTOCOL, "token": token}
    return process


def _authorize(process: subprocess.Popen[bytes], token: str) -> None:
    assert process.stdin is not None
    process.stdin.write(_frame({"protocol": PROTOCOL, "kind": "go", "token": token}))
    process.stdin.close()


def _finish(process: subprocess.Popen[bytes]) -> tuple[int, bytes, bytes]:
    assert process.stdout is not None and process.stderr is not None
    code = process.wait(timeout=PROCESS_TIMEOUT_SECONDS)
    return code, process.stdout.read(), process.stderr.read()


def _run(
    runtime: IntegrityRuntime,
    mode: str,
    request: dict[str, Any],
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [str(runtime.executable), "-I", str(runtime.helper), mode],
        input=_frame(request),
        capture_output=True,
        env=_environment(runtime),
        timeout=PROCESS_TIMEOUT_SECONDS,
    )


def _only_marker(runtime: IntegrityRuntime, token: str) -> Path:
    marker = runtime.journal / f"mutation-{token}.json"
    assert list(runtime.journal.glob("mutation-*.json")) == [marker]
    return marker


def _check_count(runtime: IntegrityRuntime) -> int:
    return runtime.checks.read_text(encoding="utf-8").count("check\n")


def _frames(raw: bytes) -> list[dict[str, Any]]:
    return [json.loads(line) for line in raw.splitlines()]


def _replace_integrity_helper(runtime: IntegrityRuntime, payload: bytes) -> None:
    runtime.integrity_helper.write_text(
        "import os\nos.write(1, " + repr(payload) + ")\n",
        encoding="utf-8",
    )


def _run_integrity_helper(executable: Path) -> dict[str, Any]:
    result = subprocess.run(
        [str(executable), "-I", str(RUNTIME_SOURCE / "dependency_integrity.py")],
        check=True,
        capture_output=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )
    assert result.stderr == b""
    return json.loads(result.stdout)
