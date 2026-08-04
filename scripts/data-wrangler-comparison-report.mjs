const SHA256 = /^[0-9a-f]{64}$/u;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const DATA_WRANGLER_BASELINE_VERSION = "1.24.2";

export const DATA_WRANGLER_STUDY_TOOL_NAMES = Object.freeze([
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

export const DATA_WRANGLER_STUDY_REPORT_PROTOCOL = "openwrangler-data-wrangler-study-report-v2";
export const DATA_WRANGLER_REGRESSION_LIMITS = Object.freeze({
  inlinePreviewMs: Object.freeze({ relative: 0.2, absolute: 250 }),
  workbenchOpenMs: Object.freeze({ relative: 0.2, absolute: 250 }),
  firstProfileMs: Object.freeze({ relative: 0.2, absolute: 500 }),
  completeProfileMs: Object.freeze({ relative: 0.2, absolute: 2_000 }),
  peakPssBytes: Object.freeze({ relative: 0.1, absolute: 256 * 1024 * 1024 })
});

const STUDY_METRICS = Object.freeze(["inlinePreviewMs", "workbenchOpenMs", "firstProfileMs", "completeProfileMs"]);
const STUDY_MEMORY_METRICS = Object.freeze(["peakPssBytes"]);
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
  if (![2, 10].includes(repetitions) || !Array.isArray(trial.samples) || trial.samples.length !== repetitions) {
    throw new TypeError(`A study session requires exactly ${repetitions === 2 ? "two" : "ten"} measured samples.`);
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
  assertPublicEvidence(report);
  return Object.freeze(report);
}

export function assertReleaseCompleteStudyReport(report) {
  if (
    report?.protocol !== DATA_WRANGLER_STUDY_REPORT_PROTOCOL ||
    report.plannedSessions !== 8 ||
    report.completedSessions !== 8 ||
    report.incompleteSessionIds?.length !== 0 ||
    report.plannedSamples !== 80 ||
    report.completedSamples !== 80 ||
    report.samples?.length !== 80 ||
    report.outcomes?.success !== 80 ||
    report.outcomes?.failure !== 0 ||
    report.outcomes?.timeout !== 0
  ) {
    throw new TypeError("A release comparison report requires eight complete sessions and eighty successful samples.");
  }
  for (const summary of report.summaries ?? []) {
    if (
      summary.planned !== 10 ||
      summary.completed !== 10 ||
      summary.successes !== 10 ||
      summary.failures !== 0 ||
      summary.timeouts !== 0 ||
      [...STUDY_METRICS, ...STUDY_MEMORY_METRICS].some((name) => {
        const section = STUDY_METRICS.includes(name) ? summary.metrics : summary.memory;
        return section?.[name]?.count !== 10;
      })
    ) {
      throw new TypeError("A release comparison report requires every scheduled product sample.");
    }
  }
  if (report.summaries?.length !== 8) {
    throw new TypeError("A release comparison report requires every study summary.");
  }
  const regressions = materialRegressionBreaches(report);
  if (regressions.length > 0) {
    throw new TypeError(
      `Open Wrangler exceeds the predeclared material-regression limit: ${regressions
        .map(({ cellId, metric, statistic }) => `${cellId} ${metric} ${statistic}`)
        .join(", ")}.`
    );
  }
  return report;
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
    manifest?.protocol !== "openwrangler-data-wrangler-study-v2" ||
    !Array.isArray(manifest.method?.cells) ||
    !Array.isArray(manifest.schedule) ||
    manifest.schedule.length !== 8
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
  if (![2, 10].includes(manifest.method.repetitionsPerSession)) {
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
    `${manifest.method.repetitionsPerSession === 10 ? "ten" : "two"} successful warm samples per product and workload; Hyndman-Fan type 7 min, max, median, and p95`,
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
  if (!STUDY_FAILURE_STAGES.has(failure.stage) || !["harness", "product", "timeout"].includes(failure.kind)) {
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
