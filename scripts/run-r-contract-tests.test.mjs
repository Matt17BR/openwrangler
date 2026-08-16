import assert from "node:assert/strict";
import test from "node:test";
import {
  R_CONTRACT_SHARDS,
  createRContractPhases,
  runRContractPhase,
  selectRContractPhases
} from "./run-r-contract-tests.mjs";

function phases() {
  return createRContractPhases({
    environment: { PATH: "/reviewed/bin" },
    node: "/reviewed/node",
    r: "/reviewed/R",
    rscript: "/reviewed/Rscript",
    vitest: "/reviewed/vitest.mjs"
  });
}

test("native R contracts use named per-subsystem deadlines without dropping or duplicating tests", () => {
  const configured = phases();
  assert.deepEqual(
    configured.map(({ id, label, timeoutMs, workloadMs }) => [id, label, timeoutMs, workloadMs]),
    [
      ["frame", "native frame contract", 120_000, 31_000],
      ["kernel-agent", "native kernel-agent contract", 360_000, 348_000],
      ["catalog", "complete native catalog contract", 120_000, 45_000],
      ["typescript", "TypeScript R frame and unit contracts", 60_000, 11_000],
      ["kernel-transport", "real-R kernel transport contract", 90_000, 56_000],
      ["process-transport", "real-R process transport contract", 90_000, 40_000],
      ["interactive-transport", "real-R interactive transport contract", 60_000, 11_000]
    ]
  );
  for (const phase of configured) {
    assert.ok(phase.workloadMs > 0);
    assert.ok(phase.workloadMs <= phase.timeoutMs);
  }

  const direct = configured.slice(0, 3);
  assert.deepEqual(
    direct.map(({ command, args }) => [command, ...args]),
    [
      ["/reviewed/Rscript", "--vanilla", "r/tests/frame_contract.R"],
      ["/reviewed/Rscript", "--vanilla", "r/tests/kernel_agent.R"],
      ["/reviewed/Rscript", "--vanilla", "r/tests/complete_catalog_contract.R"]
    ]
  );

  const vitest = configured.slice(3);
  const files = vitest.flatMap(({ args }) => args.filter((value) => value.startsWith("src/test/")));
  assert.deepEqual(files.sort(), [
    "src/test/rFrameContract.cross.test.ts",
    "src/test/rFrameContract.unit.test.ts",
    "src/test/rInteractiveSessionTransport.cross.test.ts",
    "src/test/rKernelTransport.cross.test.ts",
    "src/test/rKernelTransport.unit.test.ts",
    "src/test/rProcessTransport.cross.test.ts"
  ]);
  for (const phase of vitest) {
    assert.equal(phase.command, "/reviewed/node");
    assert.equal(phase.args[0], "/reviewed/vitest.mjs");
    assert.deepEqual(phase.args.slice(-1), ["--maxWorkers=1"]);
    assert.equal(phase.environment.OPEN_WRANGLER_R_CONTRACT_TESTS, "1");
  }
});

test("native R shards are an exhaustive disjoint workload-aware partition", () => {
  const configured = phases();
  const configuredIds = configured.map(({ id }) => id);
  const shardedIds = R_CONTRACT_SHARDS.flatMap(({ phaseIds }) => phaseIds);
  assert.equal(new Set(shardedIds).size, shardedIds.length);
  assert.deepEqual([...shardedIds].sort(), [...configuredIds].sort());
  assert.deepEqual(
    R_CONTRACT_SHARDS.map(({ id, phaseIds }) => [
      id,
      phaseIds,
      phaseIds.reduce((total, phaseId) => total + configured.find((phase) => phase.id === phaseId).workloadMs, 0)
    ]),
    [
      ["kernel-agent", ["kernel-agent"], 348_000],
      ["frame-transport", ["frame", "kernel-transport", "interactive-transport"], 98_000],
      ["catalog-transport", ["catalog", "typescript", "process-transport"], 96_000]
    ]
  );
});

test("native R phase and shard selection is exact and preserves canonical order", () => {
  const configured = phases();
  assert.strictEqual(selectRContractPhases(configured, []), configured);
  assert.deepEqual(
    selectRContractPhases(configured, ["--shard=frame-transport"]).map(({ id }) => id),
    ["frame", "kernel-transport", "interactive-transport"]
  );
  assert.deepEqual(
    selectRContractPhases(configured, ["--phase=process-transport", "--phase=frame"]).map(({ id }) => id),
    ["frame", "process-transport"]
  );
  assert.deepEqual(
    selectRContractPhases(configured, ["--shard=kernel-agent"]).map(({ command, args }) => [command, ...args]),
    [["/reviewed/Rscript", "--vanilla", "r/tests/kernel_agent.R"]]
  );
  assert.deepEqual(
    selectRContractPhases(
      configured,
      R_CONTRACT_SHARDS.map(({ id }) => `--shard=${id}`)
    ).map(({ id }) => id),
    configured.map(({ id }) => id)
  );
});

test("native R selection rejects invalid, duplicate, overlapping, and empty selectors", () => {
  const configured = phases();
  assert.throws(() => selectRContractPhases(configured, ["--phase="]), /phase selection must not be empty/u);
  assert.throws(() => selectRContractPhases(configured, ["--shard="]), /shard selection must not be empty/u);
  assert.throws(() => selectRContractPhases(configured, ["--phase=missing"]), /Unknown R contract phase: missing/u);
  assert.throws(() => selectRContractPhases(configured, ["--shard=missing"]), /Unknown R contract shard: missing/u);
  assert.throws(() => selectRContractPhases(configured, ["--phase"]), /Invalid R contract selection/u);
  assert.throws(() => selectRContractPhases(configured, ["frame"]), /Invalid R contract selection/u);
  assert.throws(
    () => selectRContractPhases(configured, ["--phase=frame", "--phase=frame"]),
    /Duplicate R contract selection/u
  );
  assert.throws(
    () => selectRContractPhases(configured, ["--shard=kernel-agent", "--shard=kernel-agent"]),
    /Duplicate R contract selection/u
  );
  assert.throws(
    () => selectRContractPhases(configured, ["--shard=frame-transport", "--phase=frame"]),
    /phase frame was selected more than once/u
  );
});

test("native R phase receipts identify success, timeout, and ordinary failure exactly", () => {
  const [phase] = phases();
  const lines = [];
  let clock = 1_000;
  runRContractPhase(phase, {
    now: () => {
      clock += 1_250;
      return clock;
    },
    spawn: () => ({ error: undefined, signal: null, status: 0 }),
    writeLine: (line) => lines.push(line)
  });
  assert.deepEqual(lines, [
    "[r-contract] START native frame contract; timeout 120.0s",
    "[r-contract] PASS native frame contract in 1.3s"
  ]);

  const timeout = Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" });
  assert.throws(
    () =>
      runRContractPhase(phase, {
        now: () => 5_000,
        spawn: () => ({ error: timeout, signal: "SIGTERM", status: null }),
        writeLine: () => {}
      }),
    /TIMEOUT native frame contract after 0\.0s; phase limit 120\.0s/u
  );
  assert.throws(
    () =>
      runRContractPhase(phase, {
        now: () => 5_000,
        spawn: () => ({ error: undefined, signal: null, status: 17 }),
        writeLine: () => {}
      }),
    /FAIL native frame contract after 0\.0s with exit 17/u
  );
});
