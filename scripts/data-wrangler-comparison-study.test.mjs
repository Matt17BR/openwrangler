import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_TOOL_NAMES,
  summarizeStudyPssSamples,
  validateLargeDataWranglerComparisonTrial
} from "./data-wrangler-comparison-report.mjs";
import {
  DATA_WRANGLER_VERSION,
  LARGE_COLUMNS,
  LARGE_FIXTURE_PROTOCOL,
  LARGE_MIN_AVAILABLE_MEMORY_BYTES,
  LARGE_ROWS,
  LARGE_TIMEOUTS_MS,
  SMOKE_REPETITIONS,
  STUDY_CELLS,
  STUDY_PROTOCOL,
  TRIAL_REQUEST_PROTOCOL,
  TRIAL_RESULT_PROTOCOL,
  WARM_REPETITIONS,
  assertCompleteLargeReport,
  assertLargeRunEnvironment,
  buildLargeComparisonReport,
  buildLargeStudyManifest,
  buildStudyManifest,
  classifyLinuxPowerSupplies,
  createDataWranglerComparisonSchedule,
  largeComparisonEditorPhaseTimeout,
  loadLargeTrials,
  loadStudyResults,
  prepareTrial,
  removeStaleTrialDirectories,
  runDataWranglerComparisonSmoke,
  runDataWranglerComparisonStudy,
  runLargeComparisonStudy,
  runOneTrial,
  terminalTrialIds,
  validateLargeLoadResult,
  writeDataWranglerComparisonStudyReport
} from "./data-wrangler-comparison-study.mjs";

const SHA = "a".repeat(64);

test("derives the large editor cap from its bounded stages and overhead", () => {
  const innerDeadlines =
    LARGE_TIMEOUTS_MS.preAction * 2 +
    LARGE_TIMEOUTS_MS.inlinePreview +
    LARGE_TIMEOUTS_MS.workbenchOpen +
    LARGE_TIMEOUTS_MS.completeProfile;
  assert.equal(innerDeadlines, 1_140_000);
  assert.equal(LARGE_TIMEOUTS_MS.editorPhase, innerDeadlines + 120_000);
  assert.equal(LARGE_TIMEOUTS_MS.editorPhase, largeComparisonEditorPhaseTimeout(LARGE_TIMEOUTS_MS));
  assert.ok(LARGE_TIMEOUTS_MS.neutralDriver > LARGE_TIMEOUTS_MS.editorPhase);
});

test("classifies battery-less hosts separately from laptops on battery", () => {
  assert.equal(classifyLinuxPowerSupplies([]), "not-applicable");
  assert.equal(classifyLinuxPowerSupplies([{ type: "Mains", online: "1" }]), "not-applicable");
  assert.equal(classifyLinuxPowerSupplies([{ type: "Battery" }, { type: "Mains", online: "1" }]), "ac");
  assert.equal(classifyLinuxPowerSupplies([{ type: "Battery" }, { type: "Mains", online: "0" }]), "battery");
  assert.equal(classifyLinuxPowerSupplies([{ type: undefined }]), "unknown");
});

test("large runs accept stable VM states but still require AC on battery hosts", () => {
  const machine = {
    ...largeProvenanceFixture().machine,
    powerSource: "not-applicable",
    cpuGovernor: "not-exposed"
  };
  const capacity = { availableMemoryBytes: 104 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 };
  assert.doesNotThrow(() => assertLargeRunEnvironment({ machine, capacity }, machine));

  const acMachine = { ...machine, powerSource: "ac" };
  assert.doesNotThrow(() => assertLargeRunEnvironment({ machine: acMachine, capacity }, acMachine));
  const batteryMachine = { ...machine, powerSource: "battery" };
  assert.throws(() => assertLargeRunEnvironment({ machine: batteryMachine, capacity }, batteryMachine), /requires AC/u);
  assert.throws(
    () => assertLargeRunEnvironment({ machine: { ...machine, cpuGovernor: "performance" }, capacity }, machine),
    /changed during the large study/u
  );
  assert.throws(
    () =>
      assertLargeRunEnvironment({ machine, capacity: { ...capacity, availableMemoryBytes: 64 * 1024 ** 3 } }, machine),
    /memory or disk space/u
  );
  assert.equal(LARGE_MIN_AVAILABLE_MEMORY_BYTES, 96 * 1024 ** 3);
  assert.throws(
    () => assertLargeRunEnvironment({ machine, capacity: { ...capacity, freeDiskBytes: 14 * 1024 ** 3 } }, machine),
    /memory or disk space/u
  );
});

