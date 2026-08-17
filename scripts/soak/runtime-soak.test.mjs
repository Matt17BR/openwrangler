import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { redactEditorAcceptanceJson } from "../editor-acceptance-evidence.mjs";
import {
  BoundedLfFramer,
  createSourceAttestation,
  executeRuntimeSoak,
  PythonRuntimeSoakAdapter,
  runRuntimeSoakCli,
  RuntimeServer
} from "./runtime-soak.mjs";
import {
  createScenarioSelector,
  createSoakReceipt,
  parseSoakArguments,
  sha256Hex,
  SOAK_MAX_RECEIPT_BYTES,
  SOAK_PRNG,
  SOAK_RECEIPT_SCHEMA,
  SOAK_SCENARIOS,
  SOAK_SCENARIO_SET_SHA256,
  SoakContractError,
  SoakRunError,
  assertFailureReceiptForEmission,
  writeFailureReceipt
} from "./soak-contract.mjs";

const subject = Object.freeze({
  kind: "source_tree",
  sourceCommit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  executedInventorySha256: "e".repeat(64),
  packageManifestSha256: "c".repeat(64),
  dependencyLockSha256: "d".repeat(64)
});
const tools = Object.freeze({
  platform: "linux",
  nodeVersion: "22.22.0",
  pythonVersion: "3.13.7",
  runtimeVersion: "1.99.7",
  backend: "pandas",
  backendVersion: "2.3.2"
});
const identifiers = Object.freeze({
  runId: "01234567-89ab-4cde-8f01-23456789abcd",
  jobId: "11234567-89ab-4cde-8f01-23456789abcd"
});

function branchCounts(count = 1) {
  return SOAK_SCENARIOS.map((scenario) => ({ scenario, count }));
}

function receiptValue(outcome = "success") {
  return {
    outcome,
    subject,
    tools,
    run: {
      ...identifiers,
      prng: SOAK_PRNG,
      seed: 123,
      scenarioSetSha256: SOAK_SCENARIO_SET_SHA256,
      requestedIterations: 4,
      requestedDurationSeconds: 0,
      wallSeconds: 60,
      completedIterations: 4,
      startedAt: "2026-08-16T00:00:00.000Z",
      endedAt: "2026-08-16T00:00:01.000Z",
      elapsedMs: 1_000,
      branches: branchCounts()
    },
    ...(outcome === "failure" ? { failure: { code: "scenario_failed", phase: "open_page_close", iteration: 4 } } : {})
  };
}

class FakeAdapter {
  constructor({ failAt, advance = () => undefined, cleanupConfirmed = true } = {}) {
    this.failAt = failAt;
    this.advance = advance;
    this.cleanupConfirmed = cleanupConfirmed;
    this.calls = [];
    this.closeCalls = 0;
    this.forceCloseCalls = 0;
    this.runtimeVersion = "1.99.7";
  }

  async initialize() {
    this.initialized = true;
  }

  async runScenario(scenario) {
    this.calls.push(scenario);
    this.advance();
    if (this.calls.length === this.failAt) throw new SoakRunError("scenario_failed", scenario);
  }

  async close() {
    this.closeCalls += 1;
  }

  async forceClose() {
    this.forceCloseCalls += 1;
    return this.cleanupConfirmed;
  }
}

