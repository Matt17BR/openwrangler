import * as assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { type ElementHandle, type Frame, type Locator, type Page } from "playwright-core";
import {
  allEditorTabs,
  comparisonFrames,
  comparisonTabsOpenedAfter,
  comparisonWorkbenchReadiness,
  connectToEditorWorkbench,
  frameChainIsVisibleAndPointerUsable,
  recordProgress,
  waitFor,
  waitForGenericGridReadiness,
  waitForWorkbenchReady,
  type ComparisonWorkbenchReadinessEvidence
} from "./dataWranglerComparison";
import {
  DEFAULT_COMPARISON_GRID_READINESS_INPUT,
  observeComparisonGridReadiness,
  type ComparisonGridReadinessEvidence
} from "./comparisonGridReadiness";
import { findExactActiveNotebookRendererButton } from "./notebookRendererFrame";
import { activateAcceptancePointerTargetAtCurrentCenter } from "./playwrightLifecycle";
import {
  releasedNotebookExecutionFailureMessage,
  releasedNotebookOutputClassification
} from "./releasedNotebookFailure";

export const DATA_WRANGLER_NOTEBOOK_TRIAL_PHASE_PROTOCOL = "openwrangler-data-wrangler-notebook-trial-phase-v1";
export const DATA_WRANGLER_NOTEBOOK_PROTOCOL = "openwrangler-data-wrangler-notebook-v1";
export const DATA_WRANGLER_NOTEBOOK_VERIFICATION_PROTOCOL = "openwrangler-data-wrangler-notebook-verification-v1";
export const DATA_WRANGLER_NOTEBOOK_VERIFICATION_MARKER = "OPENWRANGLER_STUDY_VERIFICATION:";
export const DATA_WRANGLER_STUDY_REQUIRED_LOCALE = "en";
export const DATA_WRANGLER_STUDY_INLINE_ACTION_WINDOW_MS = 45_000;
export const DATA_WRANGLER_STUDY_WORKBENCH_WINDOW_MS = 60_000;
export const DATA_WRANGLER_STUDY_PROFILE_WINDOW_MS = 135_000;

const PHASE_PRODUCTS = Object.freeze({
  "comparison-study-open-wrangler-trial": "open-wrangler",
  "comparison-study-data-wrangler-trial": "data-wrangler"
} as const);
const SHA256 = /^[0-9a-f]{64}$/u;
const KERNEL_NAME = /^openwrangler-study-[a-z0-9][a-z0-9._-]{0,95}$/u;
const PYTHON_312 = /^3\.12(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u;
const EXECUTE_CELL_ACCESSIBLE_NAME = /^Execute Cell(?: \([^\r\n()]{1,64}\))?$/u;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_NOTEBOOK_OUTPUT_BYTES = 32 * 1024;
const NOTEBOOK_CELL_TIMEOUT_MS = 120_000;
const POINTER_ACTION_TIMEOUT_MS = 10_000;
const PROFILE_POLL_MS = 25;

type ProductKey = (typeof PHASE_PRODUCTS)[keyof typeof PHASE_PRODUCTS];
type Engine = "pandas" | "polars";
type Format = "csv" | "parquet";
type TrialKind = "warm" | "cold";
type SurfaceKind = "open-wrangler-renderer" | "data-wrangler-action-on-host-output";
type DistinctEvidence = "exact-count" | "exact-100-percent";

export interface NotebookTrialDefinition {
  readonly engine: Engine;
  readonly format: Format;
  readonly kind: TrialKind;
  readonly fixture: {
    readonly id: "csv-100k-50" | "parquet-1m-20";
    readonly sha256: string;
    readonly rows: 100_000 | 1_000_000;
    readonly columns: 50 | 20;
  };
  readonly kernel: {
    readonly name: string;
    readonly displayName: string;
  };
}

export interface NotebookTrialVerificationEvidence {
  readonly phase: "before-timing" | "after-workbench";
  readonly pythonImplementation: "CPython";
  readonly pythonVersion: string;
  readonly classMatched: true;
  readonly shapeMatched: true;
  readonly columnsMatched: true;
  readonly integerDtypeMatched: true;
  readonly sentinelsMatched: true;
  readonly objectTokenContinuous: true | null;
  readonly rowDataIncluded: false;
}

export interface NotebookTrialActionEvidence {
  readonly role: "button" | "columnheader";
  readonly accessibleName: string;
  readonly exactNameMatched: true;
  readonly visible: true;
  readonly enabled: true;
  readonly pointerUsable: true;
  readonly stableFrames: 2;
}

export interface NotebookTrialInlineEvidence {
  readonly evidenceWindowMs: typeof DATA_WRANGLER_STUDY_INLINE_ACTION_WINDOW_MS;
  readonly baselineExactActionCount: 0;
  readonly genericHostHtmlAcceptedAsProductPreview: false;
  readonly runCellAction: NotebookTrialActionEvidence;
  readonly surfaceKind: SurfaceKind | null;
  readonly action: NotebookTrialActionEvidence | null;
  readonly sentinelsVisibleWithAction: boolean;
}

export interface NotebookTrialScrollEvidence {
  readonly input: "pointer-wheel";
  readonly verticalWindowChanged: true;
  readonly horizontalWindowChanged: true;
  readonly stableFrames: 2;
  readonly pointerUsableAfterScroll: true;
  readonly firstRowsRestoredAfterTiming: true;
}

export interface NotebookTrialProfileColumnEvidence {
  readonly column: string;
  readonly type: "signed-64-bit";
  readonly missingCount: 0;
  readonly minimumMatched: true;
  readonly maximumMatched: true;
  readonly distinct: DistinctEvidence;
  readonly rowValuesIncluded: false;
}

export interface NotebookTrialMilestones {
  readonly inlineActionMs: number;
  readonly inlineReadyMs: number | null;
  readonly workbenchActionMs: number | null;
  readonly workbenchReadyMs: number | null;
  readonly profileActionMs: number | null;
  readonly firstProfileReadyMs: number | null;
  readonly profilesCompleteMs: number | null;
}

export interface DataWranglerNotebookTrialPhaseReceipt {
  readonly protocol: typeof DATA_WRANGLER_NOTEBOOK_TRIAL_PHASE_PROTOCOL;
  readonly locale: typeof DATA_WRANGLER_STUDY_REQUIRED_LOCALE;
  readonly product: ProductKey;
  readonly status: "success" | "unsupported";
  readonly unsupportedReason: "data-wrangler-polars-action-absent" | null;
  readonly study: NotebookTrialDefinition & {
    readonly pythonImplementation: "CPython";
    readonly pythonVersion: string;
  };
  readonly verification: {
    readonly before: NotebookTrialVerificationEvidence;
    readonly after: NotebookTrialVerificationEvidence;
  };
  readonly inline: NotebookTrialInlineEvidence;
  readonly workbench: {
    readonly action: NotebookTrialActionEvidence;
    readonly newlySelectedProductEditor: true;
    readonly grid: ComparisonGridReadinessEvidence;
    readonly workbench: ComparisonWorkbenchReadinessEvidence;
    readonly fullShape: "aria-counts" | "visible-shape-label";
    readonly scroll: NotebookTrialScrollEvidence;
  } | null;
  readonly profiles: {
    readonly action: NotebookTrialActionEvidence;
    readonly firstUsefulColumn: "c00";
    readonly expectedColumnCount: number;
    readonly completedColumnCount: number;
    readonly canonicalOrder: true;
    readonly rowValuesIncluded: false;
    readonly columns: readonly NotebookTrialProfileColumnEvidence[];
  } | null;
  readonly clock: {
    readonly kind: "extension-host-performance-time-origin";
    readonly timeOriginUnixMs: number;
  };
  readonly milestones: NotebookTrialMilestones;
}

export interface NotebookTrialFlowDependencies {
  readonly product: ProductKey;
  readonly study: NotebookTrialDefinition;
  readonly now: () => number;
  readonly timeOriginUnixMs: number;
  assertExactNotebook(checkpoint: string): void;
  selectKernel(): Promise<void>;
  executeSetup(): Promise<void>;
  executeVerification(phase: "before-timing" | "after-workbench"): Promise<NotebookTrialVerificationEvidence>;
  countExactInlineActions(): Promise<number>;
  prepareMeasuredAction(): Promise<NotebookTrialActionEvidence>;
  executeMeasured(immediatelyBeforePointerClick: () => void, immediatelyAfterCellCompletion: () => void): Promise<void>;
  waitForInlineAction(immediatelyAfterReady: () => void): Promise<{
    readonly evidence: NotebookTrialActionEvidence;
    readonly surfaceKind: SurfaceKind;
    readonly sentinelsVisibleWithAction: boolean;
  } | null>;
  clickInlineAction(immediatelyBeforePointerClick: () => void): Promise<NotebookTrialActionEvidence>;
  waitForWorkbenchAndScroll(immediatelyAfterReady: () => void): Promise<{
    readonly newlySelectedProductEditor: true;
    readonly grid: ComparisonGridReadinessEvidence;
    readonly workbench: ComparisonWorkbenchReadinessEvidence;
    readonly fullShape: "aria-counts" | "visible-shape-label";
    readonly scroll: Omit<NotebookTrialScrollEvidence, "firstRowsRestoredAfterTiming">;
  }>;
  restoreFirstRows(): Promise<void>;
  activateProfiles(immediatelyBeforePointerClick: () => void): Promise<NotebookTrialActionEvidence>;
  profileColumn(index: number, immediatelyAfterReady: () => void): Promise<NotebookTrialProfileColumnEvidence>;
  closeProductEditorAndRestoreNotebook(): Promise<void>;
}

export async function executeDataWranglerNotebookTrialFlow(
  dependencies: NotebookTrialFlowDependencies
): Promise<DataWranglerNotebookTrialPhaseReceipt> {
  validateTrialDefinition(dependencies.study);
  const trialStarted = dependencies.now();
  const milestones: { -readonly [Key in keyof NotebookTrialMilestones]: NotebookTrialMilestones[Key] } = {
    inlineActionMs: 0,
    inlineReadyMs: null,
    workbenchActionMs: null,
    workbenchReadyMs: null,
    profileActionMs: null,
    firstProfileReadyMs: null,
    profilesCompleteMs: null
  };
  const mark = (): number => roundedMilliseconds(dependencies.now() - trialStarted, { allowZero: true });
  const exact = (checkpoint: string): void => dependencies.assertExactNotebook(checkpoint);

  exact("before kernel selection");
  await dependencies.selectKernel();
  exact("after kernel selection");
  await dependencies.executeSetup();
  exact("after setup");
  const before = await dependencies.executeVerification("before-timing");
  exact("after before-timing verification");
  assertVerificationMatchesStudy(before, dependencies.study, "before-timing");
  const baselineExactActionCount = await dependencies.countExactInlineActions();
  exact("after inline action baseline");
  assert.equal(baselineExactActionCount, 0, "The measured cell requires zero retained exact product actions.");

  const runCellAction = await dependencies.prepareMeasuredAction();
  exact("after measured Run Cell preparation");
  let resolveMeasuredBoundary!: () => void;
  let rejectMeasuredBoundary!: (error: unknown) => void;
  const measuredBoundary = new Promise<void>((resolve, reject) => {
    resolveMeasuredBoundary = resolve;
    rejectMeasuredBoundary = reject;
  });
  let measuredBoundaryReached = false;
  let measuredCompletionMs: number | undefined;
  const measuredCompletion = dependencies.executeMeasured(
    () => {
      assert.equal(measuredBoundaryReached, false, "The public Run Cell pointer boundary may be recorded only once.");
      measuredBoundaryReached = true;
      milestones.inlineActionMs = mark();
      resolveMeasuredBoundary();
    },
    () => {
      assert.equal(measuredCompletionMs, undefined, "Measured cell completion may be recorded only once.");
      measuredCompletionMs = mark();
    }
  );
  void measuredCompletion.catch(rejectMeasuredBoundary);
  await measuredBoundary;
  assert.equal(
    measuredBoundaryReached,
    true,
    "The public Run Cell action never reached its physical pointer boundary."
  );
  let inlineReadyRecorded = false;
  let inlineSurfaceReadyMs: number | undefined;
  const [inlineAction] = await Promise.all([
    dependencies.waitForInlineAction(() => {
      assert.equal(inlineReadyRecorded, false, "Inline readiness may be recorded only once.");
      inlineReadyRecorded = true;
      inlineSurfaceReadyMs = mark();
    }),
    measuredCompletion
  ]);
  exact("after measured output");

  if (inlineAction === null) {
    assert.equal(
      dependencies.product === "data-wrangler" && dependencies.study.engine === "polars",
      true,
      "Only Data Wrangler Polars may record an absent exact inline action as unsupported."
    );
    await dependencies.closeProductEditorAndRestoreNotebook();
    exact("before unsupported after-check");
    const after = await dependencies.executeVerification("after-workbench");
    exact("after unsupported after-check");
    assertVerificationMatchesStudy(after, dependencies.study, "after-workbench");
    return validateDataWranglerNotebookTrialPhaseReceipt({
      protocol: DATA_WRANGLER_NOTEBOOK_TRIAL_PHASE_PROTOCOL,
      locale: DATA_WRANGLER_STUDY_REQUIRED_LOCALE,
      product: dependencies.product,
      status: "unsupported",
      unsupportedReason: "data-wrangler-polars-action-absent",
      study: {
        ...dependencies.study,
        pythonImplementation: before.pythonImplementation,
        pythonVersion: before.pythonVersion
      },
      verification: { before, after },
      inline: {
        evidenceWindowMs: DATA_WRANGLER_STUDY_INLINE_ACTION_WINDOW_MS,
        baselineExactActionCount: 0,
        genericHostHtmlAcceptedAsProductPreview: false,
        runCellAction,
        surfaceKind: null,
        action: null,
        sentinelsVisibleWithAction: false
      },
      workbench: null,
      profiles: null,
      clock: {
        kind: "extension-host-performance-time-origin",
        timeOriginUnixMs: dependencies.timeOriginUnixMs
      },
      milestones
    });
  }

  assert.equal(inlineReadyRecorded, true, "The successful inline surface omitted its exact readiness boundary.");
  assert.notEqual(measuredCompletionMs, undefined, "The successful inline surface omitted measured-cell completion.");
  assert.notEqual(inlineSurfaceReadyMs, undefined);
  milestones.inlineReadyMs = Math.max(measuredCompletionMs as number, inlineSurfaceReadyMs as number);
  let workbenchActionMs: number | undefined;
  const clickedAction = await dependencies.clickInlineAction(() => {
    assert.equal(workbenchActionMs, undefined, "The exact Open action pointer boundary may be recorded only once.");
    workbenchActionMs = mark();
  });
  assert.notEqual(workbenchActionMs, undefined, "The exact Open action never reached its physical pointer boundary.");
  milestones.workbenchActionMs = workbenchActionMs as number;
  let workbenchReadyRecorded = false;
  const workbench = await dependencies.waitForWorkbenchAndScroll(() => {
    assert.equal(workbenchReadyRecorded, false, "Workbench readiness may be recorded only once.");
    workbenchReadyRecorded = true;
    milestones.workbenchReadyMs = mark();
  });
  assert.equal(workbenchReadyRecorded, true, "The successful workbench omitted its exact readiness boundary.");
  await dependencies.restoreFirstRows();
  exact("after restoring the notebook source grid's first rows");

  let profileActionMs: number | undefined;
  const profileAction = await dependencies.activateProfiles(() => {
    assert.equal(profileActionMs, undefined, "The profiling action pointer boundary may be recorded only once.");
    profileActionMs = mark();
  });
  assert.notEqual(profileActionMs, undefined, "The profiling action never reached its physical pointer boundary.");
  milestones.profileActionMs = profileActionMs as number;
  const profileColumns: NotebookTrialProfileColumnEvidence[] = [];
  for (let index = 0; index < dependencies.study.fixture.columns; index += 1) {
    let profileReadyRecorded = false;
    const evidence = await dependencies.profileColumn(index, () => {
      assert.equal(
        profileReadyRecorded,
        false,
        `Profile ${comparisonColumnName(index)} readiness may be recorded only once.`
      );
      profileReadyRecorded = true;
      if (index === 0) milestones.firstProfileReadyMs = mark();
      if (index === dependencies.study.fixture.columns - 1) milestones.profilesCompleteMs = mark();
    });
    assert.equal(profileReadyRecorded, true, `Profile ${comparisonColumnName(index)} omitted its readiness boundary.`);
    assert.equal(evidence.column, comparisonColumnName(index));
    profileColumns.push(evidence);
  }
  await dependencies.closeProductEditorAndRestoreNotebook();
  exact("before after-workbench verification");
  const after = await dependencies.executeVerification("after-workbench");
  exact("after after-workbench verification");
  assertVerificationMatchesStudy(after, dependencies.study, "after-workbench");

  return validateDataWranglerNotebookTrialPhaseReceipt({
    protocol: DATA_WRANGLER_NOTEBOOK_TRIAL_PHASE_PROTOCOL,
    locale: DATA_WRANGLER_STUDY_REQUIRED_LOCALE,
    product: dependencies.product,
    status: "success",
    unsupportedReason: null,
    study: {
      ...dependencies.study,
      pythonImplementation: before.pythonImplementation,
      pythonVersion: before.pythonVersion
    },
    verification: { before, after },
    inline: {
      evidenceWindowMs: DATA_WRANGLER_STUDY_INLINE_ACTION_WINDOW_MS,
      baselineExactActionCount: 0,
      genericHostHtmlAcceptedAsProductPreview: false,
      runCellAction,
      surfaceKind: inlineAction.surfaceKind,
      action: inlineAction.evidence,
      sentinelsVisibleWithAction: inlineAction.sentinelsVisibleWithAction
    },
    workbench: {
      action: clickedAction,
      newlySelectedProductEditor: true,
      grid: workbench.grid,
      workbench: workbench.workbench,
      fullShape: workbench.fullShape,
      scroll: { ...workbench.scroll, firstRowsRestoredAfterTiming: true }
    },
    profiles: {
      action: profileAction,
      firstUsefulColumn: "c00",
      expectedColumnCount: dependencies.study.fixture.columns,
      completedColumnCount: profileColumns.length,
      canonicalOrder: true,
      rowValuesIncluded: false,
      columns: profileColumns
    },
    clock: {
      kind: "extension-host-performance-time-origin",
      timeOriginUnixMs: dependencies.timeOriginUnixMs
    },
    milestones
  });
}

export function validateDataWranglerNotebookTrialPhaseReceipt(value: unknown): DataWranglerNotebookTrialPhaseReceipt {
  const receipt = requireRecord(value, "Notebook trial phase receipt");
  exactKeys(
    receipt,
    [
      "protocol",
      "locale",
      "product",
      "status",
      "unsupportedReason",
      "study",
      "verification",
      "inline",
      "workbench",
      "profiles",
      "clock",
      "milestones"
    ],
    "Notebook trial phase receipt"
  );
  if (receipt.protocol !== DATA_WRANGLER_NOTEBOOK_TRIAL_PHASE_PROTOCOL) fail("Notebook trial protocol is invalid.");
  if (receipt.locale !== DATA_WRANGLER_STUDY_REQUIRED_LOCALE) {
    fail("Notebook trial evidence requires the exact English launch locale.");
  }
  if (receipt.product !== "open-wrangler" && receipt.product !== "data-wrangler") {
    fail("Notebook trial product is invalid.");
  }
  if (receipt.status !== "success" && receipt.status !== "unsupported") fail("Notebook trial status is invalid.");

  const studyRecord = requireRecord(receipt.study, "Notebook trial study");
  exactKeys(
    studyRecord,
    ["engine", "format", "kind", "fixture", "kernel", "pythonImplementation", "pythonVersion"],
    "Notebook trial study"
  );
  const study = validateTrialDefinition(studyRecord) as NotebookTrialDefinition;
  if (studyRecord.pythonImplementation !== "CPython" || !isStringMatching(studyRecord.pythonVersion, PYTHON_312)) {
    fail("Notebook trial kernel must report CPython 3.12.");
  }

  const verification = requireRecord(receipt.verification, "Notebook trial verification");
  exactKeys(verification, ["before", "after"], "Notebook trial verification");
  const before = validateNormalizedVerification(verification.before, "before-timing");
  const after = validateNormalizedVerification(verification.after, "after-workbench");
  assertVerificationMatchesStudy(before, study, "before-timing");
  assertVerificationMatchesStudy(after, study, "after-workbench");
  if (
    before.pythonVersion !== studyRecord.pythonVersion ||
    after.pythonVersion !== studyRecord.pythonVersion ||
    before.pythonImplementation !== studyRecord.pythonImplementation ||
    after.pythonImplementation !== studyRecord.pythonImplementation
  ) {
    fail("Notebook trial verification changed its configured Python identity.");
  }

  const inline = requireRecord(receipt.inline, "Notebook trial inline evidence");
  exactKeys(
    inline,
    [
      "evidenceWindowMs",
      "baselineExactActionCount",
      "genericHostHtmlAcceptedAsProductPreview",
      "runCellAction",
      "surfaceKind",
      "action",
      "sentinelsVisibleWithAction"
    ],
    "Notebook trial inline evidence"
  );
  if (
    inline.evidenceWindowMs !== DATA_WRANGLER_STUDY_INLINE_ACTION_WINDOW_MS ||
    inline.baselineExactActionCount !== 0 ||
    inline.genericHostHtmlAcceptedAsProductPreview !== false ||
    typeof inline.sentinelsVisibleWithAction !== "boolean"
  ) {
    fail("Notebook trial inline evidence weakened its fixed product-action boundary.");
  }
  validateRunCellActionEvidence(inline.runCellAction);

  const milestones = validateTrialMilestones(receipt.milestones, receipt.status);
  const clock = requireRecord(receipt.clock, "Notebook trial clock");
  exactKeys(clock, ["kind", "timeOriginUnixMs"], "Notebook trial clock");
  if (
    clock.kind !== "extension-host-performance-time-origin" ||
    typeof clock.timeOriginUnixMs !== "number" ||
    !Number.isFinite(clock.timeOriginUnixMs) ||
    clock.timeOriginUnixMs <= 0
  ) {
    fail("Notebook trial clock is invalid.");
  }

  if (receipt.status === "unsupported") {
    if (
      receipt.product !== "data-wrangler" ||
      study.engine !== "polars" ||
      receipt.unsupportedReason !== "data-wrangler-polars-action-absent" ||
      inline.surfaceKind !== null ||
      inline.action !== null ||
      inline.sentinelsVisibleWithAction !== false ||
      receipt.workbench !== null ||
      receipt.profiles !== null
    ) {
      fail("Only the fixed-window Data Wrangler Polars action absence may be unsupported.");
    }
  } else {
    if (receipt.unsupportedReason !== null) fail("A successful notebook trial cannot retain an unsupported reason.");
    const expectedSurface: SurfaceKind =
      receipt.product === "open-wrangler" ? "open-wrangler-renderer" : "data-wrangler-action-on-host-output";
    if (inline.surfaceKind !== expectedSurface || inline.sentinelsVisibleWithAction !== true) {
      fail("A successful notebook trial requires product-owned action and inline sentinel evidence.");
    }
    validateActionEvidence(inline.action, receipt.product, "inline");
    validateWorkbenchEvidence(receipt.workbench, study, receipt.product);
    validateProfileEvidence(receipt.profiles, study, receipt.product);
    if (
      milestones.inlineReadyMs === null ||
      milestones.workbenchReadyMs === null ||
      milestones.profilesCompleteMs === null
    ) {
      fail("A successful notebook trial omitted a measured readiness boundary.");
    }
  }

  const serialized = JSON.stringify(receipt);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_BYTES) {
    fail("Notebook trial receipt exceeds its fixed 32 KiB bound.");
  }
  assertPathFreeJson(receipt);
  return value as DataWranglerNotebookTrialPhaseReceipt;
}

