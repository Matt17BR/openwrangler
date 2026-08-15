import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";

export const R_PERFORMANCE_REPORT_PROTOCOL = "openwrangler-native-r-performance-report-v1";
export const R_PERFORMANCE_HARNESS_PROTOCOL = "openwrangler-native-r-performance-harness-v1";
export const R_PERFORMANCE_FIXTURE_PROTOCOL = "openwrangler-native-r-performance-fixture-v1";
export const R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT = 5;
export const R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT = 20;
export const R_PERFORMANCE_PROCESS_SAFETY_DEADLINE_MS = 300_000;
export const R_PERFORMANCE_OUTLIER_POLICY =
  "retain every measured sample; no trimming, deletion, replacement, or retry";
export const R_PERFORMANCE_NO_THRESHOLD_PROFILE_FAILURE =
  "No reviewed native R release threshold profile is attached to this infrastructure-only report.";
export const R_PERFORMANCE_MAX_REPORT_BYTES = 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const reportReceipts = new WeakSet();
const ARTIFACT_PROTOCOLS = Object.freeze({
  "canonical-preview-release": "openwrangler-canonical-preview-release-artifact-v1",
  "canonical-stable-release": "openwrangler-canonical-release-artifact-v1",
  "performance-evidence": "openwrangler-performance-evidence-artifact-v1"
});
export const R_PERFORMANCE_FIXTURE_DEFINITION = Object.freeze({
  protocol: R_PERFORMANCE_FIXTURE_PROTOCOL,
  formulaVersion: "mixed-base-v1",
  rows: 250_000,
  columns: 20,
  pageRows: 200,
  pageColumns: 16,
  workloadSamples: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
  columnOffsets: Object.freeze([0, 4]),
  columnDefinitions: Object.freeze([
    Object.freeze({ name: "row_key", kind: "integer", formula: "seq_len(rows)" }),
    Object.freeze({ name: "group", kind: "character", formula: "g plus row_key modulo 127" }),
    Object.freeze({
      name: "value",
      kind: "double",
      formula: "centered modulo with NA NaN positive and negative infinity"
    }),
    Object.freeze({
      name: "text",
      kind: "character",
      formula: "duplicate labels with periodic NA and Unicode sentinel"
    }),
    Object.freeze({ name: "flag", kind: "logical", formula: "alternating with periodic NA" }),
    Object.freeze({ name: "bucket", kind: "integer", formula: "row_key modulo 997" }),
    Object.freeze({ name: "missing_num", kind: "double", formula: "scaled row_key with periodic NA" }),
    Object.freeze({ name: "label_factor", kind: "factor", formula: "five deterministic levels" }),
    Object.freeze({ name: "ordered_factor", kind: "ordered", formula: "four deterministic ordered levels" }),
    Object.freeze({ name: "date_value", kind: "date", formula: "2020-01-01 plus row_key modulo 1461 days" }),
    Object.freeze({
      name: "datetime_value",
      kind: "datetime",
      formula: "UTC epoch plus row_key modulo 100000 seconds"
    }),
    Object.freeze({ name: "duration_value", kind: "duration", formula: "row_key modulo 7200 seconds" }),
    Object.freeze({ name: "wide_integer", kind: "integer64", formula: "9007199254740992 plus row_key" }),
    Object.freeze({ name: "secondary_text", kind: "character", formula: "secondary duplicate labels" }),
    Object.freeze({ name: "sparse_flag", kind: "logical", formula: "periodic true with periodic NA" }),
    Object.freeze({ name: "measure_a", kind: "double", formula: "row_key modulo 4093 divided by 7" }),
    Object.freeze({ name: "measure_b", kind: "integer", formula: "row_key modulo 8191" }),
    Object.freeze({ name: "measure_c", kind: "double", formula: "negative row_key modulo 1237" }),
    Object.freeze({ name: "category", kind: "character", formula: "category plus row_key modulo 23" }),
    Object.freeze({ name: "constant", kind: "integer", formula: "constant 7" })
  ]),
  profileColumns: Object.freeze([
    "value",
    "text",
    "flag",
    "label_factor",
    "date_value",
    "datetime_value",
    "duration_value",
    "wide_integer"
  ]),
  expectedStats: Object.freeze({
    missingCells: 4848,
    missingRows: 4824,
    duplicateRows: 0,
    duplicateRowsSampleSize: 100_000,
    missingValuesByColumn: Object.freeze([0, 0, 571, 497, 491, 0, 2475, 0, 0, 0, 0, 0, 0, 0, 814, 0, 0, 0, 0, 0])
  }),
  first: Object.freeze({ rowKey: "1", text: "row-000001" }),
  last: Object.freeze({ rowKey: "250000", text: "row-250000" })
});
export const R_PERFORMANCE_FIXTURE_BYTES = Buffer.from(`${JSON.stringify(R_PERFORMANCE_FIXTURE_DEFINITION)}\n`, "utf8");
export const R_PERFORMANCE_FIXTURE_SHA256 = createHash("sha256").update(R_PERFORMANCE_FIXTURE_BYTES).digest("hex");

export function rPerformanceFixtureEvidence() {
  return {
    protocol: R_PERFORMANCE_FIXTURE_DEFINITION.protocol,
    sha256: R_PERFORMANCE_FIXTURE_SHA256,
    rows: R_PERFORMANCE_FIXTURE_DEFINITION.rows,
    columns: R_PERFORMANCE_FIXTURE_DEFINITION.columns,
    pageRows: R_PERFORMANCE_FIXTURE_DEFINITION.pageRows,
    pageColumns: R_PERFORMANCE_FIXTURE_DEFINITION.pageColumns,
    workloadSamples: R_PERFORMANCE_FIXTURE_DEFINITION.workloadSamples,
    columnOffsets: [...R_PERFORMANCE_FIXTURE_DEFINITION.columnOffsets],
    columnDefinitions: R_PERFORMANCE_FIXTURE_DEFINITION.columnDefinitions.map((entry) => ({ ...entry })),
    profileColumns: [...R_PERFORMANCE_FIXTURE_DEFINITION.profileColumns],
    expectedStats: { ...R_PERFORMANCE_FIXTURE_DEFINITION.expectedStats },
    first: { ...R_PERFORMANCE_FIXTURE_DEFINITION.first },
    last: { ...R_PERFORMANCE_FIXTURE_DEFINITION.last }
  };
}
const DIRECT_FRESH_BOUNDARY = "inside one owned Rscript: packaged capture_live_frame through encoded first page";
const DIRECT_WORKLOAD_BOUNDARY = "inside one owned Rscript: packaged production frame-contract operation";
const KERNEL_FRESH_BOUNDARY =
  "Node monotonic clock: fresh owned Rscript spawn through semantic validation of correlated openSession response";
