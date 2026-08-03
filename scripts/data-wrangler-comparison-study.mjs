import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  readdirSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicUiReceiptContext,
  validateDataWranglerPolarsCapabilityReceipt,
  validateNeitherProductControlReceipt
} from "./data-wrangler-public-ui-receipts.mjs";
import { DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY } from "./data-wrangler-comparison-driver-contract.mjs";
import {
  DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS,
  createDataWranglerComparisonMeasuredInventory
} from "./data-wrangler-comparison-inventory.mjs";
import {
  DATA_WRANGLER_COMPARISON_CACHE_CONTROLLER_PROTOCOL,
  DATA_WRANGLER_COMPARISON_CACHE_TOOLCHAIN_PROTOCOL
} from "./data-wrangler-comparison-cache-controller.mjs";
import { DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL } from "./data-wrangler-comparison-source-copy.mjs";
import {
  DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL,
  DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL,
  validateDataWranglerStudyBridgeAcknowledgement,
  validateDataWranglerStudyBridgeRequest
} from "./data-wrangler-study-control-bridge.mjs";
import {
  digestDurableJsonValue,
  publishDurableStudyJsonExclusive,
  recoverDurableStudyJsonPublication
} from "./durable-study-json.mjs";

export const DATA_WRANGLER_STUDY_METHOD_PROTOCOL = "openwrangler-data-wrangler-study-method-v1";
export const DATA_WRANGLER_STUDY_MANIFEST_PROTOCOL = "openwrangler-data-wrangler-study-manifest-v2";
export const DATA_WRANGLER_STUDY_FRAGMENT_PROTOCOL = "openwrangler-data-wrangler-study-fragment-v2";
export const DATA_WRANGLER_STUDY_RESULT_PROTOCOL = "openwrangler-data-wrangler-study-result-v2";
export const DATA_WRANGLER_STUDY_RESOURCE_PROTOCOL = "openwrangler-linux-pss-observation-v1";
export const DATA_WRANGLER_STUDY_SEED = 0x4f575231;
export const DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL = 10;
export const DATA_WRANGLER_STUDY_SCHEDULE_SHA256 = "3fcf79fa323c60e256fddaf62c0a1454ea2077c5b6158ba93e1dfddd43adaa64";
export const DATA_WRANGLER_STUDY_SOURCE_CACHE_PROTOCOL = "openwrangler-source-cache-proof-study-v2";
export const DATA_WRANGLER_STUDY_FINALIZATION_INTENT_PROTOCOL =
  "openwrangler-data-wrangler-study-finalization-intent-v1";
export const DATA_WRANGLER_STUDY_TRIAL_INTENT_PROTOCOL = "openwrangler-data-wrangler-study-trial-intent-v1";
export const DATA_WRANGLER_STUDY_METHOD_PATH = fileURLToPath(
  new URL("../docs/performance-comparison.md", import.meta.url)
);

export const DATA_WRANGLER_STUDY_PRODUCTS = Object.freeze(["open-wrangler", "data-wrangler"]);
const DATA_WRANGLER_STUDY_WARMUP_BRIDGE_KINDS = Object.freeze([
  "source-verified",
  "measurement-ready",
  "sampling-origin",
  "inline-baseline",
  "workbench-baseline",
  "profile-baseline",
  "sampling-stop",
  "cleanup-census"
]);
export const DATA_WRANGLER_STUDY_DEADLINES_MS = Object.freeze({
  "inline-preview": 45_000,
  "workbench-open": 60_000,
  "complete-profile": 135_000
});
export const DATA_WRANGLER_STUDY_CONTROL_ALLOWANCE_MS = 3_000;
export const DATA_WRANGLER_STUDY_MAXIMUM_RESOURCE_SAMPLES =
  Math.ceil(
    (Object.values(DATA_WRANGLER_STUDY_DEADLINES_MS).reduce((total, value) => total + value, 0) +
      DATA_WRANGLER_STUDY_CONTROL_ALLOWANCE_MS +
      2_000 +
      250) /
      200
  ) + 1;
