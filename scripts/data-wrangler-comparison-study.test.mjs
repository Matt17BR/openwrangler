import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_CELLS,
  DATA_WRANGLER_STUDY_FRAGMENT_PROTOCOL,
  DATA_WRANGLER_STUDY_MANIFEST_PROTOCOL,
  DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
  DATA_WRANGLER_STUDY_PRODUCTS,
  DATA_WRANGLER_STUDY_RESULT_PROTOCOL,
  DATA_WRANGLER_STUDY_SCHEDULE_SHA256,
  buildDataWranglerStudyManifest,
  buildDataWranglerStudyResult,
  calculatePairedStudyRegression,
  calculateStudyPssSegments,
  createDataWranglerStudySchedule,
  createEmptyStudyMilestones,
  createStudyFragmentIdentity,
  digestStudyValue,
  loadDataWranglerStudyFragments,
  pendingDataWranglerStudyTrials,
  publishDataWranglerStudyFragment,
  summarizeStudyMetric,
  type7Quantile,
  validateDataWranglerStudyFragment,
  validateDataWranglerStudyManifest,
  validateDataWranglerStudyResult
} from "./data-wrangler-comparison-study.mjs";

const digest = (value) => value.repeat(64);

test("the fixed study schedule has four interleaved warm cells, ten balanced pairs, and cold AB/BA", () => {
  assert.deepEqual(DATA_WRANGLER_STUDY_PRODUCTS, ["open-wrangler", "data-wrangler"]);
  const first = createDataWranglerStudySchedule();
  const second = createDataWranglerStudySchedule();
  assert.deepEqual(first, second);
  assert.equal(digestStudyValue(first), DATA_WRANGLER_STUDY_SCHEDULE_SHA256);
  assert.equal(first.length, 96);
  assert.deepEqual(
    first.map((entry) => entry.sequence),
    [...Array(96).keys()]
  );

  const warm = first.filter((entry) => entry.kind === "warm");
  const cold = first.filter((entry) => entry.kind === "cold");
  assert.equal(warm.length, 80);
  assert.equal(cold.length, 16);
  for (const cell of DATA_WRANGLER_STUDY_CELLS) {
    const firstProducts = warm
      .filter((entry) => entry.cellId === cell.id && entry.orderInPair === 1)
      .map((entry) => entry.product);
    assert.equal(firstProducts.length, 10);
    assert.equal(firstProducts.filter((product) => product === "open-wrangler").length, 5);
    assert.equal(firstProducts.filter((product) => product === "data-wrangler").length, 5);
    const coldOrders = cold
      .filter((entry) => entry.cellId === cell.id)
      .reduce((orders, entry) => {
        const current = orders.get(entry.blockId) ?? [];
        current.push(entry.product);
        orders.set(entry.blockId, current);
        return orders;
      }, new Map());
    assert.deepEqual(
      [...coldOrders.values()],
      [
        ["open-wrangler", "data-wrangler"],
        ["data-wrangler", "open-wrangler"]
      ]
    );
  }
  for (let repetition = 1; repetition <= 10; repetition += 1) {
    const cells = warm
      .filter((entry) => entry.repetition === repetition && entry.orderInPair === 1)
      .map((entry) => entry.cellId);
    assert.deepEqual(new Set(cells), new Set(DATA_WRANGLER_STUDY_CELLS.map((cell) => cell.id)));
  }
});

test("the versioned manifest binds the approved method, candidate, editor, Python, fixtures, and seeded schedule", () => {
  const manifest = studyManifest();
  assert.equal(manifest.protocol, DATA_WRANGLER_STUDY_MANIFEST_PROTOCOL);
  assert.equal(validateDataWranglerStudyManifest(manifest), manifest);
  assert.match(digestStudyValue(manifest), /^[0-9a-f]{64}$/u);

  const changedSchedule = structuredClone(manifest);
  [changedSchedule.schedule[0], changedSchedule.schedule[2]] = [
    changedSchedule.schedule[2],
    changedSchedule.schedule[0]
  ];
  assert.throws(() => validateDataWranglerStudyManifest(changedSchedule), /fixed seeded design/u);

  const wrongPython = structuredClone(manifest);
  wrongPython.python.version = "3.14.0";
  assert.throws(() => validateDataWranglerStudyManifest(wrongPython), /Python version/u);

  const extra = { ...manifest, marketingWinner: "Open Wrangler" };
  assert.throws(() => validateDataWranglerStudyManifest(extra), /missing or unknown fields/u);
});

