import { isDeepStrictEqual } from "node:util";
import {
  DATA_WRANGLER_COMPARISON_AUTHORITY,
  isRetryableComparisonSession,
  renderComparisonReleaseStatisticsMethod
} from "./data-wrangler-comparison-contract.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const DATA_WRANGLER_BASELINE_VERSION = "1.24.2";

export const DATA_WRANGLER_STUDY_TOOL_NAMES = Object.freeze([
  "contract",
  "method",
  "study",
  "driver",
  "installer",
  "report",
  "pssSampler",
  "editorAcceptance",
  "editorEvidence",
  "editorOrchestration",
  "publicMediaContract",
  "fixtureContract",
  "vsixArchive",
  "vsixContents",
  "strictJson",
  "dependencyLock",
  "host",
  "hostSupport",
  "rendererSupport",
  "hostGridReadiness",
  "hostFragmentPublication",
  "hostProgress",
  "hostIdentifiedTemporary",
  "sharedStrictJson",
  "sharedFixtureManifest"
]);

export const DATA_WRANGLER_STUDY_REPORT_PROTOCOL = DATA_WRANGLER_COMPARISON_AUTHORITY.protocols.report;
export const DATA_WRANGLER_STUDY_REPORT_MAX_BYTES = 32 * 1024 * 1024;
export const DATA_WRANGLER_REVIEW_START = "<!-- open-wrangler-comparison-results:start -->";
export const DATA_WRANGLER_REVIEW_END = "<!-- open-wrangler-comparison-results:end -->";
export const DATA_WRANGLER_REGRESSION_LIMITS = Object.freeze({
  inlinePreviewMs: Object.freeze({ relative: 0.2, absolute: 250 }),
  workbenchOpenMs: Object.freeze({ relative: 0.2, absolute: 250 }),
  firstProfileMs: Object.freeze({ relative: 0.2, absolute: 500 }),
  completeProfileMs: Object.freeze({ relative: 0.2, absolute: 2_000 }),
  peakPssBytes: Object.freeze({ relative: 0.1, absolute: 256 * 1024 * 1024 })
});

const STUDY_METRICS = Object.freeze(["inlinePreviewMs", "workbenchOpenMs", "firstProfileMs", "completeProfileMs"]);
const STUDY_MEMORY_METRICS = Object.freeze(["peakPssBytes"]);
const STUDY_SAMPLE_KEYS = Object.freeze(["index", "status", "failure", "metrics", "milestones", "publicUi", "memory"]);
const FLATTENED_STUDY_SAMPLE_KEYS = Object.freeze([
  "sessionId",
  "product",
  "engine",
  "format",
  "order",
  ...STUDY_SAMPLE_KEYS
]);
const STUDY_MILESTONES = Object.freeze([
  "run-cell-click",
  "inline-ready",
  "launch-click",
  "workbench-ready",
  "profile-click",
  "first-profile-ready",
  "profiles-complete"
]);
const STUDY_FAILURE_STAGES = new Set([
  "run-cell",
  "inline-preview",
  "workbench-open",
  "profile-first",
  "profile-all",
  "cleanup",
  "harness"
]);
const STUDY_TRIAL_ID = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const MAX_PSS_SAMPLES = 2_000;
const PSS_SAMPLE_INTERVAL_MS = 200;
const STUDY_CELL_CONTRACT = Object.freeze({
  "pandas-csv": Object.freeze({ engine: "pandas", format: "csv", rows: 100_000, columns: 50 }),
  "polars-csv": Object.freeze({ engine: "polars", format: "csv", rows: 100_000, columns: 50 }),
  "pandas-parquet": Object.freeze({ engine: "pandas", format: "parquet", rows: 1_000_000, columns: 20 }),
  "polars-parquet": Object.freeze({ engine: "polars", format: "parquet", rows: 1_000_000, columns: 20 })
});

export function type7Quantile(values, probability) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
    typeof probability !== "number" ||
    probability < 0 ||
    probability > 1
  ) {
    throw new TypeError("Type-7 quantiles require finite values and a probability from zero to one.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]);
}

export function summarizeComparisonValues(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return Object.freeze({
    count: values.length,
    median: type7Quantile(values, 0.5),
    p95: type7Quantile(values, 0.95),
    minimum: Math.min(...values),
    maximum: Math.max(...values)
  });
}

export function summarizeStudyPssSamples(samples, milestones, intervalMs = 200) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs !== PSS_SAMPLE_INTERVAL_MS) {
    throw new TypeError("Study PSS interval must be 200 ms.");
  }
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_PSS_SAMPLES) {
    throw new TypeError(`Study PSS evidence must contain between 1 and ${MAX_PSS_SAMPLES} samples.`);
  }
  let previous = 0n;
  const sanitized = samples.map((sample, index) => {
    if (!sample || typeof sample !== "object") throw new TypeError(`Study PSS sample ${index} is malformed.`);
    const monotonicNs = sample.monotonicNs;
    if (typeof monotonicNs !== "string" || !/^[1-9]\d{0,29}$/u.test(monotonicNs)) {
      throw new TypeError(`Study PSS sample ${index} has an invalid timestamp.`);
    }
    const timestamp = BigInt(monotonicNs);
    if (timestamp <= previous) throw new TypeError("Study PSS timestamps must increase strictly.");
    previous = timestamp;
    if (!Number.isSafeInteger(sample.pssBytes) || sample.pssBytes < 0) {
      throw new TypeError(`Study PSS sample ${index} has invalid bytes.`);
    }
    if (!Number.isSafeInteger(sample.processCount) || sample.processCount < 1 || sample.processCount > 4_096) {
      throw new TypeError(`Study PSS sample ${index} has an invalid process count.`);
    }
    return Object.freeze({ monotonicNs, pssBytes: sample.pssBytes, processCount: sample.processCount });
  });
  const start = milestoneTimestamp(milestones, "run-cell-click");
  const end = milestoneTimestamp(milestones, "profiles-complete");
  if (start === undefined || end === undefined || end <= start) {
    throw new TypeError("Study PSS evidence requires a valid Run Cell-to-profiles measurement window.");
  }
  const measured = sanitized.filter(({ monotonicNs }) => {
    const at = BigInt(monotonicNs);
    return at >= start && at <= end;
  });
  if (measured.length < 2) throw new TypeError("Study PSS evidence requires continuous measurement-window coverage.");
  const maximumGap = BigInt(intervalMs * 5) * 1_000_000n;
  const measuredTimes = measured.map(({ monotonicNs }) => BigInt(monotonicNs));
  if (
    measuredTimes[0] - start > maximumGap ||
    end - measuredTimes.at(-1) > maximumGap ||
    measuredTimes.some((timestamp, index) => index > 0 && timestamp - measuredTimes[index - 1] > maximumGap)
  ) {
    throw new TypeError("Study PSS evidence has a gap longer than one second.");
  }
  const peakPssBytes = Math.max(...measured.map(({ pssBytes }) => pssBytes));
  return Object.freeze({
    peakPssBytes,
    sampleCount: sanitized.length,
    intervalMs,
    samples: Object.freeze(sanitized)
  });
}

