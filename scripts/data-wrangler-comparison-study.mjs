import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DATA_WRANGLER_STUDY_TOOL_NAMES,
  DATA_WRANGLER_REGRESSION_LIMITS,
  assertReleaseCompleteStudyReport,
  buildDataWranglerComparisonStudyReport,
  validateDataWranglerComparisonStudyTrial,
  validateLargeDataWranglerComparisonTrial
} from "./data-wrangler-comparison-report.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";

export const STUDY_PROTOCOL = "openwrangler-data-wrangler-study-v2";
export const TRIAL_REQUEST_PROTOCOL = "openwrangler-comparison-trial-request-v2";
export const TRIAL_RESULT_PROTOCOL = "openwrangler-comparison-trial-result-v2";
export const DATA_WRANGLER_VERSION = "1.24.2";
export const WARM_REPETITIONS = 10;
export const SMOKE_REPETITIONS = 2;
export const LARGE_FIXTURE_PROTOCOL = "openwrangler-large-parquet-fixture-v1";
export const LARGE_ROWS = 10_000_000;
export const LARGE_COLUMNS = 100;
export const LARGE_REPETITIONS = 5;
export const LARGE_MIN_SUCCESSFUL_REPETITIONS = 4;
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
const PRODUCTS = Object.freeze(["open-wrangler", "data-wrangler"]);
const ENGINES = Object.freeze(["pandas", "polars"]);
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const LARGE_EDITOR_STARTUP_CLEANUP_MS = 120_000;
const LARGE_STAGE_TIMEOUTS_MS = Object.freeze({
  preAction: 120_000,
  inlinePreview: 120_000,
  workbenchOpen: 180_000,
  completeProfile: 600_000
});

export function largeComparisonEditorPhaseTimeout(timeouts = LARGE_STAGE_TIMEOUTS_MS) {
  return (
    timeouts.preAction * 2 +
    timeouts.inlinePreview +
    timeouts.workbenchOpen +
    timeouts.completeProfile +
    LARGE_EDITOR_STARTUP_CLEANUP_MS
  );
}

export const LARGE_TIMEOUTS_MS = Object.freeze({
  ...LARGE_STAGE_TIMEOUTS_MS,
  editorPhase: largeComparisonEditorPhaseTimeout(),
  neutralDriver: 2_400_000,
  nativeLoad: 900_000
});

