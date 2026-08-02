import {
  DATA_WRANGLER_STUDY_DEADLINES_MS,
  createEmptyStudyMilestones,
  digestStudyValue,
  validateDataWranglerStudyFragment
} from "./data-wrangler-comparison-study.mjs";
import { validateDataWranglerComparisonTrialControlReceipt } from "./data-wrangler-comparison-trial-control.mjs";
import { validateDataWranglerComparisonTrialExecutorReceipt } from "./data-wrangler-comparison-trial-executor.mjs";

const ABSOLUTE_MILESTONES = Object.freeze([
  "inlineActionNanoseconds",
  "inlineReadyNanoseconds",
  "workbenchActionNanoseconds",
  "workbenchReadyNanoseconds",
  "profileActionNanoseconds",
  "firstProfileReadyNanoseconds",
  "profilesCompleteNanoseconds"
]);
const BRIDGE_ORDER = Object.freeze([
  "source-verified",
  "cold-cache-evicted",
  "measurement-ready",
  "sampling-origin",
  "inline-baseline",
  "workbench-baseline",
  "profile-baseline",
  "sampling-stop",
  "cleanup-census"
]);
const NANOSECONDS = /^[1-9]\d{0,29}$/u;
const OUTER_FAILURE_CLASSIFICATION = /^[a-z][a-z0-9-]{0,63}$/u;

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

