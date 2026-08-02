import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  DATA_WRANGLER_STUDY_COMMON_EXTENSIONS,
  DATA_WRANGLER_STUDY_DEADLINES_MS,
  DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
  DATA_WRANGLER_STUDY_PRODUCTS,
  buildDataWranglerStudyManifest,
  createStudyFragmentIdentity,
  digestStudyValue,
  validateDataWranglerStudyFragment
} from "./data-wrangler-comparison-study.mjs";
import {
  DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND,
  NEITHER_PRODUCT_CONTROL_RECEIPT_KIND,
  PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
  PUBLIC_UI_DATA_WRANGLER_ACTION_NAME,
  PUBLIC_UI_OBSERVATION_MAX_GAP_MS,
  PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME,
  createDataWranglerPolarsCapabilityReceipt,
  createExpectedPublicUiExtensionInventory,
  createNeitherProductControlReceipt,
  createPublicUiReceiptContext
} from "./data-wrangler-public-ui-receipts.mjs";
import {
  DATA_WRANGLER_COMPARISON_TRIAL_CONTROL_PROTOCOL,
  validateDataWranglerComparisonTrialControlReceipt
} from "./data-wrangler-comparison-trial-control.mjs";
import {
  DATA_WRANGLER_COMPARISON_TRIAL_EXECUTOR_PROTOCOL,
  executeDataWranglerComparisonTrial
} from "./data-wrangler-comparison-trial-executor.mjs";
import {
  normalizeDataWranglerComparisonPostLaunchSetupFailureFragment,
  normalizeDataWranglerComparisonPreNotebookFailureFragment,
  normalizeDataWranglerComparisonTrialFragment
} from "./data-wrangler-comparison-trial-fragment.mjs";

const ORIGIN = 1_000_000_000_000n;
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const PHASE = "comparison-study-open-wrangler-trial";
const ABSOLUTE_KEYS = [
  "inlineActionNanoseconds",
  "inlineReadyNanoseconds",
  "workbenchActionNanoseconds",
  "workbenchReadyNanoseconds",
  "profileActionNanoseconds",
  "firstProfileReadyNanoseconds",
  "profilesCompleteNanoseconds"
];

// The study module already has extensive manifest and Linux receipt fixtures.
// Reuse that fixture tail here so this test exercises the public fragment
// validator instead of maintaining a weaker second validator.
function loadStudyFixtures() {
  const source = readFileSync(resolve("scripts/data-wrangler-comparison-study.test.mjs"), "utf8");
  const start = source.indexOf("function studyFixture(");
  assert.notEqual(start, -1);
  const context = {
    assert,
    digestStudyValue,
    buildDataWranglerStudyManifest,
    DATA_WRANGLER_STUDY_COMMON_EXTENSIONS,
    DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
    DATA_WRANGLER_STUDY_PRODUCTS,
    DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND,
    NEITHER_PRODUCT_CONTROL_RECEIPT_KIND,
    PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
    PUBLIC_UI_DATA_WRANGLER_ACTION_NAME,
    PUBLIC_UI_OBSERVATION_MAX_GAP_MS,
    PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME,
    createDataWranglerPolarsCapabilityReceipt,
    createExpectedPublicUiExtensionInventory,
    createNeitherProductControlReceipt,
    createPublicUiReceiptContext
  };
  const fixtureSource = `const { ${Object.keys(context).join(", ")} } = globalThis.__fixtureDeps;\nconst digest = (value) => value.repeat(64);\n${source.slice(start)}\n;globalThis.__studyFixtures = { studyManifest, studyEnvironmentGate, studyCacheProof, studyProcessProofs, studyTrialProvenance, studyCleanupProof, studyResourceObservation, studyEngineEvidence, fixtureForEntry, pssMonotonicNanoseconds };`;
  globalThis.__fixtureDeps = context;
  try {
    vm.runInThisContext(fixtureSource, { filename: "study-fragment-test-fixtures.mjs" });
    return globalThis.__studyFixtures;
  } finally {
    delete globalThis.__studyFixtures;
    delete globalThis.__fixtureDeps;
  }
}

const fixtures = loadStudyFixtures();

function atMs(milliseconds) {
  return (ORIGIN + BigInt(milliseconds) * 1_000_000n).toString();
}

function action(name, role = "button") {
  return {
    role,
    accessibleName: name,
    exactNameMatched: true,
    visible: true,
    enabled: true,
    pointerUsable: true,
    stableFrames: 2
  };
}

function verification(phase, kind) {
  return {
    phase,
    pythonImplementation: "CPython",
    pythonVersion: "3.12.10",
    classMatched: true,
    shapeMatched: true,
    columnsMatched: true,
    integerDtypeMatched: true,
    sentinelsMatched: true,
    objectTokenContinuous: kind === "warm" ? true : null,
    rowDataIncluded: false
  };
}

function bridgeExchange(kind, sequence, requestMs, acknowledgementMs) {
  const envelope = (protocol, monotonicNanoseconds) => ({
    protocol,
    runId: RUN_ID,
    phase: PHASE,
    sequence,
    kind,
    monotonicNanoseconds
  });
  return {
    request: envelope("openwrangler-data-wrangler-study-bridge-request-v1", atMs(requestMs)),
    acknowledgement: envelope("openwrangler-data-wrangler-study-bridge-ack-v1", atMs(acknowledgementMs))
  };
}

