import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { runDataWranglerComparisonStudyV2CacheController } from "./data-wrangler-comparison-cache-controller.mjs";
import { runDataWranglerComparisonNeutralDriverPhase } from "./data-wrangler-comparison-driver.mjs";
import { writeDataWranglerComparisonNotebook } from "./data-wrangler-comparison-notebook.mjs";
import {
  createEmptyStudyMilestones,
  createStudyFragmentIdentity,
  digestStudyValue,
  inspectDataWranglerStudyTrialIntents,
  loadDataWranglerStudyFragments,
  readDataWranglerStudyManifestPublication,
  validateDataWranglerComparisonCacheBinding,
  validateDataWranglerComparisonSourceCopyBinding,
  validateDataWranglerStudyFragment
} from "./data-wrangler-comparison-study.mjs";
import {
  executeDataWranglerComparisonTrial,
  validateDataWranglerComparisonTrialExecutorReceipt
} from "./data-wrangler-comparison-trial-executor.mjs";
import {
  normalizeDataWranglerComparisonPostLaunchSetupFailureFragment,
  normalizeDataWranglerComparisonPreActionProcessProofFailureFragment,
  normalizeDataWranglerComparisonPreNotebookFailureFragment,
  normalizeDataWranglerComparisonTrialFragment
} from "./data-wrangler-comparison-trial-fragment.mjs";
import { runEditorAcceptancePhase } from "./editor-acceptance.mjs";
import { runLinuxDataWranglerStudyGate } from "./linux-data-wrangler-study-gate.mjs";
import { readLinuxProcessIdentity } from "./linux-study-supervisor-client.mjs";
import { runNextDataWranglerComparisonStudyTrial } from "./run-data-wrangler-comparison-study.mjs";
import { withHeavyLocalCommandLease } from "./run-heavy-local-command.mjs";
import {
  assertDataWranglerComparisonSourceCopy,
  cleanupDataWranglerComparisonSourceCopy,
  createDataWranglerComparisonSourceCopy
} from "./data-wrangler-comparison-source-copy.mjs";

export const DATA_WRANGLER_COMPARISON_LIVE_TRIAL_PROTOCOL = "openwrangler-data-wrangler-comparison-live-trial-v1";

const PHASE_BY_PRODUCT = Object.freeze({
  "open-wrangler": "comparison-study-open-wrangler-trial",
  "data-wrangler": "comparison-study-data-wrangler-trial"
});
const SHA256 = /^[0-9a-f]{64}$/u;
const CLEANUP_INTERVAL_MS = 200;
const CLEANUP_DEADLINE_MS = 10_000;
const MAXIMUM_CLEANUP_OBSERVATIONS = CLEANUP_DEADLINE_MS / CLEANUP_INTERVAL_MS + 1;
const OWNED_EDITOR_FIELDS = new Set([
  "workspace",
  "phase",
  "resultPath",
  "comparisonStudyEnvironment",
  "runId",
  "developmentPaths"
]);

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  return value;
}

function exactKeys(value, expected, label, optional = []) {
  requireRecord(value, label);
  const allowed = new Set([...expected, ...optional]);
  const actual = Object.keys(value);
  if (expected.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !allowed.has(key))) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/u.test(value)) {
    fail(`${label} must be one canonical absolute single-line path.`);
  }
  return value;
}

function validateKernel(value) {
  exactKeys(value, ["name", "displayName"], "Prepared trial kernel");
  if (
    typeof value.name !== "string" ||
    !/^openwrangler-study-[a-z0-9][a-z0-9._-]{0,95}$/u.test(value.name) ||
    typeof value.displayName !== "string" ||
    value.displayName.length === 0 ||
    value.displayName.length > 128 ||
    /[\0\r\n/\\]/u.test(value.displayName)
  ) {
    fail("Prepared trial kernel identity is invalid.");
  }
  return value;
}

