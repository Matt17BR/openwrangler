#!/usr/bin/env python3
"""Own one Linux editor process tree for the performance comparison study.

This helper is intentionally narrow.  It accepts one exact invocation shape,
becomes a Linux child subreaper, launches exactly one payload in a new session,
and stays alive until the payload tree has been reaped.  It is a process
ownership helper for a non-adversarial benchmark, not a security sandbox.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
import platform
import re
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, NoReturn, cast


PROTOCOL = "openwrangler-linux-study-supervisor-v1"
ERROR_PREFIX = "OPEN_WRANGLER_LINUX_SUPERVISOR_ERROR:"
PR_SET_CHILD_SUBREAPER = 36
PR_GET_CHILD_SUBREAPER = 37
MAXIMUM_ARGUMENTS = 256
MAXIMUM_ARGUMENT_BYTES = 256 * 1024
MAXIMUM_ENVIRONMENT_ENTRIES = 512
MAXIMUM_ENVIRONMENT_BYTES = 1024 * 1024
MAXIMUM_RECEIPT_BYTES = 32 * 1024
MAXIMUM_PROC_ENTRIES = 131_072
MAXIMUM_RETAINED_IDENTITIES = 256
MAXIMUM_STAT_BYTES = 16 * 1024
TERMINATION_GRACE_SECONDS = 2.0
KILL_GRACE_SECONDS = 3.0
POLL_SECONDS = 0.025
EMPTY_CENSUS_CHECKS = 3
HEX_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
ENVIRONMENT_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")

_INVOCATION_POLICY = {
    "argvGrammar": [
        "--protocol",
        "--nonce",
        "--receipt-fd",
        "--payload-environment-sha256",
        "--",
        "payload-argv",
    ],
    "ownership": {
        "census": "full-numeric-proc-stat-ppid",
        "historyIdentity": "pid-start-time-ticks",
        "pidReuse": "latch-invalid-clean-replacement",
        "subreaper": True,
    },
    "payloadLaunch": {"closeFds": True, "spawnCount": 1, "startNewSession": True},
    "protocol": PROTOCOL,
    "python": {"implementation": "CPython", "major": 3, "minor": 12},
    "signaling": {
        "api": "libc-pidfd-symbols",
        "identity": "pid-start-time-ticks",
        "pidfdRequired": True,
    },
    "subreaper": {
        "get": PR_GET_CHILD_SUBREAPER,
        "set": PR_SET_CHILD_SUBREAPER,
        "verifiedValue": 1,
    },
    "version": 1,
}


class SupervisorFailure(Exception):
    """A bounded, externally classifiable supervisor failure."""

    def __init__(self, stage: str) -> None:
        super().__init__(stage)
        self.stage = stage


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    parent_pid: int
    process_group_id: int
    session_id: int
    state: str
    start_time_ticks: str


@dataclass(frozen=True)
class IdentityReuse:
    pid: int
    previous_start_time_ticks: str
    replacement_start_time_ticks: str


@dataclass(frozen=True)
class Invocation:
    nonce: str
    receipt_fd: int
    expected_environment_sha256: str
    payload_argv: tuple[str, ...]


_stop_signal = 0
_pidfd_libc: ctypes.CDLL | None = None
PidfdOpenFunction = Callable[[int, int], int]
PidfdSendSignalFunction = Callable[[int, int, None, int], int]
_pidfd_open_function: PidfdOpenFunction | None = None
_pidfd_send_signal_function: PidfdSendSignalFunction | None = None


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _sha256_json(value: object) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _filesystem_identity(file_stat: os.stat_result) -> dict[str, str | int]:
    return {
        "device": str(file_stat.st_dev),
        "inode": str(file_stat.st_ino),
        "sizeBytes": file_stat.st_size,
        "mtimeNs": str(file_stat.st_mtime_ns),
    }


def _hash_regular_file(
    path: Path, *, maximum_bytes: int
) -> tuple[str, dict[str, str | int]]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise SupervisorFailure("provenance") from error
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise SupervisorFailure("provenance")
        if before.st_size < 0 or before.st_size > maximum_bytes:
            raise SupervisorFailure("provenance")
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > maximum_bytes:
                raise SupervisorFailure("provenance")
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (
            _filesystem_identity(before) != _filesystem_identity(after)
            or total != before.st_size
        ):
            raise SupervisorFailure("provenance")
        return digest.hexdigest(), _filesystem_identity(after)
    except OSError as error:
        raise SupervisorFailure("provenance") from error
    finally:
        os.close(descriptor)


def _parse_invocation(argv: list[str]) -> Invocation:
    if len(argv) < 10:
        raise SupervisorFailure("protocol")
    if (
        argv[1] != "--protocol"
        or argv[2] != PROTOCOL
        or argv[3] != "--nonce"
        or argv[5] != "--receipt-fd"
        or argv[7] != "--payload-environment-sha256"
        or argv[9] != "--"
    ):
        raise SupervisorFailure("protocol")

    nonce = argv[4]
    expected_environment_sha256 = argv[8]
    if (
        HEX_SHA256.fullmatch(nonce) is None
        or HEX_SHA256.fullmatch(expected_environment_sha256) is None
    ):
        raise SupervisorFailure("protocol")
    if not argv[6].isascii() or not argv[6].isdigit() or len(argv[6]) > 6:
        raise SupervisorFailure("protocol")
    receipt_fd = int(argv[6], 10)
    if receipt_fd < 3 or receipt_fd > 1_048_575:
        raise SupervisorFailure("protocol")

    payload = tuple(argv[10:])
    if not payload or len(payload) > MAXIMUM_ARGUMENTS:
        raise SupervisorFailure("protocol")
    argument_bytes = sum(len(argument.encode("utf-8")) for argument in payload)
    if argument_bytes > MAXIMUM_ARGUMENT_BYTES or any(
        "\x00" in argument for argument in payload
    ):
        raise SupervisorFailure("protocol")
    try:
        receipt_stat = os.fstat(receipt_fd)
    except OSError as error:
        raise SupervisorFailure("receipt-fd") from error
    if not (stat.S_ISFIFO(receipt_stat.st_mode) or stat.S_ISSOCK(receipt_stat.st_mode)):
        raise SupervisorFailure("receipt-fd")
    return Invocation(nonce, receipt_fd, expected_environment_sha256, payload)


def _environment_payload(environment: dict[str, str]) -> list[list[str]]:
    if len(environment) > MAXIMUM_ENVIRONMENT_ENTRIES:
        raise SupervisorFailure("environment")
    entries: list[list[str]] = []
    for key, value in environment.items():
        if ENVIRONMENT_NAME.fullmatch(key) is None or "\x00" in value:
            raise SupervisorFailure("environment")
        entries.append([key, value])
    entries.sort(key=lambda item: item[0])
    if len(_canonical_json(entries)) > MAXIMUM_ENVIRONMENT_BYTES:
        raise SupervisorFailure("environment")
    return entries


def _read_proc_stat(pid: int) -> ProcessIdentity | None:
    path = f"/proc/{pid}/stat"
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        raise SupervisorFailure("proc-census") from error
    try:
        payload = os.read(descriptor, MAXIMUM_STAT_BYTES + 1)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        raise SupervisorFailure("proc-census") from error
    finally:
        os.close(descriptor)
    if len(payload) > MAXIMUM_STAT_BYTES:
        raise SupervisorFailure("proc-census")
    try:
        text = payload.decode("ascii")
    except UnicodeDecodeError as error:
        raise SupervisorFailure("proc-census") from error
    closing_parenthesis = text.rfind(")")
    if closing_parenthesis <= 0 or not text.endswith("\n"):
        raise SupervisorFailure("proc-census")
    try:
        parsed_pid = int(text[: text.index(" ")], 10)
        fields = text[closing_parenthesis + 2 :].split()
        if len(fields) < 20:
            raise ValueError
        state = fields[0]
        parent_pid = int(fields[1], 10)
        process_group_id = int(fields[2], 10)
        session_id = int(fields[3], 10)
        start_time_ticks = fields[19]
    except (ValueError, IndexError) as error:
        raise SupervisorFailure("proc-census") from error
    if (
        parsed_pid != pid
        or pid <= 0
        or parent_pid < 0
        or process_group_id < 0
        or session_id < 0
        or len(state) != 1
        or not start_time_ticks.isascii()
        or not start_time_ticks.isdigit()
    ):
        raise SupervisorFailure("proc-census")
    return ProcessIdentity(
        pid,
        parent_pid,
        process_group_id,
        session_id,
        state,
        start_time_ticks,
    )


def _proc_census() -> dict[int, ProcessIdentity]:
    try:
        names = os.listdir("/proc")
    except OSError as error:
        raise SupervisorFailure("proc-census") from error
    numeric_names = [name for name in names if name.isascii() and name.isdigit()]
    if len(numeric_names) > MAXIMUM_PROC_ENTRIES:
        raise SupervisorFailure("proc-census")
    census: dict[int, ProcessIdentity] = {}
    for name in numeric_names:
        pid = int(name, 10)
        identity = _read_proc_stat(pid)
        if identity is not None:
            census[pid] = identity
    return census


def _owned_closure(
    census: dict[int, ProcessIdentity], supervisor: ProcessIdentity
) -> dict[int, ProcessIdentity]:
    observed_supervisor = census.get(supervisor.pid)
    if (
        observed_supervisor is None
        or observed_supervisor.start_time_ticks != supervisor.start_time_ticks
    ):
        raise SupervisorFailure("supervisor-identity")
    by_parent: dict[int, list[ProcessIdentity]] = {}
    for identity in census.values():
        by_parent.setdefault(identity.parent_pid, []).append(identity)
    owned = {supervisor.pid: observed_supervisor}
    pending = [supervisor.pid]
    while pending:
        parent_pid = pending.pop()
        for child in by_parent.get(parent_pid, ()):
            if child.pid not in owned:
                owned[child.pid] = child
                pending.append(child.pid)
    return owned


def _set_and_verify_subreaper() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = [
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
    ]
    prctl.restype = ctypes.c_int
    if prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise SupervisorFailure("subreaper")
    value = ctypes.c_int(0)
    if (
        prctl(PR_GET_CHILD_SUBREAPER, ctypes.addressof(value), 0, 0, 0) != 0
        or value.value != 1
    ):
        raise SupervisorFailure("subreaper")


def _verify_pidfd_support() -> None:
    global _pidfd_libc, _pidfd_open_function, _pidfd_send_signal_function
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        raw_pidfd_open = libc.pidfd_open
        raw_pidfd_send_signal = libc.pidfd_send_signal
    except (AttributeError, OSError) as error:
        raise SupervisorFailure("pidfd") from error
    raw_pidfd_open.argtypes = [ctypes.c_int, ctypes.c_uint]
    raw_pidfd_open.restype = ctypes.c_int
    raw_pidfd_send_signal.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint,
    ]
    raw_pidfd_send_signal.restype = ctypes.c_int
    pidfd_open = cast(PidfdOpenFunction, raw_pidfd_open)
    pidfd_send_signal = cast(PidfdSendSignalFunction, raw_pidfd_send_signal)
    _pidfd_libc = libc
    _pidfd_open_function = pidfd_open
    _pidfd_send_signal_function = pidfd_send_signal
    ctypes.set_errno(0)
    descriptor = pidfd_open(os.getpid(), 0)
    if descriptor < 0:
        error_number = ctypes.get_errno()
        ctypes.set_errno(0)
        raise SupervisorFailure("pidfd") from OSError(
            error_number, os.strerror(error_number)
        )
    try:
        ctypes.set_errno(0)
        if pidfd_send_signal(descriptor, 0, None, 0) != 0:
            error_number = ctypes.get_errno()
            ctypes.set_errno(0)
            raise SupervisorFailure("pidfd") from OSError(
                error_number, os.strerror(error_number)
            )
    finally:
        os.close(descriptor)


def _open_pidfd(pid: int) -> int:
    if _pidfd_open_function is None:
        raise SupervisorFailure("pidfd")
    ctypes.set_errno(0)
    descriptor = _pidfd_open_function(pid, 0)
    if descriptor < 0:
        error_number = ctypes.get_errno()
        ctypes.set_errno(0)
        if error_number in (errno.ENOENT, errno.ESRCH):
            raise ProcessLookupError(error_number, os.strerror(error_number))
        raise SupervisorFailure("pidfd")
    return descriptor


def _send_pidfd_signal(descriptor: int, signum: int) -> None:
    if _pidfd_send_signal_function is None:
        raise SupervisorFailure("pidfd")
    ctypes.set_errno(0)
    if _pidfd_send_signal_function(descriptor, signum, None, 0) != 0:
        error_number = ctypes.get_errno()
        ctypes.set_errno(0)
        if error_number in (errno.ENOENT, errno.ESRCH):
            raise ProcessLookupError(error_number, os.strerror(error_number))
        raise SupervisorFailure("process-signal")


def _install_signal_handlers() -> None:
    def request_stop(signum: int, _frame: object) -> None:
        global _stop_signal
        if _stop_signal == 0:
            _stop_signal = signum

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, request_stop)


def _provenance() -> tuple[dict[str, object], dict[str, object]]:
    source_path = Path(__file__).resolve(strict=True)
    source_sha256, source_identity = _hash_regular_file(
        source_path, maximum_bytes=1024 * 1024
    )
    try:
        python_path = Path(os.readlink("/proc/self/exe")).resolve(strict=True)
        if not os.path.samefile(python_path, Path(sys.executable).resolve(strict=True)):
            raise SupervisorFailure("provenance")
    except (OSError, RuntimeError) as error:
        raise SupervisorFailure("provenance") from error
    python_sha256, python_identity = _hash_regular_file(
        python_path, maximum_bytes=256 * 1024 * 1024
    )
    return (
        {"sha256": source_sha256, "filesystemIdentity": source_identity},
        {
            "implementation": platform.python_implementation(),
            "version": platform.python_version(),
            "sha256": python_sha256,
            "filesystemIdentity": python_identity,
        },
    )


def _write_receipt_frame(receipt_fd: int, receipt: dict[str, object]) -> None:
    payload = _canonical_json(receipt) + b"\n"
    if len(payload) > MAXIMUM_RECEIPT_BYTES:
        raise SupervisorFailure("receipt")
    offset = 0
    try:
        while offset < len(payload):
            written = os.write(receipt_fd, payload[offset:])
            if written <= 0:
                raise SupervisorFailure("receipt")
            offset += written
    except OSError as error:
        raise SupervisorFailure("receipt") from error


def _wait_status_exit_code(status: int) -> int:
    exit_code = os.waitstatus_to_exitcode(status)
    return exit_code if exit_code >= 0 else 128 + -exit_code


def _reap_available(editor_root_pid: int, editor_exit_code: int | None) -> int | None:
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return editor_exit_code
        except InterruptedError:
            continue
        if pid == 0:
            return editor_exit_code
        if pid == editor_root_pid:
            editor_exit_code = _wait_status_exit_code(status)


def _identity_still_matches(identity: ProcessIdentity) -> bool:
    observed = _read_proc_stat(identity.pid)
    return (
        observed is not None and observed.start_time_ticks == identity.start_time_ticks
    )


def _signal_identity(identity: ProcessIdentity, signum: int) -> bool:
    if identity.pid == os.getpid() or identity.state == "Z":
        return False
    if not _identity_still_matches(identity):
        return False
    pidfd: int | None = None
    try:
        pidfd = _open_pidfd(identity.pid)
        observed_after_open = _read_proc_stat(identity.pid)
        if (
            observed_after_open is None
            or observed_after_open.start_time_ticks != identity.start_time_ticks
        ):
            return False
        _send_pidfd_signal(pidfd, signum)
        return True
    except ProcessLookupError:
        return False
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ESRCH):
            raise SupervisorFailure("process-signal") from error
    finally:
        if pidfd is not None:
            os.close(pidfd)


def _refresh_owned(
    supervisor: ProcessIdentity,
    retained: dict[tuple[int, str], ProcessIdentity],
    identity_reuse_events: list[IdentityReuse],
) -> dict[int, ProcessIdentity]:
    owned = _owned_closure(_proc_census(), supervisor)
    for identity in owned.values():
        key = (identity.pid, identity.start_time_ticks)
        if key not in retained:
            previous = next(
                (
                    candidate
                    for candidate in reversed(retained.values())
                    if candidate.pid == identity.pid
                    and candidate.start_time_ticks != identity.start_time_ticks
                ),
                None,
            )
            if previous is not None:
                event = IdentityReuse(
                    identity.pid,
                    previous.start_time_ticks,
                    identity.start_time_ticks,
                )
                if event not in identity_reuse_events:
                    identity_reuse_events.append(event)
                    if len(identity_reuse_events) > MAXIMUM_RETAINED_IDENTITIES:
                        raise SupervisorFailure("ownership-limit")
        retained[key] = identity
    if len(retained) - 1 > MAXIMUM_RETAINED_IDENTITIES:
        raise SupervisorFailure("ownership-limit")
    return owned


def _live_retained(
    retained: dict[tuple[int, str], ProcessIdentity],
) -> list[ProcessIdentity]:
    live: list[ProcessIdentity] = []
    for identity in retained.values():
        if identity.pid == os.getpid():
            continue
        observed = _read_proc_stat(identity.pid)
        if (
            observed is not None
            and observed.start_time_ticks == identity.start_time_ticks
        ):
            live.append(observed)
    return live


def _terminate_owned_tree(
    supervisor: ProcessIdentity,
    editor_root_pid: int,
    editor_exit_code: int | None,
    retained: dict[tuple[int, str], ProcessIdentity],
    identity_reuse_events: list[IdentityReuse],
    terminated: set[tuple[int, str]],
) -> int | None:
    for signum, grace_seconds in (
        (signal.SIGTERM, TERMINATION_GRACE_SECONDS),
        (signal.SIGKILL, KILL_GRACE_SECONDS),
    ):
        deadline = time.monotonic() + grace_seconds
        while True:
            owned = _refresh_owned(supervisor, retained, identity_reuse_events)
            candidates = {
                identity.pid: identity
                for identity in (*owned.values(), *_live_retained(retained))
                if identity.pid != supervisor.pid
            }
            if not candidates:
                return _reap_available(editor_root_pid, editor_exit_code)
            for identity in sorted(
                candidates.values(), key=lambda item: item.pid, reverse=True
            ):
                if _signal_identity(identity, signum):
                    terminated.add((identity.pid, identity.start_time_ticks))
            editor_exit_code = _reap_available(editor_root_pid, editor_exit_code)
            if time.monotonic() >= deadline:
                break
            time.sleep(POLL_SECONDS)
    if _live_retained(retained):
        raise SupervisorFailure("cleanup")
    return _reap_available(editor_root_pid, editor_exit_code)


def _prove_empty_owned_tree(
    supervisor: ProcessIdentity,
    editor_root_pid: int,
    editor_exit_code: int | None,
    retained: dict[tuple[int, str], ProcessIdentity],
    identity_reuse_events: list[IdentityReuse],
) -> tuple[int | None, list[dict[str, object]]]:
    checks: list[dict[str, object]] = []
    for index in range(EMPTY_CENSUS_CHECKS):
        editor_exit_code = _reap_available(editor_root_pid, editor_exit_code)
        owned = _refresh_owned(supervisor, retained, identity_reuse_events)
        live_retained = _live_retained(retained)
        descendants = [
            identity for identity in owned.values() if identity.pid != supervisor.pid
        ]
        if descendants or live_retained:
            raise SupervisorFailure("cleanup-proof")
        checks.append(
            {
                "monotonicNanoseconds": str(time.monotonic_ns()),
                "ownedProcessCount": 0,
            }
        )
        if index + 1 < EMPTY_CENSUS_CHECKS:
            time.sleep(POLL_SECONDS)
    return editor_exit_code, checks


def _run(invocation: Invocation) -> int:
    if (
        sys.platform != "linux"
        or platform.python_implementation() != "CPython"
        or sys.version_info[:2] != (3, 12)
    ):
        raise SupervisorFailure("platform")
    environment = dict(os.environ)
    environment_sha256 = _sha256_json(_environment_payload(environment))
    if environment_sha256 != invocation.expected_environment_sha256:
        raise SupervisorFailure("environment-digest")

    _set_and_verify_subreaper()
    _verify_pidfd_support()
    _install_signal_handlers()
    supervisor = _read_proc_stat(os.getpid())
    if supervisor is None:
        raise SupervisorFailure("supervisor-identity")
    source_provenance, python_provenance = _provenance()
    policy_sha256 = _sha256_json(_INVOCATION_POLICY)
    payload_argv_sha256 = _sha256_json(list(invocation.payload_argv))
    invocation_sha256 = _sha256_json(
        {
            "nonce": invocation.nonce,
            "payloadArgvSha256": payload_argv_sha256,
            "payloadEnvironmentSha256": environment_sha256,
            "policySha256": policy_sha256,
            "protocol": PROTOCOL,
            "receiptFd": invocation.receipt_fd,
        }
    )
    if _stop_signal != 0:
        raise SupervisorFailure("interrupted")

    try:
        editor_process = subprocess.Popen(
            invocation.payload_argv,
            close_fds=True,
            env=environment,
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, ValueError) as error:
        raise SupervisorFailure("spawn") from error

    retained: dict[tuple[int, str], ProcessIdentity] = {
        (supervisor.pid, supervisor.start_time_ticks): supervisor
    }
    identity_reuse_events: list[IdentityReuse] = []
    terminated: set[tuple[int, str]] = set()
    editor_exit_code: int | None = None
    try:
        editor_root = _read_proc_stat(editor_process.pid)
        if (
            editor_root is None
            or editor_root.parent_pid != supervisor.pid
            or editor_root.process_group_id != editor_root.pid
            or editor_root.session_id != editor_root.pid
        ):
            raise SupervisorFailure("editor-identity")
        retained[(editor_root.pid, editor_root.start_time_ticks)] = editor_root
        receipt = {
            "protocol": PROTOCOL,
            "kind": "launch",
            "nonce": invocation.nonce,
            "supervisor": {
                "pid": supervisor.pid,
                "startTimeTicks": supervisor.start_time_ticks,
                "subreaperVerified": True,
                "pidfdVerified": True,
            },
            "editorRoot": {
                "pid": editor_root.pid,
                "startTimeTicks": editor_root.start_time_ticks,
                "processGroupId": editor_root.process_group_id,
                "sessionId": editor_root.session_id,
            },
            "supervisorSource": source_provenance,
            "pythonExecutable": python_provenance,
            "invocationPolicySha256": policy_sha256,
            "invocationSha256": invocation_sha256,
            "payloadArgvSha256": payload_argv_sha256,
            "payloadEnvironmentSha256": environment_sha256,
        }
        _write_receipt_frame(invocation.receipt_fd, receipt)

        while editor_exit_code is None and _stop_signal == 0:
            _refresh_owned(supervisor, retained, identity_reuse_events)
            editor_exit_code = _reap_available(editor_root.pid, editor_exit_code)
            if editor_exit_code is None:
                time.sleep(POLL_SECONDS)
        editor_exit_code = _terminate_owned_tree(
            supervisor,
            editor_root.pid,
            editor_exit_code,
            retained,
            identity_reuse_events,
            terminated,
        )
        editor_exit_code, empty_checks = _prove_empty_owned_tree(
            supervisor,
            editor_root.pid,
            editor_exit_code,
            retained,
            identity_reuse_events,
        )
        supervisor_exit_code = (
            125
            if identity_reuse_events
            else 128 + _stop_signal
            if _stop_signal != 0
            else editor_exit_code
            if editor_exit_code is not None
            else 125
        )
        terminal_receipt = {
            "protocol": PROTOCOL,
            "kind": "terminal-cleanup",
            "nonce": invocation.nonce,
            "supervisor": {
                "pid": supervisor.pid,
                "startTimeTicks": supervisor.start_time_ticks,
            },
            "editorRoot": {
                "pid": editor_root.pid,
                "startTimeTicks": editor_root.start_time_ticks,
            },
            "retainedOwnedIdentities": [
                {
                    "pid": identity.pid,
                    "startTimeTicks": identity.start_time_ticks,
                    "disposition": (
                        "terminated"
                        if (identity.pid, identity.start_time_ticks) in terminated
                        else "exited"
                    ),
                }
                for identity in sorted(
                    retained.values(),
                    key=lambda item: (item.pid, int(item.start_time_ticks)),
                )
                if identity.pid != supervisor.pid
            ],
            "identityReuseEvents": [
                {
                    "pid": event.pid,
                    "previousStartTimeTicks": event.previous_start_time_ticks,
                    "replacementStartTimeTicks": event.replacement_start_time_ticks,
                }
                for event in identity_reuse_events
            ],
            "emptyCensusProof": {
                "requiredConsecutiveChecks": EMPTY_CENSUS_CHECKS,
                "checks": empty_checks,
            },
            "supervisorExitCode": supervisor_exit_code,
        }
        _write_receipt_frame(invocation.receipt_fd, terminal_receipt)
        os.close(invocation.receipt_fd)
        return supervisor_exit_code
    except BaseException:
        try:
            _terminate_owned_tree(
                supervisor,
                editor_process.pid,
                editor_exit_code,
                retained,
                identity_reuse_events,
                terminated,
            )
        except BaseException:
            pass
        raise
    finally:
        try:
            os.close(invocation.receipt_fd)
        except OSError:
            pass
        editor_process.returncode = editor_exit_code


def _fail(stage: str) -> NoReturn:
    bounded_stage = stage if re.fullmatch(r"[a-z0-9-]{1,48}", stage) else "internal"
    sys.stderr.write(f"{ERROR_PREFIX}{bounded_stage}\n")
    raise SystemExit(125)


def main() -> int:
    try:
        invocation = _parse_invocation(sys.argv)
        return _run(invocation)
    except SupervisorFailure as error:
        _fail(error.stage)
    except BaseException:
        _fail("internal")


if __name__ == "__main__":
    raise SystemExit(main())
