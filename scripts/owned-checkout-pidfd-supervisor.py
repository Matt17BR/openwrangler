from __future__ import annotations

import base64
import binascii
import json
import os
import select
import signal
import sys
import time
from typing import NoReturn


PROTOCOL = "openwrangler-owned-checkout-pidfd-v1"
GIT_EXEC_PROTOCOL = "openwrangler-owned-checkout-git-exec-v1"
TOKEN_LENGTH = 32
MAXIMUM_REQUEST_BYTES = 32 * 1024
MAXIMUM_FRAME_BYTES = 64 * 1024
MAXIMUM_TARGETS = 512
MAXIMUM_CGROUP_DIRECTORIES = 4096
MAXIMUM_CGROUP_BYTES = 4 * 1024 * 1024
GIT_EXECUTABLE_FD = 5
PYTHON_RUNTIME_FD = 6
SUPERVISOR_SOURCE_FD = 7


def emit(value: dict[str, object]) -> None:
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii") + b"\n"
    if len(payload) > MAXIMUM_FRAME_BYTES:
        raise RuntimeError("frame bound")
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def stop(code: str, token: str, exit_code: int = 1) -> NoReturn:
    emit({"protocol": PROTOCOL, "type": "error", "token": token, "code": code})
    raise SystemExit(exit_code)


def exact_object(value: object, keys: set[str]) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("object shape")
    return value


def strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate key")
        value[key] = item
    return value