test("append-only fragments resume a half pair and refuse overwrite", () => {
  withTemporaryDirectory((directory) => {
    const manifest = studyManifest();
    const firstBlock = manifest.schedule.filter((entry) => entry.blockId === manifest.schedule[0].blockId);
    const first = successFragment(manifest, firstBlock[0], 0, 10);
    const receipt = publishDataWranglerStudyFragment(directory, first, manifest);
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/u);
    assert.throws(() => publishDataWranglerStudyFragment(directory, first, manifest), /pending append-only attempt/u);

    const loaded = loadDataWranglerStudyFragments(directory, manifest);
    assert.equal(loaded.length, 1);
    const pending = pendingDataWranglerStudyTrials(manifest, loaded);
    assert.equal(pending.length, 95);
    assert.equal(pending.filter((entry) => entry.blockId === firstBlock[0].blockId).length, 1);
    assert.equal(pending.find((entry) => entry.blockId === firstBlock[0].blockId).product, firstBlock[1].product);
    assert.equal(pending.find((entry) => entry.blockId === firstBlock[0].blockId).attempt, 0);
  });
});

test("a paired pre-action invalidation is retained and schedules a new correlated attempt", () => {
  const manifest = studyManifest();
  const entries = manifest.schedule.filter((entry) => entry.blockId === manifest.schedule[0].blockId);
  const invalid = entries.map((entry) => preActionInvalidFragment(manifest, entry, 0));
  const pending = pendingDataWranglerStudyTrials(manifest, invalid);
  const rerun = pending.filter((entry) => entry.blockId === entries[0].blockId);
  assert.equal(rerun.length, 2);
  assert.ok(rerun.every((entry) => entry.attempt === 1));
  assert.ok(rerun.every((entry) => entry.effectiveBlockId.endsWith("~a01")));

  const asymmetric = [invalid[0], successFragment(manifest, entries[1], 0, 12)];
  assert.throws(() => pendingDataWranglerStudyTrials(manifest, asymmetric), /invalidate both members/u);
  const orphan = [successFragment(manifest, entries[0], 1, 12)];
  assert.throws(() => pendingDataWranglerStudyTrials(manifest, orphan), /contiguous from attempt zero/u);
});

test("fragment validation correlates manifest, scheduled identity, milestones, and bounded outcomes", () => {
  const manifest = studyManifest();
  const fragment = successFragment(manifest, manifest.schedule[0], 0, 25);
  assert.equal(fragment.protocol, DATA_WRANGLER_STUDY_FRAGMENT_PROTOCOL);
  assert.equal(validateDataWranglerStudyFragment(fragment, manifest), fragment);

  assert.throws(
    () => validateDataWranglerStudyFragment({ ...fragment, manifestSha256: digest("9") }, manifest),
    /immutable manifest/u
  );
  const missingMilestone = structuredClone(fragment);
  missingMilestone.milestones.workbenchReadyMs = null;
  assert.throws(() => validateDataWranglerStudyFragment(missingMilestone, manifest), /milestone/u);
  const badOutcome = structuredClone(fragment);
  badOutcome.outcome.reasonClass = "timeout";
  assert.throws(() => validateDataWranglerStudyFragment(badOutcome, manifest), /successful study outcome/u);
});

test("type-7 summaries use the preregistered ten-sample interpolation", () => {
  const values = [10, 3, 8, 1, 9, 4, 6, 2, 7, 5];
  assert.equal(type7Quantile(values, 0.5), 5.5);
  assert.ok(Math.abs(type7Quantile(values, 0.95) - 9.55) < Number.EPSILON * 10);
  const summary = summarizeStudyMetric(values);
  assert.equal(summary.count, 10);
  assert.equal(summary.median, 5.5);
  assert.ok(Math.abs(summary.p95 - 9.55) < Number.EPSILON * 10);
  assert.throws(() => type7Quantile([], 0.95), /at least one/u);
});