function bridgeFor(kind, stoppedMs, failureStage = null) {
  const plan = [["source-verified", -900, -899]];
  if (kind === "cold") plan.push(["cold-cache-evicted", -850, -849]);
  if (failureStage !== "run-cell-preparation") plan.push(["measurement-ready", -800, -799]);
  if (failureStage !== "run-cell-preparation") {
    plan.push(["sampling-origin", -1, 0], ["inline-baseline", 100, 803]);
  }
  if (!["run-cell-preparation", "source-load", "inline"].includes(failureStage)) {
    plan.push(["workbench-baseline", 1_500, 1_603]);
  }
  if (!["run-cell-preparation", "source-load", "inline", "workbench-open", "grid-restoration"].includes(failureStage)) {
    plan.push(["profile-baseline", 2_500, 2_603]);
  }
  if (failureStage === null) {
    plan.push(["sampling-stop", 3_030, stoppedMs], ["cleanup-census", stoppedMs + 1, stoppedMs + 2]);
  }
  return plan.map(([bridgeKind, request, acknowledgement], index) =>
    bridgeExchange(bridgeKind, index, request, acknowledgement)
  );
}

function stableBaselineReceipt(exchange, resourceObservation) {
  const requestTime = BigInt(exchange.request.monotonicNanoseconds);
  const firstEligible = resourceObservation.samples.findIndex(
    (sample) => BigInt(sample.endedMonotonicNanoseconds) >= requestTime
  );
  const lastSampleIndex = Math.max(4, firstEligible);
  const firstSampleIndex = lastSampleIndex - 4;
  const samples = resourceObservation.samples.slice(firstSampleIndex, lastSampleIndex + 1);
  const sample = samples.at(-1);
  const totals = samples.map((candidate) => candidate.totalPssBytes);
  const medianPssBytes = [...totals].sort((left, right) => left - right)[2];
  return {
    protocol: "openwrangler-linux-pss-baseline-ack-v1",
    sampleIndex: lastSampleIndex,
    sampleElapsedMs: sample.elapsedMs,
    sampleScheduledMonotonicNanoseconds: sample.scheduledMonotonicNanoseconds,
    sampleStartedMonotonicNanoseconds: sample.startedMonotonicNanoseconds,
    sampleEndedMonotonicNanoseconds: sample.endedMonotonicNanoseconds,
    stableBaseline: {
      sampleCount: 5,
      firstSampleIndex,
      lastSampleIndex,
      firstStartedMonotonicNanoseconds: samples[0].startedMonotonicNanoseconds,
      lastEndedMonotonicNanoseconds: sample.endedMonotonicNanoseconds,
      medianPssBytes,
      rangePssBytes: Math.max(...totals) - Math.min(...totals),
      maximumRangePssBytes: Math.max(64 * 1024 * 1024, medianPssBytes * 0.05)
    }
  };
}

function controlFailureStage(phaseFailureStage) {
  return {
    "run-cell-preparation": "measurement-ready",
    "source-load": "workbench-baseline",
    inline: "workbench-baseline",
    "workbench-open": "profile-baseline",
    "grid-restoration": "profile-baseline",
    profiles: "sampling-stop",
    "after-verification": "cleanup-census"
  }[phaseFailureStage];
}

function parentControlReceipt({ entry, fragmentIdentity, exchanges, resourceObservation, phaseReceipt, cacheProof }) {
  const byKind = new Map(exchanges.map((exchange) => [exchange.request.kind, exchange]));
  const baseline = (kind) => {
    const exchange = byKind.get(kind);
    return exchange === undefined
      ? null
      : {
          request: exchange.request,
          acknowledgement: exchange.acknowledgement,
          receipt: stableBaselineReceipt(exchange, resourceObservation)
        };
  };
  const authorization = byKind.has("inline-baseline")
    ? {
        runId: RUN_ID,
        scheduleEntryId: entry.id,
        effectiveBlockId: fragmentIdentity.effectiveBlockId,
        publicationSha256: "a".repeat(64),
        publicationStatus: "published"
      }
    : null;
  const samplingStopExchange = byKind.get("sampling-stop");
  return {
    protocol: DATA_WRANGLER_COMPARISON_TRIAL_CONTROL_PROTOCOL,
    status: phaseReceipt.status,
    runId: RUN_ID,
    phase: PHASE,
    cacheState: entry.kind,
    failure:
      phaseReceipt.status === "success"
        ? null
        : { stage: controlFailureStage(phaseReceipt.failure.stage), kind: "aborted" },
    completedExchanges: exchanges,
    pendingRequest: null,
    abandonedRequest: null,
    coldCacheProof: entry.kind === "cold" && byKind.has("cold-cache-evicted") ? structuredClone(cacheProof) : null,
    baselines: {
      inline: baseline("inline-baseline"),
      workbench: baseline("workbench-baseline"),
      profile: baseline("profile-baseline")
    },
    authorization,
    samplingStop:
      samplingStopExchange === undefined
        ? null
        : {
            request: samplingStopExchange.request,
            acknowledgement: samplingStopExchange.acknowledgement,
            terminalTargetMonotonicNanoseconds: resourceObservation.terminalBoundary.targetMonotonicNanoseconds
          },
    resourceObservation
  };
}

function profileColumns(count, rows, distinct = "exact") {
  return [...Array(count).keys()].map((index) => ({
    column: `c${String(index).padStart(2, "0")}`,
    type: "signed-64-bit",
    missingCount: 0,
    minimumMatched: true,
    maximumMatched: true,
    distinct:
      distinct === "exact"
        ? { semantics: "exact", count: rows, percent: 100 }
        : { semantics: "approximate", lowerBound: rows - 10, upperBound: rows },
    rowValuesIncluded: false
  }));
}