const KERNEL_WORKLOAD_BOUNDARY =
  "Node monotonic clock: completed stdin write through semantic validation of the correlated stdout response";

export function summarizeRPerformanceSamples(samples, label, expectedCount) {
  assertSamples(samples, label, expectedCount);
  const ordered = [...samples].sort((left, right) => left - right);
  return Object.freeze({
    count: samples.length,
    samplesMs: Object.freeze([...samples]),
    excludedSamples: 0,
    outlierPolicy: R_PERFORMANCE_OUTLIER_POLICY,
    minMs: ordered[0],
    medianMs: median(ordered),
    p95Ms: nearestRank(ordered, 0.95),
    maxMs: ordered.at(-1)
  });
}

export function buildRPerformanceReport({
  generatedAtUtc,
  candidate,
  packagedRuntime,
  harness,
  fixture,
  machine,
  runtime,
  measurements,
  resources,
  cleanup
}) {
  const direct = normalizeBoundaryMeasurements(
    measurements?.directFrame,
    "direct frame",
    DIRECT_FRESH_BOUNDARY,
    DIRECT_WORKLOAD_BOUNDARY
  );
  const kernel = normalizeBoundaryMeasurements(
    measurements?.kernelRoundTrip,
    "kernel round trip",
    KERNEL_FRESH_BOUNDARY,
    KERNEL_WORKLOAD_BOUNDARY
  );
  const report = {
    protocol: R_PERFORMANCE_REPORT_PROTOCOL,
    generatedAtUtc: canonicalUtcTimestamp(generatedAtUtc),
    candidate: structuredClone(candidate),
    packagedRuntime: structuredClone(packagedRuntime),
    harness: structuredClone(harness),
    fixture: structuredClone(fixture),
    environment: {
      machine: structuredClone(machine),
      runtime: structuredClone(runtime)
    },
    measurementContract: {
      freshOpenSampleCount: R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT,
      workloadSampleCount: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
      processSafetyDeadlineMs: R_PERFORMANCE_PROCESS_SAFETY_DEADLINE_MS,
      processSafetyPolicy: "operational owned-process deadline; not a numeric release threshold",
      outlierPolicy: R_PERFORMANCE_OUTLIER_POLICY,
      directFreshBoundary: DIRECT_FRESH_BOUNDARY,
      directWorkloadBoundary: DIRECT_WORKLOAD_BOUNDARY,
      kernelFreshBoundary: KERNEL_FRESH_BOUNDARY,
      kernelWorkloadBoundary: KERNEL_WORKLOAD_BOUNDARY
    },
    measurements: {
      directFrame: direct,
      kernelRoundTrip: kernel
    },
    resources: structuredClone(resources),
    cleanup: structuredClone(cleanup),
    measurementValid: { passed: false, failures: [] },
    releaseGate: {
      thresholdProfileAttached: false,
      passed: false,
      failures: [R_PERFORMANCE_NO_THRESHOLD_PROFILE_FAILURE]
    }
  };
  report.measurementValid = measurementValidity(report);
  validateRPerformanceReport(report);
  return report;
}

export function validateRPerformanceReport(report) {
  exactKeys(
    report,
    [
      "protocol",
      "generatedAtUtc",
      "candidate",
      "packagedRuntime",
      "harness",
      "fixture",
      "environment",
      "measurementContract",
      "measurements",
      "resources",
      "cleanup",
      "measurementValid",
      "releaseGate"
    ],
    "native R performance report"
  );
  assertEqual(report.protocol, R_PERFORMANCE_REPORT_PROTOCOL, "native R performance report protocol");
  canonicalUtcTimestamp(report.generatedAtUtc);
  validateCandidate(report.candidate);
  validatePackagedRuntime(report.packagedRuntime);
  validateHarness(report.harness, report.candidate.sourceCommit);
  validateFixture(report.fixture);
  validateEnvironment(report.environment);
  validateMeasurementContract(report.measurementContract);
  exactKeys(report.measurements, ["directFrame", "kernelRoundTrip"], "native R measurements");
  validateBoundaryMeasurements(
    report.measurements.directFrame,
    "direct frame",
    DIRECT_FRESH_BOUNDARY,
    DIRECT_WORKLOAD_BOUNDARY
  );
  validateBoundaryMeasurements(
    report.measurements.kernelRoundTrip,
    "kernel round trip",
    KERNEL_FRESH_BOUNDARY,
    KERNEL_WORKLOAD_BOUNDARY
  );
  validateResources(report.resources);
  validateCleanup(report.cleanup);
  exactKeys(report.measurementValid, ["passed", "failures"], "measurement-valid verdict");
  const expectedValidity = measurementValidity(report);
  if (JSON.stringify(report.measurementValid) !== JSON.stringify(expectedValidity)) {
    throw new Error("Native R measurement-valid verdict does not match its structural proofs.");
  }
  exactKeys(report.releaseGate, ["thresholdProfileAttached", "passed", "failures"], "native R release-gate verdict");
  if (
    report.releaseGate.thresholdProfileAttached !== false ||
    report.releaseGate.passed !== false ||
    JSON.stringify(report.releaseGate.failures) !== JSON.stringify([R_PERFORMANCE_NO_THRESHOLD_PROFILE_FAILURE])
  ) {
    throw new Error("Infrastructure-only native R evidence cannot claim a numeric release gate.");
  }
  assertPublicEvidence(report);
  return report;
}

