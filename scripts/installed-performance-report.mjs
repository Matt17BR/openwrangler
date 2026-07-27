import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import fixtureManifestContract from "../src/shared/installedPerformanceFixtureManifest.cjs";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";

export const INSTALLED_PERFORMANCE_FIXTURE_PROTOCOL = fixtureManifestContract.INSTALLED_PERFORMANCE_FIXTURE_PROTOCOL;
export const INSTALLED_PERFORMANCE_PHASE_PROTOCOL = "openwrangler-installed-performance-phase-v4";
export const INSTALLED_PERFORMANCE_REPORT_PROTOCOL = "openwrangler-installed-performance-report-v6";
export const INSTALLED_PERFORMANCE_EVIDENCE_REPORT_PROTOCOL = "openwrangler-installed-performance-evidence-report-v1";
export const INSTALLED_PERFORMANCE_CACHE_PROOF_PROTOCOL = "openwrangler-source-cache-proof-v1";
export const INSTALLED_PERFORMANCE_SAMPLE_COUNT = 10;
export const INSTALLED_PERFORMANCE_OUTLIER_POLICY =
  "retain every measured sample; no trimming, deletion, winsorization, or retry";
export const INSTALLED_PERFORMANCE_BOUNDARY =
  "vscode.openWith dispatch to a visible production grid block with exact shape and aria-busy=false";
export const INSTALLED_PERFORMANCE_LIMITS = Object.freeze({
  csvFirstUsableGridP95Ms: 3_000,
  parquetFirstUsableGridP95Ms: 5_000,
  cachedGridP95Ms: 100,
  uncachedGridP95Ms: 500,
  interactionHeartbeatP95Ms: 100,
  outstandingRendererHeartbeatMs: 100,
  outstandingForegroundPageMs: 500
});

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PYTHON_VERSION = /^3\.(?:10|11|12|13|14)(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u;
const MAX_REPORT_BYTES = 1024 * 1024;
const installedPerformanceReportReceipts = new WeakSet();

export function summarizeInstalledDurationSamples(samples, label = "duration samples") {
  assertDurationSamples(samples, label);
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    count: samples.length,
    samplesMs: [...samples],
    excludedSamples: 0,
    outlierPolicy: INSTALLED_PERFORMANCE_OUTLIER_POLICY,
    minMs: ordered[0],
    medianMs: median(ordered),
    p95Ms: nearestRank(ordered, 0.95),
    maxMs: ordered.at(-1)
  };
}

export function validateInstalledFixtureManifest(manifest) {
  const decoded = fixtureManifestContract.decodeInstalledPerformanceFixtureManifest(manifest);
  assertPublicEvidence(decoded);
  return decoded;
}

export function validateInstalledPerformancePhase(fragment, expected = {}) {
  exactKeys(
    fragment,
    ["protocol", "runId", "phase", "editor", "runtime", "productConfiguration", "fixture", "measurement"],
    [],
    "installed performance phase"
  );
  assertEqual(fragment.protocol, INSTALLED_PERFORMANCE_PHASE_PROTOCOL, "installed performance phase protocol");
  assertMatch(fragment.runId, UUID, "installed performance run ID");
  assertBoundedString(fragment.phase, "installed performance phase name");
  if (expected.runId !== undefined) assertEqual(fragment.runId, expected.runId, "installed performance run ID");
  if (expected.phase !== undefined) assertEqual(fragment.phase, expected.phase, "installed performance phase name");
  validateEditor(fragment.editor);
  validateRuntime(fragment.runtime);
  validateProductConfiguration(fragment.productConfiguration);
  validatePhaseFixture(fragment.fixture);

  const kind = fragment.measurement?.kind;
  if (kind === "first-grid") {
    validateFirstGridMeasurement(fragment.measurement, fragment.fixture.format);
  } else if (kind === "grid-interaction") {
    validateGridInteractionMeasurement(fragment.measurement);
  } else {
    throw new TypeError("Installed performance measurement kind must be first-grid or grid-interaction.");
  }
  assertPublicEvidence(fragment);
  return fragment;
}