export const DATA_WRANGLER_STUDY_COMMON_EXTENSIONS = DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS;
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
export const DATA_WRANGLER_STUDY_DESCRIPTIVE_METRICS = Object.freeze([
  "firstProfileFromWorkbenchClickMs",
  "completeProfileFromWorkbenchClickMs"
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
const PACKAGE_VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,126}[0-9A-Za-z])?$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MONOTONIC_NANOSECONDS = /^(?:0|[1-9]\d{0,29})$/u;
const FRAGMENT_FILE = /^(?<entry>[a-z0-9-]+)\.attempt-(?<attempt>\d{2})\.json$/u;
const TRIAL_INTENT_FILE =
  /^(?<runId>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?<stage>prepared|action-authorized)\.intent$/iu;
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
const PSS_CLOCK_SOURCE = "linux-process-hrtime-bigint";
const PSS_CLOCK_NORMALIZATION = "elapsedMs=(endedMonotonicNanoseconds-originNanoseconds)/1000000";
const PSS_OWNERSHIP_PROTOCOL = "openwrangler-linux-study-supervisor-v1";
const PSS_MAXIMUM_LATENESS_MS = 50;
const PSS_MAXIMUM_TERMINAL_OVERSHOOT_MS = 250;
const REQUIRED_PYTHON_PACKAGES = Object.freeze(["pandas", "polars", "pyarrow", "jupyter_core", "ipykernel"]);
const ENVIRONMENT_GATE_PROTOCOL = "openwrangler-linux-data-wrangler-study-gate-v1";
const ENVIRONMENT_PROVENANCE_PROTOCOL = "openwrangler-linux-data-wrangler-study-provenance-v1";
const ENVIRONMENT_SELECTION_POLICY = "accept the first complete passing window and retain every attempted window";
const ENVIRONMENT_FAILURE_CODES = Object.freeze([
  "sampling-unavailable",
  "sample-timing",
  "provenance-drift",
  "cpu-mean",
  "cpu-window",
  "cpu-pressure",
  "memory-pressure",
  "swap-activity",
  "thermal-throttle",
  "ac-power-drift",
  "governor-drift",
  "affinity-drift"
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

function assertPositiveFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive finite number.`);
  }
}

function assertBoundedText(value, label, maximum = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    fail(`${label} must be bounded single-line text.`);
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

export function captureDataWranglerStudyMethodReceipt(path = DATA_WRANGLER_STUDY_METHOD_PATH) {
  const target = resolve(path);
  let descriptor;
  try {
    const before = lstatSync(target, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      !currentUserOwns(before) ||
      before.size < 1n ||
      before.size > 2n * 1024n * 1024n
    ) {
      fail("Study methodology must be one owned, singly linked Markdown file within 2 MiB.");
    }
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFilesystemIdentity(before, opened) || before.size !== opened.size || before.mtimeNs !== opened.mtimeNs) {
      fail("Study methodology changed while it opened.");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(target, { bigint: true });
    if (
      bytes.length !== Number(opened.size) ||
      !sameFilesystemIdentity(opened, after) ||
      !sameFilesystemIdentity(after, namedAfter) ||
      opened.size !== after.size ||
      after.size !== namedAfter.size ||
      opened.mtimeNs !== after.mtimeNs ||
      after.mtimeNs !== namedAfter.mtimeNs
    ) {
      fail("Study methodology changed while it was hashed.");
    }
    return Object.freeze({
      protocol: DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateCandidate(candidate) {
  exactKeys(candidate, ["extensionId", "version", "sha256", "filesystemIdentity"], "Open Wrangler candidate receipt");
  if (candidate.extensionId !== "Matt17BR.openwrangler") {
    fail("Open Wrangler candidate extension ID is invalid.");
  }
  assertString(candidate.version, NUMERIC_VERSION, "Open Wrangler candidate version");
  assertString(candidate.sha256, SHA256, "Open Wrangler candidate SHA-256");
  validateFilesystemIdentity(candidate.filesystemIdentity, "Open Wrangler candidate filesystem identity");
}

function validateBaseline(baseline) {
  exactKeys(baseline, ["extensionId", "version"], "Data Wrangler baseline receipt");
  if (baseline.extensionId !== "ms-toolsai.datawrangler" || baseline.version !== "1.24.2") {
    fail("Data Wrangler baseline must be the official ms-toolsai.datawrangler 1.24.2 installation.");
  }
}

function validateEditor(editor) {
  exactKeys(editor, ["id", "version", "sha256", "uiLocale"], "Study editor receipt");
  if (editor.id !== "Microsoft.VisualStudioCode" || editor.uiLocale !== "en") {
    fail("Study editor must be official Microsoft Visual Studio Code launched with --locale=en.");
  }
  assertString(editor.version, NUMERIC_VERSION, "Study editor version");
  assertString(editor.sha256, SHA256, "Study editor SHA-256");
}

function validatePython(python) {
  exactKeys(
    python,
    ["implementation", "version", "executableSha256", "environmentSha256", "packages", "kernel"],
    "Study Python receipt"
  );
  if (python.implementation !== "CPython") {
    fail("Study Python implementation must be CPython.");
  }
  assertString(python.version, PYTHON_VERSION, "Study Python version");
  assertString(python.executableSha256, SHA256, "Study Python executable SHA-256");
  assertString(python.environmentSha256, SHA256, "Study Python environment SHA-256");
  if (!Array.isArray(python.packages) || python.packages.length !== REQUIRED_PYTHON_PACKAGES.length) {
    fail("Study Python package inventory is incomplete.");
  }
  python.packages.forEach((item, index) => {
    exactKeys(item, ["name", "version"], "Study Python package receipt");
    if (item.name !== REQUIRED_PYTHON_PACKAGES[index]) {
      fail("Study Python package inventory order is invalid.");
    }
    assertString(item.version, PACKAGE_VERSION, `Study Python ${item.name} version`);
  });
  exactKeys(
    python.kernel,
    ["implementation", "version", "kernelspecName", "kernelspecSha256"],
    "Study configured-kernel receipt"
  );
  if (python.kernel.implementation !== "ipykernel") {
    fail("Study configured kernel must use ipykernel.");
  }
  assertString(python.kernel.version, PACKAGE_VERSION, "Study configured-kernel version");
  const ipykernel = python.packages.find((item) => item.name === "ipykernel");
  if (python.kernel.version !== ipykernel.version) {
    fail("Study configured-kernel version must match the pinned ipykernel package.");
  }
  assertBoundedText(python.kernel.kernelspecName, "Study kernelspec name", 128);
  assertString(python.kernel.kernelspecSha256, SHA256, "Study kernelspec SHA-256");
}

function validateFilesystemIdentity(identity, label) {
  exactKeys(identity, ["device", "inode", "sizeBytes", "mtimeNs"], label);
  for (const [key, part] of [
    ["device", "device"],
    ["inode", "inode"],
    ["mtimeNs", "modification time"]
  ]) {
    if (typeof identity[key] !== "string" || !/^\d+$/u.test(identity[key])) {
      fail(`${label} ${part} is invalid.`);
    }
  }
  assertInteger(identity.sizeBytes, `${label} size`, { minimum: 1 });
}

function validateImmutableFileReceipt(receipt, label) {
  exactKeys(receipt, ["sha256", "filesystemIdentity"], label);
  assertString(receipt.sha256, SHA256, `${label} SHA-256`);
  validateFilesystemIdentity(receipt.filesystemIdentity, `${label} filesystem identity`);
}

function validateCacheToolchain(toolchain, python) {
  exactKeys(toolchain, ["protocol", "controller", "pythonExecutable"], "Study source-cache toolchain provenance");
  if (toolchain.protocol !== DATA_WRANGLER_COMPARISON_CACHE_TOOLCHAIN_PROTOCOL) {
    fail("Study source-cache toolchain protocol is invalid.");
  }
  validateImmutableFileReceipt(toolchain.controller, "Study source-cache controller");
  exactKeys(
    toolchain.pythonExecutable,
    ["implementation", "version", "sha256", "filesystemIdentity"],
    "Study source-cache Python executable"
  );
  if (
    toolchain.pythonExecutable.implementation !== "CPython" ||
    toolchain.pythonExecutable.version !== python.version ||
    toolchain.pythonExecutable.sha256 !== python.executableSha256
  ) {
    fail("Study source-cache Python does not match the manifest-pinned interpreter.");
  }
  validateFilesystemIdentity(
    toolchain.pythonExecutable.filesystemIdentity,
    "Study source-cache Python filesystem identity"
  );
}

function expectedFixtureSentinels(rows, columns) {
  return [
    { rowIndex: 0, column: "c00", value: 0 },
    { rowIndex: 1, column: "c01", value: 2 },
    {
      rowIndex: rows - 1,
      column: `c${String(columns - 1).padStart(2, "0")}`,
      value: rows - 1 + columns - 1
    }
  ];
}

function validateFixtureSchema(schema, columns, label) {
  if (!Array.isArray(schema) || schema.length !== columns) {
    fail(`${label} must contain every ordered fixture column.`);
  }
  schema.forEach((column, index) => {
    exactKeys(column, ["name", "dtype"], `${label} column`);
    if (column.name !== `c${String(index).padStart(2, "0")}` || column.dtype !== "int64") {
      fail(`${label} must match the exact ordered Int64 fixture schema.`);
    }
  });
}

function validateFixtureSentinels(sentinels, rows, columns, label) {
  if (
    !Array.isArray(sentinels) ||
    canonicalStudyJson(sentinels) !== canonicalStudyJson(expectedFixtureSentinels(rows, columns))
  ) {
    fail(`${label} must contain the three registered fixture sentinels.`);
  }
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
    exactKeys(
      fixture,
      ["id", "format", "rows", "columns", "sha256", "filesystemIdentity", "schema", "sentinels"],
      "Study fixture receipt"
    );
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
    validateFilesystemIdentity(fixture.filesystemIdentity, "Study fixture filesystem identity");
    validateFixtureSchema(fixture.schema, fixture.columns, "Study fixture schema");
    validateFixtureSentinels(fixture.sentinels, fixture.rows, fixture.columns, "Study fixture sentinels");
    expected.delete(fixture.id);
  }
  if (expected.size !== 0) {
    fail("Study fixture set is incomplete.");
  }
}

function validateFixtureToolchain(toolchain, python) {
  exactKeys(
    toolchain,
    ["protocol", "contractVersion", "implementation", "implementationVersion", "generatorSha256", "contractSha256"],
    "Study fixture toolchain provenance"
  );
  const polars = python.packages.find((entry) => entry.name === "polars");
  if (
    toolchain.protocol !== "openwrangler-performance-fixture-toolchain-v1" ||
    toolchain.contractVersion !== 1 ||
    toolchain.implementation !== "polars" ||
    toolchain.implementationVersion !== polars?.version
  ) {
    fail("Study fixture toolchain does not match the manifest-pinned Polars environment.");
  }
  assertString(toolchain.generatorSha256, SHA256, "Study fixture generator SHA-256");
  assertString(toolchain.contractSha256, SHA256, "Study fixture contract SHA-256");
}

function validateStudyMachine(machine) {
  exactKeys(
    machine,
    ["platform", "architecture", "osRelease", "kernelRelease", "machineIdSha256", "totalMemoryBytes"],
    "Study machine provenance"
  );
  if (machine.platform !== "linux" || machine.architecture !== "x64") {
    fail("Study machine must be the preregistered Linux x64 platform.");
  }
  assertBoundedText(machine.osRelease, "Study operating-system release");
  assertBoundedText(machine.kernelRelease, "Study kernel release", 128);
  assertString(machine.machineIdSha256, SHA256, "Study path-free machine identity");
  assertInteger(machine.totalMemoryBytes, "Study machine memory", { minimum: 1 });
}

function validateStudyCpu(cpu) {
  exactKeys(
    cpu,
    ["vendorId", "model", "logicalProcessorCount", "onlineCpuList", "affinity", "governors"],
    "Study CPU provenance"
  );
  assertBoundedText(cpu.vendorId, "Study CPU vendor ID", 64);
  assertBoundedText(cpu.model, "Study CPU model");
  assertBoundedText(cpu.onlineCpuList, "Study online CPU list", 128);
  assertInteger(cpu.logicalProcessorCount, "Study logical processor count", { minimum: 1 });
  const onlineCpus = parseLinuxCpuList(cpu.onlineCpuList, "Study online CPU list");
  if (onlineCpus.length > cpu.logicalProcessorCount) {
    fail("Study online CPU list exceeds the logical processor count.");
  }
  if (!Array.isArray(cpu.affinity) || cpu.affinity.length === 0) {
    fail("Study CPU affinity must contain at least one processor.");
  }
  const affinity = new Set();
  for (const processor of cpu.affinity) {
    assertInteger(processor, "Study CPU affinity processor");
    if (processor >= cpu.logicalProcessorCount || !onlineCpus.includes(processor) || affinity.has(processor)) {
      fail("Study CPU affinity processors must be unique and inside the machine topology.");
    }
    affinity.add(processor);
  }
  if (!Array.isArray(cpu.governors) || cpu.governors.length !== cpu.affinity.length) {
    fail("Study CPU governors must cover the exact affinity set.");
  }
  cpu.governors.forEach((governor, index) => {
    exactKeys(governor, ["processor", "governor"], "Study CPU governor");
    if (governor.processor !== cpu.affinity[index]) {
      fail("Study CPU governor order must match the immutable affinity order.");
    }
    assertBoundedText(governor.governor, "Study CPU governor", 64);
  });
}

function validateStudyDisplay(display) {
  exactKeys(display, ["mode", "widthPx", "heightPx", "deviceScaleFactor", "colorDepth"], "Study display provenance");
  if (display.mode !== "headless-ozone") {
    fail("Study display must use zero-window headless Ozone.");
  }
  assertInteger(display.widthPx, "Study display width", { minimum: 1 });
  assertInteger(display.heightPx, "Study display height", { minimum: 1 });
  assertPositiveFinite(display.deviceScaleFactor, "Study display scale factor");
  assertInteger(display.colorDepth, "Study display color depth", { minimum: 1 });
}

function validateStudyZoom(zoom) {
  exactKeys(
    zoom,
    ["level", "theme", "viewportWidthPx", "viewportHeightPx", "rowPageSize", "notebookLayoutSha256"],
    "Study zoom and layout provenance"
  );
  if (typeof zoom.level !== "number" || !Number.isFinite(zoom.level)) {
    fail("Study zoom level must be finite.");
  }
  assertBoundedText(zoom.theme, "Study theme", 128);
  assertInteger(zoom.viewportWidthPx, "Study viewport width", { minimum: 1 });
  assertInteger(zoom.viewportHeightPx, "Study viewport height", { minimum: 1 });
  assertInteger(zoom.rowPageSize, "Study row-page size", { minimum: 1 });
  assertString(zoom.notebookLayoutSha256, SHA256, "Study notebook-layout SHA-256");
}

function validateStudyCommonExtensions(extensions) {
  if (!Array.isArray(extensions) || extensions.length !== DATA_WRANGLER_STUDY_COMMON_EXTENSIONS.length) {
    fail("Study common-extension inventory is incomplete.");
  }
  extensions.forEach((extension, index) => {
    exactKeys(extension, ["extensionId", "version"], "Study common extension");
    const expected = DATA_WRANGLER_STUDY_COMMON_EXTENSIONS[index];
    if (extension.extensionId !== expected.extensionId || extension.version !== expected.version) {
      fail("Study common-extension inventory does not match the preregistered lock.");
    }
    assertString(extension.version, PACKAGE_VERSION, "Study common-extension version");
  });
}

function validateComparisonDriverReceipt(receipt) {
  exactKeys(
    receipt,
    ["extensionId", "version", "vsix", "packageFiles", "runtimeDependencies", "journeyGraph"],
    "Study comparison driver"
  );
  if (
    receipt.extensionId !== DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY.extensionId ||
    receipt.version !== DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY.version
  ) {
    fail("Study comparison driver identity does not match the preregistered lock.");
  }
  exactKeys(receipt.vsix, ["sha256", "filesystemIdentity", "archive"], "Study comparison-driver VSIX");
  assertString(receipt.vsix.sha256, SHA256, "Study comparison-driver VSIX SHA-256");
  validateFilesystemIdentity(receipt.vsix.filesystemIdentity, "Study comparison-driver VSIX filesystem identity");
  exactKeys(
    receipt.packageFiles,
    ["packageJsonSha256", "extensionSourceSha256"],
    "Study comparison-driver package files"
  );
  assertString(receipt.packageFiles.packageJsonSha256, SHA256, "Study comparison-driver package.json SHA-256");
  assertString(receipt.packageFiles.extensionSourceSha256, SHA256, "Study comparison-driver extension.js SHA-256");
  exactKeys(receipt.runtimeDependencies, ["playwrightCore"], "Study comparison-driver runtime dependencies");
  exactKeys(
    receipt.runtimeDependencies.playwrightCore,
    ["version", "fileCount", "totalBytes", "treeSha256", "lockIntegrity", "files"],
    "Study comparison-driver Playwright Core runtime"
  );
  assertString(
    receipt.runtimeDependencies.playwrightCore.version,
    PACKAGE_VERSION,
    "Study comparison-driver Playwright Core version"
  );
  assertInteger(receipt.runtimeDependencies.playwrightCore.fileCount, "Study comparison-driver Playwright file count", {
    minimum: 1
  });
  assertInteger(
    receipt.runtimeDependencies.playwrightCore.totalBytes,
    "Study comparison-driver Playwright byte count",
    {
      minimum: 1
    }
  );
  if (
    receipt.runtimeDependencies.playwrightCore.fileCount > 256 ||
    receipt.runtimeDependencies.playwrightCore.totalBytes > 32 * 1024 * 1024 ||
    typeof receipt.runtimeDependencies.playwrightCore.lockIntegrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(receipt.runtimeDependencies.playwrightCore.lockIntegrity)
  ) {
    fail("Study comparison-driver Playwright Core runtime exceeds its fixed lock bounds.");
  }
  assertString(
    receipt.runtimeDependencies.playwrightCore.treeSha256,
    SHA256,
    "Study comparison-driver Playwright tree SHA-256"
  );
  if (
    !Array.isArray(receipt.runtimeDependencies.playwrightCore.files) ||
    receipt.runtimeDependencies.playwrightCore.files.length !== receipt.runtimeDependencies.playwrightCore.fileCount
  ) {
    fail("Study comparison-driver Playwright receipt must enumerate every file.");
  }
  let previousPlaywrightPath = "";
  const playwrightPaths = new Set();
  for (const file of receipt.runtimeDependencies.playwrightCore.files) {
    exactKeys(file, ["path", "sha256"], "Study comparison-driver Playwright file");
    if (
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      file.path.length > 512 ||
      /[\\\0\r\n]/u.test(file.path) ||
      file.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      file.path <= previousPlaywrightPath ||
      playwrightPaths.has(file.path)
    ) {
      fail("Study comparison-driver Playwright files must be unique, sorted, and relative.");
    }
    assertString(file.sha256, SHA256, "Study comparison-driver Playwright file SHA-256");
    playwrightPaths.add(file.path);
    previousPlaywrightPath = file.path;
  }
  const expectedPlaywrightTreeSha256 = createHash("sha256")
    .update(JSON.stringify(receipt.runtimeDependencies.playwrightCore.files), "utf8")
    .digest("hex");
  if (receipt.runtimeDependencies.playwrightCore.treeSha256 !== expectedPlaywrightTreeSha256) {
    fail("Study comparison-driver Playwright tree SHA-256 does not match its file list.");
  }
  exactKeys(
    receipt.journeyGraph,
    ["entry", "moduleCount", "totalBytes", "graphSha256", "modules"],
    "Study comparison-driver journey graph"
  );
  if (receipt.journeyGraph.entry !== "test/extensionHost/dataWranglerComparisonNotebookTrial.js") {
    fail("Study comparison-driver journey graph has the wrong entrypoint.");
  }
  assertInteger(receipt.journeyGraph.moduleCount, "Study comparison-driver module count", { minimum: 1 });
  assertInteger(receipt.journeyGraph.totalBytes, "Study comparison-driver graph byte count", { minimum: 1 });
  if (
    receipt.journeyGraph.moduleCount > 64 ||
    receipt.journeyGraph.totalBytes > 2 * 1024 * 1024 ||
    !Array.isArray(receipt.journeyGraph.modules) ||
    receipt.journeyGraph.modules.length !== receipt.journeyGraph.moduleCount
  ) {
    fail("Study comparison-driver journey graph exceeds its fixed bounds.");
  }
  const paths = new Set();
  let previousPath = "";
  for (const module of receipt.journeyGraph.modules) {
    exactKeys(module, ["path", "sha256"], "Study comparison-driver module");
    if (
      typeof module.path !== "string" ||
      module.path.length === 0 ||
      module.path.length > 256 ||
      /[\\\0\r\n]/u.test(module.path) ||
      module.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      (!module.path.startsWith("test/extensionHost/") && !module.path.startsWith("shared/")) ||
      module.path === "test/extensionHost/index.js" ||
      module.path <= previousPath ||
      paths.has(module.path)
    ) {
      fail("Study comparison-driver modules must be unique, sorted, and inside neutral roots.");
    }
    assertString(module.sha256, SHA256, "Study comparison-driver module SHA-256");
    paths.add(module.path);
    previousPath = module.path;
  }
  if (!paths.has(receipt.journeyGraph.entry)) {
    fail("Study comparison-driver graph omits its entrypoint.");
  }
  assertString(receipt.journeyGraph.graphSha256, SHA256, "Study comparison-driver graph SHA-256");
  const expectedGraphSha256 = createHash("sha256")
    .update(
      JSON.stringify(receipt.journeyGraph.modules.map((module) => ({ path: module.path, sha256: module.sha256 }))),
      "utf8"
    )
    .digest("hex");
  if (receipt.journeyGraph.graphSha256 !== expectedGraphSha256) {
    fail("Study comparison-driver graph SHA-256 does not match its complete module list.");
  }
  exactKeys(
    receipt.vsix.archive,
    ["entryCount", "totalUncompressedBytes", "inventorySha256", "entries"],
    "Study comparison-driver archive"
  );
  assertInteger(receipt.vsix.archive.entryCount, "Study comparison-driver archive entry count", { minimum: 1 });
  assertInteger(receipt.vsix.archive.totalUncompressedBytes, "Study comparison-driver archive byte count", {
    minimum: 1
  });
  if (
    receipt.vsix.archive.entryCount > 324 ||
    receipt.vsix.archive.totalUncompressedBytes > 32 * 1024 * 1024 ||
    !Array.isArray(receipt.vsix.archive.entries) ||
    receipt.vsix.archive.entries.length !== receipt.vsix.archive.entryCount
  ) {
    fail("Study comparison-driver archive exceeds its fixed inventory bounds.");
  }
  let previousArchivePath = "";
  const archiveByPath = new Map();
  for (const entry of receipt.vsix.archive.entries) {
    exactKeys(entry, ["path", "sha256"], "Study comparison-driver archive entry");
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > 512 ||
      entry.path.startsWith("/") ||
      /[\\\0\r\n]/u.test(entry.path) ||
      entry.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      entry.path <= previousArchivePath ||
      archiveByPath.has(entry.path)
    ) {
      fail("Study comparison-driver archive entries must be unique, sorted, and relative.");
    }
    assertString(entry.sha256, SHA256, "Study comparison-driver archive entry SHA-256");
    archiveByPath.set(entry.path, entry.sha256);
    previousArchivePath = entry.path;
  }
  assertString(receipt.vsix.archive.inventorySha256, SHA256, "Study comparison-driver archive inventory SHA-256");
  const expectedInventorySha256 = createHash("sha256")
    .update(JSON.stringify(receipt.vsix.archive.entries), "utf8")
    .digest("hex");
  if (receipt.vsix.archive.inventorySha256 !== expectedInventorySha256) {
    fail("Study comparison-driver archive inventory SHA-256 does not match its entries.");
  }
  const expectedArchiveEntries = new Map([
    ["extension/package.json", receipt.packageFiles.packageJsonSha256],
    ["extension/extension.js", receipt.packageFiles.extensionSourceSha256],
    ...receipt.journeyGraph.modules.map((module) => [`extension/journey/${module.path}`, module.sha256]),
    ...receipt.runtimeDependencies.playwrightCore.files.map((file) => [
      `extension/node_modules/playwright-core/${file.path}`,
      file.sha256
    ])
  ]);
  if (
    archiveByPath.size !== expectedArchiveEntries.size + 2 ||
    !archiveByPath.has("[Content_Types].xml") ||
    !archiveByPath.has("extension.vsixmanifest") ||
    [...expectedArchiveEntries].some(([path, sha256]) => archiveByPath.get(path) !== sha256)
  ) {
    fail("Study comparison-driver archive does not exactly match its package, journey, and Playwright receipts.");
  }
}

function validateStudyTemplates(templates, manifestContext) {
  if (!Array.isArray(templates) || templates.length !== DATA_WRANGLER_STUDY_PRODUCTS.length) {
    fail("Study template provenance must contain both measured products.");
  }
  templates.forEach((template, index) => {
    exactKeys(
      template,
      [
        "product",
        "configuredOnlyReceiptSha256",
        "warmedReceiptSha256",
        "warmupReceiptSha256",
        "warmupReceipt",
        "publicConfigurationCompleted",
        "publicWarmupCompleted",
        "targetStateAbsent"
      ],
      "Study template provenance"
    );
    if (template.product !== DATA_WRANGLER_STUDY_PRODUCTS[index]) {
      fail("Study template provenance order is invalid.");
    }
    assertString(template.configuredOnlyReceiptSha256, SHA256, "Configured-only template receipt SHA-256");
    assertString(template.warmedReceiptSha256, SHA256, "Warmed template receipt SHA-256");
    assertString(template.warmupReceiptSha256, SHA256, "Public warm-up receipt SHA-256");
    if (template.warmupReceiptSha256 !== digestStudyValue(template.warmupReceipt)) {
      fail("Study public warm-up receipt digest does not match its retained evidence.");
    }
    const warmup = template.warmupReceipt;
    exactKeys(
      warmup,
      [
        "protocol",
        "product",
        "untimed",
        "locale",
        "editorVersion",
        "study",
        "milestones",
        "profiles",
        "controlBridge",
        "cleanup"
      ],
      "Study public warm-up receipt"
    );
    if (
      warmup.protocol !== "openwrangler-data-wrangler-public-warmup-phase-v1" ||
      warmup.product !== template.product ||
      warmup.untimed !== true ||
      warmup.locale !== manifestContext.editor.uiLocale ||
      warmup.editorVersion !== manifestContext.editor.version
    ) {
      fail("Study public warm-up receipt does not match its measured product and editor.");
    }
    exactKeys(
      warmup.study,
      ["engine", "format", "kind", "fixture", "kernel", "sourceReceipt", "pythonImplementation", "pythonVersion"],
      "Study public warm-up definition"
    );
    const csvFixture = manifestContext.fixtures.find((fixture) => fixture.format === "csv");
    if (
      warmup.study.engine !== "polars" ||
      warmup.study.format !== "csv" ||
      warmup.study.kind !== "warm" ||
      warmup.study.pythonImplementation !== manifestContext.python.implementation ||
      warmup.study.pythonVersion !== manifestContext.python.version ||
      canonicalStudyJson(warmup.study.fixture) !==
        canonicalStudyJson({
          id: csvFixture?.id,
          sha256: csvFixture?.sha256,
          rows: csvFixture?.rows,
          columns: csvFixture?.columns
        }) ||
      warmup.study.kernel?.name !== manifestContext.python.kernel.kernelspecName ||
      warmup.study.sourceReceipt?.sha256 !== csvFixture?.sha256
    ) {
      fail("Study public warm-up did not use the exact Polars CSV fixture and private CPython kernel.");
    }
    exactKeys(
      warmup.milestones,
      [
        "inlineActionMs",
        "inlineReadyMs",
        "workbenchActionMs",
        "workbenchReadyMs",
        "profileActionMs",
        "firstProfileReadyMs",
        "profilesCompleteMs"
      ],
      "Study public warm-up milestones"
    );
    const orderedMilestones = [
      warmup.milestones.inlineActionMs,
      warmup.milestones.inlineReadyMs,
      warmup.milestones.workbenchActionMs,
      warmup.milestones.workbenchReadyMs,
      warmup.milestones.profileActionMs,
      warmup.milestones.firstProfileReadyMs,
      warmup.milestones.profilesCompleteMs
    ];
    if (
      orderedMilestones.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
      orderedMilestones.some(
        (value, milestoneIndex) => milestoneIndex > 0 && value < orderedMilestones[milestoneIndex - 1]
      )
    ) {
      fail("Study public warm-up milestones are incomplete or out of order.");
    }
    exactKeys(
      warmup.profiles,
      ["expectedColumnCount", "completedColumnCount", "canonicalOrder"],
      "Study public warm-up profiles"
    );
    exactKeys(
      warmup.controlBridge,
      ["clock", "authoritativeForStudy", "requestProtocol", "acknowledgementProtocol", "exchanges"],
      "Study public warm-up control bridge"
    );
    if (
      warmup.controlBridge.clock !== "process-hrtime-bigint" ||
      warmup.controlBridge.authoritativeForStudy !== true ||
      warmup.controlBridge.requestProtocol !== DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL ||
      warmup.controlBridge.acknowledgementProtocol !== DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL ||
      !Array.isArray(warmup.controlBridge.exchanges) ||
      warmup.controlBridge.exchanges.length !== DATA_WRANGLER_STUDY_WARMUP_BRIDGE_KINDS.length
    ) {
      fail("Study public warm-up control bridge is incomplete.");
    }
    let previousAcknowledgement = 0n;
    let bridgeRunId;
    for (let exchangeIndex = 0; exchangeIndex < warmup.controlBridge.exchanges.length; exchangeIndex += 1) {
      const exchange = warmup.controlBridge.exchanges[exchangeIndex];
      exactKeys(exchange, ["request", "acknowledgement"], "Study public warm-up control exchange");
      const request = validateDataWranglerStudyBridgeRequest(exchange.request);
      const acknowledgement = validateDataWranglerStudyBridgeAcknowledgement(exchange.acknowledgement);
      const expectedKind = DATA_WRANGLER_STUDY_WARMUP_BRIDGE_KINDS[exchangeIndex];
      bridgeRunId ??= request.runId;
      if (
        request.runId !== bridgeRunId ||
        request.runId !== acknowledgement.runId ||
        request.phase !== `comparison-study-${template.product}-warmup` ||
        request.phase !== acknowledgement.phase ||
        request.sequence !== exchangeIndex ||
        request.sequence !== acknowledgement.sequence ||
        request.kind !== expectedKind ||
        request.kind !== acknowledgement.kind ||
        BigInt(request.monotonicNanoseconds) < previousAcknowledgement ||
        BigInt(acknowledgement.monotonicNanoseconds) < BigInt(request.monotonicNanoseconds)
      ) {
        fail("Study public warm-up control exchange is stale, mismatched, or out of order.");
      }
      previousAcknowledgement = BigInt(acknowledgement.monotonicNanoseconds);
    }
    exactKeys(warmup.cleanup, ["closeStatus", "afterVerification"], "Study public warm-up cleanup");
    if (
      warmup.profiles.expectedColumnCount !== csvFixture?.columns ||
      warmup.profiles.completedColumnCount !== csvFixture?.columns ||
      warmup.profiles.canonicalOrder !== true ||
      warmup.cleanup.closeStatus !== "succeeded" ||
      warmup.cleanup.afterVerification !== "matched"
    ) {
      fail("Study public warm-up did not profile every column and close cleanly.");
    }
    if (
      template.publicConfigurationCompleted !== true ||
      template.publicWarmupCompleted !== true ||
      template.targetStateAbsent !== true
    ) {
      fail("Study templates must prove public preparation and the absence of retained target state.");
    }
  });
}

function validateStudyStorage(storage) {
  exactKeys(
    storage,
    [
      "deviceModel",
      "deviceIdentitySha256",
      "filesystemType",
      "mountOptionsSha256",
      "fixtureVolumeIdentitySha256",
      "rotational"
    ],
    "Study fixture-storage provenance"
  );
  assertBoundedText(storage.deviceModel, "Study storage device model", 256);
  assertString(storage.deviceIdentitySha256, SHA256, "Study storage device identity SHA-256");
  assertBoundedText(storage.filesystemType, "Study storage filesystem type", 64);
  assertString(storage.mountOptionsSha256, SHA256, "Study storage mount-options SHA-256");
  assertString(storage.fixtureVolumeIdentitySha256, SHA256, "Study fixture-volume identity SHA-256");
  assertBoolean(storage.rotational, "Study rotational-storage provenance");
}

function expectedPublicUiSource(fixture) {
  return {
    variableName: "study_frame",
    engine: "polars",
    semanticClass: "dataframe",
    rowCount: fixture.rows,
    columnCount: fixture.columns,
    schemaSha256: digestStudyValue(fixture.schema),
    sentinels: fixture.sentinels.map((sentinel) => ({
      rowIndex: sentinel.rowIndex,
      columnName: sentinel.column,
      value: sentinel.value
    }))
  };
}

function validatePublicUiReceiptContext(context, fixtureId, manifestContext, label) {
  const fixture = manifestContext.fixtures.find((candidate) => candidate.id === fixtureId);
  if (fixture === undefined) {
    fail(`${label} fixture ID does not name a manifest fixture.`);
  }
  const expected = createPublicUiReceiptContext({
    captureId: context.captureId,
    editor: manifestContext.editor,
    source: expectedPublicUiSource(fixture)
  });
  const normalized = createPublicUiReceiptContext(context);
  if (canonicalStudyJson(normalized) !== canonicalStudyJson(context)) {
    fail(`${label} must store its normalized public-UI context.`);
  }
  if (canonicalStudyJson(normalized) !== canonicalStudyJson(expected)) {
    fail(`${label} does not match the manifest editor and exact Polars fixture source.`);
  }
  return normalized;
}

function validateCapabilityReceipts(receipts, manifestContext) {
  const expectedFixtureIds = manifestContext.fixtures.map((fixture) => fixture.id);
  if (!Array.isArray(receipts) || receipts.length !== expectedFixtureIds.length) {
    fail("Study capability provenance must contain one Data Wrangler Polars receipt for every fixture.");
  }
  const captureIds = new Set();
  receipts.forEach((receipt, index) => {
    exactKeys(
      receipt,
      ["product", "engine", "availability", "method", "timed", "fixtureId", "context", "receiptSha256", "receipt"],
      "Study public-capability receipt"
    );
    if (
      receipt.product !== "data-wrangler" ||
      receipt.engine !== "polars" ||
      !["available", "undetermined"].includes(receipt.availability) ||
      receipt.method !== "public-capability" ||
      receipt.timed !== false ||
      receipt.fixtureId !== expectedFixtureIds[index]
    ) {
      fail("Study Data Wrangler Polars capability receipts must follow the exact fixture order.");
    }
    assertBoundedText(receipt.fixtureId, "Study public-capability fixture ID", 128);
    const context = validatePublicUiReceiptContext(
      receipt.context,
      receipt.fixtureId,
      manifestContext,
      "Study public-capability context"
    );
    if (captureIds.has(context.captureId)) {
      fail("Study public-capability captures must be independent for every fixture.");
    }
    captureIds.add(context.captureId);
    validateDataWranglerPolarsCapabilityReceipt(receipt.receipt, context);
    const expectedAvailability = receipt.receipt.evidence.conclusion === "available" ? "available" : "undetermined";
    if (receipt.availability !== expectedAvailability) {
      fail("Study Data Wrangler Polars availability does not match its public-UI observation trace.");
    }
    assertString(receipt.receiptSha256, SHA256, "Study public-capability receipt SHA-256");
    if (receipt.receiptSha256 !== digestStudyValue(receipt.receipt)) {
      fail("Study public-capability receipt SHA-256 does not match its validated public-UI evidence.");
    }
  });
  return captureIds;
}

function validateControlProfile(controlProfile, manifestContext) {
  exactKeys(
    controlProfile,
    ["method", "fixtureId", "context", "receiptSha256", "receipt"],
    "Study neither-product control profile"
  );
  if (controlProfile.method !== "neither-product") {
    fail("Study control profile must omit both measured products.");
  }
  assertBoundedText(controlProfile.fixtureId, "Study control-profile fixture ID", 128);
  const context = validatePublicUiReceiptContext(
    controlProfile.context,
    controlProfile.fixtureId,
    manifestContext,
    "Study control-profile context"
  );
  validateNeitherProductControlReceipt(controlProfile.receipt, context);
  assertString(controlProfile.receiptSha256, SHA256, "Study control-profile receipt SHA-256");
  if (controlProfile.receiptSha256 !== digestStudyValue(controlProfile.receipt)) {
    fail("Study control-profile receipt SHA-256 does not match its validated public-UI evidence.");
  }
}

function validateOwnershipTrackerProvenance(tracker) {
  exactKeys(
    tracker,
    ["protocol", "supervisorSource", "pythonExecutable", "invocationPolicySha256"],
    "Study process ownership tracker"
  );
  if (tracker.protocol !== PSS_OWNERSHIP_PROTOCOL) {
    fail("Study process ownership tracker protocol is invalid.");
  }
  exactKeys(tracker.supervisorSource, ["sha256", "filesystemIdentity"], "Study supervisor source provenance");
  assertString(tracker.supervisorSource.sha256, SHA256, "Study supervisor source SHA-256");
  validateFilesystemIdentity(
    tracker.supervisorSource.filesystemIdentity,
    "Study supervisor source filesystem identity"
  );
  exactKeys(
    tracker.pythonExecutable,
    ["implementation", "version", "sha256", "filesystemIdentity"],
    "Study supervisor Python executable provenance"
  );
  if (tracker.pythonExecutable.implementation !== "CPython") {
    fail("Study supervisor must use the manifest-pinned CPython 3.12 executable.");
  }
  assertString(tracker.pythonExecutable.sha256, SHA256, "Study supervisor Python executable SHA-256");
  validateFilesystemIdentity(
    tracker.pythonExecutable.filesystemIdentity,
    "Study supervisor Python executable filesystem identity"
  );
  assertString(tracker.pythonExecutable.version, PYTHON_VERSION, "Study supervisor Python version");
  assertString(tracker.invocationPolicySha256, SHA256, "Study supervisor invocation-policy SHA-256");
}

function validateStudyProvenance(provenance, manifestContext) {
  exactKeys(
    provenance,
    [
      "machine",
      "cpu",
      "power",
      "storage",
      "display",
      "zoom",
      "commonExtensions",
      "comparisonDriver",
      "cacheToolchain",
      "fixtureToolchain",
      "templates",
      "capabilities",
      "controlProfile",
      "ownershipTracker"
    ],
    "Study environment provenance"
  );
  validateStudyMachine(provenance.machine);
  validateStudyCpu(provenance.cpu);
  exactKeys(provenance.power, ["source"], "Study power provenance");
  if (provenance.power.source !== "ac") {
    fail("Study power source must be AC.");
  }
  validateStudyStorage(provenance.storage);
  validateStudyDisplay(provenance.display);
  validateStudyZoom(provenance.zoom);
  validateStudyCommonExtensions(provenance.commonExtensions);
  validateComparisonDriverReceipt(provenance.comparisonDriver);
  validateCacheToolchain(provenance.cacheToolchain, manifestContext.python);
  validateFixtureToolchain(provenance.fixtureToolchain, manifestContext.python);
  validateStudyTemplates(provenance.templates, manifestContext);
  const capabilityCaptureIds = validateCapabilityReceipts(provenance.capabilities, manifestContext);
  validateControlProfile(provenance.controlProfile, manifestContext);
  if (capabilityCaptureIds.has(provenance.controlProfile.context.captureId)) {
    fail("Study capability and neither-product control captures must be independent.");
  }
  validateOwnershipTrackerProvenance(provenance.ownershipTracker);
  if (
    provenance.ownershipTracker.pythonExecutable.version !== manifestContext.python.version ||
    provenance.ownershipTracker.pythonExecutable.sha256 !== manifestContext.python.executableSha256
  ) {
    fail("Study process ownership must use the exact manifest-pinned Python executable.");
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
      "provenance",
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
  validateStudyProvenance(manifest.provenance, {
    editor: manifest.editor,
    python: manifest.python,
    fixtures: manifest.fixtures
  });
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
    ["studyId", "createdAtUtc", "method", "candidate", "baseline", "editor", "python", "fixtures", "provenance"],
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

function validateTimeout(timeout, reasonClass, milestones) {
  if (reasonClass !== "timeout") {
    if (timeout !== null) {
      fail("Only a timeout outcome may contain right-censoring evidence.");
    }
    return;
  }
  exactKeys(timeout, ["journey", "deadlineMs", "observedAtMs", "rightCensored"], "Study timeout evidence");
  assertEnum(timeout.journey, Object.keys(DATA_WRANGLER_STUDY_DEADLINES_MS), "Study timed-out journey");
  if (timeout.deadlineMs !== DATA_WRANGLER_STUDY_DEADLINES_MS[timeout.journey]) {
    fail("Study timeout deadline does not match the preregistered journey deadline.");
  }
  exactKeys(timeout.rightCensored, ["operator", "valueMs"], "Study right-censoring evidence");
  if (timeout.rightCensored.operator !== ">=" || timeout.rightCensored.valueMs !== timeout.deadlineMs) {
    fail("Study timeout must be right-censored at >= its preregistered deadline.");
  }
  assertNonNegativeFinite(timeout.observedAtMs, "Study observed timeout boundary");
  const actionKey = {
    "inline-preview": "inlineActionMs",
    "workbench-open": "workbenchActionMs",
    "complete-profile": "profileActionMs"
  }[timeout.journey];
  if (milestones[actionKey] === null || timeout.observedAtMs < milestones[actionKey] + timeout.deadlineMs) {
    fail("Study timeout observation must reach the monotonic action-plus-deadline boundary.");
  }
}

function validateCompletedJourney(milestones, actionKey, readyKey, deadline, label) {
  if (milestones[readyKey] === null) {
    return;
  }
  if (milestones[actionKey] === null || milestones[readyKey] <= milestones[actionKey]) {
    fail(`${label} readiness must occur after its public action.`);
  }
  if (milestones[readyKey] - milestones[actionKey] > deadline) {
    fail(`${label} readiness exceeds its preregistered deadline and must be recorded as a timeout.`);
  }
}

function validateControlAllowance(milestones) {
  let unmeasuredControlMs = milestones.inlineActionMs ?? 0;
  if (milestones.workbenchActionMs !== null) {
    unmeasuredControlMs += milestones.workbenchActionMs - milestones.inlineReadyMs;
  }
  if (milestones.profileActionMs !== null) {
    unmeasuredControlMs += milestones.profileActionMs - milestones.workbenchReadyMs;
  }
  if (unmeasuredControlMs > DATA_WRANGLER_STUDY_CONTROL_ALLOWANCE_MS) {
    fail("Study unmeasured control and transition gaps exceed the preregistered allowance.");
  }
}

function validateMilestones(milestones, status, timeout = null) {
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
  validateControlAllowance(milestones);
  validateCompletedJourney(
    milestones,
    "inlineActionMs",
    "inlineReadyMs",
    DATA_WRANGLER_STUDY_DEADLINES_MS["inline-preview"],
    "Inline preview"
  );
  validateCompletedJourney(
    milestones,
    "workbenchActionMs",
    "workbenchReadyMs",
    DATA_WRANGLER_STUDY_DEADLINES_MS["workbench-open"],
    "Workbench open"
  );
  validateCompletedJourney(
    milestones,
    "profileActionMs",
    "profilesCompleteMs",
    DATA_WRANGLER_STUDY_DEADLINES_MS["complete-profile"],
    "Complete profile"
  );
  if (
    milestones.firstProfileReadyMs !== null &&
    (milestones.profileActionMs === null || milestones.firstProfileReadyMs <= milestones.profileActionMs)
  ) {
    fail("First useful profile readiness must occur after the public profile action.");
  }
  if (
    milestones.profilesCompleteMs !== null &&
    milestones.firstProfileReadyMs !== null &&
    milestones.profilesCompleteMs < milestones.firstProfileReadyMs
  ) {
    fail("Complete profile readiness cannot precede the first useful profile.");
  }
  if (
    status === "success" &&
    (milestones.samplingStoppedMs === null || milestones.samplingStoppedMs - milestones.profilesCompleteMs < 2_000)
  ) {
    fail("A successful study fragment requires two-second resource quiescence.");
  }
  if (
    (status === "pre-action-invalid" || status === "unsupported") &&
    MILESTONE_KEYS.some((key) => milestones[key] !== null)
  ) {
    fail("A pre-action invalidation or unsupported surface cannot contain product-action milestones.");
  }
  if (timeout !== null) {
    const expectedBoundary = {
      "inline-preview": ["inlineActionMs", "inlineReadyMs"],
      "workbench-open": ["workbenchActionMs", "workbenchReadyMs"],
      "complete-profile": ["profileActionMs", "profilesCompleteMs"]
    }[timeout.journey];
    if (milestones[expectedBoundary[0]] === null || milestones[expectedBoundary[1]] !== null) {
      fail("Study timeout milestones do not stop at the declared timed-out journey.");
    }
  }
}

function fixtureForStudyEntry(manifest, entry) {
  const fixture = manifest.fixtures.find((candidate) => candidate.format === entry.format);
  if (fixture === undefined) {
    fail("Study schedule entry has no manifest fixture.");
  }
  return fixture;
}

function sameFilesystemObject(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function sourceCopyCore(copy) {
  return {
    protocol: copy.protocol,
    byteIdentical: copy.byteIdentical,
    mode: copy.mode,
    canonicalReceipt: copy.canonicalReceipt,
    copyReceipt: copy.copyReceipt
  };
}

/** Bind an in-memory or durable private-copy receipt to one manifest fixture. */
export function validateDataWranglerComparisonSourceCopyBinding({ sourceCopy, manifest, scheduleEntry }) {
  if (sourceCopy === null || typeof sourceCopy !== "object" || Array.isArray(sourceCopy)) {
    fail("Study private source-copy binding requires one receipt object.");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Study private source-copy binding requires one manifest.");
  }
  if (scheduleEntry === null || typeof scheduleEntry !== "object" || Array.isArray(scheduleEntry)) {
    fail("Study private source-copy binding requires one schedule entry.");
  }
  if (
    sourceCopy.protocol !== DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL ||
    sourceCopy.byteIdentical !== true ||
    sourceCopy.mode !== "0600"
  ) {
    fail("Study private source-copy state is invalid.");
  }
  validateImmutableFileReceipt(sourceCopy.canonicalReceipt, "Study canonical source");
  validateImmutableFileReceipt(sourceCopy.copyReceipt, "Study private source copy");
  const fixture = fixtureForStudyEntry(manifest, scheduleEntry);
  if (
    sourceCopy.canonicalReceipt.sha256 !== fixture.sha256 ||
    canonicalStudyJson(sourceCopy.canonicalReceipt.filesystemIdentity) !==
      canonicalStudyJson(fixture.filesystemIdentity) ||
    sourceCopy.copyReceipt.sha256 !== sourceCopy.canonicalReceipt.sha256 ||
    sourceCopy.copyReceipt.filesystemIdentity.sizeBytes !== sourceCopy.canonicalReceipt.filesystemIdentity.sizeBytes ||
    sameFilesystemObject(sourceCopy.copyReceipt.filesystemIdentity, sourceCopy.canonicalReceipt.filesystemIdentity)
  ) {
    fail("Study private source copy does not match its distinct immutable fixture input.");
  }
  return sourceCopy;
}

/** Bind one cache result to the manifest toolchain and exact private copy. */
export function validateDataWranglerComparisonCacheBinding({ cacheProof, sourceCopy, manifest, scheduleEntry }) {
  validateDataWranglerComparisonSourceCopyBinding({ sourceCopy, manifest, scheduleEntry });
  exactKeys(cacheProof, ["protocol", "toolchain", "proof"], "Study source-cache proof");
  if (cacheProof.protocol !== DATA_WRANGLER_COMPARISON_CACHE_CONTROLLER_PROTOCOL) {
    fail("Study source-cache proof protocol is invalid.");
  }
  if (canonicalStudyJson(cacheProof.toolchain) !== canonicalStudyJson(manifest.provenance.cacheToolchain)) {
    fail("Study source-cache proof does not use the manifest-pinned controller and Python toolchain.");
  }
  const cache = cacheProof.proof;
  exactKeys(
    cache,
    [
      "protocol",
      "requestedState",
      "fdatasyncApplied",
      "adviceAccepted",
      "verification",
      "pageSizeBytes",
      "totalPages",
      "residentPagesBefore",
      "residentPagesAfter",
      "identityStable",
      "verified",
      "sourceFilesystemIdentityBefore",
      "sourceFilesystemIdentityAfter",
      "controller",
      "pythonExecutable"
    ],
    "Study source-cache controller proof"
  );
  if (cache.protocol !== DATA_WRANGLER_STUDY_SOURCE_CACHE_PROTOCOL) {
    fail("Study source-cache controller protocol is invalid.");
  }
  validateFilesystemIdentity(cache.sourceFilesystemIdentityBefore, "Study source-cache identity before preparation");
  validateFilesystemIdentity(cache.sourceFilesystemIdentityAfter, "Study source-cache identity after preparation");
  if (
    canonicalStudyJson(cache.sourceFilesystemIdentityBefore) !==
      canonicalStudyJson(sourceCopy.copyReceipt.filesystemIdentity) ||
    canonicalStudyJson(cache.sourceFilesystemIdentityAfter) !==
      canonicalStudyJson(sourceCopy.copyReceipt.filesystemIdentity) ||
    canonicalStudyJson(cache.controller) !== canonicalStudyJson(cacheProof.toolchain.controller) ||
    canonicalStudyJson(cache.pythonExecutable) !== canonicalStudyJson(cacheProof.toolchain.pythonExecutable)
  ) {
    fail("Study source-cache proof does not bind the exact private copy and pinned toolchain.");
  }
  const expectedState = scheduleEntry.kind === "warm" ? "resident" : "evicted";
  if (cache.requestedState !== expectedState || cache.verification !== "linux-mincore") {
    fail("Study source-cache proof does not match the scheduled warm/cold Linux boundary.");
  }
  assertBoolean(cache.fdatasyncApplied, "Study source-cache fdatasync proof");
  assertBoolean(cache.adviceAccepted, "Study source-cache advisory proof");
  assertBoolean(cache.identityStable, "Study source-cache identity proof");
  assertInteger(cache.pageSizeBytes, "Study source-cache page size", { minimum: 1 });
  assertInteger(cache.totalPages, "Study source-cache page count", { minimum: 1 });
  for (const [key, label] of [
    ["residentPagesBefore", "before"],
    ["residentPagesAfter", "after"]
  ]) {
    assertInteger(cache[key], `Study source-cache resident pages ${label}`);
    if (cache[key] > cache.totalPages) fail("Study source-cache residency cannot exceed its total page count.");
  }
  assertBoolean(cache.verified, "Study source-cache verification result");
  const expectedTotalPages = Math.ceil(sourceCopy.copyReceipt.filesystemIdentity.sizeBytes / cache.pageSizeBytes);
  if (cache.totalPages !== expectedTotalPages) {
    fail("Study source-cache page count does not match the private copy byte size.");
  }
  const expectedAfter = expectedState === "resident" ? cache.totalPages : 0;
  const verified =
    cache.fdatasyncApplied &&
    cache.identityStable &&
    cache.adviceAccepted === (expectedState === "evicted") &&
    cache.residentPagesAfter === expectedAfter;
  if (cache.verified !== verified) {
    fail("Study source-cache verification result does not match its retained evidence.");
  }
  return cacheProof;
}

function validateSourceCopy(copy, entry, fragment, manifest) {
  if (copy === null) {
    if (!fragmentSkippedEditorLaunch(fragment)) {
      fail("A launched study fragment requires its private source-copy receipt.");
    }
    return;
  }
  if (fragmentSkippedEditorLaunch(fragment)) {
    fail("A launch-free study fragment cannot claim a private source copy.");
  }
  exactKeys(
    copy,
    [
      "protocol",
      "byteIdentical",
      "mode",
      "canonicalReceipt",
      "copyReceipt",
      "verifiedAfterProcessTreeEmpty",
      "cleanup"
    ],
    "Study private source-copy receipt"
  );
  if (copy.verifiedAfterProcessTreeEmpty !== true) {
    fail("Study private source-copy state is invalid.");
  }
  validateDataWranglerComparisonSourceCopyBinding({ sourceCopy: copy, manifest, scheduleEntry: entry });
  exactKeys(copy.cleanup, ["protocol", "removed", "copyReceipt"], "Study private source-copy cleanup");
  if (
    copy.cleanup.protocol !== DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL ||
    copy.cleanup.removed !== true ||
    canonicalStudyJson(copy.cleanup.copyReceipt) !== canonicalStudyJson(copy.copyReceipt)
  ) {
    fail("Study private source-copy cleanup does not match the copied inode.");
  }
}

function validateCacheProof(proof, entry, fragment, manifest) {
  if (proof === null) {
    if (entry.kind === "cold" && fragmentFailedBeforeResourceSampling(fragment)) return;
    if (
      fragment.outcome.status !== "unsupported" &&
      !(fragment.outcome.actionStarted === false && fragment.environmentGate?.passed === false)
    ) {
      fail("A missing source-cache proof requires an explicit failed pre-source-cache environment gate.");
    }
    return;
  }
  if (fragment.outcome.status === "unsupported" || fragment.environmentGate?.passed === false) {
    fail("Source-cache preparation cannot follow an unsupported surface or failed pre-source-cache gate.");
  }
  if (fragment.sourceCopy === null) {
    fail("Study source-cache proof requires its private source copy.");
  }
  validateDataWranglerComparisonCacheBinding({
    cacheProof: proof,
    sourceCopy: fragment.sourceCopy,
    manifest,
    scheduleEntry: entry
  });
  const cache = proof.proof;
  if (fragment.outcome.actionStarted && !cache.verified) {
    fail("A product action cannot start without verified source-cache preparation.");
  }
}

function validateSourceLoad(sourceLoad, entry, fragment) {
  exactKeys(sourceLoad, ["status", "durationMs", "includedInInlineTiming"], "Study source-load diagnostic");
  assertEnum(sourceLoad.status, ["measured", "failed", "not-reached"], "Study source-load status");
  if (sourceLoad.includedInInlineTiming !== (entry.kind === "cold")) {
    fail("Study source-load timing inclusion does not match the scheduled warm/cold boundary.");
  }
  if (sourceLoad.status === "measured") {
    assertPositiveFinite(sourceLoad.durationMs, "Study source-load diagnostic duration");
  } else if (sourceLoad.durationMs !== null) {
    fail("An unmeasured source load cannot contain a duration.");
  }
  if (fragment.outcome.status === "success" && sourceLoad.status !== "measured") {
    fail("A successful study fragment requires a measured source-load diagnostic.");
  }
  if (fragment.outcome.status === "unsupported" && sourceLoad.status !== "not-reached") {
    fail("An unsupported public surface cannot contain a source-load timing.");
  }
  if (fragment.milestones.inlineReadyMs !== null && sourceLoad.status !== "measured") {
    fail("Inline readiness requires a measured source-load diagnostic.");
  }
  if (entry.kind === "cold" && fragment.milestones.inlineReadyMs !== null) {
    const inlineDuration = fragment.milestones.inlineReadyMs - fragment.milestones.inlineActionMs;
    if (sourceLoad.durationMs > inlineDuration) {
      fail("A cold-source load diagnostic cannot exceed its inclusive load-and-preview duration.");
    }
  }
}

function validateEngineEvidence(evidence, entry, fragment, manifest) {
  const launchSkipped = fragmentSkippedEditorLaunch(fragment);
  if (evidence === null) {
    if (!launchSkipped && fragment.outcome.status !== "pre-action-invalid") {
      fail("A launched study fragment requires visible source-engine evidence.");
    }
    return;
  }
  if (launchSkipped) {
    fail("A pre-launch study outcome cannot claim per-fragment notebook or workbench engine evidence.");
  }
  exactKeys(
    evidence,
    ["sourceEngine", "sourceVerification", "workbenchEngine", "workbenchVerification"],
    "Study engine evidence"
  );
  if (evidence.sourceEngine !== entry.engine) {
    fail("Study source-engine evidence must match the visible notebook runtime and scheduled engine.");
  }
  exactKeys(evidence.sourceVerification, ["method", "receiptSha256", "receipt"], "Study source-engine verification");
  if (evidence.sourceVerification.method !== "visible-notebook-runtime") {
    fail("Study source-engine verification must use the visible notebook runtime.");
  }
  exactKeys(
    evidence.sourceVerification.receipt,
    [
      "engine",
      "fixtureId",
      "fixtureSha256",
      "semanticClass",
      "rowCount",
      "columnCount",
      "schema",
      "sentinelsBefore",
      "sentinelsAfter",
      "filesystemIdentityBefore",
      "filesystemIdentityAfter",
      "observedBeforeAction",
      "observedAfterTrial"
    ],
    "Study visible source-engine receipt"
  );
  const receipt = evidence.sourceVerification.receipt;
  const fixture = fixtureForStudyEntry(manifest, entry);
  validateFilesystemIdentity(receipt.filesystemIdentityBefore, "Study visible source identity before action");
  if (receipt.filesystemIdentityAfter !== null) {
    validateFilesystemIdentity(receipt.filesystemIdentityAfter, "Study visible source identity after trial");
  }
  if (
    receipt.engine !== entry.engine ||
    receipt.fixtureId !== fixture.id ||
    receipt.fixtureSha256 !== fixture.sha256 ||
    receipt.semanticClass !== "dataframe" ||
    receipt.rowCount !== fixture.rows ||
    receipt.columnCount !== fixture.columns ||
    canonicalStudyJson(receipt.schema) !== canonicalStudyJson(fixture.schema) ||
    canonicalStudyJson(receipt.sentinelsBefore) !== canonicalStudyJson(fixture.sentinels) ||
    fragment.sourceCopy === null ||
    canonicalStudyJson(receipt.filesystemIdentityBefore) !==
      canonicalStudyJson(fragment.sourceCopy.copyReceipt.filesystemIdentity) ||
    receipt.observedBeforeAction !== true ||
    !["verified", "not-reached"].includes(receipt.observedAfterTrial)
  ) {
    fail("Study visible source-engine receipt does not match the exact manifest fixture, schema, and source identity.");
  }
  const postcheckVerified = receipt.observedAfterTrial === "verified";
  if (
    (postcheckVerified &&
      (canonicalStudyJson(receipt.sentinelsAfter) !== canonicalStudyJson(fixture.sentinels) ||
        canonicalStudyJson(receipt.filesystemIdentityAfter) !==
          canonicalStudyJson(fragment.sourceCopy.copyReceipt.filesystemIdentity))) ||
    (!postcheckVerified && (receipt.sentinelsAfter !== null || receipt.filesystemIdentityAfter !== null))
  ) {
    fail("Study visible source postcheck does not prove the registered sentinels and stable filesystem identity.");
  }
  if (fragment.outcome.status === "success" && receipt.observedAfterTrial !== "verified") {
    fail("A successful study fragment requires its visible source postcheck.");
  }
  assertString(evidence.sourceVerification.receiptSha256, SHA256, "Study visible source receipt SHA-256");
  if (evidence.sourceVerification.receiptSha256 !== digestStudyValue(receipt)) {
    fail("Study visible source receipt SHA-256 does not match its bounded raw evidence.");
  }
  assertEnum(evidence.workbenchEngine, ["pandas", "polars", "unverified"], "Study public workbench engine");
  assertEnum(evidence.workbenchVerification, ["public-ui", "not-observed"], "Study workbench-engine verification");
  if (
    (evidence.workbenchEngine === "unverified") !== (evidence.workbenchVerification === "not-observed") ||
    (fragment.product === "open-wrangler" &&
      fragment.milestones.workbenchReadyMs !== null &&
      evidence.workbenchEngine !== entry.engine)
  ) {
    fail("Study workbench-engine evidence does not match its product-specific public verification.");
  }
}

function assertPercentage(value, label) {
  assertNonNegativeFinite(value, label);
  if (value > 100) {
    fail(`${label} cannot exceed 100 percent.`);
  }
}

function parseLinuxCpuList(value, label) {
  assertBoundedText(value, label, 128);
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(value)) {
    fail(`${label} is invalid.`);
  }
  const result = [];
  for (const part of value.split(",")) {
    const [firstText, lastText = firstText] = part.split("-");
    const first = Number(firstText);
    const last = Number(lastText);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last || last > 4_095) {
      fail(`${label} is invalid.`);
    }
    for (let cpu = first; cpu <= last; cpu += 1) {
      if (result.includes(cpu)) {
        fail(`${label} repeats a CPU.`);
      }
      result.push(cpu);
    }
  }
  return result;
}

function validateGateThresholds(thresholds) {
  exactKeys(
    thresholds,
    [
      "windowMs",
      "intervalMs",
      "maximumMeanNonIdleCpuPercent",
      "maximumOneSecondNonIdleCpuPercent",
      "maximumCpuSomeAvg10Percent",
      "maximumMemoryFullAvg10Percent",
      "maximumSwapPageDelta",
      "maximumThermalThrottleDelta",
      "requireExactAcPowerState",
      "requireExactGovernorSet",
      "requireExactAffinity",
      "maximumSampleLatenessMs"
    ],
    "Study environment-gate thresholds"
  );
  const expected = {
    windowMs: 10_000,
    intervalMs: 1_000,
    maximumMeanNonIdleCpuPercent: 10,
    maximumOneSecondNonIdleCpuPercent: 25,
    maximumCpuSomeAvg10Percent: 1,
    maximumMemoryFullAvg10Percent: 0,
    maximumSwapPageDelta: 0,
    maximumThermalThrottleDelta: 0,
    requireExactAcPowerState: true,
    requireExactGovernorSet: true,
    requireExactAffinity: true,
    maximumSampleLatenessMs: 250
  };
  if (canonicalStudyJson(thresholds) !== canonicalStudyJson(expected)) {
    fail("Study environment-gate thresholds do not match the preregistered method.");
  }
}

function validateGateProvenance(provenance, manifest) {
  exactKeys(
    provenance,
    ["protocol", "platform", "architecture", "kernelRelease", "cpu", "affinity", "power", "display"],
    "Study environment-gate provenance"
  );
  if (provenance.protocol !== ENVIRONMENT_PROVENANCE_PROTOCOL) {
    fail("Study environment-gate provenance protocol is invalid.");
  }
  assertBoundedText(provenance.platform, "Study environment-gate platform", 32);
  assertBoundedText(provenance.architecture, "Study environment-gate architecture", 32);
  assertBoundedText(provenance.kernelRelease, "Study environment-gate kernel release", 256);
  let matchedManifest =
    provenance.platform === manifest.provenance.machine.platform &&
    provenance.architecture === manifest.provenance.machine.architecture &&
    provenance.kernelRelease === manifest.provenance.machine.kernelRelease;
  exactKeys(
    provenance.cpu,
    ["vendorId", "modelName", "logicalCpuCount", "onlineCpuList", "pinnedCpuIds"],
    "Study environment-gate CPU provenance"
  );
  assertBoundedText(provenance.cpu.vendorId, "Study environment-gate CPU vendor", 128);
  assertBoundedText(provenance.cpu.modelName, "Study environment-gate CPU model", 256);
  assertInteger(provenance.cpu.logicalCpuCount, "Study environment-gate logical CPU count", { minimum: 1 });
  assertBoundedText(provenance.cpu.onlineCpuList, "Study environment-gate online CPU list", 4_096);
  if (
    !Array.isArray(provenance.cpu.pinnedCpuIds) ||
    provenance.cpu.pinnedCpuIds.length < 1 ||
    provenance.cpu.pinnedCpuIds.length > 4_096
  ) {
    fail("Study environment-gate pinned CPU IDs are incomplete or unbounded.");
  }
  const pinnedCpuIds = new Set();
  for (const cpuId of provenance.cpu.pinnedCpuIds) {
    assertInteger(cpuId, "Study environment-gate pinned CPU ID");
    if (pinnedCpuIds.has(cpuId)) {
      fail("Study environment-gate pinned CPU IDs must be unique.");
    }
    pinnedCpuIds.add(cpuId);
  }
  const cpuMatchesManifest =
    provenance.cpu.vendorId === manifest.provenance.cpu.vendorId &&
    provenance.cpu.modelName === manifest.provenance.cpu.model &&
    provenance.cpu.logicalCpuCount === manifest.provenance.cpu.logicalProcessorCount &&
    provenance.cpu.onlineCpuList === manifest.provenance.cpu.onlineCpuList &&
    canonicalStudyJson(provenance.cpu.pinnedCpuIds) === canonicalStudyJson(manifest.provenance.cpu.affinity);
  matchedManifest = matchedManifest && cpuMatchesManifest;
  exactKeys(provenance.affinity, ["cpuList"], "Study environment-gate affinity provenance");
  assertBoundedText(provenance.affinity.cpuList, "Study affinity CPU list", 4_096);
  const observedAffinity = parseLinuxCpuList(provenance.affinity.cpuList, "Study affinity CPU list");
  matchedManifest =
    matchedManifest && canonicalStudyJson(observedAffinity) === canonicalStudyJson(manifest.provenance.cpu.affinity);
  exactKeys(
    provenance.power,
    ["externalSupplies", "governors", "thermalThrottleCounters"],
    "Study environment-gate power provenance"
  );
  if (
    !Array.isArray(provenance.power.externalSupplies) ||
    provenance.power.externalSupplies.length < 1 ||
    provenance.power.externalSupplies.length > 16
  ) {
    fail("Study environment-gate AC provenance is incomplete or unbounded.");
  }
  let onlineSupply = false;
  for (const supply of provenance.power.externalSupplies) {
    exactKeys(supply, ["name", "type", "online"], "Study external-power supply");
    assertBoundedText(supply.name, "Study external-power supply name", 128);
    assertBoundedText(supply.type, "Study external-power supply type", 64);
    assertBoolean(supply.online, "Study external-power supply state");
    onlineSupply ||= supply.online;
  }
  matchedManifest = matchedManifest && onlineSupply;
  if (
    !Array.isArray(provenance.power.governors) ||
    provenance.power.governors.length !== manifest.provenance.cpu.governors.length
  ) {
    fail("Study environment-gate governor provenance is incomplete.");
  }
  provenance.power.governors.forEach((governor, index) => {
    exactKeys(governor, ["cpuId", "governor"], "Study environment-gate CPU governor");
    assertInteger(governor.cpuId, "Study environment-gate governor CPU ID");
    assertBoundedText(governor.governor, "Study environment-gate governor", 128);
    const expected = manifest.provenance.cpu.governors[index];
    const governorMatchesManifest = governor.cpuId === expected.processor && governor.governor === expected.governor;
    matchedManifest = matchedManifest && governorMatchesManifest;
  });
  if (
    !Array.isArray(provenance.power.thermalThrottleCounters) ||
    provenance.power.thermalThrottleCounters.length < 1 ||
    provenance.power.thermalThrottleCounters.length > 256
  ) {
    fail("Study thermal-throttle provenance must contain one to 256 counters.");
  }
  const thermalIds = new Set();
  for (const counter of provenance.power.thermalThrottleCounters) {
    exactKeys(counter, ["id", "cpuId", "kind"], "Study thermal-throttle counter");
    assertBoundedText(counter.id, "Study thermal-throttle counter ID", 128);
    assertInteger(counter.cpuId, "Study thermal-throttle CPU ID");
    assertEnum(counter.kind, ["core", "package"], "Study thermal-throttle counter kind");
    if (thermalIds.has(counter.id)) {
      fail("Study thermal-throttle counters must be unique.");
    }
    const counterMatchesManifest = manifest.provenance.cpu.affinity.includes(counter.cpuId);
    matchedManifest = matchedManifest && counterMatchesManifest;
    thermalIds.add(counter.id);
  }
  exactKeys(
    provenance.display,
    ["mode", "width", "height", "scaleFactor", "zoomLevel", "theme", "hostEnvironment"],
    "Study environment-gate display provenance"
  );
  exactKeys(
    provenance.display.hostEnvironment,
    ["displaySet", "waylandDisplaySet", "xdgSessionTypeSet"],
    "Study environment-gate display host environment"
  );
  assertBoundedText(provenance.display.mode, "Study environment-gate display mode", 64);
  assertPositiveFinite(provenance.display.width, "Study environment-gate display width");
  assertPositiveFinite(provenance.display.height, "Study environment-gate display height");
  assertPositiveFinite(provenance.display.scaleFactor, "Study environment-gate display scale factor");
  if (
    typeof provenance.display.zoomLevel !== "number" ||
    !Number.isFinite(provenance.display.zoomLevel) ||
    provenance.display.zoomLevel < -20 ||
    provenance.display.zoomLevel > 20
  ) {
    fail("Study environment-gate zoom level must be finite and bounded.");
  }
  assertBoundedText(provenance.display.theme, "Study environment-gate theme", 256);
  for (const [key, value] of Object.entries(provenance.display.hostEnvironment)) {
    assertBoolean(value, `Study environment-gate display host flag ${key}`);
  }
  const displayMatchesManifest =
    provenance.display.mode === manifest.provenance.display.mode &&
    provenance.display.width === manifest.provenance.display.widthPx &&
    provenance.display.height === manifest.provenance.display.heightPx &&
    provenance.display.scaleFactor === manifest.provenance.display.deviceScaleFactor &&
    provenance.display.zoomLevel === manifest.provenance.zoom.level &&
    provenance.display.theme === manifest.provenance.zoom.theme &&
    Object.values(provenance.display.hostEnvironment).every((value) => value === false);
  matchedManifest = matchedManifest && displayMatchesManifest;
  return { thermalIds, matchedManifest };
}

function validateGateAttempt(attempt, index, thresholds, manifest, thermalIds, provenanceMatched) {
  exactKeys(
    attempt,
    ["attempt", "startedAtOffsetMs", "durationMs", "passed", "failureCodes", "summary", "intervals"],
    "Study environment-gate attempt"
  );
  if (attempt.attempt !== index + 1) {
    fail("Study environment-gate attempt numbers must be contiguous and one-based.");
  }
  assertNonNegativeFinite(attempt.startedAtOffsetMs, "Study environment-gate attempt start offset");
  assertPositiveFinite(attempt.durationMs, "Study environment-gate attempt duration");
  assertBoolean(attempt.passed, "Study environment-gate attempt result");
  if (!Array.isArray(attempt.failureCodes)) {
    fail("Study environment-gate failure codes must be an array.");
  }
  let previousCodeIndex = -1;
  for (const code of attempt.failureCodes) {
    const codeIndex = ENVIRONMENT_FAILURE_CODES.indexOf(code);
    if (codeIndex <= previousCodeIndex) {
      fail("Study environment-gate failure codes must be a unique ordered subset.");
    }
    previousCodeIndex = codeIndex;
  }
  exactKeys(
    attempt.summary,
    [
      "cpuIds",
      "meanNonIdleCpuPercent",
      "maximumOneSecondNonIdleCpuPercent",
      "maximumCpuSomeAvg10Percent",
      "maximumMemoryFullAvg10Percent",
      "swapPageDelta",
      "thermalThrottleDeltas",
      "acPowerMatched",
      "governorsMatched",
      "affinityMatched"
    ],
    "Study environment-gate attempt summary"
  );
  const summary = attempt.summary;
  if (canonicalStudyJson(summary.cpuIds) !== canonicalStudyJson(manifest.provenance.cpu.affinity)) {
    fail("Study environment-gate CPU utilization does not use the manifest-pinned cpuN lines.");
  }
  for (const [key, label] of [
    ["meanNonIdleCpuPercent", "mean non-idle CPU"],
    ["maximumOneSecondNonIdleCpuPercent", "maximum one-second non-idle CPU"],
    ["maximumCpuSomeAvg10Percent", "CPU pressure some avg10"],
    ["maximumMemoryFullAvg10Percent", "memory pressure full avg10"]
  ]) {
    if (summary[key] !== null) {
      assertPercentage(summary[key], `Study environment-gate ${label}`);
    }
  }
  if (summary.swapPageDelta !== null) {
    exactKeys(summary.swapPageDelta, ["pagesIn", "pagesOut"], "Study environment-gate swap-page delta");
    assertInteger(summary.swapPageDelta.pagesIn, "Study environment-gate swap-in pages");
    assertInteger(summary.swapPageDelta.pagesOut, "Study environment-gate swap-out pages");
  }
  if (summary.thermalThrottleDeltas !== null) {
    if (!Array.isArray(summary.thermalThrottleDeltas) || summary.thermalThrottleDeltas.length !== thermalIds.size) {
      fail("Study thermal-throttle deltas do not cover the retained counters.");
    }
    const seen = new Set();
    for (const delta of summary.thermalThrottleDeltas) {
      exactKeys(delta, ["id", "delta"], "Study thermal-throttle delta");
      assertInteger(delta.delta, "Study thermal-throttle delta value");
      if (!thermalIds.has(delta.id) || seen.has(delta.id)) {
        fail("Study thermal-throttle deltas do not match the retained counters.");
      }
      seen.add(delta.id);
    }
  }
  assertBoolean(summary.acPowerMatched, "Study AC-power match");
  assertBoolean(summary.governorsMatched, "Study governor match");
  assertBoolean(summary.affinityMatched, "Study affinity match");
  if (!Array.isArray(attempt.intervals) || attempt.intervals.length !== thresholds.windowMs / thresholds.intervalMs) {
    fail("Study environment-gate attempts must retain every one-second interval in the complete window.");
  }
  let previousElapsedMs = -1;
  let timingFailed =
    attempt.durationMs < thresholds.windowMs ||
    attempt.durationMs > thresholds.windowMs + thresholds.maximumSampleLatenessMs;
  let unavailable = false;
  const availableIntervals = [];
  for (const [intervalIndex, interval] of attempt.intervals.entries()) {
    exactKeys(
      interval,
      [
        "index",
        "elapsedMs",
        "durationMs",
        "nonIdleCpuPercent",
        "cpuSomeAvg10Percent",
        "memoryFullAvg10Percent",
        "acPowerMatched",
        "governorsMatched",
        "affinityMatched",
        "available"
      ],
      "Study environment-gate interval"
    );
    if (interval.index !== intervalIndex) {
      fail("Study environment-gate interval indices must be contiguous and zero-based.");
    }
    assertNonNegativeFinite(interval.elapsedMs, "Study environment-gate interval elapsed time");
    assertPositiveFinite(interval.durationMs, "Study environment-gate interval duration");
    assertBoolean(interval.available, "Study environment-gate interval availability");
    assertBoolean(interval.acPowerMatched, "Study environment-gate interval AC-power match");
    assertBoolean(interval.governorsMatched, "Study environment-gate interval governor match");
    assertBoolean(interval.affinityMatched, "Study environment-gate interval affinity match");
    if (
      interval.elapsedMs <= previousElapsedMs ||
      interval.elapsedMs > attempt.durationMs + thresholds.maximumSampleLatenessMs ||
      interval.elapsedMs - (previousElapsedMs < 0 ? 0 : previousElapsedMs) !== interval.durationMs
    ) {
      fail("Study environment-gate intervals must retain contiguous actual monotonic window coverage.");
    }
    previousElapsedMs = interval.elapsedMs;
    timingFailed ||=
      interval.durationMs < thresholds.intervalMs ||
      interval.durationMs > thresholds.intervalMs + thresholds.maximumSampleLatenessMs;
    if (interval.available) {
      assertPercentage(interval.nonIdleCpuPercent, "Study interval non-idle CPU");
      assertPercentage(interval.cpuSomeAvg10Percent, "Study interval CPU pressure some avg10");
      assertPercentage(interval.memoryFullAvg10Percent, "Study interval memory pressure full avg10");
      availableIntervals.push(interval);
    } else {
      unavailable = true;
      if (
        interval.nonIdleCpuPercent !== null ||
        interval.cpuSomeAvg10Percent !== null ||
        interval.memoryFullAvg10Percent !== null
      ) {
        fail("An unavailable environment-gate interval cannot contain synthesized numeric metrics.");
      }
    }
  }
  if (previousElapsedMs !== attempt.durationMs) {
    fail("Study environment-gate interval coverage must end at the retained attempt duration.");
  }
  if (availableIntervals.length === attempt.intervals.length) {
    const observed = {
      meanNonIdleCpuPercent:
        availableIntervals.reduce((sum, interval) => sum + interval.nonIdleCpuPercent, 0) / availableIntervals.length,
      maximumOneSecondNonIdleCpuPercent: Math.max(...availableIntervals.map((interval) => interval.nonIdleCpuPercent)),
      maximumCpuSomeAvg10Percent: Math.max(...availableIntervals.map((interval) => interval.cpuSomeAvg10Percent)),
      maximumMemoryFullAvg10Percent: Math.max(...availableIntervals.map((interval) => interval.memoryFullAvg10Percent))
    };
    if (
      Object.entries(observed).some(
        ([key, value]) => summary[key] === null || Math.abs(summary[key] - value) > Number.EPSILON * 100
      )
    ) {
      fail("Study environment-gate summary does not match its retained interval metrics.");
    }
  }
  if (
    summary.acPowerMatched !== attempt.intervals.every((interval) => interval.acPowerMatched) ||
    summary.governorsMatched !== attempt.intervals.every((interval) => interval.governorsMatched) ||
    summary.affinityMatched !== attempt.intervals.every((interval) => interval.affinityMatched)
  ) {
    fail("Study environment-gate summary does not match its retained interval provenance checks.");
  }
  const derivedFailures = new Set();
  if (
    unavailable ||
    summary.meanNonIdleCpuPercent === null ||
    summary.maximumOneSecondNonIdleCpuPercent === null ||
    summary.maximumCpuSomeAvg10Percent === null ||
    summary.maximumMemoryFullAvg10Percent === null ||
    summary.swapPageDelta === null ||
    summary.thermalThrottleDeltas === null
  ) {
    derivedFailures.add("sampling-unavailable");
  }
  if (!provenanceMatched) derivedFailures.add("provenance-drift");
  if (timingFailed) derivedFailures.add("sample-timing");
  if (summary.meanNonIdleCpuPercent > thresholds.maximumMeanNonIdleCpuPercent) derivedFailures.add("cpu-mean");
  if (summary.maximumOneSecondNonIdleCpuPercent > thresholds.maximumOneSecondNonIdleCpuPercent)
    derivedFailures.add("cpu-window");
  if (summary.maximumCpuSomeAvg10Percent > thresholds.maximumCpuSomeAvg10Percent) derivedFailures.add("cpu-pressure");
  if (summary.maximumMemoryFullAvg10Percent > thresholds.maximumMemoryFullAvg10Percent)
    derivedFailures.add("memory-pressure");
  if (
    summary.swapPageDelta !== null &&
    (summary.swapPageDelta.pagesIn > thresholds.maximumSwapPageDelta ||
      summary.swapPageDelta.pagesOut > thresholds.maximumSwapPageDelta)
  )
    derivedFailures.add("swap-activity");
  if (
    summary.thermalThrottleDeltas !== null &&
    summary.thermalThrottleDeltas.some((delta) => delta.delta > thresholds.maximumThermalThrottleDelta)
  )
    derivedFailures.add("thermal-throttle");
  if (!summary.acPowerMatched) derivedFailures.add("ac-power-drift");
  if (!summary.governorsMatched) derivedFailures.add("governor-drift");
  if (!summary.affinityMatched) derivedFailures.add("affinity-drift");
  for (const failure of derivedFailures) {
    if (!attempt.failureCodes.includes(failure)) {
      fail("Study environment-gate failure codes omit a failure proven by the retained window.");
    }
  }
  if (attempt.failureCodes.some((failure) => !derivedFailures.has(failure))) {
    fail("Study environment-gate failure codes claim a condition absent from the retained window.");
  }
  if (attempt.passed !== (attempt.failureCodes.length === 0 && derivedFailures.size === 0)) {
    fail("Study environment-gate attempt result does not match its retained window evidence.");
  }
  return attempt.passed;
}

function validateEnvironmentGate(gate, fragment, manifest) {
  if (gate === null) {
    if (fragment.outcome.actionStarted) {
      fail("A product action requires a retained pre-action environment gate.");
    }
    return;
  }
  exactKeys(
    gate,
    [
      "protocol",
      "selectionPolicy",
      "thresholds",
      "provenance",
      "maximumWaitMs",
      "waitMs",
      "acceptedAttempt",
      "passed",
      "terminalFailure",
      "attempts"
    ],
    "Study pre-action environment gate"
  );
  if (gate.protocol !== ENVIRONMENT_GATE_PROTOCOL || gate.selectionPolicy !== ENVIRONMENT_SELECTION_POLICY) {
    fail("Study environment-gate protocol or selection policy is invalid.");
  }
  validateGateThresholds(gate.thresholds);
  const { thermalIds, matchedManifest: provenanceMatched } = validateGateProvenance(gate.provenance, manifest);
  if (gate.maximumWaitMs !== 300_000) {
    fail("Study environment gates must retain the preregistered five-minute maximum wait.");
  }
  assertNonNegativeFinite(gate.waitMs, "Study environment-gate actual wait");
  assertBoolean(gate.passed, "Study environment-gate result");
  if (!Array.isArray(gate.attempts) || gate.attempts.length < 1 || gate.attempts.length > 30) {
    fail("Study environment gates must retain one to thirty complete attempted windows.");
  }
  let previousEndMs = -1;
  let acceptedAttempt = null;
  for (const [index, attempt] of gate.attempts.entries()) {
    if (attempt.startedAtOffsetMs < previousEndMs) {
      fail("Study environment-gate windows must use actual non-overlapping monotonic offsets.");
    }
    const passed = validateGateAttempt(attempt, index, gate.thresholds, manifest, thermalIds, provenanceMatched);
    if (passed) {
      if (acceptedAttempt !== null || index !== gate.attempts.length - 1) {
        fail("Study environment-gate sampling must stop at its first complete passing window.");
      }
      acceptedAttempt = attempt.attempt;
    }
    previousEndMs = attempt.startedAtOffsetMs + attempt.durationMs;
  }
  if (
    gate.waitMs < previousEndMs ||
    gate.waitMs > gate.maximumWaitMs + gate.thresholds.intervalMs + gate.thresholds.maximumSampleLatenessMs
  ) {
    fail("Study environment-gate actual wait does not contain its bounded attempted windows.");
  }
  if (gate.passed) {
    if (acceptedAttempt === null || gate.acceptedAttempt !== acceptedAttempt || gate.terminalFailure !== null) {
      fail("Study environment-gate acceptance does not match its first passing window.");
    }
  } else if (
    acceptedAttempt !== null ||
    gate.acceptedAttempt !== null ||
    gate.terminalFailure !== "deadline-no-complete-window" ||
    gate.maximumWaitMs - previousEndMs >= gate.thresholds.windowMs + gate.thresholds.maximumSampleLatenessMs
  ) {
    fail("A failed study environment gate must retain every complete window through its bounded deadline.");
  }
  if (fragment.outcome.actionStarted && !gate.passed) {
    fail("A product action cannot start after a failed environment gate.");
  }
  if (fragment.outcome.status === "unsupported") {
    fail("An unsupported public surface cannot claim a measured trial environment gate.");
  }
}

function validateNormalizedPreviewEvidence(preview) {
  exactKeys(preview, ["headers", "firstRows"], "Study normalized preview evidence");
  if (canonicalStudyJson(preview.headers) !== canonicalStudyJson(["c00", "c01"])) {
    fail("Study normalized preview headers do not match the canonical fixture prefix.");
  }
  const expectedRows = [
    { rowIndex: 0, c00: 0, c01: 1 },
    { rowIndex: 1, c00: 1, c01: 2 }
  ];
  if (canonicalStudyJson(preview.firstRows) !== canonicalStudyJson(expectedRows)) {
    fail("Study normalized preview rows do not match the canonical synthetic values.");
  }
}

function validateReadyInlineEvidence(evidence, fixture, fragment, manifest) {
  exactKeys(
    evidence,
    [
      "status",
      "rowCount",
      "columnCount",
      "cellCompleted",
      "stableFrames",
      "preview",
      "surfaceOwner",
      "controlProfileReceiptSha256",
      "launchActionVisible",
      "launchActionPointerUsable",
      "unobstructed"
    ],
    "Study inline UI evidence"
  );
  if (
    evidence.rowCount !== fixture.rows ||
    evidence.columnCount !== fixture.columns ||
    evidence.cellCompleted !== true ||
    evidence.stableFrames !== 2 ||
    evidence.launchActionVisible !== true ||
    evidence.launchActionPointerUsable !== true ||
    evidence.unobstructed !== true
  ) {
    fail("Study inline readiness evidence does not prove the normalized public boundary and full source shape.");
  }
  assertEnum(
    evidence.surfaceOwner,
    ["open-wrangler", "data-wrangler", "host-jupyter", "unverified"],
    "Study inline surface owner"
  );
  if (
    (["open-wrangler", "data-wrangler"].includes(evidence.surfaceOwner) &&
      evidence.surfaceOwner !== fragment.product) ||
    evidence.controlProfileReceiptSha256 !== manifest.provenance.controlProfile.receiptSha256
  ) {
    fail("Study inline surface ownership does not match the product and neither-product control receipt.");
  }
  validateNormalizedPreviewEvidence(evidence.preview);
}

function validateReadyWorkbenchEvidence(evidence, fixture) {
  exactKeys(
    evidence,
    [
      "status",
      "rowCount",
      "columnCount",
      "gridVisible",
      "busy",
      "stableFrames",
      "preview",
      "newlyOpenedTarget",
      "targetSelected",
      "engineLabel",
      "unobstructed",
      "scroll"
    ],
    "Study workbench UI evidence"
  );
  exactKeys(
    evidence.scroll,
    ["method", "beforeC00", "afterC00", "restoredC00", "settled"],
    "Study workbench scroll evidence"
  );
  assertEnum(evidence.scroll.method, ["wheel", "page-down"], "Study workbench scroll method");
  assertEnum(evidence.engineLabel, ["pandas", "polars", "not-shown"], "Study public workbench engine label");
  if (
    evidence.rowCount !== fixture.rows ||
    evidence.columnCount !== fixture.columns ||
    evidence.gridVisible !== true ||
    evidence.busy !== false ||
    evidence.stableFrames !== 2 ||
    evidence.newlyOpenedTarget !== true ||
    evidence.targetSelected !== true ||
    evidence.unobstructed !== true ||
    evidence.scroll.beforeC00 !== 0 ||
    !Number.isSafeInteger(evidence.scroll.afterC00) ||
    evidence.scroll.afterC00 <= evidence.scroll.beforeC00 ||
    evidence.scroll.afterC00 >= fixture.rows ||
    evidence.scroll.restoredC00 !== evidence.scroll.beforeC00 ||
    evidence.scroll.settled !== true ||
    evidence.scroll.restoredC00 !== 0
  ) {
    fail("Study workbench evidence does not prove the normalized full-source and scroll boundary.");
  }
  validateNormalizedPreviewEvidence(evidence.preview);
}

function validateProfileColumnEvidence(column, index, fixture) {
  exactKeys(column, ["name", "type", "missing", "minimum", "maximum", "distinct"], "Study profile-column evidence");
  if (
    column.name !== `c${String(index).padStart(2, "0")}` ||
    column.type !== "integer" ||
    column.minimum !== index ||
    column.maximum !== fixture.rows - 1 + index
  ) {
    fail("Study profile-column evidence does not match the canonical integer correctness oracle.");
  }
  exactKeys(column.missing, ["semantics", "value"], "Study profile missing-value evidence");
  assertEnum(column.missing.semantics, ["exact-count", "exact-percent"], "Study profile missing-value semantics");
  if (column.missing.value !== 0) {
    fail("Study profile missing-value evidence must retain the observed exact zero count or unqualified percentage.");
  }
  exactKeys(
    column.distinct,
    [
      "semantics",
      "count",
      "percent",
      "displayedPoint",
      "displayedUnit",
      "lowerBound",
      "upperBound",
      "includedInCorrectness",
      "includedInSemanticEquivalence"
    ],
    "Study profile distinct-count evidence"
  );
  assertEnum(
    column.distinct.semantics,
    ["exact", "approximate", "approximate-unqualified"],
    "Study profile distinct-count semantics"
  );
  if (column.distinct.semantics === "exact") {
    if (
      !(
        (column.distinct.count === fixture.rows || column.distinct.count === null) &&
        (column.distinct.percent === 100 || column.distinct.percent === null) &&
        (column.distinct.count !== null || column.distinct.percent !== null)
      ) ||
      column.distinct.displayedPoint !== null ||
      column.distinct.displayedUnit !== null ||
      column.distinct.lowerBound !== null ||
      column.distinct.upperBound !== null ||
      column.distinct.includedInCorrectness !== true ||
      column.distinct.includedInSemanticEquivalence !== true
    ) {
      fail("Exact profile evidence must retain the fixture row count, unqualified 100%, or both without an interval.");
    }
  } else if (column.distinct.semantics === "approximate") {
    if (
      column.distinct.count !== null ||
      column.distinct.percent !== null ||
      column.distinct.displayedPoint !== null ||
      column.distinct.displayedUnit !== null ||
      column.distinct.includedInCorrectness !== true ||
      column.distinct.includedInSemanticEquivalence !== true
    ) {
      fail("Approximate profile evidence cannot claim an exact count or percentage.");
    }
    assertInteger(column.distinct.lowerBound, "Study profile distinct lower bound");
    assertInteger(column.distinct.upperBound, "Study profile distinct upper bound");
    if (
      column.distinct.lowerBound > fixture.rows ||
      column.distinct.upperBound < fixture.rows ||
      column.distinct.lowerBound > column.distinct.upperBound
    ) {
      fail("Approximate profile evidence requires bounded numeric limits containing the fixture row count.");
    }
  } else {
    if (
      column.distinct.count !== null ||
      column.distinct.percent !== null ||
      column.distinct.lowerBound !== null ||
      column.distinct.upperBound !== null ||
      column.distinct.includedInCorrectness !== false ||
      column.distinct.includedInSemanticEquivalence !== false
    ) {
      fail("An unqualified approximate distinct point must be explicitly excluded from comparison.");
    }
    assertNonNegativeFinite(column.distinct.displayedPoint, "Study unqualified approximate distinct point");
    assertEnum(column.distinct.displayedUnit, ["count", "percent"], "Study unqualified approximate distinct unit");
    if (column.distinct.displayedUnit === "percent" && column.distinct.displayedPoint > 100) {
      fail("An unqualified approximate distinct percentage cannot exceed 100 percent.");
    }
  }
}

function validateUiEvidence(evidence, fragment, entry, manifest) {
  if (evidence === null) {
    if (fragment.outcome.actionStarted) {
      fail("A started product action requires bounded normalized public-UI evidence.");
    }
    return;
  }
  if (!fragment.outcome.actionStarted) {
    fail("A fragment without a product action cannot contain public-UI timing evidence.");
  }
  exactKeys(evidence, ["inline", "workbench", "profiles"], "Study public-UI evidence");
  const fixture = fixtureForStudyEntry(manifest, entry);
  const timeoutJourney = fragment.outcome.timeout?.journey ?? null;

  assertEnum(evidence.inline.status, ["ready", "failed", "timed-out"], "Study inline UI status");
  if (evidence.inline.status === "ready") {
    validateReadyInlineEvidence(evidence.inline, fixture, fragment, manifest);
  } else {
    exactKeys(evidence.inline, ["status"], "Study incomplete inline UI evidence");
  }
  if ((fragment.milestones.inlineReadyMs !== null) !== (evidence.inline.status === "ready")) {
    fail("Study inline UI evidence does not match its readiness milestone.");
  }
  if ((timeoutJourney === "inline-preview") !== (evidence.inline.status === "timed-out")) {
    fail("Study inline timeout evidence does not match the declared journey.");
  }

  assertEnum(evidence.workbench.status, ["ready", "failed", "timed-out", "not-reached"], "Study workbench UI status");
  if (evidence.workbench.status === "ready") {
    validateReadyWorkbenchEvidence(evidence.workbench, fixture);
    const observedWorkbenchEngine =
      evidence.workbench.engineLabel === "not-shown" ? "unverified" : evidence.workbench.engineLabel;
    if (
      fragment.engineEvidence === null ||
      fragment.engineEvidence.workbenchEngine !== observedWorkbenchEngine ||
      fragment.engineEvidence.workbenchVerification !==
        (observedWorkbenchEngine === "unverified" ? "not-observed" : "public-ui")
    ) {
      fail("Study public workbench engine receipt does not match the normalized visible label.");
    }
  } else {
    exactKeys(evidence.workbench, ["status"], "Study incomplete workbench UI evidence");
  }
  if ((fragment.milestones.workbenchReadyMs !== null) !== (evidence.workbench.status === "ready")) {
    fail("Study workbench UI evidence does not match its readiness milestone.");
  }
  if ((timeoutJourney === "workbench-open") !== (evidence.workbench.status === "timed-out")) {
    fail("Study workbench timeout evidence does not match the declared journey.");
  }
  const workbenchActionStarted = fragment.milestones.workbenchActionMs !== null;
  if (
    (!workbenchActionStarted && evidence.workbench.status !== "not-reached") ||
    (workbenchActionStarted && evidence.workbench.status === "not-reached")
  ) {
    fail("Study workbench UI status does not match whether its public action started.");
  }

  exactKeys(evidence.profiles, ["status", "expectedColumnCount", "columns"], "Study profile UI evidence");
  assertEnum(evidence.profiles.status, ["complete", "failed", "timed-out", "not-reached"], "Study profile UI status");
  if (evidence.profiles.expectedColumnCount !== fixture.columns || !Array.isArray(evidence.profiles.columns)) {
    fail("Study profile UI evidence does not bind the complete fixture schema.");
  }
  if (evidence.profiles.columns.length > fixture.columns) {
    fail("Study profile UI evidence exceeds the fixture column count.");
  }
  evidence.profiles.columns.forEach((column, index) => validateProfileColumnEvidence(column, index, fixture));
  if ((evidence.profiles.status === "complete") !== (fragment.milestones.profilesCompleteMs !== null)) {
    fail("Study all-column profile evidence does not match its completion milestone.");
  }
  if (evidence.profiles.status === "complete" && evidence.profiles.columns.length !== fixture.columns) {
    fail("Study complete profile evidence must contain every fixture column.");
  }
  if (
    (fragment.milestones.firstProfileReadyMs !== null) !==
    (evidence.profiles.columns.length > 0 && evidence.profiles.columns[0].name === "c00")
  ) {
    fail("Study first-profile evidence does not match its c00 milestone.");
  }
  if ((timeoutJourney === "complete-profile") !== (evidence.profiles.status === "timed-out")) {
    fail("Study profile timeout evidence does not match the declared journey.");
  }
  const profileActionStarted = fragment.milestones.profileActionMs !== null;
  if (
    (!profileActionStarted && evidence.profiles.status !== "not-reached") ||
    (profileActionStarted && evidence.profiles.status === "not-reached")
  ) {
    fail("Study profile UI status does not match whether its public action started.");
  }
  if (fragment.outcome.status === "success" && evidence.profiles.status !== "complete") {
    fail("A successful study fragment requires complete normalized profile evidence.");
  }
}

function validatePssOwnershipTracker(tracker) {
  exactKeys(
    tracker,
    [
      "protocol",
      "kind",
      "nonce",
      "supervisor",
      "editorRoot",
      "supervisorSource",
      "pythonExecutable",
      "invocationPolicySha256",
      "invocationSha256",
      "payloadArgvSha256",
      "payloadEnvironmentSha256"
    ],
    "PSS process ownership tracker receipt"
  );
  if (tracker.protocol !== PSS_OWNERSHIP_PROTOCOL || tracker.kind !== "launch") {
    fail("PSS ownership tracker protocol is invalid.");
  }
  assertString(tracker.nonce, SHA256, "PSS ownership tracker nonce");
  exactKeys(
    tracker.supervisor,
    ["pid", "startTimeTicks", "subreaperVerified", "pidfdVerified"],
    "PSS supervisor identity"
  );
  assertInteger(tracker.supervisor.pid, "PSS supervisor PID", { minimum: 1 });
  if (typeof tracker.supervisor.startTimeTicks !== "string" || !/^\d+$/u.test(tracker.supervisor.startTimeTicks)) {
    fail("PSS supervisor start time is invalid.");
  }
  if (tracker.supervisor.subreaperVerified !== true || tracker.supervisor.pidfdVerified !== true) {
    fail("PSS ownership tracker must prove subreaper and pidfd support before launch.");
  }
  exactKeys(tracker.editorRoot, ["pid", "startTimeTicks", "processGroupId", "sessionId"], "PSS editor-root identity");
  assertInteger(tracker.editorRoot.pid, "PSS editor-root PID", { minimum: 1 });
  if (typeof tracker.editorRoot.startTimeTicks !== "string" || !/^\d+$/u.test(tracker.editorRoot.startTimeTicks)) {
    fail("PSS editor-root start time is invalid.");
  }
  if (
    tracker.editorRoot.pid === tracker.supervisor.pid ||
    tracker.editorRoot.processGroupId !== tracker.editorRoot.pid ||
    tracker.editorRoot.sessionId !== tracker.editorRoot.pid
  ) {
    fail("PSS editor root must own a dedicated process group and session beneath its supervisor.");
  }
  exactKeys(tracker.supervisorSource, ["sha256", "filesystemIdentity"], "PSS supervisor source provenance");
  assertString(tracker.supervisorSource.sha256, SHA256, "PSS supervisor source SHA-256");
  validateFilesystemIdentity(tracker.supervisorSource.filesystemIdentity, "PSS supervisor source filesystem identity");
  exactKeys(
    tracker.pythonExecutable,
    ["implementation", "version", "sha256", "filesystemIdentity"],
    "PSS supervisor Python executable provenance"
  );
  if (tracker.pythonExecutable.implementation !== "CPython") {
    fail("PSS supervisor Python implementation is invalid.");
  }
  assertString(tracker.pythonExecutable.sha256, SHA256, "PSS supervisor Python executable SHA-256");
  validateFilesystemIdentity(
    tracker.pythonExecutable.filesystemIdentity,
    "PSS supervisor Python executable filesystem identity"
  );
  assertString(tracker.pythonExecutable.version, PYTHON_VERSION, "PSS supervisor Python version");
  assertString(tracker.invocationPolicySha256, SHA256, "PSS supervisor invocation-policy SHA-256");
  assertString(tracker.invocationSha256, SHA256, "PSS supervisor invocation SHA-256");
  assertString(tracker.payloadArgvSha256, SHA256, "PSS supervisor payload-argv SHA-256");
  assertString(tracker.payloadEnvironmentSha256, SHA256, "PSS supervisor payload-environment SHA-256");
  return tracker;
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

function validatePssRetainedIdentities(identities, ownershipTracker) {
  if (!Array.isArray(identities) || identities.length === 0 || identities.length > 131_072) {
    fail("PSS retained owned identities must contain one to 131072 processes.");
  }
  const retained = new Map();
  for (const identity of identities) {
    exactKeys(identity, ["pid", "startTimeTicks"], "PSS retained owned identity");
    assertInteger(identity.pid, "PSS retained owned PID", { minimum: 1 });
    if (typeof identity.startTimeTicks !== "string" || !/^\d+$/u.test(identity.startTimeTicks)) {
      fail("PSS retained owned process start time is invalid.");
    }
    if (retained.has(identity.pid)) {
      fail("PSS retained owned identities are duplicated.");
    }
    retained.set(identity.pid, identity);
  }
  const root = retained.get(ownershipTracker.editorRoot.pid);
  if (root?.startTimeTicks !== ownershipTracker.editorRoot.startTimeTicks) {
    fail("PSS retained owned identities do not contain the supervisor-receipt editor root.");
  }
  return retained;
}

function parseMonotonicNanoseconds(value, label) {
  assertString(value, MONOTONIC_NANOSECONDS, label);
  return BigInt(value);
}

function millisecondsLowerBoundToNanoseconds(value, label) {
  assertNonNegativeFinite(value, label);
  const match = /^(?<integer>\d+)(?:\.(?<fraction>\d+))?(?:e(?<exponent>[+-]?\d+))?$/iu.exec(String(value));
  if (match?.groups === undefined) {
    fail(`${label} cannot be represented as canonical decimal milliseconds.`);
  }
  const fraction = match.groups.fraction ?? "";
  const exponent = Number(match.groups.exponent ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    fail(`${label} decimal exponent exceeds its bound.`);
  }
  const coefficient = BigInt(`${match.groups.integer}${fraction}`);
  const decimalPlaces = fraction.length - exponent;
  if (decimalPlaces <= 6) {
    return coefficient * 10n ** BigInt(6 - decimalPlaces);
  }
  const divisor = 10n ** BigInt(decimalPlaces - 6);
  return (coefficient + divisor - 1n) / divisor;
}

function validatePssClock(clock) {
  exactKeys(clock, ["source", "originNanoseconds", "normalization"], "PSS monotonic clock");
  if (clock.source !== PSS_CLOCK_SOURCE || clock.normalization !== PSS_CLOCK_NORMALIZATION) {
    fail("PSS samples must use the preregistered Linux process.hrtime.bigint normalization.");
  }
  return parseMonotonicNanoseconds(clock.originNanoseconds, "PSS monotonic-clock origin");
}

function validatePssSample(sample, originNanoseconds, ownershipTracker, retainedIdentities) {
  exactKeys(
    sample,
    [
      "scheduledMonotonicNanoseconds",
      "startedMonotonicNanoseconds",
      "endedMonotonicNanoseconds",
      "latenessMs",
      "elapsedMs",
      "totalPssBytes",
      "totalRssBytes",
      "categories",
      "processes"
    ],
    "PSS sample"
  );
  const scheduledAt = parseMonotonicNanoseconds(
    sample.scheduledMonotonicNanoseconds,
    "PSS scheduled sample monotonic timestamp"
  );
  const startedAt = parseMonotonicNanoseconds(
    sample.startedMonotonicNanoseconds,
    "PSS sample-start monotonic timestamp"
  );
  const endedAt = parseMonotonicNanoseconds(sample.endedMonotonicNanoseconds, "PSS sample-end monotonic timestamp");
  if (scheduledAt < originNanoseconds || startedAt < scheduledAt || endedAt < startedAt) {
    fail("PSS sample scheduled, start, and end timestamps are inconsistent.");
  }
  assertNonNegativeFinite(sample.latenessMs, "PSS sample lateness");
  if (sample.latenessMs !== Number(startedAt - scheduledAt) / 1_000_000) {
    fail("PSS sample lateness does not match its exact monotonic timestamps.");
  }
  assertNonNegativeFinite(sample.elapsedMs, "PSS sample elapsed time");
  if (sample.elapsedMs !== Number(endedAt - originNanoseconds) / 1_000_000) {
    fail("PSS sample elapsed time does not match its exact monotonic normalization.");
  }
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
  let foundRoot = false;
  for (const process of sample.processes) {
    validatePssProcess(process);
    const retainedIdentity = retainedIdentities.get(process.pid);
    if (retainedIdentity?.startTimeTicks !== process.startTimeTicks) {
      fail("PSS sample process is absent from the cumulative retained-owned identity set.");
    }
    if (pids.has(process.pid)) {
      fail("PSS sample cannot count one PID more than once.");
    }
    pids.add(process.pid);
    totalPssBytes += process.pssBytes;
    totalRssBytes += process.rssBytes;
    categoryTotals[process.category] += process.pssBytes;
    foundRoot ||=
      process.pid === ownershipTracker.editorRoot.pid &&
      process.startTimeTicks === ownershipTracker.editorRoot.startTimeTicks;
  }
  if (!foundRoot) {
    fail("PSS sample does not retain its launch-receipt editor root.");
  }
  if (sample.totalPssBytes !== totalPssBytes || sample.totalRssBytes !== totalRssBytes) {
    fail("PSS sample totals must equal the unique process totals.");
  }
  for (const category of RESOURCE_CATEGORIES) {
    if (sample.categories[category] !== categoryTotals[category]) {
      fail("PSS category totals must equal the unique process assignments.");
    }
  }
  return { scheduledAt, startedAt, endedAt };
}

function validatePssTerminalBoundary(boundary, samples, valid) {
  if (boundary === null) {
    return;
  }
  exactKeys(
    boundary,
    [
      "targetMonotonicNanoseconds",
      "firstEligibleSampleScheduledMonotonicNanoseconds",
      "firstEligibleSampleStartedMonotonicNanoseconds",
      "firstEligibleSampleEndedMonotonicNanoseconds",
      "startOvershootMs",
      "sampleLatenessMs",
      "maximumOvershootMs"
    ],
    "PSS terminal boundary"
  );
  const target = parseMonotonicNanoseconds(boundary.targetMonotonicNanoseconds, "PSS terminal target timestamp");
  const scheduledAt = parseMonotonicNanoseconds(
    boundary.firstEligibleSampleScheduledMonotonicNanoseconds,
    "PSS first terminal scheduled timestamp"
  );
  const startedAt = parseMonotonicNanoseconds(
    boundary.firstEligibleSampleStartedMonotonicNanoseconds,
    "PSS first terminal start timestamp"
  );
  const endedAt = parseMonotonicNanoseconds(
    boundary.firstEligibleSampleEndedMonotonicNanoseconds,
    "PSS first terminal end timestamp"
  );
  if (scheduledAt > startedAt || startedAt < target || endedAt < startedAt) {
    fail("PSS terminal sample does not begin at or after its target.");
  }
  assertNonNegativeFinite(boundary.startOvershootMs, "PSS terminal start overshoot");
  assertNonNegativeFinite(boundary.sampleLatenessMs, "PSS terminal sample lateness");
  if (
    boundary.maximumOvershootMs !== PSS_MAXIMUM_TERMINAL_OVERSHOOT_MS ||
    boundary.startOvershootMs !== Number(startedAt - target) / 1_000_000 ||
    boundary.sampleLatenessMs !== Number(startedAt - scheduledAt) / 1_000_000
  ) {
    fail("PSS terminal boundary does not match its preregistered overshoot contract.");
  }
  if (valid && boundary.startOvershootMs > boundary.maximumOvershootMs) {
    fail("A valid PSS terminal sample exceeds its bounded overshoot.");
  }
  if (
    samples.length === 0 ||
    samples.at(-1).scheduledMonotonicNanoseconds !== boundary.firstEligibleSampleScheduledMonotonicNanoseconds ||
    samples.at(-1).startedMonotonicNanoseconds !== boundary.firstEligibleSampleStartedMonotonicNanoseconds ||
    samples.at(-1).endedMonotonicNanoseconds !== boundary.firstEligibleSampleEndedMonotonicNanoseconds ||
    samples.at(-1).latenessMs !== boundary.sampleLatenessMs
  ) {
    fail("PSS terminal evidence must identify the retained final sample.");
  }
  if (samples.slice(0, -1).some((sample) => BigInt(sample.startedMonotonicNanoseconds) >= target)) {
    fail("PSS terminal evidence did not stop on the first eligible sample.");
  }
}

export function validateDataWranglerStudyResourceObservation(observation) {
  exactKeys(
    observation,
    [
      "protocol",
      "clock",
      "ownershipTracker",
      "valid",
      "reasonClass",
      "intervalMs",
      "maximumLatenessMs",
      "missedSamples",
      "terminalBoundary",
      "retainedOwnedIdentities",
      "samples"
    ],
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
  if (observation.maximumLatenessMs !== PSS_MAXIMUM_LATENESS_MS) {
    fail("Study resource samples must retain the preregistered lateness bound.");
  }
  const ownershipTracker = validatePssOwnershipTracker(observation.ownershipTracker);
  const retainedIdentities = validatePssRetainedIdentities(observation.retainedOwnedIdentities, ownershipTracker);
  const originNanoseconds = validatePssClock(observation.clock);
  assertInteger(observation.missedSamples, "Study missed resource samples");
  if (observation.valid && observation.missedSamples !== 0) {
    fail("A valid resource observation cannot contain sampling gaps.");
  }
  if (!Array.isArray(observation.samples)) {
    fail("Study resource samples must be an array.");
  }
  if (observation.samples.length > DATA_WRANGLER_STUDY_MAXIMUM_RESOURCE_SAMPLES) {
    fail("Study resource samples exceed the fixed trial, deadline, and quiescence bound.");
  }
  if (observation.valid && observation.samples.length < 5) {
    fail("A valid resource observation must contain at least five samples.");
  }
  let previousElapsedMs = -1;
  let previousScheduledAt = null;
  let previousStartedAt = null;
  let previousEndedAt = null;
  const intervalNanoseconds = BigInt(observation.intervalMs) * 1_000_000n;
  for (const sample of observation.samples) {
    const { scheduledAt, startedAt, endedAt } = validatePssSample(
      sample,
      originNanoseconds,
      ownershipTracker,
      retainedIdentities
    );
    if (sample.elapsedMs < previousElapsedMs) {
      fail("PSS samples must be ordered by elapsed time.");
    }
    if (
      observation.valid &&
      (sample.latenessMs > observation.maximumLatenessMs ||
        (previousScheduledAt !== null && scheduledAt - previousScheduledAt !== intervalNanoseconds))
    ) {
      fail("A valid PSS observation must retain its non-missed 200 ms cadence.");
    }
    if (
      (previousStartedAt !== null && startedAt <= previousStartedAt) ||
      (previousEndedAt !== null && endedAt <= previousEndedAt)
    ) {
      fail("PSS sample-start and sample-end timestamps must be strictly ordered.");
    }
    previousElapsedMs = sample.elapsedMs;
    previousScheduledAt = scheduledAt;
    previousStartedAt = startedAt;
    previousEndedAt = endedAt;
  }
  validatePssTerminalBoundary(observation.terminalBoundary, observation.samples, observation.valid);
  return observation;
}

function resourceObservationContainsProcess(observation, proof, category, maximumElapsedMs = Number.POSITIVE_INFINITY) {
  return observation.samples.some(
    (sample) =>
      sample.elapsedMs <= maximumElapsedMs &&
      sample.processes.some(
        (process) =>
          process.pid === proof.pid && process.startTimeTicks === proof.startTimeTicks && process.category === category
      )
  );
}

function fragmentSkippedEditorLaunch(fragment) {
  return (
    fragment.outcome.status === "unsupported" ||
    (fragment.outcome.status === "pre-action-invalid" && fragment.environmentGate?.passed === false)
  );
}

function fragmentFailedBeforeResourceSampling(fragment) {
  return (
    fragment.outcome.status === "pre-action-invalid" &&
    fragment.outcome.actionStarted === false &&
    ["setup", "resource-sampling"].includes(fragment.outcome.reasonClass) &&
    fragment.resourceObservation === null &&
    fragment.processProofs?.configuredKernel === null &&
    fragment.processProofs?.openWranglerRuntime === null &&
    isRecord(fragment.cleanupProof?.supervisorLaunchReceipt)
  );
}

function validateStudyProcessProofs(proofs, fragment, manifest) {
  const proofRequired = fragment.outcome.actionStarted;
  const launchSkipped = fragmentSkippedEditorLaunch(fragment);
  if (proofs === null) {
    if (!launchSkipped) {
      fail("A launched study fragment requires its editor-root process proof.");
    }
    return;
  }
  if (launchSkipped) {
    fail("A pre-launch study outcome cannot contain editor or product process proofs.");
  }
  exactKeys(proofs, ["editorRoot", "configuredKernel", "openWranglerRuntime"], "Study process identity proofs");
  exactKeys(proofs.editorRoot, ["pid", "startTimeTicks", "capturedAtLaunch"], "Study editor-root identity proof");
  assertInteger(proofs.editorRoot.pid, "Study editor-root PID", { minimum: 1 });
  if (typeof proofs.editorRoot.startTimeTicks !== "string" || !/^\d+$/u.test(proofs.editorRoot.startTimeTicks)) {
    fail("Study editor-root start time is invalid.");
  }
  if (proofs.editorRoot.capturedAtLaunch !== true) {
    fail("Study editor-root identity must be captured at launch.");
  }
  const ownershipTracker =
    fragment.resourceObservation?.ownershipTracker ?? fragment.cleanupProof?.supervisorLaunchReceipt;
  if (fragment.resourceObservation === null && ownershipTracker !== undefined) {
    validatePssOwnershipTracker(ownershipTracker);
  }
  const expectedTracker = manifest.provenance.ownershipTracker;
  if (
    ownershipTracker !== undefined &&
    (ownershipTracker.protocol !== expectedTracker.protocol ||
      canonicalStudyJson(ownershipTracker.supervisorSource) !== canonicalStudyJson(expectedTracker.supervisorSource) ||
      canonicalStudyJson(ownershipTracker.pythonExecutable) !== canonicalStudyJson(expectedTracker.pythonExecutable) ||
      ownershipTracker.invocationPolicySha256 !== expectedTracker.invocationPolicySha256)
  ) {
    fail("Study ownership receipt does not match the manifest-pinned supervisor and Python identity.");
  }
  if (
    ownershipTracker !== undefined &&
    (ownershipTracker.editorRoot.pid !== proofs.editorRoot.pid ||
      ownershipTracker.editorRoot.startTimeTicks !== proofs.editorRoot.startTimeTicks)
  ) {
    fail("Study ownership receipt does not match the editor root captured from the supervisor receipt.");
  }
  if (
    fragment.resourceObservation !== null &&
    fragment.resourceObservation.samples.length > 0 &&
    !resourceObservationContainsProcess(fragment.resourceObservation, proofs.editorRoot, "editor-main")
  ) {
    fail("Study resource evidence does not contain the exact editor root captured at launch.");
  }

  if (proofs.configuredKernel === null) {
    if (proofRequired) {
      fail("A started product action requires configured-kernel and runtime identity proofs.");
    }
    if (proofs.openWranglerRuntime !== null) {
      fail("An Open Wrangler runtime proof requires a configured-kernel proof.");
    }
    return;
  }
  if (fragment.resourceObservation === null) {
    fail("A configured-kernel process proof requires the correlated resource observation.");
  }
  exactKeys(
    proofs.configuredKernel,
    ["pid", "startTimeTicks", "executableSha256", "kernelIdSha256", "observedBeforeAction"],
    "Study configured-kernel identity proof"
  );
  assertInteger(proofs.configuredKernel.pid, "Study configured-kernel PID", { minimum: 1 });
  if (
    typeof proofs.configuredKernel.startTimeTicks !== "string" ||
    !/^\d+$/u.test(proofs.configuredKernel.startTimeTicks)
  ) {
    fail("Study configured-kernel start time is invalid.");
  }
  if (proofs.configuredKernel.executableSha256 !== manifest.python.executableSha256) {
    fail("Study configured-kernel executable does not match the manifest-pinned Python.");
  }
  assertString(proofs.configuredKernel.kernelIdSha256, SHA256, "Study configured-kernel ID SHA-256");
  if (proofs.configuredKernel.observedBeforeAction !== true) {
    fail("Study configured-kernel proof must precede the public product action.");
  }
  const actionBoundary = fragment.milestones.inlineActionMs ?? Number.POSITIVE_INFINITY;
  if (
    fragment.resourceObservation.samples.length > 0 &&
    !resourceObservationContainsProcess(
      fragment.resourceObservation,
      proofs.configuredKernel,
      "configured-kernel",
      actionBoundary
    )
  ) {
    fail("Study resource evidence does not contain the exact configured kernel before the public action.");
  }

  exactKeys(proofs.openWranglerRuntime, ["status", "pid", "startTimeTicks"], "Study Open Wrangler runtime proof");
  const runtime = proofs.openWranglerRuntime;
  assertEnum(
    runtime.status,
    ["observed", "live-kernel-absence-proven", "not-applicable"],
    "Study Open Wrangler runtime status"
  );
  if (runtime.status === "observed") {
    if (fragment.product !== "open-wrangler") {
      fail("Only an Open Wrangler trial may claim an observed Open Wrangler runtime.");
    }
    assertInteger(runtime.pid, "Study Open Wrangler runtime PID", { minimum: 1 });
    if (typeof runtime.startTimeTicks !== "string" || !/^\d+$/u.test(runtime.startTimeTicks)) {
      fail("Study Open Wrangler runtime start time is invalid.");
    }
    if (!resourceObservationContainsProcess(fragment.resourceObservation, runtime, "open-wrangler-runtime")) {
      fail("Study resource evidence does not contain the claimed Open Wrangler runtime.");
    }
  } else {
    if (runtime.pid !== null || runtime.startTimeTicks !== null) {
      fail("An absent or inapplicable Open Wrangler runtime cannot carry a process identity.");
    }
    if (runtime.status === "live-kernel-absence-proven" && fragment.product !== "open-wrangler") {
      fail("Only an Open Wrangler trial may use the live-kernel runtime-absence proof.");
    }
    if (runtime.status === "not-applicable" && fragment.product !== "data-wrangler") {
      fail("Open Wrangler trials require an observed runtime or a live-kernel absence proof.");
    }
    if (
      fragment.resourceObservation.samples.some((sample) =>
        sample.processes.some((process) => process.category === "open-wrangler-runtime")
      )
    ) {
      fail("Study resource evidence contradicts the claimed Open Wrangler runtime absence.");
    }
  }
}

function validateSupervisorTerminalReceipt(receipt, launchReceipt) {
  exactKeys(
    receipt,
    [
      "protocol",
      "kind",
      "nonce",
      "supervisor",
      "editorRoot",
      "retainedOwnedIdentities",
      "identityReuseEvents",
      "emptyCensusProof",
      "supervisorExitCode"
    ],
    "Study supervisor terminal cleanup receipt"
  );
  if (
    receipt.protocol !== PSS_OWNERSHIP_PROTOCOL ||
    receipt.kind !== "terminal-cleanup" ||
    receipt.nonce !== launchReceipt.nonce
  ) {
    fail("Study supervisor terminal receipt is not correlated with its launch receipt.");
  }
  exactKeys(receipt.supervisor, ["pid", "startTimeTicks"], "Study cleanup supervisor identity");
  exactKeys(receipt.editorRoot, ["pid", "startTimeTicks"], "Study cleanup editor-root identity");
  if (
    receipt.supervisor.pid !== launchReceipt.supervisor.pid ||
    receipt.supervisor.startTimeTicks !== launchReceipt.supervisor.startTimeTicks ||
    receipt.editorRoot.pid !== launchReceipt.editorRoot.pid ||
    receipt.editorRoot.startTimeTicks !== launchReceipt.editorRoot.startTimeTicks
  ) {
    fail("Study supervisor terminal receipt changed its launch-time process identities.");
  }
  if (
    !Array.isArray(receipt.retainedOwnedIdentities) ||
    receipt.retainedOwnedIdentities.length === 0 ||
    receipt.retainedOwnedIdentities.length > 256
  ) {
    fail("Study supervisor terminal receipt has an invalid cumulative owned-process set.");
  }
  const terminalIdentities = new Map();
  const terminalIdentitiesByPid = new Map();
  for (const identity of receipt.retainedOwnedIdentities) {
    exactKeys(identity, ["pid", "startTimeTicks", "disposition"], "Study supervisor terminal owned identity");
    assertInteger(identity.pid, "Study supervisor terminal owned PID", { minimum: 1 });
    if (typeof identity.startTimeTicks !== "string" || !/^\d+$/u.test(identity.startTimeTicks)) {
      fail("Study supervisor terminal owned-process start time is invalid.");
    }
    assertEnum(identity.disposition, ["exited", "terminated"], "Study supervisor terminal disposition");
    const key = `${identity.pid}:${identity.startTimeTicks}`;
    if (terminalIdentities.has(key)) {
      fail("Study supervisor terminal receipt repeats an owned process identity.");
    }
    terminalIdentities.set(key, identity);
    const forPid = terminalIdentitiesByPid.get(identity.pid) ?? [];
    forPid.push(identity);
    terminalIdentitiesByPid.set(identity.pid, forPid);
  }
  const rootKey = `${launchReceipt.editorRoot.pid}:${launchReceipt.editorRoot.startTimeTicks}`;
  if (!terminalIdentities.has(rootKey)) {
    fail("Study supervisor terminal receipt omits its editor root.");
  }

  if (!Array.isArray(receipt.identityReuseEvents) || receipt.identityReuseEvents.length > 256) {
    fail("Study supervisor terminal identity-reuse evidence exceeds its bound.");
  }
  const reuseEventsByPid = new Map();
  const reuseEventKeys = new Set();
  for (const event of receipt.identityReuseEvents) {
    exactKeys(
      event,
      ["pid", "previousStartTimeTicks", "replacementStartTimeTicks"],
      "Study supervisor identity-reuse event"
    );
    assertInteger(event.pid, "Study supervisor reused PID", { minimum: 1 });
    if (
      typeof event.previousStartTimeTicks !== "string" ||
      !/^\d+$/u.test(event.previousStartTimeTicks) ||
      typeof event.replacementStartTimeTicks !== "string" ||
      !/^\d+$/u.test(event.replacementStartTimeTicks) ||
      event.previousStartTimeTicks === event.replacementStartTimeTicks
    ) {
      fail("Study supervisor identity-reuse event has invalid process start times.");
    }
    const eventKey = `${event.pid}:${event.previousStartTimeTicks}:${event.replacementStartTimeTicks}`;
    if (reuseEventKeys.has(eventKey)) {
      fail("Study supervisor identity-reuse events cannot repeat.");
    }
    reuseEventKeys.add(eventKey);
    const forPid = reuseEventsByPid.get(event.pid) ?? [];
    forPid.push(event);
    reuseEventsByPid.set(event.pid, forPid);
  }
  for (const [pid, identities] of terminalIdentitiesByPid) {
    const events = reuseEventsByPid.get(pid) ?? [];
    if (identities.length === 1) {
      if (events.length !== 0) {
        fail("Study supervisor identity-reuse evidence names an unambiguous PID.");
      }
      continue;
    }
    if (events.length !== identities.length - 1) {
      fail("Study supervisor identity-reuse evidence does not cover its complete PID history.");
    }
    const historyStarts = new Set(identities.map((identity) => identity.startTimeTicks));
    let expectedPrevious = events[0]?.previousStartTimeTicks;
    const observedStarts = new Set([expectedPrevious]);
    for (const event of events) {
      if (
        event.previousStartTimeTicks !== expectedPrevious ||
        !historyStarts.has(event.previousStartTimeTicks) ||
        !historyStarts.has(event.replacementStartTimeTicks) ||
        observedStarts.has(event.replacementStartTimeTicks)
      ) {
        fail("Study supervisor identity-reuse events do not form one ordered PID history.");
      }
      observedStarts.add(event.replacementStartTimeTicks);
      expectedPrevious = event.replacementStartTimeTicks;
    }
    if (observedStarts.size !== historyStarts.size) {
      fail("Study supervisor identity-reuse evidence omits a retained PID generation.");
    }
  }
  for (const pid of reuseEventsByPid.keys()) {
    if (!terminalIdentitiesByPid.has(pid)) {
      fail("Study supervisor identity-reuse evidence names an unretained PID.");
    }
  }
  exactKeys(receipt.emptyCensusProof, ["requiredConsecutiveChecks", "checks"], "Study supervisor empty-census proof");
  if (
    receipt.emptyCensusProof.requiredConsecutiveChecks !== 3 ||
    !Array.isArray(receipt.emptyCensusProof.checks) ||
    receipt.emptyCensusProof.checks.length !== receipt.emptyCensusProof.requiredConsecutiveChecks
  ) {
    fail("Study supervisor cleanup requires three repeated empty ownership censuses.");
  }
  let previousCheck = null;
  for (const check of receipt.emptyCensusProof.checks) {
    exactKeys(check, ["monotonicNanoseconds", "ownedProcessCount"], "Study supervisor empty-census check");
    const timestamp = parseMonotonicNanoseconds(
      check.monotonicNanoseconds,
      "Study supervisor empty-census monotonic timestamp"
    );
    if (check.ownedProcessCount !== 0 || (previousCheck !== null && timestamp <= previousCheck)) {
      fail("Study supervisor empty-census checks must be empty and strictly ordered.");
    }
    previousCheck = timestamp;
  }
  assertInteger(receipt.supervisorExitCode, "Study supervisor exit code");
  if (receipt.supervisorExitCode > 255) {
    fail("Study supervisor exit code exceeds its byte-sized bound.");
  }
  if (receipt.identityReuseEvents.length > 0 && receipt.supervisorExitCode !== 125) {
    fail("Study supervisor must latch PID reuse as invalid evidence after cleanup.");
  }
  return { terminalIdentities, identityReuseEvents: receipt.identityReuseEvents };
}

function validateCleanupProof(proof, processProofs, fragment) {
  const launchSkipped = fragmentSkippedEditorLaunch(fragment);
  if (proof === null) {
    if (!launchSkipped) {
      fail("A launched study fragment requires post-trial process-tree cleanup proof.");
    }
    return;
  }
  if (launchSkipped) {
    fail("A pre-launch study outcome cannot contain process-tree cleanup evidence.");
  }
  const proofKeys = [
    "editorRootPid",
    "editorRootStartTimeTicks",
    "startedAfterTrial",
    "intervalMs",
    "deadlineMs",
    "retainedOwnedIdentities",
    "supervisorTerminalReceipt",
    "observations",
    "treeEmpty",
    "status",
    "failure"
  ];
  if (fragment.resourceObservation === null) proofKeys.push("supervisorLaunchReceipt");
  exactKeys(proof, proofKeys, "Study cleanup proof");
  if (
    processProofs === null ||
    proof.editorRootPid !== processProofs.editorRoot.pid ||
    proof.editorRootStartTimeTicks !== processProofs.editorRoot.startTimeTicks
  ) {
    fail("Study cleanup proof does not match the editor root captured at launch.");
  }
  if (proof.startedAfterTrial !== true || proof.intervalMs !== 200 || proof.deadlineMs !== 10_000) {
    fail("Study cleanup proof does not match the bounded post-trial protocol.");
  }
  const sampledRetainedIdentities =
    fragment.resourceObservation?.retainedOwnedIdentities ??
    [processProofs.editorRoot, processProofs.configuredKernel, processProofs.openWranglerRuntime]
      .filter((identity) => identity?.pid !== null && identity?.pid !== undefined)
      .sort((left, right) => left.pid - right.pid);
  const ownershipTracker =
    fragment.resourceObservation?.ownershipTracker ?? validatePssOwnershipTracker(proof.supervisorLaunchReceipt);
  const { terminalIdentities, identityReuseEvents } = validateSupervisorTerminalReceipt(
    proof.supervisorTerminalReceipt,
    ownershipTracker
  );
  const expectedRetainedIdentities = [
    ...new Map(
      [...sampledRetainedIdentities, ...terminalIdentities.values()].map((identity) => [
        `${identity.pid}:${identity.startTimeTicks}`,
        identity
      ])
    ).values()
  ]
    .sort(
      (left, right) =>
        left.pid - right.pid ||
        (BigInt(left.startTimeTicks) < BigInt(right.startTimeTicks)
          ? -1
          : BigInt(left.startTimeTicks) > BigInt(right.startTimeTicks)
            ? 1
            : 0)
    )
    .map(({ pid, startTimeTicks }) => ({ pid, startTimeTicks }));
  if (
    !Array.isArray(proof.retainedOwnedIdentities) ||
    canonicalStudyJson(proof.retainedOwnedIdentities) !== canonicalStudyJson(expectedRetainedIdentities)
  ) {
    fail("Study cleanup proof is not the canonical union of sampled and supervisor-owned identities.");
  }
  const retainedIdentityKeys = new Set();
  for (const identity of proof.retainedOwnedIdentities) {
    exactKeys(identity, ["pid", "startTimeTicks"], "Study cleanup retained owned identity");
    assertInteger(identity.pid, "Study cleanup retained owned PID", { minimum: 1 });
    if (typeof identity.startTimeTicks !== "string" || !/^\d+$/u.test(identity.startTimeTicks)) {
      fail("Study cleanup retained owned process start time is invalid.");
    }
    const key = `${identity.pid}:${identity.startTimeTicks}`;
    if (retainedIdentityKeys.has(key)) {
      fail("Study cleanup retained owned identities cannot repeat.");
    }
    retainedIdentityKeys.add(key);
  }
  if (!Array.isArray(proof.observations) || proof.observations.length < 2 || proof.observations.length > 51) {
    fail("Study cleanup proof must retain two to fifty-one bounded process-tree observations.");
  }
  let previousElapsedMs = -1;
  let observedEmptyTree = false;
  proof.observations.forEach((observation, index) => {
    exactKeys(observation, ["sequence", "elapsedMs", "processes"], "Study cleanup observation");
    assertNonNegativeFinite(observation.elapsedMs, "Study cleanup observation elapsed time");
    if (
      observation.sequence !== index ||
      (index === 0 && observation.elapsedMs > proof.intervalMs) ||
      (index > 0 &&
        (observation.elapsedMs <= previousElapsedMs ||
          observation.elapsedMs - previousElapsedMs < proof.intervalMs / 2 ||
          observation.elapsedMs - previousElapsedMs >= proof.intervalMs * 2))
    ) {
      fail("Study cleanup observations must retain their actual ordered near-200 ms polling cadence.");
    }
    if (!Array.isArray(observation.processes) || observation.processes.length > 4_096) {
      fail("Study cleanup process identities exceed the bounded evidence limit.");
    }
    const identities = new Set();
    for (const process of observation.processes) {
      exactKeys(process, ["pid", "startTimeTicks"], "Study cleanup process identity");
      assertInteger(process.pid, "Study cleanup process PID", { minimum: 1 });
      if (typeof process.startTimeTicks !== "string" || !/^\d+$/u.test(process.startTimeTicks)) {
        fail("Study cleanup process start time is invalid.");
      }
      const identity = `${process.pid}:${process.startTimeTicks}`;
      if (!retainedIdentityKeys.has(identity)) {
        fail("Study cleanup polling observed a process absent from the supervisor's cumulative ownership receipt.");
      }
      if (identities.has(identity)) {
        fail("Study cleanup observations cannot repeat a process identity.");
      }
      identities.add(identity);
    }
    if (observation.processes.length === 0) {
      observedEmptyTree = true;
    } else if (observedEmptyTree) {
      fail("Study cleanup polling cannot observe a process after the tree first becomes empty.");
    }
    previousElapsedMs = observation.elapsedMs;
  });
  const terminal = proof.observations.at(-1);
  const terminalConfirmation = proof.observations.at(-2);
  if (
    proof.status !== "complete" ||
    terminal.elapsedMs > proof.deadlineMs ||
    terminalConfirmation.processes.length !== 0 ||
    terminal.processes.length !== 0 ||
    proof.treeEmpty !== true ||
    proof.failure !== null
  ) {
    fail(
      "A publishable cleanup proof must end with two consecutive empty process-tree observations within ten seconds."
    );
  }
  if (
    identityReuseEvents.length > 0 &&
    (fragment.outcome.status !== "product-failure" || fragment.outcome.reasonClass !== "resource-sampling")
  ) {
    fail("A PID-reuse cleanup receipt requires a resource-sampling product failure.");
  }
}

function expectedTrialExtensionInventory(manifest, product) {
  const productExtension =
    product === "open-wrangler"
      ? { extensionId: manifest.candidate.extensionId, version: manifest.candidate.version }
      : { extensionId: manifest.baseline.extensionId, version: manifest.baseline.version };
  return createDataWranglerComparisonMeasuredInventory(productExtension);
}

function validateTrialProvenance(provenance, fragment, entry, manifest) {
  const launchSkipped = fragmentSkippedEditorLaunch(fragment);
  if (provenance === null) {
    if (!launchSkipped) {
      fail("A launched study fragment requires before-and-after trial provenance.");
    }
    return;
  }
  if (launchSkipped) {
    fail("A pre-launch study outcome cannot contain trial provenance.");
  }
  exactKeys(
    provenance,
    [
      "candidateBefore",
      "candidateAfter",
      "editorBefore",
      "editorAfter",
      "extensionsBefore",
      "extensionsAfter",
      "driverBefore",
      "driverAfter",
      "pythonBefore",
      "pythonAfter",
      "fixtureBefore",
      "fixtureAfter",
      "sourceCopyBefore",
      "sourceCopyAfter",
      "editorProcess",
      "kernelProcess",
      "revalidatedAfterCleanup"
    ],
    "Study trial provenance"
  );
  for (const [receipt, label] of [
    [provenance.candidateBefore, "before"],
    [provenance.candidateAfter, "after"]
  ]) {
    exactKeys(receipt, ["sha256", "filesystemIdentity"], `Study candidate ${label} trial receipt`);
    assertString(receipt.sha256, SHA256, `Study candidate ${label} SHA-256`);
    validateFilesystemIdentity(receipt.filesystemIdentity, `Study candidate ${label} filesystem identity`);
    if (
      receipt.sha256 !== manifest.candidate.sha256 ||
      canonicalStudyJson(receipt.filesystemIdentity) !== canonicalStudyJson(manifest.candidate.filesystemIdentity)
    ) {
      fail("Study trial candidate receipt does not match the manifest-pinned VSIX.");
    }
  }
  if (canonicalStudyJson(provenance.candidateBefore) !== canonicalStudyJson(provenance.candidateAfter)) {
    fail("Study trial candidate changed before post-cleanup revalidation.");
  }
  for (const [receipt, label] of [
    [provenance.editorBefore, "before"],
    [provenance.editorAfter, "after"]
  ]) {
    if (canonicalStudyJson(receipt) !== canonicalStudyJson(manifest.editor)) {
      fail(`Study ${label} trial editor build does not match the immutable manifest.`);
    }
  }
  const expectedInventory = expectedTrialExtensionInventory(manifest, fragment.product);
  if (
    canonicalStudyJson(provenance.extensionsBefore) !== canonicalStudyJson(expectedInventory) ||
    canonicalStudyJson(provenance.extensionsAfter) !== canonicalStudyJson(expectedInventory)
  ) {
    fail("Study trial extension inventory does not match the exact common and product extensions.");
  }
  for (const [receipt, label] of [
    [provenance.driverBefore, "before"],
    [provenance.driverAfter, "after"]
  ]) {
    validateComparisonDriverReceipt(receipt);
    if (canonicalStudyJson(receipt) !== canonicalStudyJson(manifest.provenance.comparisonDriver)) {
      fail(`Study ${label} trial driver does not match the manifest-pinned neutral VSIX and journey graph.`);
    }
  }
  if (canonicalStudyJson(provenance.driverBefore) !== canonicalStudyJson(provenance.driverAfter)) {
    fail("Study comparison driver changed during the measured trial.");
  }
  const expectedPython = {
    executableSha256: manifest.python.executableSha256,
    environmentSha256: manifest.python.environmentSha256,
    kernelspecSha256: manifest.python.kernel.kernelspecSha256
  };
  if (
    canonicalStudyJson(provenance.pythonBefore) !== canonicalStudyJson(expectedPython) ||
    canonicalStudyJson(provenance.pythonAfter) !== canonicalStudyJson(expectedPython)
  ) {
    fail("Study trial Python receipt does not match the configured manifest environment.");
  }
  const fixture = fixtureForStudyEntry(manifest, entry);
  const expectedFixture = {
    id: fixture.id,
    sha256: fixture.sha256,
    filesystemIdentity: fixture.filesystemIdentity
  };
  if (
    canonicalStudyJson(provenance.fixtureBefore) !== canonicalStudyJson(expectedFixture) ||
    canonicalStudyJson(provenance.fixtureAfter) !== canonicalStudyJson(expectedFixture)
  ) {
    fail("Study trial fixture receipt does not match the exact stable manifest fixture.");
  }
  if (
    fragment.sourceCopy === null ||
    canonicalStudyJson(provenance.sourceCopyBefore) !== canonicalStudyJson(sourceCopyCore(fragment.sourceCopy)) ||
    canonicalStudyJson(provenance.sourceCopyAfter) !== canonicalStudyJson(sourceCopyCore(fragment.sourceCopy))
  ) {
    fail("Study trial provenance does not match its private source-copy receipt.");
  }
  if (fragment.processProofs === null) {
    fail("Study trial provenance requires the correlated fresh editor identity.");
  }
  exactKeys(provenance.editorProcess, ["pid", "startTimeTicks"], "Study trial editor identity");
  if (
    provenance.editorProcess.pid !== fragment.processProofs.editorRoot.pid ||
    provenance.editorProcess.startTimeTicks !== fragment.processProofs.editorRoot.startTimeTicks
  ) {
    fail("Study trial provenance does not match its correlated editor.");
  }
  if (fragment.processProofs.configuredKernel === null) {
    if (fragment.outcome.actionStarted || provenance.kernelProcess !== null) {
      fail("A started action or recorded kernel provenance requires the exact configured kernel.");
    }
  } else {
    exactKeys(provenance.kernelProcess, ["pid", "startTimeTicks", "kernelIdSha256"], "Study trial kernel identity");
    if (
      provenance.kernelProcess.pid !== fragment.processProofs.configuredKernel.pid ||
      provenance.kernelProcess.startTimeTicks !== fragment.processProofs.configuredKernel.startTimeTicks ||
      provenance.kernelProcess.kernelIdSha256 !== fragment.processProofs.configuredKernel.kernelIdSha256
    ) {
      fail("Study trial provenance does not match its configured kernel.");
    }
  }
  if (provenance.revalidatedAfterCleanup !== true || fragment.cleanupProof === null) {
    fail("Study trial provenance must be revalidated after the bounded cleanup attempt.");
  }
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
      "executionIndex",
      "scheduleEntryId",
      "baseBlockId",
      "attempt",
      "effectiveBlockId",
      "product",
      "recordedAtUtc",
      "outcome",
      "milestones",
      "sourceCopy",
      "cacheProof",
      "sourceLoad",
      "engineEvidence",
      "environmentGate",
      "uiEvidence",
      "processProofs",
      "resourceObservation",
      "cleanupProof",
      "trialProvenance"
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
  assertInteger(fragment.executionIndex, "Study fragment execution index");
  assertInteger(fragment.attempt, "Study fragment attempt");
  assertString(fragment.recordedAtUtc, ISO_UTC, "Study fragment timestamp");
  const entry = scheduleEntryForFragment(fragment, manifest);
  exactKeys(
    fragment.outcome,
    ["status", "reasonClass", "actionStarted", "correctness", "timeout", "unsupported"],
    "Study outcome"
  );
  assertEnum(
    fragment.outcome.status,
    ["success", "product-failure", "pre-action-invalid", "unsupported"],
    "Study outcome status"
  );
  const dataWranglerPolarsCapability = manifest.provenance.capabilities.find(
    (capability) => capability.fixtureId === fixtureForStudyEntry(manifest, entry).id
  );
  if (entry.product === "data-wrangler" && entry.engine === "polars") {
    if (dataWranglerPolarsCapability === undefined) {
      fail("Study Data Wrangler Polars entry has no exact fixture capability receipt.");
    }
    if (dataWranglerPolarsCapability.availability !== "available") {
      fail("A timed-out Data Wrangler Polars capability check is undetermined and cannot produce a study fragment.");
    }
    if (fragment.outcome.status === "unsupported") {
      fail("An absent launch action is not public proof that Data Wrangler Polars is unsupported.");
    }
  }
  assertBoolean(fragment.outcome.actionStarted, "Study action-started proof");
  assertEnum(fragment.outcome.correctness, ["passed", "failed", "not-reached"], "Study correctness status");
  if (fragment.outcome.status === "success") {
    if (
      fragment.outcome.reasonClass !== null ||
      !fragment.outcome.actionStarted ||
      fragment.outcome.correctness !== "passed" ||
      fragment.outcome.timeout !== null ||
      fragment.outcome.unsupported !== null
    ) {
      fail("A successful study outcome requires an action, passed correctness, and no failure reason.");
    }
  } else if (fragment.outcome.status === "unsupported") {
    if (
      entry.product !== "data-wrangler" ||
      entry.engine !== "polars" ||
      fragment.outcome.reasonClass !== null ||
      fragment.outcome.actionStarted ||
      fragment.outcome.correctness !== "not-reached" ||
      fragment.outcome.timeout !== null
    ) {
      fail("Only a Data Wrangler Polars entry may record an unavailable public surface.");
    }
    exactKeys(fragment.outcome.unsupported, ["publicSurface", "comparability"], "Study unsupported outcome");
    if (
      fragment.outcome.unsupported.publicSurface !== "unavailable" ||
      fragment.outcome.unsupported.comparability !== "non-comparable"
    ) {
      fail("Study unsupported outcomes must remain bounded and explicitly non-comparable.");
    }
  } else {
    assertEnum(fragment.outcome.reasonClass, DATA_WRANGLER_STUDY_REASON_CLASSES, "Study outcome reason class");
    if (fragment.outcome.unsupported !== null) {
      fail("A product failure or pre-action invalidation cannot claim an unsupported public surface.");
    }
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
  validateTimeout(fragment.outcome.timeout, fragment.outcome.reasonClass, fragment.milestones);
  if (fragment.outcome.reasonClass === "timeout" && fragment.outcome.correctness !== "not-reached") {
    fail("A timed-out journey cannot claim completed correctness.");
  }
  if (fragment.outcome.actionStarted && fragment.milestones.inlineActionMs === null) {
    fail("A started product action requires its inline action milestone.");
  }
  validateMilestones(fragment.milestones, fragment.outcome.status, fragment.outcome.timeout);
  validateEnvironmentGate(fragment.environmentGate, fragment, manifest);
  validateSourceCopy(fragment.sourceCopy, entry, fragment, manifest);
  validateCacheProof(fragment.cacheProof, entry, fragment, manifest);
  validateSourceLoad(fragment.sourceLoad, entry, fragment);
  validateEngineEvidence(fragment.engineEvidence, entry, fragment, manifest);
  validateUiEvidence(fragment.uiEvidence, fragment, entry, manifest);
  if (fragment.resourceObservation !== null) {
    validateDataWranglerStudyResourceObservation(fragment.resourceObservation);
  }
  if (fragment.outcome.status === "success" && fragment.resourceObservation?.valid !== true) {
    fail("A successful study fragment requires a valid resource observation.");
  }
  if (
    !fragmentSkippedEditorLaunch(fragment) &&
    fragment.resourceObservation === null &&
    !fragmentFailedBeforeResourceSampling(fragment)
  ) {
    fail("A launched study fragment requires a retained valid or explicitly invalid resource observation.");
  }
  if (fragment.outcome.status === "success") {
    const lastSample = fragment.resourceObservation.samples.at(-1);
    const quiescenceBoundary = fragment.milestones.profilesCompleteMs + 2_000;
    const quiescenceTargetNanoseconds =
      BigInt(fragment.resourceObservation.clock.originNanoseconds) +
      millisecondsLowerBoundToNanoseconds(quiescenceBoundary, "Study profile-quiescence boundary");
    const firstSampleAtOrAfterQuiescence = fragment.resourceObservation.samples.find(
      (sample) => BigInt(sample.startedMonotonicNanoseconds) >= quiescenceTargetNanoseconds
    );
    if (
      firstSampleAtOrAfterQuiescence === undefined ||
      fragment.milestones.samplingStoppedMs !== firstSampleAtOrAfterQuiescence.elapsedMs ||
      lastSample.elapsedMs !== firstSampleAtOrAfterQuiescence.elapsedMs
    ) {
      fail("A successful resource observation must stop at the first sample at or after two-second quiescence.");
    }
    const terminalBoundary = fragment.resourceObservation.terminalBoundary;
    if (
      terminalBoundary === null ||
      BigInt(terminalBoundary.targetMonotonicNanoseconds) !== quiescenceTargetNanoseconds ||
      terminalBoundary.firstEligibleSampleScheduledMonotonicNanoseconds !== lastSample.scheduledMonotonicNanoseconds ||
      terminalBoundary.firstEligibleSampleStartedMonotonicNanoseconds !== lastSample.startedMonotonicNanoseconds ||
      terminalBoundary.firstEligibleSampleEndedMonotonicNanoseconds !== lastSample.endedMonotonicNanoseconds ||
      fragment.milestones.samplingStoppedMs !== lastSample.elapsedMs
    ) {
      fail(
        "A successful resource observation terminal receipt must bind profile completion and its first eligible sample."
      );
    }
    calculateStudyPssSegments(fragment.resourceObservation, fragment.milestones);
  }
  validateStudyProcessProofs(fragment.processProofs, fragment, manifest);
  if (
    fragment.outcome.status === "unsupported" &&
    (fragment.processProofs !== null || fragment.resourceObservation !== null || fragment.cleanupProof !== null)
  ) {
    fail("A manifest-bound unsupported surface cannot contain launch, process, cleanup, or resource evidence.");
  }
  validateCleanupProof(fragment.cleanupProof, fragment.processProofs, fragment);
  validateTrialProvenance(fragment.trialProvenance, fragment, entry, manifest);
  return fragment;
}

function fragmentFileName(fragment) {
  return `${fragment.scheduleEntryId}.attempt-${String(fragment.attempt).padStart(2, "0")}.json`;
}

const MAXIMUM_STUDY_JSON_BYTES = 32 * 1024 * 1024;
const MAXIMUM_STUDY_FRAGMENT_LEDGER_BYTES = 256 * 1024 * 1024;

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentUserOwns(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function assertPrivateStudyDirectory(metadata, label) {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o700n
  ) {
    fail(`${label} must be one owned mode-0700 directory.`);
  }
}

function anchoredStudyPath(directoryDescriptor, name = "") {
  return name.length === 0 ? `/proc/self/fd/${directoryDescriptor}` : `/proc/self/fd/${directoryDescriptor}/${name}`;
}

function invokeStudyReadFault(options, point) {
  if (options?.faultInjector === undefined) {
    return;
  }
  if (typeof options.faultInjector !== "function") {
    fail("Study read fault injector must be a function.");
  }
  options.faultInjector(point);
}

function openPrivateStudyDirectoryLease(directory, options = {}) {
  const path = resolve(directory);
  const before = lstatSync(path, { bigint: true });
  assertPrivateStudyDirectory(before, "Study artifact parent");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertPrivateStudyDirectory(opened, "Opened study artifact parent");
    if (!sameFilesystemIdentity(before, opened)) {
      fail("Study artifact parent identity changed while it opened.");
    }
    const lease = { descriptor, identity: opened, path };
    invokeStudyReadFault(options, "directory-opened");
    return lease;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyPrivateStudyDirectoryLease(lease) {
  const opened = fstatSync(lease.descriptor, { bigint: true });
  assertPrivateStudyDirectory(opened, "Leased study artifact parent");
  let named;
  try {
    named = lstatSync(lease.path, { bigint: true });
  } catch {
    fail("Study artifact parent disappeared while it was leased.");
  }
  assertPrivateStudyDirectory(named, "Named study artifact parent");
  if (!sameFilesystemIdentity(opened, lease.identity) || !sameFilesystemIdentity(named, lease.identity)) {
    fail("Study artifact parent identity changed while it was leased.");
  }
}

function withPrivateStudyDirectory(directory, options, callback) {
  const lease = openPrivateStudyDirectoryLease(directory, options);
  let result;
  let operationError;
  try {
    result = callback(lease);
  } catch (error) {
    operationError = error;
  }
  const settlementErrors = [];
  try {
    verifyPrivateStudyDirectoryLease(lease);
  } catch (error) {
    settlementErrors.push(error);
  }
  try {
    closeSync(lease.descriptor);
  } catch (error) {
    settlementErrors.push(error);
  }
  if (operationError !== undefined || settlementErrors.length !== 0) {
    if (operationError !== undefined && settlementErrors.length === 0) {
      throw operationError;
    }
    if (operationError === undefined && settlementErrors.length === 1) {
      throw settlementErrors[0];
    }
    throw new AggregateError(
      operationError === undefined ? settlementErrors : [operationError, ...settlementErrors],
      [operationError, ...settlementErrors]
        .filter((error) => error !== undefined)
        .map((error) => error?.message ?? "unknown study artifact error")
        .join("; ")
    );
  }
  return result;
}

function validatePrivateStudyDirectory(directory) {
  return withPrivateStudyDirectory(directory, {}, (lease) => {
    fsyncSync(lease.descriptor);
    return lease.path;
  });
}

function ensurePrivateStudyDirectory(directory) {
  const target = resolve(directory);
  let created = false;
  try {
    mkdirSync(target, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const validated = validatePrivateStudyDirectory(target);
  if (created) {
    const parent = dirname(target);
    const descriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  return validated;
}

function assertPrivateStudyFile(metadata, label) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o600n ||
    metadata.size < 1n ||
    metadata.size > BigInt(MAXIMUM_STUDY_JSON_BYTES)
  ) {
    fail(`${label} must be one private, bounded, singly linked regular JSON file.`);
  }
}

function readPrivateStudyJson(lease, name, label, options = {}) {
  if (typeof name !== "string" || name.length === 0 || basename(name) !== name) {
    fail(`${label} filename is invalid.`);
  }
  const path = anchoredStudyPath(lease.descriptor, name);
  const before = lstatSync(path, { bigint: true });
  assertPrivateStudyFile(before, label);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertPrivateStudyFile(opened, label);
    if (!sameFilesystemIdentity(before, opened)) {
      fail(`${label} identity changed while it opened.`);
    }
    invokeStudyReadFault(options, "file-opened");
    text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    if (
      !sameFilesystemIdentity(opened, after) ||
      !sameFilesystemIdentity(after, entry) ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      after.size !== entry.size ||
      after.mtimeNs !== entry.mtimeNs ||
      after.ctimeNs !== entry.ctimeNs
    ) {
      fail(`${label} changed while it was read.`);
    }
  } finally {
    closeSync(descriptor);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON.`);
  }
}