export function validateDataWranglerComparisonStudyTrial(trial, entry, manifest) {
  exactKeys(
    trial,
    ["protocol", "trialId", "product", "engine", "format", "kind", "order", "samples", "provenance"],
    "study trial"
  );
  assertEqual(trial.protocol, "openwrangler-comparison-trial-result-v2", "study trial protocol");
  assertMatch(trial.trialId, STUDY_TRIAL_ID, "study trial ID");
  if (!["open-wrangler", "data-wrangler"].includes(trial.product))
    throw new TypeError("Study trial product is invalid.");
  if (!["pandas", "polars"].includes(trial.engine)) throw new TypeError("Study trial engine is invalid.");
  if (!["csv", "parquet"].includes(trial.format)) throw new TypeError("Study trial format is invalid.");
  assertEqual(trial.kind, "warm", "study trial kind");
  assertIntegerBetween(trial.order, 0, 7, "study trial order");
  if (entry) validateTrialScheduleBinding(trial, entry);
  const repetitions = manifest?.method?.repetitionsPerSession;
  if (
    ![
      DATA_WRANGLER_COMPARISON_AUTHORITY.smoke.samplesPerSession,
      DATA_WRANGLER_COMPARISON_AUTHORITY.local.samplesPerSession,
      DATA_WRANGLER_COMPARISON_AUTHORITY.release.samplesPerSession
    ].includes(repetitions) ||
    !Array.isArray(trial.samples) ||
    trial.samples.length !== repetitions
  ) {
    const expected = new Map([
      [2, "two"],
      [3, "three"],
      [10, "ten"]
    ]).get(repetitions);
    throw new TypeError(
      expected
        ? `A comparison session requires exactly ${expected} measured samples.`
        : "A comparison session requires two, three, or ten measured samples."
    );
  }
  for (const [offset, sample] of trial.samples.entries()) {
    validateStudySample(sample, offset + 1, entry);
  }
  validateStudyProvenance(trial.provenance, manifest);
  assertPublicEvidence(trial);
  return trial;
}

function validateStudySample(sample, expectedIndex, entry) {
  exactKeys(
    sample,
    ["index", "status", "failure", "metrics", "milestones", "publicUi", "memory"],
    `study sample ${expectedIndex}`
  );
  assertEqual(sample.index, expectedIndex, `study sample ${expectedIndex} index`);
  if (!["success", "failure", "timeout"].includes(sample.status)) {
    throw new TypeError(`Study sample ${expectedIndex} status is invalid.`);
  }
  const milestones = validateStudyMilestones(sample.milestones);
  validateStudyMetrics(sample.metrics, milestones);
  validateStudyFailure(sample.failure, sample.status);
  validateStudyPublicUi(sample.publicUi, sample.status, entry);
  if (sample.status === "success") {
    if (sample.failure !== null || milestones.length !== STUDY_MILESTONES.length) {
      throw new TypeError("A successful study sample requires every milestone and no failure.");
    }
    const recomputed = summarizeStudyPssSamples(sample.memory?.samples, milestones, sample.memory?.intervalMs);
    exactKeys(sample.memory, Object.keys(recomputed), "study sample memory");
    for (const key of ["peakPssBytes", "sampleCount", "intervalMs"]) {
      assertEqual(sample.memory[key], recomputed[key], `study sample memory ${key}`);
    }
    assertEqual(
      JSON.stringify(sample.memory.samples),
      JSON.stringify(recomputed.samples),
      "study sample sanitized PSS samples"
    );
  } else if (sample.memory !== null) {
    throw new TypeError("An unsuccessful study sample cannot claim PSS results.");
  }
}

export function buildDataWranglerComparisonStudyReport({ generatedAtUtc, manifest, trials }) {
  canonicalUtcTimestamp(generatedAtUtc);
  validateStudyManifest(manifest);
  if (!Array.isArray(trials)) throw new TypeError("Study report trials must be an array.");
  const schedule = new Map(manifest.schedule.map((entry) => [entry.id, entry]));
  if (schedule.size !== manifest.schedule.length) throw new TypeError("Study manifest trial IDs must be unique.");
  const observed = new Map();
  for (const trial of trials) {
    const entry = schedule.get(trial?.trialId);
    if (!entry || observed.has(trial.trialId)) {
      throw new TypeError("Study report contains an unknown, duplicate, or malformed trial.");
    }
    validateDataWranglerComparisonStudyTrial(trial, entry, manifest);
    observed.set(trial.trialId, { entry, trial });
  }

  const samples = manifest.schedule.flatMap((entry) => {
    const trial = observed.get(entry.id)?.trial;
    return trial
      ? trial.samples.map((sample) => ({
          sessionId: trial.trialId,
          product: trial.product,
          engine: trial.engine,
          format: trial.format,
          order: trial.order,
          ...structuredClone(sample)
        }))
      : [];
  });
  const summaries = [];
  const repetitions = manifest.method.repetitionsPerSession;
  for (const cell of manifest.method.cells) {
    for (const product of ["open-wrangler", "data-wrangler"]) {
      const group = samples.filter(
        (sample) => sample.engine === cell.engine && sample.format === cell.format && sample.product === product
      );
      const successful = group.filter(({ status }) => status === "success");
      summaries.push({
        cellId: cell.id,
        product,
        planned: repetitions,
        completed: group.length,
        successes: successful.length,
        failures: group.filter(({ status }) => status === "failure").length,
        timeouts: group.filter(({ status }) => status === "timeout").length,
        metrics: Object.fromEntries(
          STUDY_METRICS.map((name) => [
            name,
            summarizeComparisonValues(successful.map((sample) => sample.metrics[name]))
          ])
        ),
        memory: Object.fromEntries(
          STUDY_MEMORY_METRICS.map((name) => [
            name,
            summarizeComparisonValues(successful.map((sample) => sample.memory[name]))
          ])
        )
      });
    }
  }

  const report = {
    protocol: DATA_WRANGLER_STUDY_REPORT_PROTOCOL,
    generatedAtUtc,
    plannedSessions: manifest.schedule.length,
    completedSessions: observed.size,
    incompleteSessionIds: manifest.schedule.filter(({ id }) => !observed.has(id)).map(({ id }) => id),
    plannedSamples: manifest.schedule.length * repetitions,
    completedSamples: samples.length,
    outcomes: {
      success: samples.filter(({ status }) => status === "success").length,
      failure: samples.filter(({ status }) => status === "failure").length,
      timeout: samples.filter(({ status }) => status === "timeout").length
    },
    method: structuredClone(manifest.method),
    provenance: structuredClone(manifest.provenance),
    samples,
    summaries
  };
  report.decision = buildDataWranglerComparisonDecision(report);
  assertPublicEvidence(report);
  return Object.freeze(report);
}