function validateTrialDefinition(value: unknown): NotebookTrialDefinition {
  const study = requireRecord(value, "Notebook trial definition");
  const allowed = ["engine", "format", "kind", "fixture", "kernel"];
  const keys = Object.keys(study);
  if (keys.includes("pythonImplementation") || keys.includes("pythonVersion")) {
    exactKeys(study, [...allowed, "pythonImplementation", "pythonVersion"], "Notebook trial definition");
  } else {
    exactKeys(study, allowed, "Notebook trial definition");
  }
  if (study.engine !== "pandas" && study.engine !== "polars") fail("Notebook trial engine is invalid.");
  if (study.format !== "csv" && study.format !== "parquet") fail("Notebook trial format is invalid.");
  if (study.kind !== "warm" && study.kind !== "cold") fail("Notebook trial kind is invalid.");
  const fixture = requireRecord(study.fixture, "Notebook trial fixture");
  exactKeys(fixture, ["id", "sha256", "rows", "columns"], "Notebook trial fixture");
  const expected =
    study.format === "csv"
      ? { id: "csv-100k-50", rows: 100_000, columns: 50 }
      : { id: "parquet-1m-20", rows: 1_000_000, columns: 20 };
  if (
    fixture.id !== expected.id ||
    fixture.rows !== expected.rows ||
    fixture.columns !== expected.columns ||
    !isStringMatching(fixture.sha256, SHA256)
  ) {
    fail("Notebook trial fixture does not match its registered release-sized cell.");
  }
  const kernel = requireRecord(study.kernel, "Notebook trial kernel");
  exactKeys(kernel, ["name", "displayName"], "Notebook trial kernel");
  if (!isStringMatching(kernel.name, KERNEL_NAME)) fail("Notebook trial kernel name is not trial-private.");
  if (
    typeof kernel.displayName !== "string" ||
    kernel.displayName.length === 0 ||
    kernel.displayName.length > 128 ||
    /[\0\r\n/\\]/u.test(kernel.displayName) ||
    !/CPython 3\.12/iu.test(kernel.displayName)
  ) {
    fail("Notebook trial kernel display name must be bounded, path-free, and identify CPython 3.12.");
  }
  return value as unknown as NotebookTrialDefinition;
}

function validateNormalizedVerification(
  value: unknown,
  expectedPhase: NotebookTrialVerificationEvidence["phase"]
): NotebookTrialVerificationEvidence {
  const evidence = requireRecord(value, `Notebook ${expectedPhase} verification`);
  exactKeys(
    evidence,
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
      "rowDataIncluded"
    ],
    `Notebook ${expectedPhase} verification`
  );
  if (
    evidence.phase !== expectedPhase ||
    evidence.pythonImplementation !== "CPython" ||
    !isStringMatching(evidence.pythonVersion, PYTHON_312) ||
    evidence.classMatched !== true ||
    evidence.shapeMatched !== true ||
    evidence.columnsMatched !== true ||
    evidence.integerDtypeMatched !== true ||
    evidence.sentinelsMatched !== true ||
    (evidence.objectTokenContinuous !== true && evidence.objectTokenContinuous !== null) ||
    evidence.rowDataIncluded !== false
  ) {
    fail(`Notebook ${expectedPhase} verification is incomplete or includes row data.`);
  }
  return value as NotebookTrialVerificationEvidence;
}

