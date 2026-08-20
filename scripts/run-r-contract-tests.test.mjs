import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createRContractPhases,
  orderRContractPhases,
  parseRContractSelection,
  R_CONTRACT_SHARDS,
  R_FRAME_CONTRACT_CASES,
  runRContractPhase,
  runRContractPhases,
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
      ...R_FRAME_CONTRACT_CASES.map((caseId) => [`frame:${caseId}`, `native frame contract: ${caseId}`, 120_000]),
      ["kernel-agent", "native kernel-agent contract", 360_000],
      ["catalog", "complete native catalog contract", 120_000],
      ["typescript-frame", "TypeScript R frame and unit contracts", 60_000],
      ["kernel-transport", "real-R kernel transport contract", 90_000],
      ["process-transport", "real-R process transport contract", 90_000],
      ["interactive-transport", "real-R interactive transport contract", 60_000]
    ]
  );

  const frameCases = configured.slice(0, R_FRAME_CONTRACT_CASES.length);
  assert.deepEqual(
    frameCases.map(({ command, args, environment }) => [
      command,
      ...args,
      environment.OPEN_WRANGLER_R_CONTRACT_TEST,
      environment.OPEN_WRANGLER_R_FRAME_CASE
    ]),
    R_FRAME_CONTRACT_CASES.map((caseId) => [
      "/reviewed/Rscript",
      "--vanilla",
      "r/tests/run_warning_strict.R",
      caseId === "interactive" ? "r/tests/interactive_contract.R" : "r/tests/frame_contract.R",
      caseId
    ])
  );

  const direct = configured.slice(R_FRAME_CONTRACT_CASES.length, R_FRAME_CONTRACT_CASES.length + 2);
  assert.deepEqual(
    direct.map(({ command, args, environment }) => [command, ...args, environment.OPEN_WRANGLER_R_CONTRACT_TEST]),
    [
      ["/reviewed/Rscript", "--vanilla", "r/tests/run_warning_strict.R", "r/tests/kernel_agent.R"],
      ["/reviewed/Rscript", "--vanilla", "r/tests/run_warning_strict.R", "r/tests/complete_catalog_contract.R"]
    ]
  );

  const vitest = configured.slice(R_FRAME_CONTRACT_CASES.length + 2);
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

