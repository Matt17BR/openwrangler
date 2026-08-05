import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_REPORT_PROTOCOL,
  DATA_WRANGLER_STUDY_TOOL_NAMES,
  assertReleaseCompleteStudyReport,
  buildDataWranglerComparisonStudyReport,
  exceedsMaterialRegressionLimit,
  materialRegressionBreaches,
  summarizeComparisonValues,
  summarizeStudyPssSamples,
  type7Quantile,
  validateDataWranglerComparisonStudyTrial
} from "./data-wrangler-comparison-report.mjs";
import {
  STUDY_CELLS,
  buildStudyManifest,
  createDataWranglerComparisonSchedule
} from "./data-wrangler-comparison-study.mjs";

const SHA = "a".repeat(64);

test("uses type-7 min, max, median, and p95 summaries", () => {
  assert.equal(type7Quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(type7Quantile([1, 2, 3, 4], 0.95), 3.8499999999999996);
  assert.deepEqual(summarizeComparisonValues([4, 1, 3, 2]), {
    count: 4,
    median: 2.5,
    p95: 3.8499999999999996,
    minimum: 1,
    maximum: 4
  });
});

test("recomputes one sample's retained process-tree PSS window", () => {
  const evidence = sampleEvidence(1, 10, 150);
  assert.deepEqual(
    summarizeStudyPssSamples(evidence.memory.samples, evidence.milestones, evidence.memory.intervalMs),
    evidence.memory
  );
  const rewritten = structuredClone(evidence.memory.samples);
  rewritten[0].pssBytes = 151;
  assert.equal(summarizeStudyPssSamples(rewritten, evidence.milestones).peakPssBytes, 151);
});

test("rejects a suspended or stalled PSS series with a gap longer than one second", () => {
  const milestones = [mark("run-cell-click", 11_000_000_000), mark("profiles-complete", 14_000_000_000)];
  assert.throws(
    () => summarizeStudyPssSamples([pss(11_100_000_000, 150), pss(13_900_000_000, 160)], milestones),
    /gap longer than one second/u
  );
  assert.throws(
    () => summarizeStudyPssSamples([pss(12_000_000_000, 150)], milestones),
    /continuous measurement-window coverage/u
  );
});

test("validates exactly ten ordered samples inside one scheduled session", () => {
  const manifest = manifestFixture();
  const entry = manifest.schedule[0];
  const trial = sessionResult(entry, manifest);
  assert.equal(validateDataWranglerComparisonStudyTrial(trial, entry, manifest), trial);
  assert.throws(
    () => validateDataWranglerComparisonStudyTrial({ ...trial, samples: trial.samples.slice(0, 9) }, entry, manifest),
    /exactly ten/u
  );
  const reordered = structuredClone(trial);
  reordered.samples[1].index = 1;
  assert.throws(() => validateDataWranglerComparisonStudyTrial(reordered, entry, manifest), /sample 2 index/u);
});

test("validates a two-sample smoke session without weakening the release gate", () => {
  const manifest = manifestFixture({ repetitionsPerSession: 2 });
  const entry = manifest.schedule[0];
  const trial = sessionResult(entry, manifest);
  assert.equal(trial.samples.length, 2);
  assert.equal(validateDataWranglerComparisonStudyTrial(trial, entry, manifest), trial);
  const report = buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials: manifest.schedule.map((scheduled) => sessionResult(scheduled, manifest))
  });
  assert.equal(report.plannedSamples, 16);
  assert.throws(() => assertReleaseCompleteStudyReport(report), /eighty successful samples/u);
});

test("flattens eight sessions into eighty raw samples and eight summaries", () => {
  const manifest = manifestFixture();
  const trials = manifest.schedule.map((entry) => sessionResult(entry, manifest));
  const report = buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials
  });
  assert.equal(report.protocol, DATA_WRANGLER_STUDY_REPORT_PROTOCOL);
  assert.equal(report.plannedSessions, 8);
  assert.equal(report.completedSessions, 8);
  assert.equal(report.plannedSamples, 80);
  assert.equal(report.completedSamples, 80);
  assert.equal(report.samples.length, 80);
  assert.equal(report.summaries.length, 8);
  assert.deepEqual(report.outcomes, { success: 80, failure: 0, timeout: 0 });
  assert.equal(report.summaries[0].metrics.inlinePreviewMs.count, 10);
  assert.equal(report.summaries[0].memory.peakPssBytes.count, 10);
  assert.equal(assertReleaseCompleteStudyReport(report), report);
});