export function assertRPerformanceMeasurementValid(report) {
  validateRPerformanceReport(report);
  if (!report.measurementValid.passed) {
    throw new Error(
      `Native R performance measurement is structurally invalid:\n${report.measurementValid.failures.join("\n")}`
    );
  }
  return report;
}

export function parseRPerformanceReport(source) {
  const report = parseStrictJson(source, { maxBytes: R_PERFORMANCE_MAX_REPORT_BYTES });
  return validateRPerformanceReport(report);
}

export function writeRPerformanceReport(destination, report, hooks = {}) {
  validateRPerformanceReport(report);
  const payload = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (payload.length === 0 || payload.length > R_PERFORMANCE_MAX_REPORT_BYTES) {
    throw new Error("Native R performance report exceeded its fixed 1 MiB limit.");
  }
  const absolute = resolve(destination);
  const parent = dirname(absolute);
  const parentReceipt = hooks.parentReceipt ?? readCanonicalOutputParent(parent);
  if (parentReceipt?.path !== parent) {
    throw new Error("Native R report publication did not receive its pre-measurement destination-parent receipt.");
  }
  revalidateOutputParent(parentReceipt);
  assertReplaceableDestination(absolute);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  let temporaryIdentity;
  let publishedDestinationIdentity;
  let published = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    revalidateOutputParent(parentReceipt);
    temporaryIdentity = fstatSync(descriptor, { bigint: true });
    requireSameIdentity(temporaryIdentity, temporaryIdentity, "Native R report temporary is not a regular file.");
    writeAll(descriptor, payload);
    fsyncSync(descriptor);
    const complete = fstatSync(descriptor, { bigint: true });
    requireSameIdentity(
      complete,
      temporaryIdentity,
      "Native R report temporary changed identity while it was written."
    );
    if (complete.size !== BigInt(payload.length)) {
      throw new Error("Native R report temporary has an invalid byte size.");
    }
    closeSync(descriptor);
    descriptor = undefined;
    hooks.beforePublish?.(temporary);
    revalidateOutputParent(parentReceipt);
    requireSameFile(
      lstatSync(temporary, { bigint: true }),
      complete,
      "Native R report temporary path changed before publication."
    );
    assertReplaceableDestination(absolute);
    renameSync(temporary, absolute);
    publishedDestinationIdentity = complete;
    hooks.afterRename?.(absolute);
    revalidateOutputParent(parentReceipt);
    const publishedIdentity = lstatSync(absolute, { bigint: true });
    requireSamePublishedFile(publishedIdentity, complete, "Native R report destination changed during publication.");
    const snapshot = readReportSnapshot(absolute, (file) => {
      hooks.afterPublishedOpen?.(file);
      revalidateOutputParent(parentReceipt);
    });
    revalidateOutputParent(parentReceipt);
    if (!snapshot.bytes.equals(payload)) {
      throw new Error("Native R report destination bytes changed during publication.");
    }
    const receipt = Object.freeze({
      path: absolute,
      bytes: snapshot.bytes.length,
      sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
      fileIdentity: snapshot.identity,
      parentReceipt
    });
    reportReceipts.add(receipt);
    published = true;
    return receipt;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published && publishedDestinationIdentity !== undefined) {
      revalidateOutputParent(parentReceipt);
      removeIdentifiedTemporary(absolute, publishedDestinationIdentity);
    } else if (!published && temporaryIdentity !== undefined) {
      revalidateOutputParent(parentReceipt);
      removeIdentifiedTemporary(temporary, temporaryIdentity);
    }
  }
}

function readCanonicalOutputParent(parent) {
  const absolute = resolve(parent);
  const canonical = realpathSync.native(absolute);
  const metadata = lstatSync(absolute, { bigint: true });
  if (
    canonical !== absolute ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Native R report requires one existing canonical current-user-owned destination directory.");
  }
  return Object.freeze({
    path: absolute,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid
  });
}

function revalidateOutputParent(receipt) {
  const metadata = lstatSync(receipt.path, { bigint: true });
  if (
    realpathSync.native(receipt.path) !== receipt.path ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== receipt.dev ||
    metadata.ino !== receipt.ino ||
    metadata.mode !== receipt.mode ||
    metadata.uid !== receipt.uid
  ) {
    throw new Error("Native R report destination directory changed during atomic publication.");
  }
}

export function revalidateRPerformanceReport(receipt, hooks = {}) {
  if (!reportReceipts.has(receipt)) {
    throw new Error("Native R report revalidation requires one minted publication receipt.");
  }
  revalidateOutputParent(receipt.parentReceipt);
  const snapshot = readReportSnapshot(receipt.path, (file) => {
    hooks.afterOpen?.(file);
    revalidateOutputParent(receipt.parentReceipt);
  });
  revalidateOutputParent(receipt.parentReceipt);
  requireSameReceipt(snapshot.identity, receipt.fileIdentity, "Native R report changed after publication.");
  if (
    snapshot.bytes.length !== receipt.bytes ||
    createHash("sha256").update(snapshot.bytes).digest("hex") !== receipt.sha256
  ) {
    throw new Error("Native R report no longer matches its publication receipt.");
  }
  parseRPerformanceReport(snapshot.bytes.toString("utf8"));
  return receipt;
}

export function removeRPerformanceReport(receipt) {
  if (!reportReceipts.has(receipt)) {
    throw new Error("Native R report removal requires one minted publication receipt.");
  }
  revalidateOutputParent(receipt.parentReceipt);
  const current = lstatSync(receipt.path, { bigint: true });
  requireSameReceipt(current, receipt.fileIdentity, "Native R report changed before failure cleanup.");
  rmSync(receipt.path);
  reportReceipts.delete(receipt);
}