test("paired regression records every difference and applies all three materiality conditions", () => {
  const pairs = [...Array(10).keys()].map((index) => ({
    pairId: `pair-${index}`,
    openWrangler: 2_500 + index,
    dataWrangler: 1_000 + index
  }));
  const regression = calculatePairedStudyRegression(pairs, { absoluteThreshold: 750 });
  assert.equal(regression.releaseComplete, true);
  assert.equal(regression.positiveDifferenceCount, 10);
  assert.equal(regression.medianDifference, 1_500);
  assert.ok(regression.medianRatio >= 1.2);
  assert.equal(regression.investigationTriggered, true);
  assert.equal(regression.pairs.length, 10);

  const sixSlower = pairs.map((pair, index) => (index < 6 ? pair : { ...pair, openWrangler: pair.dataWrangler - 1 }));
  assert.equal(calculatePairedStudyRegression(sixSlower, { absoluteThreshold: 750 }).investigationTriggered, false);
  const memory = calculatePairedStudyRegression(
    [...Array(10).keys()].map((index) => ({
      pairId: `memory-${index}`,
      openWrangler: 300 * 1024 * 1024,
      dataWrangler: 0
    })),
    { absoluteThreshold: 256 * 1024 * 1024, allowZero: true }
  );
  assert.equal(memory.medianRatio, "positive-infinity");
  assert.equal(memory.investigationTriggered, true);
});

test("PSS segments use the five samples before each action and report total and category peak deltas", () => {
  const MiB = 1024 * 1024;
  const samples = [];
  for (let elapsedMs = 0; elapsedMs <= 6_000; elapsedMs += 200) {
    const pssBytes =
      elapsedMs === 1_200 ? 130 * MiB : elapsedMs === 2_400 ? 150 * MiB : elapsedMs === 4_000 ? 180 * MiB : 100 * MiB;
    samples.push(pssSample(elapsedMs, pssBytes));
  }
  const observation = {
    protocol: "openwrangler-linux-pss-observation-v1",
    valid: true,
    reasonClass: null,
    intervalMs: 200,
    missedSamples: 0,
    samples
  };
  const milestones = {
    inlineActionMs: 1_000,
    inlineReadyMs: 1_200,
    workbenchActionMs: 2_200,
    workbenchReadyMs: 2_400,
    profileActionMs: 3_400,
    firstProfileReadyMs: 3_600,
    profilesCompleteMs: 4_000,
    samplingStoppedMs: 6_000
  };
  const segments = calculateStudyPssSegments(observation, milestones);
  assert.equal(segments.inline.baselinePssBytes, 100 * MiB);
  assert.equal(segments.inline.deltaPssBytes, 30 * MiB);
  assert.equal(segments.workbench.deltaPssBytes, 50 * MiB);
  assert.equal(segments.profile.deltaPssBytes, 80 * MiB);
  assert.equal(segments.completeTrial.deltaPssBytes, 80 * MiB);
  assert.equal(segments.completeTrial.categories["editor-main"].deltaPssBytes, 80 * MiB);
  assert.equal(segments.completeTrial.categories["configured-kernel"].deltaPssBytes, 0);
});

test("the result schema reports incomplete accounting without manufacturing missing samples", () => {
  const manifest = studyManifest();
  const entries = manifest.schedule.filter((entry) => entry.blockId === manifest.schedule[0].blockId);
  const coldEntry = manifest.schedule.find((entry) => entry.kind === "cold");
  const coldEntries = manifest.schedule.filter((entry) => entry.blockId === coldEntry.blockId);
  const fragments = [
    ...entries.map((entry, index) => successFragment(manifest, entry, 0, index === 0 ? 20 : 10)),
    ...coldEntries.map((entry, index) => successFragment(manifest, entry, 0, index === 0 ? 30 : 15))
  ];
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: "2026-08-02T12:00:00.000Z"
  });
  assert.equal(result.protocol, DATA_WRANGLER_STUDY_RESULT_PROTOCOL);
  assert.equal(result.accounting.allPlannedPairsComplete, false);
  assert.equal(result.accounting.pendingTrials.length, 92);
  assert.equal(
    result.cells.reduce((sum, cell) => sum + cell.successfulWarmPairs, 0),
    1
  );
  assert.equal(result.coldTrials.length, 2);
  assert.deepEqual(
    result.coldTrials.map((trial) => trial.measurements.loadAndPreviewMs),
    [30, 15]
  );
  assert.equal(validateDataWranglerStudyResult(result), result);
  const relabeled = structuredClone(result);
  relabeled.cells.find((cell) => cell.successfulWarmPairs === 1).metrics[0].pairedRegression.investigationTriggered =
    true;
  assert.throws(() => validateDataWranglerStudyResult(relabeled), /does not match its retained calculations/u);
});

