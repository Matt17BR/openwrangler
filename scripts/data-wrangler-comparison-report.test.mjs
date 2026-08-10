import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_REPORT_PROTOCOL,
  DATA_WRANGLER_STUDY_TOOL_NAMES,
  DATA_WRANGLER_REVIEW_END,
  DATA_WRANGLER_REVIEW_START,
  assertReleaseCompleteStudyReport,
  buildDataWranglerComparisonStudyReport,
  exceedsMaterialRegressionLimit,
  inspectDataWranglerComparisonReview,
  materialRegressionBreaches,
  renderDataWranglerComparisonReview,
  summarizeComparisonValues,
  summarizeStudyPssSamples,
  type7Quantile,
  updateDataWranglerComparisonReview,
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

test("validates exactly five ordered samples inside one scheduled session", () => {
  const manifest = manifestFixture();
  const entry = manifest.schedule[0];
  const trial = sessionResult(entry, manifest);
  assert.equal(validateDataWranglerComparisonStudyTrial(trial, entry, manifest), trial);
  assert.throws(
    () => validateDataWranglerComparisonStudyTrial({ ...trial, samples: trial.samples.slice(0, 4) }, entry, manifest),
    /exactly five/u
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
  assert.throws(() => assertReleaseCompleteStudyReport(report), /forty recorded samples/u);
});

test("flattens eight sessions into forty raw samples and eight summaries", () => {
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
  assert.equal(report.plannedSamples, 40);
  assert.equal(report.completedSamples, 40);
  assert.equal(report.samples.length, 40);
  assert.equal(report.summaries.length, 8);
  assert.deepEqual(report.outcomes, { success: 40, failure: 0, timeout: 0 });
  assert.equal(report.summaries[0].metrics.inlinePreviewMs.count, 5);
  assert.equal(report.summaries[0].memory.peakPssBytes.count, 5);
  assert.equal(assertReleaseCompleteStudyReport(report), report);
});

test("keeps p95 descriptive and gates material regressions on the median only", () => {
  const manifest = manifestFixture();
  const trials = manifest.schedule.map((entry) => {
    const values = entry.product === "open-wrangler" ? [100, 100, 100, 100, 10_000] : null;
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

test("release completeness requires every Open Wrangler sample and three Data Wrangler samples", () => {
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
  assert.deepEqual(failedReport.outcomes, { success: 39, failure: 1, timeout: 0 });
  assert.throws(() => assertReleaseCompleteStudyReport(failedReport), /five Open Wrangler successes/u);

  const baselineWithTwoFailures = structuredClone(trials);
  const baselineTrial = baselineWithTwoFailures.find(({ product }) => product === "data-wrangler");
  baselineTrial.samples[0] = failedSample(1);
  baselineTrial.samples[1] = failedSample(2);
  const baselineReport = buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials: baselineWithTwoFailures
  });
  assert.deepEqual(baselineReport.outcomes, { success: 38, failure: 2, timeout: 0 });
  assert.equal(baselineReport.samples.filter(({ status }) => status === "failure").length, 2);
  assert.equal(assertReleaseCompleteStudyReport(baselineReport), baselineReport);

  baselineTrial.samples[2] = failedSample(3);
  const insufficientBaselineReport = buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials: baselineWithTwoFailures
  });
  assert.throws(() => assertReleaseCompleteStudyReport(insufficientBaselineReport), /at least three Data Wrangler/u);
});

test("material allowances require both the relative and absolute bound", () => {
  const limit = { relative: 0.2, absolute: 250 };
  assert.equal(exceedsMaterialRegressionLimit(1_240, 1_000, limit), false);
  assert.equal(exceedsMaterialRegressionLimit(1_251, 1_000, limit), true);
  assert.equal(exceedsMaterialRegressionLimit(1_000, 1_000, limit), false);
});

test("renders comparison results in workload and product order", () => {
  const report = releaseReport();
  const expected = renderDataWranglerComparisonReview(report);
  const reordered = structuredClone(report);
  reordered.summaries.reverse();

  assert.equal(renderDataWranglerComparisonReview(reordered), expected);
  assert.match(expected, /Collected 2026-08-04 with Open Wrangler 1\.2\.1, Data Wrangler 1\.24\.2/u);
  assert.match(expected, /\[report\.json\]\(report\.json\)/u);
  assert.ok(expected.includes(`Open Wrangler VSIX SHA-256: \`${SHA}\``));
  assert.ok(expected.includes(`CSV fixture: 100,000 × 50, SHA-256 \`${SHA}\``));
  assert.ok(expected.includes(`Parquet fixture: 1,000,000 × 20, SHA-256 \`${SHA}\``));
  assert.match(expected, /Data Wrangler: 1\.24\.2 from Visual Studio Marketplace/u);
  assert.ok(expected.indexOf("| Pandas CSV | Open Wrangler |") < expected.indexOf("| Pandas CSV | Data Wrangler |"));
  assert.ok(expected.indexOf("| Pandas CSV | Data Wrangler |") < expected.indexOf("| Polars CSV | Open Wrangler |"));
  assert.match(expected, /102\.0 ms \(100\.0–104\.0\)/u);

  const changedProvenance = structuredClone(report);
  changedProvenance.provenance.fixtures.csv.sha256 = "not-a-hash";
  assert.throws(() => renderDataWranglerComparisonReview(changedProvenance), /fixture SHA-256/u);
});

test("updates only the marked comparison region and detects stale output", () => {
  const report = releaseReport();
  const prefix = "# Comparison review\n\nA reviewer owns this text.\n\n";
  const suffix = "\n\n## Notes\n\nThese notes also stay untouched.\n";
  const review = `${prefix}${DATA_WRANGLER_REVIEW_START}\nstale\n${DATA_WRANGLER_REVIEW_END}${suffix}`;
  const updated = updateDataWranglerComparisonReview(review, report);

  assert.ok(updated.startsWith(prefix));
  assert.ok(updated.endsWith(suffix));
  assert.deepEqual(inspectDataWranglerComparisonReview(updated, report), []);
  assert.deepEqual(inspectDataWranglerComparisonReview(review, report), [
    "The generated Data Wrangler comparison results in review.md are stale."
  ]);
});

test("requires one ordered pair of standalone review markers", () => {
  const report = releaseReport();
  for (const review of [
    "# Missing markers\n",
    `${DATA_WRANGLER_REVIEW_START}\n${DATA_WRANGLER_REVIEW_START}\n${DATA_WRANGLER_REVIEW_END}`,
    `${DATA_WRANGLER_REVIEW_END}\n${DATA_WRANGLER_REVIEW_START}`,
    `prefix ${DATA_WRANGLER_REVIEW_START}\n${DATA_WRANGLER_REVIEW_END}`
  ]) {
    assert.throws(() => updateDataWranglerComparisonReview(review, report), /Comparison review/u);
  }
});

function releaseReport() {
  const manifest = manifestFixture();
  return buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials: manifest.schedule.map((entry) => sessionResult(entry, manifest))
  });
}

function manifestFixture({ repetitionsPerSession = 5 } = {}) {
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
    failure: { stage: "inline-preview", kind: "product", message: "inline preview failed" },
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
