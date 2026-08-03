import { createHash } from "node:crypto";
import {
  DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS,
  createDataWranglerComparisonControlInventory,
  createDataWranglerComparisonMeasuredInventory
} from "./data-wrangler-comparison-inventory.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}\.[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const EXTENSION_VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,126}[0-9A-Za-z])?$/u;
const MAXIMUM_EVIDENCE_BYTES = 1024 * 1024;
const MAXIMUM_EXTENSION_ENTRIES = 32;
const MAXIMUM_SENTINELS = 16;
const MAXIMUM_SOURCE_ROWS = 10_000_000;
const MAXIMUM_SOURCE_COLUMNS = 2_048;
const MAXIMUM_SENTINEL_STRING_BYTES = 4 * 1024;
const MAXIMUM_COLUMN_NAME_BYTES = 256;
const CONCLUSIONS = new Set(["available", "capability-timeout", "neither-product-control"]);
const ACTION_ORDER = Object.freeze(["open-wrangler", "data-wrangler"]);

export const DATA_WRANGLER_PUBLIC_UI_RECEIPT_PROTOCOL = "openwrangler-data-wrangler-public-ui-receipt-v1";
export const DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND = "data-wrangler-polars-capability";
export const NEITHER_PRODUCT_CONTROL_RECEIPT_KIND = "neither-product-control";
export const PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS = 30_000;
export const PUBLIC_UI_CAPABILITY_END_JITTER_MS = 250;
export const PUBLIC_UI_OBSERVATION_MAX_GAP_MS = 1_000;
export const PUBLIC_UI_AVAILABLE_STABILITY_CHECKS = 2;
export const PUBLIC_UI_MAXIMUM_TRACE_SAMPLES = 64;
export const PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME = "Open in Open Wrangler";
export const PUBLIC_UI_DATA_WRANGLER_ACTION_NAME = "Open 'study_frame' in Data Wrangler";
export const PUBLIC_UI_DATA_WRANGLER_EXTENSION = Object.freeze({
  extensionId: "ms-toolsai.datawrangler",
  version: "1.24.2"
});

const CAPABILITY_KIND = DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND;
const CONTROL_KIND = NEITHER_PRODUCT_CONTROL_RECEIPT_KIND;

export const PUBLIC_UI_BASE_EXTENSION_INVENTORY = freezeInventory(DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS);
export const PUBLIC_UI_COMMON_EXTENSION_INVENTORY = freezeInventory(createDataWranglerComparisonControlInventory());

export class PublicUiReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicUiReceiptError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublicUiReceiptError(code, message);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value, expectedKeys, label) {
  if (!isPlainRecord(value)) {
    fail("invalid-shape", `${label} must be one plain object.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail("invalid-shape", `${label} may not contain symbol-keyed fields.`);
  }
  const keys = ownKeys.map(String).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("invalid-shape", `${label} has missing or unknown fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      fail("invalid-shape", `${label}.${key} must be one enumerable data field.`);
    }
  }
  return value;
}