export function createDataWranglerComparisonSchedule() {
  const schedule = [];
  const productOrders = [PRODUCTS, [...PRODUCTS].reverse(), [...PRODUCTS].reverse(), PRODUCTS];
  for (const [cellIndex, cell] of STUDY_CELLS.entries()) {
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
  repetitionsPerSession = WARM_REPETITIONS
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
  if (![SMOKE_REPETITIONS, WARM_REPETITIONS].includes(repetitionsPerSession)) {
    throw new TypeError("A comparison session requires either two smoke samples or ten release samples.");
  }
  if (candidate.version === DATA_WRANGLER_VERSION) {
    throw new TypeError("The candidate version must be independent from the Data Wrangler baseline version.");
  }
  for (const cell of STUDY_CELLS) {
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
  const schedule = createDataWranglerComparisonSchedule();
  const manifest = {
    protocol: STUDY_PROTOCOL,
    createdAtUtc,
    method: {
      cells: STUDY_CELLS.map((cell) => ({ ...cell })),
      repetitionsPerSession,
      regressionLimits: structuredClone(DATA_WRANGLER_REGRESSION_LIMITS),
      timingBoundaries: {
        inlinePreview: "Run Cell click to stable public inline output and a usable launch action",
        workbenchOpen: "public launch-action click to a stable, unobstructed, scrollable workbench grid",
        firstProfile: "public profiling action to the first completed column summary",
        completeProfile: "public profiling action to final summaries for every column"
      },
      statistics: `${repetitionsPerSession === WARM_REPETITIONS ? "ten" : "two"} successful warm samples per product and workload; Hyndman-Fan type 7 min, max, median, and p95`,
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
  const unsuccessful = result.samples.filter(({ status }) => status !== "success");
  return unsuccessful.length > 0 && unsuccessful.every(({ failure }) => failure?.kind === "harness");
}

export async function prepareComparisonStudyRun({ output, now, prepareTools, captureProvenance, buildManifest }) {
  const root = resolve(output);
  const trialsDirectory = join(root, "trials");
  mkdirSync(trialsDirectory, { recursive: true, mode: 0o700 });
  removeStaleTrialDirectories(root);
  await prepareTools();
  const observed = await captureProvenance();
  const manifestPath = join(root, "manifest.json");
  let manifest;
  if (existsSync(manifestPath)) {
    manifest = readJson(manifestPath);
    const expected = buildManifest({
      observed,
      createdAtUtc: manifest.createdAtUtc,
      existingManifest: manifest
    });
    if (digest(manifest) !== digest(expected)) {
      throw new Error("Study inputs changed since manifest creation. Start a new output directory.");
    }
  } else {
    manifest = buildManifest({ observed, createdAtUtc: now(), existingManifest: undefined });
    writeJsonAtomic(manifestPath, manifest);
  }
  return Object.freeze({ output: root, trialsDirectory, manifest });
}

async function runComparisonStudy(options, dependencies, large) {
  const repetitions = large ? 1 : (options.repetitionsPerSession ?? WARM_REPETITIONS);
  const preparedStudy = await prepareComparisonStudyRun({
    output: options.output,
    now: dependencies.now ?? (() => new Date().toISOString()),
    prepareTools: dependencies.prepareTools ?? buildComparisonTestExtension,
    captureProvenance: () =>
      large
        ? (dependencies.captureProvenance ?? captureLargeProvenance)(options)
        : captureProvenance(options, dependencies),
    buildManifest: ({ observed, createdAtUtc }) =>
      large
        ? buildLargeStudyManifest({ ...observed, createdAtUtc })
        : buildStudyManifest({ ...observed, createdAtUtc, repetitionsPerSession: repetitions })
  });
  const { output, trialsDirectory, manifest } = preparedStudy;
  const largeResults = large ? loadLargeTrials(output, manifest) : undefined;
  const completed = large
    ? new Set(largeResults.trials.map(({ trialId }) => trialId))
    : terminalTrialIds(trialsDirectory, manifest);
  const schedule = options.scheduleLimit ? manifest.schedule.slice(0, options.scheduleLimit) : manifest.schedule;
  const inspectMachine = dependencies.inspectMachine ?? inspectMachineEnvironment;
  const checkEnvironment = async () => {
    if (large) {
      const inspect =
        dependencies.inspectRunEnvironment ?? (() => inspectLargeRunEnvironment(options.python, options.parquet));
      assertLargeRunEnvironment(await inspect(), manifest.provenance.machine);
    } else if (digest(inspectMachine()) !== digest(manifest.provenance.machine)) {
      throw new Error("Machine or power provenance changed during the study.");
    }
  };
  const pending = schedule.filter(({ id }) => !completed.has(id)).slice(0, options.limit ?? schedule.length);
  for (const entry of pending) {
    await checkEnvironment();
    const trialRoot = mkdtempSync(join(output, `trial-${entry.order.toString().padStart(3, "0")}-`));
    let trial;
    let result;
    let trialError;
    try {
      trial = (dependencies.prepareTrial ?? (large ? prepareLargeTrial : prepareTrial))({
        entry,
        manifest,
        options,
        trialRoot
      });
      if (large && entry.measureNativeLoad && !largeResults.loads.some(({ trialId }) => trialId === entry.id)) {
        const load = await (dependencies.runLoad ?? measureLargeNativeLoad)(trial.request);
        validateLargeLoadResult(load, entry);
        writeJsonAtomic(join(output, "loads", `${entry.id}.json`), load);
      }
      result = large
        ? await (dependencies.runJourney ?? runNeutralDriver)(trial.request)
        : await runOneTrial({
            entry,
            request: trial.request,
            runTrial: dependencies.runTrial ?? runNeutralDriver,
            timeoutMs: STUDY_TIMEOUTS_MS.neutralDriver + 5_000
          });
    } catch (error) {
      trialError = error;
    } finally {
      try {
        (trial?.verifySource ?? trial?.verifySources)?.();
      } catch (error) {
        trialError = trialError
          ? new AggregateError([trialError, error], `${sanitizeError(trialError)}; ${sanitizeError(error)}`)
          : error;
      }
      rmSync(trialRoot, { force: true, recursive: true });
    }
    if (!large) {
      try {
        await checkEnvironment();
      } catch (error) {
        trialError = trialError
          ? new AggregateError([trialError, error], `${sanitizeError(trialError)}; ${sanitizeError(error)}`)
          : error;
      }
    }
    if (trialError) {
      result = buildComparisonFailureResult(
        entry,
        trialError,
        "harness",
        comparisonTrialProvenance(manifest),
        repetitions
      );
    }
    if (large) validateLargeDataWranglerComparisonTrial(result, entry, manifest);
    else validateTrialResult(result, entry, manifest);
    writeJsonAtomic(join(trialsDirectory, `${entry.id}.json`), result);
    if (large || !isHarnessInterrupted(result)) completed.add(entry.id);
  }
  const remaining = manifest.schedule.length - completed.size;
  if (remaining === 0) removePreparedExtensionDirectories(output);
  return Object.freeze({ manifest, completed: completed.size, remaining });
}

export const runDataWranglerComparisonStudy = (options, dependencies = {}) =>
  runComparisonStudy(options, dependencies, false);

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
  const path = resolve(output);
  if (existsSync(path)) {
    throw new Error("Comparison report requires a new output path.");
  }
  writeJsonAtomic(path, report);
  assertReleaseCompleteStudyReport(report);
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
              buildComparisonFailureResult(
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
  writeFileSync(notebookPath, `${JSON.stringify(buildComparisonNotebook(entry, source), null, 2)}\n`, { mode: 0o600 });
  const request = buildComparisonTrialRequest({
    entry,
    manifest,
    options,
    trialRoot,
    source,
    sourceSha256: expectedSourceHash,
    repetitions: manifest.method.repetitionsPerSession,
    profileContract: "integer-sentinel",
    notebookPath,
    timeoutsMs: STUDY_TIMEOUTS_MS
  });
  const verifySources = () => {
    if (sha256File(sourceInput) !== expectedSourceHash || sha256File(source) !== expectedSourceHash) {
      throw new Error(`${entry.format} fixture changed during the trial.`);
    }
  };
  return Object.freeze({ request, verifySources });
}

export function buildComparisonTrialRequest({
  entry,
  manifest,
  options,
  trialRoot,
  source,
  sourceSha256,
  sourceIdentity,
  repetitions,
  profileContract,
  notebookPath,
  timeoutsMs
}) {
  return Object.freeze({
    protocol: TRIAL_REQUEST_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    kind: entry.kind,
    order: entry.order,
    repetitions,
    cell: {
      id: entry.cellId,
      engine: entry.engine,
      format: entry.format,
      rows: entry.rows,
      columns: entry.columns,
      columnNames:
        profileContract === "mixed-sentinels-v1"
          ? manifest.provenance.fixture.schema.map(({ name }) => name)
          : Array.from({ length: entry.columns }, (_unused, index) => `c${String(index).padStart(2, "0")}`),
      source,
      sourceSha256,
      ...(sourceIdentity ? { sourceIdentity } : {}),
      variableName: "study_frame",
      profileContract
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
      preAction: timeoutsMs.preAction,
      inlinePreview: timeoutsMs.inlinePreview,
      workbenchOpen: timeoutsMs.workbenchOpen,
      completeProfile: timeoutsMs.completeProfile,
      editorPhase: timeoutsMs.editorPhase
    },
    isolatedRoot: trialRoot
  });
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

export function createLargeComparisonSchedule() {
  const schedule = [];
  for (let repetition = 1; repetition <= LARGE_REPETITIONS; repetition += 1) {
    const engines = repetition % 2 ? ENGINES : [...ENGINES].reverse();
    for (const engine of engines) {
      const products = (repetition + ENGINES.indexOf(engine)) % 2 ? PRODUCTS : [...PRODUCTS].reverse();
      for (const [productIndex, product] of products.entries()) {
        schedule.push({
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
        });
      }
    }
  }
  return Object.freeze(schedule);
}

export function buildLargeStudyManifest({ createdAtUtc, candidate, editor, python, fixture, machine, tools }) {
  canonicalUtc(createdAtUtc);
  validateLargeFixtureManifest(fixture);
  if (machine?.os !== "linux") throw new TypeError("The large comparison currently requires Linux.");
  return Object.freeze({
    createdAtUtc,
    method: {
      repetitions: LARGE_REPETITIONS,
      nativeLoadsPerEngine: LARGE_REPETITIONS,
      minimumComplete: LARGE_MIN_SUCCESSFUL_REPETITIONS,
      retries: 0,
      metrics: ["inlinePreview", "workbenchOpen", "runCellToWorkbench", "allProfiles", "processTreePss"]
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
  const { manifest: _manifest, ...status } = await runComparisonStudy(options, dependencies, true);
  return status;
}

function prepareLargeTrial({ entry, manifest, options, trialRoot }) {
  mkdirSync(trialRoot, { recursive: true, mode: 0o700 });
  const source = join(trialRoot, basename(options.parquet));
  try {
    linkSync(options.parquet, source);
  } catch (error) {
    if (error?.code === "EXDEV") throw new Error("Put the fixture and benchmark output on the same filesystem.");
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
    timeoutsMs: LARGE_TIMEOUTS_MS
  });
  return {
    request,
    verifySource() {
      if (digest(regularFileIdentity(source)) !== digest(sourceIdentity)) {
        throw new Error("The large fixture changed during the trial.");
      }
    }
  };
}

async function measureLargeNativeLoad(request) {
  const program = [
    "import json, resource, sys, time",
    "engine, source = sys.argv[1:3]",
    "expected = tuple(map(int, sys.argv[3:5]))",
    "library = __import__(engine)",
    "rss = lambda: int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024",
    "started = time.perf_counter_ns(); frame = library.read_parquet(source)",
    "elapsed = round((time.perf_counter_ns() - started) / 1_000_000, 3); shape = tuple(frame.shape)",
    "assert shape == expected, (shape, expected)",
    "print(json.dumps({'protocol':'openwrangler-large-parquet-load-v1','engine':engine,'elapsedMs':elapsed,'rows':shape[0],'columns':shape[1],'peakRssBytes':rss()}))"
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
    { cwd: resolve(import.meta.dirname, ".."), timeoutMs: LARGE_TIMEOUTS_MS.nativeLoad }
  );
  return { trialId: request.trialId, ...JSON.parse(stdout) };
}

export function loadLargeTrials(output, manifest) {
  const schedule = new Map(manifest.schedule.map((entry) => [entry.id, entry]));
  const load = (name) => {
    const directory = join(resolve(output), name);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => {
        const result = readJson(join(directory, file));
        const entry = schedule.get(result?.trialId);
        if (!entry || file !== `${entry.id}.json`) throw new Error(`Unexpected large comparison result ${file}.`);
        if (name === "trials") validateLargeDataWranglerComparisonTrial(result, entry, manifest);
        else validateLargeLoadResult(result, entry);
        return result;
      });
  };
  return { manifest, trials: load("trials"), loads: load("loads") };
}

export function buildLargeComparisonReport({ generatedAtUtc, manifest, trials, loads }) {
  canonicalUtc(generatedAtUtc);
  const schedule = new Map(manifest.schedule.map((entry) => [entry.id, entry]));
  const validateUnique = (items, label, validate) => {
    const seen = new Set();
    for (const item of items) {
      const entry = schedule.get(item?.trialId);
      if (!entry || seen.has(item.trialId)) throw new TypeError(`Large comparison ${label} is unknown or duplicated.`);
      validate(item, entry);
      seen.add(item.trialId);
    }
  };
  validateUnique(trials, "trial", (trial, entry) => validateLargeDataWranglerComparisonTrial(trial, entry, manifest));
  validateUnique(loads, "native load", validateLargeLoadResult);
  const observed = new Map(trials.map((trial) => [trial.trialId, trial]));
  const observedLoads = new Map(loads.map((load) => [load.trialId, load]));
  const summarize = (items, selectors) => {
    const successful = items.filter((item) => item.status === undefined || item.status === "success");
    return {
      planned: LARGE_REPETITIONS,
      completed: items.length,
      successful: successful.length,
      metrics: Object.fromEntries(
        Object.entries(selectors).map(([name, select]) => [name, summarizeLargeValues(successful.map(select))])
      )
    };
  };
  const uiMetrics = {
    inlinePreviewMs: (sample) => sample.metrics?.inlinePreviewMs,
    workbenchOpenMs: (sample) => sample.metrics?.workbenchOpenMs,
    runCellToWorkbenchMs,
    allProfilesMs: (sample) => sample.metrics?.completeProfileMs,
    peakPssBytes: (sample) => sample.memory?.peakPssBytes
  };
  const summaries = ENGINES.flatMap((engine) =>
    PRODUCTS.map((product) => ({
      engine,
      product,
      ...summarize(
        trials.filter((trial) => trial.engine === engine && trial.product === product).map((trial) => trial.samples[0]),
        uiMetrics
      )
    }))
  );
  const loadSummaries = ENGINES.map((engine) => {
    const attempts = manifest.schedule.filter(({ id, engine: value, measureNativeLoad }) =>
      Boolean(value === engine && measureNativeLoad && observed.has(id))
    );
    return {
      engine,
      ...summarize(attempts.map(({ id }) => observedLoads.get(id)).filter(Boolean), {
        elapsedMs: (load) => load.elapsedMs,
        peakRssBytes: (load) => load.peakRssBytes
      })
    };
  });
  return Object.freeze({
    generatedAtUtc,
    plannedTrials: manifest.schedule.length,
    completedTrials: observed.size,
    incompleteTrialIds: manifest.schedule.filter(({ id }) => !observed.has(id)).map(({ id }) => id),
    method: structuredClone(manifest.method),
    provenance: structuredClone(manifest.provenance),
    trials: structuredClone(trials),
    loads: structuredClone(loads),
    loadSummaries,
    summaries
  });
}

export function validateLargeLoadResult(load, entry) {
  const keys = load && typeof load === "object" && !Array.isArray(load) ? Object.keys(load).sort() : [];
  const expectedKeys = ["trialId", "protocol", "engine", "elapsedMs", "rows", "columns", "peakRssBytes"].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("Large comparison native-load result has missing or unknown fields.");
  }
  if (
    entry?.measureNativeLoad !== true ||
    load.trialId !== entry.id ||
    load.protocol !== "openwrangler-large-parquet-load-v1" ||
    load.engine !== entry.engine ||
    load.rows !== LARGE_ROWS ||
    load.columns !== LARGE_COLUMNS ||
    typeof load.elapsedMs !== "number" ||
    !Number.isFinite(load.elapsedMs) ||
    load.elapsedMs < 0 ||
    !Number.isSafeInteger(load.peakRssBytes) ||
    load.peakRssBytes < 0
  ) {
    throw new TypeError("Large comparison native-load result does not match its scheduled run.");
  }
  return load;
}

export function assertCompleteLargeReport(report) {
  if (
    report?.plannedTrials !== 20 ||
    report.completedTrials !== 20 ||
    report.incompleteTrialIds?.length !== 0 ||
    report.method?.repetitions !== LARGE_REPETITIONS ||
    report.method?.nativeLoadsPerEngine !== LARGE_REPETITIONS ||
    report.method?.minimumComplete !== LARGE_MIN_SUCCESSFUL_REPETITIONS ||
    report.method?.retries !== 0 ||
    report.summaries?.length !== 4 ||
    report.summaries?.some(
      ({ completed, successful }) => completed !== LARGE_REPETITIONS || successful < LARGE_MIN_SUCCESSFUL_REPETITIONS
    ) ||
    report.loadSummaries?.length !== 2 ||
    report.loadSummaries.some(
      ({ completed, successful }) => completed !== LARGE_REPETITIONS || successful < LARGE_MIN_SUCCESSFUL_REPETITIONS
    )
  ) {
    throw new Error("The large comparison needs all 20 attempts and at least four complete runs per group.");
  }
  return report;
}

function summarizeLargeValues(values) {
  const sorted = values
    .filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    minimum: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    maximum: sorted.at(-1)
  };
}

function runCellToWorkbenchMs(sample) {
  const marker = (name) => sample.milestones?.find(({ name: value }) => value === name)?.monotonicNs;
  const [start, end] = [marker("run-cell-click"), marker("workbench-ready")];
  return /^[1-9]\d*$/u.test(start ?? "") && /^[1-9]\d*$/u.test(end ?? "") && BigInt(end) >= BigInt(start)
    ? Number(BigInt(end) - BigInt(start)) / 1_000_000
    : null;
}

async function captureLargeProvenance(options) {
  const metadata = lstatSync(resolve(options.parquet));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o222) !== 0) {
    throw new Error("Use the generator's single-link read-only fixture.");
  }
  const fixture = readJson(`${resolve(options.parquet)}.json`);
  validateLargeFixtureManifest(fixture);
  if (metadata.size !== fixture.bytes) throw new Error("The large fixture size does not match its manifest.");
  const environment = await inspectLargeRunEnvironment(options.python, options.parquet, true);
  assertLargeRunEnvironment(environment, environment.machine);
  const comparison = await inspectComparisonEnvironment(options, {
    toolFiles: { ...comparisonToolFiles(), largeFixture: resolve("python/benchmarks/large_mixed_parquet.py") }
  });
  return { ...comparison, fixture, machine: environment.machine };
}

async function inspectLargeRunEnvironment(python, parquet, validate = false) {
  const program = [
    "import json, sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from large_mixed_parquet import LargeFixtureSpec, assert_large_study_capacity, validate_fixture",
    "path = Path(sys.argv[2])",
    `validate_fixture(path, LargeFixtureSpec(rows=${LARGE_ROWS}, row_group_rows=100000)) if sys.argv[3] == '1' else None`,
    "print(json.dumps(assert_large_study_capacity(path)))"
  ].join("; ");
  const { stdout } = await spawnCommand(
    python,
    ["-I", "-c", program, resolve("python/benchmarks"), resolve(parquet), validate ? "1" : "0"],
    { cwd: resolve(import.meta.dirname, ".."), timeoutMs: validate ? 180_000 : 30_000 }
  );
  return { machine: inspectMachineEnvironment(), capacity: JSON.parse(stdout) };
}

export function assertLargeRunEnvironment(environment, expectedMachine) {
  if (digest(environment?.machine) !== digest(expectedMachine)) {
    throw new Error("Machine, power source, or CPU governor changed during the large study.");
  }
  if (!["ac", "not-applicable"].includes(environment.machine.powerSource)) {
    throw new Error("The large study requires AC power when the machine has a battery.");
  }
  if (["", "unknown"].includes(environment.machine.cpuGovernor)) {
    throw new Error("The large study could not determine whether the CPU governor is exposed.");
  }
  if (
    environment.capacity?.availableMemoryBytes < 40 * 1024 ** 3 ||
    environment.capacity?.freeDiskBytes < 15 * 1024 ** 3
  ) {
    throw new Error("Available memory or disk space fell below the large-study minimum.");
  }
}

function validateLargeFixtureManifest(fixture) {
  const names = Array.isArray(fixture?.schema) ? fixture.schema.map((column) => column?.name) : [];
  if (
    fixture?.protocol !== LARGE_FIXTURE_PROTOCOL ||
    fixture.rows !== LARGE_ROWS ||
    fixture.columns !== LARGE_COLUMNS ||
    fixture.rowGroupRows !== 100_000 ||
    !Number.isSafeInteger(fixture.bytes) ||
    fixture.bytes < 1 ||
    !HASH.test(fixture.sha256 ?? "") ||
    names.length !== LARGE_COLUMNS ||
    new Set(names).size !== LARGE_COLUMNS ||
    names.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(name)) ||
    typeof fixture.profileSentinels !== "object"
  ) {
    throw new TypeError("The large Parquet fixture manifest is malformed.");
  }
}

function regularFileIdentity(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("The fixture link is not a regular file.");
  return Object.fromEntries(
    [
      ["device", metadata.dev],
      ["inode", metadata.ino],
      ["size", metadata.size],
      ["mtimeNs", metadata.mtimeNs]
    ].map(([name, value]) => [name, value.toString()])
  );
}

async function captureProvenance(options, dependencies) {
  const hashFile = dependencies.hashFile ?? sha256File;
  const inspectMachine = dependencies.inspectMachine ?? inspectMachineEnvironment;
  const validateFixtures = dependencies.validateFixtures ?? validateFixtureInputs;
  const { tools, ...environment } = await inspectComparisonEnvironment(options, {
    hashFile,
    inspectCandidate: dependencies.inspectCandidate,
    inspectEditor: dependencies.inspectEditor,
    inspectPython: dependencies.inspectPython,
    toolFiles: comparisonToolFiles()
  });
  const fixtureContract = await validateFixtures(options.python, options.csv, options.parquet);
  return {
    ...environment,
    fixtures: {
      csv: { ...fixtureContract.csv, sha256: hashFile(options.csv) },
      parquet: { ...fixtureContract.parquet, sha256: hashFile(options.parquet) }
    },
    machine: inspectMachine(),
    toolHashes: tools
  };
}

export async function inspectComparisonEnvironment(
  options,
  { hashFile = sha256File, inspectCandidate, inspectEditor, inspectPython, toolFiles }
) {
  const candidate = await (inspectCandidate ?? inspectCandidateVsix)(options.candidate);
  const editor = await (inspectEditor ?? inspectEditorEnvironment)(options.editor, options.editorCli);
  const python = {
    ...(await (inspectPython ?? inspectPythonEnvironment)(options.python)),
    sha256: hashFile(options.python)
  };
  const tools = Object.fromEntries(Object.entries(toolFiles).map(([name, path]) => [name, hashFile(path)]));
  return { candidate, editor, python, tools };
}

export async function inspectCandidateVsix(path) {
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

export async function inspectEditorEnvironment(editor, editorCli) {
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

export async function inspectPythonEnvironment(python) {
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

async function validateFixtureInputs(python, csv, parquet) {
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

export function inspectMachineEnvironment() {
  const cpuList = cpus();
  if (cpuList.length === 0 || totalmem() <= 0) throw new Error("Machine provenance is unavailable.");
  const cpuGovernor = readOptionalSystemText("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor");
  return {
    os: platform(),
    osRelease: release(),
    architecture: arch(),
    cpuModel: cpuList[0].model.trim(),
    logicalCpuCount: cpuList.length,
    totalMemoryBytes: totalmem(),
    powerSource: linuxPowerSource(),
    cpuGovernor: cpuGovernor || "not-exposed"
  };
}

function linuxPowerSource() {
  if (platform() !== "linux") return "unknown";
  const root = "/sys/class/power_supply";
  try {
    return classifyLinuxPowerSupplies(
      readdirSync(root).map((name) => ({
        type: readOptionalSystemText(join(root, name, "type")),
        online: readOptionalSystemText(join(root, name, "online"))
      }))
    );
  } catch {
    return "unknown";
  }
}

export function classifyLinuxPowerSupplies(supplies) {
  if (
    !Array.isArray(supplies) ||
    supplies.some(
      (supply) =>
        !supply ||
        typeof supply !== "object" ||
        typeof supply.type !== "string" ||
        (supply.online !== undefined && typeof supply.online !== "string")
    )
  ) {
    return "unknown";
  }
  if (!supplies.some(({ type }) => type === "Battery")) return "not-applicable";
  return supplies.some(({ type, online }) => ["Mains", "USB", "USB_C"].includes(type) && online === "1")
    ? "ac"
    : "battery";
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

export async function buildComparisonTestExtension() {
  await spawnCommand("npm", ["run", "build:test-extension"], {
    cwd: resolve(import.meta.dirname, ".."),
    timeoutMs: 180_000
  });
}

export function buildComparisonNotebook(entry, source) {
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

export function buildComparisonFailureResult(entry, error, status, provenance, repetitions) {
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

export function comparisonTrialProvenance(manifest) {
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

export async function spawnCommand(command, arguments_, { cwd, timeoutMs }) {
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
    !["ac", "battery", "not-applicable", "unknown"].includes(value.powerSource) ||
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

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readJson(path) {
  const source = readFileSync(path);
  if (source.byteLength <= 0 || source.byteLength > MAX_JSON_BYTES) {
    throw new Error(`${basename(path)} is empty or too large.`);
  }
  return JSON.parse(source.toString("utf8"));
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function sanitizeError(error) {
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
  const commands = ["run", "smoke", "report", "large-run", "large-report"];
  if (!commands.includes(command)) throw new Error(`Expected ${commands.join(", ")}.`);
  const acceptedValues = new Set([
    "--candidate",
    "--python",
    "--editor",
    "--editor-cli",
    "--csv",
    "--parquet",
    "--out",
    "--study",
    "--limit"
  ]);
  const values = new Map();
  for (let index = 1; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === "--confirm-large-study") {
      if (values.has(flag)) throw new Error(`Duplicate ${flag}.`);
      values.set(flag, true);
      continue;
    }
    const value = arguments_[index + 1];
    if (!acceptedValues.has(flag) || !value || value.startsWith("--") || values.has(flag)) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}.`);
    }
    values.set(flag, value);
    index += 1;
  }
  const required = (flag) => {
    const value = values.get(flag);
    if (!value) throw new Error(`Missing ${flag}.`);
    return value;
  };
  if (command !== "large-run" && values.has("--confirm-large-study")) {
    throw new Error("--confirm-large-study is only valid for the large study.");
  }
  if (["report", "large-report"].includes(command)) {
    return {
      command,
      study: required("--study"),
      output: required("--out")
    };
  }
  const paths = ["--candidate", "--python", "--editor", "--editor-cli", "--parquet"];
  if (command !== "large-run") paths.push("--csv");
  for (const flag of paths) {
    const value = required(flag);
    if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path.`);
  }
  if (command === "large-run" && !isAbsolute(required("--out"))) {
    throw new Error("--out must be an absolute path.");
  }
  const limit = values.has("--limit") ? Number(values.get("--limit")) : undefined;
  if (command === "smoke" && limit !== undefined) throw new Error("Smoke always runs exactly one complete pair.");
  const maximum = command === "large-run" ? 20 : 8;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)) {
    throw new Error(`--limit must be between 1 and ${maximum}.`);
  }
  return {
    command,
    candidate: values.get("--candidate"),
    python: values.get("--python"),
    editor: values.get("--editor"),
    editorCli: values.get("--editor-cli"),
    csv: values.get("--csv"),
    parquet: values.get("--parquet"),
    output: required("--out"),
    limit,
    confirmLargeStudy: values.get("--confirm-large-study") === true
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "large-run") {
    const status = await runLargeComparisonStudy(options);
    console.log(`${status.completed} of 20 fresh comparison sessions complete.`);
    return;
  }
  if (options.command === "large-report") {
    const manifest = readJson(join(resolve(options.study), "manifest.json"));
    const { trials, loads } = loadLargeTrials(options.study, manifest);
    const report = buildLargeComparisonReport({ generatedAtUtc: new Date().toISOString(), manifest, trials, loads });
    writeJsonAtomic(resolve(options.output), report);
    assertCompleteLargeReport(report);
    console.log(`Large comparison report written to ${options.output}.`);
    return;
  }
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
  const { manifest, trials } = loadStudyResults(options.study);
  const report = buildDataWranglerComparisonStudyReport({ generatedAtUtc: new Date().toISOString(), manifest, trials });
  writeDataWranglerComparisonStudyReport(options.output, report);
  console.log(`Comparison report written to ${options.output}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Data Wrangler comparison failed: ${sanitizeError(error)}`);
    process.exitCode = 1;
  });
}
