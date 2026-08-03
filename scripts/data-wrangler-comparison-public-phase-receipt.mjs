import {
  DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND,
  NEITHER_PRODUCT_CONTROL_RECEIPT_KIND,
  createDataWranglerPolarsCapabilityReceipt,
  createExpectedPublicUiExtensionInventory,
  createNeitherProductControlReceipt
} from "./data-wrangler-public-ui-receipts.mjs";
import { canonicalStudyJson, digestStudyValue } from "./data-wrangler-comparison-study.mjs";

export const DATA_WRANGLER_PUBLIC_UI_CAPTURE_PHASE_PROTOCOL = "openwrangler-data-wrangler-public-ui-capture-phase-v1";

const SHA256 = /^[0-9a-f]{64}$/u;
const PYTHON_312 = /^3\.12\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const DECIMAL_INTEGER = /^\d+$/u;

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function expectedSourceContext(fixture) {
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

function validateSourceReceipt(value, fixture, expected, label) {
  exactKeys(value, ["sha256", "filesystemIdentity"], label);
  exactKeys(value.filesystemIdentity, ["device", "inode", "sizeBytes", "mtimeNs"], `${label} filesystem identity`);
  const identity = value.filesystemIdentity;
  if (
    value.sha256 !== fixture.sha256 ||
    !SHA256.test(value.sha256) ||
    typeof identity.device !== "string" ||
    !DECIMAL_INTEGER.test(identity.device) ||
    typeof identity.inode !== "string" ||
    !DECIMAL_INTEGER.test(identity.inode) ||
    !Number.isSafeInteger(identity.sizeBytes) ||
    identity.sizeBytes <= 0 ||
    typeof identity.mtimeNs !== "string" ||
    !DECIMAL_INTEGER.test(identity.mtimeNs) ||
    (expected !== undefined && canonicalStudyJson(value) !== canonicalStudyJson(expected))
  ) {
    fail(`${label} does not match the registered fixture and private source copy.`);
  }
  return value;
}

function validateFixture(fixture) {
  if (
    !isRecord(fixture) ||
    typeof fixture.id !== "string" ||
    !["csv", "parquet"].includes(fixture.format) ||
    !Number.isSafeInteger(fixture.rows) ||
    fixture.rows < 3 ||
    !Number.isSafeInteger(fixture.columns) ||
    fixture.columns < 2 ||
    typeof fixture.sha256 !== "string" ||
    !SHA256.test(fixture.sha256) ||
    !Array.isArray(fixture.schema) ||
    fixture.schema.length !== fixture.columns ||
    !Array.isArray(fixture.sentinels) ||
    fixture.sentinels.length === 0
  ) {
    fail("Public-UI capture fixture is malformed.");
  }
}

function validateVerification(verification, { fixture, sourceReceipt, python }) {
  exactKeys(
    verification,
    [
      "phase",
      "pythonImplementation",
      "pythonVersion",
      "classMatched",
      "shapeMatched",
      "columnsMatched",
      "integerDtypeMatched",
      "sentinelsMatched",
      "objectTokenContinuous",
      "rowDataIncluded",
      "observedSource"
    ],
    "Public-UI capture verification"
  );
  const expectedPythonImplementation = python?.implementation ?? "CPython";
  const expectedPythonVersion = python?.version;
  if (
    verification.phase !== "before-timing" ||
    verification.pythonImplementation !== expectedPythonImplementation ||
    typeof verification.pythonVersion !== "string" ||
    !PYTHON_312.test(verification.pythonVersion) ||
    (expectedPythonVersion !== undefined && verification.pythonVersion !== expectedPythonVersion) ||
    verification.classMatched !== true ||
    verification.shapeMatched !== true ||
    verification.columnsMatched !== true ||
    verification.integerDtypeMatched !== true ||
    verification.sentinelsMatched !== true ||
    verification.objectTokenContinuous !== true ||
    verification.rowDataIncluded !== false
  ) {
    fail("Public-UI capture did not retain the complete before-timing verification.");
  }
  const observed = verification.observedSource;
  exactKeys(
    observed,
    ["file", "semanticClass", "rowCount", "columnCount", "schema", "sentinels"],
    "Public-UI capture observed source"
  );
  validateSourceReceipt(observed.file, fixture, sourceReceipt, "Public-UI capture observed source file");
  if (
    observed.semanticClass !== "dataframe" ||
    observed.rowCount !== fixture.rows ||
    observed.columnCount !== fixture.columns ||
    canonicalStudyJson(observed.schema) !== canonicalStudyJson(fixture.schema) ||
    canonicalStudyJson(observed.sentinels) !== canonicalStudyJson(fixture.sentinels)
  ) {
    fail("Public-UI capture observed source does not match the registered dataframe fixture.");
  }
}

function receiptKind(kind) {
  if (kind === "capability") return DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND;
  if (kind === "control") return NEITHER_PRODUCT_CONTROL_RECEIPT_KIND;
  fail("Public-UI capture binding kind is invalid.");
}

export function validateDataWranglerPublicUiCapturePhaseReceipt(
  raw,
  { kind, captureId, editor, fixture, kernel, sourceReceipt: expectedSourceReceipt, python }
) {
  exactKeys(
    raw,
    [
      "protocol",
      "captureId",
      "kind",
      "locale",
      "editorVersion",
      "study",
      "verification",
      "observation",
      "trace",
      "output",
      "actions",
      "conclusion"
    ],
    "Public-UI capture phase receipt"
  );
  validateFixture(fixture);
  exactKeys(editor, ["id", "version", "sha256", "uiLocale"], "Public-UI capture editor");
  if (
    !isRecord(kernel) ||
    typeof kernel.name !== "string" ||
    kernel.name.length === 0 ||
    typeof kernel.displayName !== "string" ||
    kernel.displayName.length === 0
  ) {
    fail("Public-UI capture kernel is malformed.");
  }
  exactKeys(raw.study, ["engine", "format", "kind", "fixture", "kernel", "sourceReceipt"], "Public-UI study");
  const sourceReceipt = validateSourceReceipt(
    raw.study.sourceReceipt,
    fixture,
    expectedSourceReceipt,
    "Public-UI study source receipt"
  );
  const expectedStudy = {
    engine: "polars",
    format: fixture.format,
    kind: "warm",
    fixture: {
      id: fixture.id,
      sha256: fixture.sha256,
      rows: fixture.rows,
      columns: fixture.columns
    },
    kernel: { name: kernel.name, displayName: kernel.displayName },
    sourceReceipt
  };
  if (
    raw.protocol !== DATA_WRANGLER_PUBLIC_UI_CAPTURE_PHASE_PROTOCOL ||
    raw.captureId !== captureId ||
    raw.kind !== kind ||
    raw.locale !== editor.uiLocale ||
    raw.editorVersion !== editor.version ||
    canonicalStudyJson(raw.study) !== canonicalStudyJson(expectedStudy)
  ) {
    fail("Public-UI capture phase does not match its exact editor, source, kernel, and fixture.");
  }
  validateVerification(raw.verification, { fixture, sourceReceipt, python });
  return raw;
}

function evidenceFromPhase(raw, context, kind) {
  return {
    captureId: context.captureId,
    editor: structuredClone(context.editor),
    extensions: structuredClone(createExpectedPublicUiExtensionInventory(receiptKind(kind))),
    source: structuredClone(context.source),
    observation: structuredClone(raw.observation),
    trace: structuredClone(raw.trace),
    output: structuredClone(raw.output),
    actions: structuredClone(raw.actions),
    conclusion: raw.conclusion
  };
}

export function deriveDataWranglerPublicUiManifestEntryFromPhase({
  kind,
  fixtureId,
  phaseReceipt,
  context,
  editor,
  fixture,
  kernel,
  sourceReceipt,
  python
}) {
  if (
    fixtureId !== fixture.id ||
    context.captureId !== phaseReceipt.captureId ||
    canonicalStudyJson(context.editor) !== canonicalStudyJson(editor) ||
    canonicalStudyJson(context.source) !== canonicalStudyJson(expectedSourceContext(fixture))
  ) {
    fail("Public-UI capture context does not match its exact editor and registered fixture source.");
  }
  const raw = validateDataWranglerPublicUiCapturePhaseReceipt(phaseReceipt, {
    kind,
    captureId: context.captureId,
    editor,
    fixture,
    kernel,
    sourceReceipt,
    python
  });
  const evidence = evidenceFromPhase(raw, context, kind);
  if (kind === "capability") {
    const receipt = createDataWranglerPolarsCapabilityReceipt(evidence, context);
    return Object.freeze({
      product: "data-wrangler",
      engine: "polars",
      availability: receipt.evidence.conclusion === "available" ? "available" : "undetermined",
      method: "public-capability",
      timed: false,
      fixtureId,
      context,
      receiptSha256: digestStudyValue(receipt),
      receipt
    });
  }
  if (kind === "control") {
    const receipt = createNeitherProductControlReceipt(evidence, context);
    return Object.freeze({
      method: "neither-product",
      fixtureId,
      context,
      receiptSha256: digestStudyValue(receipt),
      receipt
    });
  }
  fail("Public-UI capture binding kind is invalid.");
}

export function assertDataWranglerPublicUiManifestEntryMatchesPhase(manifestEntry, options) {
  const derived = deriveDataWranglerPublicUiManifestEntryFromPhase(options);
  if (canonicalStudyJson(manifestEntry) !== canonicalStudyJson(derived)) {
    fail("Public-UI manifest receipt does not derive exactly from its retained raw phase evidence.");
  }
  return derived;
}
