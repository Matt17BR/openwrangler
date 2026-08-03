import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  LINUX_STUDY_SUPERVISOR_INTERNALS,
  LINUX_STUDY_SUPERVISOR_INVOCATION_POLICY,
  LINUX_STUDY_SUPERVISOR_PROTOCOL,
  buildLinuxStudySupervisorInvocation,
  canonicalLinuxStudySupervisorJson,
  createBoundedLinuxStudySupervisorFrameReader,
  createLinuxStudySupervisorEnvironmentReceipt,
  createLinuxStudySupervisorSpawnAdapter,
  digestLinuxStudySupervisorValue
} from "./linux-study-supervisor-client.mjs";

const NONCE = "1".repeat(64);
const SOURCE = Object.freeze({
  sha256: "2".repeat(64),
  filesystemIdentity: Object.freeze({ device: "1", inode: "2", sizeBytes: 100, mtimeNs: "300" })
});
const PYTHON = Object.freeze({
  sha256: "3".repeat(64),
  filesystemIdentity: Object.freeze({ device: "1", inode: "3", sizeBytes: 200, mtimeNs: "400" })
});

test("Linux supervisor invocation digests bind ordered argv and a sorted environment", () => {
  const environment = { ZED: "last", ALPHA: "first", OMITTED: undefined };
  assert.deepEqual(createLinuxStudySupervisorEnvironmentReceipt(environment), [
    ["ALPHA", "first"],
    ["ZED", "last"]
  ]);
  const invocation = buildLinuxStudySupervisorInvocation({
    nonce: NONCE,
    environment,
    payloadArgv: ["/usr/bin/code", "--wait"]
  });
  assert.equal(invocation.payloadArgvSha256, digestLinuxStudySupervisorValue(["/usr/bin/code", "--wait"]));
  assert.equal(
    invocation.payloadEnvironmentSha256,
    digestLinuxStudySupervisorValue([
      ["ALPHA", "first"],
      ["ZED", "last"]
    ])
  );
  assert.equal(
    invocation.invocationPolicySha256,
    digestLinuxStudySupervisorValue(LINUX_STUDY_SUPERVISOR_INVOCATION_POLICY)
  );
  assert.deepEqual(invocation.supervisorArguments.slice(0, 9), [
    "--protocol",
    LINUX_STUDY_SUPERVISOR_PROTOCOL,
    "--nonce",
    NONCE,
    "--receipt-fd",
    "3",
    "--payload-environment-sha256",
    invocation.payloadEnvironmentSha256,
    "--"
  ]);
  assert.throws(() => createLinuxStudySupervisorEnvironmentReceipt({ "NOT-AN-ENV": "value" }), /invalid entry/u);
});

test("bounded supervisor framing rejects malformed, incomplete, oversized, and extra frames", async (t) => {
  await t.test("canonical frame pair", async () => {
    const stream = new PassThrough();
    const reader = createBoundedLinuxStudySupervisorFrameReader(stream);
    const one = { kind: "launch" };
    const two = { kind: "terminal-cleanup" };
    stream.end(`${canonicalLinuxStudySupervisorJson(one)}\n${canonicalLinuxStudySupervisorJson(two)}\n`);
    assert.deepEqual(await reader.nextFrame(), one);
    assert.deepEqual(await reader.nextFrame(), two);
    await reader.done;
  });

  for (const [name, payload, pattern, maximumBytes] of [
    ["malformed JSON", "{\n", /invalid JSON/u, undefined],
    ["non-canonical JSON", '{"z":1, "a":2}\n{}\n', /canonical JSON/u, undefined],
    ["incomplete final frame", "{}\n{}", /incomplete receipt/u, undefined],
    ["oversized frame", `${JSON.stringify({ value: "x".repeat(65) })}\n{}\n`, /byte limit/u, 32],
    ["extra frame", "{}\n{}\n{}\n", /extra receipt/u, undefined]
  ]) {
    await t.test(name, async () => {
      const stream = new PassThrough();
      const reader = createBoundedLinuxStudySupervisorFrameReader(stream, {
        ...(maximumBytes === undefined ? {} : { maximumBytes })
      });
      stream.end(payload);
      await assert.rejects(reader.done, pattern);
    });
  }

  await t.test("closed before any frame", async () => {
    const stream = new PassThrough();
    const reader = createBoundedLinuxStudySupervisorFrameReader(stream);
    stream.destroy();
    await assert.rejects(reader.done, /closed before its complete frame pair/u);
    await assert.rejects(reader.nextFrame(), /closed before its complete frame pair/u);
  });

  await t.test("closed after the launch frame", async () => {
    const stream = new PassThrough();
    const reader = createBoundedLinuxStudySupervisorFrameReader(stream);
    const launch = { kind: "launch" };
    stream.write(`${canonicalLinuxStudySupervisorJson(launch)}\n`);
    assert.deepEqual(await reader.nextFrame(), launch);
    stream.destroy();
    await assert.rejects(reader.done, /closed before its complete frame pair/u);
    await assert.rejects(reader.nextFrame(), /closed before its complete frame pair/u);
  });
});

