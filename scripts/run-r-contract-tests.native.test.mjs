import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createLinuxProcessSignaler,
  createPosixProcessTracker,
  readPsProcessIdentity,
  runRContractPhase
} from "./run-r-contract-tests.mjs";
import { resolveAcceptancePython } from "./packaged-python-preflight.mjs";

const runner = new URL("./run-r-contract-tests.mjs", import.meta.url).href;

function identityOf(child) {
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  return { pid: child.pid, startIdentity: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/u)[19] };
}

test("POSIX periodic observation waits after completion and stops on failure or disposal", async (context) => {
  for (const ending of ["failure", "stop"]) {
    await context.test(ending, async () => {
      const identity = { pid: 101, startIdentity: "tick", identityResolution: "kernel-start-tick" };
      const observationError = new Error("owned observation failed");
      let failObservation = false;
      let scans = 0;
      let reads = 0;
      let checkpointTimer;
      let resolveCheckpoint;
      const checkpoint = new Promise((resolveValue) => {
        resolveCheckpoint = resolveValue;
      });
      let deadlineTimer;
      const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error("observation checkpoint did not settle")), 1000);
      });
      let signaled;
      const tracker = createPosixProcessTracker(101, "owned-phase", {
        readProcessIdentity: () => {
          reads += 1;
          return identity;
        },
        listProcessIdentities: () => {
          scans += 1;
          if (scans === 2) {
            // Make the periodic pass exceed its interval without running a native process.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
            checkpointTimer = setTimeout(() => resolveCheckpoint(scans), 1);
          }
          if (failObservation) throw observationError;
          return [identity];
        },
        signalVerifiedProcesses: (targets, owner, signal) => {
          signaled = { targets, owner, signal };
        }
      });
      try {
        assert.equal(scans, 1, "initial observation is immediate");
        assert.equal(
          await Promise.race([checkpoint, deadline]),
          2,
          "the completed pass leaves a gap for another timer"
        );
        assert.equal(tracker.observe(), 1);
        assert.equal(tracker.isSettled({ isSettled: () => true }), false);
        tracker.signal("SIGTERM");
        assert.equal(scans, 5, "manual, final and signaling observations do not wait for the periodic gap");
        assert.deepEqual(signaled, { targets: [identity], owner: "owned-phase", signal: "SIGTERM" });
        if (ending === "failure") {
          failObservation = true;
          const failure = await Promise.race([tracker.failure, deadline]);
          assert.equal(failure.cause, observationError);
          assert.equal(failure.processTreeUnsettled, true);
          assert.throws(
            () => tracker.observe(),
            (error) => error === failure
          );
        } else {
          tracker.stop();
        }
        const finished = { reads, scans };
        await new Promise((resolveValue) => setTimeout(resolveValue, 30));
        assert.deepEqual({ reads, scans }, finished, "no process reads follow failure or stop");
      } finally {
        tracker.stop();
        clearTimeout(checkpointTimer);
        clearTimeout(deadlineTimer);
      }
    });
  }
});

test("POSIX ps observations retain primary state and bounded identity fields", () => {
  const ownerToken = "synthetic-owner";
  const start = "Wed Sep  9 10:05:19 2026";
  for (const state of ["S", "R+", "Z", "Zs+"]) {
    const zombie = state.startsWith("Z");
    const command = zombie ? "<defunct>" : `R --vanilla OPEN_WRANGLER_R_CONTRACT_OWNER=${ownerToken}`;
    const identity = readPsProcessIdentity(101, {
      ownerToken,
      execute: (file, args, options) => {
        assert.equal(file, "ps");
        assert.deepEqual(args, ["eww", "-p", "101", "-o", "pid=,ppid=,pgid=,state=,lstart=,command="]);
        assert.equal(options.timeout, 250);
        assert.equal(options.maxBuffer, 64 * 1024);
        assert.equal(options.killSignal, "SIGKILL");
        assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
        return `  101 100 101 ${state} ${start} ${command}\n`;
      }
    });
    assert.deepEqual(identity, {
      pid: 101,
      parentPid: 100,
      groupId: 101,
      state: state[0],
      startIdentity: start,
      command,
      ownerMarked: !zombie,
      identityResolution: "second"
    });
    assert.ok(Object.isFrozen(identity));
  }
  assert.throws(
    () => readPsProcessIdentity(101, { execute: () => `101 100 101 ${start} <defunct>\n` }),
    /process identity for PID 101 was malformed/u
  );
});