function publishOrRecoverStudyJson(path, value, options = {}) {
  const target = resolve(path);
  if (options.parentLease === undefined) {
    const directory = ensurePrivateStudyDirectory(dirname(target));
    return withPrivateStudyDirectory(directory, options, (lease) =>
      publishOrRecoverStudyJson(target, value, {
        ...options,
        parentLease: { descriptor: lease.descriptor, path: lease.path }
      })
    );
  }
  const sha256 = digestDurableJsonValue(value);
  if (sha256 !== digestStudyValue(value)) {
    fail("Study artifact canonical digest disagrees with the durable JSON digest.");
  }
  const recovery = recoverDurableStudyJsonPublication(target, sha256, options);
  invokeStudyReadFault(options, "publication-recovered");
  if (recovery.status !== "absent") {
    return Object.freeze({ path: target, sha256, status: recovery.status });
  }
  const publication = publishDurableStudyJsonExclusive(target, value, options);
  return Object.freeze({ path: target, sha256, status: publication.status });
}

export function writeDataWranglerStudyJsonExclusive(path, value, options = {}) {
  if (value?.protocol === DATA_WRANGLER_STUDY_MANIFEST_PROTOCOL) {
    validateDataWranglerStudyManifest(value);
  } else if (value?.protocol === DATA_WRANGLER_STUDY_RESULT_PROTOCOL) {
    validateDataWranglerStudyResult(value);
  } else {
    fail("Study artifact publication requires a validated manifest or result.");
  }
  return publishOrRecoverStudyJson(path, value, options);
}