function assertVerificationMatchesStudy(
  evidence: NotebookTrialVerificationEvidence,
  study: NotebookTrialDefinition,
  phase: NotebookTrialVerificationEvidence["phase"]
): void {
  if (
    evidence.phase !== phase ||
    (study.kind === "warm" ? evidence.objectTokenContinuous !== true : evidence.objectTokenContinuous !== null)
  ) {
    fail(`Notebook ${phase} verification does not match the ${study.kind} object-identity contract.`);
  }
}

function validateActionEvidence(
  value: unknown,
  product: ProductKey,
  purpose: "inline" | "workbench" | "profile"
): void {
  const evidence = requireRecord(value, `Notebook ${purpose} action evidence`);
  exactKeys(
    evidence,
    ["role", "accessibleName", "exactNameMatched", "visible", "enabled", "pointerUsable", "stableFrames"],
    `Notebook ${purpose} action evidence`
  );
  if (
    (evidence.role !== "button" && evidence.role !== "columnheader") ||
    typeof evidence.accessibleName !== "string" ||
    evidence.accessibleName.length === 0 ||
    evidence.accessibleName.length > 160 ||
    evidence.exactNameMatched !== true ||
    evidence.visible !== true ||
    evidence.enabled !== true ||
    evidence.pointerUsable !== true ||
    evidence.stableFrames !== 2
  ) {
    fail(`Notebook ${purpose} action is not exact, stable, visible, enabled, and pointer-usable.`);
  }
  if (purpose === "inline" || purpose === "workbench") {
    if (evidence.role !== "button" || !inlineActionNameMatches(product, evidence.accessibleName)) {
      fail(`Notebook ${purpose} action name does not match its product.`);
    }
  } else if (product === "open-wrangler") {
    if (evidence.role !== "button" || evidence.accessibleName !== "Column profiles and filters") {
      fail("Open Wrangler profiling must start from its exact public Column profiles action.");
    }
  } else if (evidence.role !== "columnheader" || !/^c00(?:\b|[^\p{L}\p{N}_])/u.test(evidence.accessibleName)) {
    fail("Data Wrangler profiling must start from the exact c00 column header.");
  }
}

function validateRunCellActionEvidence(value: unknown): void {
  const evidence = requireRecord(value, "Notebook Run Cell action evidence");
  exactKeys(
    evidence,
    ["role", "accessibleName", "exactNameMatched", "visible", "enabled", "pointerUsable", "stableFrames"],
    "Notebook Run Cell action evidence"
  );
  if (
    evidence.role !== "button" ||
    !isStringMatching(evidence.accessibleName, EXECUTE_CELL_ACCESSIBLE_NAME) ||
    evidence.exactNameMatched !== true ||
    evidence.visible !== true ||
    evidence.enabled !== true ||
    evidence.pointerUsable !== true ||
    evidence.stableFrames !== 2
  ) {
    fail("Notebook timing must start from the exact stable public Execute Cell action.");
  }
}

function validateWorkbenchEvidence(value: unknown, study: NotebookTrialDefinition, product: ProductKey): void {
  const evidence = requireRecord(value, "Notebook trial workbench evidence");
  exactKeys(
    evidence,
    ["action", "newlySelectedProductEditor", "grid", "workbench", "fullShape", "scroll"],
    "Notebook trial workbench evidence"
  );
  validateActionEvidence(evidence.action, product, "workbench");
  if (evidence.newlySelectedProductEditor !== true)
    fail("Notebook trial did not select a newly opened product editor.");
  const grid = requireRecord(evidence.grid, "Notebook trial grid evidence");
  exactKeys(
    grid,
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
    "Notebook trial grid evidence"
  );
  if (
    (grid.rootRole !== "grid" && grid.rootRole !== "table") ||
    (grid.busy !== "false" && grid.busy !== "absent") ||
    grid.visible !== true ||
    grid.pointerUsable !== true ||
    grid.geometryStableFrames !== 2 ||
    !Array.isArray(grid.headers) ||
    grid.headers.length !== 2 ||
    grid.headers[0] !== "c00" ||
    grid.headers[1] !== "c01" ||
    grid.sentinelsMatched !== true
  ) {
    fail("Notebook trial grid is not a stable pointer-usable sentinel grid.");
  }
  if (evidence.fullShape !== "aria-counts" && evidence.fullShape !== "visible-shape-label") {
    fail("Notebook trial full-shape proof is invalid.");
  }
  if (
    evidence.fullShape === "aria-counts" &&
    (grid.ariaRowCount !== study.fixture.rows || grid.ariaColumnCount !== study.fixture.columns)
  ) {
    fail("Notebook trial ARIA shape does not match the complete source.");
  }
  const workbench = requireRecord(evidence.workbench, "Notebook trial workbench obstruction evidence");
  exactKeys(
    workbench,
    ["targetEditorSelected", "noVisibleQuickInput", "noVisibleDialog", "noVisibleModal", "rendererFramePointerUsable"],
    "Notebook trial workbench obstruction evidence"
  );
  if (Object.values(workbench).some((item) => item !== true)) {
    fail("Notebook trial workbench was not selected, unobstructed, and pointer-usable.");
  }
  const scroll = requireRecord(evidence.scroll, "Notebook trial scroll evidence");
  exactKeys(
    scroll,
    [
      "input",
      "verticalWindowChanged",
      "horizontalWindowChanged",
      "stableFrames",
      "pointerUsableAfterScroll",
      "firstRowsRestoredAfterTiming"
    ],
    "Notebook trial scroll evidence"
  );
  if (
    scroll.input !== "pointer-wheel" ||
    scroll.verticalWindowChanged !== true ||
    scroll.horizontalWindowChanged !== true ||
    scroll.stableFrames !== 2 ||
    scroll.pointerUsableAfterScroll !== true ||
    scroll.firstRowsRestoredAfterTiming !== true
  ) {
    fail("Notebook trial did not prove real two-axis pointer-wheel grid readiness and restoration.");
  }
}

function validateProfileEvidence(value: unknown, study: NotebookTrialDefinition, product: ProductKey): void {
  const evidence = requireRecord(value, "Notebook trial profile evidence");
  exactKeys(
    evidence,
    [
      "action",
      "firstUsefulColumn",
      "expectedColumnCount",
      "completedColumnCount",
      "canonicalOrder",
      "rowValuesIncluded",
      "columns"
    ],
    "Notebook trial profile evidence"
  );
  validateActionEvidence(evidence.action, product, "profile");
  if (
    evidence.firstUsefulColumn !== "c00" ||
    evidence.expectedColumnCount !== study.fixture.columns ||
    evidence.completedColumnCount !== study.fixture.columns ||
    evidence.canonicalOrder !== true ||
    evidence.rowValuesIncluded !== false ||
    !Array.isArray(evidence.columns) ||
    evidence.columns.length !== study.fixture.columns
  ) {
    fail("Notebook trial profile traversal is incomplete, reordered, or includes row values.");
  }
  evidence.columns.forEach((item, index) => {
    const column = requireRecord(item, `Notebook trial profile column ${index}`);
    exactKeys(
      column,
      ["column", "type", "missingCount", "minimumMatched", "maximumMatched", "distinct", "rowValuesIncluded"],
      `Notebook trial profile column ${index}`
    );
    if (
      column.column !== comparisonColumnName(index) ||
      column.type !== "signed-64-bit" ||
      column.missingCount !== 0 ||
      column.minimumMatched !== true ||
      column.maximumMatched !== true ||
      (column.distinct !== "exact-count" && column.distinct !== "exact-100-percent") ||
      column.rowValuesIncluded !== false
    ) {
      fail(`Notebook trial profile column ${index} is not final or exact-equivalent.`);
    }
  });
}

function validateTrialMilestones(value: unknown, status: unknown): NotebookTrialMilestones {
  const milestones = requireRecord(value, "Notebook trial milestones");
  const keys = [
    "inlineActionMs",
    "inlineReadyMs",
    "workbenchActionMs",
    "workbenchReadyMs",
    "profileActionMs",
    "firstProfileReadyMs",
    "profilesCompleteMs"
  ];
  exactKeys(milestones, keys, "Notebook trial milestones");
  let previous = -1;
  let sawNull = false;
  for (const key of keys) {
    const item = milestones[key];
    if (item === null) {
      sawNull = true;
      continue;
    }
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || sawNull || item < previous) {
      fail("Notebook trial milestones must form one finite non-decreasing prefix.");
    }
    previous = item;
  }
  if (status === "success") {
    if (
      sawNull ||
      (milestones.inlineReadyMs as number) <= (milestones.inlineActionMs as number) ||
      (milestones.inlineReadyMs as number) - (milestones.inlineActionMs as number) >
        DATA_WRANGLER_STUDY_INLINE_ACTION_WINDOW_MS ||
      (milestones.workbenchReadyMs as number) <= (milestones.workbenchActionMs as number) ||
      (milestones.workbenchReadyMs as number) - (milestones.workbenchActionMs as number) >
        DATA_WRANGLER_STUDY_WORKBENCH_WINDOW_MS ||
      (milestones.firstProfileReadyMs as number) <= (milestones.profileActionMs as number) ||
      (milestones.profilesCompleteMs as number) < (milestones.firstProfileReadyMs as number) ||
      (milestones.profilesCompleteMs as number) - (milestones.profileActionMs as number) >
        DATA_WRANGLER_STUDY_PROFILE_WINDOW_MS
    ) {
      fail("A successful notebook trial requires positive action-to-readiness durations.");
    }
  } else if (keys.slice(1).some((key) => milestones[key] !== null)) {
    fail("An unsupported notebook trial may retain only the measured-cell action boundary.");
  }
  return value as NotebookTrialMilestones;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function fail(message: string): never {
  throw new TypeError(message);
}

function isStringMatching(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function assertPathFreeJson(value: unknown): void {
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      const pathCandidate = item.replace(
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
        fail("Notebook trial receipt contains path-shaped text.");
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
}

function comparisonColumnName(index: number): string {
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 100);
  return `c${String(index).padStart(2, "0")}`;
}

function inlineActionNameMatches(product: ProductKey, name: string): boolean {
  return product === "open-wrangler"
    ? name === "Open in Open Wrangler"
    : /^Open ['"]study_frame['"] in Data Wrangler$/u.test(name);
}

function roundedMilliseconds(value: number, { allowZero = false }: { readonly allowZero?: boolean } = {}): number {
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 300_000);
  const rounded = Math.round(value * 1_000) / 1_000;
  return allowZero ? Math.max(0, rounded) : Math.max(0.001, rounded);
}

interface NotebookTrialRectangle {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

interface NotebookTrialElement {
  readonly disabled?: boolean;
  readonly isConnected: boolean;
  readonly ownerDocument: NotebookTrialDocument;
  readonly parentElement: NotebookTrialElement | null;
  readonly tagName?: string;
  readonly textContent: string | null;
  contains(candidate: NotebookTrialElement | null): boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): NotebookTrialRectangle;
  querySelector(selector: string): NotebookTrialElement | null;
  querySelectorAll(selector: string): ArrayLike<NotebookTrialElement>;
}

interface NotebookTrialDocument {
  readonly defaultView: NotebookTrialWindow | null;
  readonly documentElement?: { readonly clientWidth: number; readonly clientHeight: number };
  elementFromPoint(x: number, y: number): NotebookTrialElement | null;
  getElementById(id: string): NotebookTrialElement | null;
  querySelectorAll(selector: string): ArrayLike<NotebookTrialElement>;
}

interface NotebookTrialWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  getComputedStyle(element: NotebookTrialElement): {
    readonly display: string;
    readonly visibility: string;
    readonly opacity: string;
  };
  requestAnimationFrame(callback: (timestamp: number) => void): number;
}

interface InlineActionObservation {
  readonly evidence: NotebookTrialActionEvidence;
  readonly sentinelsVisibleWithAction: boolean;
  readonly openWranglerRendererOwned: boolean;
}