test("accepts the historical raw timing labels while new manifests use summary wording", () => {
  const manifest = structuredClone(manifestFixture());
  assert.match(manifest.method.timingBoundaries.completeProfile, /visiting and verifying every column summary/u);
  manifest.method.timingBoundaries.firstProfile = "public profiling action to the first completed column summary";
  manifest.method.timingBoundaries.completeProfile = "public profiling action to final summaries for every column";
  const report = buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials: manifest.schedule.map((entry) => sessionResult(entry, manifest))
  });
  assert.equal(assertReleaseCompleteStudyReport(report), report);
});

test("keeps p95 descriptive and gates material regressions on the median only", () => {
  const manifest = manifestFixture();
  const trials = manifest.schedule.map((entry) => {
    const values = entry.product === "open-wrangler" ? [100, 100, 100, 100, 100, 100, 100, 100, 100, 10_000] : null;
    return sessionResult(entry, manifest, values);
  });
  const report = buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials
  });
  const open = report.summaries.find(({ cellId, product }) => cellId === "pandas-csv" && product === "open-wrangler");
  const baseline = report.summaries.find(
    ({ cellId, product }) => cellId === "pandas-csv" && product === "data-wrangler"
  );
  assert.ok(open.metrics.inlinePreviewMs.median <= baseline.metrics.inlinePreviewMs.median);
  assert.ok(open.metrics.inlinePreviewMs.p95 > baseline.metrics.inlinePreviewMs.p95);
  assert.deepEqual(materialRegressionBreaches(report), []);
  assert.equal(assertReleaseCompleteStudyReport(report), report);

  const regressed = structuredClone(report);
  const regressedOpen = regressed.summaries.find(
    ({ cellId, product }) => cellId === "pandas-csv" && product === "open-wrangler"
  );
  regressedOpen.metrics.inlinePreviewMs.median = 1_000;
  assert.deepEqual(materialRegressionBreaches(regressed)[0], {
    cellId: "pandas-csv",
    metric: "inlinePreviewMs",
    statistic: "median",
    openWrangler: 1_000,
    dataWrangler: baseline.metrics.inlinePreviewMs.median
  });
  assert.throws(() => assertReleaseCompleteStudyReport(regressed), /pandas-csv inlinePreviewMs median/u);
});

test("release completeness rejects missing sessions or unsuccessful samples", () => {
  const manifest = manifestFixture();
  const trials = manifest.schedule.map((entry) => sessionResult(entry, manifest));
  const incomplete = buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials: trials.slice(0, 7)
  });
  assert.throws(() => assertReleaseCompleteStudyReport(incomplete), /eight complete sessions/u);

  const failed = structuredClone(trials);
  failed[0].samples[0] = failedSample(1);
  const failedReport = buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials: failed
  });
  assert.deepEqual(failedReport.outcomes, { success: 79, failure: 1, timeout: 0 });
  assert.throws(() => assertReleaseCompleteStudyReport(failedReport), /eighty successful samples/u);
});

test("material allowances require both the relative and absolute bound", () => {
  const limit = { relative: 0.2, absolute: 250 };
  assert.equal(exceedsMaterialRegressionLimit(1_240, 1_000, limit), false);
  assert.equal(exceedsMaterialRegressionLimit(1_251, 1_000, limit), true);
  assert.equal(exceedsMaterialRegressionLimit(1_000, 1_000, limit), false);
});