def positive_integer(value: object, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0 or value > maximum:
        raise ValueError("integer")
    return value


def process_starttime(pid: int, pidfd: int) -> str | None:
    if pidfd_exited(pidfd):
        return None
    try:
        with open(f"/proc/{pid}/stat", "rb", buffering=0) as handle:
            value = handle.read(64 * 1024 + 1)
    except (FileNotFoundError, ProcessLookupError):
        return None
    if len(value) == 0 or len(value) > 64 * 1024:
        raise RuntimeError("stat bound")
    closing = value.rfind(b")")
    fields = value[closing + 2 :].strip().split() if closing >= 0 else []
    if len(fields) < 20 or not fields[19].isdigit() or fields[19] == b"0":
        raise RuntimeError("stat shape")
    if pidfd_exited(pidfd):
        return None
    return fields[19].decode("ascii")


def pidfd_exited(pidfd: int) -> bool:
    poller = select.poll()
    poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
    events = poller.poll(0)
    if not events:
        return False
    event = events[0][1]
    if event & select.POLLNVAL or event & select.POLLERR or event & select.POLLHUP and not event & select.POLLIN:
        raise RuntimeError("pidfd poll state")
    return bool(event & select.POLLIN)


def production_cgroup_member(pid: int, root: str, pidfd: int) -> bool | None:
    if pidfd_exited(pidfd):
        return None
    try:
        with open(f"/proc/{pid}/cgroup", "rb", buffering=0) as handle:
            value = handle.read(64 * 1024 + 1)
    except (FileNotFoundError, ProcessLookupError):
        return False
    if len(value) == 0 or len(value) > 64 * 1024:
        raise RuntimeError("cgroup bound")
    lines = value.decode("ascii").rstrip("\n").split("\n")
    if len(lines) != 1 or not lines[0].startswith("0::/"):
        raise RuntimeError("cgroup shape")
    current = lines[0][3:]
    if "\\" in current or "\x00" in current or os.path.normpath(current) != current:
        raise RuntimeError("cgroup path")
    if pidfd_exited(pidfd):
        return None
    return current == root or current.startswith(root.rstrip("/") + "/")


def test_cgroup_members(path: str) -> set[int]:
    pending = [path]
    members: set[int] = set()
    directories = 0
    consumed = 0
    while pending:
        current = pending.pop()
        directories += 1
        if directories > MAXIMUM_CGROUP_DIRECTORIES:
            raise RuntimeError("cgroup directory bound")
        with os.scandir(current) as entries:
            children = sorted((entry.path for entry in entries if entry.is_dir(follow_symlinks=False)), reverse=True)
        pending.extend(children)
        with open(os.path.join(current, "cgroup.procs"), "rb", buffering=0) as handle:
            value = handle.read(MAXIMUM_CGROUP_BYTES + 1)
        consumed += len(value)
        if len(value) > MAXIMUM_CGROUP_BYTES or consumed > MAXIMUM_CGROUP_BYTES:
            raise RuntimeError("cgroup byte bound")
        for line in value.splitlines():
            if line == b"0":
                continue
            if not line.isdigit() or line.startswith(b"0"):
                raise RuntimeError("cgroup process shape")
            members.add(int(line))
    return members


def test_cgroup_member(path: str, pid: int, pidfd: int) -> bool | None:
    if pidfd_exited(pidfd):
        return None
    present = pid in test_cgroup_members(path)
    if pidfd_exited(pidfd):
        return None
    return present


def remove_test_cgroup_members(path: str, removed: set[int]) -> None:
    pending = [path]
    directories = 0
    while pending:
        current = pending.pop()
        directories += 1
        if directories > MAXIMUM_CGROUP_DIRECTORIES:
            raise RuntimeError("cgroup directory bound")
        with os.scandir(current) as entries:
            pending.extend(entry.path for entry in entries if entry.is_dir(follow_symlinks=False))
        membership_path = os.path.join(current, "cgroup.procs")
        with open(membership_path, "rb", buffering=0) as handle:
            lines = handle.read(MAXIMUM_CGROUP_BYTES + 1).splitlines()
        if sum(len(line) + 1 for line in lines) > MAXIMUM_CGROUP_BYTES:
            raise RuntimeError("cgroup byte bound")
        retained = [line for line in lines if not line.isdigit() or int(line) not in removed]
        with open(membership_path, "wb", buffering=0) as handle:
            handle.write(b"".join(line + b"\n" for line in retained))
            os.fsync(handle.fileno())


def validate_request(encoded: str) -> tuple[str, str, str, str, int, int]:
    if not encoded or len(encoded) > MAXIMUM_REQUEST_BYTES * 2:
        raise ValueError("request bound")
    padding = "=" * ((4 - len(encoded) % 4) % 4)
    raw = base64.b64decode(encoded + padding, altchars=b"-_", validate=True)
    if len(raw) == 0 or len(raw) > MAXIMUM_REQUEST_BYTES:
        raise ValueError("request bound")
    value = exact_object(
        json.loads(raw.decode("utf-8"), object_pairs_hook=strict_object),
        {
            "protocol",
            "token",
            "cgroupTrust",
            "cgroupRelativePath",
            "cgroupPath",
            "termGraceMs",
            "killGraceMs",
        },
    )
    if value["protocol"] != PROTOCOL:
        raise ValueError("protocol")
    token = value["token"]
    if (
        not isinstance(token, str)
        or len(token) != TOKEN_LENGTH
        or any(character not in "0123456789abcdef" for character in token)
    ):
        raise ValueError("token")
    trust = value["cgroupTrust"]
    if not isinstance(trust, str) or trust not in {"production", "test"}:
        raise ValueError("trust")
    relative_path = value["cgroupRelativePath"]
    cgroup_path = value["cgroupPath"]
    if (
        not isinstance(relative_path, str)
        or not relative_path.startswith("/")
        or os.path.normpath(relative_path) != relative_path
        or not isinstance(cgroup_path, str)
        or not os.path.isabs(cgroup_path)
        or os.path.normpath(cgroup_path) != cgroup_path
        or "\x00" in relative_path
        or "\x00" in cgroup_path
    ):
        raise ValueError("cgroup")
    term_grace_ms = positive_integer(value["termGraceMs"], 5000)
    kill_grace_ms = positive_integer(value["killGraceMs"], 5000)
    return token, trust, relative_path, cgroup_path, term_grace_ms, kill_grace_ms


def validate_targets(target_values: object) -> list[tuple[int, str]]:
    if not isinstance(target_values, list) or len(target_values) > MAXIMUM_TARGETS:
        raise ValueError("targets")
    targets: list[tuple[int, str]] = []
    seen: set[int] = set()
    for target_value in target_values:
        target = exact_object(target_value, {"pid", "starttime"})
        pid = positive_integer(target["pid"], (1 << 31) - 1)
        starttime = target["starttime"]
        if not isinstance(starttime, str) or not starttime.isdigit() or starttime.startswith("0") or pid in seen:
            raise ValueError("target")
        seen.add(pid)
        targets.append((pid, starttime))
    return targets


def read_control(token: str, expected_type: str, timeout_ms: int) -> dict[str, object]:
    poller = select.poll()
    poller.register(sys.stdin.fileno(), select.POLLIN | select.POLLHUP | select.POLLERR)
    if not poller.poll(timeout_ms):
        raise TimeoutError("control timeout")
    line = sys.stdin.buffer.readline(MAXIMUM_FRAME_BYTES + 1)
    if len(line) == 0 or len(line) > MAXIMUM_FRAME_BYTES or not line.endswith(b"\n"):
        raise ValueError("control frame")
    keys = {"protocol", "type", "token", "targets"} if expected_type == "run" else {"protocol", "type", "token"}
    try:
        value = exact_object(json.loads(line.decode("utf-8"), object_pairs_hook=strict_object), keys)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise ValueError("control frame") from None
    if value["protocol"] != PROTOCOL or value["type"] != expected_type or value["token"] != token:
        raise ValueError("control correlation")
    return value


def close_launch_artifacts() -> None:
    for descriptor in (PYTHON_RUNTIME_FD, SUPERVISOR_SOURCE_FD):
        try:
            os.close(descriptor)
        except OSError:
            pass


def exec_git() -> NoReturn:
    if len(sys.argv) < 5 or sys.argv[1] != "--exec-git":
        raise ValueError("exec argv")
    token = sys.argv[2]
    if len(token) != TOKEN_LENGTH or any(character not in "0123456789abcdef" for character in token):
        raise ValueError("exec token")
    payload = json.dumps(
        {"protocol": GIT_EXEC_PROTOCOL, "type": "ready", "token": token},
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("ascii") + b"\n"
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()
    line = sys.stdin.buffer.readline(MAXIMUM_FRAME_BYTES + 1)
    if len(line) == 0 or len(line) > MAXIMUM_FRAME_BYTES or not line.endswith(b"\n"):
        raise ValueError("exec control")
    control = exact_object(
        json.loads(line.decode("utf-8"), object_pairs_hook=strict_object),
        {"protocol", "type", "token"},
    )
    if control != {"protocol": GIT_EXEC_PROTOCOL, "type": "go", "token": token}:
        raise ValueError("exec control")
    null_descriptor = os.open("/dev/null", os.O_RDONLY | os.O_CLOEXEC)
    try:
        os.dup2(null_descriptor, sys.stdin.fileno(), inheritable=True)
    finally:
        if null_descriptor != sys.stdin.fileno():
            os.close(null_descriptor)
    for descriptor in (GIT_EXECUTABLE_FD, PYTHON_RUNTIME_FD, SUPERVISOR_SOURCE_FD):
        os.set_inheritable(descriptor, False)
    os.execve(
        f"/proc/self/fd/{GIT_EXECUTABLE_FD}",
        [sys.argv[3], *sys.argv[4:]],
        dict(os.environ),
    )


def contain_open_pidfds(pidfds: dict[int, tuple[int, str]], timeout_ms: int) -> NoReturn:
    """Retain every uncertain pidfd until POLLIN, then exit without RESULT/ACK."""

    next_kill = 0.0
    while pidfds:
        now = time.monotonic()
        for pidfd in tuple(pidfds):
            try:
                exited = pidfd_exited(pidfd)
            except (OSError, RuntimeError):
                # Losing the ability to inspect an exact live handle can never
                # authorize closing it. The outer process-group deadline is the
                # only remaining containment mechanism.
                exited = False
            if exited:
                os.close(pidfd)
                del pidfds[pidfd]
                continue
            if now >= next_kill:
                try:
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL, None, 0)
                except (ProcessLookupError, OSError):
                    # ProcessLookupError is not an exit receipt. Retain the
                    # pidfd until POLLIN proves that exact process is gone.
                    pass
        if pidfds:
            if now >= next_kill:
                next_kill = now + timeout_ms / 1000
            time.sleep(0.01)

    # Reaching this path means the exact handles eventually reported POLLIN,
    # but containment already exceeded or lost its authoritative path. Never
    # turn that into a normal RESULT -> ACK completion.
    raise SystemExit(3)


def main() -> None:
    token = "0" * TOKEN_LENGTH
    pidfds: dict[int, tuple[int, str]] = {}
    try:
        if len(sys.argv) >= 2 and sys.argv[1] == "--exec-git":
            exec_git()
        if len(sys.argv) != 2:
            raise ValueError("argv")
        close_launch_artifacts()
        token, trust, relative_path, cgroup_path, term_grace_ms, kill_grace_ms = validate_request(sys.argv[1])
        if not callable(getattr(os, "pidfd_open", None)) or not callable(getattr(signal, "pidfd_send_signal", None)):
            stop("pidfd-unavailable", token)
        self_pidfd = os.pidfd_open(os.getpid(), 0)
        try:
            os.set_inheritable(self_pidfd, False)
            signal.pidfd_send_signal(self_pidfd, 0, None, 0)
            if pidfd_exited(self_pidfd):
                stop("pidfd-unavailable", token)
        finally:
            os.close(self_pidfd)

        emit({"protocol": PROTOCOL, "type": "ready", "token": token})
        outcome = "contained"
        accepted: list[dict[str, object]] = []
        live: list[dict[str, object]] = []
        try:
            run = read_control(token, "run", 2000)
            targets = validate_targets(run["targets"])
            for pid, expected_starttime in targets:
                accepted.append({"pid": pid, "starttime": expected_starttime})
                try:
                    pidfd = os.pidfd_open(pid, 0)
                except ProcessLookupError:
                    continue
                os.set_inheritable(pidfd, False)
                pidfds[pidfd] = (pid, expected_starttime)
                actual_starttime = process_starttime(pid, pidfd)
                if actual_starttime != expected_starttime:
                    if actual_starttime is None and pidfd_exited(pidfd):
                        os.close(pidfd)
                        del pidfds[pidfd]
                        continue
                    os.close(pidfd)
                    del pidfds[pidfd]
                    outcome = "identity-mismatch"
                    break
                if pidfd_exited(pidfd):
                    os.close(pidfd)
                    del pidfds[pidfd]
                    continue
                live.append({"pid": pid, "starttime": expected_starttime})

            if outcome == "contained":
                emit(
                    {
                        "protocol": PROTOCOL,
                        "type": "armed",
                        "token": token,
                        "accepted": accepted,
                        "live": live,
                    }
                )
                read_control(token, "go", 2000)

                member = (
                    (lambda pid, pidfd: production_cgroup_member(pid, relative_path, pidfd))
                    if trust == "production"
                    else (lambda pid, pidfd: test_cgroup_member(cgroup_path, pid, pidfd))
                )
                departed = False

                def reconcile_membership() -> None:
                    nonlocal departed
                    for pidfd, (pid, _starttime) in list(pidfds.items()):
                        if pidfd_exited(pidfd):
                            os.close(pidfd)
                            del pidfds[pidfd]
                            continue
                        membership = member(pid, pidfd)
                        if membership is None:
                            if not pidfd_exited(pidfd):
                                raise RuntimeError("pidfd membership state")
                            os.close(pidfd)
                            del pidfds[pidfd]
                        elif not membership:
                            if pidfd_exited(pidfd):
                                os.close(pidfd)
                                del pidfds[pidfd]
                            else:
                                departed = True

                def send_all(sent_signal: signal.Signals) -> bool:
                    for pidfd in list(pidfds):
                        if pidfd_exited(pidfd):
                            os.close(pidfd)
                            del pidfds[pidfd]
                            continue
                        try:
                            signal.pidfd_send_signal(pidfd, sent_signal, None, 0)
                        except ProcessLookupError:
                            if not pidfd_exited(pidfd):
                                return False
                    reconcile_membership()
                    return True

                def wait_until(deadline: float, check_membership: bool) -> None:
                    poller = select.poll()
                    for pidfd in pidfds:
                        poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
                    while pidfds and time.monotonic() < deadline:
                        for pidfd, _events in poller.poll(10):
                            if pidfd in pidfds:
                                if not pidfd_exited(pidfd):
                                    raise RuntimeError("pidfd poll state")
                                os.close(pidfd)
                                del pidfds[pidfd]
                        if check_membership:
                            reconcile_membership()

                reconcile_membership()
                if not departed:
                    if not send_all(signal.SIGTERM):
                        outcome = "pidfd-signal-failed"
                    else:
                        wait_until(time.monotonic() + term_grace_ms / 1000, True)
                reconcile_membership()
                if not send_all(signal.SIGKILL):
                    outcome = "pidfd-signal-failed"
                wait_until(time.monotonic() + kill_grace_ms / 1000, not departed)
                if pidfds:
                    outcome = "pidfd-timeout"
                elif departed:
                    outcome = "cgroup-departed"
        except TimeoutError:
            outcome = "control-timeout"
        except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
            outcome = "invalid-control"
        except (OSError, RuntimeError):
            outcome = "pidfd-uncertain"

        if pidfds and outcome != "contained":
            contain_open_pidfds(pidfds, kill_grace_ms)

        if trust == "test" and not pidfds and outcome != "identity-mismatch":
            remove_test_cgroup_members(cgroup_path, {int(identity["pid"]) for identity in accepted})

        emit(
            {
                "protocol": PROTOCOL,
                "type": "result",
                "token": token,
                "ok": outcome == "contained",
                "code": outcome,
            }
        )
        try:
            read_control(token, "ack", 2000)
        except (TimeoutError, ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
            raise SystemExit(2) from None
        if trust == "test":
            remove_test_cgroup_members(cgroup_path, {os.getpid()})
        raise SystemExit(0 if outcome == "contained" else 1)
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error):
        stop("invalid-request", token)
    except (OSError, RuntimeError):
        stop("pidfd-uncertain", token)
    finally:
        for pidfd in tuple(pidfds):
            try:
                os.close(pidfd)
            except OSError:
                pass


if __name__ == "__main__":
    main()