export function buildInstalledPerformanceReport({ generatedAtUtc, candidate, source, fixtureManifest, editorRuns }) {
  validateCandidate(candidate);
  validateSource(source);
  if (candidate.sourceCommit !== source.commit) {
    throw new TypeError("Installed performance candidate does not match its guarded source commit.");
  }
  validateInstalledFixtureManifest(fixtureManifest);
  if (fixtureManifest.smoke) {
    throw new TypeError("A release report cannot use smoke-sized performance fixtures.");
  }
  if (!Array.isArray(editorRuns) || editorRuns.length === 0) {
    throw new TypeError("An installed performance report requires editor runs.");
  }
  const editorKeys = new Set();
  const editors = editorRuns.map((run) => {
    exactKeys(run, ["provenance", "resources", "phases"], [], "editor performance run");
    validateProvenance(run.provenance);
    validateResources(run.resources);
    if (run.provenance.runtime.openWranglerRuntimeVersion !== candidate.extensionVersion) {
      throw new TypeError("Installed performance runtime version does not match its VSIX candidate.");
    }
    if (editorKeys.has(run.provenance.editor.key)) {
      throw new TypeError(`Duplicate installed performance editor ${run.provenance.editor.key}.`);
    }
    editorKeys.add(run.provenance.editor.key);
    const phases = run.phases.map((phase) => validateInstalledPerformancePhase(phase));
    for (const phase of phases) {
      if (
        phase.editor.key !== run.provenance.editor.key ||
        phase.editor.productVersion !== run.provenance.editor.productVersion ||
        phase.editor.vscodeApiVersion !== run.provenance.editor.vscodeApiVersion ||
        phase.runtime.pythonVersion !== run.provenance.runtime.pythonVersion ||
        phase.runtime.pythonExecutableSha256 !== run.provenance.runtime.pythonExecutableSha256 ||
        phase.runtime.polarsVersion !== run.provenance.runtime.polarsVersion ||
        JSON.stringify(phase.productConfiguration) !== JSON.stringify(run.provenance.productConfiguration)
      ) {
        throw new TypeError("Installed performance phase provenance does not match its editor run.");
      }
      const fixture = fixtureManifest.fixtures[phase.fixture.format];
      if (
        phase.fixture.sha256 !== fixture.sha256 ||
        phase.fixture.rows !== fixture.rows ||
        phase.fixture.columns !== fixture.columns
      ) {
        throw new TypeError("Installed performance phase fixture does not match the generated manifest.");
      }
    }
    return {
      provenance: structuredClone(run.provenance),
      resources: structuredClone(run.resources),
      results: groupEditorPhases(phases)
    };
  });

  const evidenceOnly = candidate.buildMethod === "performance-evidence-artifact-v1";
  const report = {
    protocol: evidenceOnly ? INSTALLED_PERFORMANCE_EVIDENCE_REPORT_PROTOCOL : INSTALLED_PERFORMANCE_REPORT_PROTOCOL,
    generatedAtUtc: canonicalUtcTimestamp(generatedAtUtc),
    candidate: structuredClone(candidate),
    source: structuredClone(source),
    fixtureManifest: structuredClone(fixtureManifest),
    measurement: {
      boundary: INSTALLED_PERFORMANCE_BOUNDARY,
      sampleCountPerCase: INSTALLED_PERFORMANCE_SAMPLE_COUNT,
      outlierPolicy: INSTALLED_PERFORMANCE_OUTLIER_POLICY
    },
    limits: { ...INSTALLED_PERFORMANCE_LIMITS },
    editors
  };
  const failures = installedPerformanceFailures(report);
  report[evidenceOnly ? "evidenceGate" : "releaseGate"] = { passed: failures.length === 0, failures };
  assertPublicEvidence(report);
  return report;
}

export function assertInstalledPerformanceReleaseGate(
  report,
  { requiredEditors = ["vscode", "cursor"], requireLinuxReference = true } = {}
) {
  return assertInstalledPerformanceGate(report, {
    protocol: INSTALLED_PERFORMANCE_REPORT_PROTOCOL,
    verdictKey: "releaseGate",
    candidateBuildMethods: new Set(["guarded-clean-head-v1", "canonical-release-artifact-v1"]),
    requiredEditors,
    requireLinuxReference,
    gateLabel: "release"
  });
}

export function assertInstalledPerformanceEvidenceGate(
  report,
  { requiredEditors = ["vscode", "cursor"], requireLinuxReference = true } = {}
) {
  return assertInstalledPerformanceGate(report, {
    protocol: INSTALLED_PERFORMANCE_EVIDENCE_REPORT_PROTOCOL,
    verdictKey: "evidenceGate",
    candidateBuildMethods: new Set(["performance-evidence-artifact-v1"]),
    requiredEditors,
    requireLinuxReference,
    gateLabel: "evidence"
  });
}

function assertInstalledPerformanceGate(
  report,
  { protocol, verdictKey, candidateBuildMethods, requiredEditors, requireLinuxReference, gateLabel }
) {
  exactKeys(
    report,
    [
      "protocol",
      "generatedAtUtc",
      "candidate",
      "source",
      "fixtureManifest",
      "measurement",
      "limits",
      "editors",
      verdictKey
    ],
    [],
    "installed performance report"
  );
  assertEqual(report.protocol, protocol, "installed performance report protocol");
  canonicalUtcTimestamp(report.generatedAtUtc);
  validateCandidate(report.candidate);
  if (!candidateBuildMethods.has(report.candidate.buildMethod)) {
    throw new TypeError(`Installed performance ${gateLabel} gate received incompatible candidate provenance.`);
  }
  validateSource(report.source);
  if (report.candidate.sourceCommit !== report.source.commit) {
    throw new TypeError("Installed performance candidate does not match its guarded source commit.");
  }
  validateInstalledFixtureManifest(report.fixtureManifest);
  exactKeys(report.measurement, ["boundary", "sampleCountPerCase", "outlierPolicy"], [], "measurement contract");
  assertEqual(report.measurement.boundary, INSTALLED_PERFORMANCE_BOUNDARY, "measurement boundary");
  assertEqual(report.measurement.sampleCountPerCase, INSTALLED_PERFORMANCE_SAMPLE_COUNT, "measurement sample count");
  assertEqual(report.measurement.outlierPolicy, INSTALLED_PERFORMANCE_OUTLIER_POLICY, "outlier policy");
  if (JSON.stringify(report.limits) !== JSON.stringify(INSTALLED_PERFORMANCE_LIMITS)) {
    throw new TypeError("Installed performance limits do not match the release contract.");
  }
  if (!Array.isArray(report.editors) || report.editors.length === 0) {
    throw new TypeError("Installed performance report requires editor results.");
  }
  const keys = report.editors.map((entry) => entry.provenance.editor.key);
  if (new Set(keys).size !== keys.length) throw new TypeError("Installed performance editors must be unique.");
  for (const editor of report.editors) {
    validateProvenance(editor.provenance);
    validateResources(editor.resources);
    validateGroupedResults(editor.results);
  }
  exactKeys(report[verdictKey], ["passed", "failures"], [], `${gateLabel}-gate verdict`);
  const failures = installedPerformanceFailures(report, { requiredEditors, requireLinuxReference });
  const expectedVerdict = { passed: failures.length === 0, failures };
  if (JSON.stringify(report[verdictKey]) !== JSON.stringify(expectedVerdict)) {
    throw new Error(`Installed performance report ${gateLabel} verdict does not match its measurements.`);
  }
  if (failures.length > 0) {
    throw new Error(`Installed performance ${gateLabel} gates failed:\n${failures.join("\n")}`);
  }
  assertPublicEvidence(report);
  return report;
}

