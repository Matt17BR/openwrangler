import { isAbsolute } from "node:path";
import { runEditorAcceptancePhase } from "./editor-acceptance.mjs";
import { createDataWranglerComparisonProcessEvidence } from "./data-wrangler-comparison-process-evidence.mjs";
import {
  controlDataWranglerComparisonMeasuredTrial,
  validateDataWranglerComparisonTrialControlReceipt
} from "./data-wrangler-comparison-trial-control.mjs";
import { digestStudyValue } from "./data-wrangler-comparison-study.mjs";
import { createLinuxStudySupervisorSpawnAdapter } from "./linux-study-supervisor-client.mjs";
import { LinuxPssTreeSampler } from "./linux-pss-sampler.mjs";

export const DATA_WRANGLER_COMPARISON_TRIAL_EXECUTOR_PROTOCOL =
  "openwrangler-data-wrangler-comparison-trial-executor-v1";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PHASE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const FAILURE_CLASSIFICATION = /^[a-z][a-z0-9-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const AUTHORIZATION_OUTCOMES = Object.freeze(["not-attempted", "not-authorized", "authorized"]);
const RECEIPT_STATUSES = Object.freeze([
  "evidence",
  "pre-notebook-failure",
  "post-launch-setup-failure",
  "pre-action-process-proof-failure"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new TypeError(`${label} has missing or unknown fields.`);
  }
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

function validateTrialBindingInput(input) {
  const prepared = input.preparedIntent;
  const schedule = input.scheduleEntry;
  if (
    !isRecord(prepared) ||
    prepared.stage !== "prepared" ||
    prepared.runId !== input.runId ||
    !SHA256.test(prepared.manifestSha256 ?? "") ||
    !Number.isSafeInteger(prepared.executionIndex) ||
    prepared.executionIndex < 0 ||
    !Number.isSafeInteger(prepared.attempt) ||
    prepared.attempt < 0 ||
    typeof prepared.scheduleEntryId !== "string" ||
    typeof prepared.effectiveBlockId !== "string" ||
    typeof prepared.ledgerSha256 !== "string" ||
    !SHA256.test(prepared.ledgerSha256) ||
    typeof prepared.preparedAtUtc !== "string"
  ) {
    throw new TypeError("Comparison trial executor prepared intent is malformed.");
  }
  if (
    !isRecord(schedule) ||
    typeof schedule.id !== "string" ||
    typeof schedule.blockId !== "string" ||
    !["warm", "cold"].includes(schedule.kind) ||
    typeof schedule.engine !== "string" ||
    typeof schedule.format !== "string" ||
    !["open-wrangler", "data-wrangler"].includes(schedule.product) ||
    prepared.scheduleEntryId !== schedule.id ||
    prepared.effectiveBlockId !== `${schedule.blockId}~a${String(prepared.attempt).padStart(2, "0")}` ||
    prepared.product !== schedule.product ||
    input.cacheState !== schedule.kind ||
    input.product !== schedule.product
  ) {
    throw new TypeError("Comparison trial executor prepared intent does not match its schedule entry.");
  }
}

function trialBinding(input) {
  return Object.freeze({
    preparedIntentSha256: digestStudyValue(input.preparedIntent),
    manifestSha256: input.preparedIntent.manifestSha256,
    executionIndex: input.preparedIntent.executionIndex,
    scheduleEntryId: input.scheduleEntry.id,
    baseBlockId: input.scheduleEntry.blockId,
    attempt: input.preparedIntent.attempt,
    effectiveBlockId: input.preparedIntent.effectiveBlockId,
    product: input.scheduleEntry.product,
    engine: input.scheduleEntry.engine,
    format: input.scheduleEntry.format,
    cacheState: input.scheduleEntry.kind
  });
}

function validateInput(input) {
  if (!isRecord(input)) throw new TypeError("Comparison trial executor input must be an object.");
  if (!UUID_V4.test(input.runId ?? "") || !PHASE.test(input.phase ?? "")) {
    throw new TypeError("Comparison trial executor correlation fields are invalid.");
  }
  if (!["warm", "cold"].includes(input.cacheState)) {
    throw new TypeError("Comparison trial executor cache state must be warm or cold.");
  }
  if (!["open-wrangler", "data-wrangler"].includes(input.product)) {
    throw new TypeError("Comparison trial executor product is invalid.");
  }
  if (
    typeof input.requestPath !== "string" ||
    !isAbsolute(input.requestPath) ||
    typeof input.acknowledgementPath !== "string" ||
    !isAbsolute(input.acknowledgementPath) ||
    input.requestPath === input.acknowledgementPath
  ) {
    throw new TypeError("Comparison trial executor requires distinct absolute bridge paths.");
  }
  if (
    !isRecord(input.selectedKernel) ||
    typeof input.selectedKernel.name !== "string" ||
    typeof input.selectedKernel.displayName !== "string"
  ) {
    throw new TypeError("Comparison trial executor requires the selected kernelspec identity.");
  }
  for (const [value, label] of [
    [input.editorPhaseOptions, "editor phase"],
    [input.supervisorOptions, "supervisor"],
    [input.processEvidenceOptions, "process evidence"]
  ]) {
    if (!isRecord(value)) throw new TypeError(`Comparison trial executor ${label} options must be an object.`);
  }
  if (input.samplerOptions !== undefined && !isRecord(input.samplerOptions)) {
    throw new TypeError("Comparison trial executor sampler options must be an object.");
  }
  if (typeof input.authorizeAction !== "function") {
    throw new TypeError("Comparison trial executor requires a synchronous action authorizer.");
  }
  if (typeof input.reinspectActionAuthorization !== "function") {
    throw new TypeError("Comparison trial executor requires a synchronous authorization-journal reinspector.");
  }
  validateTrialBindingInput(input);
  return input;
}

function validateDependencies(dependencies) {
  if (!isRecord(dependencies)) throw new TypeError("Comparison trial executor dependencies must be an object.");
  for (const [name, value] of Object.entries(dependencies)) {
    if (name === "editorRunnerDependencies" || name === "controlDependencies") continue;
    if (typeof value !== "function") {
      throw new TypeError(`Comparison trial executor dependency ${name} must be a function.`);
    }
  }
  if (dependencies.editorRunnerDependencies !== undefined && !isRecord(dependencies.editorRunnerDependencies)) {
    throw new TypeError("Comparison trial editor-runner dependencies must be an object.");
  }
  if (dependencies.controlDependencies !== undefined && !isRecord(dependencies.controlDependencies)) {
    throw new TypeError("Comparison trial control dependencies must be an object.");
  }
}

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => {});
  return Object.freeze({
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    }
  });
}

