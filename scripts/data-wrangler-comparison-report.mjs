import fixtureManifestContract from "../src/shared/installedPerformanceFixtureManifest.cjs";

export const COMPARISON_PHASE_PROTOCOL = "openwrangler-comparison-phase-v1";
export const DATA_WRANGLER_COMPARISON_SMOKE_PROTOCOL = "openwrangler-data-wrangler-comparison-smoke-v1";
export const DATA_WRANGLER_COMPARISON_BOUNDARY =
  "visible Explorer context-menu action click to a selected unobstructed target editor with a stable pointer-usable generic ARIA grid or table and matched deterministic sentinels";
export const DATA_WRANGLER_BASELINE_VERSION = "1.24.2";

const SOURCE_CACHE_PROOF_PROTOCOL = "openwrangler-source-cache-proof-v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const PACKAGE_VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,126}[0-9A-Za-z])?$/u;
const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}\.[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const INSTALLED_EXTENSION = /^([A-Za-z0-9][A-Za-z0-9-]{0,63}\.[A-Za-z0-9][A-Za-z0-9-]{0,127})@(.{1,128})$/u;
const PYTHON_VERSION = /^3\.(?:10|11|12|13|14)(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u;
const PRODUCT_ORDER = Object.freeze([
  "open-wrangler:csv",
  "open-wrangler:parquet",
  "data-wrangler:csv",
  "data-wrangler:parquet"
]);
const EXPECTED_PRODUCT = Object.freeze({
  "open-wrangler": Object.freeze({
    id: "Matt17BR.openwrangler",
    installation: "candidate-vsix"
  }),
  "data-wrangler": Object.freeze({
    id: "ms-toolsai.datawrangler",
    installation: "official-vscode-marketplace"
  })
});

export function validateDataWranglerComparisonPhase(phase) {
  exactKeys(
    phase,
    ["protocol", "runId", "product", "editor", "fixture", "diagnostic", "proofs", "installedExtensions"],
    "comparison phase"
  );
  assertEqual(phase.protocol, COMPARISON_PHASE_PROTOCOL, "comparison phase protocol");
  assertMatch(phase.runId, UUID, "comparison phase run ID");
  validateProduct(phase.product);
  validateEditor(phase.editor);
  validateFixture(phase.fixture);
  validateDiagnostic(phase.diagnostic);
  validateProofs(phase.proofs);
  validateInstalledExtensions(phase.installedExtensions, phase.product);
  assertPublicEvidence(phase);
  return phase;
}

export function buildDataWranglerComparisonSmokeReport({
  generatedAtUtc,
  configuredPythonEnvironment,
  fixtureManifest,
  phases
}) {
  canonicalUtcTimestamp(generatedAtUtc);
  validateConfiguredPythonEnvironment(configuredPythonEnvironment);
  const manifest = fixtureManifestContract.decodeInstalledPerformanceFixtureManifest(fixtureManifest);
  if (manifest.smoke !== true) {
    throw new TypeError("The comparison smoke report requires smoke-sized fixtures.");
  }
  if (!Array.isArray(phases)) throw new TypeError("Comparison smoke phases must be an array.");
  const sortedPhases = phases
    .map((phase) => structuredClone(validateDataWranglerComparisonPhase(phase)))
    .sort((left, right) => phaseOrder(left) - phaseOrder(right));
  const report = {
    protocol: DATA_WRANGLER_COMPARISON_SMOKE_PROTOCOL,
    generatedAtUtc,
    feasibilityOnly: true,
    publishable: false,
    studyDesign: {
      boundary: DATA_WRANGLER_COMPARISON_BOUNDARY,
      executionOrder: ["open-wrangler", "data-wrangler"],
      orderPolicy: "fixed",
      warmupsPerProduct: 1,
      diagnosticLaunchesPerProductFormat: 1,
      sourceCache: "resident",
      durationInterpretation: "diagnostic-only-non-comparative",
      backendMatch: "not-established"
    },
    configuredPythonEnvironment: structuredClone(configuredPythonEnvironment),
    fixtureManifest: structuredClone(manifest),
    phases: sortedPhases
  };
  return validateDataWranglerComparisonSmokeReport(report);
}

export function validateDataWranglerComparisonSmokeReport(report) {
  exactKeys(
    report,
    [
      "protocol",
      "generatedAtUtc",
      "feasibilityOnly",
      "publishable",
      "studyDesign",
      "configuredPythonEnvironment",
      "fixtureManifest",
      "phases"
    ],
    "comparison smoke report"
  );
  assertEqual(report.protocol, DATA_WRANGLER_COMPARISON_SMOKE_PROTOCOL, "comparison smoke report protocol");
  canonicalUtcTimestamp(report.generatedAtUtc);
  assertEqual(report.feasibilityOnly, true, "comparison smoke feasibility-only flag");
  assertEqual(report.publishable, false, "comparison smoke publishable flag");
  exactKeys(
    report.studyDesign,
    [
      "boundary",
      "executionOrder",
      "orderPolicy",
      "warmupsPerProduct",
      "diagnosticLaunchesPerProductFormat",
      "sourceCache",
      "durationInterpretation",
      "backendMatch"
    ],
    "comparison feasibility-study design"
  );
  assertEqual(report.studyDesign.boundary, DATA_WRANGLER_COMPARISON_BOUNDARY, "comparison diagnostic boundary");
  assertExactStringArray(
    report.studyDesign.executionOrder,
    ["open-wrangler", "data-wrangler"],
    "comparison fixed execution order"
  );
  assertEqual(report.studyDesign.orderPolicy, "fixed", "comparison execution-order policy");
  assertEqual(report.studyDesign.warmupsPerProduct, 1, "comparison warmups per product");
  assertEqual(
    report.studyDesign.diagnosticLaunchesPerProductFormat,
    1,
    "comparison diagnostic launches per product and format"
  );
  assertEqual(report.studyDesign.sourceCache, "resident", "comparison source-cache state");
  assertEqual(
    report.studyDesign.durationInterpretation,
    "diagnostic-only-non-comparative",
    "comparison duration interpretation"
  );
  assertEqual(report.studyDesign.backendMatch, "not-established", "comparison backend-match status");
  validateConfiguredPythonEnvironment(report.configuredPythonEnvironment);

  const manifest = fixtureManifestContract.decodeInstalledPerformanceFixtureManifest(report.fixtureManifest);
  if (manifest.smoke !== true) {
    throw new TypeError("The comparison smoke report requires smoke-sized fixtures.");
  }
  if (!Array.isArray(report.phases) || report.phases.length !== PRODUCT_ORDER.length) {
    throw new TypeError("The comparison smoke report requires exactly four product-format phases.");
  }
  const phaseKeys = [];
  for (const phase of report.phases) {
    validateDataWranglerComparisonPhase(phase);
    const key = `${phase.product.key}:${phase.fixture.format}`;
    phaseKeys.push(key);
    const expectedFixture = manifest.fixtures[phase.fixture.format];
    if (
      phase.fixture.rows !== expectedFixture.rows ||
      phase.fixture.columns !== expectedFixture.columns ||
      phase.fixture.bytes !== expectedFixture.bytes ||
      phase.fixture.sha256 !== expectedFixture.sha256
    ) {
      throw new TypeError(`${key} does not match the deterministic smoke fixture manifest.`);
    }
  }
  if (phaseKeys.some((key, index) => key !== PRODUCT_ORDER[index])) {
    throw new TypeError(
      "Comparison smoke phases must contain each product and format exactly once in canonical order."
    );
  }

  const [first, ...remaining] = report.phases;
  for (const phase of remaining) {
    if (JSON.stringify(phase.editor) !== JSON.stringify(first.editor)) {
      throw new TypeError("Every comparison phase must use the same official VS Code build.");
    }
  }
  for (const productKey of Object.keys(EXPECTED_PRODUCT)) {
    const productPhases = report.phases.filter((phase) => phase.product.key === productKey);
    if (
      productPhases.length !== 2 ||
      JSON.stringify(productPhases[0].product) !== JSON.stringify(productPhases[1].product) ||
      JSON.stringify(productPhases[0].installedExtensions) !== JSON.stringify(productPhases[1].installedExtensions)
    ) {
      throw new TypeError(`${productKey} comparison phases must retain identical product and extension provenance.`);
    }
  }
  assertPublicEvidence(report);
  return report;
}

function validateProduct(product) {
  exactKeys(product, ["key", "id", "version", "installation", "candidateSha256"], "comparison product");
  if (!Object.hasOwn(EXPECTED_PRODUCT, product.key)) {
    throw new TypeError("Comparison product key must be open-wrangler or data-wrangler.");
  }
  const expected = EXPECTED_PRODUCT[product.key];
  assertEqual(product.id, expected.id, `${product.key} extension ID`);
  assertMatch(product.version, NUMERIC_VERSION, `${product.key} extension version`);
  assertEqual(product.installation, expected.installation, `${product.key} installation source`);
  if (product.key === "open-wrangler") {
    assertMatch(product.candidateSha256, SHA256, "Open Wrangler candidate SHA-256");
  } else {
    assertEqual(product.version, DATA_WRANGLER_BASELINE_VERSION, "Data Wrangler baseline version");
    assertEqual(product.candidateSha256, null, "Data Wrangler proprietary candidate digest");
  }
}

function validateEditor(editor) {
  exactKeys(editor, ["id", "version", "officialDistribution", "displayMode"], "comparison editor");
  assertEqual(editor.id, "microsoft.vscode", "comparison editor ID");
  assertMatch(editor.version, NUMERIC_VERSION, "comparison editor version");
  assertEqual(editor.officialDistribution, true, "official VS Code distribution proof");
  assertEqual(editor.displayMode, "headless", "comparison editor display mode");
}

function validateConfiguredPythonEnvironment(environment) {
  exactKeys(
    environment,
    [
      "pythonVersion",
      "pythonImplementation",
      "pythonExecutableSha256",
      "installedPandasVersion",
      "installedPyarrowVersion",
      "installedJupyterCoreVersion",
      "installedIpykernelVersion"
    ],
    "comparison configured Python environment"
  );
  assertMatch(environment.pythonVersion, PYTHON_VERSION, "comparison configured Python version");
  assertEqual(environment.pythonImplementation, "CPython", "comparison configured Python implementation");
  assertMatch(environment.pythonExecutableSha256, SHA256, "comparison configured Python executable SHA-256");
  for (const [key, label] of [
    ["installedPandasVersion", "installed Pandas"],
    ["installedPyarrowVersion", "installed PyArrow"],
    ["installedJupyterCoreVersion", "installed Jupyter Core"],
    ["installedIpykernelVersion", "installed ipykernel"]
  ]) {
    assertMatch(environment[key], PACKAGE_VERSION, `comparison ${label} version`);
  }
}

function validateFixture(fixture) {
  exactKeys(fixture, ["format", "rows", "columns", "bytes", "sha256"], "comparison fixture");
  if (fixture.format !== "csv" && fixture.format !== "parquet") {
    throw new TypeError("Comparison fixture format must be csv or parquet.");
  }
  assertPositiveInteger(fixture.rows, "comparison fixture rows");
  assertPositiveInteger(fixture.columns, "comparison fixture columns");
  assertPositiveInteger(fixture.bytes, "comparison fixture bytes");
  assertMatch(fixture.sha256, SHA256, "comparison fixture SHA-256");
}

function validateDiagnostic(diagnostic) {
  exactKeys(
    diagnostic,
    ["boundary", "warmupCompleted", "diagnosticDurationMs", "cacheProof", "readiness"],
    "comparison launch/readiness diagnostic"
  );
  assertEqual(diagnostic.boundary, DATA_WRANGLER_COMPARISON_BOUNDARY, "comparison diagnostic boundary");
  assertEqual(diagnostic.warmupCompleted, true, "comparison warm-up proof");
  if (
    typeof diagnostic.diagnosticDurationMs !== "number" ||
    !Number.isFinite(diagnostic.diagnosticDurationMs) ||
    diagnostic.diagnosticDurationMs <= 0 ||
    diagnostic.diagnosticDurationMs > 300_000
  ) {
    throw new TypeError("Comparison diagnostic duration must be finite and between 0 and 300,000 ms.");
  }
  validateCacheProof(diagnostic.cacheProof);
  validateReadiness(diagnostic.readiness);
}

function validateCacheProof(proof) {
  exactKeys(
    proof,
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
      "verified"
    ],
    "comparison source-cache proof"
  );
  assertEqual(proof.protocol, SOURCE_CACHE_PROOF_PROTOCOL, "comparison source-cache protocol");
  assertEqual(proof.requestedState, "resident", "comparison source-cache requested state");
  assertEqual(proof.fdatasyncApplied, true, "comparison source-cache fdatasync proof");
  assertEqual(proof.adviceAccepted, false, "comparison warm-cache advisory proof");
  assertEqual(proof.verification, "linux-mincore", "comparison source-cache verification");
  assertPositiveInteger(proof.pageSizeBytes, "comparison source-cache page size");
  assertPositiveInteger(proof.totalPages, "comparison source-cache total pages");
  assertIntegerBetween(
    proof.residentPagesBefore,
    0,
    proof.totalPages,
    "comparison source-cache resident pages before preparation"
  );
  assertEqual(proof.residentPagesAfter, proof.totalPages, "comparison source-cache resident pages after preparation");
  assertEqual(proof.identityStable, true, "comparison source-cache identity proof");
  assertEqual(proof.verified, true, "comparison source-cache verification proof");
}

function validateReadiness(readiness) {
  exactKeys(readiness, ["grid", "workbench"], "comparison readiness boundary");
  validateGridReadiness(readiness.grid);
  validateWorkbenchReadiness(readiness.workbench);
}

function validateGridReadiness(readiness) {
  exactKeys(
    readiness,
    [
      "rootRole",
      "busy",
      "visible",
      "pointerUsable",
      "geometryStableFrames",
      "headers",
      "sentinelsMatched",
      "ariaRowCount",
      "ariaColumnCount"
    ],
    "comparison grid readiness"
  );
  if (readiness.rootRole !== "grid" && readiness.rootRole !== "table") {
    throw new TypeError("Comparison readiness root role must be grid or table.");
  }
  if (readiness.busy !== "false" && readiness.busy !== "absent") {
    throw new TypeError("Comparison readiness must prove aria-busy is false or absent.");
  }
  assertEqual(readiness.visible, true, "comparison visible-grid proof");
  assertEqual(readiness.pointerUsable, true, "comparison pointer-usable grid proof");
  assertEqual(readiness.geometryStableFrames, 2, "comparison stable-geometry frame count");
  assertExactStringArray(readiness.headers, ["c00", "c01"], "comparison readiness headers");
  assertEqual(readiness.sentinelsMatched, true, "comparison deterministic-sentinel proof");
  validateOptionalAriaCount(readiness.ariaRowCount, "comparison readiness ARIA row count");
  validateOptionalAriaCount(readiness.ariaColumnCount, "comparison readiness ARIA column count");
}

function validateWorkbenchReadiness(readiness) {
  exactKeys(
    readiness,
    ["targetEditorSelected", "noVisibleQuickInput", "noVisibleDialog", "noVisibleModal", "rendererFramePointerUsable"],
    "comparison workbench readiness"
  );
  for (const [key, label] of [
    ["targetEditorSelected", "selected target editor"],
    ["noVisibleQuickInput", "no-visible-Quick-Input"],
    ["noVisibleDialog", "no-visible-dialog"],
    ["noVisibleModal", "no-visible-modal"],
    ["rendererFramePointerUsable", "pointer-usable renderer frame"]
  ]) {
    assertEqual(readiness[key], true, `comparison ${label} proof`);
  }
}

function validateProofs(proofs) {
  exactKeys(
    proofs,
    [
      "telemetryDisabled",
      "sourceIdentityStable",
      "sourceUnchanged",
      "configuredPythonProcessObservedDuringProductRun",
      "cleanupVerified"
    ],
    "comparison proofs"
  );
  for (const [key, label] of [
    ["telemetryDisabled", "telemetry-off"],
    ["sourceIdentityStable", "source-identity"],
    ["sourceUnchanged", "source-content"],
    ["configuredPythonProcessObservedDuringProductRun", "configured-Python-process-during-product-run"],
    ["cleanupVerified", "terminal-cleanup"]
  ]) {
    assertEqual(proofs[key], true, `comparison ${label} proof`);
  }
}

function validateInstalledExtensions(installedExtensions, product) {
  if (!Array.isArray(installedExtensions) || installedExtensions.length === 0 || installedExtensions.length > 64) {
    throw new TypeError("Comparison installed extensions must contain between 1 and 64 entries.");
  }
  const normalized = [];
  for (const entry of installedExtensions) {
    const match = typeof entry === "string" ? INSTALLED_EXTENSION.exec(entry) : null;
    if (!match || !EXTENSION_ID.test(match[1]) || !PACKAGE_VERSION.test(match[2])) {
      throw new TypeError("Comparison installed extension entries must be bounded extension-id@version values.");
    }
    normalized.push(`${match[1].toLowerCase()}@${match[2]}`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("Comparison installed extension entries must be unique.");
  }
  if (normalized.some((entry, index) => index > 0 && entry < normalized[index - 1])) {
    throw new TypeError("Comparison installed extension entries must use canonical sorted order.");
  }
  const expectedProduct = `${product.id.toLowerCase()}@${product.version}`;
  if (!normalized.includes(expectedProduct)) {
    throw new TypeError("Comparison installed extensions do not contain the measured product version.");
  }
}

function phaseOrder(phase) {
  const index = PRODUCT_ORDER.indexOf(`${phase.product.key}:${phase.fixture.format}`);
  if (index < 0) throw new TypeError("Comparison phase has an unknown product-format pair.");
  return index;
}

function validateOptionalAriaCount(value, label) {
  if (value !== null) assertPositiveInteger(value, label);
}

function canonicalUtcTimestamp(value) {
  assertBoundedString(value, "comparison report timestamp");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError("Comparison report timestamp must be a canonical UTC ISO string.");
  }
  return value;
}

function assertExactStringArray(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new TypeError(`${label} must match the deterministic comparison contract.`);
  }
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