function exactArray(value, maximumLength, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximumLength) {
    fail("invalid-shape", `${label} must be an array within its entry bound.`);
  }
  const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== value.length ||
    !keys.every((key, index) => key === String(index))
  ) {
    fail("invalid-shape", `${label} must be dense and may not contain extra fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      fail("invalid-shape", `${label}[${key}] must be one data element.`);
    }
  }
  return value;
}

function assertString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("invalid-value", `${label} is invalid.`);
  }
  return value;
}

function assertBoundedString(value, maximumBytes, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\0\r\n]/u.test(value)
  ) {
    fail("invalid-value", `${label} is missing, malformed, or exceeds its byte bound.`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail("invalid-value", `${label} must be boolean.`);
  }
  return value;
}

function assertSafeInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("invalid-value", `${label} must be one bounded safe integer.`);
  }
  return value;
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeEditor(editor) {
  exactRecord(editor, ["id", "version", "sha256", "uiLocale"], "Public-UI editor receipt");
  return {
    id: assertBoundedString(editor.id, 128, "Public-UI editor ID"),
    version: assertString(editor.version, NUMERIC_VERSION, "Public-UI editor version"),
    sha256: assertString(editor.sha256, SHA256, "Public-UI editor SHA-256"),
    uiLocale: assertBoundedString(editor.uiLocale, 32, "Public-UI editor locale")
  };
}

function normalizeExtensionEntry(entry, index) {
  exactRecord(entry, ["extensionId", "version"], `Public-UI extension inventory entry ${index}`);
  return {
    extensionId: assertString(
      entry.extensionId,
      EXTENSION_ID,
      `Public-UI extension inventory entry ${index} extension ID`
    ),
    version: assertString(entry.version, EXTENSION_VERSION, `Public-UI extension inventory entry ${index} version`)
  };
}

function normalizeExtensionEntries(entries) {
  exactArray(entries, MAXIMUM_EXTENSION_ENTRIES, "Public-UI extension inventory entries");
  const normalized = entries.map(normalizeExtensionEntry).sort((left, right) => {
    const idOrder = lexicalCompare(left.extensionId, right.extensionId);
    return idOrder === 0 ? lexicalCompare(left.version, right.version) : idOrder;
  });
  const identities = new Set();
  for (const entry of normalized) {
    const identity = entry.extensionId.toLowerCase();
    if (identities.has(identity)) {
      fail("duplicate-extension", "Public-UI extension inventory IDs must be unique case-insensitively.");
    }
    identities.add(identity);
  }
  return normalized;
}

function normalizeExtensions(extensions) {
  exactRecord(extensions, ["complete", "entries", "sha256"], "Public-UI extension inventory");
  const entries = normalizeExtensionEntries(extensions.entries);
  const expectedSha256 = digestCanonical(entries);
  const sha256 = assertString(extensions.sha256, SHA256, "Public-UI extension inventory SHA-256");
  if (sha256 !== expectedSha256) {
    fail("inventory-digest-mismatch", "Public-UI extension inventory does not match its normalized digest.");
  }
  return {
    complete: assertBoolean(extensions.complete, "Public-UI extension inventory completeness"),
    entries,
    sha256
  };
}

function normalizeSentinelValue(value, label) {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("invalid-source", `${label} must be finite.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAXIMUM_SENTINEL_STRING_BYTES) {
      fail("invalid-source", `${label} exceeds its UTF-8 byte bound.`);
    }
    return value;
  }
  fail("invalid-source", `${label} must be one strict JSON scalar.`);
}

function normalizeSource(source) {
  exactRecord(
    source,
    ["variableName", "engine", "semanticClass", "rowCount", "columnCount", "schemaSha256", "sentinels"],
    "Public-UI notebook source receipt"
  );
  const rowCount = assertSafeInteger(source.rowCount, 1, MAXIMUM_SOURCE_ROWS, "Public-UI source row count");
  const columnCount = assertSafeInteger(source.columnCount, 1, MAXIMUM_SOURCE_COLUMNS, "Public-UI source column count");
  exactArray(source.sentinels, MAXIMUM_SENTINELS, "Public-UI source sentinels");
  if (source.sentinels.length === 0) {
    fail("invalid-source", "Public-UI source receipt requires at least one sentinel.");
  }
  const locations = new Set();
  const sentinels = source.sentinels.map((sentinel, index) => {
    exactRecord(sentinel, ["rowIndex", "columnName", "value"], `Public-UI source sentinel ${index}`);
    const rowIndex = assertSafeInteger(
      sentinel.rowIndex,
      0,
      rowCount - 1,
      `Public-UI source sentinel ${index} row index`
    );
    const columnName = assertBoundedString(
      sentinel.columnName,
      MAXIMUM_COLUMN_NAME_BYTES,
      `Public-UI source sentinel ${index} column name`
    );
    const location = `${rowIndex}\0${columnName}`;
    if (locations.has(location)) {
      fail("invalid-source", "Public-UI source sentinel locations must be unique.");
    }
    locations.add(location);
    return {
      rowIndex,
      columnName,
      value: normalizeSentinelValue(sentinel.value, `Public-UI source sentinel ${index} value`)
    };
  });
  sentinels.sort((left, right) => {
    const rowOrder = left.rowIndex - right.rowIndex;
    return rowOrder === 0 ? lexicalCompare(left.columnName, right.columnName) : rowOrder;
  });
  return {
    variableName: assertBoundedString(source.variableName, 128, "Public-UI source variable name"),
    engine: assertBoundedString(source.engine, 32, "Public-UI source engine"),
    semanticClass: assertBoundedString(source.semanticClass, 32, "Public-UI source semantic class"),
    rowCount,
    columnCount,
    schemaSha256: assertString(source.schemaSha256, SHA256, "Public-UI source schema SHA-256"),
    sentinels
  };
}