export function writeInstalledPerformanceReport(destination, report, hooks = {}) {
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("Installed performance report exceeded its fixed 1 MiB limit.");
  }
  const absolute = resolve(destination);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  assertReplaceableDestination(absolute);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  let temporaryIdentity;
  let published = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    temporaryIdentity = fstatSync(descriptor, { bigint: true });
    if (!temporaryIdentity.isFile() || temporaryIdentity.isSymbolicLink() || temporaryIdentity.nlink !== 1n) {
      throw new Error("Installed performance report temporary lost its file identity.");
    }
    const bytes = Buffer.from(payload, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("Installed performance report publication made no write progress.");
      offset += written;
    }
    fsyncSync(descriptor);
    const completedIdentity = fstatSync(descriptor, { bigint: true });
    requireSameReportIdentity(
      completedIdentity,
      temporaryIdentity,
      "Installed performance report temporary changed while it was written."
    );
    if (completedIdentity.size !== BigInt(bytes.length)) {
      throw new Error("Installed performance report temporary has an invalid byte size.");
    }
    closeSync(descriptor);
    descriptor = undefined;
    hooks.beforePublish?.(temporary);
    const temporaryAtPath = lstatSync(temporary, { bigint: true });
    requireSameReportFile(
      temporaryAtPath,
      completedIdentity,
      "Installed performance report temporary path changed before publication."
    );
    assertReplaceableDestination(absolute);
    renameSync(temporary, absolute);
    const publishedIdentity = lstatSync(absolute, { bigint: true });
    requireSamePublishedReportFile(
      publishedIdentity,
      completedIdentity,
      "Installed performance report destination changed during publication."
    );
    const snapshot = readInstalledPerformanceReportSnapshot(absolute, {
      afterOpen: hooks.afterPublishedOpen
    });
    if (!snapshot.bytes.equals(bytes)) {
      throw new Error("Installed performance report destination bytes changed during publication.");
    }
    const receipt = Object.freeze({
      path: absolute,
      bytes: snapshot.bytes.length,
      sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
      fileIdentity: snapshot.identity
    });
    installedPerformanceReportReceipts.add(receipt);
    published = true;
    return receipt;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published && temporaryIdentity !== undefined) {
      removeIdentifiedReportTemporary(temporary, temporaryIdentity);
    }
  }
}

export function revalidateInstalledPerformanceReport(receipt, hooks = {}) {
  if (!installedPerformanceReportReceipts.has(receipt)) {
    throw new Error("Installed performance report revalidation requires one minted publication receipt.");
  }
  const snapshot = readInstalledPerformanceReportSnapshot(receipt.path, hooks);
  requireSameReportReceipt(
    snapshot.identity,
    receipt.fileIdentity,
    "Installed performance report changed after publication."
  );
  const sha256 = createHash("sha256").update(snapshot.bytes).digest("hex");
  if (snapshot.bytes.length !== receipt.bytes || sha256 !== receipt.sha256) {
    throw new Error("Installed performance report no longer matches its publication receipt.");
  }
  return receipt;
}

function validateCandidate(candidate) {
  exactKeys(
    candidate,
    [
      "extensionId",
      "extensionVersion",
      "preview",
      "channel",
      "buildMethod",
      "releaseTag",
      "provenanceSha256",
      "sourceCommit",
      "vsixSha256",
      "vsixBytes"
    ],
    [],
    "candidate provenance"
  );
  assertEqual(candidate.extensionId, "Matt17BR.openwrangler", "candidate extension ID");
  assertMatch(candidate.extensionVersion, VERSION, "candidate extension version");
  assertBoolean(candidate.preview, "candidate preview flag");
  const classification = classifyNumericReleaseVersion(candidate.extensionVersion);
  if (classification === undefined) {
    throw new TypeError("Candidate extension version must use a numeric major.minor.patch release version.");
  }
  if (candidate.channel !== classification.channel) {
    throw new TypeError("Candidate release channel does not match its numeric release version.");
  }
  if (candidate.preview !== (classification.channel === "preview")) {
    throw new TypeError("Candidate preview flag does not match its numeric release channel.");
  }
  if (!candidate.preview && candidate.extensionVersion.startsWith("0.")) {
    throw new TypeError("A stable installed-performance candidate requires extension version 1.0.0 or newer.");
  }
  if (classification.channel === "preview") {
    assertEqual(candidate.buildMethod, "guarded-clean-head-v1", "candidate build method");
  } else if (
    candidate.buildMethod !== "canonical-release-artifact-v1" &&
    candidate.buildMethod !== "performance-evidence-artifact-v1"
  ) {
    throw new TypeError(
      'candidate build method must be "canonical-release-artifact-v1" or "performance-evidence-artifact-v1".'
    );
  }
  if (classification.channel === "preview") {
    assertEqual(candidate.releaseTag, null, "preview candidate release tag");
    assertEqual(candidate.provenanceSha256, null, "preview candidate provenance SHA-256");
  } else {
    assertEqual(candidate.releaseTag, `v${candidate.extensionVersion}`, "stable candidate release tag");
    assertMatch(candidate.provenanceSha256, SHA256, "stable candidate provenance SHA-256");
  }
  assertMatch(candidate.sourceCommit, /^[0-9a-f]{40}$/u, "candidate source commit");
  assertMatch(candidate.vsixSha256, SHA256, "candidate VSIX SHA-256");
  if (!positiveInteger(candidate.vsixBytes)) throw new TypeError("Candidate VSIX size must be positive.");
}