/** Closure-free: Playwright serializes this into the authoritative output document. */
export function observeNotebookTrialInlineAction(
  elementValue: unknown,
  input: { readonly product: ProductKey; readonly expectedName: string }
): Promise<InlineActionObservation | null> {
  const element = elementValue as NotebookTrialElement;
  if (!element?.isConnected) return Promise.resolve(null);
  const document_ = element.ownerDocument;
  const window_ = document_.defaultView;
  if (!window_) return Promise.resolve(null);
  const normalize = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
  const accessibleName = (candidate: NotebookTrialElement): string => {
    const direct = normalize(candidate.getAttribute("aria-label"));
    if (direct) return direct;
    const labelledBy = normalize(candidate.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const labels = labelledBy
        .split(" ")
        .map((id) => document_.getElementById(id))
        .filter((label): label is NotebookTrialElement => label !== null)
        .map((label) => normalize(label.textContent))
        .filter(Boolean);
      if (labels.length > 0) return labels.join(" ");
    }
    return normalize(candidate.textContent) || normalize(candidate.getAttribute("title"));
  };
  const visible = (candidate: NotebookTrialElement): boolean => {
    let current: NotebookTrialElement | null = candidate;
    while (current) {
      const style = window_.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  };
  const viewportWidth = window_.innerWidth || document_.documentElement?.clientWidth || 0;
  const viewportHeight = window_.innerHeight || document_.documentElement?.clientHeight || 0;
  const pointerUsable = (candidate: NotebookTrialElement, rectangle: NotebookTrialRectangle): boolean => {
    const left = Math.max(0, rectangle.left);
    const right = Math.min(viewportWidth, rectangle.right);
    const top = Math.max(0, rectangle.top);
    const bottom = Math.min(viewportHeight, rectangle.bottom);
    if (right <= left || bottom <= top) return false;
    const hit = document_.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return hit !== null && (hit === candidate || candidate.contains(hit));
  };
  const expectedName = typeof input?.expectedName === "string" ? input.expectedName : "";
  const actualName = accessibleName(element);
  if (
    actualName !== expectedName ||
    !visible(element) ||
    element.disabled === true ||
    element.getAttribute("aria-disabled") === "true"
  ) {
    return Promise.resolve(null);
  }

  const actionRectangle = element.getBoundingClientRect();
  if (actionRectangle.width <= 0 || actionRectangle.height <= 0 || !pointerUsable(element, actionRectangle)) {
    return Promise.resolve(null);
  }

  const roots = Array.from(document_.querySelectorAll('[role="grid"], [role="table"], table')).slice(0, 64);
  const sentinelRoot = roots.find((root) => {
    if (!root.isConnected || !visible(root)) return false;
    const rows = Array.from(root.querySelectorAll('[role="row"], tr')).slice(0, 128);
    for (const row of rows) {
      const cells = Array.from(
        row.querySelectorAll('[role="columnheader"], [role="rowheader"], [role="gridcell"], [role="cell"], th, td')
      ).slice(0, 256);
      for (let index = 0; index + 1 < cells.length; index += 1) {
        const first = accessibleName(cells[index]);
        const second = accessibleName(cells[index + 1]);
        if (!(first === "c00" || first.startsWith("c00,")) || !(second === "c01" || second.startsWith("c01,"))) {
          continue;
        }
        const bodyRows = rows
          .filter((candidate) => candidate !== row)
          .map((candidate) =>
            Array.from(
              candidate.querySelectorAll('[role="rowheader"], [role="gridcell"], [role="cell"], th, td')
            ).slice(0, 256)
          )
          .filter((candidate) => candidate.length > index + 1)
          .slice(0, 2);
        return (
          bodyRows.length === 2 &&
          normalize(bodyRows[0][index]?.textContent ?? null) === "0" &&
          normalize(bodyRows[0][index + 1]?.textContent ?? null) === "1" &&
          normalize(bodyRows[1][index]?.textContent ?? null) === "1" &&
          normalize(bodyRows[1][index + 1]?.textContent ?? null) === "2"
        );
      }
    }
    return false;
  });
  const sentinelRectangle = sentinelRoot?.getBoundingClientRect();
  const sentinelsVisibleWithAction = Boolean(
    sentinelRoot &&
    sentinelRectangle &&
    sentinelRectangle.width > 0 &&
    sentinelRectangle.height > 0 &&
    visible(sentinelRoot)
  );
  let openWranglerRendererOwned = false;
  let current: NotebookTrialElement | null = element;
  while (current) {
    const classes = ` ${normalize(current.getAttribute("class"))} `;
    if (
      current.tagName?.toLowerCase() === "section" &&
      classes.includes(" openwrangler-notebook ") &&
      normalize(current.textContent).startsWith("Open Wrangler preview: study_frame")
    ) {
      openWranglerRendererOwned = true;
      break;
    }
    current = current.parentElement;
  }
  if (input?.product === "open-wrangler" && !openWranglerRendererOwned) return Promise.resolve(null);

  const fingerprint = (): readonly number[] => {
    const action = element.getBoundingClientRect();
    const grid = sentinelRoot?.getBoundingClientRect();
    return [
      action.left,
      action.top,
      action.width,
      action.height,
      grid?.left ?? -1,
      grid?.top ?? -1,
      grid?.width ?? -1,
      grid?.height ?? -1
    ].map((item) => Math.round(item * 1_000) / 1_000);
  };
  const initial = fingerprint();
  return new Promise((resolve) => {
    window_.requestAnimationFrame(() => {
      window_.requestAnimationFrame(() => {
        if (!element.isConnected || fingerprint().some((item, index) => item !== initial[index])) {
          resolve(null);
          return;
        }
        resolve({
          evidence: {
            role: "button",
            accessibleName: actualName,
            exactNameMatched: true,
            visible: true,
            enabled: true,
            pointerUsable: true,
            stableFrames: 2
          },
          sentinelsVisibleWithAction,
          openWranglerRendererOwned
        });
      });
    });
  });
}

interface NotebookTrialPointerTarget {
  readonly pointer: { click(x: number, y: number): Promise<void> };
  boundingBox(): Promise<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null>;
  evaluate<Result>(pageFunction: (element: unknown) => Result | Promise<Result>): Promise<Result>;
}

interface NotebookTrialActionTarget extends NotebookTrialPointerTarget {
  readonly role: "button" | "columnheader";
  readonly accessibleName: string;
  inlineObservation(product: ProductKey): Promise<InlineActionObservation | null>;
  dispose(): Promise<void>;
}

async function actionTargetFromElement(
  element: ElementHandle<unknown>,
  frame: Frame,
  product: ProductKey,
  accessibleName: string,
  role: "button" | "columnheader" = "button"
): Promise<NotebookTrialActionTarget | undefined> {
  const target: NotebookTrialActionTarget = {
    pointer: frame.page().mouse,
    role,
    accessibleName,
    boundingBox: () => element.boundingBox(),
    evaluate: <Result>(pageFunction: (candidate: unknown) => Result | Promise<Result>) =>
      element.evaluate(pageFunction),
    inlineObservation: (owner) =>
      element.evaluate(observeNotebookTrialInlineAction, { product: owner, expectedName: accessibleName }),
    dispose: () => element.dispose()
  };
  try {
    const observation = await target.inlineObservation(product);
    return observation ? target : undefined;
  } catch (error) {
    await target.dispose().catch(() => undefined);
    throw error;
  }
}

async function actionTargetFromLocator(
  locator: Locator,
  frame: Frame,
  product: ProductKey,
  role: "button" | "columnheader"
): Promise<NotebookTrialActionTarget | undefined> {
  const accessibleName = await locator.evaluate((element) => {
    const direct = element.getAttribute("aria-label");
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelled = labelledBy
      ? labelledBy
          .split(/\s+/u)
          .map((id: string) => element.ownerDocument.getElementById(id)?.textContent ?? "")
          .join(" ")
      : "";
    return (direct || labelled || element.textContent || element.getAttribute("title") || "")
      .replace(/\s+/gu, " ")
      .trim();
  });
  const target: NotebookTrialActionTarget = {
    pointer: frame.page().mouse,
    role,
    accessibleName,
    boundingBox: () => locator.boundingBox(),
    evaluate: <Result>(pageFunction: (candidate: unknown) => Result | Promise<Result>) =>
      locator.evaluate(pageFunction),
    inlineObservation: (owner) =>
      locator.evaluate(observeNotebookTrialInlineAction, { product: owner, expectedName: accessibleName }),
    dispose: async () => undefined
  };
  return (await target.inlineObservation(product)) ? target : undefined;
}

async function discoverExactInlineActionTargets(
  workbench: Page,
  product: ProductKey
): Promise<NotebookTrialActionTarget[]> {
  const targets: NotebookTrialActionTarget[] = [];
  if (product === "open-wrangler") {
    for (const frame of comparisonFrames(workbench).slice(0, 64)) {
      let handle;
      try {
        handle = await frame.evaluateHandle(findExactActiveNotebookRendererButton, {
          expectedLabel: "study_frame",
          expectedButtonName: "Open in Open Wrangler"
        });
        const element = handle.asElement() as ElementHandle<unknown> | null;
        if (!element) {
          await handle.dispose();
          continue;
        }
        const target = await actionTargetFromElement(element, frame, product, "Open in Open Wrangler");
        if (target) targets.push(target);
        else await element.dispose();
      } catch {
        await handle?.dispose().catch(() => undefined);
      }
    }
    return targets;
  }

  const actionName = /^Open ['"]study_frame['"] in Data Wrangler$/u;
  for (const frame of comparisonFrames(workbench).slice(0, 64)) {
    const candidates = frame.getByRole("button", { name: actionName });
    const count = Math.min(await candidates.count().catch(() => 0), 8);
    for (let index = 0; index < count; index += 1) {
      const locator = candidates.nth(index);
      try {
        if (!(await locator.isVisible()) || !(await locator.isEnabled())) continue;
        const target = await actionTargetFromLocator(locator, frame, product, "button");
        if (target && inlineActionNameMatches(product, target.accessibleName)) targets.push(target);
      } catch {
        // A notebook output can retire while Jupyter promotes its active renderer.
      }
    }
  }
  return targets;
}

async function disposeActionTargets(targets: readonly NotebookTrialActionTarget[]): Promise<void> {
  await Promise.allSettled(targets.map((target) => target.dispose()));
}

/** Closure-free stable action probe used immediately before a physical pointer click. */
export function observeNotebookTrialPointerAction(
  elementValue: unknown,
  input: { readonly role: "button" | "columnheader"; readonly expectedName: string }
): Promise<NotebookTrialActionEvidence | null> {
  const element = elementValue as NotebookTrialElement;
  const document_ = element?.ownerDocument;
  const window_ = document_?.defaultView;
  if (!element?.isConnected || !document_ || !window_) return Promise.resolve(null);
  const normalize = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
  const accessibleName = (() => {
    const direct = normalize(element.getAttribute("aria-label"));
    if (direct) return direct;
    const labelledBy = normalize(element.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const labels = labelledBy
        .split(" ")
        .map((id) => document_.getElementById(id))
        .filter((label): label is NotebookTrialElement => label !== null)
        .map((label) => normalize(label.textContent))
        .filter(Boolean);
      if (labels.length > 0) return labels.join(" ");
    }
    return normalize(element.textContent) || normalize(element.getAttribute("title"));
  })();
  if (
    accessibleName !== input?.expectedName ||
    element.disabled === true ||
    element.getAttribute("aria-disabled") === "true"
  ) {
    return Promise.resolve(null);
  }
  let current: NotebookTrialElement | null = element;
  while (current) {
    const style = window_.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    ) {
      return Promise.resolve(null);
    }
    current = current.parentElement;
  }
  const rectangle = element.getBoundingClientRect();
  const viewportWidth = window_.innerWidth || document_.documentElement?.clientWidth || 0;
  const viewportHeight = window_.innerHeight || document_.documentElement?.clientHeight || 0;
  const left = Math.max(0, rectangle.left);
  const right = Math.min(viewportWidth, rectangle.right);
  const top = Math.max(0, rectangle.top);
  const bottom = Math.min(viewportHeight, rectangle.bottom);
  if (rectangle.width <= 0 || rectangle.height <= 0 || right <= left || bottom <= top) return Promise.resolve(null);
  const hit = document_.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  if (hit === null || (hit !== element && !element.contains(hit))) return Promise.resolve(null);
  const fingerprint = [rectangle.left, rectangle.top, rectangle.width, rectangle.height].map(
    (item) => Math.round(item * 1_000) / 1_000
  );
  return new Promise((resolve) => {
    window_.requestAnimationFrame(() => {
      window_.requestAnimationFrame(() => {
        const next = element.getBoundingClientRect();
        const nextFingerprint = [next.left, next.top, next.width, next.height].map(
          (item) => Math.round(item * 1_000) / 1_000
        );
        if (!element.isConnected || nextFingerprint.some((item, index) => item !== fingerprint[index])) {
          resolve(null);
          return;
        }
        resolve({
          role: input.role,
          accessibleName,
          exactNameMatched: true,
          visible: true,
          enabled: true,
          pointerUsable: true,
          stableFrames: 2
        });
      });
    });
  });
}

async function pointerActionTargetFromLocator(
  locator: Locator,
  frame: Frame,
  role: "button" | "columnheader"
): Promise<NotebookTrialActionTarget | undefined> {
  const accessibleName = await locator
    .evaluate((element) => {
      const direct = element.getAttribute("aria-label");
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelled = labelledBy
        ? labelledBy
            .split(/\s+/u)
            .map((id: string) => element.ownerDocument.getElementById(id)?.textContent ?? "")
            .join(" ")
        : "";
      return (direct || labelled || element.textContent || element.getAttribute("title") || "")
        .replace(/\s+/gu, " ")
        .trim();
    })
    .catch(() => "");
  if (!accessibleName) return undefined;
  const evidence = await locator
    .evaluate(observeNotebookTrialPointerAction, { role, expectedName: accessibleName })
    .catch(() => null);
  if (!evidence) return undefined;
  return {
    pointer: frame.page().mouse,
    role,
    accessibleName,
    boundingBox: () => locator.boundingBox(),
    evaluate: <Result>(pageFunction: (candidate: unknown) => Result | Promise<Result>) =>
      locator.evaluate(pageFunction),
    inlineObservation: async () => null,
    dispose: async () => undefined
  };
}

async function requirePointerActionEvidence(target: NotebookTrialActionTarget): Promise<NotebookTrialActionEvidence> {
  const evidence = await target.evaluate((element) => {
    const candidate = element as {
      readonly disabled?: boolean;
      readonly isConnected: boolean;
      readonly ownerDocument: {
        readonly defaultView: {
          getComputedStyle(item: unknown): { display: string; visibility: string; opacity: string };
        } | null;
        elementFromPoint(x: number, y: number): unknown;
        getElementById(id: string): { textContent: string | null } | null;
      };
      readonly parentElement: unknown;
      readonly textContent: string | null;
      contains(item: unknown): boolean;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { left: number; top: number; width: number; height: number };
    };
    if (!candidate.isConnected || candidate.disabled === true || candidate.getAttribute("aria-disabled") === "true") {
      return null;
    }
    const direct = candidate.getAttribute("aria-label");
    const labelledBy = candidate.getAttribute("aria-labelledby");
    const labelled = labelledBy
      ? labelledBy
          .split(/\s+/u)
          .map((id) => candidate.ownerDocument.getElementById(id)?.textContent ?? "")
          .join(" ")
      : "";
    const accessibleName = (direct || labelled || candidate.textContent || candidate.getAttribute("title") || "")
      .replace(/\s+/gu, " ")
      .trim();
    const rectangle = candidate.getBoundingClientRect();
    const hit = candidate.ownerDocument.elementFromPoint(
      rectangle.left + rectangle.width / 2,
      rectangle.top + rectangle.height / 2
    );
    if (rectangle.width <= 0 || rectangle.height <= 0 || (hit !== candidate && !candidate.contains(hit))) return null;
    return { accessibleName };
  });
  assert.ok(evidence, "The exact pointer action stopped owning its current center.");
  assert.equal(evidence.accessibleName, target.accessibleName);
  return {
    role: target.role,
    accessibleName: target.accessibleName,
    exactNameMatched: true,
    visible: true,
    enabled: true,
    pointerUsable: true,
    stableFrames: 2
  };
}

interface NotebookTrialGridScrollState {
  readonly rootOrdinal: number;
  readonly verticalOffset: number;
  readonly horizontalOffset: number;
  readonly verticalOverflow: number;
  readonly horizontalOverflow: number;
  readonly visibleHeaderSignature: string;
  readonly visibleRowSignature: string;
  readonly pointerUsable: boolean;
  readonly stableFrames: 2;
}

/** Closure-free product-neutral grid-scroll observation for Playwright frame.evaluate. */
export function observeNotebookTrialGridScrollState(): Promise<NotebookTrialGridScrollState | null> {
  type ScrollElement = NotebookTrialElement & {
    readonly clientHeight: number;
    readonly clientWidth: number;
    readonly scrollHeight: number;
    readonly scrollWidth: number;
    readonly scrollTop: number;
    readonly scrollLeft: number;
  };
  const runtime = globalThis as unknown as { readonly document: NotebookTrialDocument } & NotebookTrialWindow;
  const document_ = runtime.document;
  const normalize = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
  const roots = Array.from(document_.querySelectorAll('[role="grid"], [role="table"], table')).slice(0, 64);
  const viewportWidth = runtime.innerWidth || document_.documentElement?.clientWidth || 0;
  const viewportHeight = runtime.innerHeight || document_.documentElement?.clientHeight || 0;
  const visible = (element: NotebookTrialElement): boolean => {
    const rectangle = element.getBoundingClientRect();
    if (
      !element.isConnected ||
      rectangle.width <= 0 ||
      rectangle.height <= 0 ||
      rectangle.right <= 0 ||
      rectangle.bottom <= 0 ||
      rectangle.left >= viewportWidth ||
      rectangle.top >= viewportHeight
    ) {
      return false;
    }
    let current: NotebookTrialElement | null = element;
    while (current) {
      const style = runtime.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  };
  const headerName = (element: NotebookTrialElement): string =>
    normalize(element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent);
  const rootOrdinal = roots.findIndex((root) => {
    if (!visible(root)) return false;
    const headers = Array.from(root.querySelectorAll('[role="columnheader"], th')).slice(0, 256);
    return headers.some((header, index) => {
      const next = headers[index + 1];
      if (!next) return false;
      const currentMatch = /^c(\d{2})(?:\b|[^\p{L}\p{N}_])/u.exec(headerName(header));
      const nextMatch = /^c(\d{2})(?:\b|[^\p{L}\p{N}_])/u.exec(headerName(next));
      return Boolean(currentMatch && nextMatch && Number(nextMatch[1]) === Number(currentMatch[1]) + 1);
    });
  });
  if (rootOrdinal < 0) return Promise.resolve(null);
  const root = roots[rootOrdinal]!;
  const candidates: ScrollElement[] = [];
  const addCandidate = (candidate: NotebookTrialElement | null): void => {
    if (!candidate || candidates.includes(candidate as ScrollElement)) return;
    const scroll = candidate as ScrollElement;
    if (
      Number.isFinite(scroll.scrollHeight) &&
      Number.isFinite(scroll.clientHeight) &&
      Number.isFinite(scroll.scrollWidth) &&
      Number.isFinite(scroll.clientWidth)
    ) {
      candidates.push(scroll);
    }
  };
  addCandidate(root);
  let ancestor = root.parentElement;
  for (let depth = 0; ancestor && depth < 16; depth += 1) {
    addCandidate(ancestor);
    ancestor = ancestor.parentElement;
  }
  Array.from(root.querySelectorAll("*")).slice(0, 2_048).forEach(addCandidate);
  const vertical = [...candidates].sort(
    (left, right) => right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight)
  )[0];
  const horizontal = [...candidates].sort(
    (left, right) => right.scrollWidth - right.clientWidth - (left.scrollWidth - left.clientWidth)
  )[0];
  if (!vertical || !horizontal) return Promise.resolve(null);

  const snapshot = (): Omit<NotebookTrialGridScrollState, "stableFrames"> | null => {
    if (!root.isConnected || !visible(root)) return null;
    const rootRectangle = root.getBoundingClientRect();
    const left = Math.max(0, rootRectangle.left);
    const right = Math.min(viewportWidth, rootRectangle.right);
    const top = Math.max(0, rootRectangle.top);
    const bottom = Math.min(viewportHeight, rootRectangle.bottom);
    const hit =
      right > left && bottom > top ? document_.elementFromPoint((left + right) / 2, (top + bottom) / 2) : null;
    const headers = Array.from(root.querySelectorAll('[role="columnheader"], th'))
      .filter(visible)
      .slice(0, 64)
      .map(headerName)
      .join("|");
    const rows = Array.from(root.querySelectorAll('[role="row"], tr'))
      .filter(visible)
      .slice(0, 8)
      .map((row) => normalize(row.textContent).slice(0, 256))
      .join("|");
    return {
      rootOrdinal,
      verticalOffset: vertical.scrollTop,
      horizontalOffset: horizontal.scrollLeft,
      verticalOverflow: Math.max(0, vertical.scrollHeight - vertical.clientHeight),
      horizontalOverflow: Math.max(0, horizontal.scrollWidth - horizontal.clientWidth),
      visibleHeaderSignature: headers,
      visibleRowSignature: rows,
      pointerUsable: hit !== null && (hit === root || root.contains(hit))
    };
  };
  const first = snapshot();
  if (!first) return Promise.resolve(null);
  return new Promise((resolve) => {
    runtime.requestAnimationFrame(() => {
      runtime.requestAnimationFrame(() => {
        const second = snapshot();
        if (!second || JSON.stringify(second) !== JSON.stringify(first)) {
          resolve(null);
          return;
        }
        resolve({ ...second, stableFrames: 2 });
      });
    });
  });
}

async function exerciseNotebookTrialGridScroll(
  frame: Frame
): Promise<Omit<NotebookTrialScrollEvidence, "firstRowsRestoredAfterTiming">> {
  const before = await frame.evaluate(observeNotebookTrialGridScrollState);
  assert.ok(before, "The ready product grid did not expose a stable product-neutral scroll surface.");
  assert.ok(before.verticalOverflow > 0, "The release-sized product grid must have real vertical overflow.");
  assert.ok(before.horizontalOverflow > 0, "The release-sized product grid must have real horizontal overflow.");
  const roots = frame.locator('[role="grid"], [role="table"], table');
  const root = roots.nth(before.rootOrdinal);
  const box = await root.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "The ready product grid lost pointer geometry before scrolling.");
  const pointer = frame.page().mouse;
  await pointer.move(box.x + box.width / 2, box.y + box.height / 2);

  let vertical = before;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await pointer.wheel(0, Math.max(600, Math.round(box.height * 0.8)));
    await frame.page().waitForTimeout(20);
    const candidate = await frame.evaluate(observeNotebookTrialGridScrollState);
    if (!candidate) continue;
    vertical = candidate;
    if (
      candidate.verticalOffset > before.verticalOffset ||
      candidate.visibleRowSignature !== before.visibleRowSignature
    ) {
      break;
    }
  }
  const verticalWindowChanged =
    vertical.verticalOffset > before.verticalOffset || vertical.visibleRowSignature !== before.visibleRowSignature;
  assert.equal(verticalWindowChanged, true, "A physical vertical wheel did not change the product row window.");

  let horizontal = vertical;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await pointer.wheel(Math.max(600, Math.round(box.width * 0.8)), 0);
    await frame.page().waitForTimeout(20);
    const candidate = await frame.evaluate(observeNotebookTrialGridScrollState);
    if (!candidate) continue;
    horizontal = candidate;
    if (
      candidate.horizontalOffset > vertical.horizontalOffset ||
      candidate.visibleHeaderSignature !== vertical.visibleHeaderSignature
    ) {
      break;
    }
  }
  const horizontalWindowChanged =
    horizontal.horizontalOffset > vertical.horizontalOffset ||
    horizontal.visibleHeaderSignature !== vertical.visibleHeaderSignature;
  assert.equal(horizontalWindowChanged, true, "A physical horizontal wheel did not change the product column window.");
  assert.equal(horizontal.pointerUsable, true, "The scrolled product grid is not pointer-usable.");
  return {
    input: "pointer-wheel",
    verticalWindowChanged: true,
    horizontalWindowChanged: true,
    stableFrames: 2,
    pointerUsableAfterScroll: true
  };
}

