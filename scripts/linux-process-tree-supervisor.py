#!/usr/bin/env python3
"""Launch one command below a parent-leased Linux child subreaper."""

from __future__ import annotations

import ctypes
import os
import select
import signal
import socket
import sys
import time
import uuid


_CONTROL_FD = 3
_REPORT_FD = 4
_PR_SET_PDEATHSIG = 1
_PR_SET_CHILD_SUBREAPER = 36
_PARENT_DEATH_SIGNAL = signal.SIGUSR1
_PARENT_TERM_GRACE_SECONDS = 2.0
_POLL_MILLISECONDS = 25
_MAX_CHILDREN_BYTES = 64 * 1024
_MAX_DIRECT_CHILDREN = 4096
_CLEANUP_LEASE_TOKEN_ENV = "OPEN_WRANGLER_HEAVY_CLEANUP_LEASE_TOKEN"
_READY = b"READY\n"
_GO = b"GO\n"
_ERROR = b"ERROR\n"
_parent_death_requested = False


class ParentLeaseLost(RuntimeError):
    """The Node owner disappeared before its complete child tree settled."""


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
        raise ParentLeaseLost("the parent lease closed before one exact GO frame")


def _prctl(option: int, argument: int) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    if prctl(option, argument, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def _request_parent_death_cleanup(_signal_number: int, _frame: object) -> None:
    global _parent_death_requested
    _parent_death_requested = True


def _arm_ownership(expected_parent_pid: int) -> None:
    if os.getppid() != expected_parent_pid:
        raise ParentLeaseLost("the expected parent disappeared before ownership could arm")
    signal.signal(_PARENT_DEATH_SIGNAL, _request_parent_death_cleanup)
    _prctl(_PR_SET_CHILD_SUBREAPER, 1)
    _prctl(_PR_SET_PDEATHSIG, _PARENT_DEATH_SIGNAL)
    if os.getppid() != expected_parent_pid or _parent_death_requested:
        raise ParentLeaseLost("the expected parent disappeared while ownership was arming")


def _validate_token(raw_token: str | None) -> str:
    if raw_token is None or len(raw_token) != 36:
        raise RuntimeError("the cleanup lease requires one private token")
    try:
        parsed = uuid.UUID(raw_token)
    except ValueError as error:
        raise RuntimeError("the cleanup lease token is malformed") from error
    if str(parsed) != raw_token or parsed.version != 4:
        raise RuntimeError("the cleanup lease token is not canonical")
    return raw_token


def _open_cleanup_lease(port: int) -> socket.socket:
    if port < 35_000 or port >= 45_000:
        raise RuntimeError("the cleanup lease port is outside its private range")
    cleanup_lease = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        cleanup_lease.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        cleanup_lease.bind(("127.0.0.1", port))
        cleanup_lease.listen(8)
        cleanup_lease.setblocking(False)
    except BaseException:
        cleanup_lease.close()
        raise
    return cleanup_lease


def _serve_cleanup_token(cleanup_lease: socket.socket, token: str) -> None:
    for _ in range(16):
        try:
            connection, _address = cleanup_lease.accept()
        except BlockingIOError:
            return
        try:
            connection.settimeout(0.1)
            connection.sendall(token.encode("ascii"))
        except OSError:
            pass
        finally:
            connection.close()


def _create_poller(cleanup_lease: socket.socket) -> select.poll:
    poller = select.poll()
    event_mask = select.POLLIN | select.POLLHUP | select.POLLERR | select.POLLNVAL
    poller.register(_CONTROL_FD, event_mask)
    poller.register(cleanup_lease.fileno(), event_mask)
    return poller


def _parent_lease_lost(poller: select.poll, cleanup_lease: socket.socket, token: str) -> bool:
    if _parent_death_requested:
        return True
    try:
        events = poller.poll(_POLL_MILLISECONDS)
    except InterruptedError:
        return _parent_death_requested
    for descriptor, event_mask in events:
        if descriptor == cleanup_lease.fileno():
            if event_mask & (select.POLLHUP | select.POLLERR | select.POLLNVAL):
                return True
            if event_mask & select.POLLIN:
                _serve_cleanup_token(cleanup_lease, token)
            continue
        if descriptor != _CONTROL_FD:
            return True
        if event_mask & (select.POLLHUP | select.POLLERR | select.POLLNVAL):
            return True
        if event_mask & select.POLLIN:
            try:
                os.read(_CONTROL_FD, 4097)
            except OSError:
                return True
            return True
    return _parent_death_requested


def _reset_target_signals() -> None:
    _prctl(_PR_SET_PDEATHSIG, 0)
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM, _PARENT_DEATH_SIGNAL):
        signal.signal(number, signal.SIG_DFL)


def _target_outcome(status: int) -> tuple[int | None, int | None]:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status), None
    if os.WIFSIGNALED(status):
        return None, os.WTERMSIG(status)
    raise RuntimeError("the target produced an unsupported wait status")


def _report_target_outcome(outcome: tuple[int | None, int | None]) -> None:
    exit_code, signal_number = outcome
    if signal_number is None:
        _write_report(f"TARGET {exit_code} -\n".encode("ascii"))
        return
    signal_name = signal.Signals(signal_number).name
    _write_report(f"TARGET - {signal_name}\n".encode("ascii"))