function validateSource(source) {
  exactKeys(source, ["commit", "trackedWorktreeDirty"], [], "candidate source");
  assertMatch(source.commit, /^[0-9a-f]{40}$/u, "candidate source commit");
  assertBoolean(source.trackedWorktreeDirty, "candidate tracked-worktree state");
}

function validateEditor(editor) {
  exactKeys(editor, ["key", "appName", "productVersion", "vscodeApiVersion"], [], "editor provenance");
  if (!["vscode", "cursor"].includes(editor.key)) {
    throw new TypeError("Installed performance editor must be VS Code or Cursor.");
  }
  assertBoundedString(editor.appName, "editor application name");
  assertMatch(editor.productVersion, VERSION, "editor product version");
  assertMatch(editor.vscodeApiVersion, VERSION, "editor VS Code API version");
}

function validateRuntime(runtime) {
  exactKeys(
    runtime,
    ["pythonVersion", "pythonImplementation", "pythonExecutableSha256", "polarsVersion", "openWranglerRuntimeVersion"],
    [],
    "runtime provenance"
  );
  assertMatch(runtime.pythonVersion, PYTHON_VERSION, "Python version");
  assertBoundedString(runtime.pythonImplementation, "Python implementation");
  assertMatch(runtime.pythonExecutableSha256, SHA256, "Python executable SHA-256");
  assertBoundedString(runtime.polarsVersion, "Polars version");
  assertMatch(runtime.openWranglerRuntimeVersion, VERSION, "Open Wrangler runtime version");
}

function validateProductConfiguration(configuration) {
  exactKeys(
    configuration,
    ["defaultBackend", "fileStartMode", "insightsOnOpen", "fetchBlockSize", "fetchColumnBlockSize"],
    [],
    "shipped product configuration"
  );
  const expected = {
    defaultBackend: "auto",
    fileStartMode: "editing",
    insightsOnOpen: true,
    fetchBlockSize: 200,
    fetchColumnBlockSize: 16
  };
  if (Object.entries(expected).some(([key, value]) => configuration[key] !== value)) {
    throw new TypeError("Installed performance must use the shipped product configuration.");
  }
}

function validatePhaseFixture(fixture) {
  exactKeys(fixture, ["format", "rows", "columns", "sha256"], [], "phase fixture");
  if (!["csv", "parquet"].includes(fixture.format)) {
    throw new TypeError("Installed performance fixture format must be CSV or Parquet.");
  }
  if (!positiveInteger(fixture.rows) || !positiveInteger(fixture.columns)) {
    throw new TypeError("Installed performance fixture shape must be positive.");
  }
  assertMatch(fixture.sha256, SHA256, "phase fixture SHA-256");
}

function validateFirstGridMeasurement(measurement, format) {
  exactKeys(measurement, ["kind", "boundary", "sourceCache", "cacheProofs", "samplesMs"], [], "first-grid measurement");
  assertEqual(measurement.kind, "first-grid", "first-grid measurement kind");
  assertEqual(measurement.boundary, INSTALLED_PERFORMANCE_BOUNDARY, "first-grid measurement boundary");
  if (!["cold", "warm"].includes(measurement.sourceCache)) {
    throw new TypeError("First-grid source cache must be cold or warm.");
  }
  assertDurationSamples(measurement.samplesMs, `${format} ${measurement.sourceCache} first-grid samples`);
  if (!Array.isArray(measurement.cacheProofs) || measurement.cacheProofs.length !== measurement.samplesMs.length) {
    throw new TypeError("Every first-grid sample must retain one aligned source-cache proof.");
  }
  const requestedState = measurement.sourceCache === "cold" ? "evicted" : "resident";
  for (const proof of measurement.cacheProofs) validateCacheProof(proof, requestedState);
}

