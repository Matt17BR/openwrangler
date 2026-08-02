import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const SUPERVISOR_PROTOCOL = "openwrangler-linux-study-supervisor-v1";
const SUPERVISOR_PATH = resolve("scripts/linux-study-supervisor.py");
const LOCAL_PYTHON_312 = join(homedir(), ".local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12");
const PYTHON =
  process.env.OPEN_WRANGLER_STUDY_PYTHON ?? (existsSync(LOCAL_PYTHON_312) ? LOCAL_PYTHON_312 : "python3.12");
const ERROR_PREFIX = "OPEN_WRANGLER_LINUX_SUPERVISOR_ERROR:";
const MAXIMUM_RECEIPT_BYTES = 32 * 1024;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function environmentReceipt(environment) {
  return Object.entries(environment)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, value])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function filesystemIdentity(path) {
  const value = statSync(path, { bigint: true });
  return {
    device: value.dev.toString(),
    inode: value.ino.toString(),
    sizeBytes: Number(value.size),
    mtimeNs: value.mtimeNs.toString()
  };
}

function readProcStat(pid) {
  let text;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error.code === "ENOENT" || error.code === "ESRCH")) {
      return null;
    }
    throw error;
  }
  const closingParenthesis = text.lastIndexOf(")");
  assert.ok(closingParenthesis > 0, `malformed proc stat for PID ${pid}`);
  const fields = text
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/u);
  assert.ok(fields.length >= 20, `short proc stat for PID ${pid}`);
  return {
    pid,
    state: fields[0],
    parentPid: Number.parseInt(fields[1], 10),
    processGroupId: Number.parseInt(fields[2], 10),
    sessionId: Number.parseInt(fields[3], 10),
    startTimeTicks: fields[19]
  };
}

async function waitUntil(probe, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (lastError) throw lastError;
  assert.fail(`Timed out waiting for ${label}.`);
}

function createBoundedFrameReader(stream, maximumBytes = MAXIMUM_RECEIPT_BYTES) {
  stream.setEncoding("utf8");
  let buffered = "";
  let ended = false;
  let failure;
  let frameCount = 0;
  const queued = [];
  const waiters = [];
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolvePromise, rejectPromise) => {
    resolveDone = resolvePromise;
    rejectDone = rejectPromise;
  });
  void done.catch(() => {});
  const fail = (error) => {
    if (failure) return;
    failure = error;
    rejectDone(error);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  const publish = (frame) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else queued.push(frame);
  };
  stream.on("data", (chunk) => {
    if (failure) return;
    try {
      buffered += chunk;
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const frame = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        assert.ok(Buffer.byteLength(frame, "utf8") <= maximumBytes, "supervisor receipt exceeded bound");
        frameCount += 1;
        assert.ok(frameCount <= 2, "supervisor emitted more than two receipt frames");
        publish(frame);
      }
      assert.ok(Buffer.byteLength(buffered, "utf8") <= maximumBytes, "supervisor receipt exceeded bound");
    } catch (error) {
      fail(error);
    }
  });
  stream.once("error", fail);
  stream.once("end", () => {
    ended = true;
    if (failure) return;
    try {
      assert.equal(buffered, "", "supervisor ended with an unterminated receipt frame");
      assert.equal(frameCount, 2, "supervisor must emit launch and terminal receipt frames");
      resolveDone();
      for (const waiter of waiters.splice(0)) waiter.reject(new Error("Supervisor receipt stream ended."));
    } catch (error) {
      fail(error);
    }
  });
  return {
    done,
    nextFrame() {
      if (failure) return Promise.reject(failure);
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (ended) return Promise.reject(new Error("Supervisor receipt stream ended."));
      return new Promise((resolvePromise, rejectPromise) => {
        waiters.push({ resolve: resolvePromise, reject: rejectPromise });
      });
    }
  };
}

function terminateMatchingProcess(identity, signum = "SIGKILL") {
  if (!identity) return;
  const observed = readProcStat(identity.pid);
  if (observed?.startTimeTicks !== identity.startTimeTicks) return;
  try {
    process.kill(identity.pid, signum);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ESRCH")) throw error;
  }
}