function normalizeObservation(observation) {
  exactRecord(
    observation,
    ["clock", "startedAtMonotonicMs", "endedAtMonotonicMs", "absenceDeadlineAtMonotonicMs", "maxGapMs", "sampleCount"],
    "Public-UI observation window"
  );
  const startedAtMonotonicMs = assertSafeInteger(
    observation.startedAtMonotonicMs,
    1,
    Number.MAX_SAFE_INTEGER - PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS - PUBLIC_UI_CAPABILITY_END_JITTER_MS,
    "Public-UI observation start"
  );
  const endedAtMonotonicMs = assertSafeInteger(
    observation.endedAtMonotonicMs,
    startedAtMonotonicMs,
    Number.MAX_SAFE_INTEGER,
    "Public-UI observation end"
  );
  const absenceDeadlineAtMonotonicMs = assertSafeInteger(
    observation.absenceDeadlineAtMonotonicMs,
    startedAtMonotonicMs,
    Number.MAX_SAFE_INTEGER,
    "Public-UI absence deadline"
  );
  return {
    clock: assertBoundedString(observation.clock, 64, "Public-UI observation clock"),
    startedAtMonotonicMs,
    endedAtMonotonicMs,
    absenceDeadlineAtMonotonicMs,
    maxGapMs: assertSafeInteger(
      observation.maxGapMs,
      1,
      PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
      "Public-UI observation maximum gap"
    ),
    sampleCount: assertSafeInteger(
      observation.sampleCount,
      1,
      PUBLIC_UI_MAXIMUM_TRACE_SAMPLES,
      "Public-UI observation sample count"
    )
  };
}

function normalizeOutput(output) {
  exactRecord(output, ["ready", "busy", "obstructed", "owner"], "Public-UI notebook output state");
  return {
    ready: assertBoolean(output.ready, "Public-UI notebook output ready state"),
    busy: assertBoolean(output.busy, "Public-UI notebook output busy state"),
    obstructed: assertBoolean(output.obstructed, "Public-UI notebook output obstruction state"),
    owner: assertBoundedString(output.owner, 64, "Public-UI notebook output owner")
  };
}

function normalizeAction(action, index) {
  exactRecord(
    action,
    ["product", "accessibleName", "matchCount", "pointerUsable"],
    `Public-UI action observation ${index}`
  );
  return {
    product: assertBoundedString(action.product, 32, `Public-UI action observation ${index} product`),
    accessibleName: assertBoundedString(
      action.accessibleName,
      256,
      `Public-UI action observation ${index} accessible name`
    ),
    matchCount: assertSafeInteger(action.matchCount, 0, 16, `Public-UI action observation ${index} match count`),
    pointerUsable: assertBoolean(action.pointerUsable, `Public-UI action observation ${index} pointer usability`)
  };
}

function normalizeActions(actions) {
  exactArray(actions, ACTION_ORDER.length, "Public-UI action observations");
  if (actions.length !== ACTION_ORDER.length) {
    fail("invalid-actions", "Public-UI evidence requires the exact two measured action observations.");
  }
  return actions.map(normalizeAction).sort((left, right) => {
    return ACTION_ORDER.indexOf(left.product) - ACTION_ORDER.indexOf(right.product);
  });
}

