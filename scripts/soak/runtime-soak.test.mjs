import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redactEditorAcceptanceJson } from "../editor-acceptance-evidence.mjs";
import { executeRuntimeSoak, runRuntimeSoakCli } from "./runtime-soak.mjs";
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
  writeFailureReceipt
} from "./soak-contract.mjs";

const subject = Object.freeze({
  kind: "source_tree",
  sourceCommit: "a".repeat(40),
  sourceTree: "b".repeat(40),
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
  constructor({ failAt, advance = () => undefined } = {}) {
    this.failAt = failAt;
    this.advance = advance;
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
    return true;
  }
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
    await assert.rejects(() => writeFailureReceipt(createSoakReceipt(receiptValue()), parent), SoakContractError);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a successful run exercises every branch without a success artifact or retry", async () => {
  let monotonicMs = 0;
  const adapter = new FakeAdapter({ advance: () => (monotonicMs += 10) });
  const result = await executeRuntimeSoak({
    options: { seed: 123, iterations: 4, durationSeconds: 0, wallSeconds: 60 },
    subject,
    tools,
    identifiers,
    adapter,
    clock: { epochMs: () => 1_776_470_400_000 + monotonicMs, monotonicMs: () => monotonicMs }
  });
  assert.equal(result.failure, undefined);
  assert.equal(result.receipt.envelope.payload.outcome, "success");
  assert.equal(adapter.closeCalls, 1);
  assert.equal(adapter.forceCloseCalls, 0);
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