export function writeDataWranglerStudySpecificationExclusive(path, value, options = {}) {
  buildDataWranglerStudyManifest(value);
  return publishOrRecoverStudyJson(path, value, options);
}

export function readDataWranglerStudySpecificationPublication(path, options = {}) {
  const target = resolve(path);
  return withPrivateStudyDirectory(dirname(target), options, (lease) => {
    const specification = readPrivateStudyJson(lease, basename(target), "Study specification", options);
    buildDataWranglerStudyManifest(specification);
    return specification;
  });
}

export function readDataWranglerStudyManifestPublication(path, options = {}) {
  const target = resolve(path);
  return withPrivateStudyDirectory(dirname(target), options, (lease) =>
    validateDataWranglerStudyManifest(readPrivateStudyJson(lease, basename(target), "Study manifest", options))
  );
}

export function publishDataWranglerStudyFragment(directory, fragment, manifest, options = {}) {
  validateDataWranglerStudyFragment(fragment, manifest);
  if (fragment.attempt > 99) {
    fail("Study fragment attempt exceeds the bounded filename range.");
  }
  const targetDirectory = ensurePrivateStudyDirectory(directory);
  return withPrivateStudyDirectory(targetDirectory, options, (lease) => {
    const durableOptions = {
      ...options,
      parentLease: { descriptor: lease.descriptor, path: lease.path }
    };
    const path = resolve(lease.path, fragmentFileName(fragment));
    const sha256 = digestStudyValue(fragment);
    const recovery = recoverDurableStudyJsonPublication(path, sha256, durableOptions);
    invokeStudyReadFault(options, "fragment-recovered");
    const recorded = loadDataWranglerStudyFragmentsFromLease(lease, manifest, options);
    if (recovery.status !== "absent") {
      const existing = recorded[fragment.executionIndex];
      if (existing === undefined || canonicalStudyJson(existing) !== canonicalStudyJson(fragment)) {
        fail("Completed study fragment publication does not match the exact retry input.");
      }
      return Object.freeze({ path, sha256, status: recovery.status });
    }
    const pending = pendingDataWranglerStudyTrials(manifest, recorded);
    const next = pending[0];
    if (
      fragment.executionIndex !== recorded.length ||
      next === undefined ||
      next.id !== fragment.scheduleEntryId ||
      next.attempt !== fragment.attempt ||
      next.effectiveBlockId !== fragment.effectiveBlockId
    ) {
      fail("Study fragment is not the exact next immutable schedule execution.");
    }
    const publication = publishDurableStudyJsonExclusive(path, fragment, durableOptions);
    return Object.freeze({ path, sha256, status: publication.status });
  });
}

