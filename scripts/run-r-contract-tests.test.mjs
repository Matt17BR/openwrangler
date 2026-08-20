import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createRContractPhases,
  parseRContractSelection,
  R_CONTRACT_SHARDS,
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
    configured.map(({ id, label, timeoutMs }) => [id, label, timeoutMs]),
    [
      ["frame", "native frame contract", 120_000],
      ["kernel-agent", "native kernel-agent contract", 360_000],
      ["catalog", "complete native catalog contract", 120_000],
      ["typescript-frame", "TypeScript R frame and unit contracts", 60_000],
      ["kernel-transport", "real-R kernel transport contract", 90_000],
      ["process-transport", "real-R process transport contract", 90_000],
      ["interactive-transport", "real-R interactive transport contract", 60_000]
    ]
  );

  const direct = configured.slice(0, 3);
  assert.deepEqual(
    direct.map(({ command, args, environment }) => [command, ...args, environment.OPEN_WRANGLER_R_CONTRACT_TEST]),
    [
      ["/reviewed/Rscript", "--vanilla", "r/tests/run_warning_strict.R", "r/tests/frame_contract.R"],
      ["/reviewed/Rscript", "--vanilla", "r/tests/run_warning_strict.R", "r/tests/kernel_agent.R"],
      ["/reviewed/Rscript", "--vanilla", "r/tests/run_warning_strict.R", "r/tests/complete_catalog_contract.R"]
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

test("native R contracts fail unexpected warnings without treating messages as warnings", () => {
  const source = readFileSync(new URL("../r/tests/run_warning_strict.R", import.meta.url), "utf8");
  assert.match(source, /globalCallingHandlers\(\s*warning\s*=/u);
  assert.match(source, /Unexpected R warning \[%s\]: %s/u);
  assert.match(source, /warning contract probe/u);
  assert.match(source, /warning_state\$diagnostics/u);
  assert.doesNotMatch(source, /globalCallingHandlers\([^)]*message\s*=/su);
  assert.match(source, /OPEN_WRANGLER_R_CONTRACT_TEST/u);
  const targetValidation = source.indexOf("target %in% strict_targets");
  const handlerInstallation = source.indexOf("globalCallingHandlers(warning = unexpected_warning)");
  const warningProbe = source.indexOf('warning("warning contract probe", call. = FALSE)');
  const contractSource = source.indexOf("source(target, local = FALSE)");
  const warningSettlement = source.indexOf("length(warning_state$diagnostics) > 0L");
  assert.ok(targetValidation < handlerInstallation);
  assert.ok(handlerInstallation < warningProbe);
  assert.ok(warningProbe < contractSource);
  assert.ok(contractSource < warningSettlement);
});

test("named R contract shards are an exhaustive disjoint phase partition with the kernel agent isolated", () => {
  const configured = phases();
  assert.deepEqual(R_CONTRACT_SHARDS, [
    { id: "kernel-agent", phaseIds: ["kernel-agent"] },
    {
      id: "frame-and-interactive-transport",
      phaseIds: ["frame", "kernel-transport", "interactive-transport"]
    },
    {
      id: "catalog-and-process-transport",
      phaseIds: ["catalog", "typescript-frame", "process-transport"]
    }
  ]);

  const selectedIds = R_CONTRACT_SHARDS.flatMap((shard) =>
    selectRContractPhases(configured, { kind: "shard", id: shard.id }).map(({ id }) => id)
  );
  assert.equal(new Set(selectedIds).size, selectedIds.length);
  assert.deepEqual(selectedIds.toSorted(), configured.map(({ id }) => id).toSorted());
  assert.deepEqual(
    selectRContractPhases(configured, { kind: "shard", id: "kernel-agent" }).map(({ id }) => id),
    ["kernel-agent"]
  );
});

test("R contract phase and shard selectors are exact, mutually exclusive, and fail closed", () => {
  const configured = phases();
  assert.deepEqual(parseRContractSelection([]), { kind: "all" });
  assert.deepEqual(parseRContractSelection(["--phase", "catalog"]), { kind: "phase", id: "catalog" });
  assert.deepEqual(parseRContractSelection(["--shard", "kernel-agent"]), { kind: "shard", id: "kernel-agent" });
  assert.deepEqual(
    selectRContractPhases(configured, parseRContractSelection([])).map(({ id }) => id),
    configured.map(({ id }) => id)
  );
  assert.deepEqual(
    selectRContractPhases(configured, parseRContractSelection(["--phase", "catalog"])).map(({ id }) => id),
    ["catalog"]
  );

  for (const arguments_ of [
    ["--phase"],
    ["--phase", "catalog", "--phase", "frame"],
    ["--phase=catalog"],
    ["--shard", ""]
  ]) {
    assert.throws(() => parseRContractSelection(arguments_), /Usage|non-empty/u);
  }
  assert.throws(
    () => selectRContractPhases(configured, { kind: "phase", id: "Catalog" }),
    /Unknown R contract phase Catalog/u
  );
  assert.throws(() => selectRContractPhases(configured, { kind: "shard", id: "all" }), /Unknown R contract shard all/u);
  assert.throws(
    () => selectRContractPhases([...configured, configured[0]], { kind: "all" }),
    /Duplicate R contract phase ID: frame/u
  );
  assert.throws(() => selectRContractPhases(configured, undefined), /selection must be all, phase, or shard/u);
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