function normalizeBoundaryMeasurements(value, label, freshBoundary, workloadBoundary) {
  exactKeys(
    value,
    [
      "freshOpenSamplesMs",
      "projectedPageSamplesMs",
      "compoundFilterPageSamplesMs",
      "stableMultiKeySortFirstUncachedMs",
      "stableMultiKeySortPageSamplesMs",
      "eightColumnSummarySamplesMs",
      "semanticProof"
    ],
    `${label} input`
  );
  return {
    freshOpen: {
      boundary: freshBoundary,
      ...summarizeRPerformanceSamples(
        value.freshOpenSamplesMs,
        `${label} fresh-open samples`,
        R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT
      )
    },
    workloads: {
      projectedPage: {
        boundary: `${workloadBoundary}: scheduled 200x16 projected page across row offsets and both column blocks`,
        ...summarizeRPerformanceSamples(
          value.projectedPageSamplesMs,
          `${label} projected-page samples`,
          R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT
        )
      },
      compoundFilterPage: {
        boundary: `${workloadBoundary}: compound-filtered 200x16 page`,
        ...summarizeRPerformanceSamples(
          value.compoundFilterPageSamplesMs,
          `${label} compound-filter samples`,
          R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT
        )
      },
      stableMultiKeySortPage: {
        boundary: `${workloadBoundary}: cached stable multi-key sorted 200x16 page`,
        firstUncachedMs: value.stableMultiKeySortFirstUncachedMs,
        ...summarizeRPerformanceSamples(
          value.stableMultiKeySortPageSamplesMs,
          `${label} stable-sort samples`,
          R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT
        )
      },
      eightColumnSummary: {
        boundary: `${workloadBoundary}: eight-column summary and profile`,
        ...summarizeRPerformanceSamples(
          value.eightColumnSummarySamplesMs,
          `${label} summary samples`,
          R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT
        )
      }
    },
    semanticProof: structuredClone(value.semanticProof)
  };
}

function validateBoundaryMeasurements(value, label, freshBoundary, workloadBoundary) {
  exactKeys(value, ["freshOpen", "workloads", "semanticProof"], `${label} measurements`);
  validateSampleSummary(
    value.freshOpen,
    `${label} fresh-open samples`,
    R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT,
    freshBoundary
  );
  exactKeys(
    value.workloads,
    ["projectedPage", "compoundFilterPage", "stableMultiKeySortPage", "eightColumnSummary"],
    `${label} workload measurements`
  );
  validateSampleSummary(
    value.workloads.projectedPage,
    `${label} projected-page samples`,
    R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    `${workloadBoundary}: scheduled 200x16 projected page across row offsets and both column blocks`
  );
  validateSampleSummary(
    value.workloads.compoundFilterPage,
    `${label} compound-filter samples`,
    R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    `${workloadBoundary}: compound-filtered 200x16 page`
  );
  validateSortSummary(value.workloads.stableMultiKeySortPage, label, workloadBoundary);
  validateSampleSummary(
    value.workloads.eightColumnSummary,
    `${label} summary samples`,
    R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    `${workloadBoundary}: eight-column summary and profile`
  );
  if (label === "direct frame") validateDirectSemanticProof(value.semanticProof);
  else validateKernelSemanticProof(value.semanticProof);
}

function validateSortSummary(summary, label, workloadBoundary) {
  const { firstUncachedMs, ...ordinary } = summary;
  if (
    typeof firstUncachedMs !== "number" ||
    !Number.isFinite(firstUncachedMs) ||
    firstUncachedMs < 0 ||
    firstUncachedMs > R_PERFORMANCE_PROCESS_SAFETY_DEADLINE_MS
  ) {
    throw new TypeError(`${label} first uncached sort timing is invalid.`);
  }
  validateSampleSummary(
    ordinary,
    `${label} stable-sort samples`,
    R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    `${workloadBoundary}: cached stable multi-key sorted 200x16 page`
  );
}

function validateDirectSemanticProof(proof) {
  const label = "direct frame";
  exactKeys(
    proof,
    [
      "passed",
      "sourceUnchanged",
      "freshPagesVerified",
      "projectedPagesVerified",
      "compoundFilterPagesVerified",
      "stableSortPagesVerified",
      "summariesVerified",
      "datasetStatsVerified",
      "millionRowSampledSummaryVerified",
      "keyedDataTableVerified"
    ],
    `${label} semantic proof`
  );
  validateCommonSemanticProof(proof, label);
}

function validateKernelSemanticProof(proof) {
  const label = "kernel round trip";
  exactKeys(
    proof,
    [
      "passed",
      "sourceUnchanged",
      "freshPagesVerified",
      "projectedPagesVerified",
      "compoundFilterPagesVerified",
      "stableSortPagesVerified",
      "summariesVerified",
      "datasetStatsVerified",
      "millionRowSampledSummaryVerified",
      "keyedDataTableVerified",
      "responseAccounting",
      "readyFramesVerified",
      "closedSessions"
    ],
    `${label} semantic proof`
  );
  validateCommonSemanticProof(proof, label);
  validateKernelResponseAccounting(proof.responseAccounting);
  assertEqual(proof.readyFramesVerified, 6, `${label} ready frames`);
  assertEqual(proof.closedSessions, 8, `${label} closed sessions`);
}

function validateCommonSemanticProof(proof, label) {
  assertBoolean(proof.passed, `${label} semantic proof passed`);
  assertBoolean(proof.sourceUnchanged, `${label} source unchanged`);
  if (!proof.passed || !proof.sourceUnchanged) {
    throw new TypeError(`${label} semantic proof must pass with an unchanged source.`);
  }
  assertEqual(proof.freshPagesVerified, R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT, `${label} verified fresh pages`);
  for (const [key, text] of [
    ["projectedPagesVerified", "projected pages"],
    ["compoundFilterPagesVerified", "compound-filter pages"],
    ["stableSortPagesVerified", "stable-sort pages"],
    ["summariesVerified", "summaries"]
  ]) {
    assertEqual(proof[key], R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT, `${label} verified ${text}`);
  }
  for (const key of ["datasetStatsVerified", "millionRowSampledSummaryVerified", "keyedDataTableVerified"]) {
    assertBoolean(proof[key], `${label} ${key}`);
    if (!proof[key]) throw new TypeError(`${label} ${key} must be proven.`);
  }
}