function validatePreparedTrial(value) {
  exactKeys(
    value,
    [
      "scheduleEntryId",
      "sourcePath",
      "notebookPath",
      "requestPath",
      "acknowledgementPath",
      "selectedKernel",
      "publicSurfaceAvailability",
      "editorPhaseOptions",
      "supervisorOptions",
      "processEvidenceOptions",
      "sourceCopy",
      "sourceCache",
      "neutralDriver"
    ],
    "Prepared comparison trial",
    ["samplerOptions"]
  );
  if (typeof value.scheduleEntryId !== "string" || value.scheduleEntryId.length === 0) {
    fail("Prepared comparison trial schedule entry is invalid.");
  }
  for (const [path, label] of [
    [value.sourcePath, "Prepared trial source"],
    [value.notebookPath, "Prepared trial notebook"],
    [value.requestPath, "Prepared trial bridge request"],
    [value.acknowledgementPath, "Prepared trial bridge acknowledgement"]
  ]) {
    absolutePath(path, label);
  }
  const privatePaths = [value.sourcePath, value.notebookPath, value.requestPath, value.acknowledgementPath];
  const resultPath = `${value.notebookPath}.result.json`;
  if (new Set(privatePaths).size !== privatePaths.length || privatePaths.includes(resultPath)) {
    fail("Prepared trial source, notebook, result, and bridge paths must be distinct.");
  }
  validateKernel(requireRecord(value.selectedKernel, "Prepared trial kernel"));
  if (!["available", "undetermined"].includes(value.publicSurfaceAvailability)) {
    fail("Prepared trial public surface availability is invalid.");
  }
  const editorPhaseOptions = requireRecord(value.editorPhaseOptions, "Prepared editor phase options");
  for (const field of OWNED_EDITOR_FIELDS) {
    if (Object.hasOwn(editorPhaseOptions, field)) {
      fail(`Prepared editor phase options cannot override ${field}.`);
    }
  }
  requireRecord(value.supervisorOptions, "Prepared supervisor options");
  requireRecord(value.processEvidenceOptions, "Prepared process-evidence options");
  if (value.samplerOptions !== undefined) requireRecord(value.samplerOptions, "Prepared sampler options");
  const sourceCopy = requireRecord(value.sourceCopy, "Prepared source-copy options");
  exactKeys(sourceCopy, ["privateRoot", "name"], "Prepared source-copy options");
  absolutePath(sourceCopy.privateRoot, "Prepared source-copy private root");
  if (
    typeof sourceCopy.name !== "string" ||
    sourceCopy.name.length === 0 ||
    sourceCopy.name.length > 128 ||
    sourceCopy.name === "." ||
    sourceCopy.name === ".." ||
    /[\0\r\n/\\]/u.test(sourceCopy.name)
  ) {
    fail("Prepared source-copy name is invalid.");
  }
  const sourceCache = requireRecord(value.sourceCache, "Prepared source-cache options");
  exactKeys(sourceCache, ["pythonExecutablePath", "controlScriptPath"], "Prepared source-cache options");
  absolutePath(sourceCache.pythonExecutablePath, "Prepared source-cache Python");
  absolutePath(sourceCache.controlScriptPath, "Prepared source-cache controller");
  const neutralDriver = requireRecord(value.neutralDriver, "Prepared neutral-driver options");
  exactKeys(
    neutralDriver,
    ["receipt", "expectedExtensions", "expectedTemplate", "profile"],
    "Prepared neutral-driver options",
    ["prevalidated"]
  );
  requireRecord(neutralDriver.receipt, "Prepared neutral-driver receipt");
  if (neutralDriver.prevalidated !== undefined) {
    const prevalidatedDriver = requireRecord(neutralDriver.prevalidated, "Prepared prevalidated neutral-driver state");
    exactKeys(prevalidatedDriver, ["driver", "installedExtensions"], "Prepared prevalidated neutral-driver state");
    requireRecord(prevalidatedDriver.driver, "Prepared prevalidated driver receipt");
    if (!Array.isArray(prevalidatedDriver.installedExtensions)) {
      fail("Prepared prevalidated extension inventory must be an array.");
    }
  }
  if (!Array.isArray(neutralDriver.expectedExtensions)) {
    fail("Prepared neutral-driver extension inventory must be an array.");
  }
  const expectedTemplate = requireRecord(neutralDriver.expectedTemplate, "Prepared neutral-driver template");
  exactKeys(expectedTemplate, ["kind", "receiptSha256"], "Prepared neutral-driver template");
  if (
    (expectedTemplate.kind !== "configured-only" && expectedTemplate.kind !== "warmed") ||
    typeof expectedTemplate.receiptSha256 !== "string" ||
    !SHA256.test(expectedTemplate.receiptSha256)
  ) {
    fail("Prepared neutral-driver template is invalid.");
  }
  requireRecord(neutralDriver.profile, "Prepared neutral-driver profile");
  if (neutralDriver.profile.privateRoot !== sourceCopy.privateRoot) {
    fail("Prepared source-copy and neutral-driver roots must be the same private trial root.");
  }
  return value;
}

function validateInput(value) {
  exactKeys(
    value,
    ["manifestPath", "fragmentsDirectory", "intentsDirectory", "expectedProvenance", "preparedTrial"],
    "Live comparison trial input"
  );
  for (const [path, label] of [
    [value.manifestPath, "Study manifest"],
    [value.fragmentsDirectory, "Study fragment directory"],
    [value.intentsDirectory, "Study intent directory"]
  ]) {
    absolutePath(path, label);
  }
  requireRecord(value.expectedProvenance, "Expected Linux gate provenance");
  const prepared = validatePreparedTrial(requireRecord(value.preparedTrial, "Prepared comparison trial"));
  const sourceCopyPath = resolve(prepared.sourceCopy.privateRoot, prepared.sourceCopy.name);
  const writtenPaths = [
    sourceCopyPath,
    prepared.notebookPath,
    `${prepared.notebookPath}.result.json`,
    prepared.requestPath,
    prepared.acknowledgementPath
  ];
  const protectedPaths = [
    value.manifestPath,
    value.fragmentsDirectory,
    value.intentsDirectory,
    prepared.sourcePath,
    prepared.sourceCache.pythonExecutablePath,
    prepared.sourceCache.controlScriptPath
  ];
  if (
    new Set(writtenPaths).size !== writtenPaths.length ||
    writtenPaths.some((path) => protectedPaths.includes(path))
  ) {
    fail("Prepared trial writable paths cannot alias study, source, or runtime inputs.");
  }
  return value;
}