test("the supervisor adapter seals the editor launch and returns correlated cleanup receipts", async () => {
  const environment = { PATH: "/usr/bin", TEST_VALUE: "one" };
  const processState = new Map([
    [70, processIdentity(70, 1, 70, 70, "700")],
    [71, processIdentity(71, 70, 71, 71, "710")]
  ]);
  let capturedSpawn;
  const child = fakeChild(70);
  const adapter = createLinuxStudySupervisorSpawnAdapter(
    { pythonExecutable: "/private/python", supervisorPath: "/private/supervisor.py", nonce: NONCE },
    {
      platform: "linux",
      captureInputs: () => ({ supervisorSource: SOURCE, pythonExecutable: PYTHON }),
      readProcessIdentity: (pid) => processState.get(pid) ?? null,
      spawnProcess: (executable, args, options) => {
        capturedSpawn = { executable, args, options };
        return child;
      }
    }
  );
  const returned = adapter.spawnProcess(
    "/usr/bin/code",
    ["/workspace", "--wait"],
    { detached: true, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    { platform: "linux" }
  );
  assert.equal(returned, child);
  assert.equal(capturedSpawn.executable, "/private/python");
  assert.deepEqual(capturedSpawn.options, {
    detached: true,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"]
  });
  const invocation = buildLinuxStudySupervisorInvocation({
    nonce: NONCE,
    environment,
    payloadArgv: ["/usr/bin/code", "/workspace", "--wait"]
  });
  assert.deepEqual(capturedSpawn.args, ["/private/supervisor.py", ...invocation.supervisorArguments]);

  const launch = launchReceipt(invocation);
  child.stdio[3].write(`${canonicalLinuxStudySupervisorJson(launch)}\n`);
  assert.deepEqual(await adapter.waitForLaunch(), launch);
  processState.clear();
  const terminal = terminalReceipt(launch, 0);
  child.stdio[3].end(`${canonicalLinuxStudySupervisorJson(terminal)}\n`);
  child.stdout.end();
  child.stderr.end();
  child.exitCode = 0;
  child.emit("close", 0, null);
  const completed = await adapter.waitForCompletion();
  assert.deepEqual(completed.launchReceipt, launch);
  assert.deepEqual(completed.terminalReceipt, terminal);
  assert.deepEqual(completed.exit, { code: 0, signal: null, error: undefined });
  assert.throws(
    () =>
      adapter.spawnProcess("/usr/bin/code", [], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      }),
    /only one editor tree/u
  );
});

test("the supervisor adapter rejects stale launch receipts and PID reuse after cleanup", async (t) => {
  await t.test("stale launch", async () => {
    const scenario = adapterScenario();
    scenario.start();
    const stale = { ...scenario.launch, nonce: "9".repeat(64) };
    scenario.child.stdio[3].write(`${canonicalLinuxStudySupervisorJson(stale)}\n`);
    await assert.rejects(scenario.adapter.waitForLaunch(), /stale or mis-correlated/u);
    scenario.child.stdio[3].destroy();
  });

  await t.test("PID reuse", async () => {
    const scenario = adapterScenario();
    scenario.start();
    scenario.child.stdio[3].write(`${canonicalLinuxStudySupervisorJson(scenario.launch)}\n`);
    await scenario.adapter.waitForLaunch();
    scenario.processState.set(71, processIdentity(71, 999, 71, 71, "9999"));
    const terminal = terminalReceipt(scenario.launch, 0);
    scenario.child.stdio[3].end(`${canonicalLinuxStudySupervisorJson(terminal)}\n`);
    scenario.child.stdout.end();
    scenario.child.stderr.end();
    scenario.child.exitCode = 0;
    scenario.child.emit("close", 0, null);
    await assert.rejects(scenario.adapter.waitForCompletion(), /not unambiguously absent/u);
  });
});