async function restoreNotebookTrialGridFirstRows(frame: Frame): Promise<void> {
  const state = await frame.evaluate(observeNotebookTrialGridScrollState);
  assert.ok(state, "The product grid disappeared before first-row restoration.");
  const root = frame.locator('[role="grid"], [role="table"], table').nth(state.rootOrdinal);
  const box = await root.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  const pointer = frame.page().mouse;
  await pointer.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await pointer.wheel(-1_000_000, -1_000_000);
    await frame.page().waitForTimeout(20);
    const readiness = await frame
      .evaluate(observeComparisonGridReadiness, DEFAULT_COMPARISON_GRID_READINESS_INPUT)
      .catch(() => null);
    if (readiness) return;
  }
  throw new Error("Physical pointer-wheel restoration did not return the product grid to its sentinel first rows.");
}

/** Closure-free visible full-shape fallback when a native table omits ARIA counts. */
export function observeNotebookTrialVisibleShape(input: { readonly rows: number; readonly columns: number }): boolean {
  const runtime = globalThis as unknown as { readonly document: NotebookTrialDocument } & NotebookTrialWindow;
  const normalize = (value: string | null): string => (value ?? "").replace(/[,_]/gu, "").replace(/\s+/gu, " ").trim();
  if (
    !Number.isSafeInteger(input?.rows) ||
    !Number.isSafeInteger(input?.columns) ||
    input.rows < 1 ||
    input.columns < 1
  ) {
    return false;
  }
  const rows = String(input.rows);
  const columns = String(input.columns);
  const candidates = Array.from(
    runtime.document.querySelectorAll('[aria-label], [role="status"], [role="note"], [role="heading"], header, footer')
  ).slice(0, 512);
  return candidates.some((element) => {
    const rectangle = element.getBoundingClientRect();
    if (!element.isConnected || rectangle.width <= 0 || rectangle.height <= 0) return false;
    const text = normalize(element.getAttribute("aria-label") ?? element.textContent).toLowerCase();
    return (
      new RegExp(`(?:^|\\b)${rows}\\s+rows?\\b[\\s\\S]{0,80}\\b${columns}\\s+columns?\\b`, "u").test(text) ||
      new RegExp(`(?:^|\\b)rows?\\s*[:=]?\\s*${rows}\\b[\\s\\S]{0,80}\\bcolumns?\\s*[:=]?\\s*${columns}\\b`, "u").test(
        text
      )
    );
  });
}

interface IntegerProfileObservation {
  readonly distinct: DistinctEvidence;
}