test("a complete schedule finalizes ten warm pairs per cell and all descriptive cold trials", () => {
  const manifest = studyManifest();
  const fragments = manifest.schedule.map((entry) =>
    successFragment(manifest, entry, 0, entry.product === "open-wrangler" ? 20 : 10)
  );
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: "2026-08-02T13:00:00.000Z"
  });
  assert.equal(result.accounting.allPlannedPairsComplete, true);
  assert.equal(result.accounting.pendingTrials.length, 0);
  assert.equal(result.fragments.length, 96);
  assert.equal(result.coldTrials.length, 16);
  for (const cell of result.cells) {
    assert.equal(cell.successfulWarmPairs, 10);
    for (const metric of cell.metrics.slice(0, 4)) {
      assert.equal(metric.pairedRegression.releaseComplete, true);
      assert.equal(metric.pairedRegression.investigationTriggered, false);
    }
    assert.equal(cell.metrics[4].pairedRegression.releaseComplete, false);
  }
});

function studyManifest() {
  return buildDataWranglerStudyManifest({
    studyId: "11111111-1111-4111-8111-111111111111",
    createdAtUtc: "2026-08-02T10:00:00.000Z",
    method: { protocol: DATA_WRANGLER_STUDY_METHOD_PROTOCOL, sha256: digest("1") },
    candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1", sha256: digest("2") },
    baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
    editor: { id: "Microsoft.VisualStudioCode", version: "1.130.0", sha256: digest("3") },
    python: {
      implementation: "CPython",
      version: "3.12.10",
      executableSha256: digest("4"),
      environmentSha256: digest("5")
    },
    fixtures: [
      { id: "csv-100k-50", format: "csv", rows: 100_000, columns: 50, sha256: digest("6") },
      { id: "parquet-1m-20", format: "parquet", rows: 1_000_000, columns: 20, sha256: digest("7") }
    ]
  });
}

function successFragment(manifest, scheduleEntry, attempt, duration) {
  return {
    ...createStudyFragmentIdentity({
      manifest,
      scheduleEntry,
      attempt,
      recordedAtUtc: "2026-08-02T11:00:00.000Z"
    }),
    outcome: { status: "success", reasonClass: null, actionStarted: true, correctness: "passed" },
    milestones: {
      inlineActionMs: 0,
      inlineReadyMs: duration,
      workbenchActionMs: duration + 10,
      workbenchReadyMs: duration * 2 + 10,
      profileActionMs: duration * 2 + 20,
      firstProfileReadyMs: duration * 3 + 20,
      profilesCompleteMs: duration * 4 + 20,
      samplingStoppedMs: duration * 4 + 2_020
    },
    resourceObservation: null
  };
}

function preActionInvalidFragment(manifest, scheduleEntry, attempt) {
  return {
    ...createStudyFragmentIdentity({
      manifest,
      scheduleEntry,
      attempt,
      recordedAtUtc: "2026-08-02T11:00:00.000Z"
    }),
    outcome: {
      status: "pre-action-invalid",
      reasonClass: "setup",
      actionStarted: false,
      correctness: "not-reached"
    },
    milestones: createEmptyStudyMilestones(),
    resourceObservation: null
  };
}

function pssSample(elapsedMs, pssBytes) {
  return {
    elapsedMs,
    totalPssBytes: pssBytes,
    totalRssBytes: pssBytes + 1024,
    categories: {
      "editor-main": pssBytes,
      "renderer-gpu": 0,
      "extension-host": 0,
      "configured-kernel": 0,
      "open-wrangler-runtime": 0,
      "other-owned-child": 0
    },
    processes: [
      {
        pid: 100,
        startTimeTicks: "12345",
        category: "editor-main",
        pssBytes,
        rssBytes: pssBytes + 1024
      }
    ]
  };
}

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(resolve(tmpdir(), "ow-study-ledger-"));
  mkdirSync(resolve(directory, "fragments"), { mode: 0o700 });
  try {
    return callback(resolve(directory, "fragments"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