function exactKeys(value, expected, label) {
  requireRecord(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has missing or unknown fields.`);
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

function validateExecutorBinding(executorReceipt, input, manifest, scheduleEntry) {
  const preparedIntent = requireRecord(input.preparedIntent, "Prepared trial intent");
  const fragmentIdentity = requireRecord(input.fragmentIdentity, "Study fragment identity");
  const binding = executorReceipt.trialBinding;
  if (
    binding.preparedIntentSha256 !== digestStudyValue(preparedIntent) ||
    preparedIntent.stage !== "prepared" ||
    preparedIntent.runId !== executorReceipt.runId ||
    preparedIntent.manifestSha256 !== digestStudyValue(manifest) ||
    preparedIntent.executionIndex !== fragmentIdentity.executionIndex ||
    preparedIntent.scheduleEntryId !== scheduleEntry.id ||
    preparedIntent.attempt !== fragmentIdentity.attempt ||
    preparedIntent.effectiveBlockId !== fragmentIdentity.effectiveBlockId ||
    preparedIntent.product !== scheduleEntry.product ||
    binding.manifestSha256 !== preparedIntent.manifestSha256 ||
    binding.executionIndex !== preparedIntent.executionIndex ||
    binding.scheduleEntryId !== scheduleEntry.id ||
    binding.baseBlockId !== scheduleEntry.blockId ||
    binding.attempt !== preparedIntent.attempt ||
    binding.effectiveBlockId !== preparedIntent.effectiveBlockId ||
    binding.product !== scheduleEntry.product ||
    binding.engine !== scheduleEntry.engine ||
    binding.format !== scheduleEntry.format ||
    binding.cacheState !== scheduleEntry.kind
  ) {
    fail("The executor receipt does not match the prepared trial, schedule, and fragment identity.");
  }
}

function terminalReceipt(executorReceipt) {
  return requireRecord(executorReceipt.supervisorCompletion?.terminalReceipt, "Supervisor terminal receipt");
}

function nanoseconds(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !NANOSECONDS.test(value)) fail(`${label} is invalid.`);
  return BigInt(value);
}

function elapsedMilliseconds(value, origin, label) {
  const absolute = nanoseconds(value, label);
  if (absolute < origin) fail(`${label} predates the sampling origin.`);
  return Number(absolute - origin) / 1_000_000;
}

function fixtureForEntry(manifest, scheduleEntry) {
  const fixture = manifest.fixtures.find((candidate) => candidate.format === scheduleEntry.format);
  if (fixture === undefined) fail("The scheduled trial has no manifest fixture.");
  return fixture;
}

function bridgeExchanges(controlReceipt, phaseReceipt, scheduleEntry) {
  const retainedExchanges = controlReceipt.completedExchanges;
  if (!sameValue(retainedExchanges, phaseReceipt.controlBridge.exchanges)) {
    fail("The parent and notebook bridge exchanges do not match.");
  }
  const expectedPrefix = BRIDGE_ORDER.filter((kind) => scheduleEntry.kind === "cold" || kind !== "cold-cache-evicted");
  let previousAcknowledgement = 0n;
  const exchanges = new Map();
  retainedExchanges.forEach((exchange, index) => {
    exactKeys(exchange, ["request", "acknowledgement"], "Trial bridge exchange");
    const request = requireRecord(exchange.request, "Trial bridge request");
    const acknowledgement = requireRecord(exchange.acknowledgement, "Trial bridge acknowledgement");
    if (
      request.kind !== expectedPrefix[index] ||
      acknowledgement.kind !== request.kind ||
      request.runId !== controlReceipt.runId ||
      acknowledgement.runId !== controlReceipt.runId ||
      request.phase !== controlReceipt.phase ||
      acknowledgement.phase !== controlReceipt.phase ||
      request.sequence !== index ||
      acknowledgement.sequence !== index
    ) {
      fail("Trial bridge exchanges are stale, reordered, or do not form the expected prefix.");
    }
    const requestedAt = nanoseconds(request.monotonicNanoseconds, "Trial bridge request timestamp");
    const acknowledgedAt = nanoseconds(acknowledgement.monotonicNanoseconds, "Trial bridge acknowledgement timestamp");
    if (requestedAt < previousAcknowledgement || acknowledgedAt < requestedAt) {
      fail("Trial bridge timestamps are not monotonic.");
    }
    previousAcknowledgement = acknowledgedAt;
    exchanges.set(request.kind, { request: requestedAt, acknowledgement: acknowledgedAt });
  });
  return exchanges;
}

function authoritativeMilestones(phaseReceipt, resourceObservation, exchanges) {
  exactKeys(phaseReceipt.absoluteMilestones, ABSOLUTE_MILESTONES, "Notebook absolute milestones");
  const originExchange = exchanges.get("sampling-origin");
  const origin = nanoseconds(resourceObservation.clock.originNanoseconds, "Resource sampling origin");
  if (originExchange === undefined) {
    if (Object.values(phaseReceipt.absoluteMilestones).some((value) => value !== null)) {
      fail("A timed trial requires the sampling-origin handshake.");
    }
    return createEmptyStudyMilestones();
  }
  if (origin > originExchange.acknowledgement) {
    fail("The PSS clock starts after the acknowledged sampling origin.");
  }
  const milestones = createEmptyStudyMilestones();
  const mapping = {
    inlineActionNanoseconds: "inlineActionMs",
    inlineReadyNanoseconds: "inlineReadyMs",
    workbenchActionNanoseconds: "workbenchActionMs",
    workbenchReadyNanoseconds: "workbenchReadyMs",
    profileActionNanoseconds: "profileActionMs",
    firstProfileReadyNanoseconds: "firstProfileReadyMs",
    profilesCompleteNanoseconds: "profilesCompleteMs",
    samplingStoppedNanoseconds: "samplingStoppedMs"
  };
  for (const [absoluteKey, relativeKey] of Object.entries(mapping)) {
    const value =
      absoluteKey === "samplingStoppedNanoseconds"
        ? !exchanges.has("sampling-stop")
          ? null
          : (resourceObservation.samples.at(-1)?.endedMonotonicNanoseconds ?? null)
        : phaseReceipt.absoluteMilestones[absoluteKey];
    milestones[relativeKey] = value === null ? null : elapsedMilliseconds(value, origin, `Trial ${absoluteKey}`);
  }
  const actionBaselines = [
    ["inlineActionNanoseconds", "inline-baseline"],
    ["workbenchActionNanoseconds", "workbench-baseline"],
    ["profileActionNanoseconds", "profile-baseline"]
  ];
  for (const [actionKey, baselineKind] of actionBaselines) {
    const action = phaseReceipt.absoluteMilestones[actionKey];
    if (action === null) continue;
    const baseline = exchanges.get(baselineKind);
    if (baseline === undefined || nanoseconds(action, `Trial ${actionKey}`) <= baseline.acknowledgement) {
      fail(`Trial ${actionKey} must occur strictly after its baseline acknowledgement.`);
    }
  }
  return milestones;
}

function verifyAuthorization(controlReceipt, scheduleEntry, fragmentIdentity, milestones, exchanges, phaseReceipt) {
  const authorization = controlReceipt.authorization;
  if (milestones.inlineActionMs === null) {
    if (authorization !== null) fail("A trial without a product action cannot retain action authorization.");
    return;
  }
  exactKeys(
    authorization,
    ["runId", "scheduleEntryId", "effectiveBlockId", "publicationSha256", "publicationStatus"],
    "Trial action authorization"
  );
  if (
    authorization.runId !== controlReceipt.runId ||
    authorization.scheduleEntryId !== scheduleEntry.id ||
    authorization.effectiveBlockId !== fragmentIdentity.effectiveBlockId
  ) {
    fail("Trial action authorization does not match the scheduled attempt.");
  }
  const baseline = exchanges.get("inline-baseline");
  const action = nanoseconds(phaseReceipt.absoluteMilestones.inlineActionNanoseconds, "Trial inline action");
  if (baseline === undefined || action <= baseline.acknowledgement) {
    fail("The inline action did not follow durable authorization and its acknowledged baseline.");
  }
}

function expectedControllerFailureStage(phaseFailure) {
  return {
    "run-cell-preparation": "measurement-ready",
    "source-load": "workbench-baseline",
    inline: "workbench-baseline",
    "workbench-open": "profile-baseline",
    "grid-restoration": "profile-baseline",
    profiles: "sampling-stop",
    "after-verification": "cleanup-census"
  }[phaseFailure.stage];
}

function validateStatusAndFailureAgreement(controlReceipt, phaseReceipt) {
  if (controlReceipt.status !== phaseReceipt.status) {
    fail("The parent control and notebook phase statuses do not match.");
  }
  if (phaseReceipt.status === "success") {
    if (phaseReceipt.failure !== null || controlReceipt.failure !== null) {
      fail("A successful trial cannot retain failure evidence.");
    }
    return;
  }
  const phaseFailure = requireRecord(phaseReceipt.failure, "Notebook phase failure");
  const controlFailure = requireRecord(controlReceipt.failure, "Trial control failure");
  const expectedStage = expectedControllerFailureStage(phaseFailure);
  if (expectedStage === undefined || controlFailure.stage !== expectedStage) {
    fail("The parent control failure does not match the notebook failure boundary.");
  }
  if (
    controlReceipt.abandonedRequest !== null &&
    controlReceipt.abandonedRequest.request.kind !== controlFailure.stage
  ) {
    fail("The abandoned request does not match the failed notebook boundary.");
  }
}

function normalizedPreview() {
  return {
    headers: ["c00", "c01"],
    firstRows: [
      { rowIndex: 0, c00: 0, c01: 1 },
      { rowIndex: 1, c00: 1, c01: 2 }
    ]
  };
}

function inlineSurfaceOwner(surfaceKind) {
  if (surfaceKind === "open-wrangler-renderer") return "open-wrangler";
  if (surfaceKind === "data-wrangler-action-on-host-output") return "host-jupyter";
  fail("Inline readiness uses an unknown surface kind.");
}

function inlineEvidence(phaseReceipt, fixture, controlProfileReceiptSha256, milestones, timeoutJourney) {
  if (milestones.inlineReadyMs === null) {
    return { status: timeoutJourney === "inline-preview" ? "timed-out" : "failed" };
  }
  if (phaseReceipt.inline?.action === null || phaseReceipt.inline?.action === undefined) {
    fail("Inline readiness has no retained public action evidence.");
  }
  return {
    status: "ready",
    rowCount: fixture.rows,
    columnCount: fixture.columns,
    cellCompleted: true,
    stableFrames: 2,
    preview: normalizedPreview(),
    surfaceOwner: inlineSurfaceOwner(phaseReceipt.inline.surfaceKind),
    controlProfileReceiptSha256,
    launchActionVisible: phaseReceipt.inline.action.visible,
    launchActionPointerUsable: phaseReceipt.inline.action.pointerUsable,
    unobstructed: true
  };
}

function workbenchEvidence(phaseReceipt, fixture, milestones, timeoutJourney) {
  if (milestones.workbenchActionMs === null) return { status: "not-reached" };
  if (milestones.workbenchReadyMs === null) {
    return { status: timeoutJourney === "workbench-open" ? "timed-out" : "failed" };
  }
  const evidence = requireRecord(phaseReceipt.workbench, "Notebook workbench evidence");
  return {
    status: "ready",
    rowCount: fixture.rows,
    columnCount: fixture.columns,
    gridVisible: evidence.grid.visible,
    busy: evidence.grid.busy === "false" ? false : evidence.grid.busy === "absent" ? false : true,
    stableFrames: evidence.grid.geometryStableFrames,
    preview: normalizedPreview(),
    newlyOpenedTarget: evidence.newlySelectedProductEditor,
    targetSelected: evidence.workbench.targetEditorSelected,
    engineLabel: evidence.engineLabel,
    unobstructed:
      evidence.workbench.noVisibleQuickInput &&
      evidence.workbench.noVisibleDialog &&
      evidence.workbench.noVisibleModal &&
      evidence.workbench.rendererFramePointerUsable,
    scroll: {
      method: evidence.scroll.input === "pointer-wheel" ? "wheel" : "page-down",
      beforeC00: evidence.scroll.beforeC00,
      afterC00: evidence.scroll.afterC00,
      restoredC00: evidence.scroll.restoredC00,
      settled: evidence.scroll.firstRowsRestoredAfterTiming && evidence.scroll.pointerUsableAfterScroll
    }
  };
}

function distinctEvidence(evidence) {
  const empty = {
    count: null,
    percent: null,
    displayedPoint: null,
    displayedUnit: null,
    lowerBound: null,
    upperBound: null
  };
  if (evidence.semantics === "exact") {
    return {
      ...empty,
      semantics: "exact",
      count: evidence.count,
      percent: evidence.percent,
      includedInCorrectness: true,
      includedInSemanticEquivalence: true
    };
  }
  if (evidence.semantics === "approximate") {
    return {
      ...empty,
      semantics: "approximate",
      lowerBound: evidence.lowerBound,
      upperBound: evidence.upperBound,
      includedInCorrectness: true,
      includedInSemanticEquivalence: true
    };
  }
  return {
    ...empty,
    semantics: "approximate-unqualified",
    displayedPoint: evidence.displayedPoint,
    displayedUnit: evidence.displayedUnit,
    includedInCorrectness: false,
    includedInSemanticEquivalence: false
  };
}

function profileEvidence(phaseReceipt, fixture, milestones, timeoutJourney) {
  if (milestones.profileActionMs === null) {
    return { status: "not-reached", expectedColumnCount: fixture.columns, columns: [] };
  }
  const profiles = requireRecord(phaseReceipt.profiles, "Notebook profile evidence");
  const columns = profiles.columns.map((column, index) => ({
    name: column.column,
    type: "integer",
    missing: { semantics: "exact-count", value: column.missingCount },
    minimum: index,
    maximum: fixture.rows - 1 + index,
    distinct: distinctEvidence(column.distinct)
  }));
  return {
    status:
      milestones.profilesCompleteMs !== null
        ? "complete"
        : timeoutJourney === "complete-profile"
          ? "timed-out"
          : "failed",
    expectedColumnCount: fixture.columns,
    columns
  };
}

function timeoutForFailure(phaseReceipt, milestones) {
  if (phaseReceipt.status !== "failed" || phaseReceipt.failure?.kind !== "timeout") return null;
  const journey = {
    "source-load": "inline-preview",
    inline: "inline-preview",
    "workbench-open": "workbench-open",
    profiles: "complete-profile"
  }[phaseReceipt.failure.stage];
  if (journey === undefined) return null;
  const actionKey = {
    "inline-preview": "inlineActionMs",
    "workbench-open": "workbenchActionMs",
    "complete-profile": "profileActionMs"
  }[journey];
  if (milestones[actionKey] === null) return null;
  const deadlineMs = DATA_WRANGLER_STUDY_DEADLINES_MS[journey];
  return {
    journey,
    deadlineMs,
    observedAtMs: milestones[actionKey] + deadlineMs,
    rightCensored: { operator: ">=", valueMs: deadlineMs }
  };
}

function failureReason(phaseReceipt, timeout) {
  if (timeout !== null) return "timeout";
  return {
    "run-cell-preparation": "setup",
    "source-load": "fixture",
    inline: "obstruction",
    "workbench-open": "obstruction",
    "grid-restoration": "correctness",
    profiles: "correctness",
    "after-verification": "correctness"
  }[phaseReceipt.failure.stage];
}

function outcomeForPhase(phaseReceipt, milestones, resourceObservation, cleanupProof) {
  if (phaseReceipt.status === "success") {
    if (!resourceObservation.valid)
      return {
        status: "product-failure",
        reasonClass: "resource-sampling",
        actionStarted: true,
        correctness: "passed",
        timeout: null,
        unsupported: null
      };
    if (cleanupProof.status !== "complete")
      return {
        status: "product-failure",
        reasonClass: "cleanup",
        actionStarted: true,
        correctness: "passed",
        timeout: null,
        unsupported: null
      };
    return {
      status: "success",
      reasonClass: null,
      actionStarted: true,
      correctness: "passed",
      timeout: null,
      unsupported: null
    };
  }
  const actionStarted = milestones.inlineActionMs !== null;
  const timeout = timeoutForFailure(phaseReceipt, milestones);
  const reasonClass = failureReason(phaseReceipt, timeout);
  return {
    status: actionStarted ? "product-failure" : "pre-action-invalid",
    reasonClass,
    actionStarted,
    correctness: reasonClass === "correctness" ? "failed" : "not-reached",
    timeout,
    unsupported: null
  };
}

function sourceLoadForPhase(phaseReceipt) {
  return {
    status: phaseReceipt.sourceLoad.status,
    durationMs: phaseReceipt.sourceLoad.durationMs,
    includedInInlineTiming: phaseReceipt.sourceLoad.includedInInlineTiming
  };
}

function validateControlBinding(controlReceipt, scheduleEntry, phaseReceipt, cacheProof) {
  const firstExchange = phaseReceipt.controlBridge.exchanges[0];
  if (
    firstExchange === undefined ||
    controlReceipt.runId !== firstExchange.request.runId ||
    controlReceipt.phase !== firstExchange.request.phase ||
    controlReceipt.cacheState !== scheduleEntry.kind
  ) {
    fail("The parent control receipt does not match the notebook trial and scheduled cache state.");
  }
  const expectedBoundary =
    scheduleEntry.kind === "cold" ? "run-cell-pointer-to-cell-completion" : "setup-cell-start-to-completion";
  if (
    phaseReceipt.sourceLoad.includedInInlineTiming !== (scheduleEntry.kind === "cold") ||
    phaseReceipt.sourceLoad.measurementBoundary !== expectedBoundary
  ) {
    fail("The notebook source-load boundary does not match the scheduled warm or cold trial.");
  }
  if (scheduleEntry.kind === "cold") {
    const cacheEvictionCompleted = controlReceipt.completedExchanges.some(
      (exchange) => exchange.request.kind === "cold-cache-evicted"
    );
    if (cacheEvictionCompleted && !sameValue(controlReceipt.coldCacheProof, cacheProof)) {
      fail("The cold-cache control proof does not match the fragment cache proof.");
    }
  } else if (controlReceipt.coldCacheProof !== null) {
    fail("A warm trial cannot retain a cold-cache control receipt.");
  }
}

function sourceReceiptForPhase(sourceVerificationReceipt, phaseReceipt) {
  const receipt = structuredClone(sourceVerificationReceipt);
  if (phaseReceipt.verification.after === null || phaseReceipt.finalization.afterVerification !== "matched") {
    receipt.sentinelsAfter = null;
    receipt.filesystemIdentityAfter = null;
    receipt.observedAfterTrial = "not-reached";
  }
  return receipt;
}

/**
 * Combines already validated trial receipts. It performs no I/O and does not
 * repair missing evidence. The returned value is accepted only after the study
 * fragment validator checks the complete manifest-bound contract.
 */
export function normalizeDataWranglerComparisonTrialFragment(
  input,
  {
    validateControlReceipt = validateDataWranglerComparisonTrialControlReceipt,
    validateExecutorReceipt = validateDataWranglerComparisonTrialExecutorReceipt,
    validateFragment = validateDataWranglerStudyFragment
  } = {}
) {
  const manifest = requireRecord(input.manifest, "Study manifest");
  const scheduleEntry = requireRecord(input.scheduleEntry, "Study schedule entry");
  const executorReceipt = validateExecutorReceipt(requireRecord(input.executorReceipt, "Trial executor receipt"), {
    validateControlReceipt
  });
  if (executorReceipt.status !== "evidence") {
    fail("The main trial normalizer requires executor evidence with a notebook receipt.");
  }
  validateExecutorBinding(executorReceipt, input, manifest, scheduleEntry);
  const phaseReceipt = requireRecord(executorReceipt.notebookPhaseReceipt, "Notebook phase receipt");
  const controlReceipt = requireRecord(executorReceipt.controlReceipt, "Trial control receipt");
  if (
    phaseReceipt.product !== scheduleEntry.product ||
    phaseReceipt.study.engine !== scheduleEntry.engine ||
    phaseReceipt.study.format !== scheduleEntry.format ||
    phaseReceipt.study.kind !== scheduleEntry.kind
  ) {
    fail("Notebook phase evidence does not match the scheduled trial.");
  }
  validateStatusAndFailureAgreement(controlReceipt, phaseReceipt);
  validateControlBinding(controlReceipt, scheduleEntry, phaseReceipt, executorReceipt.cacheProof);
  const resourceObservation = requireRecord(controlReceipt.resourceObservation, "Trial resource observation");
  if (!sameValue(controlReceipt.resourceObservation, resourceObservation)) {
    fail("The supplied PSS observation does not match the parent control receipt.");
  }
  const exchanges = bridgeExchanges(controlReceipt, phaseReceipt, scheduleEntry);
  const milestones = authoritativeMilestones(phaseReceipt, resourceObservation, exchanges);
  verifyAuthorization(controlReceipt, scheduleEntry, input.fragmentIdentity, milestones, exchanges, phaseReceipt);
  if (!sameValue(executorReceipt.launchReceipt, resourceObservation.ownershipTracker)) {
    fail("Resource sampling is not bound to the supervisor launch receipt.");
  }
  const terminalEvidence = requireRecord(executorReceipt.terminalEvidence, "Trial terminal evidence");
  const cleanupProof = requireRecord(terminalEvidence.cleanupProof, "Trial cleanup proof");
  if (!sameValue(terminalReceipt(executorReceipt), cleanupProof.supervisorTerminalReceipt)) {
    fail("Cleanup is not bound to the supervisor terminal receipt.");
  }
  const timeout = timeoutForFailure(phaseReceipt, milestones);
  const fixture = fixtureForEntry(manifest, scheduleEntry);
  const actionStarted = milestones.inlineActionMs !== null;
  const sourceReceipt = actionStarted ? sourceReceiptForPhase(input.sourceVerificationReceipt, phaseReceipt) : null;
  const workbenchEngine =
    milestones.workbenchReadyMs === null || phaseReceipt.workbench?.engineLabel === "not-shown"
      ? "unverified"
      : phaseReceipt.workbench.engineLabel;
  const fragment = {
    ...structuredClone(input.fragmentIdentity),
    outcome: outcomeForPhase(phaseReceipt, milestones, resourceObservation, cleanupProof),
    milestones,
    cacheProof: structuredClone(executorReceipt.cacheProof),
    sourceLoad: sourceLoadForPhase(phaseReceipt),
    engineEvidence: actionStarted
      ? {
          sourceEngine: scheduleEntry.engine,
          sourceVerification: {
            method: "visible-notebook-runtime",
            receiptSha256: digestStudyValue(sourceReceipt),
            receipt: sourceReceipt
          },
          workbenchEngine,
          workbenchVerification: workbenchEngine === "unverified" ? "not-observed" : "public-ui"
        }
      : null,
    environmentGate: structuredClone(input.environmentGate),
    uiEvidence: actionStarted
      ? {
          inline: inlineEvidence(
            phaseReceipt,
            fixture,
            manifest.provenance.controlProfile.receiptSha256,
            milestones,
            timeout?.journey ?? null
          ),
          workbench: workbenchEvidence(phaseReceipt, fixture, milestones, timeout?.journey ?? null),
          profiles: profileEvidence(phaseReceipt, fixture, milestones, timeout?.journey ?? null)
        }
      : null,
    processProofs: structuredClone(executorReceipt.processProofs),
    resourceObservation: structuredClone(resourceObservation),
    cleanupProof: structuredClone(cleanupProof),
    trialProvenance: structuredClone(terminalEvidence.trialProvenance)
  };
  return validateFragment(fragment, manifest);
}

function preNotebookFailureReason(classification, controlReceipt) {
  if (classification === "cleanup-failure") return "cleanup";
  if (
    ["sampler-invalid", "collector-mismatch", "clock-mismatch", "resource-sampling"].includes(
      controlReceipt.failure.kind
    )
  ) {
    return "resource-sampling";
  }
  return "setup";
}

function setupFailureReason(classification) {
  if (classification.startsWith("resource-sampler-")) return "resource-sampling";
  if (classification.startsWith("process-evidence-")) return "setup";
  fail("The post-launch setup failure classification has an unknown boundary.");
}

function validateOuterFailure(executorReceipt) {
  const outerFailure = requireRecord(executorReceipt.outerEditorFailure, "Outer editor failure");
  exactKeys(outerFailure, ["status", "classification"], "Outer editor failure");
  if (
    outerFailure.status !== "failed" ||
    typeof outerFailure.classification !== "string" ||
    !OUTER_FAILURE_CLASSIFICATION.test(outerFailure.classification)
  ) {
    fail("The outer editor failure classification is invalid.");
  }
  return outerFailure;
}

function validatePreNotebookControlReceipt(controlReceipt) {
  if (controlReceipt.status !== "failed" || controlReceipt.failure === null) {
    fail("A pre-notebook fragment requires a failed trial control receipt.");
  }
  if (controlReceipt.authorization !== null) {
    fail("A pre-notebook failure cannot retain product-action authorization.");
  }
  if (controlReceipt.completedExchanges.some((exchange) => exchange.request.kind === "inline-baseline")) {
    fail("A pre-notebook failure cannot follow an acknowledged product-action fence.");
  }
  if (controlReceipt.abandonedRequest?.request.kind === "sampling-stop") {
    fail("A pre-notebook failure cannot retain an ambiguous started action.");
  }
  const sequence =
    controlReceipt.cacheState === "cold" ? BRIDGE_ORDER : BRIDGE_ORDER.filter((kind) => kind !== "cold-cache-evicted");
  const expectedStage = sequence[controlReceipt.completedExchanges.length];
  if (expectedStage === undefined || controlReceipt.failure.stage !== expectedStage) {
    fail("A pre-notebook control failure must identify the next expected bridge request.");
  }
}

/**
 * Records an editor failure that happened after launch but before the notebook
 * phase could publish a receipt. It carries no reconstructed notebook or UI
 * evidence; only independently retained controller, process, and cleanup
 * receipts cross this boundary.
 */
export function normalizeDataWranglerComparisonPreNotebookFailureFragment(
  input,
  {
    validateControlReceipt = validateDataWranglerComparisonTrialControlReceipt,
    validateExecutorReceipt = validateDataWranglerComparisonTrialExecutorReceipt,
    validateFragment = validateDataWranglerStudyFragment
  } = {}
) {
  const manifest = requireRecord(input.manifest, "Study manifest");
  const scheduleEntry = requireRecord(input.scheduleEntry, "Study schedule entry");
  const executorReceipt = validateExecutorReceipt(requireRecord(input.executorReceipt, "Trial executor receipt"), {
    validateControlReceipt
  });
  if (executorReceipt.status !== "pre-notebook-failure") {
    fail("The pre-notebook normalizer requires a matching executor failure receipt.");
  }
  validateExecutorBinding(executorReceipt, input, manifest, scheduleEntry);
  const outerFailure = validateOuterFailure(executorReceipt);
  const controlReceipt = requireRecord(executorReceipt.controlReceipt, "Trial control receipt");
  validatePreNotebookControlReceipt(controlReceipt);
  if (controlReceipt.cacheState !== scheduleEntry.kind) {
    fail("The failed trial control receipt does not match the scheduled cache state.");
  }
  if (scheduleEntry.kind === "cold") {
    const cacheEvictionCompleted = controlReceipt.completedExchanges.some(
      (exchange) => exchange.request.kind === "cold-cache-evicted"
    );
    if (!cacheEvictionCompleted) {
      fail("A launched cold failure without verified cache eviction cannot be published by the current study schema.");
    }
    if (!sameValue(controlReceipt.coldCacheProof, executorReceipt.cacheProof)) {
      fail("The cold-cache control proof does not match the pre-notebook fragment cache proof.");
    }
  }
  const resourceObservation = requireRecord(controlReceipt.resourceObservation, "Trial resource observation");
  const terminalEvidence = requireRecord(executorReceipt.terminalEvidence, "Trial terminal evidence");
  const cleanupProof = requireRecord(terminalEvidence.cleanupProof, "Trial cleanup proof");
  if (!sameValue(controlReceipt.resourceObservation, resourceObservation)) {
    fail("The supplied PSS observation does not match the failed trial control receipt.");
  }
  if (!sameValue(executorReceipt.launchReceipt, resourceObservation.ownershipTracker)) {
    fail("Resource sampling is not bound to the supervisor launch receipt.");
  }
  if (!sameValue(terminalReceipt(executorReceipt), cleanupProof.supervisorTerminalReceipt)) {
    fail("Cleanup is not bound to the supervisor terminal receipt.");
  }
  const fragment = {
    ...structuredClone(input.fragmentIdentity),
    outcome: {
      status: "pre-action-invalid",
      reasonClass: preNotebookFailureReason(outerFailure.classification, controlReceipt),
      actionStarted: false,
      correctness: "not-reached",
      timeout: null,
      unsupported: null
    },
    milestones: createEmptyStudyMilestones(),
    cacheProof: structuredClone(executorReceipt.cacheProof),
    sourceLoad: {
      status: "not-reached",
      durationMs: null,
      includedInInlineTiming: scheduleEntry.kind === "cold"
    },
    engineEvidence: null,
    environmentGate: structuredClone(input.environmentGate),
    uiEvidence: null,
    processProofs: structuredClone(executorReceipt.processProofs),
    resourceObservation: structuredClone(resourceObservation),
    cleanupProof: structuredClone(cleanupProof),
    trialProvenance: structuredClone(terminalEvidence.trialProvenance)
  };
  return validateFragment(fragment, manifest);
}

/**
 * Records a launch that failed before the controller or sampler could retain
 * an observation. The supervisor launch and terminal receipts still identify
 * the editor tree; no resource sample or kernel identity is reconstructed.
 */
export function normalizeDataWranglerComparisonPostLaunchSetupFailureFragment(
  input,
  {
    validateControlReceipt = validateDataWranglerComparisonTrialControlReceipt,
    validateExecutorReceipt = validateDataWranglerComparisonTrialExecutorReceipt,
    validateFragment = validateDataWranglerStudyFragment
  } = {}
) {
  const manifest = requireRecord(input.manifest, "Study manifest");
  const scheduleEntry = requireRecord(input.scheduleEntry, "Study schedule entry");
  const executorReceipt = validateExecutorReceipt(requireRecord(input.executorReceipt, "Trial executor receipt"), {
    validateControlReceipt
  });
  if (executorReceipt.status !== "post-launch-setup-failure") {
    fail("The post-launch setup normalizer requires its matching executor failure receipt.");
  }
  validateExecutorBinding(executorReceipt, input, manifest, scheduleEntry);
  const outerFailure = validateOuterFailure(executorReceipt);
  if (
    executorReceipt.controlReceipt !== null ||
    executorReceipt.authorizationAttempted ||
    executorReceipt.authorizationOutcome !== "not-attempted" ||
    executorReceipt.actionAuthorized
  ) {
    fail("A post-launch setup failure cannot follow action authorization or controller evidence.");
  }
  const processProofs = requireRecord(executorReceipt.processProofs, "Launch process proofs");
  exactKeys(processProofs, ["editorRoot", "configuredKernel", "openWranglerRuntime"], "Launch process proofs");
  if (processProofs.configuredKernel !== null || processProofs.openWranglerRuntime !== null) {
    fail("A post-launch setup failure cannot claim a kernel or product runtime.");
  }
  if (scheduleEntry.kind === "warm" && executorReceipt.cacheProof === null) {
    fail("A warm launched setup failure requires its completed source-cache proof.");
  }
  if (scheduleEntry.kind === "cold" && executorReceipt.cacheProof !== null) {
    fail("A cold launched setup failure cannot claim cache eviction before its controller starts.");
  }
  const terminalEvidence = requireRecord(executorReceipt.terminalEvidence, "Trial terminal evidence");
  const retainedCleanupProof = requireRecord(terminalEvidence.cleanupProof, "Trial cleanup proof");
  if (!sameValue(terminalReceipt(executorReceipt), retainedCleanupProof.supervisorTerminalReceipt)) {
    fail("Cleanup is not bound to the supervisor terminal receipt.");
  }
  const cleanupProof = {
    ...structuredClone(retainedCleanupProof),
    supervisorLaunchReceipt: structuredClone(executorReceipt.launchReceipt)
  };
  const fragment = {
    ...structuredClone(input.fragmentIdentity),
    outcome: {
      status: "pre-action-invalid",
      reasonClass: setupFailureReason(outerFailure.classification),
      actionStarted: false,
      correctness: "not-reached",
      timeout: null,
      unsupported: null
    },
    milestones: createEmptyStudyMilestones(),
    cacheProof: structuredClone(executorReceipt.cacheProof),
    sourceLoad: {
      status: "not-reached",
      durationMs: null,
      includedInInlineTiming: scheduleEntry.kind === "cold"
    },
    engineEvidence: null,
    environmentGate: structuredClone(input.environmentGate),
    uiEvidence: null,
    processProofs: structuredClone(processProofs),
    resourceObservation: null,
    cleanupProof,
    trialProvenance: structuredClone(terminalEvidence.trialProvenance)
  };
  return validateFragment(fragment, manifest);
}