function fixtureForEntry(manifest, scheduleEntry) {
  const fixture = manifest.fixtures.find((candidate) => candidate.format === scheduleEntry.format);
  if (fixture === undefined) fail("The prepared trial has no manifest fixture.");
  return fixture;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function gateFailureFragment({ manifest, scheduleEntry, executionIndex, environmentGate, fragmentId, recordedAtUtc }) {
  return {
    ...createStudyFragmentIdentity({
      manifest,
      scheduleEntry,
      executionIndex,
      attempt: scheduleEntry.attempt,
      recordedAtUtc
    }),
    fragmentId,
    outcome: {
      status: "pre-action-invalid",
      reasonClass: "setup",
      actionStarted: false,
      correctness: "not-reached",
      timeout: null,
      unsupported: null
    },
    milestones: createEmptyStudyMilestones(),
    sourceCopy: null,
    cacheProof: null,
    sourceLoad: {
      status: "not-reached",
      durationMs: null,
      includedInInlineTiming: scheduleEntry.kind === "cold"
    },
    engineEvidence: null,
    environmentGate: structuredClone(environmentGate),
    uiEvidence: null,
    processProofs: null,
    resourceObservation: null,
    cleanupProof: null,
    trialProvenance: null
  };
}

function observedNotebookSource(value, label) {
  const observed = requireRecord(value, label);
  exactKeys(observed, ["file", "semanticClass", "rowCount", "columnCount", "schema", "sentinels"], label);
  const file = requireRecord(observed.file, `${label} file`);
  exactKeys(file, ["sha256", "filesystemIdentity"], `${label} file`);
  requireRecord(file.filesystemIdentity, `${label} filesystem identity`);
  if (
    typeof file.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(file.sha256) ||
    observed.semanticClass !== "dataframe" ||
    !Number.isSafeInteger(observed.rowCount) ||
    observed.rowCount < 1 ||
    !Number.isSafeInteger(observed.columnCount) ||
    observed.columnCount < 2 ||
    !Array.isArray(observed.schema) ||
    observed.schema.length !== observed.columnCount ||
    !Array.isArray(observed.sentinels) ||
    observed.sentinels.length !== 3
  ) {
    fail(`${label} is incomplete or malformed.`);
  }
  return observed;
}

function sourceVerificationReceipt(phaseReceipt, scheduleEntry, sourceCopy) {
  const phase = requireRecord(phaseReceipt, "Measured notebook phase receipt");
  const study = requireRecord(phase.study, "Measured notebook study");
  const fixture = requireRecord(study.fixture, "Measured notebook fixture");
  const notebookSourceReceipt = requireRecord(study.sourceReceipt, "Measured notebook source receipt");
  const verification = requireRecord(phase.verification, "Measured notebook verification");
  exactKeys(verification, ["before", "after"], "Measured notebook verification");
  const beforeReceipt = requireRecord(verification.before, "Measured notebook verification before action");
  const before = observedNotebookSource(beforeReceipt.observedSource, "Measured notebook source before action");
  const after =
    verification.after === null
      ? null
      : observedNotebookSource(
          requireRecord(verification.after, "Measured notebook verification after trial").observedSource,
          "Measured notebook source after trial"
        );
  const copyReceipt = requireRecord(sourceCopy.copyReceipt, "Measured terminal source-copy receipt");
  if (
    study.engine !== scheduleEntry.engine ||
    fixture.id !== (scheduleEntry.format === "csv" ? "csv-100k-50" : "parquet-1m-20") ||
    before.file.sha256 !== fixture.sha256 ||
    before.rowCount !== fixture.rows ||
    before.columnCount !== fixture.columns ||
    !sameValue(notebookSourceReceipt, copyReceipt) ||
    !sameValue(before.file, copyReceipt) ||
    (after !== null && !sameValue(after, before)) ||
    sourceCopy.verifiedAfterProcessTreeEmpty !== true
  ) {
    fail("Measured notebook source verification does not match its engine-observed source copy.");
  }
  return {
    engine: scheduleEntry.engine,
    fixtureId: fixture.id,
    fixtureSha256: before.file.sha256,
    semanticClass: before.semanticClass,
    rowCount: before.rowCount,
    columnCount: before.columnCount,
    schema: structuredClone(before.schema),
    sentinelsBefore: structuredClone(before.sentinels),
    sentinelsAfter: after === null ? null : structuredClone(after.sentinels),
    filesystemIdentityBefore: structuredClone(before.file.filesystemIdentity),
    filesystemIdentityAfter: after === null ? null : structuredClone(copyReceipt.filesystemIdentity),
    observedBeforeAction: true,
    observedAfterTrial: after === null ? "not-reached" : "verified"
  };
}

function validateRawEvidence(rawValue, context, phase, validateExecutorReceipt) {
  const raw = validateExecutorReceipt(requireRecord(rawValue, "Raw measured-trial evidence"));
  if (
    raw.protocol !== "openwrangler-data-wrangler-comparison-trial-executor-v1" ||
    !["evidence", "pre-notebook-failure", "post-launch-setup-failure", "pre-action-process-proof-failure"].includes(
      raw.status
    ) ||
    raw.runId !== context.preparedIntent.runId ||
    raw.phase !== phase ||
    raw.cacheState !== context.scheduleEntry.kind ||
    raw.product !== context.scheduleEntry.product ||
    typeof raw.actionAuthorized !== "boolean"
  ) {
    fail("Raw measured-trial evidence is stale or does not match the prepared ledger entry.");
  }
  if ((raw.status === "evidence") !== (raw.notebookPhaseReceipt !== null)) {
    fail("Raw measured-trial evidence does not match its notebook receipt state.");
  }
  if (raw.launchReceipt === null || raw.supervisorCompletion === null) {
    fail("A launched measured trial omitted launch or terminal supervisor evidence.");
  }
  if (raw.status === "post-launch-setup-failure") {
    if (
      raw.controlReceipt !== null ||
      raw.actionAuthorized ||
      raw.authorizationAttempted ||
      raw.authorizationOutcome !== "not-attempted" ||
      !isRecord(raw.processProofs?.editorRoot) ||
      raw.processProofs.configuredKernel !== null ||
      raw.processProofs.openWranglerRuntime !== null
    ) {
      fail("Post-launch setup failure evidence is contradictory.");
    }
  } else if (raw.status === "pre-action-process-proof-failure") {
    if (
      raw.actionAuthorized ||
      raw.authorizationAttempted ||
      raw.authorizationOutcome !== "not-attempted" ||
      !isRecord(raw.processProofs?.editorRoot) ||
      raw.processProofs.configuredKernel !== null ||
      raw.processProofs.openWranglerRuntime !== null ||
      (raw.controlReceipt !== null &&
        (raw.controlReceipt?.status !== "failed" || raw.controlReceipt?.authorization !== null))
    ) {
      fail("Pre-action process-proof failure evidence is contradictory.");
    }
  } else if (raw.controlReceipt === null) {
    fail("A controlled measured trial omitted its control receipt.");
  }
  if (
    !isRecord(raw.terminalEvidence) ||
    !isRecord(raw.terminalEvidence.cleanupProof) ||
    !isRecord(raw.terminalEvidence.trialProvenance)
  ) {
    fail("A launched measured trial omitted cleanup or post-cleanup provenance evidence.");
  }
  return raw;
}

export function reinspectDataWranglerComparisonActionAuthorization(
  { manifestPath, fragmentsDirectory, intentsDirectory, manifest, preparedIntent },
  {
    readManifest = readDataWranglerStudyManifestPublication,
    loadFragments = loadDataWranglerStudyFragments,
    inspectIntents = inspectDataWranglerStudyTrialIntents,
    manifestReadOptions = {},
    fragmentReadOptions = {},
    intentReadOptions = {}
  } = {}
) {
  for (const [path, label] of [
    [manifestPath, "Authorization reinspection manifest"],
    [fragmentsDirectory, "Authorization reinspection fragment directory"],
    [intentsDirectory, "Authorization reinspection intent directory"]
  ]) {
    absolutePath(path, label);
  }
  requireRecord(manifest, "Authorization reinspection manifest value");
  const prepared = requireRecord(preparedIntent, "Authorization reinspection prepared intent");
  for (const [dependency, label] of [
    [readManifest, "manifest reader"],
    [loadFragments, "fragment reader"],
    [inspectIntents, "intent inspector"]
  ]) {
    if (typeof dependency !== "function") fail(`Authorization reinspection ${label} must be a function.`);
  }
  const currentManifest = readManifest(manifestPath, manifestReadOptions);
  if (
    !isRecord(currentManifest) ||
    digestStudyValue(currentManifest) !== digestStudyValue(manifest) ||
    prepared.manifestSha256 !== digestStudyValue(manifest)
  ) {
    fail("Authorization reinspection found a changed study manifest.");
  }
  const fragments = loadFragments(fragmentsDirectory, currentManifest, fragmentReadOptions);
  if (!Array.isArray(fragments) || fragments.length !== prepared.executionIndex) {
    fail("Authorization reinspection found a changed fragment ledger.");
  }
  const inspection = inspectIntents({
    directory: intentsDirectory,
    manifest: currentManifest,
    fragments,
    options: intentReadOptions
  });
  if (!isRecord(inspection) || !Array.isArray(inspection.unresolved)) {
    fail("Authorization reinspection returned a malformed intent journal result.");
  }
  const matching = inspection.unresolved.filter((intent) => intent?.runId === prepared.runId);
  if (matching.length === 0) {
    if (inspection.unresolved.length !== 0) {
      fail("Authorization reinspection found another unresolved product action.");
    }
    return Object.freeze({ status: "not-authorized" });
  }
  if (matching.length !== 1 || inspection.unresolved.length !== 1) {
    fail("Authorization reinspection found ambiguous product-action records.");
  }
  const intent = matching[0];
  if (
    intent.stage !== "action-authorized" ||
    intent.manifestSha256 !== prepared.manifestSha256 ||
    intent.executionIndex !== prepared.executionIndex ||
    intent.scheduleEntryId !== prepared.scheduleEntryId ||
    intent.attempt !== prepared.attempt ||
    intent.effectiveBlockId !== prepared.effectiveBlockId ||
    intent.product !== prepared.product ||
    intent.ledgerSha256 !== prepared.ledgerSha256 ||
    intent.preparedSha256 !== digestStudyValue(prepared)
  ) {
    fail("Authorization reinspection found a mismatched product-action record.");
  }
  return Object.freeze({
    status: "authorized",
    authorization: Object.freeze({
      intent: Object.freeze(structuredClone(intent)),
      publication: Object.freeze({ status: "recovered", sha256: digestStudyValue(intent) })
    })
  });
}

function cleanupIdentityUnion(raw) {
  const resourceObservation = raw.controlReceipt?.resourceObservation;
  const sampled = isRecord(resourceObservation)
    ? resourceObservation.retainedOwnedIdentities
    : [
        raw.processProofs?.editorRoot,
        raw.processProofs?.configuredKernel,
        raw.processProofs?.openWranglerRuntime
      ].filter((identity) => isRecord(identity) && identity.pid !== null && identity.pid !== undefined);
  const terminal = requireRecord(
    raw.supervisorCompletion?.terminalReceipt,
    "Measured trial supervisor terminal receipt"
  ).retainedOwnedIdentities;
  if (!Array.isArray(sampled) || !Array.isArray(terminal)) {
    fail("Measured trial cleanup identities are missing.");
  }
  const identities = new Map();
  for (const value of [...sampled, ...terminal]) {
    const identity = requireRecord(value, "Measured trial cleanup identity");
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid < 1 ||
      typeof identity.startTimeTicks !== "string" ||
      !/^\d+$/u.test(identity.startTimeTicks)
    ) {
      fail("Measured trial cleanup identity is invalid.");
    }
    identities.set(`${identity.pid}:${identity.startTimeTicks}`, {
      pid: identity.pid,
      startTimeTicks: identity.startTimeTicks
    });
  }
  if (identities.size === 0 || identities.size > 4_096) {
    fail("Measured trial cleanup identity set is empty or too large.");
  }
  return [...identities.values()].sort(
    (left, right) =>
      left.pid - right.pid ||
      (BigInt(left.startTimeTicks) < BigInt(right.startTimeTicks)
        ? -1
        : BigInt(left.startTimeTicks) > BigInt(right.startTimeTicks)
          ? 1
          : 0)
  );
}