export function buildDataWranglerComparisonDecision(report) {
  const authority = DATA_WRANGLER_COMPARISON_AUTHORITY.release;
  const decisionReasons = DATA_WRANGLER_COMPARISON_AUTHORITY.decisionReasons;
  const samplesBySession = new Map();
  for (const sample of report.samples ?? []) {
    const samples = samplesBySession.get(sample.sessionId) ?? [];
    samples.push(sample);
    samplesBySession.set(sample.sessionId, samples);
  }
  const retryableSessionIds = [...samplesBySession]
    .filter(([_sessionId, samples]) => isRetryableComparisonSession(samples))
    .map(([sessionId]) => sessionId)
    .sort();
  const reasons = [];
  if (report.method?.repetitionsPerSession !== authority.samplesPerSession)
    reasons.push(decisionReasons.nonReleaseProfile);
  if ((report.incompleteSessionIds?.length ?? 0) > 0) reasons.push(decisionReasons.incompleteCollection);
  if (retryableSessionIds.length > 0) reasons.push(decisionReasons.retryableHarnessSession);
  if (reasons.length === 0) {
    const insufficientBaseline = (report.summaries ?? []).some(
      ({ product, successes }) => product === "data-wrangler" && successes < authority.requiredSuccesses.dataWrangler
    );
    if (insufficientBaseline) reasons.push(decisionReasons.insufficientBaselineSuccesses);
  }
  if (reasons.length > 0) {
    return Object.freeze({
      disposition: "inconclusive",
      reasons: Object.freeze(reasons),
      retryableSessionIds: Object.freeze(retryableSessionIds),
      regressionBreaches: Object.freeze([])
    });
  }

  if (
    report.summaries.some(
      ({ product, successes }) => product === "open-wrangler" && successes < authority.requiredSuccesses.openWrangler
    )
  ) {
    reasons.push(decisionReasons.openWranglerSampleFailure);
  }
  const regressionBreaches = materialRegressionBreaches(report);
  if (regressionBreaches.length > 0) reasons.push(decisionReasons.materialMedianRegression);
  return Object.freeze({
    disposition: reasons.length === 0 ? "pass" : "fail",
    reasons: Object.freeze(reasons),
    retryableSessionIds: Object.freeze([]),
    regressionBreaches
  });
}

export function assertDataWranglerComparisonStudyReport(report) {
  exactKeys(
    report,
    [
      "protocol",
      "generatedAtUtc",
      "plannedSessions",
      "completedSessions",
      "incompleteSessionIds",
      "plannedSamples",
      "completedSamples",
      "outcomes",
      "method",
      "provenance",
      "samples",
      "summaries",
      "decision"
    ],
    "comparison report"
  );
  assertEqual(report.protocol, DATA_WRANGLER_STUDY_REPORT_PROTOCOL, "comparison report protocol");
  canonicalUtcTimestamp(report.generatedAtUtc);
  const expectedCells = Object.entries(STUDY_CELL_CONTRACT).map(([id, cell]) => ({ id, ...cell }));
  const repetitions = report.method?.repetitionsPerSession;
  if (
    ![
      DATA_WRANGLER_COMPARISON_AUTHORITY.smoke.samplesPerSession,
      DATA_WRANGLER_COMPARISON_AUTHORITY.release.samplesPerSession
    ].includes(repetitions)
  ) {
    throw new TypeError("A comparison report requires the two-sample smoke or ten-sample release profile.");
  }
  const productOrders = [
    ["open-wrangler", "data-wrangler"],
    ["data-wrangler", "open-wrangler"],
    ["data-wrangler", "open-wrangler"],
    ["open-wrangler", "data-wrangler"]
  ];
  const schedule = expectedCells.flatMap((cell, cellIndex) =>
    productOrders[cellIndex].map((product, productIndex) => ({
      id: `warm.${cell.id}.${product}`,
      kind: "warm",
      cellId: cell.id,
      engine: cell.engine,
      format: cell.format,
      rows: cell.rows,
      columns: cell.columns,
      product,
      order: cellIndex * 2 + productIndex
    }))
  );
  validateStudyManifest({
    protocol: DATA_WRANGLER_COMPARISON_AUTHORITY.protocols.study,
    method: report.method,
    provenance: report.provenance,
    schedule
  });
  assertEqual(
    report.plannedSessions,
    DATA_WRANGLER_COMPARISON_AUTHORITY.release.sessions,
    "comparison report planned sessions"
  );
  assertEqual(
    report.plannedSamples,
    DATA_WRANGLER_COMPARISON_AUTHORITY.release.sessions * repetitions,
    "comparison report planned samples"
  );
  const derived = recomputeReleaseStudyFields(report, expectedCells);
  assertEqual(report.completedSessions, derived.completedSessions, "comparison report completed sessions");
  assertEqual(report.completedSamples, derived.completedSamples, "comparison report completed samples");
  if (!isDeepStrictEqual(report.incompleteSessionIds, derived.incompleteSessionIds)) {
    throw new TypeError("Comparison report incomplete sessions do not match the raw samples.");
  }
  if (!isDeepStrictEqual(report.outcomes, derived.outcomes)) {
    throw new TypeError("Comparison report outcomes do not match the raw samples.");
  }
  const observedSummaries = new Map(
    (report.summaries ?? []).map((summary) => [`${summary.cellId}:${summary.product}`, summary])
  );
  if (
    !Array.isArray(report.summaries) ||
    observedSummaries.size !== derived.summaries.length ||
    derived.summaries.some(
      (summary) => !isDeepStrictEqual(observedSummaries.get(`${summary.cellId}:${summary.product}`), summary)
    )
  ) {
    throw new TypeError("Comparison report summaries do not match the raw samples.");
  }
  const expectedDecision = buildDataWranglerComparisonDecision(report);
  if (!isDeepStrictEqual(report.decision, expectedDecision)) {
    throw new TypeError("Comparison report decision does not match its completion and regression evidence.");
  }
  assertPublicEvidence(report);
  return report;
}