async function writeFixture(root, relativePath, contents = "fixture\n") {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function createAttestationFixture() {
  const root = await mkdtemp(join(tmpdir(), "openwrangler-soak-source-"));
  const fixtures = new Map([
    [
      "package.json",
      `${JSON.stringify({ scripts: { "test:scripts:portable": "node --test scripts/soak/runtime-soak.test.mjs" } })}\n`
    ],
    ["package-lock.json", "{}\n"],
    ["scripts/editor-acceptance-evidence.mjs", 'import "./strict-json.mjs";\n'],
    ["scripts/packaged-python-preflight.mjs", "export const preflight = true;\n"],
    ["scripts/strict-json.mjs", 'import "../src/shared/strictJson.cjs";\n'],
    ["src/shared/strictJson.cjs", "module.exports = {};\n"],
    ["scripts/soak/runtime-soak.mjs", 'import "../packaged-python-preflight.mjs";\nimport "./soak-contract.mjs";\n'],
    ["scripts/soak/runtime-soak.test.mjs", 'import "./runtime-soak.mjs";\n'],
    ["scripts/soak/soak-contract.mjs", 'import "../editor-acceptance-evidence.mjs";\n'],
    ["python/openwrangler_runtime/__init__.py", "# package\n"],
    ["python/openwrangler_runtime/server.py", "# server\n"]
  ]);
  for (const [path, contents] of fixtures) await writeFixture(root, path, contents);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Soak Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "soak@example.invalid"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  return root;
}

test("argument bounds are canonical and preserve the printed deterministic defaults", () => {
  assert.deepEqual(parseSoakArguments([]), {
    seed: 1_592_639_710,
    iterations: 1_000,
    durationSeconds: 3_600,
    wallSeconds: 3_660
  });
  assert.deepEqual(
    parseSoakArguments(["--seed", "0", "--iterations", "4", "--duration-seconds", "0", "--wall-seconds", "1"]),
    { seed: 0, iterations: 4, durationSeconds: 0, wallSeconds: 1 }
  );
  for (const args of [
    ["--seed", "01"],
    ["--seed", "4294967296"],
    ["--iterations", "3"],
    ["--duration-seconds", "60", "--wall-seconds", "60"],
    ["--wall-seconds"],
    ["--unknown", "1"],
    ["--seed", "1", "--seed", "2"]
  ]) {
    assert.throws(() => parseSoakArguments(args), SoakContractError);
  }
});

test("the CLI help and invalid-argument paths perform no runtime work", async () => {
  const stdout = [];
  const stderr = [];
  assert.equal(
    await runRuntimeSoakCli(["--help"], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    }),
    0
  );
  assert.equal(stdout.length, 1);
  assert.match(stdout[0], /local-only/u);
  assert.deepEqual(stderr, []);

  assert.equal(
    await runRuntimeSoakCli(["--iterations", "3"], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    }),
    2
  );
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /Usage:/u);
});

test("the fixed PRNG seed creates deterministic epochs that each cover every scenario", () => {
  const first = createScenarioSelector(0x5eedc0de);
  const second = createScenarioSelector(0x5eedc0de);
  const firstCases = Array.from({ length: 12 }, () => first.next());
  const secondCases = Array.from({ length: 12 }, () => second.next());
  assert.deepEqual(firstCases, secondCases);
  for (let offset = 0; offset < firstCases.length; offset += SOAK_SCENARIOS.length) {
    assert.deepEqual([...firstCases.slice(offset, offset + SOAK_SCENARIOS.length)].sort(), [...SOAK_SCENARIOS].sort());
  }
});

test("raw LF framing bounds bytes before decode and accepts split UTF-8", async () => {
  const stream = new PassThrough();
  const framer = new BoundedLfFramer(stream, 8);
  const encoded = Buffer.from("é\n", "utf8");
  stream.write(encoded.subarray(0, 1));
  stream.write(encoded.subarray(1));
  assert.deepEqual(await framer.next(), { kind: "line", value: "é" });
  assert.ok(framer.bufferedBytesForTesting().maximum <= 8);
  stream.end();
  assert.deepEqual(await framer.next(), { kind: "end" });
});

test("raw LF framing rejects oversized, invalid, unsupported, and partial frames exactly once", async () => {
  const oversized = new PassThrough();
  const oversizedFramer = new BoundedLfFramer(oversized, 8);
  oversized.write(Buffer.alloc(1_024, 0x61));
  assert.deepEqual(await oversizedFramer.next(), { kind: "invalid" });
  assert.deepEqual(oversizedFramer.bufferedBytesForTesting(), { current: 0, maximum: 0 });
  oversized.end(Buffer.from("\n"));
  assert.deepEqual(await oversizedFramer.next(), { kind: "end" });

  const invalidUtf8 = new PassThrough();
  const invalidUtf8Framer = new BoundedLfFramer(invalidUtf8, 8);
  invalidUtf8.end(Buffer.from([0xc3, 0x28, 0x0a]));
  assert.deepEqual(await invalidUtf8Framer.next(), { kind: "invalid" });
  assert.deepEqual(await invalidUtf8Framer.next(), { kind: "end" });

  const partial = new PassThrough();
  const partialFramer = new BoundedLfFramer(partial, 8);
  partial.end("partial");
  assert.deepEqual(await partialFramer.next(), { kind: "invalid" });
  assert.deepEqual(await partialFramer.next(), { kind: "end" });

  const unsupported = new EventEmitter();
  const unsupportedFramer = new BoundedLfFramer(unsupported, 8);
  unsupported.emit("data", { arbitrary: true });
  assert.deepEqual(await unsupportedFramer.next(), { kind: "invalid" });
  unsupported.emit("end");
  assert.deepEqual(await unsupportedFramer.next(), { kind: "end" });
});