function absoluteMilestones(values) {
  return Object.fromEntries(ABSOLUTE_KEYS.map((key) => [key, values[key] === null ? null : atMs(values[key])]));
}

function phaseReceipt({ entry, fixture, status = "success", failure = null, values, profileCount = fixture.columns }) {
  const absolute = absoluteMilestones(values);
  const inlineReady = values.inlineReadyNanoseconds !== null;
  const workbenchReady = values.workbenchReadyNanoseconds !== null;
  const profileStarted = values.profileActionNanoseconds !== null;
  const exchanges = bridgeFor(entry.kind, values.samplingStoppedMs, failure?.stage ?? null);
  return {
    protocol: "openwrangler-data-wrangler-notebook-trial-phase-v1",
    locale: "en",
    product: entry.product,
    status,
    failure,
    study: {
      engine: entry.engine,
      format: entry.format,
      kind: entry.kind,
      fixture: { id: fixture.id, sha256: fixture.sha256, rows: fixture.rows, columns: fixture.columns },
      kernel: { name: "openwrangler-study-python", displayName: "Open Wrangler CPython 3.12" },
      pythonImplementation: "CPython",
      pythonVersion: "3.12.10"
    },
    verification: {
      before: verification("before-timing", entry.kind),
      after: verification("after-workbench", entry.kind)
    },
    sourceLoad: {
      status: failure?.stage === "source-load" ? "failed" : "measured",
      durationMs: failure?.stage === "source-load" ? null : 5,
      includedInInlineTiming: entry.kind === "cold",
      measurementBoundary:
        entry.kind === "cold" ? "run-cell-pointer-to-cell-completion" : "setup-cell-start-to-completion"
    },
    inline:
      values.inlineActionNanoseconds === null
        ? null
        : {
            evidenceWindowMs: 45_000,
            baselineExactActionCount: 0,
            genericHostHtmlAcceptedAsProductPreview: false,
            runCellAction: action("Execute Cell"),
            surfaceKind: inlineReady
              ? entry.product === "open-wrangler"
                ? "open-wrangler-renderer"
                : "data-wrangler-action-on-host-output"
              : null,
            action: inlineReady
              ? action(
                  entry.product === "open-wrangler" ? "Open in Open Wrangler" : 'Open "study_frame" in Data Wrangler'
                )
              : null,
            sentinelsVisibleWithAction: inlineReady
          },
    workbench: workbenchReady
      ? {
          action: action(
            entry.product === "open-wrangler" ? "Open in Open Wrangler" : 'Open "study_frame" in Data Wrangler'
          ),
          newlySelectedProductEditor: true,
          grid: {
            rootRole: "grid",
            busy: "false",
            visible: true,
            pointerUsable: true,
            geometryStableFrames: 2,
            headers: ["c00", "c01"],
            sentinelsMatched: true,
            ariaRowCount: fixture.rows,
            ariaColumnCount: fixture.columns
          },
          workbench: {
            targetEditorSelected: true,
            noVisibleQuickInput: true,
            noVisibleDialog: true,
            noVisibleModal: true,
            rendererFramePointerUsable: true
          },
          fullShape: "aria-counts",
          engineLabel: entry.product === "data-wrangler" ? "not-shown" : entry.engine,
          scroll: {
            input: "pointer-wheel",
            verticalWindowChanged: true,
            horizontalWindowChanged: true,
            beforeC00: 0,
            afterC00: 50,
            restoredC00: 0,
            stableFrames: 2,
            pointerUsableAfterScroll: true,
            firstRowsRestoredAfterTiming: true
          }
        }
      : null,
    profiles: profileStarted
      ? {
          action: action(
            entry.product === "open-wrangler" ? "Column profiles and filters" : "c00 integer",
            entry.product === "open-wrangler" ? "button" : "columnheader"
          ),
          firstUsefulColumn: "c00",
          expectedColumnCount: fixture.columns,
          completedColumnCount: profileCount,
          canonicalOrder: true,
          rowValuesIncluded: false,
          columns: profileColumns(
            profileCount,
            fixture.rows,
            entry.product === "data-wrangler" ? "approximate" : "exact"
          )
        }
      : null,
    clock: {
      kind: "driver-local-performance-time-origin",
      timeOriginUnixMs: 1_800_000_000_000,
      authoritativeForStudy: false
    },
    controlBridge: {
      clock: "process-hrtime-bigint",
      authoritativeForStudy: true,
      requestProtocol: "openwrangler-data-wrangler-study-bridge-request-v1",
      acknowledgementProtocol: "openwrangler-data-wrangler-study-bridge-ack-v1",
      exchanges
    },
    finalization: { closeAttempted: true, closeStatus: "succeeded", afterVerification: "matched" },
    milestones: Object.fromEntries(ABSOLUTE_KEYS.map((key) => [key.replace("Nanoseconds", "Ms"), values[key]])),
    absoluteMilestones: absolute
  };
}

function preparedIntent(manifest, entry, fragmentIdentity) {
  return {
    protocol: "openwrangler-data-wrangler-study-trial-intent-v1",
    stage: "prepared",
    runId: RUN_ID,
    manifestSha256: digestStudyValue(manifest),
    executionIndex: fragmentIdentity.executionIndex,
    scheduleEntryId: entry.id,
    attempt: fragmentIdentity.attempt,
    effectiveBlockId: fragmentIdentity.effectiveBlockId,
    product: entry.product,
    ledgerSha256: "b".repeat(64),
    preparedAtUtc: "2026-08-02T10:59:00.000Z"
  };
}