function manifestFixture({ repetitionsPerSession = 10 } = {}) {
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
    python: {
      version: "3.12.11",
      sha256: SHA,
      implementation: "cpython",
      packages: { pandas: "2.3.1", polars: "1.33.1", pyarrow: "21.0.0", jupyter_core: "5.8.1", ipykernel: "6.30.1" }
    },
    fixtures: {
      csv: { rows: 100_000, columns: 50, valuesValidated: true, sha256: SHA },
      parquet: { rows: 1_000_000, columns: 20, valuesValidated: true, sha256: SHA }
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
    toolHashes: Object.fromEntries(DATA_WRANGLER_STUDY_TOOL_NAMES.map((name) => [name, SHA])),
    repetitionsPerSession
  });
}

function sessionResult(entry, manifest, inlineValues = null) {
  const values =
    inlineValues ?? Array.from({ length: manifest.method.repetitionsPerSession }, (_unused, index) => 100 + index);
  return {
    protocol: "openwrangler-comparison-trial-result-v2",
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    format: entry.format,
    kind: "warm",
    order: entry.order,
    samples: values.map((value, index) => sampleEvidence(index + 1, value, 150 + index, entry.columns)),
    provenance: {
      candidate: { version: manifest.provenance.openWrangler.version, sha256: manifest.provenance.openWrangler.sha256 },
      dataWranglerVersion: manifest.provenance.dataWrangler.version,
      editor: { version: manifest.provenance.editor.version, sha256: manifest.provenance.editor.sha256 },
      python: { version: manifest.provenance.python.version, sha256: manifest.provenance.python.sha256 }
    }
  };
}

function sampleEvidence(index, inlinePreviewMs, peakPssBytes, columns = 50) {
  const milestones = milestoneSeries(inlinePreviewMs);
  const measuredEnd = Number(milestones.at(-1).monotonicNs);
  const measured = [];
  for (let at = 11_000_000_000; at < measuredEnd; at += 200_000_000) {
    measured.push(pss(at, measured.length === 0 ? peakPssBytes : peakPssBytes - 1));
  }
  measured.push(pss(measuredEnd, peakPssBytes - 1));
  const rawPss = [...measured];
  return {
    index,
    status: "success",
    failure: null,
    metrics: { inlinePreviewMs, workbenchOpenMs: 20, firstProfileMs: 5, completeProfileMs: 30 },
    milestones,
    publicUi: {
      runCell: action("Run Cell"),
      inline: { ...action("Open in Open Wrangler"), tableReady: true },
      workbench: {
        rootRole: "grid",
        fullShape: "visible-label",
        ariaRowCount: null,
        ariaColumnCount: null,
        verticalOverflow: 100,
        horizontalOverflow: 100,
        pointerUsable: true
      },
      profiling: { ...action("Column profiles and filters"), expectedColumns: columns, completedColumns: columns }
    },
    memory: summarizeStudyPssSamples(rawPss, milestones)
  };
}

function failedSample(index) {
  return {
    index,
    status: "failure",
    failure: { stage: "harness", kind: "harness", message: "setup failed" },
    metrics: { inlinePreviewMs: null, workbenchOpenMs: null, firstProfileMs: null, completeProfileMs: null },
    milestones: [],
    publicUi: { runCell: null, inline: null, workbench: null, profiling: null },
    memory: null
  };
}

function milestoneSeries(inlinePreviewMs) {
  const inline = 11_000_000_000 + inlinePreviewMs * 1_000_000;
  return [
    mark("run-cell-click", 11_000_000_000),
    mark("inline-ready", inline),
    mark("launch-click", inline + 1_000_000),
    mark("workbench-ready", inline + 21_000_000),
    mark("profile-click", inline + 22_000_000),
    mark("first-profile-ready", inline + 27_000_000),
    mark("profiles-complete", inline + 52_000_000)
  ];
}

const action = (accessibleName) => ({ accessibleName, unique: true, pointer: true });
const mark = (name, monotonicNs) => ({ name, monotonicNs: String(monotonicNs) });
const pss = (monotonicNs, pssBytes) => ({ monotonicNs: String(monotonicNs), pssBytes, processCount: 4 });

assert.equal(STUDY_CELLS.length, 4);
assert.equal(createDataWranglerComparisonSchedule().length, 8);
