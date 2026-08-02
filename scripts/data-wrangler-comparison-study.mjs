import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, resolve } from "node:path";

export const DATA_WRANGLER_STUDY_METHOD_PROTOCOL = "openwrangler-data-wrangler-study-method-v1";
export const DATA_WRANGLER_STUDY_MANIFEST_PROTOCOL = "openwrangler-data-wrangler-study-manifest-v1";
export const DATA_WRANGLER_STUDY_FRAGMENT_PROTOCOL = "openwrangler-data-wrangler-study-fragment-v1";
export const DATA_WRANGLER_STUDY_RESULT_PROTOCOL = "openwrangler-data-wrangler-study-result-v1";
export const DATA_WRANGLER_STUDY_RESOURCE_PROTOCOL = "openwrangler-linux-pss-observation-v1";
export const DATA_WRANGLER_STUDY_SEED = 0x4f575231;
export const DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL = 10;
export const DATA_WRANGLER_STUDY_SCHEDULE_SHA256 = "3fcf79fa323c60e256fddaf62c0a1454ea2077c5b6158ba93e1dfddd43adaa64";

export const DATA_WRANGLER_STUDY_PRODUCTS = Object.freeze(["open-wrangler", "data-wrangler"]);
export const DATA_WRANGLER_STUDY_CELLS = Object.freeze([
  Object.freeze({ id: "pandas-csv", engine: "pandas", format: "csv" }),
  Object.freeze({ id: "polars-csv", engine: "polars", format: "csv" }),
  Object.freeze({ id: "pandas-parquet", engine: "pandas", format: "parquet" }),
  Object.freeze({ id: "polars-parquet", engine: "polars", format: "parquet" })
]);
export const DATA_WRANGLER_STUDY_METRICS = Object.freeze([
  Object.freeze({ name: "inlinePreviewMs", threshold: 500, allowZero: false }),
  Object.freeze({ name: "workbenchOpenMs", threshold: 750, allowZero: false }),
  Object.freeze({ name: "firstProfileMs", threshold: 750, allowZero: false }),
  Object.freeze({ name: "completeProfileMs", threshold: 2_000, allowZero: false }),
  Object.freeze({ name: "completeTrialPssDeltaBytes", threshold: 256 * 1024 * 1024, allowZero: true })
]);
export const DATA_WRANGLER_STUDY_REASON_CLASSES = Object.freeze([
  "fixture",
  "setup",
  "correctness",
  "obstruction",
  "timeout",
  "cleanup",
  "resource-sampling"
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const PYTHON_VERSION = /^3\.12(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FRAGMENT_FILE = /^(?<entry>[a-z0-9-]+)\.attempt-(?<attempt>\d{2})\.json$/u;
const MILESTONE_KEYS = Object.freeze([
  "inlineActionMs",
  "inlineReadyMs",
  "workbenchActionMs",
  "workbenchReadyMs",
  "profileActionMs",
  "firstProfileReadyMs",
  "profilesCompleteMs",
  "samplingStoppedMs"
]);
const RESOURCE_CATEGORIES = Object.freeze([
  "editor-main",
  "renderer-gpu",
  "extension-host",
  "configured-kernel",
  "open-wrangler-runtime",
  "other-owned-child"
]);

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function assertString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid.`);
  }
}

function assertInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer at least ${minimum}.`);
  }
}

function assertNonNegativeFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a non-negative finite number.`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be boolean.`);
  }
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    fail(`${label} is invalid.`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalStudyJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function digestStudyValue(value) {
  return createHash("sha256").update(canonicalStudyJson(value), "utf8").digest("hex");
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function productAbbreviation(product) {
  return product === "open-wrangler" ? "ow" : "dw";
}

function createPairEntries({ blockId, cell, kind, repetition, order, sequence }) {
  return order.map((product, orderIndex) => ({
    id: `${blockId}-${productAbbreviation(product)}`,
    blockId,
    kind,
    cellId: cell.id,
    engine: cell.engine,
    format: cell.format,
    repetition,
    product,
    orderInPair: orderIndex + 1,
    sequence: sequence + orderIndex
  }));
}

export function createDataWranglerStudySchedule(seed = DATA_WRANGLER_STUDY_SEED) {
  assertInteger(seed, "Study schedule seed");
  if (seed > 0xffff_ffff) {
    fail("Study schedule seed must fit in an unsigned 32-bit integer.");
  }
  const random = seededRandom(seed);
  const firstProductByCell = new Map(
    DATA_WRANGLER_STUDY_CELLS.map((cell) => [
      cell.id,
      shuffle([...Array(5).fill("open-wrangler"), ...Array(5).fill("data-wrangler")], random)
    ])
  );
  const schedule = [];
  let sequence = 0;
  for (let repetition = 1; repetition <= DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL; repetition += 1) {
    for (const cell of shuffle(DATA_WRANGLER_STUDY_CELLS, random)) {
      const first = firstProductByCell.get(cell.id)[repetition - 1];
      const second = first === "open-wrangler" ? "data-wrangler" : "open-wrangler";
      const blockId = `warm-${cell.id}-r${String(repetition).padStart(2, "0")}`;
      const entries = createPairEntries({
        blockId,
        cell,
        kind: "warm",
        repetition,
        order: [first, second],
        sequence
      });
      schedule.push(...entries);
      sequence += entries.length;
    }
  }
  for (const cell of DATA_WRANGLER_STUDY_CELLS) {
    for (const [label, order] of [
      ["ab", ["open-wrangler", "data-wrangler"]],
      ["ba", ["data-wrangler", "open-wrangler"]]
    ]) {
      const blockId = `cold-${cell.id}-${label}`;
      const entries = createPairEntries({
        blockId,
        cell,
        kind: "cold",
        repetition: null,
        order,
        sequence
      });
      schedule.push(...entries);
      sequence += entries.length;
    }
  }
  return Object.freeze(schedule.map((entry) => Object.freeze(entry)));
}

function validateMethod(method) {
  exactKeys(method, ["protocol", "sha256"], "Study methodology receipt");
  if (method.protocol !== DATA_WRANGLER_STUDY_METHOD_PROTOCOL) {
    fail("Study methodology protocol is invalid.");
  }
  assertString(method.sha256, SHA256, "Study methodology SHA-256");
}

function validateCandidate(candidate) {
  exactKeys(candidate, ["extensionId", "version", "sha256"], "Open Wrangler candidate receipt");
  if (candidate.extensionId !== "Matt17BR.openwrangler") {
    fail("Open Wrangler candidate extension ID is invalid.");
  }
  assertString(candidate.version, NUMERIC_VERSION, "Open Wrangler candidate version");
  assertString(candidate.sha256, SHA256, "Open Wrangler candidate SHA-256");
}

function validateBaseline(baseline) {
  exactKeys(baseline, ["extensionId", "version"], "Data Wrangler baseline receipt");
  if (baseline.extensionId !== "ms-toolsai.datawrangler" || baseline.version !== "1.24.2") {
    fail("Data Wrangler baseline must be the official ms-toolsai.datawrangler 1.24.2 installation.");
  }
}

function validateEditor(editor) {
  exactKeys(editor, ["id", "version", "sha256"], "Study editor receipt");
  if (editor.id !== "Microsoft.VisualStudioCode") {
    fail("Study editor must be official Microsoft Visual Studio Code.");
  }
  assertString(editor.version, NUMERIC_VERSION, "Study editor version");
  assertString(editor.sha256, SHA256, "Study editor SHA-256");
}

function validatePython(python) {
  exactKeys(python, ["implementation", "version", "executableSha256", "environmentSha256"], "Study Python receipt");
  if (python.implementation !== "CPython") {
    fail("Study Python implementation must be CPython.");
  }
  assertString(python.version, PYTHON_VERSION, "Study Python version");
  assertString(python.executableSha256, SHA256, "Study Python executable SHA-256");
  assertString(python.environmentSha256, SHA256, "Study Python environment SHA-256");
}

function validateFixtures(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length !== 2) {
    fail("Study fixtures must contain the exact CSV and Parquet sources.");
  }
  const expected = new Map([
    ["csv-100k-50", { format: "csv", rows: 100_000, columns: 50 }],
    ["parquet-1m-20", { format: "parquet", rows: 1_000_000, columns: 20 }]
  ]);
  for (const fixture of fixtures) {
    exactKeys(fixture, ["id", "format", "rows", "columns", "sha256"], "Study fixture receipt");
    const shape = expected.get(fixture.id);
    if (
      shape === undefined ||
      fixture.format !== shape.format ||
      fixture.rows !== shape.rows ||
      fixture.columns !== shape.columns
    ) {
      fail("Study fixture identity, format, or shape is invalid.");
    }
    assertString(fixture.sha256, SHA256, "Study fixture SHA-256");
    expected.delete(fixture.id);
  }
  if (expected.size !== 0) {
    fail("Study fixture set is incomplete.");
  }
}

function validateScheduleEntry(entry, expected) {
  exactKeys(
    entry,
    ["id", "blockId", "kind", "cellId", "engine", "format", "repetition", "product", "orderInPair", "sequence"],
    "Study schedule entry"
  );
  if (canonicalStudyJson(entry) !== canonicalStudyJson(expected)) {
    fail("Study schedule does not match the fixed seeded design.");
  }
}

export function validateDataWranglerStudyManifest(manifest) {
  exactKeys(
    manifest,
    [
      "protocol",
      "studyId",
      "createdAtUtc",
      "method",
      "candidate",
      "baseline",
      "editor",
      "python",
      "fixtures",
      "sampling",
      "schedule"
    ],
    "Data Wrangler study manifest"
  );
  if (manifest.protocol !== DATA_WRANGLER_STUDY_MANIFEST_PROTOCOL) {
    fail("Data Wrangler study manifest protocol is invalid.");
  }
  assertString(manifest.studyId, UUID, "Study ID");
  assertString(manifest.createdAtUtc, ISO_UTC, "Study creation timestamp");
  validateMethod(manifest.method);
  validateCandidate(manifest.candidate);
  validateBaseline(manifest.baseline);
  validateEditor(manifest.editor);
  validatePython(manifest.python);
  validateFixtures(manifest.fixtures);
  exactKeys(
    manifest.sampling,
    ["seed", "warmPairsPerCell", "coldPairsPerOrder", "scheduleSha256"],
    "Study sampling plan"
  );
  if (
    manifest.sampling.seed !== DATA_WRANGLER_STUDY_SEED ||
    manifest.sampling.warmPairsPerCell !== DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL ||
    manifest.sampling.coldPairsPerOrder !== 1 ||
    manifest.sampling.scheduleSha256 !== DATA_WRANGLER_STUDY_SCHEDULE_SHA256
  ) {
    fail("Study sampling plan does not match the preregistered design.");
  }
  const expected = createDataWranglerStudySchedule(manifest.sampling.seed);
  if (!Array.isArray(manifest.schedule) || manifest.schedule.length !== expected.length) {
    fail("Study schedule length is invalid.");
  }
  manifest.schedule.forEach((entry, index) => validateScheduleEntry(entry, expected[index]));
  if (digestStudyValue(manifest.schedule) !== DATA_WRANGLER_STUDY_SCHEDULE_SHA256) {
    fail("Study schedule SHA-256 does not match the published fixed schedule.");
  }
  return manifest;
}

export function buildDataWranglerStudyManifest(specification) {
  exactKeys(
    specification,
    ["studyId", "createdAtUtc", "method", "candidate", "baseline", "editor", "python", "fixtures"],
    "Data Wrangler study specification"
  );
  const manifest = {
    protocol: DATA_WRANGLER_STUDY_MANIFEST_PROTOCOL,
    ...structuredClone(specification),
    sampling: {
      seed: DATA_WRANGLER_STUDY_SEED,
      warmPairsPerCell: DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL,
      coldPairsPerOrder: 1,
      scheduleSha256: DATA_WRANGLER_STUDY_SCHEDULE_SHA256
    },
    schedule: createDataWranglerStudySchedule(DATA_WRANGLER_STUDY_SEED)
  };
  return validateDataWranglerStudyManifest(manifest);
}

function validateMilestones(milestones, status) {
  exactKeys(milestones, MILESTONE_KEYS, "Study trial milestones");
  let previous = -1;
  let sawNull = false;
  for (const key of MILESTONE_KEYS) {
    const value = milestones[key];
    if (value === null) {
      sawNull = true;
      continue;
    }
    assertNonNegativeFinite(value, `Study milestone ${key}`);
    if (sawNull || value < previous) {
      fail("Study milestones must be a contiguous non-decreasing prefix.");
    }
    previous = value;
  }
  if (status === "success" && sawNull) {
    fail("A successful study fragment requires every milestone.");
  }
  if (
    status === "success" &&
    (milestones.inlineReadyMs <= milestones.inlineActionMs ||
      milestones.workbenchReadyMs <= milestones.workbenchActionMs ||
      milestones.firstProfileReadyMs <= milestones.profileActionMs ||
      milestones.profilesCompleteMs < milestones.firstProfileReadyMs ||
      milestones.samplingStoppedMs - milestones.profilesCompleteMs < 2_000)
  ) {
    fail("A successful study fragment requires positive readiness durations and two-second resource quiescence.");
  }
  if (status === "pre-action-invalid" && MILESTONE_KEYS.some((key) => milestones[key] !== null)) {
    fail("A pre-action invalidation cannot contain product-action milestones.");
  }
}

function validatePssProcess(process) {
  exactKeys(process, ["pid", "startTimeTicks", "category", "pssBytes", "rssBytes"], "PSS process sample");
  assertInteger(process.pid, "PSS process PID", { minimum: 1 });
  if (typeof process.startTimeTicks !== "string" || !/^\d+$/u.test(process.startTimeTicks)) {
    fail("PSS process start time is invalid.");
  }
  assertEnum(process.category, RESOURCE_CATEGORIES, "PSS process category");
  assertInteger(process.pssBytes, "PSS process bytes");
  assertInteger(process.rssBytes, "RSS process bytes");
}

function validatePssSample(sample) {
  exactKeys(sample, ["elapsedMs", "totalPssBytes", "totalRssBytes", "categories", "processes"], "PSS sample");
  assertNonNegativeFinite(sample.elapsedMs, "PSS sample elapsed time");
  assertInteger(sample.totalPssBytes, "PSS sample total bytes");
  assertInteger(sample.totalRssBytes, "RSS sample total bytes");
  exactKeys(sample.categories, RESOURCE_CATEGORIES, "PSS sample categories");
  if (!Array.isArray(sample.processes) || sample.processes.length === 0) {
    fail("PSS sample must contain at least the editor root process.");
  }
  const pids = new Set();
  let totalPssBytes = 0;
  let totalRssBytes = 0;
  const categoryTotals = Object.fromEntries(RESOURCE_CATEGORIES.map((category) => [category, 0]));
  for (const process of sample.processes) {
    validatePssProcess(process);
    if (pids.has(process.pid)) {
      fail("PSS sample cannot count one PID more than once.");
    }
    pids.add(process.pid);
    totalPssBytes += process.pssBytes;
    totalRssBytes += process.rssBytes;
    categoryTotals[process.category] += process.pssBytes;
  }
  if (sample.totalPssBytes !== totalPssBytes || sample.totalRssBytes !== totalRssBytes) {
    fail("PSS sample totals must equal the unique process totals.");
  }
  for (const category of RESOURCE_CATEGORIES) {
    if (sample.categories[category] !== categoryTotals[category]) {
      fail("PSS category totals must equal the unique process assignments.");
    }
  }
}

export function validateDataWranglerStudyResourceObservation(observation) {
  exactKeys(
    observation,
    ["protocol", "valid", "reasonClass", "intervalMs", "missedSamples", "samples"],
    "Study resource observation"
  );
  if (observation.protocol !== DATA_WRANGLER_STUDY_RESOURCE_PROTOCOL) {
    fail("Study resource observation protocol is invalid.");
  }
  assertBoolean(observation.valid, "Study resource observation validity");
  if (observation.valid) {
    if (observation.reasonClass !== null) {
      fail("A valid resource observation cannot have a failure reason.");
    }
  } else if (observation.reasonClass !== "resource-sampling") {
    fail("An invalid resource observation must use the resource-sampling reason class.");
  }
  if (observation.intervalMs !== 200) {
    fail("Study resource samples must use the preregistered 200 ms interval.");
  }
  assertInteger(observation.missedSamples, "Study missed resource samples");
  if (observation.valid && observation.missedSamples !== 0) {
    fail("A valid resource observation cannot contain sampling gaps.");
  }
  if (!Array.isArray(observation.samples)) {
    fail("Study resource samples must be an array.");
  }
  if (observation.valid && observation.samples.length === 0) {
    fail("A valid resource observation must contain samples.");
  }
  let previous = -1;
  for (const sample of observation.samples) {
    validatePssSample(sample);
    if (sample.elapsedMs < previous) {
      fail("PSS samples must be ordered by elapsed time.");
    }
    previous = sample.elapsedMs;
  }
  return observation;
}

function scheduleEntryForFragment(fragment, manifest) {
  const entry = manifest.schedule.find((candidate) => candidate.id === fragment.scheduleEntryId);
  if (entry === undefined) {
    fail("Study fragment refers to an unknown schedule entry.");
  }
  if (
    entry.blockId !== fragment.baseBlockId ||
    entry.product !== fragment.product ||
    `${entry.blockId}~a${String(fragment.attempt).padStart(2, "0")}` !== fragment.effectiveBlockId
  ) {
    fail("Study fragment does not match its scheduled block, product, or attempt.");
  }
  return entry;
}

export function validateDataWranglerStudyFragment(fragment, manifest) {
  validateDataWranglerStudyManifest(manifest);
  exactKeys(
    fragment,
    [
      "protocol",
      "fragmentId",
      "manifestSha256",
      "scheduleEntryId",
      "baseBlockId",
      "attempt",
      "effectiveBlockId",
      "product",
      "recordedAtUtc",
      "outcome",
      "milestones",
      "resourceObservation"
    ],
    "Data Wrangler study fragment"
  );
  if (fragment.protocol !== DATA_WRANGLER_STUDY_FRAGMENT_PROTOCOL) {
    fail("Data Wrangler study fragment protocol is invalid.");
  }
  assertString(fragment.fragmentId, UUID, "Study fragment ID");
  if (fragment.manifestSha256 !== digestStudyValue(manifest)) {
    fail("Study fragment manifest SHA-256 does not match the immutable manifest.");
  }
  assertInteger(fragment.attempt, "Study fragment attempt");
  assertString(fragment.recordedAtUtc, ISO_UTC, "Study fragment timestamp");
  scheduleEntryForFragment(fragment, manifest);
  exactKeys(fragment.outcome, ["status", "reasonClass", "actionStarted", "correctness"], "Study outcome");
  assertEnum(fragment.outcome.status, ["success", "product-failure", "pre-action-invalid"], "Study outcome status");
  assertBoolean(fragment.outcome.actionStarted, "Study action-started proof");
  assertEnum(fragment.outcome.correctness, ["passed", "failed", "not-reached"], "Study correctness status");
  if (fragment.outcome.status === "success") {
    if (
      fragment.outcome.reasonClass !== null ||
      !fragment.outcome.actionStarted ||
      fragment.outcome.correctness !== "passed"
    ) {
      fail("A successful study outcome requires an action, passed correctness, and no failure reason.");
    }
  } else {
    assertEnum(fragment.outcome.reasonClass, DATA_WRANGLER_STUDY_REASON_CLASSES, "Study outcome reason class");
    if (fragment.outcome.status === "pre-action-invalid") {
      if (fragment.outcome.actionStarted || fragment.outcome.correctness !== "not-reached") {
        fail("A pre-action invalidation must occur before action and correctness checks.");
      }
      if (!["fixture", "setup", "cleanup", "resource-sampling"].includes(fragment.outcome.reasonClass)) {
        fail("A pre-action invalidation has an impossible post-action reason class.");
      }
    } else if (!fragment.outcome.actionStarted) {
      fail("A product failure must occur after its public action starts.");
    }
  }
  validateMilestones(fragment.milestones, fragment.outcome.status);
  if (fragment.resourceObservation !== null) {
    validateDataWranglerStudyResourceObservation(fragment.resourceObservation);
  }
  return fragment;
}

function fragmentFileName(fragment) {
  return `${fragment.scheduleEntryId}.attempt-${String(fragment.attempt).padStart(2, "0")}.json`;
}

function writeExclusiveAtomicJson(path, value) {
  const directory = resolve(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  let operationError;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, canonicalStudyJson(value), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = [];
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      cleanupErrors.push(error);
    }
  }
  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
      `Could not publish the exclusive study JSON file (${operationError?.code ?? "cleanup"}).`
    );
  }
}