function settled(promise) {
  return Promise.resolve(promise).then(
    (value) => Object.freeze({ status: "fulfilled", value }),
    (reason) => Object.freeze({ status: "rejected", reason })
  );
}

function boundedFailureClassification(error, fallback) {
  const candidates = [error?.kind, error?.code, error?.name];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate
      .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
      .replace(/[^a-zA-Z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .toLowerCase();
    if (FAILURE_CLASSIFICATION.test(normalized)) return normalized;
  }
  return fallback;
}

function setupFailureClassification(boundary, error) {
  const detail = boundedFailureClassification(error, "failure");
  const maximumDetailLength = 64 - boundary.length - 1;
  const boundedDetail = detail.slice(0, maximumDetailLength).replace(/-+$/u, "") || "failure";
  return `${boundary}-${boundedDetail}`;
}

function defaultCreateSampler({ launchReceipt, classify, samplerOptions }) {
  return new LinuxPssTreeSampler({
    ...(samplerOptions ?? {}),
    supervisorPid: launchReceipt.supervisor.pid,
    supervisorStartTimeTicks: launchReceipt.supervisor.startTimeTicks,
    editorRootPid: launchReceipt.editorRoot.pid,
    editorRootStartTimeTicks: launchReceipt.editorRoot.startTimeTicks,
    ownershipReceipt: launchReceipt,
    classify
  });
}

function defaultSignalSupervisor(adapter) {
  const child = adapter.child();
  if (!child || typeof child.kill !== "function") {
    throw new Error("The Linux study supervisor child is unavailable for termination.");
  }
  child.kill("SIGTERM");
}

function defaultCompleteTerminalEvidence() {
  return null;
}

function launchOnlyProcessProofs(launchReceipt) {
  const editorRoot = launchReceipt?.editorRoot;
  if (
    !isRecord(editorRoot) ||
    !Number.isSafeInteger(editorRoot.pid) ||
    editorRoot.pid < 1 ||
    typeof editorRoot.startTimeTicks !== "string" ||
    !/^\d+$/u.test(editorRoot.startTimeTicks)
  ) {
    throw new TypeError("Comparison trial supervisor launch receipt has no usable editor-root identity.");
  }
  return Object.freeze({
    editorRoot: Object.freeze({
      pid: editorRoot.pid,
      startTimeTicks: editorRoot.startTimeTicks,
      capturedAtLaunch: true
    }),
    configuredKernel: null,
    openWranglerRuntime: null
  });
}

function validateLaunchOnlyProcessProofs(value, launchReceipt) {
  exactKeys(value, ["editorRoot", "configuredKernel", "openWranglerRuntime"], "Comparison trial launch process proofs");
  exactKeys(value.editorRoot, ["pid", "startTimeTicks", "capturedAtLaunch"], "Comparison trial editor-root proof");
  if (
    value.editorRoot.pid !== launchReceipt.editorRoot?.pid ||
    value.editorRoot.startTimeTicks !== launchReceipt.editorRoot?.startTimeTicks ||
    value.editorRoot.capturedAtLaunch !== true ||
    value.configuredKernel !== null ||
    value.openWranglerRuntime !== null
  ) {
    throw new TypeError("Comparison trial launch process proofs do not match the supervisor receipt.");
  }
  return value;
}

function validateAdapter(adapter) {
  if (
    !isRecord(adapter) ||
    typeof adapter.spawnProcess !== "function" ||
    typeof adapter.waitForLaunch !== "function" ||
    typeof adapter.waitForCompletion !== "function" ||
    typeof adapter.child !== "function"
  ) {
    throw new TypeError("Comparison trial executor received a malformed supervisor adapter.");
  }
  return adapter;
}

function rawEvidence({
  input,
  status,
  notebookPhaseReceipt,
  controlReceipt,
  cacheProof,
  processProofs,
  launchReceipt,
  supervisorCompletion,
  terminalEvidence,
  outerEditorFailure,
  actionAuthorized,
  authorizationAttempted,
  authorizationOutcome
}) {
  return Object.freeze({
    protocol: DATA_WRANGLER_COMPARISON_TRIAL_EXECUTOR_PROTOCOL,
    status: status ?? (notebookPhaseReceipt === null ? "pre-notebook-failure" : "evidence"),
    runId: input.runId,
    phase: input.phase,
    cacheState: input.cacheState,
    product: input.product,
    trialBinding: trialBinding(input),
    actionAuthorized,
    authorizationAttempted,
    authorizationOutcome,
    notebookPhaseReceipt,
    controlReceipt,
    cacheProof,
    processProofs,
    launchReceipt,
    supervisorCompletion,
    terminalEvidence,
    outerEditorFailure
  });
}

async function completeAfterSetupFailure({
  input,
  adapter,
  editorSettlement,
  launchReceipt,
  cacheProof,
  processProofs,
  failure,
  failureBoundary,
  signalSupervisor,
  completeTerminalEvidence
}) {
  let signalError;
  try {
    await signalSupervisor(adapter, "post-launch-setup-failure");
  } catch (error) {
    signalError = error;
  }
  const [editor, completion] = await Promise.all([editorSettlement, settled(adapter.waitForCompletion())]);
  if (signalError !== undefined || completion.status === "rejected") {
    throw new AggregateError(
      [failure, signalError, completion.status === "rejected" ? completion.reason : undefined].filter(Boolean),
      "Comparison trial setup failed and verified supervisor cleanup did not complete."
    );
  }
  if (editor.status === "fulfilled") {
    throw new AggregateError(
      [failure],
      "Comparison trial setup failed after launch but the editor returned unsupported notebook evidence."
    );
  }
  const terminalEvidence = await completeTerminalEvidence({
    input,
    launchReceipt,
    supervisorCompletion: completion.value,
    processProofs,
    notebookPhaseReceipt: null,
    controlReceipt: null,
    cacheProof
  });
  return rawEvidence({
    input,
    status: "post-launch-setup-failure",
    notebookPhaseReceipt: null,
    controlReceipt: null,
    cacheProof,
    processProofs,
    launchReceipt,
    supervisorCompletion: completion.value,
    terminalEvidence,
    outerEditorFailure: Object.freeze({
      status: "failed",
      classification: setupFailureClassification(failureBoundary, failure)
    }),
    actionAuthorized: false,
    authorizationAttempted: false,
    authorizationOutcome: "not-attempted"
  });
}

function validateRetainedTrialBinding(value) {
  exactKeys(
    value,
    [
      "preparedIntentSha256",
      "manifestSha256",
      "executionIndex",
      "scheduleEntryId",
      "baseBlockId",
      "attempt",
      "effectiveBlockId",
      "product",
      "engine",
      "format",
      "cacheState"
    ],
    "Comparison trial executor binding"
  );
  if (
    !SHA256.test(value.preparedIntentSha256 ?? "") ||
    !SHA256.test(value.manifestSha256 ?? "") ||
    !Number.isSafeInteger(value.executionIndex) ||
    value.executionIndex < 0 ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0 ||
    typeof value.scheduleEntryId !== "string" ||
    typeof value.baseBlockId !== "string" ||
    value.effectiveBlockId !== `${value.baseBlockId}~a${String(value.attempt).padStart(2, "0")}` ||
    !["open-wrangler", "data-wrangler"].includes(value.product) ||
    typeof value.engine !== "string" ||
    typeof value.format !== "string" ||
    !["warm", "cold"].includes(value.cacheState)
  ) {
    throw new TypeError("Comparison trial executor binding is malformed.");
  }
}

/**
 * Checks the complete executor handoff before a normalizer can use any part of
 * it. This keeps schedule, journal, process, controller, and notebook receipts
 * tied to one measured attempt.
 */
export function validateDataWranglerComparisonTrialExecutorReceipt(
  value,
  { validateControlReceipt = validateDataWranglerComparisonTrialControlReceipt } = {}
) {
  exactKeys(
    value,
    [
      "protocol",
      "status",
      "runId",
      "phase",
      "cacheState",
      "product",
      "trialBinding",
      "actionAuthorized",
      "authorizationAttempted",
      "authorizationOutcome",
      "notebookPhaseReceipt",
      "controlReceipt",
      "cacheProof",
      "processProofs",
      "launchReceipt",
      "supervisorCompletion",
      "terminalEvidence",
      "outerEditorFailure"
    ],
    "Comparison trial executor receipt"
  );
  if (
    value.protocol !== DATA_WRANGLER_COMPARISON_TRIAL_EXECUTOR_PROTOCOL ||
    !RECEIPT_STATUSES.includes(value.status) ||
    !UUID_V4.test(value.runId ?? "") ||
    !PHASE.test(value.phase ?? "") ||
    !["warm", "cold"].includes(value.cacheState) ||
    !["open-wrangler", "data-wrangler"].includes(value.product) ||
    typeof value.actionAuthorized !== "boolean" ||
    typeof value.authorizationAttempted !== "boolean" ||
    !AUTHORIZATION_OUTCOMES.includes(value.authorizationOutcome)
  ) {
    throw new TypeError("Comparison trial executor receipt is malformed.");
  }
  validateRetainedTrialBinding(value.trialBinding);
  if (value.trialBinding.product !== value.product || value.trialBinding.cacheState !== value.cacheState) {
    throw new TypeError("Comparison trial executor receipt does not match its retained schedule binding.");
  }
  if (
    (value.authorizationOutcome === "not-attempted" && (value.authorizationAttempted || value.actionAuthorized)) ||
    (value.authorizationOutcome === "not-authorized" && (!value.authorizationAttempted || value.actionAuthorized)) ||
    (value.authorizationOutcome === "authorized" && (!value.authorizationAttempted || !value.actionAuthorized))
  ) {
    throw new TypeError("Comparison trial executor authorization state is contradictory.");
  }
  if (!isRecord(value.launchReceipt) || !isRecord(value.supervisorCompletion)) {
    throw new TypeError("Comparison trial executor omitted launch or terminal supervisor evidence.");
  }
  if (value.terminalEvidence !== null) {
    exactKeys(
      value.terminalEvidence,
      ["cleanupProof", "sourceCopy", "trialProvenance"],
      "Comparison trial terminal evidence"
    );
    if (
      !isRecord(value.terminalEvidence.cleanupProof) ||
      !isRecord(value.terminalEvidence.sourceCopy) ||
      !isRecord(value.terminalEvidence.trialProvenance)
    ) {
      throw new TypeError("Comparison trial terminal evidence is malformed.");
    }
  }
  if (
    isRecord(value.supervisorCompletion.launchReceipt) &&
    !sameValue(value.launchReceipt, value.supervisorCompletion.launchReceipt)
  ) {
    throw new TypeError("Comparison trial executor launch and completion receipts do not match.");
  }
  let controlReceipt = null;
  if (value.controlReceipt !== null) {
    controlReceipt = validateControlReceipt(value.controlReceipt);
    if (
      controlReceipt.runId !== value.runId ||
      controlReceipt.phase !== value.phase ||
      controlReceipt.cacheState !== value.cacheState
    ) {
      throw new TypeError("Comparison trial executor control receipt is stale.");
    }
    if ((controlReceipt.authorization !== null) !== value.actionAuthorized) {
      throw new TypeError("Comparison trial executor control authorization does not match its journal outcome.");
    }
  } else if (value.actionAuthorized || value.authorizationAttempted) {
    throw new TypeError("Comparison trial executor lost control evidence after an authorization attempt.");
  }
  if (value.status === "evidence") {
    const notebook = value.notebookPhaseReceipt;
    if (
      !isRecord(notebook) ||
      !["success", "failed"].includes(notebook.status) ||
      notebook.product !== value.product ||
      notebook.study?.engine !== value.trialBinding.engine ||
      notebook.study?.format !== value.trialBinding.format ||
      notebook.study?.kind !== value.cacheState ||
      value.outerEditorFailure !== null ||
      controlReceipt === null
    ) {
      throw new TypeError("Comparison trial executor notebook evidence is stale or malformed.");
    }
  } else {
    exactKeys(value.outerEditorFailure, ["status", "classification"], "Comparison trial outer failure");
    if (
      value.notebookPhaseReceipt !== null ||
      value.outerEditorFailure.status !== "failed" ||
      !FAILURE_CLASSIFICATION.test(value.outerEditorFailure.classification ?? "")
    ) {
      throw new TypeError("Comparison trial executor pre-notebook failure is malformed.");
    }
    if (value.status === "post-launch-setup-failure") {
      if (
        controlReceipt !== null ||
        value.authorizationAttempted ||
        value.actionAuthorized ||
        value.authorizationOutcome !== "not-attempted" ||
        !/^(?:process-evidence|resource-sampler)-[a-z][a-z0-9-]{0,63}$/u.test(
          value.outerEditorFailure.classification
        ) ||
        value.terminalEvidence === null
      ) {
        throw new TypeError("Comparison trial post-launch setup failure is contradictory.");
      }
      validateLaunchOnlyProcessProofs(value.processProofs, value.launchReceipt);
    } else if (value.status === "pre-action-process-proof-failure") {
      if (
        value.authorizationAttempted ||
        value.actionAuthorized ||
        value.authorizationOutcome !== "not-attempted" ||
        !/^pre-action-process-proof-[a-z][a-z0-9-]{0,63}$/u.test(value.outerEditorFailure.classification) ||
        value.terminalEvidence === null ||
        (controlReceipt !== null && (controlReceipt.status !== "failed" || controlReceipt.authorization !== null))
      ) {
        throw new TypeError("Comparison trial pre-action process-proof failure is contradictory.");
      }
      validateLaunchOnlyProcessProofs(value.processProofs, value.launchReceipt);
    } else if (controlReceipt === null) {
      throw new TypeError("Comparison trial pre-notebook failure omitted its controller receipt.");
    }
  }
  return value;
}

/**
 * Run one already-prepared study trial. This function coordinates evidence
 * collection only; it does not normalize or publish a study fragment.
 */
export async function executeDataWranglerComparisonTrial(
  inputValue,
  {
    createSupervisorAdapter = createLinuxStudySupervisorSpawnAdapter,
    runEditorPhase = runEditorAcceptancePhase,
    createProcessEvidence = createDataWranglerComparisonProcessEvidence,
    createSampler = defaultCreateSampler,
    controlTrial = controlDataWranglerComparisonMeasuredTrial,
    validateControlReceipt = validateDataWranglerComparisonTrialControlReceipt,
    prepareSourceCache,
    revalidatePreparedInputsAtSpawn = () => undefined,
    signalSupervisor = defaultSignalSupervisor,
    completeTerminalEvidence = defaultCompleteTerminalEvidence,
    editorRunnerDependencies = {},
    controlDependencies = {}
  } = {}
) {
  const input = validateInput(inputValue);
  const dependencies = {
    createSupervisorAdapter,
    runEditorPhase,
    createProcessEvidence,
    createSampler,
    controlTrial,
    validateControlReceipt,
    prepareSourceCache,
    revalidatePreparedInputsAtSpawn,
    signalSupervisor,
    completeTerminalEvidence,
    editorRunnerDependencies,
    controlDependencies
  };
  validateDependencies(dependencies);

  let cacheProof = null;
  let cachePreparationStarted = false;
  let cachePrepared = false;
  const prepareSourceCacheOnce = async ({ cacheState, request }) => {
    if (cachePreparationStarted) {
      throw new Error("Comparison trial source-cache preparation may run only once.");
    }
    cachePreparationStarted = true;
    const proof = await prepareSourceCache({ cacheState, ...(request === undefined ? {} : { request }) });
    if (!isRecord(proof)) {
      throw new TypeError("Comparison trial source-cache preparation did not return a proof object.");
    }
    cacheProof = proof;
    cachePrepared = true;
    return cacheProof;
  };
  const prepareWarmSourceCacheBeforeLaunch = async () => {
    if (input.cacheState !== "warm") {
      throw new Error("Comparison trial warm source-cache preparation was requested for a cold trial.");
    }
    return await prepareSourceCacheOnce({ cacheState: "warm" });
  };

  const adapter = validateAdapter(createSupervisorAdapter(input.supervisorOptions));
  const spawnObserved = createDeferred();
  const editorPromise = Promise.resolve().then(() =>
    runEditorPhase(
      { ...input.editorPhaseOptions, runId: input.runId, phase: input.phase },
      {
        ...editorRunnerDependencies,
        ...(input.cacheState === "warm"
          ? {
              prepareSourceCacheBeforeLaunch: prepareWarmSourceCacheBeforeLaunch,
              prepareWarmSourceCacheBeforeLaunch
            }
          : {}),
        spawnProcess(...arguments_) {
          try {
            if (input.cacheState === "warm" && (!cachePrepared || !isRecord(cacheProof))) {
              throw new Error("Comparison trial refused to launch before its fresh source-cache proof was retained.");
            }
            if (input.cacheState === "cold" && (cachePreparationStarted || cachePrepared || cacheProof !== null)) {
              throw new Error("Comparison trial refused to launch after premature cold-cache preparation.");
            }
            const revalidation = revalidatePreparedInputsAtSpawn();
            if (revalidation !== undefined && isRecord(revalidation) && typeof revalidation.then === "function") {
              throw new TypeError("Comparison trial spawn-bound input revalidation must be synchronous.");
            }
            const child = adapter.spawnProcess(...arguments_);
            spawnObserved.resolve(child);
            return child;
          } catch (error) {
            spawnObserved.reject(error);
            throw error;
          }
        }
      }
    )
  );
  const editorSettlement = settled(editorPromise);
  const spawnOrEditor = await Promise.race([
    spawnObserved.promise.then(() => "spawned"),
    editorSettlement.then(() => "editor-settled")
  ]);
  if (spawnOrEditor !== "spawned") {
    const editor = await editorSettlement;
    if (editor.status === "rejected") throw editor.reason;
    throw new Error("Comparison trial editor phase settled without launching its supervisor.");
  }

  let launchReceipt;
  try {
    launchReceipt = await adapter.waitForLaunch();
  } catch (error) {
    const editor = await editorSettlement;
    if (editor.status === "rejected") {
      throw new AggregateError([error, editor.reason], "Comparison trial supervisor launch was not verified.");
    }
    throw error;
  }

  let processEvidence;
  let sampler;
  let processProofs = launchOnlyProcessProofs(launchReceipt);
  let failureBoundary = "process-evidence";
  try {
    processEvidence = createProcessEvidence({
      ...input.processEvidenceOptions,
      launchReceipt,
      product: input.product,
      expectedKernel: input.selectedKernel
    });
    if (
      !isRecord(processEvidence) ||
      typeof processEvidence.classify !== "function" ||
      typeof processEvidence.snapshotLaunchProcessProofs !== "function" ||
      typeof processEvidence.snapshotPreActionProcessProofs !== "function" ||
      typeof processEvidence.snapshotProcessProofs !== "function"
    ) {
      throw new TypeError("Comparison trial process-evidence factory returned a malformed value.");
    }
    processProofs = processEvidence.snapshotLaunchProcessProofs();
    if (!isRecord(processProofs) || (processProofs && typeof processProofs.then === "function")) {
      throw new TypeError("Comparison trial launch process proofs must be captured synchronously.");
    }
    failureBoundary = "resource-sampler";
    sampler = createSampler({
      launchReceipt,
      classify: processEvidence.classify,
      samplerOptions: input.samplerOptions
    });
  } catch (error) {
    // A cold proof becomes study evidence only after the controller asks for
    // and acknowledges eviction. Setup failed before that controller existed,
    // so retain only a warm preload proof in the terminal receipt.
    const retainedSetupProof = input.cacheState === "warm" ? cacheProof : null;
    return completeAfterSetupFailure({
      input,
      adapter,
      editorSettlement,
      launchReceipt,
      cacheProof: retainedSetupProof,
      processProofs,
      failure: error,
      failureBoundary,
      signalSupervisor,
      completeTerminalEvidence
    });
  }

  const controlAbort = new AbortController();
  let actionAuthorized = false;
  let authorizationAttempted = false;
  let authorizationOutcome = "not-attempted";
  let actionPreparationAttempted = false;
  let preActionProofError;

  const indeterminateAuthorization = (cause) => {
    const error = new Error(
      "Comparison trial action authorization may have reached the durable journal; inspect it before any retry.",
      { cause }
    );
    error.code = "action-authorization-indeterminate";
    return error;
  };

  const inspectAuthorizationAttempt = (authorizationError) => {
    let inspection;
    try {
      inspection = input.reinspectActionAuthorization();
    } catch (inspectionError) {
      authorizationOutcome = "indeterminate";
      throw indeterminateAuthorization(new AggregateError([authorizationError, inspectionError]));
    }
    if (inspection && typeof inspection.then === "function") {
      authorizationOutcome = "indeterminate";
      throw indeterminateAuthorization(authorizationError);
    }
    if (isRecord(inspection) && inspection.status === "authorized" && isRecord(inspection.authorization)) {
      actionAuthorized = true;
      authorizationOutcome = "authorized";
      return { status: "authorized", authorization: inspection.authorization };
    }
    if (isRecord(inspection) && inspection.status === "not-authorized") {
      actionAuthorized = false;
      authorizationOutcome = "not-authorized";
      return { status: "not-authorized", authorization: null };
    }
    authorizationOutcome = "indeterminate";
    throw indeterminateAuthorization(authorizationError);
  };

  const recoverAuthorizationAttempt = (authorizationError) => {
    const inspection = inspectAuthorizationAttempt(authorizationError);
    if (inspection.status === "authorized") return inspection.authorization;
    throw authorizationError;
  };

  const authorizeMeasuredAction = () => {
    if (preActionProofError !== undefined || controlAbort.signal.aborted) {
      throw new Error("Comparison trial product-action authorization is closed after a pre-action failure.");
    }
    if (authorizationAttempted || actionPreparationAttempted) {
      throw new Error("Comparison trial product-action preparation was attempted more than once.");
    }
    actionPreparationAttempted = true;
    let proofs;
    try {
      proofs = processEvidence.snapshotProcessProofs({ selectedKernel: input.selectedKernel });
    } catch (error) {
      preActionProofError = error;
      throw error;
    }
    if (!isRecord(proofs) || (proofs && typeof proofs.then === "function")) {
      preActionProofError = new TypeError(
        "Comparison trial process proofs must be captured synchronously before authorization."
      );
      throw preActionProofError;
    }
    processProofs = proofs;
    authorizationAttempted = true;
    authorizationOutcome = "indeterminate";
    let authorization;
    try {
      authorization = input.authorizeAction();
    } catch (error) {
      return recoverAuthorizationAttempt(error);
    }
    if (authorization && typeof authorization.then === "function") {
      void Promise.resolve(authorization).catch(() => {});
      throw indeterminateAuthorization(
        new TypeError("Comparison trial product-action authorization must be synchronous.")
      );
    }
    actionAuthorized = true;
    authorizationOutcome = "authorized";
    return authorization;
  };

  const evictColdCache = async ({ request }) => {
    if (input.cacheState !== "cold" || !isRecord(request)) {
      throw new Error("Comparison trial cold-cache control requested an invalid post-verification eviction.");
    }
    return await prepareSourceCacheOnce({ cacheState: "cold", request: structuredClone(request) });
  };
  const controlPromise = Promise.resolve()
    .then(() =>
      controlTrial(
        {
          requestPath: input.requestPath,
          acknowledgementPath: input.acknowledgementPath,
          runId: input.runId,
          phase: input.phase,
          cacheState: input.cacheState,
          sampler,
          authorizeAction: authorizeMeasuredAction,
          signal: controlAbort.signal
        },
        {
          ...controlDependencies,
          ...(input.cacheState === "cold" ? { evictColdCache } : {})
        }
      )
    )
    .then((receipt) => validateControlReceipt(receipt));
  const controlSettlement = settled(controlPromise);
  const first = await Promise.race([
    editorSettlement.then((outcome) => ({ owner: "editor", outcome })),
    controlSettlement.then((outcome) => ({ owner: "control", outcome }))
  ]);

  if (!authorizationAttempted && preActionProofError === undefined) {
    try {
      const proofs = processEvidence.snapshotPreActionProcessProofs({ selectedKernel: input.selectedKernel });
      if (!isRecord(proofs) || (proofs && typeof proofs.then === "function")) {
        throw new TypeError("Comparison trial pre-action process proofs must be captured synchronously.");
      }
      processProofs = proofs;
    } catch (error) {
      preActionProofError = error;
      controlAbort.abort("pre-action-process-proof-failed");
    }
  }

  let earlySignalError;
  if (preActionProofError !== undefined) {
    try {
      await signalSupervisor(adapter, "pre-action-process-proof-failed");
    } catch (error) {
      earlySignalError = error;
    }
  } else if (first.owner === "editor") {
    if (first.outcome.status === "rejected" || first.outcome.value?.status === "failed") {
      controlAbort.abort("editor-phase-finished-without-a-successful-notebook-receipt");
    }
  } else if (
    first.outcome.status === "rejected" ||
    (first.outcome.value?.status === "failed" && first.outcome.value.abandonedRequest === null)
  ) {
    try {
      await signalSupervisor(adapter, "trial-control-failed-before-a-retained-abandonment");
    } catch (error) {
      earlySignalError = error;
    }
  }

  const [editor, control] = await Promise.all([editorSettlement, controlSettlement]);
  let authorizationInspectionError;
  if (
    authorizationAttempted &&
    actionAuthorized &&
    (control.status === "rejected" || control.value.authorization === null)
  ) {
    try {
      inspectAuthorizationAttempt(
        control.status === "rejected"
          ? control.reason
          : new TypeError("Validated control evidence omitted the attempted authorization.")
      );
    } catch (error) {
      authorizationInspectionError = error;
    }
  }
  const completion = await adapter.waitForCompletion();
  const notebookPhaseReceipt = editor.status === "fulfilled" ? editor.value : null;
  const controlReceipt = control.status === "fulfilled" ? control.value : null;
  const retainedCacheProof =
    input.cacheState === "warm"
      ? cacheProof
      : isRecord(controlReceipt?.coldCacheProof)
        ? controlReceipt.coldCacheProof
        : null;

  const terminalEvidence = await completeTerminalEvidence({
    input,
    launchReceipt,
    supervisorCompletion: completion,
    processProofs,
    notebookPhaseReceipt,
    controlReceipt,
    cacheProof: retainedCacheProof
  });

  if (preActionProofError !== undefined) {
    if (
      authorizationAttempted ||
      actionAuthorized ||
      authorizationOutcome !== "not-attempted" ||
      (editor.status === "fulfilled" && editor.value?.status === "success") ||
      (controlReceipt !== null && controlReceipt.status !== "failed")
    ) {
      throw new AggregateError(
        [preActionProofError, earlySignalError].filter(Boolean),
        "Comparison trial pre-action process proof failed with an indeterminate product action; inspect the durable journal before any retry."
      );
    }
    return rawEvidence({
      input,
      status: "pre-action-process-proof-failure",
      notebookPhaseReceipt: null,
      controlReceipt,
      cacheProof: retainedCacheProof,
      processProofs,
      launchReceipt,
      supervisorCompletion: completion,
      terminalEvidence,
      outerEditorFailure: Object.freeze({
        status: "failed",
        classification: setupFailureClassification("pre-action-process-proof", preActionProofError)
      }),
      actionAuthorized: false,
      authorizationAttempted: false,
      authorizationOutcome: "not-attempted"
    });
  }

  if (authorizationInspectionError !== undefined) {
    throw new AggregateError(
      [authorizationInspectionError, earlySignalError].filter(Boolean),
      "Comparison trial action authorization is indeterminate; inspect the durable journal before any retry."
    );
  }

  if (control.status === "rejected") {
    if (authorizationOutcome === "indeterminate" || actionAuthorized) {
      throw new AggregateError(
        [control.reason, earlySignalError, ...(editor.status === "rejected" ? [editor.reason] : [])].filter(Boolean),
        actionAuthorized
          ? "Comparison trial authorized a product action but lost its validated control evidence; the trial must not be retried."
          : "Comparison trial action authorization is indeterminate; inspect the durable journal before any retry."
      );
    }
    throw new AggregateError(
      [control.reason, earlySignalError, ...(editor.status === "rejected" ? [editor.reason] : [])].filter(Boolean),
      "Comparison trial control failed without publishable raw evidence."
    );
  }
  if (authorizationOutcome === "indeterminate") {
    throw new AggregateError(
      [...(editor.status === "rejected" ? [editor.reason] : [])],
      "Comparison trial action authorization is indeterminate; inspect the durable journal before any retry."
    );
  }
  if (actionAuthorized && notebookPhaseReceipt === null) {
    throw new AggregateError(
      [editor.reason],
      "Comparison trial authorized a product action but lost its notebook evidence; the trial must not be retried."
    );
  }
  if (notebookPhaseReceipt === null) {
    return rawEvidence({
      input,
      notebookPhaseReceipt: null,
      controlReceipt,
      cacheProof: retainedCacheProof,
      processProofs,
      launchReceipt,
      supervisorCompletion: completion,
      terminalEvidence,
      outerEditorFailure: Object.freeze({
        status: "failed",
        classification: boundedFailureClassification(editor.reason, "editor-phase-failure")
      }),
      actionAuthorized: false,
      authorizationAttempted,
      authorizationOutcome
    });
  }
  return rawEvidence({
    input,
    notebookPhaseReceipt,
    controlReceipt,
    cacheProof: retainedCacheProof,
    processProofs,
    launchReceipt,
    supervisorCompletion: completion,
    terminalEvidence,
    outerEditorFailure: null,
    actionAuthorized,
    authorizationAttempted,
    authorizationOutcome
  });
}