function validateKernelResponseAccounting(value) {
  exactKeys(value, ["measured", "controls", "measuredTotal", "controlTotal", "allTotal"], "kernel response accounting");
  exactKeys(
    value.measured,
    [
      "freshOpen",
      "projectedPage",
      "compoundFilterPage",
      "stableSortFirstUncached",
      "stableSortPage",
      "eightColumnSummary"
    ],
    "measured kernel responses"
  );
  const expectedMeasured = {
    freshOpen: 5,
    projectedPage: 20,
    compoundFilterPage: 20,
    stableSortFirstUncached: 1,
    stableSortPage: 20,
    eightColumnSummary: 20
  };
  exactKeys(
    value.controls,
    ["sessionClose", "workloadOpen", "datasetStats", "millionRowOpen", "millionRowSummary", "keyedDataTableOpen"],
    "control kernel responses"
  );
  const expectedControls = {
    sessionClose: 8,
    workloadOpen: 1,
    datasetStats: 1,
    millionRowOpen: 1,
    millionRowSummary: 1,
    keyedDataTableOpen: 1
  };
  if (JSON.stringify(value.measured) !== JSON.stringify(expectedMeasured)) {
    throw new TypeError("Measured kernel response schedule changed.");
  }
  if (JSON.stringify(value.controls) !== JSON.stringify(expectedControls)) {
    throw new TypeError("Control kernel response schedule changed.");
  }
  const measuredTotal = Object.values(value.measured).reduce((sum, entry) => sum + entry, 0);
  const controlTotal = Object.values(value.controls).reduce((sum, entry) => sum + entry, 0);
  assertEqual(value.measuredTotal, measuredTotal, "measured kernel response total");
  assertEqual(value.controlTotal, controlTotal, "control kernel response total");
  assertEqual(value.allTotal, measuredTotal + controlTotal, "all correlated kernel response total");
  assertEqual(value.measuredTotal, 86, "measured kernel response total");
  assertEqual(value.allTotal, 99, "all correlated kernel response total");
}

function validateSampleSummary(summary, label, expectedCount, boundary) {
  exactKeys(
    summary,
    ["boundary", "count", "samplesMs", "excludedSamples", "outlierPolicy", "minMs", "medianMs", "p95Ms", "maxMs"],
    `${label} summary`
  );
  assertEqual(summary.boundary, boundary, `${label} boundary`);
  const expected = summarizeRPerformanceSamples(summary.samplesMs, label, expectedCount);
  const normalized = { boundary, ...expected };
  if (JSON.stringify(summary) !== JSON.stringify(normalized)) {
    throw new Error(`${label} summary does not match its retained raw samples.`);
  }
}

function validateCandidate(candidate) {
  exactKeys(
    candidate,
    [
      "artifactKind",
      "extensionId",
      "extensionVersion",
      "preview",
      "releaseTag",
      "sourceCommit",
      "vsixSha256",
      "vsixBytes",
      "checksumSha256",
      "provenanceProtocol",
      "provenanceSha256"
    ],
    "native R candidate"
  );
  if (!Object.hasOwn(ARTIFACT_PROTOCOLS, candidate.artifactKind)) {
    throw new TypeError("Native R candidate artifact kind is unsupported.");
  }
  assertEqual(
    candidate.provenanceProtocol,
    ARTIFACT_PROTOCOLS[candidate.artifactKind],
    "native R candidate provenance protocol"
  );
  assertEqual(candidate.extensionId, "Matt17BR.openwrangler", "native R candidate extension ID");
  assertMatch(candidate.extensionVersion, VERSION, "native R candidate version");
  const classification = classifyNumericReleaseVersion(candidate.extensionVersion);
  if (classification === undefined || candidate.preview !== (classification.channel === "preview")) {
    throw new TypeError("Native R candidate version, channel, and preview flag do not agree.");
  }
  if (candidate.artifactKind === "canonical-preview-release" && !candidate.preview) {
    throw new TypeError("Canonical preview native R evidence requires preview package metadata.");
  }
  if (candidate.artifactKind !== "canonical-preview-release" && candidate.preview) {
    throw new TypeError("Stable native R evidence cannot use preview package metadata.");
  }
  if (!candidate.preview && candidate.extensionVersion.startsWith("0.")) {
    throw new TypeError("Stable native R evidence requires extension version 1.0.0 or newer.");
  }
  assertEqual(candidate.releaseTag, `v${candidate.extensionVersion}`, "native R candidate release tag");
  assertMatch(candidate.sourceCommit, COMMIT, "native R candidate source commit");
  assertMatch(candidate.vsixSha256, SHA256, "native R candidate VSIX SHA-256");
  assertPositiveInteger(candidate.vsixBytes, "native R candidate VSIX bytes");
  assertMatch(candidate.checksumSha256, SHA256, "native R candidate checksum SHA-256");
  assertMatch(candidate.provenanceSha256, SHA256, "native R candidate provenance SHA-256");
}

function validatePackagedRuntime(value) {
  exactKeys(value, ["frameContract", "kernelAgent"], "packaged native R runtime");
  validateAsset(value.frameContract, "frame_contract.R", "packaged frame contract");
  validateAsset(value.kernelAgent, "kernel_agent.R", "packaged kernel agent");
}

function validateAsset(value, name, label) {
  exactKeys(value, ["name", "bytes", "sha256"], label);
  assertEqual(value.name, name, `${label} name`);
  assertPositiveInteger(value.bytes, `${label} bytes`);
  if (value.bytes > 1024 * 1024) throw new TypeError(`${label} exceeds its 1 MiB bound.`);
  assertMatch(value.sha256, SHA256, `${label} SHA-256`);
}

function validateHarness(value, sourceCommit) {
  exactKeys(value, ["protocol", "bytes", "sha256", "sourceCommit"], "native R performance harness");
  assertEqual(value.protocol, R_PERFORMANCE_HARNESS_PROTOCOL, "native R performance harness protocol");
  assertPositiveInteger(value.bytes, "native R performance harness bytes");
  if (value.bytes > 256 * 1024) throw new TypeError("Native R performance harness exceeds its 256 KiB bound.");
  assertMatch(value.sha256, SHA256, "native R performance harness SHA-256");
  assertEqual(value.sourceCommit, sourceCommit, "native R performance harness source commit");
}