test("terminal receipt validation rejects supervisor-reported PID reuse", () => {
  const invocation = buildLinuxStudySupervisorInvocation({
    nonce: NONCE,
    environment: { PATH: "/usr/bin" },
    payloadArgv: ["/usr/bin/code"]
  });
  const launch = launchReceipt(invocation);
  const terminal = terminalReceipt(launch, 125);
  terminal.identityReuseEvents.push({
    pid: 71,
    previousStartTimeTicks: "710",
    replacementStartTimeTicks: "711"
  });
  assert.throws(
    () => LINUX_STUDY_SUPERVISOR_INTERNALS.validateTerminalReceipt(terminal, launch),
    /ownership became ambiguous/u
  );
});

test("terminal receipt validation rejects two retained identities for one PID", () => {
  const invocation = buildLinuxStudySupervisorInvocation({
    nonce: NONCE,
    environment: { PATH: "/usr/bin" },
    payloadArgv: ["/usr/bin/code"]
  });
  const launch = launchReceipt(invocation);
  const terminal = terminalReceipt(launch, 0);
  terminal.retainedOwnedIdentities.push({ pid: 71, startTimeTicks: "711", disposition: "exited" });
  assert.throws(
    () => LINUX_STUDY_SUPERVISOR_INTERNALS.validateTerminalReceipt(terminal, launch),
    /more than one identity for the same PID/u
  );
});

function adapterScenario() {
  const environment = { PATH: "/usr/bin" };
  const invocation = buildLinuxStudySupervisorInvocation({
    nonce: NONCE,
    environment,
    payloadArgv: ["/usr/bin/code"]
  });
  const processState = new Map([
    [70, processIdentity(70, 1, 70, 70, "700")],
    [71, processIdentity(71, 70, 71, 71, "710")]
  ]);
  const child = fakeChild(70);
  const adapter = createLinuxStudySupervisorSpawnAdapter(
    { pythonExecutable: "/private/python", supervisorPath: "/private/supervisor.py", nonce: NONCE },
    {
      platform: "linux",
      captureInputs: () => ({ supervisorSource: SOURCE, pythonExecutable: PYTHON }),
      readProcessIdentity: (pid) => processState.get(pid) ?? null,
      spawnProcess: () => child
    }
  );
  return {
    adapter,
    child,
    invocation,
    launch: launchReceipt(invocation),
    processState,
    start() {
      adapter.spawnProcess("/usr/bin/code", [], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
    }
  };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
  child.kill = () => true;
  return child;
}

function processIdentity(pid, parentPid, processGroupId, sessionId, startTimeTicks) {
  return { pid, parentPid, processGroupId, sessionId, startTimeTicks, state: "S" };
}

function launchReceipt(invocation) {
  return {
    protocol: LINUX_STUDY_SUPERVISOR_PROTOCOL,
    kind: "launch",
    nonce: invocation.nonce,
    supervisor: { pid: 70, startTimeTicks: "700", subreaperVerified: true, pidfdVerified: true },
    editorRoot: { pid: 71, startTimeTicks: "710", processGroupId: 71, sessionId: 71 },
    supervisorSource: SOURCE,
    pythonExecutable: {
      implementation: "CPython",
      version: "3.12.13",
      sha256: PYTHON.sha256,
      filesystemIdentity: PYTHON.filesystemIdentity
    },
    invocationPolicySha256: invocation.invocationPolicySha256,
    invocationSha256: invocation.invocationSha256,
    payloadArgvSha256: invocation.payloadArgvSha256,
    payloadEnvironmentSha256: invocation.payloadEnvironmentSha256
  };
}

function terminalReceipt(launch, exitCode) {
  return {
    protocol: LINUX_STUDY_SUPERVISOR_PROTOCOL,
    kind: "terminal-cleanup",
    nonce: launch.nonce,
    supervisor: { pid: launch.supervisor.pid, startTimeTicks: launch.supervisor.startTimeTicks },
    editorRoot: { pid: launch.editorRoot.pid, startTimeTicks: launch.editorRoot.startTimeTicks },
    retainedOwnedIdentities: [
      { pid: launch.editorRoot.pid, startTimeTicks: launch.editorRoot.startTimeTicks, disposition: "exited" }
    ],
    identityReuseEvents: [],
    emptyCensusProof: {
      requiredConsecutiveChecks: 3,
      checks: ["100", "200", "300"].map((monotonicNanoseconds) => ({
        monotonicNanoseconds,
        ownedProcessCount: 0
      }))
    },
    supervisorExitCode: exitCode
  };
}
