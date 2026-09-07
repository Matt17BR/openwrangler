import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLinuxProcessSignaler, runRContractPhase } from "./run-r-contract-tests.mjs";
import { resolveAcceptancePython } from "./packaged-python-preflight.mjs";

const runner = new URL("./run-r-contract-tests.mjs", import.meta.url).href;

function identityOf(child) {
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  return { pid: child.pid, startIdentity: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/u)[19] };
}

function cancellationProbe(kind) {
  const program = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { readFileSync } from 'node:fs';
    const processGroupOf = pid => Number(readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[2]);
    import { runRContractPhasesWithSignalForwarding } from ${JSON.stringify(runner)};
    const kind = ${JSON.stringify(kind)};
    const output = [];
    let child;
    let exit;
    let triggered = false;
    let identityUnreadable = false;
    const readIdentity = pid => {
      if (identityUnreadable) throw new Error('owned process stat became unreadable');
      try {
        const contents = readFileSync('/proc/' + pid + '/stat', 'utf8');
        const fields = contents.slice(contents.lastIndexOf(')') + 2).trim().split(/\\s+/u);
        return {pid, parentPid:Number(fields[1]), groupId:Number(fields[2]), state:fields[0], startIdentity:fields[19], identityResolution:'kernel-start-tick'};
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
    };
    let startedNext = false;
    let spawnedAt;
    let detachedPid;
    const descendantCode = "process.on('SIGTERM', () => { console.log('DETACHED_SIGTERM'); process.exit(0); }); console.log('DETACHED_READY:' + process.pid); setTimeout(() => process.exit(0), 4000);";
    const childCode = [
      ...(kind === 'detached' ? ["require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(descendantCode) + "], {detached:true, stdio:'inherit'}).unref();"] : []),
      "process.on('SIGINT', () => { console.log('RECEIVED:SIGINT'); if (!" + JSON.stringify(kind === 'ignoring' || kind === 'unverifiable') + ") process.exit(0); });",
      "process.on('SIGTERM', () => { console.log('RECEIVED:SIGTERM'); if (!" + JSON.stringify(kind === 'ignoring' || kind === 'unverifiable') + ") process.exit(0); });",
      "console.log('READY');",
      "setTimeout(() => { console.log('NATURAL_EXIT'); process.exit(0); }, 4000);",
      ...(kind === 'output' ? ["setTimeout(() => process.stdout.write('x'.repeat(500)), 80);"] : [])
    ].join('\\n');
    const phases = [{ id: 'fixture', label: 'owned cancellation fixture', command: process.execPath,
      args: ['-e', childCode], environment: process.env,
      timeoutMs: kind === 'timeout' || kind === 'ignoring' ? 300 : 6000 },
      { id: 'next', label: 'must not start after interruption', command: process.execPath,
        args: ['-e', 'process.exit(0)'], environment: process.env, timeoutMs: 1000 }];
    let failure;
    try {
      await runRContractPhasesWithSignalForwarding(phases, {
        ...(kind === 'output' ? {maximumOutputBytes: 100} : {}),
        ...(kind === 'unverifiable' ? {readProcessIdentity: readIdentity} : {}),
        spawnProcess: (...args) => {
          if (child) { startedNext = true; return spawn(...args); }
          spawnedAt = performance.now();
          child = spawn(...args);
          exit = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal, elapsed:performance.now()-spawnedAt})));
          return child;
        },
        writeLine: () => {},
        writeError: chunk => output.push(String(chunk)),
        writeOutput: chunk => {
          output.push(String(chunk));
          if (kind === 'unverifiable' && output.join('').includes('READY')) identityUnreadable = true;
          if (kind === 'detached') {
            const match = /DETACHED_READY:([0-9]+)/u.exec(output.join(''));
            if (match) detachedPid = Number(match[1]);
          }
          if (!triggered && (kind === 'detached' ? detachedPid : output.join('').includes('READY') && kind.startsWith('SIG'))) {
            triggered = true;
            if (detachedPid) {
              const stat = (processGroupOf)(detachedPid);
              assert.equal(stat, detachedPid, 'the descendant owns a different process group');
              assert.notEqual(detachedPid, child.pid);
            }
            process.kill(process.pid, kind === 'detached' ? 'SIGTERM' : kind);
          }
        }
      });
    } catch (error) { failure = error; }
    const state = await exit;
    const messages = error => [error?.message, ...(error?.errors ?? []).flatMap(messages)].filter(Boolean);
    const details = messages(failure).join('\\n');
    assert.ok(failure, 'the interrupted/timed-out phase must fail');
    assert.doesNotMatch(details, /no OS-held signal identity/);
    if (kind === 'unverifiable') assert.match(details, /cleanup also failed:.*stat became unreadable/);
    else assert.doesNotMatch(details, /cleanup also failed/);
    assert.doesNotMatch(output.join(''), /NATURAL_EXIT/);
    assert.ok(state.elapsed < 3500, 'cancellation must settle before the child natural-exit timer');
    if (kind === 'ignoring' || kind === 'unverifiable') assert.equal(state.signal, 'SIGKILL');
    else if (kind === 'output') assert.equal(state.code, 0);
    else assert.match(output.join(''), kind.startsWith('SIG') ? new RegExp('RECEIVED:' + kind) : /RECEIVED:SIGTERM/);
    if (kind === 'detached') assert.match(output.join(''), /DETACHED_SIGTERM/);
    if (kind.startsWith('SIG') || kind === 'output' || kind === 'detached' || kind === 'unverifiable') assert.equal(startedNext, false);
    else assert.equal(startedNext, true, 'a settled timeout can proceed to the next selected phase');
    console.log('verified ' + kind);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    env: process.env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 128 * 1024
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`verified ${kind}`));
}