/** Closure-free public-text profile oracle. It returns semantics, never row values or DOM text. */
export function observeNotebookTrialIntegerProfile(input: {
  readonly column: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly rows: number;
}): IntegerProfileObservation | null {
  const runtime = globalThis as unknown as { readonly document: NotebookTrialDocument } & NotebookTrialWindow;
  if (
    typeof input?.column !== "string" ||
    !/^c\d{2}$/u.test(input.column) ||
    !Number.isSafeInteger(input.minimum) ||
    !Number.isSafeInteger(input.maximum) ||
    !Number.isSafeInteger(input.rows)
  ) {
    return null;
  }
  const normalize = (value: string | null): string => (value ?? "").replace(/[,_]/gu, "").replace(/\s+/gu, " ").trim();
  const visible = (element: NotebookTrialElement): boolean => {
    const rectangle = element.getBoundingClientRect();
    if (!element.isConnected || rectangle.width <= 0 || rectangle.height <= 0) return false;
    let current: NotebookTrialElement | null = element;
    while (current) {
      const style = runtime.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      current = current.parentElement;
    }
    return true;
  };
  const candidates = Array.from(
    runtime.document.querySelectorAll('aside, [role="complementary"], [role="region"], section, [role="tabpanel"]')
  )
    .slice(0, 512)
    .filter(visible)
    .sort((left, right) => normalize(left.textContent).length - normalize(right.textContent).length);
  for (const candidate of candidates) {
    const fragments = [candidate.getAttribute("aria-label") ?? "", candidate.textContent ?? ""];
    for (const descendant of Array.from(candidate.querySelectorAll("*")).slice(0, 512)) {
      fragments.push(descendant.getAttribute("aria-label") ?? "", descendant.textContent ?? "");
    }
    const text = normalize(fragments.join(" "));
    const lower = text.toLowerCase();
    if (!new RegExp(`(?:^|\\b)${input.column}(?:\\b|[,;:()\\[\\]{}-])`, "u").test(text)) continue;
    if (/\b(?:loading|profiling|calculating|pending)\b/iu.test(text)) continue;
    if (!/\b(?:int64|integer|number|numeric)\b/iu.test(text)) continue;
    if (!/\b(?:missing|null(?:s| values?)?)\s*[:=]?\s*0(?:\b|%)/iu.test(text)) continue;
    if (!new RegExp(`\\b(?:min|minimum)\\s*[:=]?\\s*${input.minimum}\\b`, "iu").test(text)) continue;
    if (!new RegExp(`\\b(?:max|maximum)\\s*[:=]?\\s*${input.maximum}\\b`, "iu").test(text)) continue;
    const exactCount = new RegExp(`\\b(?:distinct|unique)(?:\\s+values?)?\\s*[:=]?\\s*${input.rows}\\b`, "iu").test(
      text
    );
    const exactPercent = /\b(?:distinct|unique)(?:\s+values?)?\s*[:=]?\s*100(?:\.0+)?%\b/iu.test(lower);
    if (exactCount || exactPercent) return { distinct: exactCount ? "exact-count" : "exact-100-percent" };
  }
  return null;
}

interface CapturedStudyNotebook {
  readonly notebook: vscode.NotebookDocument;
  readonly editor: vscode.NotebookEditor;
  readonly definition: NotebookTrialDefinition;
  readonly cells: {
    readonly setup: vscode.NotebookCell;
    readonly before: vscode.NotebookCell;
    readonly measured: vscode.NotebookCell;
    readonly after: vscode.NotebookCell;
  };
  assertExact(checkpoint: string): void;
}

export async function run(): Promise<DataWranglerNotebookTrialPhaseReceipt> {
  const product = studyProductFromPhase(requiredEnvironment("OPEN_WRANGLER_TEST_PHASE"));
  assert.equal(
    vscode.env.language,
    DATA_WRANGLER_STUDY_REQUIRED_LOCALE,
    "The notebook study driver requires VS Code launched with --locale=en."
  );
  recordProgress("comparison-study:workbench-connect");
  const { page } = await connectToEditorWorkbench();
  await waitForWorkbenchReady(page);
  recordProgress("comparison-study:notebook-capture");
  const captured = await captureStudyNotebook();
  const dependencies = createRealNotebookTrialDependencies(product, page, captured);
  let result: DataWranglerNotebookTrialPhaseReceipt | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    result = await executeDataWranglerNotebookTrialFlow(dependencies);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await dependencies.dispose();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Notebook trial failed and its interaction handles did not close."
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  assert.ok(result, "Notebook trial completed without its strict phase receipt.");
  recordProgress("comparison-study:phase-receipt");
  return result;
}

function createRealNotebookTrialDependencies(
  product: ProductKey,
  page: Page,
  captured: CapturedStudyNotebook
): NotebookTrialFlowDependencies & { dispose(): Promise<void> } {
  let inlineTarget: NotebookTrialActionTarget | undefined;
  let inlineObservation: InlineActionObservation | undefined;
  let sourceTab: vscode.Tab | undefined;
  let tabsBeforeAction: readonly vscode.Tab[] | undefined;
  let baselineFrames: ReadonlySet<Frame> | undefined;
  let baselinePages: ReadonlySet<Page> | undefined;
  let targetTab: vscode.Tab | undefined;
  let gridFrame: Frame | undefined;
  let profileDeadline = 0;
  let inlineDeadline = 0;
  let workbenchDeadline = 0;
  let measuredRunTarget: NotebookTrialActionTarget | undefined;

  const execute = (cell: vscode.NotebookCell, checkpoint: string): Promise<void> =>
    executeStudyNotebookCell(captured, cell, checkpoint);

  const closeProductEditorAndRestoreNotebook = async (): Promise<void> => {
    if (targetTab && allEditorTabs().includes(targetTab)) {
      await vscode.window.tabGroups.close(targetTab, true);
      await waitFor(
        () => !allEditorTabs().includes(targetTab as vscode.Tab),
        15_000,
        "the measured product editor to close"
      );
    }
    targetTab = undefined;
    gridFrame = undefined;
    const editor = await vscode.window.showNotebookDocument(captured.notebook, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false
    });
    assert.equal(editor.notebook, captured.notebook, "Restoring the trial notebook changed its exact document.");
    captured.assertExact("after restoring its notebook editor");
  };

  return {
    product,
    study: captured.definition,
    now: () => performance.now(),
    timeOriginUnixMs: performance.timeOrigin,
    assertExactNotebook: captured.assertExact,
    async selectKernel() {
      recordProgress("comparison-study:kernel-select");
      await selectStudyNotebookKernel(page, captured);
      recordProgress("comparison-study:kernel-selected");
    },
    async executeSetup() {
      recordProgress("comparison-study:setup");
      await execute(captured.cells.setup, "comparison-study:setup");
    },
    async executeVerification(phase) {
      const cell = phase === "before-timing" ? captured.cells.before : captured.cells.after;
      recordProgress(`comparison-study:${phase}`);
      await execute(cell, `comparison-study:${phase}`);
      return readStudyVerification(cell, captured.definition, phase);
    },
    async countExactInlineActions() {
      const candidates = await discoverExactInlineActionTargets(page, product);
      try {
        return candidates.length;
      } finally {
        await disposeActionTargets(candidates);
      }
    },
    async prepareMeasuredAction() {
      recordProgress("comparison-study:inline-action-prepare");
      measuredRunTarget = await preparePublicStudyRunCellAction(page, captured, captured.cells.measured);
      return requirePointerActionEvidence(measuredRunTarget);
    },
    executeMeasured(immediatelyBeforePointerClick, immediatelyAfterCellCompletion) {
      assert.ok(measuredRunTarget, "The measured public Run Cell action was not prepared.");
      return executeStudyNotebookCellFromPointer(
        captured,
        captured.cells.measured,
        measuredRunTarget,
        () => {
          inlineDeadline = Date.now() + DATA_WRANGLER_STUDY_INLINE_ACTION_WINDOW_MS;
          immediatelyBeforePointerClick();
        },
        immediatelyAfterCellCompletion,
        "comparison-study:measured"
      );
    },
    async waitForInlineAction(immediatelyAfterReady) {
      assert.ok(inlineDeadline > Date.now(), "The inline evidence window did not start at the Run Cell pointer.");
      const deadline = inlineDeadline;
      let sawExactAction = false;
      do {
        captured.assertExact("while discovering the measured inline action");
        const candidates = await discoverExactInlineActionTargets(page, product);
        if (candidates.length > 1) {
          await disposeActionTargets(candidates);
          throw new Error("The measured output exposed more than one exact product Open action.");
        }
        const candidate = candidates[0];
        if (candidate) {
          sawExactAction = true;
          const observation = await candidate.inlineObservation(product);
          if (observation?.sentinelsVisibleWithAction) {
            inlineTarget = candidate;
            inlineObservation = observation;
            immediatelyAfterReady();
            recordProgress("comparison-study:inline-ready");
            return {
              evidence: observation.evidence,
              surfaceKind:
                product === "open-wrangler" ? "open-wrangler-renderer" : "data-wrangler-action-on-host-output",
              sentinelsVisibleWithAction: true
            };
          }
          await candidate.dispose();
        }
        await page.waitForTimeout(25);
      } while (Date.now() < deadline);
      if (product === "data-wrangler" && captured.definition.engine === "polars" && !sawExactAction) {
        recordProgress("comparison-study:polars-unsupported");
        return null;
      }
      throw new Error(
        sawExactAction
          ? "The exact product Open action appeared without a stable inline sentinel surface."
          : "The measured output did not expose its exact product Open action within 45000 ms."
      );
    },
    async clickInlineAction(immediatelyBeforePointerClick) {
      assert.ok(inlineTarget && inlineObservation, "The measured inline action was not retained for activation.");
      captured.assertExact("immediately before the measured Open action");
      tabsBeforeAction = Object.freeze([...allEditorTabs()]);
      sourceTab = selectedStudyNotebookTab(captured.notebook);
      const frames = comparisonFrames(page);
      baselineFrames = new Set(frames);
      baselinePages = new Set(frames.map((frame) => frame.page()));
      const currentEvidence = await requirePointerActionEvidence(inlineTarget);
      assert.equal(inlineActionNameMatches(product, currentEvidence.accessibleName), true);
      recordProgress("comparison-study:workbench-action");
      await activateAcceptancePointerTargetAtCurrentCenter(inlineTarget, POINTER_ACTION_TIMEOUT_MS, () => {
        workbenchDeadline = Date.now() + DATA_WRANGLER_STUDY_WORKBENCH_WINDOW_MS;
        immediatelyBeforePointerClick();
      });
      return currentEvidence;
    },
    async waitForWorkbenchAndScroll(immediatelyAfterReady) {
      assert.ok(sourceTab && tabsBeforeAction && baselineFrames && baselinePages);
      const remainingMs = workbenchDeadline - Date.now();
      assert.ok(remainingMs >= 1, "The workbench evidence window expired before grid discovery began.");
      const readiness = await waitForGenericGridReadiness(
        page,
        baselineFrames,
        baselinePages,
        Math.min(DATA_WRANGLER_STUDY_WORKBENCH_WINDOW_MS, Math.ceil(remainingMs))
      );
      gridFrame = readiness.frame;
      targetTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(
        targetTab &&
          targetTab !== sourceTab &&
          (targetTab.input instanceof vscode.TabInputCustom || targetTab.input instanceof vscode.TabInputWebview),
        "The measured Open action must select one new product custom/webview editor."
      );
      const opened = comparisonTabsOpenedAfter(tabsBeforeAction, allEditorTabs());
      assert.deepEqual(
        opened,
        [targetTab],
        "The measured Open action must create exactly one selected product editor."
      );
      assert.equal(await frameChainIsVisibleAndPointerUsable(gridFrame), true);
      const workbench = await comparisonWorkbenchReadiness(page, sourceTab, true);
      assert.ok(Date.now() <= workbenchDeadline, "Workbench readiness exceeded its fixed 60000 ms window.");
      immediatelyAfterReady();
      recordProgress("comparison-study:workbench-ready");
      const fullShape = await requireCompleteGridShape(gridFrame, readiness.grid, captured.definition.fixture);
      const scroll = await exerciseNotebookTrialGridScroll(gridFrame);
      return {
        newlySelectedProductEditor: true,
        grid: readiness.grid,
        workbench,
        fullShape,
        scroll
      };
    },
    async restoreFirstRows() {
      assert.ok(gridFrame, "The measured product grid is unavailable for restoration.");
      await restoreNotebookTrialGridFirstRows(gridFrame);
      recordProgress("comparison-study:grid-restored");
    },
    async activateProfiles(immediatelyBeforePointerClick) {
      assert.ok(gridFrame, "The measured product grid is unavailable for profiling.");
      const target =
        product === "open-wrangler"
          ? await findUniqueVisiblePointerTarget(
              gridFrame,
              gridFrame.getByRole("button", { name: "Column profiles and filters", exact: true }),
              "button",
              "the Open Wrangler Column profiles action"
            )
          : await findVisibleGridColumnHeader(gridFrame, "c00", true);
      assert.ok(target, "The measured product did not expose its public profiling action.");
      const evidence = await requirePointerActionEvidence(target);
      recordProgress("comparison-study:profile-action");
      await activateAcceptancePointerTargetAtCurrentCenter(target, POINTER_ACTION_TIMEOUT_MS, () => {
        profileDeadline = Date.now() + DATA_WRANGLER_STUDY_PROFILE_WINDOW_MS;
        immediatelyBeforePointerClick();
      });
      return evidence;
    },
    async profileColumn(index, immediatelyAfterReady) {
      assert.ok(gridFrame && profileDeadline > 0, "The profile traversal began without its public action.");
      const column = comparisonColumnName(index);
      if (product === "open-wrangler") {
        await revealGridColumnHeader(gridFrame, column, profileDeadline);
        const target = await findVisibleGridCellForColumn(gridFrame, index);
        await activateAcceptancePointerTargetAtCurrentCenter(target, POINTER_ACTION_TIMEOUT_MS);
      } else if (index > 0) {
        const header = await revealGridColumnHeader(gridFrame, column, profileDeadline);
        await activateAcceptancePointerTargetAtCurrentCenter(header, POINTER_ACTION_TIMEOUT_MS);
      }
      const expected = {
        column,
        minimum: index,
        maximum: captured.definition.fixture.rows - 1 + index,
        rows: captured.definition.fixture.rows
      };
      let observed: IntegerProfileObservation | null = null;
      do {
        observed = await gridFrame.evaluate(observeNotebookTrialIntegerProfile, expected).catch(() => null);
        if (observed) break;
        await page.waitForTimeout(PROFILE_POLL_MS);
      } while (Date.now() < profileDeadline);
      if (!observed) {
        throw new Error(`The public profile for ${column} did not reach its final integer summary within 135000 ms.`);
      }
      assert.ok(Date.now() <= profileDeadline, "Profile traversal exceeded its fixed 135000 ms window.");
      immediatelyAfterReady();
      if (index === captured.definition.fixture.columns - 1) {
        recordProgress("comparison-study:profiles-complete");
      }
      return {
        column,
        type: "signed-64-bit",
        missingCount: 0,
        minimumMatched: true,
        maximumMatched: true,
        distinct: observed.distinct,
        rowValuesIncluded: false
      };
    },
    closeProductEditorAndRestoreNotebook,
    async dispose() {
      await inlineTarget?.dispose();
      inlineTarget = undefined;
      await measuredRunTarget?.dispose();
      measuredRunTarget = undefined;
      const currentTabs = allEditorTabs();
      const cleanupTabs = tabsBeforeAction
        ? [...comparisonTabsOpenedAfter(tabsBeforeAction, currentTabs)]
        : targetTab && currentTabs.includes(targetTab)
          ? [targetTab]
          : [];
      if (cleanupTabs.length > 0) {
        await vscode.window.tabGroups.close(cleanupTabs, true);
      }
    }
  };
}