function observedOwnedIdentities(identities, readProcessIdentity) {
  const observed = [];
  for (const expected of identities) {
    const current = readProcessIdentity(expected.pid);
    if (current === null) continue;
    if (!isRecord(current) || current.startTimeTicks !== expected.startTimeTicks) {
      fail(`Measured trial cleanup detected PID reuse for ${expected.pid}.`);
    }
    observed.push(structuredClone(expected));
  }
  return observed;
}

/**
 * Confirm that every process retained by the sampler or supervisor is absent.
 * The supervisor has already completed when this runs. Two real polls are kept
 * so a single empty read cannot authorize publication.
 */
export async function collectDataWranglerComparisonCleanupProof(
  rawValue,
  {
    readProcessIdentity = readLinuxProcessIdentity,
    monotonicMilliseconds = () => performance.now(),
    wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
  } = {}
) {
  const raw = requireRecord(rawValue, "Measured trial executor receipt");
  if (
    typeof readProcessIdentity !== "function" ||
    typeof monotonicMilliseconds !== "function" ||
    typeof wait !== "function"
  ) {
    fail("Measured trial cleanup dependencies must be functions.");
  }
  const processProofs = requireRecord(raw.processProofs, "Measured trial process proofs");
  const editorRoot = requireRecord(processProofs.editorRoot, "Measured trial editor-root identity");
  if (
    !Number.isSafeInteger(editorRoot.pid) ||
    editorRoot.pid < 1 ||
    typeof editorRoot.startTimeTicks !== "string" ||
    !/^\d+$/u.test(editorRoot.startTimeTicks)
  ) {
    fail("Measured trial editor-root identity is invalid.");
  }
  const terminalReceipt = requireRecord(
    raw.supervisorCompletion?.terminalReceipt,
    "Measured trial supervisor terminal receipt"
  );
  const launchReceipt = requireRecord(raw.launchReceipt, "Measured trial supervisor launch receipt");
  const retainedOwnedIdentities = cleanupIdentityUnion(raw);
  const startedAt = monotonicMilliseconds();
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    fail("Measured trial cleanup clock is invalid.");
  }
  const observations = [];
  let consecutiveEmpty = 0;
  let observedEmpty = false;
  for (let sequence = 0; sequence < MAXIMUM_CLEANUP_OBSERVATIONS; sequence += 1) {
    if (sequence > 0) {
      const target = startedAt + sequence * CLEANUP_INTERVAL_MS;
      const remaining = target - monotonicMilliseconds();
      if (!Number.isFinite(remaining)) fail("Measured trial cleanup clock is invalid.");
      if (remaining > 0) await wait(remaining);
    }
    const elapsedMs = monotonicMilliseconds() - startedAt;
    if (
      !Number.isFinite(elapsedMs) ||
      elapsedMs < 0 ||
      elapsedMs > CLEANUP_DEADLINE_MS ||
      (sequence === 0 && elapsedMs > CLEANUP_INTERVAL_MS) ||
      (sequence > 0 &&
        (elapsedMs <= observations.at(-1).elapsedMs ||
          elapsedMs - observations.at(-1).elapsedMs < CLEANUP_INTERVAL_MS / 2 ||
          elapsedMs - observations.at(-1).elapsedMs >= CLEANUP_INTERVAL_MS * 2))
    ) {
      fail("Measured trial cleanup polling missed its bounded cadence.");
    }
    const processes = observedOwnedIdentities(retainedOwnedIdentities, readProcessIdentity);
    if (observedEmpty && processes.length !== 0) {
      fail("Measured trial cleanup contradicted an earlier empty process-tree observation.");
    }
    observations.push({ sequence, elapsedMs, processes });
    consecutiveEmpty = processes.length === 0 ? consecutiveEmpty + 1 : 0;
    observedEmpty ||= processes.length === 0;
    if (consecutiveEmpty === 2) {
      return Object.freeze({
        editorRootPid: editorRoot.pid,
        editorRootStartTimeTicks: editorRoot.startTimeTicks,
        startedAfterTrial: true,
        intervalMs: CLEANUP_INTERVAL_MS,
        deadlineMs: CLEANUP_DEADLINE_MS,
        retainedOwnedIdentities,
        ...(isRecord(raw.controlReceipt?.resourceObservation)
          ? {}
          : { supervisorLaunchReceipt: structuredClone(launchReceipt) }),
        supervisorTerminalReceipt: structuredClone(terminalReceipt),
        observations,
        treeEmpty: true,
        status: "complete",
        failure: null
      });
    }
  }
  fail("Measured trial process tree did not remain empty before the cleanup deadline.");
}

