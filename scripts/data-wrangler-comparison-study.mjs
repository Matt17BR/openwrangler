import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  DATA_WRANGLER_COMPARISON_AUTHORITY,
  isRetryableComparisonSession,
  renderComparisonReleaseStatisticsMethod
} from "./data-wrangler-comparison-contract.mjs";
import {
  DATA_WRANGLER_STUDY_TOOL_NAMES,
  DATA_WRANGLER_STUDY_REPORT_MAX_BYTES,
  DATA_WRANGLER_REGRESSION_LIMITS,
  assertDataWranglerComparisonStudyReport,
  buildDataWranglerComparisonStudyReport,
  updateDataWranglerComparisonReview,
  validateDataWranglerComparisonStudyTrial
} from "./data-wrangler-comparison-report.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";

export const STUDY_PROTOCOL = DATA_WRANGLER_COMPARISON_AUTHORITY.protocols.study;
export const TRIAL_REQUEST_PROTOCOL = "openwrangler-comparison-trial-request-v2";
export const TRIAL_RESULT_PROTOCOL = "openwrangler-comparison-trial-result-v2";
export const DATA_WRANGLER_VERSION = "1.24.2";
export const WARM_REPETITIONS = DATA_WRANGLER_COMPARISON_AUTHORITY.release.samplesPerSession;
export const SMOKE_REPETITIONS = DATA_WRANGLER_COMPARISON_AUTHORITY.smoke.samplesPerSession;
export const LOCAL_REPETITIONS = DATA_WRANGLER_COMPARISON_AUTHORITY.local.samplesPerSession;
const LOCAL_FIXTURE_MAX_BYTES = 640 * 1024 * 1024;
const LOCAL_OUTPUT_MIN_FREE_BYTES = 2 * LOCAL_FIXTURE_MAX_BYTES + 512 * 1024 * 1024;
const LOCAL_FIXTURE_OWNER_PROTOCOL = "openwrangler-local-comparison-fixture-v1";
export const STUDY_TIMEOUTS_MS = Object.freeze({
  preAction: 75_000,
  inlinePreview: 30_000,
  workbenchOpen: 40_000,
  completeProfile: 110_000,
  editorPhase: 600_000,
  neutralDriver: 2_400_000
});
export const STUDY_CELLS = Object.freeze([
  Object.freeze({ id: "pandas-csv", engine: "pandas", format: "csv", rows: 100_000, columns: 50 }),
  Object.freeze({ id: "polars-csv", engine: "polars", format: "csv", rows: 100_000, columns: 50 }),
  Object.freeze({ id: "pandas-parquet", engine: "pandas", format: "parquet", rows: 1_000_000, columns: 20 }),
  Object.freeze({ id: "polars-parquet", engine: "polars", format: "parquet", rows: 1_000_000, columns: 20 })
]);
export const LOCAL_MIXED_CELLS = Object.freeze([
  Object.freeze({ id: "pandas-parquet-local", engine: "pandas", format: "parquet", rows: 1_000_000, columns: 100 }),
  Object.freeze({ id: "polars-parquet-local", engine: "polars", format: "parquet", rows: 1_000_000, columns: 100 })
]);
const PRODUCTS = Object.freeze(["open-wrangler", "data-wrangler"]);
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function validateComparisonCells(cells) {
  if (!sameCells(cells, STUDY_CELLS) && !sameCells(cells, LOCAL_MIXED_CELLS)) {
    throw new TypeError("Comparison cells must match the release study or capped local Parquet profile.");
  }
}

