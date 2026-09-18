import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createLinuxProcessSignaler,
  createPosixProcessTracker,
  runRContractPhase,
  runRContractPhasesWithSignalForwarding
} from "./run-r-contract-tests.mjs";
import { prepareMacProcessOwner } from "./r-contract-macos.mjs";
import { resolveAcceptancePython } from "./packaged-python-preflight.mjs";

const runner = new URL("./run-r-contract-tests.mjs", import.meta.url).href;

function macIdentity(pid, fields = {}) {
  return {
    pid,
    parentPid: 1,
    startIdentity: String(pid + 100000),
    parentUniqueId: "1",
    beforeParentUniqueId: "1",
    idVersion: 10,
    beforeIdVersion: 10,
    originalParentVersion: 0,
    marker: 0,
    ownerMarked: false,
    state: "?",
    identityResolution: "macos-unique-id",
    ...fields
  };
}

test("macOS tracker retains both exec samples through reread and retirement", () => {
  let root = macIdentity(40001, { ownerMarked: true });
  let scan = [];
  let reads = [];
  let targets;
  const tracker = createPosixProcessTracker(root.pid, "owned-test", {
    readProcessIdentity: (pid) =>
      pid === 40001 ? (reads.length ? reads.shift() : root) : scan.find((x) => x.pid === pid),
    listProcessIdentities: () => scan,
    signalVerifiedProcesses: (values) => {
      targets = values;
    }
  });
  try {
    // The after version is already known; the before sample must still be retained.
    root = macIdentity(40001, { beforeIdVersion: 11 });
    tracker.signal("SIGTERM");
    assert.deepEqual(targets[0].observedIdVersions, [10, 11]);
    scan = [macIdentity(40001, { beforeIdVersion: 12, idVersion: 13 })];
    reads = [root, macIdentity(40001, { beforeIdVersion: 14, idVersion: 14 })];
    tracker.observe();
    root = macIdentity(40001, { beforeIdVersion: 14, idVersion: 14 });
    scan = [];
    tracker.signal("SIGTERM");
    assert.deepEqual(targets[0].observedIdVersions, [10, 11, 12, 13, 14]);
    root = undefined;
    scan = [macIdentity(40002, { originalParentVersion: 12 })];
    assert.throws(() => tracker.isSettled({ isSettled: () => true }), /ambiguous native parent evidence/);
  } finally {
    tracker.stop();
  }
});

test("macOS tracker distinguishes positive ownership from historical parent ambiguity", async (context) => {
  for (const marker of [0, -1, 1]) {
    await context.test(`marker ${marker}`, () => {
      const root = macIdentity(40001, { ownerMarked: true });
      let scan = [macIdentity(40002, { marker, ownerMarked: marker === 1, beforeIdVersion: 20, idVersion: 21 })];
      let targets;
      const tracker = createPosixProcessTracker(root.pid, "owned-test", {
        readProcessIdentity: (pid) => (pid === root.pid ? root : scan.find((x) => x.pid === pid)),
        listProcessIdentities: () => scan,
        signalVerifiedProcesses: (values) => {
          targets = values;
        }
      });
      try {
        tracker.signal("SIGTERM");
        assert.deepEqual(
          targets.map((value) => value.pid),
          marker === 1 ? [40001, 40002] : [40001]
        );
        if (marker === 1) {
          scan = [macIdentity(40002, { beforeIdVersion: 21, idVersion: 22 })];
          tracker.signal("SIGTERM");
          assert.deepEqual(targets[1].observedIdVersions, [20, 21, 22]);
        } else {
          scan = [macIdentity(40002, { marker, beforeParentUniqueId: root.startIdentity })];
          assert.throws(() => tracker.signal("SIGTERM"), /ambiguous native parent evidence/);
          assert.deepEqual(
            targets.map((value) => value.pid),
            [40001]
          );
        }
      } finally {
        tracker.stop();
      }
    });
  }
});