async function captureStudyNotebook(): Promise<CapturedStudyNotebook> {
  const uris = await vscode.workspace.findFiles("*.ipynb", "**/.ipynb_checkpoints/**", 2);
  assert.equal(uris.length, 1, "The notebook trial workspace must contain exactly one study notebook.");
  const uri = uris[0]!;
  const openMatches = (): vscode.NotebookDocument[] =>
    vscode.workspace.notebookDocuments.filter(
      (candidate) => !candidate.isClosed && candidate.uri.toString() === uri.toString()
    );
  assert.ok(openMatches().length <= 1, "The study notebook URI is already open through duplicate document objects.");
  const notebook = openMatches()[0] ?? (await vscode.workspace.openNotebookDocument(uri));
  assert.equal(notebook.notebookType, "jupyter-notebook", "The study source must open as a Jupyter notebook.");
  const editor = await vscode.window.showNotebookDocument(notebook, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false,
    preview: false
  });
  assert.equal(editor.notebook, notebook);
  const definition = decodeStudyNotebookDefinition(notebook);
  const tagged = {
    setup: requireTaggedStudyCell(notebook, "ow-study-setup"),
    before: requireTaggedStudyCell(notebook, "ow-study-before-timing"),
    measured: requireTaggedStudyCell(notebook, "ow-study-measured"),
    after: requireTaggedStudyCell(notebook, "ow-study-after-workbench")
  };
  assert.equal(notebook.cellCount, 5, "The study notebook must retain its exact notice and four code cells.");
  assert.equal(notebook.cellAt(1), tagged.setup);
  assert.equal(notebook.cellAt(2), tagged.before);
  assert.equal(notebook.cellAt(3), tagged.measured);
  assert.equal(notebook.cellAt(4), tagged.after);
  const measuredSource = tagged.measured.document.getText().trimEnd();
  assert.equal(
    measuredSource,
    definition.kind === "warm" ? "study_frame" : "study_frame = _ow_load_study_frame()\nstudy_frame",
    "The measured cell must evaluate the exact study_frame workload."
  );
  for (const cell of Object.values(tagged)) {
    assert.equal(cell.kind, vscode.NotebookCellKind.Code);
    assert.equal(cell.outputs.length, 0, "A fresh notebook trial cannot retain code-cell outputs.");
  }
  const sources = new Map(Object.values(tagged).map((cell) => [cell, cell.document.getText()]));
  const assertExact = (checkpoint: string): void => {
    const matches = openMatches();
    assert.equal(matches.length, 1, `The study notebook URI must identify one open object ${checkpoint}.`);
    assert.equal(matches[0], notebook, `The exact study notebook object changed ${checkpoint}.`);
    assert.equal(notebook.isClosed, false, `The exact study notebook closed ${checkpoint}.`);
    assert.equal(notebook.cellCount, 5, `The exact study notebook cell count changed ${checkpoint}.`);
    for (const [cell, source] of sources) {
      assert.equal(cell.document.getText(), source, `A study cell source changed ${checkpoint}.`);
    }
  };
  assertExact("after capture");
  return { notebook, editor, definition, cells: tagged, assertExact };
}

function decodeStudyNotebookDefinition(notebook: vscode.NotebookDocument): NotebookTrialDefinition {
  const metadata = requireRecord(notebook.metadata, "Study notebook metadata");
  const study = requireRecord(metadata.openWranglerStudy, "Study notebook contract");
  exactKeys(
    study,
    [
      "protocol",
      "engine",
      "format",
      "kind",
      "kernel",
      "fixture",
      "sourceEnvironmentVariable",
      "outputsMustRemainPathFree"
    ],
    "Study notebook contract"
  );
  if (
    study.protocol !== DATA_WRANGLER_NOTEBOOK_PROTOCOL ||
    study.sourceEnvironmentVariable !== "OPEN_WRANGLER_STUDY_SOURCE" ||
    study.outputsMustRemainPathFree !== true
  ) {
    fail("Study notebook metadata does not match its path-free protocol.");
  }
  const definition = validateTrialDefinition({
    engine: study.engine,
    format: study.format,
    kind: study.kind,
    fixture: study.fixture,
    kernel: study.kernel
  });
  const kernelspec = requireRecord(metadata.kernelspec, "Study notebook kernelspec");
  if (
    kernelspec.name !== definition.kernel.name ||
    kernelspec.display_name !== definition.kernel.displayName ||
    kernelspec.language !== "python"
  ) {
    fail("Study notebook kernelspec does not match its exact trial-private kernel.");
  }
  return definition;
}

function requireTaggedStudyCell(notebook: vscode.NotebookDocument, tag: string): vscode.NotebookCell {
  const matches = [...Array(notebook.cellCount).keys()]
    .map((index) => notebook.cellAt(index))
    .filter((cell) => {
      const metadata = cell.metadata as { readonly tags?: unknown };
      return Array.isArray(metadata.tags) && metadata.tags.includes(tag);
    });
  assert.equal(matches.length, 1, `The study notebook must contain exactly one ${tag} cell.`);
  return matches[0]!;
}

function selectedStudyNotebookTab(notebook: vscode.NotebookDocument): vscode.Tab {
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(active, "The exact study notebook must own the selected editor tab.");
  assert.equal(
    active.input instanceof vscode.TabInputNotebook && active.input.uri.toString() === notebook.uri.toString(),
    true,
    "The exact study notebook must remain selected before its product action."
  );
  return active;
}

async function preparePublicStudyRunCellAction(
  page: Page,
  captured: CapturedStudyNotebook,
  cell: vscode.NotebookCell
): Promise<NotebookTrialActionTarget> {
  captured.assertExact("before preparing the public Run Cell action");
  assert.equal(vscode.window.activeNotebookEditor, captured.editor, "The exact study notebook editor must be active.");
  const selection = new vscode.NotebookRange(cell.index, cell.index + 1);
  captured.editor.selection = selection;
  captured.editor.selections = [selection];
  captured.editor.revealRange(selection, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);

  const assertSelection = (): void => {
    captured.assertExact("while preparing the public Run Cell action");
    assert.equal(vscode.window.activeNotebookEditor, captured.editor, "Run Cell preparation changed notebook editors.");
    assert.equal(captured.editor.selection.start, cell.index);
    assert.equal(captured.editor.selection.end, cell.index + 1);
    assert.deepEqual(
      captured.editor.selections.map(({ start, end }) => ({ start, end })),
      [{ start: cell.index, end: cell.index + 1 }],
      "Run Cell preparation must retain one exact measured-cell selection."
    );
  };

  const deadline = Date.now() + POINTER_ACTION_TIMEOUT_MS;
  do {
    assertSelection();
    const matches: NotebookTrialActionTarget[] = [];
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      const selectedRows = frame.locator(
        '[role="listitem"][aria-selected="true"], [role="option"][aria-selected="true"], [role="treeitem"][aria-selected="true"]'
      );
      const rowCount = Math.min(await selectedRows.count().catch(() => 0), 16);
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = selectedRows.nth(rowIndex);
        const label = (await row.getAttribute("aria-label").catch(() => null))?.trim() ?? "";
        if (!/^code cell(?:,|$)/u.test(label) || !(await row.isVisible().catch(() => false))) continue;
        const rowBox = await row.boundingBox().catch(() => null);
        if (rowBox && rowBox.width > 0 && rowBox.height > 0) {
          await frame.page().mouse.move(rowBox.x + Math.min(20, rowBox.width / 2), rowBox.y + rowBox.height / 2);
        }
        const actions = row.getByRole("button", { name: EXECUTE_CELL_ACCESSIBLE_NAME });
        const actionCount = Math.min(await actions.count().catch(() => 0), 4);
        for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
          const target = await pointerActionTargetFromLocator(actions.nth(actionIndex), frame, "button").catch(
            () => undefined
          );
          if (target) matches.push(target);
        }
      }
    }
    if (matches.length === 1) {
      assertSelection();
      return matches[0]!;
    }
    assert.ok(matches.length <= 1, "The selected measured cell exposed multiple public Execute Cell actions.");
    await page.waitForTimeout(25);
  } while (Date.now() < deadline);
  throw new Error("The selected measured cell did not expose its exact public Execute Cell action.");
}

async function selectStudyNotebookKernel(page: Page, captured: CapturedStudyNotebook): Promise<void> {
  captured.assertExact("before selecting its private kernel");
  const selection = Promise.resolve(
    vscode.commands.executeCommand("notebook.selectKernel", { notebookEditor: captured.editor })
  );
  type SelectionState = "pending" | "fulfilled" | "rejected";
  const state: { value: SelectionState } = { value: "pending" };
  let failure: unknown;
  void selection.then(
    () => {
      state.value = "fulfilled";
    },
    (error: unknown) => {
      state.value = "rejected";
      failure = error;
    }
  );
  const deadline = Date.now() + 30_000;
  const traversed = new Set<string>();
  let targetActivated = false;
  try {
    do {
      captured.assertExact("while selecting its private kernel");
      if (state.value === "rejected") throw failure;
      const quickInput = await visibleStudyKernelQuickInput(page);
      if (!quickInput) {
        if (targetActivated && state.value === "fulfilled") break;
        await page.waitForTimeout(25);
        continue;
      }
      const target = await studyKernelQuickPickRow(quickInput, captured.definition.kernel.displayName);
      if (target) {
        await target.click();
        targetActivated = true;
        await boundedPromise(selection, 30_000, "the exact private notebook kernel selection");
        break;
      }
      let advanced = false;
      for (const label of ["Select Another Kernel...", "Jupyter Kernel...", "Jupyter", "Local Kernel Specs..."]) {
        if (traversed.has(label)) continue;
        const route = await studyKernelQuickPickRow(quickInput, label);
        if (!route) continue;
        traversed.add(label);
        await route.click();
        advanced = true;
        await page.waitForTimeout(50);
        break;
      }
      if (!advanced) {
        const input = quickInput.locator(".quick-input-box input:visible").first();
        if ((await input.count().catch(() => 0)) === 1) {
          await input.fill(captured.definition.kernel.displayName);
        }
        await page.waitForTimeout(50);
      }
    } while (Date.now() < deadline);
  } catch (error) {
    await dismissStudyKernelPicker(page);
    throw error;
  }
  if (!targetActivated) {
    await dismissStudyKernelPicker(page);
    throw new Error("The released Jupyter picker did not expose the exact trial-private CPython 3.12 kernel.");
  }
  captured.assertExact("after selecting its private kernel");
  await waitForStudyKernelLabel(page, captured.definition.kernel.displayName);
}

async function visibleStudyKernelQuickInput(page: Page): Promise<Locator | undefined> {
  const matches: Locator[] = [];
  for (const frame of comparisonFrames(page).slice(0, 64)) {
    const candidates = frame.locator(".quick-input-widget:visible");
    const count = Math.min(await candidates.count().catch(() => 0), 8);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
    }
  }
  assert.ok(matches.length <= 1, "The released Jupyter kernel picker exposed more than one visible Quick Input.");
  return matches[0];
}

async function studyKernelQuickPickRow(quickInput: Locator, label: string): Promise<Locator | undefined> {
  const labels = quickInput.locator(".quick-input-list [role='option'] .label-name:visible");
  const count = await labels.count();
  assert.ok(count <= 256, "The released Jupyter kernel picker exceeded 256 visible options.");
  const rows: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = labels.nth(index);
    if ((await candidate.innerText()).trim() === label) {
      rows.push(candidate.locator("xpath=ancestor::*[@role='option'][1]"));
    }
  }
  assert.ok(rows.length <= 1, `The released Jupyter picker exposed duplicate ${JSON.stringify(label)} rows.`);
  return rows[0];
}

async function dismissStudyKernelPicker(page: Page): Promise<void> {
  const quickInput = await visibleStudyKernelQuickInput(page).catch(() => undefined);
  const input = quickInput?.locator(".quick-input-box input:visible").first();
  if (input && (await input.count().catch(() => 0)) > 0) await input.press("Escape").catch(() => undefined);
}