function executorReceipt({
  entry,
  prepared,
  phase,
  control,
  cacheProof,
  processProofs,
  launchReceipt,
  terminalReceipt,
  cleanupProof,
  trialProvenance,
  outerEditorFailure = null
}) {
  const actionAuthorized = control.authorization !== null;
  return {
    protocol: DATA_WRANGLER_COMPARISON_TRIAL_EXECUTOR_PROTOCOL,
    status: phase === null ? "pre-notebook-failure" : "evidence",
    runId: RUN_ID,
    phase: PHASE,
    cacheState: entry.kind,
    product: entry.product,
    trialBinding: {
      preparedIntentSha256: digestStudyValue(prepared),
      manifestSha256: prepared.manifestSha256,
      executionIndex: prepared.executionIndex,
      scheduleEntryId: entry.id,
      baseBlockId: entry.blockId,
      attempt: prepared.attempt,
      effectiveBlockId: prepared.effectiveBlockId,
      product: entry.product,
      engine: entry.engine,
      format: entry.format,
      cacheState: entry.kind
    },
    actionAuthorized,
    authorizationAttempted: actionAuthorized,
    authorizationOutcome: actionAuthorized ? "authorized" : "not-attempted",
    notebookPhaseReceipt: phase,
    controlReceipt: control,
    cacheProof,
    processProofs,
    launchReceipt,
    supervisorCompletion: {
      launchReceipt,
      terminalReceipt,
      exit: { code: 0, signal: null, error: undefined }
    },
    terminalEvidence: { cleanupProof, trialProvenance },
    outerEditorFailure
  };
}

function trialInput({
  product = "open-wrangler",
  kind = "warm",
  failure = null,
  profileCount,
  malformedActionMs
} = {}) {
  const manifest = fixtures.studyManifest();
  const entry = manifest.schedule.find(
    (candidate) =>
      candidate.product === product &&
      candidate.engine === "pandas" &&
      candidate.format === "csv" &&
      candidate.kind === kind
  );
  const fixture = fixtures.fixtureForEntry(manifest, entry);
  const actionStarted = failure?.stage !== "run-cell-preparation";
  const inlineReady = actionStarted && !["source-load", "inline"].includes(failure?.stage);
  const workbenchAction = inlineReady;
  const workbenchReady = workbenchAction && !["workbench-open"].includes(failure?.stage);
  const profileAction = workbenchReady && !["grid-restoration"].includes(failure?.stage);
  const profilesComplete = profileAction && failure?.stage !== "profiles";
  const values = {
    inlineActionNanoseconds: actionStarted ? (malformedActionMs ?? 1_000) : null,
    inlineReadyNanoseconds: inlineReady ? 1_010 : null,
    workbenchActionNanoseconds: workbenchAction ? 2_000 : null,
    workbenchReadyNanoseconds: workbenchReady ? 2_010 : null,
    profileActionNanoseconds: profileAction ? 3_000 : null,
    firstProfileReadyNanoseconds: profileAction ? 3_010 : null,
    profilesCompleteNanoseconds: profilesComplete ? 3_030 : null,
    samplingStoppedMs: profilesComplete ? 5_202 : null
  };
  const phase = phaseReceipt({
    entry,
    fixture,
    status: failure === null ? "success" : "failed",
    failure,
    values,
    profileCount: profileCount ?? (profilesComplete ? fixture.columns : profileAction ? 3 : 0)
  });
  const processProofs = fixtures.studyProcessProofs(manifest, entry.product, entry.sequence, 0);
  const resourceTarget = profilesComplete
    ? values.profilesCompleteNanoseconds + 2_000
    : failure?.kind === "timeout"
      ? values.inlineActionNanoseconds + DATA_WRANGLER_STUDY_DEADLINES_MS["inline-preview"]
      : 5_000;
  const resourceObservation = fixtures.studyResourceObservation(resourceTarget, processProofs);
  if (failure !== null) {
    resourceObservation.valid = false;
    resourceObservation.reasonClass = "resource-sampling";
    resourceObservation.missedSamples = 1;
    resourceObservation.terminalBoundary = null;
  }
  if (profilesComplete) {
    values.samplingStoppedMs = resourceObservation.samples.at(-1).elapsedMs;
    phase.controlBridge.exchanges = bridgeFor(entry.kind, values.samplingStoppedMs, null);
    phase.absoluteMilestones = absoluteMilestones(values);
  }
  const fragmentIdentity = createStudyFragmentIdentity({
    manifest,
    scheduleEntry: entry,
    executionIndex: entry.sequence,
    attempt: 0,
    recordedAtUtc: "2026-08-02T11:00:00.000Z"
  });
  const cleanupProof = fixtures.studyCleanupProof(processProofs);
  const cacheProof = fixtures.studyCacheProof(manifest, entry);
  const sourceVerificationReceipt = fixtures.studyEngineEvidence(
    manifest,
    entry,
    entry.product === "data-wrangler" ? "unverified" : entry.engine
  ).sourceVerification.receipt;
  const prepared = preparedIntent(manifest, entry, fragmentIdentity);
  const controlReceipt = parentControlReceipt({
    entry,
    fragmentIdentity,
    exchanges: structuredClone(phase.controlBridge.exchanges),
    resourceObservation,
    phaseReceipt: phase,
    cacheProof
  });
  const trialProvenance = fixtures.studyTrialProvenance(manifest, entry, processProofs);
  const executor = executorReceipt({
    entry,
    prepared,
    phase,
    control: controlReceipt,
    cacheProof,
    processProofs,
    launchReceipt: structuredClone(resourceObservation.ownershipTracker),
    terminalReceipt: structuredClone(cleanupProof.supervisorTerminalReceipt),
    cleanupProof,
    trialProvenance
  });
  return {
    manifest,
    scheduleEntry: entry,
    preparedIntent: prepared,
    fragmentIdentity,
    environmentGate: fixtures.studyEnvironmentGate(manifest, "passed"),
    cacheProof,
    notebookPhaseReceipt: phase,
    executorReceipt: executor,
    controlReceipt,
    resourceObservation,
    supervisorLaunchReceipt: structuredClone(resourceObservation.ownershipTracker),
    supervisorTerminalReceipt: structuredClone(cleanupProof.supervisorTerminalReceipt),
    processProofs,
    cleanupProof,
    sourceVerificationReceipt,
    trialProvenance
  };
}