test(
  "Linux runner defaults terminate owned work on signals, deadlines and excessive output",
  {
    skip: process.platform !== "linux"
  },
  async (context) => {
    for (const kind of ["SIGINT", "SIGTERM", "timeout", "ignoring", "output", "detached", "unverifiable"]) {
      await context.test(kind, () => cancellationProbe(kind));
    }
  }
);

test(
  "Linux signaling rejects an unmarked target while still stopping a marked descendant in the same batch",
  {
    skip: process.platform !== "linux"
  },
  async () => {
    const signalProcesses = createLinuxProcessSignaler();
    const owner = randomUUID();
    const children = [false, true].map((marked) => {
      const environment = { ...process.env };
      delete environment.OPEN_WRANGLER_R_CONTRACT_OWNER;
      if (marked) environment.OPEN_WRANGLER_R_CONTRACT_OWNER = owner;
      const child = spawn(process.execPath, ["-e", "console.log('READY'); setTimeout(() => {}, 1200)"], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
      return { child, ready: once(child.stdout, "data"), closed: once(child, "close") };
    });
    await Promise.all(children.map(({ ready }) => ready));
    const targets = children.map(({ child }) => identityOf(child));
    let failure;
    try {
      signalProcesses(targets, owner, "SIGTERM");
    } catch (error) {
      failure = error;
    }
    const unmarkedStillLive = children[0].child.exitCode === null && children[0].child.signalCode === null;
    const outcomes = await Promise.all(children.map(({ closed }) => closed));
    assert.match(failure?.message ?? "", /live process has no exact phase owner marker/);
    assert.ok(unmarkedStillLive);
    assert.deepEqual(outcomes, [
      [0, null],
      [null, "SIGTERM"]
    ]);
  }
);

test(
  "Linux signaling leaves a replaced start identity or foreign phase untouched",
  {
    skip: process.platform !== "linux"
  },
  async () => {
    const signalProcesses = createLinuxProcessSignaler();
    const owner = randomUUID();
    const child = spawn(process.execPath, ["-e", "console.log('READY'); setTimeout(() => {}, 700)"], {
      env: { ...process.env, OPEN_WRANGLER_R_CONTRACT_OWNER: owner },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const closed = once(child, "close");
    await once(child.stdout, "data");
    const identity = identityOf(child);
    assert.throws(() => signalProcesses([identity, identity], owner, "SIGKILL"), /duplicate process ID/);
    assert.throws(() => signalProcesses([identity], owner, "SIGUSR1"), /invalid signal/);
    assert.throws(() => signalProcesses(Array(257).fill(identity), owner, "SIGKILL"), /target bound/);
    assert.throws(
      () => signalProcesses([{ ...identity, startIdentity: "1".repeat(65536) }], owner, "SIGKILL"),
      /byte bound/
    );
    signalProcesses([{ ...identity, startIdentity: `${BigInt(identity.startIdentity) + 1n}` }], owner, "SIGKILL");
    assert.throws(() => signalProcesses([identity], randomUUID(), "SIGKILL"), /no exact phase owner marker/);
    assert.deepEqual(await closed, [0, null]);
    assert.doesNotThrow(() => signalProcesses([identity], owner, "SIGKILL"), "an exited identity is already settled");
  }
);

test(
  "Linux runner rejects an unavailable exact Python prerequisite before launching a phase",
  {
    skip: process.platform !== "linux"
  },
  async () => {
    let spawned = false;
    await assert.rejects(
      runRContractPhase(
        {
          id: "not-started",
          label: "not started",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          timeoutMs: 1000,
          environment: { ...process.env, OPEN_WRANGLER_PYTHON: "/missing-openwrangler-r-contract-python" }
        },
        {
          spawnProcess: () => {
            spawned = true;
            throw new Error("unexpected phase launch");
          }
        }
      ),
      /OW_ACCEPTANCE_PYTHON_INTERPRETER/
    );
    assert.equal(spawned, false);
  }
);

test(
  "Linux pidfds reject unreadable live metadata and cannot target a replacement after exit",
  {
    skip: process.platform !== "linux"
  },
  () => {
    const program = `
import os, runpy, signal, subprocess, sys
from unittest.mock import patch
namespace = runpy.run_path(sys.argv[1])
send = namespace["signal_verified_process"]
identity = {"pid": os.getpid(), "startIdentity": namespace["read_bounded"](f"/proc/{os.getpid()}/stat").rsplit(b")", 1)[1].split()[19].decode()}
opened = []
original_open = os.pidfd_open
def open_live(pid):
    fd = original_open(pid)
    opened.append(fd)
    return fd
def missing_metadata(path):
    raise FileNotFoundError()
with patch.object(os, "pidfd_open", open_live), patch.dict(send.__globals__, {"read_bounded": missing_metadata}), patch.object(signal, "pidfd_send_signal") as received:
    try:
        send(identity, "not-current-owner", signal.SIGKILL)
    except ValueError as error:
        assert str(error) == "live process metadata is unavailable"
    else:
        raise AssertionError("a live pidfd must not be reported gone because metadata is unreadable")
    received.assert_not_called()
child = subprocess.Popen([sys.executable, "-c", "pass"])
fd = original_open(child.pid)
child.wait()
opened.append(fd)
with patch.object(os, "pidfd_open", return_value=fd), patch.object(signal, "pidfd_send_signal") as received:
    # The fd refers to an exited process while /proc now describes a live one.
    send(identity, "not-current-owner", signal.SIGKILL)
    received.assert_not_called()
for fd in opened:
    try:
        os.fstat(fd)
    except OSError:
        pass
    else:
        raise AssertionError("every acquired pidfd must close")
`;
    const result = spawnSync(
      resolveAcceptancePython({ profile: "repository-command" }),
      ["-I", "-S", "-c", program, fileURLToPath(new URL("./r-contract-signal.py", import.meta.url))],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  }
);