async function waitForStudyKernelLabel(page: Page, expectedLabel: string): Promise<void> {
  await waitFor(
    async () => {
      let matches = 0;
      for (const frame of comparisonFrames(page).slice(0, 64)) {
        const labels = frame.locator(".kernel-action-view-item .kernel-label:visible");
        const count = Math.min(await labels.count().catch(() => 0), 16);
        for (let index = 0; index < count; index += 1) {
          if (
            (
              await labels
                .nth(index)
                .innerText()
                .catch(() => "")
            ).trim() === expectedLabel
          )
            matches += 1;
        }
      }
      assert.ok(matches <= 1, "The workbench exposed duplicate exact private kernel labels.");
      return matches === 1;
    },
    10_000,
    "the selected private CPython 3.12 kernel label"
  );
}

async function executeStudyNotebookCell(
  captured: CapturedStudyNotebook,
  cell: vscode.NotebookCell,
  checkpoint: string
): Promise<void> {
  const index = cell.index;
  return executeStudyNotebookCellWithDispatch(captured, cell, checkpoint, () =>
    Promise.resolve(
      vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [{ start: index, end: index + 1 }],
        document: captured.notebook.uri
      })
    ).then(() => undefined)
  );
}

async function executeStudyNotebookCellFromPointer(
  captured: CapturedStudyNotebook,
  cell: vscode.NotebookCell,
  target: NotebookTrialActionTarget,
  immediatelyBeforePointerClick: () => void,
  immediatelyAfterCellCompletion: () => void,
  checkpoint: string
): Promise<void> {
  return executeStudyNotebookCellWithDispatch(
    captured,
    cell,
    checkpoint,
    async () => {
      const evidence = await requirePointerActionEvidence(target);
      validateRunCellActionEvidence(evidence);
      await activateAcceptancePointerTargetAtCurrentCenter(
        target,
        POINTER_ACTION_TIMEOUT_MS,
        immediatelyBeforePointerClick
      );
    },
    immediatelyAfterCellCompletion
  );
}

async function executeStudyNotebookCellWithDispatch(
  captured: CapturedStudyNotebook,
  cell: vscode.NotebookCell,
  checkpoint: string,
  dispatch: () => Promise<void>,
  immediatelyAfterCellCompletion?: () => void
): Promise<void> {
  captured.assertExact(`before ${checkpoint}`);
  const index = cell.index;
  assert.equal(captured.notebook.cellAt(index), cell, `The ${checkpoint} cell identity changed before execution.`);
  let freshSummary = false;
  let completionBoundaryRecorded = false;
  let completionBoundaryFailure: unknown;
  const listener = vscode.workspace.onDidChangeNotebookDocument((event) => {
    if (event.notebook !== captured.notebook) return;
    for (const change of event.cellChanges) {
      if (change.cell !== cell || change.executionSummary === undefined) continue;
      freshSummary = true;
      if (change.executionSummary.success === true && immediatelyAfterCellCompletion && !completionBoundaryRecorded) {
        completionBoundaryRecorded = true;
        try {
          immediatelyAfterCellCompletion();
        } catch (error) {
          completionBoundaryFailure = error;
        }
      }
    }
  });
  try {
    const dispatched = dispatch();
    type DispatchState = "pending" | "fulfilled" | "rejected";
    const state: { value: DispatchState } = { value: "pending" };
    let failure: unknown;
    void dispatched.then(
      () => {
        state.value = "fulfilled";
      },
      (error: unknown) => {
        state.value = "rejected";
        failure = error;
      }
    );
    const deadline = Date.now() + NOTEBOOK_CELL_TIMEOUT_MS;
    do {
      captured.assertExact(`while ${checkpoint} executes`);
      if (completionBoundaryFailure !== undefined) throw completionBoundaryFailure;
      if (state.value === "rejected") throw failure;
      if (freshSummary && cell.executionSummary?.success === true) {
        if (immediatelyAfterCellCompletion && !completionBoundaryRecorded) {
          completionBoundaryRecorded = true;
          immediatelyAfterCellCompletion();
        }
        await boundedPromise(dispatched, 10_000, `${checkpoint} action completion`);
        captured.assertExact(`after ${checkpoint}`);
        return;
      }
      if (freshSummary && cell.executionSummary?.success === false) {
        throw new Error(releasedNotebookExecutionFailureMessage(index, cell.outputs));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error(
      `${checkpoint} did not publish a fresh successful execution summary. ` +
        `Action=${state.value}; output=${releasedNotebookOutputClassification(cell.outputs)}.`
    );
  } finally {
    listener.dispose();
  }
}

function readStudyVerification(
  cell: vscode.NotebookCell,
  study: NotebookTrialDefinition,
  phase: NotebookTrialVerificationEvidence["phase"]
): NotebookTrialVerificationEvidence {
  const bytes = Buffer.concat(cell.outputs.flatMap((output) => output.items.map((item) => Buffer.from(item.data))));
  if (bytes.length === 0 || bytes.length > MAX_NOTEBOOK_OUTPUT_BYTES) {
    fail("Study verification output is absent or exceeds 32 KiB.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const markers = text.split(DATA_WRANGLER_NOTEBOOK_VERIFICATION_MARKER);
  if (markers.length !== 2) fail("Study verification output must contain exactly one correlated JSON marker.");
  const serialized = markers[1]!.trim().split(/\r?\n/u)[0];
  if (!serialized) fail("Study verification output omitted its JSON receipt.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("Study verification output is not strict JSON.");
  }
  const raw = requireRecord(parsed, "Study verification output");
  exactKeys(
    raw,
    [
      "protocol",
      "phase",
      "fixtureId",
      "fixtureSha256",
      "engine",
      "configuredKernel",
      "pythonImplementation",
      "pythonVersion",
      "actualClass",
      "shape",
      "columns",
      "dtypes",
      "integerDtypeSemantic",
      "sentinelRows",
      "classMatched",
      "shapeMatched",
      "columnsMatched",
      "integerDtypeMatched",
      "sentinelsMatched",
      "objectTokenContinuous",
      "rowDataIncluded"
    ],
    "Study verification output"
  );
  const expectedColumns = Array.from({ length: study.fixture.columns }, (_item, index) => comparisonColumnName(index));
  const expectedDtype = study.engine === "pandas" ? "int64" : "Int64";
  const actualClass = requireRecord(raw.actualClass, "Study verification class");
  exactKeys(actualClass, ["module", "name"], "Study verification class");
  const configuredKernel = requireRecord(raw.configuredKernel, "Study verification kernel");
  exactKeys(configuredKernel, ["name", "displayName"], "Study verification kernel");
  if (
    raw.protocol !== DATA_WRANGLER_NOTEBOOK_VERIFICATION_PROTOCOL ||
    raw.phase !== phase ||
    raw.fixtureId !== study.fixture.id ||
    raw.fixtureSha256 !== study.fixture.sha256 ||
    raw.engine !== study.engine ||
    configuredKernel.name !== study.kernel.name ||
    configuredKernel.displayName !== study.kernel.displayName ||
    raw.pythonImplementation !== "CPython" ||
    !isStringMatching(raw.pythonVersion, PYTHON_312) ||
    actualClass.name !== "DataFrame" ||
    actualClass.module !== (study.engine === "pandas" ? "pandas.core.frame" : "polars.dataframe.frame") ||
    JSON.stringify(raw.shape) !== JSON.stringify([study.fixture.rows, study.fixture.columns]) ||
    JSON.stringify(raw.columns) !== JSON.stringify(expectedColumns) ||
    !Array.isArray(raw.dtypes) ||
    raw.dtypes.length !== study.fixture.columns ||
    raw.dtypes.some((dtype) => dtype !== expectedDtype) ||
    raw.integerDtypeSemantic !== "signed-64-bit" ||
    JSON.stringify(raw.sentinelRows) !==
      JSON.stringify([0, Math.floor(study.fixture.rows / 2), study.fixture.rows - 1]) ||
    raw.classMatched !== true ||
    raw.shapeMatched !== true ||
    raw.columnsMatched !== true ||
    raw.integerDtypeMatched !== true ||
    raw.sentinelsMatched !== true ||
    raw.objectTokenContinuous !== (study.kind === "warm" ? true : null) ||
    raw.rowDataIncluded !== false
  ) {
    fail("Study verification output does not match its exact engine, kernel, fixture, and sentinel contract.");
  }
  assertPathFreeJson(raw);
  return {
    phase,
    pythonImplementation: "CPython",
    pythonVersion: raw.pythonVersion as string,
    classMatched: true,
    shapeMatched: true,
    columnsMatched: true,
    integerDtypeMatched: true,
    sentinelsMatched: true,
    objectTokenContinuous: study.kind === "warm" ? true : null,
    rowDataIncluded: false
  };
}

async function requireCompleteGridShape(
  frame: Frame,
  grid: ComparisonGridReadinessEvidence,
  fixture: NotebookTrialDefinition["fixture"]
): Promise<"aria-counts" | "visible-shape-label"> {
  if (grid.ariaRowCount === fixture.rows && grid.ariaColumnCount === fixture.columns) return "aria-counts";
  const visible = await frame.evaluate(observeNotebookTrialVisibleShape, {
    rows: fixture.rows,
    columns: fixture.columns
  });
  assert.equal(visible, true, "The product grid did not expose the complete release-sized source shape.");
  return "visible-shape-label";
}

async function findUniqueVisiblePointerTarget(
  frame: Frame,
  candidates: Locator,
  role: "button" | "columnheader",
  label: string
): Promise<NotebookTrialActionTarget | undefined> {
  const matches: NotebookTrialActionTarget[] = [];
  const count = Math.min(await candidates.count().catch(() => 0), 64);
  for (let index = 0; index < count; index += 1) {
    const candidate = await pointerActionTargetFromLocator(candidates.nth(index), frame, role).catch(() => undefined);
    if (candidate) matches.push(candidate);
  }
  assert.ok(matches.length <= 1, `The product exposed more than one visible pointer target for ${label}.`);
  return matches[0];
}

async function findVisibleGridColumnHeader(
  frame: Frame,
  column: string,
  requireNow = false
): Promise<NotebookTrialActionTarget | undefined> {
  const state = await frame.evaluate(observeNotebookTrialGridScrollState);
  assert.ok(state, "The product grid disappeared during canonical column traversal.");
  const root = frame.locator('[role="grid"], [role="table"], table').nth(state.rootOrdinal);
  const pattern = new RegExp(`^${column}(?:\\b|[,;:()\\[\\]{}\\u2013\\u2014-])`, "u");
  const target = await findUniqueVisiblePointerTarget(
    frame,
    root.getByRole("columnheader", { name: pattern }),
    "columnheader",
    `column ${column}`
  );
  if (requireNow) assert.ok(target, `The restored grid did not expose the exact ${column} column header.`);
  return target;
}

async function revealGridColumnHeader(
  frame: Frame,
  column: string,
  deadline: number
): Promise<NotebookTrialActionTarget> {
  do {
    const existing = await findVisibleGridColumnHeader(frame, column);
    if (existing) return existing;
    const state = await frame.evaluate(observeNotebookTrialGridScrollState);
    assert.ok(state, "The product grid disappeared while revealing its next canonical column.");
    const root = frame.locator('[role="grid"], [role="table"], table').nth(state.rootOrdinal);
    const box = await root.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0);
    const pointer = frame.page().mouse;
    await pointer.move(box.x + box.width / 2, box.y + box.height / 2);
    await pointer.wheel(Math.max(300, Math.round(box.width / 2)), 0);
    await frame.page().waitForTimeout(PROFILE_POLL_MS);
  } while (Date.now() < deadline);
  throw new Error(`The public grid could not reveal canonical profile column ${column} within 135000 ms.`);
}

async function findVisibleGridCellForColumn(
  frame: Frame,
  zeroBasedColumn: number
): Promise<NotebookTrialPointerTarget> {
  assert.ok(Number.isSafeInteger(zeroBasedColumn) && zeroBasedColumn >= 0 && zeroBasedColumn < 100);
  const state = await frame.evaluate(observeNotebookTrialGridScrollState);
  assert.ok(state, "The product grid disappeared while selecting its canonical profile column.");
  const root = frame.locator('[role="grid"], [role="table"], table').nth(state.rootOrdinal);
  const ariaColumnIndex = zeroBasedColumn + 2;
  const cells = root.locator(
    `[role="gridcell"][aria-colindex="${ariaColumnIndex}"], td[aria-colindex="${ariaColumnIndex}"]`
  );
  const count = Math.min(await cells.count().catch(() => 0), 64);
  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index);
    if (!(await cell.isVisible().catch(() => false))) continue;
    return {
      pointer: frame.page().mouse,
      boundingBox: () => cell.boundingBox(),
      evaluate: <Result>(pageFunction: (candidate: unknown) => Result | Promise<Result>) => cell.evaluate(pageFunction)
    };
  }
  throw new Error(`The public grid did not expose one visible data cell for canonical column ${zeroBasedColumn}.`);
}

async function boundedPromise<T>(promise: PromiseLike<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function studyProductFromPhase(value: string): ProductKey {
  if (!Object.hasOwn(PHASE_PRODUCTS, value)) {
    throw new Error("The notebook study phase must identify exactly one product trial.");
  }
  return PHASE_PRODUCTS[value as keyof typeof PHASE_PRODUCTS];
}

function requiredEnvironment(key: string): string {
  const value = process.env[key];
  assert.ok(value, `Missing required notebook study environment ${key}.`);
  return value;
}
