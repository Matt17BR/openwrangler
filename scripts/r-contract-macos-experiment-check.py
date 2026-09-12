"""Temporary macOS consumer qualification; compilation is an external prerequisite."""

import argparse
import hashlib
import json
import os
import platform
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = [
    "run-r-contract-tests.mjs",
    "r-contract-macos-experiment.c",
    "r-contract-macos-experiment.mjs",
    "r-contract-macos-experiment-check.mjs",
    "r-contract-macos-experiment-check.py",
]
CASES = [
    "preflight-refusal",
    "ordinary",
    "deadline",
    "SIGINT",
    "SIGTERM",
    "detached-ignore",
    "output",
    "closed-reader",
    "cli-sigint",
    "missing-helper",
    "unsafe-helper",
    "real-r-quiet",
    "real-r-churn",
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    assert path.stat().st_size <= 65536, "bounded owned receipt"
    return json.loads(path.read_text())


def native_identity(helper, owner, pid):
    # Read only. Never signal fixture PIDs from this controller.
    result = subprocess.run(
        [helper, "inspect", owner, str(pid)],
        capture_output=True,
        check=True,
        timeout=0.25,
    )
    assert len(result.stdout) <= 4096, "bounded known-PID receipt"
    records = json.loads(result.stdout)["records"]
    assert len(records) <= 1
    return records[0] if records else None


def events(root, role):
    path = root / f"{role}-events"
    if not path.exists():
        return []
    assert path.stat().st_size <= 1024
    values = path.read_text().splitlines()
    assert all(value in {"SIGINT", "SIGTERM", "natural-expiry"} for value in values)
    return values


def run_case(node, helper, root, kind, record):
    env = {**os.environ, "OPEN_WRANGLER_EXPERIMENT_CASE_ROOT": str(root), "OPEN_WRANGLER_EXPERIMENT_CASE": kind}
    if kind == "preflight-refusal":
        tampered = root / "tampered-helper"
        data = bytearray(Path(helper).read_bytes())
        data[0] ^= 1
        tampered.write_bytes(data)
        tampered.chmod(0o500)
        env["OPEN_WRANGLER_EXPERIMENT_MACOS_HELPER"] = str(tampered)
    elif kind == "missing-helper":
        env["OPEN_WRANGLER_EXPERIMENT_MACOS_HELPER"] = str(root / "absent-helper")
    elif kind == "unsafe-helper":
        unsafe = root / "unsafe-parent"
        unsafe.mkdir(mode=0o755)
        unsafe.chmod(0o755)
        shutil.copyfile(helper, unsafe / "helper")
        (unsafe / "helper").chmod(0o500)
        env["OPEN_WRANGLER_EXPERIMENT_MACOS_HELPER"] = str(unsafe / "helper")
    command = [node, str(HERE / "r-contract-macos-experiment-check.mjs"), "consumer"]
    if kind == "cli-sigint":
        shim = root / "synthetic-r.mjs"
        fixture_module = json.dumps((HERE / "r-contract-macos-experiment-check.mjs").as_uri())
        shim.write_text(f"#!{node}\nimport {{ fixture }} from {fixture_module};\nfixture();\n")
        shim.chmod(0o700)
        env.update(RSCRIPT=str(shim), R=str(shim))
        command = [node, str(HERE / "run-r-contract-tests.mjs"), "--shard", "frame-foundations"]

    actual_r = kind in {"missing-helper", "unsafe-helper", "real-r-quiet", "real-r-churn"}
    if actual_r:
        command = [node, str(HERE / "run-r-contract-tests.mjs"), "--phase", "kernel:numeric-portability"]
        assert Path(env["R"]).is_absolute() and Path(env["RSCRIPT"]).is_absolute()
    record["stage"] = "launch"
    started = time.monotonic()
    child = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=HERE.parent)
    streams = selectors.DefaultSelector()
    streams.register(child.stdout, selectors.EVENT_READ, "stdout")
    streams.register(child.stderr, selectors.EVENT_READ, "stderr")
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    identities = {}
    registrations = {}
    released = False
    ready_ms = None
    forced = False
    churn = None
    churn_record = {
        "started": False,
        "enteredExecsObservedWhileConsumerAlive": 0,
        "rBodyOverlap": "unknown",
        "nativeScanOverlap": "unknown",
    }
    try:
        record["stage"] = "observe-consumer"
        while child.poll() is None or streams.get_map():
            # Real R retains its 120s phase bound plus 2s/5s cleanup graces; this is the outer guard only.
            assert time.monotonic() - started < (130 if actual_r else 10), "consumer deadline"
            for key, _ in streams.select(0.01):
                data = os.read(key.fileobj.fileno(), 4096)
                if not data:
                    streams.unregister(key.fileobj)
                else:
                    captured[key.data].extend(data)
                    assert len(captured[key.data]) <= 65536, "consumer output bound"
            if kind == "real-r-churn":
                start_seen = (
                    b"[r-contract] START native kernel-agent contract: numeric-portability;" in captured["stdout"]
                )
                pass_seen = b"[r-contract] PASS " in captured["stdout"]
                if churn is None and start_seen and not pass_seen and child.poll() is None:
                    churn_env = {**env, "OPEN_WRANGLER_R_CONTRACT_OWNER": "macos955-unrelated"}
                    churn = subprocess.Popen(
                        [sys.executable, "-B", str(Path(__file__).resolve()), "--churn", str(root), "0", "0"],
                        env=churn_env,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    churn_record.update(started=True, startBeforePassObservation=True)
                state_path = root / "churn-state.json"
                if state_path.exists():
                    state = read_json(state_path)
                    assert state["pid"] == churn.pid and 0 <= state["enteredExecs"] <= 256
                    if child.poll() is None:
                        churn_record["enteredExecsObservedWhileConsumerAlive"] = state["enteredExecs"]
            for role in ["root", "detached", "next"]:
                path = root / f"{role}-ready.json"
                if role not in registrations and path.exists():
                    registration = read_json(path)
                    assert set(registration) == {"pid", "parentPid", "owner"}
                    registrations[role] = registration
                    current = native_identity(helper, registration["owner"], registration["pid"])
                    # Next phase has an independently observed child-close contract.
                    assert current is not None or role == "next"
                    if current is not None:
                        assert current["pid"] == registration["pid"]
                        identities[role] = current
                    if role == "detached":
                        assert os.getpgid(registration["pid"]) == registration["pid"]
                    record["registeredRoles"] = sorted(registrations)
            needed = {"root", "detached"} if kind == "detached-ignore" else {"root"}
            if not released and needed <= registrations.keys():
                ready_ms = (time.monotonic() - started) * 1000
                if kind == "closed-reader":
                    streams.unregister(child.stdout)
                    child.stdout.close()
                (root / "go").write_text("go")
                released = True
                if kind in {"SIGINT", "SIGTERM", "cli-sigint", "detached-ignore"}:
                    name = "SIGINT" if kind == "cli-sigint" else "SIGTERM" if kind == "detached-ignore" else kind
                    child.send_signal(getattr(signal, name))
        code = child.wait(timeout=1)
    finally:
        streams.close()
        if child.poll() is None:
            forced = True
            child.kill()  # Only the unreaped, direct consumer; never a descendant fallback.
            child.wait(timeout=1)
        record["controllerForcedConsumerStop"] = forced
        record["exitCode"] = child.returncode
        record["stdoutBytes"] = len(captured["stdout"])
        record["stderrBytes"] = len(captured["stderr"])
        record["outputFlags"] = {
            label: any(phrase in stream for stream in captured.values())
            for label, phrase in {
                "scanRefused": b"Native scan refused",
                "identityReadRefused": b"Native inspect refused",
                "treeUnverifiable": b"process tree became unverifiable",
                "cleanupFailed": b"cleanup also failed",
                "interrupted": b"INTERRUPTED",
                "missingHelper": b"ENOENT",
                "unsafeHelperParent": b"private helper directory required",
                "unexpectedRWarning": b"Unexpected R warning",
            }.items()
        }
        record["outputFlags"]["stderrPresent"] = bool(captured["stderr"])
        allowed_reasons = {
            "identity-before-unavailable",
            "identity-after-unavailable",
            "unique-identity-changed",
            "exec-version-changed",
            "elapsed-bound",
            "metadata-bound",
            "pid-enumeration",
            "allocation",
            "observation-bound",
            "identity-observation",
            "helper-timeout",
            "helper-missing",
            "helper-access",
            "helper-output-bound",
            "helper-unknown-exit",
            "helper-unknown-launch",
        }
        refusal_reasons = set()
        for stream in captured.values():
            # Read one token; consume a longer suffix so unknown text cannot match an allowed prefix.
            for match in re.finditer(rb"Native (?:scan|inspect|preflight|signal) refused: (\S{0,64})\S*", stream):
                reason = match[1].decode("ascii", errors="replace")
                refusal_reasons.add(reason if reason in allowed_reasons else "other")
        record["nativeRefusalReasons"] = sorted(refusal_reasons)
        if child.stdout and not child.stdout.closed:
            child.stdout.close()
        if child.stderr:
            child.stderr.close()
        # Save completed consumer facts before waiting for this unrelated, independently bounded fixture.
        record["wholeConsumerMs"] = (time.monotonic() - started) * 1000
        if kind == "real-r-churn":
            record["churn"] = churn_record
            if churn is not None:
                forced_churn = False
                try:
                    churn.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    forced_churn = True
                    churn.kill()  # The still-unreaped direct fixture only, never a numeric descendant fallback.
                    churn.wait(timeout=1)
                churn_record.update(exitCode=churn.returncode, controllerForcedStop=forced_churn)
                state_path = root / "churn-state.json"
                if state_path.exists():
                    state = read_json(state_path)
                    assert state["pid"] == churn.pid and 0 <= state["enteredExecs"] <= 256
                    churn_record.update(enteredExecs=state["enteredExecs"], completed=state["completed"])
                churn_record["overlap"] = (
                    "consumer-alive-observed"
                    if churn_record["enteredExecsObservedWhileConsumerAlive"] > 0
                    else "not-observed"
                )
        outcome_path = root / "consumer-result.json"
        if outcome_path.exists():
            record["owner"] = {"entry": "phase-defaults", **read_json(outcome_path)}

    whole_ms = record["wholeConsumerMs"]
    record.update(startupToFixtureReadyMs=ready_ms, wholeConsumerMs=whole_ms, stage="verify-fixture-exit")
    assert not forced
    # Exit observation is immediate at consumer completion, not fixture-expiry polling.
    gone = {
        role: (now := native_identity(helper, registrations[role]["owner"], before["pid"])) is None
        or now["startIdentity"] != before["startIdentity"]
        for role, before in identities.items()
    }
    fixture_events = {role: events(root, role) for role in registrations}
    record.update(ownedIdentitiesGoneAtConsumerExit=gone, fixtureEvents=fixture_events)
    assert all(gone.values()), "consumer returned before owned identities exited"
    assert all("natural-expiry" not in values for values in fixture_events.values()), "expiry is not cleanup"
    if actual_r:
        record["stage"] = "assert-real-command-result"
        lines = captured["stdout"].splitlines()
        starts = sum(line.startswith(b"[r-contract] START ") for line in lines)
        passes = sum(line.startswith(b"[r-contract] PASS ") for line in lines)
        native_pass = b"Native R kernel agent case numeric-portability passed." in lines
        owner = {
            "entry": "actual-r-command",
            "starts": starts,
            "passes": passes,
            "selectedCasePassed": native_pass,
            "settlementReportedByCliPass": passes == 1,
            **record["outputFlags"],
        }
        record["owner"] = owner
        if kind in {"missing-helper", "unsafe-helper"}:
            assert code == 1 and starts == 0 and passes == 0 and not native_pass
            assert owner["missingHelper" if kind == "missing-helper" else "unsafeHelperParent"]
        else:
            assert code == 0 and starts == 1 and passes == 1 and native_pass, "actual selected R CLI did not pass"
            assert not any(record["outputFlags"].values()), "actual R observation or settlement refused"
            if kind == "real-r-churn":
                assert churn_record["started"], "unrelated exec fixture did not start before observed PASS"
                assert churn_record["enteredExecsObservedWhileConsumerAlive"] > 0, "consumer/exec overlap not observed"
                assert churn_record["completed"] and churn_record["exitCode"] == 0
                assert not churn_record["controllerForcedStop"], "controller stop is not unrelated-process protection"
    elif kind == "cli-sigint":
        record["stage"] = "assert-command-result"
        starts = sum(line.startswith(b"[r-contract] START ") for line in captured["stdout"].splitlines())
        record["owner"] = {"entry": "actual-command", "starts": starts, **record["outputFlags"]}
        assert code == 1 and set(registrations) == {"root"}
        assert starts == 1
        assert fixture_events["root"] == ["SIGINT"]
        assert b"INTERRUPTED" in captured["stderr"]
        assert b"cleanup also failed" not in captured["stderr"]
        owner = record["owner"]
    else:
        record["stage"] = "assert-phase-result"
        outcome = read_json(root / "consumer-result.json")
        owner = {"entry": "phase-defaults", **outcome}
        record["owner"] = owner
        assert all(item["closed"] for item in outcome["observations"])
        if kind == "preflight-refusal":
            assert code == 1 and not registrations and not outcome["observations"]
            assert outcome["failure"]["preflight"]
        elif kind == "ordinary":
            assert code == 0 and not outcome["failed"] and len(outcome["observations"]) == 2
        else:
            assert code == 1 and outcome["failed"] and not outcome["failure"]["unsettled"]
            assert len(outcome["observations"]) == (2 if kind == "deadline" else 1)
            if kind == "deadline":
                assert outcome["failure"]["timeout"] and fixture_events["root"] == ["SIGTERM"]
            elif kind in {"SIGINT", "SIGTERM"}:
                assert outcome["failure"]["interrupted"] and fixture_events["root"] == [kind]
            elif kind == "detached-ignore":
                assert outcome["failure"]["interrupted"] and fixture_events["detached"] == ["SIGTERM"]
            else:
                assert outcome["failure"]["outputFailure"] and fixture_events["root"] == ["SIGTERM"]
    record.update(passed=True, stage="complete", owner=owner)


def churn():
    # Only this controller-owned process execs; it has no R phase marker or R CLI ancestor.
    root = Path(sys.argv[2])
    count = int(sys.argv[3])
    started = int(sys.argv[4]) or time.monotonic_ns()
    assert root.is_absolute() and root.is_dir() and 0 <= count <= 256
    done = count >= 256 or time.monotonic_ns() - started >= 5_000_000_000
    state = {"pid": os.getpid(), "enteredExecs": count, "completed": done}
    temporary = root / "churn-state.tmp"
    temporary.write_text(json.dumps(state))
    temporary.replace(root / "churn-state.json")
    if not done:
        os.execv(
            sys.executable,
            [sys.executable, "-B", str(Path(__file__).resolve()), "--churn", str(root), str(count + 1), str(started)],
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    assert sys.platform == "darwin", "hosted macOS experiment only"
    assert Path(args.node).is_absolute() and Path(args.node).is_file()
    parent = Path(os.environ["OPEN_WRANGLER_EXPERIMENT_MACOS_ROOT"])
    assert parent.is_absolute() and parent.resolve() == parent
    parent_stat = parent.stat()
    assert parent_stat.st_uid == os.getuid() and parent_stat.st_mode & 0o077 == 0
    helper = os.environ["OPEN_WRANGLER_EXPERIMENT_MACOS_HELPER"]
    assert digest(Path(helper)) == os.environ["OPEN_WRANGLER_EXPERIMENT_MACOS_HELPER_SHA256"]
    assert digest(HERE / "r-contract-macos-experiment.c") == os.environ["OPEN_WRANGLER_EXPERIMENT_MACOS_SOURCE_SHA256"]
    helper_identity = Path(helper).stat()
    helper_parent_identity = Path(helper).parent.stat()
    r_preparation = read_json(parent / "r-preparation.json")
    assert r_preparation["privatePackageProbeMatched"] is True
    assert os.environ["R"] == r_preparation["selectedExecutables"]["r"]
    assert os.environ["RSCRIPT"] == r_preparation["selectedExecutables"]["rscript"]
    original = {name: digest(HERE / name) for name in FILES}
    node_version = subprocess.check_output([args.node, "--version"], timeout=5).decode().strip()
    assert len(node_version) < 32 and node_version.startswith("v24.")
    report = {
        "platform": sys.platform,
        "osVersion": platform.mac_ver()[0],
        "architecture": platform.machine(),
        "pythonVersion": platform.python_version(),
        "nodeVersion": node_version,
        "sourceSha256": original,
        "binarySha256": digest(Path(helper)),
        "checkout": os.environ["GITHUB_SHA"],
        "rPreparation": {
            key: r_preparation[key]
            for key in ["runtime", "selectedExecutables", "packages", "privatePackageProbeMatched"]
        },
        "cases": [],
        "scope": (
            "Explicit prepared-helper admission and real selected R CLI availability on one host; "
            "no compiler-tree, real-R interruption, abrupt-death or broader macOS qualification."
        ),
        "timingScope": (
            "Fresh consumer startup and whole invocation exclude compilation. "
            "Phase consumers report Node-only CPU and peak RSS in KiB, excluding helpers. "
            "The actual-command case reports only outer wall/readiness; no tree RSS claim."
        ),
    }
    root = Path(tempfile.mkdtemp(prefix="cli-consumer-", dir=parent))
    root.chmod(0o700)
    identity = root.stat()
    success = False
    kind = "before-first-case"
    record = {"stage": "setup"}
    try:
        for kind in CASES:
            case_root = root / kind
            case_root.mkdir(mode=0o700)
            record = {"kind": kind, "passed": False, "stage": "setup"}
            report["cases"].append(record)
            run_case(args.node, helper, case_root, kind, record)
        success = True
    except Exception as error:
        report["failure"] = {"case": kind, "type": type(error).__name__, "stage": record["stage"]}
        if isinstance(error, AssertionError):
            report["failure"]["assertion"] = str(error)[:240]
    finally:
        report["passed"] = success
        try:
            report["sourcesUnchanged"] = original == {name: digest(HERE / name) for name in FILES}
            report["preparedHelperUnchanged"] = report["binarySha256"] == digest(Path(helper))
            for path, expected in [(Path(helper), helper_identity), (Path(helper).parent, helper_parent_identity)]:
                actual = path.lstat()
                report["preparedHelperUnchanged"] &= (actual.st_dev, actual.st_ino, actual.st_uid, actual.st_mode) == (
                    expected.st_dev,
                    expected.st_ino,
                    expected.st_uid,
                    expected.st_mode,
                )
            assert report["sourcesUnchanged"] and report["preparedHelperUnchanged"]
            if success:
                current = root.stat()
                assert (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino)
                shutil.rmtree(root)
        except Exception as error:
            success = False
            report["passed"] = False
            report["cleanupFailure"] = {"type": type(error).__name__}
        finally:
            report["consumerPrivateRootRemoved"] = success and not root.exists()
            report["compilerTreeQualified"] = False
            text = json.dumps(report, indent=2) + "\n"
            assert len(text.encode()) <= 65536, "bounded final receipt"
            Path(args.output).write_text(text)
    return 0 if success else 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--churn":
        churn()
    else:
        sys.exit(main())