test("writes diagnostic report bytes before enforcing release completeness", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-comparison-report-"));
  const output = join(root, "report.json");
  const report = { protocol: "openwrangler-data-wrangler-study-report-v2", completedSessions: 1 };
  try {
    assert.throws(() => writeDataWranglerComparisonStudyReport(output, report), /eight complete sessions/u);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), report);
    assert.throws(() => writeDataWranglerComparisonStudyReport(output, report), /new output path/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schedule has one ten-sample session per product and workload and no cold launches", () => {
  const schedule = createDataWranglerComparisonSchedule();
  assert.equal(schedule.length, 8);
  assert.deepEqual(
    schedule.map(({ order }) => order),
    [...Array(8).keys()]
  );
  assert.equal(new Set(schedule.map(({ id }) => id)).size, 8);
  assert.equal(
    schedule.every(({ kind }) => kind === "warm"),
    true
  );
  for (const cell of STUDY_CELLS) {
    const sessions = schedule.filter(({ cellId }) => cellId === cell.id);
    assert.equal(sessions.length, 2);
    assert.deepEqual(new Set(sessions.map(({ product }) => product)), new Set(["open-wrangler", "data-wrangler"]));
  }
  assert.deepEqual(
    schedule.filter(({ order }) => order % 2 === 0).map(({ product }) => product),
    ["open-wrangler", "data-wrangler", "data-wrangler", "open-wrangler"]
  );
});

test("manifest records eight sessions, ten repetitions, fixed workloads, and public provenance", () => {
  const manifest = manifestFixture();
  assert.equal(manifest.protocol, STUDY_PROTOCOL);
  assert.equal(manifest.schedule.length, 8);
  assert.equal(manifest.method.repetitionsPerSession, 10);
  assert.equal(Object.hasOwn(manifest.method, "coldOrder"), false);
  assert.equal(manifest.provenance.dataWrangler.version, DATA_WRANGLER_VERSION);
  assert.equal(manifest.provenance.dataWrangler.implementationInspection, "none");
  assert.equal(Object.hasOwn(manifest.provenance.dataWrangler, "sha256"), false);
});