export async function completeDataWranglerComparisonTrialEvidence(
  value,
  {
    revalidateTrialProvenanceAfter,
    cleanupDependencies = {},
    assertSourceCopy = assertDataWranglerComparisonSourceCopy,
    cleanupSourceCopy = cleanupDataWranglerComparisonSourceCopy
  } = {}
) {
  const input = requireRecord(value, "Measured trial completion input");
  exactKeys(
    input,
    [
      "protocol",
      "manifest",
      "scheduleEntry",
      "preparedIntent",
      "environmentGate",
      "provenanceBefore",
      "neutralDriverEvidence",
      "sourceCopy",
      "rawEvidence"
    ],
    "Measured trial completion input"
  );
  if (input.protocol !== DATA_WRANGLER_COMPARISON_LIVE_TRIAL_PROTOCOL) {
    fail("Measured trial completion protocol is invalid.");
  }
  const provenanceBefore = requireRecord(input.provenanceBefore, "Measured trial provenance before launch");
  const neutralDriverEvidence = requireRecord(input.neutralDriverEvidence, "Measured trial neutral-driver evidence");
  exactKeys(neutralDriverEvidence, ["driverBefore", "driverAfter"], "Measured trial neutral-driver evidence");
  const driverBefore = requireRecord(neutralDriverEvidence.driverBefore, "Measured trial driver before launch");
  const driverAfter = requireRecord(neutralDriverEvidence.driverAfter, "Measured trial driver after launch");
  const expectedDriver = requireRecord(
    input.manifest?.provenance?.comparisonDriver,
    "Measured trial manifest comparison driver"
  );
  if (!sameValue(driverBefore, expectedDriver) || !sameValue(driverAfter, expectedDriver)) {
    fail("Measured trial driver evidence does not match the immutable study manifest.");
  }
  if (typeof revalidateTrialProvenanceAfter !== "function") {
    fail("Measured trial completion requires a post-cleanup provenance revalidator.");
  }
  if (typeof assertSourceCopy !== "function" || typeof cleanupSourceCopy !== "function") {
    fail("Measured trial completion requires source-copy revalidation and cleanup functions.");
  }
  const cleanupProof = await collectDataWranglerComparisonCleanupProof(input.rawEvidence, cleanupDependencies);
  const liveSourceCopy = assertSourceCopy(input.sourceCopy);
  let trialProvenance;
  let provenanceError;
  let sourceCleanup;
  let cleanupError;
  try {
    trialProvenance = structuredClone(
      requireRecord(
        await revalidateTrialProvenanceAfter({
          protocol: DATA_WRANGLER_COMPARISON_LIVE_TRIAL_PROTOCOL,
          manifest: structuredClone(input.manifest),
          scheduleEntry: structuredClone(input.scheduleEntry),
          preparedIntent: structuredClone(input.preparedIntent),
          provenanceBefore: structuredClone(provenanceBefore),
          driverBefore: structuredClone(driverBefore),
          driverAfter: structuredClone(driverAfter),
          sourceCopy: {
            protocol: liveSourceCopy.protocol,
            byteIdentical: liveSourceCopy.byteIdentical,
            mode: liveSourceCopy.mode,
            canonicalReceipt: structuredClone(liveSourceCopy.canonicalReceipt),
            copyReceipt: structuredClone(liveSourceCopy.copyReceipt)
          },
          cleanupProof: structuredClone(cleanupProof),
          rawEvidence: structuredClone(input.rawEvidence)
        }),
        "Measured trial provenance after cleanup"
      )
    );
  } catch (error) {
    provenanceError = error;
  }
  try {
    assertSourceCopy(liveSourceCopy);
    sourceCleanup = cleanupSourceCopy(liveSourceCopy);
  } catch (error) {
    cleanupError = error;
  }
  if (provenanceError !== undefined || cleanupError !== undefined) {
    throw new AggregateError(
      [provenanceError, cleanupError].filter((error) => error !== undefined),
      "Could not finish private comparison source-copy evidence."
    );
  }
  if (!sameValue(trialProvenance.driverBefore, driverBefore) || !sameValue(trialProvenance.driverAfter, driverAfter)) {
    fail("Measured trial provenance omitted or changed its neutral-driver receipts.");
  }
  return Object.freeze({
    cleanupProof,
    sourceCopy: Object.freeze({
      protocol: liveSourceCopy.protocol,
      byteIdentical: liveSourceCopy.byteIdentical,
      mode: liveSourceCopy.mode,
      canonicalReceipt: liveSourceCopy.canonicalReceipt,
      copyReceipt: liveSourceCopy.copyReceipt,
      verifiedAfterProcessTreeEmpty: true,
      cleanup: sourceCleanup
    }),
    trialProvenance
  });
}