function preNotebookFailureInput({ classification = "premature-exit", kind = "warm" } = {}) {
  const input = trialInput({ kind, failure: { stage: "run-cell-preparation", kind: "error" } });
  input.executorReceipt.status = "pre-notebook-failure";
  input.executorReceipt.notebookPhaseReceipt = null;
  input.executorReceipt.outerEditorFailure = { status: "failed", classification };
  return {
    manifest: input.manifest,
    scheduleEntry: input.scheduleEntry,
    preparedIntent: input.preparedIntent,
    fragmentIdentity: input.fragmentIdentity,
    executorReceipt: input.executorReceipt,
    outerEditorFailure: input.executorReceipt.outerEditorFailure,
    environmentGate: input.environmentGate,
    cacheProof: input.cacheProof,
    controlReceipt: input.controlReceipt,
    resourceObservation: input.resourceObservation,
    supervisorLaunchReceipt: input.supervisorLaunchReceipt,
    supervisorTerminalReceipt: input.supervisorTerminalReceipt,
    processProofs: input.processProofs,
    cleanupProof: input.cleanupProof,
    trialProvenance: input.trialProvenance
  };
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolvePromise_) => {
    resolvePromise = resolvePromise_;
  });
  return { promise, resolve: resolvePromise };
}

async function executeFixtureReceipt(input, { preNotebookFailure = false } = {}) {
  const launchReceipt = input.executorReceipt.launchReceipt;
  const completion = input.executorReceipt.supervisorCompletion;
  const stopEditor = deferred();
  const child = Object.freeze({ kill: () => true });
  const adapter = Object.freeze({
    spawnProcess: () => child,
    waitForLaunch: async () => launchReceipt,
    waitForCompletion: async () => completion,
    child: () => child
  });
  const authorizationResult = {
    intent: {
      protocol: input.preparedIntent.protocol,
      stage: "action-authorized",
      runId: RUN_ID,
      manifestSha256: input.preparedIntent.manifestSha256,
      executionIndex: input.preparedIntent.executionIndex,
      scheduleEntryId: input.preparedIntent.scheduleEntryId,
      attempt: input.preparedIntent.attempt,
      effectiveBlockId: input.preparedIntent.effectiveBlockId,
      product: input.preparedIntent.product,
      ledgerSha256: input.preparedIntent.ledgerSha256,
      preparedSha256: digestStudyValue(input.preparedIntent),
      authorizedAtUtc: "2026-08-02T11:00:00.000Z"
    }
  };
  authorizationResult.publication = {
    status: "published",
    sha256: digestStudyValue(authorizationResult.intent)
  };
  return await executeDataWranglerComparisonTrial(
    {
      runId: RUN_ID,
      phase: PHASE,
      cacheState: input.scheduleEntry.kind,
      product: input.scheduleEntry.product,
      preparedIntent: input.preparedIntent,
      scheduleEntry: input.scheduleEntry,
      requestPath: "/private/request.json",
      acknowledgementPath: "/private/ack.json",
      selectedKernel: {
        name: "openwrangler-study-fragment-test",
        displayName: "Open Wrangler fragment test CPython 3.12"
      },
      editorPhaseOptions: {},
      supervisorOptions: {},
      processEvidenceOptions: {},
      authorizeAction: () => authorizationResult,
      reinspectActionAuthorization: () => ({ status: "not-authorized" })
    },
    {
      createSupervisorAdapter: () => adapter,
      runEditorPhase: async (_options, { spawnProcess }) => {
        spawnProcess("code", [], {});
        if (preNotebookFailure) {
          await stopEditor.promise;
          throw new Error("editor phase stopped");
        }
        return input.notebookPhaseReceipt;
      },
      createProcessEvidence: () => ({
        classify: () => "other-owned-child",
        snapshotLaunchProcessProofs: () => input.processProofs,
        snapshotPreActionProcessProofs: () => input.processProofs,
        snapshotProcessProofs: () => input.processProofs
      }),
      createSampler: () => ({}),
      controlTrial: ({ authorizeAction }) => {
        if (input.controlReceipt.authorization !== null) authorizeAction();
        return input.controlReceipt;
      },
      prepareSourceCache: async () => input.cacheProof,
      signalSupervisor: async () => stopEditor.resolve(),
      completeTerminalEvidence: async () => input.executorReceipt.terminalEvidence
    }
  );
}