export function writeDataWranglerStudyJsonExclusive(path, value) {
  writeExclusiveAtomicJson(resolve(path), value);
  return Object.freeze({ path: resolve(path), sha256: digestStudyValue(value) });
}

export function publishDataWranglerStudyFragment(directory, fragment, manifest) {
  validateDataWranglerStudyFragment(fragment, manifest);
  if (fragment.attempt > 99) {
    fail("Study fragment attempt exceeds the bounded filename range.");
  }
  const pending = pendingDataWranglerStudyTrials(manifest, loadDataWranglerStudyFragments(directory, manifest));
  if (
    !pending.some(
      (entry) =>
        entry.id === fragment.scheduleEntryId &&
        entry.attempt === fragment.attempt &&
        entry.effectiveBlockId === fragment.effectiveBlockId
    )
  ) {
    fail("Study fragment is not the currently pending append-only attempt.");
  }
  const path = resolve(directory, fragmentFileName(fragment));
  writeExclusiveAtomicJson(path, fragment);
  return Object.freeze({ path, sha256: digestStudyValue(fragment) });
}

export function loadDataWranglerStudyFragments(directory, manifest) {
  validateDataWranglerStudyManifest(manifest);
  let names;
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const fragments = [];
  for (const name of names) {
    const match = FRAGMENT_FILE.exec(name);
    if (match === null) {
      fail("Study fragment directory contains an unexpected JSON filename.");
    }
    const path = resolve(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 32 * 1024 * 1024) {
      fail("Study fragment must be one bounded, singly linked regular file.");
    }
    let fragment;
    try {
      fragment = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      fail("Study fragment is not valid JSON.");
    }
    validateDataWranglerStudyFragment(fragment, manifest);
    if (name !== fragmentFileName(fragment)) {
      fail("Study fragment filename does not match its immutable identity.");
    }
    fragments.push(fragment);
  }
  return fragments;
}