function loadDataWranglerStudyFragmentsFromLease(lease, manifest, options) {
  const maximumFragments = manifest.schedule.length * 100;
  const maximumDirectoryEntries = maximumFragments + 64;
  const directory = opendirSync(anchoredStudyPath(lease.descriptor), { encoding: "utf8" });
  const names = [];
  let directoryEntries = 0;
  let cumulativeBytes = 0n;
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      directoryEntries += 1;
      if (directoryEntries > maximumDirectoryEntries) {
        fail("Study fragment directory entry count exceeds its bound.");
      }
      if (!entry.name.endsWith(".json")) continue;
      if (names.length >= maximumFragments) {
        fail("Study fragment count exceeds the immutable schedule and attempt bound.");
      }
      const match = FRAGMENT_FILE.exec(entry.name);
      if (match === null) {
        fail("Study fragment directory contains an unexpected JSON filename.");
      }
      const metadata = lstatSync(anchoredStudyPath(lease.descriptor, entry.name), { bigint: true });
      assertPrivateStudyFile(metadata, "Study fragment");
      cumulativeBytes += metadata.size;
      if (cumulativeBytes > BigInt(MAXIMUM_STUDY_FRAGMENT_LEDGER_BYTES)) {
        fail("Study fragment ledger exceeds its cumulative byte bound.");
      }
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  names.sort();
  invokeStudyReadFault(options, "directory-listed");
  const fragments = [];
  for (const name of names) {
    const fragment = readPrivateStudyJson(lease, name, "Study fragment", options);
    validateDataWranglerStudyFragment(fragment, manifest);
    if (name !== fragmentFileName(fragment)) {
      fail("Study fragment filename does not match its immutable identity.");
    }
    fragments.push(fragment);
  }
  fragments.sort((left, right) => left.executionIndex - right.executionIndex);
  pendingDataWranglerStudyTrials(manifest, fragments);
  return fragments;
}