async function withPrivateSourceCopyRecovery(
  sourceCopy,
  lifecycle,
  operation,
  { assertSourceCopy, cleanupSourceCopy }
) {
  try {
    return await operation();
  } catch (error) {
    if (!lifecycle.supervisorLaunchAttempted && !lifecycle.cleanupAttempted) {
      let cleanupError;
      try {
        assertSourceCopy(sourceCopy);
        lifecycle.cleanupAttempted = true;
        cleanupSourceCopy(sourceCopy);
      } catch (candidate) {
        cleanupError = candidate;
      }
      if (cleanupError !== undefined) {
        const originalMessage = error instanceof Error ? error.message : String(error);
        throw new AggregateError(
          [error, cleanupError],
          `${originalMessage}; the comparison trial failed before launch and its private source copy could not be reconciled.`
        );
      }
    }
    throw error;
  }
}

function normalizationInput({ context, raw, environmentGate, fragmentIdentity }) {
  const common = {
    manifest: context.manifest,
    scheduleEntry: context.scheduleEntry,
    preparedIntent: context.preparedIntent,
    fragmentIdentity,
    environmentGate,
    executorReceipt: raw
  };
  if (raw.status !== "evidence") {
    return common;
  }
  return {
    ...common,
    notebookPhaseReceipt: raw.notebookPhaseReceipt,
    sourceVerificationReceipt: sourceVerificationReceipt(
      raw.notebookPhaseReceipt,
      context.scheduleEntry,
      requireRecord(raw.terminalEvidence?.sourceCopy, "Measured trial terminal source-copy evidence")
    )
  };
}

/**
 * Execute and durably record exactly the next prepared study entry. The study
 * ledger owns action authorization and final publication. Missing or
 * conflicting receipts throw before the fragment writer is reached.
 */