test("POSIX ownership diagnostics distinguish bounded evidence without exposing process data", async (context) => {
  const identity = (pid, parentPid) => ({
    pid,
    parentPid,
    groupId: 101,
    state: "?",
    startIdentity: "synthetic-secret-start",
    command: "synthetic-secret-command".repeat(1000),
    ownerMarked: true,
    identityResolution: "second"
  });
  const cases = [
    {
      name: "command changes despite retained marker and lineage",
      failingPid: 102,
      change: (identities) => {
        identities.set(102, { ...identities.get(102), command: "changed-synthetic-secret" });
      },
      flags:
        "secondResolution=true, parentMatches=true, groupMatches=true, commandMatches=false, markerBefore=true, markerNow=true, lineageOwned=true, root=false"
    },
    {
      name: "root parent changes despite retained marker",
      failingPid: 101,
      change: (identities) => {
        identities.set(101, { ...identities.get(101), parentPid: 900, command: "changed-synthetic-secret" });
      },
      flags:
        "secondResolution=true, parentMatches=false, groupMatches=true, commandMatches=false, markerBefore=true, markerNow=true, lineageOwned=false, root=true"
    },
    {
      name: "root group changes despite retained marker",
      failingPid: 101,
      change: (identities) => {
        identities.set(101, { ...identities.get(101), groupId: 900, command: "changed-synthetic-secret" });
      },
      flags:
        "secondResolution=true, parentMatches=true, groupMatches=false, commandMatches=false, markerBefore=true, markerNow=true, lineageOwned=false, root=true"
    },
    {
      name: "root command changes without retained marker",
      failingPid: 101,
      confirmDeparture: true,
      change: (identities) => {
        identities.set(101, { ...identities.get(101), command: "changed-synthetic-secret", ownerMarked: false });
      },
      flags:
        "secondResolution=true, parentMatches=true, groupMatches=true, commandMatches=false, markerBefore=true, markerNow=false, lineageOwned=false, root=true"
    },
    ...[
      ["parent", { parentPid: 900 }, "secondResolution=true, parentMatches=false, groupMatches=true"],
      ["group", { groupId: 900 }, "secondResolution=true, parentMatches=true, groupMatches=false"],
      [
        "resolution",
        { identityResolution: "kernel-start-tick" },
        "secondResolution=false, parentMatches=true, groupMatches=true"
      ]
    ].map(([field, change, flags]) => ({
      name: `root ${field} disagreement does not confirm departure after marker loss`,
      failingPid: 101,
      change: (identities) =>
        identities.set(101, {
          ...identities.get(101),
          ...change,
          command: "changed-synthetic-secret",
          ownerMarked: false
        }),
      flags: `${flags}, commandMatches=false, markerBefore=true, markerNow=false, lineageOwned=false, root=true`
    })),
    {
      name: "a descendant's changed command and lost marker fail without confirming departure",
      failingPid: 102,
      change: (identities) =>
        identities.set(102, {
          ...identities.get(102),
          command: "changed-synthetic-secret",
          ownerMarked: false
        }),
      flags:
        "secondResolution=true, parentMatches=true, groupMatches=true, commandMatches=false, markerBefore=true, markerNow=false, lineageOwned=true, root=false"
    },
    {
      name: "root marker loss with unchanged command fails without confirming departure",
      failingPid: 101,
      change: (identities) => identities.set(101, { ...identities.get(101), ownerMarked: false }),
      flags:
        "secondResolution=true, parentMatches=true, groupMatches=true, commandMatches=true, markerBefore=true, markerNow=false, lineageOwned=false, root=true"
    },
    {
      name: "a newly admitted start identity does not inherit the original root allowance",
      failingPid: 101,
      change: (identities, tracker) => {
        identities.set(101, { ...identities.get(101), startIdentity: "later-synthetic-secret-start" });
        assert.equal(tracker.observe(), 2, "the existing marker rule can admit the new start identity");
        identities.set(101, { ...identities.get(101), command: "changed-synthetic-secret" });
      },
      flags:
        "secondResolution=true, parentMatches=true, groupMatches=true, commandMatches=false, markerBefore=true, markerNow=true, lineageOwned=false, root=false"
    },
    {
      name: "unmarked child loses its tracked parent",
      failingPid: 102,
      unmarkedChild: true,
      change: (identities) => identities.delete(101),
      flags:
        "secondResolution=true, parentMatches=true, groupMatches=true, commandMatches=true, markerBefore=false, markerNow=false, lineageOwned=false, root=false"
    }
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const identities = new Map([
        [101, identity(101, 100)],
        [102, { ...identity(102, 101), ownerMarked: !scenario.unmarkedChild }]
      ]);
      const reads = new Map();
      const tracker = createPosixProcessTracker(101, "synthetic-secret-owner", {
        readProcessIdentity: (pid) => {
          reads.set(pid, (reads.get(pid) ?? 0) + 1);
          return identities.get(pid);
        },
        listProcessIdentities: () => [...identities.values()]
      });
      try {
        assert.equal(tracker.observe(), 2, "the initial marked or lineage-owned tree remains accepted");
        scenario.change(identities, tracker);
        reads.clear();
        let failure;
        assert.throws(
          () => tracker.observe(),
          (error) => {
            failure = error;
            return error instanceof Error;
          }
        );
        assert.match(failure.message, new RegExp(`process ${scenario.failingPid} `));
        assert.equal(reads.get(scenario.failingPid), scenario.confirmDeparture ? 2 : 1);
        assert.ok(failure.message.endsWith(`(${scenario.flags})`), failure.message);
        assert.ok(Buffer.byteLength(failure.message, "utf8") < 512);
        assert.doesNotMatch(`${failure.message}\n${failure.cause}`, /synthetic-secret/u);
        assert.equal(failure.processTreeUnsettled, true);
        assert.equal(await tracker.failure, failure);
        assert.throws(
          () => tracker.isSettled({ isSettled: () => true }),
          (error) => error === failure
        );
      } finally {
        tracker.stop();
      }
    });
  }

  for (const outcome of ["absent", "zombie", "different-start", "restored-marker", "exiting-live", "read-error"]) {
    await context.test(`original root departure confirmation: ${outcome}`, async () => {
      const original = { ...identity(101, 100), state: "S" };
      const torn = { ...original, command: "(R)", ownerMarked: false };
      const identities = new Map([
        [101, original],
        [102, identity(102, 101)]
      ]);
      let confirm = false;
      let confirmationReads = 0;
      const tracker = createPosixProcessTracker(101, "synthetic-secret-owner", {
        readProcessIdentity: (pid, token) => {
          assert.equal(token, "synthetic-secret-owner");
          if (pid === 101 && confirm && confirmationReads < 2) {
            confirmationReads += 1;
            if (confirmationReads === 1) return torn;
            if (outcome === "read-error") throw new Error("synthetic-secret-read-error");
            const current =
              outcome === "absent"
                ? undefined
                : outcome === "zombie"
                  ? { ...torn, state: "Z", command: "<defunct>" }
                  : outcome === "different-start"
                    ? { ...torn, startIdentity: "later-synthetic-secret-start" }
                    : outcome === "restored-marker"
                      ? original
                      : { ...torn, command: "<exiting>" };
            if (current) identities.set(101, current);
            else identities.delete(101);
            return current;
          }
          return identities.get(pid);
        },
        listProcessIdentities: () => [...identities.values()]
      });
      try {
        assert.equal(tracker.observe(), 2);
        confirm = true;
        if (["absent", "zombie", "different-start"].includes(outcome)) {
          assert.equal(tracker.observe(), 1, "only the departed original root should retire");
          assert.equal(confirmationReads, 2);
          assert.equal(tracker.isSettled({ isSettled: () => true }), false, "the marked descendant remains owned");
          identities.delete(102);
          assert.equal(tracker.isSettled({ isSettled: () => false }), false, "the child observer must settle");
          assert.equal(tracker.isSettled({ isSettled: () => true }), true);
          identities.set(101, original);
          assert.throws(() => tracker.observe(), /retired coarse process 101 reappeared/u);
          assert.equal((await tracker.failure).processTreeUnsettled, true);
        } else {
          let failure;
          assert.throws(
            () => tracker.observe(),
            (error) => {
              failure = error;
              return error instanceof Error;
            }
          );
          assert.equal(confirmationReads, 2, "the failed observation allows one departure check, not retries");
          assert.ok(
            failure.message.endsWith(
              "(secondResolution=true, parentMatches=true, groupMatches=true, commandMatches=false, markerBefore=true, markerNow=false, lineageOwned=false, root=true)"
            )
          );
          assert.doesNotMatch(`${failure.message}\n${failure.cause}`, /synthetic-secret/u);
          assert.equal(await tracker.failure, failure);
          assert.throws(
            () => tracker.isSettled({ isSettled: () => true }),
            (error) => error === failure
          );
          assert.equal(confirmationReads, 2);
        }
      } finally {
        tracker.stop();
      }
    });
  }

  await context.test("original marked root command changes retain child and exit settlement", () => {
    const identities = new Map([
      [101, identity(101, 100)],
      [102, identity(102, 101)]
    ]);
    const tracker = createPosixProcessTracker(101, "synthetic-secret-owner", {
      readProcessIdentity: (pid) => identities.get(pid),
      listProcessIdentities: () => [...identities.values()]
    });
    try {
      for (const command of ["exec-synthetic-secret", "exec-synthetic-secret ENV=changed-synthetic-secret"]) {
        identities.set(101, { ...identities.get(101), command });
        assert.equal(tracker.observe(), 2);
      }
      identities.delete(101);
      assert.equal(tracker.isSettled({ isSettled: () => true }), false, "the marked child still belongs to the phase");
      identities.clear();
      assert.equal(tracker.isSettled({ isSettled: () => false }), false, "the child observer must also settle");
      assert.equal(tracker.isSettled({ isSettled: () => true }), true);
    } finally {
      tracker.stop();
    }
  });

  await context.test(
    "listed zombies retire without accepting a later live identity or premature settlement",
    async () => {
      const original = { ...identity(101, 100), state: "S" };
      const identities = new Map([
        [101, original],
        [102, identity(102, 101)]
      ]);
      const tracker = createPosixProcessTracker(101, "synthetic-secret-owner", {
        readProcessIdentity: (pid) => identities.get(pid),
        listProcessIdentities: () => [...identities.values()]
      });
      try {
        identities.set(101, { ...original, state: "Z", command: "<defunct>", ownerMarked: false });
        assert.equal(tracker.observe(), 1, "the listed zombie must retire before coarse identity checks");
        assert.equal(tracker.observe(), 1, "a still-listed zombie must not reappear as a live retired key");
        assert.equal(tracker.isSettled({ isSettled: () => true }), false, "the marked child must still settle");
        identities.delete(102);
        assert.equal(tracker.isSettled({ isSettled: () => false }), false, "the child observer must still settle");
        assert.equal(tracker.isSettled({ isSettled: () => true }), true);
        identities.set(101, original);
        assert.throws(() => tracker.observe(), /retired coarse process 101 reappeared/u);
        assert.equal((await tracker.failure).processTreeUnsettled, true);
      } finally {
        tracker.stop();
      }
    }
  );

  await context.test("a retired original root key remains refused despite its marker", async () => {
    const original = identity(101, 100);
    let current = original;
    const tracker = createPosixProcessTracker(101, "synthetic-secret-owner", {
      readProcessIdentity: () => current,
      listProcessIdentities: () => (current ? [current] : [])
    });
    try {
      current = undefined;
      assert.equal(tracker.observe(), 0);
      current = { ...original, command: "changed-synthetic-secret" };
      assert.throws(() => tracker.observe(), /retired coarse process 101 reappeared/u);
      assert.equal((await tracker.failure).processTreeUnsettled, true);
    } finally {
      tracker.stop();
    }
  });

  let current = { pid: 101, startIdentity: "tick", identityResolution: "kernel-start-tick" };
  const tracker = createPosixProcessTracker(101, "synthetic-secret-owner", {
    readProcessIdentity: () => current,
    listProcessIdentities: () => [current]
  });
  try {
    current = { ...current, parentPid: 999, groupId: 999, command: "changed-synthetic-secret", ownerMarked: false };
    assert.equal(tracker.observe(), 1, "precise identities retain the existing non-coarse bypass");
  } finally {
    tracker.stop();
  }
});

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

