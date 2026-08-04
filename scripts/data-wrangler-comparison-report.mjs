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

export const DATA_WRANGLER_STUDY_REPORT_PROTOCOL = "openwrangler-data-wrangler-study-report-v1";

const STUDY_METRICS = Object.freeze(["inlinePreviewMs", "workbenchOpenMs", "firstProfileMs", "completeProfileMs"]);
const STUDY_MEMORY_METRICS = Object.freeze(["baselinePssBytes", "peakPssBytes", "adjustedPeakPssBytes"]);
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
  if (!Number.isSafeInteger(intervalMs) || intervalMs !== 200) {
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
  const before = sanitized.filter(({ monotonicNs }) => BigInt(monotonicNs) < start).slice(-5);
  if (before.length === 0) throw new TypeError("Study PSS evidence requires a pre-action baseline sample.");
  const measured = sanitized.filter(({ monotonicNs }) => {
    const at = BigInt(monotonicNs);
    return at >= start && at <= end;
  });
  if (measured.length === 0) throw new TypeError("Study PSS evidence requires a sample inside the measurement window.");
  const baselinePssBytes = summarizeComparisonValues(before.map(({ pssBytes }) => pssBytes)).median;
  const peakPssBytes = Math.max(...measured.map(({ pssBytes }) => pssBytes));
  return Object.freeze({
    baselinePssBytes,
    peakPssBytes,
    adjustedPeakPssBytes: Math.max(0, peakPssBytes - baselinePssBytes),
    sampleCount: sanitized.length,
    intervalMs,
    samples: Object.freeze(sanitized)
  });
}

export function validateDataWranglerComparisonStudyTrial(trial, entry, manifest) {
  exactKeys(
    trial,
    [
      "protocol",
      "trialId",
      "product",
      "engine",
      "format",
      "kind",
      "order",
      "status",
      "failure",
      "metrics",
      "milestones",
      "publicUi",
      "memory",
      "provenance"
    ],
    "study trial"
  );
  assertEqual(trial.protocol, "openwrangler-comparison-trial-result-v1", "study trial protocol");
  assertMatch(trial.trialId, STUDY_TRIAL_ID, "study trial ID");
  if (!["open-wrangler", "data-wrangler"].includes(trial.product))
    throw new TypeError("Study trial product is invalid.");
  if (!["pandas", "polars"].includes(trial.engine)) throw new TypeError("Study trial engine is invalid.");
  if (!["csv", "parquet"].includes(trial.format)) throw new TypeError("Study trial format is invalid.");
  if (!["warm", "cold"].includes(trial.kind)) throw new TypeError("Study trial kind is invalid.");
  assertIntegerBetween(trial.order, 0, 255, "study trial order");
  if (!["success", "failure", "timeout"].includes(trial.status)) throw new TypeError("Study trial status is invalid.");
  if (entry) validateTrialScheduleBinding(trial, entry);

  const milestones = validateStudyMilestones(trial.milestones);
  validateStudyMetrics(trial.metrics, milestones);
  validateStudyFailure(trial.failure, trial.status);
  validateStudyPublicUi(trial.publicUi, trial.status, entry?.columns);
  if (trial.status === "success") {
    if (trial.failure !== null || milestones.length !== STUDY_MILESTONES.length) {
      throw new TypeError("A successful study trial requires every milestone and no failure.");
    }
    const recomputed = summarizeStudyPssSamples(trial.memory?.samples, milestones, trial.memory?.intervalMs);
    exactKeys(trial.memory, Object.keys(recomputed), "study trial memory");
    for (const key of ["baselinePssBytes", "peakPssBytes", "adjustedPeakPssBytes", "sampleCount", "intervalMs"]) {
      assertEqual(trial.memory[key], recomputed[key], `study trial memory ${key}`);
    }
    assertEqual(
      JSON.stringify(trial.memory.samples),
      JSON.stringify(recomputed.samples),
      "study trial sanitized PSS samples"
    );
  } else if (trial.memory !== null) {
    throw new TypeError("An unsuccessful study trial cannot claim PSS results.");
  }
  validateStudyProvenance(trial.provenance, manifest);
  assertPublicEvidence(trial);
  return trial;
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

  const summaries = [];
  for (const kind of ["warm", "cold"]) {
    for (const cell of manifest.method.cells) {
      for (const product of ["open-wrangler", "data-wrangler"]) {
        const group = [...observed.values()].filter(
          ({ entry }) => entry.kind === kind && entry.cellId === cell.id && entry.product === product
        );
        const successful = group.filter(({ trial }) => trial.status === "success").map(({ trial }) => trial);
        summaries.push({
          kind,
          cellId: cell.id,
          product,
          planned: manifest.schedule.filter(
            (entry) => entry.kind === kind && entry.cellId === cell.id && entry.product === product
          ).length,
          completed: group.length,
          successes: successful.length,
          failures: group.filter(({ trial }) => trial.status === "failure").length,
          timeouts: group.filter(({ trial }) => trial.status === "timeout").length,
          metrics: Object.fromEntries(
            STUDY_METRICS.map((name) => [
              name,
              summarizeComparisonValues(successful.map((trial) => trial.metrics[name]))
            ])
          ),
          memory: Object.fromEntries(
            STUDY_MEMORY_METRICS.map((name) => [
              name,
              summarizeComparisonValues(successful.map((trial) => trial.memory[name]))
            ])
          )
        });
      }
    }
  }

  const pairedWarm = [];
  for (const cell of manifest.method.cells) {
    const pairs = Map.groupBy(
      [...observed.values()].filter(({ entry }) => entry.kind === "warm" && entry.cellId === cell.id),
      ({ entry }) => entry.pairId
    );
    for (const name of [...STUDY_METRICS, ...STUDY_MEMORY_METRICS]) {
      const differences = [];
      for (const pair of pairs.values()) {
        const open = pair.find(({ entry }) => entry.product === "open-wrangler")?.trial;
        const baseline = pair.find(({ entry }) => entry.product === "data-wrangler")?.trial;
        if (open?.status !== "success" || baseline?.status !== "success") continue;
        const section = STUDY_METRICS.includes(name) ? "metrics" : "memory";
        differences.push(open[section][name] - baseline[section][name]);
      }
      pairedWarm.push({
        cellId: cell.id,
        metric: name,
        interpretation: "Open Wrangler minus Data Wrangler; negative is lower",
        differences: summarizeComparisonValues(differences)
      });
    }
  }

  const report = {
    protocol: DATA_WRANGLER_STUDY_REPORT_PROTOCOL,
    generatedAtUtc,
    plannedTrials: manifest.schedule.length,
    completedTrials: observed.size,
    incompleteTrialIds: manifest.schedule.filter(({ id }) => !observed.has(id)).map(({ id }) => id),
    outcomes: {
      success: [...observed.values()].filter(({ trial }) => trial.status === "success").length,
      failure: [...observed.values()].filter(({ trial }) => trial.status === "failure").length,
      timeout: [...observed.values()].filter(({ trial }) => trial.status === "timeout").length
    },
    method: structuredClone(manifest.method),
    provenance: structuredClone(manifest.provenance),
    trials: manifest.schedule
      .filter(({ id }) => observed.has(id))
      .map(({ id }) => structuredClone(observed.get(id).trial)),
    summaries,
    pairedWarm
  };
  assertPublicEvidence(report);
  return Object.freeze(report);
}