function normalizeTrace(trace) {
  exactArray(trace, PUBLIC_UI_MAXIMUM_TRACE_SAMPLES, "Public-UI observation trace");
  if (trace.length === 0) {
    fail("invalid-trace", "Public-UI observation trace requires at least one sample.");
  }
  return trace.map((sample, index) => {
    exactRecord(sample, ["atMonotonicMs", "output", "actions"], `Public-UI observation trace sample ${index}`);
    return {
      atMonotonicMs: assertSafeInteger(
        sample.atMonotonicMs,
        1,
        Number.MAX_SAFE_INTEGER,
        `Public-UI observation trace sample ${index} time`
      ),
      output: normalizeOutput(sample.output),
      actions: normalizeActions(sample.actions)
    };
  });
}

export function normalizePublicUiEvidence(evidence) {
  exactRecord(
    evidence,
    ["captureId", "editor", "extensions", "source", "observation", "trace", "output", "actions", "conclusion"],
    "Public-UI raw evidence"
  );
  const actions = normalizeActions(evidence.actions);
  if (!CONCLUSIONS.has(evidence.conclusion)) {
    fail("invalid-conclusion", "Public-UI evidence conclusion is not recognized.");
  }
  const normalized = {
    captureId: assertString(evidence.captureId, UUID_V4, "Public-UI capture ID"),
    editor: normalizeEditor(evidence.editor),
    extensions: normalizeExtensions(evidence.extensions),
    source: normalizeSource(evidence.source),
    observation: normalizeObservation(evidence.observation),
    trace: normalizeTrace(evidence.trace),
    output: normalizeOutput(evidence.output),
    actions,
    conclusion: evidence.conclusion
  };
  const bytes = Buffer.byteLength(canonicalPublicUiReceiptJson(normalized), "utf8");
  if (bytes < 1 || bytes > MAXIMUM_EVIDENCE_BYTES) {
    fail("evidence-too-large", "Normalized public-UI evidence is missing or exceeds one MiB.");
  }
  return deepFreeze(normalized);
}

export function canonicalPublicUiReceiptJson(value) {
  return `${JSON.stringify(canonicalize(value, new Set(), "Public-UI JSON value"), null, 2)}\n`;
}

export function digestPublicUiReceiptEvidence(evidence) {
  return digestCanonical(normalizePublicUiEvidence(evidence));
}

export function createPublicUiReceiptContext(context) {
  return deepFreeze(normalizeContext(context));
}

export function createExpectedPublicUiExtensionInventory(kind) {
  let entries;
  if (kind === CAPABILITY_KIND) {
    entries = createDataWranglerComparisonMeasuredInventory(PUBLIC_UI_DATA_WRANGLER_EXTENSION);
  } else if (kind === CONTROL_KIND) {
    entries = createDataWranglerComparisonControlInventory();
  } else {
    fail("invalid-kind", "Public-UI extension inventory kind is invalid.");
  }
  const normalized = normalizeExtensionEntries(entries);
  return deepFreeze({ complete: true, entries: normalized, sha256: digestCanonical(normalized) });
}

export function createDataWranglerPolarsCapabilityReceipt(evidence, context) {
  return createReceipt(CAPABILITY_KIND, evidence, context);
}

export function validateDataWranglerPolarsCapabilityReceipt(receipt, context) {
  return validateReceipt(receipt, CAPABILITY_KIND, context);
}

export function createNeitherProductControlReceipt(evidence, context) {
  return createReceipt(CONTROL_KIND, evidence, context);
}

export function validateNeitherProductControlReceipt(receipt, context) {
  return validateReceipt(receipt, CONTROL_KIND, context);
}

function createReceipt(kind, evidence, context) {
  const normalizedContext = normalizeContext(context);
  const normalizedEvidence = normalizePublicUiEvidence(evidence);
  assertReceiptSemantics(kind, normalizedEvidence, normalizedContext);
  return deepFreeze({
    protocol: DATA_WRANGLER_PUBLIC_UI_RECEIPT_PROTOCOL,
    kind,
    evidenceSha256: digestCanonical(normalizedEvidence),
    evidence: normalizedEvidence
  });
}