export function loadDataWranglerStudyFragments(directory, manifest, options = {}) {
  validateDataWranglerStudyManifest(manifest);
  try {
    return withPrivateStudyDirectory(directory, options, (lease) =>
      loadDataWranglerStudyFragmentsFromLease(lease, manifest, options)
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function trialIntentFileName(intent) {
  return `${intent.runId}.${intent.stage}.intent`;
}

function trialIntentLedgerSha256(fragments) {
  return digestStudyValue(
    fragments.map((fragment) => ({
      fragmentId: fragment.fragmentId,
      executionIndex: fragment.executionIndex,
      scheduleEntryId: fragment.scheduleEntryId,
      attempt: fragment.attempt,
      effectiveBlockId: fragment.effectiveBlockId,
      sha256: digestStudyValue(fragment)
    }))
  );
}

function validateTrialIntentIdentity(intent, label) {
  for (const key of ["runId", "manifestSha256", "scheduleEntryId", "effectiveBlockId", "product", "ledgerSha256"]) {
    if (typeof intent[key] !== "string" || intent[key].length === 0 || /[\0\r\n]/u.test(intent[key])) {
      fail(`${label} ${key} is invalid.`);
    }
  }
  if (!UUID.test(intent.runId)) {
    fail(`${label} run ID must be one UUID.`);
  }
  for (const key of ["manifestSha256", "ledgerSha256"]) {
    if (!SHA256.test(intent[key])) {
      fail(`${label} ${key} must be one SHA-256 digest.`);
    }
  }
  assertInteger(intent.executionIndex, `${label} execution index`);
  assertInteger(intent.attempt, `${label} attempt`);
  assertEnum(intent.product, DATA_WRANGLER_STUDY_PRODUCTS, `${label} product`);
  if (!intent.effectiveBlockId.endsWith(`~a${String(intent.attempt).padStart(2, "0")}`)) {
    fail(`${label} effective block does not match its attempt.`);
  }
}

function validateDataWranglerStudyTrialIntent(intent) {
  if (intent?.stage === "prepared") {
    exactKeys(
      intent,
      [
        "protocol",
        "stage",
        "runId",
        "manifestSha256",
        "executionIndex",
        "scheduleEntryId",
        "attempt",
        "effectiveBlockId",
        "product",
        "ledgerSha256",
        "preparedAtUtc"
      ],
      "Prepared study trial intent"
    );
    validateTrialIntentIdentity(intent, "Prepared study trial intent");
    assertString(intent.preparedAtUtc, ISO_UTC, "Prepared study trial timestamp");
  } else if (intent?.stage === "action-authorized") {
    exactKeys(
      intent,
      [
        "protocol",
        "stage",
        "runId",
        "manifestSha256",
        "executionIndex",
        "scheduleEntryId",
        "attempt",
        "effectiveBlockId",
        "product",
        "ledgerSha256",
        "preparedSha256",
        "authorizedAtUtc"
      ],
      "Authorized study trial intent"
    );
    validateTrialIntentIdentity(intent, "Authorized study trial intent");
    if (!SHA256.test(intent.preparedSha256)) {
      fail("Authorized study trial intent preparedSha256 must be one SHA-256 digest.");
    }
    assertString(intent.authorizedAtUtc, ISO_UTC, "Authorized study trial timestamp");
  } else {
    fail("Study trial intent stage is invalid.");
  }
  if (intent.protocol !== DATA_WRANGLER_STUDY_TRIAL_INTENT_PROTOCOL) {
    fail("Study trial intent protocol is invalid.");
  }
  return intent;
}

function readStudyTrialIntentRecords(lease, options = {}) {
  const names = readdirSync(anchoredStudyPath(lease.descriptor), { encoding: "utf8" });
  if (!Array.isArray(names) || names.length > 1_024) {
    fail("Study trial intent directory listing exceeds its bound.");
  }
  const records = [];
  for (const name of names.sort()) {
    const match = TRIAL_INTENT_FILE.exec(name);
    if (match === null) {
      const isPublicationTemporary =
        /^\.[^.]+\.(?:prepared|action-authorized)\.intent\.ow-study-publish-[0-9a-f]{32}\.tmp$/u.test(name);
      if (isPublicationTemporary) {
        continue;
      }
      fail("Study trial intent directory contains an unexpected entry.");
    }
    const intent = validateDataWranglerStudyTrialIntent(
      readPrivateStudyJson(lease, name, "Study trial intent", options)
    );
    if (intent.runId.toLowerCase() !== match.groups.runId.toLowerCase() || intent.stage !== match.groups.stage) {
      fail("Study trial intent filename does not match its content.");
    }
    records.push(intent);
  }
  return records;
}

function fragmentSettlesTrialIntent(intent, fragment) {
  return (
    fragment.executionIndex === intent.executionIndex &&
    fragment.scheduleEntryId === intent.scheduleEntryId &&
    fragment.attempt === intent.attempt &&
    fragment.effectiveBlockId === intent.effectiveBlockId &&
    fragment.product === intent.product
  );
}

function inspectStudyTrialIntentRecords(records, manifest, fragments) {
  const manifestSha256 = digestStudyValue(manifest);
  const preparedByRun = new Map();
  const authorized = [];
  for (const intent of records) {
    if (intent.manifestSha256 !== manifestSha256) {
      fail("Study trial intent belongs to another manifest.");
    }
    if (intent.stage === "prepared") {
      if (preparedByRun.has(intent.runId)) {
        fail("Study trial intent journal contains duplicate prepared entries.");
      }
      preparedByRun.set(intent.runId, intent);
    } else {
      authorized.push(intent);
    }
  }
  const unresolved = [];
  let settledCount = 0;
  for (const intent of authorized) {
    const prepared = preparedByRun.get(intent.runId);
    if (prepared === undefined || intent.preparedSha256 !== digestStudyValue(prepared)) {
      fail("Authorized study trial intent does not match one prepared entry.");
    }
    for (const key of [
      "manifestSha256",
      "executionIndex",
      "scheduleEntryId",
      "attempt",
      "effectiveBlockId",
      "product",
      "ledgerSha256"
    ]) {
      if (intent[key] !== prepared[key]) {
        fail(`Authorized study trial intent changed its prepared ${key}.`);
      }
    }
    const settled = fragments.some((fragment) => fragmentSettlesTrialIntent(intent, fragment));
    if (settled) {
      settledCount += 1;
    } else {
      unresolved.push(intent);
    }
  }
  if (new Set(authorized.map((intent) => intent.runId)).size !== authorized.length) {
    fail("Study trial intent journal contains duplicate action authorizations.");
  }
  return Object.freeze({
    preparedCount: preparedByRun.size,
    authorizedCount: authorized.length,
    settledCount,
    abandonedPreparedCount: [...preparedByRun.keys()].filter(
      (runId) => !authorized.some((intent) => intent.runId === runId)
    ).length,
    unresolved: Object.freeze(unresolved.map((intent) => Object.freeze(structuredClone(intent))))
  });
}

export function inspectDataWranglerStudyTrialIntents({ directory, manifest, fragments, options = {} }) {
  validateDataWranglerStudyManifest(manifest);
  pendingDataWranglerStudyTrials(manifest, fragments);
  try {
    return withPrivateStudyDirectory(directory, options, (lease) =>
      inspectStudyTrialIntentRecords(readStudyTrialIntentRecords(lease, options), manifest, fragments)
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        preparedCount: 0,
        authorizedCount: 0,
        settledCount: 0,
        abandonedPreparedCount: 0,
        unresolved: Object.freeze([])
      });
    }
    throw error;
  }
}

export function assertNoIndeterminateDataWranglerStudyAction(arguments_) {
  const inspection = inspectDataWranglerStudyTrialIntents(arguments_);
  if (inspection.unresolved.length !== 0) {
    const [intent] = inspection.unresolved;
    fail(
      `Study trial ${intent.scheduleEntryId} has an authorized action without a published result. The study is indeterminate and must not rerun that action.`
    );
  }
  return inspection;
}

export function prepareDataWranglerStudyTrialIntent({
  directory,
  manifest,
  fragments,
  runId = randomUUID(),
  preparedAtUtc,
  options = {}
}) {
  validateDataWranglerStudyManifest(manifest);
  const next = pendingDataWranglerStudyTrials(manifest, fragments)[0];
  if (next === undefined) {
    fail("Study trial intent cannot be prepared after the schedule is complete.");
  }
  const intent = validateDataWranglerStudyTrialIntent({
    protocol: DATA_WRANGLER_STUDY_TRIAL_INTENT_PROTOCOL,
    stage: "prepared",
    runId,
    manifestSha256: digestStudyValue(manifest),
    executionIndex: fragments.length,
    scheduleEntryId: next.id,
    attempt: next.attempt,
    effectiveBlockId: next.effectiveBlockId,
    product: next.product,
    ledgerSha256: trialIntentLedgerSha256(fragments),
    preparedAtUtc
  });
  const targetDirectory = ensurePrivateStudyDirectory(directory);
  const publication = withPrivateStudyDirectory(targetDirectory, options, (lease) => {
    const records = readStudyTrialIntentRecords(lease, options);
    const inspection = inspectStudyTrialIntentRecords(records, manifest, fragments);
    if (inspection.unresolved.length !== 0) {
      fail("Study cannot prepare another trial while an earlier authorized action is indeterminate.");
    }
    return publishOrRecoverStudyJson(resolve(lease.path, trialIntentFileName(intent)), intent, {
      ...options,
      parentLease: { descriptor: lease.descriptor, path: lease.path }
    });
  });
  return Object.freeze({ intent: Object.freeze(structuredClone(intent)), publication });
}

export function authorizeDataWranglerStudyTrialAction({
  directory,
  manifest,
  fragments,
  preparedIntent,
  authorizedAtUtc,
  options = {}
}) {
  validateDataWranglerStudyManifest(manifest);
  validateDataWranglerStudyTrialIntent(preparedIntent);
  if (preparedIntent.stage !== "prepared") {
    fail("Study action authorization requires one prepared intent.");
  }
  const next = pendingDataWranglerStudyTrials(manifest, fragments)[0];
  if (
    next === undefined ||
    preparedIntent.manifestSha256 !== digestStudyValue(manifest) ||
    preparedIntent.executionIndex !== fragments.length ||
    preparedIntent.scheduleEntryId !== next.id ||
    preparedIntent.attempt !== next.attempt ||
    preparedIntent.effectiveBlockId !== next.effectiveBlockId ||
    preparedIntent.product !== next.product ||
    preparedIntent.ledgerSha256 !== trialIntentLedgerSha256(fragments)
  ) {
    fail("Prepared study trial intent no longer matches the next ledger entry.");
  }
  const authorizedIntent = validateDataWranglerStudyTrialIntent({
    protocol: DATA_WRANGLER_STUDY_TRIAL_INTENT_PROTOCOL,
    stage: "action-authorized",
    runId: preparedIntent.runId,
    manifestSha256: preparedIntent.manifestSha256,
    executionIndex: preparedIntent.executionIndex,
    scheduleEntryId: preparedIntent.scheduleEntryId,
    attempt: preparedIntent.attempt,
    effectiveBlockId: preparedIntent.effectiveBlockId,
    product: preparedIntent.product,
    ledgerSha256: preparedIntent.ledgerSha256,
    preparedSha256: digestStudyValue(preparedIntent),
    authorizedAtUtc
  });
  const targetDirectory = ensurePrivateStudyDirectory(directory);
  const publication = withPrivateStudyDirectory(targetDirectory, options, (lease) => {
    const records = readStudyTrialIntentRecords(lease, options);
    const recordedPrepared = records.find(
      (intent) => intent.runId === preparedIntent.runId && intent.stage === "prepared"
    );
    if (recordedPrepared === undefined || canonicalStudyJson(recordedPrepared) !== canonicalStudyJson(preparedIntent)) {
      fail("Study action authorization cannot find its exact prepared intent.");
    }
    const inspection = inspectStudyTrialIntentRecords(records, manifest, fragments);
    if (inspection.unresolved.some((intent) => intent.runId !== preparedIntent.runId)) {
      fail("Study cannot authorize another action while an earlier action is indeterminate.");
    }
    const receipt = publishOrRecoverStudyJson(
      resolve(lease.path, trialIntentFileName(authorizedIntent)),
      authorizedIntent,
      {
        ...options,
        parentLease: { descriptor: lease.descriptor, path: lease.path }
      }
    );
    const after = inspectStudyTrialIntentRecords(readStudyTrialIntentRecords(lease, options), manifest, fragments);
    if (after.unresolved.length !== 1 || after.unresolved[0].runId !== preparedIntent.runId) {
      fail("Study action authorization did not leave one exact in-flight action.");
    }
    return receipt;
  });
  return Object.freeze({ intent: Object.freeze(structuredClone(authorizedIntent)), publication });
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function finalizationIntentPattern(outputName) {
  return new RegExp(
    `^\\.${escapeRegularExpression(outputName)}\\.ow-study-finalize-(?<sha256>[0-9a-f]{64})\\.json$`,
    "u"
  );
}

function finalizationFragmentDigests(fragments) {
  return fragments.map((fragment) => digestStudyValue(fragment));
}

function validateFinalizationIntent(intent, { outputName, manifest, fragments }) {
  exactKeys(
    intent,
    ["protocol", "outputName", "manifestSha256", "fragmentSha256s", "finalizedAtUtc"],
    "Study finalization intent"
  );
  if (
    intent.protocol !== DATA_WRANGLER_STUDY_FINALIZATION_INTENT_PROTOCOL ||
    intent.outputName !== outputName ||
    intent.manifestSha256 !== digestStudyValue(manifest) ||
    canonicalStudyJson(intent.fragmentSha256s) !== canonicalStudyJson(finalizationFragmentDigests(fragments))
  ) {
    fail("Study finalization intent does not match the output, manifest, and ordered fragments.");
  }
  assertString(intent.finalizedAtUtc, ISO_UTC, "Study finalization timestamp");
  return intent;
}

function listFinalizationIntentNames(lease, outputName) {
  const names = readdirSync(anchoredStudyPath(lease.descriptor), { encoding: "utf8" });
  if (!Array.isArray(names) || names.length > 131_072) {
    fail("Study finalization directory listing is malformed or exceeds its bound.");
  }
  const pattern = finalizationIntentPattern(outputName);
  return names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry) => entry.match !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createOrLoadDataWranglerStudyFinalizationIntent({
  outputPath,
  manifest,
  fragments,
  finalizedAtUtc,
  publicationOptions = {},
  readOptions = {}
}) {
  validateDataWranglerStudyManifest(manifest);
  if (pendingDataWranglerStudyTrials(manifest, fragments).length !== 0) {
    fail("Study finalization intent requires every planned pair to be complete.");
  }
  assertString(finalizedAtUtc, ISO_UTC, "Requested study finalization timestamp");
  const target = resolve(outputPath);
  const directory = ensurePrivateStudyDirectory(dirname(target));
  const outputName = basename(target);
  return withPrivateStudyDirectory(directory, readOptions, (lease) => {
    const durableOptions = {
      ...publicationOptions,
      parentLease: { descriptor: lease.descriptor, path: lease.path }
    };
    let matches = listFinalizationIntentNames(lease, outputName);
    invokeStudyReadFault(readOptions, "directory-listed");
    if (matches.length > 1) {
      fail("Study finalization found more than one digest-named intent.");
    }
    let intent;
    if (matches.length === 0) {
      intent = validateFinalizationIntent(
        {
          protocol: DATA_WRANGLER_STUDY_FINALIZATION_INTENT_PROTOCOL,
          outputName,
          manifestSha256: digestStudyValue(manifest),
          fragmentSha256s: finalizationFragmentDigests(fragments),
          finalizedAtUtc
        },
        { outputName, manifest, fragments }
      );
      const sha256 = digestStudyValue(intent);
      const name = `.${outputName}.ow-study-finalize-${sha256}.json`;
      publishOrRecoverStudyJson(resolve(directory, name), intent, durableOptions);
      matches = listFinalizationIntentNames(lease, outputName);
      if (matches.length !== 1 || matches[0].name !== name) {
        fail("Study finalization did not publish one unique digest-named intent.");
      }
    } else {
      const [{ name, match }] = matches;
      const expectedSha256 = match.groups.sha256;
      const intentPath = resolve(directory, name);
      const recovery = recoverDurableStudyJsonPublication(intentPath, expectedSha256, durableOptions);
      if (recovery.status === "absent") {
        fail("Study finalization intent disappeared during recovery.");
      }
      intent = validateFinalizationIntent(readPrivateStudyJson(lease, name, "Study finalization intent", readOptions), {
        outputName,
        manifest,
        fragments
      });
      if (digestStudyValue(intent) !== expectedSha256) {
        fail("Study finalization intent content does not match the SHA-256 in its filename.");
      }
    }
    return Object.freeze(structuredClone(intent));
  });
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

function attemptIsInvalidated(group, entries) {
  const first = group.get(entries[0].product);
  if (group.size === 1) {
    return first?.outcome.status === "pre-action-invalid";
  }
  return (
    group.size === 2 &&
    DATA_WRANGLER_STUDY_PRODUCTS.some((product) => group.get(product)?.outcome.status === "pre-action-invalid")
  );
}

function validateAttemptChain(blockId, groups, entries) {
  const attempts = [...groups.entries()]
    .filter(([key]) => key.startsWith(`${blockId}:`))
    .map(([key, group]) => ({ attempt: Number(key.slice(blockId.length + 1)), group }))
    .sort((left, right) => left.attempt - right.attempt);
  for (let index = 0; index < attempts.length; index += 1) {
    const current = attempts[index];
    if (current.attempt !== index) {
      fail("Study fragment attempts must be contiguous from attempt zero.");
    }
    if (index < attempts.length - 1 && !attemptIsInvalidated(current.group, entries)) {
      fail("A later study attempt requires a terminal earlier pair invalidation.");
    }
    if (index > 0) {
      const previous = attempts[index - 1].group;
      if (!attemptIsInvalidated(previous, entries)) {
        fail("A later study attempt requires a retained pair invalidated before one product action.");
      }
    }
  }
}

function computePendingDataWranglerStudyTrials(manifest, fragments) {
  validateDataWranglerStudyManifest(manifest);
  const groups = groupFragmentsByBlock(fragments, manifest);
  const pending = [];
  for (const [blockId, entries] of blockEntries(manifest)) {
    validateAttemptChain(blockId, groups, entries);
    let attempt = 0;
    while (true) {
      const group = groups.get(`${blockId}:${attempt}`) ?? new Map();
      if (attemptIsInvalidated(group, entries)) {
        attempt += 1;
        if (attempt > 99) {
          fail("Study pair exceeded the bounded append-only attempt range.");
        }
        continue;
      }
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
      break;
    }
  }
  return pending.sort((left, right) => left.sequence - right.sequence || left.orderInPair - right.orderInPair);
}

export function pendingDataWranglerStudyTrials(manifest, fragments) {
  validateDataWranglerStudyManifest(manifest);
  if (!Array.isArray(fragments)) {
    fail("Study fragments must be an execution-ordered array.");
  }
  const recorded = [];
  const editorIdentities = new Set();
  const kernelIdentities = new Set();
  for (let executionIndex = 0; executionIndex < fragments.length; executionIndex += 1) {
    const fragment = fragments[executionIndex];
    validateDataWranglerStudyFragment(fragment, manifest);
    if (fragment.executionIndex !== executionIndex) {
      fail("Study fragment execution indices must be contiguous and preserve publication order.");
    }
    if (fragment.outcome.actionStarted) {
      const editorIdentity = `${fragment.trialProvenance.editorProcess.pid}:${fragment.trialProvenance.editorProcess.startTimeTicks}`;
      const kernelIdentity = `${fragment.trialProvenance.kernelProcess.pid}:${fragment.trialProvenance.kernelProcess.startTimeTicks}:${fragment.trialProvenance.kernelProcess.kernelIdSha256}`;
      if (editorIdentities.has(editorIdentity) || kernelIdentities.has(kernelIdentity)) {
        fail("Completed study fragments must use fresh editor and configured-kernel identities.");
      }
      editorIdentities.add(editorIdentity);
      kernelIdentities.add(kernelIdentity);
    }
    const next = computePendingDataWranglerStudyTrials(manifest, recorded)[0];
    if (
      next === undefined ||
      next.id !== fragment.scheduleEntryId ||
      next.attempt !== fragment.attempt ||
      next.effectiveBlockId !== fragment.effectiveBlockId
    ) {
      fail("Study fragments do not follow the exact next immutable schedule execution.");
    }
    recorded.push(fragment);
  }
  return computePendingDataWranglerStudyTrials(manifest, recorded);
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
  const maximumObservedSampledPssBytes = Math.max(...segmentSamples.map((sample) => sample.totalPssBytes));
  const categories = Object.fromEntries(
    RESOURCE_CATEGORIES.map((category) => {
      const baselinePssBytes = categoryMedian(baselineSamples, category);
      const maximumObservedSampledPssBytes = Math.max(...segmentSamples.map((sample) => sample.categories[category]));
      return [
        category,
        {
          baselinePssBytes,
          maximumObservedSampledPssBytes,
          deltaPssBytes: Math.max(0, maximumObservedSampledPssBytes - baselinePssBytes)
        }
      ];
    })
  );
  return {
    baselinePssBytes: median,
    maximumObservedSampledPssBytes,
    deltaPssBytes: Math.max(0, maximumObservedSampledPssBytes - median),
    processCountRange: {
      minimum: Math.min(...segmentSamples.map((sample) => sample.processes.length)),
      maximum: Math.max(...segmentSamples.map((sample) => sample.processes.length))
    },
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
      openWrangler: pair.openWrangler,
      dataWrangler: pair.dataWrangler,
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
      openWrangler: value.openWrangler,
      dataWrangler: value.dataWrangler,
      difference: value.difference,
      ratio: encodeRatio(value.ratio)
    }))
  });
}