function validateFixture(value) {
  exactKeys(
    value,
    [
      "protocol",
      "sha256",
      "rows",
      "columns",
      "pageRows",
      "pageColumns",
      "workloadSamples",
      "columnOffsets",
      "columnDefinitions",
      "profileColumns",
      "expectedStats",
      "first",
      "last"
    ],
    "R fixture"
  );
  assertEqual(value.protocol, R_PERFORMANCE_FIXTURE_PROTOCOL, "R fixture protocol");
  assertEqual(value.sha256, R_PERFORMANCE_FIXTURE_SHA256, "R fixture SHA-256");
  const expected = rPerformanceFixtureEvidence();
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new TypeError("Native R fixture does not match its SHA-256-bound deterministic descriptor.");
  }
}

function validateEnvironment(value) {
  exactKeys(value, ["machine", "runtime"], "native R environment");
  exactKeys(
    value.machine,
    ["operatingSystem", "release", "architecture", "cpuModel", "logicalCpuCount", "memoryBytes"],
    "native R machine provenance"
  );
  for (const key of ["operatingSystem", "release", "architecture", "cpuModel"]) {
    assertBoundedString(value.machine[key], `native R machine ${key}`, 256);
  }
  assertEqual(value.machine.operatingSystem, "Linux", "native R reference operating system");
  assertPositiveInteger(value.machine.logicalCpuCount, "native R logical CPU count");
  assertPositiveInteger(value.machine.memoryBytes, "native R machine memory bytes");
  validateRuntime(value.runtime);
}

function validateRuntime(value) {
  exactKeys(
    value,
    [
      "rVersion",
      "platform",
      "architecture",
      "operatingSystem",
      "libraryResolution",
      "nodeVersion",
      "nodeExecutable",
      "rscript",
      "packages"
    ],
    "native R runtime provenance"
  );
  assertMatch(value.rVersion, VERSION, "R version");
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.nodeVersion)) {
    throw new TypeError("Node runtime version is invalid.");
  }
  for (const key of ["platform", "architecture", "operatingSystem"]) {
    assertBoundedString(value[key], `R runtime ${key}`, 256);
  }
  assertEqual(value.operatingSystem, "Linux", "R runtime operating system");
  exactKeys(
    value.libraryResolution,
    ["protocol", "directoryCount", "explicitDirectoriesVerified"],
    "R library-resolution provenance"
  );
  assertEqual(
    value.libraryResolution.protocol,
    "openwrangler-native-r-library-discovery-v1",
    "R library-resolution protocol"
  );
  assertPositiveInteger(value.libraryResolution.directoryCount, "R library directory count");
  if (value.libraryResolution.directoryCount > 64) {
    throw new TypeError("R library directory count exceeds its fixed bound.");
  }
  assertEqual(value.libraryResolution.explicitDirectoriesVerified, true, "explicit R library-directory verification");
  exactKeys(value.nodeExecutable, ["bytes", "sha256"], "Node executable provenance");
  assertPositiveInteger(value.nodeExecutable.bytes, "Node executable bytes");
  if (value.nodeExecutable.bytes > 256 * 1024 * 1024) {
    throw new TypeError("Node executable exceeds its 256 MiB provenance bound.");
  }
  assertMatch(value.nodeExecutable.sha256, SHA256, "Node executable SHA-256");
  exactKeys(value.rscript, ["bytes", "sha256"], "Rscript executable provenance");
  assertPositiveInteger(value.rscript.bytes, "Rscript executable bytes");
  if (value.rscript.bytes > 64 * 1024 * 1024) {
    throw new TypeError("Rscript executable exceeds its 64 MiB provenance bound.");
  }
  assertMatch(value.rscript.sha256, SHA256, "Rscript executable SHA-256");
  exactKeys(
    value.packages,
    ["jsonlite", "dataTable", "rlang", "bit64", "tibble", "nanoparquet", "collapse"],
    "R package provenance"
  );
  for (const [key, version] of Object.entries(value.packages)) {
    if (version !== null) assertBoundedString(version, `R package ${key}`, 128);
  }
  for (const required of ["jsonlite", "dataTable", "rlang", "bit64"]) {
    if (value.packages[required] === null) {
      throw new TypeError(`R package provenance requires ${required}.`);
    }
  }
}

function validateMeasurementContract(value) {
  exactKeys(
    value,
    [
      "freshOpenSampleCount",
      "workloadSampleCount",
      "processSafetyDeadlineMs",
      "processSafetyPolicy",
      "outlierPolicy",
      "directFreshBoundary",
      "directWorkloadBoundary",
      "kernelFreshBoundary",
      "kernelWorkloadBoundary"
    ],
    "native R measurement contract"
  );
  assertEqual(value.freshOpenSampleCount, R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT, "fresh-open sample count");
  assertEqual(value.workloadSampleCount, R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT, "workload sample count");
  assertEqual(value.processSafetyDeadlineMs, R_PERFORMANCE_PROCESS_SAFETY_DEADLINE_MS, "owned-process safety deadline");
  assertEqual(
    value.processSafetyPolicy,
    "operational owned-process deadline; not a numeric release threshold",
    "owned-process safety policy"
  );
  assertEqual(value.outlierPolicy, R_PERFORMANCE_OUTLIER_POLICY, "native R outlier policy");
  assertEqual(value.directFreshBoundary, DIRECT_FRESH_BOUNDARY, "direct fresh boundary");
  assertEqual(value.directWorkloadBoundary, DIRECT_WORKLOAD_BOUNDARY, "direct workload boundary");
  assertEqual(value.kernelFreshBoundary, KERNEL_FRESH_BOUNDARY, "kernel fresh boundary");
  assertEqual(value.kernelWorkloadBoundary, KERNEL_WORKLOAD_BOUNDARY, "kernel workload boundary");
}