function validateCacheProof(proof, requestedState) {
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
    [],
    "source-cache proof"
  );
  assertEqual(proof.protocol, INSTALLED_PERFORMANCE_CACHE_PROOF_PROTOCOL, "source-cache proof protocol");
  assertEqual(proof.requestedState, requestedState, "source-cache requested state");
  assertBoolean(proof.fdatasyncApplied, "source-cache fdatasync application");
  assertBoolean(proof.adviceAccepted, "source-cache advice acceptance");
  if (!["linux-mincore", "unavailable"].includes(proof.verification)) {
    throw new TypeError("Source-cache proof verification method is invalid.");
  }
  if (!positiveInteger(proof.pageSizeBytes) || !positiveInteger(proof.totalPages)) {
    throw new TypeError("Source-cache proof page dimensions must be positive integers.");
  }
  for (const [key, value] of [
    ["before", proof.residentPagesBefore],
    ["after", proof.residentPagesAfter]
  ]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > proof.totalPages)) {
      throw new TypeError(`Source-cache resident-pages ${key} count is invalid.`);
    }
  }
  assertBoolean(proof.identityStable, "source-cache identity stability");
  assertBoolean(proof.verified, "source-cache verification");
  if (proof.verification === "unavailable") {
    if (
      proof.residentPagesBefore !== null ||
      proof.residentPagesAfter !== null ||
      proof.fdatasyncApplied ||
      proof.adviceAccepted ||
      proof.verified
    ) {
      throw new TypeError("Unavailable source-cache proof cannot claim cache operations or residency.");
    }
    return;
  }
  if (proof.residentPagesBefore === null || proof.residentPagesAfter === null) {
    throw new TypeError("Linux mincore proof requires both residency counts.");
  }
  if (proof.adviceAccepted !== (requestedState === "evicted")) {
    throw new TypeError("Source-cache advice state does not match the requested preparation.");
  }
  const expectedAfter = requestedState === "evicted" ? 0 : proof.totalPages;
  const semanticallyVerified =
    proof.fdatasyncApplied && proof.identityStable && proof.residentPagesAfter === expectedAfter;
  if (proof.verified !== semanticallyVerified) {
    throw new TypeError("Source-cache verification does not match its retained residency evidence.");
  }
}

function validateGridInteractionMeasurement(measurement) {
  exactKeys(
    measurement,
    ["kind", "cachedSamplesMs", "uncachedSamplesMs", "heartbeatSamplesMs", "filter", "sort", "profiling"],
    [],
    "grid-interaction measurement"
  );
  assertEqual(measurement.kind, "grid-interaction", "grid-interaction measurement kind");
  for (const [key, label] of [
    ["cachedSamplesMs", "cached-grid samples"],
    ["uncachedSamplesMs", "uncached-grid samples"],
    ["heartbeatSamplesMs", "interaction-heartbeat samples"]
  ]) {
    assertDurationSamples(measurement[key], label);
  }
  for (const operation of ["filter", "sort"]) {
    exactKeys(measurement[operation], ["completed", "latencyMs", "responsiveness"], [], `${operation} evidence`);
    assertEqual(measurement[operation].completed, true, `${operation} completion`);
    assertFiniteNonnegative(measurement[operation].latencyMs, `${operation} latency`);
    validateOutstandingResponsiveness(measurement[operation].responsiveness, `${operation} responsiveness`);
  }
  exactKeys(
    measurement.profiling,
    [
      "activeObserved",
      "activeCheckpoint",
      "queuedCheckpoint",
      "cancellationRequested",
      "cancelAcknowledged",
      "originalRequestSettled",
      "originalResponseKind",
      "responsiveness"
    ],
    [],
    "profiling cancellation evidence"
  );
  for (const key of ["activeObserved", "cancellationRequested", "cancelAcknowledged", "originalRequestSettled"]) {
    assertEqual(measurement.profiling[key], true, `profiling ${key}`);
  }
  validateSchedulerCheckpoint(
    measurement.profiling.activeCheckpoint,
    "active",
    "background",
    "getSummary",
    "active profiling scheduler checkpoint"
  );
  validateSchedulerCheckpoint(
    measurement.profiling.queuedCheckpoint,
    "queued",
    "background",
    "getDatasetStats",
    "queued profiling scheduler checkpoint"
  );
  assertEqual(
    measurement.profiling.queuedCheckpoint.sessionId,
    measurement.profiling.activeCheckpoint.sessionId,
    "profiling scheduler checkpoint session"
  );
  if (measurement.profiling.queuedCheckpoint.viewRequestId === measurement.profiling.activeCheckpoint.viewRequestId) {
    throw new TypeError("Profiling scheduler checkpoints must identify distinct requests.");
  }
  assertEqual(measurement.profiling.originalResponseKind, "cancelled", "profiling original response kind");
  validateOutstandingResponsiveness(measurement.profiling.responsiveness, "profiling responsiveness");
}

function validateSchedulerCheckpoint(checkpoint, state, lane, requestKind, label) {
  exactKeys(checkpoint, ["sessionId", "state", "lane", "requestKind", "viewRequestId"], [], label);
  assertBoundedString(checkpoint.sessionId, `${label} session ID`);
  assertEqual(checkpoint.state, state, `${label} state`);
  assertEqual(checkpoint.lane, lane, `${label} lane`);
  assertEqual(checkpoint.requestKind, requestKind, `${label} request kind`);
  assertBoundedString(checkpoint.viewRequestId, `${label} view request ID`);
}

function validateOutstandingResponsiveness(responsiveness, label) {
  exactKeys(
    responsiveness,
    ["outstandingObserved", "rendererHeartbeatMs", "foregroundPageLatencyMs", "foregroundResponseKind"],
    [],
    label
  );
  assertEqual(responsiveness.outstandingObserved, true, `${label} outstanding observation`);
  assertFiniteNonnegative(responsiveness.rendererHeartbeatMs, `${label} renderer heartbeat`);
  assertFiniteNonnegative(responsiveness.foregroundPageLatencyMs, `${label} foreground page latency`);
  assertEqual(responsiveness.foregroundResponseKind, "page", `${label} foreground response kind`);
}

