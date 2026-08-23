import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createPosixProcessTracker,
  createRContractPhases,
  orderRContractPhases,
  parseRContractSelection,
  readPsProcessIdentity,
  R_CONTRACT_SHARD_ALIASES,
  R_CONTRACT_SHARDS,
  R_FRAME_CONTRACT_CASES,
  R_KERNEL_AGENT_CASES,
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
      ...R_KERNEL_AGENT_CASES.map((caseId) => [`kernel:${caseId}`, `native kernel-agent contract: ${caseId}`, 360_000]),
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

  const direct = configured.slice(
    R_FRAME_CONTRACT_CASES.length,
    R_FRAME_CONTRACT_CASES.length + R_KERNEL_AGENT_CASES.length + 1
  );
  assert.deepEqual(
    direct.map(({ command, args, environment }) => [
      command,
      ...args,
      environment.OPEN_WRANGLER_R_CONTRACT_TEST,
      environment.OPEN_WRANGLER_R_KERNEL_CASE
    ]),
    [
      ...R_KERNEL_AGENT_CASES.map((caseId) => [
        "/reviewed/Rscript",
        "--vanilla",
        "r/tests/run_warning_strict.R",
        "r/tests/kernel_agent.R",
        caseId
      ]),
      [
        "/reviewed/Rscript",
        "--vanilla",
        "r/tests/run_warning_strict.R",
        "r/tests/complete_catalog_contract.R",
        undefined
      ]
    ]
  );

  const vitest = configured.slice(R_FRAME_CONTRACT_CASES.length + R_KERNEL_AGENT_CASES.length + 1);
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

test("the kernel agent exposes independently selectable named operation owners", () => {
  const source = readFileSync(new URL("../r/tests/kernel_agent.R", import.meta.url), "utf8");
  const declared = /kernel_agent_cases <- c\(([\s\S]*?)\)\nselected_kernel_agent_case/u.exec(source)?.[1];
  assert.ok(declared);
  assert.deepEqual(
    [...declared.matchAll(/"([a-z][a-z0-9-]+)"/gu)].map(([, caseId]) => caseId),
    R_KERNEL_AGENT_CASES
  );
  for (const caseId of R_KERNEL_AGENT_CASES) {
    assert.match(source, new RegExp(`identical\\(selected_kernel_agent_case, "${caseId}"\\)`, "u"));
  }
  assert.match(source, /kernel_agent_case_run_count <- kernel_agent_case_run_count \+ 1L/u);
  assert.equal(
    [...source.matchAll(/kernel_agent_case_run_count <- kernel_agent_case_run_count \+ 1L/gu)].length,
    R_KERNEL_AGENT_CASES.length
  );
  assert.match(source, /kernel_agent_case_run_count,\s*1L,/su);
  assert.match(source, /Sys\.unsetenv\("OPEN_WRANGLER_R_KERNEL_CASE"\)/u);
});

