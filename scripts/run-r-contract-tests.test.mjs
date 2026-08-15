import assert from "node:assert/strict";
import test from "node:test";
import { createRContractPhases, runRContractPhase } from "./run-r-contract-tests.mjs";

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
    configured.map(({ label, timeoutMs }) => [label, timeoutMs]),
    [
      ["native frame contract", 120_000],
      ["native kernel-agent contract", 360_000],
      ["complete native catalog contract", 120_000],
      ["TypeScript R frame and unit contracts", 60_000],
      ["real-R kernel transport contract", 90_000],
      ["real-R process transport contract", 90_000],
      ["real-R interactive transport contract", 60_000]
    ]
  );

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