function groupFragmentsByBlock(fragments, manifest) {
  const groups = new Map();
  const fragmentIds = new Set();
  for (const fragment of fragments) {
    validateDataWranglerStudyFragment(fragment, manifest);
    if (fragmentIds.has(fragment.fragmentId)) {
      fail("Study accounting found a duplicate immutable fragment ID.");
    }
    fragmentIds.add(fragment.fragmentId);
    const key = `${fragment.baseBlockId}:${fragment.attempt}`;
    const group = groups.get(key) ?? new Map();
    if (group.has(fragment.product)) {
      fail("Study accounting found duplicate product fragments in one pair attempt.");
    }
    group.set(fragment.product, fragment);
    groups.set(key, group);
  }
  return groups;
}

function blockEntries(manifest) {
  const blocks = new Map();
  for (const entry of manifest.schedule) {
    const list = blocks.get(entry.blockId) ?? [];
    list.push(entry);
    blocks.set(entry.blockId, list);
  }
  for (const list of blocks.values()) {
    list.sort((left, right) => left.orderInPair - right.orderInPair);
  }
  return blocks;
}

function validateAttemptChain(blockId, groups) {
  const attempts = [...groups.entries()]
    .filter(([key]) => key.startsWith(`${blockId}:`))
    .map(([key, group]) => ({ attempt: Number(key.slice(blockId.length + 1)), group }))
    .sort((left, right) => left.attempt - right.attempt);
  for (let index = 0; index < attempts.length; index += 1) {
    const current = attempts[index];
    if (current.attempt !== index) {
      fail("Study fragment attempts must be contiguous from attempt zero.");
    }
    if (index < attempts.length - 1 && current.group.size !== 2) {
      fail("A later study attempt cannot begin before both earlier pair fragments exist.");
    }
    if (index > 0) {
      const previous = attempts[index - 1].group;
      if (
        previous.size !== 2 ||
        DATA_WRANGLER_STUDY_PRODUCTS.some((product) => previous.get(product)?.outcome.status !== "pre-action-invalid")
      ) {
        fail("A later study attempt requires a fully retained pre-action invalidated pair.");
      }
    }
  }
}

export function pendingDataWranglerStudyTrials(manifest, fragments) {
  validateDataWranglerStudyManifest(manifest);
  const groups = groupFragmentsByBlock(fragments, manifest);
  const pending = [];
  for (const [blockId, entries] of blockEntries(manifest)) {
    validateAttemptChain(blockId, groups);
    let attempt = 0;
    while (true) {
      const group = groups.get(`${blockId}:${attempt}`) ?? new Map();
      if (group.size < 2) {
        for (const entry of entries) {
          if (!group.has(entry.product)) {
            pending.push({
              ...entry,
              attempt,
              effectiveBlockId: `${blockId}~a${String(attempt).padStart(2, "0")}`
            });
          }
        }
        break;
      }
      const statuses = DATA_WRANGLER_STUDY_PRODUCTS.map((product) => group.get(product).outcome.status);
      const invalidCount = statuses.filter((status) => status === "pre-action-invalid").length;
      if (invalidCount === 2) {
        attempt += 1;
        if (attempt > 99) {
          fail("Study pair exceeded the bounded append-only attempt range.");
        }
        continue;
      }
      if (invalidCount === 1) {
        fail("A pre-action environment invalidation must invalidate both members of the pair.");
      }
      break;
    }
  }
  return pending.sort((left, right) => left.sequence - right.sequence || left.orderInPair - right.orderInPair);
}

export function type7Quantile(values, probability) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("Type-7 quantile requires at least one observation.");
  }
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    fail("Type-7 quantile probability must be between zero and one.");
  }
  const sorted = values
    .map((value, index) => {
      assertNonNegativeFinite(value, `Type-7 observation ${index}`);
      return value;
    })
    .sort((left, right) => left - right);
  return type7QuantileSorted(sorted, probability);
}