function sameCells(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sampleCountWord(value) {
  return new Map([
    [SMOKE_REPETITIONS, "two"],
    [LOCAL_REPETITIONS, "three"],
    [WARM_REPETITIONS, "ten"]
  ]).get(value);
}

export function createDataWranglerComparisonSchedule(cells = STUDY_CELLS) {
  validateComparisonCells(cells);
  const schedule = [];
  const productOrders = [PRODUCTS, [...PRODUCTS].reverse(), [...PRODUCTS].reverse(), PRODUCTS];
  for (const [cellIndex, cell] of cells.entries()) {
    for (const product of productOrders[cellIndex]) {
      schedule.push(
        Object.freeze({
          id: `warm.${cell.id}.${product}`,
          kind: "warm",
          cellId: cell.id,
          engine: cell.engine,
          format: cell.format,
          rows: cell.rows,
          columns: cell.columns,
          product,
          order: schedule.length
        })
      );
    }
  }
  return Object.freeze(schedule);
}

export function buildStudyManifest({
  createdAtUtc,
  candidate,
  editor,
  python,
  fixtures,
  machine,
  toolHashes,
  repetitionsPerSession = WARM_REPETITIONS,
  cells = STUDY_CELLS
}) {
  canonicalUtc(createdAtUtc);
  validateVersionedFile(candidate, "Open Wrangler candidate");
  validateVersionedFile(editor, "VS Code");
  validateVersionedFile(python, "Python");
  if (!HASH.test(editor.cliSha256 ?? "") || !HASH.test(editor.productSha256 ?? "")) {
    throw new TypeError("VS Code must include its CLI and product metadata hashes.");
  }
  if (
    editor.distribution !== "Visual Studio Code" ||
    python.implementation !== "cpython" ||
    !python.version.startsWith("3.12.")
  ) {
    throw new TypeError("The study requires official Visual Studio Code and CPython 3.12.");
  }
  validateMachine(machine);
  validateToolHashes(toolHashes);
  validateComparisonCells(cells);
  const localProfile = sameCells(cells, LOCAL_MIXED_CELLS);
  const validRepetitions = localProfile
    ? repetitionsPerSession === LOCAL_REPETITIONS
    : [SMOKE_REPETITIONS, WARM_REPETITIONS].includes(repetitionsPerSession);
  if (!validRepetitions) {
    throw new TypeError(
      localProfile
        ? "The local comparison requires exactly three samples."
        : "The release comparison requires two smoke or ten release samples."
    );
  }
  if (candidate.version === DATA_WRANGLER_VERSION) {
    throw new TypeError("The candidate version must be independent from the Data Wrangler baseline version.");
  }
  for (const cell of cells) {
    const fixture = fixtures[cell.format];
    if (
      !fixture ||
      fixture.rows !== cell.rows ||
      fixture.columns !== cell.columns ||
      fixture.valuesValidated !== true ||
      !HASH.test(fixture.sha256)
    ) {
      throw new TypeError(`${cell.format} fixture does not match the fixed study dimensions.`);
    }
  }
  const schedule = createDataWranglerComparisonSchedule(cells);
  const manifest = {
    protocol: STUDY_PROTOCOL,
    createdAtUtc,
    method: {
      cells: cells.map((cell) => ({ ...cell })),
      repetitionsPerSession,
      regressionLimits: structuredClone(DATA_WRANGLER_REGRESSION_LIMITS),
      timingBoundaries: {
        inlinePreview: "Run Cell click to stable public inline output and a usable launch action",
        workbenchOpen: "public launch-action click to a stable, unobstructed, scrollable workbench grid",
        firstProfile: "public profiling action to the first completed column summary",
        completeProfile: "public profiling action to final summaries for every column"
      },
      statistics: localProfile
        ? "three planned warm samples per product and engine; summaries require at least two successful samples; Hyndman-Fan type 7 min, max, median, and p95"
        : repetitionsPerSession === WARM_REPETITIONS
          ? renderComparisonReleaseStatisticsMethod()
          : `${sampleCountWord(repetitionsPerSession)} successful warm samples per product and workload; Hyndman-Fan type 7 min, max, median, and p95`,
      memory: "highest observed absolute process-tree PSS during each measured notebook workflow"
    },
    provenance: {
      openWrangler: { extensionId: "Matt17BR.openwrangler", version: candidate.version, sha256: candidate.sha256 },
      dataWrangler: {
        extensionId: "ms-toolsai.datawrangler",
        version: DATA_WRANGLER_VERSION,
        source: "Visual Studio Marketplace",
        implementationInspection: "none"
      },
      editor: structuredClone(editor),
      python: structuredClone(python),
      fixtures: structuredClone(fixtures),
      machine: structuredClone(machine),
      tools: structuredClone(toolHashes)
    },
    timeoutsMs: { ...STUDY_TIMEOUTS_MS },
    schedule
  };
  return Object.freeze(manifest);
}

export function terminalTrialIds(directory, manifest) {
  if (!existsSync(directory)) return new Set();
  const scheduled = new Map(manifest.schedule.map((entry) => [entry.id, entry]));
  const terminal = new Set();
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const result = readJson(join(directory, name));
    const entry = scheduled.get(result.trialId);
    if (!entry || name !== `${result.trialId}.json`) {
      throw new Error(`Unexpected trial result ${name}.`);
    }
    validateTrialResult(result, entry, manifest);
    if (terminal.has(result.trialId)) throw new Error(`Duplicate trial result ${result.trialId}.`);
    if (!isHarnessInterrupted(result)) terminal.add(result.trialId);
  }
  return terminal;
}

function isHarnessInterrupted(result) {
  return isRetryableComparisonSession(result.samples);
}

export async function runDataWranglerComparisonStudy(options, dependencies = {}) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const prepareTools = dependencies.prepareTools ?? buildComparisonTestExtension;
  const runTrial = dependencies.runTrial ?? runNeutralDriver;
  const makeTrial = dependencies.prepareTrial ?? prepareTrial;
  const output = resolve(options.output);
  const trialsDirectory = join(output, "trials");
  mkdirSync(trialsDirectory, { recursive: true, mode: 0o700 });
  removeStaleTrialDirectories(output);
  await prepareTools();
  const observed = await captureProvenance(options, dependencies);
  const repetitionsPerSession = options.repetitionsPerSession ?? WARM_REPETITIONS;
  const cells = options.cells ?? STUDY_CELLS;
  const manifestPath = join(output, "manifest.json");
  let manifest;
  if (existsSync(manifestPath)) {
    manifest = readJson(manifestPath);
    const expected = buildStudyManifest({
      ...observed,
      createdAtUtc: manifest.createdAtUtc,
      repetitionsPerSession,
      cells
    });
    if (digest(manifest) !== digest(expected)) {
      throw new Error("Study inputs changed since manifest creation. Start a new output directory.");
    }
  } else {
    manifest = buildStudyManifest({ ...observed, createdAtUtc: now(), repetitionsPerSession, cells });
    writeJsonAtomic(manifestPath, manifest);
  }

  const completed = terminalTrialIds(trialsDirectory, manifest);
  const eligibleSchedule =
    options.scheduleLimit === undefined ? manifest.schedule : manifest.schedule.slice(0, options.scheduleLimit);
  const remaining = eligibleSchedule.filter(({ id }) => !completed.has(id));
  const limit = options.limit === undefined ? remaining.length : options.limit;
  const selected = remaining.slice(0, limit);
  for (const entry of selected) {
    const currentMachine = (dependencies.inspectMachine ?? inspectMachineEnvironment)();
    if (digest(currentMachine) !== digest(manifest.provenance.machine)) {
      throw new Error("Machine or power provenance changed during the study.");
    }
    const trialRoot = mkdtempSync(join(output, `trial-${entry.order.toString().padStart(3, "0")}-`));
    let prepared;
    let result;
    let trialError;
    try {
      prepared = makeTrial({ entry, manifest, options, trialRoot });
      result = await runOneTrial({
        entry,
        request: prepared.request,
        runTrial,
        timeoutMs: STUDY_TIMEOUTS_MS.neutralDriver + 5_000
      });
    } catch (error) {
      trialError = error;
    } finally {
      try {
        prepared?.verifySources?.();
      } catch (error) {
        trialError = trialError
          ? new AggregateError([trialError, error], `${sanitizeError(trialError)}; ${sanitizeError(error)}`)
          : error;
      }
      rmSync(trialRoot, { force: true, recursive: true });
    }
    if (trialError) {
      result = failedResult(
        entry,
        trialError,
        "harness",
        trialProvenance(manifest),
        manifest.method.repetitionsPerSession
      );
    }
    const machineAfter = (dependencies.inspectMachine ?? inspectMachineEnvironment)();
    if (digest(machineAfter) !== digest(manifest.provenance.machine)) {
      result = failedResult(
        entry,
        new Error("Machine or power provenance changed during the trial."),
        "harness",
        trialProvenance(manifest),
        manifest.method.repetitionsPerSession
      );
    }
    validateTrialResult(result, entry, manifest);
    writeJsonAtomic(join(trialsDirectory, `${entry.id}.json`), result);
    if (!isHarnessInterrupted(result)) completed.add(entry.id);
  }
  const remainingCount = manifest.schedule.length - completed.size;
  if (remainingCount === 0) removePreparedExtensionDirectories(output);
  return Object.freeze({
    manifest,
    completed: completed.size,
    remaining: remainingCount
  });
}