function validateProvenance(provenance) {
  exactKeys(
    provenance,
    ["editor", "runtime", "productConfiguration", "platform", "storage"],
    [],
    "editor-run provenance"
  );
  validateEditor(provenance.editor);
  validateRuntime(provenance.runtime);
  validateProductConfiguration(provenance.productConfiguration);
  exactKeys(
    provenance.platform,
    [
      "operatingSystem",
      "operatingSystemRelease",
      "architecture",
      "cpuModel",
      "logicalCpuCount",
      "totalMemoryBytes",
      "editorDisplayMode"
    ],
    [],
    "platform provenance"
  );
  for (const key of ["operatingSystem", "operatingSystemRelease", "architecture", "cpuModel"]) {
    assertBoundedString(provenance.platform[key], `platform ${key}`);
  }
  if (!positiveInteger(provenance.platform.logicalCpuCount) || !positiveInteger(provenance.platform.totalMemoryBytes)) {
    throw new TypeError("Platform CPU and memory counts must be positive.");
  }
  if (!["headless", "xvfb", "current"].includes(provenance.platform.editorDisplayMode)) {
    throw new TypeError("Platform editor display mode is invalid.");
  }
  exactKeys(
    provenance.storage,
    ["filesystemType", "blockSizeBytes", "deviceModel", "firmwareVersion", "rotational"],
    [],
    "storage provenance"
  );
  assertBoundedString(provenance.storage.filesystemType, "storage filesystem type");
  if (!positiveInteger(provenance.storage.blockSizeBytes)) {
    throw new TypeError("Storage block size must be positive.");
  }
  for (const key of ["deviceModel", "firmwareVersion"]) {
    if (provenance.storage[key] !== null) {
      assertBoundedString(provenance.storage[key], `storage ${key}`);
    }
  }
  if (provenance.storage.rotational !== null) {
    assertBoolean(provenance.storage.rotational, "storage rotational flag");
  }
}

function validateResources(resources) {
  exactKeys(
    resources,
    ["supported", "sampler", "peakEditorTreeRssBytes", "peakPythonRuntimeRssBytes", "samples"],
    [],
    "resource evidence"
  );
  assertBoolean(resources.supported, "resource sampler support");
  assertBoundedString(resources.sampler, "resource sampler");
  for (const key of ["peakEditorTreeRssBytes", "peakPythonRuntimeRssBytes"]) {
    if (resources[key] !== null && !positiveInteger(resources[key])) {
      throw new TypeError(`Resource ${key} must be positive or null.`);
    }
  }
  if (!Array.isArray(resources.samples) || resources.samples.length === 0 || resources.samples.length > 1_024) {
    throw new TypeError("Resource evidence requires between 1 and 1,024 samples.");
  }
  for (const sample of resources.samples) {
    exactKeys(sample, ["stage", "editorTreeRssBytes", "pythonRuntimeRssBytes"], [], "resource sample");
    assertBoundedString(sample.stage, "resource sample stage");
    if (!positiveInteger(sample.editorTreeRssBytes)) {
      throw new TypeError("Editor-tree RSS sample must be positive.");
    }
    if (sample.pythonRuntimeRssBytes !== null && !positiveInteger(sample.pythonRuntimeRssBytes)) {
      throw new TypeError("Python-runtime RSS sample must be positive or null.");
    }
  }
}

function groupEditorPhases(phases) {
  const firstGrid = { csv: {}, parquet: {} };
  let gridInteraction;
  for (const phase of phases) {
    if (phase.measurement.kind === "first-grid") {
      const format = phase.fixture.format;
      const cache = phase.measurement.sourceCache;
      if (firstGrid[format][cache]) {
        throw new TypeError(`Duplicate ${format} ${cache} installed first-grid phase.`);
      }
      firstGrid[format][cache] = {
        cacheProofs: structuredClone(phase.measurement.cacheProofs),
        timing: summarizeInstalledDurationSamples(phase.measurement.samplesMs, `${format} ${cache} first-grid samples`)
      };
      continue;
    }
    if (gridInteraction) throw new TypeError("Duplicate installed grid-interaction phase.");
    gridInteraction = {
      fixtureFormat: phase.fixture.format,
      cached: summarizeInstalledDurationSamples(phase.measurement.cachedSamplesMs, "cached-grid samples"),
      uncached: summarizeInstalledDurationSamples(phase.measurement.uncachedSamplesMs, "uncached-grid samples"),
      heartbeat: summarizeInstalledDurationSamples(
        phase.measurement.heartbeatSamplesMs,
        "interaction-heartbeat samples"
      ),
      filter: structuredClone(phase.measurement.filter),
      sort: structuredClone(phase.measurement.sort),
      profiling: structuredClone(phase.measurement.profiling)
    };
  }
  for (const format of ["csv", "parquet"]) {
    for (const cache of ["cold", "warm"]) {
      if (!firstGrid[format][cache]) throw new TypeError(`Missing ${format} ${cache} installed first-grid phase.`);
    }
  }
  if (!gridInteraction) throw new TypeError("Missing installed grid-interaction phase.");
  return { firstGrid, gridInteraction };
}