test("macOS tracker bounds observed execution history without dropping ambiguity evidence", () => {
  let root = macIdentity(40001);
  const tracker = createPosixProcessTracker(root.pid, "owned-test", {
    readProcessIdentity: () => root,
    listProcessIdentities: () => [],
    signalVerifiedProcesses: () => {}
  });
  try {
    for (let version = 11; version < 266; version++) {
      root = macIdentity(40001, { beforeIdVersion: version, idVersion: version });
      tracker.observe();
    }
    root = macIdentity(40001, { beforeIdVersion: 266, idVersion: 266 });
    assert.throws(() => tracker.observe(), /256-version bound/);
  } finally {
    tracker.stop();
  }
});

test("macOS tracker requires the current parent's PID and lifetime together", () => {
  const root = macIdentity(40001);
  const children = [
    macIdentity(40002, { parentPid: root.pid, parentUniqueId: root.startIdentity }),
    macIdentity(40003, { parentPid: root.pid, parentUniqueId: "999999" })
  ];
  let targets;
  const tracker = createPosixProcessTracker(root.pid, "owned-test", {
    readProcessIdentity: (pid) => [root, ...children].find((value) => value.pid === pid),
    listProcessIdentities: () => children,
    signalVerifiedProcesses: (values) => {
      targets = values;
    }
  });
  try {
    tracker.signal("SIGTERM");
    assert.deepEqual(
      targets.map((value) => value.pid),
      [40001, 40002]
    );
  } finally {
    tracker.stop();
  }
});