function trialDurations(fragment) {
  const milestone = fragment.milestones;
  const pssSegments =
    fragment.outcome.status !== "success" || fragment.resourceObservation === null
      ? null
      : calculateStudyPssSegments(fragment.resourceObservation, fragment.milestones);
  return {
    inlinePreviewMs: milestone.inlineReadyMs === null ? null : milestone.inlineReadyMs - milestone.inlineActionMs,
    workbenchOpenMs:
      milestone.workbenchReadyMs === null ? null : milestone.workbenchReadyMs - milestone.workbenchActionMs,
    firstProfileMs:
      milestone.firstProfileReadyMs === null ? null : milestone.firstProfileReadyMs - milestone.profileActionMs,
    completeProfileMs:
      milestone.profilesCompleteMs === null ? null : milestone.profilesCompleteMs - milestone.profileActionMs,
    firstProfileFromWorkbenchClickMs:
      milestone.firstProfileReadyMs === null ? null : milestone.firstProfileReadyMs - milestone.workbenchActionMs,
    completeProfileFromWorkbenchClickMs:
      milestone.profilesCompleteMs === null ? null : milestone.profilesCompleteMs - milestone.workbenchActionMs,
    completeTrialPssDeltaBytes: pssSegments?.completeTrial.deltaPssBytes ?? null
  };
}