export function assertReleaseCompleteStudyReport(report) {
  assertDataWranglerComparisonStudyReport(report);
  if (report.decision.disposition !== "pass") {
    throw new TypeError(
      `A release comparison report is ${report.decision.disposition}: ${report.decision.reasons.join(", ")}.`
    );
  }
  return report;
}

function recomputeReleaseStudyFields(report, cells) {
  const repetitions = report.method.repetitionsPerSession;
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const productOrders = [
    ["open-wrangler", "data-wrangler"],
    ["data-wrangler", "open-wrangler"],
    ["data-wrangler", "open-wrangler"],
    ["open-wrangler", "data-wrangler"]
  ];
  const expectedSessions = new Map(
    cells.flatMap((cell, cellIndex) =>
      productOrders[cellIndex].map((product, productIndex) => {
        const order = cellIndex * 2 + productIndex;
        const id = `warm.${cell.id}.${product}`;
        return [id, { cell, identity: `${cell.id}:${product}`, order }];
      })
    )
  );
  const sessions = new Map();
  const pairs = new Map();
  for (const sample of report.samples) {
    exactKeys(sample, FLATTENED_STUDY_SAMPLE_KEYS, "flattened study sample");
    assertMatch(sample.sessionId, STUDY_TRIAL_ID, "flattened study session ID");
    if (!["open-wrangler", "data-wrangler"].includes(sample.product)) {
      throw new TypeError("Flattened study sample product is invalid.");
    }
    const cell = cellById.get(`${sample.engine}-${sample.format}`);
    if (!cell) throw new TypeError("Flattened study sample workload is invalid.");
    assertIntegerBetween(sample.order, 0, 7, "flattened study sample order");

    const identity = `${cell.id}:${sample.product}`;
    const existing = sessions.get(sample.sessionId);
    if (
      existing !== undefined &&
      (existing.identity !== identity || existing.order !== sample.order || existing.cell !== cell)
    ) {
      throw new TypeError("A study session cannot change product, workload, or order.");
    }
    const session = existing ?? { cell, identity, order: sample.order, samples: [] };
    session.samples.push(sample);
    sessions.set(sample.sessionId, session);
  }

  for (const [sessionId, session] of sessions) {
    const expected = expectedSessions.get(sessionId);
    if (
      expected === undefined ||
      expected.cell !== session.cell ||
      expected.identity !== session.identity ||
      expected.order !== session.order
    ) {
      throw new TypeError("Raw study samples do not match the canonical release schedule.");
    }
    if (pairs.has(session.identity)) throw new TypeError("A product and workload can have only one study session.");
    pairs.set(session.identity, sessionId);
    session.samples.sort((left, right) => left.index - right.index);
    if (session.samples.length !== repetitions) {
      throw new TypeError(`Each comparison study session requires ${repetitions} raw samples.`);
    }
    session.samples.forEach((sample, offset) => {
      const evidence = Object.fromEntries(STUDY_SAMPLE_KEYS.map((key) => [key, sample[key]]));
      validateStudySample(evidence, offset + 1, session.cell);
    });
  }

  if (expectedSessions.size !== DATA_WRANGLER_COMPARISON_AUTHORITY.release.sessions || pairs.size !== sessions.size) {
    throw new TypeError("Raw study samples do not form unique product and workload sessions.");
  }
  const incompleteSessionIds = [...expectedSessions.keys()].filter((sessionId) => !sessions.has(sessionId));
  const canonicalSamples = [...sessions.values()]
    .sort((left, right) => left.order - right.order)
    .flatMap(({ samples }) => samples);
  if (canonicalSamples.some((sample, index) => sample !== report.samples[index])) {
    throw new TypeError("Raw study samples are not in canonical session and sample order.");
  }

  const outcomes = {
    success: report.samples.filter(({ status }) => status === "success").length,
    failure: report.samples.filter(({ status }) => status === "failure").length,
    timeout: report.samples.filter(({ status }) => status === "timeout").length
  };
  const summaries = cells.flatMap((cell) =>
    ["open-wrangler", "data-wrangler"].map((product) => {
      const group = report.samples.filter(
        (sample) => sample.engine === cell.engine && sample.format === cell.format && sample.product === product
      );
      const successful = group.filter(({ status }) => status === "success");
      return {
        cellId: cell.id,
        product,
        planned: repetitions,
        completed: group.length,
        successes: successful.length,
        failures: group.filter(({ status }) => status === "failure").length,
        timeouts: group.filter(({ status }) => status === "timeout").length,
        metrics: Object.fromEntries(
          STUDY_METRICS.map((name) => [
            name,
            summarizeComparisonValues(successful.map((sample) => sample.metrics[name]))
          ])
        ),
        memory: Object.fromEntries(
          STUDY_MEMORY_METRICS.map((name) => [
            name,
            summarizeComparisonValues(successful.map((sample) => sample.memory[name]))
          ])
        )
      };
    })
  );
  return {
    completedSessions: sessions.size,
    incompleteSessionIds,
    completedSamples: report.samples.length,
    outcomes,
    summaries
  };
}