test(
  "Linux study supervisor rejects any non-canonical invocation before launch",
  { skip: process.platform !== "linux" },
  () => {
    const result = spawnSync(PYTHON, [SUPERVISOR_PATH, "--unknown"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"]
    });
    assert.equal(result.status, 125);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, `${ERROR_PREFIX}protocol\n`);

    const digestMismatch = spawnSync(
      PYTHON,
      [
        SUPERVISOR_PATH,
        "--protocol",
        SUPERVISOR_PROTOCOL,
        "--nonce",
        "1".repeat(64),
        "--receipt-fd",
        "3",
        "--payload-environment-sha256",
        "0".repeat(64),
        "--",
        "/bin/true"
      ],
      { encoding: "utf8", stdio: ["ignore", "ignore", "pipe", "pipe"] }
    );
    assert.equal(digestMismatch.status, 125);
    assert.equal(digestMismatch.signal, null);
    assert.equal(digestMismatch.stderr, `${ERROR_PREFIX}environment-digest\n`);
    assert.equal(digestMismatch.output[3].length, 0);
  }
);

test(
  "Linux study supervisor retains sequential PID generations and cleans the current replacement",
  { skip: process.platform !== "linux" },
  () => {
    const result = spawnSync(
      PYTHON,
      [
        "-c",
        [
          "import importlib.util",
          "import os",
          "import signal",
          "import sys",
          "spec = importlib.util.spec_from_file_location('ow_supervisor', sys.argv[1])",
          "module = importlib.util.module_from_spec(spec)",
          "sys.modules[spec.name] = module",
          "spec.loader.exec_module(module)",
          "supervisor = module.ProcessIdentity(os.getpid(), os.getppid(), os.getpgrp(), os.getsid(0), 'R', '100')",
          "pid = 999999",
          "old = module.ProcessIdentity(pid, supervisor.pid, pid, pid, 'S', '200')",
          "replacement = module.ProcessIdentity(pid, supervisor.pid, pid, pid, 'S', '201')",
          "second = module.ProcessIdentity(pid, supervisor.pid, pid, pid, 'S', '202')",
          "current = [replacement]",
          "def census():",
          "    return {supervisor.pid: supervisor, **({current[0].pid: current[0]} if current else {})}",
          "module._proc_census = census",
          "retained = {(supervisor.pid, supervisor.start_time_ticks): supervisor, (old.pid, old.start_time_ticks): old}",
          "events = []",
          "module._refresh_owned(supervisor, retained, events)",
          "module._refresh_owned(supervisor, retained, events)",
          "assert len(events) == 1",
          "current[0] = second",
          "module._refresh_owned(supervisor, retained, events)",
          "assert [(event.previous_start_time_ticks, event.replacement_start_time_ticks) for event in events] == [('200', '201'), ('201', '202')]",
          "assert set(retained) == {(supervisor.pid, '100'), (pid, '200'), (pid, '201'), (pid, '202')}",
          "signaled = []",
          "def signal_identity(identity, signum):",
          "    signaled.append((identity.pid, identity.start_time_ticks, signum))",
          "    current.clear()",
          "    return True",
          "module._signal_identity = signal_identity",
          "module._reap_available = lambda _pid, code: code",
          "module.time.sleep = lambda _seconds: None",
          "module._terminate_owned_tree(supervisor, pid, 0, retained, events, set())",
          "assert signaled == [(pid, '202', signal.SIGTERM)]",
          "_, checks = module._prove_empty_owned_tree(supervisor, pid, 0, retained, events)",
          "assert len(checks) == 3 and all(check['ownedProcessCount'] == 0 for check in checks)"
        ].join("\n"),
        SUPERVISOR_PATH
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
);

test(
  "Linux study supervisor receipts, adopts, reaps, and terminates the real payload tree",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "ow-linux-supervisor-"));
    chmodSync(privateRoot, 0o700);
    const statePath = join(privateRoot, "payload-state.json");
    const payloadPath = join(privateRoot, "payload.py");
    writeFileSync(
      payloadPath,
      [
        "import json",
        "import os",
        "import subprocess",
        "import sys",
        "import threading",
        "import time",
        "",
        "if len(sys.argv) == 2 and sys.argv[1] == '--sleep-child':",
        "    while True:",
        "        time.sleep(1)",
        "if len(sys.argv) == 2 and sys.argv[1] == '--ephemeral-child':",
        "    time.sleep(0.5)",
        "    raise SystemExit(0)",
        "",
        "state_path = sys.argv[1]",
        "read_fd, write_fd = os.pipe()",
        "first = os.fork()",
        "if first == 0:",
        "    os.close(read_fd)",
        "    os.setsid()",
        "    second = os.fork()",
        "    if second != 0:",
        "        os._exit(0)",
        "    os.write(write_fd, f'{os.getpid()}\\n'.encode('ascii'))",
        "    os.close(write_fd)",
        "    while True:",
        "        time.sleep(1)",
        "os.close(write_fd)",
        "daemon_pid = int(os.read(read_fd, 64).decode('ascii').strip())",
        "os.close(read_fd)",
        "os.waitpid(first, 0)",
        "thread_result = []",
        "def spawn_from_thread():",
        "    thread_result.append(subprocess.Popen([sys.executable, __file__, '--sleep-child'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).pid)",
        "worker = threading.Thread(target=spawn_from_thread)",
        "worker.start()",
        "worker.join()",
        "ephemeral = subprocess.Popen([sys.executable, __file__, '--ephemeral-child'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
        "ephemeral_waiter = threading.Thread(target=ephemeral.wait, daemon=True)",
        "ephemeral_waiter.start()",
        "temporary = state_path + '.tmp'",
        "with open(temporary, 'w', encoding='utf-8') as output:",
        "    json.dump({'rootPid': os.getpid(), 'daemonPid': daemon_pid, 'threadedPid': thread_result[0], 'ephemeralPid': ephemeral.pid}, output, separators=(',', ':'))",
        "    output.flush()",
        "    os.fsync(output.fileno())",
        "os.replace(temporary, state_path)",
        "while True:",
        "    time.sleep(1)",
        ""
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 }
    );

    const environment = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
    const environmentSha256 = sha256Json(environmentReceipt(environment));
    const nonce = sha256Bytes(Buffer.from(`${process.pid}:${privateRoot}`, "utf8"));
    const payloadArgv = [PYTHON, payloadPath, statePath];
    const payloadArgvSha256 = sha256Json(payloadArgv);
    const invocationPolicySha256 = sha256Json({
      argvGrammar: ["--protocol", "--nonce", "--receipt-fd", "--payload-environment-sha256", "--", "payload-argv"],
      ownership: {
        census: "full-numeric-proc-stat-ppid",
        historyIdentity: "pid-start-time-ticks",
        pidReuse: "latch-invalid-clean-replacement",
        subreaper: true
      },
      payloadLaunch: { closeFds: true, spawnCount: 1, startNewSession: true },
      protocol: SUPERVISOR_PROTOCOL,
      python: { implementation: "CPython", major: 3, minor: 12 },
      signaling: {
        api: "libc-pidfd-symbols",
        identity: "pid-start-time-ticks",
        pidfdRequired: true
      },
      subreaper: { get: 37, set: 36, verifiedValue: 1 },
      version: 1
    });
    const invocationSha256 = sha256Json({
      nonce,
      payloadArgvSha256,
      payloadEnvironmentSha256: environmentSha256,
      policySha256: invocationPolicySha256,
      protocol: SUPERVISOR_PROTOCOL,
      receiptFd: 3
    });

    const supervisor = spawn(
      PYTHON,
      [
        SUPERVISOR_PATH,
        "--protocol",
        SUPERVISOR_PROTOCOL,
        "--nonce",
        nonce,
        "--receipt-fd",
        "3",
        "--payload-environment-sha256",
        environmentSha256,
        "--",
        ...payloadArgv
      ],
      {
        env: environment,
        stdio: ["ignore", "ignore", "pipe", "pipe"]
      }
    );
    const closePromise = once(supervisor, "close");
    const receiptReader = createBoundedFrameReader(supervisor.stdio[3]);
    let stderr = "";
    supervisor.stderr.setEncoding("utf8");
    supervisor.stderr.on("data", (chunk) => {
      stderr += chunk;
      assert.ok(Buffer.byteLength(stderr, "utf8") <= 4096, "supervisor stderr exceeded bound");
    });
    let receipt;
    let identities = [];
    try {
      receipt = JSON.parse(await receiptReader.nextFrame());
      assert.deepEqual(Object.keys(receipt).sort(), [
        "editorRoot",
        "invocationPolicySha256",
        "invocationSha256",
        "kind",
        "nonce",
        "payloadArgvSha256",
        "payloadEnvironmentSha256",
        "protocol",
        "pythonExecutable",
        "supervisor",
        "supervisorSource"
      ]);
      assert.equal(receipt.protocol, SUPERVISOR_PROTOCOL);
      assert.equal(receipt.kind, "launch");
      assert.equal(receipt.nonce, nonce);
      assert.equal(receipt.supervisor.pid, supervisor.pid);
      assert.equal(receipt.supervisor.subreaperVerified, true);
      assert.equal(receipt.supervisor.pidfdVerified, true);
      assert.equal(receipt.invocationPolicySha256, invocationPolicySha256);
      assert.equal(receipt.invocationSha256, invocationSha256);
      assert.equal(receipt.payloadArgvSha256, payloadArgvSha256);
      assert.equal(receipt.payloadEnvironmentSha256, environmentSha256);
      assert.deepEqual(receipt.supervisorSource, {
        sha256: sha256Bytes(readFileSync(SUPERVISOR_PATH)),
        filesystemIdentity: filesystemIdentity(SUPERVISOR_PATH)
      });
      assert.equal(receipt.pythonExecutable.implementation, "CPython");
      assert.match(receipt.pythonExecutable.version, /^3\.12\./u);
      assert.match(receipt.pythonExecutable.sha256, /^[0-9a-f]{64}$/u);
      const pythonExecutablePath = readlinkSync(`/proc/${receipt.supervisor.pid}/exe`);
      assert.deepEqual(receipt.pythonExecutable.filesystemIdentity, filesystemIdentity(pythonExecutablePath));
      assert.equal(receipt.pythonExecutable.sha256, sha256Bytes(readFileSync(pythonExecutablePath)));

      const supervisorStat = readProcStat(receipt.supervisor.pid);
      assert.equal(supervisorStat?.startTimeTicks, receipt.supervisor.startTimeTicks);
      const editorStat = readProcStat(receipt.editorRoot.pid);
      assert.deepEqual(
        {
          parentPid: editorStat?.parentPid,
          startTimeTicks: editorStat?.startTimeTicks,
          processGroupId: editorStat?.processGroupId,
          sessionId: editorStat?.sessionId
        },
        {
          parentPid: receipt.supervisor.pid,
          startTimeTicks: receipt.editorRoot.startTimeTicks,
          processGroupId: receipt.editorRoot.pid,
          sessionId: receipt.editorRoot.pid
        }
      );
      assert.equal(receipt.editorRoot.processGroupId, receipt.editorRoot.pid);
      assert.equal(receipt.editorRoot.sessionId, receipt.editorRoot.pid);

      const payloadState = await waitUntil(() => {
        try {
          return JSON.parse(readFileSync(statePath, "utf8"));
        } catch (error) {
          if (error && typeof error === "object" && error.code === "ENOENT") return null;
          throw error;
        }
      }, "payload state");
      assert.equal(payloadState.rootPid, receipt.editorRoot.pid);

      const adoptedDaemon = await waitUntil(() => {
        const value = readProcStat(payloadState.daemonPid);
        return value?.parentPid === receipt.supervisor.pid ? value : null;
      }, "double-forked daemon adoption");
      const threadedChild = await waitUntil(() => {
        const value = readProcStat(payloadState.threadedPid);
        return value?.parentPid === receipt.editorRoot.pid ? value : null;
      }, "thread-created child");
      const ephemeralChild = await waitUntil(() => {
        const value = readProcStat(payloadState.ephemeralPid);
        return value?.parentPid === receipt.editorRoot.pid ? value : null;
      }, "ephemeral child");
      identities = [
        { pid: receipt.editorRoot.pid, startTimeTicks: receipt.editorRoot.startTimeTicks },
        adoptedDaemon,
        threadedChild,
        ephemeralChild
      ];
      await waitUntil(() => readProcStat(ephemeralChild.pid) === null, "ephemeral child exit", 3_000);

      supervisor.kill("SIGTERM");
      const [terminalLine, [code, closeSignal]] = await Promise.all([receiptReader.nextFrame(), closePromise]);
      const terminal = JSON.parse(terminalLine);
      await receiptReader.done;
      assert.equal(code, 128 + 15);
      assert.equal(closeSignal, null);
      assert.equal(stderr, "");
      assert.deepEqual(Object.keys(terminal).sort(), [
        "editorRoot",
        "emptyCensusProof",
        "identityReuseEvents",
        "kind",
        "nonce",
        "protocol",
        "retainedOwnedIdentities",
        "supervisor",
        "supervisorExitCode"
      ]);
      assert.equal(terminal.protocol, SUPERVISOR_PROTOCOL);
      assert.equal(terminal.kind, "terminal-cleanup");
      assert.equal(terminal.nonce, nonce);
      assert.deepEqual(terminal.supervisor, {
        pid: receipt.supervisor.pid,
        startTimeTicks: receipt.supervisor.startTimeTicks
      });
      assert.deepEqual(terminal.editorRoot, {
        pid: receipt.editorRoot.pid,
        startTimeTicks: receipt.editorRoot.startTimeTicks
      });
      assert.equal(terminal.supervisorExitCode, code);
      assert.deepEqual(terminal.identityReuseEvents, []);
      assert.equal(terminal.emptyCensusProof.requiredConsecutiveChecks, 3);
      assert.equal(terminal.emptyCensusProof.checks.length, 3);
      let previousCheck = -1n;
      for (const check of terminal.emptyCensusProof.checks) {
        assert.deepEqual(Object.keys(check).sort(), ["monotonicNanoseconds", "ownedProcessCount"]);
        assert.equal(check.ownedProcessCount, 0);
        assert.match(check.monotonicNanoseconds, /^[1-9]\d*$/u);
        assert.ok(BigInt(check.monotonicNanoseconds) > previousCheck);
        previousCheck = BigInt(check.monotonicNanoseconds);
      }
      const terminalIdentityKeys = new Set();
      for (const identity of terminal.retainedOwnedIdentities) {
        assert.deepEqual(Object.keys(identity).sort(), ["disposition", "pid", "startTimeTicks"]);
        assert.match(identity.disposition, /^(?:exited|terminated)$/u);
        const key = `${identity.pid}:${identity.startTimeTicks}`;
        assert.equal(terminalIdentityKeys.has(key), false);
        terminalIdentityKeys.add(key);
      }
      for (const identity of identities) {
        assert.equal(
          terminalIdentityKeys.has(`${identity.pid}:${identity.startTimeTicks}`),
          true,
          `terminal receipt omitted retained PID ${identity.pid}`
        );
      }
      const terminalEphemeral = terminal.retainedOwnedIdentities.find(
        (identity) => identity.pid === ephemeralChild.pid && identity.startTimeTicks === ephemeralChild.startTimeTicks
      );
      assert.equal(terminalEphemeral?.disposition, "exited");
      identities = terminal.retainedOwnedIdentities;
      for (const identity of identities) {
        await waitUntil(() => readProcStat(identity.pid) === null, `cleanup of PID ${identity.pid}`, 5_000);
      }
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGTERM");
        await Promise.race([closePromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))]);
      }
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
      for (const identity of identities) terminateMatchingProcess(identity);
      rmSync(privateRoot, { recursive: true, force: true });
    }
  }
);