test("the frame mega-test exposes every semantic case exactly once in a fresh local scope", () => {
  const frameSource = readFileSync(new URL("../r/tests/frame_contract.R", import.meta.url), "utf8");
  const isolatedCases = [...frameSource.matchAll(/run_frame_contract_case\("([^"]+)", local\(\{/gu)].map(
    ([, caseId]) => caseId
  );
  assert.deepEqual(isolatedCases, R_FRAME_CONTRACT_CASES);
  assert.match(frameSource, /frame_contract_case_run_count <<- frame_contract_case_run_count \+ 1L/u);
  assert.match(frameSource, /assert_identical\(\s*frame_contract_case_run_count,\s*1L,/su);

  const interactiveSource = readFileSync(new URL("../r/tests/interactive_contract.R", import.meta.url), "utf8");
  assert.match(interactiveSource, /identical\(selected_case, "interactive"\)/u);
  assert.match(interactiveSource, /source\("r\/tests\/frame_contract\.R", local = FALSE\)/u);
});

test("native R contracts fail unexpected warnings without treating messages as warnings", () => {
  const source = readFileSync(new URL("../r/tests/run_warning_strict.R", import.meta.url), "utf8");
  assert.match(source, /globalCallingHandlers\(\s*warning\s*=/u);
  assert.match(source, /Unexpected R warning \[%s\]: %s/u);
  assert.match(source, /warning contract probe/u);
  assert.match(source, /warning_state\$diagnostics/u);
  assert.doesNotMatch(source, /globalCallingHandlers\([^)]*message\s*=/su);
  assert.match(source, /OPEN_WRANGLER_R_CONTRACT_TEST/u);
  assert.match(source, /r\/tests\/interactive_contract\.R/u);
  const targetValidation = source.indexOf("target %in% strict_targets");
  const handlerInstallation = source.indexOf("globalCallingHandlers(warning = unexpected_warning)");
  const warningProbe = source.indexOf('warning("warning contract probe", call. = FALSE)');
  const contractSource = source.indexOf("source(target, local = FALSE)");
  const warningSettlement = source.indexOf("length(warning_state$diagnostics) > 0L");
  for (const seam of [targetValidation, handlerInstallation, warningProbe, contractSource, warningSettlement]) {
    assert.notEqual(seam, -1);
  }
  assert.ok(targetValidation < handlerInstallation);
  assert.ok(handlerInstallation < warningProbe);
  assert.ok(warningProbe < contractSource);
  assert.ok(contractSource < warningSettlement);
});

test("named R contract shards are an exhaustive disjoint phase partition with the kernel agent isolated", () => {
  const configured = phases();
  assert.deepEqual(R_CONTRACT_SHARDS, [
    {
      id: "frame-foundations",
      phaseIds: [
        "frame:decimal-ordering",
        "frame:capture-and-export",
        "frame:custom-code",
        "frame:validation-and-categorical"
      ]
    },
    {
      id: "frame-transformations",
      phaseIds: [
        "frame:group-by",
        "frame:column-operations",
        "frame:by-example",
        "frame:formula",
        "frame:text",
        "frame:numeric-and-datetime",
        "frame:fill-missing",
        "frame:cast-and-structure"
      ]
    },
    { id: "frame-query", phaseIds: ["frame:profiling", "frame:interactive"] },
    { id: "kernel-agent", phaseIds: ["kernel-agent"] },
    { id: "catalog-and-unit", phaseIds: ["catalog", "typescript-frame"] },
    { id: "runtime-transport", phaseIds: ["kernel-transport", "process-transport", "interactive-transport"] }
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
  assert.deepEqual(parseRContractSelection(["--seed", "4294967295"]), { kind: "all", seed: 4_294_967_295 });
  assert.deepEqual(parseRContractSelection(["--seed", "7", "--phase", "catalog"]), {
    kind: "phase",
    id: "catalog",
    seed: 7
  });
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
    ["--shard", ""],
    ["--seed", "01"],
    ["--seed", "4294967296"],
    ["--seed", "1", "--seed", "2"]
  ]) {
    assert.throws(() => parseRContractSelection(arguments_), /Usage|selection|seed/u);
  }
  assert.throws(
    () => selectRContractPhases(configured, { kind: "phase", id: "Catalog" }),
    /Unknown R contract phase Catalog/u
  );
  assert.throws(() => selectRContractPhases(configured, { kind: "shard", id: "all" }), /Unknown R contract shard all/u);
  assert.throws(
    () => selectRContractPhases([...configured, configured[0]], { kind: "all" }),
    /Duplicate R contract phase ID: frame:decimal-ordering/u
  );
  assert.throws(() => selectRContractPhases(configured, undefined), /selection must be all, phase, or shard/u);
});

test("seeded R contract ordering is deterministic, complete, and immutable", () => {
  const configured = phases();
  const originalIds = configured.map(({ id }) => id);
  const first = orderRContractPhases(configured, 20260820).map(({ id }) => id);
  const repeated = orderRContractPhases(configured, 20260820).map(({ id }) => id);
  const different = orderRContractPhases(configured, 695).map(({ id }) => id);

  assert.deepEqual(first, repeated);
  assert.deepEqual(first.toSorted(), originalIds.toSorted());
  assert.notDeepEqual(first, originalIds);
  assert.notDeepEqual(first, different);
  assert.deepEqual(
    configured.map(({ id }) => id),
    originalIds
  );
  assert.deepEqual(
    orderRContractPhases(configured, undefined).map(({ id }) => id),
    originalIds
  );
  assert.throws(() => orderRContractPhases(configured, -1), /unsigned 32-bit integer/u);
  assert.throws(() => orderRContractPhases(configured, 0x1_0000_0000), /unsigned 32-bit integer/u);
});

test("R contract execution reports every selected phase after unrelated failures", () => {
  const selected = phases().slice(0, 4);
  const visited = [];
  const lines = [];
  let failure;
  try {
    runRContractPhases(selected, {
      runPhase: (phase) => {
        visited.push(phase.id);
        if (phase === selected[0] || phase === selected[2]) throw new Error(`fixture failure ${phase.id}`);
      },
      writeLine: (line) => lines.push(line)
    });
  } catch (error) {
    failure = error;
  }

  assert.deepEqual(
    visited,
    selected.map(({ id }) => id)
  );
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.message, /2 of 4 selected phases failed after all selected phases settled/u);
  assert.deepEqual(
    failure.errors.map(({ message }) => message),
    [`fixture failure ${selected[0].id}`, `fixture failure ${selected[2].id}`]
  );
  assert.deepEqual(lines, [
    `[r-contract] RECORDED ${selected[0].id}: fixture failure ${selected[0].id}`,
    `[r-contract] RECORDED ${selected[2].id}: fixture failure ${selected[2].id}`
  ]);
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
    "[r-contract] START native frame contract: decimal-ordering; timeout 120.0s",
    "[r-contract] PASS native frame contract: decimal-ordering in 1.3s"
  ]);

  const timeout = Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" });
  assert.throws(
    () =>
      runRContractPhase(phase, {
        now: () => 5_000,
        spawn: () => ({ error: timeout, signal: "SIGTERM", status: null }),
        writeLine: () => {}
      }),
    /TIMEOUT native frame contract: decimal-ordering after 0\.0s; phase limit 120\.0s/u
  );
  assert.throws(
    () =>
      runRContractPhase(phase, {
        now: () => 5_000,
        spawn: () => ({ error: undefined, signal: null, status: 17 }),
        writeLine: () => {}
      }),
    /FAIL native frame contract: decimal-ordering after 0\.0s with exit 17/u
  );
});