function validateGroupedResults(results) {
  exactKeys(results, ["firstGrid", "gridInteraction"], [], "grouped performance results");
  exactKeys(results.firstGrid, ["csv", "parquet"], [], "first-grid formats");
  for (const format of ["csv", "parquet"]) {
    exactKeys(results.firstGrid[format], ["cold", "warm"], [], `${format} first-grid cases`);
    for (const cache of ["cold", "warm"]) {
      const result = results.firstGrid[format][cache];
      exactKeys(result, ["cacheProofs", "timing"], [], `${format} ${cache} first-grid result`);
      validateSummary(result.timing);
      if (!Array.isArray(result.cacheProofs) || result.cacheProofs.length !== result.timing.samplesMs.length) {
        throw new TypeError(`${format} ${cache} result must retain one proof per timing sample.`);
      }
      const requestedState = cache === "cold" ? "evicted" : "resident";
      for (const proof of result.cacheProofs) validateCacheProof(proof, requestedState);
    }
  }
  exactKeys(
    results.gridInteraction,
    ["fixtureFormat", "cached", "uncached", "heartbeat", "filter", "sort", "profiling"],
    [],
    "grid-interaction results"
  );
  if (!["csv", "parquet"].includes(results.gridInteraction.fixtureFormat)) {
    throw new TypeError("Grid-interaction fixture format is invalid.");
  }
  for (const key of ["cached", "uncached", "heartbeat"]) validateSummary(results.gridInteraction[key]);
  validateGridInteractionMeasurement({
    kind: "grid-interaction",
    cachedSamplesMs: results.gridInteraction.cached.samplesMs,
    uncachedSamplesMs: results.gridInteraction.uncached.samplesMs,
    heartbeatSamplesMs: results.gridInteraction.heartbeat.samplesMs,
    filter: results.gridInteraction.filter,
    sort: results.gridInteraction.sort,
    profiling: results.gridInteraction.profiling
  });
}

function validateSummary(summary) {
  exactKeys(
    summary,
    ["count", "samplesMs", "excludedSamples", "outlierPolicy", "minMs", "medianMs", "p95Ms", "maxMs"],
    [],
    "duration summary"
  );
  const expected = summarizeInstalledDurationSamples(summary.samplesMs);
  if (JSON.stringify(summary) !== JSON.stringify(expected)) {
    throw new TypeError("Duration summary does not match its retained samples.");
  }
}

function installedPerformanceFailures(
  report,
  { requiredEditors = ["vscode", "cursor"], requireLinuxReference = true } = {}
) {
  const failures = [];
  if (report.source.trackedWorktreeDirty) {
    failures.push("candidate source worktree has tracked changes");
  }
  const editorKeys = report.editors.map((entry) => entry.provenance.editor.key);
  for (const required of requiredEditors) {
    if (!editorKeys.includes(required)) failures.push(`missing ${required} installed performance evidence`);
  }
  for (const editor of report.editors) {
    const label = editor.provenance.editor.key;
    if (requireLinuxReference && editor.provenance.platform.operatingSystem !== "Linux") {
      failures.push(`${label} did not run on the Linux reference platform`);
    }
    const expectedDisplayMode = label === "cursor" ? "xvfb" : "headless";
    if (requireLinuxReference && editor.provenance.platform.editorDisplayMode !== expectedDisplayMode) {
      failures.push(`${label} did not use the required ${expectedDisplayMode} editor display mode`);
    }
    if (
      requireLinuxReference &&
      (!editor.resources.supported ||
        !positiveInteger(editor.resources.peakEditorTreeRssBytes) ||
        !positiveInteger(editor.resources.peakPythonRuntimeRssBytes))
    ) {
      failures.push(`${label} RSS evidence is incomplete`);
    }
    for (const format of ["csv", "parquet"]) {
      const limit =
        format === "csv"
          ? INSTALLED_PERFORMANCE_LIMITS.csvFirstUsableGridP95Ms
          : INSTALLED_PERFORMANCE_LIMITS.parquetFirstUsableGridP95Ms;
      for (const cache of ["cold", "warm"]) {
        const result = editor.results.firstGrid[format][cache];
        const actual = result.timing.p95Ms;
        if (!(actual < limit)) failures.push(`${label} ${format} ${cache} first-grid p95 ${actual}ms >= ${limit}ms`);
        if (result.cacheProofs.some((proof) => !proof.verified)) {
          failures.push(`${label} ${format} ${cache} source-cache residency was not proven for every sample`);
        }
      }
    }
    const interaction = editor.results.gridInteraction;
    for (const [name, actual, limit] of [
      ["cached grid", interaction.cached.p95Ms, INSTALLED_PERFORMANCE_LIMITS.cachedGridP95Ms],
      ["uncached grid", interaction.uncached.p95Ms, INSTALLED_PERFORMANCE_LIMITS.uncachedGridP95Ms],
      ["interaction heartbeat", interaction.heartbeat.p95Ms, INSTALLED_PERFORMANCE_LIMITS.interactionHeartbeatP95Ms]
    ]) {
      if (!(actual < limit)) failures.push(`${label} ${name} p95 ${actual}ms >= ${limit}ms`);
    }
    if (!interaction.filter.completed) failures.push(`${label} filter did not complete`);
    if (!interaction.sort.completed) failures.push(`${label} sort did not complete`);
    if (
      !interaction.profiling.activeObserved ||
      interaction.profiling.activeCheckpoint.state !== "active" ||
      interaction.profiling.activeCheckpoint.lane !== "background" ||
      interaction.profiling.activeCheckpoint.requestKind !== "getSummary" ||
      interaction.profiling.queuedCheckpoint.state !== "queued" ||
      interaction.profiling.queuedCheckpoint.lane !== "background" ||
      interaction.profiling.queuedCheckpoint.requestKind !== "getDatasetStats" ||
      !interaction.profiling.cancellationRequested ||
      !interaction.profiling.cancelAcknowledged ||
      !interaction.profiling.originalRequestSettled ||
      interaction.profiling.originalResponseKind !== "cancelled"
    ) {
      failures.push(`${label} did not prove authoritative profile cancellation`);
    }
    for (const [operation, responsiveness] of [
      ["filter", interaction.filter.responsiveness],
      ["sort", interaction.sort.responsiveness],
      ["profiling", interaction.profiling.responsiveness]
    ]) {
      if (!responsiveness.outstandingObserved || responsiveness.foregroundResponseKind !== "page") {
        failures.push(`${label} ${operation} did not prove concurrent renderer and foreground responsiveness`);
      }
      if (!(responsiveness.rendererHeartbeatMs < INSTALLED_PERFORMANCE_LIMITS.outstandingRendererHeartbeatMs)) {
        failures.push(
          `${label} ${operation} outstanding renderer heartbeat ${responsiveness.rendererHeartbeatMs}ms >= ${INSTALLED_PERFORMANCE_LIMITS.outstandingRendererHeartbeatMs}ms`
        );
      }
      if (!(responsiveness.foregroundPageLatencyMs < INSTALLED_PERFORMANCE_LIMITS.outstandingForegroundPageMs)) {
        failures.push(
          `${label} ${operation} outstanding foreground page ${responsiveness.foregroundPageLatencyMs}ms >= ${INSTALLED_PERFORMANCE_LIMITS.outstandingForegroundPageMs}ms`
        );
      }
    }
  }
  return failures;
}

