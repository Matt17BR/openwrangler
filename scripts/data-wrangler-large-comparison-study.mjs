import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DATA_WRANGLER_VERSION,
  TRIAL_REQUEST_PROTOCOL,
  buildComparisonTestExtension,
  inspectCandidateVsix,
  inspectEditorEnvironment,
  inspectMachineEnvironment,
  inspectPythonEnvironment,
  removePreparedExtensionDirectories,
  runNeutralDriver,
  sha256File,
  spawnCommand
} from "./data-wrangler-comparison-study.mjs";

export const LARGE_STUDY_PROTOCOL = "openwrangler-large-data-wrangler-study-v1";
export const LARGE_TRIAL_PROTOCOL = "openwrangler-large-data-wrangler-trial-v1";
export const LARGE_REPORT_PROTOCOL = "openwrangler-large-data-wrangler-report-v1";
export const LARGE_FIXTURE_PROTOCOL = "openwrangler-large-parquet-fixture-v1";
export const LARGE_ROWS = 10_000_000;
export const LARGE_COLUMNS = 100;
export const LARGE_REPETITIONS = 5;
const PRODUCTS = Object.freeze(["open-wrangler", "data-wrangler"]);
const ENGINES = Object.freeze(["pandas", "polars"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 900_000;
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
    for (const [engineOffset, engine] of engines.entries()) {
      const products = (repetition + engineOffset) % 2 === 1 ? PRODUCTS : [...PRODUCTS].reverse();
      for (const product of products) {
        schedule.push(
          Object.freeze({
            id: `fresh.r${String(repetition).padStart(2, "0")}.${engine}.${product}`,
            product,
            engine,
            repetition,
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

export function buildLargeStudyManifest({
  createdAtUtc,
  candidate,
  editor,
  python,
  fixture,
  machine,
  capacity,
  tools
}) {
  if (typeof createdAtUtc !== "string" || new Date(createdAtUtc).toISOString() !== createdAtUtc) {
    throw new TypeError("The large study timestamp must be canonical UTC.");
  }
  validateFixtureManifest(fixture);
  validateArtifact(candidate, "Open Wrangler candidate");
  validateArtifact(editor, "VS Code");
  validateArtifact(python, "Python");
  if (machine?.os !== "linux") throw new TypeError("The large comparison currently requires Linux.");
  if (!capacity || capacity.availableMemoryBytes < 40 * 1024 ** 3 || capacity.freeDiskBytes < 15 * 1024 ** 3) {
    throw new TypeError("The large comparison capacity check did not pass.");
  }
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
        fileLoad: "native dataframe load in a separate new Python process immediately before the editor journey",
        inlinePreview: "Run Cell click to usable inline dataframe preview",
        workbenchOpen: "viewer launch click to usable scrollable grid",
        allProfiles: "profiling action to completed summaries for every column",
        memory: "first, peak, and increase in sampled editor-process-tree PSS during the UI journey"
      },
      statistics: "five independent measurements; minimum, median, and maximum"
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
      capacity,
      tools
    }
  });
}

export async function runLargeComparisonStudy(options, dependencies = {}) {
  if (options.confirmLargeStudy !== true) throw new Error("Pass --confirm-large-study to run this manual benchmark.");
  const output = resolve(options.output);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const inspect = dependencies.captureProvenance ?? captureLargeProvenance;
  const prepareTools = dependencies.prepareTools ?? buildComparisonTestExtension;
  const runLoad = dependencies.runLoad ?? measureNativeLoad;
  const runJourney = dependencies.runJourney ?? runNeutralDriver;
  const makeTrial = dependencies.prepareTrial ?? prepareLargeTrial;
  const now = dependencies.now ?? (() => new Date().toISOString());
  await prepareTools();
  const observed = await inspect(options);
  const manifestPath = join(output, "manifest.json");
  let manifest;
  if (existsSync(manifestPath)) {
    manifest = readJson(manifestPath);
    const expected = buildLargeStudyManifest({ ...observed, createdAtUtc: manifest.createdAtUtc });
    if (digest(manifest) !== digest(expected)) {
      throw new Error("The large study inputs changed. Use a new output directory.");
    }
  } else {
    manifest = buildLargeStudyManifest({ ...observed, createdAtUtc: now() });
    writeJsonAtomic(manifestPath, manifest);
  }
  const existingTrials = loadLargeTrials(output, manifest).trials;
  const failedExisting = existingTrials.find((trial) => trial.error !== null || trial.journey.status !== "success");
  if (failedExisting) {
    throw new Error(`Trial ${failedExisting.trialId} did not finish successfully. Inspect it and start a new study.`);
  }
  const existing = new Set(existingTrials.map(({ trialId }) => trialId));
  const remaining = manifest.schedule.filter(({ id }) => !existing.has(id));
  const limit = options.limit ?? remaining.length;
  for (const entry of remaining.slice(0, limit)) {
    const trialRoot = mkdtempSync(join(output, `trial-${String(entry.order).padStart(3, "0")}-`));
    let trial;
    try {
      const prepared = makeTrial({ entry, manifest, options, trialRoot });
      const load = await runLoad(prepared.request);
      const journey = await runJourney(prepared.request);
      prepared.verifySource();
      trial = buildLargeTrialResult(entry, load, journey.samples[0]);
    } catch (error) {
      trial = buildLargeTrialFailure(entry, error);
    } finally {
      rmSync(trialRoot, { recursive: true, force: true });
    }
    writeJsonAtomic(join(output, "trials", `${entry.id}.json`), trial);
    if (trial.error !== null || trial.journey.status !== "success") {
      throw new Error(
        `Trial ${entry.id} did not finish successfully. The study stopped before starting another editor.`
      );
    }
  }
  const status = loadLargeTrials(output, manifest);
  if (status.trials.length === manifest.schedule.length) removePreparedExtensionDirectories(output);
  return Object.freeze({ completed: status.trials.length, remaining: manifest.schedule.length - status.trials.length });
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
  writeFileSync(notebookPath, `${JSON.stringify(largeStudyNotebook(entry.engine, source), null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  const request = Object.freeze({
    protocol: TRIAL_REQUEST_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    kind: "warm",
    order: entry.order,
    repetitions: 1,
    cell: {
      id: `${entry.engine}-parquet`,
      engine: entry.engine,
      format: "parquet",
      rows: LARGE_ROWS,
      columns: LARGE_COLUMNS,
      source,
      sourceSha256: manifest.provenance.fixture.sha256,
      sourceIdentity,
      variableName: "study_frame",
      profileContract: "mixed-completion"
    },
    notebookPath,
    candidate: {
      path: resolve(options.candidate),
      version: manifest.provenance.openWrangler.version,
      sha256: manifest.provenance.openWrangler.sha256
    },
    dataWranglerVersion: DATA_WRANGLER_VERSION,
    editor: {
      path: resolve(options.editor),
      cliPath: resolve(options.editorCli),
      version: manifest.provenance.editor.version,
      sha256: manifest.provenance.editor.sha256,
      cliSha256: manifest.provenance.editor.cliSha256
    },
    python: {
      path: resolve(options.python),
      version: manifest.provenance.python.version,
      sha256: manifest.provenance.python.sha256
    },
    timeoutsMs: { ...TRIAL_TIMEOUTS_MS },
    isolatedRoot: trialRoot
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
  const helper = resolve("python/benchmarks/measure_large_parquet_load.py");
  const { stdout } = await spawnCommand(
    request.python.path,
    [
      "-I",
      helper,
      "--engine",
      request.cell.engine,
      "--source",
      request.cell.source,
      "--rows",
      String(request.cell.rows),
      "--columns",
      String(request.cell.columns)
    ],
    { cwd: resolve(import.meta.dirname, ".."), timeoutMs: LOAD_TIMEOUT_MS }
  );
  const result = JSON.parse(stdout);
  validateLoadResult(result, request.cell.engine);
  return result;
}

export function buildLargeTrialResult(entry, load, journey) {
  validateLoadResult(load, entry.engine);
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
      const metrics = successful.map(trialMetrics);
      summaries.push({
        engine,
        product,
        planned: LARGE_REPETITIONS,
        completed: group.length,
        successful: successful.length,
        metrics: Object.fromEntries(
          [
            "fileLoadMs",
            "nativeLoadPeakRssBytes",
            "nativeLoadPeakRssIncreaseBytes",
            "inlinePreviewMs",
            "workbenchOpenMs",
            "allProfilesMs",
            "baselinePssBytes",
            "peakPssBytes",
            "pssIncreaseBytes"
          ].map((name) => [name, summarizeLargeValues(metrics.map((metric) => metric[name]))])
        )
      });
    }
  }
  return Object.freeze({
    protocol: LARGE_REPORT_PROTOCOL,
    generatedAtUtc,
    plannedTrials: manifest.schedule.length,
    completedTrials: observed.size,
    incompleteTrialIds: manifest.schedule.filter(({ id }) => !observed.has(id)).map(({ id }) => id),
    method: structuredClone(manifest.method),
    provenance: structuredClone(manifest.provenance),
    trials: structuredClone([...observed.values()]),
    summaries
  });
}

export function assertCompleteLargeReport(report) {
  if (
    report?.protocol !== LARGE_REPORT_PROTOCOL ||
    report.plannedTrials !== 20 ||
    report.completedTrials !== 20 ||
    report.summaries.some(
      ({ completed, successful }) => completed !== LARGE_REPETITIONS || successful !== LARGE_REPETITIONS
    )
  ) {
    throw new Error("The large comparison needs five successful fresh sessions for each product and engine.");
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
  if (fixture.sha256 !== (await hashLargeFile(options.parquet)) || fixture.bytes !== statSync(options.parquet).size) {
    throw new Error("The large fixture does not match its manifest.");
  }
  const capacity = await inspectLargeFixtureCapacity(options.python, options.parquet);
  const candidate = await inspectCandidateVsix(options.candidate);
  const editor = await inspectEditorEnvironment(options.editor, options.editorCli);
  const python = { ...(await inspectPythonEnvironment(options.python)), sha256: sha256File(options.python) };
  const tools = Object.fromEntries(Object.entries(largeToolFiles()).map(([name, path]) => [name, sha256File(path)]));
  return { candidate, editor, python, fixture, machine: inspectMachineEnvironment(), capacity, tools };
}

export async function hashLargeFile(path) {
  const before = regularFileIdentity(path);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })) digest.update(chunk);
  if (JSON.stringify(regularFileIdentity(path)) !== JSON.stringify(before)) {
    throw new Error("The large fixture changed while it was hashed.");
  }
  return digest.digest("hex");
}

async function inspectLargeFixtureCapacity(python, parquet) {
  const program = [
    "import json, sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from large_mixed_parquet import LargeFixtureSpec, assert_large_study_capacity, validate_fixture",
    "path = Path(sys.argv[2])",
    `validate_fixture(path, LargeFixtureSpec(rows=${LARGE_ROWS}, columns=${LARGE_COLUMNS}, row_group_rows=100000))`,
    "print(json.dumps(assert_large_study_capacity(path)))"
  ].join("; ");
  const { stdout } = await spawnCommand(python, ["-I", "-c", program, resolve("python/benchmarks"), resolve(parquet)], {
    cwd: resolve(import.meta.dirname, ".."),
    timeoutMs: 180_000
  });
  return JSON.parse(stdout);
}

function largeToolFiles() {
  return {
    method: resolve("docs/performance-comparison.md"),
    study: resolve("scripts/data-wrangler-large-comparison-study.mjs"),
    driver: resolve("scripts/data-wrangler-comparison-neutral-driver.mjs"),
    generator: resolve("python/benchmarks/large_mixed_parquet.py"),
    load: resolve("python/benchmarks/measure_large_parquet_load.py"),
    host: resolve("dist-test/test/extensionHost/dataWranglerComparisonNotebookTrial.js"),
    dependencyLock: resolve("package-lock.json")
  };
}

function largeStudyNotebook(engine, source) {
  const importLine = engine === "pandas" ? "import pandas as pd" : "import polars as pl";
  const bootstrap =
    engine === "pandas" ? 'pd.DataFrame({"c00": [0], "c01": [1]})' : 'pl.DataFrame({"c00": [0], "c01": [1]})';
  const reader =
    engine === "pandas" ? `pd.read_parquet(${JSON.stringify(source)})` : `pl.read_parquet(${JSON.stringify(source)})`;
  return {
    cells: [
      codeCell(`${importLine}\naaa_comparison_bootstrap = ${bootstrap}\nstudy_frame = ${reader}`, [
        `ow-comparison-setup:${engine}-parquet`
      ]),
      codeCell("study_frame", [`ow-comparison-cell:${engine}-parquet`])
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3.12 (Comparison)",
        language: "python",
        name: "openwrangler-comparison"
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

function codeCell(source, tags) {
  return {
    cell_type: "code",
    execution_count: null,
    metadata: { tags },
    outputs: [],
    source: source.split("\n").map((line, index, lines) => `${line}${index + 1 < lines.length ? "\n" : ""}`)
  };
}

function trialMetrics(trial) {
  const memory = trial.journey.memory;
  const baseline = memory.samples[0].pssBytes;
  return {
    fileLoadMs: trial.load.elapsedMs,
    nativeLoadPeakRssBytes: trial.load.peakRssBytes,
    nativeLoadPeakRssIncreaseBytes: trial.load.peakRssIncreaseBytes,
    inlinePreviewMs: trial.journey.metrics.inlinePreviewMs,
    workbenchOpenMs: trial.journey.metrics.workbenchOpenMs,
    allProfilesMs: trial.journey.metrics.completeProfileMs,
    baselinePssBytes: baseline,
    peakPssBytes: memory.peakPssBytes,
    pssIncreaseBytes: Math.max(0, memory.peakPssBytes - baseline)
  };
}

function buildLargeTrialFailure(entry, error) {
  return {
    protocol: LARGE_TRIAL_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    repetition: entry.repetition,
    order: entry.order,
    load: null,
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
    (trial.error === null && (trial.load === null || trial.journey?.index !== 1)) ||
    (trial.error !== null && (typeof trial.error !== "string" || trial.error.length < 1 || trial.error.length > 500))
  ) {
    throw new TypeError(`Large comparison trial ${entry.id} is malformed.`);
  }
  if (trial.load !== null) validateLoadResult(trial.load, entry.engine);
  return trial;
}

function validateLoadResult(load, engine) {
  if (
    !load ||
    load.protocol !== "openwrangler-large-parquet-load-v1" ||
    load.engine !== engine ||
    load.rows !== LARGE_ROWS ||
    load.columns !== LARGE_COLUMNS ||
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
    fixture.schema.some(({ name }, index) => name !== expectedNames[index])
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

function readJson(path) {
  const bytes = readFileSync(path);
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_JSON_BYTES)
    throw new Error(`${basename(path)} is empty or too large.`);
  return JSON.parse(bytes.toString("utf8"));
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sanitizeError(error) {
  return String(error?.message ?? error)
    .replaceAll(/(?:[A-Za-z]:)?[\\/][^\s:]+/gu, "<path>")
    .replaceAll(/[\\/]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function parseArguments(arguments_) {
  const command = arguments_[0];
  if (!["run", "report"].includes(command)) throw new Error("Expected run or report.");
  const values = new Map();
  for (let index = 1; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === "--confirm-large-study") {
      if (values.has(flag)) throw new Error("Duplicate --confirm-large-study.");
      values.set(flag, true);
      continue;
    }
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || values.has(flag)) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}.`);
    }
    values.set(flag, value);
    index += 1;
  }
  if (command === "report") {
    return { command, study: required(values, "--study"), output: required(values, "--out") };
  }
  for (const flag of ["--candidate", "--python", "--editor", "--editor-cli", "--parquet", "--out"]) {
    if (!isAbsolute(required(values, flag))) throw new Error(`${flag} must be an absolute path.`);
  }
  const limit = values.has("--limit") ? Number(values.get("--limit")) : undefined;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)) {
    throw new Error("--limit must be between 1 and 20.");
  }
  return {
    command,
    candidate: values.get("--candidate"),
    python: values.get("--python"),
    editor: values.get("--editor"),
    editorCli: values.get("--editor-cli"),
    parquet: values.get("--parquet"),
    output: values.get("--out"),
    limit,
    confirmLargeStudy: values.get("--confirm-large-study") === true
  };
}

function required(values, flag) {
  const value = values.get(flag);
  if (!value) throw new Error(`Missing ${flag}.`);
  return value;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "run") {
    const status = await runLargeComparisonStudy(options);
    console.log(`${status.completed} of 20 fresh comparison sessions complete.`);
    return;
  }
  const manifest = readJson(join(resolve(options.study), "manifest.json"));
  const { trials } = loadLargeTrials(options.study, manifest);
  const report = buildLargeComparisonReport({ generatedAtUtc: new Date().toISOString(), manifest, trials });
  writeJsonAtomic(resolve(options.output), report);
  assertCompleteLargeReport(report);
  console.log(`Large comparison report written to ${options.output}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Large Data Wrangler comparison failed: ${sanitizeError(error)}`);
    process.exitCode = 1;
  });
}