export async function recordOnePreparedDataWranglerComparisonStudyTrial(
  inputValue,
  {
    withHeavyLease = withHeavyLocalCommandLease,
    runNext = runNextDataWranglerComparisonStudyTrial,
    runGate = runLinuxDataWranglerStudyGate,
    writeNotebook = writeDataWranglerComparisonNotebook,
    executeTrial = executeDataWranglerComparisonTrial,
    validateExecutorReceipt = validateDataWranglerComparisonTrialExecutorReceipt,
    runNeutralDriverPhase = runDataWranglerComparisonNeutralDriverPhase,
    normalizeTrial = normalizeDataWranglerComparisonTrialFragment,
    normalizePreNotebookFailure = normalizeDataWranglerComparisonPreNotebookFailureFragment,
    normalizePostLaunchSetupFailure = normalizeDataWranglerComparisonPostLaunchSetupFailureFragment,
    normalizePreActionProcessProofFailure = normalizeDataWranglerComparisonPreActionProcessProofFailureFragment,
    validateFragment = validateDataWranglerStudyFragment,
    captureTrialProvenanceBefore,
    revalidateTrialProvenanceAfter,
    completeTerminalEvidence = completeDataWranglerComparisonTrialEvidence,
    createSourceCopy = createDataWranglerComparisonSourceCopy,
    assertSourceCopy = assertDataWranglerComparisonSourceCopy,
    cleanupSourceCopy = cleanupDataWranglerComparisonSourceCopy,
    validateSourceCopyBinding = validateDataWranglerComparisonSourceCopyBinding,
    validateCacheBinding = validateDataWranglerComparisonCacheBinding,
    prepareSourceCache = runDataWranglerComparisonStudyV2CacheController,
    now = () => new Date(),
    fragmentIdFactory = randomUUID,
    gateDependencies = {},
    executorDependencies = {},
    cleanupDependencies = {},
    neutralDriverDependencies = {},
    runNextOptions = {}
  } = {}
) {
  const input = validateInput(inputValue);
  requireRecord(executorDependencies, "Trial executor dependencies");
  requireRecord(neutralDriverDependencies, "Neutral-driver dependencies");
  for (const [dependency, label] of [
    [withHeavyLease, "heavy-command lease"],
    [runNext, "study scheduler"],
    [runGate, "environment gate"],
    [writeNotebook, "notebook writer"],
    [executeTrial, "trial executor"],
    [validateExecutorReceipt, "trial executor receipt validator"],
    [runNeutralDriverPhase, "neutral-driver phase"],
    [normalizeTrial, "trial normalizer"],
    [normalizePreNotebookFailure, "pre-notebook normalizer"],
    [normalizePostLaunchSetupFailure, "post-launch setup normalizer"],
    [normalizePreActionProcessProofFailure, "pre-action process-proof normalizer"],
    [validateFragment, "fragment validator"],
    [captureTrialProvenanceBefore, "pre-launch provenance capture"],
    [revalidateTrialProvenanceAfter, "post-cleanup provenance revalidation"],
    [completeTerminalEvidence, "cleanup and provenance finalizer"],
    [createSourceCopy, "source-copy creator"],
    [assertSourceCopy, "source-copy revalidator"],
    [cleanupSourceCopy, "source-copy cleanup"],
    [validateSourceCopyBinding, "manifest source-copy binding validator"],
    [validateCacheBinding, "manifest cache binding validator"],
    [prepareSourceCache, "source-cache preparer"],
    [now, "clock"],
    [fragmentIdFactory, "fragment ID factory"]
  ]) {
    if (typeof dependency !== "function") fail(`Live comparison ${label} must be a function.`);
  }
  const prepared = input.preparedTrial;
  return await withHeavyLease("data-wrangler-comparison-study-trial", async () =>
    runNext(
      {
        manifestPath: input.manifestPath,
        fragmentsDirectory: input.fragmentsDirectory,
        intentsDirectory: input.intentsDirectory
      },
      {
        ...runNextOptions,
        now,
        fragmentIdFactory,
        expectedEntryId: prepared.scheduleEntryId,
        executeTrial: async (context) => {
          if (
            context.scheduleEntry.id !== prepared.scheduleEntryId ||
            context.preparedIntent.scheduleEntryId !== prepared.scheduleEntryId
          ) {
            fail("Prepared comparison trial does not match the next study schedule entry.");
          }
          if (typeof context.reinspectActionAuthorization !== "function") {
            fail("Prepared comparison trial omitted its scheduler-owned authorization reinspector.");
          }
          const phase = PHASE_BY_PRODUCT[context.scheduleEntry.product];
          if (phase === undefined) fail("Prepared comparison trial product is invalid.");
          const fragmentIdentity = createStudyFragmentIdentity({
            manifest: context.manifest,
            scheduleEntry: context.scheduleEntry,
            executionIndex: context.executionIndex,
            attempt: context.scheduleEntry.attempt,
            recordedAtUtc: now().toISOString()
          });
          fragmentIdentity.fragmentId = fragmentIdFactory();
          const fixture = fixtureForEntry(context.manifest, context.scheduleEntry);
          const sourceCopy = createSourceCopy({
            canonicalPath: prepared.sourcePath,
            privateRoot: prepared.sourceCopy.privateRoot,
            name: prepared.sourceCopy.name
          });
          const sourceCopyLifecycle = {
            supervisorLaunchAttempted: false,
            cleanupAttempted: false
          };
          return await withPrivateSourceCopyRecovery(
            sourceCopy,
            sourceCopyLifecycle,
            async () => {
              assertSourceCopy(sourceCopy);
              const validateCurrentSourceCopy = () =>
                validateSourceCopyBinding({
                  sourceCopy,
                  manifest: context.manifest,
                  scheduleEntry: context.scheduleEntry
                });
              validateCurrentSourceCopy();
              let validatedCacheProof;
              const notebookReceipt = writeNotebook(prepared.notebookPath, {
                engine: context.scheduleEntry.engine,
                format: context.scheduleEntry.format,
                kind: context.scheduleEntry.kind,
                fixture: {
                  id: fixture.id,
                  format: fixture.format,
                  rows: fixture.rows,
                  columns: fixture.columns,
                  sha256: fixture.sha256
                },
                kernel: structuredClone(prepared.selectedKernel),
                sourceReceipt: structuredClone(sourceCopy.copyReceipt)
              });
              if (
                !isRecord(notebookReceipt) ||
                notebookReceipt.path !== prepared.notebookPath ||
                !Number.isSafeInteger(notebookReceipt.bytes) ||
                notebookReceipt.bytes < 1 ||
                notebookReceipt.mode !== "0600"
              ) {
                fail("Comparison notebook writer did not retain its exact private publication receipt.");
              }

              const environmentGate = await runGate(
                { expectedProvenance: structuredClone(input.expectedProvenance), maximumWaitMs: 300_000 },
                gateDependencies
              );
              if (environmentGate?.passed !== true) {
                return validateFragment(
                  gateFailureFragment({
                    manifest: context.manifest,
                    scheduleEntry: context.scheduleEntry,
                    executionIndex: context.executionIndex,
                    environmentGate,
                    fragmentId: fragmentIdentity.fragmentId,
                    recordedAtUtc: fragmentIdentity.recordedAtUtc
                  }),
                  context.manifest
                );
              }

              let provenanceBefore;
              let capturedDriverBefore;
              let neutralDriverEvidence;
              const raw = validateRawEvidence(
                await executeTrial(
                  {
                    runId: context.preparedIntent.runId,
                    phase,
                    cacheState: context.scheduleEntry.kind,
                    product: context.scheduleEntry.product,
                    preparedIntent: structuredClone(context.preparedIntent),
                    scheduleEntry: structuredClone(context.scheduleEntry),
                    requestPath: prepared.requestPath,
                    acknowledgementPath: prepared.acknowledgementPath,
                    selectedKernel: structuredClone(prepared.selectedKernel),
                    editorPhaseOptions: {
                      ...structuredClone(prepared.editorPhaseOptions),
                      workspace: prepared.notebookPath,
                      phase,
                      resultPath: `${prepared.notebookPath}.result.json`,
                      comparisonStudyEnvironment: {
                        requestPath: prepared.requestPath,
                        acknowledgementPath: prepared.acknowledgementPath,
                        sourcePath: sourceCopy.copyPath,
                        publicSurfaceAvailability: prepared.publicSurfaceAvailability
                      }
                    },
                    supervisorOptions: structuredClone(prepared.supervisorOptions),
                    processEvidenceOptions: structuredClone(prepared.processEvidenceOptions),
                    ...(prepared.samplerOptions === undefined
                      ? {}
                      : { samplerOptions: structuredClone(prepared.samplerOptions) }),
                    authorizeAction: () => {
                      assertSourceCopy(sourceCopy);
                      validateCurrentSourceCopy();
                      if (validatedCacheProof === undefined) {
                        fail("Measured action authorization requires one manifest-bound source-cache proof.");
                      }
                      validateCacheBinding({
                        cacheProof: validatedCacheProof,
                        sourceCopy,
                        manifest: context.manifest,
                        scheduleEntry: context.scheduleEntry
                      });
                      return context.authorizeAction();
                    },
                    reinspectActionAuthorization: context.reinspectActionAuthorization
                  },
                  {
                    ...executorDependencies,
                    runEditorPhase: async (phaseOptions, editorRunnerDependencies) => {
                      const baseRunEditorPhase = executorDependencies.runEditorPhase ?? runEditorAcceptancePhase;
                      if (typeof baseRunEditorPhase !== "function") {
                        fail("Prepared editor phase runner must be a function.");
                      }
                      const expectedDriver = requireRecord(
                        context.manifest?.provenance?.comparisonDriver,
                        "Study manifest comparison driver"
                      );
                      const retainNeutralDriverEvidence = (value) => {
                        const evidence = requireRecord(value, "Neutral-driver terminal evidence");
                        const driverBefore = requireRecord(
                          evidence.driverBefore,
                          "Neutral-driver receipt before launch"
                        );
                        const driverAfter = requireRecord(evidence.driverAfter, "Neutral-driver receipt after launch");
                        if (
                          !sameValue(driverBefore, capturedDriverBefore) ||
                          !sameValue(driverBefore, expectedDriver) ||
                          !sameValue(driverAfter, expectedDriver)
                        ) {
                          fail("Neutral-driver phase receipts do not match the measured launch or study manifest.");
                        }
                        neutralDriverEvidence = {
                          driverBefore: structuredClone(driverBefore),
                          driverAfter: structuredClone(driverAfter)
                        };
                      };
                      const result = requireRecord(
                        await runNeutralDriverPhase(
                          {
                            product: context.scheduleEntry.product,
                            receipt: prepared.neutralDriver.receipt,
                            expectedDriver,
                            expectedExtensions: structuredClone(prepared.neutralDriver.expectedExtensions),
                            expectedTemplate: structuredClone(prepared.neutralDriver.expectedTemplate),
                            profile: prepared.neutralDriver.profile,
                            prevalidated: structuredClone(prepared.neutralDriver.prevalidated),
                            editorPhaseOptions: phaseOptions
                          },
                          {
                            ...neutralDriverDependencies,
                            onAfterValidation: retainNeutralDriverEvidence,
                            runPhase: async (neutralPhaseOptions, neutralPhaseDependencies) => {
                              if (provenanceBefore !== undefined) {
                                fail("Measured trial provenance before launch was captured more than once.");
                              }
                              const dependencies = requireRecord(
                                neutralPhaseDependencies,
                                "Neutral-driver phase dependencies"
                              );
                              capturedDriverBefore = structuredClone(
                                requireRecord(dependencies.driverBefore, "Neutral driver before measured launch")
                              );
                              const prepareSourceCacheBeforeLaunch =
                                editorRunnerDependencies.prepareSourceCacheBeforeLaunch;
                              if (typeof prepareSourceCacheBeforeLaunch !== "function") {
                                fail("Measured trial omitted its executor-owned pre-launch cache preparation hook.");
                              }
                              await prepareSourceCacheBeforeLaunch();
                              provenanceBefore = structuredClone(
                                requireRecord(
                                  await captureTrialProvenanceBefore({
                                    protocol: DATA_WRANGLER_COMPARISON_LIVE_TRIAL_PROTOCOL,
                                    manifest: structuredClone(context.manifest),
                                    scheduleEntry: structuredClone(context.scheduleEntry),
                                    preparedIntent: structuredClone(context.preparedIntent),
                                    canonicalSourcePath: prepared.sourcePath,
                                    sourcePath: sourceCopy.copyPath,
                                    sourceCopy: {
                                      protocol: sourceCopy.protocol,
                                      byteIdentical: sourceCopy.byteIdentical,
                                      mode: sourceCopy.mode,
                                      canonicalReceipt: structuredClone(sourceCopy.canonicalReceipt),
                                      copyReceipt: structuredClone(sourceCopy.copyReceipt)
                                    },
                                    notebookPath: prepared.notebookPath,
                                    driverBefore: structuredClone(capturedDriverBefore)
                                  }),
                                  "Measured trial provenance before launch"
                                )
                              );
                              const spawnProcess = editorRunnerDependencies.spawnProcess;
                              if (typeof spawnProcess !== "function") {
                                fail("Measured editor phase omitted its supervisor-owned spawn function.");
                              }
                              return await baseRunEditorPhase(neutralPhaseOptions, {
                                ...editorRunnerDependencies,
                                ...neutralPhaseDependencies,
                                spawnProcess(...arguments_) {
                                  sourceCopyLifecycle.supervisorLaunchAttempted = true;
                                  return spawnProcess(...arguments_);
                                }
                              });
                            }
                          }
                        ),
                        "Neutral-driver phase result"
                      );
                      retainNeutralDriverEvidence(result);
                      return result.phaseResult;
                    },
                    completeTerminalEvidence: (terminalInput) =>
                      completeTerminalEvidence(
                        {
                          protocol: DATA_WRANGLER_COMPARISON_LIVE_TRIAL_PROTOCOL,
                          manifest: structuredClone(context.manifest),
                          scheduleEntry: structuredClone(context.scheduleEntry),
                          preparedIntent: structuredClone(context.preparedIntent),
                          environmentGate: structuredClone(environmentGate),
                          provenanceBefore: structuredClone(
                            requireRecord(provenanceBefore, "Measured trial provenance before launch")
                          ),
                          neutralDriverEvidence: structuredClone(
                            requireRecord(neutralDriverEvidence, "Measured trial neutral-driver evidence")
                          ),
                          sourceCopy,
                          rawEvidence: {
                            launchReceipt: structuredClone(terminalInput.launchReceipt),
                            supervisorCompletion: structuredClone(terminalInput.supervisorCompletion),
                            processProofs: structuredClone(terminalInput.processProofs),
                            notebookPhaseReceipt: structuredClone(terminalInput.notebookPhaseReceipt),
                            controlReceipt: structuredClone(terminalInput.controlReceipt),
                            cacheProof: structuredClone(terminalInput.cacheProof)
                          }
                        },
                        {
                          revalidateTrialProvenanceAfter,
                          cleanupDependencies,
                          assertSourceCopy,
                          cleanupSourceCopy(value) {
                            sourceCopyLifecycle.cleanupAttempted = true;
                            return cleanupSourceCopy(value);
                          }
                        }
                      ),
                    prepareSourceCache: async ({ cacheState }) => {
                      const proof = await prepareSourceCache({
                        sourceCopy,
                        cacheState,
                        pythonExecutablePath: prepared.sourceCache.pythonExecutablePath,
                        controllerPath: prepared.sourceCache.controlScriptPath
                      });
                      validateCurrentSourceCopy();
                      validateCacheBinding({
                        cacheProof: proof,
                        sourceCopy,
                        manifest: context.manifest,
                        scheduleEntry: context.scheduleEntry
                      });
                      validatedCacheProof = proof;
                      return proof;
                    }
                  }
                ),
                context,
                phase,
                validateExecutorReceipt
              );
              const normalization = normalizationInput({
                context,
                raw,
                environmentGate,
                fragmentIdentity
              });
              if (raw.status === "evidence") return normalizeTrial(normalization);
              if (raw.status === "post-launch-setup-failure") {
                return normalizePostLaunchSetupFailure(normalization);
              }
              if (raw.status === "pre-action-process-proof-failure") {
                return normalizePreActionProcessProofFailure(normalization);
              }
              return normalizePreNotebookFailure(normalization);
            },
            { assertSourceCopy, cleanupSourceCopy }
          );
        }
      }
    )
  );
}