test("study resumes at session granularity without replacing completed samples", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-study-"));
  const calls = [];
  try {
    const dependencies = fakeDependencies(calls);
    const options = studyOptions(root);
    const first = await runDataWranglerComparisonStudy({ ...options, limit: 2 }, dependencies);
    assert.equal(first.completed, 2);
    assert.equal(first.remaining, 6);
    const second = await runDataWranglerComparisonStudy({ ...options, limit: 1 }, dependencies);
    assert.equal(second.completed, 3);
    assert.equal(second.remaining, 5);
    assert.deepEqual(
      calls,
      first.manifest.schedule.slice(0, 3).map(({ id }) => id)
    );
    assert.deepEqual(
      [...terminalTrialIds(join(root, "trials"), first.manifest)].sort(),
      first.manifest.schedule
        .slice(0, 3)
        .map(({ id }) => id)
        .sort()
    );
    assert.equal(loadStudyResults(root).trials[0].samples.length, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke runs the two product sessions for one workload", async () => {
  const root = join(tmpdir(), `ow-batched-smoke-${process.pid}-${Date.now()}`);
  const calls = [];
  try {
    const result = await runDataWranglerComparisonSmoke(studyOptions(root), fakeDependencies(calls));
    assert.equal(result.completed, 2);
    assert.equal(result.remaining, 6);
    assert.equal(new Set(calls).size, 2);
    assert.equal(result.manifest.method.repetitionsPerSession, SMOKE_REPETITIONS);
    assert.equal(
      loadStudyResults(root).trials.every(({ samples }) => samples.length === SMOKE_REPETITIONS),
      true
    );
    assert.deepEqual(
      new Set(result.manifest.schedule.slice(0, 2).map(({ product }) => product)),
      new Set(["open-wrangler", "data-wrangler"])
    );
    const resumedCalls = [];
    const resumed = await runDataWranglerComparisonSmoke(studyOptions(root), fakeDependencies(resumedCalls));
    assert.equal(resumed.completed, 2);
    assert.deepEqual(resumedCalls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted session is recorded and rerun without replacing successful sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-failure-"));
  try {
    const dependencies = fakeDependencies([]);
    dependencies.runTrial = async () => {
      throw new Error("file:///private/source.csv $HOME /home/alice/source.csv");
    };
    const status = await runDataWranglerComparisonStudy({ ...studyOptions(root), limit: 1 }, dependencies);
    assert.equal(status.completed, 0);
    assert.equal(status.remaining, 8);
    const [trial] = loadStudyResults(root).trials;
    assert.equal(trial.samples.length, 10);
    assert.equal(
      trial.samples.every(({ status: sampleStatus }) => sampleStatus === "failure"),
      true
    );
    assert.equal(JSON.stringify(trial).includes("/private"), false);
    assert.equal(JSON.stringify(trial).includes("$HOME"), false);

    const calls = [];
    const resumed = await runDataWranglerComparisonStudy({ ...studyOptions(root), limit: 1 }, fakeDependencies(calls));
    assert.equal(resumed.completed, 1);
    assert.equal(resumed.remaining, 7);
    assert.deepEqual(calls, [resumed.manifest.schedule[0].id]);
    assert.equal(
      loadStudyResults(root).trials[0].samples.every(({ status: sampleStatus }) => sampleStatus === "success"),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a measured product failure remains in the study instead of being retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-product-failure-"));
  try {
    const manifest = manifestFixture();
    const dependencies = fakeDependencies([]);
    dependencies.runTrial = async (request) => {
      const entry = manifest.schedule.find(({ id }) => id === request.trialId);
      const result = sessionResult(entry, manifest, request.repetitions);
      result.samples[0] = failedProductSample(1);
      return result;
    };
    const first = await runDataWranglerComparisonStudy({ ...studyOptions(root), limit: 1 }, dependencies);
    assert.equal(first.completed, 1);
    assert.equal(first.remaining, 7);

    const calls = [];
    const resumed = await runDataWranglerComparisonStudy({ ...studyOptions(root), limit: 1 }, fakeDependencies(calls));
    assert.equal(resumed.completed, 2);
    assert.deepEqual(calls, [resumed.manifest.schedule[1].id]);
    const retained = loadStudyResults(root).trials.find(({ trialId }) => trialId === resumed.manifest.schedule[0].id);
    assert.equal(retained.samples[0].failure.kind, "product");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session deadline yields ten timeout samples", async () => {
  const manifest = manifestFixture();
  const entry = manifest.schedule[0];
  const request = requestForEntry(entry, manifest);
  const result = await runOneTrial({ entry, request, runTrial: () => new Promise(() => {}), timeoutMs: 5 });
  assert.equal(result.protocol, TRIAL_RESULT_PROTOCOL);
  assert.equal(result.samples.length, 10);
  assert.equal(
    result.samples.every(({ status }) => status === "timeout"),
    true
  );
});

test("prepared request loads one resident dataframe and asks the host for ten measured samples", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-prepare-"));
  const csv = join(root, "fixture.csv");
  const parquet = join(root, "fixture.parquet");
  writeFileSync(csv, "c00\n0\n");
  writeFileSync(parquet, "parquet fixture");
  const manifest = manifestFixture({ csvHash: hashFile(csv), parquetHash: hashFile(parquet) });
  const trialRoot = join(root, "session");
  try {
    const prepared = prepareTrial({
      entry: manifest.schedule[0],
      manifest,
      options: { ...studyOptions(root), csv, parquet },
      trialRoot
    });
    assert.equal(prepared.request.protocol, TRIAL_REQUEST_PROTOCOL);
    assert.equal(prepared.request.kind, "warm");
    assert.equal(prepared.request.repetitions, WARM_REPETITIONS);
    assert.equal(prepared.request.cell.profileContract, "integer-sentinel");
    assert.equal(prepared.request.cell.columnNames.length, prepared.request.cell.columns);
    const notebook = JSON.parse(readFileSync(prepared.request.notebookPath, "utf8"));
    assert.equal(notebook.cells.length, 2);
    assert.match(notebook.cells[0].source.join(""), /study_frame = pd\.read_csv/u);
    assert.equal(notebook.cells[1].source.join(""), "study_frame");
    assert.doesNotThrow(prepared.verifySources);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale temporary session roots are removed without touching unrelated entries", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-stale-"));
  try {
    mkdirSync(join(root, "trial-001-AbCd12"));
    mkdirSync(join(root, "keep-me"));
    removeStaleTrialDirectories(root);
    assert.equal(existsSync(join(root, "trial-001-AbCd12")), false);
    assert.equal(existsSync(join(root, "keep-me")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large schedule covers its pilot and marks a four-run group inconclusive", () => {
  const manifest = largeManifestFixture();
  assert.equal(manifest.schedule.length, 20);
  assert.deepEqual(
    manifest.schedule.slice(0, 4).map(({ engine, product }) => `${engine}.${product}`),
    ["pandas.open-wrangler", "pandas.data-wrangler", "polars.data-wrangler", "polars.open-wrangler"]
  );
  const loads = manifest.schedule.filter(({ measureNativeLoad }) => measureNativeLoad);
  assert.equal(loads.length, 10);
  for (const engine of ["pandas", "polars"]) {
    assert.equal(loads.filter((entry) => entry.engine === engine).length, 5);
    assert.equal(
      new Set(manifest.schedule.filter((entry) => entry.engine === engine).map((entry) => entry.product)).size,
      2
    );
  }
  const trials = manifest.schedule.map((entry) => sessionResult(entry, manifest, 1));
  const partialTrial = trials.find((trial) => trial.engine === "pandas" && trial.product === "open-wrangler");
  const partial = partialTrial.samples[0];
  partial.status = "timeout";
  partial.failure = { stage: "profile-all", kind: "timeout", message: "profile timeout" };
  partial.metrics.completeProfileMs = null;
  partial.milestones.pop();
  partial.memory = null;
  const report = buildLargeComparisonReport({
    generatedAtUtc: manifest.createdAtUtc,
    manifest,
    trials,
    loads: loads.map(largeLoadResult)
  });
  const summary = report.summaries.find(({ engine, product }) => engine === "pandas" && product === "open-wrangler");
  assert.deepEqual(
    [summary.completed, summary.successful, summary.headlineStatus, summary.metrics],
    [5, 4, "inconclusive", null]
  );
  const retained = report.trials.find(({ trialId }) => trialId === partialTrial.trialId)?.samples[0];
  assert.deepEqual([retained.status, retained.metrics.inlinePreviewMs], ["timeout", 10]);
  const completeSummary = report.summaries.find(
    ({ engine, product }) => engine === "polars" && product === "open-wrangler"
  );
  assert.deepEqual(
    [completeSummary.headlineStatus, completeSummary.metrics.runCellToWorkbenchMs.median],
    ["complete", 31]
  );
  assert.equal(Object.hasOwn(completeSummary.metrics.inlinePreviewMs, "p95"), false);
  assert.doesNotThrow(() => assertCompleteLargeReport(report));
});

test("large results must match their scheduled run and contain valid measurements", () => {
  const manifest = largeManifestFixture();
  const entry = manifest.schedule.find(({ measureNativeLoad }) => measureNativeLoad);
  const trial = sessionResult(entry, manifest, 1);
  const load = largeLoadResult(entry);

  assert.doesNotThrow(() => validateLargeDataWranglerComparisonTrial(trial, entry, manifest));
  assert.doesNotThrow(() => validateLargeLoadResult(load, entry));

  assert.throws(
    () => validateLargeDataWranglerComparisonTrial({ ...trial, product: "data-wrangler" }, entry, manifest),
    /scheduled product/u
  );
  const negativeTiming = structuredClone(trial);
  negativeTiming.samples[0].metrics.inlinePreviewMs = -1;
  assert.throws(
    () => validateLargeDataWranglerComparisonTrial(negativeTiming, entry, manifest),
    /inlinePreviewMs does not match/u
  );
  const negativeMemory = structuredClone(trial);
  negativeMemory.samples[0].memory.samples[0].pssBytes = -1;
  assert.throws(() => validateLargeDataWranglerComparisonTrial(negativeMemory, entry, manifest), /invalid bytes/u);
  assert.throws(() => validateLargeLoadResult({ ...load, protocol: "wrong" }, entry), /scheduled run/u);
  assert.throws(() => validateLargeLoadResult({ ...load, elapsedMs: Number.NaN }, entry), /scheduled run/u);
  assert.throws(() => validateLargeLoadResult({ ...load, peakRssBytes: -1 }, entry), /scheduled run/u);
});

test("stored large results are validated before they can be reported", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-large-stored-results-"));
  const manifest = largeManifestFixture();
  const entry = manifest.schedule.find(({ measureNativeLoad }) => measureNativeLoad);
  try {
    mkdirSync(join(root, "trials"));
    mkdirSync(join(root, "loads"));
    writeFileSync(join(root, "trials", `${entry.id}.json`), JSON.stringify(sessionResult(entry, manifest, 1)));
    writeFileSync(
      join(root, "loads", `${entry.id}.json`),
      JSON.stringify({ ...largeLoadResult(entry), engine: entry.engine === "pandas" ? "polars" : "pandas" })
    );
    assert.throws(() => loadLargeTrials(root, manifest), /scheduled run/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large study records 20 fixed attempts, five native loads per engine, and resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-large-study-"));
  const journeys = [];
  const loads = [];
  let checks = 0;
  const manifest = largeManifestFixture();
  const failedId = manifest.schedule.find(({ measureNativeLoad }) => measureNativeLoad).id;
  const dependencies = {
    now: () => manifest.createdAtUtc,
    prepareTools: async () => {},
    captureProvenance: async () => largeProvenanceFixture(),
    inspectRunEnvironment: async () => {
      checks += 1;
      return {
        machine: manifest.provenance.machine,
        capacity: { availableMemoryBytes: 104 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 }
      };
    },
    prepareTrial: ({ entry, trialRoot }) => ({
      request: {
        trialId: entry.id,
        cell: entry,
        isolatedRoot: trialRoot
      },
      verifySource() {}
    }),
    runLoad: async (request) => {
      loads.push(request.trialId);
      return largeLoadResult({ id: request.trialId, engine: request.cell.engine });
    },
    runJourney: async (request) => {
      journeys.push(request.trialId);
      if (request.trialId === failedId) throw new Error("synthetic editor failure");
      const entry = manifest.schedule.find(({ id }) => id === request.trialId);
      return sessionResult(entry, manifest, 1);
    }
  };
  try {
    assert.deepEqual(await runLargeComparisonStudy({ output: root, confirmLargeStudy: true }, dependencies), {
      completed: 20,
      remaining: 0
    });
    await runLargeComparisonStudy({ output: root, confirmLargeStudy: true }, dependencies);
    assert.deepEqual([journeys.length, loads.length, checks], [20, 10, 20]);
    assert.match(readFileSync(join(root, "trials", `${failedId}.json`), "utf8"), /synthetic editor failure/u);
    assert.equal(existsSync(join(root, "loads", `${failedId}.json`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeDependencies(calls) {
  const manifest = manifestFixture();
  return {
    now: () => manifest.createdAtUtc,
    prepareTools: async () => {},
    inspectCandidate: async () => manifest.provenance.openWrangler,
    inspectEditor: async () => manifest.provenance.editor,
    inspectPython: async () => manifest.provenance.python,
    inspectMachine: () => manifest.provenance.machine,
    validateFixtures: async () => manifest.provenance.fixtures,
    hashFile: () => SHA,
    prepareTrial: ({ entry, manifest: activeManifest, trialRoot }) => ({
      request: requestForEntry(entry, activeManifest, trialRoot),
      verifySources() {}
    }),
    runTrial: async (request) => {
      calls.push(request.trialId);
      const entry = manifest.schedule.find(({ id }) => id === request.trialId);
      return sessionResult(entry, manifest, request.repetitions);
    }
  };
}

function studyOptions(output) {
  return {
    candidate: "/tmp/openwrangler.vsix",
    python: "/tmp/python3.12",
    editor: "/tmp/code",
    editorCli: "/tmp/code-cli",
    csv: "/tmp/study.csv",
    parquet: "/tmp/study.parquet",
    output
  };
}

function manifestFixture({ csvHash = SHA, parquetHash = SHA } = {}) {
  return buildStudyManifest({
    createdAtUtc: "2026-08-04T10:00:00.000Z",
    candidate: { version: "1.2.1", sha256: SHA },
    editor: {
      version: "1.131.0",
      sha256: SHA,
      cliSha256: SHA,
      productSha256: SHA,
      distribution: "Visual Studio Code"
    },
    python: { version: "3.12.11", sha256: SHA, implementation: "cpython", packages: {} },
    fixtures: {
      csv: { rows: 100_000, columns: 50, valuesValidated: true, sha256: csvHash },
      parquet: { rows: 1_000_000, columns: 20, valuesValidated: true, sha256: parquetHash }
    },
    machine: {
      os: "linux",
      osRelease: "6.8",
      architecture: "x64",
      cpuModel: "Example CPU",
      logicalCpuCount: 8,
      totalMemoryBytes: 16_000_000_000,
      powerSource: "ac",
      cpuGovernor: "performance"
    },
    toolHashes: Object.fromEntries(DATA_WRANGLER_STUDY_TOOL_NAMES.map((name) => [name, SHA]))
  });
}

function largeProvenanceFixture() {
  return {
    candidate: { version: "1.2.3", sha256: SHA },
    editor: { version: "1.132.0", sha256: SHA, cliSha256: SHA },
    python: { version: "3.12.13", sha256: SHA },
    fixture: {
      protocol: LARGE_FIXTURE_PROTOCOL,
      rows: LARGE_ROWS,
      columns: LARGE_COLUMNS,
      rowGroupRows: 100_000,
      bytes: 5_000_000_000,
      sha256: SHA,
      schema: Array.from({ length: LARGE_COLUMNS }, (_unused, index) => ({
        name: `benchmark_field_${String(index).padStart(3, "0")}`
      })),
      profileSentinels: {}
    },
    machine: { ...manifestFixture().provenance.machine, totalMemoryBytes: 64 * 1024 ** 3 },
    tools: {}
  };
}

function largeManifestFixture() {
  return buildLargeStudyManifest({ createdAtUtc: "2026-08-05T10:00:00.000Z", ...largeProvenanceFixture() });
}

function largeLoadResult(entry) {
  return {
    trialId: entry.id,
    protocol: "openwrangler-large-parquet-load-v1",
    engine: entry.engine,
    elapsedMs: 1_000,
    rows: LARGE_ROWS,
    columns: LARGE_COLUMNS,
    peakRssBytes: 300
  };
}

function requestForEntry(entry, manifest, isolatedRoot = "/tmp/ow-comparison-session") {
  return {
    protocol: TRIAL_REQUEST_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    kind: "warm",
    order: entry.order,
    repetitions: manifest.method.repetitionsPerSession,
    isolatedRoot,
    candidate: { path: "/tmp/openwrangler.vsix", ...manifest.provenance.openWrangler },
    dataWranglerVersion: manifest.provenance.dataWrangler.version,
    editor: { path: "/tmp/code", cliPath: "/tmp/code-cli", ...manifest.provenance.editor },
    python: { path: "/tmp/python", ...manifest.provenance.python }
  };
}

function sessionResult(entry, manifest, repetitions = manifest.method.repetitionsPerSession) {
  return {
    protocol: TRIAL_RESULT_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    format: entry.format,
    kind: "warm",
    order: entry.order,
    samples: Array.from({ length: repetitions }, (_unused, index) => successfulSample(index + 1, entry.columns)),
    provenance: {
      candidate: { version: manifest.provenance.openWrangler.version, sha256: manifest.provenance.openWrangler.sha256 },
      dataWranglerVersion: manifest.provenance.dataWrangler.version,
      editor: { version: manifest.provenance.editor.version, sha256: manifest.provenance.editor.sha256 },
      python: { version: manifest.provenance.python.version, sha256: manifest.provenance.python.sha256 }
    }
  };
}

function successfulSample(index, columns) {
  const milestones = [
    mark("run-cell-click", 11_000_000_000),
    mark("inline-ready", 11_010_000_000),
    mark("launch-click", 11_011_000_000),
    mark("workbench-ready", 11_031_000_000),
    mark("profile-click", 11_032_000_000),
    mark("first-profile-ready", 11_037_000_000),
    mark("profiles-complete", 11_062_000_000)
  ];
  const memory = summarizeStudyPssSamples([pss(11_000_000_000, 150), pss(11_062_000_000, 149)], milestones);
  return {
    index,
    status: "success",
    failure: null,
    metrics: { inlinePreviewMs: 10, workbenchOpenMs: 20, firstProfileMs: 5, completeProfileMs: 30 },
    milestones,
    publicUi: {
      runCell: action("Run Cell"),
      inline: { ...action("Open in viewer"), tableReady: true },
      workbench: {
        rootRole: "grid",
        fullShape: "visible-label",
        ariaRowCount: null,
        ariaColumnCount: null,
        verticalOverflow: 100,
        horizontalOverflow: 100,
        pointerUsable: true
      },
      profiling: { ...action("Column profiles"), expectedColumns: columns, completedColumns: columns }
    },
    memory
  };
}

function failedProductSample(index) {
  return {
    index,
    status: "failure",
    failure: { stage: "inline-preview", kind: "product", message: "The inline preview failed." },
    metrics: { inlinePreviewMs: null, workbenchOpenMs: null, firstProfileMs: null, completeProfileMs: null },
    milestones: [mark("run-cell-click", 11_000_000_000)],
    publicUi: { runCell: action("Run Cell"), inline: null, workbench: null, profiling: null },
    memory: null
  };
}

const action = (accessibleName) => ({ accessibleName, unique: true, pointer: true });
const mark = (name, monotonicNs) => ({ name, monotonicNs: String(monotonicNs) });
const pss = (monotonicNs, pssBytes) => ({ monotonicNs: String(monotonicNs), pssBytes, processCount: 4 });
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