def _reap_available(
    target_pid: int, target_outcome: tuple[int | None, int | None] | None
) -> tuple[tuple[int | None, int | None] | None, bool]:
    while True:
        try:
            waited_pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return target_outcome, False
        if waited_pid == 0:
            return target_outcome, True
        if waited_pid == target_pid:
            if target_outcome is not None:
                raise RuntimeError("the target outcome was observed twice")
            target_outcome = _target_outcome(status)


def _direct_child_pids() -> tuple[int, ...]:
    path = f"/proc/self/task/{os.getpid()}/children"
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        contents = os.read(descriptor, _MAX_CHILDREN_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(contents) > _MAX_CHILDREN_BYTES:
        raise RuntimeError("the direct-child list exceeded its byte bound")
    fields = contents.split()
    if len(fields) > _MAX_DIRECT_CHILDREN:
        raise RuntimeError("the direct-child list exceeded its process bound")
    children = tuple(int(field) for field in fields)
    if any(pid <= 0 or pid == os.getpid() for pid in children):
        raise RuntimeError("the direct-child list contained an invalid PID")
    return children


def _signal_direct_children(signal_number: int) -> None:
    children = _direct_child_pids()
    for pid in children:
        try:
            os.kill(pid, signal_number)
        except ProcessLookupError:
            pass


def _drain_after_parent_death(
    target_pid: int,
    target_outcome: tuple[int | None, int | None] | None,
    cleanup_lease: socket.socket,
    token: str,
) -> None:
    started = time.monotonic()
    while True:
        target_outcome, children_exist = _reap_available(target_pid, target_outcome)
        if not children_exist:
            return
        signal_number = (
            signal.SIGTERM
            if time.monotonic() - started < _PARENT_TERM_GRACE_SECONDS
            else signal.SIGKILL
        )
        try:
            _signal_direct_children(signal_number)
        except (OSError, RuntimeError, ValueError):
            # Ownership uncertainty may delay cleanup, but it must never make
            # the supervisor exit and orphan a still-live child tree.
            pass
        _serve_cleanup_token(cleanup_lease, token)
        time.sleep(_POLL_MILLISECONDS / 1000)


def _supervise(
    target_pid: int, poller: select.poll, cleanup_lease: socket.socket, token: str
) -> tuple[int | None, int | None]:
    target_outcome: tuple[int | None, int | None] | None = None
    target_reported = False
    while True:
        target_outcome, children_exist = _reap_available(target_pid, target_outcome)
        if not children_exist:
            if target_outcome is None:
                raise RuntimeError("the target outcome was not observed")
            if not target_reported:
                _report_target_outcome(target_outcome)
            return target_outcome

        if target_outcome is not None and not target_reported:
            try:
                _report_target_outcome(target_outcome)
                target_reported = True
            except (BrokenPipeError, OSError):
                _drain_after_parent_death(target_pid, target_outcome, cleanup_lease, token)
                raise ParentLeaseLost("the parent disappeared before the target tree settled") from None

        if _parent_lease_lost(poller, cleanup_lease, token):
            _drain_after_parent_death(target_pid, target_outcome, cleanup_lease, token)
            raise ParentLeaseLost("the parent lease closed before the target tree settled")


def _exit_like_target(exit_code: int | None, signal_number: int | None) -> None:
    if signal_number is None:
        raise SystemExit(exit_code)
    signal.signal(signal_number, signal.SIG_DFL)
    os.kill(os.getpid(), signal_number)
    os._exit(128 + signal_number)


def _run(argv: list[str]) -> None:
    if len(argv) < 4:
        raise RuntimeError("the supervisor requires parent, lease, and target arguments")
    try:
        expected_parent_pid = int(argv[1])
        cleanup_port = int(argv[2])
    except ValueError as error:
        raise RuntimeError("the supervisor launch arguments are malformed") from error
    if expected_parent_pid <= 0:
        raise RuntimeError("the supervisor parent PID is invalid")
    token = _validate_token(os.environ.get(_CLEANUP_LEASE_TOKEN_ENV))
    _arm_ownership(expected_parent_pid)
    cleanup_lease = _open_cleanup_lease(cleanup_port)
    try:
        if os.getppid() != expected_parent_pid or _parent_death_requested:
            raise ParentLeaseLost("the expected parent disappeared before the launch barrier")
        for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            signal.signal(number, signal.SIG_IGN)
        _write_report(_READY)
        _read_go()
        if os.getppid() != expected_parent_pid or _parent_death_requested:
            raise ParentLeaseLost("the expected parent disappeared at the launch barrier")

        target_pid = os.fork()
        if target_pid == 0:
            try:
                os.close(_CONTROL_FD)
                os.close(_REPORT_FD)
                cleanup_lease.close()
                _reset_target_signals()
                target_environment = dict(os.environ)
                target_environment.pop(_CLEANUP_LEASE_TOKEN_ENV, None)
                os.execvpe(argv[3], argv[3:], target_environment)
            except BaseException:
                os._exit(127)

        poller = _create_poller(cleanup_lease)
        outcome = _supervise(target_pid, poller, cleanup_lease, token)
        _exit_like_target(*outcome)
    finally:
        cleanup_lease.close()


def main() -> None:
    try:
        _run(sys.argv)
    except ParentLeaseLost:
        raise SystemExit(125) from None
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