function outputReaderProbe(channel, entryPoint = "runRContractPhasesWithSignalForwarding") {
  const program = `
import fs from 'node:fs';
import { ${entryPoint} } from ${JSON.stringify(runner)};
const root = process.env.OW_OUTPUT_PROBE_ROOT;
const childCode = ${JSON.stringify(`
const fs = require('node:fs');
const root = process.env.OW_OUTPUT_PROBE_ROOT;
const event = name => fs.appendFileSync(root+'/events',name+'\\n');
const fields = fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ');
fs.writeFileSync(root+'/phase.tmp',JSON.stringify({pid:process.pid,start:fields[19],owner:process.env.OPEN_WRANGLER_R_CONTRACT_OWNER}));
fs.renameSync(root+'/phase.tmp',root+'/phase.json');
process.on('SIGTERM',()=>{event('SIGTERM');process.exit(0);});
process.stdout.on('error',()=>{});
process.stderr.on('error',()=>{});
const gate=setInterval(()=>{if(fs.existsSync(root+'/emit')){clearInterval(gate);process.${channel ?? "stdout"}.write('owned phase output\\n');}},10);
setTimeout(()=>{event('expiry');process.exit(0);},2000);
`)};
const phases = [{id:'output',label:'owned output',command:process.execPath,args:['-e',childCode],environment:process.env,timeoutMs:4000},
 {id:'next',label:'next',command:process.execPath,args:['-e',"require('node:fs').writeFileSync("+JSON.stringify(root+'/next')+",'yes')"],environment:process.env,timeoutMs:1000}];
try {
 await ${entryPoint}(${entryPoint === "runRContractPhase" ? "phases[0]" : "phases"});
 fs.writeFileSync(root+'/result',JSON.stringify({ok:true}));
} catch(error) {
 const messages = e => [e.message,...(e.errors??[]).flatMap(messages)];
 fs.writeFileSync(root+'/result',JSON.stringify({ok:false,messages:messages(error)}));process.exitCode=1;
}
`;
  const controller = String.raw`
import ctypes,json,os,pathlib,signal,subprocess,sys,tempfile,time
assert ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0
with tempfile.TemporaryDirectory(prefix='ow-r-output-') as directory:
 root=pathlib.Path(directory); phase=None; fd=None; runner=None
 def identity(pid):
  try: return pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
  except FileNotFoundError: return None
 try:
  runner=subprocess.Popen([sys.argv[1],'--input-type=module','-e',sys.argv[2]],env={**os.environ,'OW_OUTPUT_PROBE_ROOT':directory},stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  deadline=time.monotonic()+4
  while not (root/'phase.json').exists():
   assert runner.poll() is None, runner.stderr.read().decode()
   assert time.monotonic()<deadline, 'phase registration deadline'
   time.sleep(.01)
  phase=json.loads((root/'phase.json').read_text()); fields=identity(phase['pid'])
  assert fields[19]==phase['start'] and int(fields[1])==runner.pid
  assert ('OPEN_WRANGLER_R_CONTRACT_OWNER='+phase['owner']).encode() in pathlib.Path(f"/proc/{phase['pid']}/environ").read_bytes().split(b'\0')
  fd=os.pidfd_open(phase['pid'])
  if sys.argv[3]!='intact': getattr(runner,sys.argv[3]).close()
  (root/'emit').write_text('go')
  status=runner.wait(timeout=6)
  after_exit=identity(phase['pid'])
  outputs={name:getattr(runner,name).read().decode() for name in ['stdout','stderr'] if not getattr(runner,name).closed}
  deadline=time.monotonic()+3
  while identity(phase['pid']) is not None:
   try: os.waitpid(phase['pid'],os.WNOHANG)
   except ChildProcessError: pass
   assert time.monotonic()<deadline, 'self-expiring fixture did not exit'
   time.sleep(.01)
  result={'status':status,'phaseAliveAfterRunner':after_exit is not None and after_exit[0]!='Z','events':(root/'events').read_text().splitlines(),'nextStarted':(root/'next').exists(),'outcome':json.loads((root/'result').read_text()) if (root/'result').exists() else None,'outputs':outputs}
 finally:
  if fd is not None:
   try: signal.pidfd_send_signal(fd,signal.SIGKILL)
   except ProcessLookupError: pass
   os.close(fd)
  if runner is not None:
   if runner.poll() is None: runner.kill()
   runner.wait(timeout=3)
   runner.stdout.close();runner.stderr.close()
  deadline=time.monotonic()+3
  while True:
   try: pid,_=os.waitpid(-1,os.WNOHANG)
   except ChildProcessError: break
   assert time.monotonic()<deadline, 'owned fixture cleanup deadline'
   if not pid: time.sleep(.01)
  if phase is not None: assert identity(phase['pid']) is None
print(json.dumps(result))
`;
  const execution = spawnSync(
    resolveAcceptancePython({ profile: "repository-command" }),
    ["-c", controller, process.execPath, program, channel ?? "intact"],
    {
      encoding: "utf8",
      timeout: 12_000,
      maxBuffer: 128 * 1024
    }
  );
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.phaseAliveAfterRunner, false, "the runner must settle its phase before returning");
  if (channel) {
    assert.equal(result.status, 1);
    assert.equal(result.outcome?.ok, false, "destination errors must reject through the runner");
    assert.match(result.outcome.messages.join("\n"), new RegExp(`${channel} sink failed`));
    assert.deepEqual(result.events, ["SIGTERM"]);
    assert.equal(result.nextStarted, false);
    assert.doesNotMatch(Object.values(result.outputs).join(""), /Unhandled 'error' event/);
  } else {
    assert.equal(result.status, 0);
    assert.equal(result.outcome.ok, true);
    assert.deepEqual(result.events, ["expiry"]);
    assert.equal(result.nextStarted, true);
    assert.match(result.outputs.stdout, /owned phase output/);
  }
}