function validateResources(value) {
  exactKeys(
    value,
    [
      "directMethod",
      "directProcessVmHwmKiB",
      "directStagesVmHwmKiB",
      "libraryProbeMethod",
      "libraryProbeSamplingIntervalMs",
      "libraryProbeMaxObservedRssKiB",
      "kernelMethod",
      "kernelSamplingIntervalMs",
      "freshKernelMaxObservedRssKiB",
      "workloadKernelMaxObservedRssKiB",
      "kernelRequestsMaxObservedRssKiB",
      "everyProcessObserved",
      "everyStageObserved"
    ],
    "native R resource proof"
  );
  assertEqual(
    value.directMethod,
    "linux-proc-self-status-vmhwm-after-stage-v1",
    "direct Rscript resource measurement method"
  );
  assertPositiveInteger(value.directProcessVmHwmKiB, "direct Rscript VmHWM");
  exactKeys(
    value.directStagesVmHwmKiB,
    [
      "freshOpen",
      "projectedPage",
      "compoundFilterPage",
      "stableMultiKeySortPage",
      "eightColumnSummary",
      "semanticProof"
    ],
    "direct Rscript stage VmHWM proof"
  );
  const directStages = Object.values(value.directStagesVmHwmKiB);
  for (const [stage, rss] of Object.entries(value.directStagesVmHwmKiB)) {
    assertPositiveInteger(rss, `direct Rscript ${stage} VmHWM`);
  }
  if (value.directProcessVmHwmKiB < Math.max(...directStages)) {
    throw new TypeError("Direct Rscript VmHWM must cover every retained stage VmHWM.");
  }
  assertEqual(
    value.libraryProbeMethod,
    "linux-proc-status-vmrss-parent-sampled-v1",
    "library-probe Rscript resource measurement method"
  );
  assertEqual(value.libraryProbeSamplingIntervalMs, 5, "library-probe Rscript RSS sampling interval");
  assertPositiveInteger(value.libraryProbeMaxObservedRssKiB, "library-probe max-observed RSS");
  assertEqual(
    value.kernelMethod,
    "linux-proc-status-vmrss-parent-sampled-v1",
    "kernel Rscript resource measurement method"
  );
  assertEqual(value.kernelSamplingIntervalMs, 5, "kernel Rscript RSS sampling interval");
  if (!Array.isArray(value.freshKernelMaxObservedRssKiB) || value.freshKernelMaxObservedRssKiB.length !== 5) {
    throw new TypeError("Fresh kernel RSS proof must retain exactly five samples.");
  }
  for (const sample of value.freshKernelMaxObservedRssKiB) {
    assertPositiveInteger(sample, "fresh kernel max-observed RSS");
  }
  assertPositiveInteger(value.workloadKernelMaxObservedRssKiB, "workload kernel max-observed RSS");
  exactKeys(
    value.kernelRequestsMaxObservedRssKiB,
    [
      "projectedPage",
      "compoundFilterPage",
      "stableMultiKeySortFirstUncached",
      "stableMultiKeySortPage",
      "eightColumnSummary",
      "semanticControls"
    ],
    "kernel request RSS proof"
  );
  for (const key of ["projectedPage", "compoundFilterPage", "stableMultiKeySortPage", "eightColumnSummary"]) {
    const samples = value.kernelRequestsMaxObservedRssKiB[key];
    if (!Array.isArray(samples) || samples.length !== R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT) {
      throw new TypeError(`Kernel ${key} RSS proof must retain exactly 20 observations.`);
    }
    for (const sample of samples) assertPositiveInteger(sample, `kernel ${key} max-observed RSS`);
  }
  assertPositiveInteger(
    value.kernelRequestsMaxObservedRssKiB.stableMultiKeySortFirstUncached,
    "kernel first uncached sort max-observed RSS"
  );
  assertPositiveInteger(
    value.kernelRequestsMaxObservedRssKiB.semanticControls,
    "kernel semantic-control max-observed RSS"
  );
  const workloadObservations = [
    ...value.kernelRequestsMaxObservedRssKiB.projectedPage,
    ...value.kernelRequestsMaxObservedRssKiB.compoundFilterPage,
    value.kernelRequestsMaxObservedRssKiB.stableMultiKeySortFirstUncached,
    ...value.kernelRequestsMaxObservedRssKiB.stableMultiKeySortPage,
    ...value.kernelRequestsMaxObservedRssKiB.eightColumnSummary,
    value.kernelRequestsMaxObservedRssKiB.semanticControls
  ];
  if (value.workloadKernelMaxObservedRssKiB < Math.max(...workloadObservations)) {
    throw new TypeError("Workload-kernel maximum RSS contradicts its per-request observations.");
  }
  assertEqual(value.everyProcessObserved, true, "native R resource observation proof");
  assertEqual(value.everyStageObserved, true, "native R stage resource observation proof");
}

function validateCleanup(value) {
  exactKeys(
    value,
    [
      "directProcessExitedNaturally",
      "libraryProbeProcessExitedNaturally",
      "freshKernelProcessesExitedNaturally",
      "workloadKernelProcessExitedNaturally",
      "ownedRscriptProcessesExitedNaturally",
      "sessionsClosed",
      "processGroupsGone",
      "privateRootRemoved"
    ],
    "native R cleanup proof"
  );
  assertBoolean(value.directProcessExitedNaturally, "direct Rscript natural exit proof");
  assertEqual(value.libraryProbeProcessExitedNaturally, true, "library-probe Rscript natural exit proof");
  assertEqual(value.freshKernelProcessesExitedNaturally, 5, "fresh kernel natural exit count");
  assertBoolean(value.workloadKernelProcessExitedNaturally, "workload kernel natural exit proof");
  assertEqual(value.ownedRscriptProcessesExitedNaturally, 8, "owned Rscript natural exit count");
  assertEqual(value.sessionsClosed, 8, "closed native R session count");
  assertBoolean(value.processGroupsGone, "native R process-group cleanup proof");
  assertBoolean(value.privateRootRemoved, "native R private-root cleanup proof");
}