function validateReceipt(receipt, expectedKind, context) {
  exactRecord(receipt, ["protocol", "kind", "evidenceSha256", "evidence"], "Public-UI receipt");
  if (receipt.protocol !== DATA_WRANGLER_PUBLIC_UI_RECEIPT_PROTOCOL || receipt.kind !== expectedKind) {
    fail("wrong-receipt", "Public-UI receipt protocol or kind is invalid.");
  }
  const normalizedContext = normalizeContext(context);
  const normalizedEvidence = normalizePublicUiEvidence(receipt.evidence);
  if (canonicalPublicUiReceiptJson(receipt.evidence) !== canonicalPublicUiReceiptJson(normalizedEvidence)) {
    fail("unnormalized-evidence", "Public-UI receipt evidence is not in normalized form.");
  }
  const evidenceSha256 = assertString(receipt.evidenceSha256, SHA256, "Public-UI evidence SHA-256");
  if (evidenceSha256 !== digestCanonical(normalizedEvidence)) {
    fail("evidence-digest-mismatch", "Public-UI receipt evidence does not match its normalized digest.");
  }
  assertReceiptSemantics(expectedKind, normalizedEvidence, normalizedContext);
  return receipt;
}

function normalizeContext(context) {
  exactRecord(context, ["captureId", "editor", "source"], "Expected public-UI receipt context");
  const normalized = {
    captureId: assertString(context.captureId, UUID_V4, "Expected public-UI capture ID"),
    editor: normalizeEditor(context.editor),
    source: normalizeSource(context.source)
  };
  assertStudyEditor(normalized.editor);
  assertStudyFramePolarsSource(normalized.source);
  return normalized;
}

function assertStudyEditor(editor) {
  if (editor.id !== "Microsoft.VisualStudioCode" || editor.uiLocale !== "en") {
    fail("wrong-editor", "Public-UI evidence requires official Microsoft Visual Studio Code with --locale=en.");
  }
}

function assertStudyFramePolarsSource(source) {
  if (source.variableName !== "study_frame" || source.engine !== "polars" || source.semanticClass !== "dataframe") {
    fail("wrong-source", "Public-UI evidence requires the exact study_frame Polars dataframe source.");
  }
}

function assertReceiptSemantics(kind, evidence, context) {
  assertExpectedContext(evidence, context);
  assertExpectedInventory(kind, evidence.extensions);
  assertObservationWindow(evidence.observation);
  assertUnobstructedHostOutput(evidence.output);
  const actions = assertFixedActions(evidence.actions);
  const traceActions = assertObservationTrace(evidence);

  if (kind === CAPABILITY_KIND) {
    assertCapabilityConclusion(evidence, actions, traceActions);
    return;
  }
  if (kind === CONTROL_KIND) {
    assertControlConclusion(evidence, actions, traceActions);
    return;
  }
  fail("invalid-kind", "Public-UI receipt kind is invalid.");
}

function assertExpectedContext(evidence, context) {
  if (evidence.captureId !== context.captureId) {
    fail("wrong-capture", "Public-UI evidence does not belong to the expected capture ID.");
  }
  if (canonicalPublicUiReceiptJson(evidence.editor) !== canonicalPublicUiReceiptJson(context.editor)) {
    fail("wrong-editor", "Public-UI evidence does not match the exact expected editor identity.");
  }
  if (canonicalPublicUiReceiptJson(evidence.source) !== canonicalPublicUiReceiptJson(context.source)) {
    fail("wrong-source", "Public-UI evidence does not match the exact expected notebook source receipt.");
  }
}