export function renderDataWranglerComparisonReview(report) {
  assertDataWranglerComparisonStudyReport(report);
  const summaries = new Map(report.summaries.map((summary) => [`${summary.cellId}:${summary.product}`, summary]));
  const workloadNames = new Map([
    ["pandas-csv", "Pandas CSV"],
    ["polars-csv", "Polars CSV"],
    ["pandas-parquet", "Pandas Parquet"],
    ["polars-parquet", "Polars Parquet"]
  ]);
  const productNames = new Map([
    ["open-wrangler", "Open Wrangler"],
    ["data-wrangler", "Data Wrangler"]
  ]);
  const rows = report.method.cells.flatMap((cell) =>
    ["open-wrangler", "data-wrangler"].map((product) => {
      const summary = summaries.get(`${cell.id}:${product}`);
      return [
        workloadNames.get(cell.id),
        productNames.get(product),
        `${summary.successes}/${summary.planned}`,
        formatTiming(summary.metrics.inlinePreviewMs),
        formatTiming(summary.metrics.workbenchOpenMs),
        formatTiming(summary.metrics.firstProfileMs),
        formatTiming(summary.metrics.completeProfileMs),
        formatMemory(summary.memory.peakPssBytes)
      ];
    })
  );
  const candidate = report.provenance.openWrangler.version;
  const baseline = report.provenance.dataWrangler.version;
  const editor = report.provenance.editor.version;
  const candidateSha = report.provenance.openWrangler.sha256;
  const csv = report.provenance.fixtures.csv;
  const parquet = report.provenance.fixtures.parquet;
  return `${DATA_WRANGLER_REVIEW_START}

<!-- prettier-ignore-start -->

Report generated ${report.generatedAtUtc.slice(0, 10)} for Open Wrangler ${candidate}, Data Wrangler ${baseline}, and VS Code ${editor}.
Decision: **${report.decision.disposition.toUpperCase()}**${
    report.decision.reasons.length === 0
      ? "."
      : ` (${report.decision.reasons.map((reason) => `\`${reason}\``).join(", ")}).`
  }
Each row shows successful samples out of ${report.method.repetitionsPerSession}. Measurements are median (minimum–maximum).

- Raw report: [report.json](report.json)
- Open Wrangler VSIX SHA-256: \`${candidateSha}\`
- CSV fixture: ${formatInteger(csv.rows)} × ${formatInteger(csv.columns)}, SHA-256 \`${csv.sha256}\`
- Parquet fixture: ${formatInteger(parquet.rows)} × ${formatInteger(parquet.columns)}, SHA-256 \`${parquet.sha256}\`
- Data Wrangler: ${baseline} from ${report.provenance.dataWrangler.source}

| Workload | Product | Successful | Inline preview | Full workbench | First profile | All profiles | Peak PSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.map((row) => `| ${row.join(" | ")} |`).join("\n")}

<!-- prettier-ignore-end -->

${DATA_WRANGLER_REVIEW_END}`;
}

export function updateDataWranglerComparisonReview(review, report) {
  const { end, start } = comparisonReviewRegion(review);
  return `${review.slice(0, start)}${renderDataWranglerComparisonReview(report)}${review.slice(end)}`;
}

export function inspectDataWranglerComparisonReview(review, report) {
  let region;
  try {
    region = comparisonReviewRegion(review);
  } catch (error) {
    return [String(error?.message ?? error)];
  }
  const expected = renderDataWranglerComparisonReview(report);
  return review.slice(region.start, region.end) === expected
    ? []
    : ["The generated Data Wrangler comparison results in review.md are stale."];
}

function comparisonReviewRegion(review) {
  if (typeof review !== "string") throw new TypeError("Comparison review must be text.");
  const start = uniqueReviewMarker(review, DATA_WRANGLER_REVIEW_START);
  const endStart = uniqueReviewMarker(review, DATA_WRANGLER_REVIEW_END);
  const end = endStart + DATA_WRANGLER_REVIEW_END.length;
  if (start >= endStart) throw new TypeError("Comparison review result markers are out of order.");
  return { start, end };
}

function uniqueReviewMarker(review, marker) {
  const occurrences = review.split(marker).length - 1;
  if (occurrences !== 1) throw new TypeError(`Comparison review must contain exactly one ${marker} marker.`);
  const index = review.indexOf(marker);
  const before = index === 0 ? "" : review[index - 1];
  const after = review[index + marker.length];
  if ((before !== "" && before !== "\n") || (after !== undefined && after !== "\r" && after !== "\n")) {
    throw new TypeError(`Comparison review marker ${marker} must be on its own line.`);
  }
  return index;
}

function formatTiming(summary) {
  return summary === null
    ? "n/a"
    : `${formatDecimal(summary.median)} ms (${formatDecimal(summary.minimum)}–${formatDecimal(summary.maximum)})`;
}

function formatMemory(summary) {
  if (summary === null) return "n/a";
  const mib = (value) => formatDecimal(value / (1024 * 1024));
  return `${mib(summary.median)} MiB (${mib(summary.minimum)}–${mib(summary.maximum)})`;
}

function formatDecimal(value) {
  return Number(value).toFixed(1);
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
}