function measurementValidity(report) {
  const failures = [];
  for (const [label, proof] of [
    ["direct frame", report.measurements.directFrame.semanticProof],
    ["kernel round trip", report.measurements.kernelRoundTrip.semanticProof]
  ]) {
    if (!proof.passed) failures.push(`${label} semantic proof failed`);
    if (!proof.sourceUnchanged) failures.push(`${label} source fixture changed`);
  }
  if (!report.resources.everyProcessObserved) failures.push("not every owned Rscript had an RSS observation");
  if (!report.resources.everyStageObserved)
    failures.push("not every native R measurement stage had an RSS observation");
  if (!report.cleanup.directProcessExitedNaturally) failures.push("direct Rscript did not exit naturally");
  if (!report.cleanup.libraryProbeProcessExitedNaturally) {
    failures.push("library-probe Rscript did not exit naturally");
  }
  if (report.cleanup.freshKernelProcessesExitedNaturally !== 5) {
    failures.push("not every fresh kernel Rscript exited naturally");
  }
  if (!report.cleanup.workloadKernelProcessExitedNaturally) {
    failures.push("workload kernel Rscript did not exit naturally");
  }
  if (report.cleanup.ownedRscriptProcessesExitedNaturally !== 8) {
    failures.push("not every owned Rscript exited naturally");
  }
  if (report.cleanup.sessionsClosed !== 8) failures.push("not every kernel session closed");
  if (!report.cleanup.processGroupsGone) failures.push("an owned Rscript process group may remain");
  if (!report.cleanup.privateRootRemoved) failures.push("the private measurement root was not removed");
  return { passed: failures.length === 0, failures };
}

function assertSamples(samples, label, expectedCount) {
  if (!Array.isArray(samples) || samples.length !== expectedCount) {
    throw new TypeError(`${label} must retain exactly ${expectedCount} raw samples.`);
  }
  for (const sample of samples) {
    if (
      typeof sample !== "number" ||
      !Number.isFinite(sample) ||
      sample < 0 ||
      sample > R_PERFORMANCE_PROCESS_SAFETY_DEADLINE_MS
    ) {
      throw new TypeError(
        `${label} must contain finite non-negative milliseconds within the operational process deadline.`
      );
    }
  }
}

function median(ordered) {
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function nearestRank(ordered, percentile) {
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)];
}

function canonicalUtcTimestamp(value) {
  assertBoundedString(value, "native R report timestamp", 64);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError("Native R report timestamp must be canonical UTC ISO text.");
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has missing or unknown fields.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
}

function assertBoundedString(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be one bounded single-line string.`);
  }
}

function assertMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid.`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new TypeError(`${label} must be ${JSON.stringify(expected)}.`);
}

function assertPublicEvidence(value, key = "") {
  if (Array.isArray(value)) {
    for (const entry of value) assertPublicEvidence(entry, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      if (
        /(?:^|_)(?:path|uri|cwd|home|workspace|profile|commandLine|sourceLabel|schema|cellValues?)(?:$|_)/iu.test(
          childKey
        )
      ) {
        throw new TypeError(`Native R performance evidence cannot contain private field ${childKey}.`);
      }
      assertPublicEvidence(child, childKey);
    }
    return;
  }
  if (typeof value === "string") {
    const pathCandidate = value;
    if (
      /[\\/]/u.test(pathCandidate) ||
      /[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(pathCandidate) ||
      /\bfile:(?:\/+|\\+)/iu.test(pathCandidate) ||
      /(?:^|[^\p{L}\p{N}])[\\/]+/u.test(pathCandidate) ||
      /(?:^|[^\p{L}\p{N}])~[^\s]*/u.test(pathCandidate) ||
      /(?:^|[^\p{L}\p{N}])\.{1,2}(?=$|[^\p{L}\p{N}])/u.test(pathCandidate) ||
      /(?:^|[^\p{L}\p{N}])[A-Za-z]:[^\s]*/u.test(pathCandidate) ||
      /(?:^|[^\p{L}\p{N}])(?:\$[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?|\$\{[^}\s]+\}|%[^%\s]+%)(?=$|[^\p{L}\p{N}_])/iu.test(
        pathCandidate
      ) ||
      /%[0-9A-Fa-f]{2}/u.test(pathCandidate)
    ) {
      throw new TypeError(`Native R performance evidence field ${key} contains a private path.`);
    }
  }
}

function assertReplaceableDestination(destination) {
  try {
    const metadata = lstatSync(destination, { bigint: true });
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("Native R report destination must be one current-user-owned single-link regular file.");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error("Native R report publication made no write progress.");
    offset += count;
  }
}

function readReportSnapshot(file, afterOpen) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    requireSameFile(lstatSync(file, { bigint: true }), opened, "Native R report path changed before reading.");
    if (opened.size <= 0n || opened.size > BigInt(R_PERFORMANCE_MAX_REPORT_BYTES)) {
      throw new Error("Native R report has an invalid byte size.");
    }
    afterOpen?.(file);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count <= 0) throw new Error("Native R report ended before its pinned byte size.");
      offset += count;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    requireSameFile(completed, opened, "Native R report changed while reading.");
    requireSameFile(lstatSync(file, { bigint: true }), opened, "Native R report path changed while reading.");
    return Object.freeze({ bytes, identity: Object.freeze(identityReceipt(completed)) });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireSameIdentity(actual, expected, message) {
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1n ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error(message);
  }
}

function requireSameFile(actual, expected, message) {
  requireSameIdentity(actual, expected, message);
  if (actual.size !== expected.size || actual.mtimeNs !== expected.mtimeNs || actual.ctimeNs !== expected.ctimeNs) {
    throw new Error(message);
  }
}

function requireSamePublishedFile(actual, expected, message) {
  requireSameIdentity(actual, expected, message);
  if (actual.size !== expected.size || actual.mtimeNs !== expected.mtimeNs) throw new Error(message);
}

function identityReceipt(metadata) {
  return {
    birthtimeNs: metadata.birthtimeNs,
    ctimeNs: metadata.ctimeNs,
    dev: metadata.dev,
    gid: metadata.gid,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    size: metadata.size,
    uid: metadata.uid
  };
}

function requireSameReceipt(actual, expected, message) {
  for (const key of ["birthtimeNs", "ctimeNs", "dev", "gid", "ino", "mode", "mtimeNs", "size", "uid"]) {
    if (typeof expected?.[key] !== "bigint" || actual[key] !== expected[key]) throw new Error(message);
  }
}

function removeIdentifiedTemporary(file, identity) {
  try {
    requireSameIdentity(
      lstatSync(file, { bigint: true }),
      identity,
      "Native R report temporary cleanup was withheld after an identity change."
    );
    rmSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