function completedPairAttempts(manifest, fragments) {
  const groups = groupFragmentsByBlock(fragments, manifest);
  const result = [];
  for (const [blockId, entries] of blockEntries(manifest)) {
    for (let attempt = 0; ; attempt += 1) {
      const group = groups.get(`${blockId}:${attempt}`);
      if (group === undefined) {
        break;
      }
      if (attemptIsInvalidated(group, entries)) {
        continue;
      }
      if (group.size < 2) {
        break;
      }
      const openWrangler = group.get("open-wrangler");
      const dataWrangler = group.get("data-wrangler");
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

export function summarizeDataWranglerStudyTrialResource(fragment) {
  if (!isRecord(fragment) || !isRecord(fragment.outcome)) {
    fail("Study resource summary requires one fragment with an outcome.");
  }
  const observation = fragment.resourceObservation;
  const samplingDisclosure = {
    memoryMetric: "maximum-observed-sampled-pss",
    samplingLimitations: {
      configuredIntervalMs: 200,
      processMeasurementsAreSequential: true,
      betweenSampleSpikesMayBeMissed: true
    }
  };
  if (observation === null) {
    return {
      ...samplingDisclosure,
      status: "not-recorded",
      reasonClass: null,
      intervalMs: null,
      missedSamples: null,
      processCountRange: null,
      segments: null
    };
  }
  if (!isRecord(observation)) {
    fail("Study resource summary requires a resource observation object or null.");
  }
  validateDataWranglerStudyResourceObservation(observation);
  const processCounts = observation.samples.map((sample) => sample.processes.length);
  return {
    ...samplingDisclosure,
    status: observation.valid ? "valid" : "invalid",
    reasonClass: observation.reasonClass,
    intervalMs: observation.intervalMs,
    missedSamples: observation.missedSamples,
    processCountRange:
      processCounts.length === 0
        ? null
        : {
            minimum: Math.min(...processCounts),
            maximum: Math.max(...processCounts)
          },
    segments: fragment.outcome.status === "success" ? calculateStudyPssSegments(observation, fragment.milestones) : null
  };
}

function summarizeProfileSemanticEquivalence(fragment) {
  if (fragment.outcome.status !== "success") {
    return { status: "not-evaluated", excludedDistinctColumns: [] };
  }
  const excludedDistinctColumns = fragment.uiEvidence.profiles.columns
    .filter((column) => column.distinct.includedInSemanticEquivalence === false)
    .map((column) => column.name);
  return {
    status: excludedDistinctColumns.length === 0 ? "fully-compared" : "distinct-excluded",
    excludedDistinctColumns
  };
}

function summarizeDescriptiveMetrics(attempts) {
  return DATA_WRANGLER_STUDY_DESCRIPTIVE_METRICS.map((name) => {
    const values = { "open-wrangler": [], "data-wrangler": [] };
    const observations = [];
    for (const attempt of attempts) {
      const observation = {
        pairId: `${attempt.blockId}~a${String(attempt.attempt).padStart(2, "0")}`,
        openWrangler: null,
        dataWrangler: null
      };
      for (const product of DATA_WRANGLER_STUDY_PRODUCTS) {
        const fragment = product === "open-wrangler" ? attempt.openWrangler : attempt.dataWrangler;
        if (fragment.outcome.status !== "success") {
          continue;
        }
        const value = trialDurations(fragment)[name];
        if (value !== null) {
          values[product].push(value);
          observation[product === "open-wrangler" ? "openWrangler" : "dataWrangler"] = value;
        }
      }
      observations.push(observation);
    }
    return {
      name,
      openWrangler: values["open-wrangler"].length === 0 ? null : summarizeStudyMetric(values["open-wrangler"]),
      dataWrangler: values["data-wrangler"].length === 0 ? null : summarizeStudyMetric(values["data-wrangler"]),
      observations
    };
  });
}

function summarizeCell(cell, attempts) {
  const cellAttempts = attempts.filter((attempt) => attempt.entry.cellId === cell.id && attempt.entry.kind === "warm");
  const metrics = DATA_WRANGLER_STUDY_METRICS.map((metric) => {
    const pairs = [];
    const openWranglerValues = [];
    const dataWranglerValues = [];
    const observations = [];
    for (const attempt of cellAttempts) {
      const openDurations = trialDurations(attempt.openWrangler);
      const dataDurations = trialDurations(attempt.dataWrangler);
      const openSucceeded = attempt.openWrangler.outcome.status === "success";
      const dataSucceeded = attempt.dataWrangler.outcome.status === "success";
      const observation = {
        pairId: `${attempt.blockId}~a${String(attempt.attempt).padStart(2, "0")}`,
        openWrangler: null,
        dataWrangler: null
      };
      if (openSucceeded && openDurations[metric.name] !== null) {
        openWranglerValues.push(openDurations[metric.name]);
        observation.openWrangler = openDurations[metric.name];
      }
      if (dataSucceeded && dataDurations[metric.name] !== null) {
        dataWranglerValues.push(dataDurations[metric.name]);
        observation.dataWrangler = dataDurations[metric.name];
      }
      if (
        openSucceeded &&
        dataSucceeded &&
        openDurations[metric.name] !== null &&
        dataDurations[metric.name] !== null
      ) {
        pairs.push({
          pairId: `${attempt.blockId}~a${String(attempt.attempt).padStart(2, "0")}`,
          openWrangler: openDurations[metric.name],
          dataWrangler: dataDurations[metric.name]
        });
      }
      observations.push(observation);
    }
    return {
      name: metric.name,
      openWrangler: openWranglerValues.length === 0 ? null : summarizeStudyMetric(openWranglerValues),
      dataWrangler: dataWranglerValues.length === 0 ? null : summarizeStudyMetric(dataWranglerValues),
      observations,
      pairedRegression: calculatePairedStudyRegression(pairs, {
        absoluteThreshold: metric.threshold,
        allowZero: metric.allowZero
      })
    };
  });
  const rightCensoredTimeouts = cellAttempts
    .flatMap((attempt) => [attempt.openWrangler, attempt.dataWrangler])
    .filter((fragment) => fragment.outcome.timeout !== null)
    .map((fragment) => ({
      effectiveBlockId: fragment.effectiveBlockId,
      product: fragment.product,
      journey: fragment.outcome.timeout.journey,
      deadlineMs: fragment.outcome.timeout.deadlineMs,
      actionAtMs:
        fragment.milestones[
          {
            "inline-preview": "inlineActionMs",
            "workbench-open": "workbenchActionMs",
            "complete-profile": "profileActionMs"
          }[fragment.outcome.timeout.journey]
        ],
      observedAtMs: fragment.outcome.timeout.observedAtMs,
      operator: fragment.outcome.timeout.rightCensored.operator,
      valueMs: fragment.outcome.timeout.rightCensored.valueMs
    }));
  const dataWranglerUnsupported = cellAttempts.filter(
    (attempt) => attempt.dataWrangler.outcome.status === "unsupported"
  ).length;
  const availability =
    dataWranglerUnsupported > 0
      ? "data-wrangler-polars-unavailable"
      : cellAttempts.length < DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL
        ? "pending"
        : "available";
  const resourceTrials = cellAttempts.flatMap((attempt) =>
    DATA_WRANGLER_STUDY_PRODUCTS.map((product) => {
      const fragment = product === "open-wrangler" ? attempt.openWrangler : attempt.dataWrangler;
      return {
        effectiveBlockId: fragment.effectiveBlockId,
        product,
        outcomeStatus: fragment.outcome.status,
        sourceEngine: fragment.engineEvidence?.sourceEngine ?? cell.engine,
        sourceVerification: fragment.engineEvidence?.sourceVerification.method ?? "manifest-capability",
        sourcePostcheck: fragment.engineEvidence?.sourceVerification.receipt.observedAfterTrial ?? "not-applicable",
        workbenchEngine: fragment.engineEvidence?.workbenchEngine ?? "unverified",
        workbenchVerification: fragment.engineEvidence?.workbenchVerification ?? "manifest-capability",
        inlineSurfaceOwner:
          fragment.uiEvidence?.inline.status === "ready" ? fragment.uiEvidence.inline.surfaceOwner : "unverified",
        semanticEquivalence: summarizeProfileSemanticEquivalence(fragment),
        ...summarizeDataWranglerStudyTrialResource(fragment)
      };
    })
  );
  const semanticTrials = resourceTrials.map((trial) => trial.semanticEquivalence);
  const successfulWarmPairs = cellAttempts.filter(
    (attempt) => attempt.openWrangler.outcome.status === "success" && attempt.dataWrangler.outcome.status === "success"
  ).length;
  return {
    cellId: cell.id,
    completedWarmPairs: cellAttempts.length,
    successfulWarmPairs,
    availability,
    releaseComplete:
      availability === "available" &&
      successfulWarmPairs === DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL &&
      metrics.every((metric) => metric.pairedRegression.releaseComplete),
    dataWranglerUnsupported,
    sourcePostcheckNotReached: resourceTrials.filter((trial) => trial.sourcePostcheck === "not-reached").length,
    openWranglerFailures: cellAttempts.filter((attempt) => attempt.openWrangler.outcome.status === "product-failure")
      .length,
    dataWranglerFailures: cellAttempts.filter((attempt) => attempt.dataWrangler.outcome.status === "product-failure")
      .length,
    openWranglerTimeouts: rightCensoredTimeouts.filter((timeout) => timeout.product === "open-wrangler").length,
    dataWranglerTimeouts: rightCensoredTimeouts.filter((timeout) => timeout.product === "data-wrangler").length,
    openWranglerFailuresAgainstDataWranglerSuccess: cellAttempts.filter(
      (attempt) =>
        attempt.openWrangler.outcome.status === "product-failure" && attempt.dataWrangler.outcome.status === "success"
    ).length,
    rightCensoredTimeouts,
    resourceTrials,
    semanticEquivalence: {
      requiredProfileFields: ["type", "missing", "minimum", "maximum"],
      unqualifiedApproximateDistinct: "excluded",
      fullyComparedSuccessfulTrials: semanticTrials.filter((trial) => trial.status === "fully-compared").length,
      successfulTrialsWithDistinctExclusions: semanticTrials.filter((trial) => trial.status === "distinct-excluded")
        .length
    },
    metrics,
    descriptiveMetrics: summarizeDescriptiveMetrics(cellAttempts)
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
          sourceLoad: structuredClone(fragment.sourceLoad),
          sourceEngine: fragment.engineEvidence?.sourceEngine ?? entry.engine,
          sourceVerification: fragment.engineEvidence?.sourceVerification.method ?? "manifest-capability",
          sourcePostcheck: fragment.engineEvidence?.sourceVerification.receipt.observedAfterTrial ?? "not-applicable",
          workbenchEngine: fragment.engineEvidence?.workbenchEngine ?? "unverified",
          workbenchVerification: fragment.engineEvidence?.workbenchVerification ?? "manifest-capability",
          inlineSurfaceOwner:
            fragment.uiEvidence?.inline.status === "ready" ? fragment.uiEvidence.inline.surfaceOwner : "unverified",
          timeout:
            fragment.outcome.timeout === null
              ? null
              : {
                  journey: fragment.outcome.timeout.journey,
                  deadlineMs: fragment.outcome.timeout.deadlineMs,
                  actionAtMs:
                    fragment.milestones[
                      {
                        "inline-preview": "inlineActionMs",
                        "workbench-open": "workbenchActionMs",
                        "complete-profile": "profileActionMs"
                      }[fragment.outcome.timeout.journey]
                    ],
                  observedAtMs: fragment.outcome.timeout.observedAtMs,
                  operator: fragment.outcome.timeout.rightCensored.operator,
                  valueMs: fragment.outcome.timeout.rightCensored.valueMs
                },
          resource: summarizeDataWranglerStudyTrialResource(fragment),
          measurements: {
            loadAndPreviewMs: measurements.inlinePreviewMs,
            workbenchOpenMs: measurements.workbenchOpenMs,
            firstProfileMs: measurements.firstProfileMs,
            completeProfileMs: measurements.completeProfileMs,
            firstProfileFromWorkbenchClickMs: measurements.firstProfileFromWorkbenchClickMs,
            completeProfileFromWorkbenchClickMs: measurements.completeProfileFromWorkbenchClickMs,
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
  const cells = DATA_WRANGLER_STUDY_CELLS.map((cell) => summarizeCell(cell, attempts));
  const coldTrials = summarizeColdTrials(manifest, attempts);
  const analyzedTimeouts =
    cells.reduce((count, cell) => count + cell.rightCensoredTimeouts.length, 0) +
    coldTrials.filter((trial) => trial.timeout !== null).length;
  const result = {
    protocol: DATA_WRANGLER_STUDY_RESULT_PROTOCOL,
    manifestSha256: digestStudyValue(manifest),
    finalizedAtUtc,
    fragments: fragments.map((fragment) => ({
      fragmentId: fragment.fragmentId,
      executionIndex: fragment.executionIndex,
      scheduleEntryId: fragment.scheduleEntryId,
      attempt: fragment.attempt,
      effectiveBlockId: fragment.effectiveBlockId,
      product: fragment.product,
      outcomeStatus: fragment.outcome.status,
      sha256: digestStudyValue(fragment)
    })),
    accounting: {
      plannedTrials: manifest.schedule.length,
      fragmentCount: fragments.length,
      invalidatedPairAttempts,
      retainedTimeoutFragments: fragments.filter((fragment) => fragment.outcome.timeout !== null).length,
      retainedUnsupportedFragments: fragments.filter((fragment) => fragment.outcome.status === "unsupported").length,
      analyzedRightCensoredMeasurements: analyzedTimeouts,
      unavailableCells: cells
        .filter((cell) => cell.availability === "data-wrangler-polars-unavailable")
        .map((cell) => cell.cellId),
      pendingTrials: pending.map((entry) => ({
        scheduleEntryId: entry.id,
        attempt: entry.attempt,
        effectiveBlockId: entry.effectiveBlockId
      })),
      allPlannedPairsComplete: pending.length === 0
    },
    cells,
    coldTrials
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

function validateMetricObservations(observations, resourceTrials, label) {
  const expectedPairIds = [...new Set(resourceTrials.map((trial) => trial.effectiveBlockId))];
  if (!Array.isArray(observations) || observations.length !== expectedPairIds.length) {
    fail(`${label} must retain one raw observation row per completed pair.`);
  }
  const trials = new Map(
    resourceTrials.map((trial) => [`${trial.effectiveBlockId}:${trial.product}`, trial.outcomeStatus])
  );
  const seen = new Set();
  for (const observation of observations) {
    exactKeys(observation, ["pairId", "openWrangler", "dataWrangler"], label);
    if (!expectedPairIds.includes(observation.pairId) || seen.has(observation.pairId)) {
      fail(`${label} pair IDs must be unique completed effective block IDs.`);
    }
    seen.add(observation.pairId);
    for (const [product, key] of [
      ["open-wrangler", "openWrangler"],
      ["data-wrangler", "dataWrangler"]
    ]) {
      const succeeded = trials.get(`${observation.pairId}:${product}`) === "success";
      if (succeeded) {
        assertNonNegativeFinite(observation[key], `${label} ${product} value`);
      } else if (observation[key] !== null) {
        fail(`${label} cannot retain a value for a non-successful product outcome.`);
      }
    }
  }
  return observations;
}

function validateSummaryAgainstValues(summary, values, label) {
  const expected = values.length === 0 ? null : summarizeStudyMetric(values);
  if (canonicalStudyJson(summary) !== canonicalStudyJson(expected)) {
    fail(`${label} does not match its retained raw successful observations.`);
  }
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
    exactKeys(pair, ["pairId", "openWrangler", "dataWrangler", "difference", "ratio"], "Study paired calculation");
    if (typeof pair.pairId !== "string" || pair.pairId.length === 0 || pairIds.has(pair.pairId)) {
      fail("Study paired calculation IDs must be non-empty and unique.");
    }
    pairIds.add(pair.pairId);
    assertNonNegativeFinite(pair.openWrangler, "Study paired Open Wrangler observation");
    assertNonNegativeFinite(pair.dataWrangler, "Study paired Data Wrangler observation");
    if (!expectedMetric.allowZero && (pair.openWrangler === 0 || pair.dataWrangler === 0)) {
      fail("Study paired latency observations must be positive.");
    }
    if (
      typeof pair.difference !== "number" ||
      !Number.isFinite(pair.difference) ||
      pair.difference !== pair.openWrangler - pair.dataWrangler
    ) {
      fail("Study paired difference must be finite.");
    }
    if (
      pair.ratio !== "positive-infinity" &&
      (typeof pair.ratio !== "number" || !Number.isFinite(pair.ratio) || pair.ratio < 0)
    ) {
      fail("Study paired ratio must be non-negative or positive infinity.");
    }
    const expectedRatio =
      pair.dataWrangler === 0
        ? pair.openWrangler === 0
          ? 1
          : "positive-infinity"
        : pair.openWrangler / pair.dataWrangler;
    if (pair.ratio !== expectedRatio) {
      fail("Study paired ratio does not match its retained product observations.");
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

function validateResultTimeout(timeout, label) {
  exactKeys(
    timeout,
    ["effectiveBlockId", "product", "journey", "deadlineMs", "actionAtMs", "observedAtMs", "operator", "valueMs"],
    label
  );
  if (typeof timeout.effectiveBlockId !== "string" || timeout.effectiveBlockId.length === 0) {
    fail(`${label} effective block ID is invalid.`);
  }
  assertEnum(timeout.product, DATA_WRANGLER_STUDY_PRODUCTS, `${label} product`);
  assertEnum(timeout.journey, Object.keys(DATA_WRANGLER_STUDY_DEADLINES_MS), `${label} journey`);
  if (
    timeout.deadlineMs !== DATA_WRANGLER_STUDY_DEADLINES_MS[timeout.journey] ||
    timeout.operator !== ">=" ||
    timeout.valueMs !== timeout.deadlineMs
  ) {
    fail(`${label} must retain the exact preregistered right-censoring boundary.`);
  }
  assertNonNegativeFinite(timeout.observedAtMs, `${label} observed monotonic boundary`);
  assertNonNegativeFinite(timeout.actionAtMs, `${label} action boundary`);
  if (timeout.observedAtMs < timeout.actionAtMs + timeout.deadlineMs) {
    fail(`${label} observed boundary does not reach action plus deadline.`);
  }
}

function validateColdTimeout(timeout, label) {
  exactKeys(timeout, ["journey", "deadlineMs", "actionAtMs", "observedAtMs", "operator", "valueMs"], label);
  validateResultTimeout({ effectiveBlockId: "cold-timeout", product: "open-wrangler", ...timeout }, label);
}

function validateProcessCountRange(range, label) {
  exactKeys(range, ["minimum", "maximum"], label);
  assertInteger(range.minimum, `${label} minimum`, { minimum: 1 });
  assertInteger(range.maximum, `${label} maximum`, { minimum: 1 });
  if (range.minimum > range.maximum) {
    fail(`${label} is inverted.`);
  }
}

function validateResourceSegment(segment, label) {
  exactKeys(
    segment,
    ["baselinePssBytes", "maximumObservedSampledPssBytes", "deltaPssBytes", "processCountRange", "categories"],
    label
  );
  assertNonNegativeFinite(segment.baselinePssBytes, `${label} baseline PSS`);
  assertNonNegativeFinite(segment.maximumObservedSampledPssBytes, `${label} maximum observed sampled PSS`);
  assertNonNegativeFinite(segment.deltaPssBytes, `${label} PSS delta`);
  if (segment.deltaPssBytes !== Math.max(0, segment.maximumObservedSampledPssBytes - segment.baselinePssBytes)) {
    fail(`${label} PSS delta does not match its retained baseline and maximum observed sample.`);
  }
  validateProcessCountRange(segment.processCountRange, `${label} process-count range`);
  exactKeys(segment.categories, RESOURCE_CATEGORIES, `${label} categories`);
  for (const category of RESOURCE_CATEGORIES) {
    const summary = segment.categories[category];
    exactKeys(summary, ["baselinePssBytes", "maximumObservedSampledPssBytes", "deltaPssBytes"], `${label} ${category}`);
    assertNonNegativeFinite(summary.baselinePssBytes, `${label} ${category} baseline PSS`);
    assertNonNegativeFinite(
      summary.maximumObservedSampledPssBytes,
      `${label} ${category} maximum observed sampled PSS`
    );
    assertNonNegativeFinite(summary.deltaPssBytes, `${label} ${category} PSS delta`);
    if (summary.deltaPssBytes !== Math.max(0, summary.maximumObservedSampledPssBytes - summary.baselinePssBytes)) {
      fail(`${label} ${category} PSS delta does not match its retained baseline and maximum observed sample.`);
    }
  }
}

function validateResultResource(summary, outcomeStatus, label) {
  exactKeys(
    summary,
    [
      "memoryMetric",
      "samplingLimitations",
      "status",
      "reasonClass",
      "intervalMs",
      "missedSamples",
      "processCountRange",
      "segments"
    ],
    label
  );
  if (summary.memoryMetric !== "maximum-observed-sampled-pss") {
    fail(`${label} must identify maximum observed sampled PSS as its memory metric.`);
  }
  exactKeys(
    summary.samplingLimitations,
    ["configuredIntervalMs", "processMeasurementsAreSequential", "betweenSampleSpikesMayBeMissed"],
    `${label} sampling limitations`
  );
  if (
    summary.samplingLimitations.configuredIntervalMs !== 200 ||
    summary.samplingLimitations.processMeasurementsAreSequential !== true ||
    summary.samplingLimitations.betweenSampleSpikesMayBeMissed !== true
  ) {
    fail(`${label} must disclose sequential 200 ms sampling and the between-sample limitation.`);
  }
  assertEnum(summary.status, ["valid", "invalid", "not-recorded"], `${label} status`);
  if (summary.status === "not-recorded") {
    if (
      summary.reasonClass !== null ||
      summary.intervalMs !== null ||
      summary.missedSamples !== null ||
      summary.processCountRange !== null ||
      summary.segments !== null ||
      outcomeStatus === "success"
    ) {
      fail(`${label} not-recorded state is inconsistent.`);
    }
    return;
  }
  if (summary.intervalMs !== 200) {
    fail(`${label} interval must be 200 ms.`);
  }
  assertInteger(summary.missedSamples, `${label} missed-sample count`);
  if (summary.processCountRange !== null) {
    validateProcessCountRange(summary.processCountRange, `${label} process-count range`);
  }
  if (summary.status === "valid") {
    if (summary.reasonClass !== null || summary.missedSamples !== 0 || summary.processCountRange === null) {
      fail(`${label} valid state is inconsistent.`);
    }
  } else if (summary.reasonClass !== "resource-sampling" || summary.segments !== null) {
    fail(`${label} invalid state is inconsistent.`);
  }
  if (summary.segments === null) {
    if (summary.status === "valid" && outcomeStatus === "success") {
      fail(`${label} omits segments for a successful valid observation.`);
    }
    return;
  }
  if (summary.status !== "valid" || outcomeStatus !== "success") {
    fail(`${label} segments require a successful valid observation.`);
  }
  exactKeys(summary.segments, ["inline", "workbench", "profile", "completeTrial"], `${label} segments`);
  for (const [name, segment] of Object.entries(summary.segments)) {
    validateResourceSegment(segment, `${label} ${name}`);
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
  result.fragments.forEach((receipt, executionIndex) => {
    exactKeys(
      receipt,
      [
        "fragmentId",
        "executionIndex",
        "scheduleEntryId",
        "attempt",
        "effectiveBlockId",
        "product",
        "outcomeStatus",
        "sha256"
      ],
      "Study result fragment receipt"
    );
    assertString(receipt.fragmentId, UUID, "Study result fragment ID");
    if (fragmentIds.has(receipt.fragmentId)) {
      fail("Study result fragment IDs must be unique.");
    }
    fragmentIds.add(receipt.fragmentId);
    if (receipt.executionIndex !== executionIndex) {
      fail("Study result fragment receipts must retain execution order.");
    }
    if (typeof receipt.scheduleEntryId !== "string" || receipt.scheduleEntryId.length === 0) {
      fail("Study result schedule entry ID is invalid.");
    }
    assertInteger(receipt.attempt, "Study result fragment attempt");
    const scheduleEntry = createDataWranglerStudySchedule().find((entry) => entry.id === receipt.scheduleEntryId);
    if (
      scheduleEntry === undefined ||
      receipt.product !== scheduleEntry.product ||
      receipt.effectiveBlockId !== `${scheduleEntry.blockId}~a${String(receipt.attempt).padStart(2, "0")}`
    ) {
      fail("Study result fragment receipt does not bind its fixed schedule identity.");
    }
    assertEnum(
      receipt.outcomeStatus,
      ["success", "product-failure", "pre-action-invalid", "unsupported"],
      "Study result fragment outcome"
    );
    assertString(receipt.sha256, SHA256, "Study result fragment SHA-256");
  });
  exactKeys(
    result.accounting,
    [
      "plannedTrials",
      "fragmentCount",
      "invalidatedPairAttempts",
      "retainedTimeoutFragments",
      "retainedUnsupportedFragments",
      "analyzedRightCensoredMeasurements",
      "unavailableCells",
      "pendingTrials",
      "allPlannedPairsComplete"
    ],
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
  assertInteger(result.accounting.retainedTimeoutFragments, "Study retained timeout-fragment count");
  assertInteger(result.accounting.retainedUnsupportedFragments, "Study retained unsupported-fragment count");
  assertInteger(result.accounting.analyzedRightCensoredMeasurements, "Study analyzed right-censored measurement count");
  if (
    result.accounting.retainedTimeoutFragments > result.accounting.fragmentCount ||
    result.accounting.retainedUnsupportedFragments > result.accounting.fragmentCount ||
    result.accounting.analyzedRightCensoredMeasurements > result.accounting.retainedTimeoutFragments
  ) {
    fail("Study timeout accounting exceeds the retained immutable evidence.");
  }
  if (!Array.isArray(result.accounting.unavailableCells)) {
    fail("Study unavailable-cell accounting must be an array.");
  }
  const unavailableCellIds = new Set();
  for (const cellId of result.accounting.unavailableCells) {
    const cell = DATA_WRANGLER_STUDY_CELLS.find((candidate) => candidate.id === cellId);
    if (cell?.engine !== "polars" || unavailableCellIds.has(cellId)) {
      fail("Study unavailable cells must be unique preregistered Polars cells.");
    }
    unavailableCellIds.add(cellId);
  }
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
        "completedWarmPairs",
        "successfulWarmPairs",
        "availability",
        "releaseComplete",
        "dataWranglerUnsupported",
        "sourcePostcheckNotReached",
        "openWranglerFailures",
        "dataWranglerFailures",
        "openWranglerTimeouts",
        "dataWranglerTimeouts",
        "openWranglerFailuresAgainstDataWranglerSuccess",
        "rightCensoredTimeouts",
        "resourceTrials",
        "semanticEquivalence",
        "metrics",
        "descriptiveMetrics"
      ],
      "Study cell result"
    );
    if (cell.cellId !== DATA_WRANGLER_STUDY_CELLS[index].id) {
      fail("Study result cell order is invalid.");
    }
    for (const key of [
      "completedWarmPairs",
      "successfulWarmPairs",
      "dataWranglerUnsupported",
      "sourcePostcheckNotReached",
      "openWranglerFailures",
      "dataWranglerFailures",
      "openWranglerTimeouts",
      "dataWranglerTimeouts",
      "openWranglerFailuresAgainstDataWranglerSuccess"
    ]) {
      assertInteger(cell[key], `Study cell ${key}`);
    }
    assertEnum(
      cell.availability,
      ["pending", "available", "data-wrangler-polars-unavailable"],
      "Study cell availability"
    );
    assertBoolean(cell.releaseComplete, "Study cell release completeness");
    if (
      cell.completedWarmPairs > 10 ||
      cell.successfulWarmPairs > cell.completedWarmPairs ||
      cell.dataWranglerUnsupported > cell.completedWarmPairs ||
      cell.sourcePostcheckNotReached > cell.completedWarmPairs * 2 ||
      cell.successfulWarmPairs > 10 ||
      cell.openWranglerFailures > 10 ||
      cell.dataWranglerFailures > 10 ||
      cell.openWranglerTimeouts > cell.openWranglerFailures ||
      cell.dataWranglerTimeouts > cell.dataWranglerFailures ||
      cell.openWranglerFailuresAgainstDataWranglerSuccess > cell.openWranglerFailures
    ) {
      fail("Study cell counts exceed the ten planned warm pairs.");
    }
    const expectedAvailability =
      cell.dataWranglerUnsupported > 0
        ? "data-wrangler-polars-unavailable"
        : cell.completedWarmPairs < DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL
          ? "pending"
          : "available";
    if (
      cell.availability !== expectedAvailability ||
      (cell.availability === "data-wrangler-polars-unavailable" && DATA_WRANGLER_STUDY_CELLS[index].engine !== "polars")
    ) {
      fail("Study cell availability does not match its completed and unsupported outcomes.");
    }
    if (!Array.isArray(cell.rightCensoredTimeouts)) {
      fail("Study cell right-censored timeouts must be an array.");
    }
    const timeoutKeys = new Set();
    for (const timeout of cell.rightCensoredTimeouts) {
      validateResultTimeout(timeout, "Study cell right-censored timeout");
      const key = `${timeout.effectiveBlockId}:${timeout.product}`;
      if (timeoutKeys.has(key)) {
        fail("Study cell right-censored timeout identities must be unique.");
      }
      timeoutKeys.add(key);
    }
    if (
      cell.openWranglerTimeouts !==
        cell.rightCensoredTimeouts.filter((timeout) => timeout.product === "open-wrangler").length ||
      cell.dataWranglerTimeouts !==
        cell.rightCensoredTimeouts.filter((timeout) => timeout.product === "data-wrangler").length
    ) {
      fail("Study cell timeout counts do not match its right-censored observations.");
    }
    if (!Array.isArray(cell.resourceTrials) || cell.resourceTrials.length !== cell.completedWarmPairs * 2) {
      fail("Study cell resource trials must contain both products for every completed warm pair.");
    }
    const resourceTrialKeys = new Set();
    const resourcePairs = new Map();
    for (const trial of cell.resourceTrials) {
      exactKeys(
        trial,
        [
          "effectiveBlockId",
          "product",
          "outcomeStatus",
          "sourceEngine",
          "sourceVerification",
          "sourcePostcheck",
          "workbenchEngine",
          "workbenchVerification",
          "inlineSurfaceOwner",
          "semanticEquivalence",
          "memoryMetric",
          "samplingLimitations",
          "status",
          "reasonClass",
          "intervalMs",
          "missedSamples",
          "processCountRange",
          "segments"
        ],
        "Study cell resource trial"
      );
      if (typeof trial.effectiveBlockId !== "string" || trial.effectiveBlockId.length === 0) {
        fail("Study cell resource-trial block ID is invalid.");
      }
      assertEnum(trial.product, DATA_WRANGLER_STUDY_PRODUCTS, "Study cell resource-trial product");
      if (trial.sourceEngine !== DATA_WRANGLER_STUDY_CELLS[index].engine) {
        fail("Study cell resource-trial source engine does not match its preregistered cell.");
      }
      assertEnum(
        trial.sourceVerification,
        ["visible-notebook-runtime", "manifest-capability"],
        "Study cell source-engine verification"
      );
      assertEnum(trial.sourcePostcheck, ["verified", "not-reached", "not-applicable"], "Study cell source postcheck");
      assertEnum(trial.workbenchEngine, ["pandas", "polars", "unverified"], "Study cell workbench engine");
      assertEnum(
        trial.workbenchVerification,
        ["public-ui", "not-observed", "manifest-capability"],
        "Study cell workbench-engine verification"
      );
      assertEnum(
        trial.inlineSurfaceOwner,
        ["open-wrangler", "data-wrangler", "host-jupyter", "unverified"],
        "Study cell inline surface owner"
      );
      if (
        ["open-wrangler", "data-wrangler"].includes(trial.inlineSurfaceOwner) &&
        trial.inlineSurfaceOwner !== trial.product
      ) {
        fail("Study cell inline surface owner is attributed to the wrong product.");
      }
      assertEnum(
        trial.outcomeStatus,
        ["success", "product-failure", "unsupported"],
        "Study cell resource-trial outcome"
      );
      if (
        trial.outcomeStatus === "unsupported" &&
        (trial.product !== "data-wrangler" || DATA_WRANGLER_STUDY_CELLS[index].engine !== "polars")
      ) {
        fail("Only a Data Wrangler Polars resource trial may be unavailable.");
      }
      if (trial.outcomeStatus === "unsupported" && trial.workbenchEngine !== "unverified") {
        fail("An unavailable Data Wrangler Polars resource trial must keep its workbench engine unverified.");
      }
      if (
        trial.outcomeStatus === "unsupported" &&
        (trial.sourceVerification !== "manifest-capability" ||
          trial.sourcePostcheck !== "not-applicable" ||
          trial.workbenchVerification !== "manifest-capability")
      ) {
        fail(
          "An unavailable Data Wrangler Polars resource trial must derive engine state from the capability receipt."
        );
      }
      if (
        trial.outcomeStatus !== "unsupported" &&
        (trial.sourceVerification !== "visible-notebook-runtime" ||
          (trial.outcomeStatus === "success" && trial.sourcePostcheck !== "verified") ||
          (trial.workbenchEngine === "unverified") !== (trial.workbenchVerification === "not-observed"))
      ) {
        fail("A measured resource trial has inconsistent source or workbench engine verification.");
      }
      exactKeys(
        trial.semanticEquivalence,
        ["status", "excludedDistinctColumns"],
        "Study resource-trial semantic-equivalence disclosure"
      );
      assertEnum(
        trial.semanticEquivalence.status,
        ["fully-compared", "distinct-excluded", "not-evaluated"],
        "Study resource-trial semantic-equivalence status"
      );
      if (!Array.isArray(trial.semanticEquivalence.excludedDistinctColumns)) {
        fail("Study resource-trial excluded distinct columns must be an array.");
      }
      const excludedNames = new Set();
      for (const name of trial.semanticEquivalence.excludedDistinctColumns) {
        if (typeof name !== "string" || !/^c\d{2}$/u.test(name) || excludedNames.has(name)) {
          fail("Study resource-trial excluded distinct columns must be unique canonical names.");
        }
        excludedNames.add(name);
      }
      if (
        (trial.outcomeStatus === "success") !== (trial.semanticEquivalence.status !== "not-evaluated") ||
        (trial.semanticEquivalence.status === "fully-compared" && excludedNames.size !== 0) ||
        (trial.semanticEquivalence.status === "distinct-excluded" && excludedNames.size === 0) ||
        (trial.semanticEquivalence.status === "not-evaluated" && excludedNames.size !== 0)
      ) {
        fail("Study resource-trial semantic-equivalence disclosure does not match its outcome and exclusions.");
      }
      const key = `${trial.effectiveBlockId}:${trial.product}`;
      if (resourceTrialKeys.has(key)) {
        fail("Study cell resource-trial identities must be unique.");
      }
      resourceTrialKeys.add(key);
      const pair = resourcePairs.get(trial.effectiveBlockId) ?? new Map();
      pair.set(trial.product, trial.outcomeStatus);
      resourcePairs.set(trial.effectiveBlockId, pair);
      validateResultResource(
        {
          memoryMetric: trial.memoryMetric,
          samplingLimitations: trial.samplingLimitations,
          status: trial.status,
          reasonClass: trial.reasonClass,
          intervalMs: trial.intervalMs,
          missedSamples: trial.missedSamples,
          processCountRange: trial.processCountRange,
          segments: trial.segments
        },
        trial.outcomeStatus,
        "Study cell resource trial"
      );
    }
    if (
      [...resourcePairs.values()].some((pair) => pair.size !== 2) ||
      [...resourcePairs.values()].filter(
        (pair) => pair.get("open-wrangler") === "success" && pair.get("data-wrangler") === "success"
      ).length !== cell.successfulWarmPairs ||
      cell.resourceTrials.filter(
        (trial) => trial.product === "open-wrangler" && trial.outcomeStatus === "product-failure"
      ).length !== cell.openWranglerFailures ||
      cell.resourceTrials.filter(
        (trial) => trial.product === "data-wrangler" && trial.outcomeStatus === "product-failure"
      ).length !== cell.dataWranglerFailures ||
      cell.resourceTrials.filter((trial) => trial.product === "data-wrangler" && trial.outcomeStatus === "unsupported")
        .length !== cell.dataWranglerUnsupported ||
      cell.resourceTrials.filter((trial) => trial.sourcePostcheck === "not-reached").length !==
        cell.sourcePostcheckNotReached ||
      [...resourcePairs.values()].filter(
        (pair) => pair.get("open-wrangler") === "product-failure" && pair.get("data-wrangler") === "success"
      ).length !== cell.openWranglerFailuresAgainstDataWranglerSuccess
    ) {
      fail("Study cell outcome counts do not match its retained resource-trial identities.");
    }
    exactKeys(
      cell.semanticEquivalence,
      [
        "requiredProfileFields",
        "unqualifiedApproximateDistinct",
        "fullyComparedSuccessfulTrials",
        "successfulTrialsWithDistinctExclusions"
      ],
      "Study cell semantic-equivalence disclosure"
    );
    if (
      canonicalStudyJson(cell.semanticEquivalence.requiredProfileFields) !==
        canonicalStudyJson(["type", "missing", "minimum", "maximum"]) ||
      cell.semanticEquivalence.unqualifiedApproximateDistinct !== "excluded"
    ) {
      fail("Study cell semantic-equivalence policy is invalid.");
    }
    assertInteger(
      cell.semanticEquivalence.fullyComparedSuccessfulTrials,
      "Study fully compared successful trial count"
    );
    assertInteger(
      cell.semanticEquivalence.successfulTrialsWithDistinctExclusions,
      "Study successful trial count with distinct exclusions"
    );
    const fullyComparedSuccessfulTrials = cell.resourceTrials.filter(
      (trial) => trial.semanticEquivalence.status === "fully-compared"
    ).length;
    const successfulTrialsWithDistinctExclusions = cell.resourceTrials.filter(
      (trial) => trial.semanticEquivalence.status === "distinct-excluded"
    ).length;
    if (
      cell.semanticEquivalence.fullyComparedSuccessfulTrials !== fullyComparedSuccessfulTrials ||
      cell.semanticEquivalence.successfulTrialsWithDistinctExclusions !== successfulTrialsWithDistinctExclusions ||
      fullyComparedSuccessfulTrials + successfulTrialsWithDistinctExclusions !==
        cell.resourceTrials.filter((trial) => trial.outcomeStatus === "success").length
    ) {
      fail("Study cell semantic-equivalence counts do not match its retained trials.");
    }
    if (!Array.isArray(cell.metrics) || cell.metrics.length !== DATA_WRANGLER_STUDY_METRICS.length) {
      fail("Study cell result must contain every preregistered metric.");
    }
    cell.metrics.forEach((metric, metricIndex) => {
      exactKeys(
        metric,
        ["name", "openWrangler", "dataWrangler", "observations", "pairedRegression"],
        "Study metric result"
      );
      if (metric.name !== DATA_WRANGLER_STUDY_METRICS[metricIndex].name) {
        fail("Study metric order is invalid.");
      }
      validateMetricSummary(metric.openWrangler, "Open Wrangler metric summary");
      validateMetricSummary(metric.dataWrangler, "Data Wrangler metric summary");
      validateMetricObservations(metric.observations, cell.resourceTrials, "Study metric observations");
      validateSummaryAgainstValues(
        metric.openWrangler,
        metric.observations.flatMap((observation) =>
          observation.openWrangler === null ? [] : [observation.openWrangler]
        ),
        "Open Wrangler metric summary"
      );
      validateSummaryAgainstValues(
        metric.dataWrangler,
        metric.observations.flatMap((observation) =>
          observation.dataWrangler === null ? [] : [observation.dataWrangler]
        ),
        "Data Wrangler metric summary"
      );
      validateRegression(metric.pairedRegression, DATA_WRANGLER_STUDY_METRICS[metricIndex]);
      const expectedPairedObservations = metric.observations.filter(
        (observation) => observation.openWrangler !== null && observation.dataWrangler !== null
      );
      if (
        canonicalStudyJson(
          metric.pairedRegression.pairs.map((pair) => ({
            pairId: pair.pairId,
            openWrangler: pair.openWrangler,
            dataWrangler: pair.dataWrangler
          }))
        ) !== canonicalStudyJson(expectedPairedObservations)
      ) {
        fail("Study paired regression does not match its raw successful product observations.");
      }
    });
    const successfulTrialCounts = {
      "open-wrangler": cell.resourceTrials.filter(
        (trial) => trial.product === "open-wrangler" && trial.outcomeStatus === "success"
      ).length,
      "data-wrangler": cell.resourceTrials.filter(
        (trial) => trial.product === "data-wrangler" && trial.outcomeStatus === "success"
      ).length
    };
    for (const metric of cell.metrics) {
      if (
        (metric.openWrangler?.count ?? 0) !== successfulTrialCounts["open-wrangler"] ||
        (metric.dataWrangler?.count ?? 0) !== successfulTrialCounts["data-wrangler"] ||
        metric.pairedRegression.successfulPairCount !== cell.successfulWarmPairs
      ) {
        fail("Study metric summaries must contain only successful product and paired outcomes.");
      }
    }
    if (
      !Array.isArray(cell.descriptiveMetrics) ||
      cell.descriptiveMetrics.length !== DATA_WRANGLER_STUDY_DESCRIPTIVE_METRICS.length
    ) {
      fail("Study cell result must contain every descriptive workbench-relative profile metric.");
    }
    cell.descriptiveMetrics.forEach((metric, metricIndex) => {
      exactKeys(metric, ["name", "openWrangler", "dataWrangler", "observations"], "Study descriptive metric result");
      if (metric.name !== DATA_WRANGLER_STUDY_DESCRIPTIVE_METRICS[metricIndex]) {
        fail("Study descriptive metric order is invalid.");
      }
      validateMetricSummary(metric.openWrangler, "Open Wrangler descriptive metric summary");
      validateMetricSummary(metric.dataWrangler, "Data Wrangler descriptive metric summary");
      validateMetricObservations(metric.observations, cell.resourceTrials, "Study descriptive metric observations");
      validateSummaryAgainstValues(
        metric.openWrangler,
        metric.observations.flatMap((observation) =>
          observation.openWrangler === null ? [] : [observation.openWrangler]
        ),
        "Open Wrangler descriptive metric summary"
      );
      validateSummaryAgainstValues(
        metric.dataWrangler,
        metric.observations.flatMap((observation) =>
          observation.dataWrangler === null ? [] : [observation.dataWrangler]
        ),
        "Data Wrangler descriptive metric summary"
      );
      if (
        (metric.openWrangler?.count ?? 0) !== successfulTrialCounts["open-wrangler"] ||
        (metric.dataWrangler?.count ?? 0) !== successfulTrialCounts["data-wrangler"]
      ) {
        fail("Study descriptive summaries must contain only successful product outcomes.");
      }
    });
    const expectedReleaseComplete =
      cell.availability === "available" &&
      cell.successfulWarmPairs === DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL &&
      cell.metrics.every((metric) => metric.pairedRegression.releaseComplete);
    if (cell.releaseComplete !== expectedReleaseComplete) {
      fail("Study cell release completeness does not match availability and paired measurements.");
    }
  });
  if (!Array.isArray(result.coldTrials) || result.coldTrials.length > 16) {
    fail("Study result cold trials must fit the eight planned descriptive pairs.");
  }
  const coldEntries = new Set();
  for (const trial of result.coldTrials) {
    exactKeys(
      trial,
      [
        "scheduleEntryId",
        "effectiveBlockId",
        "cellId",
        "product",
        "orderInPair",
        "outcomeStatus",
        "sourceLoad",
        "sourceEngine",
        "sourceVerification",
        "sourcePostcheck",
        "workbenchEngine",
        "workbenchVerification",
        "inlineSurfaceOwner",
        "timeout",
        "resource",
        "measurements"
      ],
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
    const coldCell = DATA_WRANGLER_STUDY_CELLS.find((cell) => cell.id === trial.cellId);
    if (trial.sourceEngine !== coldCell.engine) {
      fail("Study cold trial source engine does not match its preregistered cell.");
    }
    assertEnum(
      trial.sourceVerification,
      ["visible-notebook-runtime", "manifest-capability"],
      "Study cold source-engine verification"
    );
    assertEnum(trial.sourcePostcheck, ["verified", "not-reached", "not-applicable"], "Study cold source postcheck");
    assertEnum(trial.workbenchEngine, ["pandas", "polars", "unverified"], "Study cold workbench engine");
    assertEnum(
      trial.workbenchVerification,
      ["public-ui", "not-observed", "manifest-capability"],
      "Study cold workbench-engine verification"
    );
    assertEnum(
      trial.inlineSurfaceOwner,
      ["open-wrangler", "data-wrangler", "host-jupyter", "unverified"],
      "Study cold inline surface owner"
    );
    if (
      ["open-wrangler", "data-wrangler"].includes(trial.inlineSurfaceOwner) &&
      trial.inlineSurfaceOwner !== trial.product
    ) {
      fail("Study cold inline surface owner is attributed to the wrong product.");
    }
    if (trial.orderInPair !== 1 && trial.orderInPair !== 2) {
      fail("Study cold trial product order is invalid.");
    }
    assertEnum(
      trial.outcomeStatus,
      ["success", "product-failure", "pre-action-invalid", "unsupported"],
      "Study cold trial outcome"
    );
    if (trial.outcomeStatus === "unsupported" && trial.workbenchEngine !== "unverified") {
      fail("An unavailable cold Data Wrangler Polars trial must keep its workbench engine unverified.");
    }
    if (
      trial.outcomeStatus === "unsupported" &&
      (trial.sourceVerification !== "manifest-capability" ||
        trial.sourcePostcheck !== "not-applicable" ||
        trial.workbenchVerification !== "manifest-capability")
    ) {
      fail("An unavailable cold Data Wrangler Polars trial must derive engine state from the capability receipt.");
    }
    if (
      trial.outcomeStatus !== "unsupported" &&
      (trial.sourceVerification !== "visible-notebook-runtime" ||
        (trial.outcomeStatus === "success" && trial.sourcePostcheck !== "verified") ||
        (trial.workbenchEngine === "unverified") !== (trial.workbenchVerification === "not-observed"))
    ) {
      fail("A measured cold trial has inconsistent source or workbench engine verification.");
    }
    exactKeys(trial.sourceLoad, ["status", "durationMs", "includedInInlineTiming"], "Study cold source load");
    assertEnum(trial.sourceLoad.status, ["measured", "failed", "not-reached"], "Study cold source-load status");
    if (trial.sourceLoad.includedInInlineTiming !== true) {
      fail("Study cold source loads must be included in load-and-preview timing.");
    }
    if (trial.sourceLoad.status === "measured") {
      assertPositiveFinite(trial.sourceLoad.durationMs, "Study cold source-load duration");
    } else if (trial.sourceLoad.durationMs !== null) {
      fail("Study cold unmeasured source loads cannot contain a duration.");
    }
    if (trial.timeout !== null) {
      if (trial.outcomeStatus !== "product-failure") {
        fail("Only a failed cold product journey may be right-censored.");
      }
      validateColdTimeout(trial.timeout, "Study cold right-censored timeout");
    }
    validateResultResource(trial.resource, trial.outcomeStatus, "Study cold trial resource");
    exactKeys(
      trial.measurements,
      [
        "loadAndPreviewMs",
        "workbenchOpenMs",
        "firstProfileMs",
        "completeProfileMs",
        "firstProfileFromWorkbenchClickMs",
        "completeProfileFromWorkbenchClickMs",
        "completeTrialPssDeltaBytes"
      ],
      "Study cold trial measurements"
    );
    for (const key of [
      "loadAndPreviewMs",
      "workbenchOpenMs",
      "firstProfileMs",
      "completeProfileMs",
      "firstProfileFromWorkbenchClickMs",
      "completeProfileFromWorkbenchClickMs"
    ]) {
      if (trial.measurements[key] !== null) {
        assertNonNegativeFinite(trial.measurements[key], `Study cold trial ${key}`);
      }
    }
    if (trial.measurements.completeTrialPssDeltaBytes !== null) {
      assertNonNegativeFinite(
        trial.measurements.completeTrialPssDeltaBytes,
        "Study cold trial complete-trial PSS delta"
      );
    }
    const timedMeasurement = {
      "inline-preview": "loadAndPreviewMs",
      "workbench-open": "workbenchOpenMs",
      "complete-profile": "completeProfileMs"
    }[trial.timeout?.journey];
    if (timedMeasurement !== undefined && trial.measurements[timedMeasurement] !== null) {
      fail("A cold timeout cannot substitute its right-censoring bound into a timing measurement.");
    }
    const latencyKeys = [
      "loadAndPreviewMs",
      "workbenchOpenMs",
      "firstProfileMs",
      "completeProfileMs",
      "firstProfileFromWorkbenchClickMs",
      "completeProfileFromWorkbenchClickMs"
    ];
    if (
      trial.outcomeStatus === "success" &&
      (trial.sourceLoad.status !== "measured" || latencyKeys.some((key) => trial.measurements[key] === null))
    ) {
      fail("A successful cold trial requires its source-load and journey measurements.");
    }
    if (
      ["pre-action-invalid", "unsupported"].includes(trial.outcomeStatus) &&
      (trial.sourceLoad.status === "measured" ||
        trial.timeout !== null ||
        Object.values(trial.measurements).some((value) => value !== null))
    ) {
      fail("An invalidated or unsupported cold trial cannot contain product timings.");
    }
  }
  const analyzedRightCensoredMeasurements =
    result.cells.reduce((count, cell) => count + cell.rightCensoredTimeouts.length, 0) +
    result.coldTrials.filter((trial) => trial.timeout !== null).length;
  if (result.accounting.analyzedRightCensoredMeasurements !== analyzedRightCensoredMeasurements) {
    fail("Study right-censoring accounting does not match the analyzed warm and cold trials.");
  }
  const expectedUnavailableCells = result.cells
    .filter((cell) => cell.availability === "data-wrangler-polars-unavailable")
    .map((cell) => cell.cellId);
  if (canonicalStudyJson(result.accounting.unavailableCells) !== canonicalStudyJson(expectedUnavailableCells)) {
    fail("Study unavailable-cell accounting does not match the retained cell outcomes.");
  }
  const analyzedUnsupported = result.cells.reduce((count, cell) => count + cell.dataWranglerUnsupported, 0);
  if (result.accounting.retainedUnsupportedFragments < analyzedUnsupported) {
    fail("Study unsupported accounting omits analyzed immutable outcomes.");
  }
  return result;
}

export function validateDataWranglerStudyResultEvidence({ manifest, fragments, result }) {
  validateDataWranglerStudyManifest(manifest);
  validateDataWranglerStudyResult(result);
  if (!Array.isArray(fragments)) {
    fail("Study result evidence requires the loaded raw fragment array.");
  }
  const rebuilt = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: result.finalizedAtUtc
  });
  if (canonicalStudyJson(rebuilt) !== canonicalStudyJson(result)) {
    fail("Study result does not match its manifest-bound raw fragment evidence.");
  }
  return result;
}

export function createEmptyStudyMilestones() {
  return Object.fromEntries(MILESTONE_KEYS.map((key) => [key, null]));
}

export function createStudyFragmentIdentity({ manifest, scheduleEntry, executionIndex, attempt = 0, recordedAtUtc }) {
  assertInteger(executionIndex, "Study fragment execution index");
  return {
    protocol: DATA_WRANGLER_STUDY_FRAGMENT_PROTOCOL,
    fragmentId: randomUUID(),
    manifestSha256: digestStudyValue(manifest),
    executionIndex,
    scheduleEntryId: scheduleEntry.id,
    baseBlockId: scheduleEntry.blockId,
    attempt,
    effectiveBlockId: `${scheduleEntry.blockId}~a${String(attempt).padStart(2, "0")}`,
    product: scheduleEntry.product,
    recordedAtUtc
  };
}

export const DATA_WRANGLER_STUDY_RESOURCE_CATEGORIES = RESOURCE_CATEGORIES;