export async function runLocalDataWranglerComparison(options, dependencies = {}) {
  if (options.confirmLocalComparison !== "yes") {
    throw new Error("Pass --confirm-local-comparison yes to run the four local comparison sessions.");
  }
  const output = resolve(options.output);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  removeStaleLocalFixtureDirectories(output, dependencies.isProcessAlive ?? isProcessAlive);
  (dependencies.requireLocalDiskSpace ?? requireLocalComparisonDiskSpace)(output);
  const fixtureRoot = mkdtempSync(join(output, `local-fixture-${process.pid}-`));
  writeJsonAtomic(join(fixtureRoot, "owner.json"), {
    protocol: LOCAL_FIXTURE_OWNER_PROTOCOL,
    pid: process.pid
  });
  const parquet = join(fixtureRoot, "mixed-1000000-100.parquet");
  const generateFixture = dependencies.generateLocalFixture ?? generateLocalMixedFixture;
  const runStudy = dependencies.runStudy ?? runDataWranglerComparisonStudy;
  const loadResults = dependencies.loadResults ?? loadStudyResults;
  try {
    await generateFixture(options.python, parquet);
    const result = await runStudy(
      {
        ...options,
        parquet,
        cells: LOCAL_MIXED_CELLS,
        repetitionsPerSession: LOCAL_REPETITIONS
      },
      dependencies
    );
    assertLocalComparisonUsable(result, output, loadResults);
    return result;
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

function assertLocalComparisonUsable(result, output, loadResults) {
  const expectedSessions = result.manifest.schedule.length;
  const expectedSamples = expectedSessions * LOCAL_REPETITIONS;
  const scheduledIds = new Set(result.manifest.schedule.map(({ id }) => id));
  const trials = loadResults(output).trials.filter(({ trialId }) => scheduledIds.has(trialId));
  const samples = trials.flatMap(({ samples: trialSamples }) => trialSamples);
  const outcomes = Object.fromEntries(
    ["success", "failure", "timeout"].map((status) => [
      status,
      samples.filter((sample) => sample.status === status).length
    ])
  );
  const successfulByTrial = trials.map(({ trialId, samples: trialSamples }) => ({
    trialId,
    successes: trialSamples.filter(({ status }) => status === "success").length
  }));
  const insufficientTrials = successfulByTrial.filter(({ successes }) => successes < 2);
  if (
    result.completed !== expectedSessions ||
    result.remaining !== 0 ||
    trials.length !== expectedSessions ||
    samples.length !== expectedSamples ||
    insufficientTrials.length > 0
  ) {
    throw new Error(
      "Local comparison failed: every product and engine needs at least two of three successful samples; found " +
        `${outcomes.success} success, ${outcomes.failure} failure, and ${outcomes.timeout} timeout. ` +
        `Insufficient sessions: ${insufficientTrials.map(({ trialId, successes }) => `${trialId} (${successes}/3)`).join(", ") || "none"}. ` +
        `Results were kept in ${output}.`
    );
  }
}

export function requireLocalComparisonDiskSpace(output, availableBytes = availableDiskBytes(output)) {
  if (!Number.isSafeInteger(availableBytes) || availableBytes < LOCAL_OUTPUT_MIN_FREE_BYTES) {
    throw new Error("The local comparison needs 1.75 GiB free for its capped fixture and private trial copy.");
  }
}

export function removeStaleLocalFixtureDirectories(output, processAlive = isProcessAlive) {
  for (const name of readdirSync(output)) {
    const match = /^local-fixture-(\d+)-[A-Za-z0-9]{6}$/u.exec(name);
    if (!match) continue;
    const path = join(output, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Refusing malformed local fixture path ${name}.`);
    }
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1 || processAlive(pid)) {
      throw new Error(`Local fixture ${name} may still belong to a running comparison.`);
    }
    const children = readdirSync(path);
    const ownerPath = join(path, "owner.json");
    if (existsSync(ownerPath)) {
      const owner = readJson(ownerPath);
      if (
        Object.keys(owner).sort().join(",") !== "pid,protocol" ||
        owner.protocol !== LOCAL_FIXTURE_OWNER_PROTOCOL ||
        owner.pid !== pid
      ) {
        throw new Error(`Refusing invalid ownership marker in stale local fixture ${name}.`);
      }
    } else if (children.some((child) => !/^owner\.json\.[A-Za-z0-9-]+\.tmp$/u.test(child))) {
      throw new Error(`Refusing unowned stale local fixture ${name}.`);
    }
    for (const child of children) {
      if (
        child !== "owner.json" &&
        child !== "mixed-1000000-100.parquet" &&
        !/^\.mixed-1000000-100\.parquet\.[A-Za-z0-9_-]+\.tmp$/u.test(child) &&
        !/^owner\.json\.[A-Za-z0-9-]+\.tmp$/u.test(child)
      ) {
        throw new Error(`Refusing unexpected entry ${child} in stale local fixture ${name}.`);
      }
      const childMetadata = lstatSync(join(path, child));
      if (childMetadata.isSymbolicLink() || !childMetadata.isFile() || childMetadata.nlink !== 1) {
        throw new Error(`Refusing malformed entry ${child} in stale local fixture ${name}.`);
      }
    }
    rmSync(path, { force: true, recursive: true });
  }
}

export async function runDataWranglerComparisonSmoke(options, dependencies = {}) {
  const output = resolve(options.output);
  try {
    const result = await runDataWranglerComparisonStudy(
      { ...options, output, limit: 2, scheduleLimit: 2, repetitionsPerSession: SMOKE_REPETITIONS },
      dependencies
    );
    const pair = result.manifest.schedule.slice(0, 2);
    if (
      pair.length !== 2 ||
      pair[0].cellId !== pair[1].cellId ||
      new Set(pair.map(({ product }) => product)).size !== 2
    ) {
      throw new Error("Comparison smoke did not select one complete product pair.");
    }
    const pairIds = new Set(pair.map(({ id }) => id));
    const failures = loadStudyResults(output).trials.flatMap((trial) =>
      pairIds.has(trial.trialId)
        ? trial.samples
            .filter(({ status }) => status !== "success")
            .map((sample) => ({ trialId: trial.trialId, ...sample }))
        : []
    );
    if (failures.length > 0) {
      throw new Error(
        `Comparison smoke failed: ${failures
          .map(
            ({ trialId, index, status, failure }) =>
              `${trialId} sample ${index} (${status}, ${failure?.stage ?? "unknown"})`
          )
          .join(", ")}.`
      );
    }
    return result;
  } finally {
    if (existsSync(output)) removePreparedExtensionDirectories(output);
  }
}

export function writeDataWranglerComparisonStudyReport(output, report) {
  assertDataWranglerComparisonStudyReport(report);
  const path = resolve(output);
  if (existsSync(path)) {
    const existing = readJson(path, DATA_WRANGLER_STUDY_REPORT_MAX_BYTES);
    assertDataWranglerComparisonStudyReport(existing);
    if (!isDeepStrictEqual(existing, report)) {
      throw new Error("Comparison report output already contains different evidence.");
    }
    return false;
  }
  writeJsonAtomic(path, report);
  return true;
}

export function removePreparedExtensionDirectories(output) {
  for (const product of PRODUCTS) {
    rmSync(join(resolve(output), `prepared-extensions-${product}`), { force: true, recursive: true });
  }
}

export function removeStaleTrialDirectories(output) {
  for (const name of readdirSync(output)) {
    if (!/^trial-\d{3}-[A-Za-z0-9]{6}$/u.test(name)) continue;
    const path = join(output, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Refusing malformed stale trial path ${name}.`);
    }
    rmSync(path, { force: true, recursive: true });
  }
}

export async function runOneTrial({ entry, request, runTrial, timeoutMs }) {
  let timer;
  try {
    const result = await Promise.race([
      runTrial(request),
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve(
              failedResult(
                entry,
                new Error("Trial deadline exceeded."),
                "timeout",
                trialProvenanceFromRequest(request),
                request.repetitions
              )
            ),
          timeoutMs
        );
      })
    ]);
    if (result?.trialId !== entry.id) throw new Error("Neutral driver returned the wrong trial ID.");
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function prepareTrial({ entry, manifest, options, trialRoot }) {
  mkdirSync(trialRoot, { recursive: true, mode: 0o700 });
  const sourceInput = entry.format === "csv" ? options.csv : options.parquet;
  const expectedSourceHash = manifest.provenance.fixtures[entry.format].sha256;
  if (sha256File(sourceInput) !== expectedSourceHash) {
    throw new Error(`${entry.format} fixture changed after the study manifest was recorded.`);
  }
  const source = join(trialRoot, basename(sourceInput));
  copyFileSync(sourceInput, source);
  if (sha256File(source) !== expectedSourceHash || sha256File(sourceInput) !== expectedSourceHash) {
    throw new Error(`${entry.format} fixture changed while its private trial copy was created.`);
  }
  chmodSync(source, 0o444);
  const notebookPath = join(trialRoot, `${entry.id}.ipynb`);
  writeFileSync(notebookPath, `${JSON.stringify(studyNotebook(entry, source), null, 2)}\n`, { mode: 0o600 });
  const request = {
    protocol: TRIAL_REQUEST_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    kind: entry.kind,
    order: entry.order,
    repetitions: manifest.method.repetitionsPerSession,
    cell: {
      id: entry.cellId,
      engine: entry.engine,
      format: entry.format,
      rows: entry.rows,
      columns: entry.columns,
      source,
      sourceSha256: expectedSourceHash,
      variableName: "study_frame"
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
    timeoutsMs: {
      preAction: STUDY_TIMEOUTS_MS.preAction,
      inlinePreview: STUDY_TIMEOUTS_MS.inlinePreview,
      workbenchOpen: STUDY_TIMEOUTS_MS.workbenchOpen,
      completeProfile: STUDY_TIMEOUTS_MS.completeProfile,
      editorPhase: STUDY_TIMEOUTS_MS.editorPhase
    },
    isolatedRoot: trialRoot
  };
  const verifySources = () => {
    if (sha256File(sourceInput) !== expectedSourceHash || sha256File(source) !== expectedSourceHash) {
      throw new Error(`${entry.format} fixture changed during the trial.`);
    }
  };
  return Object.freeze({ request: Object.freeze(request), verifySources });
}

export async function runNeutralDriver(
  request,
  { driver = resolve("scripts/data-wrangler-comparison-neutral-driver.mjs") } = {}
) {
  const requestPath = join(request.isolatedRoot, "request.json");
  const resultPath = join(request.isolatedRoot, "result.json");
  writeJsonAtomic(requestPath, request);
  await spawnCommand(process.execPath, [driver, "--request", requestPath, "--out", resultPath], {
    cwd: resolve(import.meta.dirname, ".."),
    timeoutMs: STUDY_TIMEOUTS_MS.neutralDriver
  });
  return readJson(resultPath);
}

export function validateTrialResult(result, entry, manifest) {
  return validateDataWranglerComparisonStudyTrial(result, entry, manifest);
}

export function loadStudyResults(output) {
  const manifest = readJson(join(resolve(output), "manifest.json"));
  const trialsDirectory = join(resolve(output), "trials");
  terminalTrialIds(trialsDirectory, manifest);
  const trials = readdirSync(trialsDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(join(trialsDirectory, name)));
  return { manifest, trials };
}

async function captureProvenance(options, dependencies) {
  const hashFile = dependencies.hashFile ?? sha256File;
  const inspectCandidate = dependencies.inspectCandidate ?? inspectCandidateVsix;
  const inspectEditor = dependencies.inspectEditor ?? inspectEditorEnvironment;
  const inspectPython = dependencies.inspectPython ?? inspectPythonEnvironment;
  const inspectMachine = dependencies.inspectMachine ?? inspectMachineEnvironment;
  const validateFixtures = dependencies.validateFixtures ?? validateFixtureInputs;
  const candidate = await inspectCandidate(options.candidate);
  const editor = await inspectEditor(options.editor, options.editorCli);
  const python = { ...(await inspectPython(options.python)), sha256: hashFile(options.python) };
  const cells = options.cells ?? STUDY_CELLS;
  const fixtureContract = await validateFixtures(options.python, options.csv, options.parquet, cells);
  const fixturePaths = { csv: options.csv, parquet: options.parquet };
  const fixtures = Object.fromEntries(
    [...new Set(cells.map(({ format }) => format))].map((format) => [
      format,
      { ...fixtureContract[format], sha256: hashFile(fixturePaths[format]) }
    ])
  );
  return {
    candidate,
    editor,
    python,
    fixtures,
    machine: inspectMachine(),
    toolHashes: Object.fromEntries(Object.entries(comparisonToolFiles()).map(([name, path]) => [name, hashFile(path)]))
  };
}

async function inspectCandidateVsix(path) {
  const snapshot = readBoundedVsixFileSnapshot(path);
  const archive = await inspectVsixArchive(snapshot.bytes);
  const packageJson = JSON.parse(archive.packagedPackageJson);
  if (
    packageJson?.publisher !== "Matt17BR" ||
    packageJson?.name !== "openwrangler" ||
    !VERSION.test(packageJson?.version ?? "")
  ) {
    throw new Error("The comparison candidate is not a versioned Matt17BR.openwrangler VSIX.");
  }
  return {
    version: packageJson.version,
    sha256: createHash("sha256").update(snapshot.bytes).digest("hex")
  };
}

async function inspectEditorEnvironment(editor, editorCli) {
  const productPath = join(dirname(editor), "resources", "app", "product.json");
  const product = JSON.parse(readFileSync(productPath, "utf8"));
  if (
    product?.nameLong !== "Visual Studio Code" ||
    product?.applicationName !== "code" ||
    product?.licenseName !== "Multiple, see https://code.visualstudio.com/license" ||
    !VERSION.test(product?.version ?? "") ||
    !/^[0-9a-f]{40}$/u.test(product?.commit ?? "")
  ) {
    throw new Error("The comparison requires an official Microsoft Visual Studio Code installation.");
  }
  const cli = await reportedEditorIdentity(editorCli);
  if (cli.version !== product.version || cli.commit !== product.commit || cli.architecture !== arch()) {
    throw new Error("The VS Code CLI does not match its product metadata and current architecture.");
  }
  return {
    version: product.version,
    sha256: sha256File(editor),
    cliSha256: sha256File(editorCli),
    productSha256: sha256File(productPath),
    distribution: "Visual Studio Code"
  };
}

async function reportedEditorIdentity(executable) {
  const { stdout } = await spawnCommand(executable, ["--version"], { timeoutMs: 30_000 });
  const lines = stdout.trim().split(/\r?\n/u);
  if (
    lines.length !== 3 ||
    !VERSION.test(lines[0] ?? "") ||
    !/^[0-9a-f]{40}$/u.test(lines[1] ?? "") ||
    !/^[A-Za-z0-9_-]{2,32}$/u.test(lines[2] ?? "")
  ) {
    throw new Error("VS Code CLI did not report its exact version, commit, and architecture.");
  }
  return { version: lines[0], commit: lines[1], architecture: lines[2] };
}

async function inspectPythonEnvironment(python) {
  const script = [
    "import importlib.metadata as m, json, platform, sys",
    "print(json.dumps({'version': platform.python_version(), 'implementation': sys.implementation.name, 'packages': {n: m.version(n) for n in ['pandas','polars','pyarrow','jupyter_core','ipykernel']}}))"
  ].join("; ");
  const { stdout } = await spawnCommand(python, ["-c", script], { timeoutMs: 30_000 });
  const value = JSON.parse(stdout);
  if (value.implementation !== "cpython" || !/^3\.12\.\d+$/u.test(value.version ?? "")) {
    throw new Error("The comparison requires CPython 3.12.");
  }
  return value;
}

async function validateFixtureInputs(python, csv, parquet, cells = STUDY_CELLS) {
  if (sameCells(cells, LOCAL_MIXED_CELLS)) {
    const script = resolve("python/benchmarks/local_mixed_parquet.py");
    const program = [
      "import json, sys",
      "from pathlib import Path",
      "sys.path.insert(0, sys.argv[1])",
      "from local_mixed_parquet import validate_local_mixed_parquet",
      "print(json.dumps({'parquet': validate_local_mixed_parquet(Path(sys.argv[2]))}))"
    ].join("; ");
    const { stdout } = await spawnCommand(python, ["-I", "-c", program, dirname(script), parquet], {
      timeoutMs: 180_000
    });
    return JSON.parse(stdout);
  }
  const benchmarkDirectory = resolve("python/benchmarks");
  const program = [
    "import json, sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from fixture_contract import FixtureSpec, assert_fixture_contract",
    "items = [('csv', Path(sys.argv[2]), 100000, 50), ('parquet', Path(sys.argv[3]), 1000000, 20)]",
    "[assert_fixture_contract(path, FixtureSpec(kind, rows, columns)) for kind, path, rows, columns in items]",
    "print(json.dumps({kind: {'rows': rows, 'columns': columns, 'valuesValidated': True} for kind, _, rows, columns in items}))"
  ].join("; ");
  const { stdout } = await spawnCommand(python, ["-I", "-c", program, benchmarkDirectory, csv, parquet], {
    timeoutMs: 180_000
  });
  const value = JSON.parse(stdout);
  if (
    value?.csv?.rows !== 100_000 ||
    value.csv.columns !== 50 ||
    value.csv.valuesValidated !== true ||
    value?.parquet?.rows !== 1_000_000 ||
    value.parquet.columns !== 20 ||
    value.parquet.valuesValidated !== true
  ) {
    throw new Error("The comparison fixtures did not satisfy the deterministic fixture contract.");
  }
  return value;
}

async function generateLocalMixedFixture(python, output) {
  const script = resolve("python/benchmarks/local_mixed_parquet.py");
  await spawnCommand(python, ["-I", script, "--out", output], {
    cwd: resolve(import.meta.dirname, ".."),
    timeoutMs: 900_000
  });
}

function availableDiskBytes(path) {
  const statistics = statfsSync(path, { bigint: true });
  const bytes = statistics.bavail * statistics.bsize;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function inspectMachineEnvironment() {
  const cpuList = cpus();
  if (cpuList.length === 0 || totalmem() <= 0) throw new Error("Machine provenance is unavailable.");
  return {
    os: platform(),
    osRelease: release(),
    architecture: arch(),
    cpuModel: cpuList[0].model.trim(),
    logicalCpuCount: cpuList.length,
    totalMemoryBytes: totalmem(),
    powerSource: linuxPowerSource(),
    cpuGovernor: readOptionalSystemText("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor") ?? "unknown"
  };
}

function linuxPowerSource() {
  if (platform() !== "linux") return "unknown";
  const root = "/sys/class/power_supply";
  try {
    const online = readdirSync(root).some((name) => {
      const type = readOptionalSystemText(join(root, name, "type"));
      return ["Mains", "USB", "USB_C"].includes(type) && readOptionalSystemText(join(root, name, "online")) === "1";
    });
    return online ? "ac" : "battery";
  } catch {
    return "unknown";
  }
}

function readOptionalSystemText(path) {
  try {
    return readFileSync(path, "utf8").trim().slice(0, 256);
  } catch {
    return undefined;
  }
}

function comparisonToolFiles() {
  return {
    contract: resolve("scripts/data-wrangler-comparison-contract.mjs"),
    method: resolve("docs/performance-comparison.md"),
    study: resolve("scripts/data-wrangler-comparison-study.mjs"),
    driver: resolve("scripts/data-wrangler-comparison-neutral-driver.mjs"),
    installer: resolve("scripts/data-wrangler-comparison-install.mjs"),
    report: resolve("scripts/data-wrangler-comparison-report.mjs"),
    pssSampler: resolve("scripts/linux-pss-sampler.mjs"),
    editorAcceptance: resolve("scripts/editor-acceptance.mjs"),
    editorEvidence: resolve("scripts/editor-acceptance-evidence.mjs"),
    editorOrchestration: resolve("scripts/packaged-editor-orchestration.mjs"),
    publicMediaContract: resolve("scripts/public-media-contract.mjs"),
    fixtureContract: resolve("python/benchmarks/fixture_contract.py"),
    vsixArchive: resolve("scripts/vsix-archive.mjs"),
    vsixContents: resolve("scripts/vsix-contents.mjs"),
    strictJson: resolve("scripts/strict-json.mjs"),
    dependencyLock: resolve("package-lock.json"),
    host: resolve("dist-test/test/extensionHost/dataWranglerComparisonNotebookTrial.js"),
    hostSupport: resolve("dist-test/test/extensionHost/dataWranglerComparison.js"),
    rendererSupport: resolve("dist-test/test/extensionHost/notebookRendererFrame.js"),
    hostGridReadiness: resolve("dist-test/test/extensionHost/comparisonGridReadiness.js"),
    hostFragmentPublication: resolve("dist-test/test/extensionHost/fragmentPublication.js"),
    hostProgress: resolve("dist-test/test/extensionHost/progress.js"),
    hostIdentifiedTemporary: resolve("dist-test/test/extensionHost/identifiedTemporary.js"),
    sharedStrictJson: resolve("dist-test/shared/strictJson.cjs"),
    sharedFixtureManifest: resolve("dist-test/shared/installedPerformanceFixtureManifest.cjs")
  };
}

async function buildComparisonTestExtension() {
  await spawnCommand("npm", ["run", "build:test-extension"], {
    cwd: resolve(import.meta.dirname, ".."),
    timeoutMs: 180_000
  });
}

function studyNotebook(entry, source) {
  const reader =
    entry.engine === "pandas"
      ? entry.format === "csv"
        ? `pd.read_csv(${JSON.stringify(source)})`
        : `pd.read_parquet(${JSON.stringify(source)})`
      : entry.format === "csv"
        ? `pl.read_csv(${JSON.stringify(source)})`
        : `pl.read_parquet(${JSON.stringify(source)})`;
  const importLine = entry.engine === "pandas" ? "import pandas as pd" : "import polars as pl";
  const bootstrap =
    entry.engine === "pandas" ? 'pd.DataFrame({"c00": [0], "c01": [1]})' : 'pl.DataFrame({"c00": [0], "c01": [1]})';
  const setup = `${importLine}\naaa_comparison_bootstrap = ${bootstrap}\nstudy_frame = ${reader}`;
  const measured = "study_frame";
  const cells = [codeCell(setup, [`ow-comparison-setup:${entry.cellId}`])];
  cells.push(codeCell(measured, [`ow-comparison-cell:${entry.cellId}`]));
  return {
    cells,
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

function codeCell(source, tags = []) {
  return {
    cell_type: "code",
    execution_count: null,
    metadata: { tags },
    outputs: [],
    source: source.split("\n").map((line, index, lines) => `${line}${index + 1 < lines.length ? "\n" : ""}`)
  };
}

function failedResult(entry, error, status, provenance, repetitions) {
  const failureStatus = status === "timeout" ? "timeout" : "failure";
  const failure = {
    stage: "harness",
    kind: status === "timeout" ? "timeout" : "harness",
    message: sanitizeError(error)
  };
  return {
    protocol: TRIAL_RESULT_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    format: entry.format,
    kind: entry.kind,
    order: entry.order,
    samples: Array.from({ length: repetitions }, (_unused, index) => ({
      index: index + 1,
      status: failureStatus,
      failure,
      metrics: { inlinePreviewMs: null, workbenchOpenMs: null, firstProfileMs: null, completeProfileMs: null },
      milestones: [],
      publicUi: { runCell: null, inline: null, workbench: null, profiling: null },
      memory: null
    })),
    provenance
  };
}

function trialProvenance(manifest) {
  return {
    candidate: {
      version: manifest.provenance.openWrangler.version,
      sha256: manifest.provenance.openWrangler.sha256
    },
    dataWranglerVersion: DATA_WRANGLER_VERSION,
    editor: { version: manifest.provenance.editor.version, sha256: manifest.provenance.editor.sha256 },
    python: { version: manifest.provenance.python.version, sha256: manifest.provenance.python.sha256 }
  };
}

function trialProvenanceFromRequest(request) {
  return {
    candidate: { version: request.candidate.version, sha256: request.candidate.sha256 },
    dataWranglerVersion: request.dataWranglerVersion,
    editor: { version: request.editor.version, sha256: request.editor.sha256 },
    python: { version: request.python.version, sha256: request.python.sha256 }
  };
}

async function spawnCommand(command, arguments_, { cwd, timeoutMs }) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const output = { stdout: "", stderr: "" };
    let settled = false;
    let failure;
    let killTimer;
    const terminate = (error) => {
      if (failure) return;
      failure = error;
      killChild(child, "SIGTERM");
      killTimer = setTimeout(() => killChild(child, "SIGKILL"), 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      terminate(new Error(`Command timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    for (const [stream, key] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"]
    ]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output[key] += chunk;
        if (Buffer.byteLength(output[key], "utf8") > 64 * 1024) {
          terminate(new Error("Command output exceeded 64 KiB."));
        }
      });
    }
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(failure ?? error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code === 0) resolvePromise(output);
      else reject(new Error(`Command failed (${code ?? signal}): ${output.stderr.trim()}`));
    });
  });
}

function killChild(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function validateVersionedFile(value, label) {
  if (!value || !VERSION.test(value.version ?? "") || !HASH.test(value.sha256 ?? "")) {
    throw new TypeError(`${label} must have an exact version and SHA-256.`);
  }
}

function validateMachine(value) {
  if (
    !value ||
    typeof value.os !== "string" ||
    typeof value.osRelease !== "string" ||
    typeof value.architecture !== "string" ||
    typeof value.cpuModel !== "string" ||
    value.cpuModel.length === 0 ||
    !Number.isSafeInteger(value.logicalCpuCount) ||
    value.logicalCpuCount < 1 ||
    !Number.isSafeInteger(value.totalMemoryBytes) ||
    value.totalMemoryBytes < 1 ||
    !["ac", "battery", "unknown"].includes(value.powerSource) ||
    typeof value.cpuGovernor !== "string"
  ) {
    throw new TypeError("Study machine provenance is incomplete.");
  }
}

function validateToolHashes(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const expected = [...DATA_WRANGLER_STUDY_TOOL_NAMES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("Study tool provenance is incomplete.");
  }
  for (const name of DATA_WRANGLER_STUDY_TOOL_NAMES) {
    if (!HASH.test(value[name])) throw new TypeError(`Study tool ${name} must have a SHA-256.`);
  }
}

function canonicalUtc(value) {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new TypeError("Study timestamp must be canonical UTC.");
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readJson(path, maxBytes = MAX_JSON_BYTES) {
  const source = readFileSync(path);
  if (source.byteLength <= 0 || source.byteLength > maxBytes) {
    throw new Error(`${basename(path)} is empty or too large.`);
  }
  return JSON.parse(source.toString("utf8"));
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

function writeTextAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { flag: "wx", mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sanitizeError(error) {
  return String(error?.message ?? error)
    .replaceAll(/\bfile:(?:\/+|\\+)[^\s:]+/giu, "<path>")
    .replaceAll(/(?:[A-Za-z]:)?[\\/][^\s:]+/gu, "<path>")
    .replaceAll(/(^|[^\p{L}\p{N}])\.{1,3}(?=$|[^\p{L}\p{N}])/gu, "$1")
    .replaceAll(/(^|[^\p{L}\p{N}])~[^\s]*/gu, "$1<path>")
    .replaceAll(/(^|[^\p{L}\p{N}])[A-Za-z]:[^\s]*/gu, "$1<path>")
    .replaceAll(/(?:%[0-9A-Fa-f]{2})+[^\s]*/gu, "<encoded-path>")
    .replaceAll(/(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}\s]+\}|%[^%\s]+%)/gu, "<environment>")
    .replaceAll(/[\\/]/gu, "")
    .replaceAll(/[^\p{L}\p{N}\s,;()[\]{}'"+=-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function parseArguments(arguments_) {
  const command = arguments_[0];
  if (!["run", "smoke", "local", "report"].includes(command)) {
    throw new Error("Expected run, smoke, local, or report.");
  }
  const values = new Map();
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || values.has(flag)) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}.`);
    }
    values.set(flag, value);
  }
  if (command === "report") {
    return {
      command,
      study: required(values, "--study"),
      output: required(values, "--out"),
      review: values.get("--review")
    };
  }
  const paths = ["--candidate", "--python", "--editor", "--editor-cli"];
  if (command !== "local") paths.push("--csv", "--parquet");
  for (const flag of paths) {
    const value = required(values, flag);
    if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path.`);
  }
  const limit = values.has("--limit") ? Number(values.get("--limit")) : undefined;
  if (command === "smoke" && limit !== undefined) throw new Error("Smoke always runs exactly one complete pair.");
  if (command === "local" && limit !== undefined) throw new Error("Local comparison always runs all four sessions.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 8)) {
    throw new Error("--limit must be between 1 and 8.");
  }
  return {
    command,
    candidate: values.get("--candidate"),
    python: values.get("--python"),
    editor: values.get("--editor"),
    editorCli: values.get("--editor-cli"),
    csv: values.get("--csv"),
    parquet: values.get("--parquet"),
    output: required(values, "--out"),
    confirmLocalComparison: values.get("--confirm-local-comparison"),
    limit
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
    const status = await runDataWranglerComparisonStudy(options);
    console.log(`${status.completed} of ${status.manifest.schedule.length} study sessions complete.`);
    return;
  }
  if (options.command === "smoke") {
    const status = await runDataWranglerComparisonSmoke(options);
    console.log(`${status.completed} paired smoke sessions complete.`);
    return;
  }
  if (options.command === "local") {
    const status = await runLocalDataWranglerComparison(options);
    console.log(`${status.completed} of ${status.manifest.schedule.length} local comparison sessions complete.`);
    return;
  }
  const { manifest, trials } = loadStudyResults(options.study);
  const reportPath = resolve(options.output);
  const generatedAtUtc = existsSync(reportPath)
    ? readJson(reportPath, DATA_WRANGLER_STUDY_REPORT_MAX_BYTES).generatedAtUtc
    : new Date().toISOString();
  const report = buildDataWranglerComparisonStudyReport({ generatedAtUtc, manifest, trials });
  let review;
  if (options.review !== undefined) {
    const reportPath = resolve(options.output);
    const reviewPath = resolve(options.review);
    if (
      basename(reportPath) !== "report.json" ||
      basename(reviewPath) !== "review.md" ||
      dirname(reportPath) !== dirname(reviewPath)
    ) {
      throw new Error("--review must be review.md beside the report.json output.");
    }
    review = updateDataWranglerComparisonReview(readFileSync(reviewPath, "utf8"), report);
  }
  writeDataWranglerComparisonStudyReport(options.output, report);
  if (review !== undefined) writeTextAtomic(resolve(options.review), review);
  console.log(`Comparison report written to ${options.output}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Data Wrangler comparison failed: ${sanitizeError(error)}`);
    process.exitCode = 1;
  });
}
