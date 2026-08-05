import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  DATA_WRANGLER_VERSION,
  buildComparisonNotebook,
  buildComparisonTestExtension,
  buildComparisonTrialRequest,
  digest,
  inspectComparisonEnvironment,
  inspectMachineEnvironment,
  prepareComparisonStudyRun,
  readJson,
  removePreparedExtensionDirectories,
  runComparisonSchedule,
  runNeutralDriver,
  sanitizeError,
  spawnCommand
} from "./data-wrangler-comparison-study.mjs";

export const LARGE_STUDY_PROTOCOL = "openwrangler-large-data-wrangler-study-v1";
export const LARGE_TRIAL_PROTOCOL = "openwrangler-large-data-wrangler-trial-v1";
export const LARGE_REPORT_PROTOCOL = "openwrangler-large-data-wrangler-report-v1";
export const LARGE_FIXTURE_PROTOCOL = "openwrangler-large-parquet-fixture-v1";
export const LARGE_ROWS = 10_000_000;
export const LARGE_COLUMNS = 100;
export const LARGE_REPETITIONS = 5;
export const LARGE_MIN_SUCCESSFUL_REPETITIONS = 4;
const PRODUCTS = Object.freeze(["open-wrangler", "data-wrangler"]);
const ENGINES = Object.freeze(["pandas", "polars"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const LOAD_TIMEOUT_MS = 900_000;
const MIN_AVAILABLE_MEMORY_BYTES = 40 * 1024 ** 3;
const MIN_FREE_DISK_BYTES = 15 * 1024 ** 3;
const MIXED_PROFILE_SENTINELS = Object.freeze({
  numericExtrema: [-900_000_000, 900_000_000],
  categoricalTopValue: "enterprise",
  highCardinalityTopValueTemplate: "popular-c{column}",
  datetimeExtrema: ["2000-01-01", "2099-12-31"],
  durationExtremaMs: [-86_400_000, 31_536_000_000],
  durationTopValueMs: 172_800_000,
  booleanValues: ["True", "False"]
});
const TRIAL_TIMEOUTS_MS = Object.freeze({
  preAction: 120_000,
  inlinePreview: 120_000,
  workbenchOpen: 180_000,
  completeProfile: 600_000,
  editorPhase: 600_000
});

export function createLargeComparisonSchedule() {
  const schedule = [];
  for (let repetition = 1; repetition <= LARGE_REPETITIONS; repetition += 1) {
    const engines = repetition % 2 === 1 ? ENGINES : [...ENGINES].reverse();
    for (const engine of engines) {
      const engineIndex = ENGINES.indexOf(engine);
      const products = (repetition + engineIndex) % 2 === 1 ? PRODUCTS : [...PRODUCTS].reverse();
      for (const [productIndex, product] of products.entries()) {
        schedule.push(
          Object.freeze({
            id: `fresh.r${String(repetition).padStart(2, "0")}.${engine}.${product}`,
            product,
            engine,
            kind: "warm",
            cellId: `${engine}-parquet`,
            format: "parquet",
            rows: LARGE_ROWS,
            columns: LARGE_COLUMNS,
            repetition,
            measureNativeLoad: productIndex === 0,
            order: schedule.length
          })
        );
      }
    }
  }
  return Object.freeze(schedule);
}

export function summarizeLargeValues(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new TypeError("Large comparison summaries require finite non-negative values.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[Math.max(0, middle - 1)] + sorted[middle]) / 2;
  return Object.freeze({ count: sorted.length, minimum: sorted[0], median, maximum: sorted.at(-1) });
}

export function buildLargeStudyManifest({ createdAtUtc, candidate, editor, python, fixture, machine, tools }) {
  if (typeof createdAtUtc !== "string" || new Date(createdAtUtc).toISOString() !== createdAtUtc) {
    throw new TypeError("The large study timestamp must be canonical UTC.");
  }
  validateFixtureManifest(fixture);
  validateArtifact(candidate, "Open Wrangler candidate");
  validateArtifact(editor, "VS Code");
  validateArtifact(python, "Python");
  if (machine?.os !== "linux") throw new TypeError("The large comparison currently requires Linux.");
  if (!tools || Object.values(tools).some((value) => !SHA256.test(value))) {
    throw new TypeError("The large comparison tool hashes are incomplete.");
  }
  return Object.freeze({
    protocol: LARGE_STUDY_PROTOCOL,
    createdAtUtc,
    method: {
      repetitionsPerProductAndEngine: LARGE_REPETITIONS,
      sessionPolicy: "one new headless VS Code window and one new Jupyter kernel per measurement",
      fixture: { rows: LARGE_ROWS, columns: LARGE_COLUMNS, format: "parquet" },
      measurements: {
        fileLoad: "one native dataframe load per engine and repetition in a separate new Python process",
        inlinePreview: "Run Cell click to usable inline dataframe preview",
        workbenchOpen: "viewer launch click to usable scrollable grid",
        runCellToWorkbench: "Run Cell click to usable scrollable grid",
        allProfiles: "profiling action to completed summaries for every column",
        memory: "first, peak, and increase in sampled editor-process-tree PSS during the UI journey"
      },
      statistics: "fixed five-attempt schedule; each metric uses every attempt that reached its endpoint",
      resultRule: {
        minimumSuccessfulAttemptsPerProductAndEngine: LARGE_MIN_SUCCESSFUL_REPETITIONS,
        minimumSuccessfulNativeLoadsPerEngine: LARGE_MIN_SUCCESSFUL_REPETITIONS,
        retries: 0,
        includeEverySuccessfulAttempt: true,
        reviewEveryFailure: true
      },
      runRequirements: {
        minimumAvailableMemoryBytes: MIN_AVAILABLE_MEMORY_BYTES,
        minimumFreeDiskBytes: MIN_FREE_DISK_BYTES,
        powerSource: "ac",
        cpuGovernor: machine.cpuGovernor
      }
    },
    schedule: createLargeComparisonSchedule(),
    provenance: {
      openWrangler: { extensionId: "Matt17BR.openwrangler", ...candidate },
      dataWrangler: {
        extensionId: "ms-toolsai.datawrangler",
        version: DATA_WRANGLER_VERSION,
        source: "Visual Studio Marketplace"
      },
      editor,
      python,
      fixture,
      machine,
      tools
    }
  });
}

export async function runLargeComparisonStudy(options, dependencies = {}) {
  if (options.confirmLargeStudy !== true) throw new Error("Pass --confirm-large-study to run this manual benchmark.");
  const inspect = dependencies.captureProvenance ?? captureLargeProvenance;
  const prepareTools = dependencies.prepareTools ?? buildComparisonTestExtension;
  const runLoad = dependencies.runLoad ?? measureNativeLoad;
  const runJourney = dependencies.runJourney ?? runNeutralDriver;
  const makeTrial = dependencies.prepareTrial ?? prepareLargeTrial;
  const inspectRunEnvironment =
    dependencies.inspectRunEnvironment ?? (() => inspectLargeRunEnvironment(options.python, options.parquet));
  const now = dependencies.now ?? (() => new Date().toISOString());
  const preparedStudy = await prepareComparisonStudyRun({
    output: options.output,
    now,
    prepareTools,
    captureProvenance: () => inspect(options),
    buildManifest: ({ observed, createdAtUtc, existingManifest }) => {
      const machine = existingManifest
        ? {
            ...observed.machine,
            powerSource: existingManifest.provenance.machine.powerSource,
            cpuGovernor: existingManifest.provenance.machine.cpuGovernor
          }
        : observed.machine;
      return buildLargeStudyManifest({ ...observed, machine, createdAtUtc });
    }
  });
  const { output, trialsDirectory, manifest } = preparedStudy;
  const existingTrials = loadLargeTrials(output, manifest).trials;
  const assertEnvironment = async () =>
    assertLargeRunEnvironment(await inspectRunEnvironment(), manifest.provenance.machine);
  return runComparisonSchedule({
    output,
    trialsDirectory,
    manifest,
    schedule: manifest.schedule,
    completedIds: existingTrials.map(({ trialId }) => trialId),
    limit: options.limit,
    beforeTrial: assertEnvironment,
    executeTrial: async ({ entry, trialRoot }) => {
      const prepared = makeTrial({ entry, manifest, options, trialRoot });
      try {
        const load = entry.measureNativeLoad ? await runLoad(prepared.request) : null;
        try {
          const journey = await runJourney(prepared.request);
          return buildLargeTrialResult(entry, load, journey.samples[0]);
        } catch (error) {
          return buildLargeTrialFailure(entry, error, load);
        }
      } finally {
        prepared.verifySource();
      }
    },
    afterTrial: assertEnvironment,
    buildFailure: buildLargeTrialFailure,
    validateTrial: validateLargeTrial,
    isTerminal: () => true,
    cleanup: () => removePreparedExtensionDirectories(output)
  });
}

export function prepareLargeTrial({ entry, manifest, options, trialRoot }) {
  mkdirSync(trialRoot, { recursive: true, mode: 0o700 });
  const source = join(trialRoot, basename(options.parquet));
  try {
    linkSync(options.parquet, source);
  } catch (error) {
    if (error?.code === "EXDEV") {
      throw new Error(
        "The fixture and benchmark output must be on the same filesystem so each trial can use a hard link."
      );
    }
    throw error;
  }
  const sourceIdentity = regularFileIdentity(source);
  if (sourceIdentity.size !== String(manifest.provenance.fixture.bytes)) {
    throw new Error("The large fixture size changed before the trial.");
  }
  const notebookPath = join(trialRoot, `${entry.id}.ipynb`);
  writeFileSync(notebookPath, `${JSON.stringify(buildComparisonNotebook(entry, source), null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  const request = buildComparisonTrialRequest({
    entry,
    manifest,
    options,
    trialRoot,
    source,
    sourceSha256: manifest.provenance.fixture.sha256,
    sourceIdentity,
    repetitions: 1,
    profileContract: "mixed-sentinels-v1",
    notebookPath,
    timeoutsMs: TRIAL_TIMEOUTS_MS
  });
  return Object.freeze({
    request,
    verifySource() {
      if (digest(regularFileIdentity(source)) !== digest(sourceIdentity)) {
        throw new Error("The large fixture identity changed during the trial.");
      }
    }
  });
}

export async function measureNativeLoad(request) {
  const program = [
    "import json, resource, sys, time",
    "engine, source = sys.argv[1], sys.argv[2]",
    "expected = (int(sys.argv[3]), int(sys.argv[4]))",
    "if engine == 'pandas':",
    "    import pandas as library",
    "elif engine == 'polars':",
    "    import polars as library",
    "else:",
    "    raise ValueError('Expected pandas or polars')",
    "reader = library.read_parquet",
    "rss = lambda: int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024",
    "baseline = rss()",
    "started = time.perf_counter_ns()",
    "frame = reader(source)",
    "elapsed = round((time.perf_counter_ns() - started) / 1_000_000, 3)",
    "shape = tuple(frame.shape)",
    "if shape != expected:",
    "    raise RuntimeError(f'Loaded {shape}; expected {expected}')",
    "peak = rss()",
    "print(json.dumps({'protocol': 'openwrangler-large-parquet-load-v1', 'engine': engine, 'elapsedMs': elapsed, 'rows': shape[0], 'columns': shape[1], 'baselinePeakRssBytes': baseline, 'peakRssBytes': peak, 'peakRssIncreaseBytes': peak - baseline}))"
  ].join("\n");
  const { stdout } = await spawnCommand(
    request.python.path,
    [
      "-I",
      "-c",
      program,
      request.cell.engine,
      request.cell.source,
      String(request.cell.rows),
      String(request.cell.columns)
    ],
    { cwd: resolve(import.meta.dirname, ".."), timeoutMs: LOAD_TIMEOUT_MS }
  );
  const result = JSON.parse(stdout);
  validateLoadResult(result, request.cell.engine, request.cell.rows, request.cell.columns);
  return result;
}

export function buildLargeTrialResult(entry, load, journey) {
  if (entry.measureNativeLoad) validateLoadResult(load, entry.engine);
  else if (load !== null) throw new TypeError("Only the scheduled native-load owner may publish a load result.");
  if (!journey || journey.index !== 1) throw new TypeError("The fresh editor journey returned the wrong sample.");
  return Object.freeze({
    protocol: LARGE_TRIAL_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    repetition: entry.repetition,
    order: entry.order,
    load,
    journey,
    error: null
  });
}

export function buildLargeComparisonReport({ generatedAtUtc, manifest, trials }) {
  if (typeof generatedAtUtc !== "string" || new Date(generatedAtUtc).toISOString() !== generatedAtUtc) {
    throw new TypeError("The large report timestamp must be canonical UTC.");
  }
  const schedule = new Map(manifest.schedule.map((entry) => [entry.id, entry]));
  const observed = new Map();
  for (const trial of trials) {
    const entry = schedule.get(trial?.trialId);
    if (!entry || observed.has(entry.id))
      throw new TypeError("The large report contains an unknown or duplicate trial.");
    validateLargeTrial(trial, entry);
    observed.set(entry.id, trial);
  }
  const summaries = [];
  for (const engine of ENGINES) {
    for (const product of PRODUCTS) {
      const group = [...observed.values()].filter((trial) => trial.engine === engine && trial.product === product);
      const successful = group.filter((trial) => trial.error === null && trial.journey.status === "success");
      const usable = group.filter((trial) => trial.error === null && trial.journey !== null);
      summaries.push({
        engine,
        product,
        planned: LARGE_REPETITIONS,
        completed: group.length,
        successful: successful.length,
        metrics: Object.fromEntries(
          [
            "inlinePreviewMs",
            "workbenchOpenMs",
            "runCellToWorkbenchMs",
            "allProfilesMs",
            "baselinePssBytes",
            "peakPssBytes",
            "pssIncreaseBytes"
          ].map((name) => [
            name,
            summarizeLargeValues(usable.map((trial) => trialUiMetric(trial, name)).filter((value) => value !== null))
          ])
        )
      });
    }
  }
  const loadSummaries = ENGINES.map((engine) => {
    const group = [...observed.values()].filter(
      (trial) => trial.engine === engine && schedule.get(trial.trialId)?.measureNativeLoad === true
    );
    const successful = group.filter((trial) => trial.load !== null);
    return {
      engine,
      planned: LARGE_REPETITIONS,
      completed: group.length,
      successful: successful.length,
      metrics: Object.fromEntries(
        ["fileLoadMs", "nativeLoadPeakRssBytes", "nativeLoadPeakRssIncreaseBytes"].map((name) => [
          name,
          summarizeLargeValues(successful.map((trial) => nativeLoadMetrics(trial.load)[name]))
        ])
      )
    };
  });
  return Object.freeze({
    protocol: LARGE_REPORT_PROTOCOL,
    generatedAtUtc,
    plannedTrials: manifest.schedule.length,
    completedTrials: observed.size,
    incompleteTrialIds: manifest.schedule.filter(({ id }) => !observed.has(id)).map(({ id }) => id),
    method: structuredClone(manifest.method),
    provenance: structuredClone(manifest.provenance),
    trials: structuredClone([...observed.values()]),
    loadSummaries,
    summaries
  });
}

export function assertCompleteLargeReport(report) {
  const resultRule = report?.method?.resultRule;
  if (
    report?.protocol !== LARGE_REPORT_PROTOCOL ||
    report.plannedTrials !== 20 ||
    report.completedTrials !== 20 ||
    report.incompleteTrialIds?.length !== 0 ||
    resultRule?.minimumSuccessfulAttemptsPerProductAndEngine !== LARGE_MIN_SUCCESSFUL_REPETITIONS ||
    resultRule?.minimumSuccessfulNativeLoadsPerEngine !== LARGE_MIN_SUCCESSFUL_REPETITIONS ||
    resultRule?.retries !== 0 ||
    resultRule?.includeEverySuccessfulAttempt !== true ||
    resultRule?.reviewEveryFailure !== true ||
    !Array.isArray(report.loadSummaries) ||
    report.loadSummaries.length !== ENGINES.length ||
    report.loadSummaries.some(
      ({ completed, successful }) => completed !== LARGE_REPETITIONS || successful < LARGE_MIN_SUCCESSFUL_REPETITIONS
    ) ||
    !Array.isArray(report.summaries) ||
    report.summaries.some(
      ({ completed, successful }) => completed !== LARGE_REPETITIONS || successful < LARGE_MIN_SUCCESSFUL_REPETITIONS
    )
  ) {
    throw new Error(
      "The large comparison needs all 20 fixed attempts and at least four successful sessions for each product and engine."
    );
  }
}

export function loadLargeTrials(output, manifest) {
  const directory = join(resolve(output), "trials");
  if (!existsSync(directory)) return { manifest, trials: [] };
  const schedule = new Map(manifest.schedule.map((entry) => [entry.id, entry]));
  const trials = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const trial = readJson(join(directory, name));
      const entry = schedule.get(trial?.trialId);
      if (!entry || name !== `${entry.id}.json`) throw new Error(`Unexpected large comparison result ${name}.`);
      validateLargeTrial(trial, entry);
      return trial;
    });
  return { manifest, trials };
}

async function captureLargeProvenance(options) {
  const fixtureMetadata = lstatSync(resolve(options.parquet));
  if (
    !fixtureMetadata.isFile() ||
    fixtureMetadata.isSymbolicLink() ||
    fixtureMetadata.nlink !== 1 ||
    (fixtureMetadata.mode & 0o222) !== 0
  ) {
    throw new Error("The large fixture must be the generator's single-link read-only regular file.");
  }
  const fixture = readJson(`${resolve(options.parquet)}.json`);
  validateFixtureManifest(fixture);
  const checkedFixture = await validateLargeFixtureFile(options.python, options.parquet);
  if (fixture.sha256 !== checkedFixture.sha256 || fixture.bytes !== checkedFixture.bytes) {
    throw new Error("The large fixture does not match its manifest.");
  }
  const environment = await inspectLargeRunEnvironment(options.python, options.parquet);
  assertLargeRunEnvironment(environment, environment.machine);
  const comparison = await inspectComparisonEnvironment(options, { toolFiles: largeToolFiles() });
  return { ...comparison, fixture, machine: environment.machine };
}

async function validateLargeFixtureFile(python, parquet) {
  const program = [
    "import json, sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from large_mixed_parquet import LargeFixtureSpec, _sha256, validate_fixture",
    "path = Path(sys.argv[2])",
    `validate_fixture(path, LargeFixtureSpec(rows=${LARGE_ROWS}, columns=${LARGE_COLUMNS}, row_group_rows=100000))`,
    "print(json.dumps({'bytes': path.stat().st_size, 'sha256': _sha256(path)}))"
  ].join("; ");
  const { stdout } = await spawnCommand(python, ["-I", "-c", program, resolve("python/benchmarks"), resolve(parquet)], {
    cwd: resolve(import.meta.dirname, ".."),
    timeoutMs: LOAD_TIMEOUT_MS
  });
  return JSON.parse(stdout);
}

export async function inspectLargeRunEnvironment(python, parquet) {
  const program = [
    "import json, sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from large_mixed_parquet import assert_large_study_capacity",
    "print(json.dumps(assert_large_study_capacity(Path(sys.argv[2]))))"
  ].join("; ");
  const { stdout } = await spawnCommand(python, ["-I", "-c", program, resolve("python/benchmarks"), resolve(parquet)], {
    cwd: resolve(import.meta.dirname, ".."),
    timeoutMs: 30_000
  });
  return Object.freeze({ machine: inspectMachineEnvironment(), capacity: JSON.parse(stdout) });
}

export function assertLargeRunEnvironment(environment, expectedMachine) {
  if (digest(environment?.machine) !== digest(expectedMachine)) {
    throw new Error("Machine, power source, or CPU governor changed during the large study.");
  }
  if (environment.machine.powerSource !== "ac") {
    throw new Error("The large study requires AC power before every editor run.");
  }
  if (environment.machine.cpuGovernor === "unknown") {
    throw new Error("The large study requires a readable, unchanged CPU governor.");
  }
  if (
    !environment.capacity ||
    environment.capacity.availableMemoryBytes < MIN_AVAILABLE_MEMORY_BYTES ||
    environment.capacity.freeDiskBytes < MIN_FREE_DISK_BYTES
  ) {
    throw new Error("Available memory or disk space fell below the large-study minimum.");
  }
}

function largeToolFiles() {
  return {
    method: resolve("docs/performance-comparison.md"),
    study: resolve("scripts/data-wrangler-large-comparison-study.mjs"),
    coordinator: resolve("scripts/data-wrangler-comparison-study.mjs"),
    driver: resolve("scripts/data-wrangler-comparison-neutral-driver.mjs"),
    generator: resolve("python/benchmarks/large_mixed_parquet.py"),
    host: resolve("dist-test/test/extensionHost/dataWranglerComparisonNotebookTrial.js"),
    dependencyLock: resolve("package-lock.json")
  };
}

function trialUiMetric(trial, name) {
  if (name === "inlinePreviewMs") return finiteMetric(trial.journey.metrics.inlinePreviewMs);
  if (name === "workbenchOpenMs") return finiteMetric(trial.journey.metrics.workbenchOpenMs);
  if (name === "allProfilesMs") return finiteMetric(trial.journey.metrics.completeProfileMs);
  if (name === "runCellToWorkbenchMs") {
    return milestoneDuration(trial.journey.milestones, "run-cell-click", "workbench-ready");
  }
  const memory = trial.journey.memory;
  if (!memory?.samples?.length) return null;
  const baseline = memory.samples[0].pssBytes;
  if (name === "baselinePssBytes") return baseline;
  if (name === "peakPssBytes") return memory.peakPssBytes;
  if (name === "pssIncreaseBytes") return Math.max(0, memory.peakPssBytes - baseline);
  throw new TypeError(`Unknown large comparison metric ${name}.`);
}

function finiteMetric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function milestoneDuration(milestones, startName, endName) {
  const start = milestones?.find(({ name }) => name === startName)?.monotonicNs;
  const end = milestones?.find(({ name }) => name === endName)?.monotonicNs;
  if (!/^[1-9]\d*$/u.test(start ?? "") || !/^[1-9]\d*$/u.test(end ?? "")) return null;
  const duration = BigInt(end) - BigInt(start);
  return duration >= 0n ? Number(duration) / 1_000_000 : null;
}

function nativeLoadMetrics(load) {
  return {
    fileLoadMs: load.elapsedMs,
    nativeLoadPeakRssBytes: load.peakRssBytes,
    nativeLoadPeakRssIncreaseBytes: load.peakRssIncreaseBytes
  };
}

function buildLargeTrialFailure(entry, error, load = null) {
  return {
    protocol: LARGE_TRIAL_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    repetition: entry.repetition,
    order: entry.order,
    load,
    journey: null,
    error: sanitizeError(error)
  };
}

function validateLargeTrial(trial, entry) {
  if (
    !trial ||
    trial.protocol !== LARGE_TRIAL_PROTOCOL ||
    trial.trialId !== entry.id ||
    trial.product !== entry.product ||
    trial.engine !== entry.engine ||
    trial.repetition !== entry.repetition ||
    trial.order !== entry.order ||
    (trial.error === null &&
      (trial.journey?.index !== 1 || (entry.measureNativeLoad ? trial.load === null : trial.load !== null))) ||
    (trial.error !== null && (typeof trial.error !== "string" || trial.error.length < 1 || trial.error.length > 500))
  ) {
    throw new TypeError(`Large comparison trial ${entry.id} is malformed.`);
  }
  if (trial.load !== null) validateLoadResult(trial.load, entry.engine);
  return trial;
}

function validateLoadResult(load, engine, rows = LARGE_ROWS, columns = LARGE_COLUMNS) {
  if (
    !load ||
    load.protocol !== "openwrangler-large-parquet-load-v1" ||
    load.engine !== engine ||
    load.rows !== rows ||
    load.columns !== columns ||
    !["elapsedMs", "baselinePeakRssBytes", "peakRssBytes", "peakRssIncreaseBytes"].every(
      (name) => typeof load[name] === "number" && Number.isFinite(load[name]) && load[name] >= 0
    ) ||
    load.peakRssBytes < load.baselinePeakRssBytes ||
    load.peakRssIncreaseBytes !== load.peakRssBytes - load.baselinePeakRssBytes
  ) {
    throw new TypeError("The native large-fixture load result is malformed.");
  }
}

function validateFixtureManifest(fixture) {
  const expectedNames = Array.from({ length: LARGE_COLUMNS }, (_unused, index) => `c${String(index).padStart(2, "0")}`);
  if (
    !fixture ||
    fixture.protocol !== LARGE_FIXTURE_PROTOCOL ||
    fixture.rows !== LARGE_ROWS ||
    fixture.columns !== LARGE_COLUMNS ||
    fixture.rowGroupRows !== 100_000 ||
    !Number.isSafeInteger(fixture.bytes) ||
    fixture.bytes < 1 ||
    !SHA256.test(fixture.sha256 ?? "") ||
    !Array.isArray(fixture.schema) ||
    fixture.schema.length !== LARGE_COLUMNS ||
    fixture.schema.some(({ name }, index) => name !== expectedNames[index]) ||
    digest(fixture.profileSentinels) !== digest(MIXED_PROFILE_SENTINELS)
  ) {
    throw new TypeError("The large Parquet fixture manifest is malformed.");
  }
}

function validateArtifact(value, label) {
  if (!value || typeof value.version !== "string" || !SHA256.test(value.sha256 ?? "")) {
    throw new TypeError(`${label} is missing its exact version or SHA-256.`);
  }
}

function regularFileIdentity(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("The large fixture link is not a regular file.");
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString()
  };
}