function launchOnlyTerminalEvidence(input) {
  const editorRoot = input.supervisorLaunchReceipt.editorRoot;
  const processProofs = {
    editorRoot: {
      pid: editorRoot.pid,
      startTimeTicks: editorRoot.startTimeTicks,
      capturedAtLaunch: true
    },
    configuredKernel: null,
    openWranglerRuntime: null
  };
  const cleanupProof = structuredClone(input.cleanupProof);
  cleanupProof.retainedOwnedIdentities = [{ pid: editorRoot.pid, startTimeTicks: editorRoot.startTimeTicks }];
  cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities = [
    { pid: editorRoot.pid, startTimeTicks: editorRoot.startTimeTicks, disposition: "terminated" }
  ];
  cleanupProof.observations = [
    {
      sequence: 0,
      elapsedMs: 0,
      processes: [{ pid: editorRoot.pid, startTimeTicks: editorRoot.startTimeTicks }]
    },
    { sequence: 1, elapsedMs: 200, processes: [] },
    { sequence: 2, elapsedMs: 400, processes: [] }
  ];
  const trialProvenance = structuredClone(input.trialProvenance);
  trialProvenance.kernelProcess = null;
  return { processProofs, cleanupProof, trialProvenance };
}

async function executeSetupFailureReceipt(input, boundary) {
  const launchReceipt = input.supervisorLaunchReceipt;
  const terminal = launchOnlyTerminalEvidence(input);
  const completion = {
    launchReceipt,
    terminalReceipt: terminal.cleanupProof.supervisorTerminalReceipt,
    exit: { code: 0, signal: null, error: undefined }
  };
  const stopEditor = deferred();
  const child = Object.freeze({ kill: () => true });
  const adapter = Object.freeze({
    spawnProcess: () => child,
    waitForLaunch: async () => launchReceipt,
    waitForCompletion: async () => completion,
    child: () => child
  });
  return await executeDataWranglerComparisonTrial(
    {
      runId: RUN_ID,
      phase: PHASE,
      cacheState: input.scheduleEntry.kind,
      product: input.scheduleEntry.product,
      preparedIntent: input.preparedIntent,
      scheduleEntry: input.scheduleEntry,
      requestPath: "/private/request.json",
      acknowledgementPath: "/private/ack.json",
      selectedKernel: {
        name: "openwrangler-study-setup-failure-test",
        displayName: "Open Wrangler setup failure test CPython 3.12"
      },
      editorPhaseOptions: {},
      supervisorOptions: {},
      processEvidenceOptions: {},
      authorizeAction: () => assert.fail("setup failure must not authorize an action"),
      reinspectActionAuthorization: () => assert.fail("setup failure must not inspect authorization")
    },
    {
      createSupervisorAdapter: () => adapter,
      runEditorPhase: async (_options, { spawnProcess }) => {
        spawnProcess("code", [], {});
        await stopEditor.promise;
        throw new Error("private editor shutdown detail");
      },
      createProcessEvidence: () => {
        if (boundary === "process-evidence") throw new Error("private process evidence detail");
        return {
          classify: () => "other-owned-child",
          snapshotLaunchProcessProofs: () => terminal.processProofs,
          snapshotPreActionProcessProofs: () => terminal.processProofs,
          snapshotProcessProofs: () => assert.fail("setup failure cannot snapshot an action")
        };
      },
      createSampler: () => {
        throw new Error("private resource sampler detail");
      },
      prepareSourceCache: async () => input.cacheProof,
      signalSupervisor: async () => stopEditor.resolve(),
      completeTerminalEvidence: async () => ({
        cleanupProof: terminal.cleanupProof,
        trialProvenance: terminal.trialProvenance
      })
    }
  );
}

test("normalizes a successful trial through the manifest fragment validator", () => {
  const input = trialInput();
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.equal(fragment.outcome.status, "success");
  assert.equal(fragment.uiEvidence.inline.surfaceOwner, "open-wrangler");
  assert.equal(fragment.engineEvidence.workbenchEngine, "pandas");
  assert.equal(fragment.milestones.inlineActionMs, 1_000);
});

test("composes one real executor success receipt directly into the normalizer", async () => {
  const input = trialInput();
  input.executorReceipt = await executeFixtureReceipt(input);
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.equal(fragment.outcome.status, "success");
});

test("composes one real pre-notebook executor failure directly into the normalizer", async () => {
  const input = preNotebookFailureInput();
  const source = trialInput({ failure: { stage: "run-cell-preparation", kind: "error" } });
  input.executorReceipt = await executeFixtureReceipt(source, { preNotebookFailure: true });
  const fragment = normalizeDataWranglerComparisonPreNotebookFailureFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.equal(fragment.outcome.status, "pre-action-invalid");
});

test("composes honest process and sampler setup failures without a resource sample", async (t) => {
  for (const [boundary, reasonClass] of [
    ["process-evidence", "setup"],
    ["resource-sampler", "resource-sampling"]
  ]) {
    await t.test(boundary, async () => {
      const input = preNotebookFailureInput();
      input.executorReceipt = await executeSetupFailureReceipt(input, boundary);
      const fragment = normalizeDataWranglerComparisonPostLaunchSetupFailureFragment(input);
      assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
      assert.equal(fragment.outcome.status, "pre-action-invalid");
      assert.equal(fragment.outcome.reasonClass, reasonClass);
      assert.equal(fragment.outcome.actionStarted, false);
      assert.equal(fragment.resourceObservation, null);
      assert.equal(fragment.processProofs.configuredKernel, null);
      assert.equal(fragment.trialProvenance.kernelProcess, null);
      assert.deepEqual(fragment.cleanupProof.supervisorLaunchReceipt, input.supervisorLaunchReceipt);
      assert.equal(JSON.stringify(fragment).includes("private"), false);

      const missingLaunch = structuredClone(fragment);
      delete missingLaunch.cleanupProof.supervisorLaunchReceipt;
      assert.throws(
        () => validateDataWranglerStudyFragment(missingLaunch, input.manifest),
        /resource observation|missing or unknown fields/u
      );

      const inventedKernel = structuredClone(fragment);
      inventedKernel.processProofs.configuredKernel = structuredClone(input.processProofs.configuredKernel);
      inventedKernel.processProofs.openWranglerRuntime = structuredClone(input.processProofs.openWranglerRuntime);
      assert.throws(() => validateDataWranglerStudyFragment(inventedKernel, input.manifest), /resource observation/u);
    });
  }

  await t.test("cold cache preparation was not claimed", async () => {
    const input = preNotebookFailureInput({ kind: "cold" });
    input.executorReceipt = await executeSetupFailureReceipt(input, "process-evidence");
    const fragment = normalizeDataWranglerComparisonPostLaunchSetupFailureFragment(input);
    assert.equal(fragment.cacheProof, null);
    assert.equal(fragment.sourceLoad.includedInInlineTiming, true);
    assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  });
});

