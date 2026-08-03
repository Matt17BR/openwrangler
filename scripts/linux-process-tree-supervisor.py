#!/usr/bin/env python3
"""Launch one command below a Linux child subreaper.

The parent Node wrapper arms process accounting before it sends ``GO``.  A
subreaper remains the nearest adoption point for daemonized descendants, so a
command cannot make a child invisible merely by changing its process group and
exiting between procfs samples.
"""

from __future__ import annotations

import ctypes
import os
import signal
import sys


_CONTROL_FD = 3
_REPORT_FD = 4
_PR_SET_CHILD_SUBREAPER = 36
_READY = b"READY\n"
_GO = b"GO\n"
_ERROR = b"ERROR\n"


def _write_report(contents: bytes) -> None:
    offset = 0
    while offset < len(contents):
        written = os.write(_REPORT_FD, contents[offset:])
        if written <= 0:
            raise RuntimeError("the supervisor report pipe closed")
        offset += written


def _read_go() -> None:
    received = bytearray()
    while len(received) <= len(_GO):
        chunk = os.read(_CONTROL_FD, len(_GO) + 1 - len(received))
        if not chunk:
            break
        received.extend(chunk)
        if received.endswith(b"\n"):
            break
    if bytes(received) != _GO:
        raise RuntimeError("the supervisor did not receive one exact GO frame")


def _become_subreaper() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    if prctl(_PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def _reset_target_signals() -> None:
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(number, signal.SIG_DFL)


def _report_target_outcome(status: int) -> tuple[int | None, int | None]:
    if os.WIFEXITED(status):
        exit_code = os.WEXITSTATUS(status)
        _write_report(f"TARGET {exit_code} -\n".encode("ascii"))
        return exit_code, None
    if os.WIFSIGNALED(status):
        signal_number = os.WTERMSIG(status)
        signal_name = signal.Signals(signal_number).name
        _write_report(f"TARGET - {signal_name}\n".encode("ascii"))
        return None, signal_number
    raise RuntimeError("the target produced an unsupported wait status")


def _exit_like_target(exit_code: int | None, signal_number: int | None) -> None:
    if signal_number is None:
        raise SystemExit(exit_code)
    signal.signal(signal_number, signal.SIG_DFL)
    os.kill(os.getpid(), signal_number)
    os._exit(128 + signal_number)


def _run(argv: list[str]) -> None:
    if len(argv) < 2:
        raise RuntimeError("the supervisor requires a target command")
    _become_subreaper()
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(number, signal.SIG_IGN)
    _write_report(_READY)
    _read_go()

    target_pid = os.fork()
    if target_pid == 0:
        try:
            os.close(_CONTROL_FD)
            os.close(_REPORT_FD)
            _reset_target_signals()
            os.execvpe(argv[1], argv[1:], os.environ)
        except BaseException:
            os._exit(127)

    target_outcome: tuple[int | None, int | None] | None = None
    while True:
        try:
            waited_pid, status = os.waitpid(-1, 0)
        except ChildProcessError:
            break
        if waited_pid == target_pid:
            target_outcome = _report_target_outcome(status)

    if target_outcome is None:
        raise RuntimeError("the target outcome was not observed")
    _exit_like_target(*target_outcome)


def main() -> None:
    try:
        _run(sys.argv)
    except BaseException as error:
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        try:
            _write_report(_ERROR)
        except BaseException:
            pass
        sys.stderr.write("Open Wrangler Linux process supervisor failed.\n")
        raise SystemExit(125) from None


if __name__ == "__main__":
    main()