function type7QuantileSorted(sorted, probability) {
  if (sorted.length === 1) {
    return sorted[0];
  }
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const upper = Math.min(lower + 1, sorted.length - 1);
  if (fraction === 0 || sorted[lower] === sorted[upper]) {
    return sorted[lower];
  }
  if (sorted[upper] === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export function summarizeStudyMetric(values) {
  return Object.freeze({
    count: values.length,
    median: type7Quantile(values, 0.5),
    p95: type7Quantile(values, 0.95)
  });
}

function stablePssBaseline(samples, actionMs, label) {
  const eligible = samples.filter((sample) => sample.elapsedMs < actionMs);
  if (eligible.length < 5) {
    fail(`${label} PSS baseline requires five samples before the action.`);
  }
  const baselineSamples = eligible.slice(-5);
  if (actionMs - baselineSamples[0].elapsedMs > 10_000) {
    fail(`${label} PSS baseline exceeds the ten-second acceptance window.`);
  }
  const values = baselineSamples.map((sample) => sample.totalPssBytes);
  const median = type7Quantile(values, 0.5);
  const range = Math.max(...values) - Math.min(...values);
  if (range > Math.max(64 * 1024 * 1024, median * 0.05)) {
    fail(`${label} PSS baseline is not stable.`);
  }
  return { baselineSamples, median };
}

function categoryMedian(samples, category) {
  return type7Quantile(
    samples.map((sample) => sample.categories[category]),
    0.5
  );
}

function pssSegment(observation, { label, actionMs, endMs }) {
  const { baselineSamples, median } = stablePssBaseline(observation.samples, actionMs, label);
  const segmentSamples = observation.samples.filter(
    (sample) => sample.elapsedMs >= actionMs && sample.elapsedMs <= endMs
  );
  if (segmentSamples.length === 0) {
    fail(`${label} PSS segment has no samples inside its measured interval.`);
  }
  const peak = Math.max(...segmentSamples.map((sample) => sample.totalPssBytes));
  const categories = Object.fromEntries(
    RESOURCE_CATEGORIES.map((category) => {
      const baselinePssBytes = categoryMedian(baselineSamples, category);
      const peakPssBytes = Math.max(...segmentSamples.map((sample) => sample.categories[category]));
      return [
        category,
        {
          baselinePssBytes,
          peakPssBytes,
          deltaPssBytes: Math.max(0, peakPssBytes - baselinePssBytes)
        }
      ];
    })
  );
  return {
    baselinePssBytes: median,
    peakPssBytes: peak,
    deltaPssBytes: Math.max(0, peak - median),
    categories
  };
}

export function calculateStudyPssSegments(observation, milestones) {
  validateDataWranglerStudyResourceObservation(observation);
  validateMilestones(milestones, "success");
  if (!observation.valid) {
    return null;
  }
  return {
    inline: pssSegment(observation, {
      label: "Inline",
      actionMs: milestones.inlineActionMs,
      endMs: milestones.inlineReadyMs
    }),
    workbench: pssSegment(observation, {
      label: "Workbench",
      actionMs: milestones.workbenchActionMs,
      endMs: milestones.workbenchReadyMs
    }),
    profile: pssSegment(observation, {
      label: "Profile",
      actionMs: milestones.profileActionMs,
      endMs: milestones.samplingStoppedMs
    }),
    completeTrial: pssSegment(observation, {
      label: "Complete trial",
      actionMs: milestones.inlineActionMs,
      endMs: milestones.samplingStoppedMs
    })
  };
}

function encodeRatio(value) {
  return Number.isFinite(value) ? value : "positive-infinity";
}

export function calculatePairedStudyRegression(
  pairs,
  { absoluteThreshold, requiredPairs = 10, positiveRequired = 7, ratioThreshold = 1.2, allowZero = false }
) {
  assertNonNegativeFinite(absoluteThreshold, "Paired regression absolute threshold");
  assertInteger(requiredPairs, "Paired regression required pair count", { minimum: 1 });
  assertInteger(positiveRequired, "Paired regression positive-difference count", { minimum: 1 });
  assertNonNegativeFinite(ratioThreshold, "Paired regression ratio threshold");
  if (!Array.isArray(pairs)) {
    fail("Paired regression observations must be an array.");
  }
  const seen = new Set();
  const calculations = pairs.map((pair, index) => {
    exactKeys(pair, ["pairId", "openWrangler", "dataWrangler"], `Paired regression observation ${index}`);
    if (typeof pair.pairId !== "string" || pair.pairId.length === 0 || seen.has(pair.pairId)) {
      fail("Paired regression pair IDs must be non-empty and unique.");
    }
    seen.add(pair.pairId);
    assertNonNegativeFinite(pair.openWrangler, "Open Wrangler paired observation");
    assertNonNegativeFinite(pair.dataWrangler, "Data Wrangler paired observation");
    if (!allowZero && (pair.openWrangler === 0 || pair.dataWrangler === 0)) {
      fail("Latency comparisons require positive observations.");
    }
    const ratio =
      pair.dataWrangler === 0
        ? pair.openWrangler === 0
          ? 1
          : Number.POSITIVE_INFINITY
        : pair.openWrangler / pair.dataWrangler;
    return {
      pairId: pair.pairId,
      difference: pair.openWrangler - pair.dataWrangler,
      ratio
    };
  });
  const differences = calculations.map((value) => value.difference);
  const ratios = calculations.map((value) => value.ratio);
  const medianDifference =
    differences.length === 0
      ? null
      : type7QuantileSorted(
          differences
            .map((value, index) => {
              if (typeof value !== "number" || !Number.isFinite(value)) {
                fail(`Paired difference ${index} must be finite.`);
              }
              return value;
            })
            .sort((left, right) => left - right),
          0.5
        );
  // Ratios are non-negative; type-7 naturally remains infinite if an interpolated upper value is infinite.
  const medianRatio =
    ratios.length === 0
      ? null
      : type7QuantileSorted(
          [...ratios].sort((left, right) => left - right),
          0.5
        );
  const positiveDifferenceCount = differences.filter((value) => value > 0).length;
  const releaseComplete = calculations.length === requiredPairs;
  const investigationTriggered =
    releaseComplete &&
    positiveDifferenceCount >= positiveRequired &&
    medianRatio >= ratioThreshold &&
    medianDifference >= absoluteThreshold;
  return Object.freeze({
    successfulPairCount: calculations.length,
    requiredPairCount: requiredPairs,
    releaseComplete,
    positiveDifferenceCount,
    positiveDifferenceRequired: positiveRequired,
    medianDifference,
    medianRatio: medianRatio === null ? null : encodeRatio(medianRatio),
    ratioThreshold,
    absoluteThreshold,
    investigationTriggered,
    pairs: calculations.map((value) => ({
      pairId: value.pairId,
      difference: value.difference,
      ratio: encodeRatio(value.ratio)
    }))
  });
}

function trialDurations(fragment) {
  if (fragment.outcome.status !== "success") {
    return null;
  }
  const milestone = fragment.milestones;
  const pssSegments =
    fragment.resourceObservation === null
      ? null
      : calculateStudyPssSegments(fragment.resourceObservation, fragment.milestones);
  return {
    inlinePreviewMs: milestone.inlineReadyMs - milestone.inlineActionMs,
    workbenchOpenMs: milestone.workbenchReadyMs - milestone.workbenchActionMs,
    firstProfileMs: milestone.firstProfileReadyMs - milestone.profileActionMs,
    completeProfileMs: milestone.profilesCompleteMs - milestone.profileActionMs,
    completeTrialPssDeltaBytes: pssSegments?.completeTrial.deltaPssBytes ?? null
  };
}

function completedPairAttempts(manifest, fragments) {
  const groups = groupFragmentsByBlock(fragments, manifest);
  const result = [];
  for (const [blockId, entries] of blockEntries(manifest)) {
    for (let attempt = 0; ; attempt += 1) {
      const group = groups.get(`${blockId}:${attempt}`);
      if (group === undefined || group.size < 2) {
        break;
      }
      const openWrangler = group.get("open-wrangler");
      const dataWrangler = group.get("data-wrangler");
      const invalidCount = [openWrangler, dataWrangler].filter(
        (fragment) => fragment.outcome.status === "pre-action-invalid"
      ).length;
      if (invalidCount === 2) {
        continue;
      }
      if (invalidCount === 1) {
        fail("A pre-action environment invalidation must invalidate both members of the pair.");
      }
      result.push({
        blockId,
        attempt,
        entry: entries[0],
        openWrangler,
        dataWrangler
      });
      break;
    }
  }
  return result;
}

function summarizeCell(cell, attempts) {
  const cellAttempts = attempts.filter((attempt) => attempt.entry.cellId === cell.id && attempt.entry.kind === "warm");
  const metrics = DATA_WRANGLER_STUDY_METRICS.map((metric) => {
    const pairs = [];
    const openWranglerValues = [];
    const dataWranglerValues = [];
    for (const attempt of cellAttempts) {
      const openDurations = trialDurations(attempt.openWrangler);
      const dataDurations = trialDurations(attempt.dataWrangler);
      if (openDurations !== null) {
        if (openDurations[metric.name] !== null) {
          openWranglerValues.push(openDurations[metric.name]);
        }
      }
      if (dataDurations !== null) {
        if (dataDurations[metric.name] !== null) {
          dataWranglerValues.push(dataDurations[metric.name]);
        }
      }
      if (
        openDurations !== null &&
        dataDurations !== null &&
        openDurations[metric.name] !== null &&
        dataDurations[metric.name] !== null
      ) {
        pairs.push({
          pairId: `${attempt.blockId}~a${String(attempt.attempt).padStart(2, "0")}`,
          openWrangler: openDurations[metric.name],
          dataWrangler: dataDurations[metric.name]
        });
      }
    }
    return {
      name: metric.name,
      openWrangler: openWranglerValues.length === 0 ? null : summarizeStudyMetric(openWranglerValues),
      dataWrangler: dataWranglerValues.length === 0 ? null : summarizeStudyMetric(dataWranglerValues),
      pairedRegression: calculatePairedStudyRegression(pairs, {
        absoluteThreshold: metric.threshold,
        allowZero: metric.allowZero
      })
    };
  });
  return {
    cellId: cell.id,
    successfulWarmPairs: metrics[0].pairedRegression.successfulPairCount,
    openWranglerFailures: cellAttempts.filter((attempt) => attempt.openWrangler.outcome.status !== "success").length,
    dataWranglerFailures: cellAttempts.filter((attempt) => attempt.dataWrangler.outcome.status !== "success").length,
    openWranglerFailuresAgainstDataWranglerSuccess: cellAttempts.filter(
      (attempt) =>
        attempt.openWrangler.outcome.status !== "success" && attempt.dataWrangler.outcome.status === "success"
    ).length,
    metrics
  };
}

function summarizeColdTrials(manifest, attempts) {
  const sequenceByEntry = new Map(manifest.schedule.map((entry) => [entry.id, entry.sequence]));
  return attempts
    .filter((attempt) => attempt.entry.kind === "cold")
    .flatMap((attempt) =>
      DATA_WRANGLER_STUDY_PRODUCTS.map((product) => {
        const fragment = product === "open-wrangler" ? attempt.openWrangler : attempt.dataWrangler;
        const entry = manifest.schedule.find((candidate) => candidate.id === fragment.scheduleEntryId);
        const measurements = trialDurations(fragment);
        return {
          scheduleEntryId: entry.id,
          effectiveBlockId: fragment.effectiveBlockId,
          cellId: entry.cellId,
          product,
          orderInPair: entry.orderInPair,
          outcomeStatus: fragment.outcome.status,
          measurements:
            measurements === null
              ? null
              : {
                  loadAndPreviewMs: measurements.inlinePreviewMs,
                  workbenchOpenMs: measurements.workbenchOpenMs,
                  firstProfileMs: measurements.firstProfileMs,
                  completeProfileMs: measurements.completeProfileMs,
                  completeTrialPssDeltaBytes: measurements.completeTrialPssDeltaBytes
                }
        };
      })
    )
    .sort((left, right) => sequenceByEntry.get(left.scheduleEntryId) - sequenceByEntry.get(right.scheduleEntryId));
}

export function buildDataWranglerStudyResult({ manifest, fragments, finalizedAtUtc }) {
  validateDataWranglerStudyManifest(manifest);
  assertString(finalizedAtUtc, ISO_UTC, "Study result timestamp");
  const pending = pendingDataWranglerStudyTrials(manifest, fragments);
  const attempts = completedPairAttempts(manifest, fragments);
  const invalidatedPairAttempts = new Set(
    fragments
      .filter((fragment) => fragment.outcome.status === "pre-action-invalid")
      .map((fragment) => `${fragment.baseBlockId}:${fragment.attempt}`)
  ).size;
  const result = {
    protocol: DATA_WRANGLER_STUDY_RESULT_PROTOCOL,
    manifestSha256: digestStudyValue(manifest),
    finalizedAtUtc,
    fragments: [...fragments]
      .sort((left, right) => {
        const leftSequence = manifest.schedule.find((entry) => entry.id === left.scheduleEntryId).sequence;
        const rightSequence = manifest.schedule.find((entry) => entry.id === right.scheduleEntryId).sequence;
        return leftSequence - rightSequence || left.attempt - right.attempt;
      })
      .map((fragment) => ({
        fragmentId: fragment.fragmentId,
        scheduleEntryId: fragment.scheduleEntryId,
        attempt: fragment.attempt,
        sha256: digestStudyValue(fragment)
      })),
    accounting: {
      plannedTrials: manifest.schedule.length,
      fragmentCount: fragments.length,
      invalidatedPairAttempts,
      pendingTrials: pending.map((entry) => ({
        scheduleEntryId: entry.id,
        attempt: entry.attempt,
        effectiveBlockId: entry.effectiveBlockId
      })),
      allPlannedPairsComplete: pending.length === 0
    },
    cells: DATA_WRANGLER_STUDY_CELLS.map((cell) => summarizeCell(cell, attempts)),
    coldTrials: summarizeColdTrials(manifest, attempts)
  };
  return validateDataWranglerStudyResult(result);
}

function validateMetricSummary(summary, label) {
  if (summary === null) {
    return;
  }
  exactKeys(summary, ["count", "median", "p95"], label);
  assertInteger(summary.count, `${label} count`, { minimum: 1 });
  assertNonNegativeFinite(summary.median, `${label} median`);
  assertNonNegativeFinite(summary.p95, `${label} p95`);
}

function validateRegression(regression, expectedMetric) {
  exactKeys(
    regression,
    [
      "successfulPairCount",
      "requiredPairCount",
      "releaseComplete",
      "positiveDifferenceCount",
      "positiveDifferenceRequired",
      "medianDifference",
      "medianRatio",
      "ratioThreshold",
      "absoluteThreshold",
      "investigationTriggered",
      "pairs"
    ],
    "Study paired regression"
  );
  assertInteger(regression.successfulPairCount, "Study successful pair count");
  assertInteger(regression.requiredPairCount, "Study required pair count", { minimum: 1 });
  assertBoolean(regression.releaseComplete, "Study paired-regression completeness");
  assertInteger(regression.positiveDifferenceCount, "Study positive-difference count");
  assertInteger(regression.positiveDifferenceRequired, "Study required positive-difference count", { minimum: 1 });
  if (
    regression.medianDifference !== null &&
    (typeof regression.medianDifference !== "number" || !Number.isFinite(regression.medianDifference))
  ) {
    fail("Study median paired difference is invalid.");
  }
  if (
    regression.medianRatio !== null &&
    regression.medianRatio !== "positive-infinity" &&
    (typeof regression.medianRatio !== "number" || !Number.isFinite(regression.medianRatio))
  ) {
    fail("Study median paired ratio is invalid.");
  }
  assertNonNegativeFinite(regression.ratioThreshold, "Study paired ratio threshold");
  assertNonNegativeFinite(regression.absoluteThreshold, "Study paired absolute threshold");
  assertBoolean(regression.investigationTriggered, "Study paired investigation result");
  if (!Array.isArray(regression.pairs) || regression.pairs.length !== regression.successfulPairCount) {
    fail("Study paired calculations do not match the successful pair count.");
  }
  if (
    regression.requiredPairCount !== 10 ||
    regression.positiveDifferenceRequired !== 7 ||
    regression.ratioThreshold !== 1.2 ||
    regression.absoluteThreshold !== expectedMetric.threshold
  ) {
    fail("Study paired regression thresholds do not match the preregistered method.");
  }
  const pairIds = new Set();
  const differences = [];
  const ratios = [];
  for (const pair of regression.pairs) {
    exactKeys(pair, ["pairId", "difference", "ratio"], "Study paired calculation");
    if (typeof pair.pairId !== "string" || pair.pairId.length === 0 || pairIds.has(pair.pairId)) {
      fail("Study paired calculation IDs must be non-empty and unique.");
    }
    pairIds.add(pair.pairId);
    if (typeof pair.difference !== "number" || !Number.isFinite(pair.difference)) {
      fail("Study paired difference must be finite.");
    }
    if (
      pair.ratio !== "positive-infinity" &&
      (typeof pair.ratio !== "number" || !Number.isFinite(pair.ratio) || pair.ratio < 0)
    ) {
      fail("Study paired ratio must be non-negative or positive infinity.");
    }
    differences.push(pair.difference);
    ratios.push(pair.ratio === "positive-infinity" ? Number.POSITIVE_INFINITY : pair.ratio);
  }
  const expectedMedianDifference =
    differences.length === 0
      ? null
      : type7QuantileSorted(
          [...differences].sort((left, right) => left - right),
          0.5
        );
  const expectedMedianRatio =
    ratios.length === 0
      ? null
      : encodeRatio(
          type7QuantileSorted(
            [...ratios].sort((left, right) => left - right),
            0.5
          )
        );
  const expectedPositiveCount = differences.filter((difference) => difference > 0).length;
  const decodedMedianRatio =
    expectedMedianRatio === "positive-infinity" ? Number.POSITIVE_INFINITY : expectedMedianRatio;
  const expectedReleaseComplete = regression.successfulPairCount === 10;
  const expectedInvestigation =
    expectedReleaseComplete &&
    expectedPositiveCount >= 7 &&
    decodedMedianRatio >= 1.2 &&
    expectedMedianDifference >= expectedMetric.threshold;
  if (
    regression.releaseComplete !== expectedReleaseComplete ||
    regression.positiveDifferenceCount !== expectedPositiveCount ||
    regression.medianDifference !== expectedMedianDifference ||
    regression.medianRatio !== expectedMedianRatio ||
    regression.investigationTriggered !== expectedInvestigation
  ) {
    fail("Study paired regression summary does not match its retained calculations.");
  }
}

export function validateDataWranglerStudyResult(result) {
  exactKeys(
    result,
    ["protocol", "manifestSha256", "finalizedAtUtc", "fragments", "accounting", "cells", "coldTrials"],
    "Study result"
  );
  if (result.protocol !== DATA_WRANGLER_STUDY_RESULT_PROTOCOL) {
    fail("Study result protocol is invalid.");
  }
  assertString(result.manifestSha256, SHA256, "Study result manifest SHA-256");
  assertString(result.finalizedAtUtc, ISO_UTC, "Study result timestamp");
  if (!Array.isArray(result.fragments)) {
    fail("Study result fragment receipts must be an array.");
  }
  const fragmentIds = new Set();
  for (const receipt of result.fragments) {
    exactKeys(receipt, ["fragmentId", "scheduleEntryId", "attempt", "sha256"], "Study result fragment receipt");
    assertString(receipt.fragmentId, UUID, "Study result fragment ID");
    if (fragmentIds.has(receipt.fragmentId)) {
      fail("Study result fragment IDs must be unique.");
    }
    fragmentIds.add(receipt.fragmentId);
    if (typeof receipt.scheduleEntryId !== "string" || receipt.scheduleEntryId.length === 0) {
      fail("Study result schedule entry ID is invalid.");
    }
    assertInteger(receipt.attempt, "Study result fragment attempt");
    assertString(receipt.sha256, SHA256, "Study result fragment SHA-256");
  }
  exactKeys(
    result.accounting,
    ["plannedTrials", "fragmentCount", "invalidatedPairAttempts", "pendingTrials", "allPlannedPairsComplete"],
    "Study result accounting"
  );
  assertInteger(result.accounting.plannedTrials, "Study planned trial count", { minimum: 1 });
  if (result.accounting.plannedTrials !== createDataWranglerStudySchedule().length) {
    fail("Study result planned trial count does not match the fixed schedule.");
  }
  assertInteger(result.accounting.fragmentCount, "Study fragment count");
  if (result.accounting.fragmentCount !== result.fragments.length) {
    fail("Study result fragment count does not match its immutable receipts.");
  }
  assertInteger(result.accounting.invalidatedPairAttempts, "Study invalidated pair-attempt count");
  assertBoolean(result.accounting.allPlannedPairsComplete, "Study accounting completeness");
  if (!Array.isArray(result.accounting.pendingTrials)) {
    fail("Study pending trials must be an array.");
  }
  const pendingKeys = new Set();
  for (const pending of result.accounting.pendingTrials) {
    exactKeys(pending, ["scheduleEntryId", "attempt", "effectiveBlockId"], "Study pending trial");
    if (typeof pending.scheduleEntryId !== "string" || pending.scheduleEntryId.length === 0) {
      fail("Study pending schedule entry ID is invalid.");
    }
    assertInteger(pending.attempt, "Study pending attempt");
    if (
      typeof pending.effectiveBlockId !== "string" ||
      !pending.effectiveBlockId.endsWith(`~a${String(pending.attempt).padStart(2, "0")}`)
    ) {
      fail("Study pending effective block ID is invalid.");
    }
    const key = `${pending.scheduleEntryId}:${pending.attempt}`;
    if (pendingKeys.has(key)) {
      fail("Study pending trials must be unique.");
    }
    pendingKeys.add(key);
  }
  if (result.accounting.allPlannedPairsComplete !== (result.accounting.pendingTrials.length === 0)) {
    fail("Study result completeness does not match its pending work.");
  }
  if (!Array.isArray(result.cells) || result.cells.length !== DATA_WRANGLER_STUDY_CELLS.length) {
    fail("Study result must contain the four preregistered cells.");
  }
  result.cells.forEach((cell, index) => {
    exactKeys(
      cell,
      [
        "cellId",
        "successfulWarmPairs",
        "openWranglerFailures",
        "dataWranglerFailures",
        "openWranglerFailuresAgainstDataWranglerSuccess",
        "metrics"
      ],
      "Study cell result"
    );
    if (cell.cellId !== DATA_WRANGLER_STUDY_CELLS[index].id) {
      fail("Study result cell order is invalid.");
    }
    for (const key of [
      "successfulWarmPairs",
      "openWranglerFailures",
      "dataWranglerFailures",
      "openWranglerFailuresAgainstDataWranglerSuccess"
    ]) {
      assertInteger(cell[key], `Study cell ${key}`);
    }
    if (
      cell.successfulWarmPairs > 10 ||
      cell.openWranglerFailures > 10 ||
      cell.dataWranglerFailures > 10 ||
      cell.openWranglerFailuresAgainstDataWranglerSuccess > cell.openWranglerFailures
    ) {
      fail("Study cell counts exceed the ten planned warm pairs.");
    }
    if (!Array.isArray(cell.metrics) || cell.metrics.length !== DATA_WRANGLER_STUDY_METRICS.length) {
      fail("Study cell result must contain every preregistered metric.");
    }
    cell.metrics.forEach((metric, metricIndex) => {
      exactKeys(metric, ["name", "openWrangler", "dataWrangler", "pairedRegression"], "Study metric result");
      if (metric.name !== DATA_WRANGLER_STUDY_METRICS[metricIndex].name) {
        fail("Study metric order is invalid.");
      }
      validateMetricSummary(metric.openWrangler, "Open Wrangler metric summary");
      validateMetricSummary(metric.dataWrangler, "Data Wrangler metric summary");
      validateRegression(metric.pairedRegression, DATA_WRANGLER_STUDY_METRICS[metricIndex]);
    });
    if (cell.metrics[0].pairedRegression.successfulPairCount !== cell.successfulWarmPairs) {
      fail("Study cell successful-pair count does not match its latency calculations.");
    }
  });
  if (!Array.isArray(result.coldTrials) || result.coldTrials.length > 16) {
    fail("Study result cold trials must fit the eight planned descriptive pairs.");
  }
  const coldEntries = new Set();
  for (const trial of result.coldTrials) {
    exactKeys(
      trial,
      ["scheduleEntryId", "effectiveBlockId", "cellId", "product", "orderInPair", "outcomeStatus", "measurements"],
      "Study cold trial"
    );
    if (
      typeof trial.scheduleEntryId !== "string" ||
      trial.scheduleEntryId.length === 0 ||
      coldEntries.has(trial.scheduleEntryId)
    ) {
      fail("Study cold trial schedule entries must be non-empty and unique.");
    }
    coldEntries.add(trial.scheduleEntryId);
    if (typeof trial.effectiveBlockId !== "string" || trial.effectiveBlockId.length === 0) {
      fail("Study cold trial effective block ID is invalid.");
    }
    assertEnum(
      trial.cellId,
      DATA_WRANGLER_STUDY_CELLS.map((cell) => cell.id),
      "Study cold trial cell"
    );
    assertEnum(trial.product, DATA_WRANGLER_STUDY_PRODUCTS, "Study cold trial product");
    if (trial.orderInPair !== 1 && trial.orderInPair !== 2) {
      fail("Study cold trial product order is invalid.");
    }
    assertEnum(trial.outcomeStatus, ["success", "product-failure", "pre-action-invalid"], "Study cold trial outcome");
    if (trial.measurements !== null) {
      exactKeys(
        trial.measurements,
        ["loadAndPreviewMs", "workbenchOpenMs", "firstProfileMs", "completeProfileMs", "completeTrialPssDeltaBytes"],
        "Study cold trial measurements"
      );
      for (const key of ["loadAndPreviewMs", "workbenchOpenMs", "firstProfileMs", "completeProfileMs"]) {
        assertNonNegativeFinite(trial.measurements[key], `Study cold trial ${key}`);
      }
      if (trial.measurements.completeTrialPssDeltaBytes !== null) {
        assertNonNegativeFinite(
          trial.measurements.completeTrialPssDeltaBytes,
          "Study cold trial complete-trial PSS delta"
        );
      }
    }
  }
  return result;
}

export function createEmptyStudyMilestones() {
  return Object.fromEntries(MILESTONE_KEYS.map((key) => [key, null]));
}

export function createStudyFragmentIdentity({ manifest, scheduleEntry, attempt = 0, recordedAtUtc }) {
  return {
    protocol: DATA_WRANGLER_STUDY_FRAGMENT_PROTOCOL,
    fragmentId: randomUUID(),
    manifestSha256: digestStudyValue(manifest),
    scheduleEntryId: scheduleEntry.id,
    baseBlockId: scheduleEntry.blockId,
    attempt,
    effectiveBlockId: `${scheduleEntry.blockId}~a${String(attempt).padStart(2, "0")}`,
    product: scheduleEntry.product,
    recordedAtUtc
  };
}

export const DATA_WRANGLER_STUDY_RESOURCE_CATEGORIES = RESOURCE_CATEGORIES;
