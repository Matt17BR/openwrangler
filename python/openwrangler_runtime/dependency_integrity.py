"""Run one quiet, bounded ``pip check`` for the selected interpreter."""

from __future__ import annotations

import contextlib
import json
import os
import runpy
import sys
from collections.abc import Iterator

PROTOCOL = "openwrangler-dependency-integrity-v1"


@contextlib.contextmanager
def _silence_pip_output() -> Iterator[None]:
    stdout_object = sys.stdout
    stderr_object = sys.stderr
    saved_stdout = -1
    saved_stderr = -1
    devnull = -1
    try:
        with contextlib.suppress(OSError, ValueError):
            stdout_object.flush()
            stderr_object.flush()
        saved_stdout = os.dup(1)
        saved_stderr = os.dup(2)
        os.set_inheritable(saved_stdout, False)
        os.set_inheritable(saved_stderr, False)
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        yield
    finally:
        sys.stdout = stdout_object
        sys.stderr = stderr_object
        if saved_stdout >= 0:
            os.dup2(saved_stdout, 1)
        if saved_stderr >= 0:
            os.dup2(saved_stderr, 2)
        for descriptor in (devnull, saved_stdout, saved_stderr):
            if descriptor >= 0:
                with contextlib.suppress(OSError):
                    os.close(descriptor)


def _pip_check_state() -> str:
    prior_arguments = sys.argv
    try:
        sys.argv = ["pip", "check", "--disable-pip-version-check"]
        with _silence_pip_output():
            try:
                runpy.run_module("pip", run_name="__main__", alter_sys=True)
            except SystemExit as error:
                if error.code is None or error.code == 0:
                    return "clean"
                if error.code == 1:
                    return "inconsistent"
                return "failed"
            except BaseException:
                return "failed"
            return "clean"
    finally:
        sys.argv = prior_arguments


def main() -> int:
    payload = (
        json.dumps(
            {"kind": "integrity", "protocol": PROTOCOL, "state": _pip_check_state()},
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
        + b"\n"
    )
    written = 0
    while written < len(payload):
        written += os.write(1, payload[written:])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