function macPreparationFixture(context) {
  const parent = mkdtempSync(join(tmpdir(), "ow-mac-owner-test-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const calls = [];
  const preflight = { capability: "native-identity-signal", staleSelfRefusedLive: true };
  return {
    parent,
    calls,
    preflight,
    environment: { ...process.env, TMPDIR: parent },
    compile: async (input, options) => {
      assert.equal(input.executable, "/usr/bin/xcrun");
      assert.equal(options.timeoutMs, 20000);
      assert.equal(options.maxOutputBytes, 16 * 1024);
      input.beforeSpawnCheck();
      writeFileSync(input.args.at(-1), "controlled native helper", { flag: "wx", mode: 0o770 });
    },
    execute: (_file, args) => {
      calls.push(args);
      return JSON.stringify(preflight);
    }
  };
}

test(
  "macOS preparation rejects cancellation and failed admission before exposing a helper",
  { skip: process.platform === "win32" },
  async (context) => {
    for (const kind of [
      "already aborted",
      "before spawn",
      "after close",
      "compiler failure",
      "unsettled compiler",
      "preflight failure"
    ]) {
      await context.test(kind, async (t) => {
        const fixture = macPreparationFixture(t);
        const controller = new AbortController();
        let compileCalls = 0;
        if (kind === "already aborted") controller.abort("SIGTERM");
        const compilerFailure = Object.assign(
          new Error(kind),
          kind === "unsettled compiler" ? { code: "EDITOR_PROCESS_TREE_UNVERIFIED" } : {}
        );
        await assert.rejects(
          prepareMacProcessOwner(fixture.environment, {
            platform: "darwin",
            terminationSignal: controller.signal,
            runCommand: async (input, options) => {
              compileCalls++;
              if (kind === "before spawn") controller.abort("SIGINT");
              input.beforeSpawnCheck();
              if (kind.endsWith("compiler") || kind === "compiler failure") throw compilerFailure;
              await fixture.compile(input, options);
              if (kind === "after close") controller.abort("SIGTERM");
            },
            execute: kind === "preflight failure" ? () => "{}" : fixture.execute
          }),
          (error) => {
            if (kind.includes("compiler")) assert.equal(error, compilerFailure);
            else if (kind !== "preflight failure") assert.match(error.message, /interrupted by SIG/);
            if (kind === "unsettled compiler") assert.equal(existsSync(error.macHelperRetainedRoot), true);
            return true;
          }
        );
        assert.equal(compileCalls, kind === "already aborted" ? 0 : 1);
        assert.equal(fixture.calls.length, 0);
        assert.equal(readdirSync(fixture.parent).length, kind === "unsettled compiler" ? 1 : 0);
      });
    }
  }
);

test(
  "macOS prepared adapter validates samples and signals only the current exact lifetime",
  { skip: process.platform === "win32" },
  async (context) => {
    const fixture = macPreparationFixture(context);
    const wire = ({ ownerMarked: _ownerMarked, state: _state, identityResolution: _identityResolution, ...record }) =>
      record;
    let record = wire(macIdentity(40001, { beforeIdVersion: 20, idVersion: 21 }));
    let refused = false;
    const calls = [];
    const envelope = (records) => ({ records, cpuMs: 0, wallMs: 0, metadataBytes: 0 });
    const prepared = await prepareMacProcessOwner(fixture.environment, {
      platform: "darwin",
      runCommand: fixture.compile,
      execute: (_file, args) => {
        calls.push(args);
        if (args[0] === "preflight") return JSON.stringify(fixture.preflight);
        if (args[0] === "signal") {
          const result = JSON.stringify({ results: [{ pid: record.pid, result: refused ? 2 : 0 }] });
          if (refused) throw Object.assign(new Error("native refusal"), { status: 3, stdout: result });
          return result;
        }
        return JSON.stringify(envelope([record]));
      }
    });
    const owner = prepared.createProcessOwner("owned-test");
    assert.equal(owner.readProcessIdentity(40001).beforeIdVersion, 20);
    assert.deepEqual(owner.signalVerifiedProcesses([macIdentity(40001)], "owned-test", "SIGTERM"), [
      macIdentity(40001, { beforeIdVersion: 20, idVersion: 21 })
    ]);
    assert.deepEqual(calls.at(-1), ["signal", "SIGTERM", "40001", "140001", "21"]);
    record = { ...record, startIdentity: "999999" };
    assert.deepEqual(owner.signalVerifiedProcesses([macIdentity(40001)], "owned-test", "SIGTERM"), []);
    assert.equal(calls.at(-1)[0], "inspect");
    record = { ...record, startIdentity: "140001" };
    refused = true;
    assert.throws(
      () => owner.signalVerifiedProcesses([macIdentity(40001)], "owned-test", "SIGKILL"),
      /may remain live/
    );
    const valid = record;
    for (const invalid of [
      { ...valid, beforeIdVersion: undefined },
      { ...valid, beforeIdVersion: 2 ** 32 },
      { ...valid, beforeParentUniqueId: "01" },
      { ...valid, beforeParentUniqueId: String(2n ** 64n) },
      { ...valid, pid: 40002 }
    ]) {
      record = invalid;
      assert.throws(() => owner.readProcessIdentity(40001));
    }
    renameSync(prepared.binary, `${prepared.binary}.original`);
    writeFileSync(prepared.binary, "controlled native helper", { mode: 0o500 });
    const callsBeforeReplacement = calls.length;
    assert.throws(() => owner.listProcessIdentities(), /helper identity changed/);
    assert.equal(calls.length, callsBeforeReplacement);
    prepared.dispose();
    prepared.dispose();
    assert.deepEqual(readdirSync(fixture.parent), []);
    assert.throws(() => owner.listProcessIdentities(), /already retired/);
  }
);

test(
  "macOS tracker retains signal-time execution history before retiring a parent",
  { skip: process.platform === "win32" },
  async (context) => {
    const fixture = macPreparationFixture(context);
    const wire = ({ ownerMarked: _ownerMarked, state: _state, identityResolution: _identityResolution, ...record }) =>
      record;
    let root = wire(macIdentity(40001, { marker: 1 }));
    let children = [];
    let armed = false;
    let reads = 0;
    let signalVersion;
    const prepared = await prepareMacProcessOwner(fixture.environment, {
      platform: "darwin",
      runCommand: fixture.compile,
      execute: (_file, args) => {
        if (args[0] === "preflight") return JSON.stringify(fixture.preflight);
        if (args[0] === "signal") {
          signalVersion = Number(args[4]);
          root = undefined;
          children = [wire(macIdentity(40002, { originalParentVersion: 11 }))];
          return JSON.stringify({ results: [{ pid: 40001, result: 0 }] });
        }
        if (args[0] === "inspect" && armed && Number(args[2]) === 40001 && ++reads === 3)
          root = { ...root, beforeIdVersion: 11, idVersion: 11 };
        const records =
          args[0] === "scan"
            ? children
            : Number(args[2]) === 40001
              ? root
                ? [root]
                : []
              : children.filter((child) => child.pid === Number(args[2]));
        return JSON.stringify({ records, cpuMs: 0, wallMs: 0, metadataBytes: 0 });
      }
    });
    const tracker = createPosixProcessTracker(40001, "owned-test", prepared.createProcessOwner("owned-test"));
    try {
      armed = true;
      tracker.signal("SIGTERM");
      assert.equal(signalVersion, 11, "the adapter must signal the execution it just observed");
      assert.throws(
        () => tracker.isSettled({ isSettled: () => true }),
        /ambiguous native parent evidence/,
        "the fresh signal-time parent execution must prevent false settlement"
      );
      assert.equal(children.length, 1, "ambiguity must not grant signaling authority over the orphan");
    } finally {
      tracker.stop();
      prepared.dispose();
    }
  }
);

test(
  "macOS helper retirement preserves a replacement private root",
  { skip: process.platform === "win32" },
  async (context) => {
    const fixture = macPreparationFixture(context);
    const prepared = await prepareMacProcessOwner(fixture.environment, {
      platform: "darwin",
      runCommand: fixture.compile,
      execute: fixture.execute
    });
    const moved = `${prepared.directory}.original`;
    renameSync(prepared.directory, moved);
    mkdirSync(prepared.directory, { mode: 0o700 });
    const unrelated = join(prepared.directory, "unrelated.txt");
    writeFileSync(unrelated, "preserve replacement");
    assert.throws(() => prepared.createProcessOwner("owned-test"), /identity/);
    assert.throws(
      () => prepared.dispose(),
      (error) => {
        assert.equal(error.macHelperRetainedRoot, prepared.directory);
        return true;
      }
    );
    assert.equal(readFileSync(unrelated, "utf8"), "preserve replacement");
    assert.equal(existsSync(join(moved, "process-owner")), true);
  }
);

test(
  "macOS compiler output failure settles its inherited process group or retains the private root",
  { skip: process.platform === "win32" },
  async (context) => {
    const { runBoundedEditorCommand } = await import("./editor-acceptance.mjs");
    for (const settles of [true, false]) {
      await context.test(`settles ${settles}`, async (t) => {
        const fixture = macPreparationFixture(t);
        let groupAlive = true;
        const signals = [];
        const child = Object.assign(new EventEmitter(), {
          pid: 40001,
          exitCode: null,
          signalCode: null,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => {
            assert.fail("the compiler leader has already exited");
          }
        });
        t.after(() => {
          child.emit("close", 0, null);
          child.stdout.destroy();
          child.stderr.destroy();
        });
        t.mock.method(process, "kill", (pid, signal) => {
          assert.equal(pid, -child.pid);
          if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
          if (signal !== 0) signals.push(signal);
          if (signal === "SIGKILL" && settles) {
            groupAlive = false;
            child.emit("close", 0, null);
          }
        });
        await assert.rejects(
          prepareMacProcessOwner(fixture.environment, {
            platform: "darwin",
            execute: fixture.execute,
            runCommand: (input, options) =>
              runBoundedEditorCommand(input, {
                ...options,
                terminationGraceMs: 1,
                killGraceMs: 1,
                signalSource: new EventEmitter(),
                spawnProcess: () => {
                  queueMicrotask(() => {
                    child.exitCode = 0;
                    child.emit("exit", 0, null);
                    child.stdout.write(Buffer.alloc(options.maxOutputBytes + 1));
                  });
                  return child;
                }
              })
          }),
          (error) => {
            if (!settles) assert.equal(existsSync(error.macHelperRetainedRoot), true);
            return true;
          }
        );
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
        assert.equal(fixture.calls.length, 0);
        assert.equal(readdirSync(fixture.parent).length, settles ? 0 : 1);
      });
    }
  }
);

test("macOS runner owns one preparation through cancellation, phases and retirement", async (context) => {
  for (const kind of ["success", "cancel during preparation", "phase failure", "cleanup failure"]) {
    await context.test(kind, async () => {
      const signalSource = new EventEmitter();
      const events = [];
      const phases = ["first", "second"].map((id) => ({ id, environment: process.env }));
      const factory = () => {};
      const run = runRContractPhasesWithSignalForwarding(phases, {
        platform: "darwin",
        signalSource,
        writeLine: () => {},
        prepareMacOwner: async (_environment, { terminationSignal }) => {
          events.push("prepare");
          assert.equal(terminationSignal.aborted, false);
          if (kind === "cancel during preparation") signalSource.emit("SIGTERM");
          return {
            createProcessOwner: factory,
            dispose: () => {
              events.push("dispose");
              if (kind === "cleanup failure") throw new Error("controlled helper retirement failure");
            }
          };
        },
        runPhase: async (phase, options) => {
          assert.equal(options.macProcessOwner, factory);
          events.push(phase.id);
          if (kind === "phase failure")
            throw Object.assign(new Error("controlled unsettled phase"), { processTreeUnsettled: true });
        }
      });
      if (kind === "success") await run;
      else await assert.rejects(run);
      assert.deepEqual(
        events,
        kind === "cancel during preparation"
          ? ["prepare", "dispose"]
          : kind === "phase failure"
            ? ["prepare", "first", "dispose"]
            : ["prepare", "first", "second", "dispose"]
      );
      assert.equal(signalSource.listenerCount("SIGINT"), 0);
      assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    });
  }
});

test("macOS direct phase refuses launch without its prepared native owner", async () => {
  await assert.rejects(
    runRContractPhase(
      { id: "unstarted", label: "unstarted", environment: process.env, timeoutMs: 1000 },
      {
        platform: "darwin",
        writeLine: () => {},
        spawnProcess: () => {
          assert.fail("phase launched before native ownership was prepared");
        }
      }
    ),
    /prepared native process owner/
  );
});

function identityOf(child) {
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  return { pid: child.pid, startIdentity: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/u)[19] };
}

function cancellationProbe(kind) {
  const program = `
    import assert from 'node:assert/strict';
    import { execFileSync, spawn } from 'node:child_process';
    import { readFileSync } from 'node:fs';
    const processGroupOf = pid => {
      if (process.platform === 'linux') return Number(readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[2]);
      const group = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {encoding:'utf8', timeout:250, killSignal:'SIGKILL', maxBuffer:1024});
      assert.match(group, /^\\s*[1-9][0-9]*\\s*$/u);
      return Number(group);
    };
    import { runRContractPhasesWithSignalForwarding } from ${JSON.stringify(runner)};
    const kind = ${JSON.stringify(kind)};
    const detached = kind === 'detached' || kind === 'late-detached';
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
    let detachedRequested = false;
    const descendantCode = "process.on('SIGTERM', () => { console.log('DETACHED_SIGTERM'); process.exit(0); }); console.log('DETACHED_READY:' + process.pid); setTimeout(() => process.exit(0), 4000);";
    const spawnDetached = "require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(descendantCode) + "], {detached:true, stdio:'inherit'}).unref();";
    const childCode = [
      ...(kind === 'detached' ? [spawnDetached] : []),
      ...(kind === 'late-detached' ? ["process.on('SIGUSR2', () => {" + spawnDetached + "});"] : []),
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
        ...(kind === 'late-detached' ? {observationIntervalMs: 60_000} : {}),
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
          if (detached) {
            const match = /DETACHED_READY:([0-9]+)/u.exec(output.join(''));
            if (match) detachedPid = Number(match[1]);
          }
          // READY arrives after initial tracking. No background tick can discover
          // the late child before cancellation forces fresh settlement/signaling.
          if (kind === 'late-detached' && !detachedRequested && output.join('').split('\\n').includes('READY')) {
            detachedRequested = true;
            assert.equal(child.kill('SIGUSR2'), true);
          }
          if (!triggered && (detached ? detachedPid : output.join('').includes('READY') && kind.startsWith('SIG'))) {
            triggered = true;
            if (detachedPid) {
              const stat = (processGroupOf)(detachedPid);
              assert.equal(stat, detachedPid, 'the descendant owns a different process group');
              assert.notEqual(detachedPid, child.pid);
            }
            process.kill(process.pid, detached ? 'SIGTERM' : kind);
          }
        }
      });
    } catch (error) { failure = error; }
    const messages = error => [error?.message, ...(error?.errors ?? []).flatMap(messages)].filter(Boolean);
    const details = messages(failure).join('\\n');
    assert.ok(failure, 'the interrupted/timed-out phase must fail');
    assert.ok(exit, details || 'the fixture did not start');
    const state = await exit;
    assert.doesNotMatch(details, /no OS-held signal identity/);
    if (kind === 'unverifiable') assert.match(details, /cleanup also failed:.*stat became unreadable/);
    else assert.doesNotMatch(details, /cleanup also failed/);
    assert.doesNotMatch(output.join(''), /NATURAL_EXIT/);
    assert.ok(state.elapsed < 3500, 'cancellation must settle before the child natural-exit timer');
    if (kind === 'ignoring' || kind === 'unverifiable') assert.equal(state.signal, 'SIGKILL');
    else if (kind === 'output') assert.equal(state.code, 0);
    else assert.match(output.join(''), kind.startsWith('SIG') ? new RegExp('RECEIVED:' + kind) : /RECEIVED:SIGTERM/);
    if (detached) assert.match(output.join(''), /DETACHED_SIGTERM/);
    if (kind.startsWith('SIG') || kind === 'output' || detached || kind === 'unverifiable') assert.equal(startedNext, false);
    else assert.equal(startedNext, true, 'a settled timeout can proceed to the next selected phase');
    console.log('verified ' + kind);
  `;
  const privateDirectory =
    process.platform === "darwin" ? mkdtempSync(join(tmpdir(), "openwrangler-r-native-")) : undefined;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      env: privateDirectory ? { ...process.env, TMPDIR: privateDirectory } : process.env,
      encoding: "utf8",
      timeout: process.platform === "darwin" ? 35_000 : 10_000,
      maxBuffer: 128 * 1024
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`verified ${kind}`));
    if (privateDirectory) {
      assert.deepEqual(readdirSync(privateDirectory), [], "the settled helper must retire its private root");
      rmdirSync(privateDirectory);
    }
  } catch (error) {
    if (privateDirectory) error.message += `\nRetained private TMPDIR: ${privateDirectory}`;
    throw error;
  }
}

test(
  "POSIX runner defaults terminate owned work on signals, deadlines and excessive output",
  {
    skip: process.platform !== "linux" && process.platform !== "darwin"
  },
  async (context) => {
    const kinds = ["SIGINT", "SIGTERM", "timeout", "ignoring", "output", "detached"];
    if (process.platform === "linux") kinds.push("unverifiable", "late-detached");
    for (const kind of kinds) {
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