function assertExpectedInventory(kind, inventory) {
  const expected = createExpectedPublicUiExtensionInventory(kind);
  if (canonicalPublicUiReceiptJson(inventory) !== canonicalPublicUiReceiptJson(expected)) {
    fail("wrong-inventory", "Public-UI evidence does not match the exact complete extension inventory.");
  }
  const measured = new Set(inventory.entries.map((entry) => entry.extensionId.toLowerCase()));
  if (kind === CAPABILITY_KIND) {
    if (!measured.has("ms-toolsai.datawrangler") || measured.has("matt17br.openwrangler")) {
      fail("wrong-inventory", "Capability evidence requires Data Wrangler alone among measured products.");
    }
  } else if (measured.has("ms-toolsai.datawrangler") || measured.has("matt17br.openwrangler")) {
    fail("wrong-inventory", "Control evidence requires both measured products to be absent.");
  }
}

function assertObservationWindow(observation) {
  if (
    observation.clock !== "linux-monotonic" ||
    observation.maxGapMs !== PUBLIC_UI_OBSERVATION_MAX_GAP_MS ||
    observation.absenceDeadlineAtMonotonicMs !==
      observation.startedAtMonotonicMs + PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS ||
    observation.endedAtMonotonicMs > observation.absenceDeadlineAtMonotonicMs + PUBLIC_UI_CAPABILITY_END_JITTER_MS
  ) {
    fail("invalid-window", "Public-UI evidence does not contain the fixed absolute monotonic window and cadence.");
  }
}

function assertObservationTrace(evidence) {
  const { observation, trace } = evidence;
  if (
    observation.sampleCount !== trace.length ||
    trace[0].atMonotonicMs !== observation.startedAtMonotonicMs ||
    trace.at(-1).atMonotonicMs !== observation.endedAtMonotonicMs
  ) {
    fail("invalid-trace", "Public-UI trace count and endpoints must match the declared absolute observation window.");
  }
  const actionMaps = [];
  for (const [index, sample] of trace.entries()) {
    if (index > 0) {
      const gap = sample.atMonotonicMs - trace[index - 1].atMonotonicMs;
      if (gap < 1 || gap > observation.maxGapMs) {
        fail("invalid-trace", "Public-UI trace contains a missing, reversed, or overlong observation interval.");
      }
    }
    assertUnobstructedHostOutput(sample.output);
    actionMaps.push(assertFixedActions(sample.actions));
  }
  const finalSample = trace.at(-1);
  if (
    canonicalPublicUiReceiptJson(evidence.output) !== canonicalPublicUiReceiptJson(finalSample.output) ||
    canonicalPublicUiReceiptJson(evidence.actions) !== canonicalPublicUiReceiptJson(finalSample.actions)
  ) {
    fail("forged-summary", "Public-UI summary state must equal the final normalized trace sample.");
  }
  return actionMaps;
}

function assertUnobstructedHostOutput(output) {
  if (
    output.ready !== true ||
    output.busy !== false ||
    output.obstructed !== false ||
    output.owner !== "host-jupyter"
  ) {
    fail("invalid-output", "Public-UI evidence requires the same ready, idle, unobstructed host/Jupyter output.");
  }
}

function assertFixedActions(actions) {
  if (
    actions.length !== ACTION_ORDER.length ||
    actions[0].product !== ACTION_ORDER[0] ||
    actions[1].product !== ACTION_ORDER[1]
  ) {
    fail("invalid-actions", "Public-UI evidence requires one observation for each measured product.");
  }
  const expectedNames = new Map([
    ["open-wrangler", PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME],
    ["data-wrangler", PUBLIC_UI_DATA_WRANGLER_ACTION_NAME]
  ]);
  for (const action of actions) {
    if (action.accessibleName !== expectedNames.get(action.product)) {
      fail("invalid-actions", "Public-UI evidence action accessible names must match the fixed study_frame labels.");
    }
  }
  return new Map(actions.map((action) => [action.product, action]));
}

