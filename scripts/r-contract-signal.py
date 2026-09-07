"""Signal an observed Linux test process only through a verified pidfd."""

import json
import os
import re
import select
import signal
import sys

MAX_INPUT_BYTES = 64 * 1024
MAX_TARGETS = 256
MAX_PROCESS_BYTES = 256 * 1024
OWNER_KEY = b"OPEN_WRANGLER_R_CONTRACT_OWNER="
SIGNALS = {name: getattr(signal, name) for name in ("SIGINT", "SIGTERM", "SIGKILL")}


def read_bounded(path):
    with open(path, "rb") as source:
        data = source.read(MAX_PROCESS_BYTES + 1)
    if len(data) > MAX_PROCESS_BYTES:
        raise ValueError("process metadata exceeds its bound")
    return data


def exited(pidfd):
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    events = poller.poll(0)
    if any(flags & (select.POLLERR | select.POLLNVAL) for _, flags in events):
        raise ValueError("pidfd liveness could not be verified")
    return bool(events)


def signal_verified_process(target, owner, requested_signal):
    pidfd = None
    try:
        pid = target["pid"]
        pidfd = os.pidfd_open(pid)
        stat = read_bounded(f"/proc/{pid}/stat")
        close = stat.rfind(b")")
        fields = stat[close + 2 :].split()
        if close < 0 or len(fields) < 20 or not fields[19].isdigit():
            raise ValueError("process start identity is malformed")
        if fields[0] == b"Z" or fields[19].decode("ascii") != target["startIdentity"]:
            return
        environment = read_bounded(f"/proc/{pid}/environ").split(b"\0")
        marked = [entry for entry in environment if entry.startswith(OWNER_KEY)] == [OWNER_KEY + owner.encode("ascii")]
        # A reused PID cannot substitute another process's stat/environment for
        # an exited pidfd target: check the opened identity after both reads.
        if exited(pidfd):
            return
        if not marked:
            raise ValueError("live process has no exact phase owner marker")
        signal.pidfd_send_signal(pidfd, requested_signal)
    except FileNotFoundError:
        if pidfd is not None and exited(pidfd):
            return
        raise ValueError("live process metadata is unavailable") from None
    except ProcessLookupError:
        return
    finally:
        if pidfd is not None:
            os.close(pidfd)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate request field")
        result[key] = value
    return result


def read_request():
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("signal request exceeds its byte bound")
    request = json.loads(data.decode("utf8"), object_pairs_hook=unique_object)
    if not isinstance(request, dict) or set(request) != {"ownerToken", "signal", "targets"}:
        raise ValueError("invalid signal request")
    owner = request["ownerToken"]
    if not isinstance(owner, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", owner):
        raise ValueError("invalid phase owner marker")
    if not isinstance(request["signal"], str) or request["signal"] not in SIGNALS:
        raise ValueError("invalid signal")
    targets = request["targets"]
    if not isinstance(targets, list) or not 1 <= len(targets) <= MAX_TARGETS:
        raise ValueError("invalid signal target count")
    seen = set()
    for target in targets:
        if not isinstance(target, dict) or set(target) != {"pid", "startIdentity"}:
            raise ValueError("invalid signal target")
        pid = target["pid"]
        identity = target["startIdentity"]
        if type(pid) is not int or not 0 < pid < 2**31 or pid in seen:
            raise ValueError("invalid or duplicate process ID")
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9]{1,20}", identity):
            raise ValueError("invalid process start identity")
        seen.add(pid)
    return request


def main():
    if sys.platform != "linux" or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise ValueError("Linux R contract supervision requires Python with pidfd support")
    if sys.argv[1:] == ["--probe"]:
        pidfd = os.pidfd_open(os.getpid())
        try:
            signal.pidfd_send_signal(pidfd, 0)
        finally:
            os.close(pidfd)
        return 0
    if len(sys.argv) != 1:
        raise ValueError("invalid signal helper arguments")
    request = read_request()
    failures = 0
    first_failure = ""
    for target in request["targets"]:
        try:
            signal_verified_process(target, request["ownerToken"], SIGNALS[request["signal"]])
        except (OSError, ValueError) as error:
            failures += 1
            if not first_failure:
                detail = str(error) if isinstance(error, ValueError) else type(error).__name__
                first_failure = f"process {target['pid']}: {detail}"
    if failures:
        print(f"Linux R cleanup refused {failures} unverifiable target(s); {first_failure}.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        detail = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(f"Linux R process signaling failed: {detail}.", file=sys.stderr)
        raise SystemExit(1) from None