function assertDurationSamples(samples, label) {
  if (!Array.isArray(samples) || samples.length < INSTALLED_PERFORMANCE_SAMPLE_COUNT || samples.length > 1_000) {
    throw new TypeError(`${label} must retain between ${INSTALLED_PERFORMANCE_SAMPLE_COUNT} and 1,000 samples.`);
  }
  for (const sample of samples) assertFiniteNonnegative(sample, label);
}

function median(ordered) {
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function nearestRank(ordered, percentile) {
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)];
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const keys = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} has missing or unknown fields.`);
  }
}

function assertFiniteNonnegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must contain finite non-negative milliseconds.`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
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

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalUtcTimestamp(value) {
  assertBoundedString(value, "report timestamp");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError("Installed performance timestamp must be a canonical UTC ISO string.");
  }
  return value;
}

function assertPublicEvidence(value, key = "") {
  if (Array.isArray(value)) {
    for (const entry of value) assertPublicEvidence(entry, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      if (
        /(?:^|_)(?:path|uri|cwd|home|workspace|profile|commandLine|sourceLabel|schema|cellValues?)(?:$|_)/iu.test(
          childKey
        )
      ) {
        throw new TypeError(`Installed performance evidence cannot contain private field ${childKey}.`);
      }
      assertPublicEvidence(child, childKey);
    }
    return;
  }
  if (
    typeof value === "string" &&
    (/\bfile:\/\//iu.test(value) ||
      /(?:^|[\s"'(])\/(?:home|Users|tmp|run|private|var\/folders)\//u.test(value) ||
      /(?:^|[\s"'(])[A-Za-z]:\\/u.test(value))
  ) {
    throw new TypeError(`Installed performance evidence field ${key} contains a private path.`);
  }
}

function assertReplaceableDestination(destination) {
  try {
    const metadata = lstatSync(destination, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
      throw new Error("Installed performance report destination must be a single-link regular file.");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function readInstalledPerformanceReportSnapshot(destination, hooks = {}) {
  let descriptor;
  try {
    descriptor = openSync(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(destination, { bigint: true });
    requireSameReportFile(
      namedBefore,
      opened,
      "Installed performance report path changed before its descriptor snapshot."
    );
    if (opened.size <= 0n || opened.size > BigInt(MAX_REPORT_BYTES)) {
      throw new Error("Installed performance report descriptor snapshot has an invalid byte size.");
    }
    hooks.afterOpen?.(destination);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) {
        throw new Error("Installed performance report ended before its pinned byte size.");
      }
      offset += count;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(destination, { bigint: true });
    requireSameReportFile(
      completed,
      opened,
      "Installed performance report changed while its descriptor snapshot was read."
    );
    requireSameReportFile(
      namedAfter,
      opened,
      "Installed performance report path changed while its descriptor snapshot was read."
    );
    return Object.freeze({
      bytes,
      identity: Object.freeze(reportIdentityReceipt(completed))
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireSameReportIdentity(actual, expected, message) {
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1n ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error(message);
  }
}

function reportIdentityReceipt(metadata) {
  return {
    birthtimeNs: metadata.birthtimeNs,
    ctimeNs: metadata.ctimeNs,
    dev: metadata.dev,
    gid: metadata.gid,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    size: metadata.size,
    uid: metadata.uid
  };
}

function requireSameReportReceipt(actual, expected, message) {
  for (const key of ["birthtimeNs", "ctimeNs", "dev", "gid", "ino", "mode", "mtimeNs", "size", "uid"]) {
    if (typeof expected?.[key] !== "bigint" || actual[key] !== expected[key]) {
      throw new Error(message);
    }
  }
}

function requireSameReportFile(actual, expected, message) {
  requireSameReportIdentity(actual, expected, message);
  if (actual.size !== expected.size || actual.mtimeNs !== expected.mtimeNs || actual.ctimeNs !== expected.ctimeNs) {
    throw new Error(message);
  }
}

function requireSamePublishedReportFile(actual, expected, message) {
  requireSameReportIdentity(actual, expected, message);
  if (actual.size !== expected.size || actual.mtimeNs !== expected.mtimeNs) {
    throw new Error(message);
  }
}

function removeIdentifiedReportTemporary(temporary, identity) {
  try {
    const current = lstatSync(temporary, { bigint: true });
    requireSameReportIdentity(
      current,
      identity,
      "Installed performance report temporary cleanup was withheld after an identity change."
    );
    rmSync(temporary);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
