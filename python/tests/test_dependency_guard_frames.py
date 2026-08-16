from __future__ import annotations

import json
import os
import subprocess
import venv
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

PROTOCOL = "openwrangler-dependency-guard-v1"
HELPER = Path(__file__).parents[1] / "openwrangler_runtime" / "dependency_guard.py"
MAX_FRAME_BYTES = 65_536
PROCESS_TIMEOUT_SECONDS = 20
INVALID_REQUEST_FRAME = {
    "code": "invalid_request",
    "kind": "error",
    "protocol": PROTOCOL,
}
CLEAN_STATUS_FRAME = {
    "kind": "status",
    "protocol": PROTOCOL,
    "state": "clean",
    "token": None,
}


@dataclass(frozen=True)
class GuardRuntime:
    executable: Path
    request: dict[str, Any]


@pytest.fixture(scope="module")
def guard_runtime(tmp_path_factory: pytest.TempPathFactory) -> GuardRuntime:
    root = tmp_path_factory.mktemp("dependency-guard-frames") / "selected"
    venv.EnvBuilder(with_pip=False).create(root)
    executable = root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return GuardRuntime(
        executable=executable,
        request={
            "protocol": PROTOCOL,
            "kind": "status",
            "environment": _probe_environment(executable),
        },
    )


@pytest.mark.parametrize(
    "frame_size",
    [MAX_FRAME_BYTES - 1, MAX_FRAME_BYTES],
    ids=["one-byte-below-cap", "exact-cap"],
)
def test_accepts_complete_frames_through_the_exact_cap(guard_runtime: GuardRuntime, frame_size: int) -> None:
    result = _run_guard(guard_runtime, _sized_frame(guard_runtime.request, frame_size))

    assert result.returncode == 0
    assert _output_frames(result) == [CLEAN_STATUS_FRAME]
    assert result.stderr == b""


@pytest.mark.parametrize(
    "case",
    ["one-byte-over-cap", "crlf", "duplicate-key", "invalid-utf8", "partial-eof"],
)
def test_rejects_invalid_ingress_and_exits_once(guard_runtime: GuardRuntime, case: str) -> None:
    encoded = _encoded_request(guard_runtime.request)
    if case == "one-byte-over-cap":
        frame = _sized_frame(guard_runtime.request, MAX_FRAME_BYTES + 1)
    elif case == "crlf":
        frame = encoded + b"\r\n"
    elif case == "duplicate-key":
        frame = encoded.replace(b'"kind":"status"', b'"kind":"status","kind":"status"', 1) + b"\n"
    elif case == "invalid-utf8":
        frame = b'{"kind":"\xc3("}\n'
    else:
        frame = encoded

    result = _run_guard(guard_runtime, frame)

    assert result.returncode == 10
    assert _output_frames(result) == [INVALID_REQUEST_FRAME]
    assert result.stderr == b""


def test_a_fresh_guard_recovers_after_a_rejected_partial_frame(guard_runtime: GuardRuntime) -> None:
    rejected = _run_guard(guard_runtime, b'{"partial":true}')
    assert rejected.returncode == 10
    assert _output_frames(rejected) == [INVALID_REQUEST_FRAME]
    assert rejected.stderr == b""

    recovered = _run_guard(guard_runtime, _sized_frame(guard_runtime.request, MAX_FRAME_BYTES))
    assert recovered.returncode == 0
    assert _output_frames(recovered) == [CLEAN_STATUS_FRAME]
    assert recovered.stderr == b""


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


def _encoded_request(request: dict[str, Any]) -> bytes:
    return json.dumps(request, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _sized_frame(request: dict[str, Any], frame_size: int) -> bytes:
    payload = _encoded_request(request)
    padding_size = frame_size - len(payload) - 1
    assert padding_size >= 0
    frame = payload + (b" " * padding_size) + b"\n"
    assert len(frame) == frame_size
    return frame


def _run_guard(runtime: GuardRuntime, frame: bytes) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [str(runtime.executable), "-I", str(HELPER), "status"],
        input=frame,
        capture_output=True,
        timeout=PROCESS_TIMEOUT_SECONDS,
    )


def _output_frames(result: subprocess.CompletedProcess[bytes]) -> list[dict[str, Any]]:
    frames = [json.loads(line) for line in result.stdout.splitlines()]
    assert all(isinstance(frame, dict) for frame in frames)
    return frames