test(
  "Linux default output destinations settle before rejecting closed readers",
  { skip: process.platform !== "linux" },
  async (context) => {
    for (const channel of [undefined, "stdout", "stderr"]) {
      await context.test(channel ?? "intact", () => outputReaderProbe(channel));
    }
    await context.test("direct phase defaults", () => outputReaderProbe("stdout", "runRContractPhase"));
  }
);

function outputCallbackProbe(stage) {
  const program = `
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {runRContractPhase,runRContractPhasesWithSignalForwarding} from ${JSON.stringify(runner)};
const stage=${JSON.stringify(stage)};
const safety=setTimeout(()=>process.exit(97),3000);
const stream=process.stdout, original=stream.write;
const unrelated=()=>{};stream.on('error',unrelated);
const listeners=stream.listenerCount('error');
let triggered=false, spawned=0, closed=0, release;
const lateError=new Error('controlled destination failure');
stream.write=function(chunk,...args) {
 const target=stage==='START-signal'?'START':stage.startsWith('PASS')?'PASS':stage;
 if(!triggered && (stage==='FAIL-pending'?String(chunk).includes('held payload'):String(chunk).includes('[r-contract] '+target))) {
  triggered=true;
  const callback=args.at(-1);assert.equal(typeof callback,'function');
  if(stage==='START-signal') {process.kill(process.pid,'SIGTERM');return original.call(this,chunk,...args);}
  release=error=>{callback(error);if(error)process.nextTick(()=>stream.emit('error',error));};
  if(stage==='FAIL-pending') return true;
  if(stage==='START') {process.nextTick(()=>release(lateError));return true;}
  setImmediate(()=>setImmediate(()=>{
   if(stage.startsWith('PASS') && stage.endsWith('signal')) process.kill(process.pid,'SIGTERM');
   else if(stage==='PASS-healthy') {assert.equal(spawned,1);assert.equal(closed,1);release();}
   else release(lateError);
  }));
  return true;
 }
 return original.call(this,chunk,...args);
};
const phases=[{id:'fixture',label:'callback fixture',command:process.execPath,args:['-e',(stage==='FAIL-pending'?"process.stdout.write('held payload');":'')+'process.exit('+(['RECORDED','FAIL-pending'].includes(stage)?7:0)+')'],environment:process.env,timeoutMs:1000},
 {id:'next',label:'next',command:process.execPath,args:['-e','process.exit(0)'],environment:process.env,timeoutMs:1000}];
let failure;
const run=stage==='FAIL-pending'?runRContractPhase:runRContractPhasesWithSignalForwarding;
try {await run(stage==='FAIL-pending'?phases[0]:phases,{spawnProcess:(...args)=>{spawned++;const child=spawn(...args);child.once('close',()=>closed++);return child;}});}catch(error){failure=error;}
finally {stream.write=original;}
assert.ok(triggered);
if(stage==='FAIL-pending'||(stage.startsWith('PASS') && stage.endsWith('signal'))) {
 assert.equal(stream.listenerCount('error'),listeners+1,'pending callback retains its error listener');
 release(lateError);
}
await new Promise(resolve=>setImmediate(resolve));
assert.equal(stream.listenerCount('error'),listeners,'only owned listeners retire after callback/error delivery');
assert.equal(closed,spawned,'native children settle before return');
const messages=e=>[e?.message,...(e?.errors??[]).flatMap(messages)].filter(Boolean).join('\\n');
if(stage==='PASS-healthy'){assert.equal(failure,undefined);assert.equal(spawned,2);}
else {
 assert.ok(failure);assert.equal(spawned,stage==='START'||stage==='START-signal'?0:1);
 assert.match(messages(failure),stage==='FAIL-pending'?/exit 7/:stage.endsWith('signal')?/INTERRUPTED.*SIGTERM/:/stdout sink failed/);
 if(stage==='RECORDED')assert.match(messages(failure),/exit 7/);
}
await runRContractPhasesWithSignalForwarding([]);
assert.equal(stream.listenerCount('error'),listeners,'a second invocation does not accumulate listeners');
stream.removeListener('error',unrelated);
clearTimeout(safety);
process.stderr.write('verified '+stage+'\\n');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    timeout: 6000,
    maxBuffer: 128 * 1024
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, new RegExp(`verified ${stage}`));
}

test(
  "Linux output callbacks preserve status, interruption and listener ownership",
  { skip: process.platform !== "linux" },
  async (context) => {
    for (const stage of ["START", "PASS", "RECORDED", "START-signal", "PASS-signal", "FAIL-pending", "PASS-healthy"]) {
      await context.test(stage, () => outputCallbackProbe(stage));
    }
  }
);

test(
  "CLI order and final diagnostics use the owned output destination",
  { skip: process.platform !== "linux" },
  async (context) => {
    for (const stage of ["ORDER", "final"]) {
      await context.test(stage, () => {
        const preload = `
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const stream=process.${stage === "ORDER" ? "stdout" : "stderr"}, original=stream.write;
const listeners=stream.listenerCount('error');let writes=0,spawns=0;
cp.spawn=()=>{spawns++;throw new Error('unexpected phase launch');};syncBuiltinESMExports();
stream.write=function(_chunk,callback){writes++;const error=new Error('controlled ${stage} destination failure');setImmediate(()=>{callback(error);process.nextTick(()=>stream.emit('error',error));});return true;};
process.once('beforeExit',()=>{
 stream.write=original;
 assert.equal(spawns,0);assert.equal(writes,1);assert.equal(stream.listenerCount('error'),listeners);
 process.${stage === "ORDER" ? "stderr" : "stdout"}.write('verified ${stage}\\n');
});
`;
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            `data:text/javascript,${encodeURIComponent(preload)}`,
            fileURLToPath(runner),
            ...(stage === "ORDER" ? ["--phase", "frame:decimal-ordering", "--seed", "1"] : ["--invalid"])
          ],
          {
            env: { ...process.env, R: process.execPath, RSCRIPT: process.execPath },
            encoding: "utf8",
            timeout: 6000,
            maxBuffer: 128 * 1024
          }
        );
        assert.equal(result.status, 1);
        assert.match(result.stdout + result.stderr, new RegExp(`verified ${stage}`));
        assert.doesNotMatch(result.stdout + result.stderr, /Unhandled 'error' event/);
      });
    }
  }
);

test(
  "Linux output wrapper preserves exact falsy writer rejections",
  { skip: process.platform !== "linux" },
  async (context) => {
    for (const value of [undefined, 0]) {
      await context.test(String(value), async () => {
        let spawned = false;
        let rejected = false;
        try {
          await runRContractPhase(
            { id: "unstarted", label: "unstarted", environment: process.env, timeoutMs: 1000 },
            {
              writeLine: () => {
                throw value;
              },
              spawnProcess: () => {
                spawned = true;
                throw new Error("unexpected launch");
              }
            }
          );
        } catch (error) {
          rejected = true;
          assert.equal(error, value);
        }
        assert.equal(rejected, true);
        assert.equal(spawned, false);
      });
    }
  }
);