export function exceedsMaterialRegressionLimit(openWrangler, dataWrangler, limit) {
  for (const [value, label] of [
    [openWrangler, "Open Wrangler value"],
    [dataWrangler, "Data Wrangler value"],
    [limit?.relative, "relative allowance"],
    [limit?.absolute, "absolute allowance"]
  ]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative finite number.`);
    }
  }
  return openWrangler > Math.max(dataWrangler * (1 + limit.relative), dataWrangler + limit.absolute);
}

export function materialRegressionBreaches(report) {
  const breaches = [];
  for (const cell of report?.method?.cells ?? []) {
    const summaries = (report.summaries ?? []).filter(({ cellId }) => cellId === cell.id);
    const open = summaries.find(({ product }) => product === "open-wrangler");
    const baseline = summaries.find(({ product }) => product === "data-wrangler");
    if (!open || !baseline) continue;
    for (const [metric, limit] of Object.entries(DATA_WRANGLER_REGRESSION_LIMITS)) {
      const section = metric === "peakPssBytes" ? "memory" : "metrics";
      const openValue = open[section]?.[metric]?.median;
      const baselineValue = baseline[section]?.[metric]?.median;
      if (openValue === undefined || openValue === null || baselineValue === undefined || baselineValue === null)
        continue;
      if (exceedsMaterialRegressionLimit(openValue, baselineValue, limit)) {
        breaches.push(
          Object.freeze({
            cellId: cell.id,
            metric,
            statistic: "median",
            openWrangler: openValue,
            dataWrangler: baselineValue
          })
        );
      }
    }
  }
  return Object.freeze(breaches);
}

function validateStudyManifest(manifest) {
  if (
    manifest?.protocol !== DATA_WRANGLER_COMPARISON_AUTHORITY.protocols.study ||
    !Array.isArray(manifest.method?.cells) ||
    !Array.isArray(manifest.schedule) ||
    manifest.schedule.length !== DATA_WRANGLER_COMPARISON_AUTHORITY.release.sessions
  ) {
    throw new TypeError("Study report requires the fixed eight-session study manifest.");
  }
  exactKeys(
    manifest.method,
    ["cells", "repetitionsPerSession", "regressionLimits", "timingBoundaries", "statistics", "memory"],
    "study manifest method"
  );
  if (JSON.stringify(manifest.method.regressionLimits) !== JSON.stringify(DATA_WRANGLER_REGRESSION_LIMITS)) {
    throw new TypeError("Study report method policies do not match the predeclared release contract.");
  }
  if (
    ![
      DATA_WRANGLER_COMPARISON_AUTHORITY.smoke.samplesPerSession,
      DATA_WRANGLER_COMPARISON_AUTHORITY.release.samplesPerSession
    ].includes(manifest.method.repetitionsPerSession)
  ) {
    throw new TypeError("Study manifest repetitions per session must be two for smoke or ten for release.");
  }
  exactKeys(
    manifest.method.timingBoundaries,
    ["inlinePreview", "workbenchOpen", "firstProfile", "completeProfile"],
    "study manifest timing boundaries"
  );
  for (const [key, expected] of Object.entries({
    inlinePreview: "Run Cell click to stable public inline output and a usable launch action",
    workbenchOpen: "public launch-action click to a stable, unobstructed, scrollable workbench grid",
    firstProfile: "public profiling action to the first completed column summary",
    completeProfile: "public profiling action to final summaries for every column"
  })) {
    assertEqual(manifest.method.timingBoundaries[key], expected, `study manifest ${key} timing boundary`);
  }
  assertEqual(
    manifest.method.statistics,
    manifest.method.repetitionsPerSession === DATA_WRANGLER_COMPARISON_AUTHORITY.release.samplesPerSession
      ? renderComparisonReleaseStatisticsMethod()
      : "two successful warm samples per product and workload; Hyndman-Fan type 7 min, max, median, and p95",
    "study manifest statistics"
  );
  assertEqual(
    manifest.method.memory,
    "highest observed absolute process-tree PSS during each measured notebook workflow",
    "study manifest memory method"
  );
  const cells = new Map();
  for (const cell of manifest.method.cells) {
    exactKeys(cell, ["id", "engine", "format", "rows", "columns"], "study manifest cell");
    assertMatch(cell.id, STUDY_TRIAL_ID, "study manifest cell ID");
    if (!["pandas", "polars"].includes(cell.engine) || !["csv", "parquet"].includes(cell.format)) {
      throw new TypeError("Study manifest cell engine or format is invalid.");
    }
    assertEqual(cell.id, `${cell.engine}-${cell.format}`, "study manifest cell identity");
    assertPositiveInteger(cell.rows, "study manifest rows");
    assertPositiveInteger(cell.columns, "study manifest columns");
    const expected = STUDY_CELL_CONTRACT[cell.id];
    if (
      !expected ||
      cell.engine !== expected.engine ||
      cell.format !== expected.format ||
      cell.rows !== expected.rows ||
      cell.columns !== expected.columns
    ) {
      throw new TypeError("Study manifest cell does not match the fixed comparison workload.");
    }
    if (cells.has(cell.id)) throw new TypeError("Study manifest cell IDs must be unique.");
    cells.set(cell.id, cell);
  }
  if (cells.size !== 4) throw new TypeError("Study manifest must contain four engine-format cells.");
  for (const [index, entry] of manifest.schedule.entries()) {
    exactKeys(
      entry,
      ["id", "kind", "cellId", "engine", "format", "rows", "columns", "product", "order"],
      "study schedule entry"
    );
    assertMatch(entry.id, STUDY_TRIAL_ID, "study schedule trial ID");
    if (entry.kind !== "warm" || !["open-wrangler", "data-wrangler"].includes(entry.product)) {
      throw new TypeError("Study schedule kind or product is invalid.");
    }
    assertEqual(entry.order, index, "study schedule order");
    const cell = cells.get(entry.cellId);
    if (!cell) throw new TypeError("Study schedule references an unknown cell.");
    for (const key of ["engine", "format", "rows", "columns"]) {
      assertEqual(entry[key], cell[key], `study schedule cell ${key}`);
    }
  }
  for (const cell of cells.values()) {
    const entries = manifest.schedule.filter((entry) => entry.cellId === cell.id);
    if (entries.length !== 2 || new Set(entries.map(({ product }) => product)).size !== 2) {
      throw new TypeError(`Study schedule coverage is incomplete for ${cell.id}.`);
    }
  }
  const provenance = manifest.provenance;
  assertEqual(provenance?.openWrangler?.extensionId, "Matt17BR.openwrangler", "study Open Wrangler extension ID");
  assertMatch(provenance?.openWrangler?.version, NUMERIC_VERSION, "study Open Wrangler version");
  assertMatch(provenance?.openWrangler?.sha256, SHA256, "study Open Wrangler SHA-256");
  assertEqual(provenance?.dataWrangler?.extensionId, "ms-toolsai.datawrangler", "study Data Wrangler extension ID");
  assertEqual(provenance?.dataWrangler?.version, DATA_WRANGLER_BASELINE_VERSION, "study Data Wrangler version");
  assertEqual(provenance?.dataWrangler?.source, "Visual Studio Marketplace", "study Data Wrangler source");
  assertEqual(provenance?.dataWrangler?.implementationInspection, "none", "study Data Wrangler inspection");
  assertMatch(provenance?.editor?.version, NUMERIC_VERSION, "study editor version");
  assertMatch(provenance?.editor?.sha256, SHA256, "study editor SHA-256");
  assertMatch(provenance?.editor?.cliSha256, SHA256, "study editor CLI SHA-256");
  assertMatch(provenance?.editor?.productSha256, SHA256, "study editor product SHA-256");
  assertEqual(provenance?.editor?.distribution, "Visual Studio Code", "study editor distribution");
  assertMatch(provenance?.python?.version, /^3\.12\.\d+$/u, "study Python version");
  assertMatch(provenance?.python?.sha256, SHA256, "study Python SHA-256");
  assertEqual(provenance?.python?.implementation, "cpython", "study Python implementation");
  for (const cell of cells.values()) {
    const fixture = provenance?.fixtures?.[cell.format];
    assertEqual(fixture?.rows, cell.rows, `study ${cell.format} fixture rows`);
    assertEqual(fixture?.columns, cell.columns, `study ${cell.format} fixture columns`);
    assertEqual(fixture?.valuesValidated, true, `study ${cell.format} fixture value validation`);
    assertMatch(fixture?.sha256, SHA256, `study ${cell.format} fixture SHA-256`);
  }
  const machine = provenance?.machine;
  exactKeys(
    machine,
    [
      "os",
      "osRelease",
      "architecture",
      "cpuModel",
      "logicalCpuCount",
      "totalMemoryBytes",
      "powerSource",
      "cpuGovernor"
    ],
    "study machine provenance"
  );
  for (const key of ["os", "osRelease", "architecture", "cpuModel", "cpuGovernor"]) {
    assertBoundedString(machine[key], `study machine ${key}`);
  }
  assertPositiveInteger(machine.logicalCpuCount, "study machine logical CPU count");
  assertPositiveInteger(machine.totalMemoryBytes, "study machine total memory");
  if (!["ac", "battery", "unknown"].includes(machine.powerSource)) {
    throw new TypeError("Study machine power source is invalid.");
  }
  exactKeys(provenance?.tools, DATA_WRANGLER_STUDY_TOOL_NAMES, "study tool provenance");
  for (const name of DATA_WRANGLER_STUDY_TOOL_NAMES) {
    assertMatch(provenance.tools[name], SHA256, `study tool ${name} SHA-256`);
  }
}

function validateTrialScheduleBinding(trial, entry) {
  for (const [trialKey, entryKey] of [
    ["trialId", "id"],
    ["product", "product"],
    ["engine", "engine"],
    ["format", "format"],
    ["kind", "kind"],
    ["order", "order"]
  ]) {
    assertEqual(trial[trialKey], entry[entryKey], `study trial scheduled ${trialKey}`);
  }
}

function validateStudyMilestones(value) {
  if (!Array.isArray(value) || value.length > STUDY_MILESTONES.length) {
    throw new TypeError("Study trial milestones are malformed.");
  }
  let previous = 0n;
  return value.map((milestone, index) => {
    exactKeys(milestone, ["name", "monotonicNs"], `study milestone ${index}`);
    assertEqual(milestone.name, STUDY_MILESTONES[index], `study milestone ${index} name`);
    if (typeof milestone.monotonicNs !== "string" || !/^[1-9]\d{0,29}$/u.test(milestone.monotonicNs)) {
      throw new TypeError(`Study milestone ${index} timestamp is invalid.`);
    }
    const timestamp = BigInt(milestone.monotonicNs);
    if (timestamp <= previous) throw new TypeError("Study milestone timestamps must increase strictly.");
    previous = timestamp;
    return milestone;
  });
}

function validateStudyMetrics(metrics, milestones) {
  exactKeys(metrics, STUDY_METRICS, "study trial metrics");
  const pairs = {
    inlinePreviewMs: ["run-cell-click", "inline-ready"],
    workbenchOpenMs: ["launch-click", "workbench-ready"],
    firstProfileMs: ["profile-click", "first-profile-ready"],
    completeProfileMs: ["profile-click", "profiles-complete"]
  };
  for (const [name, [start, end]] of Object.entries(pairs)) {
    const expected = studyDuration(milestones, start, end);
    if (metrics[name] !== expected) throw new TypeError(`Study trial ${name} does not match its milestones.`);
  }
}

function validateStudyFailure(failure, status) {
  if (status === "success") {
    if (failure !== null) throw new TypeError("A successful study trial cannot contain a failure.");
    return;
  }
  exactKeys(failure, ["stage", "kind", "message"], "study trial failure");
  const failureKinds = [
    DATA_WRANGLER_COMPARISON_AUTHORITY.outcomes.replaceableFailureKind,
    ...DATA_WRANGLER_COMPARISON_AUTHORITY.outcomes.immutableFailureKinds
  ];
  if (!STUDY_FAILURE_STAGES.has(failure.stage) || !failureKinds.includes(failure.kind)) {
    throw new TypeError("Study trial failure kind or stage is invalid.");
  }
  if ((status === "timeout") !== (failure.kind === "timeout")) {
    throw new TypeError("Study trial timeout status and failure kind disagree.");
  }
  if (
    typeof failure.message !== "string" ||
    failure.message.length === 0 ||
    failure.message.length > 500 ||
    /[\0\r\n]/u.test(failure.message)
  ) {
    throw new TypeError("Study trial failure message is invalid.");
  }
}

function validateStudyPublicUi(value, status, scheduledEntry) {
  exactKeys(value, ["runCell", "inline", "workbench", "profiling"], "study trial public UI");
  const runCell = validateStudyAction(value.runCell, "study trial Run Cell");
  const inline = validateStudyAction(value.inline, "study trial inline action", ["tableReady"]);
  if (inline && value.inline.tableReady !== true) throw new TypeError("Study inline preview is not ready.");
  const workbench = value.workbench;
  if (workbench !== null) {
    exactKeys(
      workbench,
      [
        "rootRole",
        "fullShape",
        "ariaRowCount",
        "ariaColumnCount",
        "verticalOverflow",
        "horizontalOverflow",
        "pointerUsable"
      ],
      "study trial workbench"
    );
    if (
      !["grid", "table"].includes(workbench.rootRole) ||
      !["aria-counts", "visible-label"].includes(workbench.fullShape)
    ) {
      throw new TypeError("Study trial workbench role or shape proof is invalid.");
    }
    for (const count of [workbench.ariaRowCount, workbench.ariaColumnCount]) {
      if (count !== null && (!Number.isSafeInteger(count) || count < 1 || count > 100_000_000)) {
        throw new TypeError("Study trial workbench ARIA count is invalid.");
      }
    }
    if (
      workbench.fullShape === "aria-counts" &&
      scheduledEntry &&
      (![scheduledEntry.rows, scheduledEntry.rows + 1].includes(workbench.ariaRowCount) ||
        ![scheduledEntry.columns, scheduledEntry.columns + 1].includes(workbench.ariaColumnCount))
    ) {
      throw new TypeError("Study trial ARIA shape proof does not match the scheduled dataframe.");
    }
    for (const overflow of [workbench.verticalOverflow, workbench.horizontalOverflow]) {
      if (!Number.isSafeInteger(overflow) || overflow < 1 || overflow > 1_000_000_000) {
        throw new TypeError("Study trial workbench overflow proof is invalid.");
      }
    }
    assertEqual(workbench.pointerUsable, true, "study trial workbench pointer proof");
  }
  const profiling = validateStudyAction(value.profiling, "study trial profiling action", [
    "expectedColumns",
    "completedColumns"
  ]);
  if (profiling) {
    assertPositiveInteger(value.profiling.expectedColumns, "study trial expected profile columns");
    assertIntegerBetween(
      value.profiling.completedColumns,
      0,
      value.profiling.expectedColumns,
      "study trial completed profile columns"
    );
    if (scheduledEntry !== undefined) {
      assertEqual(value.profiling.expectedColumns, scheduledEntry.columns, "study trial scheduled profile columns");
    }
  }
  if (
    status === "success" &&
    (!runCell ||
      !inline ||
      !workbench ||
      !profiling ||
      value.profiling.completedColumns !== value.profiling.expectedColumns)
  ) {
    throw new TypeError("A successful study trial requires complete public UI evidence.");
  }
}

function validateStudyAction(value, label, extraKeys = []) {
  if (value === null) return null;
  exactKeys(value, ["accessibleName", "unique", "pointer", ...extraKeys], label);
  assertBoundedString(value.accessibleName, `${label} accessible name`);
  assertEqual(value.unique, true, `${label} unique proof`);
  assertEqual(value.pointer, true, `${label} pointer proof`);
  return value;
}

function validateStudyProvenance(value, manifest) {
  exactKeys(value, ["candidate", "dataWranglerVersion", "editor", "python"], "study trial provenance");
  for (const key of ["candidate", "editor", "python"]) {
    exactKeys(value[key], ["version", "sha256"], `study trial ${key} provenance`);
    assertMatch(value[key].version, NUMERIC_VERSION, `study trial ${key} version`);
    assertMatch(value[key].sha256, SHA256, `study trial ${key} SHA-256`);
  }
  assertEqual(value.dataWranglerVersion, DATA_WRANGLER_BASELINE_VERSION, "study trial Data Wrangler version");
  if (!manifest) return;
  for (const [actual, expected, label] of [
    [value.candidate.version, manifest.provenance.openWrangler.version, "candidate version"],
    [value.candidate.sha256, manifest.provenance.openWrangler.sha256, "candidate SHA-256"],
    [value.editor.version, manifest.provenance.editor.version, "editor version"],
    [value.editor.sha256, manifest.provenance.editor.sha256, "editor SHA-256"],
    [value.python.version, manifest.provenance.python.version, "Python version"],
    [value.python.sha256, manifest.provenance.python.sha256, "Python SHA-256"]
  ]) {
    assertEqual(actual, expected, `study trial ${label}`);
  }
}

function studyDuration(milestones, startName, endName) {
  const start = milestoneTimestamp(milestones, startName);
  const end = milestoneTimestamp(milestones, endName);
  return start === undefined || end === undefined
    ? null
    : Math.round((Number(end - start) / 1_000_000) * 1_000) / 1_000;
}

function milestoneTimestamp(milestones, name) {
  const value = milestones?.find?.((milestone) => milestone.name === name)?.monotonicNs;
  return value === undefined ? undefined : BigInt(value);
}

function canonicalUtcTimestamp(value) {
  assertBoundedString(value, "comparison report timestamp");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError("Comparison report timestamp must be a canonical UTC ISO string.");
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new TypeError(`${label} has missing or unknown fields.`);
  }
}

function assertBoundedString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be one bounded single-line string.`);
  }
}

function assertMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid.`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new TypeError(`${label} must be ${JSON.stringify(expected)}.`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
}

function assertIntegerBetween(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function assertPublicEvidence(value, key = "") {
  if (Array.isArray(value)) {
    for (const entry of value) assertPublicEvidence(entry, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      if (
        /(?:^|_)(?:path|uri|cwd|home|workspace|profile|commandLine|log|rawLog|screenshot|dom|html|asset|sourceLabel|schema|cellValues?)(?:$|_)/iu.test(
          childKey
        )
      ) {
        throw new TypeError(`Comparison evidence cannot contain private or proprietary field ${childKey}.`);
      }
      assertPublicEvidence(child, childKey);
    }
    return;
  }
  if (typeof value !== "string") return;
  const pathCandidate = value.replace(
    /(^|[^\p{L}\p{N}])((?!file:)[A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?(?:[/?#][A-Za-z0-9._~!$&'()*+\-=%:@/?#]*)?(?=$|[^\p{L}\p{N}._~!$&'()*+\-=%:@/?#])/giu,
    "$1"
  );
  if (
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
    throw new TypeError(`Comparison evidence field ${key} contains a private path.`);
  }
}