function assertCapabilityConclusion(evidence, actions, traceActions) {
  if (evidence.conclusion !== "available" && evidence.conclusion !== "capability-timeout") {
    fail("invalid-conclusion", "Data Wrangler Polars capability evidence has an invalid conclusion.");
  }
  const openWrangler = actions.get("open-wrangler");
  const dataWrangler = actions.get("data-wrangler");
  if (
    openWrangler.matchCount !== 0 ||
    openWrangler.pointerUsable !== false ||
    traceActions.some((sample) => {
      const action = sample.get("open-wrangler");
      return action.matchCount !== 0 || action.pointerUsable !== false;
    })
  ) {
    fail("invalid-actions", "Open Wrangler must have no action in the isolated Data Wrangler capability capture.");
  }
  if (evidence.conclusion === "available") {
    const stableStart = traceActions.length - PUBLIC_UI_AVAILABLE_STABILITY_CHECKS;
    if (
      stableStart < 0 ||
      dataWrangler.matchCount !== 1 ||
      dataWrangler.pointerUsable !== true ||
      evidence.observation.endedAtMonotonicMs > evidence.observation.absenceDeadlineAtMonotonicMs ||
      traceActions.some((sample, index) => {
        const action = sample.get("data-wrangler");
        const expectedAvailable = index >= stableStart;
        return action.matchCount !== (expectedAvailable ? 1 : 0) || action.pointerUsable !== expectedAvailable;
      })
    ) {
      fail(
        "invalid-capability",
        "Available Data Wrangler capability must stop at the first stable exact pointer-usable action."
      );
    }
    return;
  }
  if (
    dataWrangler.matchCount !== 0 ||
    dataWrangler.pointerUsable !== false ||
    evidence.observation.endedAtMonotonicMs < evidence.observation.absenceDeadlineAtMonotonicMs ||
    traceActions.some((sample) => {
      const action = sample.get("data-wrangler");
      return action.matchCount !== 0 || action.pointerUsable !== false;
    })
  ) {
    fail("invalid-capability", "A Data Wrangler Polars capability timeout requires zero actions through the deadline.");
  }
}

function assertControlConclusion(evidence, actions, traceActions) {
  if (evidence.conclusion !== "neither-product-control") {
    fail("invalid-conclusion", "Neither-product control evidence has an invalid conclusion.");
  }
  if (evidence.observation.endedAtMonotonicMs < evidence.observation.absenceDeadlineAtMonotonicMs) {
    fail("invalid-control", "Neither-product control must observe the full absence deadline.");
  }
  for (const action of actions.values()) {
    if (action.matchCount !== 0 || action.pointerUsable !== false) {
      fail("invalid-control", "Neither-product control requires both launch actions to remain absent.");
    }
  }
  for (const sample of traceActions) {
    for (const action of sample.values()) {
      if (action.matchCount !== 0 || action.pointerUsable !== false) {
        fail("invalid-control", "Neither-product control trace requires both launch actions to remain absent.");
      }
    }
  }
}

function canonicalize(value, ancestors, label) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("invalid-json", `${label} contains a non-finite number.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    exactArray(value, Number.MAX_SAFE_INTEGER, label);
    if (ancestors.has(value)) {
      fail("invalid-json", `${label} contains a cycle.`);
    }
    ancestors.add(value);
    try {
      return value.map((item, index) => canonicalize(item, ancestors, `${label}[${index}]`));
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isPlainRecord(value)) {
    fail("invalid-json", `${label} contains a non-JSON value.`);
  }
  if (ancestors.has(value)) {
    fail("invalid-json", `${label} contains a cycle.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail("invalid-json", `${label} contains a symbol-keyed field.`);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      fail("invalid-json", `${label}.${key} must be one enumerable data field.`);
    }
  }
  ancestors.add(value);
  try {
    return Object.fromEntries(
      ownKeys
        .map(String)
        .sort()
        .map((key) => [key, canonicalize(value[key], ancestors, `${label}.${key}`)])
    );
  } finally {
    ancestors.delete(value);
  }
}

function digestCanonical(value) {
  return createHash("sha256").update(canonicalPublicUiReceiptJson(value), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function freezeInventory(entries) {
  return deepFreeze(
    entries.map((entry) => ({ ...entry })).sort((left, right) => lexicalCompare(left.extensionId, right.extensionId))
  );
}