function validateStudyManifest(manifest) {
  if (
    manifest?.protocol !== "openwrangler-data-wrangler-study-v1" ||
    !Array.isArray(manifest.method?.cells) ||
    !Array.isArray(manifest.schedule) ||
    manifest.schedule.length !== 96
  ) {
    throw new TypeError("Study report requires the fixed 96-trial study manifest.");
  }
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
      [
        "id",
        "pairId",
        "kind",
        "repetition",
        "cellId",
        "engine",
        "format",
        "rows",
        "columns",
        "product",
        "orderInPair",
        "order"
      ],
      "study schedule entry"
    );
    assertMatch(entry.id, STUDY_TRIAL_ID, "study schedule trial ID");
    assertMatch(entry.pairId, STUDY_TRIAL_ID, "study schedule pair ID");
    if (!["warm", "cold"].includes(entry.kind) || !["open-wrangler", "data-wrangler"].includes(entry.product)) {
      throw new TypeError("Study schedule kind or product is invalid.");
    }
    assertIntegerBetween(entry.repetition, 1, entry.kind === "warm" ? 10 : 2, "study schedule repetition");
    assertIntegerBetween(entry.orderInPair, 0, 1, "study schedule pair order");
    assertEqual(entry.order, index, "study schedule order");
    const cell = cells.get(entry.cellId);
    if (!cell) throw new TypeError("Study schedule references an unknown cell.");
    for (const key of ["engine", "format", "rows", "columns"]) {
      assertEqual(entry[key], cell[key], `study schedule cell ${key}`);
    }
  }
  const pairs = Map.groupBy(manifest.schedule, ({ pairId }) => pairId);
  for (const entries of pairs.values()) {
    if (
      entries.length !== 2 ||
      entries[0].orderInPair !== 0 ||
      entries[1].orderInPair !== 1 ||
      entries[1].order !== entries[0].order + 1 ||
      new Set(entries.map(({ kind }) => kind)).size !== 1 ||
      new Set(entries.map(({ repetition }) => repetition)).size !== 1 ||
      new Set(entries.map(({ cellId }) => cellId)).size !== 1 ||
      new Set(entries.map(({ product }) => product)).size !== 2
    ) {
      throw new TypeError("Every study pair must contain each product once in pair order.");
    }
  }
  if (pairs.size !== 48) throw new TypeError("Study schedule must contain exactly 48 product pairs.");
  for (const cell of cells.values()) {
    for (const [kind, repetitions] of [
      ["warm", 10],
      ["cold", 2]
    ]) {
      const entries = manifest.schedule.filter((entry) => entry.cellId === cell.id && entry.kind === kind);
      const byRepetition = Map.groupBy(entries, ({ repetition }) => repetition);
      if (entries.length !== repetitions * 2 || byRepetition.size !== repetitions) {
        throw new TypeError(`Study schedule ${kind} coverage is incomplete for ${cell.id}.`);
      }
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const pair = byRepetition.get(repetition);
        if (!pair || pair.length !== 2 || new Set(pair.map(({ pairId }) => pairId)).size !== 1) {
          throw new TypeError(`Study schedule ${kind} repetition coverage is invalid for ${cell.id}.`);
        }
      }
      const firstProducts = entries.filter(({ orderInPair }) => orderInPair === 0).map(({ product }) => product);
      const expectedFirstCount = repetitions / 2;
      if (
        firstProducts.filter((product) => product === "open-wrangler").length !== expectedFirstCount ||
        firstProducts.filter((product) => product === "data-wrangler").length !== expectedFirstCount
      ) {
        throw new TypeError(`Study schedule ${kind} product order is not counterbalanced for ${cell.id}.`);
      }
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
  if (!STUDY_FAILURE_STAGES.has(failure.stage) || !["product", "timeout"].includes(failure.kind)) {
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

function validateStudyPublicUi(value, status, scheduledColumns) {
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
    if (scheduledColumns !== undefined) {
      assertEqual(value.profiling.expectedColumns, scheduledColumns, "study trial scheduled profile columns");
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
