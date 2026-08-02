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
  if (failureStage !== "run-cell-preparation") plan.push(["measurement-ready", -800, -799]);
  if (failureStage !== "run-cell-preparation") {
    plan.push(["sampling-origin", -1, 0], ["inline-baseline", 100, 101]);
  }
  if (!["run-cell-preparation", "source-load", "inline"].includes(failureStage)) {
    plan.push(["workbench-baseline", 1_500, 1_501]);
  }
  if (
    !["run-cell-preparation", "source-load", "inline", "workbench-open", "grid-restoration"].includes(
      failureStage
    )
  ) {
    plan.push(["profile-baseline", 2_500, 2_501]);
  }
  if (failureStage === null) {
    plan.push(["sampling-stop", 3_031, stoppedMs], ["cleanup-census", stoppedMs + 1, stoppedMs + 2]);
  }
  return plan.map(([bridgeKind, request, acknowledgement], index) =>
    bridgeExchange(bridgeKind, index, request, acknowledgement)
  );
}

function parentControlReceipt({ entry, fragmentIdentity, exchanges, resourceObservation }) {
  const byKind = new Map(exchanges.map((exchange) => [exchange.request.kind, exchange]));
  const baseline = (kind, authorization = null) => {
    const exchange = byKind.get(kind);
    return exchange === undefined
      ? null
      : {
          exchange,
          baseline: { protocol: "openwrangler-linux-pss-baseline-ack-v1", stableBaseline: {} },
          ...(authorization === null ? {} : { authorization })
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
    runId: RUN_ID,
    phase: PHASE,
    cacheState: entry.kind,
    sourceVerified: byKind.get("source-verified") ?? null,
    coldCacheEvicted: byKind.get("cold-cache-evicted") ?? null,
    coldCacheProof: null,
    measurementReady: byKind.get("measurement-ready") ?? null,
    samplingOrigin: byKind.get("sampling-origin") ?? null,
    baselines: {
      inline: baseline("inline-baseline", authorization),
      workbench: baseline("workbench-baseline"),
      profile: baseline("profile-baseline")
    },
    samplingStop:
      samplingStopExchange === undefined
        ? null
        : {
            exchange: samplingStopExchange,
            terminalTargetMonotonicNanoseconds: resourceObservation.terminalBoundary.targetMonotonicNanoseconds
          },
    cleanupCensus: byKind.get("cleanup-census") ?? null,
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
      measurementBoundary: entry.kind === "cold" ? "run-cell-pointer-to-cell-completion" : "setup-cell-start-to-completion"
    },
    inline: values.inlineActionNanoseconds === null
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
            ? action(entry.product === "open-wrangler" ? "Open in Open Wrangler" : 'Open "study_frame" in Data Wrangler')
            : null,
          sentinelsVisibleWithAction: inlineReady
        },
    workbench: workbenchReady
      ? {
          action: action(entry.product === "open-wrangler" ? "Open in Open Wrangler" : 'Open "study_frame" in Data Wrangler'),
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
          action: action(entry.product === "open-wrangler" ? "Column profiles and filters" : "c00 integer", entry.product === "open-wrangler" ? "button" : "columnheader"),
          firstUsefulColumn: "c00",
          expectedColumnCount: fixture.columns,
          completedColumnCount: profileCount,
          canonicalOrder: true,
          rowValuesIncluded: false,
          columns: profileColumns(profileCount, fixture.rows, entry.product === "data-wrangler" ? "approximate" : "exact")
        }
      : null,
    clock: { kind: "driver-local-performance-time-origin", timeOriginUnixMs: 1_800_000_000_000, authoritativeForStudy: false },
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

function trialInput({ product = "open-wrangler", failure = null, profileCount, malformedActionMs } = {}) {
  const manifest = fixtures.studyManifest();
  const entry = manifest.schedule.find(
    (candidate) =>
      candidate.product === product && candidate.engine === "pandas" && candidate.format === "csv" && candidate.kind === "warm"
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
  const sourceVerificationReceipt = fixtures.studyEngineEvidence(
    manifest,
    entry,
    entry.product === "data-wrangler" ? "unverified" : entry.engine
  ).sourceVerification.receipt;
  return {
    manifest,
    scheduleEntry: entry,
    fragmentIdentity,
    environmentGate: fixtures.studyEnvironmentGate(manifest, "passed"),
    cacheProof: fixtures.studyCacheProof(manifest, entry),
    notebookPhaseReceipt: phase,
    controlReceipt: parentControlReceipt({
      entry,
      fragmentIdentity,
      exchanges: structuredClone(phase.controlBridge.exchanges),
      resourceObservation
    }),
    resourceObservation,
    supervisorLaunchReceipt: structuredClone(resourceObservation.ownershipTracker),
    supervisorTerminalReceipt: structuredClone(cleanupProof.supervisorTerminalReceipt),
    processProofs,
    cleanupProof,
    sourceVerificationReceipt,
    trialProvenance: fixtures.studyTrialProvenance(manifest, entry, processProofs)
  };
}

test("normalizes a successful trial through the manifest fragment validator", () => {
  const input = trialInput();
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(validateDataWranglerStudyFragment(fragment, input.manifest), fragment);
  assert.equal(fragment.outcome.status, "success");
  assert.equal(fragment.engineEvidence.workbenchEngine, "pandas");
  assert.equal(fragment.milestones.inlineActionMs, 1_000);
});

test("keeps Data Wrangler's unlabelled workbench engine unverified", () => {
  const input = trialInput({ product: "data-wrangler" });
  const fragment = normalizeDataWranglerComparisonTrialFragment(input);
  assert.equal(fragment.engineEvidence.workbenchEngine, "unverified");
  assert.equal(fragment.engineEvidence.workbenchVerification, "not-observed");
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