test("source attestation rejects dirty runtime, dirty harness, and untracked shadowing", async () => {
  const root = await createAttestationFixture();
  const privateRoot = await mkdtemp(join(tmpdir(), "openwrangler-soak-materialized-"));
  try {
    const attestation = await createSourceAttestation(root, privateRoot);
    assert.match(attestation.subject.executedInventorySha256, /^[a-f0-9]{64}$/u);
    assert.match(
      await readFile(join(attestation.runtimePythonRoot, "openwrangler_runtime", "server.py"), "utf8"),
      /server/u
    );

    const runtimePath = join(root, "python", "openwrangler_runtime", "server.py");
    const runtimeSource = await readFile(runtimePath, "utf8");
    await writeFile(runtimePath, `${runtimeSource}# dirty\n`, "utf8");
    await assert.rejects(attestation.revalidate, SoakContractError);
    await writeFile(runtimePath, runtimeSource, "utf8");

    const harnessPath = join(root, "scripts", "soak", "runtime-soak.mjs");
    const harnessSource = await readFile(harnessPath, "utf8");
    await writeFile(harnessPath, `${harnessSource}// dirty\n`, "utf8");
    await assert.rejects(attestation.revalidate, SoakContractError);
    await writeFile(harnessPath, harnessSource, "utf8");

    const transitivePath = join(root, "src", "shared", "strictJson.cjs");
    const transitiveSource = await readFile(transitivePath, "utf8");
    await writeFile(transitivePath, `${transitiveSource}// dirty\n`, "utf8");
    await assert.rejects(attestation.revalidate, SoakContractError);
    await writeFile(transitivePath, transitiveSource.replace("{}", "{x:1}"), "utf8");
    await assert.rejects(attestation.revalidate, SoakContractError);
    await writeFile(transitivePath, transitiveSource, "utf8");

    if (process.platform !== "win32") {
      const replacementPath = join(root, "strict-json-replacement.cjs");
      await writeFile(replacementPath, transitiveSource, "utf8");
      await rename(transitivePath, `${transitivePath}.tracked`);
      await symlink(replacementPath, transitivePath);
      await assert.rejects(attestation.revalidate, SoakContractError);
      await rm(transitivePath);
      await rename(`${transitivePath}.tracked`, transitivePath);
    }

    await writeFixture(root, "python/openwrangler_runtime/shadow.py", "raise RuntimeError('shadow')\n");
    await assert.rejects(() => createSourceAttestation(root, privateRoot), SoakContractError);
    await assert.rejects(attestation.revalidate, SoakContractError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("source attestation rejects a future relative import outside its exact executable closure", async () => {
  const root = await createAttestationFixture();
  const privateRoot = await mkdtemp(join(tmpdir(), "openwrangler-soak-materialized-"));
  try {
    await writeFixture(root, "src/shared/unbound.cjs", "module.exports = {};\n");
    const strictPath = join(root, "scripts", "strict-json.mjs");
    await writeFile(
      strictPath,
      'import "../src/shared/strictJson.cjs";\nimport "../src/shared/unbound.cjs";\n',
      "utf8"
    );
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "add unbound import"]);
    await assert.rejects(() => createSourceAttestation(root, privateRoot), SoakContractError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("source attestation freezes the exact portable owner-test registration", async () => {
  const root = await createAttestationFixture();
  const privateRoot = await mkdtemp(join(tmpdir(), "openwrangler-soak-materialized-"));
  try {
    await writeFixture(
      root,
      "package.json",
      `${JSON.stringify({ scripts: { "test:scripts:portable": "node --test scripts/soak/runtime-soak-mutant.test.mjs" } })}\n`
    );
    execFileSync("git", ["-C", root, "add", "package.json"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "mutate portable owner"]);
    await assert.rejects(() => createSourceAttestation(root, privateRoot), SoakContractError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("stop timeout retains ownership through one kill and exact late-or-never exit settlement", async () => {
  class FakeChild extends EventEmitter {
    constructor(exitAfterKillMs) {
      super();
      this.exitAfterKillMs = exitAfterKillMs;
      this.exitCode = null;
      this.signalCode = null;
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.killCalls = 0;
    }

    kill() {
      this.killCalls += 1;
      if (this.exitAfterKillMs !== undefined) {
        setTimeout(() => {
          this.signalCode = "SIGKILL";
          this.emit("exit", null, "SIGKILL");
          this.stdout.end();
          this.stderr.end();
        }, this.exitAfterKillMs);
      }
      return true;
    }
  }

  const late = new FakeChild(1);
  const lateServer = new RuntimeServer("python", tmpdir(), tmpdir(), undefined, {
    spawnProcess: () => late,
    stopTimeoutMs: 20
  });
  assert.deepEqual(await lateServer.stop("cleanup"), { settled: true, clean: false });
  assert.equal(late.killCalls, 1);

  const never = new FakeChild(undefined);
  const neverServer = new RuntimeServer("python", tmpdir(), tmpdir(), undefined, {
    spawnProcess: () => never,
    stopTimeoutMs: 5
  });
  assert.deepEqual(await neverServer.stop("cleanup"), { settled: false, clean: false });
  assert.equal(await neverServer.forceStop(), false);
  assert.equal(never.killCalls, 1);
  never.stdout.end();
  never.stderr.end();
});

test("only pre-spawn failure or actual exit and close attest process settlement", async () => {
  class SettlementChild extends EventEmitter {
    constructor({ killResult = false, errorOnKill = false } = {}) {
      super();
      this.exitCode = null;
      this.signalCode = null;
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.killResult = killResult;
      this.errorOnKill = errorOnKill;
      this.killCalls = 0;
    }

    kill() {
      this.killCalls += 1;
      if (this.errorOnKill) queueMicrotask(() => this.emit("error", new Error("kill failed")));
      return this.killResult;
    }

    finish() {
      this.stdout.end();
      this.stderr.end();
    }
  }

  const preSpawn = new SettlementChild();
  const preSpawnServer = new RuntimeServer("python", tmpdir(), tmpdir(), undefined, {
    spawnProcess: () => preSpawn,
    stopTimeoutMs: 10
  });
  preSpawn.emit("error", new Error("spawn failed"));
  assert.equal(await preSpawnServer.forceStop(), true);
  assert.equal(preSpawn.killCalls, 0);
  preSpawn.finish();

  const delayedExit = new SettlementChild({ errorOnKill: true });
  const delayedServer = new RuntimeServer("python", tmpdir(), tmpdir(), undefined, {
    spawnProcess: () => delayedExit,
    stopTimeoutMs: 20
  });
  delayedExit.emit("spawn");
  let delayedSettled = false;
  const delayedSettlement = delayedServer.forceStop().then((value) => {
    delayedSettled = true;
    return value;
  });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(delayedSettled, false);
  delayedExit.signalCode = "SIGKILL";
  delayedExit.emit("close", null, "SIGKILL");
  assert.equal(await delayedSettlement, true);
  assert.equal(delayedExit.killCalls, 1);
  delayedExit.finish();

  const failedKill = new SettlementChild({ errorOnKill: true });
  const failedKillServer = new RuntimeServer("python", tmpdir(), tmpdir(), undefined, {
    spawnProcess: () => failedKill,
    stopTimeoutMs: 5
  });
  failedKill.emit("spawn");
  assert.equal(await failedKillServer.forceStop(), false);
  assert.equal(failedKill.killCalls, 1);
  failedKill.finish();
});

test("one absolute deadline is recomputed before every multi-step scenario request", async () => {
  let monotonicMs = 100;
  const timeouts = [];
  const adapter = new PythonRuntimeSoakAdapter({
    executable: "python",
    workingRoot: tmpdir(),
    runtimePythonRoot: tmpdir(),
    sourcePath: join(tmpdir(), "soak.csv"),
    seed: 123,
    signal: undefined
  });
  adapter.server = {
    async request(request, _phase, timeoutMs) {
      timeouts.push(timeoutMs);
      monotonicMs += 250;
      if (request.kind === "openSession") {
        return {
          kind: "sessionOpened",
          metadata: { sessionId: request.requestedSessionId, backend: "pandas", revision: 0 }
        };
      }
      if (request.kind === "getPage") return { kind: "page" };
      if (request.kind === "closeSession") return { kind: "sessionClosed" };
      throw new Error("unexpected request");
    }
  };
  await adapter.runScenario("open_page_close", 1, () => 1_000 - monotonicMs);
  assert.deepEqual(timeouts, [900, 650, 400]);
});

test("receipt serialization is deterministic, bounded, checksummed, and rejects free-form containers", () => {
  const first = createSoakReceipt(receiptValue());
  const second = createSoakReceipt(receiptValue());
  assert.equal(first.json, second.json);
  assert.ok(first.byteLength <= SOAK_MAX_RECEIPT_BYTES);
  assert.equal(first.envelope.schema, SOAK_RECEIPT_SCHEMA);
  assert.equal(first.envelope.payloadSha256, sha256Hex(JSON.stringify(first.envelope.payload)));
  assert.equal(first.json.includes("PRIVATE-CANARY"), false);

  for (const mutation of [
    { ...receiptValue(), path: "/private/workspace" },
    { ...receiptValue(), message: "PRIVATE-CANARY" },
    { ...receiptValue(), tools: { ...tools, environment: { TOKEN: "PRIVATE-CANARY" } } },
    { ...receiptValue(), run: { ...receiptValue().run, runId: "credential=PRIVATE-CANARY" } },
    { ...receiptValue(), run: { ...receiptValue().run, runId: "秘密" } },
    {
      ...receiptValue(),
      run: {
        ...receiptValue().run,
        startedAt: "2026-08-16T00:00:01.000Z",
        endedAt: "2026-08-16T00:00:00.000Z"
      }
    },
    { ...receiptValue(), run: { ...receiptValue().run, wallSeconds: 1, elapsedMs: 1_001 } },
    { ...receiptValue(), run: { ...receiptValue().run, branches: [...branchCounts()].reverse() } }
  ]) {
    assert.throws(() => createSoakReceipt(mutation), SoakContractError);
  }
  const cyclic = receiptValue();
  cyclic.cycle = cyclic;
  assert.throws(() => createSoakReceipt(cyclic), SoakContractError);
});

test("one failure receipt is private, schema-valid, re-redacted, bounded, and secret-free", async () => {
  const parent = await mkdtemp(join(tmpdir(), "openwrangler-soak-test-"));
  try {
    const receipt = createSoakReceipt(receiptValue("failure"));
    const retained = await writeFailureReceipt(receipt, parent);
    const text = await readFile(retained.path, "utf8");
    assert.ok(Buffer.byteLength(text, "utf8") <= SOAK_MAX_RECEIPT_BYTES);
    assert.equal(text.includes("PRIVATE-CANARY"), false);
    assert.equal(redactEditorAcceptanceJson(text, [], SOAK_MAX_RECEIPT_BYTES)?.trim(), text.trim());
    const parsed = JSON.parse(text);
    assert.equal(parsed.schema, SOAK_RECEIPT_SCHEMA);
    assert.equal(parsed.payloadSha256, sha256Hex(JSON.stringify(parsed.payload)));
    assert.equal(retained.sha256, sha256Hex(text));
    assert.equal(retained.file.nlink, 1n);
    await assertFailureReceiptForEmission(retained);
    await assert.rejects(() => writeFailureReceipt(createSoakReceipt(receiptValue()), parent), SoakContractError);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("failure-receipt seal rejects content, link, path, and parent mutations before emission", async () => {
  const parent = await mkdtemp(join(tmpdir(), "openwrangler-soak-seal-test-"));
  const createRetained = () => writeFailureReceipt(createSoakReceipt(receiptValue("failure")), parent);
  try {
    const contentMutation = await createRetained();
    const original = await readFile(contentMutation.path, "utf8");
    await writeFile(contentMutation.path, original.replace("scenario_failed", "iteration_limit"), "utf8");
    await assert.rejects(() => assertFailureReceiptForEmission(contentMutation), SoakContractError);

    const linkMutation = await createRetained();
    await link(linkMutation.path, `${linkMutation.path}.linked`);
    await assert.rejects(() => assertFailureReceiptForEmission(linkMutation), SoakContractError);

    const pathMutation = await createRetained();
    const parkedPath = `${pathMutation.path}.parked`;
    const pathContents = await readFile(pathMutation.path);
    await rename(pathMutation.path, parkedPath);
    await writeFile(pathMutation.path, pathContents, { mode: 0o600 });
    await assert.rejects(() => assertFailureReceiptForEmission(pathMutation), SoakContractError);

    if (process.platform !== "win32") {
      const symlinkMutation = await createRetained();
      const symlinkTarget = `${symlinkMutation.path}.target`;
      await rename(symlinkMutation.path, symlinkTarget);
      await symlink(symlinkTarget, symlinkMutation.path);
      await assert.rejects(() => assertFailureReceiptForEmission(symlinkMutation), SoakContractError);
    }

    const parentMutation = await createRetained();
    const root = dirname(parentMutation.path);
    const parkedRoot = `${root}.parked`;
    await rename(root, parkedRoot);
    await mkdir(root, { mode: 0o700 });
    await assert.rejects(() => assertFailureReceiptForEmission(parentMutation), SoakContractError);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the portable owner inventory names this exact test once", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const command = manifest.scripts?.["test:scripts:portable"];
  assert.equal(command.split(/\s+/u).filter((token) => token === "scripts/soak/runtime-soak.test.mjs").length, 1);
});

test("a successful run exercises every branch without a success artifact or retry", async () => {
  let monotonicMs = 0;
  let revalidations = 0;
  const adapter = new FakeAdapter({ advance: () => (monotonicMs += 10) });
  const result = await executeRuntimeSoak({
    options: { seed: 123, iterations: 4, durationSeconds: 0, wallSeconds: 60 },
    subject,
    tools,
    identifiers,
    adapter,
    clock: { epochMs: () => 1_776_470_400_000 + monotonicMs, monotonicMs: () => monotonicMs },
    beforeReceipt: async () => {
      revalidations += 1;
    }
  });
  assert.equal(result.failure, undefined);
  assert.equal(result.receipt.envelope.payload.outcome, "success");
  assert.equal(adapter.closeCalls, 1);
  assert.equal(adapter.forceCloseCalls, 0);
  assert.equal(revalidations, 1);
  assert.equal(adapter.calls.length, 4);
  assert.deepEqual([...adapter.calls].sort(), [...SOAK_SCENARIOS].sort());
  assert.deepEqual(
    result.receipt.envelope.payload.run.branches,
    SOAK_SCENARIOS.map((scenario) => ({ scenario, count: 1 }))
  );
});

test("the first classified failure stops immediately and performs cleanup without retry", async () => {
  let monotonicMs = 0;
  const adapter = new FakeAdapter({ failAt: 2, advance: () => (monotonicMs += 10) });
  const result = await executeRuntimeSoak({
    options: { seed: 123, iterations: 8, durationSeconds: 0, wallSeconds: 60 },
    subject,
    tools,
    identifiers,
    adapter,
    clock: { epochMs: () => 1_776_470_400_000 + monotonicMs, monotonicMs: () => monotonicMs }
  });
  assert.equal(result.failure?.code, "scenario_failed");
  assert.equal(result.failure?.iteration, 2);
  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.closeCalls, 0);
  assert.equal(adapter.forceCloseCalls, 1);
  assert.equal(result.receipt.envelope.payload.run.completedIterations, 1);
  assert.equal(result.retentionAllowed, true);
});

test("source revalidation failure emits no receipt after confirmed cleanup", async () => {
  let monotonicMs = 0;
  const adapter = new FakeAdapter({ advance: () => (monotonicMs += 10) });
  await assert.rejects(
    () =>
      executeRuntimeSoak({
        options: { seed: 123, iterations: 4, durationSeconds: 0, wallSeconds: 60 },
        subject,
        tools,
        identifiers,
        adapter,
        clock: { epochMs: () => 1_776_470_400_000 + monotonicMs, monotonicMs: () => monotonicMs },
        beforeReceipt: async () => {
          throw new SoakContractError("source changed");
        }
      }),
    SoakContractError
  );
  assert.equal(adapter.closeCalls, 1);
  assert.equal(adapter.forceCloseCalls, 0);
});

test("cleanup uncertainty prevents failure-receipt retention and does not retry", async () => {
  let monotonicMs = 0;
  const adapter = new FakeAdapter({
    failAt: 1,
    advance: () => (monotonicMs += 10),
    cleanupConfirmed: false
  });
  const result = await executeRuntimeSoak({
    options: { seed: 123, iterations: 4, durationSeconds: 0, wallSeconds: 60 },
    subject,
    tools,
    identifiers,
    adapter,
    clock: { epochMs: () => 1_776_470_400_000 + monotonicMs, monotonicMs: () => monotonicMs }
  });
  assert.equal(result.failure?.code, "cleanup_failed");
  assert.equal(result.retentionAllowed, false);
  assert.equal(result.receipt, undefined);
  assert.equal(adapter.forceCloseCalls, 1);
  assert.equal(adapter.calls.length, 1);
});

test("cleanup uncertainty transfers live-root ownership before attestation can throw", async () => {
  const liveRoot = await mkdtemp(join(tmpdir(), "openwrangler-soak-live-root-"));
  let ownsRoot = true;
  let deletedLiveRoot = false;
  let revalidations = 0;
  try {
    let result;
    try {
      const adapter = new FakeAdapter({ failAt: 1, cleanupConfirmed: false });
      result = await executeRuntimeSoak({
        options: { seed: 123, iterations: 4, durationSeconds: 0, wallSeconds: 60 },
        subject,
        tools,
        identifiers,
        adapter,
        clock: { epochMs: () => 1_776_470_400_000, monotonicMs: () => 0 },
        beforeReceipt: async () => {
          revalidations += 1;
          throw new SoakContractError("must not run");
        },
        onCleanupUncertain: () => {
          ownsRoot = false;
        }
      });
    } finally {
      if (ownsRoot) {
        deletedLiveRoot = true;
        await rm(liveRoot, { recursive: true, force: true });
      }
    }
    assert.equal(result.retentionAllowed, false);
    assert.equal(result.receipt, undefined);
    assert.equal(revalidations, 0);
    assert.equal(deletedLiveRoot, false);
    assert.equal((await lstat(liveRoot)).isDirectory(), true);
  } finally {
    await rm(liveRoot, { recursive: true, force: true });
  }
});

test("the run continues past its minimum iterations until the requested duration is satisfied", async () => {
  let monotonicMs = 0;
  const adapter = new FakeAdapter({ advance: () => (monotonicMs += 300) });
  const result = await executeRuntimeSoak({
    options: { seed: 123, iterations: 4, durationSeconds: 2, wallSeconds: 3 },
    subject,
    tools,
    identifiers,
    adapter,
    clock: { epochMs: () => 1_776_470_400_000 + monotonicMs, monotonicMs: () => monotonicMs }
  });
  assert.equal(result.failure, undefined);
  assert.equal(result.receipt.envelope.payload.run.completedIterations, 7);
  assert.equal(result.receipt.envelope.payload.run.elapsedMs, 2_100);
  assert.equal(adapter.calls.length, 7);
});

test("wall expiry is non-green and does not start another scenario", async () => {
  let monotonicMs = 0;
  const adapter = new FakeAdapter({ advance: () => (monotonicMs += 1_100) });
  const result = await executeRuntimeSoak({
    options: { seed: 123, iterations: 8, durationSeconds: 0, wallSeconds: 1 },
    subject,
    tools,
    identifiers,
    adapter,
    clock: { epochMs: () => 1_776_470_400_000 + monotonicMs, monotonicMs: () => monotonicMs }
  });
  assert.equal(result.failure?.code, "deadline_exceeded");
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.forceCloseCalls, 1);
});