test("binds a cold trial to the controller's verified cache proof", () => {
  const input = trialInput({ kind: "cold" });
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.equal(fragment.cacheProof.requestedState, "evicted");
  assert.deepEqual(input.controlReceipt.coldCacheProof, fragment.cacheProof);
});

test("keeps Data Wrangler's unlabelled workbench engine unverified", () => {
  const input = trialInput({ product: "data-wrangler" });
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(fragment.uiEvidence.inline.surfaceOwner, "host-jupyter");
  assert.equal(fragment.engineEvidence.workbenchEngine, "unverified");
  assert.equal(fragment.engineEvidence.workbenchVerification, "not-observed");
});

test("rejects an unknown inline surface rather than assigning it to a product", () => {
  const input = trialInput();
  input.notebookPhaseReceipt.inline.surfaceKind = "unknown-renderer";
  assert.throws(() => normalizeDataWranglerComparisonTrialFragment(input), /unknown surface kind/u);
});

test("records an inline timeout without inventing readiness", () => {
  const input = trialInput({ failure: { stage: "inline", kind: "timeout" } });
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.deepEqual(fragment.uiEvidence.inline, { status: "timed-out" });
  assert.equal(fragment.outcome.timeout.journey, "inline-preview");
  assert.equal(fragment.milestones.inlineReadyMs, null);
});

test("records a pre-action setup failure with no product evidence", () => {
  const input = trialInput({ failure: { stage: "run-cell-preparation", kind: "error" } });
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.equal(fragment.outcome.status, "pre-action-invalid");
  assert.equal(fragment.uiEvidence, null);
  assert.equal(fragment.engineEvidence, null);
});

test("retains an explicitly abandoned next request outside the notebook exchange prefix", () => {
  const input = trialInput({ failure: { stage: "run-cell-preparation", kind: "error" } });
  const request = bridgeExchange("measurement-ready", 1, -800, -799).request;
  input.controlReceipt.abandonedRequest = {
    request,
    abandonment: {
      protocol: "openwrangler-data-wrangler-study-bridge-abandonment-v1",
      runId: request.runId,
      phase: request.phase,
      sequence: request.sequence,
      kind: request.kind,
      requestMonotonicNanoseconds: request.monotonicNanoseconds,
      abandonedMonotonicNanoseconds: atMs(-799)
    }
  };
  assert.deepEqual(validateDataWranglerComparisonTrialControlReceipt(input.controlReceipt), input.controlReceipt);
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.equal(fragment.outcome.status, "pre-action-invalid");
});

test("retains completed profiles when later profile traversal fails", () => {
  const input = trialInput({ failure: { stage: "profiles", kind: "error" }, profileCount: 3 });
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.equal(fragment.outcome.reasonClass, "correctness");
  assert.equal(fragment.uiEvidence.profiles.status, "failed");
  assert.equal(fragment.uiEvidence.profiles.columns.length, 3);
});

test("rejects an action at or before its acknowledged baseline", () => {
  const input = trialInput({ malformedActionMs: 101 });
  assert.throws(
    () => normalizeDataWranglerComparisonTrialFragment(input),
    /strictly after its baseline acknowledgement/u
  );
});

test("normalizes a post-launch failure without inventing a notebook receipt", () => {
  const input = preNotebookFailureInput();
  const fragment = normalizeDataWranglerComparisonPreNotebookFailureFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.equal(fragment.outcome.status, "pre-action-invalid");
  assert.equal(fragment.outcome.reasonClass, "setup");
  assert.deepEqual(fragment.milestones, {
    inlineActionMs: null,
    inlineReadyMs: null,
    workbenchActionMs: null,
    workbenchReadyMs: null,
    profileActionMs: null,
    firstProfileReadyMs: null,
    profilesCompleteMs: null,
    samplingStoppedMs: null
  });
  assert.deepEqual(fragment.sourceLoad, {
    status: "not-reached",
    durationMs: null,
    includedInInlineTiming: false
  });
  assert.equal(fragment.uiEvidence, null);
  assert.equal(fragment.engineEvidence, null);
  assert.equal("notebookPhaseReceipt" in fragment, false);
});

test("rejects malformed and contradictory controller evidence", async (t) => {
  await t.test("unknown controller fields", () => {
    const input = trialInput();
    input.controlReceipt.extra = true;
    assert.throws(() => normalizeDataWranglerComparisonTrialFragment(input), /missing or unknown fields/u);
  });

  await t.test("parent and notebook status mismatch", () => {
    const input = trialInput();
    input.controlReceipt.status = "failed";
    input.controlReceipt.failure = { stage: "cleanup-census", kind: "aborted" };
    assert.throws(() => normalizeDataWranglerComparisonTrialFragment(input), /statuses do not match/u);
  });

  await t.test("completed exchange mismatch", () => {
    const input = trialInput({ failure: { stage: "inline", kind: "timeout" } });
    input.notebookPhaseReceipt.controlBridge.exchanges.pop();
    assert.throws(() => normalizeDataWranglerComparisonTrialFragment(input), /bridge exchanges do not match/u);
  });

  await t.test("failure boundary mismatch", () => {
    const input = trialInput({ failure: { stage: "inline", kind: "timeout" } });
    input.controlReceipt.failure.stage = "profile-baseline";
    assert.throws(
      () => normalizeDataWranglerComparisonTrialFragment(input),
      /does not match the notebook failure boundary/u
    );
  });
});

