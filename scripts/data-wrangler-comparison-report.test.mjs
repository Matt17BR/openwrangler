import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_REPORT_PROTOCOL,
  DATA_WRANGLER_STUDY_TOOL_NAMES,
  buildDataWranglerComparisonStudyReport,
  summarizeComparisonValues,
  summarizeStudyPssSamples,
  type7Quantile,
  validateDataWranglerComparisonStudyTrial
} from "./data-wrangler-comparison-report.mjs";

const digest = (value) => value.repeat(64);

test("uses type-7 statistics and recomputes retained PSS evidence", () => {
  assert.equal(type7Quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(type7Quantile([1, 2, 3, 4], 0.95), 3.8499999999999996);
  assert.deepEqual(summarizeComparisonValues([4, 1, 3, 2]), {
    count: 4,
    median: 2.5,
    p95: 3.8499999999999996,
    minimum: 1,
    maximum: 4
  });
  assert.deepEqual(summarizeStudyPssSamples(pssSamples(), milestones()), {
    baselinePssBytes: 110,
    peakPssBytes: 150,
    adjustedPeakPssBytes: 40,
    sampleCount: 3,
    intervalMs: 200,
    samples: pssSamples()
  });
  assert.throws(() => summarizeStudyPssSamples([pss("90", 100), pss("50", 120)], milestones()), /increase strictly/u);
  assert.throws(
    () => summarizeStudyPssSamples([pss("100000000", 100), pss("160000000", 120)], milestones()),
    /pre-action baseline/u
  );
  assert.throws(
    () => summarizeStudyPssSamples([pss("50000000", 100), pss("90000000", 120), pss("190000000", 150)], milestones()),
    /inside the measurement window/u
  );
  assert.throws(() => summarizeStudyPssSamples(pssSamples(), []), /measurement window/u);
});

test("binds trials to the exact schedule and provenance and rejects rewritten PSS", () => {
  const manifest = studyManifest();
  const entry = manifest.schedule[0];
  const trial = studyTrial(entry, manifest);
  assert.equal(validateDataWranglerComparisonStudyTrial(trial, entry, manifest), trial);
  for (const [mutated, expected] of [
    [
      { ...trial, product: trial.product === "open-wrangler" ? "data-wrangler" : "open-wrangler" },
      /scheduled product/u
    ],
    [{ ...trial, order: 42 }, /scheduled order/u],
    [
      { ...trial, provenance: { ...trial.provenance, editor: { ...trial.provenance.editor, sha256: digest("9") } } },
      /editor SHA-256/u
    ],
    [{ ...trial, memory: { ...trial.memory, peakPssBytes: 151 } }, /memory peakPssBytes/u],
    [
      {
        ...trial,
        memory: { ...trial.memory, samples: trial.memory.samples.map((sample, index) => ({ ...sample, index })) }
      },
      /sanitized PSS samples/u
    ]
  ]) {
    assert.throws(() => validateDataWranglerComparisonStudyTrial(mutated, entry, manifest), expected);
  }
});

test("validates host timings at the retained microsecond precision", () => {
  const manifest = studyManifest();
  const entry = manifest.schedule[0];
  const trial = studyTrial(entry, manifest, 10.123);
  assert.equal(validateDataWranglerComparisonStudyTrial(trial, entry, manifest), trial);
});

test("retains raw trials in the report and derives paired summaries", () => {
  const manifest = studyManifest();
  const firstPair = manifest.schedule.slice(0, 2);
  const open = studyTrial(
    firstPair.find(({ product }) => product === "open-wrangler"),
    manifest
  );
  const baseline = studyTrial(
    firstPair.find(({ product }) => product === "data-wrangler"),
    manifest,
    15,
    200
  );
  const report = buildDataWranglerComparisonStudyReport({
    generatedAtUtc: "2026-08-04T12:00:00.000Z",
    manifest,
    trials: [open, baseline]
  });
  assert.equal(report.protocol, DATA_WRANGLER_STUDY_REPORT_PROTOCOL);
  assert.deepEqual(report.trials, [baseline, open]);
  assert.deepEqual(
    report.trials.find(({ product }) => product === "open-wrangler").memory.samples,
    open.memory.samples
  );
  assert.equal(report.incompleteTrialIds.length, 94);
  const paired = report.pairedWarm.find(
    ({ cellId, metric }) => cellId === "pandas-csv" && metric === "inlinePreviewMs"
  );
  assert.equal(paired.differences.median, -5);
});

test("requires complete editor, Python, fixture, and machine provenance", () => {
  const manifest = studyManifest();
  const trial = studyTrial(manifest.schedule[0], manifest);
  for (const [change, expected] of [
    [(copy) => (copy.provenance.editor.cliSha256 = "bad"), /editor CLI SHA-256/u],
    [(copy) => (copy.provenance.editor.distribution = "Code - OSS"), /editor distribution/u],
    [(copy) => (copy.provenance.python.implementation = "pypy"), /Python implementation/u],
    [(copy) => (copy.provenance.fixtures.csv.valuesValidated = false), /fixture value validation/u],
    [(copy) => delete copy.provenance.machine.cpuModel, /machine provenance/u]
  ]) {
    const invalid = structuredClone(manifest);
    change(invalid);
    assert.throws(
      () =>
        buildDataWranglerComparisonStudyReport({
          generatedAtUtc: "2026-08-04T12:00:00.000Z",
          manifest: invalid,
          trials: [trial]
        }),
      expected
    );
  }
});

test("rejects a study schedule whose product order is not counterbalanced", () => {
  const manifest = studyManifest();
  const invalid = structuredClone(manifest);
  const pair = invalid.schedule.filter(
    ({ cellId, kind, repetition }) => cellId === "pandas-csv" && kind === "warm" && repetition === 2
  );
  assert.equal(pair.length, 2);
  [pair[0].product, pair[1].product] = [pair[1].product, pair[0].product];
  assert.throws(
    () =>
      buildDataWranglerComparisonStudyReport({
        generatedAtUtc: "2026-08-04T12:00:00.000Z",
        manifest: invalid,
        trials: []
      }),
    /not counterbalanced/u
  );
});

function studyManifest() {
  const cells = [
    { id: "pandas-csv", engine: "pandas", format: "csv", rows: 100_000, columns: 50 },
    { id: "polars-csv", engine: "polars", format: "csv", rows: 100_000, columns: 50 },
    { id: "pandas-parquet", engine: "pandas", format: "parquet", rows: 1_000_000, columns: 20 },
    { id: "polars-parquet", engine: "polars", format: "parquet", rows: 1_000_000, columns: 20 }
  ];
  const schedule = [];
  for (let repetition = 1; repetition <= 10; repetition += 1) {
    for (const [cellIndex, cell] of cells.entries()) {
      addPair(schedule, `warm.${cell.id}.r${repetition}`, "warm", repetition, cell, (repetition + cellIndex) % 2 !== 0);
    }
  }
  for (const cell of cells) {
    addPair(schedule, `cold.${cell.id}.ab`, "cold", 1, cell);
    addPair(schedule, `cold.${cell.id}.ba`, "cold", 2, cell, true);
  }
  return {
    protocol: "openwrangler-data-wrangler-study-v1",
    method: { cells },
    provenance: {
      openWrangler: { extensionId: "Matt17BR.openwrangler", version: "1.2.1", sha256: digest("a") },
      dataWrangler: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
      editor: {
        version: "1.131.0",
        sha256: digest("b"),
        cliSha256: digest("c"),
        productSha256: digest("d"),
        distribution: "Visual Studio Code"
      },
      python: { version: "3.12.13", sha256: digest("e"), implementation: "cpython", packages: {} },
      fixtures: {
        csv: { rows: 100_000, columns: 50, valuesValidated: true, sha256: digest("f") },
        parquet: { rows: 1_000_000, columns: 20, valuesValidated: true, sha256: digest("1") }
      },
      machine: {
        os: "linux",
        osRelease: "6.8.0",
        architecture: "x64",
        cpuModel: "Test CPU",
        logicalCpuCount: 8,
        totalMemoryBytes: 16_000_000_000,
        powerSource: "ac",
        cpuGovernor: "performance"
      },
      tools: Object.fromEntries(
        DATA_WRANGLER_STUDY_TOOL_NAMES.map((name, index) => [name, digest("abcdef0123456789"[index % 16])])
      )
    },
    schedule
  };
}

function addPair(schedule, pairId, kind, repetition, cell, reverse = false) {
  const products = reverse ? ["data-wrangler", "open-wrangler"] : ["open-wrangler", "data-wrangler"];
  for (const [orderInPair, product] of products.entries()) {
    schedule.push({
      id: `${pairId}.${orderInPair + 1}.${product}`,
      pairId,
      kind,
      repetition,
      cellId: cell.id,
      engine: cell.engine,
      format: cell.format,
      rows: cell.rows,
      columns: cell.columns,
      product,
      orderInPair,
      order: schedule.length
    });
  }
}

function studyTrial(entry, manifest, inlinePreviewMs = 10, peakPssBytes = 150) {
  const marks = milestones(inlinePreviewMs);
  const samples = pssSamples(peakPssBytes);
  return {
    protocol: "openwrangler-comparison-trial-result-v1",
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    format: entry.format,
    kind: entry.kind,
    order: entry.order,
    status: "success",
    failure: null,
    metrics: { inlinePreviewMs, workbenchOpenMs: 20, firstProfileMs: 5, completeProfileMs: 30 },
    milestones: marks,
    publicUi: publicUi(entry),
    memory: {
      baselinePssBytes: 110,
      peakPssBytes,
      adjustedPeakPssBytes: peakPssBytes - 110,
      sampleCount: samples.length,
      intervalMs: 200,
      samples
    },
    provenance: {
      candidate: {
        version: manifest.provenance.openWrangler.version,
        sha256: manifest.provenance.openWrangler.sha256
      },
      dataWranglerVersion: "1.24.2",
      editor: { version: manifest.provenance.editor.version, sha256: manifest.provenance.editor.sha256 },
      python: { version: manifest.provenance.python.version, sha256: manifest.provenance.python.sha256 }
    }
  };
}

function milestones(inlinePreviewMs = 10) {
  return [
    mark("run-cell-click", 100_000_000),
    mark("inline-ready", 100_000_000 + inlinePreviewMs * 1_000_000),
    mark("launch-click", 120_000_000),
    mark("workbench-ready", 140_000_000),
    mark("profile-click", 150_000_000),
    mark("first-profile-ready", 155_000_000),
    mark("profiles-complete", 180_000_000)
  ];
}

function mark(name, monotonicNs) {
  return { name, monotonicNs: String(monotonicNs) };
}

function pssSamples(peak = 150) {
  return [pss("50000000", 100), pss("90000000", 120), pss("160000000", peak)];
}

function pss(monotonicNs, pssBytes) {
  return { monotonicNs, pssBytes, processCount: 3 };
}

function publicUi(entry) {
  const action = { accessibleName: "Open in product", unique: true, pointer: true };
  return {
    runCell: { ...action, accessibleName: "Run Cell" },
    inline: { ...action, tableReady: true },
    workbench: {
      rootRole: "grid",
      fullShape: "aria-counts",
      ariaRowCount: entry.rows,
      ariaColumnCount: entry.columns,
      verticalOverflow: 100,
      horizontalOverflow: 100,
      pointerUsable: true
    },
    profiling: {
      ...action,
      accessibleName: "Profile columns",
      expectedColumns: entry.columns,
      completedColumns: entry.columns
    }
  };
}