test("the direct full kernel-agent alias runs every named owner in a fresh strict process", () => {
  const source = readFileSync(new URL("../r/tests/run_kernel_agent_case.R", import.meta.url), "utf8");
  const declared = /kernel_agent_cases <- c\(([\s\S]*?)\)\ncase_file/u.exec(source)?.[1];
  assert.ok(declared);
  assert.deepEqual(
    [...declared.matchAll(/"([a-z][a-z0-9-]+)"/gu)].map(([, caseId]) => caseId),
    R_KERNEL_AGENT_CASES
  );
  assert.match(source, /if \(identical\(case_name, "full"\)\) \{/u);
  assert.match(source, /vapply\(kernel_agent_cases, function\(kernel_case\) \{/u);
  assert.match(source, /OPEN_WRANGLER_R_CONTRACT_TEST=r\/tests\/kernel_agent\.R/u);
  assert.match(source, /OPEN_WRANGLER_R_KERNEL_CASE=%s/u);
  assert.doesNotMatch(source, /identical\(case_name, "full"\)[\s\S]{0,120}source\(case_file/u);
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
    { id: "kernel-agent", phaseIds: R_KERNEL_AGENT_CASES.map((caseId) => `kernel:${caseId}`) },
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
    R_KERNEL_AGENT_CASES.map((caseId) => `kernel:${caseId}`)
  );
  assert.deepEqual(R_CONTRACT_SHARD_ALIASES, [
    {
      id: "frame-and-interactive-transport",
      phaseIds: [
        ...R_FRAME_CONTRACT_CASES.map((caseId) => `frame:${caseId}`),
        "kernel-transport",
        "interactive-transport"
      ]
    },
    {
      id: "catalog-and-process-transport",
      phaseIds: ["catalog", "typescript-frame", "process-transport"]
    }
  ]);
});

test("every package-exposed R contract shard remains an exact compatibility selector", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const runnerPrefix = "node scripts/run-r-contract-tests.mjs --shard ";
  const exposed = Object.values(packageJson.scripts)
    .filter((command) => command.startsWith(runnerPrefix))
    .map((command) => command.slice(runnerPrefix.length));
  assert.ok(exposed.length > 0 && exposed.length <= 16);
  assert.deepEqual(exposed.toSorted(), ["catalog-and-process-transport", "frame-and-interactive-transport"]);
  for (const shardId of exposed) {
    assert.match(shardId, /^[a-z][a-z0-9-]{0,63}$/u);
    assert.ok(selectRContractPhases(phases(), { kind: "shard", id: shardId }).length > 0);
  }
});

test("R contract phase and shard selectors are exact, mutually exclusive, and fail closed", () => {
  const configured = phases();
  assert.deepEqual(parseRContractSelection([]), { kind: "all", seed: 20_260_820 });
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
  const defaultSelection = parseRContractSelection([]);
  const originalIds = configured.map(({ id }) => id);
  const first = orderRContractPhases(configured, 20260820).map(({ id }) => id);
  const repeated = orderRContractPhases(configured, 20260820).map(({ id }) => id);
  const different = orderRContractPhases(configured, 695).map(({ id }) => id);

  assert.deepEqual(first, repeated);
  assert.deepEqual(defaultSelection, { kind: "all", seed: 20_260_820 });
  assert.deepEqual(
    orderRContractPhases(configured, defaultSelection.seed).map(({ id }) => id),
    first
  );
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
  const source = readFileSync(new URL("./run-r-contract-tests.mjs", import.meta.url), "utf8");
  assert.match(source, /\[r-contract\] ORDER seed \$\{selection\.seed\}: \$\{ordered/u);
});

test("R contract execution reports every selected phase after unrelated failures", async () => {
  const selected = phases().slice(0, 4);
  const visited = [];
  const lines = [];
  let failure;
  try {
    await runRContractPhases(selected, {
      runPhase: async (phase) => {
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

test("an external termination observed between phases prevents the next phase from starting", async () => {
  const termination = new AbortController();
  termination.abort("SIGTERM");
  let starts = 0;
  await assert.rejects(
    runRContractPhases(phases().slice(0, 2), {
      terminationSignal: termination.signal,
      runPhase: async () => {
        starts += 1;
      },
      writeLine: () => {}
    }),
    /stopped before frame:decimal-ordering because the runner received an external termination signal/u
  );
  assert.equal(starts, 0);
});

function fixtureChild(pid, { code, error, signal = null } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    if (error) child.emit("error", error);
    if (code !== undefined || signal !== null || error) child.emit("close", code ?? null, signal);
  });
  return child;
}

function fixtureProcessTracker({ onSignal, settled = false } = {}) {
  let live = !settled;
  return {
    failure: new Promise(() => {}),
    assertHealthy: () => {},
    observe: () => (live ? 1 : 0),
    isSettled: (observer) => !live && observer.isSettled(),
    signal: (signal) => {
      onSignal?.(signal);
      live = false;
    },
    stop: () => {}
  };
}

test("native R phase receipts identify success, timeout, and ordinary failure exactly", async () => {
  const [phase] = phases();
  const lines = [];
  let clock = 1_000;
  await runRContractPhase(phase, {
    now: () => {
      clock += 1_250;
      return clock;
    },
    spawnProcess: () => fixtureChild(41001, { code: 0 }),
    createProcessTracker: () => fixtureProcessTracker({ settled: true }),
    writeLine: (line) => lines.push(line)
  });
  assert.deepEqual(lines, [
    "[r-contract] START native frame contract: decimal-ordering; timeout 120.0s",
    "[r-contract] PASS native frame contract: decimal-ordering in 1.3s"
  ]);

  let timeoutChild;
  let timeoutTracker;
  await assert.rejects(
    runRContractPhase(
      { ...phase, timeoutMs: 2 },
      {
        now: () => 5_000,
        spawnProcess: () => {
          timeoutChild = fixtureChild(41002);
          timeoutTracker = fixtureProcessTracker({
            onSignal: (signal) => {
              if (signal === "SIGTERM") timeoutChild.emit("close", null, signal);
            }
          });
          return timeoutChild;
        },
        createProcessTracker: () => timeoutTracker,
        terminationGraceMs: 25,
        killGraceMs: 25,
        writeLine: () => {}
      }
    ),
    /TIMEOUT native frame contract: decimal-ordering after 0\.0s; phase limit 0\.0s/u
  );
  await assert.rejects(
    runRContractPhase(phase, {
      now: () => 5_000,
      spawnProcess: () => fixtureChild(41003, { code: 17 }),
      createProcessTracker: () => fixtureProcessTracker({ settled: true }),
      writeLine: () => {}
    }),
    /FAIL native frame contract: decimal-ordering after 0\.0s with exit 17/u
  );
});

test("Windows R contract phases launch through the existing Job Object supervisor", async () => {
  const [phase] = phases();
  const launches = [];
  let spawnReceipt;
  await runRContractPhase(
    { ...phase, environment: { ...phase.environment, SYSTEMROOT: "C:\\Windows" } },
    {
      platform: "win32",
      randomToken: () => "00000000-0000-4000-8000-000000000695",
      spawnProcess: (command, args, options) => {
        spawnReceipt = { command, args, options };
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin.setEncoding("utf8");
        child.stdin.on("data", (frame) => {
          const parsed = JSON.parse(frame.trim());
          launches.push(parsed);
          child.stderr.end("OPEN_WRANGLER_WINDOWS_JOB_EMPTY:00000000-0000-4000-8000-000000000695\n");
          queueMicrotask(() => child.emit("close", 0, null));
        });
        return child;
      },
      writeError: () => {},
      writeLine: () => {}
    }
  );
  assert.equal(spawnReceipt.command, "C:\\Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
  assert.deepEqual(spawnReceipt.args.slice(-2), [
    "-File",
    new URL("./windows-job-supervisor.ps1", import.meta.url).pathname
  ]);
  assert.equal(spawnReceipt.options.detached, false);
  assert.deepEqual(spawnReceipt.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, "launch");
  assert.equal(launches[0].executable, phase.command);
  assert.deepEqual(launches[0].args, phase.args);
});

test("the Windows empty-tree marker is removed before the combined 4 MiB user-output budget", async () => {
  const [phase] = phases();
  const token = "00000000-0000-4000-8000-000000000695";
  const marker = Buffer.from(`OPEN_WRANGLER_WINDOWS_JOB_EMPTY:${token}\n`, "ascii");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  await runRContractPhase(
    { ...phase, environment: { ...phase.environment, SYSTEMROOT: "C:\\Windows" } },
    {
      platform: "win32",
      randomToken: () => token,
      spawnProcess: () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin.setEncoding("utf8");
        child.stdin.on("data", (frame) => {
          if (JSON.parse(frame.trim()).command !== "launch") return;
          child.stdout.end(Buffer.alloc(1024 * 1024, 0x6f));
          child.stderr.write(Buffer.alloc(3 * 1024 * 1024, 0x65));
          child.stderr.write(marker.subarray(0, 17));
          child.stderr.end(marker.subarray(17));
          queueMicrotask(() => child.emit("close", 0, null));
        });
        return child;
      },
      writeOutput: (chunk) => {
        stdoutBytes += chunk.length;
      },
      writeError: (chunk) => {
        stderrBytes += chunk.length;
      },
      writeLine: () => {}
    }
  );
  assert.equal(stdoutBytes, 1024 * 1024);
  assert.equal(stderrBytes, 3 * 1024 * 1024);

  await assert.rejects(
    runRContractPhase(
      { ...phase, timeoutMs: 500, environment: { ...phase.environment, SYSTEMROOT: "C:\\Windows" } },
      {
        platform: "win32",
        randomToken: () => token,
        spawnProcess: () => {
          const child = new EventEmitter();
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.stdin.setEncoding("utf8");
          child.stdin.on("data", (frame) => {
            const command = JSON.parse(frame.trim()).command;
            if (command === "launch") {
              child.stdout.end(Buffer.alloc(1024 * 1024, 0x6f));
              child.stderr.end(Buffer.concat([Buffer.alloc(3 * 1024 * 1024 + 1, 0x65), marker]));
            } else if (command === "terminate") {
              queueMicrotask(() => child.emit("close", null, "SIGKILL"));
            }
          });
          return child;
        },
        writeOutput: () => {},
        writeError: () => {},
        writeLine: () => {}
      }
    ),
    /exceeded its 4194304-byte stdout\/stderr bound/u
  );
});

test("a Windows post-spawn control failure terminates and latches before a later phase", async () => {
  const first = { ...phases()[0], environment: { ...phases()[0].environment, SYSTEMROOT: "C:\\Windows" } };
  const second = { ...phases()[1], environment: { ...phases()[1].environment, SYSTEMROOT: "C:\\Windows" } };
  let spawnCount = 0;
  let killCount = 0;
  let failure;
  try {
    await runRContractPhases([first, second], {
      platform: "win32",
      spawnProcess: () => {
        spawnCount += 1;
        const child = new EventEmitter();
        child.pid = 51_000 + spawnCount;
        child.kill = () => {
          killCount += 1;
          queueMicrotask(() => child.emit("close", null, "SIGKILL"));
          return true;
        };
        return child;
      },
      windowsSettlementMs: 25,
      writeLine: () => {}
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AggregateError);
  assert.equal(spawnCount, 1);
  assert.equal(killCount, 1);
  assert.match(failure.message, /stopped after frame:decimal-ordering/u);
  assert.ok(failure.errors[0] instanceof AggregateError);
  assert.match(failure.errors[0].errors[0].message, /did not expose its control channels/u);
  assert.match(failure.errors[0].errors[1].message, /did not provide one exact empty-tree attestation/u);
});

function processIdentity(pid, parentPid, startIdentity, ownerMarked = false, overrides = {}) {
  return {
    pid,
    parentPid,
    groupId: pid,
    state: "S",
    startIdentity,
    ownerMarked,
    identityResolution: "exact-test-identity",
    ...overrides
  };
}

function heldSignalHandle(identity, signals, beforeSignal = () => {}) {
  return {
    signal: (signal) => {
      beforeSignal(identity, signal);
      signals.push([identity.pid, identity.startIdentity, signal]);
    }
  };
}

test(
  "Linux /proc enumeration ignores only a numeric entry that disappears during type resolution",
  { skip: process.platform !== "linux" },
  () => {
    const runnerUrl = new URL("./run-r-contract-tests.mjs", import.meta.url).href;
    const program = [
      'import assert from "node:assert/strict";',
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      `const runnerUrl = ${JSON.stringify(runnerUrl)};`,
      "const originalReaddirSync = fs.readdirSync;",
      "const observationError = (code) => Object.assign(new Error(`${code}: numeric process entry disappeared`), { code, path: '/proc/2147483646' });",
      "const setReadDirectory = (implementation) => { fs.readdirSync = implementation; syncBuiltinESMExports(); };",
      "try {",
      "  const { createPosixProcessTracker } = await import(runnerUrl);",
      "  for (const code of ['ENOENT', 'ESRCH']) {",
      "    setReadDirectory((path, options) => {",
      "      assert.equal(path, '/proc');",
      "      if (options?.withFileTypes === true) throw observationError(code);",
      "      return ['2147483646'];",
      "    });",
      "    const tracker = createPosixProcessTracker(process.pid, 'owner', { observationIntervalMs: 60_000 });",
      "    tracker.assertHealthy();",
      "    tracker.stop();",
      "  }",
      "  setReadDirectory(() => { throw observationError('EACCES'); });",
      "  const tracker = createPosixProcessTracker(process.pid, 'owner', { observationIntervalMs: 60_000 });",
      "  assert.throws(() => tracker.assertHealthy(), /numeric process entry disappeared/u);",
      "  const failure = await tracker.failure;",
      "  assert.equal(failure.processTreeUnsettled, true);",
      "  assert.equal(failure.cause.code, 'EACCES');",
      "  tracker.stop();",
      "} finally {",
      "  setReadDirectory(originalReaddirSync);",
      "}"
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 10_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
);

test("POSIX ownership follows marker-free descendants and binds every signal to a stable identity", () => {
  const processes = new Map([
    [61_001, processIdentity(61_001, 1, "root")],
    [61_002, processIdentity(61_002, 61_001, "child", false)]
  ]);
  const signals = [];
  const tracker = createPosixProcessTracker(61_001, "owner", {
    readProcessIdentity: (pid) => processes.get(pid),
    listProcessIdentities: () => [...processes.values()],
    acquireSignalHandle: (identity) => heldSignalHandle(identity, signals),
    observationIntervalMs: 60_000
  });
  tracker.signal("SIGTERM");
  tracker.stop();
  assert.deepEqual(signals, [
    [61_001, "root", "SIGTERM"],
    [61_002, "child", "SIGTERM"]
  ]);
});

test("POSIX ownership retires one identity and tracks an owned reuse of the same PID", () => {
  const processes = new Map([
    [62_001, processIdentity(62_001, 1, "root")],
    [62_002, processIdentity(62_002, 62_001, "owned-child")]
  ]);
  const signals = [];
  const tracker = createPosixProcessTracker(62_001, "owner", {
    readProcessIdentity: (pid) => processes.get(pid),
    listProcessIdentities: () => [...processes.values()],
    acquireSignalHandle: (identity) => heldSignalHandle(identity, signals),
    observationIntervalMs: 60_000
  });
  processes.delete(62_002);
  tracker.observe();
  processes.set(62_002, processIdentity(62_002, 62_001, "owned-reuse"));
  tracker.signal("SIGKILL");
  tracker.stop();
  assert.deepEqual(signals, [
    [62_001, "root", "SIGKILL"],
    [62_002, "owned-reuse", "SIGKILL"]
  ]);
});

test("POSIX ownership does not adopt a foreign reuse of a retired PID", () => {
  const processes = new Map([
    [62_101, processIdentity(62_101, 1, "root")],
    [62_102, processIdentity(62_102, 62_101, "owned-child")]
  ]);
  const signals = [];
  const tracker = createPosixProcessTracker(62_101, "owner", {
    readProcessIdentity: (pid) => processes.get(pid),
    listProcessIdentities: () => [...processes.values()],
    acquireSignalHandle: (identity) => heldSignalHandle(identity, signals),
    observationIntervalMs: 60_000
  });
  processes.delete(62_102);
  tracker.observe();
  processes.set(62_102, processIdentity(62_102, 99, "foreign-reuse"));
  tracker.signal("SIGKILL");
  tracker.stop();
  assert.deepEqual(signals, [[62_101, "root", "SIGKILL"]]);
});

test("POSIX signaling stays bound to the held identity across replacement after verification", () => {
  const owned = processIdentity(62_201, 1, "owned-root", true);
  const foreign = processIdentity(62_201, 99, "foreign-reuse", false);
  const processes = new Map([[62_201, owned]]);
  const signals = [];
  const tracker = createPosixProcessTracker(62_201, "owner", {
    readProcessIdentity: (pid) => processes.get(pid),
    listProcessIdentities: () => [...processes.values()],
    acquireSignalHandle: (identity) =>
      heldSignalHandle(identity, signals, () => {
        processes.set(62_201, foreign);
      }),
    observationIntervalMs: 60_000
  });
  tracker.signal("SIGTERM");
  tracker.stop();
  assert.deepEqual(signals, [[62_201, "owned-root", "SIGTERM"]]);
  assert.equal(processes.get(62_201), foreign);
});

test("a same-timestamp non-Linux PID reuse fails closed instead of settling", async () => {
  const ownerCommand = "fixture OPEN_WRANGLER_R_CONTRACT_OWNER=owner";
  const owned = processIdentity(62_301, 1, "Fri Aug 21 13:00:00 2026", true, {
    command: ownerCommand,
    identityResolution: "second"
  });
  const foreign = processIdentity(62_301, 99, owned.startIdentity, false, {
    command: "unrelated fixture",
    identityResolution: "second"
  });
  const processes = new Map([[62_301, owned]]);
  const tracker = createPosixProcessTracker(62_301, "owner", {
    readProcessIdentity: (pid) => processes.get(pid),
    listProcessIdentities: () => [...processes.values()],
    observationIntervalMs: 60_000
  });
  processes.set(62_301, foreign);
  assert.throws(() => tracker.observe(), /ambiguous second-resolution identity/u);
  const failure = await tracker.failure;
  assert.equal(failure.processTreeUnsettled, true);
  assert.throws(() => tracker.isSettled({ isSettled: () => true }), /ambiguous second-resolution identity/u);
  tracker.stop();
});

test("a retired coarse identity that reappears cannot settle or start a later phase", async () => {
  const ownerCommand = "fixture OPEN_WRANGLER_R_CONTRACT_OWNER=owner";
  const coarse = processIdentity(62_401, 1, "Fri Aug 21 14:00:00 2026", true, {
    command: ownerCommand,
    identityResolution: "second"
  });
  const replacement = processIdentity(62_401, 99, coarse.startIdentity, false, {
    command: "foreign replacement",
    identityResolution: "second"
  });
  let current = coarse;
  const tracker = createPosixProcessTracker(62_401, "owner", {
    readProcessIdentity: () => current,
    listProcessIdentities: () => (current ? [current] : []),
    observationIntervalMs: 60_000
  });

  current = undefined;
  assert.equal(tracker.observe(), 0);
  current = replacement;
  assert.throws(
    () => tracker.isSettled({ isSettled: () => true }),
    /retired coarse process 62401 reappeared with the same .* identity key/u
  );
  const settlementFailure = await tracker.failure;
  assert.equal(settlementFailure.processTreeUnsettled, true);
  tracker.stop();

  const [first, second] = phases();
  const started = [];
  await assert.rejects(
    runRContractPhases([first, second], {
      runPhase: async (phase) => {
        started.push(phase.id);
        throw settlementFailure;
      },
      writeLine: () => {}
    }),
    /stopped after frame:decimal-ordering because its process tree was not verified settled/u
  );
  assert.deepEqual(started, [first.id]);
});

test("POSIX ownership fails closed when an observed descendant becomes unverifiable", async () => {
  const processes = new Map([
    [63_001, processIdentity(63_001, 1, "root")],
    [63_002, processIdentity(63_002, 63_001, "child")]
  ]);
  let unreadable = false;
  const tracker = createPosixProcessTracker(63_001, "owner", {
    readProcessIdentity: (pid) => {
      if (pid === 63_002 && unreadable) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return processes.get(pid);
    },
    listProcessIdentities: () => [...processes.values()],
    observationIntervalMs: 60_000
  });
  unreadable = true;
  assert.throws(() => tracker.observe(), /process tree became unverifiable.*permission denied/u);
  assert.equal((await tracker.failure).processTreeUnsettled, true);
  tracker.stop();
});

test("POSIX ownership fails closed on a stalled observer or weak signal identity", async () => {
  const stable = processIdentity(63_101, 1, "root");
  let observerStalled = false;
  const stalledSignals = [];
  const stalledTracker = createPosixProcessTracker(63_101, "owner", {
    readProcessIdentity: () => stable,
    listProcessIdentities: () => {
      if (observerStalled) throw new Error("process observation exceeded its fixed deadline");
      return [stable];
    },
    acquireSignalHandle: (identity) => heldSignalHandle(identity, stalledSignals),
    observationIntervalMs: 60_000
  });
  observerStalled = true;
  assert.throws(() => stalledTracker.signal("SIGTERM"), /process observation exceeded its fixed deadline/u);
  assert.equal((await stalledTracker.failure).processTreeUnsettled, true);
  assert.deepEqual(stalledSignals, []);
  stalledTracker.stop();

  const weak = processIdentity(63_201, 1, "coarse-ps-time", true, {
    command: "fixture OPEN_WRANGLER_R_CONTRACT_OWNER=owner",
    identityResolution: "second"
  });
  const weakSignals = [];
  const weakTracker = createPosixProcessTracker(63_201, "owner", {
    readProcessIdentity: () => weak,
    listProcessIdentities: () => [weak],
    observationIntervalMs: 60_000
  });
  assert.throws(() => weakTracker.signal("SIGTERM"), /has no OS-held signal identity/u);
  assert.equal((await weakTracker.failure).processTreeUnsettled, true);
  assert.deepEqual(weakSignals, []);
  weakTracker.stop();
});

test("non-Linux POSIX process observation owns a fixed deadline and weak signal identity", () => {
  let invocation;
  assert.throws(
    () =>
      readPsProcessIdentity(63_301, {
        execute: (command, args, options) => {
          invocation = { command, args, options };
          const error = new Error("spawnSync ps ETIMEDOUT");
          error.code = "ETIMEDOUT";
          throw error;
        }
      }),
    /process 63301 could not be verified.*ETIMEDOUT/u
  );
  assert.equal(invocation.command, "ps");
  assert.deepEqual(invocation.args, ["eww", "-p", "63301", "-o", "pid=,ppid=,pgid=,lstart=,command="]);
  assert.deepEqual(invocation.options, {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 250,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"]
  });

  const identity = readPsProcessIdentity(63_302, {
    ownerToken: "owner",
    execute: () => "63302 1 63302 Fri Aug 21 12:00:00 2026 fixture OPEN_WRANGLER_R_CONTRACT_OWNER=owner\n"
  });
  assert.equal(identity.startIdentity, "Fri Aug 21 12:00:00 2026");
  assert.equal(identity.identityResolution, "second");
  assert.equal(identity.ownerMarked, true);
});

test("a phase without an OS-held identity fails closed without numeric signaling or a later phase", async () => {
  const [first, second] = phases();
  const identity = processIdentity(63_401, 1, "root", true);
  let starts = 0;
  let numericSignals = 0;
  let failure;
  try {
    await runRContractPhases([{ ...first, timeoutMs: 2 }, second], {
      spawnProcess: () => {
        starts += 1;
        return fixtureChild(63_401);
      },
      readProcessIdentity: () => identity,
      listProcessIdentities: () => [identity],
      signalProcess: () => {
        numericSignals += 1;
      },
      terminationGraceMs: 1,
      killGraceMs: 1,
      writeLine: () => {}
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AggregateError);
  assert.equal(starts, 1);
  assert.equal(numericSignals, 0);
  assert.match(failure.message, /stopped after frame:decimal-ordering/u);
  assert.ok(failure.errors[0] instanceof AggregateError);
  assert.match(failure.errors[0].errors[1].message, /no OS-held signal identity/u);
});

test("phase output is byte-bounded and settles before suppressing every later phase", async () => {
  const first = { ...phases()[0], timeoutMs: 5_000 };
  const second = phases()[1];
  let child;
  let starts = 0;
  let tracker;
  let failure;
  let forwardedBytes = 0;
  try {
    await runRContractPhases([first, second], {
      maximumOutputBytes: 32,
      spawnProcess: () => {
        starts += 1;
        child = fixtureChild(64_001);
        tracker = fixtureProcessTracker({ onSignal: (signal) => child.emit("close", null, signal) });
        queueMicrotask(() => child.stdout.write(Buffer.alloc(33, 0x78)));
        return child;
      },
      createProcessTracker: () => tracker,
      terminationGraceMs: 50,
      killGraceMs: 50,
      writeLine: () => {},
      writeOutput: (chunk) => {
        forwardedBytes += chunk.length;
      }
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AggregateError);
  assert.equal(starts, 1);
  assert.equal(forwardedBytes, 0);
  assert.match(failure.message, /stopped after frame:decimal-ordering/u);
  assert.match(failure.errors[0].message, /exceeded its 32-byte stdout\/stderr bound/u);
});

test(
  "a timed-out phase settles through its held direct-child identity before the next phase starts",
  { skip: process.platform === "win32" },
  async () => {
    const held = {
      id: "held",
      label: "held process",
      command: process.execPath,
      args: [
        "-e",
        [
          'process.on("SIGTERM", () => { process.stdout.write("HELD-SIGTERM\\n"); process.exit(0); });',
          "setInterval(() => {}, 1000);"
        ].join("\n")
      ],
      environment: process.env,
      timeoutMs: 150
    };
    const next = {
      id: "next",
      label: "next phase",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      environment: process.env,
      timeoutMs: 2_000
    };
    let firstPid;
    let spawnCount = 0;
    const heldChildren = new Map();
    const lines = [];
    await assert.rejects(
      runRContractPhases([held, next], {
        spawnProcess: (...arguments_) => {
          const child = spawn(...arguments_);
          heldChildren.set(child.pid, child);
          if (spawnCount++ === 0) firstPid = child.pid;
          return child;
        },
        acquireSignalHandle: (identity) => {
          const child = heldChildren.get(identity.pid);
          return child === undefined ? undefined : { signal: (signal) => child.kill(signal) };
        },
        terminationGraceMs: 100,
        killGraceMs: 2_000,
        writeLine: (line) => {
          if (line.startsWith("[r-contract] START next phase")) {
            assert.throws(
              () => process.kill(-firstPid, 0),
              (error) => error?.code === "ESRCH"
            );
          }
          lines.push(line);
        }
      }),
      /1 of 2 selected phases failed/u
    );
    assert.ok(lines.some((line) => line.startsWith("[r-contract] START next phase")));
    assert.throws(
      () => process.kill(-firstPid, 0),
      (error) => error?.code === "ESRCH"
    );
  }
);

test(
  "external SIGINT and SIGTERM use the held direct-child identity",
  { skip: process.platform === "win32" },
  async () => {
    const runnerUrl = new URL("./run-r-contract-tests.mjs", import.meta.url).href;
    const waitForAbsent = async (pid) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error?.code === "ESRCH") return;
          throw error;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      assert.fail(`process ${pid} survived external runner termination`);
    };

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const phaseProgram = [
        `const signal = ${JSON.stringify(signal)};`,
        "process.stdout.write(`PHASE:${process.pid}\\n`);",
        "process.on(signal, () => { process.stdout.write(`PHASE-FORWARDED:${signal}\\n`); process.exit(0); });",
        "setInterval(() => {}, 1000);"
      ].join("\n");
      const outerProgram = [
        'import { spawn } from "node:child_process";',
        `import { runRContractPhasesWithSignalForwarding } from ${JSON.stringify(runnerUrl)};`,
        `const phase = ${JSON.stringify({
          id: "external-signal",
          label: "external signal fixture",
          command: process.execPath,
          args: ["-e", phaseProgram],
          environment: process.env,
          timeoutMs: 30_000
        })};`,
        "let heldChild;",
        "const spawnProcess = (...args) => { heldChild = spawn(...args); return heldChild; };",
        "const acquireSignalHandle = (identity) => identity.pid === heldChild?.pid ? { signal: (signal) => heldChild.kill(signal) } : undefined;",
        "runRContractPhasesWithSignalForwarding([phase], { spawnProcess, acquireSignalHandle }).catch(() => { process.exitCode = 1; });"
      ].join("\n");
      const outer = spawn(process.execPath, ["--input-type=module", "-e", outerProgram], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      outer.stdout.setEncoding("utf8");
      let output = "";
      let phasePid;
      const ready = new Promise((resolveReady, rejectReady) => {
        outer.once("error", rejectReady);
        outer.once("close", (code, exitSignal) => {
          rejectReady(new Error(`external signal fixture exited before readiness: ${code}/${exitSignal}`));
        });
        outer.stdout.on("data", (chunk) => {
          output += chunk;
          const phaseMatch = /PHASE:([1-9][0-9]*)/u.exec(output);
          if (phaseMatch) phasePid = Number(phaseMatch[1]);
          if (Number.isSafeInteger(phasePid)) resolveReady();
        });
      });
      await ready;
      outer.kill(signal);
      const exit = await new Promise((resolveExit, rejectExit) => {
        outer.once("error", rejectExit);
        outer.once("close", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
      });
      assert.deepEqual(exit, { code: 1, signal: null });
      assert.match(output, new RegExp(`PHASE-FORWARDED:${signal}`, "u"));
      await waitForAbsent(phasePid);
    }
  }
);

test("timeout diagnostics preserve primary then cleanup failure and stop later phases", async () => {
  const first = { ...phases()[0], timeoutMs: 2 };
  const second = phases()[1];
  let phaseStarts = 0;
  let failure;
  try {
    await runRContractPhases([first, second], {
      spawnProcess: () => {
        phaseStarts += 1;
        return fixtureChild(41999);
      },
      createProcessTracker: () => fixtureProcessTracker(),
      sleepFor: async () => {},
      terminationGraceMs: 1,
      killGraceMs: 1,
      writeLine: () => {}
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AggregateError);
  assert.equal(phaseStarts, 1);
  assert.match(failure.message, /stopped after frame:decimal-ordering/u);
  assert.ok(failure.errors[0] instanceof AggregateError);
  assert.match(failure.errors[0].errors[0].message, /TIMEOUT native frame contract: decimal-ordering/u);
  assert.match(failure.errors[0].errors[1].message, /remained live after bounded SIGTERM and SIGKILL/u);
});