test("pre-notebook normalization rejects authorization, action ambiguity, and missing outer evidence", async (t) => {
  await t.test("abandoned request after durable authorization", () => {
    const input = preNotebookFailureInput();
    const authorized = trialInput({ failure: { stage: "inline", kind: "error" } });
    const inlineExchange = authorized.controlReceipt.completedExchanges.pop();
    authorized.controlReceipt.failure = { stage: "inline-baseline", kind: "aborted" };
    authorized.controlReceipt.baselines.inline.acknowledgement = null;
    authorized.controlReceipt.abandonedRequest = {
      request: inlineExchange.request,
      abandonment: {
        protocol: "openwrangler-data-wrangler-study-bridge-abandonment-v1",
        runId: inlineExchange.request.runId,
        phase: inlineExchange.request.phase,
        sequence: inlineExchange.request.sequence,
        kind: inlineExchange.request.kind,
        requestMonotonicNanoseconds: inlineExchange.request.monotonicNanoseconds,
        abandonedMonotonicNanoseconds: atMs(804)
      }
    };
    assert.deepEqual(
      validateDataWranglerComparisonTrialControlReceipt(authorized.controlReceipt),
      authorized.controlReceipt
    );
    input.executorReceipt.controlReceipt = authorized.controlReceipt;
    input.executorReceipt.actionAuthorized = true;
    input.executorReceipt.authorizationAttempted = true;
    input.executorReceipt.authorizationOutcome = "authorized";
    input.executorReceipt.launchReceipt = authorized.supervisorLaunchReceipt;
    input.executorReceipt.supervisorCompletion.launchReceipt = authorized.supervisorLaunchReceipt;
    assert.throws(
      () => normalizeDataWranglerComparisonPreNotebookFailureFragment(input),
      /cannot retain product-action authorization/u
    );
  });

  await t.test("acknowledged inline fence", () => {
    const input = preNotebookFailureInput();
    const authorized = trialInput({ failure: { stage: "inline", kind: "error" } });
    authorized.controlReceipt.authorization = null;
    assert.throws(
      () =>
        normalizeDataWranglerComparisonPreNotebookFailureFragment({
          ...input,
          executorReceipt: { ...input.executorReceipt, controlReceipt: authorized.controlReceipt }
        }),
      /Acknowledged inline baseline has no durable action authorization/u
    );
  });

  await t.test("no outer failure classification", () => {
    const input = preNotebookFailureInput();
    delete input.outerEditorFailure.classification;
    assert.throws(() => normalizeDataWranglerComparisonPreNotebookFailureFragment(input), /missing or unknown fields/u);
  });

  await t.test("path-bearing outer failure classification", () => {
    const input = preNotebookFailureInput({ classification: "tmp/failure" });
    assert.throws(
      () => normalizeDataWranglerComparisonPreNotebookFailureFragment(input),
      /pre-notebook failure is malformed/u
    );
  });

  await t.test("cold launch before verified cache eviction", () => {
    const input = preNotebookFailureInput({ kind: "cold" });
    input.controlReceipt.completedExchanges.pop();
    input.controlReceipt.failure = { stage: "cold-cache-evicted", kind: "timeout" };
    input.controlReceipt.coldCacheProof = null;
    input.executorReceipt.cacheProof = null;
    assert.deepEqual(validateDataWranglerComparisonTrialControlReceipt(input.controlReceipt), input.controlReceipt);
    assert.throws(
      () => normalizeDataWranglerComparisonPreNotebookFailureFragment(input),
      /without verified cache eviction cannot be published/u
    );
  });

  await t.test("failure stage is not the next bridge request", () => {
    const input = preNotebookFailureInput();
    input.executorReceipt.controlReceipt.failure.stage = "profile-baseline";
    assert.throws(
      () => normalizeDataWranglerComparisonPreNotebookFailureFragment(input),
      /next expected bridge request/u
    );
  });

  await t.test("launch proof has no configured kernel", () => {
    const input = preNotebookFailureInput();
    input.executorReceipt.processProofs = {
      editorRoot: input.executorReceipt.processProofs.editorRoot,
      configuredKernel: null,
      openWranglerRuntime: null
    };
    const fragment = normalizeDataWranglerComparisonPreNotebookFailureFragment(input, {
      validateFragment: (value) => value
    });
    assert.equal(fragment.processProofs.configuredKernel, null);
    assert.equal(fragment.outcome.actionStarted, false);
  });

  await t.test("prepared intent digest differs from executor binding", () => {
    const input = preNotebookFailureInput();
    input.executorReceipt.trialBinding.preparedIntentSha256 = "c".repeat(64);
    assert.throws(
      () => normalizeDataWranglerComparisonPreNotebookFailureFragment(input),
      /does not match the prepared trial/u
    );
  });

  await t.test("no notebook phase receipt on the main path", () => {
    const input = trialInput();
    delete input.executorReceipt.notebookPhaseReceipt;
    assert.throws(() => normalizeDataWranglerComparisonTrialFragment(input), /receipt has missing or unknown fields/u);
  });
});
