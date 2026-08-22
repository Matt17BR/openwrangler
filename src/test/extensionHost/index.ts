import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import * as vscode from "vscode";
import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type ElementHandle,
  type Frame,
  type Locator,
  type Page,
  type Request,
  type Response
} from "playwright-core";
import type { Jupyter, JupyterServerCollection } from "@vscode/jupyter-extension";
import type { PythonExtension } from "@vscode/python-extension";
import {
  DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS,
  DEFAULT_SESSION_OPEN_TIMEOUT_MS,
  getSetting
} from "../../extension/configuration";
import { IMPORT_DETECTION_SAMPLE_BYTES } from "../../extension/files/importDetection";
import { requiredDependencies } from "../../extension/pythonEnvironmentModel";
import { insertGeneratedNotebookCell } from "../../extension/notebooks/notebookInsertion";
import { R_KERNEL_RUNTIME_BINDING } from "../../extension/r/rKernelRuntimeBundle";
import {
  normalizeNotebookOutputPayload,
  OPEN_WRANGLER_MIME_V2,
  type NotebookOutputPayload
} from "../../shared/notebookOutput";
import { operationKinds as RELEASED_R_SUPPORTED_OPERATIONS } from "../../shared/operationCatalog.generated";
import type {
  ColumnReference,
  GridPage,
  LiveGridPage,
  OpenWranglerResponse,
  FilterModel,
  SessionMetadata,
  SessionSource,
  TransformStep
} from "../../shared/protocol";
import type { GridViewState } from "../../shared/viewState";
import {
  acquirePreparedAcceptanceAction,
  activateExactAcceptanceElementOnce,
  activateReplaceableAcceptanceLocator,
  diagnoseThenReacquireAcceptanceAction,
  ignoreRetiredRendererProbeFailure,
  invokeAcceptanceActionOnceWithAuthoritativeReceipt,
  isRetiredRendererTarget,
  pollAcceptanceCondition,
  pressKeyboardKeyPairWithoutTransitionGap,
  probeRendererButtonReadiness,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";
import { revealCodePreviewOperationLine, revealCodePreviewText, waitForCodePreview } from "./codePreview";
import { findCurrentWebviewAction, waitForReplaceableWebviewAction } from "./webviewActionDiscovery";
import { findExactActiveNotebookRendererButton } from "./notebookRendererFrame";
import { exactSessionApp, sameRendererSynchronizationReceipt } from "./acknowledgedRenderer";
import { verifyBackendSwitchPhysicalView } from "./backendSwitchPhysicalView";
import {
  assertExactBytes,
  ensureDeterministicDelimitedFixturePath,
  exerciseBoundedExactByteAssertionContract
} from "./acceptanceSourceFixture";
import {
  cleanupAcceptanceTemporaryDirectory,
  exerciseAcceptanceTemporaryDirectoryCleanupContract
} from "./acceptanceTemporaryDirectory";
import { createDependencyIsolatedPython, sameAcceptanceExecutable } from "./dependencyInstallLifecycleFixture";
import { createDependencyInstallShutdownJourney } from "./dependencyInstallShutdownJourney";
import {
  DEPENDENCY_GUARD_ACCEPTANCE_TOKEN,
  DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE,
  DEPENDENCY_GUARD_PROTOCOL,
  type DependencyGuardRecoveryFixture
} from "./dependencyGuardRecoveryFixture";
import {
  acceptanceProcessIsAlive,
  createAcceptanceSignalExclusively,
  readAcceptanceGuardStatus,
  type AcceptanceGuardProcess
} from "./dependencyGuardAcceptanceIo";
import {
  createInstrumentedPythonEnvironment,
  instrumentedRuntimeStarts,
  verifyInstrumentedPythonEnvironmentMarker
} from "./instrumentedPythonEnvironment";
import {
  DATA_WRANGLER_COEXISTENCE_SETUP_RESULT,
  writeDataWranglerCoexistenceNotebook
} from "./dataWranglerCoexistenceNotebookFixture";
import {
  RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
  RELEASED_JUPYTER_RESTART_RESULT,
  RELEASED_JUPYTER_RUNTIME_RESULT,
  RELEASED_JUPYTER_SESSION_COUNT_RESULT,
  RELEASED_JUPYTER_SETUP_RESULT,
  writeReleasedJupyterNotebook
} from "./releasedJupyterNotebookFixture";
import { exportCleanedDataThroughWorkbench } from "./cleanedDataExport";
import { persistedReplayExportRequest } from "./persistedReplayExport";
import { exerciseMultiOutputSplitJourney } from "./multiOutputSplitJourney";
import { exercisePivotLongerJourney } from "./pivotLongerJourney";
import { exercisePivotWiderJourney } from "./pivotWiderJourney";
import { exerciseActiveRegexExtractionJourney, exercisePandasRegexExtractionJourney } from "./regexExtractionJourney";
import { requireFreshExactSessionPanelHydration as requireFreshExactSessionPanelHydrationOwner } from "./panelHydration";
import {
  captureNotebookWorkbenchScreenshot,
  captureWorkbenchScreenshot,
  publicMediaPixelRatio
} from "./evidenceSceneCapture";
import { packagedScreenshotFileName } from "./evidenceScenes";
import {
  ACCEPTANCE_PROGRESS_PROTOCOL,
  failedAcceptanceProgressCheckpoint,
  writeAcceptanceProgressCheckpoint
} from "./progress";
import { readReleasedRemoteJupyterDescriptorToken } from "./remoteJupyterDescriptor";
import {
  RELEASED_JUPYTER_R_BINDING_RESULT,
  RELEASED_JUPYTER_R_KERNEL_RESULT,
  RELEASED_JUPYTER_R_MEDIA_RESULT,
  RELEASED_JUPYTER_R_SETUP_RESULT
} from "./releasedDocumentFixtures";
import {
  assertReleasedRDocumentFixtureUnchanged,
  readReleasedRDocumentProcessId,
  releasedRProcessRoots
} from "./releasedRDocumentProcess";
import { assertReleasedRGeneratedCode } from "./releasedRGeneratedCode";
import { assertReleasedNativeREditorTooling as assertReleasedNativeREditorToolingOwner } from "./releasedRTooling";
import { exerciseReleasedRCoreEditingCatalog } from "./releasedRCoreEditing";
import {
  exerciseReleasedRValueOperationsAfterLowercase,
  exerciseReleasedRValueOperationsBeforeLowercase
} from "./releasedRValueOperations";
import { createReleasedRTextOperations } from "./releasedRTextOperations";
import { createReleasedRVariableDiscovery } from "./releasedRVariableDiscovery";
import { createReleasedRNotebookMedia } from "./releasedRNotebookMedia";
import { createReleasedREditingModeTransition } from "./releasedREditingModeTransition";
import { createReleasedREditingCoverage } from "./releasedREditingCoverage";
import { createReleasedRJupyterExtensionJourney } from "./releasedRJupyterExtensionJourney";
import { createReleasedPySparkJupyterJourney } from "./releasedPySparkJupyterJourney";
import { createReleasedPythonSourceCellJourney } from "./releasedPythonSourceCellJourney";
import { createReleasedPythonFileEntrypointJourney } from "./releasedPythonFileEntrypointJourney";
import { createPackagedExcelDependencyInstallJourney } from "./packagedExcelDependencyInstallJourney";
import { createDependencyMutationRecoveryJourney } from "./dependencyMutationRecoveryJourney";
import { createPackagedFirstUseInteractionJourney } from "./packagedFirstUseInteractionJourney";
import { createPackagedReopenAndUndoJourney } from "./packagedReopenAndUndoJourney";
import { createPackagedLinkedRendererLiveOpen } from "./packagedLinkedRendererLiveOpen";
import { createPackagedRendererProvenanceJourneys } from "./packagedRendererProvenanceJourney";
import { createPackagedSessionPanelLifecycle } from "./packagedSessionPanelLifecycle";
import { createPackagedFileLaunchSurfaces } from "./packagedFileLaunchSurfaces";
import { createLiveImportReconfiguration } from "./liveImportReconfiguration";
import { exerciseReleasedRCategoricalEditingJourney } from "./releasedRCategoricalEditing";
import { exerciseReleasedRLowercaseOperation } from "./releasedRLowercaseOperation";
import { exerciseReleasedRCastOperation } from "./releasedRCastOperation";
import { exerciseReleasedRGroupByOperation } from "./releasedRGroupByOperation";
import { createReleasedRFormulaDatetimeOperations } from "./releasedRFormulaDatetimeOperations";
import { createReleasedRRepresentativeEditingJourney } from "./releasedRRepresentativeEditing";
import { createReleasedRValueOperationState } from "./releasedRValueOperationState";
import { createReleasedRPageBoundary } from "./releasedRPageBoundary";
import { createReleasedRCloneState } from "./releasedRCloneState";
import { createReleasedRCloneEditingJourney } from "./releasedRCloneEditing";
import { createReleasedRClonePreview } from "./releasedRClonePreview";
import { createReleasedRFillMissingJourney } from "./releasedRFillMissing";
import { createReleasedRRowReductionJourney } from "./releasedRRowReduction";
import { createReleasedRPersistentRowsJourney } from "./releasedRPersistentRows";
import { createReleasedRGridJourney } from "./releasedRGrid";
import { createReleasedRDocumentGrid } from "./releasedRDocumentGrid";
import { createReleasedRDocumentSession } from "./releasedRDocumentSession";
import { createReleasedRDocumentVariableInvoker } from "./releasedRDocumentVariable";
import { createReleasedRDocumentJourney } from "./releasedRDocumentJourney";
import { createReleasedRLiterateDocumentJourneys } from "./releasedRLiterateDocumentJourney";
import { createReleasedPythonQuartoDocumentJourney } from "./releasedPythonQuartoDocumentJourney";
import { createReleasedRInteractiveTerminalJourney } from "./releasedRInteractiveTerminalJourney";
import { createReleasedRInteractiveTerminalSupport } from "./releasedRInteractiveTerminalSupport";
import { createReleasedRInteractiveTitleActions } from "./releasedRInteractiveTitleAction";
import { createReleasedRRuntimeBinding } from "./releasedRRuntimeBinding";
import { createReleasedRKernelLifecycle } from "./releasedRKernelLifecycleJourney";
import { createReleasedRKernelRestartJourney } from "./releasedRKernelRestartJourney";
import { createReleasedREditingMediaCapture } from "./releasedREditingMediaCapture";
import { createReleasedRWorkbenchMediaCapture } from "./releasedRWorkbenchMediaCapture";
import { createReleasedRMediaWorkbench } from "./releasedRMediaWorkbench";
import { createReleasedROperationPicker } from "./releasedROperationPicker";
import { createReleasedROperationPreviews } from "./releasedROperationPreviews";
import { createReleasedRColumnActions } from "./releasedRColumnActions";
import { createReleasedRDocumentMedia } from "./releasedRDocumentMedia";
import { createReleasedRNativeFrameSessions } from "./releasedRNativeFrameSessions";
import { createReleasedRNativeFramesJourney } from "./releasedRNativeFramesJourney";
import {
  findReleasedQuartoPreviewLocator,
  openReleasedNativeQuartoPreview as openReleasedNativeQuartoPreviewOwner
} from "./quartoPreview";
import {
  releasedNotebookExecutionFailureMessage,
  releasedNotebookOutputClassification,
  releasedNotebookRSetupFailureStage
} from "./releasedNotebookFailure";
import {
  restartReleasedJupyterKernelAndWait as restartReleasedJupyterKernelAndWaitOwner,
  type ReleasedJupyterKernelRestartBoundary
} from "./releasedJupyterKernelRestart";
import { RELEASED_JUPYTER_VARIABLES_PANDAS } from "./releasedJupyterVariables";
import { notebookTab } from "./rendererProvenance";
import {
  PACKAGED_FIRST_USE_ROW_COUNT,
  PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
  PACKAGED_OPERATION_DIALOG_VIEWPORT,
  PACKAGED_PANDAS_NOTEBOOK_OUTPUT,
  PACKAGED_PANDAS_NOTEBOOK_VIEWPORT,
  PACKAGED_PRODUCT_VIEWPORT,
  PACKAGED_SCREENSHOT_COLUMNS,
  PACKAGED_SCREENSHOT_FEATURED_COLUMNS,
  PACKAGED_SCREENSHOT_ROW_COUNT,
  PACKAGED_SCREENSHOT_VIEWPORT,
  PACKAGED_WIDE_SCHEMA_COLUMN_COUNT,
  PACKAGED_WIDE_SCHEMA_ROW_COUNT,
  packagedScreenshotFeaturedColumnWidths,
  packagedViewportHeightWithoutPartialBottomRow,
  packagedFirstUseFixtureCsv,
  packagedProductFixtureCsv,
  packagedScreenshotFixtureCsv,
  packagedScreenshotRow,
  packagedWideSchemaColumns,
  packagedWideSchemaFixtureCsv
} from "./screenshotEvidence";
import { classifyRendererUrl, prioritizeNewestRendererTargets } from "./webviewTargetOrdering";
import { customEditorTabDiagnostic, findExactCustomEditorTab } from "./customEditorTabs";
import {
  CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR,
  dispatchExtensionHostPhase,
  parseExtensionHostPhaseSelection,
  PYSPARK_PRERELEASE_DENIAL_SELECTOR,
  type DataWranglerCoexistencePhase
} from "./phaseDispatch";
import { createFocusedReleasedRAcceptanceHandlers } from "./focusedReleasedRAcceptance";
import { releasedRAcceptanceCoverageProfile } from "./releasedRAcceptanceCoverage";
import type { ExtensionApi, TestApi } from "./extensionHostTestApi";
import { assertNumericSummarySum, exerciseNumericSummaryPandasJourney } from "./numericSummaryJourney";
import { exercisePandasIndexFidelityJourney, pandasIndexFixtureSetupCode } from "./pandasIndexFidelityJourney";

interface ReleasedJupyterVariableAction {
  readonly action: Locator;
  readonly documentRoot: Locator;
}

interface ReleasedJupyterDocumentRootElement {
  readonly dataset: { readonly openWranglerAcceptanceActivation?: string };
}

interface ReleasedJupyterActivationEvent {
  readonly detail?: number;
  readonly isTrusted?: boolean;
  readonly composedPath?: () => readonly unknown[];
}

interface ReleasedJupyterActivationPathElement {
  readonly tagName?: string;
}

interface FakeJupyterApi {
  testing: {
    execute(uri: vscode.Uri, code: string): Promise<string>;
    restart(uri: vscode.Uri, setupCode?: string): Promise<number>;
    setDenied(value: boolean): void;
    denialCalls(): number;
    stats(uri: vscode.Uri): { generation: number; executions: number } | undefined;
    lookupCalls(uri: vscode.Uri): number;
  };
}

const DUCKDB_FOREIGN_ENGINE_CONVERSION =
  /\b(?:pandas|polars|pyarrow)\b|(?:to|from)_(?:pandas|polars|arrow)\b|fetch_(?:df|pandas|arrow)\b|\.(?:arrow|df|pl)\s*\(/iu;
const GRID_COLUMN_WINDOW = { columnOffset: 0, columnLimit: 16 } as const;
const SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS = DEFAULT_SESSION_OPEN_TIMEOUT_MS + 15_000;
const QUEUED_RUNTIME_MUTATION_ACCEPTANCE_TIMEOUT_MS = DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS * 2 + 15_000;
const WORKBENCH_PLAYWRIGHT_TIMEOUT_MS = 10_000;
const WORKBENCH_OPERATION_TIMEOUT_MS = 12_000;
const WORKBENCH_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const IMPORT_FOCUS_POLL_TIMEOUT_MS = WORKBENCH_PLAYWRIGHT_TIMEOUT_MS;
const IMPORT_FOCUS_POLL_INTERVAL_MS = 50;
const IMPORT_FOCUS_PROBE_TIMEOUT_MS = 1_000;
const NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS = 30_000;
const NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS = 1_000;
const NOTEBOOK_RENDERER_ACTION_STABLE_MS = 750;
const NOTEBOOK_RENDERER_TARGET_LIMIT = 64;
const NOTEBOOK_RENDERER_DIAGNOSTIC_TARGET_LIMIT = 24;
const RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS = 120_000;
const RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS = 1_000;
const RELEASED_JUPYTER_EXTENSION_VERSION = "2025.9.1";
const RELEASED_DATA_WRANGLER_EXTENSION_VERSION = "1.24.2";
const RELEASED_JUPYTER_CONSENT_MESSAGE =
  "Do you want to grant Kernel access to the extension Open Wrangler (Matt17BR.openwrangler)?";
const RELEASED_JUPYTER_CONSENT_DETAIL = "This allows the extension to execute code against Jupyter Kernels.";
const NOTEBOOK_PREVIEW_CONFLICT_MESSAGE =
  "Open Wrangler and Data Wrangler can both render dataframe outputs. Which notebook preview should take priority?";
const NOTEBOOK_PREVIEW_CONFLICT_DETAIL =
  "You can change this later with “Open Wrangler: Choose Notebook Preview Provider”.";
const NOTEBOOK_PREVIEW_USE_OPEN_WRANGLER = "Use Open Wrangler";
const NOTEBOOK_PREVIEW_KEEP_DATA_WRANGLER = "Keep Data Wrangler";
const RELEASED_JUPYTER_VARIABLE_VIEWER_ACTION = "Show variable snapshot in data viewer";
const RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND = "openWrangler.openNotebookVariable";
const RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN = /^Open in Open Wrangler$/u;
const RELEASED_JUPYTER_EXPORT_COMMAND = "jupyter.notebookeditor.export";
const RELEASED_JUPYTER_INTERACTIVE_EXPORT_COMMAND = "jupyter.interactive.exportasnotebook";
const NOTEBOOK_TOOLBAR_MORE_COMMAND = "toolbar.toggle.more";
const RELEASED_JUPYTER_NOTEBOOK_VARIABLE_PICKER_TITLE = "Open Wrangler: Open Notebook Variable";
const PACKAGED_FILE_ACTION_MEDIA_HEIGHT = 865;
const RELEASED_JUPYTER_FIRST_RESULT_CELL = 8;
const RELEASED_JUPYTER_LOCAL_KERNEL_LABEL = "Python 3.12 (Open Wrangler)";
const RELEASED_JUPYTER_R_KERNEL_LABEL = "R (Open Wrangler)";
const RELEASED_JUPYTER_R_KERNEL_NAME = "openwrangler-r-acceptance";
const RELEASED_JUPYTER_R_KERNEL_CELL = 0;
const RELEASED_JUPYTER_R_SETUP_CELL = 1;
const RELEASED_JUPYTER_R_BINDING_CELL = 2;
const RELEASED_JUPYTER_R_MEDIA_CELL = 3;
const RELEASED_JUPYTER_R_SHOWCASE_CELL = 4;
const RELEASED_R_CUSTOM_CODE = [
  'result <- df[df$row_id <= 3L, c("row_id", "score"), drop = FALSE]',
  "result$score_plus_one <- result$score + 1"
].join("\n");
const RELEASED_JUPYTER_REMOTE_COLLECTION_LABEL = "Open Wrangler Remote Servers";
const RELEASED_JUPYTER_REMOTE_SERVER_LABEL = "Open Wrangler Container Server";
const RELEASED_JUPYTER_REMOTE_KERNEL_LABEL = "Open Wrangler Remote Acceptance";
const RELEASED_JUPYTER_REMOTE_KERNEL_NAME = "openwrangler-remote-acceptance";
const RELEASED_JUPYTER_REMOTE_R_KERNEL_LABEL = "R (Open Wrangler Remote)";
const RELEASED_JUPYTER_REMOTE_R_KERNEL_NAME = "openwrangler-r-remote-acceptance";
const RELEASED_JUPYTER_REMOTE_DESCRIPTOR_PROTOCOL = "openwrangler-remote-jupyter-v1";
const OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS = 30_000;
const OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT = 64;
const OPEN_WRANGLER_WEBVIEW_DIAGNOSTIC_TARGET_LIMIT = 24;
const DEPENDENCY_GUARD_HOSTILE_TOKEN = "33333333-3333-4333-8333-333333333333";
// sample.csv has only four data rows and fits in the native editor grid, so
// row zero is its only physically possible first visible row. The 80-row
// import-reconfiguration scenario separately proves nonzero row restoration.
const SHORT_FIXTURE_FIRST_VISIBLE_ROW = 0;
const PERSISTED_PANEL_STEP_ID = "packaged-visible-recovery-score";
const PERSISTED_PANEL_OUTPUT_COLUMN = "recovery_score";
const PERSISTED_PANEL_SELECTED_COLUMN = "gross_margin";
const PERSISTED_PANEL_COLUMN_WIDTH = 333;
const PERSISTED_PANEL_FIRST_VISIBLE_ROW = 400;
const PERSISTED_PANEL_SCROLL_LEFT = 1_400;
const PACKAGED_LINEAR_INTERPOLATION_FIXTURE_CSV = [
  "source_row,coordinate,measurement",
  "r4,20,",
  "r1,0,10.0",
  "r5,40,50.0",
  "r2,5,",
  "r6,50,",
  "r3,15,",
  "r7,60,70.0",
  ""
].join("\n");

function persistedPanelFilterModel(): FilterModel {
  return {
    logic: "and",
    filters: [],
    sort: [
      { column: "revenue", direction: "desc", nulls: "last" },
      { column: "market", direction: "desc", nulls: "last" }
    ]
  };
}

function columnReference(metadata: SessionMetadata, name: string): ColumnReference {
  const column = metadata.schema.find((candidate) => candidate.name === name);
  assert.ok(column, `Expected ${name} in the opened session schema.`);
  return { id: column.id, name: column.name };
}

function columnReferenceAt(metadata: SessionMetadata, position: number): ColumnReference {
  const column = metadata.schema[position];
  assert.ok(column, `Expected a column at position ${position} in the opened session schema.`);
  return { id: column.id, name: column.name };
}

function gridColumnCells(page: LiveGridPage, columnId: string): GridPage["rows"][number]["values"] {
  const position = page.columnIds.indexOf(columnId);
  assert.notEqual(position, -1, `Expected projected page column ${columnId}.`);
  return page.rows.map((row) => {
    const value = row.values[position];
    assert.ok(value, `Expected a cell for projected page column ${columnId}.`);
    return value;
  });
}

function gridColumnDisplays(page: LiveGridPage, columnId: string): string[] {
  return gridColumnCells(page, columnId).map((value) => value.display);
}

const {
  closeReleasedJupyterSessionTabs,
  disposePackagedSessionPanel,
  isOpenWranglerSessionTab,
  releasedJupyterSessionTabs
} = createPackagedSessionPanelLifecycle({ waitFor });

const exerciseDependencyInstallShutdownLifecycle = createDependencyInstallShutdownJourney({
  connectToEditorWorkbench,
  gridColumnWindow: GRID_COLUMN_WINDOW,
  recordAcceptanceProgress,
  waitFor,
  waitForVisibleEditorDialog,
  workbenchOperationTimeoutMs: WORKBENCH_OPERATION_TIMEOUT_MS
});

const { openReleasedROperationPicker, reacquireAcknowledgedSessionApp, releasedRSessionApp, synchronizedSessionApp } =
  createReleasedROperationPicker({
    requireFreshExactSessionPanelHydration,
    waitForOpenWranglerGridTarget
  });

const {
  previewReleasedRCast,
  previewReleasedRDrop,
  previewReleasedRDropDuplicates,
  previewReleasedRDropMissingRows,
  previewReleasedRFilterRows,
  previewReleasedRFindReplace,
  previewReleasedRRename,
  previewReleasedRSelect,
  previewReleasedRSortRows,
  previewReleasedRTextLength
} = createReleasedROperationPreviews({
  openReleasedROperationPicker,
  recordAcceptanceProgress,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
});

const { applyReleasedRQuickSort, assertReleasedProfileStat } = createReleasedRColumnActions({
  assertOpenWranglerWebviewLifecycle,
  openWranglerWebviewTargets,
  releasedRSessionApp,
  waitFor,
  waitForLocatorText,
  waitForOpenWranglerGridTarget,
  OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT,
  WORKBENCH_OPERATION_TIMEOUT_MS
});

const {
  assertMediaColumnTitlesUnclipped,
  assertOnlyCompleteMediaColumnsVisible,
  clearReleasedJupyterScreenshotTransientUi,
  closeVisibleWorkbenchPart,
  fitReleasedRMediaColumns,
  releasedJupyterScreenshotTheme
} = createReleasedRMediaWorkbench({
  columnReference,
  requireFreshExactSessionPanelHydration
});

const exercisePackagedFirstUseInteractionJourney = createPackagedFirstUseInteractionJourney({
  clearReleasedJupyterScreenshotTransientUi,
  columnReference,
  exerciseMultiOutputSplitJourney: (app, testing, sessionId, synchronizeApp) =>
    exerciseMultiOutputSplitJourney(app, testing, sessionId, synchronizeApp, { recordAcceptanceProgress, waitFor }),
  exercisePivotLongerJourney: (app, testing, sessionId, selectedColumnNames, synchronizeApp) =>
    exercisePivotLongerJourney(app, testing, sessionId, selectedColumnNames, synchronizeApp, {
      recordAcceptanceProgress,
      waitFor
    }),
  exercisePivotWiderJourney: (
    app,
    testing,
    sessionId,
    namesFromName,
    valuesFromName,
    keys,
    synchronizeApp,
    reacquireApp
  ) =>
    exercisePivotWiderJourney(
      app,
      testing,
      sessionId,
      namesFromName,
      valuesFromName,
      keys,
      synchronizeApp,
      reacquireApp,
      {
        recordAcceptanceProgress,
        waitFor
      }
    ),
  previewAndDiscardPreviousRevenue,
  previewApplyAndUndoGroupedRevenue,
  previewMostCommonAccountNote,
  previewUppercaseMarket,
  reacquireAcknowledgedSessionApp,
  recordAcceptanceProgress,
  synchronizedSessionApp,
  waitFor,
  waitForLocatorText,
  webviewDiscoveryTimeoutMs: OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS
});

export async function run(): Promise<void> {
  exerciseBoundedExactByteAssertionContract();
  recordAcceptanceProgress("preflight:start");
  recordAcceptanceProgress("activation:start");
  const extension = vscode.extensions.getExtension<ExtensionApi>("matt17br.openwrangler");
  assert.ok(extension, "The Open Wrangler extension must be discoverable.");
  const extensionApi = await extension.activate();
  const testing = extensionApi?.testing;
  assert.ok(testing, "The isolated acceptance harness must enable the test-only extension API.");
  assert.equal(extension.isActive, true, "The extension must activate successfully.");
  exerciseAcceptanceTemporaryDirectoryCleanupContract();
  recordAcceptanceProgress("activation:complete");
  recordAcceptanceProgress("preflight:package");
  assert.equal(extension.packageJSON.name, "openwrangler");
  assert.equal(extension.packageJSON.displayName, "Open Wrangler");
  assert.equal(extension.packageJSON.publisher, "Matt17BR");
  assert.equal(extension.packageJSON.icon, "media/icon.png");
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "icon.png"));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "action-icon-dark.svg"));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "action-icon-light.svg"));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "activity-icon.svg"));
  const phaseSelection = parseExtensionHostPhaseSelection(process.env, process.platform);
  const { phase, testPython } = phaseSelection;
  if (testPython && phase !== "python-environment" && phase !== "remote-workspace") {
    await vscode.workspace
      .getConfiguration("openWrangler")
      .update("pythonPath", testPython, vscode.ConfigurationTarget.Global);
  }

  recordAcceptanceProgress("preflight:commands");
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "openWrangler.openPath",
    "openWrangler.openFile",
    "openWrangler.convertTrustedPickle",
    "openWrangler.changeImportOptions",
    "openWrangler.launchDataViewer",
    "openWrangler.openNotebookVariable",
    "openWrangler.runPythonCellAndOpenVariable",
    "openWrangler.refreshRInteractiveVariables",
    "openWrangler.openRDataframe",
    "openWrangler.runRDocument",
    "openWrangler.chooseNotebookPreviewProvider",
    "openWrangler.checkJupyterIntegration",
    "openWrangler.changeRuntime",
    "openWrangler.clearRuntime",
    "openWrangler.installRuntimeDependencies",
    "openWrangler.revalidateRuntimeDependencies",
    "openWrangler.startOperation",
    "openWrangler.applyStep",
    "openWrangler.discardStep",
    "openWrangler.editLatestStep",
    "openWrangler.selectStep",
    "openWrangler.undoStep",
    "openWrangler.copyCode",
    "openWrangler.exportCode",
    "openWrangler.insertNotebookCode",
    "openWrangler.insertRDocumentCode",
    "openWrangler.exportData",
    "openWrangler.openSourceFile",
    "openWrangler.openWalkthrough",
    "openWrangler.openSettings",
    "openWrangler.reportIssue"
  ]) {
    assert.ok(commands.includes(command), `Expected registered command: ${command}`);
  }

  const packagedManifestBytes = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(extension.extensionUri, "package.json")
  );
  assert.ok(packagedManifestBytes.byteLength <= 1024 * 1024, "The packaged extension manifest must remain bounded.");
  const packagedManifest = JSON.parse(Buffer.from(packagedManifestBytes).toString("utf8")) as {
    contributes?: unknown;
  };
  const contributions = packagedManifest.contributes as {
    configurationDefaults?: Record<string, unknown>;
    commands?: Array<{
      command?: string;
      title?: string;
      shortTitle?: string;
      icon?: string | { light?: string; dark?: string };
    }>;
    viewsContainers?: {
      activitybar?: Array<{ id?: string; icon?: string }>;
      panel?: Array<{ id?: string; icon?: string }>;
    };
    views?: Record<string, Array<{ id?: string }>>;
    configuration?: { properties?: Record<string, unknown> };
    notebookRenderer?: Array<{ mimeTypes?: string[]; requiresMessaging?: string }>;
    keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }>;
    menus?: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
  };
  recordAcceptanceProgress("preflight:contributions");
  assert.ok(
    contributions.viewsContainers?.activitybar?.some(
      (container) => container.id === "openWrangler" && container.icon === "media/activity-icon.svg"
    )
  );
  assert.ok(
    contributions.viewsContainers?.panel?.some(
      (container) => container.id === "openWranglerCode" && container.icon === "media/activity-icon.svg"
    )
  );
  assert.deepEqual(
    contributions.views?.openWrangler?.map((view) => view.id),
    ["openWrangler.operations", "openWrangler.summary", "openWrangler.filters", "openWrangler.cleaningSteps"]
  );
  assert.ok(contributions.configuration?.properties?.["openWrangler.fetchBlockSize"]);
  assert.ok(contributions.configuration?.properties?.["openWrangler.fetchColumnBlockSize"]);
  assert.ok(contributions.configuration?.properties?.["openWrangler.filterMode"]);
  assert.ok(contributions.configuration?.properties?.["openWrangler.sessionOpenTimeoutMs"]);
  assert.ok(contributions.configuration?.properties?.["openWrangler.rscriptPath"]);
  const enabledFileTypes = contributions.configuration?.properties?.["openWrangler.enabledFileTypes"] as
    { items?: { enum?: string[] }; default?: string[] } | undefined;
  assert.ok(enabledFileTypes?.items?.enum?.includes("xls"));
  assert.ok(enabledFileTypes?.default?.includes("xls"));
  assert.deepEqual(contributions.configurationDefaults?.["cursor.general.pinnedTitleActions"], [
    "openWrangler.openFile",
    "openWrangler.changeImportOptions",
    "openWrangler.openNotebookVariable",
    "openWrangler.runPythonCellAndOpenVariable",
    "openWrangler.openRDataframe"
  ]);
  assert.deepEqual(
    contributions.commands?.find((command) => command.command === "openWrangler.openFile"),
    {
      command: "openWrangler.openFile",
      title: "Open in Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    }
  );
  assert.deepEqual(
    contributions.commands?.find((command) => command.command === "openWrangler.openRDataframe"),
    {
      command: "openWrangler.openRDataframe",
      title: "Open Wrangler: Open R Dataframe",
      shortTitle: "Open in Open Wrangler",
      category: "Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    }
  );
  assert.deepEqual(
    contributions.commands?.find((command) => command.command === "openWrangler.runRDocument"),
    {
      command: "openWrangler.runRDocument",
      title: "Run R Document in Open Wrangler…",
      shortTitle: "Run in Open Wrangler…",
      category: "Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    }
  );
  assert.deepEqual(
    contributions.commands?.find((command) => command.command === "openWrangler.changeImportOptions"),
    {
      command: "openWrangler.changeImportOptions",
      title: "Open Wrangler: Change Import Options",
      shortTitle: "Change Import Options",
      icon: "$(settings-gear)"
    }
  );
  assert.deepEqual(
    contributions.commands?.find((command) => command.command === RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND),
    {
      command: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND,
      title: "Open in Open Wrangler",
      shortTitle: "Open in Open Wrangler",
      category: "Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    }
  );
  const fileResourcePredicate =
    "resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.(csv|tsv|parquet|jsonl|ndjson|xlsx|xls)$/i";
  const rDocumentPredicate =
    "isWorkspaceTrusted && (resourceScheme == vscode-remote || isLinux || isMac) && resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.([Rr]|[Rr][Mm][Dd]|[Qq][Mm][Dd])$/";
  const rTitlePredicate =
    "isWorkspaceTrusted && resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.([Rr]|[Rr][Mm][Dd]|[Qq][Mm][Dd])$/";
  const explorerContextItems = contributions.menus?.["explorer/context"] ?? [];
  assert.ok(
    explorerContextItems.some(
      (item) =>
        item.command === "openWrangler.runRDocument" &&
        item.when === `!explorerResourceIsFolder && ${rDocumentPredicate}` &&
        item.group === "navigation@49"
    ),
    `Explorer R documents must expose Run in Open Wrangler. Loaded: ${JSON.stringify(explorerContextItems)}`
  );
  assert.ok(
    explorerContextItems.some(
      (item) =>
        item.command === "openWrangler.openFile" &&
        item.when === `!explorerResourceIsFolder && ${fileResourcePredicate}` &&
        item.group === "navigation@50"
    ),
    `Explorer data files must expose the canonical Open in Open Wrangler action. Loaded: ${JSON.stringify(explorerContextItems)}`
  );
  if (vscode.env.remoteName === "ssh-remote") {
    const loadedExplorerContextItems =
      (extension.packageJSON.contributes as typeof contributions).menus?.["explorer/context"] ?? [];
    const loadedRemoteAction = loadedExplorerContextItems.find(
      (item) => item.command === "openWrangler.openFile" && item.group === "navigation@50"
    );
    assert.ok(loadedRemoteAction, "Remote SSH must load the Open in Open Wrangler Explorer action.");
    assert.match(
      loadedRemoteAction.when ?? "",
      /resourceScheme =~ \/\^\(vscode-remote\|vscode-remote\)\$\//u,
      "VS Code must bind both packaged file-resource alternatives to the active remote scheme."
    );
    assert.match(
      loadedRemoteAction.when ?? "",
      /resourceExtname =~ \/\\\.\(csv\|tsv\|parquet\|jsonl\|ndjson\|xlsx\|xls\)\$\/i/u,
      "Remote SSH must preserve the supported data-file extension predicate."
    );
  }
  assert.ok(
    contributions.menus?.["editor/title"]?.some(
      (item) =>
        item.command === "openWrangler.openRDataframe" && item.when === rTitlePredicate && item.group === "navigation@1"
    ),
    "R document editors must expose the Open Wrangler title action."
  );
  assert.doesNotMatch(
    rTitlePredicate,
    /isLinux|isMac|editorLangId|resourceLangId/u,
    "The stable R title action must not depend on platform or language-extension context."
  );
  assert.ok(
    contributions.menus?.["editor/title"]?.some(
      (item) =>
        item.command === "openWrangler.openFile" &&
        item.when ===
          `${fileResourcePredicate} && ` + "(!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)" &&
        item.group === "navigation@1"
    ),
    "Supported source editors must expose the Open Wrangler title action."
  );
  assert.ok(
    contributions.menus?.["editor/title"]?.some(
      (item) =>
        item.command === "openWrangler.changeImportOptions" &&
        item.when ===
          "openWrangler.canChangeImportOptions && (activeWebviewPanelId == openWrangler.session || activeCustomEditorId == openWrangler.viewer)" &&
        item.group === "navigation@2"
    ),
    "Configurable Open Wrangler file editors must expose the Change Import Options title action."
  );
  assert.ok(
    contributions.menus?.["editor/title/context"]?.some(
      (item) =>
        item.command === "openWrangler.runRDocument" &&
        item.when === rDocumentPredicate &&
        item.group === "navigation@49"
    ),
    "R document tabs must expose Run in Open Wrangler in their context menu."
  );
  assert.equal(
    contributions.menus?.commandPalette?.some((item) => item.command === "openWrangler.runRDocument"),
    false,
    "The R document command must remain available from the Command Palette for supported remote hosts."
  );
  assert.ok(
    contributions.menus?.["editor/title/context"]?.some(
      (item) =>
        item.command === "openWrangler.openFile" &&
        item.when ===
          `${fileResourcePredicate} && (!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)` &&
        item.group === "navigation@50"
    ),
    "Supported source tabs must expose Open in Open Wrangler in their context menu."
  );
  assert.ok(
    contributions.menus?.["editor/title/context"]?.some(
      (item) =>
        item.command === "openWrangler.changeImportOptions" &&
        item.when ===
          "openWrangler.canChangeImportOptions && (activeWebviewPanelId == openWrangler.session || activeCustomEditorId == openWrangler.viewer)" &&
        item.group === "navigation@51"
    ),
    "Configurable Open Wrangler tabs must expose Change Import Options in their context menu."
  );
  assert.ok(
    contributions.menus?.commandPalette?.some(
      (item) => item.command === "openWrangler.launchDataViewer" && item.when === "false"
    ),
    "The argument-only Jupyter viewer command must stay out of the Command Palette."
  );
  assert.ok(
    contributions.menus?.["view/title"]?.some(
      (item) =>
        item.command === "openWrangler.insertRDocumentCode" &&
        item.when === "view == openWrangler.codePreview && openWrangler.canInsertRDocumentCode" &&
        item.group === "navigation@12"
    ),
    "R document sessions must expose generated-code insertion only when their exact source is active."
  );
  const notebookVariableWhen = "notebookType == 'jupyter-notebook' && isWorkspaceTrusted";
  const notebookVariableToolbarWhen =
    `${notebookVariableWhen} && config.notebook.globalToolbar == true && ` +
    "!openWrangler.forceNotebookEditorTitleAction";
  const notebookVariableWhenCompact =
    "isWorkspaceTrusted && ((notebookType == 'jupyter-notebook' && " +
    "(config.notebook.globalToolbar != true || openWrangler.forceNotebookEditorTitleAction)) || " +
    "(activeEditor == workbench.editor.interactive && openWrangler.forceNotebookEditorTitleAction))";
  for (const [menu, when] of [
    ["editor/title", notebookVariableWhenCompact],
    ["notebook/toolbar", notebookVariableToolbarWhen]
  ] as const) {
    const entries: Array<{ command?: string; when?: string; group?: string }> | undefined = contributions.menus?.[
      menu
    ]?.filter((item) => item.command === "openWrangler.openNotebookVariable");
    assert.equal(entries?.length, 1, `${menu} must expose exactly one Open Wrangler variable action.`);
    assert.deepEqual(entries?.[0], {
      command: "openWrangler.openNotebookVariable",
      when,
      group: "navigation@50"
    });
  }
  const interactiveEntries = contributions.menus?.["interactive/toolbar"]?.filter(
    (item) => item.command === "openWrangler.openNotebookVariable"
  );
  assert.deepEqual(interactiveEntries, [
    {
      command: "openWrangler.openNotebookVariable",
      when: "isWorkspaceTrusted && !openWrangler.forceNotebookEditorTitleAction",
      group: "navigation@2"
    }
  ]);
  assert.deepEqual(
    contributions.keybindings?.map((binding) => ({
      command: binding.command,
      key: binding.key,
      mac: binding.mac,
      when: binding.when
    })),
    [
      {
        command: "openWrangler.applyStep",
        key: "ctrl+enter",
        mac: "cmd+enter",
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.hasDraft"
      },
      {
        command: "openWrangler.discardStep",
        key: "escape",
        mac: undefined,
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.hasDraft"
      },
      {
        command: "openWrangler.editLatestStep",
        key: "ctrl+shift+e",
        mac: "cmd+shift+e",
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.canChangePlan"
      },
      {
        command: "openWrangler.undoStep",
        key: "ctrl+alt+z",
        mac: "cmd+alt+z",
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.canChangePlan"
      }
    ]
  );
  assert.ok(
    contributions.menus?.["view/item/context"]?.some(
      (item) =>
        item.command === "openWrangler.editLatestStep" &&
        item.when ===
          "view == openWrangler.cleaningSteps && viewItem == openWrangler.latestCleaningStep && openWrangler.canChangePlan" &&
        item.group === "inline@10"
    ),
    "Edit Latest Step must be unavailable from the Cleaning Steps menu while a draft blocks plan changes."
  );
  assert.deepEqual(contributions.notebookRenderer?.[0]?.mimeTypes, ["application/vnd.openwrangler.viewer.v2+json"]);
  assert.equal(contributions.notebookRenderer?.[0]?.requiresMessaging, "optional");
  assert.ok(
    (extension.packageJSON.activationEvents as string[] | undefined)?.includes("onRenderer:openWrangler.renderer"),
    "The extension host must activate before optional renderer messages are delivered."
  );
  assert.ok(
    (extension.packageJSON.activationEvents as string[] | undefined)?.includes(
      "onCommand:openWrangler.changeImportOptions"
    ),
    "The Change Import Options command must activate the extension host."
  );
  assert.ok(
    extension.packageJSON.contributes.walkthroughs?.some(
      (walkthrough: { id?: string }) => walkthrough.id === "gettingStarted"
    )
  );

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "The extension-host fixture workspace must be open.");
  const fixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.csv");
  recordAcceptanceProgress("preflight:complete");
  const focusedReleasedRHandlers = createFocusedReleasedRAcceptanceHandlers({
    testing,
    testPython,
    platform: process.platform,
    screenshotOutput: process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS,
    assertNativeEditorTooling: assertReleasedNativeREditorTooling,
    connectToEditorWorkbench,
    createLiterateDirectory: () => mkdtempSync(path.join(tmpdir(), "openwrangler-r-literate-")),
    cleanupLiterateDirectory: cleanupAcceptanceTemporaryDirectory,
    exerciseInteractiveTerminalJourney: exerciseReleasedRInteractiveTerminalJourney,
    exerciseLiterateDocumentJourneys: exerciseReleasedRLiterateDocumentJourneys,
    log: console.log,
    recordProgress: recordAcceptanceProgress
  });
  const phaseDispatched = await dispatchExtensionHostPhase(phaseSelection, {
    ...focusedReleasedRHandlers,
    dataWranglerCoexistence: async (coexistencePhase) => {
      assert.ok(testPython, "Real Data Wrangler coexistence acceptance requires the private Jupyter environment.");
      recordAcceptanceProgress(`${coexistencePhase}:start`);
      await exerciseReleasedDataWranglerCoexistence(testing, extension, coexistencePhase, testPython);
      recordAcceptanceProgress(`${coexistencePhase}:complete`);
      console.log(`Open Wrangler real Data Wrangler coexistence ${coexistencePhase} acceptance passed.`);
    },
    releasedJupyter: async (releasedPhase, releasedSelector) => {
      assert.ok(testPython, "Released Jupyter acceptance requires the runner-selected host Python environment.");
      recordAcceptanceProgress(`${releasedPhase}:start`);
      if (releasedPhase === "jupyter-pyspark") {
        await exerciseReleasedPySparkJupyterExtension(
          testing,
          extension,
          testPython,
          releasedSelector === PYSPARK_PRERELEASE_DENIAL_SELECTOR ? "prerelease-denial" : "stable-qualification"
        );
      } else if (releasedPhase === "jupyter-r" || releasedPhase === "jupyter-r-remote") {
        const coverage = releasedRAcceptanceCoverageProfile({
          editor: phaseSelection.editor,
          phase: releasedPhase,
          platform: phaseSelection.platform,
          selector: releasedSelector
        });
        await exerciseReleasedRJupyterExtension(testing, extension, releasedPhase, coverage);
      } else {
        await exerciseReleasedJupyterExtension(testing, extension, releasedPhase, testPython);
      }
      recordAcceptanceProgress(`${releasedPhase}:complete`);
      console.log(
        `Open Wrangler released Jupyter ${
          releasedPhase === "jupyter-deny"
            ? "denial"
            : releasedPhase === "jupyter-remote"
              ? "remote"
              : releasedPhase === "jupyter-pyspark"
                ? "PySpark"
                : releasedPhase === "jupyter-r"
                  ? "R"
                  : releasedPhase === "jupyter-r-remote"
                    ? "remote R"
                    : "allow"
        } acceptance passed.`
      );
    },
    pythonEnvironment: async () => {
      assert.ok(testPython, "Real Python-extension acceptance requires the runner-selected dependency environment.");
      recordAcceptanceProgress("python-environment:start");
      await exerciseRealPythonEnvironmentSelection(testing, workspace, fixture, testPython, extension.extensionPath);
      recordAcceptanceProgress("python-environment:complete");
      console.log("Open Wrangler real Python-environment selection acceptance passed.");
    },
    platformSmoke: async () => {
      assert.ok(testPython, "The packaged platform smoke requires the runner-selected Python environment.");
      recordAcceptanceProgress("platform-smoke:start");
      const firstUseFixture = ensurePackagedFirstUseFixture(workspace);
      await exercisePackagedPlatformSmoke(testing, extension, firstUseFixture, testPython);
      recordAcceptanceProgress("platform-smoke:excel-dependency-install");
      await exercisePackagedExcelDependencyInstall(testing, workspace, testPython);
      if (process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS) {
        recordAcceptanceProgress("platform-smoke:screenshots");
        await capturePackagedEditorScreenshots(testing, process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS);
      }
      recordAcceptanceProgress("platform-smoke:complete");
      console.log("Open Wrangler packaged platform smoke passed.");
    },
    remoteWorkspace: async () => {
      assert.ok(testPython, "Remote-workspace acceptance requires the pre-provisioned private Python environment.");
      recordAcceptanceProgress("remote-workspace:start");
      await exerciseRemoteWorkspace(testing, extension, workspace, testPython);
      recordAcceptanceProgress("remote-workspace:complete");
      console.log("Open Wrangler real Remote SSH workspace acceptance passed.");
    },
    seed: async () => {
      recordAcceptanceProgress("seed:start");
      await seedPersistedPlan(testing, fixture, ensurePersistedRecoveryFixture(workspace));
      recordAcceptanceProgress("seed:complete");
      console.log("Open Wrangler extension-host persistence seed passed.");
    }
  });
  if (phaseDispatched) return;

  const persistedRecoveryFixture = ensurePersistedRecoveryFixture(workspace);
  if (phase === "single") await seedPersistedPlan(testing, fixture, persistedRecoveryFixture);
  if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
    recordAcceptanceProgress("verify:visible-replay-recovery");
    await verifyVisiblePersistedReplayAndRecovery(testing, persistedRecoveryFixture);
  }
  recordAcceptanceProgress("verify:replay-recovery");
  await verifyPersistedReplayAndRecovery(testing, workspace, fixture);
  recordAcceptanceProgress("verify:custom-editor");
  await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitFor(
    () => {
      const expectedUri = fixture.toString();
      const response = testing.panelOpenResponse();
      const active = testing.activeSession();
      return Boolean(
        response?.kind === "sessionOpened" &&
        response.metadata.source.kind === "file" &&
        response.metadata.source.uri === expectedUri &&
        active?.sessionId === response.metadata.sessionId &&
        active.metadata.source.kind === "file" &&
        active.metadata.source.uri === expectedUri &&
        findExactCustomEditorTab<vscode.Tab>(vscode.window.tabGroups.all, "openWrangler.viewer", expectedUri)
      );
    },
    45_000,
    "the exact Open Wrangler custom editor, file session, and panel response",
    () => {
      const expectedUri = fixture.toString();
      const response = testing.panelOpenResponse();
      const active = testing.activeSession();
      const activeTab = activeEditorTabDiagnostic();
      return JSON.stringify({
        tabs: customEditorTabDiagnostic(vscode.window.tabGroups.all, "openWrangler.viewer", expectedUri),
        activeTab: {
          inputType: activeTab.inputType,
          viewType: activeTab.viewType,
          isOpenWranglerSession: activeTab.isOpenWranglerSession
        },
        panelResponse: {
          kind: response?.kind ?? "missing",
          sourceMatches:
            response?.kind === "sessionOpened" &&
            response.metadata.source.kind === "file" &&
            response.metadata.source.uri === expectedUri,
          sessionMatches: response?.kind === "sessionOpened" && active?.sessionId === response.metadata.sessionId
        },
        activeSession: {
          present: active !== undefined,
          sourceMatches: active?.metadata.source.kind === "file" && active.metadata.source.uri === expectedUri
        },
        coordinator: {
          sessionCount: testing.diagnostics().sessionCount,
          runtimeRunning: testing.runtimeRunning()
        }
      });
    }
  );

  const panelResponse = testing.panelOpenResponse();
  assert.equal(panelResponse?.kind, "sessionOpened");
  if (panelResponse?.kind !== "sessionOpened") return;
  assert.equal(panelResponse.metadata.source.uri, fixture.toString());
  assert.equal(testing.activeSession()?.sessionId, panelResponse.metadata.sessionId);
  const customEditorTab = findExactCustomEditorTab<vscode.Tab>(
    vscode.window.tabGroups.all,
    "openWrangler.viewer",
    fixture.toString()
  );
  assert.ok(customEditorTab, "The exact source must own an Open Wrangler custom-editor tab in one tab group.");
  await exercisePackagedStepInspection(testing, fixture);
  await vscode.commands.executeCommand("openWrangler.openSourceFile");
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    45_000,
    "Open Source File to reveal the active runtime session"
  );
  const sourceInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(sourceInput instanceof vscode.TabInputText, "Open Source File must resolve the active runtime session.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  const currentCustomEditorTab = findExactCustomEditorTab<vscode.Tab>(
    vscode.window.tabGroups.all,
    "openWrangler.viewer",
    fixture.toString()
  );
  assert.ok(currentCustomEditorTab, "The exact custom-editor tab must still exist immediately before cleanup.");
  await vscode.window.tabGroups.close(currentCustomEditorTab, true);
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the custom-editor session to close"
  );

  if (testPython) {
    recordAcceptanceProgress("verify:runtime-and-file-inputs");
    await exerciseRuntimeSelectionCommands(testing, fixture, testPython);
    await exercisePackagedFileInputs(testing, workspace, testPython);
    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      await exerciseNumericSummaryPandasJourney({
        testing,
        createTemporaryDirectory: () => mkdtempSync(path.join(tmpdir(), "openwrangler-numeric-summary-")),
        cleanupTemporaryDirectory: cleanupAcceptanceTemporaryDirectory,
        sessionApp: async (sessionId, description) =>
          synchronizedSessionApp(
            await connectToEditorWorkbench(),
            testing,
            sessionId,
            `${description} must render its confirmed shared-webview state.`
          ),
        recordProgress: recordAcceptanceProgress
      });
      await exercisePandasRegexExtractionJourney({
        testing,
        createTemporaryDirectory: () => mkdtempSync(path.join(tmpdir(), "openwrangler-regex-extraction-")),
        cleanupTemporaryDirectory: cleanupAcceptanceTemporaryDirectory,
        sessionApp: async (sessionId, description) =>
          synchronizedSessionApp(
            await connectToEditorWorkbench(),
            testing,
            sessionId,
            `${description} must render its confirmed shared-webview state.`
          ),
        recordProgress: recordAcceptanceProgress
      });
    }
  }
  recordAcceptanceProgress("verify:viewing-queries");
  await exercisePackagedViewingQueries(testing, fixture);
  recordAcceptanceProgress("verify:wide-projection");
  await exerciseWideColumnProjection(testing);
  recordAcceptanceProgress("verify:operation-groups");
  await exercisePackagedOperationGroups(testing, fixture);
  recordAcceptanceProgress("verify:notebook-flows");
  await exercisePackagedNotebookFlows(testing);
  if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
    recordAcceptanceProgress("verify:file-launch-surfaces");
    const firstUseFixture = ensurePackagedFirstUseFixture(workspace);
    await exercisePackagedFileLaunchSurfaces(
      testing,
      firstUseFixture,
      process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS
    );
  }
  if (process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS) {
    recordAcceptanceProgress("verify:screenshots");
    await capturePackagedEditorScreenshots(testing, process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS);
  }
  if (testPython && process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
    recordAcceptanceProgress("verify:excel-dependency-install");
    await exercisePackagedExcelDependencyInstall(testing, workspace, testPython);
    recordAcceptanceProgress("verify:dependency-recovery");
    await exerciseDependencyMutationRecovery(
      testing,
      fixture,
      testPython,
      path.join(extension.extensionPath, "python", "openwrangler_runtime", "dependency_guard.py")
    );
    recordAcceptanceProgress("verify:dependency-install-shutdown");
    await exerciseDependencyInstallShutdownLifecycle(testing, testPython);
  }

  recordAcceptanceProgress("verify:complete");
  console.log("Open Wrangler extension-host acceptance passed.");
}

function ensurePackagedFirstUseFixture(workspace: vscode.Uri): vscode.Uri {
  return ensureDeterministicFirstUseFixture(workspace, "[Live] regional orders 2024-2025.csv");
}

function ensurePersistedRecoveryFixture(workspace: vscode.Uri): vscode.Uri {
  return ensureDeterministicFirstUseFixture(workspace, "[Recovery] persisted panel state.csv");
}

function ensureDeterministicFirstUseFixture(workspace: vscode.Uri, fileName: string): vscode.Uri {
  return ensureDeterministicDelimitedFixture(workspace, fileName, packagedFirstUseFixtureCsv(), "first-use");
}

function ensurePackagedProductSceneFixture(workspace: vscode.Uri): vscode.Uri {
  return ensureDeterministicDelimitedFixture(workspace, "orders.csv", packagedProductFixtureCsv(), "product-scene");
}

function ensurePackagedLinearInterpolationFixture(workspace: vscode.Uri): vscode.Uri {
  return ensureDeterministicDelimitedFixture(
    workspace,
    "linear-interpolation.csv",
    PACKAGED_LINEAR_INTERPOLATION_FIXTURE_CSV,
    "linear-interpolation"
  );
}

function ensureDeterministicDelimitedFixture(
  workspace: vscode.Uri,
  fileName: string,
  expected: string,
  description: string
): vscode.Uri {
  const fixture = vscode.Uri.joinPath(workspace, "fixtures", fileName);
  ensureDeterministicDelimitedFixturePath(fixture.fsPath, expected, description);
  return fixture;
}

let lastAcceptanceProgressCheckpoint: string | undefined;

function recordAcceptanceProgress(checkpoint: string): void {
  const progressPath = process.env.OPEN_WRANGLER_TEST_PROGRESS;
  if (!progressPath) {
    lastAcceptanceProgressCheckpoint = checkpoint;
    return;
  }
  const runId = process.env.OPEN_WRANGLER_TEST_RUN_ID;
  const phase = process.env.OPEN_WRANGLER_TEST_PHASE;
  if (!runId || !phase) {
    throw new Error("Editor acceptance progress requires the launched run ID and phase.");
  }
  writeAcceptanceProgressCheckpoint(progressPath, {
    protocol: ACCEPTANCE_PROGRESS_PROTOCOL,
    runId,
    phase,
    checkpoint
  });
  lastAcceptanceProgressCheckpoint = checkpoint;
}

type ReleasedJupyterPhase =
  | "jupyter-deny"
  | "jupyter-allow"
  | "jupyter-pyspark"
  | "jupyter-remote"
  | "jupyter-r"
  | "jupyter-r-remote"
  | DataWranglerCoexistencePhase;

interface ReleasedJupyterKernelTarget {
  readonly label: string;
  readonly name: string;
  readonly routeLabels: readonly string[];
  readonly remote?: {
    readonly baseUrl: vscode.Uri;
    readonly token: string;
    readonly runId: string;
    readonly hostname: string;
  };
}

interface ReleasedVariableExpectation {
  readonly name: string;
  readonly type: string;
  readonly backend: "pandas" | "polars" | "duckdb" | "pyspark" | "r";
  readonly firstValue: string;
  readonly notebookInsert?: boolean;
  readonly rDataframeFlavor?: "r.data.frame" | "r.tibble" | "r.data.table";
}

interface ReleasedDuckDbRecoverySession {
  readonly sessionId: string;
  readonly revision: number;
  readonly filterModel: FilterModel;
  readonly runtimeId: string;
  readonly schema: SessionMetadata["schema"];
  readonly viewState: GridViewState;
}

function dataWranglerCoexistenceExpectation(phase: DataWranglerCoexistencePhase): {
  provider: "openWrangler" | "dataWrangler";
  selection: boolean;
} {
  return {
    provider: phase.includes("-open-") ? "openWrangler" : "dataWrangler",
    selection: phase.endsWith("-select")
  };
}

async function exerciseReleasedDataWranglerCoexistence(
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  phase: DataWranglerCoexistencePhase,
  testPython: string
): Promise<void> {
  assert.equal(
    testing.diagnostics().sessionCount,
    0,
    "Data Wrangler coexistence acceptance must start without an Open Wrangler session."
  );
  assert.ok(
    !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
    "Coexistence must not add a hard Jupyter dependency to Open Wrangler."
  );

  const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
  assert.equal(jupyterExtension.packageJSON.publisher, "ms-toolsai");
  assert.equal(jupyterExtension.packageJSON.name, "jupyter");
  assert.equal(jupyterExtension.packageJSON.version, RELEASED_JUPYTER_EXTENSION_VERSION);

  const dataWranglerExtension = vscode.extensions.getExtension("ms-toolsai.datawrangler");
  assert.ok(dataWranglerExtension, "The exact Microsoft Data Wrangler parity baseline must be installed.");
  assert.equal(dataWranglerExtension.packageJSON.publisher, "ms-toolsai");
  assert.equal(dataWranglerExtension.packageJSON.name, "datawrangler");
  assert.equal(
    dataWranglerExtension.packageJSON.version,
    RELEASED_DATA_WRANGLER_EXTENSION_VERSION,
    "Coexistence acceptance must not float to an unreviewed Data Wrangler version."
  );

  const expectation = dataWranglerCoexistenceExpectation(phase);
  if (expectation.provider === "dataWrangler") {
    await dataWranglerExtension.activate();
    assert.equal(dataWranglerExtension.isActive, true, "The selected real Data Wrangler extension must be active.");
  }
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const initialProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
    "notebookPreviewProvider"
  );
  if (expectation.selection) {
    assert.equal(initialProvider?.globalValue, undefined, "A fresh coexistence profile must not preselect a provider.");
    assert.equal(initialProvider?.workspaceValue, undefined);
    assert.equal(configuration.get("notebookPreviewProvider", "ask"), "ask");
  } else {
    assert.equal(
      initialProvider?.globalValue,
      expectation.provider,
      "The provider selected before editor restart must persist globally."
    );
    assert.equal(configuration.get("notebookPreviewProvider", "ask"), expectation.provider);
  }

  const kernelTarget = releasedJupyterKernelTarget(phase);
  const directory = mkdtempSync(path.join(tmpdir(), `openwrangler-data-wrangler-${phase}-`));
  const notebookPath = path.join(directory, `${phase}.ipynb`);
  writeDataWranglerCoexistenceNotebook(notebookPath, kernelTarget);
  const notebookUri = vscode.Uri.file(notebookPath);
  let notebook: vscode.NotebookDocument | undefined;
  try {
    recordAcceptanceProgress(`${phase}:notebook-open`);
    notebook = await vscode.workspace.openNotebookDocument(notebookUri);
    assertExactOpenNotebookDocument(notebook, "after opening the Data Wrangler coexistence fixture");
    const notebookEditor = await vscode.window.showNotebookDocument(notebook, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false
    });
    assert.equal(notebookEditor.notebook, notebook);
    assertExactVisibleReleasedNotebookEditor(
      notebook,
      notebookEditor,
      "after showing the Data Wrangler coexistence fixture"
    );

    const workbench = await connectToEditorWorkbench();
    if (expectation.selection) {
      recordAcceptanceProgress(`${phase}:provider-prompt`);
      const conflict = await waitForNotebookPreviewConflict(workbench);
      assert.equal(
        configuration.get("notebookPreviewProvider", "ask"),
        "ask",
        "The conflict prompt must not mutate the preference before one explicit choice."
      );
      const action = expectation.provider === "openWrangler" ? conflict.useOpenWrangler : conflict.keepDataWrangler;
      await action.click();
      await conflict.dialog.waitFor({ state: "hidden", timeout: 10_000 });
      await waitFor(
        () =>
          vscode.workspace
            .getConfiguration("openWrangler")
            .inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">("notebookPreviewProvider")?.globalValue ===
          expectation.provider,
        10_000,
        "the selected notebook preview provider to persist globally"
      );
    } else {
      recordAcceptanceProgress(`${phase}:provider-persisted`);
      await assertNotebookPreviewConflictAbsent(
        workbench,
        1_500,
        "A persisted notebook preview provider must suppress the conflict prompt after editor restart."
      );
    }

    recordAcceptanceProgress(`${phase}:kernel-discovery`);
    await jupyterExtension.activate();
    assertExactOpenNotebookDocument(notebook, "after activating released Jupyter for coexistence");
    recordAcceptanceProgress(`${phase}:kernel-select`);
    await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);
    recordAcceptanceProgress(`${phase}:kernel-selected`);

    const setupExecution = executeReleasedNotebookCell(
      notebook,
      0,
      DATA_WRANGLER_COEXISTENCE_SETUP_RESULT,
      `${phase}:setup-cell`,
      notebookEditor
    );
    if (expectation.provider === "openWrangler") {
      recordAcceptanceProgress(`${phase}:open-wrangler-consent`);
      const consent = await waitForReleasedJupyterConsent(workbench, testing);
      await consent.allow.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    }
    await setupExecution;
    const initialKernel = dataWranglerCoexistenceSetupResult(notebook.cellAt(0));
    assert.equal(
      canonicalAcceptancePath(String(initialKernel.executable)),
      canonicalAcceptancePath(testPython),
      "Data Wrangler coexistence must use the private released-Jupyter interpreter."
    );
    assert.ok(Number.isSafeInteger(Number(initialKernel.pid)) && Number(initialKernel.pid) > 0);
    if (expectation.provider === "dataWrangler") {
      assert.equal(
        await visibleReleasedJupyterConsentCount(workbench),
        0,
        "Choosing Data Wrangler must not show Open Wrangler kernel consent."
      );
    }

    await assertDataWranglerCoexistenceOwnership(
      workbench,
      notebook,
      notebookEditor,
      expectation.provider,
      `${phase}:initial-provider`
    );
    await assertNotebookPreviewConflictAbsent(
      workbench,
      1_500,
      "The notebook preview conflict prompt must stay dismissed after the selected provider renders output."
    );

    if (!expectation.selection) {
      recordAcceptanceProgress(`${phase}:kernel-restart`);
      await restartReleasedJupyterKernelAndWait(notebook);
      await executeReleasedNotebookCell(
        notebook,
        0,
        DATA_WRANGLER_COEXISTENCE_SETUP_RESULT,
        `${phase}:restart-setup-cell`,
        notebookEditor
      );
      const replacementKernel = dataWranglerCoexistenceSetupResult(notebook.cellAt(0));
      assert.notEqual(
        Number(replacementKernel.pid),
        Number(initialKernel.pid),
        "The coexistence restart phase must exercise a replacement kernel process."
      );
      assert.equal(canonicalAcceptancePath(String(replacementKernel.executable)), canonicalAcceptancePath(testPython));
      await assertDataWranglerCoexistenceOwnership(
        workbench,
        notebook,
        notebookEditor,
        expectation.provider,
        `${phase}:restarted-provider`
      );
      await assertNotebookPreviewConflictAbsent(
        workbench,
        1_500,
        "Kernel restart must not repeat the resolved notebook preview conflict."
      );
    }

    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "Automatic notebook preview coexistence must not create an Open Wrangler session panel."
    );
  } finally {
    await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function assertDataWranglerCoexistenceOwnership(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  notebookEditor: vscode.NotebookEditor,
  provider: "openWrangler" | "dataWrangler",
  checkpoint: string
): Promise<void> {
  if (provider === "openWrangler") {
    await executeReleasedNotebookCellUntilMime(notebook, 1, OPEN_WRANGLER_MIME_V2, checkpoint, notebookEditor);
    const mimes = notebook.cellAt(1).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(mimes.includes(OPEN_WRANGLER_MIME_V2));
    return;
  }

  await executeReleasedNotebookCell(notebook, 1, undefined, `${checkpoint}:dataframe-cell`, notebookEditor);
  const mimes = notebook.cellAt(1).outputs.flatMap((output) => output.items.map((item) => item.mime));
  assert.equal(
    mimes.includes(OPEN_WRANGLER_MIME_V2),
    false,
    "Choosing Data Wrangler must leave Open Wrangler's automatic notebook formatter unregistered."
  );
  assert.ok(
    mimes.includes("text/plain"),
    "The selected Data Wrangler path must retain the successful native Jupyter dataframe output."
  );
}

async function waitForNotebookPreviewConflict(workbench: Page): Promise<{
  dialog: Locator;
  useOpenWrangler: Locator;
  keepDataWrangler: Locator;
}> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  do {
    for (const frame of [workbench.mainFrame()]) {
      const dialog = frame
        .locator(".monaco-dialog-box:visible")
        .filter({ hasText: NOTEBOOK_PREVIEW_CONFLICT_MESSAGE })
        .last();
      if ((await dialog.count().catch(() => 0)) === 0 || !(await dialog.isVisible().catch(() => false))) continue;
      const message = await dialog.locator(".dialog-message-text").innerText();
      const detail = await dialog.locator(".dialog-message-detail").innerText();
      assert.equal(message, NOTEBOOK_PREVIEW_CONFLICT_MESSAGE);
      assert.equal(detail, NOTEBOOK_PREVIEW_CONFLICT_DETAIL);
      const useOpenWrangler = dialog.getByRole("button", {
        name: NOTEBOOK_PREVIEW_USE_OPEN_WRANGLER,
        exact: true
      });
      const keepDataWrangler = dialog.getByRole("button", {
        name: NOTEBOOK_PREVIEW_KEEP_DATA_WRANGLER,
        exact: true
      });
      assert.equal(await useOpenWrangler.count(), 1);
      assert.equal(await keepDataWrangler.count(), 1);
      return { dialog, useOpenWrangler, keepDataWrangler };
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  const diagnostics = await boundedImportPromptDiagnostics(workbench);
  throw new Error(
    "Timed out waiting for the real Open Wrangler/Data Wrangler provider conflict prompt. " +
      `Dialogs: ${JSON.stringify(diagnostics.dialogs)}.`
  );
}

async function assertNotebookPreviewConflictAbsent(
  workbench: Page,
  observationMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + observationMs;
  do {
    let count = 0;
    for (const frame of [workbench.mainFrame()]) {
      count += await frame
        .locator(".monaco-dialog-box:visible")
        .filter({ hasText: NOTEBOOK_PREVIEW_CONFLICT_MESSAGE })
        .count()
        .catch(() => 0);
    }
    assert.equal(count, 0, message);
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
}

function dataWranglerCoexistenceSetupResult(cell: vscode.NotebookCell): Record<string, unknown> {
  return releasedNotebookJsonResult(cell, DATA_WRANGLER_COEXISTENCE_SETUP_RESULT, "Data Wrangler coexistence setup");
}

const {
  assertReleasedRPrivateLibrary,
  assertReleasedRRuntimeBinding,
  assertReleasedRVersion,
  recordReleasedRAcceptanceSection,
  waitForReleasedRRuntimeBindingCleanup
} = createReleasedRRuntimeBinding({
  RELEASED_JUPYTER_R_BINDING_CELL,
  executeReleasedNotebookCell,
  recordAcceptanceProgress,
  releasedNotebookJsonResult
});

const exerciseReleasedRVariableDiscovery = createReleasedRVariableDiscovery({
  activateReleasedNotebookVariableAction,
  arrangePackagedProductSidebar,
  assertReleasedSessionPage,
  captureReleasedRJupyterOperations,
  prepareReleasedRNotebookScreenshotWorkbench,
  recordReleasedRAcceptanceSection,
  releasedJupyterQuickPickRow,
  showExactReleasedNotebook,
  waitForReleasedJupyterConsent,
  waitForReleasedVariableSession
});

const exerciseReleasedREditingModeTransition = createReleasedREditingModeTransition({
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  assertExactOpenNotebookDocument,
  recordAcceptanceProgress,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor
});

const {
  exerciseReleasedRCollapseFrameSessions,
  exerciseReleasedRNativeFrameSessions,
  recordReleasedRNativeFrameCheckpoint
} = createReleasedRNativeFrameSessions({
  RELEASED_R_SUPPORTED_OPERATIONS,
  assertReleasedRRuntimeBinding,
  assertReleasedSessionPage,
  disposePackagedSessionPanel,
  invokeReleasedNotebookToolbarVariable,
  previewReleasedRDrop,
  previewReleasedRRename,
  recordAcceptanceProgress,
  recordReleasedRAcceptanceSection,
  releasedRSessionApp,
  showExactReleasedNotebook,
  waitFor,
  waitForReleasedVariableSession
});

const exerciseReleasedRNativeFramesExtension = createReleasedRNativeFramesJourney({
  RELEASED_JUPYTER_EXTENSION_VERSION,
  RELEASED_JUPYTER_R_KERNEL_CELL,
  RELEASED_JUPYTER_R_SETUP_CELL,
  assertReleasedRPrivateLibrary,
  assertReleasedRVersion,
  bestEffortReleasedJupyterCleanup,
  connectToEditorWorkbench,
  executeReleasedNotebookCell,
  exerciseReleasedRCollapseFrameSessions,
  exerciseReleasedRNativeFrameSessions,
  getLastAcceptanceProgressCheckpoint: () => lastAcceptanceProgressCheckpoint,
  notebookCellOutputText,
  recordAcceptanceProgress,
  recordReleasedRAcceptanceSection,
  recordReleasedRNativeFrameCheckpoint,
  releasedJupyterKernelTarget,
  releasedNotebookJsonResult,
  selectReleasedJupyterKernel,
  showExactReleasedNotebook,
  waitForReleasedJupyterConsent,
  waitForReleasedRRuntimeBindingCleanup
});

const { exerciseReleasedRKernelLifecycle, recordReleasedRKernelLifecycleCheckpoint } = createReleasedRKernelLifecycle({
  GRID_COLUMN_WINDOW,
  RELEASED_JUPYTER_R_KERNEL_CELL,
  RELEASED_JUPYTER_R_SETUP_CELL,
  assertReleasedRPrivateLibrary,
  assertReleasedRVersion,
  assertReleasedSessionPage,
  disposePackagedSessionPanel,
  executeReleasedNotebookCell,
  invokeReleasedNotebookToolbarVariable,
  recordAcceptanceProgress,
  releasedNotebookJsonResult,
  restartReleasedJupyterKernelAndWait,
  showExactReleasedNotebook,
  waitForReleasedRRuntimeBindingCleanup,
  waitForReleasedVariableSession
});

const exerciseReleasedRKernelRestartExtension = createReleasedRKernelRestartJourney({
  RELEASED_JUPYTER_EXTENSION_VERSION,
  RELEASED_JUPYTER_R_KERNEL_CELL,
  RELEASED_JUPYTER_R_SETUP_CELL,
  assertReleasedRPrivateLibrary,
  assertReleasedRVersion,
  bestEffortReleasedJupyterCleanup,
  connectToEditorWorkbench,
  executeReleasedNotebookCell,
  exerciseReleasedRKernelLifecycle,
  getLastAcceptanceProgressCheckpoint: () => lastAcceptanceProgressCheckpoint,
  notebookCellOutputText,
  recordAcceptanceProgress,
  recordReleasedRAcceptanceSection,
  recordReleasedRKernelLifecycleCheckpoint,
  releasedJupyterKernelTarget,
  releasedNotebookJsonResult,
  selectReleasedJupyterKernel,
  waitForReleasedJupyterConsent
});

const {
  activateReleasedRInteractiveTitleAction,
  assertReleasedWorkbenchHasNoBlockingDialog,
  invokeReleasedRInteractiveTitleAction
} = createReleasedRInteractiveTitleActions({
  WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
  releasedCommandOwnedAction,
  releasedJupyterQuickPickRow,
  releasedNotebookActionLabelEvidence,
  waitFor
});

const exercisePackagedReopenAndUndoJourney = createPackagedReopenAndUndoJourney({
  recordAcceptanceProgress,
  synchronizedSessionApp,
  waitFor,
  waitForAutomaticDelimitedImport,
  waitForOpenWranglerGridTarget,
  sessionOpenAcceptanceTimeoutMs: SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS
});

const exercisePackagedLinkedRendererLiveOpen = createPackagedLinkedRendererLiveOpen({
  columnReference,
  connectToEditorWorkbench,
  disposePackagedSessionPanel,
  isOpenWranglerSessionTab,
  recordAcceptanceProgress,
  waitFor,
  waitForNotebookRendererButton,
  sessionOpenAcceptanceTimeoutMs: SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS
});

const { exercisePackagedRendererProvenance, exercisePackagedSameGroupRendererSwitch } =
  createPackagedRendererProvenanceJourneys({
    connectToEditorWorkbench,
    disposePackagedSessionPanel,
    isOpenWranglerSessionTab,
    recordAcceptanceProgress,
    releasedJupyterSessionTabs,
    waitFor,
    waitForNotebookRendererButton,
    waitForNotebookRendererPreviewOnly,
    gridColumnWindow: GRID_COLUMN_WINDOW,
    sessionOpenAcceptanceTimeoutMs: SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    workbenchPlaywrightTimeoutMs: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
  });

const exercisePackagedFileLaunchSurfaces = createPackagedFileLaunchSurfaces({
  activateReleasedRInteractiveTitleAction,
  activeEditorTabDiagnostic,
  assertOpenWranglerTabBrandIcon,
  closeVisibleWorkbenchPart,
  connectToEditorWorkbench,
  exercisePrimarySortJourney,
  isOpenWranglerSessionTab,
  openEditorTabContextMenu,
  openWorkbenchContextMenu,
  recordAcceptanceProgress,
  waitFor,
  waitForAutomaticDelimitedImport,
  waitForLocatorCount,
  waitForOpenWranglerGridTarget,
  waitForThirdPartyCustomEditorWorkbench,
  fileActionMediaHeight: PACKAGED_FILE_ACTION_MEDIA_HEIGHT,
  sessionOpenAcceptanceTimeoutMs: SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  webviewDiscoveryTimeoutMs: OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
  workbenchOperationTimeoutMs: WORKBENCH_OPERATION_TIMEOUT_MS,
  workbenchPlaywrightTimeoutMs: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
});

const exerciseLiveImportReconfiguration = createLiveImportReconfiguration({
  acceptQuickPickOptionWithKeyboard,
  activeEditorTabDiagnostic,
  connectToEditorWorkbench,
  fileSourceIdentity,
  isOpenWranglerSessionTab,
  openEditorTabContextMenu,
  recordAcceptanceProgress,
  waitFor,
  waitForAutomaticDelimitedImport,
  waitForExactSessionWebviewAction,
  waitForExactSessionWebviewButton,
  waitForImportNaturalKeyboardFocus,
  waitForImportQuickInput,
  waitForOpenWranglerWebviewButton,
  sessionOpenAcceptanceTimeoutMs: SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  workbenchOperationTimeoutMs: WORKBENCH_OPERATION_TIMEOUT_MS,
  workbenchPlaywrightTimeoutMs: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
});

const invokeReleasedRDocumentTitleAction = createReleasedRDocumentMedia({
  activateReleasedRInteractiveTitleAction,
  assertReleasedNotebookVariablePickerGeometry,
  clearReleasedJupyterScreenshotTransientUi,
  closeVisibleWorkbenchPart,
  recordAcceptanceProgress,
  releasedJupyterQuickPickRow,
  releasedJupyterScreenshotTheme,
  releasedQuartoPreviewLocator,
  waitFor,
  withBoundedAcceptancePromise,
  WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
});

const {
  assertReleasedRInteractiveProfileEditingAndExport,
  assertReleasedRInteractiveRows,
  createReleasedOfficialRTerminal,
  isReleasedOfficialRTerminal,
  releasedRInteractiveMailboxRoots,
  seedReleasedRInteractiveFrames
} = createReleasedRInteractiveTerminalSupport({
  RELEASED_R_SUPPORTED_OPERATIONS,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  assertParquetFile,
  assertReleasedProfileStat,
  assertReleasedSessionPage,
  recordAcceptanceProgress,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor,
  withBoundedAcceptancePromise: (promise, timeoutMs, description) =>
    withBoundedAcceptancePromise(promise, timeoutMs, description)
});

const exerciseReleasedRInteractiveTerminalJourney = createReleasedRInteractiveTerminalJourney({
  GRID_COLUMN_WINDOW,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  arrangePackagedProductSidebar,
  assertReleasedRInteractiveProfileEditingAndExport,
  assertReleasedRInteractiveRows,
  assertReleasedSessionPage,
  assertReleasedWorkbenchHasNoBlockingDialog,
  createReleasedOfficialRTerminal,
  disposePackagedSessionPanel,
  invokeReleasedRInteractiveTitleAction,
  isReleasedOfficialRTerminal,
  recordAcceptanceProgress,
  releasedRInteractiveMailboxRoots,
  seedReleasedRInteractiveFrames,
  waitFor,
  withBoundedAcceptancePromise: (promise, timeoutMs, description) =>
    withBoundedAcceptancePromise(promise, timeoutMs, description)
});

const invokeReleasedRDocumentVariable = createReleasedRDocumentVariableInvoker({
  releasedJupyterQuickPickRow,
  runReleasedRDocument: (source) => vscode.commands.executeCommand<boolean>("openWrangler.runRDocument", source),
  withBoundedAcceptancePromise: (promise, timeoutMs, description) =>
    withBoundedAcceptancePromise(promise, timeoutMs, description)
});

const waitForReleasedRDocumentSession = createReleasedRDocumentSession({
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  boundedImportPromptDiagnostics,
  matchingTextDocumentCount: (uri) =>
    vscode.workspace.textDocuments.filter((candidate) => candidate.uri.toString() === uri).length,
  releasedJupyterSessionTabLabels: () => releasedJupyterSessionTabs().map((tab) => tab.label),
  visibleOpenWranglerPanelAlert,
  waitFor
});

const exerciseReleasedRDocumentGrid = createReleasedRDocumentGrid({
  GRID_COLUMN_WINDOW,
  applyReleasedRQuickSort,
  assertReleasedProfileStat,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor,
  waitForLocatorText
});

const exerciseReleasedRDocumentJourney = createReleasedRDocumentJourney({
  RELEASED_R_SUPPORTED_OPERATIONS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  acceptanceProcessIsAlive,
  assertParquetFile,
  assertReleasedRDocumentFixtureUnchanged,
  assertReleasedSessionPage,
  canonicalAcceptancePath,
  disposePackagedSessionPanel,
  exerciseReleasedRDocumentGrid,
  invokeReleasedRDocumentVariable,
  previewReleasedRRename,
  readReleasedRDocumentProcessId,
  recordAcceptanceProgress,
  releasedRProcessRoots,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  textDocumentTab,
  waitFor,
  waitForReleasedRDocumentSession,
  withBoundedAcceptancePromise: (promise, timeoutMs, description) =>
    withBoundedAcceptancePromise(promise, timeoutMs, description)
});

const exerciseReleasedPythonQuartoDocumentJourney = createReleasedPythonQuartoDocumentJourney({
  RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS,
  WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  activateReleasedRInteractiveTitleAction,
  arrangePackagedProductSidebar,
  assertExactOpenNotebookDocument,
  assertReleasedSessionPage,
  boundedReleasedJupyterQuickInputDiagnostics,
  closeExactReleasedPythonInteractiveWindow,
  disposePackagedSessionPanel,
  recordAcceptanceProgress,
  releasedJupyterQuickPickRow,
  releasedJupyterRouteLabel,
  releasedPythonEntrypointDiagnostics,
  releasedPythonFailureNotification,
  showExactReleasedNotebook,
  textDocumentTab,
  visibleReleasedJupyterConsentCount,
  visibleReleasedJupyterQuickInput,
  waitFor,
  waitForReleasedJupyterConsent,
  withBoundedAcceptancePromise: (promise, timeoutMs, description) =>
    withBoundedAcceptancePromise(promise, timeoutMs, description)
});

const exerciseReleasedRLiterateDocumentJourneys = createReleasedRLiterateDocumentJourneys({
  OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  acceptanceProcessIsAlive,
  assertReleasedNativeREditorTooling,
  assertReleasedRDocumentFixtureUnchanged,
  assertReleasedSessionPage,
  disposePackagedSessionPanel,
  exerciseReleasedPythonQuartoDocumentJourney,
  exerciseReleasedRDocumentJourney,
  invokeReleasedRDocumentTitleAction,
  invokeReleasedRDocumentVariable,
  isReleasedOfficialRTerminal,
  openReleasedNativeQuartoPreview,
  previewReleasedRRename,
  readReleasedRDocumentProcessId,
  recordAcceptanceProgress,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  textDocumentTab,
  waitFor,
  waitForReleasedRDocumentSession,
  withBoundedAcceptancePromise: (promise, timeoutMs, description) =>
    withBoundedAcceptancePromise(promise, timeoutMs, description)
});

async function assertReleasedNativeREditorTooling(): Promise<boolean> {
  return assertReleasedNativeREditorToolingOwner({
    getExtension: (id) => vscode.extensions.getExtension(id),
    getCommands: () => vscode.commands.getCommands(true),
    getConfiguration: <T>(section: string, key: string) => vscode.workspace.getConfiguration(section).get<T>(key),
    pathIsAbsolute: path.isAbsolute,
    pathExists: existsSync,
    quartoVersion: (executable) =>
      execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim(),
    withBoundedPromise: withBoundedAcceptancePromise
  });
}

async function openReleasedNativeQuartoPreview(workbench: Page, source: vscode.Uri): Promise<() => Promise<void>> {
  return openReleasedNativeQuartoPreviewOwner(workbench, source, {
    operationTimeoutMs: WORKBENCH_OPERATION_TIMEOUT_MS,
    diagnosticTimeoutMs: WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
    frames: releasedWorkbenchFrames,
    recordProgress: recordAcceptanceProgress,
    waitFor: (condition, timeoutMs, description) => waitFor(condition, timeoutMs, description),
    withBoundedPromise: (promise, timeoutMs, description) =>
      withBoundedAcceptancePromise(promise, timeoutMs, description)
  });
}

async function releasedQuartoPreviewLocator(workbench: Page): Promise<Locator | undefined> {
  return findReleasedQuartoPreviewLocator(releasedWorkbenchFrames(workbench));
}

function textDocumentTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
}

const exerciseReleasedRGridJourney = createReleasedRGridJourney({
  GRID_COLUMN_WINDOW,
  applyReleasedRQuickSort,
  assertNumericSummarySum,
  assertReleasedProfileStat,
  columnReference,
  openWorkbenchContextMenu,
  releasedRSessionApp,
  waitFor,
  waitForLocatorText
});

const exerciseReleasedRFillMissingJourney = createReleasedRFillMissingJourney({
  openReleasedROperationPicker,
  recordAcceptanceProgress,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor
});

const { exerciseReleasedRValueOperationsJourney, previewAndDiscardReleasedRTextTool } = createReleasedRTextOperations({
  exerciseReleasedREditingJourney
});

const { releasedRCloneFailureSnapshot, releasedRCloneMutationRevisionAdvanced, waitForReleasedRCloneState } =
  createReleasedRCloneState({ visibleOpenWranglerPanelAlert, waitFor });

const previewReleasedRClone = createReleasedRClonePreview({
  openReleasedROperationPicker,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  revealCodePreviewText,
  waitFor,
  waitForCodePreview
});

const exerciseReleasedRCloneEditingLifecycle = createReleasedRCloneEditingJourney({
  arrangePackagedProductSidebar,
  previewReleasedRClone,
  recordAcceptanceProgress,
  releasedRCloneFailureSnapshot,
  releasedRCloneMutationRevisionAdvanced,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor,
  waitForReleasedRCloneState
});

const { releasedRVisibleRows, releasedRFirstVisibleRow } = createReleasedRPageBoundary({ GRID_COLUMN_WINDOW });

const exerciseReleasedRPersistentRowsJourney = createReleasedRPersistentRowsJourney({
  applyReleasedRQuickSort,
  previewReleasedRFilterRows,
  previewReleasedRSortRows,
  recordAcceptanceProgress,
  releasedRFirstVisibleRow,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor
});

const exerciseReleasedRRowReductionJourney = createReleasedRRowReductionJourney({
  previewReleasedRDropDuplicates,
  previewReleasedRDropMissingRows,
  recordAcceptanceProgress,
  releasedRFirstVisibleRow,
  releasedRSessionApp,
  releasedRVisibleRows,
  requireFreshExactSessionPanelHydration,
  waitFor
});

const { assertReleasedRValueOperationsCleanState, recordReleasedRValueOperationCheckpoint } =
  createReleasedRValueOperationState({
    RELEASED_R_SUPPORTED_OPERATIONS,
    recordAcceptanceProgress,
    releasedRSessionApp,
    waitFor
  });

const exerciseReleasedRRepresentativeEditingJourney = createReleasedRRepresentativeEditingJourney({
  RELEASED_R_CUSTOM_CODE,
  RELEASED_R_SUPPORTED_OPERATIONS,
  assertReleasedRRuntimeBinding,
  openReleasedROperationPicker,
  previewReleasedRRename,
  recordAcceptanceProgress,
  releasedRFirstVisibleRow,
  releasedRSessionApp,
  releasedRVisibleRows,
  requireFreshExactSessionPanelHydration,
  waitFor
});

const { exerciseReleasedRFormulaJourney, exerciseReleasedRFormatDatetimeJourney } =
  createReleasedRFormulaDatetimeOperations({
    RELEASED_R_SUPPORTED_OPERATIONS,
    openReleasedROperationPicker,
    recordAcceptanceProgress,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor,
    waitForLocatorText
  });

const releasedRValueOperationDependencies = {
  assertReleasedRValueOperationsCleanState,
  exerciseReleasedRFormulaJourney,
  exerciseReleasedRFormatDatetimeJourney,
  openReleasedROperationPicker,
  previewAndDiscardReleasedRTextTool,
  previewReleasedRFindReplace,
  recordAcceptanceProgress,
  recordReleasedRValueOperationCheckpoint,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor,
  waitForLocatorText
} as const;

const exerciseReleasedREditingCoverage = createReleasedREditingCoverage({
  assertReleasedRRuntimeBinding,
  categoricalDependencies: {
    openReleasedROperationPicker,
    reacquireAcknowledgedSessionApp,
    recordAcceptanceProgress,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor,
    waitForLocatorText,
    QUEUED_RUNTIME_MUTATION_ACCEPTANCE_TIMEOUT_MS,
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
  },
  disposePackagedSessionPanel,
  exerciseReleasedREditingJourney,
  exerciseReleasedRCategoricalEditingJourney,
  exerciseReleasedRPivotWiderJourney: async (testing, workbench, sessionId) => {
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The focused native R Pivot wider renderer must acknowledge its complete host snapshot."
    );
    const app = await releasedRSessionApp(workbench, testing, sessionId, "the focused native R Pivot wider session");
    await exercisePivotWiderJourney(
      app,
      testing,
      sessionId,
      "group",
      "score",
      ["A", "B"],
      (description) => releasedRSessionApp(workbench, testing, sessionId, description),
      (description) => reacquireAcknowledgedSessionApp(workbench, testing, sessionId, description),
      { recordAcceptanceProgress, waitFor }
    );
  },
  exerciseReleasedRRepresentativeEditingJourney,
  exerciseReleasedRValueOperationsJourney,
  recordReleasedRAcceptanceSection
});

async function exerciseReleasedREditingJourney(
  testing: TestApi,
  workbench: Page,
  sessionId: string,
  notebook: vscode.NotebookDocument,
  notebookPath: string,
  outputDirectory: string,
  phase: "jupyter-r" | "jupyter-r-remote",
  screenshotOutput?: string,
  editingCatalog: "clone-lifecycle" | "core-catalog" | "value-operations" = "core-catalog"
): Promise<void> {
  recordAcceptanceProgress(`${phase}:editing:${editingCatalog}:open`);
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The editable R renderer must acknowledge its first complete host snapshot."
  );
  let app = await releasedRSessionApp(workbench, testing, sessionId, "the editable R session");
  const opened = testing.activeSession();
  assert.ok(opened, "The native R editing journey requires one active session.");
  assert.equal(opened.sessionId, sessionId);
  assert.equal(opened.metadata.backend, "r");
  assert.equal(opened.metadata.rDataframeFlavor, "r.data.frame");
  assert.equal(opened.metadata.mode, "editing");
  assert.deepEqual(opened.metadata.capabilities, {
    editable: true,
    lazy: false,
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: true,
    filter: true,
    sort: true,
    profile: true,
    columnValues: true,
    supportedOperations: RELEASED_R_SUPPORTED_OPERATIONS
  });
  assert.deepEqual(
    opened.metadata.schema.slice(0, 4).map((column) => column.name),
    ["row_id", "group", "score", "label"]
  );
  assert.equal((await app.locator('[data-session-badge="backend"]').innerText()).trim(), "R");
  assert.equal((await app.locator('[data-session-badge="mode"]').innerText()).trim(), "EDITING");
  await app.getByRole("button", { name: "Add step", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await app.getByRole("button", { name: "Export", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

  if (editingCatalog === "clone-lifecycle") {
    await exerciseReleasedRCloneEditingLifecycle(testing, workbench, sessionId, phase);
    return;
  }

  if (editingCatalog === "value-operations") {
    await assertReleasedRValueOperationsCleanState(testing, workbench, sessionId, "entry");
  }

  let coreScreenshot: Readonly<{ insertedRCellIndex: number; generatedCode: string }> | undefined;
  if (editingCatalog === "core-catalog") {
    const core = await exerciseReleasedRCoreEditingCatalog(
      { testing, workbench, sessionId, notebook, notebookPath, outputDirectory, phase, initialApp: app },
      {
        GRID_COLUMN_WINDOW,
        QUEUED_RUNTIME_MUTATION_ACCEPTANCE_TIMEOUT_MS,
        WORKBENCH_OPERATION_TIMEOUT_MS,
        applyReleasedRQuickSort,
        assertParquetFile,
        assertReleasedRNotebookCodeInsertion,
        exerciseRealScriptSaveDialog,
        exerciseReleasedRCloneEditingLifecycle,
        exerciseReleasedRFillMissingJourney,
        exerciseReleasedRPersistentRowsJourney,
        exerciseReleasedRRowReductionJourney,
        previewReleasedRClone,
        previewReleasedRDrop,
        previewReleasedRRename,
        previewReleasedRSelect,
        previewReleasedRTextLength,
        recordAcceptanceProgress,
        releasedRSessionApp,
        requireFreshExactSessionPanelHydration,
        waitFor,
        waitForOpenWranglerWebviewAction
      }
    );
    app = core.app;
    coreScreenshot = core.coreScreenshot;
  }

  if (phase === "jupyter-r" && editingCatalog === "value-operations") {
    await exerciseReleasedRValueOperationsBeforeLowercase(
      { testing, workbench, sessionId, phase, initialApp: app },
      releasedRValueOperationDependencies
    );
  }

  if (editingCatalog === "core-catalog") {
    await exerciseReleasedRCastOperation(
      { testing, workbench, sessionId, phase, initialApp: app },
      {
        previewReleasedRCast,
        recordAcceptanceProgress,
        releasedRSessionApp,
        requireFreshExactSessionPanelHydration,
        waitFor
      }
    );
  }

  if (phase === "jupyter-r" && editingCatalog === "core-catalog") {
    await exerciseReleasedRGroupByOperation(
      { testing, workbench, sessionId },
      {
        openReleasedROperationPicker,
        recordAcceptanceProgress,
        releasedRSessionApp,
        requireFreshExactSessionPanelHydration,
        waitFor,
        waitForLocatorText
      }
    );
  }

  // Coordinator-only checks intentionally follow the final Open Wrangler
  // renderer mutation so their newer revisions cannot stale a later UI action.
  if (
    (phase === "jupyter-r-remote" && editingCatalog === "core-catalog") ||
    (phase === "jupyter-r" && editingCatalog === "value-operations")
  ) {
    await exerciseReleasedRLowercaseOperation({
      testing,
      sessionId,
      phase,
      catalog: editingCatalog,
      recordProgress: recordAcceptanceProgress,
      recordValueOperationBoundary: (boundary) => recordReleasedRValueOperationCheckpoint("lowercase", boundary)
    });
  }
  if (phase === "jupyter-r" && editingCatalog === "value-operations") {
    await exerciseReleasedRValueOperationsAfterLowercase(
      { testing, workbench, sessionId, phase },
      releasedRValueOperationDependencies
    );
    assert.equal(
      await testing.ensurePanelSynchronized(sessionId, Date.now() + WORKBENCH_OPERATION_TIMEOUT_MS),
      true,
      "Native R coordinator-only value operations must publish their exact revision before later installed UI actions."
    );
    const regexApp = await releasedRSessionApp(workbench, testing, sessionId, "the native R regex-extraction session");
    await exerciseActiveRegexExtractionJourney({
      app: regexApp,
      testing,
      sessionId,
      sourceColumnName: "label",
      pattern: "([a-z]+)-([0-9]{4})()",
      group: 3,
      outputName: "regex_capture",
      expectedOutputDisplays: ["", "", ""],
      generatedCodePattern: /regexec\(/u,
      reacquireApp: (description) => releasedRSessionApp(workbench, testing, sessionId, description),
      recordProgress: recordAcceptanceProgress,
      checkpoint: "jupyter-r:editing:value-operations:regex-extraction"
    });
    const pivotApp = await releasedRSessionApp(workbench, testing, sessionId, "the native R Pivot longer session");
    await exercisePivotLongerJourney(
      pivotApp,
      testing,
      sessionId,
      ["score", "fractional_score"],
      (description) => releasedRSessionApp(workbench, testing, sessionId, description),
      {
        recordAcceptanceProgress,
        waitFor
      }
    );
    const widerApp = await releasedRSessionApp(workbench, testing, sessionId, "the native R Pivot wider session");
    await exercisePivotWiderJourney(
      widerApp,
      testing,
      sessionId,
      "group",
      "score",
      ["A", "B"],
      (description) => releasedRSessionApp(workbench, testing, sessionId, description),
      (description) => reacquireAcknowledgedSessionApp(workbench, testing, sessionId, description),
      { recordAcceptanceProgress, waitFor }
    );
  }

  if (phase === "jupyter-r" && editingCatalog === "core-catalog" && screenshotOutput) {
    assert.ok(coreScreenshot, "The core R editing catalog must retain its code-insertion screenshot receipt.");
    await captureReleasedJupyterCodeInsertion(
      workbench,
      notebook,
      coreScreenshot.insertedRCellIndex,
      "orders_frame",
      coreScreenshot.generatedCode,
      screenshotOutput,
      {
        languageId: "r",
        scene: "notebook-r-code-insertion",
        progress: "jupyter-r:screenshot:code-insertion"
      }
    );
  }

  if (editingCatalog === "value-operations") {
    await assertReleasedRValueOperationsCleanState(testing, workbench, sessionId, "exit");
  }
}

const captureReleasedRNotebookGroupByDraft = createReleasedREditingMediaCapture({
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  arrangePackagedProductSidebar,
  assertMediaColumnTitlesUnclipped,
  clearReleasedJupyterScreenshotTransientUi,
  closeVisibleWorkbenchPart,
  columnReference,
  openReleasedROperationPicker,
  recordAcceptanceProgress,
  releasedJupyterScreenshotTheme,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor
});

const captureReleasedRJupyterWorkbench = createReleasedRWorkbenchMediaCapture({
  alignPackagedSceneRowBoundary,
  applyReleasedRQuickSort,
  arrangePackagedProductSidebar,
  assertMediaColumnTitlesUnclipped,
  assertOnlyCompleteMediaColumnsVisible,
  assertReleasedProfileStat,
  clearReleasedJupyterScreenshotTransientUi,
  closeVisibleWorkbenchPart,
  columnReference,
  fitReleasedRMediaColumns,
  recordAcceptanceProgress,
  releasedJupyterScreenshotTheme,
  releasedRSessionApp,
  waitFor,
  waitForOpenWranglerGridTarget
});

const exerciseReleasedRNotebookMedia = createReleasedRNotebookMedia({
  RELEASED_JUPYTER_R_MEDIA_CELL,
  assertReleasedRRuntimeBinding,
  assertReleasedSessionPage,
  captureReleasedRJupyterWorkbench,
  captureReleasedRNotebookGroupByDraft,
  disposePackagedSessionPanel,
  executeReleasedNotebookCell,
  invokeReleasedNotebookToolbarVariable,
  releasedNotebookJsonResult,
  showExactReleasedNotebook,
  waitForReleasedVariableSession
});

const exerciseReleasedRJupyterExtension = createReleasedRJupyterExtensionJourney({
  RELEASED_JUPYTER_EXTENSION_VERSION,
  RELEASED_JUPYTER_R_KERNEL_CELL,
  RELEASED_JUPYTER_R_SETUP_CELL,
  assertReleasedRPrivateLibrary,
  assertReleasedRRuntimeBinding,
  assertReleasedRVersion,
  bestEffortReleasedJupyterCleanup,
  connectToEditorWorkbench,
  executeReleasedNotebookCell,
  exerciseReleasedRCollapseFrameSessions,
  exerciseReleasedRDocumentJourney,
  exerciseReleasedREditingCoverage,
  exerciseReleasedREditingModeTransition,
  exerciseReleasedRGridJourney,
  exerciseReleasedRKernelLifecycle,
  exerciseReleasedRKernelRestartExtension,
  exerciseReleasedRNativeFrameSessions,
  exerciseReleasedRNativeFramesExtension,
  exerciseReleasedRNotebookMedia,
  exerciseReleasedRVariableDiscovery,
  getLastAcceptanceProgressCheckpoint: () => lastAcceptanceProgressCheckpoint,
  notebookCellOutputText,
  recordAcceptanceProgress,
  recordReleasedRAcceptanceSection,
  registerReleasedRemoteJupyterServer,
  releasedJupyterKernelTarget,
  releasedNotebookJsonResult,
  selectReleasedJupyterKernel
});

async function exerciseReleasedJupyterExtension(
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  phase: ReleasedJupyterPhase,
  testPython: string
): Promise<void> {
  assert.equal(
    testing.diagnostics().sessionCount,
    0,
    "Released Jupyter acceptance must start without a retained Open Wrangler session."
  );
  assert.ok(
    !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
    "File-backed Open Wrangler use must not acquire a hard Jupyter extension dependency."
  );
  const candidateCompatibilitySeam =
    process.env.OPEN_WRANGLER_TEST_SELECTOR === CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR;

  const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
  assert.equal(jupyterExtension.packageJSON.publisher, "ms-toolsai");
  assert.equal(jupyterExtension.packageJSON.name, "jupyter");
  assert.equal(
    jupyterExtension.packageJSON.version,
    RELEASED_JUPYTER_EXTENSION_VERSION,
    "Released-kernel acceptance must not float to an unreviewed Jupyter build."
  );
  assert.notEqual(
    jupyterExtension.packageJSON.displayName,
    "Open Wrangler stable Jupyter API acceptance double",
    "The released-Jupyter phases must never load the local API double."
  );

  const kernelTarget = releasedJupyterKernelTarget(phase);
  const directory = mkdtempSync(path.join(tmpdir(), `openwrangler-released-jupyter-${phase}-`));
  const notebookPath = path.join(
    directory,
    phase === "jupyter-allow" && process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS
      ? "orders-analysis.ipynb"
      : `${phase}.ipynb`
  );
  const notebookUri = vscode.Uri.file(notebookPath);
  const setupMarker = `OPEN_WRANGLER_SETUP_${phase.replace("jupyter-", "").toUpperCase()}`;
  writeReleasedJupyterNotebook(notebookPath, setupMarker, kernelTarget, extension.extensionPath);
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const originalNotebookStartMode = configuration.get<"viewing" | "editing">("notebookStartMode", "viewing");
  const originalNotebookPreviewProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
    "notebookPreviewProvider"
  )?.workspaceValue;

  let notebook: vscode.NotebookDocument | undefined;
  let rendererLoadObserver: NotebookRendererLoadObserver | undefined;
  let remoteServerCollection: JupyterServerCollection | undefined;
  let duckdbRecoverySession: ReleasedDuckDbRecoverySession | undefined;
  let failureCheckpoint: string | undefined;
  try {
    await configuration.update("notebookPreviewProvider", "disabled", vscode.ConfigurationTarget.Workspace);
    recordAcceptanceProgress(`${phase}:notebook-open`);
    notebook = await vscode.workspace.openNotebookDocument(notebookUri);
    assertExactOpenNotebookDocument(notebook, "after opening the released-Jupyter fixture");
    const notebookEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });
    assert.equal(
      notebookEditor.notebook,
      notebook,
      "The released-Jupyter fixture must retain its exact visible editor."
    );
    assertExactOpenNotebookDocument(notebook, "after showing the released-Jupyter fixture");

    const workbench = await connectToEditorWorkbench();
    rendererLoadObserver = observeNotebookRendererLoad(workbench);
    recordAcceptanceProgress(`${phase}:kernel-discovery`);
    const jupyterApi = await jupyterExtension.activate();
    assertExactOpenNotebookDocument(notebook, "after activating released Jupyter for kernel discovery");
    if (kernelTarget.remote) {
      remoteServerCollection = registerReleasedRemoteJupyterServer(jupyterApi, kernelTarget);
    }
    recordAcceptanceProgress(`${phase}:kernel-select`);
    await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);
    recordAcceptanceProgress(`${phase}:kernel-selected`);

    const variableNotebookEditor = await showExactReleasedNotebook(notebook);
    recordAcceptanceProgress(`${phase}:kernel-start`);
    await executeReleasedNotebookCell(
      notebook,
      3,
      RELEASED_JUPYTER_RESTART_RESULT,
      `${phase}:kernel-warmup-cell`,
      variableNotebookEditor
    );
    const warmKernel = releasedNotebookJsonResult(notebook.cellAt(3), RELEASED_JUPYTER_RESTART_RESULT, "kernel warmup");
    assert.equal(warmKernel.runtime, false, "The private kernel must not inherit Open Wrangler before bootstrap.");
    assert.equal(warmKernel.bootstrap, false, "The private kernel must not inherit Open Wrangler bootstrap state.");
    assert.equal(warmKernel.setup, null, "The private kernel warmup must run before the dataframe setup cell.");
    if (kernelTarget.remote) {
      assert.equal(warmKernel.remoteRunId, kernelTarget.remote.runId);
      assert.equal(warmKernel.hostname, kernelTarget.remote.hostname);
      assert.equal(warmKernel.hostExtensionVisible, false);
    }

    let initialKernelBeforeFormatter: Record<string, unknown> | undefined;
    if (phase === "jupyter-allow") {
      await executeReleasedNotebookCell(
        notebook,
        0,
        setupMarker,
        `${phase}:setup-cell-before-formatter`,
        variableNotebookEditor
      );
      initialKernelBeforeFormatter = releasedNotebookSetupResult(notebook.cellAt(0));
      assertReleasedJupyterKernelIdentity(initialKernelBeforeFormatter, kernelTarget, testPython);
      assert.equal(
        initialKernelBeforeFormatter.pid,
        warmKernel.pid,
        "The formatter-disabled setup must retain the exact warmed kernel."
      );
      assert.equal(initialKernelBeforeFormatter.setup, setupMarker);
      assert.equal(initialKernelBeforeFormatter.duckdbConversionGuards, true);
      if (!candidateCompatibilitySeam) {
        await exerciseFormatterDisabledFirstNotebookResult(
          workbench,
          testing,
          notebook,
          variableNotebookEditor,
          jupyterApi
        );
      }
    }

    assert.equal(
      releasedJupyterSessionTabs().length,
      0,
      "Automatic notebook-preview preparation must begin without creating an Open Wrangler session panel."
    );
    recordAcceptanceProgress(`${phase}:proactive-formatter`);
    await configuration.update("notebookPreviewProvider", "openWrangler", vscode.ConfigurationTarget.Workspace);

    if (phase === "jupyter-deny") {
      const consent = await waitForReleasedJupyterConsent(workbench, testing);
      assertExactOpenNotebookDocument(notebook, "while proactive formatter consent belongs to the fixture notebook");
      recordAcceptanceProgress("jupyter-deny:consent");
      await consent.deny.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
      await waitForStableReleasedJupyterSessionCount(testing, 0, 2_000, 10_000);
      assert.equal(testing.diagnostics().sessionCount, 0);
      assert.equal(
        releasedJupyterSessionTabs().length,
        0,
        "Denying proactive formatter access must not leave a session panel."
      );

      recordAcceptanceProgress("jupyter-deny:persisted-denial");
      assertExactOpenNotebookDocument(notebook, "before retrying the denied released Jupyter permission");
      await withBoundedAcceptancePromise(
        vscode.commands.executeCommand("openWrangler.launchDataViewer", {
          name: "duckdb_relation",
          type: "_duckdb.DuckDBPyRelation",
          fileName: notebook.uri
        }),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the persisted released-Jupyter denial retry"
      );
      assertExactOpenNotebookDocument(notebook, "after retrying the denied released Jupyter permission");
      const denialError = await waitForReleasedJupyterTerminalPanelError(workbench, testing);
      assert.ok(denialError.length > 0, "The persisted Jupyter denial must publish a terminal panel error.");
      await waitForStableReleasedJupyterSessionCount(testing, 0, 2_000, 10_000);
      assert.equal(
        await visibleReleasedJupyterConsentCount(workbench),
        0,
        "A persisted Jupyter denial must fail without prompting again in the same isolated profile."
      );
      await closeReleasedJupyterSessionTabs();
      assert.equal(testing.diagnostics().sessionCount, 0);
      return;
    }

    if (phase !== "jupyter-allow" || candidateCompatibilitySeam) {
      const consent = await waitForReleasedJupyterConsent(workbench, testing);
      assertExactOpenNotebookDocument(notebook, "while proactive formatter consent belongs to the fixture notebook");
      recordAcceptanceProgress(`${phase}:consent`);
      await consent.allow.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    } else {
      assert.equal(
        await visibleReleasedJupyterConsentCount(workbench),
        0,
        "The formatter-disabled result action must settle kernel consent before proactive preparation begins."
      );
    }
    assert.equal(
      releasedJupyterSessionTabs().length,
      0,
      "Allowing proactive formatter access must not create an Open Wrangler session panel."
    );

    if (initialKernelBeforeFormatter === undefined) {
      await executeReleasedNotebookCell(notebook, 0, setupMarker, `${phase}:setup-cell`, variableNotebookEditor);
    }
    assert.equal(
      jupyterExtension.isActive,
      true,
      "Executing the fixture must activate the released Jupyter extension."
    );
    const initialKernel = initialKernelBeforeFormatter ?? releasedNotebookSetupResult(notebook.cellAt(0));
    assertReleasedJupyterKernelIdentity(initialKernel, kernelTarget, testPython);
    assert.equal(initialKernel.pid, warmKernel.pid, "The formatter must remain on the exact warmed kernel.");
    assert.equal(initialKernel.setup, setupMarker);
    assert.equal(initialKernel.duckdbConversionGuards, true);

    recordAcceptanceProgress(`${phase}:proactive-mime-v2`);
    const renderedCell = new vscode.NotebookRange(1, 2);
    const executionEditor = await showExactReleasedNotebook(notebook);
    executionEditor.selection = renderedCell;
    executionEditor.selections = [renderedCell];
    executionEditor.revealRange(renderedCell, vscode.NotebookEditorRevealType.InCenter);
    await waitFor(
      () => executionEditor.visibleRanges.some((range) => range.start <= 1 && range.end > 1),
      WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
      "the released-Jupyter MIME cell to become visible before execution"
    );
    await executeReleasedNotebookCellUntilMime(
      notebook,
      1,
      OPEN_WRANGLER_MIME_V2,
      `${phase}:proactive-mime-cell`,
      executionEditor
    );
    const pandasOutputMimes = notebook.cellAt(1).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(
      pandasOutputMimes.includes(OPEN_WRANGLER_MIME_V2),
      "Proactive formatter installation must emit Open Wrangler MIME v2 on the first cell run after it is enabled. " +
        `Actual MIME types: ${JSON.stringify(pandasOutputMimes)}. ` +
        `Output: ${JSON.stringify(notebookCellOutputText(notebook.cellAt(1)).slice(0, 2_000))}.`
    );
    assert.equal(
      pandasOutputMimes.includes("text/html"),
      false,
      `Formatter registration must suppress competing default dataframe HTML. Actual MIME types: ${JSON.stringify(
        pandasOutputMimes
      )}.`
    );
    const pandasMimeItem = notebook
      .cellAt(1)
      .outputs.flatMap((output) => output.items)
      .find((item) => item.mime === OPEN_WRANGLER_MIME_V2);
    assert.ok(pandasMimeItem, "The released-Jupyter dataframe output must retain its MIME v2 item.");
    const pandasMimePayload = normalizeNotebookOutputPayload(
      JSON.parse(new TextDecoder().decode(pandasMimeItem.data)) as unknown
    );
    assert.ok(pandasMimePayload, "The released-Jupyter MIME v2 item must satisfy the saved-output contract.");
    assert.equal(pandasMimePayload.metadata.source.label, "orders_preview_df");
    assert.equal(pandasMimePayload.metadata.source.variableName, "orders_preview_df");
    assert.deepEqual(pandasMimePayload.metadata.shape, { rows: 100_000, columns: 12 });
    assert.ok(
      pandasMimePayload.page.rows.length > 0 && pandasMimePayload.page.rows.length < 100_000,
      "The portable MIME output must retain a bounded captured preview instead of embedding the complete live frame."
    );
    const capturedShowcaseFirstValue = pandasMimePayload.page.rows[0]?.values[0]?.display;
    assert.equal(capturedShowcaseFirstValue, "2400001");
    assert.deepEqual(
      pandasMimePayload.metadata.schema.map((column) => column.name),
      [
        "order_id",
        "market",
        "revenue",
        "fulfilled",
        "order_date",
        "segment",
        "channel",
        "product_family",
        "units",
        "unit_price",
        "discount_pct",
        "gross_margin"
      ]
    );
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "Producing an automatic notebook preview must not implicitly open a dataframe session."
    );
    if (candidateCompatibilitySeam) {
      await exerciseReleasedJupyterAllowCompatibilitySeam(
        testing,
        workbench,
        notebook,
        variableNotebookEditor,
        rendererLoadObserver,
        renderedCell,
        capturedShowcaseFirstValue
      );
      return;
    }

    recordAcceptanceProgress(`${phase}:temporary-result-mime-v2`);
    const temporaryResultKernel = await jupyterApi.kernels.getKernel(notebook.uri);
    assert.ok(temporaryResultKernel, "The temporary-result check requires the exact active notebook kernel.");
    const temporaryResultCell = new vscode.NotebookRange(2, 3);
    executionEditor.selection = temporaryResultCell;
    executionEditor.selections = [temporaryResultCell];
    executionEditor.revealRange(temporaryResultCell, vscode.NotebookEditorRevealType.InCenter);
    await waitFor(
      () => executionEditor.visibleRanges.some((range) => range.start <= 2 && range.end > 2),
      WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
      "the temporary Pandas expression cell to become visible before its single execution"
    );
    await executeReleasedNotebookCell(notebook, 2, undefined, `${phase}:temporary-result-cell`, executionEditor);
    const temporaryMimeItem = notebook
      .cellAt(2)
      .outputs.flatMap((output) => output.items)
      .find((item) => item.mime === OPEN_WRANGLER_MIME_V2);
    assert.ok(
      temporaryMimeItem,
      "A single execution of an unassigned dataframe expression must emit Open Wrangler MIME v2."
    );
    const temporaryMimePayload = normalizeNotebookOutputPayload(
      JSON.parse(new TextDecoder().decode(temporaryMimeItem.data)) as unknown
    );
    assert.ok(temporaryMimePayload, "The temporary dataframe MIME item must satisfy the saved-output contract.");
    assert.equal(temporaryMimePayload.metadata.backend, "pandas");
    assert.equal(temporaryMimePayload.metadata.source.label, "DataFrame");
    assert.equal(temporaryMimePayload.metadata.source.kind, "notebookOutput");
    const temporaryResultHandle = temporaryMimePayload.metadata.source.variableName;
    assert.equal(typeof temporaryResultHandle, "string");
    if (typeof temporaryResultHandle !== "string") {
      throw new Error("The temporary dataframe MIME item did not include its live-result handle.");
    }
    assert.match(
      temporaryResultHandle,
      /^__openwrangler_live_result_[0-9a-f]{32}$/u,
      "An unassigned dataframe expression must publish an opaque live-result handle."
    );
    assert.deepEqual(temporaryMimePayload.metadata.shape, { rows: 3, columns: 12 });
    assert.equal(temporaryMimePayload.page.totalRows, 3);
    assert.equal(temporaryMimePayload.page.rows[0]?.values[0]?.display, "2499998");
    assert.equal(temporaryMimePayload.page.rows[2]?.values[0]?.display, "2500000");
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "Rendering a temporary dataframe result must not open a session before the user clicks its action."
    );

    let temporaryRendererButton: NotebookRendererButton;
    try {
      temporaryRendererButton = await waitForNotebookRendererButton(workbench, "DataFrame", "Open in Open Wrangler");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Host: ${JSON.stringify(
          releasedNotebookRendererHostDiagnostics(notebook, 2)
        )} Browser: ${JSON.stringify(rendererLoadObserver.snapshot())}`
      );
    }
    let temporaryResultSession: NonNullable<ReturnType<TestApi["activeSession"]>>;
    try {
      temporaryResultSession = await openReleasedRendererVariableSession(
        temporaryRendererButton,
        workbench,
        testing,
        notebook,
        {
          name: temporaryResultHandle,
          type: "DataFrame",
          backend: "pandas",
          firstValue: "2499998"
        },
        "the exact temporary Pandas expression opened from its physical renderer action",
        `${phase}:temporary-result-inline`
      );
    } finally {
      await temporaryRendererButton.dispose();
    }
    try {
      assert.equal(temporaryResultSession.metadata.source.kind, "notebookVariable");
      assert.equal(temporaryResultSession.metadata.source.variableName, temporaryResultHandle);
      assert.equal(temporaryResultSession.metadata.source.label, "DataFrame");
      assert.equal(temporaryResultSession.metadata.source.uri, notebook.uri.toString());
      assert.notEqual(
        temporaryResultSession.sessionId,
        temporaryMimePayload.metadata.sessionId,
        "The primary renderer action must open a live kernel session rather than its saved inline snapshot."
      );
      assert.deepEqual(temporaryResultSession.metadata.shape, { rows: 3, columns: 12 });
      assert.deepEqual(temporaryResultSession.metadata.filteredShape, { rows: 3, columns: 12 });
      const temporaryPage = await testing.request({
        kind: "getPage",
        columnOffset: 0,
        columnLimit: 12,
        viewRequestId: "released-jupyter-temporary-result-page",
        sessionId: temporaryResultSession.sessionId,
        revision: temporaryResultSession.metadata.revision,
        offset: 0,
        limit: 3,
        filterModel: temporaryResultSession.metadata.filterModel
      });
      assert.equal(temporaryPage.kind, "page");
      if (temporaryPage.kind !== "page") throw new Error("The temporary-result live page did not resolve.");
      assert.equal(temporaryPage.page.totalRows, 3);
      assert.equal(temporaryPage.page.rows[0]?.values[0]?.display, "2499998");
      assert.equal(temporaryPage.page.rows[2]?.values[0]?.display, "2500000");
      assertExactOpenNotebookDocument(notebook, "after opening its temporary dataframe result");
      assert.equal(
        await jupyterApi.kernels.getKernel(notebook.uri),
        temporaryResultKernel,
        "Opening a temporary result must retain the exact originating notebook kernel."
      );
    } finally {
      await disposePackagedSessionPanel(
        testing,
        temporaryResultSession.sessionId,
        "the released-Jupyter temporary dataframe session"
      );
    }

    await showExactReleasedNotebook(notebook);
    assertExactVisibleReleasedNotebookEditor(
      notebook,
      variableNotebookEditor,
      "immediately before opening the real Jupyter Variables view"
    );
    await vscode.commands.executeCommand("jupyter.openVariableView");
    assertExactOpenNotebookDocument(notebook, "after opening the real Jupyter Variables view");
    assertExactVisibleReleasedNotebookEditor(
      notebook,
      variableNotebookEditor,
      "after opening the real Jupyter Variables view"
    );

    assertExactOpenNotebookDocument(
      notebook,
      `before resolving the ${RELEASED_JUPYTER_VARIABLES_PANDAS.name} action from Jupyter Variables`
    );

    recordAcceptanceProgress(`${phase}:variables-action`);
    await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);
    await dispatchReleasedJupyterVariableAction(
      workbench,
      notebook,
      RELEASED_JUPYTER_VARIABLES_PANDAS.name,
      `${phase}:variables`
    );
    recordAcceptanceProgress(`${phase}:variables-delegation-dispatched`);
    recordAcceptanceProgress(`${phase}:variables-panel-created`);
    const pandasFrame = await waitForReleasedVariableSession(
      workbench,
      testing,
      notebook,
      RELEASED_JUPYTER_VARIABLES_PANDAS,
      "the complete canonical orders_df opened from the real Jupyter Variables view"
    );
    assert.equal(pandasFrame.metadata.mode, "editing");

    recordAcceptanceProgress(`${phase}:pandas-dataframe`);
    await assertReleasedSessionPage(
      testing,
      pandasFrame,
      RELEASED_JUPYTER_VARIABLES_PANDAS.firstValue,
      "released-jupyter-pandas-dataframe"
    );
    if (kernelTarget.remote) {
      await assertReleasedRemoteRuntimeTransfer(notebook, kernelTarget, extension.extensionPath, phase);
    }
    await assertReleasedNotebookCodeInsertion(
      testing,
      notebook,
      pandasFrame,
      RELEASED_JUPYTER_VARIABLES_PANDAS.name,
      RELEASED_JUPYTER_VARIABLES_PANDAS.insertionInputColumn,
      RELEASED_JUPYTER_VARIABLES_PANDAS.insertionOutputColumn,
      phase
    );
    await disposePackagedSessionPanel(testing, pandasFrame.sessionId, "the released-Jupyter Pandas DataFrame session");

    // Cursor may retire Jupyter's Variables frame after its first remote activation. The local
    // phase proves DuckDB's Variables action; the remote journey exercises the relation below.
    if (!kernelTarget.remote) {
      recordAcceptanceProgress(`${phase}:duckdb-variables-action`);
      await dispatchReleasedJupyterVariableAction(workbench, notebook, "duckdb_relation", `${phase}:duckdb-variables`);
      const duckdbVariablesRelation = await waitForReleasedVariableSession(
        workbench,
        testing,
        notebook,
        {
          name: "duckdb_relation",
          type: "_duckdb.DuckDBPyRelation",
          backend: "duckdb",
          firstValue: "3400001",
          notebookInsert: false
        },
        "the exact DuckDB relation opened from the existing Jupyter Variables view"
      );
      assert.equal(
        duckdbVariablesRelation.metadata.mode,
        "viewing",
        "A DuckDB relation opened from Jupyter Variables must stay viewing-only."
      );
      assert.deepEqual(duckdbVariablesRelation.metadata.shape, { rows: 100_000, columns: 4 });
      await assertReleasedSessionPage(
        testing,
        duckdbVariablesRelation,
        "3400001",
        "released-jupyter-duckdb-variables-native-page"
      );
      await disposePackagedSessionPanel(
        testing,
        duckdbVariablesRelation.sessionId,
        "the released-Jupyter DuckDB relation opened from Jupyter Variables"
      );
    }
    await configuration.update("notebookStartMode", originalNotebookStartMode, vscode.ConfigurationTarget.Workspace);

    recordAcceptanceProgress(`${phase}:polars-series-toolbar`);
    await showExactReleasedNotebook(notebook);
    await invokeReleasedNotebookToolbarVariable(workbench, notebook, "polars_series");
    const polarsSeries = await waitForReleasedVariableSession(
      workbench,
      testing,
      notebook,
      { name: "polars_series", type: "polars.series.series.Series", backend: "polars", firstValue: "7" },
      "the Polars Series opened from the real Open Wrangler notebook toolbar"
    );
    await assertReleasedSessionPage(testing, polarsSeries, "7", "released-jupyter-polars-series");
    assert.equal(polarsSeries.metadata.mode, "viewing", "Released notebook sessions must default to viewing mode.");
    await disposePackagedSessionPanel(testing, polarsSeries.sessionId, "the released-Jupyter Polars Series");

    const rendererEditor = await showExactReleasedNotebook(notebook);
    rendererEditor.selection = renderedCell;
    rendererEditor.selections = [renderedCell];
    rendererEditor.revealRange(renderedCell, vscode.NotebookEditorRevealType.InCenter);
    assertExactVisibleReleasedNotebookEditor(
      notebook,
      rendererEditor,
      "after revealing the released-Jupyter MIME renderer"
    );
    recordAcceptanceProgress(`${phase}:mime-renderer-revealed`);
    const screenshotOutput = process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS;
    const restoreScreenshotWorkbench =
      phase === "jupyter-allow" && screenshotOutput
        ? await prepareReleasedJupyterScreenshotWorkbench(workbench, notebook, rendererEditor, {
            isolateShowcaseCell: true
          })
        : undefined;
    try {
      if (phase === "jupyter-allow" && screenshotOutput) {
        await captureReleasedJupyterVariablePicker(workbench, notebook, screenshotOutput);
      }
      let rendererButton: NotebookRendererButton;
      try {
        rendererButton = await waitForNotebookRendererButton(workbench, "orders_preview_df", "Open in Open Wrangler");
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Host: ${JSON.stringify(
            releasedNotebookRendererHostDiagnostics(notebook, 1)
          )} Browser: ${JSON.stringify(rendererLoadObserver.snapshot())}`
        );
      }
      if (phase === "jupyter-allow" && screenshotOutput) {
        await captureReleasedJupyterPandasPreview(workbench, rendererButton, screenshotOutput);
      }
      let liveShowcase: NonNullable<ReturnType<TestApi["activeSession"]>>;
      try {
        liveShowcase = await openReleasedRendererVariableSession(
          rendererButton,
          workbench,
          testing,
          notebook,
          { name: "orders_preview_df", type: "DataFrame", backend: "pandas", firstValue: "2400001" },
          "the complete current orders_preview_df opened from the primary MIME-v2 renderer action",
          `${phase}:orders-inline`
        );
      } finally {
        await rendererButton.dispose();
      }
      assert.equal(liveShowcase.metadata.mode, "viewing");
      assert.deepEqual(liveShowcase.metadata.shape, { rows: 100_000, columns: 12 });
      assert.deepEqual(liveShowcase.metadata.filteredShape, liveShowcase.metadata.shape);
      assert.equal(liveShowcase.metadata.capabilities.notebookInsert, true);
      await assertReleasedSessionPage(
        testing,
        liveShowcase,
        capturedShowcaseFirstValue,
        "released-jupyter-renderer-live-notebook-showcase"
      );
      await disposePackagedSessionPanel(
        testing,
        liveShowcase.sessionId,
        "the released-Jupyter live MIME-linked dataframe session"
      );
    } finally {
      await restoreScreenshotWorkbench?.();
    }

    recordAcceptanceProgress(`${phase}:duckdb-inline`);
    const duckdbCellRange = new vscode.NotebookRange(5, 6);
    const duckdbRendererEditor = await showExactReleasedNotebook(notebook);
    duckdbRendererEditor.selection = duckdbCellRange;
    duckdbRendererEditor.selections = [duckdbCellRange];
    duckdbRendererEditor.revealRange(duckdbCellRange, vscode.NotebookEditorRevealType.InCenter);
    await waitFor(
      () => duckdbRendererEditor.visibleRanges.some((range) => range.start <= 5 && range.end > 5),
      WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
      "the native DuckDB MIME cell to become visible before execution"
    );
    await executeReleasedNotebookCellUntilMime(
      notebook,
      5,
      OPEN_WRANGLER_MIME_V2,
      `${phase}:duckdb-mime-cell`,
      duckdbRendererEditor
    );
    const duckdbOutputMimes = notebook.cellAt(5).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(
      duckdbOutputMimes.includes(OPEN_WRANGLER_MIME_V2),
      `The exact DuckDB relation must emit Open Wrangler MIME v2. Actual MIME types: ${JSON.stringify(
        duckdbOutputMimes
      )}.`
    );
    assert.equal(
      duckdbOutputMimes.includes("text/html"),
      false,
      "The native DuckDB formatter must suppress the competing default HTML representation."
    );
    const duckdbMimeItem = notebook
      .cellAt(5)
      .outputs.flatMap((output) => output.items)
      .find((item) => item.mime === OPEN_WRANGLER_MIME_V2);
    assert.ok(duckdbMimeItem, "The exact DuckDB relation output must retain its MIME-v2 item.");
    const duckdbMimePayload = normalizeNotebookOutputPayload(
      JSON.parse(new TextDecoder().decode(duckdbMimeItem.data)) as unknown
    );
    assert.ok(duckdbMimePayload, "The DuckDB MIME-v2 item must satisfy the saved-output contract.");
    assert.equal(duckdbMimePayload.metadata.backend, "duckdb");
    assert.equal(duckdbMimePayload.metadata.source.label, "duckdb_relation");
    assert.equal(duckdbMimePayload.metadata.source.variableName, "duckdb_relation");
    assert.deepEqual(duckdbMimePayload.metadata.shape, { rows: 100_000, columns: 4 });
    assert.ok(
      duckdbMimePayload.page.rows.length > 0 && duckdbMimePayload.page.rows.length < 100_000,
      "The portable DuckDB table must remain a bounded inline preview before its live action is used."
    );

    await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);
    try {
      const duckdbRendererButton = await waitForNotebookRendererButton(
        workbench,
        "duckdb_relation",
        "Open in Open Wrangler"
      );
      let duckdbRelation: NonNullable<ReturnType<TestApi["activeSession"]>>;
      try {
        duckdbRelation = await openReleasedRendererVariableSession(
          duckdbRendererButton,
          workbench,
          testing,
          notebook,
          {
            name: "duckdb_relation",
            type: "_duckdb.DuckDBPyRelation",
            backend: "duckdb",
            firstValue: "3400001",
            notebookInsert: false
          },
          "the complete connection-private DuckDB relation opened from its primary inline action",
          `${phase}:duckdb-inline`
        );
      } finally {
        await duckdbRendererButton.dispose();
      }
      assert.equal(
        duckdbRelation.metadata.mode,
        "viewing",
        "A live DuckDB relation must stay viewing-only even when notebook sessions default to editing."
      );
      assert.deepEqual(duckdbRelation.metadata.shape, { rows: 100_000, columns: 4 });
      assert.deepEqual(duckdbRelation.metadata.filteredShape, duckdbRelation.metadata.shape);
      assert.deepEqual(duckdbRelation.metadata.capabilities, {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      });
      await assertReleasedSessionPage(testing, duckdbRelation, "3400001", "released-jupyter-duckdb-native-page");

      const farDuckdbPage = await testing.request({
        kind: "getPage",
        columnOffset: 0,
        columnLimit: 4,
        viewRequestId: "released-jupyter-duckdb-native-far-page",
        sessionId: duckdbRelation.sessionId,
        revision: duckdbRelation.metadata.revision,
        offset: 99_990,
        limit: 10,
        filterModel: duckdbRelation.metadata.filterModel
      });
      assert.equal(farDuckdbPage.kind, "page");
      if (farDuckdbPage.kind !== "page") throw new Error("The far native DuckDB page did not resolve.");
      assert.equal(farDuckdbPage.page.totalRows, 100_000);
      assert.equal(farDuckdbPage.page.rows[0]?.values[0]?.display, "3499991");
      assert.equal(farDuckdbPage.page.rows[9]?.values[0]?.display, "3500000");

      const filteredDuckdbModel: FilterModel = {
        logic: "and",
        filters: [
          {
            column: "market",
            type: "string",
            logic: "and",
            predicates: [{ kind: "predicate", operator: "equals", value: "DACH" }]
          }
        ],
        sort: [
          { column: "order_id", direction: "desc", nulls: "last" },
          { column: "revenue", direction: "asc", nulls: "last" }
        ]
      };
      const filteredDuckdbPage = await testing.request({
        kind: "getPage",
        columnOffset: 0,
        columnLimit: 4,
        viewRequestId: "released-jupyter-duckdb-native-filter-sort",
        sessionId: duckdbRelation.sessionId,
        revision: farDuckdbPage.revision,
        offset: 0,
        limit: 10,
        filterModel: filteredDuckdbModel
      });
      assert.equal(filteredDuckdbPage.kind, "page");
      if (filteredDuckdbPage.kind !== "page") {
        throw new Error("The filtered and sorted native DuckDB page did not resolve.");
      }
      assert.equal(filteredDuckdbPage.page.totalRows, 25_000);
      assert.equal(filteredDuckdbPage.page.rows[0]?.values[0]?.display, "3499997");
      assert.equal(filteredDuckdbPage.page.rows[0]?.values[1]?.display, "DACH");

      const duckdbRevenue = columnReference(duckdbRelation.metadata, "revenue");
      const duckdbSummary = await testing.request({
        kind: "getSummary",
        sessionId: duckdbRelation.sessionId,
        revision: filteredDuckdbPage.revision,
        viewRequestId: "released-jupyter-duckdb-native-summary",
        filterModel: filteredDuckdbModel,
        columnIds: [duckdbRevenue.id]
      });
      assert.equal(duckdbSummary.kind, "summary");
      if (duckdbSummary.kind !== "summary") throw new Error("The native DuckDB summary did not resolve.");
      assert.equal(duckdbSummary.summaries[0]?.totalCount, 25_000);
      assert.equal(duckdbSummary.summaries[0]?.numeric?.min, 100.5);
      assert.equal(duckdbSummary.summaries[0]?.numeric?.max, 5_099.94);
      if (phase === "jupyter-allow" && screenshotOutput) {
        await captureReleasedJupyterDuckDbRelation(
          workbench,
          testing,
          duckdbRelation.sessionId,
          filteredDuckdbModel,
          screenshotOutput
        );
      }

      await disposePackagedSessionPanel(
        testing,
        duckdbRelation.sessionId,
        "the released-Jupyter native DuckDB relation session"
      );
      const duckdbAliveEditor = await showExactReleasedNotebook(notebook);
      await executeReleasedNotebookCell(
        notebook,
        6,
        RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
        `${phase}:duckdb-user-relation-after-close`,
        duckdbAliveEditor
      );
      const duckdbAlive = releasedNotebookJsonResult(
        notebook.cellAt(6),
        RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
        "DuckDB user relation after Open Wrangler close"
      );
      assert.equal(duckdbAlive.count, 100_000);
      assert.equal(duckdbAlive.connectionCount, 100_000);
      assert.equal(duckdbAlive.first, 3_400_001);
      assert.equal(duckdbAlive.conversionGuards, true);

      recordAcceptanceProgress(`${phase}:duckdb-toolbar-reopen`);
      await showExactReleasedNotebook(notebook);
      await invokeReleasedNotebookToolbarVariable(workbench, notebook, "duckdb_relation");
      const reopenedDuckdbRelation = await waitForReleasedVariableSession(
        workbench,
        testing,
        notebook,
        {
          name: "duckdb_relation",
          type: "_duckdb.DuckDBPyRelation",
          backend: "duckdb",
          firstValue: "3400001",
          notebookInsert: false
        },
        "the exact DuckDB relation reopened from the Open Wrangler notebook toolbar"
      );
      assert.equal(reopenedDuckdbRelation.metadata.mode, "viewing");
      assert.deepEqual(
        reopenedDuckdbRelation.metadata.filterModel,
        filteredDuckdbModel,
        "Reopening the same live DuckDB variable must restore its confirmed viewing state."
      );
      assert.deepEqual(reopenedDuckdbRelation.metadata.filteredShape, { rows: 25_000, columns: 4 });
      await assertReleasedSessionPage(
        testing,
        reopenedDuckdbRelation,
        "3499997",
        "released-jupyter-duckdb-toolbar-restored-page"
      );

      const unfilteredReopenedDuckdbPage = await testing.request({
        kind: "getPage",
        columnOffset: 0,
        columnLimit: 4,
        viewRequestId: "released-jupyter-duckdb-toolbar-complete-page",
        sessionId: reopenedDuckdbRelation.sessionId,
        revision: reopenedDuckdbRelation.metadata.revision,
        offset: 0,
        limit: 10,
        filterModel: { logic: "and", filters: [], sort: [] }
      });
      assert.equal(unfilteredReopenedDuckdbPage.kind, "page");
      if (unfilteredReopenedDuckdbPage.kind !== "page") {
        throw new Error("The complete native DuckDB toolbar page did not resolve.");
      }
      assert.equal(unfilteredReopenedDuckdbPage.page.totalRows, 100_000);
      assert.equal(unfilteredReopenedDuckdbPage.page.rows[0]?.values[0]?.display, "3400001");

      const recoveryDuckdbPage = await testing.request({
        kind: "getPage",
        columnOffset: 0,
        columnLimit: 4,
        viewRequestId: "released-jupyter-duckdb-native-recovery-view",
        sessionId: reopenedDuckdbRelation.sessionId,
        revision: unfilteredReopenedDuckdbPage.revision,
        offset: 0,
        limit: 10,
        filterModel: filteredDuckdbModel
      });
      assert.equal(recoveryDuckdbPage.kind, "page");
      if (recoveryDuckdbPage.kind !== "page") {
        throw new Error("The native DuckDB recovery view did not resolve.");
      }
      assert.deepEqual(recoveryDuckdbPage.metadata.filterModel, filteredDuckdbModel);
      assert.deepEqual(recoveryDuckdbPage.metadata.filteredShape, { rows: 25_000, columns: 4 });
      assert.equal(recoveryDuckdbPage.page.rows[0]?.values[0]?.display, "3499997");
      assert.equal(recoveryDuckdbPage.page.rows[0]?.values[1]?.display, "DACH");
      const duckdbDiagnostic = testing
        .diagnostics()
        .sessions.find((session) => session.publicId === reopenedDuckdbRelation.sessionId);
      assert.ok(duckdbDiagnostic, "The native DuckDB session must remain coordinated before kernel restart.");
      const recoveryDuckdbRevenue = columnReference(recoveryDuckdbPage.metadata, "revenue");
      const recoveryDuckdbViewState: GridViewState = {
        columnWidths: new Map(
          recoveryDuckdbPage.metadata.schema.map(
            (column) => [column.id, column.id === recoveryDuckdbRevenue.id ? 310 : 640] as const
          )
        ),
        selectedColumnId: recoveryDuckdbRevenue.id,
        viewport: { firstVisibleRow: 123, scrollLeft: 120 }
      };
      await waitFor(
        () => testing.panelHydrated(reopenedDuckdbRelation.sessionId),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the native DuckDB recovery panel to hydrate before presentation injection"
      );
      assert.equal(
        await testing.synchronizePanel(reopenedDuckdbRelation.sessionId),
        true,
        "The native DuckDB recovery panel must settle its default presentation before injection."
      );
      await testing.updateViewState(reopenedDuckdbRelation.sessionId, recoveryDuckdbViewState);
      assert.equal(
        await testing.synchronizePanel(reopenedDuckdbRelation.sessionId),
        true,
        "The native DuckDB recovery presentation must commit through the real renderer before restart."
      );
      assert.deepEqual(testing.activeSession()?.viewState, {
        ...recoveryDuckdbViewState,
        filterModel: filteredDuckdbModel
      });
      duckdbRecoverySession = {
        sessionId: reopenedDuckdbRelation.sessionId,
        revision: recoveryDuckdbPage.revision,
        filterModel: filteredDuckdbModel,
        runtimeId: duckdbDiagnostic.runtimeId,
        schema: recoveryDuckdbPage.metadata.schema.map((column) => ({ ...column })),
        viewState: recoveryDuckdbViewState
      };
    } finally {
      await configuration.update("notebookStartMode", originalNotebookStartMode, vscode.ConfigurationTarget.Workspace);
    }

    recordAcceptanceProgress(`${phase}:pandas-series`);
    const pandasSeries = await openReleasedVariableSession(
      workbench,
      testing,
      notebook,
      { name: "pandas_series", type: "Series", backend: "pandas", firstValue: "5" },
      "the Pandas Series opened through the released viewer argument"
    );
    await assertReleasedSessionPage(testing, pandasSeries, "5", "released-jupyter-pandas-series");
    await disposePackagedSessionPanel(testing, pandasSeries.sessionId, "the released-Jupyter Pandas Series");

    recordAcceptanceProgress(`${phase}:polars-dataframe`);
    await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);
    const polarsFrame = await openReleasedVariableSession(
      workbench,
      testing,
      notebook,
      {
        name: "polars_frame",
        type: "polars.dataframe.frame.DataFrame",
        backend: "polars",
        firstValue: "3"
      },
      "the Polars DataFrame opened through the released viewer argument"
    );
    assert.equal(
      polarsFrame.metadata.mode,
      "editing",
      "Changing the notebook start mode must make the next released-Jupyter session editable."
    );
    const polarsPage = await assertReleasedSessionPage(testing, polarsFrame, "3", "released-jupyter-polars-dataframe");
    await waitFor(
      () => testing.panelHydrated(polarsFrame.sessionId),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the exact released-Jupyter Polars panel to hydrate before its live preview",
      () =>
        JSON.stringify({
          sessionId: polarsFrame.sessionId,
          coordinator: testing.diagnostics(),
          activeTab: activeEditorTabDiagnostic()
        })
    );
    assert.equal(
      await withAcceptanceOperationDeadline(
        testing.synchronizePanel(polarsFrame.sessionId),
        OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
        "the exact released-Jupyter Polars panel synchronization"
      ),
      true,
      "The released-Jupyter Polars session must own a synchronized live dataframe panel before preview."
    );

    recordAcceptanceProgress(`${phase}:polars-plan`);
    const preview = await testing.previewPanelStep({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: polarsFrame.sessionId,
      revision: polarsPage.revision,
      step: {
        id: "released-jupyter-double",
        kind: "formula",
        params: {
          leftColumn: columnReference(polarsFrame.metadata, "units"),
          operator: "multiply",
          value: 2,
          newColumn: "double_units"
        }
      },
      offset: 0,
      limit: 10
    });
    assert.ok(preview, "The released-Jupyter Polars preview must publish through the live dataframe panel.");
    assert.equal(preview.metadata.draftStep?.id, "released-jupyter-double");
    if (phase === "jupyter-allow" && screenshotOutput) {
      await captureReleasedJupyterPolarsDraft(workbench, testing, polarsFrame.sessionId, screenshotOutput);
    }
    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: polarsFrame.sessionId,
      revision: preview.metadata.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") throw new Error("The released-Jupyter Polars plan did not apply.");
    assert.equal(applied.metadata.steps.length, 1);

    recordAcceptanceProgress(`${phase}:pandas-recovery-session`);
    const pandasRecovery = await openReleasedVariableSession(
      workbench,
      testing,
      notebook,
      { name: "pandas_frame", type: "DataFrame", backend: "pandas", firstValue: "1" },
      "the concurrent Pandas DataFrame retained for released-Jupyter recovery"
    );
    const pandasRecoveryPage = await assertReleasedSessionPage(
      testing,
      pandasRecovery,
      "1",
      "released-jupyter-pandas-concurrent-recovery"
    );
    const duckdbRestartSession = duckdbRecoverySession;
    assert.ok(duckdbRestartSession, "The native DuckDB session must remain open for kernel restart recovery.");
    assert.equal(
      testing.diagnostics().sessionCount,
      3,
      "The Polars, Pandas, and DuckDB sessions must all remain open before restart."
    );

    recordAcceptanceProgress(`${phase}:restart`);
    await exerciseReleasedJupyterRestartReplay(
      testing,
      notebook,
      polarsFrame.sessionId,
      applied,
      {
        sessionId: pandasRecovery.sessionId,
        revision: pandasRecoveryPage.revision,
        filterModel: pandasRecovery.metadata.filterModel
      },
      duckdbRestartSession,
      Number(initialKernel.pid),
      setupMarker,
      phase,
      kernelTarget,
      extension.extensionPath
    );
    await disposePackagedSessionPanel(testing, polarsFrame.sessionId, "the recovered released-Jupyter Polars session");
    await disposePackagedSessionPanel(
      testing,
      pandasRecovery.sessionId,
      "the recovered released-Jupyter Pandas session"
    );
    await disposePackagedSessionPanel(
      testing,
      duckdbRestartSession.sessionId,
      "the recovered released-Jupyter DuckDB relation session"
    );
    const recoveredDuckdbAliveEditor = await showExactReleasedNotebook(notebook);
    await executeReleasedNotebookCell(
      notebook,
      6,
      RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
      `${phase}:duckdb-replacement-relation-after-close`,
      recoveredDuckdbAliveEditor
    );
    const recoveredDuckdbAlive = releasedNotebookJsonResult(
      notebook.cellAt(6),
      RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
      "DuckDB replacement relation after Open Wrangler recovery cleanup"
    );
    assert.equal(recoveredDuckdbAlive.count, 100_000);
    assert.equal(recoveredDuckdbAlive.connectionCount, 100_000);
    assert.equal(recoveredDuckdbAlive.first, 3_400_001);
    assert.equal(recoveredDuckdbAlive.conversionGuards, true);
    await executeReleasedNotebookCell(
      notebook,
      7,
      RELEASED_JUPYTER_SESSION_COUNT_RESULT,
      `${phase}:replacement-runtime-session-count`,
      await showExactReleasedNotebook(notebook)
    );
    const replacementRuntimeSessions = releasedNotebookJsonResult(
      notebook.cellAt(7),
      RELEASED_JUPYTER_SESSION_COUNT_RESULT,
      "replacement kernel runtime sessions after terminal cleanup"
    );
    assert.equal(
      replacementRuntimeSessions.count,
      0,
      "Terminal cleanup must leave no Open Wrangler session in the replacement kernel."
    );
    assert.equal(testing.diagnostics().sessionCount, 0);
    if (phase === "jupyter-allow") {
      await exerciseReleasedPythonFileEntrypoint(testing, workbench, directory, kernelTarget);
      await exerciseReleasedPythonSourceCellDiscovery(testing, workbench, directory, kernelTarget);
    }
  } catch (error) {
    failureCheckpoint = failedAcceptanceProgressCheckpoint(phase, lastAcceptanceProgressCheckpoint);
    throw error;
  } finally {
    try {
      rendererLoadObserver?.dispose();
      await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
      remoteServerCollection?.dispose();
      await configuration.update("notebookStartMode", originalNotebookStartMode, vscode.ConfigurationTarget.Workspace);
      await configuration.update(
        "notebookPreviewProvider",
        originalNotebookPreviewProvider,
        vscode.ConfigurationTarget.Workspace
      );
      cleanupAcceptanceTemporaryDirectory(directory);
    } finally {
      if (failureCheckpoint) recordAcceptanceProgress(failureCheckpoint);
    }
  }
}

async function exerciseReleasedJupyterAllowCompatibilitySeam(
  testing: TestApi,
  workbench: Page,
  notebook: vscode.NotebookDocument,
  notebookEditor: vscode.NotebookEditor,
  rendererLoadObserver: NotebookRendererLoadObserver,
  renderedCell: vscode.NotebookRange,
  firstValue: string
): Promise<void> {
  recordAcceptanceProgress("jupyter-allow:candidate-seam:variables");
  await showExactReleasedNotebook(notebook);
  assertExactVisibleReleasedNotebookEditor(
    notebook,
    notebookEditor,
    "before opening the candidate Cursor Jupyter Variables seam"
  );
  await vscode.commands.executeCommand("jupyter.openVariableView");
  assertExactOpenNotebookDocument(notebook, "after opening the candidate Cursor Jupyter Variables seam");
  await dispatchReleasedJupyterVariableAction(
    workbench,
    notebook,
    RELEASED_JUPYTER_VARIABLES_PANDAS.name,
    "jupyter-allow:candidate-seam:variables"
  );
  const variablesSession = await waitForReleasedVariableSession(
    workbench,
    testing,
    notebook,
    RELEASED_JUPYTER_VARIABLES_PANDAS,
    "the canonical orders_df opened through the candidate Cursor Jupyter Variables seam"
  );
  try {
    await assertReleasedSessionPage(
      testing,
      variablesSession,
      RELEASED_JUPYTER_VARIABLES_PANDAS.firstValue,
      "jupyter-allow-candidate-variables-page"
    );
  } finally {
    await disposePackagedSessionPanel(
      testing,
      variablesSession.sessionId,
      "the candidate Cursor Jupyter Variables session"
    );
  }

  recordAcceptanceProgress("jupyter-allow:candidate-seam:renderer");
  const rendererEditor = await showExactReleasedNotebook(notebook);
  rendererEditor.selection = renderedCell;
  rendererEditor.selections = [renderedCell];
  rendererEditor.revealRange(renderedCell, vscode.NotebookEditorRevealType.InCenter);
  let rendererButton: NotebookRendererButton;
  try {
    rendererButton = await waitForNotebookRendererButton(workbench, "orders_preview_df", "Open in Open Wrangler");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Host: ${JSON.stringify(
        releasedNotebookRendererHostDiagnostics(notebook, 1)
      )} Browser: ${JSON.stringify(rendererLoadObserver.snapshot())}`
    );
  }
  let rendererSession: NonNullable<ReturnType<TestApi["activeSession"]>>;
  try {
    rendererSession = await openReleasedRendererVariableSession(
      rendererButton,
      workbench,
      testing,
      notebook,
      { name: "orders_preview_df", type: "DataFrame", backend: "pandas", firstValue },
      "the live orders_preview_df opened through the candidate Cursor renderer seam",
      "jupyter-allow:candidate-seam:renderer"
    );
  } finally {
    await rendererButton.dispose();
  }
  try {
    assert.deepEqual(rendererSession.metadata.shape, { rows: 100_000, columns: 12 });
    await assertReleasedSessionPage(testing, rendererSession, firstValue, "jupyter-allow-candidate-renderer-page");
  } finally {
    await disposePackagedSessionPanel(
      testing,
      rendererSession.sessionId,
      "the candidate Cursor Jupyter renderer session"
    );
  }
  assert.equal(testing.diagnostics().sessionCount, 0);
}

const exerciseReleasedPythonFileEntrypoint = createReleasedPythonFileEntrypointJourney({
  RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
  arrangePackagedProductSidebar,
  assertExactOpenNotebookDocument,
  assertExactVisibleReleasedNotebookEditor,
  assertReleasedSessionPage,
  closeExactReleasedPythonInteractiveWindow,
  disposePackagedSessionPanel,
  invokeReleasedNotebookToolbarVariable,
  recordAcceptanceProgress,
  releasedJupyterQuickInputDiagnostics,
  releasedJupyterQuickPickRow,
  releasedJupyterRouteLabel,
  releasedPythonEntrypointDiagnostics,
  releasedPythonFailureNotification,
  showExactReleasedNotebook,
  textDocumentTab,
  visibleReleasedJupyterQuickInput,
  waitFor,
  waitForReleasedVariableSession,
  withBoundedAcceptancePromise
});

const exerciseReleasedPythonSourceCellDiscovery = createReleasedPythonSourceCellJourney({
  RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS,
  arrangePackagedProductSidebar,
  assertExactOpenNotebookDocument,
  assertExactVisibleReleasedNotebookEditor,
  assertReleasedSessionPage,
  closeExactReleasedPythonInteractiveWindow,
  completedReleasedPythonSourceCells,
  disposePackagedSessionPanel,
  invokeReleasedNotebookToolbarVariable,
  recordAcceptanceProgress,
  releasedJupyterQuickPickRow,
  releasedJupyterRouteLabel,
  releasedPythonSourceCells,
  selectReleasedJupyterKernel,
  showExactReleasedNotebook,
  textDocumentTab,
  visibleReleasedJupyterQuickInput,
  waitFor,
  waitForReleasedVariableSession,
  withBoundedAcceptancePromise
});

async function closeExactReleasedPythonInteractiveWindow(interactive: vscode.NotebookDocument): Promise<void> {
  assertExactOpenNotebookDocument(interactive, "before closing the Python entry-point Interactive Window");
  if (!vscode.window.visibleNotebookEditors.some((candidate) => candidate.notebook === interactive)) {
    await waitFor(
      () =>
        interactive.isClosed ||
        vscode.window.visibleNotebookEditors.some((candidate) => candidate.notebook === interactive),
      10_000,
      "the existing Python entry-point Interactive Window editor to become visible for cleanup"
    );
  }
  if (interactive.isClosed) return;
  const closeBudget = vscode.window.visibleNotebookEditors.filter(
    (candidate) => candidate.notebook === interactive
  ).length;
  assert.ok(closeBudget > 0, "The Python entry-point Interactive Window must have a visible editor for cleanup.");
  let closeCount = 0;
  while (!interactive.isClosed) {
    const visibleEditors = vscode.window.visibleNotebookEditors.filter(
      (candidate) => candidate.notebook === interactive
    );
    assert.ok(
      visibleEditors.length > 0,
      "The Python entry-point Interactive Window must stay visible until its final editor closes."
    );
    assert.ok(
      closeCount < closeBudget,
      "The Python entry-point Interactive Window cleanup exceeded its initial exact-editor count."
    );

    let editor = vscode.window.activeNotebookEditor;
    if (editor?.notebook !== interactive) {
      const groupCount = vscode.window.tabGroups.all.length;
      for (let groupOffset = 0; groupOffset < groupCount; groupOffset += 1) {
        await withBoundedAcceptancePromise(
          vscode.commands.executeCommand("workbench.action.focusNextGroup"),
          10_000,
          "an editor group containing the exact Python entry-point Interactive Window to receive focus"
        );
        editor = vscode.window.activeNotebookEditor;
        if (editor?.notebook === interactive) break;
      }
    }

    assert.equal(
      editor?.notebook,
      interactive,
      "Cleanup must focus the exact Python entry-point Interactive Window before closing an editor."
    );
    assert.equal(
      vscode.window.activeNotebookEditor,
      editor,
      "Cleanup must not close an editor unless the exact Python entry-point Interactive Window is active."
    );
    const visibleCountBeforeClose = visibleEditors.length;
    await withBoundedAcceptancePromise(
      vscode.commands.executeCommand("workbench.action.closeActiveEditor"),
      10_000,
      "one exact Python entry-point Interactive Window editor to close"
    );
    closeCount += 1;
    await waitFor(
      () =>
        interactive.isClosed ||
        vscode.window.visibleNotebookEditors.filter((candidate) => candidate.notebook === interactive).length <
          visibleCountBeforeClose,
      10_000,
      "the exact Python entry-point Interactive Window editor count to decrease"
    );
    if (
      !interactive.isClosed &&
      !vscode.window.visibleNotebookEditors.some((candidate) => candidate.notebook === interactive)
    ) {
      await waitFor(() => interactive.isClosed, 10_000, "the final Python Interactive Window document to close");
    }
  }
  await waitFor(() => interactive.isClosed, 10_000, "the private Python Interactive Window to close");
}

function releasedPythonSourceCells(interactive: vscode.NotebookDocument, source: vscode.Uri): vscode.NotebookCell[] {
  return interactive.getCells().filter((cell) => {
    const metadata = cell.metadata as {
      interactive?: { uristring?: unknown; lineIndex?: unknown };
    };
    return metadata.interactive?.uristring === source.toString();
  });
}

function completedReleasedPythonSourceCells(
  interactive: vscode.NotebookDocument,
  source: vscode.Uri
): vscode.NotebookCell[] {
  return releasedPythonSourceCells(interactive, source).filter((cell) => cell.executionSummary?.success === true);
}

async function releasedPythonFailureNotification(workbench: Page): Promise<string | undefined> {
  const notices = await workbench
    .locator(".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible")
    .allInnerTexts();
  const text = notices
    .map((notice) => notice.replace(/\s+/gu, " ").trim().slice(0, 500))
    .find((notice) => notice.includes("Source: Open Wrangler"));
  if (!text) return undefined;
  if (/kernel|restored|focused after kernel/iu.test(text)) return "kernel recovery / rejected";
  if (/did not finish(?: within|\s+(?:opening|preparing))|failed\. Fix the error/iu.test(text)) {
    return "execution / failed";
  }
  if (/didn't confirm whether this Python/iu.test(text)) return "dispatch / unconfirmed";
  if (/did not produce an Interactive Window execution/iu.test(text)) return "dispatch / missing execution";
  if (/changed or closed|more than one matching cell/iu.test(text)) return "dispatch / stale or ambiguous";
  return undefined;
}

function releasedPythonEntrypointDiagnostics(
  interactive: vscode.NotebookDocument | undefined,
  source: vscode.TextDocument
): string {
  const cells =
    interactive
      ?.getCells()
      .slice(-8)
      .map((cell) => {
        const metadata = cell.metadata as {
          interactive?: { uristring?: unknown; lineIndex?: unknown };
          id?: unknown;
        };
        return {
          index: cell.index,
          language: cell.document.languageId,
          associatedSource: metadata.interactive?.uristring === source.uri.toString(),
          lineIndex: metadata.interactive?.lineIndex,
          hasId: typeof metadata.id === "string" && metadata.id.length > 0,
          success: cell.executionSummary?.success,
          executionOrder: cell.executionSummary?.executionOrder,
          ended: cell.executionSummary?.timing?.endTime !== undefined
        };
      }) ?? [];
  return JSON.stringify({
    opened: Boolean(interactive && !interactive.isClosed),
    cellCount: interactive?.cellCount ?? 0,
    visible: interactive
      ? vscode.window.visibleNotebookEditors.some((editor) => editor.notebook === interactive)
      : false,
    activeNotebook: interactive ? vscode.window.activeNotebookEditor?.notebook === interactive : false,
    sourceOpen: !source.isClosed,
    sourceActive: vscode.window.activeTextEditor?.document === source,
    cells
  });
}

const exerciseReleasedPySparkJupyterExtension = createReleasedPySparkJupyterJourney({
  GRID_COLUMN_WINDOW,
  RELEASED_JUPYTER_EXTENSION_VERSION,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  assertExactOpenNotebookDocument,
  assertReleasedJupyterKernelIdentity,
  assertReleasedPySparkPanelAndQueries,
  bestEffortReleasedJupyterCleanup,
  captureReleasedJupyterPySparkLive,
  captureReleasedJupyterPySparkPicker,
  closeReleasedJupyterSessionTabs,
  connectToEditorWorkbench,
  dispatchReleasedJupyterVariableAction,
  disposePackagedSessionPanel,
  executeReleasedNotebookCell,
  getLastAcceptanceProgressCheckpoint: () => lastAcceptanceProgressCheckpoint,
  gridColumnDisplays,
  recordAcceptanceProgress,
  releasedJupyterKernelTarget,
  releasedJupyterSessionTabs,
  releasedNotebookJsonResult,
  restartReleasedJupyterKernelAndWait,
  selectReleasedJupyterKernel,
  showExactReleasedNotebook,
  waitForReleasedJupyterConsent,
  waitForReleasedJupyterTerminalPanelError,
  waitForReleasedVariableSession,
  waitForStableReleasedJupyterSessionCount,
  withBoundedAcceptancePromise
});

async function dispatchReleasedJupyterVariableAction(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  variableName: string,
  checkpoint: string
): Promise<void> {
  await restoreCursorRemoteReleasedJupyterNotebook(notebook, checkpoint);
  const viewerAction = await waitForReleasedJupyterVariableAction(workbench, notebook, variableName, checkpoint);
  assert.equal(
    releasedJupyterSessionTabs().length,
    0,
    `The real released-Jupyter Variables action for ${variableName} requires a zero-tab receipt baseline.`
  );
  assertExactOpenNotebookDocument(
    notebook,
    `immediately before dispatching the released-Jupyter Variables action for ${variableName}`
  );
  recordAcceptanceProgress(`${checkpoint}:dispatch`);
  await invokeAcceptanceActionOnceWithAuthoritativeReceipt({
    description: `the real released-Jupyter Variables action for ${variableName}`,
    activate: () => viewerAction.action.press("Enter", { timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    receipt: async () => {
      assert.equal(
        await viewerAction.documentRoot.evaluate(
          (element) =>
            (element as unknown as ReleasedJupyterDocumentRootElement).dataset.openWranglerAcceptanceActivation
        ),
        "seen",
        `The real released-Jupyter Variables action for ${variableName} must receive one trusted keyboard activation.`
      );
      await waitForReleasedJupyterVariableActionReceipt(variableName);
    },
    authoritativeReceiptAfterActivationFailure: () => waitForReleasedJupyterVariableActionReceipt(variableName)
  });
  recordAcceptanceProgress(`${checkpoint}:receipt`);
}

async function restoreCursorRemoteReleasedJupyterNotebook(
  notebook: vscode.NotebookDocument,
  checkpoint: string
): Promise<void> {
  if (process.env.OPEN_WRANGLER_TEST_EDITOR !== "cursor" || process.env.OPEN_WRANGLER_TEST_PHASE !== "jupyter-remote") {
    return;
  }
  assertExactOpenNotebookDocument(notebook, "before checking Cursor's remote Jupyter Variables notebook");
  if (vscode.window.activeNotebookEditor?.notebook === notebook) return;

  recordAcceptanceProgress(`${checkpoint}:focus-drift`);
  const exactEditor = await showExactReleasedNotebook(notebook);
  assertExactVisibleReleasedNotebookEditor(
    notebook,
    exactEditor,
    "after restoring Cursor's remote Jupyter Variables notebook"
  );
  recordAcceptanceProgress(`${checkpoint}:refocused`);
}

async function waitForReleasedJupyterVariableActionReceipt(variableName: string): Promise<void> {
  await waitFor(
    () => releasedJupyterSessionTabs().length === 1,
    10_000,
    `the released Jupyter viewer delegation for ${variableName}`,
    () => JSON.stringify({ tabCount: releasedJupyterSessionTabs().length })
  );
}

async function assertReleasedPySparkPanelAndQueries(
  testing: TestApi,
  active: NonNullable<ReturnType<TestApi["activeSession"]>>,
  variant: "classic" | "connect"
): Promise<Extract<OpenWranglerResponse, { kind: "page" }>> {
  await waitFor(
    () => testing.panelHydrated(active.sessionId),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the released-Jupyter PySpark ${variant} panel to hydrate`,
    () => JSON.stringify(testing.diagnostics())
  );
  assert.equal(
    await withAcceptanceOperationDeadline(
      testing.synchronizePanel(active.sessionId),
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      `the released-Jupyter PySpark ${variant} panel synchronization`
    ),
    true
  );

  const filterModel: FilterModel = {
    logic: "and",
    filters: [
      {
        column: "category",
        type: "string",
        logic: "and",
        predicates: [{ kind: "predicate", operator: "equals", value: "alpha" }]
      }
    ],
    sort: [{ column: "amount", direction: "desc", nulls: "last" }]
  };
  const first = await withBoundedAcceptancePromise(
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `released-jupyter-pyspark-${variant}-page-0`,
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 1,
      filterModel
    }),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the released-Jupyter PySpark ${variant} filtered page`
  );
  assert.equal(first.kind, "page");
  if (first.kind !== "page") throw new Error(`The PySpark ${variant} filtered page did not resolve.`);
  assert.equal(first.page.totalRows, null);
  assert.equal("hasMore" in first.page && first.page.hasMore, true);
  assert.deepEqual(first.metadata.filterModel, filterModel);
  const recordId = first.metadata.schema.find((column) => column.name === "record_id");
  const amount = first.metadata.schema.find((column) => column.name === "amount");
  assert.ok(recordId);
  assert.ok(amount);
  assert.deepEqual(gridColumnDisplays(first.page, recordId.id), ["2"]);

  const second = await withBoundedAcceptancePromise(
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `released-jupyter-pyspark-${variant}-page-1`,
      sessionId: active.sessionId,
      revision: first.revision,
      offset: 1,
      limit: 1,
      filterModel
    }),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the released-Jupyter PySpark ${variant} second page`
  );
  assert.equal(second.kind, "page");
  if (second.kind !== "page") throw new Error(`The PySpark ${variant} second page did not resolve.`);
  assert.equal(second.page.totalRows, 2);
  assert.deepEqual(gridColumnDisplays(second.page, recordId.id), ["3"]);

  const summaryColumnIds = second.metadata.schema.map((column) => column.id);
  assert.ok(summaryColumnIds[0], `The PySpark ${variant} tiny fixture must retain at least one column.`);
  const summary = await withBoundedAcceptancePromise(
    testing.request({
      kind: "getSummary",
      viewRequestId: `released-jupyter-pyspark-${variant}-summary`,
      sessionId: active.sessionId,
      revision: second.revision,
      filterModel,
      columnIds: [summaryColumnIds[0], ...summaryColumnIds.slice(1)]
    }),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the released-Jupyter PySpark ${variant} complete tiny-fixture summaries`
  );
  assert.equal(summary.kind, "summary");
  if (summary.kind !== "summary") throw new Error(`The PySpark ${variant} summaries did not resolve.`);
  assert.deepEqual(
    summary.summaries.map((item) => item.columnId),
    summaryColumnIds,
    `The PySpark ${variant} complete projection must retain schema order.`
  );
  assert.deepEqual(
    summary.summaries.map((item) => item.totalCount),
    [2, 2, 2]
  );
  const recordIdSummary = summary.summaries.find((item) => item.columnId === recordId.id);
  const category = second.metadata.schema.find((column) => column.name === "category");
  assert.ok(category);
  const categorySummary = summary.summaries.find((item) => item.columnId === category.id);
  const amountSummary = summary.summaries.find((item) => item.columnId === amount.id);
  assert.equal(recordIdSummary?.numeric?.min, 2);
  assert.equal(recordIdSummary?.numeric?.max, 3);
  assert.deepEqual(categorySummary?.topValues, [{ value: "alpha", count: 2 }]);
  assert.equal(amountSummary?.numeric?.min, 20);
  assert.equal(amountSummary?.numeric?.max, 30);
  return second;
}

function readReleasedRemoteJupyterDescriptor(runId: string): {
  readonly baseUrl: string;
  readonly token: string;
  readonly hostname: string;
} {
  assert.equal(process.platform, "linux", "Container-isolated remote Jupyter acceptance is Linux-only.");
  const descriptorPath = process.env.OPEN_WRANGLER_TEST_REMOTE_JUPYTER_DESCRIPTOR;
  assert.ok(
    descriptorPath && path.isAbsolute(descriptorPath) && !/[\0\r\n]/u.test(descriptorPath),
    "Remote Jupyter acceptance requires one absolute private descriptor path."
  );
  const privateTemp = path.resolve(tmpdir());
  const resolvedDescriptor = path.resolve(descriptorPath);
  const contained = path.relative(privateTemp, resolvedDescriptor);
  assert.ok(
    contained.length > 0 && contained !== ".." && !contained.startsWith(`..${path.sep}`) && !path.isAbsolute(contained),
    "The remote Jupyter descriptor must stay inside the phase's private temporary root."
  );

  let descriptorFd: number | undefined;
  try {
    descriptorFd = openSync(
      resolvedDescriptor,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)
    );
    const before = fstatSync(descriptorFd, { bigint: true });
    assert.ok(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1n &&
        before.size > 0n &&
        before.size <= 2_048n &&
        (before.mode & 0o777n) === 0o400n &&
        (typeof process.getuid !== "function" || before.uid === BigInt(process.getuid())),
      "The remote Jupyter descriptor must be one owned, mode-0400, single-link bounded regular file."
    );
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptorFd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, "The remote Jupyter descriptor ended before its recorded size.");
      offset += count;
    }
    const after = fstatSync(descriptorFd, { bigint: true });
    assert.deepEqual(
      {
        dev: after.dev,
        ino: after.ino,
        mode: after.mode,
        nlink: after.nlink,
        uid: after.uid,
        size: after.size,
        mtimeNs: after.mtimeNs
      },
      {
        dev: before.dev,
        ino: before.ino,
        mode: before.mode,
        nlink: before.nlink,
        uid: before.uid,
        size: before.size,
        mtimeNs: before.mtimeNs
      },
      "The remote Jupyter descriptor changed while it was read."
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(decoded);
    assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    const record = parsed as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ["baseUrl", "hostname", "protocol", "runId", "token"]);
    assert.equal(record.protocol, RELEASED_JUPYTER_REMOTE_DESCRIPTOR_PROTOCOL);
    assert.equal(record.runId, runId);
    assert.equal(record.hostname, `owr-${runId.replaceAll("-", "").slice(0, 12)}`);
    const token = readReleasedRemoteJupyterDescriptorToken(record.token);
    assert.ok(typeof record.baseUrl === "string" && record.baseUrl.length <= 64);
    return {
      baseUrl: record.baseUrl,
      token,
      hostname: String(record.hostname)
    };
  } catch (error) {
    throw new Error("Remote Jupyter acceptance could not validate its private connection descriptor.", {
      cause: error
    });
  } finally {
    if (descriptorFd !== undefined) closeSync(descriptorFd);
  }
}

function releasedJupyterKernelTarget(phase: ReleasedJupyterPhase): ReleasedJupyterKernelTarget {
  if (phase === "jupyter-r") {
    return {
      label: RELEASED_JUPYTER_R_KERNEL_LABEL,
      name: RELEASED_JUPYTER_R_KERNEL_NAME,
      routeLabels: ["Jupyter Kernel...", "Jupyter", "Local Kernel Specs..."]
    };
  }
  if (phase !== "jupyter-remote" && phase !== "jupyter-r-remote") {
    return {
      label: RELEASED_JUPYTER_LOCAL_KERNEL_LABEL,
      name: "openwrangler-acceptance",
      routeLabels: ["Jupyter Kernel...", "Jupyter", "Local Kernel Specs..."]
    };
  }
  const runId = process.env.OPEN_WRANGLER_TEST_RUN_ID;
  assert.ok(
    runId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId),
    "Remote Jupyter acceptance requires its correlated UUID run ID."
  );
  const descriptor = readReleasedRemoteJupyterDescriptor(runId);
  const serializedBaseUrl = descriptor.baseUrl;
  const parsed = new URL(serializedBaseUrl);
  assert.equal(parsed.protocol, "http:", "Remote Jupyter acceptance permits only a loopback HTTP server.");
  assert.equal(parsed.hostname, "127.0.0.1", "Remote Jupyter acceptance permits only the IPv4 loopback host.");
  assert.match(parsed.port, /^(?:[1-9][0-9]{0,4})$/u, "Remote Jupyter acceptance requires an explicit port.");
  assert.ok(Number(parsed.port) <= 65_535, "Remote Jupyter acceptance port exceeds the TCP range.");
  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
  assert.equal(parsed.pathname, "/");
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "");
  assert.equal(parsed.origin, serializedBaseUrl, "The remote Jupyter base URL must be one canonical origin.");
  return {
    label: phase === "jupyter-r-remote" ? RELEASED_JUPYTER_REMOTE_R_KERNEL_LABEL : RELEASED_JUPYTER_REMOTE_KERNEL_LABEL,
    name: phase === "jupyter-r-remote" ? RELEASED_JUPYTER_REMOTE_R_KERNEL_NAME : RELEASED_JUPYTER_REMOTE_KERNEL_NAME,
    routeLabels: [RELEASED_JUPYTER_REMOTE_COLLECTION_LABEL, RELEASED_JUPYTER_REMOTE_SERVER_LABEL],
    remote: {
      baseUrl: vscode.Uri.parse(serializedBaseUrl, true),
      token: descriptor.token,
      runId,
      hostname: descriptor.hostname
    }
  };
}

function registerReleasedRemoteJupyterServer(
  jupyter: Jupyter,
  target: ReleasedJupyterKernelTarget
): JupyterServerCollection {
  assert.ok(target.remote, "A local released-Jupyter target cannot register the remote server collection.");
  const server = {
    id: `container-${target.remote.runId.replaceAll("-", "")}`,
    label: RELEASED_JUPYTER_REMOTE_SERVER_LABEL,
    connectionInformation: {
      baseUrl: target.remote.baseUrl,
      token: target.remote.token
    }
  } as const;
  return jupyter.createJupyterServerCollection(
    `openwrangler.remoteAcceptance.${target.remote.runId.replaceAll("-", "")}`,
    RELEASED_JUPYTER_REMOTE_COLLECTION_LABEL,
    {
      provideJupyterServers: () => [server],
      resolveJupyterServer: (candidate) => {
        assert.equal(candidate.id, server.id, "Released Jupyter resolved an unknown remote acceptance server.");
        return server;
      }
    }
  );
}

function assertReleasedJupyterKernelIdentity(
  result: Readonly<Record<string, unknown>>,
  target: ReleasedJupyterKernelTarget,
  hostPython: string
): void {
  assert.equal(result.setup === undefined, false, "The released-Jupyter setup result must include its marker.");
  if (!target.remote) {
    assert.equal(
      canonicalAcceptancePath(String(result.executable)),
      canonicalAcceptancePath(hostPython),
      "The local released Jupyter kernel must use the runner-selected private Python environment."
    );
    return;
  }
  assert.notEqual(
    canonicalAcceptancePath(String(result.executable)),
    canonicalAcceptancePath(hostPython),
    "The remote Jupyter kernel must not execute through the editor host's Python environment."
  );
  assert.equal(
    result.remoteRunId,
    target.remote.runId,
    "The selected kernel did not originate in the owned container."
  );
  assert.equal(
    result.hostname,
    target.remote.hostname,
    "The selected kernel reported an unexpected container hostname."
  );
  assert.equal(
    result.hostExtensionVisible,
    false,
    "The remote kernel must not be able to read the host extension installation."
  );
}

async function assertReleasedRemoteRuntimeTransfer(
  notebook: vscode.NotebookDocument,
  target: ReleasedJupyterKernelTarget,
  hostExtensionPath: string,
  phase: ReleasedJupyterPhase
): Promise<void> {
  assert.ok(target.remote, "Runtime-transfer attestation is reserved for the remote Jupyter phase.");
  await executeReleasedNotebookCell(notebook, 4, RELEASED_JUPYTER_RUNTIME_RESULT, `${phase}:runtime-transfer-cell`);
  const result = releasedNotebookJsonResult(notebook.cellAt(4), RELEASED_JUPYTER_RUNTIME_RESULT, "runtime transfer");
  assert.equal(result.remoteRunId, target.remote.runId);
  assert.equal(result.hostname, target.remote.hostname);
  assert.equal(result.hostExtensionVisible, false);
  const runtimeFile = String(result.runtimeFile);
  assert.match(
    runtimeFile,
    /^\/tmp\/openwrangler-runtime\/[0-9a-f]{16}\/openwrangler_runtime\/__init__\.py$/u,
    "Open Wrangler must transfer its runtime into the remote kernel's own temporary filesystem."
  );
  assert.equal(
    runtimeFile.startsWith(canonicalAcceptancePath(hostExtensionPath)),
    false,
    "The remote runtime must not resolve from the host extension installation."
  );
}

function assertExactOpenNotebookDocument(notebook: vscode.NotebookDocument, checkpoint: string): void {
  const matches = vscode.workspace.notebookDocuments.filter(
    (candidate) => !candidate.isClosed && candidate.uri.toString() === notebook.uri.toString()
  );
  assert.equal(matches.length, 1, `The released-Jupyter notebook URI must identify one document ${checkpoint}.`);
  assert.equal(matches[0], notebook, `The released-Jupyter notebook object changed ${checkpoint}.`);
  assert.equal(notebook.isClosed, false, `The released-Jupyter notebook closed ${checkpoint}.`);
}

async function showExactReleasedNotebook(notebook: vscode.NotebookDocument): Promise<vscode.NotebookEditor> {
  assertExactOpenNotebookDocument(notebook, "before showing its exact editor");
  const existingEditors = vscode.window.visibleNotebookEditors.filter((candidate) => candidate.notebook === notebook);
  assert.ok(
    existingEditors.length <= 1,
    "A released-Jupyter notebook must not already be visible in multiple editor groups."
  );
  const existingEditor = existingEditors[0];
  const editor = await vscode.window.showNotebookDocument(notebook, {
    viewColumn: existingEditor?.viewColumn ?? vscode.ViewColumn.One,
    preserveFocus: false,
    preview: false
  });
  if (existingEditor) {
    assert.equal(editor, existingEditor, "Showing a visible released-Jupyter notebook must reuse its exact editor.");
  }
  assert.equal(editor.notebook, notebook, "Showing a released-Jupyter notebook must retain its exact editor.");
  assertExactOpenNotebookDocument(notebook, "after showing its exact editor");
  assertExactVisibleReleasedNotebookEditor(notebook, editor, "after showing its exact editor");
  return editor;
}

function assertExactVisibleReleasedNotebookEditor(
  notebook: vscode.NotebookDocument,
  editor: vscode.NotebookEditor,
  checkpoint: string
): void {
  const sameUriEditors = vscode.window.visibleNotebookEditors.filter(
    (candidate) => candidate.notebook.uri.toString() === notebook.uri.toString()
  );
  assert.equal(sameUriEditors.length, 1, `The released-Jupyter notebook must have one visible editor ${checkpoint}.`);
  assert.equal(sameUriEditors[0], editor, `The released-Jupyter visible editor changed ${checkpoint}.`);
  assert.equal(editor.notebook, notebook, `The released-Jupyter visible editor changed document ${checkpoint}.`);
  assert.equal(
    vscode.window.activeNotebookEditor,
    editor,
    `The released-Jupyter notebook was not active ${checkpoint}.`
  );
}

async function selectReleasedJupyterKernel(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  notebookEditor: vscode.NotebookEditor,
  phase: ReleasedJupyterPhase,
  targetKernel: ReleasedJupyterKernelTarget
): Promise<void> {
  assertExactOpenNotebookDocument(notebook, "before selecting its released Jupyter kernel");
  assert.equal(notebookEditor.notebook, notebook, "The released-Jupyter kernel picker must keep its captured editor.");
  const selection = vscode.commands.executeCommand("notebook.selectKernel", {
    notebookEditor
  });
  type SelectionState = { kind: "pending" } | { kind: "fulfilled" } | { kind: "rejected"; error: unknown };
  let selectionState: SelectionState = { kind: "pending" };
  const readSelectionState = (): SelectionState => selectionState;
  const observedSelection = Promise.resolve(selection).then(
    () => {
      selectionState = { kind: "fulfilled" };
      return selectionState;
    },
    (error: unknown) => {
      selectionState = { kind: "rejected", error };
      return selectionState;
    }
  );
  const deadline = Date.now() + 30_000;
  const traversed = new Set<string>();
  let filterForTarget = false;
  try {
    do {
      assertExactOpenNotebookDocument(notebook, "while selecting its released Jupyter kernel");
      const currentSelectionState = readSelectionState();
      if (currentSelectionState.kind === "rejected") throw currentSelectionState.error;
      const quickInput = await visibleReleasedJupyterQuickInput(workbench);
      if (!quickInput) {
        if (currentSelectionState.kind === "fulfilled") {
          throw new Error("The released-Jupyter kernel picker closed before the private kernel was selected.");
        }
        await workbench.waitForTimeout(50);
        continue;
      }
      const target = await releasedJupyterQuickPickRow(quickInput, targetKernel.label);
      if (target) {
        recordAcceptanceProgress(`${phase}:kernel-picker-target`);
        await target.click();
        const outcome = await withBoundedAcceptancePromise(
          observedSelection,
          60_000,
          "the released-Jupyter kernel selection"
        );
        if (outcome.kind === "rejected") throw outcome.error;
        assertExactOpenNotebookDocument(notebook, "after selecting its released Jupyter kernel");
        assert.equal(notebookEditor.notebook, notebook, "The released-Jupyter kernel selection changed its editor.");
        await waitForReleasedJupyterKernelLabel(workbench, targetKernel.label);
        return;
      }

      if (filterForTarget) {
        const stillOnRoutePicker = await releasedJupyterRouteLabel(quickInput, targetKernel.routeLabels);
        if (!stillOnRoutePicker) {
          const input = quickInput.locator(".quick-input-box input:visible").first();
          if ((await input.count()) > 0) {
            await input.fill(targetKernel.label);
            filterForTarget = false;
            await workbench.waitForTimeout(100);
            continue;
          }
        }
      }

      let advanced = false;
      for (const label of ["Select Another Kernel...", ...targetKernel.routeLabels]) {
        if (traversed.has(label)) continue;
        const row = await releasedJupyterQuickPickRow(quickInput, label);
        if (!row) continue;
        traversed.add(label);
        recordAcceptanceProgress(
          `${phase}:kernel-picker-${label
            .toLowerCase()
            .replaceAll(/[^a-z]+/gu, "-")
            .replaceAll(/^-|-$/gu, "")}`
        );
        await row.click();
        filterForTarget = targetKernel.routeLabels.includes(label);
        await workbench.waitForTimeout(100);
        advanced = true;
        break;
      }
      if (!advanced) await workbench.waitForTimeout(100);
    } while (Date.now() < deadline);

    const diagnostics = await releasedJupyterQuickInputDiagnostics(workbench);
    throw new Error(
      `Timed out selecting released-Jupyter kernel ${JSON.stringify(targetKernel.label)}. ` +
        `Quick-input labels: ${JSON.stringify(diagnostics)}`
    );
  } catch (error) {
    await dismissReleasedJupyterKernelPicker(workbench, observedSelection);
    throw error;
  }
}

async function releasedJupyterRouteLabel(
  quickInput: Locator,
  routeLabels: readonly string[]
): Promise<string | undefined> {
  for (const label of ["Select Another Kernel...", ...routeLabels]) {
    if (await releasedJupyterQuickPickRow(quickInput, label)) return label;
  }
  return undefined;
}

async function dismissReleasedJupyterKernelPicker(
  workbench: Page,
  selection: Promise<{ kind: "fulfilled" } | { kind: "rejected"; error: unknown }>
): Promise<void> {
  const quickInputs = workbench.mainFrame().locator(".quick-input-widget:visible");
  const count = Math.min(await quickInputs.count().catch(() => 0), 8);
  for (let index = 0; index < count; index += 1) {
    const quickInput = quickInputs.nth(index);
    const input = quickInput.locator(".quick-input-box input:visible").first();
    if ((await input.count().catch(() => 0)) > 0) {
      await input.press("Escape").catch(() => {});
    } else {
      await quickInput.press("Escape").catch(() => {});
    }
  }
  await Promise.race([selection, workbench.waitForTimeout(2_000)]).catch(() => {});
}

async function waitForReleasedJupyterKernelLabel(workbench: Page, expectedLabel: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    let exactMatches = 0;
    const labels = workbench.mainFrame().locator(".kernel-action-view-item .kernel-label:visible");
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
        exactMatches += 1;
    }
    if (exactMatches === 1) return;
    assert.ok(exactMatches < 2, `The workbench exposed duplicate ${JSON.stringify(expectedLabel)} kernel labels.`);
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`The workbench did not confirm selected kernel ${JSON.stringify(expectedLabel)}.`);
}

async function visibleReleasedJupyterQuickInput(workbench: Page): Promise<Locator | undefined> {
  const quickInput = workbench.mainFrame().locator(".quick-input-widget:visible").last();
  if ((await quickInput.count().catch(() => 0)) > 0 && (await quickInput.isVisible().catch(() => false))) {
    return quickInput;
  }
  return undefined;
}

async function releasedJupyterQuickPickRow(quickInput: Locator, label: string): Promise<Locator | undefined> {
  const labels = quickInput.locator(".quick-input-list [role='option'] .label-name:visible");
  const count = await labels.count();
  assert.ok(count <= 256, "The released-Jupyter kernel picker exceeded its bounded visible option count.");
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = labels.nth(index);
    if ((await candidate.innerText()).trim() === label) {
      matches.push(candidate.locator("xpath=ancestor::*[@role='option'][1]"));
    }
  }
  assert.ok(matches.length < 2, `The released-Jupyter kernel picker exposed duplicate ${JSON.stringify(label)} rows.`);
  return matches[0];
}

async function releasedJupyterQuickInputDiagnostics(workbench: Page): Promise<string[]> {
  const diagnostics: string[] = [];
  const labels = workbench.mainFrame().locator(".quick-input-widget:visible [role='option'] .label-name:visible");
  const count = Math.min(await labels.count().catch(() => 0), 64);
  for (let index = 0; index < count; index += 1) {
    diagnostics.push(
      (
        await labels
          .nth(index)
          .innerText()
          .catch(() => "")
      )
        .trim()
        .slice(0, 256)
    );
  }
  return diagnostics;
}

async function boundedReleasedJupyterQuickInputDiagnostics(workbench: Page): Promise<string[] | string> {
  try {
    return await withBoundedAcceptancePromise(
      releasedJupyterQuickInputDiagnostics(workbench),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "released-Jupyter quick-input diagnostics"
    );
  } catch {
    return "unavailable within the diagnostics deadline";
  }
}

async function exerciseFormatterDisabledFirstNotebookResult(
  workbench: Page,
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  notebookEditor: vscode.NotebookEditor,
  jupyterApi: Jupyter
): Promise<void> {
  const checkpoint = "jupyter-allow:first-result";
  const removedRerunHint = "Run this cell again to open the current dataframe in Open Wrangler.";
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  assert.equal(
    configuration.get("notebookPreviewProvider"),
    "disabled",
    "The first-result fallback must run before proactive notebook formatters are enabled."
  );
  const cell = notebook.cellAt(RELEASED_JUPYTER_FIRST_RESULT_CELL);
  const initialExecutionOrder = cell.executionSummary?.executionOrder;
  assert.equal(
    initialExecutionOrder,
    undefined,
    "The first-result fixture cell must not have an execution order before acceptance."
  );
  assert.equal(cell.outputs.length, 0, "The first-result fixture cell must begin without saved output.");
  const kernel = await jupyterApi.kernels.getKernel(notebook.uri);
  assert.ok(kernel, "The first-result fallback requires the exact selected notebook kernel.");

  const range = new vscode.NotebookRange(RELEASED_JUPYTER_FIRST_RESULT_CELL, RELEASED_JUPYTER_FIRST_RESULT_CELL + 1);
  notebookEditor.selection = range;
  notebookEditor.selections = [range];
  notebookEditor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
  await waitFor(
    () =>
      notebookEditor.visibleRanges.some(
        (visible) =>
          visible.start <= RELEASED_JUPYTER_FIRST_RESULT_CELL && visible.end > RELEASED_JUPYTER_FIRST_RESULT_CELL
      ),
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
    "the formatter-disabled Pandas result cell to become visible before its first execution"
  );
  recordAcceptanceProgress(`${checkpoint}:execute`);
  await executeReleasedNotebookCell(
    notebook,
    RELEASED_JUPYTER_FIRST_RESULT_CELL,
    undefined,
    checkpoint,
    notebookEditor
  );
  const executionOrder = cell.executionSummary?.executionOrder;
  assert.ok(
    Number.isSafeInteger(executionOrder) && Number(executionOrder) > 0,
    "The formatter-disabled Pandas result must publish one positive execution order."
  );
  const outputMimes = cell.outputs.flatMap((output) => output.items.map((item) => item.mime));
  assert.equal(
    outputMimes.includes(OPEN_WRANGLER_MIME_V2),
    false,
    "The formatter-disabled first result must not contain Open Wrangler MIME."
  );
  assert.ok(
    cell.outputs.some((output) => output.metadata?.outputType === "execute_result"),
    "The first-result fallback must be exercised by a real Jupyter execute_result."
  );
  const outputText = notebookCellOutputText(cell);
  assert.equal(
    outputText.includes(removedRerunHint),
    false,
    "The formatter-disabled cell output must not restore the removed rerun instruction."
  );
  assert.equal(testing.diagnostics().sessionCount, 0, "Executing the first result must not open a session by itself.");

  const consent = await waitForReleasedJupyterConsent(workbench, testing);
  assertExactOpenNotebookDocument(notebook, "while first-result kernel consent belongs to the fixture notebook");
  recordAcceptanceProgress(`${checkpoint}:consent`);
  await consent.allow.click();
  await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(
    configuration.get("notebookPreviewProvider"),
    "disabled",
    "Kernel consent must not enable proactive formatters before the first-result action is used."
  );

  notebookEditor.selection = range;
  notebookEditor.selections = [range];
  notebookEditor.revealRange(range, vscode.NotebookEditorRevealType.AtTop);
  await waitFor(
    () =>
      notebookEditor.visibleRanges.some(
        (visible) =>
          visible.start <= RELEASED_JUPYTER_FIRST_RESULT_CELL && visible.end > RELEASED_JUPYTER_FIRST_RESULT_CELL
      ),
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
    "the formatter-disabled Pandas result cell to become visible again after kernel consent"
  );
  const action = await waitForReleasedNotebookCellResultAction(
    workbench,
    testing,
    notebook,
    notebookEditor,
    RELEASED_JUPYTER_FIRST_RESULT_CELL
  );
  const actionText = (await action.innerText()).replace(/\s+/gu, " ").trim();
  assert.equal(actionText, "Open in Open Wrangler", "The cell status fallback must use the canonical action label.");
  assert.equal(
    await workbench.getByText(removedRerunHint, { exact: true }).count(),
    0,
    "The notebook workbench must not display the removed rerun instruction."
  );

  const beforeClickOutput = notebookCellOutputText(cell);
  const receipt = async (): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> => {
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.backend === "pandas" &&
          active.metadata.source.kind === "notebookVariable" &&
          active.metadata.source.label === "DataFrame" &&
          active.metadata.source.uri === notebook.uri.toString() &&
          active.metadata.shape.rows === 3 &&
          active.metadata.shape.columns === 12
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the formatter-disabled first Pandas result to open from its cell status action",
      () => JSON.stringify(testing.diagnostics())
    );
    const active = testing.activeSession();
    assert.ok(active, "The formatter-disabled cell status action must publish an active session.");
    return active;
  };
  recordAcceptanceProgress(`${checkpoint}:action-ready`);
  const session = await invokeAcceptanceActionOnceWithAuthoritativeReceipt({
    description: "the formatter-disabled first-result cell status action",
    activate: () => action.click({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    receipt,
    authoritativeReceiptAfterActivationFailure: receipt
  });
  recordAcceptanceProgress(`${checkpoint}:session-open`);
  try {
    assert.match(
      session.metadata.source.variableName ?? "",
      /^__openwrangler_live_result_[0-9a-f]{32}$/u,
      "The first-result action must bind the exact live Out value through an opaque handle."
    );
    assert.deepEqual(session.metadata.shape, { rows: 3, columns: 12 });
    assert.deepEqual(session.metadata.filteredShape, { rows: 3, columns: 12 });
    const page = await testing.request({
      kind: "getPage",
      columnOffset: 0,
      columnLimit: 12,
      viewRequestId: "released-jupyter-first-result-page",
      sessionId: session.sessionId,
      revision: session.metadata.revision,
      offset: 0,
      limit: 3,
      filterModel: session.metadata.filterModel
    });
    assert.equal(page.kind, "page");
    if (page.kind !== "page") throw new Error("The formatter-disabled first-result page did not resolve.");
    assert.equal(page.page.totalRows, 3);
    assert.equal(page.page.rows[0]?.values[0]?.display, "2499998");
    assert.equal(page.page.rows[2]?.values[0]?.display, "2500000");
    assert.equal(
      await jupyterApi.kernels.getKernel(notebook.uri),
      kernel,
      "Opening the first result must retain the exact kernel that produced it."
    );
    assert.equal(
      cell.executionSummary?.executionOrder,
      executionOrder,
      "Opening the first result must not rerun its notebook cell."
    );
    assert.equal(
      notebookCellOutputText(cell),
      beforeClickOutput,
      "Opening the first result must not replace or rerender its original output."
    );
    assert.equal(
      cell.outputs.flatMap((output) => output.items.map((item) => item.mime)).includes(OPEN_WRANGLER_MIME_V2),
      false,
      "Opening the first result must not rewrite it as Open Wrangler MIME."
    );
  } finally {
    await disposePackagedSessionPanel(testing, session.sessionId, "the formatter-disabled first-result session");
    recordAcceptanceProgress(`${checkpoint}:session-closed`);
  }
}

async function waitForReleasedNotebookCellResultAction(
  workbench: Page,
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  notebookEditor: vscode.NotebookEditor,
  cellIndex: number
): Promise<Locator> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  do {
    assertExactVisibleReleasedNotebookEditor(notebook, notebookEditor, "while locating its first-result action");
    const overlays = workbench.locator(".notebookOverlay:visible");
    const overlayCount = await overlays.count().catch(() => 0);
    assert.ok(overlayCount < 2, "The workbench exposed duplicate visible notebook overlays.");
    const row = overlays
      .first()
      .locator(`.cell-list-container .monaco-list-rows > [data-index="${cellIndex}"]:visible`);
    const rowCount = await row.count().catch(() => 0);
    assert.ok(rowCount < 2, "The active notebook exposed duplicate rows for the first-result cell.");
    const action = row.locator(
      '.cell-statusbar-container:visible .cell-status-item.cell-status-item-has-command[aria-label="Open executed dataframe result in Open Wrangler"]:visible'
    );
    const actionCount = await action.count().catch(() => 0);
    assert.ok(actionCount < 2, "The active notebook exposed duplicate Open Wrangler result actions.");
    if (actionCount === 1 && (await action.isVisible().catch(() => false))) {
      const [bounds, viewport] = await Promise.all([
        action.boundingBox().catch(() => null),
        workbench.evaluate(() => {
          const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
          return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
        })
      ]);
      if (
        bounds &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.x < viewport.width &&
        bounds.x + bounds.width > 0 &&
        bounds.y < viewport.height &&
        bounds.y + bounds.height > 0
      ) {
        return action;
      }
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(
    "Timed out waiting for the Open Wrangler result action in the active notebook. " +
      `Tracker: ${JSON.stringify(testing.notebookCellResultDiagnostics() ?? { stage: "unavailable" })}.`
  );
}

async function executeReleasedNotebookCell(
  notebook: vscode.NotebookDocument,
  index: number,
  expectedText: string | readonly string[] | undefined,
  checkpoint: string,
  expectedEditor?: vscode.NotebookEditor,
  failureDiagnostic?: "r-setup"
): Promise<void> {
  assertExactOpenNotebookDocument(notebook, `before executing cell ${index}`);
  if (expectedEditor) {
    assertExactVisibleReleasedNotebookEditor(notebook, expectedEditor, `before executing cell ${index}`);
  }
  assert.ok(index >= 0 && index < notebook.cellCount, `Released-Jupyter cell ${index} must exist.`);
  const cell = notebook.cellAt(index);
  let observedFreshExecutionSummary = false;
  let outputAttachmentFailure: string | undefined;
  const executionListener = vscode.workspace.onDidChangeNotebookDocument((event) => {
    if (event.notebook !== notebook) return;
    for (const change of event.cellChanges) {
      if (change.cell !== cell) continue;
      if (change.executionSummary !== undefined) observedFreshExecutionSummary = true;
      if (change.outputs !== undefined && expectedEditor) {
        try {
          assertExactVisibleReleasedNotebookEditor(notebook, expectedEditor, `while cell ${index} published output`);
        } catch (error) {
          outputAttachmentFailure = error instanceof Error ? error.message : String(error);
        }
      }
    }
  });
  try {
    const deadline = Date.now() + 120_000;
    recordAcceptanceProgress(`${checkpoint}:dispatch`);
    if (expectedEditor) {
      assertExactVisibleReleasedNotebookEditor(
        notebook,
        expectedEditor,
        `immediately before dispatching cell ${index}`
      );
    }
    const command = Promise.resolve(
      vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [{ start: index, end: index + 1 }],
        document: notebook.uri
      })
    );
    type CommandState = { kind: "pending" } | { kind: "fulfilled" } | { kind: "rejected"; error: unknown };
    let commandState: CommandState = { kind: "pending" };
    const readCommandState = (): CommandState => commandState;
    void command.then(
      () => {
        commandState = { kind: "fulfilled" };
      },
      (error: unknown) => {
        commandState = { kind: "rejected", error };
      }
    );
    recordAcceptanceProgress(`${checkpoint}:dispatched`);
    let publishedExecutionObservation = false;
    do {
      assertExactOpenNotebookDocument(notebook, `while waiting for cell ${index}`);
      if (expectedEditor) {
        assertExactVisibleReleasedNotebookEditor(notebook, expectedEditor, `while waiting for cell ${index}`);
      }
      assert.equal(outputAttachmentFailure, undefined, outputAttachmentFailure);
      const currentCommandState = readCommandState();
      if (currentCommandState.kind === "rejected") {
        recordAcceptanceProgress(`${checkpoint}:command-rejected`);
        throw currentCommandState.error;
      }
      if (observedFreshExecutionSummary && !publishedExecutionObservation) {
        publishedExecutionObservation = true;
        recordAcceptanceProgress(`${checkpoint}:execution-observed`);
      }
      if (observedFreshExecutionSummary && cell.executionSummary?.success === true) {
        const expectedTexts = typeof expectedText === "string" ? [expectedText] : expectedText;
        if (
          expectedTexts === undefined ||
          expectedTexts.some((candidate) => notebookCellOutputText(cell).includes(candidate))
        ) {
          recordAcceptanceProgress(`${checkpoint}:output-complete`);
          await withBoundedAcceptancePromise(command, 10_000, `released-Jupyter cell ${index} command completion`);
          if (expectedEditor) {
            assertExactVisibleReleasedNotebookEditor(notebook, expectedEditor, `after completing cell ${index}`);
          }
          recordAcceptanceProgress(`${checkpoint}:complete`);
          return;
        }
      }
      if (observedFreshExecutionSummary && cell.executionSummary?.success === false) {
        recordAcceptanceProgress(`${checkpoint}:execution-failed`);
        const rSetupStage =
          failureDiagnostic === "r-setup" ? releasedNotebookRSetupFailureStage(cell.outputs) : undefined;
        throw new Error(releasedNotebookExecutionFailureMessage(index, cell.outputs, rSetupStage));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    recordAcceptanceProgress(`${checkpoint}:timeout`);
    throw new Error(
      `Timed out waiting for a fresh released-Jupyter execution of cell ${index}. ` +
        `Command: ${readCommandState().kind}. Output: ${releasedNotebookOutputClassification(cell.outputs)}.`
    );
  } finally {
    executionListener.dispose();
  }
}

async function executeReleasedNotebookCellUntilMime(
  notebook: vscode.NotebookDocument,
  index: number,
  mime: string,
  checkpoint: string,
  expectedEditor: vscode.NotebookEditor
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let attempt = 0;
  let observedMimes: string[] = [];
  do {
    attempt += 1;
    await executeReleasedNotebookCell(notebook, index, undefined, `${checkpoint}:attempt-${attempt}`, expectedEditor);
    observedMimes = notebook.cellAt(index).outputs.flatMap((output) => output.items.map((item) => item.mime));
    if (observedMimes.includes(mime)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out waiting for proactive notebook formatter MIME ${JSON.stringify(mime)}. ` +
      `Observed: ${JSON.stringify(observedMimes)}.`
  );
}

function notebookCellOutputText(cell: vscode.NotebookCell): string {
  return cell.outputs
    .flatMap((output) => output.items)
    .map((item) => Buffer.from(item.data).toString("utf8"))
    .join("\n");
}

function releasedNotebookSetupResult(cell: vscode.NotebookCell): Record<string, unknown> {
  return releasedNotebookJsonResult(cell, RELEASED_JUPYTER_SETUP_RESULT, "setup");
}

function releasedNotebookJsonResult(
  cell: vscode.NotebookCell,
  marker: string,
  description: string
): Record<string, unknown> {
  const text = notebookCellOutputText(cell);
  const markerIndex = text.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, `The notebook ${description} omitted its result marker: ${JSON.stringify(text)}`);
  const serialized = text
    .slice(markerIndex + marker.length)
    .trim()
    .split(/\r?\n/u)[0];
  assert.ok(serialized, `The notebook ${description} returned an empty result.`);
  const parsed: unknown = JSON.parse(serialized);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function canonicalAcceptancePath(candidate: string): string {
  const resolved = path.normalize(path.resolve(candidate));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function waitForReleasedJupyterVariableAction(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  variableName: string,
  checkpoint: string
): Promise<ReleasedJupyterVariableAction> {
  recordAcceptanceProgress(`${checkpoint}:wait`);
  const viewerAction = await acquirePreparedAcceptanceAction({
    timeoutMs: RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS,
    intervalMs: 100,
    acquire: async () => {
      for (const frame of releasedWorkbenchFrames(workbench)) {
        try {
          const table = frame.getByRole("table", { name: "Variables", exact: true }).first();
          if ((await table.count()) === 0 || !(await table.isVisible())) continue;
          const cell = table.locator(`[role="cell"][title=${JSON.stringify(variableName)}]`).first();
          if ((await cell.count()) === 0 || !(await cell.isVisible())) continue;
          const row = cell.locator("xpath=ancestor::*[@role='row'][1]");
          const actions = row.getByRole("button", {
            name: RELEASED_JUPYTER_VARIABLE_VIEWER_ACTION,
            exact: true
          });
          if ((await actions.count()) !== 1) continue;
          const action = actions.first();
          await action.waitFor({
            state: "visible",
            timeout: RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS
          });
          return { action, documentRoot: frame.locator("html") };
        } catch (error) {
          if (!isReleasedJupyterVariableActionReplacement(error)) {
            // Jupyter may retire a scanned child target while its real kernel
            // refreshes. Ignore the probe only after the shared lifecycle
            // guard proves this is a retired non-workbench target; a live
            // frame, detached workbench main frame, or disconnected browser
            // must still fail immediately.
            ignoreRetiredRendererProbeFailure(workbench, workbench.context().browser(), frame.page(), frame, error);
          }
          // The Variables view can replace a row or retire its child frame
          // while its real kernel refreshes.
        }
      }
      return undefined;
    },
    prepare: async ({ action, documentRoot }) => {
      const [visible, enabled] = await withReleasedJupyterVariableActionPrepareDeadline(
        Promise.all([
          action.isVisible(),
          action.isEnabled({ timeout: RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS })
        ]),
        "visibility and enabled-state probes"
      );
      if (!visible || !enabled) {
        throw new ReleasedJupyterVariableActionReplacementError();
      }
      await withReleasedJupyterVariableActionPrepareDeadline(
        action.focus({ timeout: RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS }),
        "focus"
      );
      const focusState = await withReleasedJupyterVariableActionPrepareDeadline(
        action.evaluate((element) => ({
          connected:
            typeof element === "object" && element !== null && "isConnected" in element && element.isConnected === true,
          focused:
            typeof element === "object" &&
            element !== null &&
            "ownerDocument" in element &&
            element.ownerDocument.activeElement === element
        })),
        "focus assertion"
      );
      if (!focusState.connected) throw new ReleasedJupyterVariableActionReplacementError();
      assert.equal(
        focusState.focused,
        true,
        `The released Jupyter Variables action for ${variableName} must accept keyboard focus.`
      );
      const listenerAttached = await withReleasedJupyterVariableActionPrepareDeadline(
        action.evaluate((element) => {
          if (
            typeof element !== "object" ||
            element === null ||
            !("isConnected" in element) ||
            element.isConnected !== true ||
            !("ownerDocument" in element) ||
            !("addEventListener" in element) ||
            typeof element.addEventListener !== "function"
          ) {
            return false;
          }
          const root = element.ownerDocument.documentElement;
          root.dataset.openWranglerAcceptanceActivation = "pending";
          root.addEventListener(
            "click",
            (event: unknown) => {
              const candidateEvent = event as unknown as ReleasedJupyterActivationEvent;
              const composedPath = candidateEvent.composedPath?.() ?? [];
              const keyboardButtonActivation =
                candidateEvent.isTrusted === true &&
                candidateEvent.detail === 0 &&
                composedPath.some((candidate: unknown) => {
                  if (typeof candidate !== "object" || candidate === null) return false;
                  return (candidate as ReleasedJupyterActivationPathElement).tagName === "BUTTON";
                });
              if (keyboardButtonActivation) {
                root.dataset.openWranglerAcceptanceActivation = "seen";
              }
            },
            { capture: true }
          );
          return true;
        }),
        "click-listener setup"
      );
      if (!listenerAttached) throw new ReleasedJupyterVariableActionReplacementError();
      assert.equal(
        await documentRoot.evaluate(
          (element) =>
            (element as unknown as ReleasedJupyterDocumentRootElement).dataset.openWranglerAcceptanceActivation
        ),
        "pending",
        `The released Jupyter Variables action for ${variableName} must arm its trusted keyboard receipt.`
      );
    },
    dispose: async () => undefined,
    isRetryablePreparationError: isReleasedJupyterVariableActionReplacement,
    wait: (durationMs) => workbench.waitForTimeout(durationMs)
  });

  if (viewerAction) {
    recordAcceptanceProgress(`${checkpoint}:ready`);
    return viewerAction;
  }

  const diagnostics = await releasedWorkbenchDiagnostics(workbench, notebook, variableName);
  throw new Error(
    `Timed out waiting for ${variableName} in the released Jupyter Variables view: ${JSON.stringify(diagnostics)}`
  );
}

class ReleasedJupyterVariableActionReplacementError extends Error {}

function isReleasedJupyterVariableActionReplacement(error: unknown): boolean {
  if (error instanceof ReleasedJupyterVariableActionReplacementError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /(?:element|node).*(?:detached|not attached|not connected)/iu.test(message) ||
    ((error as { name?: unknown } | undefined)?.name === "TimeoutError" &&
      /^(?:elementHandle|locator)\.(?:elementHandle|focus|hover|isEnabled|waitFor): Timeout \d+ms exceeded/u.test(
        message
      ))
  );
}

async function withReleasedJupyterVariableActionPrepareDeadline<T>(
  operation: PromiseLike<T>,
  description: string
): Promise<T> {
  try {
    return await withAcceptanceOperationDeadline(
      operation,
      RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS,
      `the released Jupyter Variables action ${description}`
    );
  } catch (error) {
    if (isReleasedJupyterVariableActionReplacement(error)) throw error;
    if (
      error instanceof Error &&
      error.message ===
        `Timed out waiting for the released Jupyter Variables action ${description} after ${RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS} ms.`
    ) {
      throw new ReleasedJupyterVariableActionReplacementError();
    }
    throw error;
  }
}

function releasedWorkbenchFrames(workbench: Page): Frame[] {
  const browser = workbench.context().browser();
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  return pages.flatMap((page) => page.frames());
}

async function releasedWorkbenchDiagnostics(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  variableName: string
): Promise<unknown> {
  const frames = releasedWorkbenchFrames(workbench);
  const frameLimit = 12;
  return {
    activeNotebook:
      vscode.window.activeNotebookEditor?.notebook === notebook
        ? "exact"
        : vscode.window.activeNotebookEditor
          ? "other"
          : "none",
    frameCount: Math.min(frames.length, 999),
    framesTruncated: frames.length > frameLimit,
    frames: await Promise.all(
      frames.slice(0, frameLimit).map(async (frame) => {
        const table = frame.getByRole("table", { name: "Variables", exact: true }).first();
        const emptyRows = frame.locator("#variable-explorer-empty-rows").first();
        const [tables, tableVisible, variableCells, loading] = await Promise.all([
          frame
            .getByRole("table", { name: "Variables", exact: true })
            .count()
            .catch(() => 0),
          table.isVisible().catch(() => false),
          frame
            .locator(`[role="cell"][title=${JSON.stringify(variableName)}]`)
            .count()
            .catch(() => 0),
          emptyRows.evaluate((element) => (element.textContent ?? "").trim() === "Loading variables").catch(() => false)
        ]);
        return {
          kind:
            frame.page() === workbench && frame === workbench.mainFrame()
              ? "workbench"
              : /^vscode-webview:.*(?:[?&])extensionId=ms-toolsai\.jupyter(?:&|$)/u.test(frame.url())
                ? "jupyter"
                : frame.url().startsWith("vscode-webview:")
                  ? "webview"
                  : "other",
          tables: Math.min(Math.max(tables, 0), 999),
          tableVisible,
          variableCells: Math.min(Math.max(variableCells, 0), 999),
          loading
        };
      })
    )
  };
}

async function waitForReleasedJupyterConsent(
  workbench: Page,
  testing: TestApi
): Promise<{ dialog: Locator; allow: Locator; deny: Locator }> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  let dialog: Locator | undefined;
  do {
    const candidate = workbench
      .mainFrame()
      .locator(".monaco-dialog-box:visible")
      .filter({ hasText: RELEASED_JUPYTER_CONSENT_MESSAGE })
      .last();
    if ((await candidate.count().catch(() => 0)) > 0 && (await candidate.isVisible().catch(() => false))) {
      dialog = candidate;
    }
    if (dialog) break;
    const panelError = await visibleOpenWranglerPanelAlert(workbench);
    if (panelError) {
      throw new Error(`Open Wrangler failed before released Jupyter displayed kernel consent: ${panelError}`);
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  if (!dialog) {
    throw new Error(
      "Timed out waiting for released Jupyter kernel consent during proactive formatter preparation. " +
        `State: ${JSON.stringify({
          tabCount: releasedJupyterSessionTabs().length,
          coordinator: testing.diagnostics(),
          webviewFrames: releasedWorkbenchFrames(workbench).filter(
            (frame) => classifyRendererUrl(frame.url()).isOpenWranglerWebview
          ).length
        })}`
    );
  }
  const text = await dialog.innerText();
  assert.ok(text.includes(RELEASED_JUPYTER_CONSENT_MESSAGE), "The Jupyter consent message must name Open Wrangler.");
  assert.ok(
    text.includes(RELEASED_JUPYTER_CONSENT_DETAIL),
    "The Jupyter consent must explain kernel execution access."
  );
  const allow = dialog.getByRole("button", { name: "Allow", exact: true });
  const deny = dialog.getByRole("button", { name: "Deny", exact: true });
  const learnMore = dialog.getByRole("button", { name: "Learn more", exact: true });
  assert.equal(await allow.count(), 1, "The released Jupyter consent must expose one Allow action.");
  assert.equal(await deny.count(), 1, "The released Jupyter consent must expose one Deny action.");
  assert.equal(await learnMore.count(), 1, "The released Jupyter consent must expose one Learn More action.");
  return { dialog, allow, deny };
}

async function visibleReleasedJupyterConsentCount(workbench: Page): Promise<number> {
  return workbench
    .mainFrame()
    .locator(".monaco-dialog-box:visible")
    .filter({ hasText: RELEASED_JUPYTER_CONSENT_MESSAGE })
    .count()
    .catch(() => 0);
}

async function waitForReleasedJupyterTerminalPanelError(workbench: Page, testing: TestApi): Promise<string> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  do {
    const panelError = await visibleOpenWranglerPanelAlert(workbench);
    if (panelError) return panelError;
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  const diagnostics = await boundedImportPromptDiagnostics(workbench);
  const browser = workbench.context().browser();
  const openWranglerFrames = openWranglerWebviewTargets(
    workbench,
    browser,
    OPEN_WRANGLER_WEBVIEW_DIAGNOSTIC_TARGET_LIMIT
  );
  const frameDiagnostics = await Promise.all(
    openWranglerFrames.map(async (target) => ({
      ...rendererTargetDiagnostic(target, {}),
      apps: await target.frame
        .locator("main.app")
        .count()
        .catch(() => -1),
      text: (
        await target.frame
          .locator("main.app")
          .first()
          .innerText()
          .catch(() => "")
      )
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 2_000),
      alerts: (
        await target.frame
          .locator("main.app")
          .first()
          .getByRole("alert")
          .allInnerTexts()
          .catch(() => [])
      ).slice(0, 8)
    }))
  );
  throw new Error(
    "Timed out waiting for the persisted released-Jupyter denial to reach a terminal panel error. " +
      `State: ${JSON.stringify({
        sessionTabs: releasedJupyterSessionTabs().map((tab) => tab.label),
        coordinator: testing.diagnostics(),
        webviewFrames: frameDiagnostics,
        ui: diagnostics
      })}`
  );
}

async function visibleOpenWranglerPanelAlert(workbench: Page): Promise<string | undefined> {
  const browser = workbench.context().browser();
  assertOpenWranglerWebviewLifecycle(workbench, browser);
  for (const target of openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT)) {
    if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
    try {
      const app = target.frame.locator("main.app").first();
      if ((await app.count()) === 0 || !(await app.isVisible())) continue;
      const alert = app.getByRole("alert").first();
      if ((await alert.count()) === 0 || !(await alert.isVisible())) continue;
      const message = (await alert.innerText()).trim();
      if (message.length > 0) return message;
    } catch (error) {
      ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
    }
  }
  return undefined;
}

async function waitForStableReleasedJupyterSessionCount(
  testing: TestApi,
  expected: number,
  stableForMs: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = testing.diagnostics().sessionCount === expected ? Date.now() : undefined;
  do {
    if (testing.diagnostics().sessionCount === expected) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableForMs) return;
    } else {
      stableSince = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out waiting for released-Jupyter session count ${expected}: ${JSON.stringify(testing.diagnostics())}`
  );
}

async function withBoundedAcceptancePromise<T>(
  promise: Thenable<T>,
  timeoutMs: number,
  description: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForReleasedVariableSession(
  workbench: Page,
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  expected: ReleasedVariableExpectation,
  description: string
): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> {
  try {
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.kind === "notebookVariable" &&
          active.metadata.source.variableName === expected.name &&
          active.metadata.source.uri === notebook.uri.toString()
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      description,
      () => JSON.stringify(testing.diagnostics())
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `Released-Jupyter panel state: ${JSON.stringify({
          alert: await visibleOpenWranglerPanelAlert(workbench),
          sessionTabs: releasedJupyterSessionTabs().map((tab) => tab.label),
          coordinator: testing.diagnostics(),
          ui: await boundedImportPromptDiagnostics(workbench)
        })}`
    );
  }
  assertExactOpenNotebookDocument(notebook, `after opening ${expected.name}`);
  const active = testing.activeSession();
  assert.ok(active, `${description} must publish an active session.`);
  assert.equal(active.metadata.backend, expected.backend);
  if (expected.rDataframeFlavor !== undefined) {
    assert.equal(active.metadata.rDataframeFlavor, expected.rDataframeFlavor);
  }
  assert.equal(active.metadata.source.kind, "notebookVariable");
  assert.equal(active.metadata.source.variableName, expected.name);
  assert.equal(active.metadata.source.uri, notebook.uri.toString());
  assert.equal(active.metadata.capabilities.notebookInsert, expected.notebookInsert ?? true);
  return active;
}

async function openReleasedRendererVariableSession(
  action: NotebookRendererButton,
  workbench: Page,
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  expected: ReleasedVariableExpectation,
  description: string,
  checkpoint: string
): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> {
  recordAcceptanceProgress(`${checkpoint}:button-ready`);
  const receipt = async (): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> => {
    const active = await waitForReleasedVariableSession(workbench, testing, notebook, expected, description);
    recordAcceptanceProgress(`${checkpoint}:receipt`);
    return active;
  };
  return invokeAcceptanceActionOnceWithAuthoritativeReceipt({
    description,
    activate: async () => {
      recordAcceptanceProgress(`${checkpoint}:activate`);
      await activateNotebookRendererButtonOnce(workbench, action);
    },
    receipt,
    authoritativeReceiptAfterActivationFailure: receipt
  });
}

async function openReleasedVariableSession(
  workbench: Page,
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  expected: ReleasedVariableExpectation,
  description: string
): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> {
  assertExactOpenNotebookDocument(notebook, `before opening ${expected.name}`);
  const notebookEditor = await showExactReleasedNotebook(notebook);
  assertExactVisibleReleasedNotebookEditor(notebook, notebookEditor, `immediately before dispatching ${expected.name}`);
  await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
    name: expected.name,
    type: expected.type,
    fileName: notebook.uri
  });
  assertExactOpenNotebookDocument(notebook, `after dispatching ${expected.name}`);
  return waitForReleasedVariableSession(workbench, testing, notebook, expected, description);
}

async function assertReleasedSessionPage(
  testing: TestApi,
  active: NonNullable<ReturnType<TestApi["activeSession"]>>,
  firstValue: string,
  viewRequestId: string
): Promise<Extract<OpenWranglerResponse, { kind: "page" }>> {
  recordAcceptanceProgress(`${viewRequestId}:request`);
  const response = await withBoundedAcceptancePromise(
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId,
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    }),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `released-Jupyter page ${viewRequestId}`
  );
  recordAcceptanceProgress(`${viewRequestId}:response`);
  assert.equal(response.kind, "page");
  if (response.kind !== "page") throw new Error(`Released-Jupyter page ${viewRequestId} did not resolve.`);
  assert.equal(response.page.rows[0]?.values[0]?.display, firstValue);
  return response;
}

async function assertReleasedRNotebookCodeInsertion(
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  active: NonNullable<ReturnType<TestApi["activeSession"]>>,
  code: string,
  variableName: string,
  phase: "jupyter-r" | "jupyter-r-remote",
  outputDirectory: string
): Promise<number> {
  assert.equal(active.metadata.source.kind, "notebookVariable");
  assert.equal(active.metadata.source.variableName, variableName);
  assert.equal(active.metadata.backend, "r");
  assert.equal(active.metadata.mode, "editing");
  assert.equal(active.metadata.capabilities.notebookInsert, true);
  assert.ok(code, "R notebook insertion requires native generated R code.");
  assertReleasedRGeneratedCode(code, "case_id");
  const before = Array.from({ length: notebook.cellCount }, (_, index) => ({
    text: notebook.cellAt(index).document.getText(),
    languageId: notebook.cellAt(index).document.languageId
  }));
  const decoyPath = path.join(outputDirectory, `${phase}.r-insertion-decoy.ipynb`);
  writeFileSync(
    decoyPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ["decoy_value <- 99\n"]
        }
      ],
      metadata: {
        kernelspec: {
          display_name: "R (Open Wrangler)",
          language: "R",
          name: "ir"
        }
      },
      nbformat: 4,
      nbformat_minor: 5
    })
  );
  const decoy = await vscode.workspace.openNotebookDocument(vscode.Uri.file(decoyPath));
  try {
    await vscode.window.showNotebookDocument(decoy, { viewColumn: vscode.ViewColumn.One });
    assertExactOpenNotebookDocument(decoy, "after showing the native R insertion decoy");
    const decoyBefore = Array.from({ length: decoy.cellCount }, (_, index) => ({
      text: decoy.cellAt(index).document.getText(),
      languageId: decoy.cellAt(index).document.languageId
    }));

    testing.setActiveSession(active.sessionId);
    assertExactOpenNotebookDocument(notebook, "before native R insertion");
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      decoy,
      "Native R insertion acceptance must keep a different notebook active."
    );
    recordAcceptanceProgress(`${phase}:editing:insertion-dispatch`);
    const result = await withBoundedAcceptancePromise(
      vscode.commands.executeCommand<boolean>("openWrangler.insertNotebookCode"),
      30_000,
      "native R generated-code insertion"
    );
    assert.equal(result, true, "Native R generated-code insertion must report success.");
    assert.deepEqual(
      Array.from({ length: decoy.cellCount }, (_, index) => ({
        text: decoy.cellAt(index).document.getText(),
        languageId: decoy.cellAt(index).document.languageId
      })),
      decoyBefore,
      "Native R insertion must not target a different active notebook."
    );
    const inserted = Array.from({ length: notebook.cellCount }, (_, index) => index).filter((index) => {
      const cell = notebook.cellAt(index);
      return (
        cell.document.getText() === code &&
        cell.document.languageId === "r" &&
        cell.metadata.openWrangler?.source === variableName
      );
    });
    assert.equal(inserted.length, 1, "Native R insertion must add one uniquely marked R cell.");
    const insertedIndex = inserted[0];
    assert.notEqual(insertedIndex, undefined);
    const insertedCell = notebook.cellAt(insertedIndex);
    const marker = insertedCell.metadata.openWrangler;
    assert.deepEqual(marker, {
      source: variableName,
      backend: "r",
      languageId: "r",
      generated: true,
      insertionId: marker.insertionId
    });
    assert.equal(typeof marker.insertionId, "string");
    assert.deepEqual(
      Array.from({ length: notebook.cellCount }, (_, index) => index)
        .filter((index) => index !== insertedIndex)
        .map((index) => ({
          text: notebook.cellAt(index).document.getText(),
          languageId: notebook.cellAt(index).document.languageId
        })),
      before,
      "Native R insertion must not rewrite any existing cell."
    );
    return insertedIndex;
  } finally {
    const decoyTab = notebookTab(decoy.uri);
    if (decoyTab) await vscode.window.tabGroups.close(decoyTab, true);
    rmSync(decoyPath, { force: true });
  }
}

async function assertReleasedNotebookCodeInsertion(
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  active: NonNullable<ReturnType<TestApi["activeSession"]>>,
  variableName: string,
  inputColumnName: string,
  outputColumnName: string,
  phase: ReleasedJupyterPhase
): Promise<void> {
  assert.equal(active.metadata.source.kind, "notebookVariable");
  assert.equal(active.metadata.mode, "editing");
  assert.equal(active.metadata.steps.length, 0);
  const preview = await testing.request({
    kind: "previewStep",
    ...GRID_COLUMN_WINDOW,
    sessionId: active.sessionId,
    revision: active.metadata.revision,
    step: {
      id: "released-jupyter-insertion-formula",
      kind: "formula",
      params: {
        leftColumn: columnReference(active.metadata, inputColumnName),
        operator: "add",
        value: 10,
        newColumn: outputColumnName
      }
    },
    offset: 0,
    limit: 10
  });
  assert.equal(preview.kind, "stepPreview");
  if (preview.kind !== "stepPreview") {
    throw new Error("Released-Jupyter insertion did not preview its real formula step.");
  }
  const applied = await testing.request({
    kind: "applyDraft",
    ...GRID_COLUMN_WINDOW,
    sessionId: active.sessionId,
    revision: preview.revision,
    offset: 0,
    limit: 10
  });
  assert.equal(applied.kind, "planUpdated");
  if (applied.kind !== "planUpdated") {
    throw new Error("Released-Jupyter insertion did not apply its real formula step.");
  }
  const insertionActive = testing.activeSession();
  assert.equal(insertionActive?.sessionId, active.sessionId);
  assert.equal(insertionActive?.metadata.steps.length, 1);
  assert.equal(insertionActive?.metadata.steps[0]?.kind, "formula");
  assert.equal(
    insertionActive?.metadata.schema.some((column) => column.name === outputColumnName),
    true
  );
  const code = insertionActive?.code;
  assert.ok(code, "Released-Jupyter insertion requires the engine's real generated cleaning code.");
  assert.match(code, /import pandas as pd/u);
  assert.match(code, /def clean_data\(df\):/u);
  assert.equal(code.includes(outputColumnName), true);
  const before = Array.from({ length: notebook.cellCount }, (_, index) => notebook.cellAt(index).document.getText());
  const decoyPath = path.join(path.dirname(notebook.uri.fsPath), "released-jupyter-insertion-decoy.ipynb");
  writeFileSync(
    decoyPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ["decoy_value = 99\n"]
        }
      ],
      metadata: {
        kernelspec: {
          display_name: "Python 3.12 (Open Wrangler)",
          language: "python",
          name: "openwrangler-acceptance"
        }
      },
      nbformat: 4,
      nbformat_minor: 5
    })
  );
  const decoy = await vscode.workspace.openNotebookDocument(vscode.Uri.file(decoyPath));
  let insertedIndex: number | undefined;
  try {
    recordAcceptanceProgress(`${phase}:insertion-decoy`);
    await vscode.window.showNotebookDocument(decoy, { viewColumn: vscode.ViewColumn.One });
    assertExactOpenNotebookDocument(decoy, "after showing the insertion decoy");
    const decoyBefore = Array.from({ length: decoy.cellCount }, (_, index) => decoy.cellAt(index).document.getText());

    testing.setActiveSession(active.sessionId);
    recordAcceptanceProgress(`${phase}:insertion-decoy-active`);
    assertExactOpenNotebookDocument(notebook, "before released-Jupyter generated-code insertion");
    assertExactOpenNotebookDocument(decoy, "before insertion while the decoy remained open");
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      decoy,
      "Released-Jupyter insertion acceptance must keep a different notebook active."
    );
    recordAcceptanceProgress(`${phase}:insertion-dispatch`);
    let insertionResult: boolean | undefined;
    try {
      insertionResult = await withBoundedAcceptancePromise(
        vscode.commands.executeCommand<boolean>("openWrangler.insertNotebookCode"),
        30_000,
        "released-Jupyter generated-code insertion"
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
          `Diagnostics: ${JSON.stringify(
            await releasedNotebookInsertionDiagnostics(testing, notebook, code, variableName)
          )}`
      );
    }
    if (insertionResult !== true) {
      throw new Error(
        `Released-Jupyter generated-code insertion returned ${JSON.stringify(insertionResult)}. ` +
          `Diagnostics: ${JSON.stringify(
            await releasedNotebookInsertionDiagnostics(testing, notebook, code, variableName)
          )}`
      );
    }
    recordAcceptanceProgress(`${phase}:insertion-complete`);
    assertExactOpenNotebookDocument(notebook, "after released-Jupyter generated-code insertion");
    assertExactOpenNotebookDocument(decoy, "after insertion while the decoy remained open");
    assert.deepEqual(
      Array.from({ length: decoy.cellCount }, (_, index) => decoy.cellAt(index).document.getText()),
      decoyBefore,
      "Released-Jupyter insertion must not target a different active notebook."
    );
    const inserted = Array.from({ length: notebook.cellCount }, (_, index) => index).filter((index) => {
      const cell = notebook.cellAt(index);
      return cell.document.getText() === code && cell.metadata.openWrangler?.source === variableName;
    });
    assert.equal(inserted.length, 1, "Released-Jupyter insertion must add one uniquely marked cell.");
    insertedIndex = inserted[0];
    assert.notEqual(insertedIndex, undefined);
    assert.deepEqual(
      Array.from({ length: notebook.cellCount }, (_, index) => index)
        .filter((index) => index !== insertedIndex)
        .map((index) => notebook.cellAt(index).document.getText()),
      before,
      "Released-Jupyter insertion must not rewrite any originating cell."
    );
  } finally {
    const decoyTab = notebookTab(decoy.uri);
    if (decoyTab) await vscode.window.tabGroups.close(decoyTab, true);
  }
  const screenshotOutput = process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS;
  if (phase === "jupyter-allow" && screenshotOutput) {
    assert.notEqual(insertedIndex, undefined);
    await captureReleasedJupyterCodeInsertion(
      await connectToEditorWorkbench(),
      notebook,
      insertedIndex,
      variableName,
      code,
      screenshotOutput
    );
  }
}

async function captureReleasedJupyterCodeInsertion(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  insertedIndex: number,
  variableName: string,
  code: string,
  outputDirectory: string,
  options: {
    languageId: "python" | "r";
    progress: string;
    scene: Parameters<typeof packagedScreenshotFileName>[1];
  } = {
    languageId: "python",
    progress: "jupyter-allow:screenshot:code-insertion",
    scene: "notebook-code-insertion"
  }
): Promise<void> {
  recordAcceptanceProgress(options.progress);
  assert.equal(path.isAbsolute(outputDirectory), true);
  assert.equal(notebook.cellAt(insertedIndex).document.getText(), code);
  assert.equal(notebook.cellAt(insertedIndex).document.languageId, options.languageId);
  assert.equal(notebook.cellAt(insertedIndex).metadata.openWrangler?.source, variableName);
  assert.equal(notebook.cellAt(insertedIndex).metadata.openWrangler?.languageId, options.languageId);
  assert.equal(
    insertedIndex,
    notebook.cellCount - 1,
    "Generated-code insertion media requires the uniquely inserted cell to remain last in the notebook."
  );
  const editor = await showExactReleasedNotebook(notebook);
  const restoreWorkbench = await prepareReleasedJupyterScreenshotWorkbench(workbench, notebook, editor);
  try {
    await workbench.setViewportSize(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT);
    assert.deepEqual(
      await workbench.evaluate(() => {
        const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
        return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
      }),
      PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
      "Generated-code insertion media requires the standard 1440 by 900 notebook viewport."
    );
    const range = new vscode.NotebookRange(insertedIndex, insertedIndex + 1);
    editor.selection = range;
    editor.selections = [range];
    editor.revealRange(range, vscode.NotebookEditorRevealType.AtTop);
    await waitFor(
      () => editor.visibleRanges.some((visible) => visible.start <= insertedIndex && visible.end > insertedIndex),
      WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
      "the generated Open Wrangler notebook cell to become fully visible"
    );
    const commands = new Set(await vscode.commands.getCommands(true));
    assert.equal(
      commands.has("notebook.cell.edit"),
      true,
      "Generated-code insertion media requires VS Code's built-in notebook cell edit command."
    );
    await vscode.commands.executeCommand("notebook.cell.edit");
    assertExactVisibleReleasedNotebookEditor(notebook, editor, "after entering the generated notebook cell editor");
    await workbench.waitForTimeout(600);
    const notebookSurface = workbench.locator(".notebook-editor:visible").first();
    await notebookSurface.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    assert.equal(notebook.cellAt(insertedIndex).document.getText(), code);
    assert.equal(notebook.cellAt(insertedIndex).metadata.openWrangler?.source, variableName);
    assert.equal(
      editor.visibleRanges.some((visible) => visible.start <= insertedIndex && visible.end > insertedIndex),
      true,
      "The public notebook editor must still report the inserted cell as visible immediately before capture."
    );
    await clearReleasedJupyterScreenshotTransientUi(workbench);
    mkdirSync(outputDirectory, { recursive: true });
    await captureNotebookWorkbenchScreenshot(
      workbench,
      path.resolve(
        outputDirectory,
        packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", options.scene, "dark")
      )
    );
  } finally {
    await restoreWorkbench();
  }
}

async function releasedNotebookInsertionDiagnostics(
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  code: string,
  variableName: string
): Promise<unknown> {
  const matchingCells = Array.from({ length: notebook.cellCount }, (_, index) => notebook.cellAt(index)).filter(
    (cell) => cell.document.getText() === code && cell.metadata.openWrangler?.source === variableName
  );
  let workbench: ImportPromptDiagnostics | string = "unavailable";
  try {
    workbench = await boundedImportPromptDiagnostics(await connectToEditorWorkbench());
  } catch {
    // The notebook state remains useful when CDP diagnostics cannot connect.
  }
  return {
    insertionStatus: testing.notebookInsertionStatus(),
    notebookVersion: notebook.version,
    notebookCellCount: notebook.cellCount,
    matchingCells: matchingCells.length,
    activeOrigin: vscode.window.activeNotebookEditor?.notebook === notebook,
    exactOpen: vscode.workspace.notebookDocuments.filter((candidate) => candidate === notebook).length,
    workbench
  };
}

async function invokeReleasedNotebookToolbarVariable(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  variableName: string
): Promise<void> {
  assertExactOpenNotebookDocument(notebook, "before invoking the Open Wrangler notebook toolbar");
  assert.equal(
    vscode.window.activeNotebookEditor?.notebook,
    notebook,
    "The exact released-Jupyter notebook must be active before its Open Wrangler toolbar action."
  );
  const picker = await activateReleasedNotebookVariableAction(workbench, notebook);
  assertActiveNotebookTab(
    notebook,
    "The exact released-Jupyter notebook tab must remain active after its toolbar action opens the variable picker."
  );
  const input = picker.locator(".quick-input-box input:visible").first();
  await input.fill(variableName);
  const deadline = Date.now() + 10_000;
  let row: Locator | undefined;
  do {
    row = await releasedJupyterQuickPickRow(picker, variableName);
    if (row) break;
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  assert.ok(row, `The Open Wrangler notebook-variable picker did not expose ${JSON.stringify(variableName)}.`);
  await row.click();
  assertExactOpenNotebookDocument(notebook, "after submitting the Open Wrangler notebook toolbar variable");
}

interface ReleasedNotebookPreparedAction {
  readonly activate: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly overflowMenu?: ElementHandle<unknown>;
  readonly abandonBeforeDispatch?: () => Promise<void>;
  readonly description: string;
}

async function activateReleasedNotebookVariableAction(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  afterActivation?: () => Promise<void>
): Promise<Locator> {
  assertReleasedNotebookActionLabelOwnership(notebook.notebookType);
  const cursorHost = process.env.OPEN_WRANGLER_TEST_EDITOR === "cursor";
  const globalToolbar = vscode.workspace.getConfiguration("notebook").get<boolean>("globalToolbar");
  if (cursorHost) {
    const pinnedTitleActions = vscode.workspace
      .getConfiguration("cursor.general")
      .inspect<string[]>("pinnedTitleActions");
    assert.ok(pinnedTitleActions, "Cursor must register its pinned-title-action setting.");
    assert.ok(
      pinnedTitleActions.defaultValue?.includes(RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND),
      "The packaged Cursor default must pin the canonical notebook-variable action."
    );
    assert.equal(
      pinnedTitleActions.globalValue,
      undefined,
      "Cursor notebook acceptance must not persist a user-level title-action setting."
    );
    assert.equal(
      pinnedTitleActions.workspaceValue,
      undefined,
      "Cursor notebook acceptance must not persist a workspace title-action setting."
    );
  }
  const prepared =
    cursorHost || (notebook.notebookType !== "interactive" && globalToolbar !== true)
      ? await resolveReleasedNotebookEditorTitleAction(workbench)
      : await resolveReleasedNotebookToolbarAction(workbench);
  let dispatchStarted = false;
  try {
    assertExactOpenNotebookDocument(notebook, "immediately before activating its Open Wrangler notebook action");
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      notebook,
      "The exact released-Jupyter notebook must remain active after resolving its Open Wrangler action."
    );
    assertActiveNotebookTab(
      notebook,
      "The exact released-Jupyter notebook tab must remain active before activating its Open Wrangler action."
    );
    dispatchStarted = true;
    return await invokeAcceptanceActionOnceWithAuthoritativeReceipt({
      description: prepared.description,
      activate: async () => {
        await prepared.activate();
        await afterActivation?.();
      },
      receipt: () => waitForReleasedNotebookVariablePicker(workbench),
      authoritativeReceiptAfterActivationFailure: () => waitForReleasedNotebookVariablePicker(workbench),
      naturalDismissal: prepared.overflowMenu
        ? () => prepared.overflowMenu!.waitForElementState("hidden", { timeout: 2_000 })
        : undefined
    });
  } finally {
    if (!dispatchStarted && prepared.abandonBeforeDispatch) {
      await prepared.abandonBeforeDispatch();
    } else {
      await Promise.allSettled([prepared.dispose(), prepared.overflowMenu?.dispose()]);
    }
  }
}

function assertReleasedNotebookActionLabelOwnership(notebookType: string): void {
  const menuId = notebookType === "interactive" ? "interactive/toolbar" : "notebook/toolbar";
  const owners: Array<{ extensionId: string; command: string }> = [];
  for (const extension of vscode.extensions.all) {
    const contributions = (
      extension.packageJSON as {
        contributes?: {
          commands?: unknown;
          menus?: Record<string, unknown>;
        };
      }
    ).contributes;
    const commands = contributions?.commands;
    if (!Array.isArray(commands)) continue;
    const toolbarItems = contributions?.menus?.[menuId];
    if (!Array.isArray(toolbarItems)) continue;
    const toolbarCommands = new Set(
      toolbarItems.flatMap((candidate) => {
        if (typeof candidate !== "object" || candidate === null) return [];
        const command = (candidate as { command?: unknown }).command;
        return typeof command === "string" ? [command] : [];
      })
    );
    for (const candidate of commands) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const command = candidate as { command?: unknown; title?: unknown; shortTitle?: unknown };
      if (
        typeof command.command === "string" &&
        toolbarCommands.has(command.command) &&
        ((typeof command.title === "string" &&
          RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN.test(command.title)) ||
          (typeof command.shortTitle === "string" &&
            RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN.test(command.shortTitle)))
      ) {
        owners.push({ extensionId: extension.id.toLowerCase(), command: command.command });
      }
    }
  }
  owners.sort((left, right) =>
    left.extensionId === right.extensionId
      ? left.command.localeCompare(right.command)
      : left.extensionId.localeCompare(right.extensionId)
  );
  assert.deepEqual(
    owners,
    [{ extensionId: "matt17br.openwrangler", command: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND }],
    "The rendered notebook-action label must belong uniquely to the installed Open Wrangler command."
  );
}

function assertActiveNotebookTab(notebook: vscode.NotebookDocument, message: string): void {
  const activeEditor = vscode.window.activeNotebookEditor;
  const activeTabGroup = vscode.window.tabGroups.activeTabGroup;
  const activeTab = activeTabGroup.activeTab;
  assert.equal(activeEditor?.notebook, notebook, message);
  if (notebook.notebookType === "interactive") {
    assertExactOpenNotebookDocument(notebook, message);
    const matchingEditors = vscode.window.visibleNotebookEditors.filter((candidate) => candidate.notebook === notebook);
    assert.equal(matchingEditors.length, 1, message);
    assert.equal(activeEditor, matchingEditors[0], message);
    assert.equal(activeTabGroup.isActive, true, message);
    assert.equal(activeTab?.isActive, true, message);
    if (activeEditor?.viewColumn !== undefined) {
      assert.equal(activeTabGroup.viewColumn, activeEditor.viewColumn, message);
    }
    return;
  }
  const input = activeTab?.input;
  assert.ok(input instanceof vscode.TabInputNotebook, message);
  assert.equal(input.uri.toString(), notebook.uri.toString(), message);
  assert.equal(input.notebookType, notebook.notebookType, message);
}

async function resolveReleasedNotebookEditorTitleAction(workbench: Page): Promise<ReleasedNotebookPreparedAction> {
  const deadline = Date.now() + 20_000;
  do {
    for (const frame of [workbench.mainFrame()]) {
      try {
        const titleActions = frame.locator(".part.editor .editor-group-container.active .editor-actions:visible");
        const commandItems = notebookToolbarCommandItems(titleActions, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
        const commandCount = await commandItems.count();
        assert.ok(commandCount < 2, "The active editor title exposed duplicate Open Wrangler notebook actions.");
        const byLabel = titleActions.getByRole("button", {
          name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
        });
        const labelCount = await byLabel.count();
        assert.ok(labelCount < 2, "The active editor title exposed duplicate labeled Open Wrangler actions.");

        const action =
          commandCount === 1
            ? releasedCommandOwnedAction(titleActions, commandItems.first(), "button")
            : labelCount === 1
              ? byLabel.first()
              : undefined;
        const actionCount = action ? await action.count() : 0;
        assert.ok(actionCount < 2, "The active editor title exposed duplicate command-owned actions.");
        if (actionCount === 1 && action && (await action.isVisible()) && (await action.isEnabled())) {
          await assertReleasedNotebookActionLabel(action, "active notebook editor title");
          const overflow = await probeReleasedNotebookToolbarOverflow(workbench);
          const surfaceMatches = await withReleasedNotebookOverflow(overflow, () =>
            releasedNotebookLaunchSurfaceMatches(workbench, "editor-title", overflow.inventory.visible)
          );
          if (!surfaceMatches) continue;
          const refreshedTitleActions = frame.locator(
            ".part.editor .editor-group-container.active .editor-actions:visible"
          );
          const refreshedItems = notebookToolbarCommandItems(
            refreshedTitleActions,
            RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND
          );
          const refreshedCommandCount = await refreshedItems.count();
          const refreshedByLabel = refreshedTitleActions.getByRole("button", {
            name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
          });
          const refreshedLabelCount = await refreshedByLabel.count();
          if (refreshedCommandCount > 1 || refreshedLabelCount > 1) {
            throw new ReleasedNotebookSurfaceTerminalError(
              [],
              "The active editor title exposed duplicate refreshed Open Wrangler actions."
            );
          }
          const refreshedAction =
            refreshedCommandCount === 1
              ? releasedCommandOwnedAction(refreshedTitleActions, refreshedItems.first(), "button")
              : refreshedLabelCount === 1
                ? refreshedByLabel.first()
                : undefined;
          if (
            !refreshedAction ||
            (await refreshedAction.count()) !== 1 ||
            !(await refreshedAction.isVisible()) ||
            !(await refreshedAction.isEnabled())
          ) {
            continue;
          }
          await assertReleasedNotebookActionLabel(refreshedAction, "refreshed active notebook editor title");
          return {
            activate: () => activateReplaceableAcceptanceLocator(refreshedAction, WORKBENCH_PLAYWRIGHT_TIMEOUT_MS),
            dispose: async () => undefined,
            description: "the real Open Wrangler action in the active notebook editor title"
          };
        }
      } catch (error) {
        if (isReleasedNotebookSurfaceTerminalError(error)) throw error;
        // The active editor title can rerender after the selected kernel changes.
      }
    }
    await workbench.waitForTimeout(100);
  } while (Date.now() < deadline);

  const diagnostics = await releasedNotebookToolbarDiagnostics(workbench, "none", {
    total: 0,
    visible: 0,
    enabled: 0
  });
  throw new Error(
    "Timed out resolving the real Open Wrangler action in the active notebook editor title. " +
      `Structure: ${JSON.stringify(diagnostics)}`
  );
}

async function resolveReleasedNotebookToolbarAction(workbench: Page): Promise<ReleasedNotebookPreparedAction> {
  const deadline = Date.now() + 20_000;
  let lastStructuralFailure: "none" | "transient-toolbar-rerender" = "none";
  let observedOverflowAction = { total: 0, visible: 0, enabled: 0 };
  do {
    for (const frame of [workbench.mainFrame()]) {
      try {
        const toolbar = frame.locator(".notebook-editor:visible .notebook-toolbar-container:visible");
        const directItems = notebookToolbarCommandItems(toolbar, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
        const directCount = await directItems.count();
        assert.ok(directCount < 2, "The notebook toolbar exposed duplicate Open Wrangler variable actions.");
        const directByLabel = toolbar.getByRole("button", {
          name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
        });
        const directLabelCount = await directByLabel.count();
        assert.ok(directLabelCount < 2, "The notebook toolbar exposed duplicate labeled Open Wrangler actions.");
        let directAction: Locator | undefined;
        if (directCount === 1) {
          const direct = releasedCommandOwnedAction(toolbar, directItems.first(), "button");
          const directOwnedCount = await direct.count();
          assert.ok(directOwnedCount < 2, "The notebook toolbar exposed duplicate command-owned actions.");
          if (directOwnedCount === 1) directAction = direct;
        } else if (directLabelCount === 1) {
          directAction = directByLabel.first();
        }
        if (directAction && (await directAction.isVisible()) && (await directAction.isEnabled())) {
          await assertReleasedNotebookActionLabel(directAction, "released Jupyter notebook toolbar");
          const overflow = await probeReleasedNotebookToolbarOverflow(workbench);
          observedOverflowAction = {
            total: Math.max(observedOverflowAction.total, overflow.inventory.total),
            visible: Math.max(observedOverflowAction.visible, overflow.inventory.visible),
            enabled: Math.max(observedOverflowAction.enabled, overflow.inventory.enabled)
          };
          const surfaceMatches = await withReleasedNotebookOverflow(overflow, () =>
            releasedNotebookLaunchSurfaceMatches(workbench, "notebook-toolbar", overflow.inventory.visible)
          );
          if (!surfaceMatches) continue;
          const refreshedToolbar = frame.locator(".notebook-editor:visible .notebook-toolbar-container:visible");
          const refreshedItems = notebookToolbarCommandItems(
            refreshedToolbar,
            RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND
          );
          const refreshedCommandCount = await refreshedItems.count();
          const refreshedByLabel = refreshedToolbar.getByRole("button", {
            name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
          });
          const refreshedLabelCount = await refreshedByLabel.count();
          if (refreshedCommandCount > 1 || refreshedLabelCount > 1) {
            throw new ReleasedNotebookSurfaceTerminalError(
              [],
              "The notebook toolbar exposed duplicate refreshed Open Wrangler actions."
            );
          }
          const refreshedAction =
            refreshedCommandCount === 1
              ? releasedCommandOwnedAction(refreshedToolbar, refreshedItems.first(), "button")
              : refreshedLabelCount === 1
                ? refreshedByLabel.first()
                : undefined;
          if (
            !refreshedAction ||
            (await refreshedAction.count()) !== 1 ||
            !(await refreshedAction.isVisible()) ||
            !(await refreshedAction.isEnabled())
          ) {
            continue;
          }
          await assertReleasedNotebookActionLabel(refreshedAction, "refreshed released Jupyter notebook toolbar");
          return {
            activate: () => activateReplaceableAcceptanceLocator(refreshedAction, WORKBENCH_PLAYWRIGHT_TIMEOUT_MS),
            dispose: async () => undefined,
            description: "the real Open Wrangler action in the released Jupyter notebook toolbar"
          };
        }

        const overflow = await probeReleasedNotebookToolbarOverflow(workbench);
        observedOverflowAction = {
          total: Math.max(observedOverflowAction.total, overflow.inventory.total),
          visible: Math.max(observedOverflowAction.visible, overflow.inventory.visible),
          enabled: Math.max(observedOverflowAction.enabled, overflow.inventory.enabled)
        };
        if (
          overflow.action &&
          overflow.menu &&
          overflow.actionState.visible === 1 &&
          overflow.actionState.enabled === 1
        ) {
          let surfaceMatches: boolean;
          try {
            surfaceMatches = await releasedNotebookLaunchSurfaceMatches(
              workbench,
              "notebook-toolbar",
              overflow.inventory.visible
            );
          } catch (error) {
            try {
              await releaseReleasedNotebookOverflowAfterInspection(overflow);
            } catch (cleanupError) {
              throw new ReleasedNotebookSurfaceTerminalError(
                [error, cleanupError],
                "Notebook launch-surface inspection and exact overflow cleanup both failed."
              );
            }
            throw error;
          }
          if (surfaceMatches) {
            return {
              activate: () =>
                overflow.action!.click({
                  timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
                }),
              dispose: () => overflow.action!.dispose(),
              overflowMenu: overflow.menu,
              abandonBeforeDispatch: () => releaseReleasedNotebookOverflowAfterInspection(overflow),
              description: "the real Open Wrangler action in the released Jupyter notebook-toolbar overflow"
            };
          }
        }
        await releaseReleasedNotebookOverflowAfterInspection(overflow);
      } catch (error) {
        if (isReleasedNotebookSurfaceTerminalError(error)) throw error;
        lastStructuralFailure = "transient-toolbar-rerender";
        // The notebook toolbar can rerender after the selected kernel changes.
      }
    }
    await workbench.waitForTimeout(100);
  } while (Date.now() < deadline);
  const diagnostics = await releasedNotebookToolbarDiagnostics(
    workbench,
    lastStructuralFailure,
    observedOverflowAction
  );
  throw new Error(
    "Timed out clicking the real Open Wrangler action in the released Jupyter notebook toolbar. " +
      `Structure: ${JSON.stringify(diagnostics)}`
  );
}

function notebookToolbarCommandItems(container: Locator, command: string): Locator {
  return container.locator(`.action-item[data-command-id="${command}"]`);
}

function notebookToolbarCommandAction(item: Locator, command: string): Locator {
  return item.locator(`:scope > .action-label[data-command-id="${command}"]`);
}

function releasedCommandOwnedAction(
  container: Locator,
  commandItem: Locator,
  role: "button" | "menuitem",
  includeHidden = false
): Locator {
  const actions = container.getByRole(role, { includeHidden });
  return commandItem.and(actions).or(commandItem.getByRole(role));
}

async function assertReleasedNotebookActionLabel(action: Locator, surface: string): Promise<void> {
  const evidence = await releasedNotebookActionLabelEvidence(action);
  const accessibleName = evidence.ariaLabel || evidence.title || evidence.text;
  assert.match(
    accessibleName,
    RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN,
    `The ${surface} command must expose the exact accessible name ` +
      `${JSON.stringify(RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN.source)}. ` +
      `Observed: ${JSON.stringify(evidence)}`
  );
}

async function releasedNotebookActionLabelEvidence(
  action: Locator
): Promise<{ ariaLabel: string; title: string; text: string }> {
  const bounded = (value: string | null): string => (value ?? "").trim().slice(0, 160);
  return {
    ariaLabel: bounded(await action.getAttribute("aria-label").catch(() => null)),
    title: bounded(await action.getAttribute("title").catch(() => null)),
    text: bounded(await action.textContent().catch(() => null))
  };
}

async function releasedNotebookLaunchSurfaceMatches(
  workbench: Page,
  expected: "notebook-toolbar" | "editor-title",
  notebookToolbarOverflow = 0
): Promise<boolean> {
  let notebookToolbar = 0;
  let editorTitle = 0;
  for (const frame of [workbench.mainFrame()]) {
    const toolbar = frame.locator(".notebook-editor:visible .notebook-toolbar-container:visible");
    const title = frame.locator(".part.editor .editor-group-container.active .editor-actions:visible");
    notebookToolbar += await releasedVisibleOwnedActionCount(toolbar, "button");
    editorTitle += await releasedVisibleOwnedActionCount(title, "button");
  }
  notebookToolbar += notebookToolbarOverflow;
  assert.ok(
    notebookToolbar <= 1 && editorTitle <= 1 && notebookToolbar + editorTitle <= 1,
    "Released notebook launch exposed duplicate Open Wrangler actions across native surfaces."
  );
  return expected === "notebook-toolbar"
    ? notebookToolbar === 1 && editorTitle === 0
    : notebookToolbar === 0 && editorTitle === 1;
}

interface ReleasedNotebookOverflowProbe {
  readonly inventory: ReleasedLocatorState;
  readonly actionState: ReleasedLocatorState;
  readonly action?: ElementHandle<unknown>;
  readonly menu?: ElementHandle<unknown>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

class ReleasedNotebookSurfaceTerminalError extends AggregateError {}

function isReleasedNotebookSurfaceTerminalError(error: unknown): boolean {
  return (
    error instanceof ReleasedNotebookSurfaceTerminalError ||
    (error as { code?: unknown } | undefined)?.code === "ERR_ASSERTION"
  );
}

async function withReleasedNotebookOverflow<T>(
  overflow: ReleasedNotebookOverflowProbe,
  operation: () => Promise<T>
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await releaseReleasedNotebookOverflowAfterInspection(overflow);
    } catch (cleanupError) {
      throw new ReleasedNotebookSurfaceTerminalError(
        [error, cleanupError],
        "Notebook launch-surface inspection and exact overflow cleanup both failed."
      );
    }
    throw error;
  }
  try {
    await releaseReleasedNotebookOverflowAfterInspection(overflow);
  } catch (cleanupError) {
    throw new ReleasedNotebookSurfaceTerminalError(
      [cleanupError],
      "The exact notebook overflow menu could not be closed after launch-surface inspection."
    );
  }
  return result;
}

async function releaseReleasedNotebookOverflowAfterInspection(overflow: ReleasedNotebookOverflowProbe): Promise<void> {
  try {
    await overflow.close();
  } finally {
    await overflow.dispose();
  }
}

async function probeReleasedNotebookToolbarOverflow(workbench: Page): Promise<ReleasedNotebookOverflowProbe> {
  for (const frame of [workbench.mainFrame()]) {
    const toolbar = frame.locator(".notebook-editor:visible .notebook-toolbar-container:visible");
    const moreItems = notebookToolbarCommandItems(toolbar, NOTEBOOK_TOOLBAR_MORE_COMMAND);
    const moreCount = await moreItems.count();
    assert.ok(moreCount < 2, "The notebook toolbar exposed duplicate More Actions buttons.");
    const moreByLabel = toolbar.getByRole("button", { name: /^More Actions(?:\.\.\.)?$/u });
    const moreLabelCount = moreCount === 0 ? await moreByLabel.count() : 0;
    assert.ok(moreLabelCount < 2, "The notebook toolbar exposed duplicate labeled More Actions buttons.");
    if (moreCount !== 1 && moreLabelCount !== 1) continue;

    const more =
      moreCount === 1
        ? notebookToolbarCommandAction(moreItems.first(), NOTEBOOK_TOOLBAR_MORE_COMMAND)
        : moreByLabel.first();
    if (!(await more.isVisible())) continue;
    const visibleMenus = frame.locator(".context-view.monaco-menu-container:visible");
    assert.equal(
      await visibleMenus.count(),
      0,
      "Notebook overflow discovery requires no pre-existing visible workbench menu."
    );
    await more.click({ timeout: 2_000 });
    const menuContainer = visibleMenus.first();
    let openedMenu: ElementHandle<unknown> | undefined;
    let pinnedAction: ElementHandle<unknown> | undefined;
    let closed = false;
    let disposed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      if (openedMenu && !(await openedMenu.isVisible())) {
        closed = true;
        return;
      }
      if (!openedMenu && (await visibleMenus.count()) === 0) {
        closed = true;
        return;
      }
      await frame.locator("body").press("Escape");
      if (openedMenu) {
        await openedMenu.waitForElementState("hidden", { timeout: 2_000 });
      } else {
        await visibleMenus.waitFor({ state: "hidden", timeout: 2_000 });
      }
      closed = true;
    };
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([pinnedAction?.dispose(), openedMenu?.dispose()]);
    };
    try {
      // VS Code delays overflow-action mouseup registration for 100 ms so the
      // pointer that opened a menu cannot also invoke an action.
      await workbench.waitForTimeout(150);
      await menuContainer.waitFor({ state: "visible", timeout: 2_000 });
      assert.equal(await visibleMenus.count(), 1, "The More Actions button must open exactly one workbench menu.");
      openedMenu = (await menuContainer.elementHandle()) ?? undefined;
      assert.ok(openedMenu, "The exact opened notebook overflow menu must remain addressable.");

      const menuItems = notebookToolbarCommandItems(menuContainer, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
      const commandState = await releasedLocatorState(menuItems);
      const menuByLabel = menuContainer.getByRole("menuitem", {
        name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
      });
      const labelState = await releasedLocatorState(menuByLabel);
      const commandOwned =
        commandState.total === 1 ? releasedCommandOwnedAction(menuContainer, menuItems.first(), "menuitem") : undefined;
      const commandOwnedState = commandOwned
        ? await releasedLocatorState(commandOwned)
        : { total: 0, visible: 0, enabled: 0 };
      assert.ok(commandState.total < 2, "The notebook overflow exposed duplicate Open Wrangler variable actions.");
      assert.ok(labelState.total < 2, "The notebook overflow exposed duplicate labeled Open Wrangler actions.");
      assert.ok(commandOwnedState.total < 2, "The notebook overflow exposed duplicate command-owned actions.");
      const inventory = commandState.total === 0 ? labelState : commandState;
      const actionState = commandState.total === 0 ? labelState : commandOwnedState;
      const ownedAction =
        commandState.total === 0 ? (labelState.total === 1 ? menuByLabel.first() : undefined) : commandOwned;
      if (actionState.total === 1 && actionState.visible === 1 && actionState.enabled === 1) {
        assert.ok(ownedAction, "The manifest-owned notebook overflow action must remain addressable.");
        await assertReleasedNotebookActionLabel(ownedAction, "released Jupyter notebook-toolbar overflow");
        pinnedAction = (await ownedAction?.elementHandle()) ?? undefined;
        assert.ok(pinnedAction, "The manifest-owned notebook overflow action must remain addressable.");
        assert.equal(
          await pinnedAction.evaluate(
            (action, menu) =>
              typeof menu === "object" &&
              menu !== null &&
              "contains" in menu &&
              typeof (menu as { contains?: unknown }).contains === "function" &&
              (menu as { contains(candidate: unknown): boolean }).contains(action),
            openedMenu
          ),
          true,
          "The pinned Open Wrangler action must belong to the exact opened notebook overflow menu."
        );
      }
      return {
        inventory,
        actionState,
        action: pinnedAction,
        menu: openedMenu,
        close,
        dispose
      };
    } catch (error) {
      try {
        await close();
      } catch (cleanupError) {
        await dispose();
        throw new ReleasedNotebookSurfaceTerminalError(
          [error, cleanupError],
          "Notebook overflow inspection and exact-menu cleanup both failed."
        );
      }
      await dispose();
      throw error;
    }
  }
  return {
    inventory: { total: 0, visible: 0, enabled: 0 },
    actionState: { total: 0, visible: 0, enabled: 0 },
    close: async () => undefined,
    dispose: async () => undefined
  };
}

async function releasedVisibleOwnedActionCount(container: Locator, role: "button" | "menuitem"): Promise<number> {
  const commandItems = notebookToolbarCommandItems(container, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
  const commandState = await releasedLocatorState(commandItems);
  if (commandState.total > 0) return commandState.visible;
  return (
    await releasedLocatorState(
      container.getByRole(role, {
        name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
      })
    )
  ).visible;
}

interface ReleasedLocatorState {
  total: number;
  visible: number;
  enabled: number;
}

async function releasedLocatorState(locator: Locator): Promise<ReleasedLocatorState> {
  const total = await locator.count().catch(() => -1);
  if (total <= 0) return { total, visible: 0, enabled: 0 };
  let visible = 0;
  let enabled = 0;
  for (let index = 0; index < Math.min(total, 8); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      visible += 1;
      if (await candidate.isEnabled().catch(() => false)) enabled += 1;
    }
  }
  return { total, visible, enabled };
}

async function releasedNotebookToolbarDiagnostics(
  workbench: Page,
  lastStructuralFailure: "none" | "transient-toolbar-rerender",
  observedOverflowAction: ReleasedLocatorState
): Promise<unknown> {
  const registeredCommands = await vscode.commands.getCommands(true);
  const jupyter = vscode.extensions.getExtension("ms-toolsai.jupyter");
  const jupyterExportCommand =
    vscode.window.activeNotebookEditor?.notebook.notebookType === "interactive"
      ? RELEASED_JUPYTER_INTERACTIVE_EXPORT_COMMAND
      : RELEASED_JUPYTER_EXPORT_COMMAND;
  const frames = await Promise.all(
    [workbench.mainFrame()].slice(0, NOTEBOOK_RENDERER_TARGET_LIMIT).map(async (frame) => {
      const notebookEditors = frame.locator(".notebook-editor");
      const toolbars = frame.locator(".notebook-editor .notebook-toolbar-container");
      const directCommand = notebookToolbarCommandItems(toolbars, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
      const directCommandState = await releasedLocatorState(directCommand);
      const directActionLocator =
        directCommandState.total === 1
          ? releasedCommandOwnedAction(toolbars, directCommand.first(), "button", true)
          : toolbars.getByRole("button", {
              name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN,
              includeHidden: true
            });
      const directAction = await releasedLocatorState(directActionLocator);
      const directActionLabel =
        directAction.total === 1 ? await releasedNotebookActionLabelEvidence(directActionLocator) : undefined;
      const editorTitles = frame.locator(".part.editor .editor-group-container.active .editor-actions");
      const editorTitleCommand = notebookToolbarCommandItems(editorTitles, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
      const editorTitleCommandState = await releasedLocatorState(editorTitleCommand);
      const editorTitleActionLocator =
        editorTitleCommandState.total === 1
          ? releasedCommandOwnedAction(editorTitles, editorTitleCommand.first(), "button", true)
          : editorTitles.getByRole("button", {
              name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN,
              includeHidden: true
            });
      const editorTitleAction = await releasedLocatorState(editorTitleActionLocator);
      const editorTitleActionLabel =
        editorTitleAction.total === 1 ? await releasedNotebookActionLabelEvidence(editorTitleActionLocator) : undefined;
      const jupyterExport = notebookToolbarCommandItems(toolbars, jupyterExportCommand);
      return {
        notebookEditors: await releasedLocatorState(notebookEditors),
        toolbars: await releasedLocatorState(toolbars),
        toolbarButtons: await releasedLocatorState(toolbars.getByRole("button", { includeHidden: true })),
        directAction,
        directActionLabel,
        editorTitleAction,
        editorTitleActionLabel,
        jupyterExport: await releasedLocatorState(jupyterExport),
        tableIcons: await toolbars
          .locator(".codicon-table")
          .count()
          .catch(() => -1)
      };
    })
  );
  const totals = frames.reduce(
    (result, frame) => ({
      notebookEditors: result.notebookEditors + Math.max(frame.notebookEditors.total, 0),
      visibleNotebookEditors: result.visibleNotebookEditors + frame.notebookEditors.visible,
      toolbars: result.toolbars + Math.max(frame.toolbars.total, 0),
      visibleToolbars: result.visibleToolbars + frame.toolbars.visible,
      directActions: result.directActions + Math.max(frame.directAction.total, 0),
      visibleDirectActions: result.visibleDirectActions + frame.directAction.visible,
      enabledDirectActions: result.enabledDirectActions + frame.directAction.enabled,
      editorTitleActions: result.editorTitleActions + Math.max(frame.editorTitleAction.total, 0),
      visibleEditorTitleActions: result.visibleEditorTitleActions + frame.editorTitleAction.visible,
      enabledEditorTitleActions: result.enabledEditorTitleActions + frame.editorTitleAction.enabled,
      labelMismatches:
        result.labelMismatches +
        [frame.directActionLabel, frame.editorTitleActionLabel].filter(
          (evidence) =>
            evidence !== undefined &&
            !RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN.test(
              evidence.ariaLabel || evidence.title || evidence.text
            )
        ).length,
      toolbarButtons: result.toolbarButtons + Math.max(frame.toolbarButtons.total, 0),
      jupyterExports: result.jupyterExports + Math.max(frame.jupyterExport.total, 0),
      tableIcons: result.tableIcons + Math.max(frame.tableIcons, 0)
    }),
    {
      notebookEditors: 0,
      visibleNotebookEditors: 0,
      toolbars: 0,
      visibleToolbars: 0,
      directActions: 0,
      visibleDirectActions: 0,
      enabledDirectActions: 0,
      editorTitleActions: 0,
      visibleEditorTitleActions: 0,
      enabledEditorTitleActions: 0,
      labelMismatches: 0,
      toolbarButtons: 0,
      jupyterExports: 0,
      tableIcons: 0
    }
  );
  const nativeActions = totals.directActions + totals.editorTitleActions;
  const visibleNativeActions = totals.visibleDirectActions + totals.visibleEditorTitleActions;
  const enabledNativeActions = totals.enabledDirectActions + totals.enabledEditorTitleActions;
  const classification =
    totals.visibleNotebookEditors === 0
      ? "notebook-missing"
      : nativeActions + observedOverflowAction.total > 1
        ? "duplicate"
        : nativeActions > 0 && visibleNativeActions === 0
          ? "action-hidden"
          : visibleNativeActions > 0 && enabledNativeActions === 0
            ? "action-disabled"
            : totals.labelMismatches > 0
              ? "label-mismatch"
              : totals.toolbars === 0
                ? "toolbar-missing"
                : totals.visibleToolbars === 0
                  ? "toolbar-hidden"
                  : totals.jupyterExports === 0
                    ? "scoped-context-unavailable"
                    : totals.tableIcons > 0
                      ? "icon-only-action-unresolved"
                      : lastStructuralFailure !== "none"
                        ? "race"
                        : registeredCommands.includes("openWrangler.openNotebookVariable")
                          ? "contribution-suppressed"
                          : "ambiguous";
  return {
    classification,
    lastStructuralFailure,
    framesInspected: frames.length,
    globalToolbar: vscode.workspace.getConfiguration("notebook").get<boolean>("globalToolbar"),
    workspaceTrusted: vscode.workspace.isTrusted,
    activeNotebookType: vscode.window.activeNotebookEditor?.notebook.notebookType,
    jupyterInstalled: jupyter !== undefined,
    jupyterActive: jupyter?.isActive ?? false,
    commandRegistered: registeredCommands.includes("openWrangler.openNotebookVariable"),
    observedOverflowAction,
    totals
  };
}

async function waitForReleasedNotebookVariablePicker(workbench: Page): Promise<Locator> {
  const deadline = Date.now() + 10_000;
  do {
    const matches: Locator[] = [];
    for (const frame of [workbench.mainFrame()]) {
      const widgets = frame.locator(".quick-input-widget:visible");
      const count = Math.min(await widgets.count().catch(() => 0), 8);
      for (let index = 0; index < count; index += 1) {
        const widget = widgets.nth(index);
        const title = (
          await widget
            .locator(".quick-input-title")
            .first()
            .textContent()
            .catch(() => "")
        )?.trim();
        if (title !== RELEASED_JUPYTER_NOTEBOOK_VARIABLE_PICKER_TITLE) continue;
        const input = widget.locator(".quick-input-box input").first();
        if ((await input.count()) > 0 && (await input.isVisible())) matches.push(widget);
      }
    }
    if (matches.length === 1) return matches[0]!;
    assert.ok(
      matches.length < 2,
      "The notebook-toolbar action exposed multiple visible Open Wrangler variable pickers."
    );
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  const diagnostics = await boundedImportPromptDiagnostics(workbench);
  throw new Error(
    "Timed out waiting for the Open Wrangler notebook-toolbar variable picker. " +
      `Quick inputs: ${JSON.stringify(diagnostics.quickInputs)}. ` +
      `Notifications: ${JSON.stringify(diagnostics.notifications)}. ` +
      `Dialogs: ${JSON.stringify(diagnostics.dialogs)}. ` +
      `Active tabs: ${JSON.stringify(diagnostics.activeTabs)}.`
  );
}

async function exerciseReleasedJupyterRestartReplay(
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  sessionId: string,
  applied: Extract<OpenWranglerResponse, { kind: "planUpdated" }>,
  pandas: { sessionId: string; revision: number; filterModel: FilterModel },
  duckdb: ReleasedDuckDbRecoverySession,
  priorPid: number,
  setupMarker: string,
  phase: ReleasedJupyterPhase,
  target: ReleasedJupyterKernelTarget,
  hostExtensionPath: string
): Promise<void> {
  await restartReleasedJupyterKernelAndWait(notebook);

  recordAcceptanceProgress(`${phase}:restart-probe`);
  await showExactReleasedNotebook(notebook);
  await executeReleasedNotebookCell(notebook, 3, RELEASED_JUPYTER_RESTART_RESULT, `${phase}:restart-probe-cell`);
  const replacement = releasedNotebookJsonResult(notebook.cellAt(3), RELEASED_JUPYTER_RESTART_RESULT, "restart probe");
  assert.notEqual(Number(replacement.pid), priorPid, "A released-Jupyter restart must replace the kernel process.");
  assert.equal(replacement.setup, null, "The replacement kernel must not retain the prior setup marker.");
  assert.equal(
    replacement.runtime,
    replacement.bootstrap,
    "Runtime availability in the replacement process must come from its own Open Wrangler bootstrap."
  );
  if (target.remote) {
    assert.equal(replacement.remoteRunId, target.remote.runId);
    assert.equal(replacement.hostname, target.remote.hostname);
    assert.equal(replacement.hostExtensionVisible, false);
  }

  recordAcceptanceProgress(`${phase}:restart-setup`);
  await executeReleasedNotebookCell(notebook, 0, setupMarker, `${phase}:restart-setup-cell`);
  const restoredSetup = releasedNotebookSetupResult(notebook.cellAt(0));
  assert.equal(restoredSetup.setup, setupMarker);
  assert.equal(
    restoredSetup.pid,
    replacement.pid,
    "The recreated DuckDB relation must belong to the exact observed replacement kernel."
  );
  assert.equal(
    restoredSetup.duckdbConversionGuards,
    true,
    "The replacement kernel must arm DuckDB conversion traps before session recovery."
  );
  if (target.remote) {
    assert.equal(restoredSetup.remoteRunId, target.remote.runId);
    assert.equal(restoredSetup.hostname, target.remote.hostname);
    assert.equal(restoredSetup.hostExtensionVisible, false);
  }

  recordAcceptanceProgress(`${phase}:restart-replay`);
  const [polarsReplayed, pandasReplayed, duckdbReplayed] = await Promise.all([
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "released-jupyter-polars-restart-replay",
      sessionId,
      revision: applied.revision,
      offset: 0,
      limit: 10,
      filterModel: applied.metadata.filterModel
    }),
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "released-jupyter-pandas-restart-replay",
      sessionId: pandas.sessionId,
      revision: pandas.revision,
      offset: 0,
      limit: 10,
      filterModel: pandas.filterModel
    }),
    testing.request({
      kind: "getPage",
      columnOffset: 0,
      columnLimit: 4,
      viewRequestId: "released-jupyter-duckdb-restart-replay",
      sessionId: duckdb.sessionId,
      revision: duckdb.revision,
      offset: 0,
      limit: 10,
      filterModel: duckdb.filterModel
    })
  ]);
  assert.equal(polarsReplayed.kind, "page", "The released-Jupyter Polars plan must replay after kernel replacement.");
  if (polarsReplayed.kind !== "page") throw new Error("Released-Jupyter Polars restart replay did not return a page.");
  const doubled = polarsReplayed.metadata.schema.find((column) => column.name === "double_units");
  assert.ok(doubled, "Recovered released-Jupyter metadata must retain the applied formula output.");
  assert.deepEqual(gridColumnDisplays(polarsReplayed.page, doubled.id), [
    "6",
    "20",
    "10",
    "24",
    "14",
    "4",
    "18",
    "8",
    "22",
    "12"
  ]);
  assert.equal(polarsReplayed.metadata.steps.length, 1);
  assert.equal(
    pandasReplayed.kind,
    "page",
    "The concurrent released-Jupyter Pandas session must recover after kernel replacement."
  );
  if (pandasReplayed.kind !== "page") throw new Error("Released-Jupyter Pandas restart replay did not return a page.");
  assert.deepEqual(gridColumnDisplays(pandasReplayed.page, pandasReplayed.metadata.schema[0]?.id ?? ""), ["1", "2"]);
  assert.equal(pandasReplayed.metadata.backend, "pandas");
  assert.equal(
    duckdbReplayed.kind,
    "page",
    "The concurrent native DuckDB relation must recover after kernel replacement."
  );
  if (duckdbReplayed.kind !== "page") {
    throw new Error("Released-Jupyter DuckDB restart replay did not return a page.");
  }
  assert.equal(
    duckdbReplayed.metadata.sessionId,
    duckdb.sessionId,
    "DuckDB recovery must preserve the public Open Wrangler session identity."
  );
  assert.equal(duckdbReplayed.metadata.backend, "duckdb");
  assert.equal(duckdbReplayed.metadata.mode, "viewing");
  assert.deepEqual(duckdbReplayed.metadata.capabilities, {
    editable: false,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: false
  });
  assert.deepEqual(duckdbReplayed.metadata.filterModel, duckdb.filterModel);
  assert.deepEqual(duckdbReplayed.metadata.filteredShape, { rows: 25_000, columns: 4 });
  assert.deepEqual(
    duckdbReplayed.metadata.schema,
    duckdb.schema,
    "DuckDB recovery must preserve the exact ordered public schema."
  );
  assert.equal(duckdbReplayed.page.totalRows, 25_000);
  assert.equal(duckdbReplayed.page.rows[0]?.values[0]?.display, "3499997");
  assert.equal(duckdbReplayed.page.rows[0]?.values[1]?.display, "DACH");

  const duckdbRevenue = columnReference(duckdbReplayed.metadata, "revenue");
  const duckdbSummary = await testing.request({
    kind: "getSummary",
    sessionId: duckdb.sessionId,
    revision: duckdbReplayed.revision,
    viewRequestId: "released-jupyter-duckdb-restart-summary",
    filterModel: duckdb.filterModel,
    columnIds: [duckdbRevenue.id]
  });
  assert.equal(duckdbSummary.kind, "summary");
  if (duckdbSummary.kind !== "summary") {
    throw new Error("Released-Jupyter DuckDB restart summary did not resolve.");
  }
  assert.equal(duckdbSummary.summaries[0]?.totalCount, 25_000);
  assert.equal(duckdbSummary.summaries[0]?.numeric?.min, 100.5);
  assert.equal(duckdbSummary.summaries[0]?.numeric?.max, 5_099.94);
  const recoveredDuckdbDiagnostic = testing
    .diagnostics()
    .sessions.find((session) => session.publicId === duckdb.sessionId);
  assert.ok(recoveredDuckdbDiagnostic, "The recovered native DuckDB session must remain coordinated.");
  assert.notEqual(
    recoveredDuckdbDiagnostic.runtimeId,
    duckdb.runtimeId,
    "Kernel recovery must replace DuckDB's private runtime identity."
  );
  testing.setActiveSession(duckdb.sessionId);
  const activeDuckdb = testing.activeSession();
  assert.ok(activeDuckdb, "The recovered DuckDB session must remain selectable.");
  assert.equal(activeDuckdb.sessionId, duckdb.sessionId);
  assert.deepEqual(activeDuckdb.viewState, {
    ...duckdb.viewState,
    filterModel: duckdb.filterModel
  });
  if (target.remote) {
    await assertReleasedRemoteRuntimeTransfer(notebook, target, hostExtensionPath, phase);
  }
}

async function restartReleasedJupyterKernelAndWait(
  notebook: vscode.NotebookDocument,
  checkpoint?: (boundary: ReleasedJupyterKernelRestartBoundary) => void
): Promise<void> {
  const extension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  assert.ok(extension, "The released Jupyter extension must remain installed for restart acceptance.");
  await restartReleasedJupyterKernelAndWaitOwner({
    notebook,
    activateJupyter: () => extension.activate(),
    getKernel: (api, exactNotebook) => api.kernels.getKernel(exactNotebook.uri),
    dispatchRestart: (exactNotebook) => vscode.commands.executeCommand("jupyter.restartkernel", exactNotebook.uri),
    assertExactNotebook: assertExactOpenNotebookDocument,
    checkpoint
  });
}

async function bestEffortReleasedJupyterCleanup(
  testing: TestApi,
  notebook: vscode.NotebookDocument | undefined,
  phase: ReleasedJupyterPhase
): Promise<void> {
  recordAcceptanceProgress(`${phase}:cleanup-start`);
  for (const session of [...testing.diagnostics().sessions]) {
    try {
      await withBoundedAcceptancePromise(
        testing.disposePanelForSession(session.publicId),
        10_000,
        `released-Jupyter session ${session.publicId} cleanup`
      );
    } catch {
      // Preserve the first released-Jupyter acceptance failure.
    }
  }
  recordAcceptanceProgress(`${phase}:cleanup-sessions`);
  try {
    await withBoundedAcceptancePromise(
      closeReleasedJupyterSessionTabs(),
      10_000,
      "released-Jupyter session-tab cleanup"
    );
  } catch {
    // The isolated editor process remains the bounded final cleanup owner.
  }
  recordAcceptanceProgress(`${phase}:cleanup-session-tabs`);
  if (notebook) {
    if (!notebook.isClosed && notebook.isDirty) {
      const saved = await withBoundedAcceptancePromise(
        notebook.save(),
        10_000,
        "saving the temporary released-Jupyter notebook before cleanup"
      );
      assert.equal(saved, true, "The temporary released-Jupyter notebook must save before its tab closes.");
      recordAcceptanceProgress(`${phase}:cleanup-notebook-saved`);
    }
    const tab = notebookTab(notebook.uri);
    if (tab) {
      try {
        await withBoundedAcceptancePromise(
          vscode.window.tabGroups.close(tab, true),
          10_000,
          "released-Jupyter notebook-tab cleanup"
        );
        await waitFor(() => notebook.isClosed, 10_000, "the released-Jupyter notebook document to close");
      } catch {
        // Preserve the first released-Jupyter acceptance failure.
      }
    }
  }
  recordAcceptanceProgress(`${phase}:cleanup-complete`);
}

async function exercisePackagedStepInspection(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.source.path === fixture.fsPath &&
        active.metadata.steps.some((step) => step.id === "packaged-score")
      );
    },
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the packaged custom editor to restore its applied cleaning step"
  );
  await waitForSettledViewState(testing, "the confirmed packaged-editor view before step selection");

  const beforeSelection = testing.activeSession();
  assert.ok(beforeSelection, "The packaged custom editor must publish its active session.");
  assert.equal(beforeSelection.stepInspection, undefined);
  const confirmedMetadata = structuredClone(beforeSelection.metadata);
  const confirmedView = structuredClone(beforeSelection.viewState);
  const confirmedCode = beforeSelection.code;

  await vscode.commands.executeCommand("openWrangler.selectStep", "packaged-score");
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === "packaged-score",
    30_000,
    "the packaged editor to inspect the selected applied step"
  );

  const selected = testing.activeSession();
  assert.ok(selected?.stepInspection, "Selecting an applied step must publish its inspection snapshot.");
  const inspection = selected.stepInspection;
  assert.equal(inspection.revision, confirmedMetadata.revision, "Inspection must not advance the session revision.");
  assert.equal(inspection.stepIndex, 0);
  assert.deepEqual(
    inspection.inputSchema.map((column) => column.name),
    ["city", "year", "sales", "active"]
  );
  assert.deepEqual(
    inspection.outputSchema.map((column) => column.name),
    ["city", "year", "sales", "active", "score"]
  );
  assert.deepEqual(inspection.diff.addedColumns, ["score"]);
  assert.deepEqual(inspection.diff.removedColumns, []);
  assert.equal(inspection.diff.truncated, false);
  assert.match(inspection.code, /def clean_data\(df\):/u);
  assert.match(inspection.code, /score/u);
  assert.deepEqual(selected.metadata, confirmedMetadata, "Inspection must leave the confirmed metadata unchanged.");
  assert.deepEqual(selected.viewState, confirmedView, "Inspection must leave the confirmed view unchanged.");

  await vscode.commands.executeCommand("openWrangler.selectStep");
  await waitFor(
    () => testing.activeSession()?.stepInspection === undefined,
    10_000,
    "Original Data to clear the selected applied-step inspection"
  );
  await waitForSettledViewState(testing, "the confirmed packaged-editor view after clearing step selection");

  const restored = testing.activeSession();
  assert.ok(restored, "Clearing an inspection must retain the active dataframe session.");
  assert.equal(restored.stepInspection, undefined);
  assert.deepEqual(restored.metadata, confirmedMetadata, "Clearing must restore the exact confirmed metadata.");
  assert.deepEqual(
    restored.viewState,
    confirmedView,
    "Clearing must restore filters, sorts, widths, selection, and viewport exactly."
  );
  assert.equal(restored.code, confirmedCode, "Clearing must restore the full-plan generated code.");

  const sourceBytes = readFileSync(fixture.fsPath);
  const originalStep = confirmedMetadata.steps[0];
  assert.ok(originalStep, "The packaged history journey requires one confirmed source step.");
  const suffixStep: TransformStep = {
    id: "packaged-history-suffix",
    kind: "cloneColumn",
    params: { column: columnReference(restored.metadata, "sales"), newName: "sales copy" }
  };
  const suffixPreview = await testing.request({
    kind: "previewStep",
    ...GRID_COLUMN_WINDOW,
    sessionId: restored.sessionId,
    revision: restored.metadata.revision,
    step: suffixStep,
    offset: 0,
    limit: 20
  });
  assert.equal(suffixPreview.kind, "stepPreview", "The packaged history suffix did not preview.");
  if (suffixPreview.kind !== "stepPreview") return;
  const suffixApplied = await testing.request({
    kind: "applyDraft",
    ...GRID_COLUMN_WINDOW,
    sessionId: restored.sessionId,
    revision: suffixPreview.revision,
    offset: 0,
    limit: 20
  });
  assert.equal(suffixApplied.kind, "planUpdated", "The packaged history suffix did not apply.");
  if (suffixApplied.kind !== "planUpdated") return;

  const replacementStep: TransformStep = {
    ...originalStep,
    params: { ...originalStep.params, value: 4 }
  } as TransformStep;
  const replacementPreview = await testing.request({
    kind: "previewStep",
    ...GRID_COLUMN_WINDOW,
    sessionId: restored.sessionId,
    revision: suffixApplied.revision,
    step: replacementStep,
    replaceStepId: originalStep.id,
    offset: 0,
    limit: 20
  });
  assert.equal(replacementPreview.kind, "stepPreview", "The packaged earlier replacement did not preview.");
  if (replacementPreview.kind !== "stepPreview") return;
  const replacementApplied = await testing.rewriteCleaningPlan(
    restored.sessionId,
    replacementPreview.revision,
    originalStep.id,
    "applyDraft"
  );
  assert.equal(replacementApplied?.kind, "planUpdated", "The packaged earlier replacement did not publish.");
  if (replacementApplied?.kind !== "planUpdated") return;
  assert.deepEqual(
    replacementApplied.metadata.steps.map((step) => step.id),
    [originalStep.id, suffixStep.id],
    "The packaged earlier replacement lost or reordered the unchanged suffix."
  );
  assert.equal(
    gridColumnDisplays(replacementApplied.page, columnReference(replacementApplied.metadata, "score").id)[0],
    "48.0",
    "The packaged earlier replacement did not rebuild the selected step."
  );

  const deleted = await testing.rewriteCleaningPlan(
    restored.sessionId,
    replacementApplied.revision,
    originalStep.id,
    "deleteStep"
  );
  assert.equal(deleted?.kind, "planUpdated", "The packaged earlier deletion did not publish.");
  if (deleted?.kind !== "planUpdated") return;
  assert.deepEqual(
    deleted.metadata.steps.map((step) => step.id),
    [suffixStep.id],
    "The packaged earlier deletion did not preserve the stable suffix ID."
  );
  assert.equal(
    deleted.metadata.schema.some((column) => column.name === "score"),
    false,
    "The packaged earlier deletion retained the deleted output."
  );
  assert.ok(columnReference(deleted.metadata, "sales copy"));

  const suffixUndone = await testing.request({
    kind: "undoStep",
    ...GRID_COLUMN_WINDOW,
    sessionId: restored.sessionId,
    revision: deleted.revision,
    offset: 0,
    limit: 20
  });
  assert.equal(suffixUndone.kind, "planUpdated", "The packaged history suffix did not undo during restoration.");
  if (suffixUndone.kind !== "planUpdated") return;
  const originalPreview = await testing.request({
    kind: "previewStep",
    ...GRID_COLUMN_WINDOW,
    sessionId: restored.sessionId,
    revision: suffixUndone.revision,
    step: originalStep,
    offset: 0,
    limit: 20
  });
  assert.equal(originalPreview.kind, "stepPreview", "The packaged source step did not restore.");
  if (originalPreview.kind !== "stepPreview") return;
  const originalApplied = await testing.request({
    kind: "applyDraft",
    ...GRID_COLUMN_WINDOW,
    sessionId: restored.sessionId,
    revision: originalPreview.revision,
    offset: 0,
    limit: 20
  });
  assert.equal(originalApplied.kind, "planUpdated", "The packaged source plan did not restore.");
  if (originalApplied.kind !== "planUpdated") return;
  assert.deepEqual(originalApplied.metadata.steps, [originalStep]);
  assert.deepEqual(originalApplied.metadata.filterModel, confirmedMetadata.filterModel);
  assert.deepEqual(testing.activeSession()?.viewState, confirmedView);
  assert.equal(originalApplied.code, confirmedCode);
  assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Packaged history rewrites must not modify the source.");
}

async function exercisePackagedTrustedPickleConversion(
  testing: TestApi,
  workbench: Page,
  testPython: string
): Promise<void> {
  assert.equal(testing.diagnostics().sessionCount, 0, "Pickle conversion must start without an open dataframe.");
  assert.equal(testing.runtimeRunning(), false, "Pickle conversion must start without the dataframe runtime.");

  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-trusted-pickle-"));
  const sourcePath = path.join(directory, "trusted-orders.pkl");
  const declinedPath = path.join(directory, "declined.parquet");
  const destinationPath = path.join(directory, "trusted-orders.parquet");
  const source = vscode.Uri.file(sourcePath);
  createHarmlessTrustedPickleFixture(testPython, sourcePath, directory);
  const sourceBytes = readFileSync(sourcePath);
  const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
  const initialWorkerRoots = trustedPickleWorkerRoots();
  const availableCommands = new Set(await vscode.commands.getCommands(true));

  try {
    recordAcceptanceProgress("platform-smoke:trusted-pickle:ordinary-open-rejected");
    const ordinaryOpen = vscode.commands.executeCommand("openWrangler.openFile", source);
    const unsupportedNotice = workbench
      .locator(
        ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
      )
      .filter({ hasText: "Open Wrangler supports CSV, TSV, Parquet, JSONL/NDJSON, XLSX, and XLS files." })
      .last();
    await unsupportedNotice.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    assert.equal(testing.activeSession(), undefined, "Ordinary Open must not create a pickle session.");
    assert.equal(testing.runtimeRunning(), false, "Ordinary Open must not start Python for a pickle.");
    if (availableCommands.has("notifications.clearAll")) {
      await vscode.commands.executeCommand("notifications.clearAll");
    } else {
      await workbench.keyboard.press("Escape");
    }
    await withBoundedAcceptancePromise(ordinaryOpen, WORKBENCH_OPERATION_TIMEOUT_MS, "the rejected pickle open");
    assert.equal(existsSync(declinedPath), false);
    assert.deepEqual(trustedPickleWorkerRoots(), initialWorkerRoots);

    recordAcceptanceProgress("platform-smoke:trusted-pickle:decline");
    const declined = vscode.commands.executeCommand<boolean>("openWrangler.convertTrustedPickle", source);
    await chooseTrustedPickleDestination(workbench, declinedPath);
    const declineDialog = await waitForVisibleEditorDialog(workbench, "Convert trusted-orders.pkl");
    await assertTrustedPickleWarning(declineDialog.dialog);
    await declineDialog.page.bringToFront();
    await declineDialog.page.keyboard.press("Escape");
    await declineDialog.dialog.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    assert.equal(
      await withBoundedAcceptancePromise(declined, WORKBENCH_OPERATION_TIMEOUT_MS, "declining pickle conversion"),
      false
    );
    assert.equal(existsSync(declinedPath), false, "Declining conversion must not create the chosen Parquet file.");
    assert.deepEqual(trustedPickleWorkerRoots(), initialWorkerRoots, "Declining must not leave a pickle worker root.");
    assert.deepEqual(trustedPickleSiblingTemporaries(directory), [], "Declining must not reserve a sibling temp file.");
    assert.equal(
      createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
      sourceDigest,
      "Declining conversion must preserve the pickle digest."
    );

    recordAcceptanceProgress("platform-smoke:trusted-pickle:convert");
    const converted = vscode.commands.executeCommand<boolean>("openWrangler.convertTrustedPickle", source);
    await chooseTrustedPickleDestination(workbench, destinationPath);
    const conversionDialog = await waitForVisibleEditorDialog(workbench, "Convert trusted-orders.pkl");
    await assertTrustedPickleWarning(conversionDialog.dialog);
    const convertButton = conversionDialog.dialog.getByRole("button", { name: "Convert", exact: true });
    assert.equal(await convertButton.count(), 1, "Trusted pickle conversion must have one explicit Convert action.");
    await convertButton.click({ timeout: WORKBENCH_OPERATION_TIMEOUT_MS, noWaitAfter: true });
    await conversionDialog.dialog.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });

    const completedNotice = workbench
      .locator(
        ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
      )
      .filter({ hasText: "Converted trusted-orders.pkl to trusted-orders.parquet." })
      .last();
    await completedNotice.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(existsSync(destinationPath), true, "Confirmed conversion must publish the chosen Parquet file.");
    assert.deepEqual(
      trustedPickleWorkerRoots(),
      initialWorkerRoots,
      "The converter must remove its private worker root before reporting success."
    );
    assert.deepEqual(
      trustedPickleSiblingTemporaries(directory),
      [],
      "Publishing the Parquet file must leave no sibling transaction temp."
    );
    assertExactBytes(
      readFileSync(sourcePath),
      sourceBytes,
      "Successful trusted pickle conversion must leave the source byte-identical."
    );
    assert.equal(createHash("sha256").update(readFileSync(sourcePath)).digest("hex"), sourceDigest);

    const openAction = completedNotice.getByRole("button", { name: "Open in Open Wrangler", exact: true });
    assert.equal(await openAction.count(), 1, "The completed conversion notice must expose one Open action.");
    await openAction.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    await workbench.bringToFront();
    await openAction.focus({ timeout: WORKBENCH_OPERATION_TIMEOUT_MS });
    const actionState = await openAction.evaluate((element) => ({
      connected: element.isConnected,
      focused: element.ownerDocument.activeElement === element
    }));
    assert.deepEqual(actionState, { connected: true, focused: true });
    await openAction.press("Enter", { timeout: WORKBENCH_OPERATION_TIMEOUT_MS });
    recordAcceptanceProgress("platform-smoke:trusted-pickle:open-action-dispatched");
    assert.equal(
      await withBoundedAcceptancePromise(
        converted,
        WORKBENCH_OPERATION_TIMEOUT_MS,
        "the trusted pickle completion action"
      ),
      true
    );
    recordAcceptanceProgress("platform-smoke:trusted-pickle:open");
    await waitFor(
      () => testing.activeSession()?.metadata.source.path === vscode.Uri.file(destinationPath).fsPath,
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the converted Parquet file to open in Open Wrangler"
    );
    const active = testing.activeSession();
    assert.ok(active, "Opening the converted Parquet file must publish a dataframe session.");
    assert.deepEqual(active.metadata.shape, { rows: 3, columns: 3 });
    assert.deepEqual(
      active.metadata.schema.map((column) => column.name),
      ["order_id", "market", "revenue"]
    );
    const page = await testing.request({
      kind: "getPage",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      viewRequestId: "packaged-trusted-pickle-page",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 3,
      filterModel: active.metadata.filterModel
    });
    assert.equal(page.kind, "page");
    if (page.kind !== "page") throw new Error("The converted Parquet file did not return its first grid page.");
    assert.deepEqual(
      page.page.rows.map((row) => row.values.map((cell) => cell.display)),
      [
        ["2400001", "DACH", "620.5"],
        ["2400002", "Nordics", "699.69"],
        ["2400003", "Iberia", "778.88"]
      ]
    );

    recordAcceptanceProgress("platform-smoke:trusted-pickle:cleanup");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      15_000,
      "the converted Parquet session and dataframe runtime to stop"
    );
    assert.deepEqual(testing.diagnostics().sessions, []);
    assert.deepEqual(trustedPickleWorkerRoots(), initialWorkerRoots);
    assert.deepEqual(trustedPickleSiblingTemporaries(directory), []);
    assertExactBytes(readFileSync(sourcePath), sourceBytes, "Pickle acceptance cleanup must preserve the source.");
  } finally {
    await workbench.keyboard.press("Escape").catch(() => {});
    if (availableCommands.has("notifications.clearAll")) {
      await vscode.commands.executeCommand("notifications.clearAll").then(undefined, () => undefined);
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors").then(undefined, () => undefined);
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      15_000,
      "trusted pickle acceptance cleanup"
    );
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

function createHarmlessTrustedPickleFixture(python: string, destination: string, cwd: string): void {
  const source = [
    "import pandas as pd",
    "import sys",
    "frame = pd.DataFrame({",
    "    'order_id': [2400001, 2400002, 2400003],",
    "    'market': ['DACH', 'Nordics', 'Iberia'],",
    "    'revenue': [620.5, 699.69, 778.88],",
    "})",
    "frame.to_pickle(sys.argv[1])"
  ].join("\n");
  execFileSync(python, ["-I", "-c", source, destination], {
    cwd,
    stdio: "ignore",
    timeout: 30_000,
    windowsHide: true
  });
}

async function chooseTrustedPickleDestination(workbench: Page, destination: string): Promise<void> {
  const picker = workbench
    .locator(".quick-input-widget:visible")
    .filter({ hasText: "Convert Trusted Pickle to Parquet" })
    .last();
  await picker.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  const input = picker.locator(".quick-input-box input").first();
  await input.fill(path.resolve(destination));
  await input.press("Enter");
  await picker.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
}

async function assertTrustedPickleWarning(dialog: Locator): Promise<void> {
  const message = await dialog.locator(".dialog-message-text").innerText();
  const detail = await dialog.locator(".dialog-message-detail").innerText();
  const prefix = "Convert trusted-orders.pkl with ";
  assert.ok(message.startsWith(prefix) && message.endsWith("?"));
  const python = message.slice(prefix.length, -1);
  assert.ok(path.isAbsolute(python), "The warning must name the resolved absolute Python interpreter.");
  assert.equal(
    detail,
    "Loading a pickle can run Python code with your user permissions. Continue only if you trust trusted-orders.pkl, " +
      `know where it came from, and know it has not been modified. Open Wrangler will use ${python}. ` +
      "The conversion output goes to a separate Parquet file; Open Wrangler does not overwrite the pickle."
  );
}

function trustedPickleWorkerRoots(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("openwrangler-pickle-"))
    .map((entry) => entry.name)
    .sort();
}

function trustedPickleSiblingTemporaries(directory: string): string[] {
  return readdirSync(directory)
    .filter((entry) => /^\.openwrangler-.+-\d+\.tmp$/u.test(entry))
    .sort();
}

async function exercisePackagedPlatformSmoke(
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  fixture: vscode.Uri,
  testPython: string
): Promise<void> {
  const editorKey = process.env.OPEN_WRANGLER_TEST_EDITOR;
  assert.equal(
    editorKey === "vscode" || editorKey === "cursor",
    true,
    "The bounded packaged journey requires VS Code or Cursor."
  );
  const editorName = editorKey === "cursor" ? "Cursor" : "VS Code";
  const sourceBytes = await vscode.workspace.fs.readFile(fixture);
  const page = await connectToEditorWorkbench();
  const activeEditorGroup = page.locator(".part.editor .editor-group-container.active");

  recordAcceptanceProgress("platform-smoke:gallery-icon");
  await vscode.commands.executeCommand("workbench.view.extensions");
  const installedExtension = page
    .locator(".part.sidebar .monaco-list-row, .part.sidebar [role=treeitem]")
    .filter({ hasText: "Open Wrangler" })
    .first();
  await installedExtension.waitFor({ state: "visible", timeout: 10_000 });
  const galleryIcon = installedExtension.locator("img").first();
  await galleryIcon.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    await galleryIcon.evaluate((image: unknown) => {
      const candidate = image as { complete?: unknown; naturalWidth?: unknown; tagName?: unknown };
      return candidate.tagName === "IMG" && candidate.complete === true && Number(candidate.naturalWidth) > 0;
    }),
    true,
    "The installed Open Wrangler gallery entry must render its packaged icon."
  );
  recordAcceptanceProgress("platform-smoke:trusted-pickle");
  await exercisePackagedTrustedPickleConversion(testing, page, testPython);

  const screenshotOutput = process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS;
  if (screenshotOutput) {
    const commands = new Set(await vscode.commands.getCommands(true));
    const auxiliaryBar = page.locator(".part.auxiliarybar");
    if ((await auxiliaryBar.count()) > 0 && (await auxiliaryBar.isVisible())) {
      const closeAuxiliaryBar = commands.has("workbench.action.closeAuxiliaryBar")
        ? "workbench.action.closeAuxiliaryBar"
        : commands.has("workbench.action.toggleAuxiliaryBar")
          ? "workbench.action.toggleAuxiliaryBar"
          : undefined;
      if (closeAuxiliaryBar) {
        await vscode.commands.executeCommand(closeAuxiliaryBar);
        await auxiliaryBar.waitFor({ state: "hidden", timeout: 10_000 });
      }
    }
    const sidebar = page.locator(".part.sidebar");
    if ((await sidebar.count()) > 0 && (await sidebar.isVisible())) {
      const closeSidebar = commands.has("workbench.action.closeSidebar")
        ? "workbench.action.closeSidebar"
        : commands.has("workbench.action.toggleSidebarVisibility")
          ? "workbench.action.toggleSidebarVisibility"
          : undefined;
      if (closeSidebar) {
        await vscode.commands.executeCommand(closeSidebar);
        await sidebar.waitFor({ state: "hidden", timeout: 10_000 });
      }
    }
    await clearReleasedJupyterScreenshotTransientUi(page);
  }

  recordAcceptanceProgress("platform-smoke:file-action");
  await vscode.commands.executeCommand("vscode.open", fixture, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    10_000,
    `the CSV source editor before the ${editorName} title action`
  );
  await page.bringToFront();
  const titleAction = activeEditorGroup.locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible').first();
  await titleAction.waitFor({ state: "visible", timeout: 10_000 });
  if (screenshotOutput) {
    recordAcceptanceProgress("platform-smoke:file-action:screenshots");
    mkdirSync(screenshotOutput, { recursive: true });
    await page.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
    assert.deepEqual(
      await page.evaluate(() => {
        const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
        return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
      }),
      PACKAGED_PRODUCT_VIEWPORT,
      "File-action public media requires the dedicated 1440 by 900 logical editor viewport."
    );
    await titleAction.hover();
    await page
      .locator(".monaco-hover:visible")
      .filter({ hasText: "Open in Open Wrangler" })
      .waitFor({ state: "visible", timeout: 2_000 })
      .catch(() => {});
    await captureWorkbenchScreenshot(
      page,
      path.resolve(screenshotOutput, `${editorKey}-file-title-action.png`),
      PACKAGED_FILE_ACTION_MEDIA_HEIGHT
    );
    await page.keyboard.press("Escape");

    const sourceTab = activeEditorGroup
      .locator(".tabs-container .tab.active")
      .filter({ hasText: path.basename(fixture.fsPath) })
      .last();
    const { menu } = await openEditorTabContextMenu(page, sourceTab, "Open in Open Wrangler");
    await captureWorkbenchScreenshot(
      page,
      path.resolve(screenshotOutput, `${editorKey}-tab-context-menu.png`),
      PACKAGED_FILE_ACTION_MEDIA_HEIGHT
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden", timeout: 3_000 });
    await titleAction.waitFor({ state: "visible", timeout: 3_000 });
  }
  await titleAction.click();
  await waitForAutomaticDelimitedImport(page, testing, fixture, "platform-smoke:import");
  await waitFor(
    () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the ${editorName} CSV action to open a dataframe session`
  );
  const active = testing.activeSession();
  assert.ok(active, `The ${editorName} journey must publish an active dataframe session.`);
  assert.equal(active.metadata.source.path, fixture.fsPath);
  assert.deepEqual(active.metadata.shape, {
    rows: PACKAGED_FIRST_USE_ROW_COUNT,
    columns: PACKAGED_SCREENSHOT_COLUMNS.length
  });
  assert.equal(active.metadata.backend, "polars");
  assert.deepEqual(active.metadata.source.importOptions, {
    delimiter: ";",
    encoding: "utf-8",
    quoteChar: '"',
    hasHeader: true
  });

  recordAcceptanceProgress("platform-smoke:grid");
  const gridTarget = await waitForOpenWranglerGridTarget(page, testing, active.metadata.sessionId);
  const grid = gridTarget.frame.getByRole("grid", { name: `Data grid for ${active.metadata.source.label}` });
  await grid.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await grid.getAttribute("aria-colcount"), String(PACKAGED_SCREENSHOT_COLUMNS.length + 1));
  const firstCell = gridTarget.frame.locator('td[data-grid-row="0"][data-grid-column="0"]').first();
  await firstCell.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await firstCell.innerText()).trim(), "2400001");
  await firstCell.focus();
  await firstCell.press("ArrowRight");
  await gridTarget.frame
    .locator('td[data-grid-row="0"][data-grid-column="1"]:focus')
    .waitFor({ state: "visible", timeout: 5_000 });

  await exercisePrimarySortJourney(
    testing,
    page,
    gridTarget.frame,
    active.metadata.sessionId,
    "platform-smoke:sort-journey"
  );
  await exercisePackagedBackendSwitchJourney(testing, page, active.metadata.sessionId, fixture, sourceBytes);
  await exercisePackagedFirstUseInteractionJourney(testing, page, active.metadata.sessionId, fixture, sourceBytes);

  recordAcceptanceProgress("platform-smoke:theme");
  const themedGridTarget = await waitForOpenWranglerGridTarget(page, testing, active.metadata.sessionId);
  const themeAttestation = await themedGridTarget.frame.locator("main.app").evaluate((element) => {
    const window = element.ownerDocument.defaultView;
    if (!window) throw new Error("The packaged editor webview did not expose a live window.");
    const computed = window.getComputedStyle(element);
    const root = window.getComputedStyle(element.ownerDocument.documentElement);
    const probe = element.ownerDocument.createElement("span");
    probe.style.color = "var(--vscode-foreground)";
    probe.style.backgroundColor = "var(--vscode-editor-background)";
    element.appendChild(probe);
    const expected = window.getComputedStyle(probe);
    const result = {
      color: computed.color,
      background: root.backgroundColor,
      expectedColor: expected.color,
      expectedBackground: expected.backgroundColor,
      foregroundToken: root.getPropertyValue("--vscode-foreground").trim(),
      backgroundToken: root.getPropertyValue("--vscode-editor-background").trim(),
      fontToken: root.getPropertyValue("--vscode-font-family").trim(),
      fontFamily: computed.fontFamily
    };
    probe.remove();
    return result;
  });
  assert.ok(themeAttestation.foregroundToken, `${editorName} must provide the VS Code foreground token.`);
  assert.ok(themeAttestation.backgroundToken, `${editorName} must provide the VS Code editor-background token.`);
  assert.ok(themeAttestation.fontToken, `${editorName} must provide the VS Code font token.`);
  assert.equal(themeAttestation.color, themeAttestation.expectedColor);
  assert.equal(themeAttestation.background, themeAttestation.expectedBackground);
  assert.ok(themeAttestation.fontFamily);

  recordAcceptanceProgress("platform-smoke:native-views");
  await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
  const activityAction = page.getByRole("tab", { name: /Open Wrangler/iu }).first();
  await activityAction.waitFor({ state: "visible", timeout: 10_000 });
  const sidebar = page.locator(".part.sidebar:visible");
  for (const label of ["Operations", "Summary", "Filters / Sorts", "Cleaning Steps"]) {
    await sidebar.getByText(label, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  assert.equal(extension.isActive, true);

  await exercisePackagedReopenAndUndoJourney(testing, page, fixture, sourceBytes, editorName);
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "The interpolation journey requires the isolated acceptance workspace.");
  await exercisePackagedLinearInterpolationJourney(
    testing,
    page,
    ensurePackagedLinearInterpolationFixture(workspace),
    editorName
  );

  recordAcceptanceProgress("platform-smoke:cleanup");
  assertExactBytes(
    await vscode.workspace.fs.readFile(fixture),
    sourceBytes,
    `${editorName} platform-smoke cleanup must preserve its source bytes.`
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    `the ${editorName} journey session and Python runtime to terminate`
  );
  assert.deepEqual(testing.diagnostics().sessions, []);
}

async function exerciseRemoteWorkspace(
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  workspace: vscode.Uri,
  testPython: string
): Promise<void> {
  assert.equal(
    process.env.OPEN_WRANGLER_TEST_EDITOR,
    "vscode-remote-ssh",
    "Remote-workspace acceptance is reserved for the pinned official VS Code and Remote SSH chain."
  );
  assert.equal(vscode.env.remoteName, "ssh-remote", "The acceptance extension host must execute over Remote SSH.");
  assert.equal(
    workspace.scheme,
    "file",
    "A workspace-extension process must receive its Remote SSH filesystem as a host-local file URI."
  );
  assert.equal(workspace.authority, "");
  assert.equal(extension.isActive, true);
  for (const loaderVariable of ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_BIND_NOW", "LD_AUDIT"]) {
    assert.equal(
      process.env[loaderVariable],
      undefined,
      `The remote extension host must not inherit ${loaderVariable}.`
    );
  }

  const configuredPython = vscode.workspace.getConfiguration("openWrangler", workspace).inspect<string>("pythonPath");
  assert.equal(
    configuredPython?.workspaceFolderValue,
    testPython,
    "The remote workspace must pin its private Python through resource-scoped configuration."
  );
  assert.equal(vscode.workspace.getConfiguration("openWrangler", workspace).get<string>("pythonPath"), testPython);

  const fixture = vscode.Uri.joinPath(workspace, "remote.csv");
  const sourceBytes = await vscode.workspace.fs.readFile(fixture);
  recordAcceptanceProgress("remote-workspace:open");
  await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitFor(
    () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the Remote SSH CSV source to open in the real Open Wrangler grid",
    () =>
      JSON.stringify({
        coordinator: testing.diagnostics(),
        runtimeRunning: testing.runtimeRunning(),
        runtimeEnvironment: testing.runtimeEnvironment(),
        panelOpenResponse: testing.panelOpenResponse()
      })
  );
  const active = testing.activeSession();
  assert.ok(active, "The Remote SSH workspace must publish one active dataframe grid.");
  assert.equal(active.metadata.backend, "polars");
  assert.deepEqual(active.metadata.shape, { rows: 3, columns: 2 });
  await waitFor(
    () => testing.panelHydrated(active.metadata.sessionId),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the exact Remote SSH panel to finish opening and acknowledge its current renderer snapshot"
  );
  assert.equal(
    await testing.synchronizePanel(active.metadata.sessionId),
    true,
    "The remote dataframe session must own a synchronized Open Wrangler grid panel."
  );

  const runtimeEnvironment = testing.runtimeEnvironment();
  assert.ok(runtimeEnvironment, "The remote grid must start its Python runtime.");
  assert.equal(runtimeEnvironment.executable, testPython);
  assert.equal(runtimeEnvironment.source, "configuration");
  assert.match(runtimeEnvironment.version, /^3\.(?:1[0-4])\./u);

  const filterModel: FilterModel = {
    logic: "and",
    filters: [
      {
        column: "city",
        type: "string",
        logic: "and",
        predicates: [{ kind: "predicate", operator: "equals", value: "Milan" }]
      }
    ],
    sort: []
  };
  recordAcceptanceProgress("remote-workspace:filter");
  const filtered = await testing.request({
    kind: "getPage",
    ...GRID_COLUMN_WINDOW,
    viewRequestId: "remote-workspace-filter",
    sessionId: active.metadata.sessionId,
    revision: active.metadata.revision,
    offset: 0,
    limit: 20,
    filterModel
  });
  assert.equal(filtered.kind, "page");
  if (filtered.kind !== "page") return;
  assert.equal(filtered.page.totalRows, 1);
  assert.equal(filtered.page.rows.length, 1);
  assert.equal(filtered.page.rows[0]?.values[0]?.display, "Milan");
  assert.equal(filtered.page.rows[0]?.values[1]?.display, "42");
  assert.deepEqual(testing.activeSession()?.viewState.filterModel, filterModel);
  assertExactBytes(
    await vscode.workspace.fs.readFile(fixture),
    sourceBytes,
    "A remote viewing filter must leave the source CSV bytes unchanged."
  );

  recordAcceptanceProgress("remote-workspace:cleanup");
  await testing.disposePanelForSession(active.metadata.sessionId);
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    15_000,
    "the Remote SSH session and private Python runtime to terminate"
  );
  assert.deepEqual(testing.diagnostics().sessions, []);
  assert.equal(testing.runtimeEnvironment(), undefined);
  assertExactBytes(
    await vscode.workspace.fs.readFile(fixture),
    sourceBytes,
    "Remote-workspace cleanup must preserve the source CSV bytes."
  );
}

async function waitForOpenWranglerGridTarget(
  workbench: Page,
  testing: TestApi,
  expectedSessionId: string,
  expectedRendererSynchronizationReceipt?: Readonly<{ syncId: string; sessionId: string; revision: number }>
): Promise<OpenWranglerWebviewTarget> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  do {
    const browser = workbench.context().browser();
    const target = await findCurrentOpenWranglerGridTarget(
      workbench,
      browser,
      testing,
      expectedSessionId,
      expectedRendererSynchronizationReceipt
    );
    if (target) return target;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  const { action: reacquiredTarget, diagnostics } = await diagnoseThenReacquireAcceptanceAction({
    timeoutMs: WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
    diagnose: async (failureDeadline) => {
      const browser = workbench.context().browser();
      assertOpenWranglerWebviewLifecycle(workbench, browser);
      return openWranglerGridDiagnostics(workbench, browser, expectedSessionId, failureDeadline);
    },
    reacquire: async (failureDeadline) =>
      findCurrentOpenWranglerGridTarget(
        workbench,
        workbench.context().browser(),
        testing,
        expectedSessionId,
        expectedRendererSynchronizationReceipt,
        failureDeadline
      )
  });
  if (reacquiredTarget) return reacquiredTarget;

  assertOpenWranglerWebviewLifecycle(workbench, workbench.context().browser());
  const active = testing.activeSession();
  throw new Error(
    "The editor journey did not expose the expected live Open Wrangler grid. " +
      `State: ${JSON.stringify({
        expectedSessionId,
        activeSession:
          active === undefined
            ? undefined
            : {
                sessionId: active.sessionId,
                sourceLabel: active.metadata.source.label,
                revision: active.metadata.revision
              },
        coordinator: testing.diagnostics(),
        panelHydrated: testing.panelHydrated(expectedSessionId),
        activeTab: activeEditorTabDiagnostic(),
        webviews: diagnostics
      })}`
  );
}

async function findCurrentOpenWranglerGridTarget(
  workbench: Page,
  browser: Browser | null,
  testing: TestApi,
  expectedSessionId: string,
  expectedRendererSynchronizationReceipt?: Readonly<{ syncId: string; sessionId: string; revision: number }>,
  deadline?: number
): Promise<OpenWranglerWebviewTarget | undefined> {
  assertOpenWranglerWebviewLifecycle(workbench, browser);
  if (deadline !== undefined && Date.now() >= deadline) return undefined;
  for (const target of openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT)) {
    if (deadline !== undefined && Date.now() >= deadline) return undefined;
    if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
    try {
      const app = await exactSessionApp(
        target.frame,
        expectedSessionId,
        expectedRendererSynchronizationReceipt?.syncId
      );
      if (deadline !== undefined && Date.now() >= deadline) return undefined;
      if (!app) continue;
      const grid = app.locator('[data-testid="data-grid-scroller"] [role="grid"]').first();
      if ((await grid.count()) === 0 || !(await grid.isVisible())) continue;
      if (deadline !== undefined && Date.now() >= deadline) return undefined;
      if (
        expectedRendererSynchronizationReceipt &&
        !sameRendererSynchronizationReceipt(
          expectedRendererSynchronizationReceipt,
          testing.panelSynchronizationReceipt(expectedSessionId)
        )
      ) {
        continue;
      }
      return target;
    } catch (error) {
      ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
    }
  }
  return undefined;
}

async function waitForExactSessionWebviewButton(
  workbench: Page,
  testing: TestApi,
  expectedSessionId: string,
  name: string,
  requireEnabled = false,
  expectedRendererSynchronizationReceipt?: Readonly<{ syncId: string; sessionId: string; revision: number }>
): Promise<Locator> {
  return (
    await waitForExactSessionWebviewAction(
      workbench,
      testing,
      expectedSessionId,
      name,
      requireEnabled,
      expectedRendererSynchronizationReceipt
    )
  ).action;
}

async function waitForExactSessionWebviewAction(
  workbench: Page,
  testing: TestApi,
  expectedSessionId: string,
  name: string,
  requireEnabled = false,
  expectedRendererSynchronizationReceipt?: Readonly<{ syncId: string; sessionId: string; revision: number }>
): Promise<{ target: OpenWranglerWebviewTarget; action: Locator }> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  do {
    const browser = workbench.context().browser();
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    for (const target of openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT)) {
      if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
      try {
        const app = await exactSessionApp(
          target.frame,
          expectedSessionId,
          expectedRendererSynchronizationReceipt?.syncId
        );
        if (!app) continue;
        const grid = app.locator('[data-testid="data-grid-scroller"] [role="grid"]').first();
        if ((await grid.count()) === 0 || !(await grid.isVisible())) continue;
        const button = app.getByRole("button", { name, exact: true }).first();
        if ((await button.count()) === 0 || !(await button.isVisible())) continue;
        if (requireEnabled && !(await button.isEnabled())) continue;
        if (
          expectedRendererSynchronizationReceipt &&
          !sameRendererSynchronizationReceipt(
            expectedRendererSynchronizationReceipt,
            testing.panelSynchronizationReceipt(expectedSessionId)
          )
        ) {
          continue;
        }
        return { target, action: button };
      } catch (error) {
        ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  assertOpenWranglerWebviewLifecycle(workbench, browser);
  const diagnostics = await openWranglerGridDiagnostics(workbench, browser, expectedSessionId);
  throw new Error(
    `The editor journey did not expose the exact Open Wrangler session ${JSON.stringify(name)} button. ` +
      `State: ${JSON.stringify({
        expectedSessionId,
        requireEnabled,
        expectedRendererSynchronizationReceipt,
        activeSession: testing.activeSession()?.sessionId,
        coordinator: testing.diagnostics(),
        panelHydrated: testing.panelHydrated(expectedSessionId),
        activeTab: activeEditorTabDiagnostic(),
        webviews: diagnostics
      })}`
  );
}

async function exercisePackagedBackendSwitchJourney(
  testing: TestApi,
  workbench: Page,
  sessionId: string,
  fixture: vscode.Uri,
  sourceBytes: Uint8Array
): Promise<void> {
  recordAcceptanceProgress("platform-smoke:backend-switch");
  const initial = testing.activeSession();
  assert.equal(initial?.sessionId, sessionId, "The backend switch must start from the active file session.");
  assert.ok(initial, "The backend switch requires one active file session.");
  assert.equal(initial.metadata.source.kind, "file");
  assert.equal(initial.metadata.backend, "polars");
  const initialRevision = initial.metadata.revision;
  const initialSource = initial.metadata.source;
  const selectedColumn = columnReference(initial.metadata, "market");
  await testing.updateViewState(sessionId, {
    ...initial.viewState,
    columnWidths: new Map([...initial.viewState.columnWidths, [selectedColumn.id, 287]]),
    selectedColumnId: selectedColumn.id,
    viewport: { firstVisibleRow: 37, scrollLeft: 113 }
  });
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The backend-switch journey must publish its non-default view before changing engines."
  );
  const expectedViewState = testing.activeSession()?.viewState;
  assert.ok(expectedViewState, "The backend-switch journey must retain its confirmed view state.");

  const chooseBackend = async (current: "Polars" | "Pandas", next: "Polars" | "Pandas"): Promise<void> => {
    const before = testing.activeSession();
    assert.equal(before?.sessionId, sessionId);
    assert.ok(before, `Switching from ${current} requires the active file session.`);
    const app = await synchronizedSessionApp(
      workbench,
      testing,
      sessionId,
      `The ${current} renderer must acknowledge the current session before its engine badge is clicked.`
    );
    const badge = app.getByRole("button", {
      name: `Change dataframe engine. Current engine: ${current}`,
      exact: true
    });
    await badge.waitFor({ state: "visible", timeout: 10_000 });
    await badge.click();

    const picker = workbench.locator(".quick-input-widget:visible").filter({ hasText: "Dataframe engine" }).last();
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    const labels = picker.locator(".quick-input-list [role='option'] .label-name:visible");
    const matchingLabels = labels.filter({ hasText: new RegExp(`^${next}$`, "u") });
    assert.equal(await matchingLabels.count(), 1, `The engine picker must expose one exact ${next} option.`);
    await matchingLabels.first().click();
    await picker.waitFor({ state: "hidden", timeout: 10_000 });
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.backend === next.toLowerCase() &&
          active.metadata.revision > before.metadata.revision
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      `the file session to switch from ${current} to ${next}`
    );
    const switched = testing.activeSession();
    assert.equal(switched?.sessionId, sessionId, "Changing engines must retain the public session ID.");
    assert.ok(switched, `The ${next} file session must remain active.`);
    assert.equal(switched.metadata.source.uri, fixture.toString());
    assert.deepEqual(switched.metadata.source, initialSource);
    assert.deepEqual(switched.viewState, expectedViewState);
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      `Switching the file session to ${next} must not modify its source.`
    );
    await verifyBackendSwitchPhysicalView({
      sessionId,
      backend: next,
      expectedRevision: switched.metadata.revision,
      discoveryTimeoutMs: OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      activeSession: () => testing.activeSession(),
      currentReceipt: () => testing.panelSynchronizationReceipt(sessionId),
      panelHydrated: () => testing.panelHydrated(sessionId),
      requireHydration: (expectation, timeoutMs) =>
        requireFreshExactSessionPanelHydration(testing, sessionId, expectation, timeoutMs),
      assertLifecycle: () => assertOpenWranglerWebviewLifecycle(workbench, workbench.context().browser()),
      findCurrentTarget: (receipt, deadline) =>
        findCurrentOpenWranglerGridTarget(
          workbench,
          workbench.context().browser(),
          testing,
          sessionId,
          receipt,
          deadline
        ),
      bindExactApp: (target, synchronizationId) => exactSessionApp(target.frame, sessionId, synchronizationId),
      targetIsRetired: (target) => isRetiredRendererTarget(workbench, target.page, target.frame),
      withDeadline: withAcceptanceOperationDeadline,
      wait: (durationMs) => workbench.waitForTimeout(durationMs)
    });
  };

  await chooseBackend("Polars", "Pandas");
  await chooseBackend("Pandas", "Polars");
  const restored = testing.activeSession();
  assert.equal(restored?.metadata.backend, "polars");
  assert.ok((restored?.metadata.revision ?? initialRevision) > initialRevision);
}

async function exercisePrimarySortJourney(
  testing: TestApi,
  workbench: Page,
  frame: Frame,
  sessionId: string,
  checkpoint: string
): Promise<void> {
  recordAcceptanceProgress(checkpoint);
  const marketHeader = frame.locator('th[data-column="market"]').first();
  const marketMenu = marketHeader.locator("details.columnMenu").first();
  await marketMenu.getByLabel("Column actions for market").click();
  await marketMenu.getByRole("button", { name: "Sort descending", exact: true }).click();
  assert.equal(
    await marketMenu.evaluate((element) => element.hasAttribute("open")),
    false,
    "A quick-sort choice must close its column menu."
  );
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return (
        sort?.length === 1 && sort[0]?.column === "market" && sort[0].direction === "desc" && sort[0].nulls === "last"
      );
    },
    10_000,
    "the market quick sort to become the highest-priority viewing sort"
  );
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="1"]')
    .filter({ hasText: "UK & Ireland" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2400005" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await marketHeader.getByRole("button", { name: /Clear sort for market; currently descending/u }).waitFor({
    state: "visible",
    timeout: 10_000
  });

  const revenueHeader = frame.locator('th[data-column="revenue"]').first();
  const revenueMenu = revenueHeader.locator("details.columnMenu").first();
  await revenueMenu.getByLabel("Column actions for revenue").click();
  await revenueMenu.getByRole("button", { name: "Sort descending", exact: true }).click();
  assert.equal(
    await revenueMenu.evaluate((element) => element.hasAttribute("open")),
    false,
    "A later quick sort must also close its column menu."
  );
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return (
        sort?.length === 2 &&
        sort[0]?.column === "revenue" &&
        sort[0].direction === "desc" &&
        sort[0].nulls === "last" &&
        sort[1]?.column === "market" &&
        sort[1].direction === "desc" &&
        sort[1].nulls === "last"
      );
    },
    10_000,
    "the revenue quick sort to become priority 1 while retaining market as its tie-breaker"
  );
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2409089" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await marketHeader
    .getByRole("button", { name: /Clear sort for market; currently descending, priority 2 of 2/u })
    .waitFor({ state: "visible", timeout: 10_000 });
  const clearRevenueSort = revenueHeader.getByRole("button", {
    name: /Clear sort for revenue; currently descending, priority 1 of 2/u
  });
  await clearRevenueSort.waitFor({ state: "visible", timeout: 10_000 });

  await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
  const sidebar = workbench.locator(".part.sidebar:visible");
  const filtersTree = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
  if (!(await filtersTree.isVisible().catch(() => false))) {
    const filtersHeader = sidebar.getByText("Filters / Sorts", { exact: true }).first();
    await filtersHeader.waitFor({ state: "visible", timeout: 10_000 });
    await filtersHeader.click();
  }
  await filtersTree.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    testing.activeSession()?.sessionId,
    sessionId,
    "Opening the Open Wrangler Activity Bar must keep the visible dataframe session active."
  );
  assert.equal(
    testing.panelHydrated(sessionId),
    true,
    "Native sort-priority actions require the exact visible dataframe panel to remain hydrated."
  );

  const revenuePriorityOne = filtersTree
    .getByRole("treeitem", {
      name: /^revenue, Priority 1 · Descending · nulls last/u
    })
    .first();
  const marketPriorityTwo = filtersTree
    .getByRole("treeitem", {
      name: /^market, Priority 2 · Descending · nulls last/u
    })
    .first();
  await revenuePriorityOne.waitFor({ state: "visible", timeout: 10_000 });
  await marketPriorityTwo.waitFor({ state: "visible", timeout: 10_000 });
  await marketPriorityTwo.hover();
  const moveMarketUp = marketPriorityTwo.getByRole("button", { name: /Move View Sort Up$/u }).first();
  await moveMarketUp.waitFor({ state: "visible", timeout: 5_000 });
  await moveMarketUp.click();
  try {
    await waitFor(
      () => {
        const sort = testing.activeSession()?.viewState.filterModel.sort;
        return (
          sort?.length === 2 &&
          sort[0]?.column === "market" &&
          sort[0].direction === "desc" &&
          sort[0].nulls === "last" &&
          sort[1]?.column === "revenue" &&
          sort[1].direction === "desc" &&
          sort[1].nulls === "last"
        );
      },
      10_000,
      "the real Filters / Sorts move-up action to make market priority 1"
    );
  } catch (error) {
    const active = testing.activeSession();
    const retained = testing.sessionSnapshot(sessionId);
    const treeItems = await filtersTree
      .getByRole("treeitem")
      .allTextContents()
      .catch(() => ["<detached>"]);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Native sort diagnostics: ${JSON.stringify({
        expectedSessionId: sessionId,
        activeSessionId: active?.sessionId,
        activeSort: active?.viewState.filterModel.sort,
        retainedSort: retained?.viewState.filterModel.sort,
        dispatchStatus: testing.viewSortDispatchStatus(),
        panelHydrated: testing.panelHydrated(sessionId),
        coordinator: testing.diagnostics(),
        treeItems
      })}`,
      { cause: error }
    );
  }
  await filtersTree
    .getByRole("treeitem", {
      name: /^market, Priority 1 · Descending · nulls last/u
    })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await filtersTree
    .getByRole("treeitem", {
      name: /^revenue, Priority 2 · Descending · nulls last/u
    })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  const marketFirstTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  await marketFirstTarget.frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2400488" })
    .waitFor({ state: "visible", timeout: 10_000 });

  const marketPriorityOne = filtersTree
    .getByRole("treeitem", {
      name: /^market, Priority 1 · Descending · nulls last/u
    })
    .first();
  await marketPriorityOne.hover();
  const moveMarketDown = marketPriorityOne.getByRole("button", { name: /Move View Sort Down$/u }).first();
  await moveMarketDown.waitFor({ state: "visible", timeout: 5_000 });
  await moveMarketDown.click();
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return (
        sort?.length === 2 &&
        sort[0]?.column === "revenue" &&
        sort[0].direction === "desc" &&
        sort[0].nulls === "last" &&
        sort[1]?.column === "market" &&
        sort[1].direction === "desc" &&
        sort[1].nulls === "last"
      );
    },
    10_000,
    "the real Filters / Sorts move-down action to restore revenue as priority 1"
  );
  await filtersTree
    .getByRole("treeitem", {
      name: /^revenue, Priority 1 · Descending · nulls last/u
    })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await filtersTree
    .getByRole("treeitem", {
      name: /^market, Priority 2 · Descending · nulls last/u
    })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });

  const restoredTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  frame = restoredTarget.frame;
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2409089" })
    .waitFor({ state: "visible", timeout: 10_000 });
  const restoredRevenueHeader = frame.locator('th[data-column="revenue"]').first();
  const restoredMarketHeader = frame.locator('th[data-column="market"]').first();
  const restoredClearRevenueSort = restoredRevenueHeader.getByRole("button", {
    name: /Clear sort for revenue; currently descending, priority 1 of 2/u
  });
  await restoredClearRevenueSort.waitFor({ state: "visible", timeout: 10_000 });
  await restoredClearRevenueSort.click();
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return sort?.length === 1 && sort[0]?.column === "market" && sort[0].direction === "desc";
    },
    10_000,
    "clearing the primary revenue sort to retain the market tie-breaker as priority 1"
  );
  const revenueSortIndicator = restoredRevenueHeader.getByRole("button", { name: /Clear sort for revenue/u });
  await revenueSortIndicator.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(
    await revenueSortIndicator.count(),
    0,
    "Clearing one sort key must remove only that column's indicator."
  );
  const clearMarketSort = restoredMarketHeader.getByRole("button", {
    name: "Clear sort for market; currently descending",
    exact: true
  });
  await clearMarketSort.waitFor({ state: "visible", timeout: 10_000 });
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2400005" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await clearMarketSort.click();
  await waitFor(
    () => testing.activeSession()?.viewState.filterModel.sort.length === 0,
    10_000,
    "clearing the final market sort"
  );
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2400001" })
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function previewMostCommonAccountNote(app: Locator, testing: TestApi): Promise<void> {
  const active = testing.activeSession();
  assert.ok(active, "The most-common fill preview requires one active dataframe session.");
  const accountNote = columnReference(active.metadata, "account_note");
  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("fill missing");
  await dialog.getByRole("button", { name: /^Fill missing values/u }).click();
  await dialog.getByLabel("Column", { exact: true }).selectOption(accountNote.id);
  const fillMode = dialog.getByLabel("Method", { exact: true });
  await fillMode.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    await fillMode.inputValue(),
    "mostFrequent",
    "Selecting a nullable text column should choose its most useful automatic fill."
  );
  await dialog
    .getByText("Filters in the current view do not affect this calculation.", { exact: false })
    .waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const draft = testing.activeSession()?.metadata.draftStep;
      return (
        draft?.kind === "fillMissingValues" &&
        draft.params.column.id === accountNote.id &&
        draft.params.replacement.kind === "mostFrequent"
      );
    },
    30_000,
    "the most-common text fill preview"
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
}

async function previewAndDiscardPreviousRevenue(
  app: Locator,
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  revenue: ColumnReference
): Promise<Locator> {
  const active = testing.activeSession();
  assert.ok(active, "The previous-value fill preview requires one active dataframe session.");
  const orderId = columnReference(active.metadata, "order_id");
  const revenuePosition = active.metadata.schema.findIndex((column) => column.id === revenue.id);
  assert.notEqual(revenuePosition, -1);
  const revenueGapIndex = 84;
  const sourceGap = await testing.request({
    kind: "getPage",
    sessionId,
    revision: active.metadata.revision,
    viewRequestId: "platform-smoke-fill-previous-source-gap",
    offset: revenueGapIndex - 1,
    limit: 3,
    filterModel: active.viewState.filterModel,
    columnOffset: revenuePosition,
    columnLimit: 1
  });
  assert.equal(sourceGap.kind, "page");
  if (sourceGap.kind !== "page") throw new Error("The one-row revenue source gap did not resolve.");
  assert.deepEqual(sourceGap.page.columnIds, [revenue.id]);
  const previousRevenue = sourceGap.page.rows[0]?.values[0];
  assert.equal(previousRevenue?.isNull, false);
  assert.equal(sourceGap.page.rows[1]?.values[0]?.isNull, true);
  assert.equal(sourceGap.page.rows[2]?.values[0]?.isNull, false);

  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("fill missing");
  await dialog.getByRole("button", { name: /^Fill missing values/u }).click();
  await dialog.getByLabel("Column", { exact: true }).selectOption(revenue.id);
  const fillMode = dialog.getByLabel("Method", { exact: true });
  await fillMode.waitFor({ state: "visible", timeout: 10_000 });
  await fillMode.selectOption("directionalForward");
  await dialog.getByLabel("Order column 1", { exact: true }).selectOption(orderId.id);
  await dialog.getByLabel("Direction 1", { exact: true }).selectOption("asc");
  await dialog.getByLabel("Order missing values 1", { exact: true }).selectOption("last");
  await dialog.getByLabel("Maximum gap length (optional)", { exact: true }).fill("1");
  await dialog
    .getByText("Current view filters and sorts do not affect the calculation", { exact: false })
    .waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const draft = testing.activeSession()?.metadata.draftStep;
      return (
        draft?.kind === "fillMissingValues" &&
        draft.params.column.id === revenue.id &&
        isDeepStrictEqual(draft.params.replacement, {
          kind: "directional",
          direction: "forward",
          orderBy: [{ column: orderId, direction: "asc", nulls: "last" }],
          maxGap: 1
        })
      );
    },
    30_000,
    "the ordered previous-value revenue preview"
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  const preview = testing.activeSession();
  assert.ok(preview?.metadata.draftStep?.kind === "fillMissingValues");
  const code = preview.code ?? "";
  assert.match(code, /import polars as pl/u);
  assert.match(code, /_ow_polars_fill_missing_directional\(df, 'revenue'/u);
  assert.match(code, /\{'column': 'order_id', 'direction': 'asc', 'nulls': 'last'\}/u);
  assert.match(code, /'forward', 1\)/u);
  const codePreview = await waitForCodePreview(workbench, "import polars as pl");
  await revealCodePreviewOperationLine(
    codePreview,
    "_ow_polars_fill_missing_directional(df, 'revenue', " +
      "[{'column': 'order_id', 'direction': 'asc', 'nulls': 'last'}], 'forward', 1)",
    "return df"
  );
  const refreshedApp = await synchronizedSessionApp(
    workbench,
    testing,
    sessionId,
    "The previous-value preview must retain the acknowledged Open Wrangler renderer."
  );
  const previewGap = await testing.request({
    kind: "getPage",
    sessionId,
    revision: preview.metadata.revision,
    viewRequestId: "platform-smoke-fill-previous-preview-gap",
    offset: revenueGapIndex - 1,
    limit: 3,
    filterModel: preview.viewState.filterModel,
    columnOffset: revenuePosition,
    columnLimit: 1
  });
  assert.equal(previewGap.kind, "page");
  if (previewGap.kind !== "page") throw new Error("The Previous value revenue preview did not resolve.");
  assert.deepEqual(previewGap.page.columnIds, [revenue.id]);
  assert.deepEqual(
    previewGap.page.rows[1]?.values[0],
    previousRevenue,
    "Previous value must fill the isolated revenue gap from the earlier order_id row."
  );
  const review = refreshedApp.getByRole("region", { name: "Draft review" });
  await review.getByText("Fill missing values", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await review
    .locator('[aria-label="Data diff summary"]')
    .getByText(/^[1-9][\d,]* existing cells? changed(?: in this block)?$/u)
    .waitFor({ state: "visible", timeout: 10_000 });
  const discard = review.getByRole("button", { name: "Discard", exact: true });
  const schedulerBeforeDiscard = testing.sessionSchedulerState(sessionId);
  assert.equal(
    schedulerBeforeDiscard?.activeForegroundOperation,
    false,
    "The previous-value Discard action requires no earlier foreground operation."
  );
  assert.equal(
    schedulerBeforeDiscard?.interactiveQueueLength,
    0,
    "The previous-value Discard action requires an empty foreground queue."
  );
  const discardElement = await discard.elementHandle({ timeout: 10_000 });
  assert.ok(discardElement, "The previous-value draft must expose one exact Discard action.");
  const discardState = (): Record<string, unknown> => {
    const current = testing.activeSession();
    return {
      revision: current?.metadata.revision,
      previewRevision: preview.metadata.revision,
      draft: current?.metadata.draftStep?.kind,
      stepCount: current?.metadata.steps.length,
      revenueNullable: current?.metadata.schema.find((column) => column.id === revenue.id)?.nullable,
      generatedCodeLength: current?.code?.length,
      scheduler: testing.sessionSchedulerState(sessionId),
      panelHydrated: testing.panelHydrated(sessionId),
      panelSynchronizable: testing.panelSynchronizable(sessionId),
      panelReceipt: testing.panelSynchronizationReceipt(sessionId)
    };
  };
  const waitForDiscardDispatch = (): Promise<void> =>
    waitFor(
      () => {
        const current = testing.activeSession();
        const scheduler = testing.sessionSchedulerState(sessionId);
        return Boolean(
          current &&
          (current.metadata.revision > preview.metadata.revision ||
            scheduler?.activeForegroundOperation ||
            (scheduler?.interactiveQueueLength ?? 0) > 0)
        );
      },
      5_000,
      "the previous-value Discard action to reach the coordinator",
      () => JSON.stringify(discardState())
    );
  try {
    await invokeAcceptanceActionOnceWithAuthoritativeReceipt({
      description: "the previous-value draft Discard action",
      activate: () => activateExactAcceptanceElementOnce(discardElement, 10_000),
      receipt: waitForDiscardDispatch,
      authoritativeReceiptAfterActivationFailure: waitForDiscardDispatch
    });
  } finally {
    await discardElement.dispose();
  }
  await waitFor(
    () => {
      const current = testing.activeSession();
      if (!current) return false;
      return (
        current.metadata.draftStep === undefined &&
        current.metadata.steps.length === 0 &&
        current.metadata.schema.find((column) => column.id === revenue.id)?.nullable === true &&
        (current.code ?? "") === ""
      );
    },
    30_000,
    "discarding the previous-value fill preview",
    () => JSON.stringify(discardState())
  );
  await review.waitFor({ state: "hidden", timeout: 10_000 });
  await waitFor(
    () => testing.panelHydrated(sessionId),
    OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
    "the discarded previous-value state to hydrate on its automatically published renderer",
    () => JSON.stringify(discardState())
  );
  return reacquireAcknowledgedSessionApp(
    workbench,
    testing,
    sessionId,
    "The discarded previous-value preview must retain the acknowledged renderer that published its confirmed state."
  );
}

async function previewApplyAndUndoGroupedRevenue(
  app: Locator,
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  revenue: ColumnReference
): Promise<Locator> {
  const active = testing.activeSession();
  assert.ok(active, "The grouped-median preview requires one active dataframe session.");
  const market = columnReference(active.metadata, "market");
  const segment = columnReference(active.metadata, "segment");
  const revenuePosition = active.metadata.schema.findIndex((column) => column.id === revenue.id);
  assert.notEqual(revenuePosition, -1);
  const revenueGapIndex = 84;
  const gapRow = packagedScreenshotRow(revenueGapIndex);
  assert.equal(gapRow[2], "", "The installed-editor fixture must retain its grouped-fill revenue gap.");
  const groupedRevenue = Array.from({ length: PACKAGED_FIRST_USE_ROW_COUNT }, (_, index) =>
    packagedScreenshotRow(index)
  )
    .filter((row) => row[1] === gapRow[1] && row[5] === gapRow[5] && row[2] !== "")
    .map((row) => Number(row[2]))
    .sort((left, right) => left - right);
  assert.ok(groupedRevenue.length > 0, "The grouped-fill fixture must have usable values in the target group.");
  const midpoint = Math.floor(groupedRevenue.length / 2);
  const expectedMedian =
    groupedRevenue.length % 2 === 1
      ? groupedRevenue[midpoint]!
      : (groupedRevenue[midpoint - 1]! + groupedRevenue[midpoint]!) / 2;

  const sourceGap = await testing.request({
    kind: "getPage",
    sessionId,
    revision: active.metadata.revision,
    viewRequestId: "platform-smoke-fill-grouped-source-gap",
    offset: revenueGapIndex,
    limit: 1,
    filterModel: active.viewState.filterModel,
    columnOffset: revenuePosition,
    columnLimit: 1
  });
  assert.equal(sourceGap.kind, "page");
  if (sourceGap.kind !== "page") throw new Error("The grouped-median source gap did not resolve.");
  assert.deepEqual(sourceGap.page.columnIds, [revenue.id]);
  assert.equal(sourceGap.page.rows[0]?.values[0]?.isNull, true);
  const sourceRowId = sourceGap.page.rows[0]?.id;

  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("fill missing");
  await dialog.getByRole("button", { name: /^Fill missing values/u }).click();
  await dialog.getByLabel("Column", { exact: true }).selectOption(revenue.id);
  await dialog.getByLabel("Method", { exact: true }).selectOption("groupedMedian");
  const groupBy = dialog.getByRole("group", { name: "Group by", exact: true });
  const selectedKeys = groupBy.getByRole("checkbox", { checked: true });
  for (let index = (await selectedKeys.count()) - 1; index >= 0; index -= 1) {
    await selectedKeys.nth(index).uncheck();
  }
  await groupBy.getByRole("checkbox", { name: "market", exact: true }).check();
  await groupBy.getByRole("checkbox", { name: "segment", exact: true }).check();
  await dialog
    .getByText("Filters and sorts in the current view are ignored", { exact: false })
    .waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const draft = testing.activeSession()?.metadata.draftStep;
      return (
        draft?.kind === "fillMissingValues" &&
        draft.params.column.id === revenue.id &&
        isDeepStrictEqual(draft.params.replacement, {
          kind: "groupedStatistic",
          statistic: "median",
          keys: [market, segment]
        })
      );
    },
    30_000,
    "the grouped-median revenue preview"
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  const code = testing.activeSession()?.code ?? "";
  assert.match(code, /import polars as pl/u);
  assert.match(
    code,
    /_ow_polars_fill_missing_grouped_statistic\(df, ['"]revenue['"], \[['"]market['"], ['"]segment['"]\], ['"]median['"]\)/u
  );
  const codePreview = await waitForCodePreview(workbench, "import polars as pl");
  await revealCodePreviewOperationLine(
    codePreview,
    "_ow_polars_fill_missing_grouped_statistic(df, 'revenue', ['market', 'segment'], 'median')",
    "return df"
  );
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const refreshedApp = await exactSessionApp(target.frame, sessionId);
  assert.ok(refreshedApp, "The grouped-median preview must retain the exact Open Wrangler renderer.");
  const preview = testing.activeSession();
  assert.ok(preview?.metadata.draftStep?.kind === "fillMissingValues");
  const previewGap = await testing.request({
    kind: "getPage",
    sessionId,
    revision: preview.metadata.revision,
    viewRequestId: "platform-smoke-fill-grouped-preview-gap",
    offset: revenueGapIndex,
    limit: 1,
    filterModel: preview.viewState.filterModel,
    columnOffset: revenuePosition,
    columnLimit: 1
  });
  assert.equal(previewGap.kind, "page");
  if (previewGap.kind !== "page") throw new Error("The grouped-median preview gap did not resolve.");
  assert.deepEqual(previewGap.page.columnIds, [revenue.id]);
  assert.equal(previewGap.page.rows[0]?.id, sourceRowId, "Grouped filling must not reorder the source rows.");
  const previewValue = previewGap.page.rows[0]?.values[0];
  assert.ok(previewValue?.kind === "number" && previewValue.isNull === false && previewValue.isNaN === false);
  assert.ok(
    Math.abs(Number(previewValue.raw) - expectedMedian) < 1e-9,
    `Expected grouped median ${expectedMedian}, received ${String(previewValue.raw)}.`
  );

  const review = refreshedApp.getByRole("region", { name: "Draft review" });
  await review.waitFor({ state: "visible", timeout: 10_000 });
  await review
    .locator('[aria-label="Data diff summary"]')
    .getByText(/^[1-9][\d,]* existing cells? changed(?: in this block)?$/u)
    .waitFor({ state: "visible", timeout: 10_000 });
  await review.getByRole("button", { name: "Apply step", exact: true }).click();
  await waitFor(
    () => {
      const current = testing.activeSession();
      const step = current?.metadata.steps[0];
      return (
        current?.metadata.draftStep === undefined &&
        current?.metadata.steps.length === 1 &&
        step?.kind === "fillMissingValues" &&
        isDeepStrictEqual(step.params.replacement, {
          kind: "groupedStatistic",
          statistic: "median",
          keys: [market, segment]
        })
      );
    },
    30_000,
    "applying the grouped-median revenue fill"
  );
  const applied = testing.activeSession();
  assert.ok(applied, "The applied grouped-median step must keep its session active.");
  const appliedGap = await testing.request({
    kind: "getPage",
    sessionId,
    revision: applied.metadata.revision,
    viewRequestId: "platform-smoke-fill-grouped-applied-gap",
    offset: revenueGapIndex,
    limit: 1,
    filterModel: applied.viewState.filterModel,
    columnOffset: revenuePosition,
    columnLimit: 1
  });
  assert.equal(appliedGap.kind, "page");
  if (appliedGap.kind !== "page") throw new Error("The applied grouped-median gap did not resolve.");
  assert.equal(appliedGap.page.rows[0]?.id, sourceRowId);
  assert.ok(Math.abs(Number(appliedGap.page.rows[0]?.values[0]?.raw) - expectedMedian) < 1e-9);

  await refreshedApp.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const current = testing.activeSession();
      return (
        current?.metadata.steps.length === 0 &&
        current.metadata.draftStep === undefined &&
        current.metadata.schema.find((column) => column.id === revenue.id)?.nullable === true &&
        (current.code ?? "") === ""
      );
    },
    30_000,
    "undoing the grouped-median revenue fill"
  );
  const restored = testing.activeSession();
  assert.ok(restored, "Undoing grouped median must keep its session active.");
  const restoredGap = await testing.request({
    kind: "getPage",
    sessionId,
    revision: restored.metadata.revision,
    viewRequestId: "platform-smoke-fill-grouped-restored-gap",
    offset: revenueGapIndex,
    limit: 1,
    filterModel: restored.viewState.filterModel,
    columnOffset: revenuePosition,
    columnLimit: 1
  });
  assert.equal(restoredGap.kind, "page");
  if (restoredGap.kind !== "page") throw new Error("The undone grouped-median gap did not resolve.");
  assert.equal(restoredGap.page.rows[0]?.id, sourceRowId);
  assert.equal(restoredGap.page.rows[0]?.values[0]?.isNull, true);
  return refreshedApp;
}

async function exercisePackagedLinearInterpolationJourney(
  testing: TestApi,
  workbench: Page,
  fixture: vscode.Uri,
  editorName: string
): Promise<void> {
  recordAcceptanceProgress("platform-smoke:fill-linear-interpolation");
  const sourceBytes = await vscode.workspace.fs.readFile(fixture);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    15_000,
    `the ${editorName} session to close before linear interpolation`
  );

  await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitForAutomaticDelimitedImport(workbench, testing, fixture, "platform-smoke:fill-linear-import");
  const opened = testing.activeSession();
  assert.ok(opened, "The linear-interpolation fixture must open one dataframe session.");
  assert.equal(opened.metadata.backend, "polars");
  assert.deepEqual(opened.metadata.shape, { rows: 7, columns: 3 });
  const sourceRow = columnReference(opened.metadata, "source_row");
  const coordinate = columnReference(opened.metadata, "coordinate");
  const measurement = columnReference(opened.metadata, "measurement");
  const measurementPosition = opened.metadata.schema.findIndex((column) => column.id === measurement.id);
  assert.equal(measurementPosition, 2);
  assert.equal(opened.metadata.schema[measurementPosition]?.type, "float");

  const sourcePage = await testing.request({
    kind: "getPage",
    sessionId: opened.sessionId,
    revision: opened.metadata.revision,
    viewRequestId: "platform-smoke-fill-linear-source",
    offset: 0,
    limit: 7,
    filterModel: opened.viewState.filterModel,
    columnOffset: 0,
    columnLimit: 3
  });
  assert.equal(sourcePage.kind, "page");
  if (sourcePage.kind !== "page") throw new Error("The linear-interpolation source page did not resolve.");
  assert.deepEqual(sourcePage.page.columnIds, [sourceRow.id, coordinate.id, measurement.id]);
  assert.deepEqual(
    sourcePage.page.rows.map((row) => ({
      sourceRow: row.values[0]?.display,
      coordinate: Number(row.values[1]?.raw),
      measurement: row.values[2]?.isNull ? null : Number(row.values[2]?.raw)
    })),
    [
      { sourceRow: "r4", coordinate: 20, measurement: null },
      { sourceRow: "r1", coordinate: 0, measurement: 10 },
      { sourceRow: "r5", coordinate: 40, measurement: 50 },
      { sourceRow: "r2", coordinate: 5, measurement: null },
      { sourceRow: "r6", coordinate: 50, measurement: null },
      { sourceRow: "r3", coordinate: 15, measurement: null },
      { sourceRow: "r7", coordinate: 60, measurement: 70 }
    ],
    "The source must be shuffled while its interpolation coordinate remains irregular."
  );
  const sourceRowIds = sourcePage.page.rows.map((row) => row.id);

  const target = await waitForOpenWranglerGridTarget(workbench, testing, opened.sessionId);
  let app = await exactSessionApp(target.frame, opened.sessionId);
  assert.ok(app, "The linear-interpolation fixture must expose its exact Open Wrangler renderer.");
  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("fill missing");
  await dialog.getByRole("button", { name: /^Fill missing values/u }).click();
  await dialog.getByLabel("Column", { exact: true }).selectOption(measurement.id);
  const method = dialog.getByLabel("Method", { exact: true });
  await method.locator('option[value="linearInterpolation"]').waitFor({ state: "attached", timeout: 10_000 });
  await method.selectOption("linearInterpolation");
  await dialog.getByLabel("Coordinate column", { exact: true }).selectOption(coordinate.id);
  await dialog.getByLabel("Maximum missing cells in a run (optional)", { exact: true }).fill("3");
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const draft = testing.activeSession()?.metadata.draftStep;
      return (
        draft?.kind === "fillMissingValues" &&
        draft.params.column.id === measurement.id &&
        isDeepStrictEqual(draft.params.replacement, {
          kind: "linearInterpolation",
          coordinate,
          maxGap: 3
        })
      );
    },
    30_000,
    "previewing linear interpolation through the installed operation form"
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  const code = testing.activeSession()?.code ?? "";
  assert.match(code, /^import polars as pl$/mu);
  assert.ok(
    code.includes("df = _ow_polars_fill_missing_linear_interpolation(df, 'measurement', 'coordinate', 3)"),
    "Generated Polars code must call linear interpolation with the exact selected columns and gap limit."
  );
  assert.doesNotMatch(code, /\b(?:pandas|duckdb|Rscript)\b/iu);
  const codePreview = await waitForCodePreview(workbench, "import polars as pl");
  await revealCodePreviewOperationLine(
    codePreview,
    "_ow_polars_fill_missing_linear_interpolation(df, 'measurement', 'coordinate', 3)",
    "return df"
  );

  const refreshedTarget = await waitForOpenWranglerGridTarget(workbench, testing, opened.sessionId);
  app = await exactSessionApp(refreshedTarget.frame, opened.sessionId);
  assert.ok(app, "The linear-interpolation preview must retain its exact renderer.");
  const preview = testing.activeSession();
  assert.ok(preview?.metadata.draftStep?.kind === "fillMissingValues");
  const previewPage = await testing.request({
    kind: "getPage",
    sessionId: opened.sessionId,
    revision: preview.metadata.revision,
    viewRequestId: "platform-smoke-fill-linear-preview",
    offset: 0,
    limit: 7,
    filterModel: preview.viewState.filterModel,
    columnOffset: measurementPosition,
    columnLimit: 1
  });
  assert.equal(previewPage.kind, "page");
  if (previewPage.kind !== "page") throw new Error("The linear-interpolation preview page did not resolve.");
  assert.deepEqual(previewPage.page.columnIds, [measurement.id]);
  assert.deepEqual(
    previewPage.page.rows.map((row) => row.id),
    sourceRowIds,
    "Interpolation must preserve source order."
  );
  assert.deepEqual(
    previewPage.page.rows.map((row) => Number(row.values[0]?.raw)),
    [30, 10, 50, 15, 60, 25, 70],
    "Interpolation must use coordinate distance rather than source-row distance."
  );
  assert.equal(
    previewPage.page.rows.every(
      (row) => row.values[0]?.kind === "number" && !row.values[0].isNull && !row.values[0].isNaN
    ),
    true
  );
  const review = app.getByRole("region", { name: "Draft review" });
  await review.waitFor({ state: "visible", timeout: 10_000 });
  await review
    .locator('[aria-label="Data diff summary"]')
    .getByText("4 existing cells changed", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });

  await review.getByRole("button", { name: "Apply step", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const step = active?.metadata.steps[0];
      return (
        active?.metadata.draftStep === undefined &&
        active?.metadata.steps.length === 1 &&
        step?.kind === "fillMissingValues" &&
        isDeepStrictEqual(step.params.replacement, {
          kind: "linearInterpolation",
          coordinate,
          maxGap: 3
        })
      );
    },
    30_000,
    "applying linear interpolation through Draft review"
  );
  const applied = testing.activeSession();
  assert.ok(applied, "Applying linear interpolation must retain the active session.");
  const appliedPage = await testing.request({
    kind: "getPage",
    sessionId: opened.sessionId,
    revision: applied.metadata.revision,
    viewRequestId: "platform-smoke-fill-linear-applied",
    offset: 0,
    limit: 7,
    filterModel: applied.viewState.filterModel,
    columnOffset: measurementPosition,
    columnLimit: 1
  });
  assert.equal(appliedPage.kind, "page");
  if (appliedPage.kind !== "page") throw new Error("The applied linear-interpolation page did not resolve.");
  assert.deepEqual(
    appliedPage.page.rows.map((row) => row.id),
    sourceRowIds
  );
  assert.deepEqual(
    appliedPage.page.rows.map((row) => Number(row.values[0]?.raw)),
    [30, 10, 50, 15, 60, 25, 70]
  );
  assertExactBytes(
    await vscode.workspace.fs.readFile(fixture),
    sourceBytes,
    "Applying linear interpolation must not modify the source CSV."
  );

  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.steps.length === 0 && active.metadata.draftStep === undefined && (active.code ?? "") === ""
      );
    },
    30_000,
    "undoing linear interpolation through the installed editor"
  );
  const restored = testing.activeSession();
  assert.ok(restored, "Undoing linear interpolation must retain the active session.");
  const restoredPage = await testing.request({
    kind: "getPage",
    sessionId: opened.sessionId,
    revision: restored.metadata.revision,
    viewRequestId: "platform-smoke-fill-linear-restored",
    offset: 0,
    limit: 7,
    filterModel: restored.viewState.filterModel,
    columnOffset: 0,
    columnLimit: 3
  });
  assert.equal(restoredPage.kind, "page");
  if (restoredPage.kind !== "page") throw new Error("The undone linear-interpolation page did not resolve.");
  assert.deepEqual(restoredPage.page.columnIds, sourcePage.page.columnIds);
  assert.deepEqual(
    restoredPage.page.rows,
    sourcePage.page.rows,
    "Undo must restore the exact source values and row order."
  );
  assertExactBytes(
    await vscode.workspace.fs.readFile(fixture),
    sourceBytes,
    "Previewing, applying, and undoing linear interpolation must preserve the source CSV bytes."
  );

  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    15_000,
    `the ${editorName} linear-interpolation session and runtime to terminate`
  );
}

async function previewUppercaseMarket(app: Locator, testing: TestApi, newColumn: string): Promise<void> {
  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("uppercase");
  await dialog.getByRole("button", { name: /^Uppercase/u }).click();
  const textColumn = dialog.getByLabel("Text column", { exact: true });
  await textColumn.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(
    (await textColumn.locator("option:checked").innerText()).trim(),
    /^market$/u,
    "The Uppercase form should show the unique source name without positional noise."
  );
  await dialog.getByLabel("Output column (blank replaces in place)", { exact: true }).fill(newColumn);
  const commands = new Set(await vscode.commands.getCommands(true));
  if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
  if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () =>
      testing.activeSession()?.metadata.draftStep?.kind === "upperText" &&
      testing.activeSession()?.metadata.schema.some((column) => column.name === newColumn) === true,
    30_000,
    `the uppercase preview for ${newColumn}`
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
}

async function previewRevenueProjection(app: Locator, testing: TestApi, newColumn: string): Promise<void> {
  const active = testing.activeSession();
  assert.ok(active, "The revenue projection preview requires one active dataframe session.");
  const revenue = columnReference(active.metadata, "revenue");
  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("formula");
  await dialog.getByRole("button", { name: /^Formula column/u }).click();
  await dialog.getByLabel("Left column", { exact: true }).selectOption(revenue.id);
  await dialog.getByLabel("Operator", { exact: true }).selectOption("add");
  await dialog.getByLabel("Numeric value", { exact: true }).fill("500");
  await dialog.getByLabel("New column", { exact: true }).fill(newColumn);
  const commands = new Set(await vscode.commands.getCommands(true));
  if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
  if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  try {
    await waitFor(
      () =>
        testing.activeSession()?.metadata.draftStep?.kind === "formula" &&
        testing.activeSession()?.metadata.schema.some((column) => column.name === newColumn) === true,
      30_000,
      `the revenue projection preview for ${newColumn}`
    );
  } catch (error) {
    const state = testing.activeSession();
    const alerts = await app.getByRole("alert").allTextContents();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify({
        revision: state?.metadata.revision,
        steps: state?.metadata.steps.map((step) => step.kind),
        draft: state?.metadata.draftStep?.kind,
        schema: state?.metadata.schema.map((column) => column.name),
        alerts
      })}`
    );
  }
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
}

function assertParquetFile(filePath: string, label: string): void {
  const bytes = readFileSync(filePath);
  assert.ok(bytes.byteLength >= 8, `${label} must contain a complete Parquet file.`);
  assert.equal(bytes.subarray(0, 4).toString("utf8"), "PAR1", `${label} has an invalid Parquet header.`);
  assert.equal(bytes.subarray(-4).toString("utf8"), "PAR1", `${label} has an invalid Parquet footer.`);
}

async function requireFreshExactSessionPanelHydration(
  testing: TestApi,
  sessionId: string,
  expectation: string,
  timeoutMs = OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS
): Promise<void> {
  return requireFreshExactSessionPanelHydrationOwner(testing, sessionId, expectation, {
    timeoutMs,
    diagnosticState: () => ({
      expectedSessionId: sessionId,
      activeSessionId: testing.activeSession()?.sessionId,
      activeRevision: testing.activeSession()?.metadata.revision,
      panelHydrated: testing.panelHydrated(sessionId),
      panelSynchronizable: testing.panelSynchronizable(sessionId),
      panelSynchronizationReceipt: testing.panelSynchronizationReceipt(sessionId),
      activeTab: activeEditorTabDiagnostic()
    })
  });
}

async function waitForLocatorText(
  locator: Locator,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  expectation: string,
  diagnostics?: (lastText: string) => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  do {
    lastText = await locator.innerText();
    if (predicate(lastText)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const state = diagnostics?.(lastText);
  throw new Error(`Timed out waiting for ${expectation}.${state ? ` State: ${state}` : ""}`);
}

async function waitForLocatorCount(
  locator: Locator,
  expectedCount: number,
  timeoutMs: number,
  expectation: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await locator.count()) === expectedCount) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${expectation}; found ${await locator.count()}.`);
}

async function waitForSettledViewState(testing: TestApi, expectation: string): Promise<void> {
  const started = Date.now();
  // The coordinator snapshot can become active before the newly mounted Electron
  // webview reports its browser-quantized physical scroll position. Wait across
  // the webview debounce and a full render quiet period so inspection compares
  // two confirmed UI states rather than racing that initial report.
  const stableForMs = 1_200;
  let previous = "";
  let unchangedSince = started;
  while (Date.now() - started <= 10_000) {
    const active = testing.activeSession();
    const current = active
      ? JSON.stringify({
          ...active.viewState,
          columnWidths: [...active.viewState.columnWidths]
        })
      : "";
    if (current !== previous) {
      previous = current;
      unchangedSince = Date.now();
    } else if (active && Date.now() - unchangedSince >= stableForMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expectation}.`);
}

async function assertOpenWranglerTabBrandIcon(tab: Locator): Promise<void> {
  await tab.waitFor({ state: "visible", timeout: WORKBENCH_OPERATION_TIMEOUT_MS });
  const expectedFileName =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
      ? "action-icon-light.svg"
      : "action-icon-dark.svg";
  const iconReferences = await tab.evaluate((root, expectedIcon) => {
    const references: Array<{
      reference: string;
      visible: boolean;
      source: string;
      matchesExpectedIcon: boolean;
      className: string;
    }> = [];
    const browserWindow = root.ownerDocument.defaultView;
    if (!browserWindow) return references;
    for (const element of [root, ...root.querySelectorAll("*")]) {
      const bounds = element.getBoundingClientRect();
      const elementStyle = browserWindow.getComputedStyle(element);
      const elementIsVisible =
        bounds.width > 0 &&
        bounds.height > 0 &&
        elementStyle.display !== "none" &&
        elementStyle.visibility !== "hidden" &&
        Number.parseFloat(elementStyle.opacity || "1") > 0;
      const imageSource = element.tagName.toLowerCase() === "img" ? element.getAttribute("src") : null;
      if (imageSource) {
        references.push({
          reference: imageSource,
          visible: elementIsVisible,
          source: "image",
          matchesExpectedIcon: imageSource.includes(expectedIcon),
          className: element.className
        });
      }
      for (const pseudo of [undefined, "::before", "::after"] as const) {
        const style = browserWindow.getComputedStyle(element, pseudo);
        for (const value of [style.backgroundImage, style.maskImage]) {
          if (value && value !== "none") {
            references.push({
              reference: value,
              visible:
                elementIsVisible &&
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number.parseFloat(style.opacity || "1") > 0,
              source: pseudo ?? "element",
              matchesExpectedIcon: value.includes(expectedIcon),
              className: element.className
            });
          }
        }
      }
    }
    return references;
  }, expectedFileName);
  assert.ok(
    iconReferences.some(({ visible, matchesExpectedIcon }) => visible && matchesExpectedIcon),
    `The Open Wrangler custom-editor tab must visibly use ${expectedFileName} for the active theme, not a generic or wrong-theme file glyph. Observed matching references: ${JSON.stringify(iconReferences)}.`
  );
}

interface ContextMenuDiagnostic {
  attempt: number;
  menus: Array<{
    text: string;
    items: Array<{ role: string | null; text: string; ariaLabel: string | null; labelAriaLabel: string | null }>;
  }>;
}

async function openEditorTabContextMenu(
  page: Page,
  tab: Locator,
  requiredActionName?: string
): Promise<{ menu: Locator; action?: Locator }> {
  return openWorkbenchContextMenu(page, tab, requiredActionName, "editor tab");
}

async function openWorkbenchContextMenu(
  page: Page,
  target: Locator,
  requiredActionName: string | undefined,
  surface: string
): Promise<{ menu: Locator; action?: Locator }> {
  const diagnostics: ContextMenuDiagnostic[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.keyboard.press("Escape");
    const visibleMenus = page.locator(".context-view.monaco-menu-container:visible");
    await visibleMenus.waitFor({ state: "hidden", timeout: 1_000 }).catch(() => {});
    await target.click({ button: "right" });

    const menu = visibleMenus.last();
    const action = requiredActionName
      ? menu.getByRole("menuitem", { name: requiredActionName, exact: true }).last()
      : undefined;
    try {
      await menu.waitFor({ state: "visible", timeout: 3_000 });
      if (action) await action.waitFor({ state: "visible", timeout: 3_000 });
      // VS Code intentionally attaches a menu item's mouse-up handler after a
      // 100 ms guard so the click that opened the menu cannot also invoke it.
      await page.waitForTimeout(200);
      return { menu, action };
    } catch (error) {
      lastError = error;
      diagnostics.push({ attempt, menus: await inspectVisibleContextMenus(page) });
    }
  }

  throw new Error(
    `The ${surface} context menu did not expose ${
      requiredActionName ? JSON.stringify(requiredActionName) : "a visible HTML menu"
    } after two right-click attempts. Visible menu diagnostics: ${JSON.stringify(diagnostics)}`,
    { cause: lastError }
  );
}

async function inspectVisibleContextMenus(page: Page): Promise<ContextMenuDiagnostic["menus"]> {
  return page.locator(".context-view.monaco-menu-container:visible").evaluateAll((menus) =>
    menus.map((menu) => ({
      text: (menu.textContent ?? "").replace(/\s+/gu, " ").trim(),
      items: Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((item) => {
        const element = item as typeof menu;
        return {
          role: element.getAttribute("role"),
          text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
          ariaLabel: element.getAttribute("aria-label"),
          labelAriaLabel: element.querySelector(".action-label")?.getAttribute("aria-label") ?? null
        };
      })
    }))
  );
}

interface CustomEditorFrameDiagnostic {
  page: string;
  frame: string;
  markerCount: number;
  visibleMarkerCount: number;
}

async function waitForThirdPartyCustomEditorWorkbench(
  page: Page,
  activeEditorGroup: Locator,
  fixture: vscode.Uri
): Promise<Locator> {
  const activeTab = activeEditorGroup
    .locator(".tabs-container .tab.active")
    .filter({ hasText: path.basename(fixture.fsPath) })
    .last();
  const titleAction = activeEditorGroup.locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible');
  const deadline = Date.now() + 10_000;
  do {
    const frames = await inspectThirdPartyCustomEditorFrames(page);
    if (
      (await activeTab.isVisible().catch(() => false)) &&
      frames.some((frame) => frame.visibleMarkerCount === 1) &&
      (await titleAction.count()) === 1
    ) {
      return titleAction.first();
    }
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);

  const activeTabs = await page
    .locator(".part.editor .tabs-container .tab.active:visible")
    .allInnerTexts()
    .catch(() => []);
  const visibleEditorLabels = await activeEditorGroup
    .locator("[aria-label]:visible")
    .evaluateAll((elements) => elements.slice(0, 64).map((element) => element.getAttribute("aria-label")))
    .catch(() => []);
  throw new Error(
    `The third-party CSV editor did not become renderer-active before its title action was used. ` +
      `Expected URI: ${JSON.stringify(fixture.toString())}. Active workbench tabs: ${JSON.stringify(activeTabs)}. ` +
      `Visible editor labels: ${JSON.stringify(visibleEditorLabels)}. Webview frames: ${JSON.stringify(await inspectThirdPartyCustomEditorFrames(page))}.`
  );
}

async function inspectThirdPartyCustomEditorFrames(page: Page): Promise<CustomEditorFrameDiagnostic[]> {
  const browser = page.context().browser();
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [page];
  const diagnostics = await Promise.all(
    pages.slice(0, 16).flatMap((candidate) =>
      candidate
        .frames()
        .slice(0, 32)
        .map(async (frame) => {
          const markers = frame.locator('[aria-label="Acceptance CSV Editor"]');
          const markerCount = await markers.count().catch(() => 0);
          let visibleMarkerCount = 0;
          for (let index = 0; index < markerCount; index += 1) {
            if (
              await markers
                .nth(index)
                .isVisible()
                .catch(() => false)
            )
              visibleMarkerCount += 1;
          }
          return {
            page: candidate.url(),
            frame: frame.url(),
            markerCount,
            visibleMarkerCount
          };
        })
    )
  );
  return diagnostics.filter((diagnostic) => diagnostic.markerCount > 0);
}

async function waitForAutomaticDelimitedImport(
  page: Page,
  testing: TestApi,
  expectedSource: vscode.Uri,
  checkpointPrefix: string
): Promise<void> {
  recordAcceptanceProgress(`${checkpointPrefix}:automatic-detection`);
  const deadline = Date.now() + SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS;
  do {
    const quickInputs = page.locator(".quick-input-widget:visible");
    const count = await quickInputs.count().catch(() => 0);
    if (count > 0) {
      const labels = await quickInputs
        .allInnerTexts()
        .then((values) => values.slice(0, 8).map((value) => value.replace(/\s+/gu, " ").trim()))
        .catch(() => []);
      throw new Error(
        `Opening ${JSON.stringify(expectedSource.toString())} exposed an initial Quick Input instead of using automatic import detection. Visible Quick Inputs: ${JSON.stringify(labels)}.`
      );
    }
    if (testing.activeSession()?.metadata.source.uri === expectedSource.toString()) {
      recordAcceptanceProgress(`${checkpointPrefix}:automatic-detection-complete`);
      return;
    }
    await page.waitForTimeout(25);
  } while (Date.now() < deadline);
  throw new Error(
    `Automatic import detection did not open ${JSON.stringify(expectedSource.toString())} before the launch deadline.`
  );
}

async function boundedImportOptionDiagnostics(quickInput: Locator): Promise<unknown> {
  try {
    return await withAcceptanceOperationDeadline(
      quickInput.getByRole("option").evaluateAll((options) =>
        options.map((candidate) => ({
          label: candidate.getAttribute("aria-label"),
          className: candidate.getAttribute("class")
        }))
      ),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "import-option diagnostics"
    );
  } catch {
    return "unavailable within the diagnostics deadline";
  }
}

type ImportFocusRelationship = "contains" | "exact";

async function waitForImportNaturalKeyboardFocus(
  target: Locator,
  title: string,
  relationship: ImportFocusRelationship
): Promise<void> {
  const focused = await withAcceptanceOperationDeadline(
    pollAcceptanceCondition(
      () =>
        target.evaluate(
          (element, expectedRelationship) => {
            const activeElement = element.ownerDocument.activeElement;
            return expectedRelationship === "exact" ? element === activeElement : element.contains(activeElement);
          },
          relationship,
          { timeout: IMPORT_FOCUS_PROBE_TIMEOUT_MS }
        ),
      {
        timeoutMs: IMPORT_FOCUS_POLL_TIMEOUT_MS,
        intervalMs: IMPORT_FOCUS_POLL_INTERVAL_MS
      }
    ),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${title} natural keyboard focus`
  );
  if (focused) return;

  const diagnostics = await boundedImportFocusDiagnostics(target, relationship);
  throw new Error(
    `${title} did not naturally receive keyboard focus within ${IMPORT_FOCUS_POLL_TIMEOUT_MS} ms. ` +
      `Structural focus diagnostics: ${JSON.stringify(diagnostics)}`
  );
}

async function boundedImportFocusDiagnostics(target: Locator, relationship: ImportFocusRelationship): Promise<unknown> {
  try {
    return await withAcceptanceOperationDeadline(
      target.evaluate(
        (element, expectedRelationship) => {
          const activeElement = element.ownerDocument.activeElement;
          return {
            targetConnected: element.isConnected,
            targetOwnsFocus:
              expectedRelationship === "exact" ? element === activeElement : element.contains(activeElement),
            activeElement:
              activeElement === null
                ? null
                : {
                    tagName: activeElement.tagName.slice(0, 32),
                    role: activeElement.getAttribute("role")?.slice(0, 64) ?? null,
                    classTokens: Array.from(activeElement.classList as ArrayLike<string>)
                      .slice(0, 8)
                      .map((token) => token.slice(0, 64))
                  }
          };
        },
        relationship,
        { timeout: WORKBENCH_DIAGNOSTIC_TIMEOUT_MS }
      ),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "import focus diagnostics"
    );
  } catch {
    return "unavailable within the diagnostics deadline";
  }
}

async function waitForImportQuickInput(
  page: Page,
  testing: TestApi,
  expectedSource: vscode.Uri,
  title: string,
  existingSessionId?: string
): Promise<Locator> {
  const quickInput = page.locator(".quick-input-widget:visible").filter({ hasText: title }).last();
  const deadline = Date.now() + 10_000;
  do {
    if (
      await withAcceptanceOperationDeadline(
        quickInput.isVisible(),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        `${title} prompt visibility`
      )
    ) {
      return quickInput;
    }
    const active = testing.activeSession();
    if (active && active.sessionId !== existingSessionId) {
      throw new Error(
        `The import-options action created a dataframe session before the ${JSON.stringify(title)} prompt appeared. ` +
          `Expected source: ${JSON.stringify(expectedSource.fsPath)}. Actual source: ${JSON.stringify(active.metadata.source.path)}.`
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  const compactText = (value: string): string => value.replace(/\s+/gu, " ").trim().slice(0, 1_000);
  const diagnostics = await boundedImportPromptDiagnostics(page);
  const hostInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const activeSession = testing.activeSession();
  throw new Error(
    `The ${JSON.stringify(title)} import prompt did not appear after the import-options action. ` +
      `Expected source: ${JSON.stringify(expectedSource.toString())}. ` +
      `Active host input: ${JSON.stringify(describeTabInput(hostInput))}. ` +
      `Active dataframe source: ${JSON.stringify(activeSession?.metadata.source.uri)}. ` +
      `Visible quick inputs: ${JSON.stringify(diagnostics.quickInputs.map(compactText))}. ` +
      `Notifications: ${JSON.stringify(diagnostics.notifications.map(compactText))}. ` +
      `Dialogs: ${JSON.stringify(diagnostics.dialogs.map(compactText))}. ` +
      `Active workbench tabs: ${JSON.stringify(diagnostics.activeTabs.map(compactText))}. ` +
      `Webview frames: ${JSON.stringify(diagnostics.frames)}.`
  );
}

interface ImportPromptDiagnostics {
  quickInputs: string[];
  notifications: string[];
  dialogs: string[];
  activeTabs: string[];
  frames: CustomEditorFrameDiagnostic[] | string;
}

async function boundedImportPromptDiagnostics(page: Page): Promise<ImportPromptDiagnostics> {
  const unavailable: ImportPromptDiagnostics = {
    quickInputs: [],
    notifications: [],
    dialogs: [],
    activeTabs: [],
    frames: "unavailable within the diagnostics deadline"
  };
  try {
    return await withAcceptanceOperationDeadline(
      Promise.all([
        page.locator(".quick-input-widget:visible").allInnerTexts(),
        page
          .locator(
            ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
          )
          .allInnerTexts(),
        page.locator(".monaco-dialog-box:visible").allInnerTexts(),
        page.locator(".part.editor .tabs-container .tab.active:visible").allInnerTexts(),
        inspectThirdPartyCustomEditorFrames(page)
      ]).then(([quickInputs, notifications, dialogs, activeTabs, frames]) => ({
        quickInputs: quickInputs.slice(0, 8),
        notifications: notifications.slice(0, 8),
        dialogs: dialogs.slice(0, 8),
        activeTabs: activeTabs.slice(0, 8),
        frames
      })),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "import-prompt diagnostics"
    );
  } catch {
    return unavailable;
  }
}

function describeTabInput(input: unknown): unknown {
  if (input instanceof vscode.TabInputText) return { kind: "text", uri: input.uri.toString() };
  if (input instanceof vscode.TabInputTextDiff) {
    return { kind: "textDiff", original: input.original.toString(), modified: input.modified.toString() };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { kind: "custom", viewType: input.viewType, uri: input.uri.toString() };
  }
  return input === undefined ? undefined : { kind: typeof input };
}

let editorWorkbenchPage: Promise<Page> | undefined;

async function connectToEditorWorkbench(): Promise<Page> {
  editorWorkbenchPage ??= connectToEditorWorkbenchOnce();
  return editorWorkbenchPage;
}

async function connectToEditorWorkbenchOnce(): Promise<Page> {
  const cdpPort = Number(process.env.OPEN_WRANGLER_EDITOR_CDP_PORT);
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 0, "Editor workbench interaction requires a CDP port.");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const page of pages) {
    if ((await page.locator(".monaco-workbench").count()) > 0) return page;
  }
  const workbench = pages.find((page) => page.url().includes("workbench"));
  assert.ok(workbench, "The editor CDP endpoint must expose its workbench page.");
  return workbench;
}

async function waitForVisibleEditorDialog(workbench: Page, text: string): Promise<{ page: Page; dialog: Locator }> {
  const deadline = Date.now() + 10_000;
  do {
    const browser = workbench.context().browser();
    const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
    for (const page of pages) {
      const dialog = page.locator(".monaco-dialog-box:visible").filter({ hasText: text }).last();
      if ((await dialog.count()) > 0 && (await dialog.isVisible())) return { page, dialog };
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  const diagnostics = await Promise.all(
    pages.map(async (page) => ({
      url: page.url(),
      title: await page.title().catch(() => ""),
      dialogs: await page.locator(".monaco-dialog-box:visible").allInnerTexts()
    }))
  );
  throw new Error(
    `Timed out waiting for the real editor dialog containing ${JSON.stringify(text)}: ${JSON.stringify(diagnostics)}`
  );
}

async function prepareReleasedJupyterScreenshotWorkbench(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  editor: vscode.NotebookEditor,
  options: { readonly isolateShowcaseCell?: boolean } = {}
): Promise<() => Promise<void>> {
  if (process.platform !== "linux") return async () => {};
  const previousViewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  const previousThemeKind = vscode.window.activeColorTheme.kind;
  await workbench.setViewportSize(PACKAGED_PANDAS_NOTEBOOK_VIEWPORT);
  const viewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  assert.deepEqual(
    viewport,
    PACKAGED_PANDAS_NOTEBOOK_VIEWPORT,
    "Notebook README evidence requires the deterministic packaged-editor viewport."
  );

  const workbenchConfiguration = vscode.workspace.getConfiguration("workbench");
  const breadcrumbs = vscode.workspace.getConfiguration("breadcrumbs");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const settings = [
    { configuration: windowConfiguration, key: "autoDetectColorScheme" },
    { configuration: windowConfiguration, key: "autoDetectHighContrast" },
    { configuration: windowConfiguration, key: "commandCenter" },
    { configuration: windowConfiguration, key: "title" },
    { configuration: workbenchConfiguration, key: "colorTheme" },
    { configuration: workbenchConfiguration, key: "statusBar.visible" },
    { configuration: breadcrumbs, key: "enabled" }
  ] as const;
  const previousSettings = settings.map(({ configuration, key }) => ({
    configuration,
    key,
    value: configuration.inspect(key)?.globalValue
  }));
  await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
  await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
  await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
  await windowConfiguration.update(
    "title",
    "${activeEditorShort}${separator}Open Wrangler",
    vscode.ConfigurationTarget.Global
  );
  await workbenchConfiguration.update(
    "colorTheme",
    releasedJupyterScreenshotTheme(),
    vscode.ConfigurationTarget.Global
  );
  await workbenchConfiguration.update("statusBar.visible", false, vscode.ConfigurationTarget.Global);
  await breadcrumbs.update("enabled", false, vscode.ConfigurationTarget.Global);
  await waitFor(
    () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
    10_000,
    "the dark notebook screenshot theme"
  );

  await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
    "workbench.action.closeSidebar",
    "workbench.action.toggleSidebarVisibility"
  ]);
  await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.toggleAuxiliaryBar"
  ]);
  await closeVisibleWorkbenchPart(workbench, ".part.panel", [
    "workbench.action.closePanel",
    "workbench.action.togglePanel"
  ]);
  await clearReleasedJupyterScreenshotTransientUi(workbench);
  const visibleEditor = await showExactReleasedNotebook(notebook);
  assert.equal(visibleEditor, editor, "Notebook screenshot preparation must retain the exact originating editor.");
  if (options.isolateShowcaseCell) {
    const requiredCommands = ["notebook.cell.collapseCellInput", "notebook.cell.collapseCellOutput"] as const;
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of requiredCommands) {
      assert.ok(commands.has(command), `Notebook screenshot isolation requires the built-in ${command} command.`);
    }
    for (const internalIndex of [0, 3, 4]) {
      const internalCell = new vscode.NotebookRange(internalIndex, internalIndex + 1);
      editor.selection = internalCell;
      editor.selections = [internalCell];
      editor.revealRange(internalCell, vscode.NotebookEditorRevealType.InCenter);
      await waitFor(
        () => editor.visibleRanges.some((visible) => visible.start <= internalIndex && visible.end > internalIndex),
        WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
        `the private notebook cell ${internalIndex} to become visible before it is collapsed`
      );
      await vscode.commands.executeCommand(requiredCommands[0]);
      await vscode.commands.executeCommand(requiredCommands[1]);
    }
  }
  const renderedCell = new vscode.NotebookRange(1, 2);
  editor.selection = renderedCell;
  editor.selections = [renderedCell];
  if (options.isolateShowcaseCell) {
    assertExactVisibleReleasedNotebookEditor(notebook, editor, "before isolating the public notebook showcase cell");
  }
  editor.revealRange(renderedCell, vscode.NotebookEditorRevealType.AtTop);
  await workbench.waitForTimeout(600);
  if (options.isolateShowcaseCell) {
    assert.equal(
      editor.visibleRanges.some((visible) => visible.start <= renderedCell.start && visible.end > renderedCell.start),
      true,
      "The public notebook showcase cell must be visible before its media journey begins."
    );
  }
  return async () => {
    for (const { configuration, key, value } of previousSettings.reverse()) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await workbench.setViewportSize(previousViewport);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === previousThemeKind,
      10_000,
      "the notebook workbench to restore its prior color theme"
    );
    await workbench.waitForTimeout(1_000);
  };
}

async function prepareReleasedRNotebookScreenshotWorkbench(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  editor: vscode.NotebookEditor
): Promise<() => Promise<void>> {
  const restore = await prepareReleasedJupyterScreenshotWorkbench(workbench, notebook, editor);
  try {
    await workbench.setViewportSize(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT);
    assert.deepEqual(
      await workbench.evaluate(() => {
        const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
        return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
      }),
      PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
      "The R notebook Operations scene requires the standard 1440 by 900 editor viewport."
    );
    const requiredCommands = ["notebook.cell.collapseCellInput", "notebook.cell.collapseCellOutput"] as const;
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of requiredCommands) {
      assert.ok(commands.has(command), `R notebook media requires the built-in ${command} command.`);
    }
    for (const privateIndex of [
      RELEASED_JUPYTER_R_KERNEL_CELL,
      RELEASED_JUPYTER_R_SETUP_CELL,
      RELEASED_JUPYTER_R_BINDING_CELL,
      RELEASED_JUPYTER_R_MEDIA_CELL
    ]) {
      const privateCell = new vscode.NotebookRange(privateIndex, privateIndex + 1);
      editor.selection = privateCell;
      editor.selections = [privateCell];
      editor.revealRange(privateCell, vscode.NotebookEditorRevealType.InCenter);
      await vscode.commands.executeCommand(requiredCommands[0]);
      await vscode.commands.executeCommand(requiredCommands[1]);
    }
    const publicCell = new vscode.NotebookRange(RELEASED_JUPYTER_R_SHOWCASE_CELL, RELEASED_JUPYTER_R_SHOWCASE_CELL + 1);
    editor.selection = publicCell;
    editor.selections = [publicCell];
    editor.revealRange(publicCell, vscode.NotebookEditorRevealType.AtTop);
    await waitFor(
      () =>
        editor.visibleRanges.some(
          (visible) =>
            visible.start <= RELEASED_JUPYTER_R_SHOWCASE_CELL && visible.end > RELEASED_JUPYTER_R_SHOWCASE_CELL
        ),
      WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
      "the public R notebook cell to be visible before Operations capture"
    );
    await workbench.waitForTimeout(600);
    await assertReleasedRPrivateNotebookContentHidden(workbench);
    return restore;
  } catch (error) {
    await restore();
    throw error;
  }
}

async function captureReleasedRJupyterOperations(
  workbench: Page,
  sidebar: Locator,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  assert.equal(path.isAbsolute(outputDirectory), true, "R notebook screenshot output must be one absolute directory.");
  const operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
  const expected = [
    ["orders_frame", "R · data.frame"],
    ["orders_tibble", "R · tibble"],
    ["orders_table", "R · data.table"],
    ["collapse_frame", "R · data.frame"],
    ["collapse_tibble", "R · tibble"],
    ["collapse_table", "R · data.table"]
  ] as const;
  for (const [name, typeLabel] of expected) {
    const row = operations.getByRole("treeitem", { name: new RegExp(`^${name}\\b`, "u") }).first();
    await row.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    const label = (await row.innerText()).replace(/\s+/gu, " ");
    assert.ok(label.includes(typeLabel), `R notebook Operations must label ${name} as ${typeLabel}.`);
  }
  await assertPackagedProductSidebarGeometry(sidebar);
  await assertReleasedRPrivateNotebookContentHidden(workbench);
  mkdirSync(outputDirectory, { recursive: true });
  recordAcceptanceProgress("jupyter-r:screenshot:operations");
  await captureNotebookWorkbenchScreenshot(
    workbench,
    path.resolve(
      outputDirectory,
      packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-r-operations", "dark")
    )
  );
}

async function assertReleasedRPrivateNotebookContentHidden(workbench: Page): Promise<void> {
  const exposed = await workbench.locator("body").evaluate(
    (body, prohibited) => {
      type TextElement = {
        readonly children: ArrayLike<TextElement>;
        readonly textContent: string | null;
        getBoundingClientRect(): { bottom: number; height: number; left: number; top: number; width: number };
      };
      type TextBody = TextElement & { querySelectorAll(selector: string): ArrayLike<TextElement> };
      const page = globalThis as unknown as {
        getComputedStyle(element: TextElement): { display: string; visibility: string };
        innerHeight: number;
        innerWidth: number;
      };
      return Array.from((body as unknown as TextBody).querySelectorAll("*")).flatMap((element) => {
        const marker = prohibited.find((candidate) => element.textContent?.includes(candidate));
        if (!marker) return [];
        if (Array.from(element.children).some((child) => child.textContent?.includes(marker))) return [];
        const style = page.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return [];
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.left < page.innerWidth &&
          bounds.top < page.innerHeight &&
          bounds.bottom > 0
          ? [marker]
          : [];
      });
    },
    [
      RELEASED_JUPYTER_R_KERNEL_RESULT,
      RELEASED_JUPYTER_R_SETUP_RESULT,
      RELEASED_JUPYTER_R_BINDING_RESULT,
      RELEASED_JUPYTER_R_MEDIA_RESULT,
      "orders_frame_before",
      "regional_orders_before",
      R_KERNEL_RUNTIME_BINDING
    ]
  );
  assert.deepEqual(exposed, [], "R notebook media must not expose acceptance markers or private binding probes.");
}

async function captureReleasedJupyterPandasPreview(
  workbench: Page,
  rendererButton: NotebookRendererButton,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  assert.equal(path.isAbsolute(outputDirectory), true, "Notebook screenshot output must be one absolute directory.");
  const preview = await rendererButton.evaluate((element) => {
    type PreviewElement = {
      readonly clientHeight: number;
      readonly clientTop: number;
      readonly clientWidth: number;
      readonly parentElement: PreviewElement | null;
      readonly scrollLeft: number;
      readonly scrollHeight: number;
      readonly scrollWidth: number;
      readonly textContent: string | null;
      closest(selector: string): PreviewElement | null;
      getBoundingClientRect(): {
        bottom: number;
        height: number;
        left: number;
        right: number;
        top: number;
        width: number;
      };
      querySelector(selector: string): PreviewElement | null;
      querySelectorAll(selector: string): ArrayLike<PreviewElement>;
    };
    type PreviewSelectElement = PreviewElement & {
      readonly ownerDocument: {
        readonly defaultView: {
          readonly Event: new (type: string, init: { readonly bubbles: boolean }) => object;
        } | null;
      };
      value: string;
      dispatchEvent(event: object): boolean;
    };
    const button = element as PreviewElement;
    const section = button.closest("section.openwrangler-notebook");
    if (!section) return null;
    const pageSize = section.querySelector(
      'select[aria-label="Rows per notebook preview page"]'
    ) as PreviewSelectElement | null;
    if (!pageSize) return null;
    const EventConstructor = pageSize.ownerDocument.defaultView?.Event;
    if (!EventConstructor) return null;
    // Drive the renderer's real public control so the capture contains an
    // integral page instead of the first sliver of an eleventh table row.
    pageSize.value = "10";
    pageSize.dispatchEvent(new EventConstructor("change", { bubbles: true }));
    const bounds = section.getBoundingClientRect();
    const table = section.querySelector("table");
    const scroller = table?.parentElement;
    if (!table || !scroller) return null;
    const scrollerBounds = scroller.getBoundingClientRect();
    const contentTop = scrollerBounds.top + scroller.clientTop;
    const contentBottom = Math.min(scrollerBounds.bottom, contentTop + scroller.clientHeight);
    const headers = Array.from(table.querySelectorAll("thead th"));
    const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
    const firstRowCells = Array.from(table.querySelectorAll("tbody tr:first-child td"));
    const isPartial = (cell: PreviewElement) => {
      const cellBounds = cell.getBoundingClientRect();
      const intersects = cellBounds.right > scrollerBounds.left + 1 && cellBounds.left < scrollerBounds.right - 1;
      return intersects && (cellBounds.left < scrollerBounds.left - 1 || cellBounds.right > scrollerBounds.right + 1);
    };
    return {
      title: section.querySelector("header > span")?.textContent?.trim() ?? "",
      pageStatus: section.querySelector('[data-testid="inline-preview-page"]')?.textContent?.trim() ?? "",
      headers: headers.map((header) => header.textContent?.trim() ?? ""),
      rows: bodyRows.length,
      pageSize: pageSize.value,
      width: bounds.width,
      height: bounds.height,
      horizontalOverflow: scroller.scrollWidth - scroller.clientWidth,
      verticalOverflow: scroller.scrollHeight - scroller.clientHeight,
      scrollLeft: scroller.scrollLeft,
      partialBodyRows: bodyRows
        .map((row, index) => {
          const rowBounds = row.getBoundingClientRect();
          const visible = rowBounds.bottom > contentTop + 1 && rowBounds.top < contentBottom - 1;
          return visible && (rowBounds.top < contentTop - 1 || rowBounds.bottom > contentBottom + 1) ? index : -1;
        })
        .filter((index) => index >= 0),
      partialHeaderColumns: headers
        .map((header, index) => (isPartial(header) ? index : -1))
        .filter((index) => index >= 0),
      partialBodyColumns: firstRowCells
        .map((cell, index) => (isPartial(cell) ? index : -1))
        .filter((index) => index >= 0),
      visibleHeaderCount: headers.filter((header) => {
        const headerBounds = header.getBoundingClientRect();
        return headerBounds.left >= scrollerBounds.left - 1 && headerBounds.right <= scrollerBounds.right + 1;
      }).length,
      actionText: button.textContent?.trim() ?? "",
      actionClipped:
        button.scrollWidth > button.clientWidth + 1 ||
        button.getBoundingClientRect().left < bounds.left - 1 ||
        button.getBoundingClientRect().right > bounds.right + 1
    };
  });
  assert.ok(preview, "The Pandas notebook action must remain inside its exact rendered preview.");
  assert.deepEqual(preview, {
    title: "Open Wrangler preview: orders_preview_df (pandas) - 100000 x 12",
    pageStatus: "1-10 of 200 captured · 100,000 total",
    headers: [
      "order_id",
      "market",
      "revenue",
      "fulfilled",
      "order_date",
      "segment",
      "channel",
      "product_family",
      "units",
      "unit_price",
      "discount_pct",
      "gross_margin"
    ],
    rows: 10,
    pageSize: "10",
    width: preview?.width,
    height: preview?.height,
    horizontalOverflow: preview?.horizontalOverflow,
    verticalOverflow: preview?.verticalOverflow,
    scrollLeft: 0,
    partialBodyRows: [],
    partialHeaderColumns: [],
    partialBodyColumns: [],
    visibleHeaderCount: 12,
    actionText: "Open in Open Wrangler",
    actionClipped: false
  });
  assert.ok(
    preview.width > 0 && preview.height > 0,
    `The Pandas notebook preview must be fully laid out: ${JSON.stringify({
      width: preview.width,
      height: preview.height
    })}`
  );
  assert.ok(
    preview.horizontalOverflow <= 1,
    `The Pandas README scene must fit all twelve columns without a partial next-column sliver: ${JSON.stringify({
      horizontalOverflow: preview.horizontalOverflow,
      partialHeaderColumns: preview.partialHeaderColumns,
      partialBodyColumns: preview.partialBodyColumns
    })}`
  );
  assert.ok(
    preview.verticalOverflow <= 1,
    `The Pandas README scene must show only complete table rows: ${JSON.stringify({
      verticalOverflow: preview.verticalOverflow,
      partialBodyRows: preview.partialBodyRows
    })}`
  );
  await assertReleasedJupyterCaptureInternalMarkerHidden(workbench);
  await clearReleasedJupyterScreenshotTransientUi(workbench);
  mkdirSync(outputDirectory, { recursive: true });
  recordAcceptanceProgress("jupyter-allow:screenshot:pandas");
  const destination = path.resolve(
    outputDirectory,
    packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-pandas", "dark")
  );
  await captureWorkbenchScreenshot(workbench, destination, PACKAGED_PANDAS_NOTEBOOK_OUTPUT.height);
  const screenshot = readFileSync(destination);
  assert.equal(
    screenshot.readUInt32BE(16),
    PACKAGED_PANDAS_NOTEBOOK_OUTPUT.width * publicMediaPixelRatio(),
    "The Pandas README screenshot must retain its dedicated readable width."
  );
  assert.equal(
    screenshot.readUInt32BE(20),
    PACKAGED_PANDAS_NOTEBOOK_OUTPUT.height * publicMediaPixelRatio(),
    "The Pandas README screenshot must retain its dedicated readable height."
  );
}

async function captureReleasedJupyterVariablePicker(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  assert.equal(path.isAbsolute(outputDirectory), true, "Notebook screenshot output must be one absolute directory.");
  const previousViewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  let picker: Locator | undefined;
  try {
    await workbench.setViewportSize(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT);
    const previewButton = await waitForNotebookRendererButton(workbench, "orders_preview_df", "Open in Open Wrangler");
    await previewButton.evaluate((element) => {
      (element as { scrollIntoView(options: { block: string }): void }).scrollIntoView({ block: "center" });
    });
    await assertReleasedJupyterCaptureInternalMarkerHidden(workbench);
    await previewButton.dispose();
    recordAcceptanceProgress("jupyter-allow:screenshot:variable-picker");
    picker = await activateReleasedNotebookVariableAction(workbench, notebook);
    const rows = await Promise.all(
      ["pandas_frame", "polars_frame", "duckdb_relation"].map((variableName) =>
        releasedJupyterQuickPickRow(picker!, variableName)
      )
    );
    assert.equal(
      rows.every((row) => row !== undefined),
      true,
      "The notebook-variable gallery picker must expose native Pandas, Polars, and DuckDB values together."
    );
    for (const row of rows) await row!.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    await assertReleasedNotebookVariablePickerGeometry(picker, ["pandas_frame", "polars_frame", "duckdb_relation"]);
    await assertReleasedJupyterCaptureInternalMarkerHidden(workbench);
    mkdirSync(outputDirectory, { recursive: true });
    const destination = path.resolve(
      outputDirectory,
      packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-variable-picker", "dark")
    );
    await captureNotebookWorkbenchScreenshot(workbench, destination);
  } finally {
    if (picker && (await picker.isVisible().catch(() => false))) {
      await picker.locator(".quick-input-box input:visible").first().press("Escape");
      await picker.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    }
    await workbench.setViewportSize(previousViewport);
  }
}

async function assertReleasedJupyterCaptureInternalMarkerHidden(workbench: Page): Promise<void> {
  const internalMarkerVisible = await workbench.locator("body").evaluate((body, marker) => {
    type TextElement = {
      readonly children: ArrayLike<TextElement>;
      readonly textContent: string | null;
      getBoundingClientRect(): {
        bottom: number;
        height: number;
        left: number;
        right: number;
        top: number;
        width: number;
      };
    };
    type TextBody = TextElement & { querySelectorAll(selector: string): ArrayLike<TextElement> };
    const page = globalThis as unknown as {
      getComputedStyle(element: TextElement): { display: string; visibility: string };
      innerHeight: number;
      innerWidth: number;
    };
    return Array.from((body as unknown as TextBody).querySelectorAll("*")).some((element) => {
      if (!element.textContent?.includes(marker)) return false;
      if (Array.from(element.children).some((child) => child.textContent?.includes(marker))) return false;
      const style = page.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const bounds = element.getBoundingClientRect();
      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.right > 0 &&
        bounds.bottom > 0 &&
        bounds.left < page.innerWidth &&
        bounds.top < page.innerHeight
      );
    });
  }, RELEASED_JUPYTER_RESTART_RESULT);
  assert.equal(
    internalMarkerVisible,
    false,
    "Public notebook screenshots must hide visible internal restart-probe source text."
  );
}

async function assertReleasedNotebookVariablePickerGeometry(
  picker: Locator,
  requiredLabels: readonly string[]
): Promise<void> {
  const geometry = await picker.evaluate((element) => {
    type PickerRect = { bottom: number; left: number; right: number; top: number };
    type PickerElement = {
      readonly clientWidth: number;
      readonly scrollWidth: number;
      readonly textContent: string | null;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): PickerRect & { height: number; width: number };
      querySelector(selector: string): PickerElement | null;
      querySelectorAll(selector: string): ArrayLike<PickerElement>;
    };
    const root = element as unknown as PickerElement;
    const list = root.querySelector(".quick-input-list .monaco-list");
    if (!list) throw new Error("The notebook-variable picker list viewport is unavailable.");
    const listBounds = list.getBoundingClientRect();
    const options = Array.from(root.querySelectorAll(".quick-input-list [role='option']")).filter((option) => {
      const bounds = option.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1;
    });
    const labels = options.map((option) => {
      const name = option.querySelector(".label-name");
      return name?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
    });
    const partiallyVisible = options
      .filter((option) => {
        const bounds = option.getBoundingClientRect();
        return bounds.top < listBounds.top - 1 || bounds.bottom > listBounds.bottom + 1;
      })
      .map((option) => option.textContent?.replace(/\s+/gu, " ").trim() ?? "");
    const clippedText = options.flatMap((option) =>
      Array.from(option.querySelectorAll(".label-name, .label-description, .quick-input-list-detail"))
        .filter((item) => item.scrollWidth > item.clientWidth + 1)
        .map((item) => item.textContent?.replace(/\s+/gu, " ").trim() ?? "")
    );
    return {
      pickerOverflow: root.scrollWidth - root.clientWidth,
      labels,
      partiallyVisible,
      clippedText
    };
  });
  assert.ok(geometry.pickerOverflow <= 1, "The notebook-variable picker must not overflow horizontally.");
  assert.deepEqual(geometry.partiallyVisible, [], "The notebook-variable capture must show only complete rows.");
  assert.deepEqual(geometry.clippedText, [], "The notebook-variable capture must not clip visible row text.");
  for (const label of requiredLabels) {
    assert.ok(geometry.labels.includes(label), `The notebook-variable capture must visibly include ${label}.`);
  }
}

async function captureReleasedJupyterPySparkPicker(
  workbench: Page,
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  editor: vscode.NotebookEditor,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  assert.equal(path.isAbsolute(outputDirectory), true, "PySpark screenshot output must be one absolute directory.");
  const restoreWorkbench = await prepareReleasedJupyterScreenshotWorkbench(workbench, notebook, editor);
  let picker: Locator | undefined;
  try {
    await workbench.setViewportSize(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT);
    assert.deepEqual(
      await workbench.evaluate(() => {
        const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
        return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
      }),
      PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
      "The PySpark picker media scene requires the standard 1440 by 900 editor viewport."
    );

    recordAcceptanceProgress("jupyter-pyspark:screenshot:variable-picker");
    picker = await activateReleasedNotebookVariableAction(workbench, notebook, async () => {
      const consent = await waitForReleasedJupyterConsent(workbench, testing);
      await consent.allow.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    });
    const input = picker.locator(".quick-input-box input:visible").first();
    await input.fill("spark_classic_frame");
    const deadline = Date.now() + WORKBENCH_PLAYWRIGHT_TIMEOUT_MS;
    let row: Locator | undefined;
    do {
      row = await releasedJupyterQuickPickRow(picker, "spark_classic_frame");
      if (row) break;
      await workbench.waitForTimeout(50);
    } while (Date.now() < deadline);
    assert.ok(row, "The filtered PySpark picker must expose spark_classic_frame.");
    await row.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    assert.equal(
      await picker.locator(".quick-input-list [role='option']:visible").count(),
      1,
      "Filtering the PySpark picker must leave one unambiguous visible dataframe row."
    );

    const expectedDetail = "Viewing only · First page loads without counting rows · PySpark 4.2.x required";
    const rowText = (await row.innerText()).replace(/\s+/gu, " ").trim();
    assert.match(rowText, /spark_classic_frame/u);
    assert.match(rowText, /PySpark Classic · DataFrame/u);
    for (const phrase of ["Viewing only", "First page loads without counting rows", "PySpark 4.2.x required"]) {
      assert.ok(rowText.includes(phrase), `The PySpark picker row must visibly explain ${phrase}.`);
    }
    const detail = row.getByText(expectedDetail, { exact: true }).first();
    await detail.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    const detailGeometry = await Promise.all([detail.boundingBox(), row.boundingBox(), picker.boundingBox()]);
    const [detailBounds, rowBounds, pickerBounds] = detailGeometry;
    assert.ok(detailBounds && rowBounds && pickerBounds, "The PySpark picker detail must have measurable geometry.");
    assert.ok(
      detailBounds.x >= rowBounds.x - 1 &&
        detailBounds.x + detailBounds.width <= rowBounds.x + rowBounds.width + 1 &&
        detailBounds.x >= pickerBounds.x - 1 &&
        detailBounds.x + detailBounds.width <= pickerBounds.x + pickerBounds.width + 1,
      "The PySpark picker detail must remain fully inside its row and picker."
    );
    assert.equal(
      await detail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      "The PySpark picker detail must remain horizontally unclipped."
    );
    await assertReleasedNotebookVariablePickerGeometry(picker, ["spark_classic_frame"]);

    mkdirSync(outputDirectory, { recursive: true });
    await captureNotebookWorkbenchScreenshot(
      workbench,
      path.resolve(
        outputDirectory,
        packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-pyspark-picker", "dark")
      )
    );
  } finally {
    try {
      if (picker && (await picker.isVisible().catch(() => false))) {
        await picker.locator(".quick-input-box input:visible").first().press("Escape");
        await picker.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      }
    } finally {
      await restoreWorkbench();
    }
  }
}

async function captureReleasedJupyterPolarsDraft(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  const previousViewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  await workbench.setViewportSize(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT);
  assert.deepEqual(
    await workbench.evaluate(() => {
      const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
      return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
    }),
    PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
    "The Polars notebook media scene requires the standard 1440 by 900 editor viewport."
  );
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId, "The Polars notebook screenshot requires the exact live session.");
  assert.ok(active, "The Polars notebook screenshot requires one active dataframe session.");
  assert.equal(active.metadata.backend, "polars");
  assert.equal(active.metadata.source.kind, "notebookVariable");
  assert.equal(active.metadata.source.variableName, "polars_frame");
  assert.equal(active.metadata.draftStep?.id, "released-jupyter-double");

  const doubleUnits = columnReference(active.metadata, "double_units");
  const baselineWidths = new Map(active.metadata.schema.map((column) => [column.id, 230] as const));
  const doubleUnitsPosition = active.metadata.schema.findIndex((column) => column.id === doubleUnits.id);
  assert.ok(doubleUnitsPosition >= 0, "The Polars notebook screenshot requires the draft output column.");
  await testing.updateViewState(sessionId, {
    ...active.viewState,
    columnWidths: baselineWidths,
    selectedColumnId: columnReference(active.metadata, "units").id,
    viewport: { firstVisibleRow: 0, scrollLeft: 0 }
  });
  assert.equal(await testing.synchronizePanel(sessionId), true);
  await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
    "workbench.action.closeSidebar",
    "workbench.action.toggleSidebarVisibility"
  ]);
  await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.toggleAuxiliaryBar"
  ]);
  await vscode.commands.executeCommand("openWrangler.codePreview.focus");
  const panel = workbench.locator(".part.panel:visible").first();
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    await workbench.locator(".part.panel:visible").count(),
    1,
    "The Polars notebook screenshot must open exactly one native panel."
  );
  const codePreview = await waitForCodePreview(workbench, "double_units");
  assert.equal(await codePreview.count(), 1, "The Polars notebook screenshot must render one Code Preview editor.");
  const codeText = await codePreview.innerText();
  assert.ok(codeText.includes("import polars as pl"), "The Polars notebook screenshot must show its native import.");
  assert.ok(
    codeText.includes("pl.col('units') * pl.lit(2)"),
    "The Polars notebook screenshot must show its native formula expression."
  );
  assert.ok(
    codeText.includes(".alias('double_units')"),
    "The Polars notebook screenshot must show the generated output alias."
  );
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The Polars notebook screenshot requires the exact live Open Wrangler renderer.");
  const backendBadge = app.locator('[data-session-badge="backend"]');
  const modeBadge = app.locator('[data-session-badge="mode"]');
  await backendBadge.waitFor({ state: "visible", timeout: 10_000 });
  await modeBadge.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await backendBadge.innerText()).trim(), "POLARS");
  assert.equal((await modeBadge.innerText()).trim().toUpperCase(), "EDITING");
  const toolbarBox = await app.locator(".toolbar").boundingBox();
  const allBadges = app.locator("[data-session-badge]");
  assert.equal(await allBadges.count(), 2, "The Polars notebook scene must expose only its mode and backend badges.");
  const badgeBoxes = await Promise.all((await allBadges.all()).map((badge) => badge.boundingBox()));
  assert.ok(toolbarBox, "The Polars notebook media scene requires a measurable workbench toolbar.");
  assert.ok(
    badgeBoxes.every(
      (badge) =>
        badge !== null && badge.x >= toolbarBox.x && badge.x + badge.width <= toolbarBox.x + toolbarBox.width + 1
    ),
    "The Polars engine and editing badges must remain fully inside the workbench toolbar."
  );
  await app.getByRole("button", { name: "Apply step" }).waitFor({ state: "visible", timeout: 10_000 });
  await app.getByRole("button", { name: "Discard" }).waitFor({ state: "visible", timeout: 10_000 });
  const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await columnSearch.fill("double_units");
  await app.getByRole("option", { name: /^double_units,/u }).waitFor({ state: "visible", timeout: 10_000 });
  await columnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === doubleUnits.id,
    10_000,
    "the Polars notebook screenshot to navigate to its computed draft column"
  );
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The Polars notebook screenshot must synchronize after navigating to the draft column."
  );
  const headerProfiles = app.getByRole("button", { name: "Header profiles", exact: true });
  await headerProfiles.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await headerProfiles.getAttribute("aria-pressed"), "true");
  await headerProfiles.click();
  assert.equal(await headerProfiles.getAttribute("aria-pressed"), "false");

  const firstVisibleColumn = columnReference(active.metadata, "product_family");
  const firstVisibleColumnPosition = active.metadata.schema.findIndex((column) => column.id === firstVisibleColumn.id);
  assert.ok(
    firstVisibleColumnPosition >= 0 && firstVisibleColumnPosition < doubleUnitsPosition,
    "The Polars notebook screenshot requires product_family before its computed draft output."
  );
  assert.equal(
    doubleUnitsPosition,
    active.metadata.schema.length - 1,
    "The Polars notebook screenshot requires the computed draft output to remain the final column."
  );
  const gridScroller = app.getByTestId("data-grid-scroller");
  const measuredGrid = await gridScroller.evaluate((element) => {
    const scroller = element as {
      clientWidth: number;
      querySelector(selector: string): { getBoundingClientRect(): { width: number } } | null;
    };
    const rowHeader = scroller.querySelector("th.rowHeader");
    return {
      clientWidth: scroller.clientWidth,
      rowHeaderWidth: rowHeader?.getBoundingClientRect().width ?? 0
    };
  });
  const rowHeaderWidth = Math.round(measuredGrid.rowHeaderWidth);
  const visibleDataWidth = measuredGrid.clientWidth - rowHeaderWidth;
  const visibleColumnCount = doubleUnitsPosition - firstVisibleColumnPosition + 1;
  const alignedBaseWidth = Math.floor(visibleDataWidth / visibleColumnCount);
  const alignedWidthRemainder = visibleDataWidth % visibleColumnCount;
  assert.ok(
    Number.isSafeInteger(visibleDataWidth) &&
      visibleDataWidth > 0 &&
      rowHeaderWidth > 0 &&
      alignedBaseWidth >= 80 &&
      alignedBaseWidth + Number(alignedWidthRemainder > 0) <= 640,
    `The native Polars grid cannot fit its complete gallery suffix: ${JSON.stringify({
      ...measuredGrid,
      rowHeaderWidth,
      visibleDataWidth,
      visibleColumnCount,
      alignedBaseWidth,
      alignedWidthRemainder
    })}`
  );
  const alignedWidths = new Map(
    active.metadata.schema.map((column) => {
      if (column.position < firstVisibleColumnPosition) return [column.id, 230] as const;
      const visiblePosition = column.position - firstVisibleColumnPosition;
      return [column.id, alignedBaseWidth + Number(visiblePosition < alignedWidthRemainder)] as const;
    })
  );
  const alignedScrollLeft = active.metadata.schema
    .slice(0, firstVisibleColumnPosition)
    .reduce((total, column) => total + (alignedWidths.get(column.id) ?? 0), 0);
  const alignedViewState = testing.activeSession()?.viewState;
  assert.ok(alignedViewState, "The Polars notebook screenshot requires its confirmed presentation state.");
  await testing.updateViewState(sessionId, {
    ...alignedViewState,
    columnWidths: alignedWidths,
    selectedColumnId: doubleUnits.id,
    viewport: { firstVisibleRow: 0, scrollLeft: alignedScrollLeft }
  });
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The Polars notebook screenshot must synchronize its column-aligned gallery viewport."
  );

  const addedCells = app.locator(`td[data-grid-column="${doubleUnitsPosition}"][data-grid-row]`);
  await addedCells.nth(5).waitFor({ state: "visible", timeout: 10_000 });
  assert.deepEqual(
    (await addedCells.allInnerTexts()).slice(0, 6).map((value) => value.trim()),
    ["6", "20", "10", "24", "14", "4"],
    "The Polars notebook screenshot page must contain six computed draft values."
  );
  assert.deepEqual(
    await Promise.all(Array.from({ length: 6 }, (_, index) => addedCells.nth(index).getAttribute("data-diff-state"))),
    Array(6).fill("added"),
    "The computed Polars draft values must retain their added-column diff state."
  );
  const gridViewport = await gridScroller.boundingBox();
  assert.ok(gridViewport, "The Polars notebook screenshot requires a measurable grid viewport.");
  const rowHeader = await app.locator("th.rowHeader").first().boundingBox();
  const firstVisibleHeader = await app.locator('th[data-column="product_family"]').boundingBox();
  const precedingHeader = await app.locator('th[data-column="channel"]').boundingBox();
  const doubleUnitsHeader = await app.locator('th[data-column="double_units"]').boundingBox();
  assert.ok(rowHeader, "The Polars notebook screenshot requires a measurable row header.");
  assert.ok(firstVisibleHeader, "The first visible Polars data column must have measurable geometry.");
  assert.ok(doubleUnitsHeader, "The computed Polars draft header must have measurable geometry.");
  const dataViewportLeft = rowHeader.x + rowHeader.width;
  const gridViewportRight = gridViewport.x + gridViewport.width;
  assert.ok(
    Math.abs(firstVisibleHeader.x - dataViewportLeft) <= 1,
    "The Polars notebook screenshot must begin at the complete product_family column boundary."
  );
  assert.ok(
    !precedingHeader || precedingHeader.x + precedingHeader.width <= dataViewportLeft + 1,
    "No partially visible data column may remain to the left of product_family in the Polars screenshot."
  );
  assert.ok(
    doubleUnitsHeader.x >= dataViewportLeft - 1 &&
      doubleUnitsHeader.x + doubleUnitsHeader.width <= gridViewportRight + 1,
    "The complete computed double_units header must remain inside the Polars screenshot viewport."
  );
  await assertMediaColumnTitlesUnclipped(
    app,
    active.metadata.schema.slice(firstVisibleColumnPosition).map((column) => column.name),
    "The Polars notebook media scene"
  );
  for (let index = 0; index < 3; index += 1) {
    const cell = await addedCells.nth(index).boundingBox();
    assert.ok(cell, `Computed Polars draft row ${index + 1} must have measurable geometry.`);
    assert.ok(
      cell.x >= gridViewport.x &&
        cell.y >= gridViewport.y &&
        cell.x + cell.width <= gridViewport.x + gridViewport.width &&
        cell.y + cell.height <= gridViewport.y + gridViewport.height,
      `Computed Polars draft row ${index + 1} must be fully inside the captured grid viewport.`
    );
  }
  await vscode.commands.executeCommand("openWrangler.codePreview.focus");
  await codePreview.focus();
  await clearReleasedJupyterScreenshotTransientUi(workbench);
  assert.equal(
    testing.activeSession()?.metadata.draftStep?.id,
    "released-jupyter-double",
    "Screenshot cleanup must not discard the Polars draft."
  );
  mkdirSync(outputDirectory, { recursive: true });
  recordAcceptanceProgress("jupyter-allow:screenshot:polars");
  await captureNotebookWorkbenchScreenshot(
    workbench,
    path.resolve(
      outputDirectory,
      packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-polars", "dark")
    )
  );
  await workbench.setViewportSize(previousViewport);
  await workbench.waitForTimeout(500);
}

async function captureReleasedJupyterDuckDbRelation(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  filterModel: FilterModel,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  assert.equal(path.isAbsolute(outputDirectory), true, "DuckDB screenshot output must be one absolute directory.");
  const previousViewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  const previousThemeKind = vscode.window.activeColorTheme.kind;
  const workbenchConfiguration = vscode.workspace.getConfiguration("workbench");
  const breadcrumbs = vscode.workspace.getConfiguration("breadcrumbs");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const settings = [
    { configuration: windowConfiguration, key: "autoDetectColorScheme" },
    { configuration: windowConfiguration, key: "autoDetectHighContrast" },
    { configuration: windowConfiguration, key: "commandCenter" },
    { configuration: windowConfiguration, key: "title" },
    { configuration: workbenchConfiguration, key: "colorTheme" },
    { configuration: workbenchConfiguration, key: "statusBar.visible" },
    { configuration: breadcrumbs, key: "enabled" }
  ] as const;
  const previousSettings = settings.map(({ configuration, key }) => ({
    configuration,
    key,
    value: configuration.inspect(key)?.globalValue
  }));

  try {
    await workbench.setViewportSize(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT);
    assert.deepEqual(
      await workbench.evaluate(() => {
        const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
        return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
      }),
      PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
      "The DuckDB notebook media scene requires the standard 1440 by 900 editor viewport."
    );
    await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update(
      "title",
      "${activeEditorShort}${separator}Open Wrangler",
      vscode.ConfigurationTarget.Global
    );
    await workbenchConfiguration.update(
      "colorTheme",
      releasedJupyterScreenshotTheme(),
      vscode.ConfigurationTarget.Global
    );
    await workbenchConfiguration.update("statusBar.visible", false, vscode.ConfigurationTarget.Global);
    await breadcrumbs.update("enabled", false, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
      10_000,
      "the dark DuckDB notebook screenshot theme"
    );
    await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
      "workbench.action.closeSidebar",
      "workbench.action.toggleSidebarVisibility"
    ]);
    await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
      "workbench.action.closeAuxiliaryBar",
      "workbench.action.toggleAuxiliaryBar"
    ]);
    await closeVisibleWorkbenchPart(workbench, ".part.panel", [
      "workbench.action.closePanel",
      "workbench.action.togglePanel"
    ]);
    await clearReleasedJupyterScreenshotTransientUi(workbench);

    const active = testing.activeSession();
    assert.equal(active?.sessionId, sessionId, "The DuckDB notebook screenshot requires the exact live relation.");
    assert.ok(active, "The DuckDB notebook screenshot requires one active relation session.");
    assert.equal(active.metadata.backend, "duckdb");
    assert.equal(active.metadata.mode, "viewing");
    assert.equal(active.metadata.source.kind, "notebookVariable");
    assert.equal(active.metadata.source.variableName, "duckdb_relation");
    assert.deepEqual(active.metadata.shape, { rows: 100_000, columns: 4 });
    assert.deepEqual(active.metadata.filteredShape, { rows: 25_000, columns: 4 });
    assert.deepEqual(active.metadata.filterModel, filterModel);
    assert.deepEqual(active.metadata.steps, []);
    assert.equal(active.metadata.draftStep, undefined);
    assert.deepEqual(active.metadata.capabilities, {
      editable: false,
      lazy: false,
      cancel: false,
      exportCsv: false,
      exportParquet: false,
      notebookInsert: false
    });
    // Cursor can reload the webview when the screenshot theme changes. Require
    // the exact session grid and a current host handshake before publishing
    // screenshot-only presentation state; an immediate synchronization here
    // can otherwise race the renderer's ready message.
    const readyTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const readyApp = await exactSessionApp(readyTarget.frame, sessionId);
    assert.ok(readyApp, "The DuckDB notebook screenshot requires the exact live Open Wrangler renderer.");
    await waitFor(
      () => testing.panelSynchronizable(sessionId),
      10_000,
      "the reloaded DuckDB notebook renderer to complete its host handshake"
    );
    const revenue = columnReference(active.metadata, "revenue");
    await testing.updateViewState(sessionId, {
      ...active.viewState,
      columnWidths: new Map(active.metadata.schema.map((column) => [column.id, 230] as const)),
      selectedColumnId: revenue.id,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The DuckDB notebook screenshot must synchronize its native filtered relation."
    );
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "The synchronized DuckDB screenshot requires the exact current renderer generation.");
    const backendBadge = app.locator('[data-session-badge="backend"]');
    const modeBadge = app.locator('[data-session-badge="mode"]');
    await backendBadge.waitFor({ state: "visible", timeout: 10_000 });
    await modeBadge.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal((await backendBadge.innerText()).trim().toUpperCase(), "DUCKDB");
    assert.equal((await modeBadge.innerText()).trim().toUpperCase(), "VIEWING");
    const toolbarBox = await app.locator(".toolbar").boundingBox();
    const allBadges = app.locator("[data-session-badge]");
    assert.equal(await allBadges.count(), 2, "The DuckDB notebook scene must expose only its mode and backend badges.");
    const badgeBoxes = await Promise.all((await allBadges.all()).map((badge) => badge.boundingBox()));
    assert.ok(toolbarBox, "The DuckDB notebook media scene requires a measurable workbench toolbar.");
    assert.ok(
      badgeBoxes.every(
        (badge) =>
          badge !== null && badge.x >= toolbarBox.x && badge.x + badge.width <= toolbarBox.x + toolbarBox.width + 1
      ),
      "The DuckDB engine and viewing badges must remain fully inside the workbench toolbar."
    );
    assert.equal(await app.getByRole("button", { name: "Add step" }).count(), 0);
    assert.equal(await app.getByRole("button", { name: "Apply step" }).count(), 0);
    assert.equal(await app.getByRole("button", { name: "Discard" }).count(), 0);
    assert.equal(await app.getByRole("button", { name: "Export", exact: true }).count(), 0);

    const insightsToggle = app.getByRole("button", { name: "Column profiles and filters" });
    if ((await insightsToggle.getAttribute("aria-expanded")) !== "true") await insightsToggle.click();
    const drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });

    // The coordinator assertions above deliberately exercise DuckDB without
    // going through the renderer. Materialize the same view through the real
    // UI before capturing it so the panel owns the exact page and profiling
    // context a user would see.
    await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    const filterPanel = drawer.locator(".filterSortPanel").first();
    await filterPanel.waitFor({ state: "visible", timeout: 10_000 });
    const activeDachFilter = drawer.getByRole("button", {
      name: 'Remove equals "DACH" filter from market'
    });
    if ((await activeDachFilter.count()) === 0) {
      await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "market" });
      await filterPanel.getByLabel("Predicate operator").selectOption("equals");
      await filterPanel.getByLabel("equals predicate value").fill("DACH");
      await filterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
      await waitFor(
        () => {
          const current = testing.activeSession();
          const filter = current?.metadata.filterModel.filters[0];
          return (
            current?.metadata.filteredShape.rows === 25_000 &&
            current.metadata.filterModel.sort.length === 0 &&
            current.metadata.filterModel.filters.length === 1 &&
            filter?.column === "market" &&
            filter.predicates.length === 1 &&
            filter.predicates[0]?.kind === "predicate" &&
            filter.predicates[0].operator === "equals" &&
            filter.predicates[0].value === "DACH"
          );
        },
        30_000,
        "the real DuckDB filter editor to publish its filter-only intermediate view",
        () => JSON.stringify(testing.activeSession()?.metadata.filterModel)
      );
    }
    await activeDachFilter.waitFor({ state: "visible", timeout: 30_000 });

    const orderIdHeader = app.locator('th[data-column="order_id"]');
    const revenueHeader = app.locator('th[data-column="revenue"]');
    for (const [header, column] of [
      [orderIdHeader, "order_id"],
      [revenueHeader, "revenue"]
    ] as const) {
      const clearSort = header.getByRole("button", { name: new RegExp(`^Clear sort for ${column};`, "u") });
      if ((await clearSort.count()) > 0) {
        await clearSort.click();
        await clearSort.waitFor({ state: "hidden", timeout: 10_000 });
      }
    }
    const revenueMenu = revenueHeader.locator("details.columnMenu");
    await revenueMenu.getByLabel("Column actions for revenue").click();
    await revenueMenu.getByRole("button", { name: "Sort ascending", exact: true }).click();
    assert.equal(await revenueMenu.evaluate((element) => element.hasAttribute("open")), false);
    const orderIdMenu = orderIdHeader.locator("details.columnMenu");
    await orderIdMenu.getByLabel("Column actions for order_id").click();
    await orderIdMenu.getByRole("button", { name: "Sort descending", exact: true }).click();
    assert.equal(await orderIdMenu.evaluate((element) => element.hasAttribute("open")), false);
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.metadata.filteredShape.rows === 25_000 &&
          isDeepStrictEqual(current.metadata.filterModel, filterModel)
        );
      },
      30_000,
      "the real DuckDB filter and priority sorts to own the captured view"
    );

    await drawer.getByRole("tab", { name: "Column" }).click();
    const headerProfiles = app.getByRole("button", { name: "Header profiles", exact: true });
    await headerProfiles.waitFor({ state: "visible", timeout: 10_000 });
    if ((await headerProfiles.getAttribute("aria-pressed")) !== "true") await headerProfiles.click();
    assert.equal(
      await headerProfiles.getAttribute("aria-pressed"),
      "true",
      "The DuckDB notebook media scene must retain native visible-column profiles."
    );

    const gridScroller = app.getByTestId("data-grid-scroller");
    const measuredGrid = await gridScroller.evaluate((element) => {
      const scroller = element as {
        clientWidth: number;
        querySelector(selector: string): { getBoundingClientRect(): { width: number } } | null;
      };
      const rowHeader = scroller.querySelector("th.rowHeader");
      return {
        clientWidth: scroller.clientWidth,
        rowHeaderWidth: rowHeader?.getBoundingClientRect().width ?? 0
      };
    });
    const rowHeaderWidth = Math.round(measuredGrid.rowHeaderWidth);
    const visibleDataWidth = measuredGrid.clientWidth - rowHeaderWidth;
    const alignedBaseWidth = Math.floor(visibleDataWidth / active.metadata.schema.length);
    const alignedWidthRemainder = visibleDataWidth % active.metadata.schema.length;
    assert.ok(
      Number.isSafeInteger(visibleDataWidth) &&
        visibleDataWidth > 0 &&
        rowHeaderWidth > 0 &&
        alignedBaseWidth >= 80 &&
        alignedBaseWidth + Number(alignedWidthRemainder > 0) <= 640,
      `The native DuckDB grid cannot fit its complete relation schema: ${JSON.stringify({
        ...measuredGrid,
        rowHeaderWidth,
        visibleDataWidth,
        alignedBaseWidth,
        alignedWidthRemainder
      })}`
    );
    const alignedWidths = new Map(
      active.metadata.schema.map(
        (column) => [column.id, alignedBaseWidth + Number(column.position < alignedWidthRemainder)] as const
      )
    );
    const confirmedViewState = testing.activeSession()?.viewState;
    assert.ok(confirmedViewState, "The DuckDB notebook screenshot requires its confirmed presentation state.");
    await testing.updateViewState(sessionId, {
      ...confirmedViewState,
      columnWidths: alignedWidths,
      selectedColumnId: revenue.id,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The DuckDB notebook screenshot must synchronize its exact four-column fit."
    );

    const profileDeadline = Date.now() + 60_000;
    let revenueProfile = "";
    while (Date.now() < profileDeadline) {
      revenueProfile = await revenueHeader.innerText();
      if (
        /Min 100\.5/u.test(revenueProfile) &&
        /Max 5,?099\.94/u.test(revenueProfile) &&
        !revenueProfile.includes("Profiling")
      ) {
        break;
      }
      await workbench.waitForTimeout(50);
    }
    assert.match(revenueProfile, /Min 100\.5/u);
    assert.match(revenueProfile, /Max 5,?099\.94/u);
    assert.doesNotMatch(revenueProfile, /Profiling/u);

    await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    await drawer.getByRole("heading", { name: "Filters / Sorts" }).waitFor({ state: "visible", timeout: 10_000 });
    const filterEditor = drawer.locator("details.filterSection").first();
    if ((await filterEditor.getAttribute("open")) !== null) {
      await filterEditor.locator("summary").click();
    }
    const activeFilters = drawer.getByRole("region", { name: "Active filters" });
    await activeFilters.waitFor({ state: "visible", timeout: 10_000 });
    await activeFilters
      .getByRole("button", { name: 'Remove equals "DACH" filter from market' })
      .waitFor({ state: "visible", timeout: 10_000 });
    const sortOrder = drawer.getByRole("list", { name: "Active sort order" });
    await sortOrder.waitFor({ state: "visible", timeout: 10_000 });
    const sortRules = (await sortOrder.getByRole("listitem").allInnerTexts()).map((text) =>
      text.replace(/\s+/gu, " ").trim()
    );
    assert.equal(sortRules.length, 2);
    assert.match(sortRules[0] ?? "", /^1 order_id .*descending.*nulls last/u);
    assert.match(sortRules[1] ?? "", /^2 revenue .*ascending.*nulls last/u);

    const visibleRows = app.getByRole("status", { name: "Visible rows" });
    await visibleRows.waitFor({ state: "visible", timeout: 10_000 });
    assert.match((await visibleRows.innerText()).trim(), /^Rows 1\u2013\d+ of 25,000$/u);
    const gridBox = await gridScroller.boundingBox();
    const rowHeaderBox = await app.locator("th.rowHeader").first().boundingBox();
    const orderIdBox = await app.locator('th[data-column="order_id"]').boundingBox();
    const orderDateBox = await app.locator('th[data-column="order_date"]').boundingBox();
    assert.ok(gridBox, "The DuckDB notebook media scene requires a measurable grid viewport.");
    assert.ok(rowHeaderBox, "The DuckDB notebook media scene requires a measurable row header.");
    assert.ok(orderIdBox, "The DuckDB notebook media scene requires the complete order_id header.");
    assert.ok(orderDateBox, "The DuckDB notebook media scene requires the complete order_date header.");
    const dataViewportLeft = rowHeaderBox.x + rowHeaderBox.width;
    const gridContentRight = gridBox.x + measuredGrid.clientWidth;
    assert.ok(
      Math.abs(orderIdBox.x - dataViewportLeft) <= 1,
      "The DuckDB notebook media scene must begin at the complete order_id column boundary."
    );
    assert.ok(
      Math.abs(orderDateBox.x + orderDateBox.width - gridContentRight) <= 1,
      "The DuckDB notebook media scene must end at the complete order_date column boundary."
    );
    await assertMediaColumnTitlesUnclipped(
      app,
      active.metadata.schema.map((column) => column.name),
      "The DuckDB notebook media scene"
    );

    const commands = new Set(await vscode.commands.getCommands(true));
    if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
    if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
    await workbench.mouse.move(Math.floor(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT.width * 0.75), 40);
    await workbench.waitForTimeout(500);
    const transient = await workbench
      .locator(
        ".quick-input-widget:visible, .monaco-dialog-box:visible, .context-view.monaco-menu-container:visible, " +
          ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible, " +
          ".monaco-hover:visible"
      )
      .allInnerTexts();
    assert.deepEqual(
      transient.map((text) => text.replace(/\s+/gu, " ").trim().slice(0, 500)),
      [],
      "DuckDB screenshot capture must not retain transient workbench UI."
    );

    mkdirSync(outputDirectory, { recursive: true });
    recordAcceptanceProgress("jupyter-allow:screenshot:duckdb");
    await captureNotebookWorkbenchScreenshot(
      workbench,
      path.resolve(
        outputDirectory,
        packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-duckdb", "dark")
      )
    );
  } finally {
    for (const { configuration, key, value } of previousSettings.reverse()) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await workbench.setViewportSize(previousViewport);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === previousThemeKind,
      10_000,
      "the DuckDB notebook workbench to restore its prior color theme"
    );
    await workbench.waitForTimeout(500);
  }
}

async function captureReleasedJupyterPySparkLive(
  workbench: Page,
  testing: TestApi,
  active: NonNullable<ReturnType<TestApi["activeSession"]>>,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  assert.equal(path.isAbsolute(outputDirectory), true, "PySpark screenshot output must be one absolute directory.");
  assert.equal(active.metadata.backend, "pyspark");
  assert.equal(active.metadata.source.kind, "notebookVariable");
  assert.equal(active.metadata.source.variableName, "spark_orders_frame");
  assert.deepEqual(active.metadata.shape, { rows: null, columns: 15 });

  const previousViewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  const previousThemeKind = vscode.window.activeColorTheme.kind;
  const workbenchConfiguration = vscode.workspace.getConfiguration("workbench");
  const breadcrumbs = vscode.workspace.getConfiguration("breadcrumbs");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const settings = [
    { configuration: windowConfiguration, key: "autoDetectColorScheme" },
    { configuration: windowConfiguration, key: "autoDetectHighContrast" },
    { configuration: windowConfiguration, key: "commandCenter" },
    { configuration: windowConfiguration, key: "title" },
    { configuration: workbenchConfiguration, key: "colorTheme" },
    { configuration: workbenchConfiguration, key: "statusBar.visible" },
    { configuration: breadcrumbs, key: "enabled" }
  ] as const;
  const previousSettings = settings.map(({ configuration, key }) => ({
    configuration,
    key,
    value: configuration.inspect(key)?.globalValue
  }));

  try {
    await workbench.setViewportSize(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT);
    assert.deepEqual(
      await workbench.evaluate(() => {
        const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
        return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
      }),
      PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
      "The PySpark notebook media scene requires the standard 1440 by 900 editor viewport."
    );
    await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update(
      "title",
      "${activeEditorShort}${separator}Open Wrangler",
      vscode.ConfigurationTarget.Global
    );
    await workbenchConfiguration.update(
      "colorTheme",
      releasedJupyterScreenshotTheme(),
      vscode.ConfigurationTarget.Global
    );
    await workbenchConfiguration.update("statusBar.visible", false, vscode.ConfigurationTarget.Global);
    await breadcrumbs.update("enabled", false, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
      10_000,
      "the dark PySpark notebook screenshot theme"
    );
    await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
      "workbench.action.closeSidebar",
      "workbench.action.toggleSidebarVisibility"
    ]);
    await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
      "workbench.action.closeAuxiliaryBar",
      "workbench.action.toggleAuxiliaryBar"
    ]);
    await closeVisibleWorkbenchPart(workbench, ".part.panel", [
      "workbench.action.closePanel",
      "workbench.action.togglePanel"
    ]);
    await clearReleasedJupyterScreenshotTransientUi(workbench);

    const selectedColumn = columnReference(active.metadata, "revenue");
    const baselineColumnWidths = new Map(
      active.metadata.schema.map(
        (column) =>
          [
            column.id,
            ["order_id", "market", "revenue", "fulfilled", "order_date"].includes(column.name)
              ? 204
              : ["segment", "channel"].includes(column.name)
                ? 197
                : 170
          ] as const
      )
    );
    await testing.updateViewState(active.sessionId, {
      ...active.viewState,
      columnWidths: baselineColumnWidths,
      selectedColumnId: selectedColumn.id,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(await testing.synchronizePanel(active.sessionId), true);

    const target = await waitForOpenWranglerGridTarget(workbench, testing, active.sessionId);
    const app = await exactSessionApp(target.frame, active.sessionId);
    assert.ok(app, "The PySpark screenshot requires the exact live Open Wrangler renderer.");
    const backendBadge = app.locator('[data-session-badge="backend"]');
    await backendBadge.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal((await backendBadge.innerText()).trim().toUpperCase(), "PYSPARK");
    const orderingBadge = app.locator('[data-session-badge="ordering"]');
    const modeBadge = app.locator('[data-session-badge="mode"]');
    assert.equal(await app.locator('[data-session-badge="experimental"]').count(), 0);
    assert.equal((await orderingBadge.innerText()).trim(), "SOURCE ORDER");
    assert.equal((await modeBadge.innerText()).trim(), "VIEWING ONLY");
    await orderingBadge.focus();
    await orderingBadge.press("Enter");
    const orderingHelp = app.getByRole("note");
    await orderingHelp.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      (await orderingHelp.innerText()).trim(),
      "Spark does not guarantee source order. Add a sort with a unique final key when you need repeatable rows."
    );
    await orderingBadge.press("Enter");
    await orderingHelp.waitFor({ state: "hidden", timeout: 10_000 });
    const toolbarBox = await app.locator(".toolbar").boundingBox();
    const allBadges = app.locator("[data-session-badge]");
    assert.equal(
      await allBadges.count(),
      3,
      "The PySpark notebook scene must expose ordering, mode, and backend badges."
    );
    const badgeBoxes = await Promise.all((await allBadges.all()).map((badge) => badge.boundingBox()));
    assert.ok(toolbarBox, "The PySpark media scene requires a measurable workbench toolbar.");
    assert.ok(
      badgeBoxes.every(
        (badge) =>
          badge !== null && badge.x >= toolbarBox.x && badge.x + badge.width <= toolbarBox.x + toolbarBox.width + 1
      ),
      "Every PySpark session badge must remain fully inside the workbench toolbar."
    );
    assert.equal(await app.getByRole("button", { name: "Add step" }).count(), 0);
    assert.equal(await app.getByRole("button", { name: "Apply step" }).count(), 0);

    const insightsToggle = app.getByRole("button", { name: "Column profiles and filters" });
    if ((await insightsToggle.getAttribute("aria-expanded")) !== "true") await insightsToggle.click();
    const drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("heading", { name: "revenue" }).waitFor({ state: "visible", timeout: 10_000 });
    const insightsDeadline = Date.now() + 60_000;
    let insightsReady = false;
    let summary = "";
    while (Date.now() < insightsDeadline) {
      summary = await drawer.innerText();
      if (
        summary.includes("Rows\n100,000") &&
        !summary.includes("Profiling selected column") &&
        ["Min", "Max", "Mean", "Median"].every((label) => new RegExp(`\\b${label}\\b`, "u").test(summary))
      ) {
        insightsReady = true;
        break;
      }
      await workbench.waitForTimeout(50);
    }
    if (!insightsReady) {
      throw new Error(`PySpark selected-column Insights did not finish: ${JSON.stringify(summary.slice(0, 2_000))}`);
    }

    const featuredColumns = ["order_id", "market", "revenue", "fulfilled", "order_date", "segment", "channel"];
    assert.deepEqual(
      active.metadata.schema.slice(0, featuredColumns.length).map((column) => column.name),
      featuredColumns,
      "The PySpark media scene requires its featured columns to remain the schema prefix."
    );
    const gridScroller = app.getByTestId("data-grid-scroller");
    const measuredGrid = await gridScroller.evaluate((element) => {
      const scroller = element as {
        clientWidth: number;
        querySelector(selector: string): { getBoundingClientRect(): { width: number } } | null;
      };
      const rowHeader = scroller.querySelector("th.rowHeader");
      return {
        clientWidth: scroller.clientWidth,
        rowHeaderWidth: rowHeader?.getBoundingClientRect().width ?? 0
      };
    });
    const rowHeaderWidth = Math.round(measuredGrid.rowHeaderWidth);
    const featuredDataWidth = measuredGrid.clientWidth - rowHeaderWidth;
    const featuredBaseWidth = Math.floor(featuredDataWidth / featuredColumns.length);
    const featuredWidthRemainder = featuredDataWidth % featuredColumns.length;
    assert.ok(
      Number.isSafeInteger(featuredDataWidth) &&
        featuredDataWidth > 0 &&
        rowHeaderWidth > 0 &&
        featuredBaseWidth >= 80 &&
        featuredBaseWidth + Number(featuredWidthRemainder > 0) <= 640,
      `The native PySpark grid cannot fit its complete featured prefix: ${JSON.stringify({
        ...measuredGrid,
        rowHeaderWidth,
        featuredDataWidth,
        featuredBaseWidth,
        featuredWidthRemainder
      })}`
    );
    const alignedColumnWidths = new Map(
      active.metadata.schema.map(
        (column) =>
          [
            column.id,
            column.position < featuredColumns.length
              ? featuredBaseWidth + Number(column.position < featuredWidthRemainder)
              : 170
          ] as const
      )
    );
    const confirmedViewState = testing.activeSession()?.viewState;
    assert.ok(confirmedViewState, "The PySpark media scene requires its confirmed presentation state.");
    await testing.updateViewState(active.sessionId, {
      ...confirmedViewState,
      columnWidths: alignedColumnWidths,
      selectedColumnId: selectedColumn.id,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(
      await testing.synchronizePanel(active.sessionId),
      true,
      "The PySpark media scene must synchronize its exact featured-column fit."
    );
    const channelColumn = columnReference(active.metadata, "channel");
    const firstPassGridBox = await gridScroller.boundingBox();
    const firstPassChannelBox = await app.locator('th[data-column="channel"]').boundingBox();
    assert.ok(firstPassGridBox, "The first PySpark media fit requires a measurable grid viewport.");
    assert.ok(firstPassChannelBox, "The first PySpark media fit requires a measurable channel header.");
    const widthCorrection = Math.round(
      firstPassGridBox.x + firstPassGridBox.width - (firstPassChannelBox.x + firstPassChannelBox.width)
    );
    if (Math.abs(widthCorrection) > 1) {
      const correctedChannelWidth = alignedColumnWidths.get(channelColumn.id)! + widthCorrection;
      assert.ok(
        correctedChannelWidth >= 80 && correctedChannelWidth <= 640,
        `The native PySpark grid produced an invalid final-column correction: ${JSON.stringify({
          widthCorrection,
          correctedChannelWidth
        })}`
      );
      const correctedViewState = testing.activeSession()?.viewState;
      assert.ok(correctedViewState, "The PySpark media correction requires its confirmed presentation state.");
      await testing.updateViewState(active.sessionId, {
        ...correctedViewState,
        columnWidths: new Map([...alignedColumnWidths, [channelColumn.id, correctedChannelWidth]]),
        selectedColumnId: selectedColumn.id,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      });
      assert.equal(
        await testing.synchronizePanel(active.sessionId),
        true,
        "The PySpark media scene must synchronize its native final-column correction."
      );
    }

    const headerProfiles = app.getByRole("button", { name: "Header profiles", exact: true });
    assert.equal(
      await headerProfiles.getAttribute("aria-pressed"),
      "false",
      "The PySpark media scene must not enable multi-column grid profiling."
    );
    assert.equal(
      await headerProfiles.getAttribute("title"),
      "Runs Spark profiling queries for the visible columns.",
      "The PySpark header-profile toggle must retain its explicit cost warning."
    );
    const loadedRows = app.getByRole("status", { name: "Visible rows" });
    assert.equal(await loadedRows.count(), 1, "The PySpark media scene must expose one visible-row status.");
    assert.match(
      (await loadedRows.innerText()).trim(),
      /^Rows 1\u2013\d+ · total appears after the last page$/u,
      "The PySpark media scene must label its progressive live total honestly."
    );
    const gridBox = await gridScroller.boundingBox();
    const rowHeaderBox = await app.locator("th.rowHeader").first().boundingBox();
    const orderIdBox = await app.locator('th[data-column="order_id"]').boundingBox();
    const channelBox = await app.locator('th[data-column="channel"]').boundingBox();
    assert.ok(gridBox, "The PySpark media scene requires a measurable grid viewport.");
    assert.ok(rowHeaderBox, "The PySpark media scene requires a measurable row header.");
    assert.ok(orderIdBox, "The PySpark media scene requires the complete order_id header.");
    assert.ok(channelBox, "The PySpark media scene requires the complete channel header.");
    const dataViewportLeft = rowHeaderBox.x + rowHeaderBox.width;
    const gridRight = gridBox.x + gridBox.width;
    const channelRight = channelBox.x + channelBox.width;
    assert.ok(
      Math.abs(orderIdBox.x - dataViewportLeft) <= 1,
      "The PySpark media scene must begin cleanly at the complete order_id column."
    );
    assert.ok(
      Math.abs(gridRight - channelRight) <= 1,
      "The PySpark media scene must end cleanly after the complete channel column."
    );
    const nextColumnBox = await app.locator('th[data-column="product_family"]').boundingBox();
    assert.ok(
      !nextColumnBox || nextColumnBox.x >= gridRight,
      "The PySpark media scene must not show a clipped product_family column."
    );
    await assertMediaColumnTitlesUnclipped(app, featuredColumns, "The PySpark notebook media scene");

    const commands = new Set(await vscode.commands.getCommands(true));
    if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
    if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
    await workbench.mouse.move(Math.floor(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT.width * 0.75), 40);
    await workbench.waitForTimeout(500);
    const transient = await workbench
      .locator(
        ".quick-input-widget:visible, .monaco-dialog-box:visible, .context-view.monaco-menu-container:visible, " +
          ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible, " +
          ".monaco-hover:visible"
      )
      .allInnerTexts();
    assert.deepEqual(
      transient.map((text) => text.replace(/\s+/gu, " ").trim().slice(0, 500)),
      [],
      "PySpark screenshot capture must not retain transient workbench UI."
    );

    mkdirSync(outputDirectory, { recursive: true });
    recordAcceptanceProgress("jupyter-pyspark:screenshot:classic");
    await captureNotebookWorkbenchScreenshot(
      workbench,
      path.resolve(
        outputDirectory,
        packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-pyspark", "dark")
      )
    );
  } finally {
    for (const { configuration, key, value } of previousSettings.reverse()) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await workbench.setViewportSize(previousViewport);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === previousThemeKind,
      10_000,
      "the PySpark notebook workbench to restore its prior color theme"
    );
    await workbench.waitForTimeout(500);
  }
}

async function capturePackagedEditorScreenshots(testing: TestApi, outputDirectory: string): Promise<void> {
  if (process.platform !== "linux") return;
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-screenshot-evidence-"));
  const fixture = vscode.Uri.file(path.join(fixtureDirectory, "regional-orders-2024-2025.csv"));
  writeFileSync(fixture.fsPath, packagedScreenshotFixtureCsv(), { encoding: "utf8", flag: "wx" });
  const workbench = vscode.workspace.getConfiguration("workbench");
  const breadcrumbs = vscode.workspace.getConfiguration("breadcrumbs");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const scm = vscode.workspace.getConfiguration("scm");
  const typescript = vscode.workspace.getConfiguration("typescript");
  const javascript = vscode.workspace.getConfiguration("javascript");
  const originalTheme = workbench.get<string>("colorTheme");
  const originalStatusBarVisible = workbench.get<boolean>("statusBar.visible");
  const originalBreadcrumbsEnabled = breadcrumbs.get<boolean>("enabled");
  const originalZoom = windowConfiguration.get<number>("zoomLevel");
  const originalTitle = windowConfiguration.get<string>("title");
  const originalCommandCenter = windowConfiguration.get<boolean>("commandCenter");
  const originalAutoDetectColorScheme = windowConfiguration.get<boolean>("autoDetectColorScheme");
  const originalAutoDetectHighContrast = windowConfiguration.get<boolean>("autoDetectHighContrast");
  const originalScmCountBadge = scm.get<string>("countBadge");
  const originalTypescriptValidation = typescript.get<boolean>("validate.enable");
  const originalJavascriptValidation = javascript.get<boolean>("validate.enable");
  const editor = process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor";
  let capturePage: Page;
  try {
    capturePage = await connectToEditorWorkbench();
    await capturePage.setViewportSize(PACKAGED_SCREENSHOT_VIEWPORT);
    const captureViewport = await capturePage.evaluate(() => {
      const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
      return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
    });
    assert.deepEqual(
      captureViewport,
      PACKAGED_SCREENSHOT_VIEWPORT,
      `README evidence requires the deterministic ${PACKAGED_SCREENSHOT_VIEWPORT.width} by ${PACKAGED_SCREENSHOT_VIEWPORT.height} packaged-editor viewport.`
    );
    await prepareWorkbenchForEvidence();
    await hideCodePreviewPanel();
    await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
    recordAcceptanceProgress("verify:screenshots:open");
    mkdirSync(outputDirectory, { recursive: true });
    await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitFor(
      () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the custom editor before screenshot capture"
    );
    const opened = testing.activeSession();
    assert.ok(opened, "The screenshot fixture must publish one active session.");
    assert.deepEqual(opened.metadata.shape, {
      rows: PACKAGED_SCREENSHOT_ROW_COUNT,
      columns: PACKAGED_SCREENSHOT_COLUMNS.length
    });
    assert.deepEqual(opened.metadata.filterModel, { logic: "and", filters: [], sort: [] });
    assert.deepEqual(opened.metadata.steps, []);
    assert.equal(opened.metadata.draftStep, undefined);
    assert.deepEqual(opened.viewState, {
      filterModel: { logic: "and", filters: [], sort: [] },
      columnWidths: new Map(),
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    await waitFor(
      () => testing.panelHydrated(opened.sessionId),
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the screenshot fixture panel to hydrate"
    );
    assert.equal(
      await testing.synchronizePanel(opened.sessionId),
      true,
      "The clean screenshot fixture must publish its initial renderer snapshot."
    );
    const gridTarget = await waitForOpenWranglerGridTarget(capturePage, testing, opened.sessionId);
    const app = await exactSessionApp(gridTarget.frame, opened.sessionId);
    assert.ok(app, "The screenshot fixture must expose its exact live application root.");
    const revenue = columnReference(opened.metadata, "revenue");
    await testing.updateViewState(opened.sessionId, {
      ...opened.viewState,
      selectedColumnId: revenue.id
    });
    assert.equal(
      await testing.synchronizePanel(opened.sessionId),
      true,
      "The screenshot fixture must synchronize its selected revenue column."
    );
    assert.equal(testing.activeSession()?.viewState.selectedColumnId, revenue.id);
  } catch (error) {
    const active = testing.activeSession();
    if (active?.metadata.source.path === fixture.fsPath) {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        10_000,
        "the failed screenshot session and runtime to close"
      );
    }
    if (testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning()) {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
    throw error;
  }

  const darkTheme = contributedTheme("vs-dark", "Default Dark Modern");
  const lightTheme = contributedTheme("vs", "Default Light Modern");
  const highContrastTheme = contributedTheme("hc-black", "Default High Contrast");
  try {
    recordAcceptanceProgress("verify:screenshots:prepare");
    await workbench.update("statusBar.visible", false, vscode.ConfigurationTarget.Global);
    await breadcrumbs.update("enabled", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update(
      "title",
      "${activeEditorShort}${separator}Open Wrangler",
      vscode.ConfigurationTarget.Global
    );
    await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
    await scm.update("countBadge", "off", vscode.ConfigurationTarget.Global);
    await typescript.update("validate.enable", false, vscode.ConfigurationTarget.Global);
    await javascript.update("validate.enable", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
    await prepareWorkbenchForEvidence();
    await hideCodePreviewPanel();
    const hero = testing.activeSession();
    assert.ok(hero, "The screenshot fixture must remain active while selected-column Insights is composed.");
    await closeVisibleWorkbenchPart(capturePage, ".part.sidebar", [
      "workbench.action.closeSidebar",
      "workbench.action.toggleSidebarVisibility"
    ]);
    await openSelectedColumnInsights(hero.sessionId, "revenue");
    assert.equal(
      await testing.synchronizePanel(hero.sessionId),
      true,
      "Selected-column Insights must synchronize with the exact renderer."
    );
    await fitFeaturedGridColumns(hero.sessionId, columnReference(hero.metadata, "revenue").id);
    recordAcceptanceProgress("verify:screenshots:hero-dark");
    await captureTheme(
      darkTheme,
      vscode.ColorThemeKind.Dark,
      0,
      packagedScreenshotFileName(editor, "hero", "dark"),
      "hero"
    );
    recordAcceptanceProgress("verify:screenshots:hero-light");
    await captureTheme(
      lightTheme,
      vscode.ColorThemeKind.Light,
      0,
      packagedScreenshotFileName(editor, "hero", "light"),
      "hero"
    );
    recordAcceptanceProgress("verify:screenshots:high-contrast");
    await captureTheme(
      highContrastTheme,
      vscode.ColorThemeKind.HighContrast,
      4,
      `${editor}-high-contrast-zoom-200.png`,
      "responsive"
    );
    recordAcceptanceProgress("verify:screenshots:restore");
  } finally {
    await workbench.update("colorTheme", originalTheme, vscode.ConfigurationTarget.Global);
    await workbench.update("statusBar.visible", originalStatusBarVisible, vscode.ConfigurationTarget.Global);
    await breadcrumbs.update("enabled", originalBreadcrumbsEnabled, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("zoomLevel", originalZoom, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("title", originalTitle, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("commandCenter", originalCommandCenter, vscode.ConfigurationTarget.Global);
    await scm.update("countBadge", originalScmCountBadge, vscode.ConfigurationTarget.Global);
    await typescript.update("validate.enable", originalTypescriptValidation, vscode.ConfigurationTarget.Global);
    await javascript.update("validate.enable", originalJavascriptValidation, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update(
      "autoDetectColorScheme",
      originalAutoDetectColorScheme,
      vscode.ConfigurationTarget.Global
    );
    await windowConfiguration.update(
      "autoDetectHighContrast",
      originalAutoDetectHighContrast,
      vscode.ConfigurationTarget.Global
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the screenshot session and runtime to close"
    );
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
  await capturePackagedFileWorkflowScenes(testing, outputDirectory);
  await capturePackagedWideSchemaColumnSearchScene(testing, outputDirectory);
  recordAcceptanceProgress("verify:screenshots:complete");

  async function captureTheme(
    theme: string,
    expectedKind: vscode.ColorThemeKind,
    zoomLevel: number,
    fileName: string,
    scene?: "hero" | "responsive"
  ): Promise<void> {
    await workbench.update("colorTheme", theme, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("zoomLevel", zoomLevel, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === expectedKind,
      10_000,
      `${theme} to activate before screenshot capture`
    );
    await clearNotifications();
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const destination = path.resolve(outputDirectory, fileName);
    await capturePage.bringToFront();
    const viewport = await capturePage.evaluate(() => {
      const pageWindow = globalThis as unknown as {
        innerWidth: number;
        innerHeight: number;
        devicePixelRatio: number;
      };
      return {
        width: pageWindow.innerWidth,
        height: pageWindow.innerHeight,
        scale: Math.max(1, pageWindow.devicePixelRatio)
      };
    });
    await capturePage.keyboard.press("Escape");
    await capturePage.mouse.move(Math.max(1, Math.floor(viewport.width * 0.75)), 40);
    await clearNotifications();
    assert.equal(
      await pollAcceptanceCondition(async () => (await capturePage.locator(".monaco-hover:visible").count()) === 0, {
        timeoutMs: 3_000,
        intervalMs: 50
      }),
      true,
      "Screenshot capture must dismiss every workbench hover."
    );
    const transientUi = await inspectCaptureTransientUi();
    assert.equal(
      transientUi.length,
      0,
      `A packaged screenshot must not contain transient workbench UI: ${JSON.stringify(transientUi)}`
    );
    if (scene === "hero") await assertPackagedScreenshotScene(scene);
    if (scene === "responsive") await assertResponsivePackagedControls();
    await captureWorkbenchScreenshot(capturePage, destination);
  }

  async function inspectCaptureTransientUi(): Promise<Array<{ kind: string; text: string }>> {
    const selectors = [
      ["hover", ".monaco-hover:visible"],
      ["quick input", ".quick-input-widget:visible"],
      ["dialog", ".monaco-dialog-box:visible"],
      ["menu", ".context-view.monaco-menu-container:visible"],
      [
        "notification",
        ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
      ]
    ] as const;
    const entries = await Promise.all(
      selectors.map(async ([kind, selector]) =>
        (await capturePage.locator(selector).allInnerTexts()).map((text) => ({
          kind,
          text: text.replace(/\s+/gu, " ").trim().slice(0, 500)
        }))
      )
    );
    return entries.flat();
  }

  async function fitFeaturedGridColumns(
    sessionId: string,
    selectedColumnId: string
  ): Promise<ReadonlyMap<string, number>> {
    const active = testing.activeSession();
    assert.equal(active?.sessionId, sessionId, "Screenshot grid fitting requires the exact active session.");
    assert.ok(active, "Screenshot grid fitting requires one active dataframe session.");
    const target = await waitForOpenWranglerGridTarget(capturePage, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "Screenshot grid fitting requires the exact live Open Wrangler renderer.");
    const gridDimensions = await app.locator('[data-testid="data-grid-scroller"]').evaluate((scroller) => {
      const rowHeader = scroller.querySelector("th.rowHeader");
      if (!rowHeader) throw new Error("The screenshot grid row header is unavailable.");
      return {
        clientWidth: scroller.clientWidth,
        rowHeaderWidth: rowHeader.getBoundingClientRect().width
      };
    });
    const widthsByName = packagedScreenshotFeaturedColumnWidths(
      gridDimensions.clientWidth,
      gridDimensions.rowHeaderWidth
    );
    let columnWidths = new Map(
      active.metadata.schema
        .filter((column) => column.name in widthsByName)
        .map((column) => [column.id, widthsByName[column.name as keyof typeof widthsByName]] as const)
    );
    await testing.updateViewState(sessionId, {
      columnWidths,
      selectedColumnId,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The fitted screenshot grid must synchronize with its exact renderer."
    );
    const orderDate = columnReference(active.metadata, "order_date");
    const trailingGap = await app.evaluate((root, columnName) => {
      type ScreenshotRect = { readonly right: number };
      type ScreenshotElement = {
        readonly dataset: Readonly<Record<string, string | undefined>>;
        getBoundingClientRect(): ScreenshotRect;
        querySelector(selector: string): ScreenshotElement | null;
        querySelectorAll(selector: string): ArrayLike<ScreenshotElement>;
      };
      const appRoot = root as unknown as ScreenshotElement;
      const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
      const header = Array.from(appRoot.querySelectorAll("th[data-column]")).find(
        (candidate) => candidate.dataset.column === columnName
      );
      if (!scroller || !header) throw new Error("The screenshot grid fit geometry is incomplete.");
      return scroller.getBoundingClientRect().right - header.getBoundingClientRect().right;
    }, orderDate.name);
    assert.ok(trailingGap >= -1, "The final featured screenshot column must not extend beyond the live grid.");
    if (trailingGap > 1) {
      const adjustedWidth = (columnWidths.get(orderDate.id) ?? widthsByName.order_date) + Math.floor(trailingGap);
      assert.ok(adjustedWidth <= 640, "The live screenshot grid fit must retain the maximum column width.");
      columnWidths = new Map([...columnWidths, [orderDate.id, adjustedWidth]]);
      await testing.updateViewState(sessionId, {
        columnWidths,
        selectedColumnId,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      });
      assert.equal(
        await testing.synchronizePanel(sessionId),
        true,
        "The final measured screenshot grid fit must synchronize with its exact renderer."
      );
    }
    assert.deepEqual(testing.activeSession()?.viewState.columnWidths, columnWidths);
    assert.equal(testing.activeSession()?.viewState.selectedColumnId, selectedColumnId);
    return columnWidths;
  }

  async function openSelectedColumnInsights(sessionId: string, expectedColumn: string): Promise<void> {
    const target = await waitForOpenWranglerGridTarget(capturePage, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "Selected-column Insights requires the exact live Open Wrangler renderer.");
    const toggle = app.getByRole("button", { name: "Column profiles and filters" });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("tab", { name: "Column" }).waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("heading", { name: expectedColumn }).waitFor({ state: "visible", timeout: 10_000 });
    const deadline = Date.now() + 30_000;
    do {
      const summary = await drawer.innerText();
      if (
        !summary.includes("Profiling selected column") &&
        ["Min", "Max", "Mean", "Median"].every((label) => new RegExp(`\\b${label}\\b`, "u").test(summary))
      ) {
        return;
      }
      await capturePage.waitForTimeout(50);
    } while (Date.now() < deadline);
    throw new Error(`Selected-column Insights did not publish complete numeric statistics for ${expectedColumn}.`);
  }

  async function assertPackagedScreenshotScene(scene: "hero"): Promise<void> {
    assert.equal(
      await capturePage.locator(".part.sidebar:visible").count(),
      0,
      "The compact hero must not retain a competing native sidebar."
    );
    const active = testing.activeSession();
    assert.ok(active, "Screenshot geometry requires the active packaged dataframe session.");
    const target = await waitForOpenWranglerGridTarget(capturePage, testing, active.sessionId);
    const app = await exactSessionApp(target.frame, active.sessionId);
    assert.ok(app, "Screenshot geometry requires the exact live Open Wrangler renderer.");
    const deadline = Date.now() + 15_000;
    let measurement:
      | {
          workspaceOverflow: number;
          gridOverflow: number;
          gridScrollLeft: number;
          renderedColumns: string[];
          missingFeaturedColumns: string[];
          partialColumns: string[];
          clippedColumnTitles: string[];
          clippedColumnStats: string[];
          clippedColumnVisualizations: string[];
          clippedCells: number;
          clippedControls: string[];
          revenueSummary: string;
          insightsHeading: string;
          insightsStats: Record<string, string>;
          insightsOverflow: number;
          insightsContained: boolean;
          draftVisible: boolean;
          columnSearchOpen: boolean;
        }
      | undefined;
    do {
      measurement = await app.evaluate(
        (root, expected) => {
          type ScreenshotRect = {
            readonly bottom: number;
            readonly left: number;
            readonly right: number;
            readonly top: number;
          };
          type ScreenshotElement = {
            readonly className: string;
            readonly clientWidth: number;
            readonly dataset: Readonly<Record<string, string | undefined>>;
            readonly innerText: string;
            readonly scrollLeft: number;
            readonly scrollWidth: number;
            getBoundingClientRect(): ScreenshotRect;
            querySelector(selector: string): ScreenshotElement | null;
            querySelectorAll(selector: string): ArrayLike<ScreenshotElement>;
          };
          const appRoot = root as unknown as ScreenshotElement;
          const workspace = appRoot.querySelector(".layout");
          const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
          if (!workspace || !scroller) throw new Error("The packaged screenshot layout is incomplete.");
          const scrollerBounds = scroller.getBoundingClientRect();
          const headers = Array.from(appRoot.querySelectorAll("th[data-column]"));
          const renderedColumns = headers.map((header) => header.dataset.column ?? "");
          const featuredHeaders = expected.featured.map((name) =>
            headers.find((header) => header.dataset.column === name)
          );
          const nextHeader = headers.find((header) => header.dataset.column === expected.nextColumn);
          const partialColumns = headers
            .filter((header) => {
              const bounds = header.getBoundingClientRect();
              const intersects = bounds.right > scrollerBounds.left + 1 && bounds.left < scrollerBounds.right - 1;
              const contained = bounds.left >= scrollerBounds.left - 1 && bounds.right <= scrollerBounds.right + 1;
              return intersects && !contained;
            })
            .map((header) => header.dataset.column ?? "");
          if (nextHeader) {
            const bounds = nextHeader.getBoundingClientRect();
            if (bounds.left < scrollerBounds.right - 1 && bounds.right > scrollerBounds.left + 1) {
              partialColumns.push(expected.nextColumn);
            }
          }
          const clippedColumnTitles = featuredHeaders.flatMap((header, index) => {
            const title = header?.querySelector(".columnTitle");
            return title && title.scrollWidth > title.clientWidth + 1 ? [expected.featured[index] ?? ""] : [];
          });
          const clippedColumnStats = featuredHeaders.flatMap((header, index) => {
            const clipped = Array.from(header?.querySelectorAll(".exactSummaryStats span") ?? []).some(
              (item) => item.scrollWidth > item.clientWidth + 1
            );
            return clipped ? [expected.featured[index] ?? ""] : [];
          });
          const clippedColumnVisualizations = featuredHeaders.flatMap((header, index) => {
            if (!header) return [];
            const headerBounds = header.getBoundingClientRect();
            const clipped = Array.from(
              header.querySelectorAll(
                ".categoryMiniRow small, .datetimeMiniChart span, .numericMiniChart text, .booleanMiniChart span"
              )
            ).some((item) => {
              const bounds = item.getBoundingClientRect();
              return (
                item.scrollWidth > item.clientWidth + 1 ||
                bounds.left < headerBounds.left - 1 ||
                bounds.right > headerBounds.right + 1
              );
            });
            return clipped ? [expected.featured[index] ?? ""] : [];
          });
          const visibleCells = Array.from(appRoot.querySelectorAll("td[data-grid-column]")).filter((cell) => {
            const bounds = cell.getBoundingClientRect();
            return bounds.right > scrollerBounds.left && bounds.left < scrollerBounds.right;
          });
          const controls = Array.from(appRoot.querySelectorAll(".toolbar, .toolbarPlan, .gridStatusBar, .draftReview"));
          const clippedControls = controls
            .filter((element) => element.scrollWidth > element.clientWidth + 1)
            .map((element) => element.className);
          const revenueHeader = headers.find((header) => header.dataset.column === "revenue");
          const insights = appRoot.querySelector("#openwrangler-insights-panel");
          const insightLabels = Array.from(insights?.querySelectorAll(".summaryStatGrid dt") ?? []);
          const insightValues = Array.from(insights?.querySelectorAll(".summaryStatGrid dd") ?? []);
          const insightsBounds = insights?.getBoundingClientRect();
          const workspaceBounds = workspace.getBoundingClientRect();
          const draft = appRoot.querySelector('.draftReview[aria-label="Draft review"]');
          const columnSearch = appRoot.querySelector(".columnSearchPopup");
          return {
            workspaceOverflow: workspace.scrollWidth - workspace.clientWidth,
            gridOverflow: scroller.scrollWidth - scroller.clientWidth,
            gridScrollLeft: scroller.scrollLeft,
            renderedColumns,
            missingFeaturedColumns: expected.featured.filter((_, index) => !featuredHeaders[index]),
            partialColumns: [...new Set(partialColumns)],
            clippedColumnTitles,
            clippedColumnStats,
            clippedColumnVisualizations,
            clippedCells: visibleCells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
            clippedControls,
            revenueSummary: revenueHeader?.querySelector(".exactSummaryStats")?.innerText ?? "",
            insightsHeading: insights?.querySelector(".summaryColumnHeader h2")?.innerText ?? "",
            insightsStats: Object.fromEntries(
              insightLabels.map((label, index) => [label.innerText, insightValues[index]?.innerText ?? ""])
            ),
            insightsOverflow: insights ? insights.scrollWidth - insights.clientWidth : Number.POSITIVE_INFINITY,
            insightsContained: Boolean(
              insightsBounds &&
              insightsBounds.left >= workspaceBounds.left - 1 &&
              insightsBounds.right <= workspaceBounds.right + 1
            ),
            draftVisible: Boolean(draft),
            columnSearchOpen: Boolean(columnSearch)
          };
        },
        {
          featured: [...PACKAGED_SCREENSHOT_FEATURED_COLUMNS],
          nextColumn: PACKAGED_SCREENSHOT_COLUMNS[PACKAGED_SCREENSHOT_FEATURED_COLUMNS.length]
        }
      );
      const ready =
        measurement.workspaceOverflow <= 1 &&
        measurement.gridOverflow > 0 &&
        measurement.gridScrollLeft <= 1 &&
        measurement.missingFeaturedColumns.length === 0 &&
        measurement.partialColumns.length === 0 &&
        measurement.clippedColumnTitles.length === 0 &&
        measurement.clippedColumnStats.length === 0 &&
        measurement.clippedColumnVisualizations.length === 0 &&
        measurement.clippedCells === 0 &&
        measurement.clippedControls.length === 0 &&
        /\bMin\b/u.test(measurement.revenueSummary) &&
        /\bMax\b/u.test(measurement.revenueSummary) &&
        measurement.insightsHeading === "revenue" &&
        ["Min", "Max", "Mean", "Median"].every((label) => {
          const value = measurement?.insightsStats[label];
          return typeof value === "string" && value.length > 0 && value !== "n/a";
        }) &&
        measurement.insightsOverflow <= 1 &&
        measurement.insightsContained &&
        !measurement.draftVisible &&
        !measurement.columnSearchOpen;
      if (ready) return;
      await capturePage.waitForTimeout(50);
    } while (Date.now() < deadline);
    throw new Error(`The ${scene} screenshot scene is clipped or incomplete: ${JSON.stringify(measurement)}`);
  }

  async function assertResponsivePackagedControls(): Promise<void> {
    const active = testing.activeSession();
    assert.ok(active, "Responsive screenshot geometry requires the active packaged dataframe session.");
    const target = await waitForOpenWranglerGridTarget(capturePage, testing, active.sessionId);
    const app = await exactSessionApp(target.frame, active.sessionId);
    assert.ok(app, "Responsive screenshot geometry requires the exact live Open Wrangler renderer.");
    const measurement = await app.evaluate((root) => {
      const appBounds = root.getBoundingClientRect();
      const toolbar = root.querySelector(".toolbar");
      const toolbarActions = root.querySelector(".toolbarActions");
      const gridStatusBar = root.querySelector(".gridStatusBar");
      if (!toolbar || !toolbarActions || !gridStatusBar) {
        throw new Error("Responsive screenshot controls are incomplete.");
      }
      const clippedChildren = (containerSelector: string, selector: string): string[] => {
        const container = root.querySelector(containerSelector);
        if (!container) return [`Missing ${containerSelector}`];
        const containerBounds = container.getBoundingClientRect();
        return [...container.querySelectorAll(selector)]
          .filter((element) => {
            const style = element.ownerDocument.defaultView?.getComputedStyle(element);
            if (!style || style.display === "none" || style.visibility === "hidden") return false;
            const bounds = element.getBoundingClientRect();
            return (
              bounds.left < Math.max(appBounds.left, containerBounds.left) - 1 ||
              bounds.right > Math.min(appBounds.right, containerBounds.right) + 1 ||
              bounds.top < containerBounds.top - 1 ||
              bounds.bottom > containerBounds.bottom + 1
            );
          })
          .map(
            (element) =>
              element.getAttribute("aria-label") ?? element.textContent?.replace(/\s+/gu, " ").trim() ?? element.tagName
          );
      };
      return {
        appOverflow: root.scrollWidth - root.clientWidth,
        toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth,
        toolbarActionsOverflow: toolbarActions.scrollWidth - toolbarActions.clientWidth,
        gridStatusBarOverflow: gridStatusBar.scrollWidth - gridStatusBar.clientWidth,
        clippedToolbarControls: clippedChildren(".toolbarActions", ":scope > *"),
        clippedGridStatusBar: clippedChildren(".gridStatusBar", ":scope > *")
      };
    });
    assert.ok(
      measurement.appOverflow <= 1 &&
        measurement.toolbarOverflow <= 1 &&
        measurement.toolbarActionsOverflow <= 1 &&
        measurement.gridStatusBarOverflow <= 1,
      `The 200% zoom layout must not overflow horizontally: ${JSON.stringify(measurement)}`
    );
    assert.deepEqual(
      measurement.clippedToolbarControls,
      [],
      "Every toolbar action must remain completely visible at 200% zoom."
    );
    assert.deepEqual(
      measurement.clippedGridStatusBar,
      [],
      "Every grid status control and the visible-row range must remain completely visible at 200% zoom."
    );
  }

  async function prepareWorkbenchForEvidence(): Promise<void> {
    const commands = new Set(await vscode.commands.getCommands(true));
    const auxiliaryBar = capturePage.locator(".part.auxiliarybar");
    if ((await auxiliaryBar.count()) > 0 && (await auxiliaryBar.isVisible())) {
      const closeCommand = commands.has("workbench.action.closeAuxiliaryBar")
        ? "workbench.action.closeAuxiliaryBar"
        : commands.has("workbench.action.toggleAuxiliaryBar")
          ? "workbench.action.toggleAuxiliaryBar"
          : undefined;
      if (closeCommand) {
        await vscode.commands.executeCommand(closeCommand);
        await auxiliaryBar.waitFor({ state: "hidden", timeout: 10_000 });
      }
    }
    await clearNotifications(commands);
  }

  async function hideCodePreviewPanel(): Promise<void> {
    const panel = capturePage.locator(".part.panel").first();
    if ((await panel.count()) === 0 || !(await panel.isVisible())) return;
    const commands = new Set(await vscode.commands.getCommands(true));
    assert.equal(
      commands.has("workbench.action.closePanel"),
      true,
      "The workbench must expose its panel close command."
    );
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await panel.waitFor({ state: "hidden", timeout: 10_000 });
  }

  async function clearNotifications(commands?: Set<string>): Promise<void> {
    const availableCommands = commands ?? new Set(await vscode.commands.getCommands(true));
    if (availableCommands.has("notifications.clearAll")) {
      await vscode.commands.executeCommand("notifications.clearAll");
    }
    if (availableCommands.has("notifications.hideList")) {
      await vscode.commands.executeCommand("notifications.hideList");
    }
    const notificationItems = capturePage.locator(
      ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
    );
    await capturePage
      .locator(
        ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
      )
      .first()
      .waitFor({ state: "hidden", timeout: 10_000 })
      .catch(async (error: unknown) => {
        const visible = (await notificationItems.allInnerTexts()).map((text) =>
          text.replace(/\s+/gu, " ").trim().slice(0, 500)
        );
        throw new Error(
          `Visible notifications remained after deterministic workbench cleanup: ${JSON.stringify(visible)}`,
          {
            cause: error
          }
        );
      });
  }

  function contributedTheme(uiTheme: string, fallback: string): string {
    const themes = vscode.extensions.all.flatMap(
      (extension) =>
        (extension.packageJSON.contributes?.themes ?? []) as Array<{
          id?: string;
          label?: string;
          uiTheme?: string;
        }>
    );
    const candidates = themes.filter((theme) => theme.uiTheme === uiTheme);
    if (editor === "cursor") {
      const cursorTheme = candidates.find((theme) =>
        uiTheme === "vs-dark"
          ? theme.label === "Cursor Dark"
          : uiTheme === "vs"
            ? theme.label === "Cursor Light"
            : theme.label === "Cursor Dark High Contrast"
      );
      if (cursorTheme) return cursorTheme.id ?? cursorTheme.label ?? fallback;
    }
    const preferred = candidates.find((theme) => /default|modern/i.test(theme.label ?? theme.id ?? ""));
    return preferred?.id ?? preferred?.label ?? candidates[0]?.id ?? candidates[0]?.label ?? fallback;
  }
}

async function capturePackagedFileWorkflowScenes(testing: TestApi, outputDirectory: string): Promise<void> {
  if (process.platform !== "linux") return;
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "Packaged product scenes require the isolated acceptance workspace.");
  assert.equal(workspace.scheme, "file", "Packaged product scenes require one local isolated workspace.");
  const fixture = ensurePackagedProductSceneFixture(workspace);
  const sourceBytes = readFileSync(fixture.fsPath);
  const workbench = vscode.workspace.getConfiguration("workbench");
  const breadcrumbs = vscode.workspace.getConfiguration("breadcrumbs");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const scm = vscode.workspace.getConfiguration("scm");
  const originalTheme = workbench.get<string>("colorTheme");
  const originalStatusBarVisible = workbench.get<boolean>("statusBar.visible");
  const originalActivityBarLocation = workbench.get<string>("activityBar.location");
  const originalBreadcrumbsEnabled = breadcrumbs.get<boolean>("enabled");
  const originalZoom = windowConfiguration.get<number>("zoomLevel");
  const originalCommandCenter = windowConfiguration.get<boolean>("commandCenter");
  const originalAutoDetectColorScheme = windowConfiguration.get<boolean>("autoDetectColorScheme");
  const originalAutoDetectHighContrast = windowConfiguration.get<boolean>("autoDetectHighContrast");
  const originalScmCountBadge = scm.get<string>("countBadge");
  const editor = process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor";
  const capturePage = await connectToEditorWorkbench();
  const originalViewport = await capturePage.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  let sessionId: string | undefined;

  try {
    recordAcceptanceProgress("verify:screenshots:file-scenes:prepare");
    await capturePage.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
    assert.deepEqual(
      await capturePage.evaluate(() => {
        const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
        return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
      }),
      PACKAGED_PRODUCT_VIEWPORT,
      "Packaged file scenes require the standard 1440 by 900 product viewport."
    );
    await workbench.update(
      "colorTheme",
      contributedProductSceneTheme(editor, "vs-dark", "Default Dark Modern"),
      vscode.ConfigurationTarget.Global
    );
    await workbench.update("statusBar.visible", true, vscode.ConfigurationTarget.Global);
    await workbench.update("activityBar.location", "default", vscode.ConfigurationTarget.Global);
    await breadcrumbs.update("enabled", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("zoomLevel", 0, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
    await scm.update("countBadge", "off", vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
      10_000,
      "the packaged product-scene dark theme"
    );
    await closeVisibleWorkbenchPart(capturePage, ".part.auxiliarybar", [
      "workbench.action.closeAuxiliaryBar",
      "workbench.action.toggleAuxiliaryBar"
    ]);
    await closeVisibleWorkbenchPart(capturePage, ".part.panel", [
      "workbench.action.closePanel",
      "workbench.action.togglePanel"
    ]);
    await clearPackagedProductSceneTransientUi(capturePage);

    recordAcceptanceProgress("verify:screenshots:file-scenes:open");
    await openPackagedProductFixtureThroughExplorer(capturePage, fixture, outputDirectory, editor);
    await waitForAutomaticDelimitedImport(capturePage, testing, fixture, "verify:screenshots:file-scenes:import");
    await waitFor(
      () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the deterministic full-size fixture to open for packaged product scenes"
    );
    const opened = testing.activeSession();
    assert.ok(opened, "Packaged product scenes require one active full-size session.");
    sessionId = opened.sessionId;
    assert.equal(opened.metadata.backend, "polars");
    assert.deepEqual(opened.metadata.shape, {
      rows: PACKAGED_SCREENSHOT_ROW_COUNT,
      columns: PACKAGED_SCREENSHOT_COLUMNS.length
    });
    assert.deepEqual(opened.metadata.source.importOptions, {
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    await waitFor(
      () => testing.panelHydrated(opened.sessionId),
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the full-size product-scene panel to hydrate"
    );
    assert.equal(
      await testing.synchronizePanel(opened.sessionId),
      true,
      "The full-size product scene must synchronize with its exact renderer."
    );

    const revenue = columnReference(opened.metadata, "revenue");
    let target = await waitForOpenWranglerGridTarget(capturePage, testing, opened.sessionId);
    let app = await exactSessionApp(target.frame, opened.sessionId);
    assert.ok(app, "The Explore scene requires the exact production Open Wrangler renderer.");
    const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await columnSearch.fill("revenue");
    await app.getByRole("option", { name: "revenue, Number column", exact: true }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    await columnSearch.press("Enter");
    await waitFor(
      () => testing.activeSession()?.viewState.selectedColumnId === revenue.id,
      10_000,
      "the Explore scene to select revenue through the production column search"
    );
    const profilesToggle = app.getByRole("button", { name: "Column profiles and filters" });
    if ((await profilesToggle.getAttribute("aria-expanded")) !== "true") await profilesToggle.click();
    let profiles = app.getByRole("complementary", { name: "Column profiles and filters" });
    await profiles.waitFor({ state: "visible", timeout: 10_000 });
    await waitForLocatorText(
      profiles,
      (text) => {
        const normalized = text.toLowerCase();
        return (
          !normalized.includes("profiling selected column") &&
          ["min", "max", "mean", "median", "distribution", "counts"].every((label) => normalized.includes(label))
        );
      },
      30_000,
      "the initial complete Explore revenue profile"
    );
    await profiles.getByRole("tab", { name: "Dataset", exact: true }).click();
    await waitFor(
      () => testing.activeSession()?.metadata.stats !== undefined,
      30_000,
      "the Explore sidebar to receive exact dataset statistics"
    );
    await profiles.getByRole("tab", { name: "Column", exact: true }).click();
    await waitForLocatorText(
      profiles,
      (text) => {
        const normalized = text.toLowerCase();
        return (
          !normalized.includes("profiling selected column") &&
          ["min", "max", "mean", "median", "distribution", "counts"].every((label) => normalized.includes(label))
        );
      },
      30_000,
      "the complete Explore revenue profile"
    );
    const exploreSidebar = await arrangePackagedProductSidebar(capturePage, "explore");
    await fitPackagedProductSceneGrid(testing, capturePage, opened.sessionId, revenue.id);
    await assertPackagedExploreScene(capturePage, testing, opened.sessionId, exploreSidebar);
    await clearPackagedProductSceneTransientUi(capturePage);
    recordAcceptanceProgress("verify:screenshots:file-scenes:explore");
    mkdirSync(outputDirectory, { recursive: true });
    await captureWorkbenchScreenshot(
      capturePage,
      path.resolve(outputDirectory, packagedScreenshotFileName(editor, "explore", "dark"))
    );
    await capturePackagedHighContrastExploreScene(capturePage, testing, opened.sessionId, outputDirectory, editor);
    await capturePackagedImportOptionsScene(capturePage, testing, opened.sessionId, fixture, outputDirectory, editor);
    target = await waitForOpenWranglerGridTarget(capturePage, testing, opened.sessionId);
    app = await exactSessionApp(target.frame, opened.sessionId);
    assert.ok(app, "Histogram capture requires the restored dark-theme renderer.");
    profiles = app.getByRole("complementary", { name: "Column profiles and filters" });
    await capturePackagedHistogramInteractionScene(capturePage, profiles, outputDirectory, editor);
    await capturePackagedFilterResultScene(capturePage, testing, opened.sessionId, outputDirectory, editor);
    await capturePackagedOperationDialogScenes(capturePage, testing, opened.sessionId, outputDirectory, editor);

    recordAcceptanceProgress("verify:screenshots:file-scenes:workflow");
    target = await waitForOpenWranglerGridTarget(capturePage, testing, opened.sessionId);
    app = await exactSessionApp(target.frame, opened.sessionId);
    assert.ok(app, "The Workflow scene requires the exact production Open Wrangler renderer.");
    profiles = app.getByRole("complementary", { name: "Column profiles and filters" });
    if (await profiles.isVisible().catch(() => false)) {
      await profiles.getByRole("button", { name: "Close panel" }).click();
      await profiles.waitFor({ state: "hidden", timeout: 10_000 });
    }
    await fitPackagedProductSceneGrid(testing, capturePage, opened.sessionId, revenue.id);
    target = await waitForOpenWranglerGridTarget(capturePage, testing, opened.sessionId);
    app = await exactSessionApp(target.frame, opened.sessionId);
    assert.ok(app, "The Workflow scene must retain its renderer before adding its first cleaning step.");
    await previewUppercaseMarket(app, testing, "market_upper");
    target = await waitForOpenWranglerGridTarget(capturePage, testing, opened.sessionId);
    app = await exactSessionApp(target.frame, opened.sessionId);
    assert.ok(app, "The Workflow scene must retain its renderer while applying its first cleaning step.");
    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.steps.length === 1 &&
          active.metadata.draftStep === undefined &&
          active.metadata.schema.some((column) => column.name === "market_upper")
        );
      },
      30_000,
      "the Workflow scene's applied uppercase step"
    );
    await addPackagedProductSceneSorts(testing, capturePage, opened.sessionId);
    target = await waitForOpenWranglerGridTarget(capturePage, testing, opened.sessionId);
    app = await exactSessionApp(target.frame, opened.sessionId);
    assert.ok(app, "The Workflow scene must retain its renderer after adding ordered sorts.");
    await previewRevenueProjection(app, testing, "projected_revenue");
    await fitPackagedWorkflowFormulaDraftGrid(testing, capturePage, opened.sessionId);
    const codePreview = await waitForCodePreview(capturePage, "projected_revenue");
    const visibleCode = await codePreview.innerText();
    assert.match(visibleCode, /import polars as pl/u);
    assert.match(visibleCode, /market_upper/u);
    assert.match(visibleCode, /projected_revenue/u);
    assert.match(visibleCode, /pl\.col\('revenue'\) \+ pl\.lit\(500\)/u);
    const workflowSidebar = await arrangePackagedProductSidebar(capturePage, "workflow");
    await assertPackagedWorkflowScene(capturePage, testing, opened.sessionId, workflowSidebar, codePreview);
    await clearPackagedProductSceneTransientUi(capturePage);
    await captureWorkbenchScreenshot(
      capturePage,
      path.resolve(outputDirectory, packagedScreenshotFileName(editor, "workflow", "dark"))
    );
    await capturePackagedSortPriorityScene(capturePage, workflowSidebar, outputDirectory, editor);
    await capturePackagedSidebarOverviewScene(capturePage, testing, opened.sessionId, outputDirectory, editor);
    await capturePackagedExportOutcomeScenes(
      capturePage,
      testing,
      opened.sessionId,
      workspace,
      fixture,
      sourceBytes,
      outputDirectory,
      editor
    );
    assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Product-scene capture must not modify its source.");
  } finally {
    try {
      if (sessionId && testing.diagnostics().sessionCount > 0) {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await waitFor(
          () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
          15_000,
          "the packaged product-scene session and runtime to close"
        );
      }
      assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Product-scene cleanup must preserve its source.");
    } finally {
      await workbench.update("colorTheme", originalTheme, vscode.ConfigurationTarget.Global);
      await workbench.update("statusBar.visible", originalStatusBarVisible, vscode.ConfigurationTarget.Global);
      await workbench.update("activityBar.location", originalActivityBarLocation, vscode.ConfigurationTarget.Global);
      await breadcrumbs.update("enabled", originalBreadcrumbsEnabled, vscode.ConfigurationTarget.Global);
      await windowConfiguration.update("zoomLevel", originalZoom, vscode.ConfigurationTarget.Global);
      await windowConfiguration.update("commandCenter", originalCommandCenter, vscode.ConfigurationTarget.Global);
      await windowConfiguration.update(
        "autoDetectColorScheme",
        originalAutoDetectColorScheme,
        vscode.ConfigurationTarget.Global
      );
      await windowConfiguration.update(
        "autoDetectHighContrast",
        originalAutoDetectHighContrast,
        vscode.ConfigurationTarget.Global
      );
      await scm.update("countBadge", originalScmCountBadge, vscode.ConfigurationTarget.Global);
      await capturePage.setViewportSize(originalViewport);
    }
  }
}

async function openPackagedProductFixtureThroughExplorer(
  workbench: Page,
  fixture: vscode.Uri,
  outputDirectory: string,
  editor: string
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:explorer-action:source");
  await vscode.commands.executeCommand("vscode.open", fixture, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    10_000,
    "the realistic product fixture text editor before its Explorer action"
  );
  const commands = new Set(await vscode.commands.getCommands(true));
  assert.ok(
    commands.has("workbench.files.action.showActiveFileInExplorer"),
    "The packaged product scene requires the native active-file Explorer reveal command."
  );
  await vscode.commands.executeCommand("workbench.files.action.showActiveFileInExplorer");
  await workbench.bringToFront();
  const sidebar = workbench.locator(".part.sidebar:visible").first();
  await sidebar.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  await ensurePackagedProductSidebarWidth(workbench, sidebar);
  const explorer = sidebar.locator(".explorer-folders-view:visible").first();
  await explorer.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  const rows = explorer
    .locator('.monaco-list-row[role="treeitem"]:visible')
    .filter({ hasText: path.basename(fixture.fsPath) });
  await waitForLocatorCount(
    rows,
    1,
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
    "one exact realistic product fixture row in Explorer"
  );
  const row = rows.first();
  assert.equal((await row.innerText()).replace(/\s+/gu, " ").trim(), path.basename(fixture.fsPath));
  const rowGeometry = await row.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      clipped: element.scrollWidth > element.clientWidth + 1,
      left: bounds.left,
      right: bounds.right,
      viewportWidth: element.ownerDocument.defaultView?.innerWidth ?? 0
    };
  });
  assert.equal(rowGeometry.clipped, false, "The Explorer entry-point scene must show the complete source name.");
  assert.ok(rowGeometry.left >= -1 && rowGeometry.right <= rowGeometry.viewportWidth + 1);

  recordAcceptanceProgress("verify:screenshots:file-scenes:explorer-action:menu");
  const { menu, action } = await openWorkbenchContextMenu(
    workbench,
    row,
    "Open in Open Wrangler",
    "realistic Explorer row"
  );
  assert.ok(action, "The realistic Explorer row must expose Open in Open Wrangler.");
  assert.equal(
    await menu.getByRole("menuitem", { name: "Open in Open Wrangler", exact: true }).count(),
    1,
    "The Explorer entry-point scene must expose one canonical Open Wrangler action."
  );
  assert.equal((await action.innerText()).trim(), "Open in Open Wrangler");
  const menuGeometry = await menu.evaluate((element) => {
    type ExplorerMenuElement = {
      readonly clientWidth: number;
      readonly scrollWidth: number;
      readonly textContent: string | null;
      getBoundingClientRect(): { bottom: number; left: number; right: number; top: number };
      querySelectorAll(selector: string): ArrayLike<ExplorerMenuElement>;
    };
    const root = element as unknown as ExplorerMenuElement;
    const bounds = element.getBoundingClientRect();
    const viewport = element.ownerDocument.defaultView;
    const items = Array.from(root.querySelectorAll('[role="menuitem"]'));
    return {
      clippedItems: items
        .filter((item) => item.scrollWidth > item.clientWidth + 1)
        .map((item) => item.textContent?.replace(/\s+/gu, " ").trim() ?? ""),
      insideViewport:
        bounds.left >= -1 &&
        bounds.top >= -1 &&
        bounds.right <= (viewport?.innerWidth ?? 0) + 1 &&
        bounds.bottom <= (viewport?.innerHeight ?? 0) + 1
    };
  });
  assert.deepEqual(menuGeometry.clippedItems, []);
  assert.equal(menuGeometry.insideViewport, true, "The Explorer context menu must remain inside the workbench.");
  mkdirSync(outputDirectory, { recursive: true });
  await captureWorkbenchScreenshot(
    workbench,
    path.resolve(outputDirectory, packagedScreenshotFileName(editor, "file-explorer-action", "dark"))
  );

  recordAcceptanceProgress("verify:screenshots:file-scenes:explorer-action:open");
  if (await menu.isVisible().catch(() => false)) {
    await workbench.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  }
  const { menu: liveMenu, action: liveAction } = await openWorkbenchContextMenu(
    workbench,
    rows.first(),
    "Open in Open Wrangler",
    "realistic Explorer row after public media capture"
  );
  assert.ok(liveAction, "The live Explorer row must still expose Open in Open Wrangler after capture.");
  await liveAction.click();
  await liveMenu.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
}

async function capturePackagedHighContrastExploreScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  outputDirectory: string,
  editor: string
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:high-contrast-explore");
  const configuration = vscode.workspace.getConfiguration("workbench");
  const darkTheme = contributedProductSceneTheme(editor, "vs-dark", "Default Dark Modern");
  const highContrastTheme = contributedProductSceneTheme(editor, "hc-black", "Default High Contrast");
  try {
    await configuration.update("colorTheme", highContrastTheme, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast,
      10_000,
      "the realistic high-contrast product theme"
    );
    const sidebar = await arrangePackagedProductSidebar(workbench, "explore");
    await assertPackagedExploreScene(workbench, testing, sessionId, sidebar);
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "High-contrast capture requires the exact production renderer.");
    const contrast = await app.evaluate((root) => {
      const styles = root.ownerDocument.defaultView?.getComputedStyle(root.ownerDocument.documentElement);
      return {
        foreground: styles?.getPropertyValue("--vscode-foreground").trim() ?? "",
        background: styles?.getPropertyValue("--vscode-editor-background").trim() ?? "",
        contrastBorder: styles?.getPropertyValue("--vscode-contrastBorder").trim() ?? ""
      };
    });
    assert.ok(contrast.foreground && contrast.background && contrast.contrastBorder);
    assert.notEqual(contrast.foreground, contrast.background);
    await alignPackagedSceneRowBoundary(workbench, app);
    const rowBoundary = await measurePackagedSceneRowBoundary(app);
    assert.equal(rowBoundary.partialTopRows, 0);
    assert.deepEqual(
      rowBoundary.partialBottomRows,
      [],
      "The realistic high-contrast scene must show only complete data rows."
    );
    await clearPackagedProductSceneTransientUi(workbench);
    mkdirSync(outputDirectory, { recursive: true });
    await captureWorkbenchScreenshot(
      workbench,
      path.resolve(outputDirectory, packagedScreenshotFileName(editor, "high-contrast-explore", "high-contrast"))
    );
  } finally {
    await workbench.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
    await configuration.update("colorTheme", darkTheme, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
      10_000,
      "the dark product theme to return after high-contrast capture"
    );
    await arrangePackagedProductSidebar(workbench, "explore");
  }
}

async function capturePackagedHistogramInteractionScene(
  workbench: Page,
  profiles: Locator,
  outputDirectory: string,
  editor: string
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:histogram-hover");
  const counts = profiles.getByRole("button", { name: "Counts", exact: true });
  const percent = profiles.getByRole("button", { name: "%", exact: true });
  await counts.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  await percent.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  assert.equal(await counts.getAttribute("aria-pressed"), "true");
  assert.equal(await percent.getAttribute("aria-pressed"), "false");
  const histogramControl = profiles.locator(".numericHistogramHitTarget");
  const histogramStatus = profiles.locator(".summaryDistributionChart .miniChartCaption");
  assert.equal(await histogramControl.count(), 1, "The product histogram must expose one full-chart control.");
  const restingStatus = (await histogramStatus.innerText()).trim();
  await histogramControl.focus();
  await histogramControl.press("Home");
  for (let index = 0; index < 17; index += 1) await histogramControl.press("ArrowRight");
  const label = await histogramControl.getAttribute("aria-label");
  assert.equal(
    label,
    "20,174-21,357: 398 rows (0.4%); lower bound included, upper bound excluded",
    "The focused histogram bin must expose its interval, row count, and percentage."
  );
  assert.equal((await histogramStatus.innerText()).trim(), "20,174-21,357: 398 rows");
  assert.ok(label?.startsWith(`${(await histogramStatus.innerText()).trim()} (`));
  assert.equal(await histogramStatus.getAttribute("title"), label);
  assert.equal(await profiles.getByRole("tooltip").count(), 0);
  mkdirSync(outputDirectory, { recursive: true });
  await captureWorkbenchScreenshot(workbench, path.resolve(outputDirectory, `${editor}-histogram-hover-dark.png`));

  await percent.click();
  assert.equal(await counts.getAttribute("aria-pressed"), "false");
  assert.equal(await percent.getAttribute("aria-pressed"), "true");
  await histogramControl.focus();
  await histogramControl.press("Home");
  for (let index = 0; index < 17; index += 1) await histogramControl.press("ArrowRight");
  const percentLabel = await histogramControl.getAttribute("aria-label");
  assert.equal(
    percentLabel,
    "20,174-21,357: 0.4% (398 rows); lower bound included, upper bound excluded",
    "The percentage-mode histogram must lead with the selected value mode while retaining its exact row count."
  );
  assert.equal((await histogramStatus.innerText()).trim(), "20,174-21,357: 0.4%");
  assert.ok(percentLabel?.startsWith(`${(await histogramStatus.innerText()).trim()} (`));
  assert.equal(await histogramStatus.getAttribute("title"), percentLabel);
  await captureWorkbenchScreenshot(
    workbench,
    path.resolve(outputDirectory, `${editor}-histogram-hover-percent-dark.png`)
  );
  await histogramControl.evaluate((element) => {
    (element as unknown as { blur(): void }).blur();
  });
  assert.equal((await histogramStatus.innerText()).trim(), restingStatus);
  await counts.click();
  assert.equal(await counts.getAttribute("aria-pressed"), "true");
}

async function capturePackagedFilterResultScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  outputDirectory: string,
  editor: string
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:filter-result");
  const originalViewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  assert.deepEqual(
    originalViewport,
    PACKAGED_PRODUCT_VIEWPORT,
    "The filter-result scene must begin at the standard packaged product viewport."
  );
  const filterValue = "Benelux";
  const expectedRows = Array.from({ length: PACKAGED_SCREENSHOT_ROW_COUNT }, (_, index) => index).filter(
    (index) => packagedScreenshotRow(index)[1] === filterValue
  ).length;
  assert.ok(expectedRows > 0 && expectedRows < PACKAGED_SCREENSHOT_ROW_COUNT);
  const marketColumnId = testing.activeSession()?.metadata.schema.find((column) => column.name === "market")?.id;
  assert.ok(marketColumnId, "The filter-result scene requires the market column identity.");
  let captureError: unknown;

  try {
    let target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    let app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "The filter-result scene requires the exact production renderer.");
    let drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
    if (await drawer.isVisible().catch(() => false)) {
      await drawer.getByRole("button", { name: "Close panel", exact: true }).click();
      await drawer.waitFor({ state: "hidden", timeout: 10_000 });
    }
    const profileCategory = app.getByRole("button", {
      name: `Filter market to ${filterValue}; ${expectedRows.toLocaleString()} rows`,
      exact: true
    });
    await profileCategory.waitFor({ state: "visible", timeout: 30_000 });
    await profileCategory.click();
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await drawer.getByRole("tab", { name: "Column", exact: true }).getAttribute("aria-selected"), "true");
    await drawer.getByRole("heading", { name: "market", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByText(`Filter: ${filterValue}`, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("button", { name: "Clear filter for market", exact: true }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    await waitFor(
      () => {
        const active = testing.activeSession();
        const filter = active?.viewState.filterModel.filters[0];
        return (
          active?.sessionId === sessionId &&
          active.viewState.selectedColumnId === marketColumnId &&
          active.metadata.filteredShape.rows === expectedRows &&
          active.viewState.filterModel.filters.length === 1 &&
          active.viewState.filterModel.sort.length === 0 &&
          filter?.column === "market" &&
          filter.predicates.length === 0 &&
          filter.valueFilter?.kind === "values" &&
          filter.valueFilter.selectedValues.length === 1 &&
          filter.valueFilter.selectedValues[0] === filterValue &&
          filter.valueFilter.includeNulls === false &&
          filter.valueFilter.includeNaN === false
        );
      },
      30_000,
      "the Benelux header-profile filter to publish its exact file-session result"
    );
    assert.equal(await testing.synchronizePanel(sessionId), true);
    await testing.updateViewState(sessionId, {
      ...testing.activeSession()!.viewState,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(await testing.synchronizePanel(sessionId), true);

    const sidebar = await arrangePackagedProductSidebar(workbench, "filter-result");
    const filtersTree = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
    const nativeFilter = filtersTree.getByRole("treeitem", { name: /^market, 1 selected value/u }).first();
    await nativeFilter.waitFor({ state: "visible", timeout: 10_000 });

    target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "The filter-result scene must retain its renderer after arranging the native sidebar.");
    drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
    assert.equal(await drawer.getByRole("tab", { name: "Column", exact: true }).getAttribute("aria-selected"), "true");
    await drawer.getByRole("heading", { name: "market", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByText(`Filter: ${filterValue}`, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const clearMarket = drawer.getByRole("button", { name: "Clear filter for market", exact: true });
    await clearMarket.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("button", { name: "Counts", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const visibleRows = app.getByRole("status", { name: "Visible rows" });
    await visibleRows.waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      (await visibleRows.innerText()).trim(),
      new RegExp(`^Rows 1\\u2013\\d+ of ${expectedRows.toLocaleString()}$`, "u")
    );
    await app
      .locator('td[data-grid-row="0"][data-grid-column="1"]')
      .filter({ hasText: filterValue })
      .waitFor({ state: "visible", timeout: 10_000 });
    await clearPackagedProductSceneTransientUi(workbench);
    await alignPackagedSceneRowBoundary(workbench, app);
    await assertPackagedFilterResultGeometry(app, sidebar);
    mkdirSync(outputDirectory, { recursive: true });
    await captureWorkbenchScreenshot(
      workbench,
      path.resolve(outputDirectory, packagedScreenshotFileName(editor, "filter-result", "dark"))
    );
    await clearMarket.click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.sessionId === sessionId &&
          current.viewState.filterModel.filters.length === 0 &&
          current.viewState.filterModel.sort.length === 0 &&
          current.metadata.filteredShape.rows === PACKAGED_SCREENSHOT_ROW_COUNT
        );
      },
      30_000,
      "the Column-profile Clear action to restore the complete file session"
    );
    assert.equal(await testing.synchronizePanel(sessionId), true);
  } catch (error) {
    captureError = error;
  }

  let cleanupError: unknown;
  try {
    const active = testing.activeSession();
    if (active?.sessionId === sessionId && active.viewState.filterModel.filters.length > 0) {
      const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
      const app = await exactSessionApp(target.frame, sessionId);
      assert.ok(app, "Filter-result cleanup requires the exact production renderer.");
      const drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
      if (!(await drawer.isVisible().catch(() => false))) {
        await app.getByRole("button", { name: "Column profiles and filters" }).click();
        await drawer.waitFor({ state: "visible", timeout: 10_000 });
      }
      await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
      await drawer.getByRole("button", { name: "Clear all", exact: true }).click();
      await waitFor(
        () => {
          const current = testing.activeSession();
          return (
            current?.sessionId === sessionId &&
            current.viewState.filterModel.filters.length === 0 &&
            current.viewState.filterModel.sort.length === 0 &&
            current.metadata.filteredShape.rows === PACKAGED_SCREENSHOT_ROW_COUNT
          );
        },
        30_000,
        "filter-result emergency cleanup to restore the complete file session"
      );
      assert.equal(await testing.synchronizePanel(sessionId), true);
    }
  } catch (error) {
    cleanupError = error;
  }

  let viewportError: unknown;
  try {
    await workbench.setViewportSize(originalViewport);
    assert.deepEqual(
      await workbench.evaluate(() => {
        const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
        return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
      }),
      PACKAGED_PRODUCT_VIEWPORT,
      "The filter-result scene must restore the standard packaged product viewport."
    );
  } catch (error) {
    viewportError = error;
  }

  const errors = [captureError, cleanupError, viewportError].filter((error) => error !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "The filter-result capture or its cleanup failed.");
}

async function alignPackagedSceneRowBoundary(
  workbench: Page,
  app: Locator
): Promise<{ width: number; height: number }> {
  const maximumAttempts = 4;
  let lastMeasurement: Awaited<ReturnType<typeof measurePackagedSceneRowBoundary>> | undefined;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const viewport = await workbench.evaluate(() => {
      const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
      return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
    });
    const measurement = await measurePackagedSceneRowBoundary(app);
    lastMeasurement = measurement;
    assert.equal(
      measurement.partialTopRows,
      0,
      "A packaged product screenshot may align only a bottom partial row, never hide a clipped top row."
    );
    if (measurement.partialBottomRows.length === 0) return viewport;
    assert.equal(
      measurement.partialBottomRows.length,
      1,
      "A packaged product screenshot must expose at most one measurable bottom partial row."
    );
    const partial = measurement.partialBottomRows[0]!;
    const alignedHeight = packagedViewportHeightWithoutPartialBottomRow(
      viewport.height,
      partial.visibleHeight,
      partial.rowHeight
    );
    await workbench.setViewportSize({ width: viewport.width, height: alignedHeight });
    await app.evaluate(() => {
      const frameWindow = globalThis as unknown as {
        requestAnimationFrame(callback: () => void): number;
      };
      return new Promise<void>((resolve) => {
        frameWindow.requestAnimationFrame(() => frameWindow.requestAnimationFrame(() => resolve()));
      });
    });
  }
  throw new Error(
    `The packaged product screenshot could not align its bottom row after ${maximumAttempts} measured viewport adjustments: ${JSON.stringify(lastMeasurement)}`
  );
}

async function measurePackagedSceneRowBoundary(app: Locator): Promise<{
  partialTopRows: number;
  partialBottomRows: Array<{ rowHeight: number; visibleHeight: number }>;
}> {
  return app.evaluate((root) => {
    type RowBoundaryRect = { bottom: number; top: number };
    type RowBoundaryElement = {
      readonly clientHeight: number;
      readonly clientTop: number;
      getBoundingClientRect(): RowBoundaryRect & { height: number };
      querySelector(selector: string): RowBoundaryElement | null;
      querySelectorAll(selector: string): ArrayLike<RowBoundaryElement>;
    };
    const appRoot = root as unknown as RowBoundaryElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    if (!scroller) throw new Error("The packaged product row-boundary scroller is unavailable.");
    const headers = Array.from(scroller.querySelectorAll("thead th"));
    if (headers.length === 0) throw new Error("The packaged product row-boundary headers are unavailable.");
    const bodyTop = Math.max(...headers.map((header) => header.getBoundingClientRect().bottom));
    const scrollerBounds = scroller.getBoundingClientRect();
    // The outer rect includes the horizontal scrollbar; clientHeight does not.
    // Rows hidden beneath that scrollbar must therefore count as partial.
    const scrollerBottom = Math.min(
      scrollerBounds.bottom,
      scrollerBounds.top + scroller.clientTop + scroller.clientHeight
    );
    // VS Code can place the grid content box on fractional CSS-pixel
    // boundaries, especially with high-contrast borders. A subpixel edge
    // cannot expose independently readable row content in the rasterized
    // screenshot; keep rejecting every visibly partial row beyond one CSS
    // pixel without oscillating between adjacent integer viewport heights.
    const boundaryTolerance = 1;
    const visibleRows = Array.from(scroller.querySelectorAll("tbody tr")).filter((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > bodyTop && bounds.top < scrollerBottom;
    });
    return {
      partialTopRows: visibleRows.filter((row) => row.getBoundingClientRect().top < bodyTop - boundaryTolerance).length,
      partialBottomRows: visibleRows
        .filter((row) => row.getBoundingClientRect().bottom > scrollerBottom + boundaryTolerance)
        .map((row) => {
          const bounds = row.getBoundingClientRect();
          return {
            rowHeight: bounds.height,
            visibleHeight: scrollerBottom - Math.max(bodyTop, bounds.top)
          };
        })
    };
  });
}

async function assertPackagedFilterResultGeometry(app: Locator, sidebar: Locator): Promise<void> {
  await assertPackagedProductSidebarGeometry(sidebar);
  const geometry = await app.evaluate((root) => {
    type SceneRect = { bottom: number; left: number; right: number; top: number };
    type SceneElement = {
      readonly clientHeight: number;
      readonly clientTop: number;
      readonly clientWidth: number;
      readonly scrollWidth: number;
      readonly textContent: string | null;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): SceneRect & { height: number; width: number };
      querySelector(selector: string): SceneElement | null;
      querySelectorAll(selector: string): ArrayLike<SceneElement>;
    };
    const appRoot = root as unknown as SceneElement;
    const layout = appRoot.querySelector(".layout");
    const drawer = appRoot.querySelector('#openwrangler-insights-panel[aria-label="Column profiles and filters"]');
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const rowHeader = scroller?.querySelector("th.rowHeader");
    if (!layout || !drawer || !scroller || !rowHeader) {
      throw new Error("The filter-result layout is incomplete.");
    }
    const scrollerBounds = scroller.getBoundingClientRect();
    // Match the alignment probe's actual content box rather than accepting a
    // row that merely extends into the horizontal scrollbar track.
    const scrollerContentBottom = Math.min(
      scrollerBounds.bottom,
      scrollerBounds.top + scroller.clientTop + scroller.clientHeight
    );
    const drawerBounds = drawer.getBoundingClientRect();
    const dataLeft = rowHeader.getBoundingClientRect().right;
    const visibleRight = Math.min(scrollerBounds.right, drawerBounds.left);
    const visibleHeaders = Array.from(appRoot.querySelectorAll("th[data-column]")).filter((header) => {
      const bounds = header.getBoundingClientRect();
      return bounds.right > dataLeft + 1 && bounds.left < visibleRight - 1;
    });
    const bodyTop = Math.max(
      ...Array.from(scroller.querySelectorAll("thead th")).map((header) => header.getBoundingClientRect().bottom)
    );
    const boundaryTolerance = 1;
    const visibleRows = Array.from(scroller.querySelectorAll("tbody tr")).filter((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > bodyTop && bounds.top < scrollerContentBottom;
    });
    const visibleCells = Array.from(scroller.querySelectorAll("tbody td")).filter((cell) => {
      const bounds = cell.getBoundingClientRect();
      return (
        bounds.right > dataLeft + 1 &&
        bounds.left < visibleRight - 1 &&
        bounds.bottom > bodyTop &&
        bounds.top < scrollerContentBottom
      );
    });
    const controls = Array.from(
      drawer.querySelectorAll(".panelHeader button, .profileFilterStatus button, .distributionValueControls button")
    ).filter((control) => control.getBoundingClientRect().height > 0);
    return {
      layoutOverflow: layout.scrollWidth - layout.clientWidth,
      drawerOverflow: drawer.scrollWidth - drawer.clientWidth,
      drawerText: drawer.textContent?.replace(/\s+/gu, " ").trim() ?? "",
      partialHeaders: visibleHeaders
        .filter((header) => {
          const bounds = header.getBoundingClientRect();
          return bounds.left < dataLeft - 1 || bounds.right > visibleRight + 1;
        })
        .map((header) => header.getAttribute("data-column") ?? ""),
      clippedTitles: visibleHeaders
        .filter((header) => {
          const title = header.querySelector(".columnTitle");
          return Boolean(title && title.scrollWidth > title.clientWidth + 1);
        })
        .map((header) => header.getAttribute("data-column") ?? ""),
      partialRows: visibleRows.filter((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.top < bodyTop - boundaryTolerance || bounds.bottom > scrollerContentBottom + boundaryTolerance;
      }).length,
      clippedCells: visibleCells
        .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
        .map((cell) => cell.textContent?.replace(/\s+/gu, " ").trim() ?? ""),
      clippedControls: controls
        .filter((control) => {
          const bounds = control.getBoundingClientRect();
          return (
            control.scrollWidth > control.clientWidth + 1 ||
            bounds.left < drawerBounds.left - 1 ||
            bounds.right > drawerBounds.right + 1
          );
        })
        .map((control) => control.textContent?.replace(/\s+/gu, " ").trim() ?? "")
    };
  });
  assert.ok(geometry.layoutOverflow <= 1, "The filter-result workspace must not overflow horizontally.");
  assert.ok(geometry.drawerOverflow <= 1, "The filter-result editor must not overflow horizontally.");
  for (const label of ["Selected column", "market", "Filter: Benelux", "Counts", "%", "Top values"]) {
    assert.ok(geometry.drawerText.includes(label), `The filter-result editor must visibly include ${label}.`);
  }
  assert.deepEqual(geometry.partialHeaders, [], "The filter-result grid must show only complete columns.");
  assert.deepEqual(geometry.clippedTitles, [], "The filter-result grid must not clip visible column names.");
  assert.equal(geometry.partialRows, 0, "The filter-result grid must show only complete visible rows.");
  assert.deepEqual(geometry.clippedCells, [], "The filter-result grid must not clip visible cell values.");
  assert.deepEqual(geometry.clippedControls, [], "The filter-result editor must not clip profile controls.");
}

async function capturePackagedSortPriorityScene(
  workbench: Page,
  sidebar: Locator,
  outputDirectory: string,
  editor: string
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:sort-priority");
  const filters = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
  const priorityOne = filters.getByRole("treeitem", {
    name: /^revenue, Priority 1 · Descending · nulls last/u
  });
  await priorityOne.hover();
  await sidebar
    .getByRole("button", { name: /Move View Sort Down/iu })
    .first()
    .waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  await sidebar
    .getByRole("button", { name: /Remove View Sort/iu })
    .first()
    .waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  mkdirSync(outputDirectory, { recursive: true });
  await captureWorkbenchScreenshot(workbench, path.resolve(outputDirectory, `${editor}-sort-priority-dark.png`));
  await workbench.mouse.move(Math.floor(PACKAGED_PRODUCT_VIEWPORT.width * 0.72), 34);
}

async function capturePackagedSidebarOverviewScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  outputDirectory: string,
  editor: string
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:sidebar-overview");
  assert.deepEqual(testing.activeSession()?.viewState.filterModel.sort, [
    { column: "revenue", direction: "desc", nulls: "last" },
    { column: "market", direction: "desc", nulls: "last" }
  ]);
  assert.equal(testing.activeSession()?.metadata.steps.length, 1);
  assert.equal(testing.activeSession()?.metadata.draftStep?.kind, "formula");

  try {
    await closeVisibleWorkbenchPart(workbench, ".part.panel", [
      "workbench.action.closePanel",
      "workbench.action.togglePanel"
    ]);
    await workbench.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
    assert.deepEqual(
      await workbench.evaluate(() => {
        const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
        return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
      }),
      PACKAGED_PRODUCT_VIEWPORT,
      "The native-view overview requires its deterministic 1440 by 900 product viewport."
    );
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "The native-view overview requires the exact production renderer for dataset profiling.");
    const profilesToggle = app.getByRole("button", { name: "Column profiles and filters" });
    if ((await profilesToggle.getAttribute("aria-expanded")) !== "true") await profilesToggle.click();
    const profiles = app.getByRole("complementary", { name: "Column profiles and filters" });
    await profiles.waitFor({ state: "visible", timeout: 10_000 });
    await profiles.getByRole("tab", { name: "Dataset", exact: true }).click();
    await waitForLocatorText(
      profiles,
      (text) =>
        !text.includes("Profiling dataset statistics") &&
        ["Missing cells", "Rows with missing values", "Duplicate rows"].every((label) => text.includes(label)),
      30_000,
      "the current sorted draft view to publish exact dataset statistics through Column profiles"
    );
    await waitFor(
      () => testing.activeSession()?.metadata.stats !== undefined,
      10_000,
      "the native Summary view to receive the exact profiled dataset statistics"
    );
    await profiles.getByRole("button", { name: "Close panel" }).click();
    await profiles.waitFor({ state: "hidden", timeout: 10_000 });
    const sidebar = await arrangePackagedProductSidebar(workbench, "sidebar-overview");
    await fitPackagedSidebarOverviewGrid(testing, workbench, sessionId);
    assert.equal(await testing.synchronizePanel(sessionId), true);
    await assertPackagedSidebarOverviewScene(workbench, testing, sessionId, sidebar);
    await clearPackagedProductSceneTransientUi(workbench);
    mkdirSync(outputDirectory, { recursive: true });
    await captureWorkbenchScreenshot(
      workbench,
      path.resolve(outputDirectory, packagedScreenshotFileName(editor, "sidebar-overview", "dark"))
    );
  } finally {
    await workbench.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
    await vscode.commands.executeCommand("openWrangler.codePreview.focus");
    await waitForCodePreview(workbench, "projected_revenue");
    await arrangePackagedProductSidebar(workbench, "workflow");
  }
}

async function capturePackagedOperationDialogScenes(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  outputDirectory: string,
  editor: string
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:operation-catalog");
  assert.equal(testing.activeSession()?.metadata.steps.length, 0);
  assert.equal(testing.activeSession()?.metadata.draftStep, undefined);
  let dialog: Locator | undefined;
  try {
    const initialTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const initialApp = await exactSessionApp(initialTarget.frame, sessionId);
    assert.ok(initialApp, "Operation-catalog capture requires the exact production renderer.");
    const profiles = initialApp.getByRole("complementary", { name: "Column profiles and filters" });
    if (await profiles.isVisible().catch(() => false)) {
      await profiles.getByRole("button", { name: "Close panel" }).click();
      await profiles.waitFor({ state: "hidden", timeout: 10_000 });
    }
    await workbench.setViewportSize(PACKAGED_OPERATION_DIALOG_VIEWPORT);
    await arrangePackagedProductSidebar(workbench, "operation-catalog");
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "Operation-catalog capture must retain its exact production renderer.");
    await app.getByRole("button", { name: "Add step", exact: true }).click();
    dialog = app.getByRole("dialog", { name: "Add cleaning step" });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await assertPackagedOperationDialogGeometry(dialog, "catalog");
    await dialog.getByRole("navigation", { name: "Operation catalog" }).waitFor({ state: "visible" });
    for (const label of ["Rows / order", "Columns / types", "Categorical / text", "Numeric / datetime"]) {
      await dialog.getByRole("heading", { name: label, exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    }
    await dialog.getByRole("heading", { name: "Choose an operation", exact: true }).waitFor({ state: "visible" });
    await clearPackagedProductSceneTransientUi(workbench);
    mkdirSync(outputDirectory, { recursive: true });
    await captureWorkbenchScreenshot(
      workbench,
      path.resolve(outputDirectory, packagedScreenshotFileName(editor, "operation-catalog", "dark"))
    );

    recordAcceptanceProgress("verify:screenshots:file-scenes:operation-configuration");
    const search = dialog.getByPlaceholder("Search operations");
    await search.fill("fill missing");
    await dialog.getByRole("button", { name: /^Fill missing values/u }).click();
    const active = testing.activeSession();
    assert.ok(active, "The missing-value configuration capture requires one active session.");
    await dialog.getByLabel("Column", { exact: true }).selectOption(columnReference(active.metadata, "revenue").id);
    await dialog.getByLabel("Method", { exact: true }).selectOption("groupedMean");
    const groupBy = dialog.getByRole("group", { name: "Group by", exact: true });
    const selectedKeys = groupBy.getByRole("checkbox", { checked: true });
    for (let index = (await selectedKeys.count()) - 1; index >= 0; index -= 1) {
      await selectedKeys.nth(index).uncheck();
    }
    await groupBy.getByRole("checkbox", { name: "market", exact: true }).check();
    await groupBy.getByRole("checkbox", { name: "segment", exact: true }).check();
    await groupBy.getByText("Selected (2): market, segment", { exact: true }).waitFor({ state: "visible" });
    await dialog.getByLabel("Search group columns", { exact: true }).fill("market");
    await groupBy.getByRole("checkbox", { name: "market", exact: true }).waitFor({ state: "visible" });
    await groupBy.getByText("Selected (2): market, segment", { exact: true }).waitFor({ state: "visible" });
    await dialog
      .getByText("Filters and sorts in the current view are ignored", { exact: false })
      .waitFor({ state: "visible" });
    await dialog.getByRole("heading", { name: "Fill missing values", exact: true }).waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).waitFor({ state: "visible" });
    await assertPackagedOperationDialogGeometry(dialog, "configuration");
    await clearPackagedProductSceneTransientUi(workbench);
    await captureWorkbenchScreenshot(
      workbench,
      path.resolve(outputDirectory, packagedScreenshotFileName(editor, "operation-configuration", "dark"))
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    dialog = undefined;
  } finally {
    if (dialog && (await dialog.isVisible().catch(() => false))) {
      await dialog
        .getByRole("button", { name: "Close operation picker" })
        .click()
        .catch(() => undefined);
    }
    await workbench.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
  }
}

async function assertPackagedOperationDialogGeometry(
  dialog: Locator,
  scene: "catalog" | "configuration"
): Promise<void> {
  const geometry = await dialog.evaluate((element) => {
    type DialogElement = {
      readonly clientWidth: number;
      readonly scrollWidth: number;
      readonly ownerDocument: { readonly defaultView: { readonly innerHeight: number; readonly innerWidth: number } };
      getBoundingClientRect(): { bottom: number; left: number; right: number; top: number; width: number };
      querySelector(selector: string): DialogElement | null;
    };
    const root = element as unknown as DialogElement;
    const body = root.querySelector(".operationDialogBody");
    const catalog = root.querySelector(".operationCatalog");
    const form = root.querySelector(".operationForm");
    const header = root.querySelector(".operationDialogHeader");
    const searchIcon = root.querySelector(".operationSearch > span");
    const searchInput = root.querySelector(".operationSearch input");
    if (!body || !catalog || !form || !header || !searchIcon || !searchInput) {
      throw new Error("The operation dialog layout is incomplete.");
    }
    const bounds = root.getBoundingClientRect();
    const searchIconBounds = searchIcon.getBoundingClientRect();
    const searchInputBounds = searchInput.getBoundingClientRect();
    return {
      bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
      bodyOverflow: body.scrollWidth - body.clientWidth,
      headerOverflow: header.scrollWidth - header.clientWidth,
      catalogVisible: catalog.getBoundingClientRect().width > 0,
      formVisible: form.getBoundingClientRect().width > 0,
      searchIconContained:
        searchIconBounds.left >= searchInputBounds.left - 1 &&
        searchIconBounds.right <= searchInputBounds.right + 1 &&
        searchIconBounds.top >= searchInputBounds.top - 1 &&
        searchIconBounds.bottom <= searchInputBounds.bottom + 1,
      searchIconCenterDelta: Math.abs(
        (searchIconBounds.top + searchIconBounds.bottom) / 2 - (searchInputBounds.top + searchInputBounds.bottom) / 2
      ),
      viewport: {
        width: root.ownerDocument.defaultView.innerWidth,
        height: root.ownerDocument.defaultView.innerHeight
      }
    };
  });
  assert.ok(geometry.bounds.left >= -1 && geometry.bounds.top >= -1, `${scene} dialog must stay inside its renderer.`);
  assert.ok(
    geometry.bounds.right <= geometry.viewport.width + 1 && geometry.bounds.bottom <= geometry.viewport.height + 1,
    `${scene} dialog must stay inside its renderer.`
  );
  assert.ok(geometry.bodyOverflow <= 1, `${scene} operation dialog must not overflow horizontally.`);
  assert.ok(geometry.headerOverflow <= 1, `${scene} operation dialog header must not clip.`);
  assert.equal(geometry.catalogVisible, true);
  assert.equal(geometry.formVisible, true);
  assert.equal(geometry.searchIconContained, true, `${scene} search icon must stay inside its input.`);
  assert.ok(geometry.searchIconCenterDelta <= 1, `${scene} search icon must be vertically centered in its input.`);
}

async function capturePackagedImportOptionsScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  fixture: vscode.Uri,
  outputDirectory: string,
  editor: string
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:import-options");
  const before = testing.activeSession();
  assert.equal(before?.sessionId, sessionId, "Import-options capture requires the exact active session.");
  assert.deepEqual(before?.metadata.source.importOptions, {
    delimiter: ";",
    encoding: "utf-8",
    quoteChar: '"',
    hasHeader: true
  });
  const importAction = await waitForExactSessionWebviewButton(workbench, testing, sessionId, "Import options", true);
  await importAction.click();
  const prompt = await waitForImportQuickInput(workbench, testing, fixture, "Delimiter", sessionId);
  const semicolon = prompt.getByRole("option", { name: "Semicolon" }).first();
  await semicolon.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  assert.match(
    (await semicolon.getAttribute("class")) ?? "",
    /(?:^|\s)focused(?:\s|$)/u,
    "The advanced override must open on the automatically inferred semicolon delimiter."
  );
  const notifications = workbench.locator(
    ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
  );
  const notificationTexts = (await notifications.allInnerTexts()).map((text) => text.replace(/\s+/gu, " ").trim());
  const permittedNotification =
    "Instructions Unable to watch for file changes. Please follow the instructions link to resolve this issue.";
  assert.deepEqual(
    notificationTexts.filter((text) => text !== permittedNotification),
    [],
    `The import-options scene exposed an unexpected notification: ${JSON.stringify(notificationTexts)}`
  );
  const commands = new Set(await vscode.commands.getCommands(true));
  if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
  if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
  const notificationUi = workbench.locator(
    ".notifications-toasts .notification-toast:visible, .notifications-center:visible"
  );
  assert.equal(
    await pollAcceptanceCondition(async () => (await notificationUi.count()) === 0, {
      timeoutMs: 3_000,
      intervalMs: 50
    }),
    true,
    "The import-options scene must dismiss unrelated workbench notifications without closing its prompt."
  );
  await prompt.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  await waitForImportNaturalKeyboardFocus(prompt, "Delimiter import prompt", "contains");
  assert.match(
    (await semicolon.getAttribute("class")) ?? "",
    /(?:^|\s)focused(?:\s|$)/u,
    "Notification cleanup must preserve the inferred delimiter option's natural focus."
  );
  await captureWorkbenchScreenshot(workbench, path.resolve(outputDirectory, `${editor}-import-options-dark.png`));
  await workbench.keyboard.press("Escape");
  await prompt.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  assert.deepEqual(
    testing.activeSession()?.metadata.source.importOptions,
    before?.metadata.source.importOptions,
    "Cancelling the showcase override must preserve the inferred import configuration."
  );
}

async function capturePackagedExportOutcomeScenes(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  workspace: vscode.Uri,
  fixture: vscode.Uri,
  sourceBytes: Buffer,
  outputDirectory: string,
  editor: string
): Promise<void> {
  assert.equal(workspace.scheme, "file", "Product export captures require a local disposable workspace.");
  assert.equal(testing.activeSession()?.sessionId, sessionId, "Export capture requires the exact active session.");
  assert.equal(path.relative(workspace.fsPath, fixture.fsPath).startsWith(`..${path.sep}`), false);
  const codePreview = await waitForCodePreview(workbench, "projected_revenue");
  assert.match(await codePreview.innerText(), /import polars as pl/u);
  const panel = workbench.locator(".part.panel:visible").first();
  await panel.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  await panel.locator('[aria-label*="Export Generated Script"]:visible').first().waitFor({
    state: "visible",
    timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
  });

  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Export capture requires the exact production Open Wrangler renderer.");
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 2 &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema.some((column) => column.name === "market_upper") &&
        active.metadata.schema.some((column) => column.name === "projected_revenue")
      );
    },
    30_000,
    "the complete two-step product workflow before export"
  );
  assertExactBytes(
    readFileSync(fixture.fsPath),
    sourceBytes,
    "Applying the product workflow must preserve the source."
  );
  assert.equal(await testing.synchronizePanel(sessionId), true, "Export capture must synchronize its applied plan.");
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId);
  const generatedCode = active?.code ?? "";
  assert.match(generatedCode, /import polars as pl/u);
  assert.match(generatedCode, /market_upper/u);
  assert.match(generatedCode, /projected_revenue/u);
  assert.match(generatedCode, /pl\.col\('revenue'\) \+ pl\.lit\(500\)/u);
  await capturePackagedAppliedStepInspectionScene(workbench, testing, sessionId, outputDirectory, editor, codePreview);
  await capturePackagedEditAndUndoScenes(workbench, testing, sessionId, outputDirectory, editor, fixture, sourceBytes);
  const restoredAfterEditAndUndo = testing.activeSession();
  assert.equal(restoredAfterEditAndUndo?.sessionId, sessionId);
  assert.equal(restoredAfterEditAndUndo?.code, generatedCode);
  const restoredTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const restoredApp = await exactSessionApp(restoredTarget.frame, sessionId);
  assert.ok(restoredApp, "Export capture requires the restored post-edit Open Wrangler renderer.");

  const exportDirectory = path.join(workspace.fsPath, "exports");
  mkdirSync(exportDirectory, { recursive: true });
  assert.deepEqual(readdirSync(exportDirectory), [], "The disposable product export directory must start empty.");
  const scriptPath = path.join(exportDirectory, "orders.clean.py");
  const cleanedDataPath = path.join(exportDirectory, "orders.cleaned.csv");
  for (const destination of [scriptPath, cleanedDataPath]) {
    const relative = path.relative(workspace.fsPath, destination);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative === ".." || relative.startsWith(`..${path.sep}`), false);
    assert.equal(existsSync(destination), false, `The product export destination must not pre-exist: ${destination}`);
  }

  recordAcceptanceProgress("verify:screenshots:file-scenes:export-code:save");
  const scriptOutcome = vscode.commands.executeCommand<boolean>("openWrangler.exportCode");
  const scriptSavePrompt = workbench
    .locator(".quick-input-widget:visible")
    .filter({ hasText: "Export Open Wrangler Python Code" })
    .last();
  await scriptSavePrompt.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  const scriptDestination = scriptSavePrompt.locator(".quick-input-box input").first();
  await scriptDestination.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  assert.match(await scriptDestination.inputValue(), /\.clean\.py$/u);
  await scriptDestination.fill(scriptPath);
  await scriptDestination.press("Enter");
  await scriptSavePrompt.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  assert.equal(await scriptOutcome, true, "The product-media script export must complete successfully.");
  await waitFor(() => existsSync(scriptPath), 10_000, "the generated product-media Python script to appear");
  assert.equal(readFileSync(scriptPath, "utf8"), generatedCode);
  assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Python export must preserve the source bytes.");

  await clearPackagedProductSceneTransientUi(workbench);
  recordAcceptanceProgress("verify:screenshots:file-scenes:export-data:save");
  await exportCleanedDataThroughWorkbench(restoredApp, workbench, cleanedDataPath);
  await waitFor(() => existsSync(cleanedDataPath), 30_000, "the complete cleaned product CSV to appear");
  const exportedData = readFileSync(cleanedDataPath, "utf8");
  const exportedLines = exportedData.trimEnd().split(/\r?\n/u);
  assert.equal(exportedLines.length, PACKAGED_SCREENSHOT_ROW_COUNT + 1);
  assert.match(exportedLines[0] ?? "", /(?:^|,)market_upper(?:,|$)/u);
  assert.match(exportedLines[0] ?? "", /(?:^|,)projected_revenue(?:,|$)/u);
  assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Cleaned-data export must preserve the source bytes.");

  await closeVisibleWorkbenchPart(workbench, ".part.panel", [
    "workbench.action.closePanel",
    "workbench.action.togglePanel"
  ]);
  recordAcceptanceProgress("verify:screenshots:file-scenes:export-data:open");
  await openPackagedCleanedDataInOpenWrangler(
    workbench,
    testing,
    vscode.Uri.file(cleanedDataPath),
    workspace,
    exportedData
  );
  await clearPackagedProductSceneTransientUi(workbench);
  await captureWorkbenchScreenshot(workbench, path.resolve(outputDirectory, `${editor}-export-data-dark.png`));

  recordAcceptanceProgress("verify:screenshots:file-scenes:export-code:open");
  await openPackagedProductExportInEditor(workbench, vscode.Uri.file(scriptPath), "import polars as pl", [
    "import polars as pl",
    "market_upper",
    "projected_revenue"
  ]);
  await clearPackagedProductSceneTransientUi(workbench);
  await captureWorkbenchScreenshot(workbench, path.resolve(outputDirectory, `${editor}-export-code-dark.png`));
  assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Opening exported outcomes must preserve the source.");
}

async function capturePackagedAppliedStepInspectionScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  outputDirectory: string,
  editor: string,
  codePreview: Locator
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:applied-step-inspection");
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId);
  assert.equal(active?.metadata.steps.length, 2);
  assert.equal(active?.metadata.draftStep, undefined);
  const latestStep = active?.metadata.steps.at(-1);
  assert.equal(latestStep?.kind, "formula");
  assert.ok(latestStep, "Applied-step capture requires the latest formula step.");

  try {
    await closeVisibleWorkbenchPart(workbench, ".part.panel", [
      "workbench.action.closePanel",
      "workbench.action.togglePanel"
    ]);
    await workbench.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
    const sidebar = await arrangePackagedProductSidebar(workbench, "inspection");
    await fitPackagedSidebarOverviewGrid(testing, workbench, sessionId);
    const steps = sidebar.getByRole("tree", { name: /Cleaning Steps/u }).first();
    const latest = steps.getByRole("treeitem", { name: /^2\. Formula column/u });
    await latest.waitFor({ state: "visible", timeout: 10_000 });
    await latest.click();
    await waitFor(
      () => testing.activeSession()?.stepInspection?.stepId === latestStep.id,
      30_000,
      "the exact latest applied-step inspection"
    );
    await assertPackagedAppliedStepInspectionScene(workbench, testing, sessionId, sidebar, latestStep.id);
    await clearPackagedProductSceneTransientUi(workbench);
    mkdirSync(outputDirectory, { recursive: true });
    await captureWorkbenchScreenshot(
      workbench,
      path.resolve(outputDirectory, packagedScreenshotFileName(editor, "applied-step-inspection", "dark"))
    );
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "Applied-step capture must retain its exact renderer while restoring confirmed data.");
    await app.getByRole("button", { name: "Show confirmed data", exact: true }).click();
    await waitFor(
      () => testing.activeSession()?.stepInspection === undefined,
      10_000,
      "the applied-step capture to restore confirmed data"
    );
  } finally {
    if (testing.activeSession()?.stepInspection !== undefined) {
      await vscode.commands.executeCommand("openWrangler.selectStep");
      await waitFor(
        () => testing.activeSession()?.stepInspection === undefined,
        10_000,
        "the failed applied-step capture to clear inspection"
      );
    }
    await workbench.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
    await vscode.commands.executeCommand("openWrangler.codePreview.focus");
    await waitForCodePreview(workbench, "projected_revenue");
    await arrangePackagedProductSidebar(workbench, "workflow");
    assert.equal(await codePreview.isVisible(), true, "Applied-step capture must restore the generated code panel.");
  }
}

async function capturePackagedEditAndUndoScenes(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  outputDirectory: string,
  editor: string,
  fixture: vscode.Uri,
  sourceBytes: Buffer
): Promise<void> {
  recordAcceptanceProgress("verify:screenshots:file-scenes:latest-step-edit");
  const before = testing.activeSession();
  assert.equal(before?.sessionId, sessionId);
  assert.equal(before?.metadata.steps.length, 2);
  assert.equal(before?.metadata.draftStep, undefined);
  const latest = before?.metadata.steps.at(-1);
  assert.equal(latest?.kind, "formula");
  assert.ok(latest, "Latest-step media requires one committed formula step.");
  const originalStepId = latest.id;
  let target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  let app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Latest-step media requires the exact production renderer.");
  await app.getByRole("button", { name: "Edit latest", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Edit cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(
    (await dialog.getByLabel("Left column", { exact: true }).locator("option:checked").innerText()).trim(),
    /^revenue$/u
  );
  assert.equal(await dialog.getByLabel("Numeric value", { exact: true }).inputValue(), "500");
  assert.equal(await dialog.getByLabel("New column", { exact: true }).inputValue(), "projected_revenue");
  await assertPackagedOperationDialogGeometry(dialog, "configuration");
  await dialog.getByLabel("Numeric value", { exact: true }).fill("750");
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const draft = active?.metadata.draftStep;
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 2 &&
        active.metadata.steps.at(-1)?.id === originalStepId &&
        active.metadata.draftReplacesStepId === originalStepId &&
        draft?.id === originalStepId &&
        draft.kind === "formula" &&
        draft.params.value === 750 &&
        draft.params.newColumn === "projected_revenue"
      );
    },
    30_000,
    "the edited formula to preview as a stable latest-step replacement"
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Latest-step media requires the replacement preview renderer.");
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const edited = active?.metadata.steps.at(-1);
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 2 &&
        active.metadata.draftStep === undefined &&
        active.metadata.draftReplacesStepId === undefined &&
        edited?.id === originalStepId &&
        edited.kind === "formula" &&
        edited.params.value === 750 &&
        active.metadata.schema.some((column) => column.name === "projected_revenue")
      );
    },
    30_000,
    "the edited latest step to apply without appending another plan entry"
  );
  assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Editing the latest step must preserve the source.");
  assert.equal(await testing.synchronizePanel(sessionId), true);
  await fitPackagedWorkflowFormulaDraftGrid(testing, workbench, sessionId);
  let codePreview = await waitForCodePreview(workbench, "pl.lit(750)");
  let sidebar = await arrangePackagedProductSidebar(workbench, "workflow");
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Edited latest-step capture requires its exact renderer.");
  await assertPackagedCommittedPlanScene(
    workbench,
    testing,
    sessionId,
    app,
    sidebar,
    codePreview,
    2,
    "projected_revenue",
    /pl\.lit\(750\)/u
  );
  await clearPackagedProductSceneTransientUi(workbench);
  await alignPackagedSceneRowBoundary(workbench, app);
  mkdirSync(outputDirectory, { recursive: true });
  await captureWorkbenchScreenshot(
    workbench,
    path.resolve(outputDirectory, packagedScreenshotFileName(editor, "latest-step-edited", "dark"))
  );
  await workbench.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);

  recordAcceptanceProgress("verify:screenshots:file-scenes:latest-step-undo");
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Undo media requires the exact edited-plan renderer.");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 1 &&
        active.metadata.steps[0]?.kind === "upperText" &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema.some((column) => column.name === "market_upper") &&
        !active.metadata.schema.some((column) => column.name === "projected_revenue")
      );
    },
    30_000,
    "Undo to remove exactly the edited latest formula step"
  );
  assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Undoing the latest step must preserve the source.");
  assert.equal(await testing.synchronizePanel(sessionId), true);
  await fitPackagedUppercasePlanGrid(testing, workbench, sessionId);
  codePreview = await waitForCodePreview(workbench, "market_upper");
  sidebar = await arrangePackagedProductSidebar(workbench, "workflow");
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Undone latest-step capture requires its exact renderer.");
  await assertPackagedCommittedPlanScene(
    workbench,
    testing,
    sessionId,
    app,
    sidebar,
    codePreview,
    1,
    "market_upper",
    /market_upper/u
  );
  assert.doesNotMatch(await codePreview.innerText(), /projected_revenue|pl\.lit\(750\)/u);
  await clearPackagedProductSceneTransientUi(workbench);
  await alignPackagedSceneRowBoundary(workbench, app);
  await captureWorkbenchScreenshot(
    workbench,
    path.resolve(outputDirectory, packagedScreenshotFileName(editor, "latest-step-undone", "dark"))
  );
  await workbench.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);

  recordAcceptanceProgress("verify:screenshots:file-scenes:latest-step-restore");
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Latest-step media restoration requires the exact undone renderer.");
  await previewRevenueProjection(app, testing, "projected_revenue");
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Latest-step media restoration requires the formula preview renderer.");
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const restored = active?.metadata.steps.at(-1);
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 2 &&
        active.metadata.draftStep === undefined &&
        restored?.kind === "formula" &&
        restored.params.value === 500 &&
        restored.params.newColumn === "projected_revenue"
      );
    },
    30_000,
    "the original 500-unit formula to return after edit and undo media"
  );
  assert.equal(await testing.synchronizePanel(sessionId), true);
  await fitPackagedWorkflowFormulaDraftGrid(testing, workbench, sessionId);
  await waitForCodePreview(workbench, "pl.lit(500)");
  await arrangePackagedProductSidebar(workbench, "workflow");
  assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Media restoration must preserve the source.");
}

async function assertPackagedCommittedPlanScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  app: Locator,
  sidebar: Locator,
  codePreview: Locator,
  stepCount: number,
  expectedOutput: string,
  expectedCode: RegExp
): Promise<void> {
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId);
  assert.equal(active?.metadata.steps.length, stepCount);
  assert.equal(active?.metadata.draftStep, undefined);
  await app
    .getByRole("group", { name: "Cleaning plan" })
    .getByText(`${stepCount} applied ${stepCount === 1 ? "step" : "steps"}`, { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  await app.getByRole("button", { name: "Edit latest", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await app.getByRole("button", { name: "Undo", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await app.getByRole("region", { name: "Draft review" }).count(), 0);
  const steps = sidebar.getByRole("tree", { name: /Cleaning Steps/u }).first();
  await steps
    .getByRole("treeitem", { name: /Original data/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await steps
    .getByRole("treeitem", { name: /1\. Uppercase/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  if (stepCount === 2) {
    await steps
      .getByRole("treeitem", { name: /2\. Formula column/u })
      .first()
      .waitFor({
        state: "visible",
        timeout: 10_000
      });
  } else {
    assert.equal(await steps.getByRole("treeitem", { name: /Formula column/u }).count(), 0);
  }
  await assertPackagedProductSidebarGeometry(sidebar);
  await app.locator(`th[data-column="${expectedOutput}"]`).waitFor({ state: "visible", timeout: 10_000 });
  const geometry = await app.evaluate((root) => {
    type PlanSceneElement = {
      readonly clientWidth: number;
      readonly scrollWidth: number;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { left: number; right: number };
      querySelector(selector: string): PlanSceneElement | null;
      querySelectorAll(selector: string): ArrayLike<PlanSceneElement>;
    };
    const appRoot = root as unknown as PlanSceneElement;
    const layout = appRoot.querySelector(".layout");
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const rowHeader = scroller?.querySelector("th.rowHeader");
    if (!layout || !scroller || !rowHeader) throw new Error("The committed-plan scene geometry is incomplete.");
    const bounds = scroller.getBoundingClientRect();
    const dataLeft = rowHeader.getBoundingClientRect().right;
    const visible = Array.from(appRoot.querySelectorAll("th[data-column]")).filter((header) => {
      const headerBounds = header.getBoundingClientRect();
      return headerBounds.right > dataLeft + 1 && headerBounds.left < bounds.right - 1;
    });
    return {
      layoutOverflow: layout.scrollWidth - layout.clientWidth,
      partialHeaders: visible
        .filter((header) => {
          const headerBounds = header.getBoundingClientRect();
          return headerBounds.left < dataLeft - 1 || headerBounds.right > bounds.right + 1;
        })
        .map((header) => header.getAttribute("data-column") ?? ""),
      clippedTitles: visible
        .filter((header) => {
          const title = header.querySelector(".columnTitle");
          return Boolean(title && title.scrollWidth > title.clientWidth + 1);
        })
        .map((header) => header.getAttribute("data-column") ?? "")
    };
  });
  assert.ok(geometry.layoutOverflow <= 1);
  assert.deepEqual(geometry.partialHeaders, []);
  assert.deepEqual(geometry.clippedTitles, []);
  const code = await codePreview.innerText();
  assert.match(code, /import polars as pl/u);
  assert.match(code, expectedCode);
  const codeBounds = await codePreview.boundingBox();
  assert.ok(codeBounds && codeBounds.width > 0 && codeBounds.height > 0);
  assert.equal(await workbench.locator(".part.panel:visible").count(), 1);
}

async function openPackagedCleanedDataInOpenWrangler(
  workbench: Page,
  testing: TestApi,
  destination: vscode.Uri,
  workspace: vscode.Uri,
  exportedData: string
): Promise<void> {
  await vscode.commands.executeCommand("vscode.openWith", destination, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitForAutomaticDelimitedImport(
    workbench,
    testing,
    destination,
    "verify:screenshots:file-scenes:export-data:import"
  );
  await waitFor(
    () => testing.activeSession()?.metadata.source.uri === destination.toString(),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the separate cleaned output to open in Open Wrangler"
  );
  const outputSession = testing.activeSession();
  assert.ok(outputSession, "The cleaned-output capture requires one active Open Wrangler session.");
  assert.equal(outputSession.metadata.backend, "polars");
  assert.deepEqual(outputSession.metadata.shape, {
    rows: PACKAGED_SCREENSHOT_ROW_COUNT,
    columns: PACKAGED_SCREENSHOT_COLUMNS.length + 2
  });
  await waitFor(
    () => testing.panelHydrated(outputSession.sessionId),
    OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
    "the cleaned-output renderer to hydrate"
  );
  assert.equal(await testing.synchronizePanel(outputSession.sessionId), true);
  await fitPackagedWorkflowFormulaDraftGrid(testing, workbench, outputSession.sessionId);
  const active = testing.activeSession();
  assert.equal(active?.sessionId, outputSession.sessionId);
  assert.ok(active, "The cleaned-output capture must retain its exact active session.");
  assert.equal(active.metadata.schema.at(-2)?.name, "market_upper");
  assert.equal(active.metadata.schema.at(-1)?.name, "projected_revenue");
  assert.equal(readFileSync(destination.fsPath, "utf8"), exportedData);
  assert.equal(path.relative(workspace.fsPath, destination.fsPath).startsWith(`..${path.sep}`), false);

  await vscode.commands.executeCommand("workbench.files.action.showActiveFileInExplorer");
  await workbench.bringToFront();
  const explorer = workbench.locator(".part.sidebar .explorer-folders-view:visible").first();
  await explorer.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  await waitForLocatorCount(
    explorer
      .locator('.monaco-list-row[role="treeitem"]:visible')
      .filter({ hasText: path.basename(destination.fsPath) }),
    1,
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
    `one exact ${path.basename(destination.fsPath)} row in Explorer`
  );
}

async function openPackagedProductExportInEditor(
  workbench: Page,
  destination: vscode.Uri,
  revealText: string,
  visibleText: readonly string[]
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(destination);
  assert.equal(document.uri.toString(), destination.toString());
  const documentText = document.getText();
  for (const expected of visibleText) {
    assert.ok(
      documentText.includes(expected),
      `The opened ${path.basename(destination.fsPath)} document must contain ${expected}.`
    );
  }
  const textEditor = await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  const revealOffset = document.getText().indexOf(revealText);
  assert.notEqual(revealOffset, -1, `The exported ${path.basename(destination.fsPath)} must contain ${revealText}.`);
  const revealStart = document.positionAt(revealOffset);
  const revealEnd = document.positionAt(revealOffset + revealText.length);
  textEditor.revealRange(new vscode.Range(revealStart, revealEnd), vscode.TextEditorRevealType.InCenter);
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === destination.toString();
    },
    10_000,
    `the exported ${path.basename(destination.fsPath)} text editor to become active`
  );
  const commands = new Set(await vscode.commands.getCommands(true));
  assert.ok(
    commands.has("workbench.files.action.showActiveFileInExplorer"),
    "Product export capture requires the native active-file Explorer reveal command."
  );
  await vscode.commands.executeCommand("workbench.files.action.showActiveFileInExplorer");
  await workbench.bringToFront();
  const explorer = workbench.locator(".part.sidebar .explorer-folders-view:visible").first();
  await explorer.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  const exportRow = explorer
    .locator('.monaco-list-row[role="treeitem"]:visible')
    .filter({ hasText: path.basename(destination.fsPath) });
  await waitForLocatorCount(
    exportRow,
    1,
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
    `one exact ${path.basename(destination.fsPath)} row in Explorer`
  );
  const activeTab = workbench.locator(".part.editor .tab.active:visible").last();
  await waitForLocatorText(
    activeTab,
    (text) => text.replace(/\s+/gu, " ").includes(path.basename(destination.fsPath)),
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
    `the active ${path.basename(destination.fsPath)} editor tab`
  );
  await workbench
    .locator(".part.editor .editor-instance:visible .view-lines:visible")
    .first()
    .waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
}

async function capturePackagedWideSchemaColumnSearchScene(testing: TestApi, outputDirectory: string): Promise<void> {
  if (process.platform !== "linux") return;
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "Wide-schema capture requires the disposable acceptance workspace.");
  assert.equal(workspace.scheme, "file", "Wide-schema capture requires a local disposable workspace.");
  const expectedColumns = packagedWideSchemaColumns();
  const source = packagedWideSchemaFixtureCsv();
  const fixture = ensureDeterministicDelimitedFixture(
    workspace,
    "enterprise-account-model-417-columns.csv",
    source,
    "wide-schema"
  );
  assert.equal(path.relative(workspace.fsPath, fixture.fsPath).startsWith(`..${path.sep}`), false);
  const workbench = vscode.workspace.getConfiguration("workbench");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const originalTheme = workbench.get<string>("colorTheme");
  const originalZoom = windowConfiguration.get<number>("zoomLevel");
  const editor = process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor";
  const page = await connectToEditorWorkbench();
  const originalViewport = await page.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  let sessionId: string | undefined;
  try {
    recordAcceptanceProgress("verify:screenshots:wide-schema:prepare");
    await page.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
    await workbench.update(
      "colorTheme",
      contributedProductSceneTheme(editor, "vs-dark", "Default Dark Modern"),
      vscode.ConfigurationTarget.Global
    );
    await windowConfiguration.update("zoomLevel", 0, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
      10_000,
      "the wide-schema showcase dark theme"
    );
    await closeVisibleWorkbenchPart(page, ".part.auxiliarybar", [
      "workbench.action.closeAuxiliaryBar",
      "workbench.action.toggleAuxiliaryBar"
    ]);
    await closeVisibleWorkbenchPart(page, ".part.panel", [
      "workbench.action.closePanel",
      "workbench.action.togglePanel"
    ]);
    await closeVisibleWorkbenchPart(page, ".part.sidebar", [
      "workbench.action.closeSidebar",
      "workbench.action.toggleSidebarVisibility"
    ]);
    await clearPackagedProductSceneTransientUi(page);
    await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitForAutomaticDelimitedImport(page, testing, fixture, "verify:screenshots:wide-schema:import");
    await waitFor(
      () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the wide-schema showcase fixture to open"
    );
    const opened = testing.activeSession();
    assert.ok(opened, "Wide-schema showcase capture requires one active session.");
    sessionId = opened.sessionId;
    assert.deepEqual(opened.metadata.shape, {
      rows: PACKAGED_WIDE_SCHEMA_ROW_COUNT,
      columns: PACKAGED_WIDE_SCHEMA_COLUMN_COUNT
    });
    assert.deepEqual(
      opened.metadata.schema.map((column) => column.name),
      expectedColumns,
      "The wide-schema showcase must retain every source column."
    );
    await waitFor(
      () => testing.panelHydrated(opened.sessionId),
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the wide-schema showcase renderer to hydrate"
    );
    assert.equal(await testing.synchronizePanel(opened.sessionId), true);
    const target = await waitForOpenWranglerGridTarget(page, testing, opened.sessionId);
    const app = await exactSessionApp(target.frame, opened.sessionId);
    assert.ok(app, "Wide-schema capture requires the exact production renderer.");
    const search = app.getByRole("combobox", { name: "Column", exact: true });
    await search.focus();
    const listbox = app.getByRole("listbox", { name: "Matching columns" });
    await listbox.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    const firstOption = listbox.getByRole("option").first();
    assert.equal(await firstOption.getAttribute("aria-setsize"), String(PACKAGED_WIDE_SCHEMA_COLUMN_COUNT));
    assert.equal(
      await app.getByText(/Showing 100 of/u).count(),
      0,
      "Wide-schema search must not expose the retired cap."
    );
    await search.press("End");
    const lastOption = listbox.locator(`[role="option"][aria-posinset="${PACKAGED_WIDE_SCHEMA_COLUMN_COUNT}"]`);
    await lastOption.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    assert.equal(await lastOption.getAttribute("aria-setsize"), String(PACKAGED_WIDE_SCHEMA_COLUMN_COUNT));
    assert.match((await lastOption.innerText()).replace(/\s+/gu, " ").trim(), new RegExp(expectedColumns.at(-1)!));
    const popupGeometry = await listbox.evaluate((element) => {
      type WideSearchElement = {
        readonly clientWidth: number;
        readonly scrollWidth: number;
        readonly ownerDocument: { readonly documentElement: WideSearchElement };
        getBoundingClientRect(): {
          readonly bottom: number;
          readonly right: number;
          readonly top: number;
          readonly width: number;
        };
        querySelector(selector: string): WideSearchElement | null;
        querySelectorAll(selector: string): ArrayLike<WideSearchElement>;
      };
      const list = element as WideSearchElement;
      const bounds = list.getBoundingClientRect();
      const viewport = list.ownerDocument.documentElement.getBoundingClientRect();
      const options = Array.from(list.querySelectorAll('[role="option"]'));
      const clipped = options.filter((option) => {
        const optionBounds = option.getBoundingClientRect();
        const name = option.querySelector(".columnSearchName");
        return (
          optionBounds.width > 0 &&
          (option.scrollWidth > option.clientWidth + 1 ||
            optionBounds.right > viewport.right + 1 ||
            Boolean(name && name.scrollWidth > name.clientWidth + 1))
        );
      }).length;
      const partiallyVisible = options.filter((option) => {
        const optionBounds = option.getBoundingClientRect();
        const intersects = optionBounds.bottom > bounds.top + 1 && optionBounds.top < bounds.bottom - 1;
        return intersects && (optionBounds.top < bounds.top - 1 || optionBounds.bottom > bounds.bottom + 1);
      }).length;
      return { popupRight: bounds.right, viewportRight: viewport.right, clipped, partiallyVisible };
    });
    assert.equal(popupGeometry.clipped, 0, "Visible wide-schema search results must remain readable.");
    assert.equal(popupGeometry.partiallyVisible, 0, "Wide-schema evidence must show only complete column-search rows.");
    assert.ok(popupGeometry.popupRight <= popupGeometry.viewportRight + 1);
    const breadcrumbText = (
      await page.locator(".breadcrumbs-control:visible, .breadcrumbs-below-tabs:visible").allInnerTexts()
    )
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    assert.match(breadcrumbText, /fixtures.*enterprise-account-model-417-columns\.csv/iu);
    assert.doesNotMatch(
      breadcrumbText,
      /openwrangler-wide-schema-showcase-|(?:^|\s)(?:tmp|x-[a-z0-9-]+)(?:\s|$)/iu,
      "Public wide-schema evidence must not expose random acceptance paths."
    );
    mkdirSync(outputDirectory, { recursive: true });
    recordAcceptanceProgress("verify:screenshots:wide-schema:capture");
    await clearPackagedProductSceneTransientUi(page);
    await captureWorkbenchScreenshot(page, path.resolve(outputDirectory, `${editor}-column-search-wide-dark.png`));
    await search.press("Escape");
    assertExactBytes(
      readFileSync(fixture.fsPath),
      Buffer.from(source, "utf8"),
      "The wide-schema showcase must preserve its source bytes."
    );
  } finally {
    try {
      if (sessionId && testing.diagnostics().sessionCount > 0) {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await waitFor(
          () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
          15_000,
          "the wide-schema showcase session to close"
        );
      }
    } finally {
      await workbench.update("colorTheme", originalTheme, vscode.ConfigurationTarget.Global);
      await windowConfiguration.update("zoomLevel", originalZoom, vscode.ConfigurationTarget.Global);
      await page.setViewportSize(originalViewport);
    }
  }
}

function contributedProductSceneTheme(editor: string, uiTheme: string, fallback: string): string {
  const themes = vscode.extensions.all.flatMap(
    (extension) =>
      (extension.packageJSON.contributes?.themes ?? []) as Array<{
        id?: string;
        label?: string;
        uiTheme?: string;
      }>
  );
  const candidates = themes.filter((theme) => theme.uiTheme === uiTheme);
  if (editor === "cursor") {
    const cursorTheme = candidates.find((theme) =>
      uiTheme === "vs-dark"
        ? theme.label === "Cursor Dark"
        : uiTheme === "vs"
          ? theme.label === "Cursor Light"
          : theme.label === "Cursor Dark High Contrast"
    );
    if (cursorTheme) return cursorTheme.id ?? cursorTheme.label ?? fallback;
  }
  const preferred = candidates.find((theme) => /default|modern/i.test(theme.label ?? theme.id ?? ""));
  return preferred?.id ?? preferred?.label ?? candidates[0]?.id ?? candidates[0]?.label ?? fallback;
}

async function fitPackagedProductSceneGrid(
  testing: TestApi,
  workbench: Page,
  sessionId: string,
  selectedColumnId: string
): Promise<void> {
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId, "Product-scene grid fitting requires the exact active session.");
  assert.ok(active, "Product-scene grid fitting requires one active dataframe session.");
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Product-scene grid fitting requires the exact production renderer.");
  const dimensions = await app.locator('[data-testid="data-grid-scroller"]').evaluate((scroller) => {
    const rowHeader = scroller.querySelector("th.rowHeader");
    if (!rowHeader) throw new Error("The product-scene row header is unavailable.");
    const drawer = scroller.ownerDocument.querySelector(
      '#openwrangler-insights-panel[aria-label="Column profiles and filters"]'
    );
    const scrollerBounds = scroller.getBoundingClientRect();
    const drawerBounds = drawer?.getBoundingClientRect();
    const visibleRight =
      drawerBounds &&
      drawerBounds.width > 0 &&
      drawerBounds.left > scrollerBounds.left &&
      drawerBounds.left < scrollerBounds.right
        ? drawerBounds.left
        : scrollerBounds.right;
    return {
      visibleWidth: visibleRight - scrollerBounds.left,
      rowHeaderWidth: rowHeader.getBoundingClientRect().width
    };
  });
  const available = Math.floor(dimensions.visibleWidth - dimensions.rowHeaderWidth);
  assert.ok(available >= 510, "The 1440-pixel product viewport must fit three complete featured columns.");
  const orderWidth = Math.max(160, Math.floor(available * 0.28));
  const marketWidth = Math.max(150, Math.floor(available * 0.28));
  const revenueWidth = available - orderWidth - marketWidth;
  assert.ok(revenueWidth >= 200, "The product viewport must retain a readable revenue profile column.");
  const widthsByName = {
    order_id: orderWidth,
    market: marketWidth,
    revenue: revenueWidth
  } as const;
  let columnWidths = new Map(
    active.metadata.schema
      .filter((column) => column.name in widthsByName)
      .map((column) => [column.id, widthsByName[column.name as keyof typeof widthsByName]] as const)
  );
  await testing.updateViewState(sessionId, {
    ...active.viewState,
    columnWidths,
    selectedColumnId,
    viewport: { firstVisibleRow: 0, scrollLeft: 0 }
  });
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The fitted product grid must synchronize with its exact renderer."
  );
  const revenue = columnReference(active.metadata, "revenue");
  const trailingGap = await app.evaluate((root, columnName) => {
    type ProductSceneElement = {
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { left: number; right: number; width: number };
      querySelector(selector: string): ProductSceneElement | null;
      querySelectorAll(selector: string): ArrayLike<ProductSceneElement>;
    };
    const appRoot = root as unknown as ProductSceneElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const drawer = appRoot.querySelector('#openwrangler-insights-panel[aria-label="Column profiles and filters"]');
    const header = Array.from(appRoot.querySelectorAll("th[data-column]")).find(
      (candidate) => candidate.getAttribute("data-column") === columnName
    );
    if (!scroller || !header) throw new Error("The product-scene grid fit geometry is incomplete.");
    const scrollerBounds = scroller.getBoundingClientRect();
    const drawerBounds = drawer?.getBoundingClientRect();
    const visibleRight =
      drawerBounds &&
      drawerBounds.width > 0 &&
      drawerBounds.left > scrollerBounds.left &&
      drawerBounds.left < scrollerBounds.right
        ? drawerBounds.left
        : scrollerBounds.right;
    return visibleRight - header.getBoundingClientRect().right;
  }, revenue.name);
  if (Math.abs(trailingGap) > 1) {
    const adjusted = (columnWidths.get(revenue.id) ?? revenueWidth) + Math.floor(trailingGap);
    assert.ok(adjusted >= 200 && adjusted <= 640, "The fitted revenue column must remain readable.");
    columnWidths = new Map([...columnWidths, [revenue.id, adjusted]]);
    await testing.updateViewState(sessionId, {
      ...testing.activeSession()!.viewState,
      columnWidths,
      selectedColumnId,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The final product grid width adjustment must synchronize with its exact renderer."
    );
  }
}

async function revealPackagedProductSceneColumn(
  testing: TestApi,
  workbench: Page,
  sessionId: string,
  columnName: string
): Promise<void> {
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId, "Product-scene column reveal requires the exact active session.");
  assert.ok(active, "Product-scene column reveal requires one active dataframe session.");
  const column = columnReference(active.metadata, columnName);
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Product-scene column reveal requires the exact production renderer.");
  const search = app.getByRole("combobox", { name: "Column", exact: true });
  const escapedColumnName = columnName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  await search.fill(columnName);
  await app
    .getByRole("option", { name: new RegExp(`^${escapedColumnName},`, "u") })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await search.press("Enter");
  await waitFor(
    () =>
      testing.activeSession()?.viewState.selectedColumnId === column.id &&
      (testing.activeSession()?.viewState.viewport.scrollLeft ?? 0) > 0,
    10_000,
    `column search to reveal ${columnName} for the packaged product scene`
  );
}

async function fitPackagedUppercasePlanGrid(testing: TestApi, workbench: Page, sessionId: string): Promise<void> {
  await revealPackagedProductSceneColumn(testing, workbench, sessionId, "market_upper");
  let target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  let app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The uppercase-plan grid fit requires the exact production renderer.");
  const dimensions = await app.locator('[data-testid="data-grid-scroller"]').evaluate((scroller) => {
    const rowHeader = scroller.querySelector("th.rowHeader");
    if (!rowHeader) throw new Error("The uppercase-plan row header is unavailable.");
    return {
      clientWidth: scroller.clientWidth,
      rowHeaderWidth: rowHeader.getBoundingClientRect().width
    };
  });
  const available = Math.floor(dimensions.clientWidth - dimensions.rowHeaderWidth);
  assert.ok(available >= 840, "The uppercase-plan viewport must fit five complete comparison columns.");
  const names = ["gross_margin", "priority", "renewal_date", "account_note", "market_upper"] as const;
  const widths = [
    Math.floor(available * 0.16),
    Math.floor(available * 0.16),
    Math.floor(available * 0.19),
    Math.floor(available * 0.27)
  ];
  widths.push(available - widths.reduce((sum, width) => sum + width, 0));
  assert.ok(
    widths.every((width) => width >= 140),
    "Every uppercase-plan comparison column must remain readable."
  );
  const current = testing.activeSession();
  assert.equal(current?.sessionId, sessionId);
  assert.ok(current, "The uppercase-plan grid fit requires one active dataframe session.");
  const marketUpper = columnReference(current.metadata, "market_upper");
  let columnWidths = new Map([
    ...current.viewState.columnWidths,
    ...names.map((name, index) => [columnReference(current.metadata, name).id, widths[index]!] as const)
  ]);
  await testing.updateViewState(sessionId, {
    ...current.viewState,
    columnWidths,
    selectedColumnId: marketUpper.id
  });
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The fitted uppercase-plan grid must synchronize with its exact renderer."
  );
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The uppercase-plan viewport alignment requires the exact production renderer.");
  const alignment = await app.evaluate((root, firstColumnName) => {
    type UppercaseSceneRect = { left: number };
    type UppercaseSceneElement = {
      readonly scrollLeft: number;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): UppercaseSceneRect & { width: number };
      querySelector(selector: string): UppercaseSceneElement | null;
      querySelectorAll(selector: string): ArrayLike<UppercaseSceneElement>;
    };
    const appRoot = root as unknown as UppercaseSceneElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const rowHeader = scroller?.querySelector("th.rowHeader");
    const firstHeader = Array.from(appRoot.querySelectorAll("th[data-column]")).find(
      (candidate) => candidate.getAttribute("data-column") === firstColumnName
    );
    if (!scroller || !rowHeader || !firstHeader) {
      throw new Error("The uppercase-plan viewport-alignment geometry is incomplete.");
    }
    const scrollerBounds = scroller.getBoundingClientRect();
    return {
      currentScrollLeft: scroller.scrollLeft,
      offset: firstHeader.getBoundingClientRect().left - (scrollerBounds.left + rowHeader.getBoundingClientRect().width)
    };
  }, names[0]);
  const alignedScrollLeft = Math.max(0, Math.round(alignment.currentScrollLeft + alignment.offset));
  await testing.updateViewState(sessionId, {
    ...testing.activeSession()!.viewState,
    columnWidths,
    selectedColumnId: marketUpper.id,
    viewport: {
      ...testing.activeSession()!.viewState.viewport,
      scrollLeft: alignedScrollLeft
    }
  });
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The aligned uppercase-plan viewport must synchronize with its exact renderer."
  );
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The final uppercase-plan width adjustment requires the exact production renderer.");
  const trailingGap = await app.evaluate((root, columnName) => {
    type UppercaseSceneElement = {
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { right: number };
      querySelector(selector: string): UppercaseSceneElement | null;
      querySelectorAll(selector: string): ArrayLike<UppercaseSceneElement>;
    };
    const appRoot = root as unknown as UppercaseSceneElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const header = Array.from(appRoot.querySelectorAll("th[data-column]")).find(
      (candidate) => candidate.getAttribute("data-column") === columnName
    );
    if (!scroller || !header) throw new Error("The uppercase-plan fit geometry is incomplete.");
    return scroller.getBoundingClientRect().right - header.getBoundingClientRect().right;
  }, marketUpper.name);
  if (Math.abs(trailingGap) > 1) {
    const adjusted = (columnWidths.get(marketUpper.id) ?? widths.at(-1)!) + Math.floor(trailingGap);
    assert.ok(adjusted >= 140 && adjusted <= 640, "The fitted uppercase output column must remain readable.");
    columnWidths = new Map([...columnWidths, [marketUpper.id, adjusted]]);
    await testing.updateViewState(sessionId, {
      ...testing.activeSession()!.viewState,
      columnWidths,
      selectedColumnId: marketUpper.id
    });
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The final uppercase output-column width adjustment must synchronize with its exact renderer."
    );
  }
}

async function addPackagedProductSceneSorts(testing: TestApi, workbench: Page, sessionId: string): Promise<void> {
  let target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  for (const column of ["market", "revenue"] as const) {
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, `The ${column} product-scene sort requires the exact production renderer.`);
    const search = app.getByRole("combobox", { name: "Column", exact: true });
    await search.fill(column);
    await app
      .getByRole("option", { name: new RegExp(`^${column},`, "u") })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await search.press("Enter");
    await waitFor(
      () =>
        testing.activeSession()?.viewState.selectedColumnId ===
        columnReference(testing.activeSession()!.metadata, column).id,
      10_000,
      `column search to reveal ${column} for the product-scene sort`
    );
    target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const frame = target.frame;
    const menu = frame.locator(`th[data-column="${column}"] details.columnMenu`).first();
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    await menu.getByLabel(`Column actions for ${column}`).click();
    await menu.getByRole("button", { name: "Sort descending", exact: true }).click();
    assert.equal(
      await menu.evaluate((element) => element.hasAttribute("open")),
      false,
      `The ${column} quick-sort menu must close before capture.`
    );
    await waitFor(
      () => testing.activeSession()?.viewState.filterModel.sort[0]?.column === column,
      10_000,
      `${column} to become the newest product-scene sort`
    );
    target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  }
  assert.deepEqual(testing.activeSession()?.viewState.filterModel.sort, [
    { column: "revenue", direction: "desc", nulls: "last" },
    { column: "market", direction: "desc", nulls: "last" }
  ]);
}

async function fitPackagedWorkflowFormulaDraftGrid(
  testing: TestApi,
  workbench: Page,
  sessionId: string
): Promise<void> {
  let target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  let app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The Workflow draft fit requires the exact production renderer.");
  const search = app.getByRole("combobox", { name: "Column", exact: true });
  await search.fill("projected_revenue");
  await app
    .getByRole("option", { name: /^projected_revenue,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await search.press("Enter");
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId, "The Workflow draft fit requires the exact active session.");
  assert.ok(active, "The Workflow draft fit requires one active dataframe session.");
  const projectedRevenue = columnReference(active.metadata, "projected_revenue");
  await waitFor(
    () =>
      testing.activeSession()?.viewState.selectedColumnId === projectedRevenue.id &&
      (testing.activeSession()?.viewState.viewport.scrollLeft ?? 0) > 0,
    10_000,
    "column search to reveal the Workflow draft output"
  );
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The Workflow draft fit must retain the exact production renderer.");
  const dimensions = await app.locator('[data-testid="data-grid-scroller"]').evaluate((scroller) => {
    const rowHeader = scroller.querySelector("th.rowHeader");
    if (!rowHeader) throw new Error("The Workflow draft row header is unavailable.");
    return {
      clientWidth: scroller.clientWidth,
      rowHeaderWidth: rowHeader.getBoundingClientRect().width
    };
  });
  const available = Math.floor(dimensions.clientWidth - dimensions.rowHeaderWidth);
  assert.ok(available >= 840, "The 1440-pixel Workflow viewport must fit five complete comparison columns.");
  const names = ["priority", "renewal_date", "account_note", "market_upper", "projected_revenue"] as const;
  const widths = [
    Math.floor(available * 0.16),
    Math.floor(available * 0.19),
    Math.floor(available * 0.24),
    Math.floor(available * 0.19)
  ];
  widths.push(available - widths.reduce((sum, width) => sum + width, 0));
  assert.ok(
    widths.every((width) => width >= 140),
    "Every Workflow comparison column must remain readable."
  );
  const current = testing.activeSession()!;
  let columnWidths = new Map([
    ...current.viewState.columnWidths,
    ...names.map((name, index) => [columnReference(current.metadata, name).id, widths[index]!] as const)
  ]);
  await testing.updateViewState(sessionId, {
    ...current.viewState,
    columnWidths,
    selectedColumnId: projectedRevenue.id
  });
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The fitted Workflow draft grid must synchronize with its exact renderer."
  );
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The Workflow draft viewport alignment requires the exact production renderer.");
  const alignment = await app.evaluate((root, firstColumnName) => {
    type ProductSceneRect = { left: number; width: number };
    type ProductSceneElement = {
      readonly scrollLeft: number;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): ProductSceneRect;
      querySelector(selector: string): ProductSceneElement | null;
      querySelectorAll(selector: string): ArrayLike<ProductSceneElement>;
    };
    const appRoot = root as unknown as ProductSceneElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const rowHeader = scroller?.querySelector("th.rowHeader");
    const firstHeader = Array.from(appRoot.querySelectorAll("th[data-column]")).find(
      (candidate) => candidate.getAttribute("data-column") === firstColumnName
    );
    if (!scroller || !rowHeader || !firstHeader) {
      throw new Error("The Workflow draft viewport-alignment geometry is incomplete.");
    }
    const scrollerBounds = scroller.getBoundingClientRect();
    const firstBounds = firstHeader.getBoundingClientRect();
    return {
      currentScrollLeft: scroller.scrollLeft,
      offset: firstBounds.left - (scrollerBounds.left + rowHeader.getBoundingClientRect().width)
    };
  }, names[0]);
  const alignedScrollLeft = Math.max(0, Math.round(alignment.currentScrollLeft + alignment.offset));
  await testing.updateViewState(sessionId, {
    ...testing.activeSession()!.viewState,
    columnWidths,
    selectedColumnId: projectedRevenue.id,
    viewport: {
      ...testing.activeSession()!.viewState.viewport,
      scrollLeft: alignedScrollLeft
    }
  });
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The aligned Workflow draft viewport must synchronize with its exact renderer."
  );
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The final Workflow draft width adjustment requires the exact production renderer.");
  const trailingGap = await app.evaluate((root, columnName) => {
    type ProductSceneElement = {
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { right: number };
      querySelector(selector: string): ProductSceneElement | null;
      querySelectorAll(selector: string): ArrayLike<ProductSceneElement>;
    };
    const appRoot = root as unknown as ProductSceneElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const header = Array.from(appRoot.querySelectorAll("th[data-column]")).find(
      (candidate) => candidate.getAttribute("data-column") === columnName
    );
    if (!scroller || !header) throw new Error("The Workflow draft fit geometry is incomplete.");
    return scroller.getBoundingClientRect().right - header.getBoundingClientRect().right;
  }, projectedRevenue.name);
  if (Math.abs(trailingGap) > 1) {
    const adjusted = (columnWidths.get(projectedRevenue.id) ?? widths.at(-1)!) + Math.floor(trailingGap);
    assert.ok(adjusted >= 140 && adjusted <= 640, "The fitted Workflow output column must remain readable.");
    columnWidths = new Map([...columnWidths, [projectedRevenue.id, adjusted]]);
    await testing.updateViewState(sessionId, {
      ...testing.activeSession()!.viewState,
      columnWidths,
      selectedColumnId: projectedRevenue.id
    });
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The final Workflow output-column width adjustment must synchronize with its exact renderer."
    );
  }
}

async function arrangePackagedProductSidebar(
  workbench: Page,
  scene: "explore" | "filter-result" | "workflow" | "sidebar-overview" | "operation-catalog" | "inspection"
): Promise<Locator> {
  await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
  if ((process.env.OPEN_WRANGLER_TEST_EDITOR ?? "vscode") !== "cursor") {
    const activityBar = workbench.locator(".part.activitybar:visible, .activitybar:visible").first();
    await activityBar.waitFor({ state: "visible", timeout: 10_000 });
    const activityAction = activityBar.locator('[aria-label*="Open Wrangler" i], [title*="Open Wrangler" i]').first();
    await activityAction.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await activityAction.evaluate((element) => {
        type ActivityElement = {
          readonly classList: { contains(name: string): boolean };
          readonly parentElement: ActivityElement | null;
          getAttribute(name: string): string | null;
        };
        let current = element as unknown as ActivityElement | null;
        for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
          const selected = current.getAttribute("aria-selected") ?? current.getAttribute("aria-checked");
          if (selected === "true" || current.classList.contains("checked")) return true;
        }
        return false;
      }),
      true,
      "The packaged product scene must visibly select the native Open Wrangler Activity Bar item."
    );
  }
  const sidebar = workbench.locator(".part.sidebar:visible").first();
  await sidebar.waitFor({ state: "visible", timeout: 10_000 });
  await ensurePackagedProductSidebarWidth(workbench, sidebar);
  const sections = [
    ["Operations", /Operations/u],
    ["Summary", /Summary/u],
    ["Filters / Sorts", /Filters\s*\/\s*Sorts/u],
    ["Cleaning Steps", /Cleaning Steps/u]
  ] as const;
  for (const [label] of sections) {
    await sidebar.getByText(label, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  const expanded =
    scene === "explore" || scene === "sidebar-overview"
      ? new Set(["Operations", "Summary", "Filters / Sorts", "Cleaning Steps"])
      : scene === "operation-catalog"
        ? new Set(["Operations"])
        : scene === "filter-result"
          ? new Set(["Filters / Sorts"])
          : new Set(["Filters / Sorts", "Cleaning Steps"]);
  for (const [label, treeName] of sections) {
    const tree = sidebar.getByRole("tree", { name: treeName }).first();
    const isExpanded = await tree.isVisible().catch(() => false);
    if (isExpanded !== expanded.has(label)) {
      await sidebar.getByText(label, { exact: true }).first().click();
      if (expanded.has(label)) await tree.waitFor({ state: "visible", timeout: 10_000 });
      else await tree.waitFor({ state: "hidden", timeout: 10_000 });
    }
  }
  for (const [label] of sections) {
    await sidebar.getByText(label, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  return sidebar;
}

async function fitPackagedSidebarOverviewGrid(testing: TestApi, workbench: Page, sessionId: string): Promise<void> {
  let target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  let app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The native-view overview grid fit requires the exact production renderer.");
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId);
  assert.ok(active, "The native-view overview requires one active dataframe session.");
  const names = ["account_note", "market_upper", "projected_revenue"] as const;
  const selected = columnReference(active.metadata, "projected_revenue");
  const search = app.getByRole("combobox", { name: "Column", exact: true });
  await search.fill(selected.name);
  await app
    .getByRole("option", { name: /^projected_revenue,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await search.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === selected.id,
    10_000,
    "column search to reveal the overview's computed output"
  );
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The native-view overview must retain its renderer after column navigation.");
  const dimensions = await app.locator('[data-testid="data-grid-scroller"]').evaluate((scroller) => {
    const rowHeader = scroller.querySelector("th.rowHeader");
    if (!rowHeader) throw new Error("The native-view overview row header is unavailable.");
    return {
      clientWidth: scroller.clientWidth,
      rowHeaderWidth: rowHeader.getBoundingClientRect().width
    };
  });
  const available = Math.floor(dimensions.clientWidth - dimensions.rowHeaderWidth);
  assert.ok(available >= 600, "The 1280-pixel native-view overview must fit three complete workflow columns.");
  const widths = [Math.floor(available * 0.4), Math.floor(available * 0.27)];
  widths.push(available - widths.reduce((sum, width) => sum + width, 0));
  assert.ok(
    widths.every((width) => width >= 160),
    "Every overview column must remain readable."
  );
  let columnWidths = new Map([
    ...testing.activeSession()!.viewState.columnWidths,
    ...names.map(
      (name, index) => [columnReference(testing.activeSession()!.metadata, name).id, widths[index]!] as const
    )
  ]);
  await testing.updateViewState(sessionId, {
    ...testing.activeSession()!.viewState,
    columnWidths,
    selectedColumnId: selected.id
  });
  assert.equal(await testing.synchronizePanel(sessionId), true);
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The native-view overview must retain its renderer while aligning its columns.");
  const alignment = await app.evaluate((root, firstColumnName) => {
    type OverviewElement = {
      readonly scrollLeft: number;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { left: number; width: number };
      querySelector(selector: string): OverviewElement | null;
      querySelectorAll(selector: string): ArrayLike<OverviewElement>;
    };
    const appRoot = root as unknown as OverviewElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const rowHeader = scroller?.querySelector("th.rowHeader");
    const firstHeader = Array.from(appRoot.querySelectorAll("th[data-column]")).find(
      (candidate) => candidate.getAttribute("data-column") === firstColumnName
    );
    if (!scroller || !rowHeader || !firstHeader) throw new Error("The overview grid alignment is incomplete.");
    return {
      currentScrollLeft: scroller.scrollLeft,
      offset:
        firstHeader.getBoundingClientRect().left -
        (scroller.getBoundingClientRect().left + rowHeader.getBoundingClientRect().width)
    };
  }, names[0]);
  await testing.updateViewState(sessionId, {
    ...testing.activeSession()!.viewState,
    columnWidths,
    selectedColumnId: selected.id,
    viewport: {
      ...testing.activeSession()!.viewState.viewport,
      scrollLeft: Math.max(0, Math.round(alignment.currentScrollLeft + alignment.offset))
    }
  });
  assert.equal(await testing.synchronizePanel(sessionId), true);
  target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The native-view overview must retain its renderer for its final width adjustment.");
  const trailingGap = await app.evaluate((root, finalColumnName) => {
    type OverviewElement = {
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { right: number };
      querySelector(selector: string): OverviewElement | null;
      querySelectorAll(selector: string): ArrayLike<OverviewElement>;
    };
    const appRoot = root as unknown as OverviewElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const finalHeader = Array.from(appRoot.querySelectorAll("th[data-column]")).find(
      (candidate) => candidate.getAttribute("data-column") === finalColumnName
    );
    if (!scroller || !finalHeader) throw new Error("The overview grid width geometry is incomplete.");
    return scroller.getBoundingClientRect().right - finalHeader.getBoundingClientRect().right;
  }, names.at(-1)!);
  if (Math.abs(trailingGap) > 1) {
    const adjusted = (columnWidths.get(selected.id) ?? widths.at(-1)!) + Math.floor(trailingGap);
    assert.ok(adjusted >= 160 && adjusted <= 640, "The overview's computed output must remain readable.");
    columnWidths = new Map([...columnWidths, [selected.id, adjusted]]);
    await testing.updateViewState(sessionId, {
      ...testing.activeSession()!.viewState,
      columnWidths,
      selectedColumnId: selected.id
    });
    assert.equal(await testing.synchronizePanel(sessionId), true);
  }
}

async function assertPackagedSidebarOverviewScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  sidebar: Locator
): Promise<void> {
  const operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
  const summary = sidebar.getByRole("tree", { name: /Summary/u }).first();
  const filters = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
  const steps = sidebar.getByRole("tree", { name: /Cleaning Steps/u }).first();
  await operations.getByRole("treeitem", { name: /^Sort rows/u }).waitFor({ state: "visible", timeout: 10_000 });
  for (const expected of [
    /orders\.csv, polars · editing/iu,
    /Shape, 100,000 × 17/u,
    /Selected column, projected_revenue/u,
    /^Missing cells, (?!Profiling)/u,
    /^Duplicate rows, (?!Profiling)/u
  ]) {
    await summary.getByRole("treeitem", { name: expected }).waitFor({ state: "visible", timeout: 10_000 });
  }
  await filters
    .getByRole("treeitem", { name: /^revenue, Priority 1 · Descending · nulls last/u })
    .waitFor({ state: "visible", timeout: 10_000 });
  await filters
    .getByRole("treeitem", { name: /^market, Priority 2 · Descending · nulls last/u })
    .waitFor({ state: "visible", timeout: 10_000 });
  for (const expected of [/Original data/u, /1\. Uppercase/u, /Draft · Formula column/u]) {
    await steps.getByRole("treeitem", { name: expected }).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  await assertPackagedProductSidebarGeometry(sidebar);
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Native-view overview geometry requires the exact production renderer.");
  await assertPackagedProductToolbarIdentity(app);
  await app.getByRole("region", { name: "Draft review" }).waitFor({ state: "visible", timeout: 10_000 });
  const geometry = await measurePackagedOverviewGrid(app);
  assert.deepEqual(geometry.partialHeaders, []);
  assert.deepEqual(geometry.clippedTitles, []);
  assert.deepEqual(geometry.visibleColumns, ["account_note", "market_upper", "projected_revenue"]);
  assert.equal(await workbench.locator(".part.panel:visible").count(), 0);
}

async function assertPackagedAppliedStepInspectionScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  sidebar: Locator,
  stepId: string
): Promise<void> {
  assert.equal(testing.activeSession()?.stepInspection?.stepId, stepId);
  const filters = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
  const steps = sidebar.getByRole("tree", { name: /Cleaning Steps/u }).first();
  await filters
    .getByRole("treeitem", { name: /Filters and sorts paused, Inspecting an applied step/u })
    .waitFor({ state: "visible", timeout: 10_000 });
  for (const expected of [/Original data/u, /1\. Uppercase/u, /2\. Formula column, Selected · latest applied step/u]) {
    await steps.getByRole("treeitem", { name: expected }).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  await assertPackagedProductSidebarGeometry(sidebar);
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Applied-step inspection geometry requires the exact production renderer.");
  await assertPackagedProductToolbarIdentity(app);
  const inspection = app.getByRole("region", { name: "Selected applied-step inspection" });
  await waitForLocatorText(
    inspection,
    (text) => text.includes("Inspecting Formula column") && !text.includes("Loading Formula column"),
    30_000,
    "the applied-step inspection projection to settle"
  );
  await inspection.getByText(/confirmed dataframe view and filters are unchanged/u).waitFor({ state: "visible" });
  await inspection.getByText("+1 columns", { exact: true }).waitFor({ state: "visible" });
  await inspection.getByRole("button", { name: "Show confirmed data", exact: true }).waitFor({ state: "visible" });
  await app.getByRole("button", { name: "Edit latest", exact: true }).waitFor({ state: "visible" });
  await app.getByRole("button", { name: "Undo", exact: true }).waitFor({ state: "visible" });
  const geometry = await measurePackagedOverviewGrid(app);
  assert.deepEqual(geometry.partialHeaders, []);
  assert.deepEqual(geometry.clippedTitles, []);
  assert.deepEqual(geometry.visibleColumns, ["account_note", "market_upper", "projected_revenue"]);
  assert.equal(await workbench.locator(".part.panel:visible").count(), 0);
}

async function assertPackagedProductToolbarIdentity(app: Locator): Promise<void> {
  const identity = app.locator(".toolbarIdentity");
  await identity.waitFor({ state: "visible", timeout: 10_000 });
  const measurement = await identity.evaluate((root) => {
    const title = root.querySelector("strong");
    const shape = root.querySelector("span");
    if (!title || !shape) throw new Error("The product-scene toolbar identity is incomplete.");
    return {
      title: title.textContent?.trim() ?? "",
      shape: shape.textContent?.trim() ?? "",
      titleClipped: title.scrollWidth > title.clientWidth + 1,
      shapeClipped: shape.scrollWidth > shape.clientWidth + 1
    };
  });
  assert.equal(measurement.title, "orders.csv");
  assert.equal(measurement.shape, "100,000 × 17");
  assert.equal(measurement.titleClipped, false, "The public product screenshot must show the complete source title.");
  assert.equal(measurement.shapeClipped, false, "The public product screenshot must show the complete dataset shape.");
}

async function measurePackagedOverviewGrid(app: Locator): Promise<{
  partialHeaders: string[];
  clippedTitles: string[];
  visibleColumns: string[];
}> {
  return app.evaluate((root) => {
    type OverviewElement = {
      readonly clientWidth: number;
      readonly scrollWidth: number;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { left: number; right: number };
      querySelector(selector: string): OverviewElement | null;
      querySelectorAll(selector: string): ArrayLike<OverviewElement>;
    };
    const appRoot = root as unknown as OverviewElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const rowHeader = scroller?.querySelector("th.rowHeader");
    if (!scroller || !rowHeader) throw new Error("The overview grid geometry is incomplete.");
    const bounds = scroller.getBoundingClientRect();
    const dataLeft = rowHeader.getBoundingClientRect().right;
    const visible = Array.from(appRoot.querySelectorAll("th[data-column]")).filter((header) => {
      const headerBounds = header.getBoundingClientRect();
      return headerBounds.right > dataLeft + 1 && headerBounds.left < bounds.right - 1;
    });
    return {
      partialHeaders: visible
        .filter((header) => {
          const headerBounds = header.getBoundingClientRect();
          return headerBounds.left < dataLeft - 1 || headerBounds.right > bounds.right + 1;
        })
        .map((header) => header.getAttribute("data-column") ?? ""),
      clippedTitles: visible
        .filter((header) => {
          const title = header.querySelector(".columnTitle");
          return Boolean(title && title.scrollWidth > title.clientWidth + 1);
        })
        .map((header) => header.getAttribute("data-column") ?? ""),
      visibleColumns: visible.map((header) => header.getAttribute("data-column") ?? "")
    };
  });
}

async function ensurePackagedProductSidebarWidth(workbench: Page, sidebar: Locator): Promise<void> {
  const targetWidth = 400;
  const initial = await sidebar.boundingBox();
  assert.ok(initial, "The packaged product scene requires measurable native sidebar geometry.");
  if (initial.width >= targetWidth - 2) return;
  const boundaryX = Math.floor(initial.x + initial.width);
  const boundaryY = Math.floor(initial.y + initial.height / 2);
  await workbench.mouse.move(boundaryX, boundaryY);
  await workbench.mouse.down();
  await workbench.mouse.move(Math.floor(initial.x + targetWidth), boundaryY, { steps: 8 });
  await workbench.mouse.up();
  assert.equal(
    await pollAcceptanceCondition(
      async () => {
        const current = await sidebar.boundingBox();
        return Boolean(current && current.width >= targetWidth - 2);
      },
      { timeoutMs: 3_000, intervalMs: 50 }
    ),
    true,
    "The packaged product scene must widen the native sidebar enough to show complete descriptions."
  );
}

async function assertPackagedExploreScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  sidebar: Locator
): Promise<void> {
  const summaryTree = sidebar.getByRole("tree", { name: /Summary/u }).first();
  const operationsTree = sidebar.getByRole("tree", { name: /Operations/u }).first();
  const filtersTree = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
  const stepsTree = sidebar.getByRole("tree", { name: /Cleaning Steps/u }).first();
  await operationsTree.getByRole("treeitem").first().waitFor({ state: "visible", timeout: 10_000 });
  await filtersTree.getByRole("treeitem", { name: /No filters or sorts/u }).waitFor({
    state: "visible",
    timeout: 10_000
  });
  await stepsTree.getByRole("treeitem", { name: /Original data/u }).waitFor({
    state: "visible",
    timeout: 10_000
  });
  await summaryTree.waitFor({ state: "visible", timeout: 10_000 });
  for (const expected of [
    /orders\.csv, polars · editing/iu,
    /Shape, 100,000 × 15/u,
    /Columns, 15/u,
    /Selected column, revenue/u,
    /^Missing cells, (?!Profiling)/u,
    /^Duplicate rows, (?!Profiling)/u
  ]) {
    await summaryTree.getByRole("treeitem", { name: expected }).waitFor({ state: "visible", timeout: 10_000 });
  }
  await assertPackagedProductSidebarGeometry(sidebar);
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Explore geometry requires the exact production renderer.");
  const measurement = await app.evaluate((root) => {
    type ProductSceneRect = { left: number; right: number; width: number };
    type ProductSceneElement = {
      readonly clientWidth: number;
      readonly scrollLeft: number;
      readonly scrollWidth: number;
      readonly textContent: string | null;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): ProductSceneRect;
      querySelector(selector: string): ProductSceneElement | null;
      querySelectorAll(selector: string): ArrayLike<ProductSceneElement>;
    };
    const appRoot = root as unknown as ProductSceneElement;
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const drawer = appRoot.querySelector('#openwrangler-insights-panel[aria-label="Column profiles and filters"]');
    const layout = appRoot.querySelector(".layout");
    const sourceLabel = appRoot.querySelector(".toolbarIdentity strong");
    const shapeLabel = appRoot.querySelector(".toolbarIdentity span");
    const rowHeader = scroller?.querySelector("th.rowHeader");
    if (!scroller || !drawer || !layout || !sourceLabel || !shapeLabel || !rowHeader) {
      throw new Error("The Explore product layout is incomplete.");
    }
    const scrollerBounds = scroller.getBoundingClientRect();
    const dataLeft = rowHeader.getBoundingClientRect().right;
    const drawerBounds = drawer.getBoundingClientRect();
    const visibleRight =
      drawerBounds.width > 0 && drawerBounds.left > scrollerBounds.left && drawerBounds.left < scrollerBounds.right
        ? drawerBounds.left
        : scrollerBounds.right;
    const visibleHeaders = Array.from(appRoot.querySelectorAll("th[data-column]")).filter((header) => {
      const bounds = header.getBoundingClientRect();
      return bounds.right > dataLeft + 1 && bounds.left < visibleRight - 1;
    });
    return {
      layoutOverflow: layout.scrollWidth - layout.clientWidth,
      clippedToolbarIdentity:
        sourceLabel.scrollWidth > sourceLabel.clientWidth + 1 || shapeLabel.scrollWidth > shapeLabel.clientWidth + 1,
      drawerOverflow: drawer.scrollWidth - drawer.clientWidth,
      drawerText: drawer.textContent ?? "",
      gridOverflow: scroller.scrollWidth - scroller.clientWidth,
      gridScrollLeft: scroller.scrollLeft,
      partialHeaders: visibleHeaders
        .filter((header) => {
          const bounds = header.getBoundingClientRect();
          return bounds.left < dataLeft - 1 || bounds.right > visibleRight + 1;
        })
        .map((header) => header.getAttribute("data-column") ?? ""),
      clippedTitles: visibleHeaders
        .filter((header) => {
          const title = header.querySelector(".columnTitle");
          return Boolean(title && title.scrollWidth > title.clientWidth + 1);
        })
        .map((header) => header.getAttribute("data-column") ?? ""),
      visibleColumns: visibleHeaders.map((header) => header.getAttribute("data-column") ?? "")
    };
  });
  assert.ok(measurement.gridOverflow > 0, "Explore must retain real horizontal grid virtualization.");
  assert.ok(measurement.gridScrollLeft <= 1, "Explore must begin at the first complete grid column.");
  assert.ok(measurement.layoutOverflow <= 1, "Explore must not overflow the production workspace.");
  assert.equal(measurement.clippedToolbarIdentity, false, "Explore must show its complete source name and shape.");
  assert.ok(measurement.drawerOverflow <= 1, "Explore Column profiles must not clip horizontally.");
  assert.deepEqual(measurement.partialHeaders, []);
  assert.deepEqual(measurement.clippedTitles, []);
  assert.deepEqual(measurement.visibleColumns, ["order_id", "market", "revenue"]);
  for (const label of ["Min", "Max", "Mean", "Median", "Distribution", "Counts"]) {
    assert.ok(measurement.drawerText.includes(label), `Explore Column profiles must show ${label}.`);
  }
  assert.equal(
    await workbench.locator(".part.panel:visible").count(),
    0,
    "Explore must keep the native bottom panel closed."
  );
}

async function assertPackagedWorkflowScene(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  sidebar: Locator,
  codePreview: Locator
): Promise<void> {
  assert.deepEqual(testing.activeSession()?.viewState.filterModel.sort, [
    { column: "revenue", direction: "desc", nulls: "last" },
    { column: "market", direction: "desc", nulls: "last" }
  ]);
  const filters = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
  const steps = sidebar.getByRole("tree", { name: /Cleaning Steps/u }).first();
  await filters.getByRole("treeitem", { name: /^revenue, Priority 1 · Descending · nulls last/u }).waitFor({
    state: "visible",
    timeout: 10_000
  });
  await filters.getByRole("treeitem", { name: /^market, Priority 2 · Descending · nulls last/u }).waitFor({
    state: "visible",
    timeout: 10_000
  });
  for (const expected of [/Original data/u, /1\. Uppercase/u, /Draft · Formula column/u]) {
    await steps.getByRole("treeitem", { name: expected }).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  await assertPackagedProductSidebarGeometry(sidebar);
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "Workflow geometry requires the exact production renderer.");
  const review = app.getByRole("region", { name: "Draft review" });
  await review.waitFor({ state: "visible", timeout: 10_000 });
  await review.getByText("Formula column", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await review
    .locator('[aria-label="Data diff summary"]')
    .getByText("+1 column", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  await review.getByRole("button", { name: "Discard", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await review.getByRole("button", { name: "Apply step", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const active = testing.activeSession();
  assert.ok(active, "The Workflow scene requires the exact active dataframe session.");
  assert.equal(active?.metadata.steps.length, 1);
  assert.equal(active?.metadata.steps[0]?.kind, "upperText");
  const draft = active?.metadata.draftStep;
  assert.equal(draft?.kind, "formula");
  if (!draft || draft.kind !== "formula") throw new Error("The Workflow scene requires one numeric formula draft.");
  assert.deepEqual(draft.params, {
    leftColumn: columnReference(active.metadata, "revenue"),
    operator: "add",
    value: 500,
    newColumn: "projected_revenue"
  });
  const measurement = await app.evaluate((root) => {
    type ProductSceneRect = { bottom: number; height: number; left: number; right: number; top: number; width: number };
    type ProductSceneElement = {
      readonly clientWidth: number;
      readonly scrollLeft: number;
      readonly scrollWidth: number;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): ProductSceneRect;
      querySelector(selector: string): ProductSceneElement | null;
      querySelectorAll(selector: string): ArrayLike<ProductSceneElement>;
    };
    const appRoot = root as unknown as ProductSceneElement;
    const layout = appRoot.querySelector(".layout");
    const review = appRoot.querySelector('.draftReview[aria-label="Draft review"]');
    const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
    const grid = scroller?.querySelector('[role="grid"]');
    const sourceLabel = appRoot.querySelector(".toolbarIdentity strong");
    const shapeLabel = appRoot.querySelector(".toolbarIdentity span");
    const rowHeader = scroller?.querySelector("th.rowHeader");
    if (!layout || !review || !scroller || !grid || !sourceLabel || !shapeLabel || !rowHeader) {
      throw new Error("The Workflow product layout is incomplete.");
    }
    const scrollerBounds = scroller.getBoundingClientRect();
    const dataLeft = rowHeader.getBoundingClientRect().right;
    const visibleHeaders = Array.from(appRoot.querySelectorAll("th[data-column]")).filter((header) => {
      const bounds = header.getBoundingClientRect();
      return bounds.right > dataLeft + 1 && bounds.left < scrollerBounds.right - 1;
    });
    return {
      layoutOverflow: layout.scrollWidth - layout.clientWidth,
      clippedToolbarIdentity:
        sourceLabel.scrollWidth > sourceLabel.clientWidth + 1 || shapeLabel.scrollWidth > shapeLabel.clientWidth + 1,
      reviewOverflow: review.scrollWidth - review.clientWidth,
      reviewBounds: review.getBoundingClientRect(),
      appBounds: appRoot.getBoundingClientRect(),
      gridVisible: grid.getBoundingClientRect().height > 0,
      gridScrollLeft: scroller.scrollLeft,
      partialHeaders: visibleHeaders
        .filter((header) => {
          const bounds = header.getBoundingClientRect();
          return bounds.left < dataLeft - 1 || bounds.right > scrollerBounds.right + 1;
        })
        .map((header) => header.getAttribute("data-column") ?? ""),
      clippedTitles: visibleHeaders
        .filter((header) => {
          const title = header.querySelector(".columnTitle");
          return Boolean(title && title.scrollWidth > title.clientWidth + 1);
        })
        .map((header) => header.getAttribute("data-column") ?? ""),
      visibleColumns: visibleHeaders.map((header) => header.getAttribute("data-column") ?? "")
    };
  });
  assert.ok(measurement.layoutOverflow <= 1, "Workflow must not overflow the production workspace.");
  assert.equal(measurement.clippedToolbarIdentity, false, "Workflow must show its complete source name and shape.");
  assert.ok(measurement.reviewOverflow <= 1, "Workflow Draft review must not clip controls or diff labels.");
  assert.ok(measurement.reviewBounds.left >= measurement.appBounds.left - 1);
  assert.ok(measurement.reviewBounds.right <= measurement.appBounds.right + 1);
  assert.equal(measurement.gridVisible, true);
  assert.ok(measurement.gridScrollLeft > 0, "Workflow must reveal the draft's added columns.");
  assert.deepEqual(measurement.partialHeaders, []);
  assert.deepEqual(measurement.clippedTitles, []);
  assert.ok(measurement.visibleColumns.includes("market_upper"));
  assert.ok(measurement.visibleColumns.includes("projected_revenue"));
  const code = await codePreview.innerText();
  assert.match(code, /import polars as pl/u);
  assert.match(code, /market_upper/u);
  assert.match(code, /projected_revenue/u);
  assert.match(code, /pl\.col\('revenue'\) \+ pl\.lit\(500\)/u);
  assert.equal(await codePreview.isVisible(), true, "Workflow must keep the generated Polars code visible.");
  const codeBounds = await codePreview.boundingBox();
  assert.ok(codeBounds && codeBounds.width > 0 && codeBounds.height > 0, "Workflow Code Preview must remain legible.");
  assert.equal(await workbench.locator(".part.panel:visible").count(), 1, "Workflow must keep its native panel open.");
}

async function assertPackagedProductSidebarGeometry(sidebar: Locator): Promise<void> {
  const geometry = await sidebar.evaluate((root) => {
    type ProductSceneRect = { left: number; right: number };
    type ProductSceneElement = {
      readonly clientWidth: number;
      readonly scrollWidth: number;
      readonly textContent: string | null;
      getBoundingClientRect(): ProductSceneRect & { height: number };
      querySelector(selector: string): ProductSceneElement | null;
      querySelectorAll(selector: string): ArrayLike<ProductSceneElement>;
    };
    const sidebarRoot = root as unknown as ProductSceneElement;
    const bounds = sidebarRoot.getBoundingClientRect();
    const headings = Array.from(sidebarRoot.querySelectorAll(".pane-header")).filter(
      (heading) => heading.getBoundingClientRect().height > 0
    );
    const treeLabels = Array.from(
      sidebarRoot.querySelectorAll(".monaco-list-row .label-name, .monaco-list-row .label-description")
    ).filter(
      (label) => label.getBoundingClientRect().height > 0 && Boolean(label.textContent?.replace(/\s+/gu, " ").trim())
    );
    return {
      headingCount: headings.length,
      clippedHeadings: headings
        .filter((heading) => {
          const item = heading.querySelector(".title");
          const itemBounds = item?.getBoundingClientRect();
          return Boolean(
            !item ||
            !itemBounds ||
            item.scrollWidth > item.clientWidth + 1 ||
            itemBounds.left < bounds.left - 1 ||
            itemBounds.right > bounds.right + 1
          );
        })
        .map((heading) => heading.textContent?.replace(/\s+/gu, " ").trim() ?? ""),
      clippedRows: treeLabels
        .filter((label) => {
          const labelBounds = label.getBoundingClientRect();
          return (
            label.scrollWidth > label.clientWidth + 1 ||
            labelBounds.left < bounds.left - 1 ||
            labelBounds.right > bounds.right + 1
          );
        })
        .map((label) => label.textContent?.replace(/\s+/gu, " ").trim() ?? "")
    };
  });
  assert.ok(geometry.headingCount >= 4, "The Open Wrangler sidebar must show all four native view headings.");
  assert.deepEqual(geometry.clippedHeadings, []);
  assert.deepEqual(geometry.clippedRows, []);
}

async function clearPackagedProductSceneTransientUi(workbench: Page): Promise<void> {
  const commands = new Set(await vscode.commands.getCommands(true));
  if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
  if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
  await workbench.mouse.move(Math.floor(PACKAGED_PRODUCT_VIEWPORT.width * 0.72), 34);
  const transient = workbench.locator(
    ".quick-input-widget:visible, .monaco-dialog-box:visible, .context-view.monaco-menu-container:visible, " +
      ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible, " +
      ".monaco-hover:visible"
  );
  assert.equal(
    await pollAcceptanceCondition(async () => (await transient.count()) === 0, {
      timeoutMs: 3_000,
      intervalMs: 50
    }),
    true,
    "Packaged product-scene capture must not retain transient workbench UI."
  );
}

async function exercisePackagedNotebookFlows(testing: TestApi): Promise<void> {
  recordAcceptanceProgress("verify:notebook:fixture");
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-notebook-"));
  const notebookPath = path.join(directory, "notebook-acceptance.ipynb");
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const originalMode = configuration.get<"viewing" | "editing">("notebookStartMode", "viewing");
  const originalWorkspacePreviewProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
    "notebookPreviewProvider"
  )?.workspaceValue;
  let previewProviderOverridden = false;
  const page: GridPage = {
    offset: 0,
    limit: 1,
    totalRows: 1,
    columnIds: ["c:0"],
    rows: [
      {
        id: "r:0",
        rowNumber: 0,
        values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
      }
    ]
  };
  const schema: SessionMetadata["schema"] = [
    { id: "c:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }
  ];
  const currentPayload: NotebookOutputPayload = {
    mimeVersion: 2,
    metadata: {
      protocolVersion: 2,
      sessionId: "snapshot",
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: {
        kind: "notebookOutput",
        label: "renderer provenance A",
        variableName: "renderer_frame"
      },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: 1, columns: 1 },
      filteredShape: { rows: 1, columns: 1 },
      schema,
      filterModel: { filters: [], sort: [] },
      steps: []
    },
    page,
    summaries: []
  };
  writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            {
              output_type: "display_data",
              metadata: {},
              data: {
                "text/plain": ["Open Wrangler saved output"],
                [OPEN_WRANGLER_MIME_V2]: currentPayload
              }
            }
          ],
          source: ["value = 1"]
        }
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5
    })
  );

  try {
    recordAcceptanceProgress("verify:notebook:document-open");
    await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(notebookPath));
    await vscode.window.showNotebookDocument(notebook);
    const outputMimes = notebook.cellAt(0).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(outputMimes.includes(OPEN_WRANGLER_MIME_V2), "MIME v2 output must be registered in a real notebook.");

    recordAcceptanceProgress("verify:notebook:direct-insertion");
    const inserted = await insertGeneratedNotebookCell(notebook, 1, "def clean_data(df):\n    return df\n", {
      source: "df",
      backend: "polars",
      languageId: "python"
    });
    assert.deepEqual(inserted, { status: "applied" });
    assert.equal(notebook.cellCount, 2);
    assert.equal(notebook.cellAt(1).document.getText(), "def clean_data(df):\n    return df\n");
    assert.deepEqual(notebook.cellAt(1).metadata.openWrangler, {
      source: "df",
      backend: "polars",
      languageId: "python",
      generated: true,
      insertionId: notebook.cellAt(1).metadata.openWrangler.insertionId
    });
    assert.equal(typeof notebook.cellAt(1).metadata.openWrangler.insertionId, "string");

    recordAcceptanceProgress("verify:notebook:jupyter-activate");
    const jupyterExtension = vscode.extensions.getExtension<FakeJupyterApi>("ms-toolsai.jupyter");
    assert.ok(jupyterExtension, "The stable Jupyter API acceptance extension must be available.");
    const jupyter = await jupyterExtension.activate();
    const setupCode = [
      "import pandas as pd",
      "import polars as pl",
      "pandas_frame = pd.DataFrame({'value': [1, 2], 'label': ['a', 'b']})",
      "duplicate_frame = pd.DataFrame([[2, 10.26, 'a', 'red', 'x', '2024-01-02', '2020-05-06'], [1, 20.74, 'b', 'blue', 'y', '2024-02-03', '2021-06-07'], [2, 10.26, 'c', 'red', 'z', '2024-03-04', '2022-07-08'], [2, None, 'd', 'green', 'x', '2024-04-05', '2023-08-09']], columns=['duplicate', 'duplicate', 7, 'category', 'category', 'when', 'when'])",
      "duplicate_frame_source = duplicate_frame.copy(deep=True)",
      "structural_frame = duplicate_frame.copy(deep=True)",
      "structural_frame_source = structural_frame.copy(deep=True)",
      "identity_frame = duplicate_frame.copy(deep=True)",
      "identity_frame.iloc[:, 2] = ['alpha', 'bravo', 'charlie', 'delta']",
      "identity_frame_source = identity_frame.copy(deep=True)",
      ...pandasIndexFixtureSetupCode(),
      "polars_frame = pl.DataFrame({'value': [3, 4], 'label': ['c', 'd']})",
      "renderer_frame = pl.DataFrame({'value': [101]})"
    ].join("\n");
    recordAcceptanceProgress("verify:notebook:kernel-setup");
    await jupyter.testing.execute(notebook.uri, setupCode);

    recordAcceptanceProgress("verify:notebook:pandas-basic:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "pandas_frame",
      fileName: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "pandas_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged Pandas notebook variable session"
    );
    let active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    assert.equal(active?.metadata.capabilities.notebookInsert, true);
    if (!active) throw new Error("Pandas notebook session did not become active.");
    recordAcceptanceProgress("verify:notebook:pandas-basic:page");
    const pandasPage = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-page",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(pandasPage.kind, "page");
    if (pandasPage.kind !== "page") throw new Error("Pandas notebook page did not resolve.");
    assert.equal(pandasPage.page.rows[1]?.values[0]?.display, "2");
    recordAcceptanceProgress("verify:notebook:pandas-basic:preview");
    const preview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: active.sessionId,
      revision: pandasPage.revision,
      step: {
        id: "notebook-score",
        kind: "formula",
        params: {
          leftColumn: columnReference(active.metadata, "value"),
          operator: "multiply",
          value: 2,
          newColumn: "score"
        }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(preview.kind, "stepPreview");
    if (preview.kind !== "stepPreview") throw new Error("Pandas notebook step did not preview.");
    recordAcceptanceProgress("verify:notebook:pandas-basic:apply");
    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: active.sessionId,
      revision: preview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") throw new Error("Pandas notebook step did not apply.");
    const editedNotebookCode = "# edited notebook export\ndef clean_data(df):\n    return df\n";
    testing.setCodeForExport(editedNotebookCode);
    const insertionIndex = notebook.cellCount;
    recordAcceptanceProgress("verify:notebook:pandas-basic:insert");
    await vscode.commands.executeCommand("openWrangler.insertNotebookCode");
    await waitFor(
      () => notebook.cellCount === insertionIndex + 1,
      10_000,
      "the notebook export command to insert a cell"
    );
    assert.equal(notebook.cellAt(insertionIndex).document.getText(), editedNotebookCode);
    const pandasInsertionMetadata = notebook.cellAt(insertionIndex).metadata.openWrangler;
    assert.deepEqual(pandasInsertionMetadata, {
      source: "pandas_frame",
      backend: "pandas",
      languageId: "python",
      generated: true,
      insertionId: pandasInsertionMetadata.insertionId
    });
    assert.equal(typeof pandasInsertionMetadata.insertionId, "string");
    recordAcceptanceProgress("verify:notebook:pandas-basic:close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the Pandas notebook session");
    await waitFor(() => testing.diagnostics().sessionCount === 0, 10_000, "the Pandas notebook session to close");

    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      const workbench = await connectToEditorWorkbench();
      await exercisePandasIndexFidelityJourney({
        testing,
        notebookUri: notebook.uri,
        executeNotebook: (code) => jupyter.testing.execute(notebook.uri, code),
        workbench,
        sessionApp: (sessionId, description) =>
          synchronizedSessionApp(
            workbench,
            testing,
            sessionId,
            `${description} must render its confirmed shared-webview state.`
          ),
        disposeSession: disposePackagedSessionPanel,
        createTemporaryDirectory: () => mkdtempSync(path.join(tmpdir(), "openwrangler-pandas-index-")),
        cleanupTemporaryDirectory: cleanupAcceptanceTemporaryDirectory,
        recordProgress: recordAcceptanceProgress,
        waitFor,
        sessionOpenTimeoutMs: SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS
      });
    }

    recordAcceptanceProgress("verify:notebook:pandas-duplicates:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "duplicate_frame",
      fileName: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "duplicate_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged duplicate-column Pandas notebook variable session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    if (!active) throw new Error("Duplicate-column Pandas notebook session did not become active.");
    assert.deepEqual(
      active.metadata.schema.map((column) => column.name),
      ["duplicate", "duplicate", "7", "category", "category", "when", "when"]
    );
    const firstDuplicate = columnReferenceAt(active.metadata, 0);
    const secondDuplicate = columnReferenceAt(active.metadata, 1);
    const integerLabel = columnReferenceAt(active.metadata, 2);
    const firstCategory = columnReferenceAt(active.metadata, 3);
    const secondCategory = columnReferenceAt(active.metadata, 4);
    const firstDatetime = columnReferenceAt(active.metadata, 5);
    const secondDatetime = columnReferenceAt(active.metadata, 6);
    assert.notEqual(firstDuplicate.id, secondDuplicate.id, "Duplicate labels must retain distinct stable identities.");
    assert.notEqual(firstCategory.id, secondCategory.id, "Duplicate category labels must retain distinct identities.");
    assert.notEqual(firstDatetime.id, secondDatetime.id, "Duplicate datetime labels must retain distinct identities.");
    assert.equal(integerLabel.name, "7");

    recordAcceptanceProgress("verify:notebook:pandas-duplicates:profiles");
    const duplicateProfiles = await testing.request({
      kind: "getSummary",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      viewRequestId: "notebook-pandas-duplicate-profiles",
      filterModel: active.metadata.filterModel,
      columnIds: [firstDuplicate.id, secondDuplicate.id]
    });
    assert.equal(duplicateProfiles.kind, "summary", "Duplicate-label profiles must resolve by stable ID.");
    if (duplicateProfiles.kind !== "summary") throw new Error("Duplicate-label profiles did not resolve.");
    assert.deepEqual(
      duplicateProfiles.summaries.map((summary) => [summary.columnId, summary.column]),
      [
        [firstDuplicate.id, "duplicate"],
        [secondDuplicate.id, "duplicate"]
      ]
    );
    assert.deepEqual(
      duplicateProfiles.summaries.map((summary) => [summary.numeric?.min, summary.numeric?.max]),
      [
        [1, 2],
        [10.26, 20.74]
      ],
      "Same-name numeric columns must retain their own statistics."
    );

    let duplicateRevision = active.metadata.revision;
    const valueSteps: TransformStep[] = [
      {
        id: "duplicate-one-hot-second-category",
        kind: "oneHotEncode",
        params: { columns: [secondCategory], prefixSeparator: "__", dropOriginal: false }
      },
      {
        id: "integer-label-uppercase",
        kind: "upperText",
        params: { column: integerLabel }
      },
      {
        id: "duplicate-round-second",
        kind: "roundNumber",
        params: { column: secondDuplicate, decimals: 1 }
      },
      {
        id: "duplicate-format-second-datetime",
        kind: "formatDatetime",
        params: { column: secondDatetime, format: "%Y" }
      }
    ];
    const valueCodeMarkers: readonly (readonly RegExp[])[] = [
      [
        /for _position_0, _column_0 in \[\(4, 'category'\)\]:\s+_encoded_series_0 = df\.iloc\[:, _position_0\]/u,
        /\.eq\(value\)\.fillna\(False\)\.astype\('int8'\)/u
      ],
      [/df\.isetitem\(2, df\.iloc\[:, 2\]\.astype\('string'\)\.map\(str\.upper, na_action='ignore'\)\)/u],
      [/df\.isetitem\(1, pd\.to_numeric\(df\.iloc\[:, 1\], errors='coerce'\)\.round\(1\)\)/u],
      [/df\.isetitem\(6, pd\.to_datetime\(df\.iloc\[:, 6\], errors='coerce'\)\.dt\.strftime\('%Y'\)\)/u]
    ];

    for (const [index, step] of valueSteps.entries()) {
      recordAcceptanceProgress(`verify:notebook:pandas-duplicates:value:${step.kind}:preview`);
      const valuePreview = await testing.request({
        kind: "previewStep",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: duplicateRevision,
        step,
        offset: 0,
        limit: 10
      });
      assert.equal(valuePreview.kind, "stepPreview", `Packaged ${step.kind} must preview duplicate labels.`);
      if (valuePreview.kind !== "stepPreview") {
        throw new Error(`Packaged ${step.kind} duplicate-label preview did not resolve.`);
      }
      for (const marker of valueCodeMarkers[index]) {
        assert.match(
          valuePreview.code,
          marker,
          `${step.kind} generated code must bind its operation-specific implementation to the exact Pandas position.`
        );
      }
      assert.doesNotMatch(
        JSON.stringify(valuePreview.metadata.draftStep),
        /"position"\s*:/u,
        "Private bound positions must not leak into public value-operation drafts."
      );

      if (step.kind === "oneHotEncode") {
        const encodedX = columnReference(valuePreview.metadata, "category__x");
        const encodedY = columnReference(valuePreview.metadata, "category__y");
        const encodedZ = columnReference(valuePreview.metadata, "category__z");
        assert.deepEqual(gridColumnDisplays(valuePreview.page, encodedX.id), ["1", "0", "0", "1"]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, encodedY.id), ["0", "1", "0", "0"]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, encodedZ.id), ["0", "0", "1", "0"]);
        assert.equal(
          valuePreview.metadata.schema.some((column) => column.name === "category__red"),
          false,
          "One-hot encoding must use the selected second duplicate, not its same-named neighbor."
        );
      } else if (step.kind === "upperText") {
        assert.deepEqual(gridColumnDisplays(valuePreview.page, integerLabel.id), ["A", "B", "C", "D"]);
      } else if (step.kind === "roundNumber") {
        assert.deepEqual(gridColumnDisplays(valuePreview.page, secondDuplicate.id).slice(0, 3), [
          "10.3",
          "20.7",
          "10.3"
        ]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, firstDuplicate.id), ["2", "1", "2", "2"]);
      } else if (step.kind === "formatDatetime") {
        assert.deepEqual(gridColumnDisplays(valuePreview.page, secondDatetime.id), ["2020", "2021", "2022", "2023"]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, firstDatetime.id), [
          "2024-01-02",
          "2024-02-03",
          "2024-03-04",
          "2024-04-05"
        ]);
      }

      recordAcceptanceProgress(`verify:notebook:pandas-duplicates:value:${step.kind}:apply`);
      const valueApplied = await testing.request({
        kind: "applyDraft",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: valuePreview.revision,
        offset: 0,
        limit: 10
      });
      assert.equal(valueApplied.kind, "planUpdated", `Packaged ${step.kind} must apply duplicate labels.`);
      if (valueApplied.kind !== "planUpdated") {
        throw new Error(`Packaged ${step.kind} duplicate-label apply did not resolve.`);
      }
      assert.equal(valueApplied.metadata.steps.length, index + 1);
      assert.doesNotMatch(
        JSON.stringify(valueApplied.metadata.steps),
        /"position"\s*:/u,
        "Private bound positions must not leak into persisted value-operation steps."
      );
      duplicateRevision = valueApplied.revision;
    }

    const duplicateSteps: TransformStep[] = [
      {
        id: "duplicate-sort-second",
        kind: "sortRows",
        params: {
          rules: [
            { column: secondDuplicate, direction: "desc", nulls: "last" },
            { column: integerLabel, direction: "desc", nulls: "last" }
          ]
        }
      },
      {
        id: "duplicate-filter-first",
        kind: "filterRows",
        params: {
          filterModel: {
            logic: "and",
            filters: [
              {
                column: firstDuplicate,
                type: "integer",
                predicates: [{ kind: "predicate", operator: "equals", value: 2 }]
              }
            ],
            sort: []
          }
        }
      },
      {
        id: "duplicate-drop-missing-second",
        kind: "dropMissingRows",
        params: { columns: [secondDuplicate], how: "any" }
      },
      {
        id: "duplicate-drop-duplicates-pair",
        kind: "dropDuplicates",
        params: { columns: [firstDuplicate, secondDuplicate], keep: "first" }
      }
    ];
    const expectedThirdColumnAfterStep = [["B", "C", "A", "D"], ["C", "A", "D"], ["C", "A"], ["C"]];
    const expectedCodeMarkerAfterStep: readonly (readonly RegExp[])[] = [
      [/_sort_order_4_0 = df\.iloc\[:, 2\]/u, /_sort_order_4_1 = df\.iloc\[:, 1\]/u],
      [
        /_filter_mask_5 = .*df\.iloc\[:, 0\] == _open_wrangler_view_value\(2, 'integer'\).*_open_wrangler_is_null.*_open_wrangler_is_nan/u
      ],
      [
        /_missing_positions_6 = \[1\] or list\(range\(df\.shape\[1\]\)\)/u,
        /\[df\.iloc\[:, position\]\.notna\(\) for position in _missing_positions_6\]/u
      ],
      [
        /_duplicate_positions_7 = \[0, 1\] or list\(range\(df\.shape\[1\]\)\)/u,
        /df\.iloc\[:, _duplicate_positions_7\]/u
      ]
    ];

    for (const [index, step] of duplicateSteps.entries()) {
      recordAcceptanceProgress(`verify:notebook:pandas-duplicates:rows:${step.kind}:preview`);
      const duplicatePreview = await testing.request({
        kind: "previewStep",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: duplicateRevision,
        step,
        offset: 0,
        limit: 10
      });
      assert.equal(duplicatePreview.kind, "stepPreview", `Packaged ${step.kind} must preview duplicate labels.`);
      if (duplicatePreview.kind !== "stepPreview") {
        throw new Error(`Packaged ${step.kind} duplicate-label preview did not resolve.`);
      }
      for (const marker of expectedCodeMarkerAfterStep[index]) {
        assert.match(
          duplicatePreview.code,
          marker,
          `${step.kind} generated code must bind its operation-specific implementation to the exact Pandas position.`
        );
      }
      assert.doesNotMatch(
        JSON.stringify(duplicatePreview.metadata.draftStep),
        /"position"\s*:/u,
        "Private bound positions must not leak into the public draft step."
      );
      assert.deepEqual(
        duplicatePreview.page.rows.map((row) => row.values[2]?.display),
        expectedThirdColumnAfterStep[index],
        `${step.kind} must target the selected duplicate or integer-labelled column before apply.`
      );
      recordAcceptanceProgress(`verify:notebook:pandas-duplicates:rows:${step.kind}:apply`);
      const duplicateApplied = await testing.request({
        kind: "applyDraft",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: duplicatePreview.revision,
        offset: 0,
        limit: 10
      });
      assert.equal(duplicateApplied.kind, "planUpdated", `Packaged ${step.kind} must apply duplicate labels.`);
      if (duplicateApplied.kind !== "planUpdated") {
        throw new Error(`Packaged ${step.kind} duplicate-label apply did not resolve.`);
      }
      assert.equal(duplicateApplied.metadata.steps.length, valueSteps.length + index + 1);
      assert.doesNotMatch(
        JSON.stringify(duplicateApplied.metadata.steps),
        /"position"\s*:/u,
        "Private bound positions must not leak into persisted cleaning steps."
      );
      duplicateRevision = duplicateApplied.revision;
    }

    const duplicateSourceBeforeRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(duplicate_frame.equals(duplicate_frame_source))"
    );
    assert.match(
      duplicateSourceBeforeRestart,
      /\bTrue\b/u,
      "Cleaning steps must not mutate the originating notebook dataframe before kernel recovery."
    );

    recordAcceptanceProgress("verify:notebook:pandas-duplicates:replay");
    const duplicateGeneration = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const duplicateReplacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(duplicateReplacementGeneration > duplicateGeneration);
    const duplicateReplayed = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-duplicate-row-operations-replay",
      sessionId: active.sessionId,
      revision: duplicateRevision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(duplicateReplayed.kind, "page", "Duplicate/non-string row operations must replay after restart.");
    if (duplicateReplayed.kind !== "page") throw new Error("Duplicate/non-string row-operation replay failed.");
    assert.equal(jupyter.testing.stats(notebook.uri)?.generation, duplicateReplacementGeneration);
    assert.equal(duplicateReplayed.page.totalRows, 1);
    assert.equal(duplicateReplayed.metadata.steps.length, valueSteps.length + duplicateSteps.length);
    recordAcceptanceProgress("verify:notebook:pandas-duplicates:profiles-replayed");
    const replayedDuplicateProfiles = await testing.request({
      kind: "getSummary",
      sessionId: active.sessionId,
      revision: duplicateRevision,
      viewRequestId: "notebook-pandas-duplicate-profiles-replayed",
      filterModel: active.metadata.filterModel,
      columnIds: [firstDuplicate.id, secondDuplicate.id]
    });
    assert.equal(replayedDuplicateProfiles.kind, "summary", "Duplicate-label profiles must replay by stable ID.");
    if (replayedDuplicateProfiles.kind !== "summary") {
      throw new Error("Replayed duplicate-label profiles did not resolve.");
    }
    assert.deepEqual(
      replayedDuplicateProfiles.summaries.map((summary) => [summary.columnId, summary.column]),
      [
        [firstDuplicate.id, "duplicate"],
        [secondDuplicate.id, "duplicate"]
      ]
    );
    assert.deepEqual(
      replayedDuplicateProfiles.summaries.map((summary) => [summary.numeric?.min, summary.numeric?.max]),
      [
        [2, 2],
        [10.3, 10.3]
      ],
      "Kernel replay must not collapse same-name profiles."
    );
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, firstDuplicate.id), ["2"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, secondDuplicate.id), ["10.3"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, integerLabel.id), ["C"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, firstCategory.id), ["red"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, secondCategory.id), ["z"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, firstDatetime.id), ["2024-03-04"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, secondDatetime.id), ["2022"]);
    assert.deepEqual(gridColumnCells(duplicateReplayed.page, secondDuplicate.id), [
      { kind: "number", raw: 10.3, display: "10.3", isNull: false, isNaN: false }
    ]);
    assert.deepEqual(gridColumnCells(duplicateReplayed.page, integerLabel.id), [
      { kind: "string", raw: "C", display: "C", isNull: false, isNaN: false }
    ]);
    assert.deepEqual(gridColumnCells(duplicateReplayed.page, secondDatetime.id), [
      { kind: "string", raw: "2022", display: "2022", isNull: false, isNaN: false }
    ]);
    for (const [name, expected] of [
      ["category__x", "0"],
      ["category__y", "0"],
      ["category__z", "1"]
    ] as const) {
      assert.deepEqual(
        gridColumnDisplays(duplicateReplayed.page, columnReference(duplicateReplayed.metadata, name).id),
        [expected]
      );
      assert.deepEqual(gridColumnCells(duplicateReplayed.page, columnReference(duplicateReplayed.metadata, name).id), [
        { kind: "integer", raw: Number(expected), display: expected, isNull: false, isNaN: false }
      ]);
    }
    assert.deepEqual(
      duplicateReplayed.metadata.schema.slice(0, 7).map((column) => column.name),
      ["duplicate", "duplicate", "7", "category", "category", "when", "when"]
    );
    assert.doesNotMatch(
      JSON.stringify(duplicateReplayed.metadata.steps),
      /"position"\s*:/u,
      "Kernel replay must retain position-free public references."
    );
    recordAcceptanceProgress("verify:notebook:pandas-duplicates:close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the duplicate-column Pandas notebook session");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0,
      10_000,
      "the duplicate-column Pandas notebook session to close"
    );
    assert.deepEqual(testing.diagnostics().sessions, [], "Duplicate/non-string acceptance must retain no session.");
    const duplicateSourceState = await jupyter.testing.execute(
      notebook.uri,
      "print(duplicate_frame.equals(duplicate_frame_source))"
    );
    assert.match(
      duplicateSourceState,
      /\bTrue\b/u,
      "Cleaning steps must not mutate the originating notebook dataframe."
    );

    recordAcceptanceProgress("verify:notebook:pandas-structural:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "structural_frame",
      fileName: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "structural_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged structural duplicate-column Pandas notebook variable session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    if (!active) throw new Error("Structural duplicate-column Pandas session did not become active.");
    const structuralSessionId = active.sessionId;
    const structuralFirstDuplicate = columnReferenceAt(active.metadata, 0);
    const structuralSecondDuplicate = columnReferenceAt(active.metadata, 1);
    const structuralIntegerLabel = columnReferenceAt(active.metadata, 2);
    const structuralFirstCategory = columnReferenceAt(active.metadata, 3);
    const structuralSecondCategory = columnReferenceAt(active.metadata, 4);
    const structuralFirstDatetime = columnReferenceAt(active.metadata, 5);
    const structuralSecondDatetime = columnReferenceAt(active.metadata, 6);
    assert.equal(structuralFirstDuplicate.name, "duplicate");
    assert.equal(structuralSecondDuplicate.name, "duplicate");
    assert.notEqual(
      structuralFirstDuplicate.id,
      structuralSecondDuplicate.id,
      "Structural acceptance requires independently addressable duplicate labels."
    );
    assert.equal(structuralIntegerLabel.name, "7");

    const structuralRenamedFirst = {
      id: structuralFirstDuplicate.id,
      name: "renamed_first"
    } as const;
    const structuralSteps: TransformStep[] = [
      {
        id: "structural-select-reordered",
        kind: "selectColumns",
        params: {
          columns: [
            structuralSecondDuplicate,
            structuralIntegerLabel,
            structuralFirstDuplicate,
            structuralSecondCategory,
            structuralFirstCategory,
            structuralSecondDatetime,
            structuralFirstDatetime
          ]
        }
      },
      {
        id: "structural-clone-second",
        kind: "cloneColumn",
        params: { column: structuralSecondDuplicate, newName: "second_copy" }
      },
      {
        id: "structural-cast-first",
        kind: "castColumn",
        params: { column: structuralFirstDuplicate, dtype: "float" }
      },
      {
        id: "structural-formula-duplicates",
        kind: "formula",
        params: {
          leftColumn: structuralFirstDuplicate,
          operator: "add",
          rightColumn: structuralSecondDuplicate,
          newColumn: "combined"
        }
      },
      {
        id: "structural-text-length-integer",
        kind: "textLength",
        params: { column: structuralIntegerLabel, newColumn: "label_length" }
      },
      {
        id: "structural-drop-second-duplicate",
        kind: "dropColumns",
        params: { columns: [structuralSecondDuplicate] }
      },
      {
        id: "structural-rename-first-duplicate",
        kind: "renameColumn",
        params: { column: structuralFirstDuplicate, newName: structuralRenamedFirst.name }
      }
    ];
    const structuralCodeMarkers = [
      /df = df\.iloc\[:, \[1, 2, 0, 4, 3, 6, 5\]\]\.copy\(\)/u,
      /df = pd\.concat\(\[df, df\.iloc\[:, 0\]\.rename\('second_copy'\)\], axis=1\)/u,
      /df\.isetitem\(2, df\.iloc\[:, 2\]\.astype\('Float64'\)\)/u,
      /df = pd\.concat\(\[df, \(df\.iloc\[:, 2\] \+ df\.iloc\[:, 0\]\)\.rename\('combined'\)\], axis=1\)/u,
      /df = pd\.concat\(\[df, df\.iloc\[:, 1\]\.astype\('string'\)\.str\.len\(\)\.rename\('label_length'\)\], axis=1\)/u,
      /df = df\.iloc\[:, \[position for position in range\(df\.shape\[1\]\) if position not in \[0\]\]\]\.copy\(\)/u,
      /_columns_6\[1\] = 'renamed_first'/u
    ] as const;
    const secondDuplicateCells = [
      { kind: "number", raw: 10.26, display: "10.26", isNull: false, isNaN: false },
      { kind: "number", raw: 20.74, display: "20.74", isNull: false, isNaN: false },
      { kind: "number", raw: 10.26, display: "10.26", isNull: false, isNaN: false },
      { kind: "nan", raw: null, display: "NaN", isNull: false, isNaN: true }
    ] as const;
    const castDuplicateCells = [
      { kind: "number", raw: 2, display: "2.0", isNull: false, isNaN: false },
      { kind: "number", raw: 1, display: "1.0", isNull: false, isNaN: false },
      { kind: "number", raw: 2, display: "2.0", isNull: false, isNaN: false },
      { kind: "number", raw: 2, display: "2.0", isNull: false, isNaN: false }
    ] as const;
    const combinedCells = [
      { kind: "number", raw: 12.26, display: "12.26", isNull: false, isNaN: false },
      { kind: "number", raw: 21.74, display: "21.74", isNull: false, isNaN: false },
      { kind: "number", raw: 12.26, display: "12.26", isNull: false, isNaN: false },
      { kind: "null", raw: null, display: "", isNull: true, isNaN: false }
    ] as const;
    const lengthCells = ["a", "b", "c", "d"].map(() => ({
      kind: "integer" as const,
      raw: 1,
      display: "1",
      isNull: false,
      isNaN: false
    }));
    const integerLabelCells = ["a", "b", "c", "d"].map((value) => ({
      kind: "string" as const,
      raw: value,
      display: value,
      isNull: false,
      isNaN: false
    }));

    let structuralRevision = active.metadata.revision;
    let structuralMetadata = active.metadata;
    let structuralPage: LiveGridPage | undefined;
    let structuralClone: ColumnReference | undefined;
    let structuralCombined: ColumnReference | undefined;
    let structuralLength: ColumnReference | undefined;
    for (const [index, step] of structuralSteps.entries()) {
      recordAcceptanceProgress(`verify:notebook:pandas-structural:${step.kind}:preview`);
      const structuralPreview = await testing.request({
        kind: "previewStep",
        ...GRID_COLUMN_WINDOW,
        sessionId: structuralSessionId,
        revision: structuralRevision,
        step,
        offset: 0,
        limit: 10
      });
      assert.equal(structuralPreview.kind, "stepPreview", `Packaged ${step.kind} must preview structural labels.`);
      if (structuralPreview.kind !== "stepPreview") {
        throw new Error(`Packaged ${step.kind} structural preview did not resolve.`);
      }
      assert.match(
        structuralPreview.code,
        structuralCodeMarkers[index],
        `${step.kind} generated code must use the exact position after the preceding lineage changes.`
      );
      assert.doesNotMatch(
        structuralPreview.code,
        /df\[['"]duplicate['"]\]/u,
        `${step.kind} generated code must not fall back to an ambiguous duplicate label.`
      );
      assert.doesNotMatch(
        JSON.stringify(structuralPreview.metadata.draftStep),
        /"position"\s*:/u,
        "Private structural bindings must not leak into the public draft."
      );
      assert.deepEqual(
        structuralPreview.metadata.draftStep,
        step,
        "Structural previews must preserve the submitted public stable references verbatim."
      );

      if (step.kind === "selectColumns") {
        assert.deepEqual(
          structuralPreview.metadata.schema.map(({ id, name, position }) => ({ id, name, position })),
          [
            { ...structuralSecondDuplicate, position: 0 },
            { ...structuralIntegerLabel, position: 1 },
            { ...structuralFirstDuplicate, position: 2 },
            { ...structuralSecondCategory, position: 3 },
            { ...structuralFirstCategory, position: 4 },
            { ...structuralSecondDatetime, position: 5 },
            { ...structuralFirstDatetime, position: 6 }
          ],
          "Select Columns must reorder duplicate and non-string identities before later operations bind them."
        );
        assert.deepEqual(gridColumnCells(structuralPreview.page, structuralSecondDuplicate.id), secondDuplicateCells);
        assert.deepEqual(gridColumnCells(structuralPreview.page, structuralIntegerLabel.id), integerLabelCells);
      } else if (step.kind === "cloneColumn") {
        const clone = columnReference(structuralPreview.metadata, "second_copy");
        assert.equal(clone.id, `c:step:${step.id}:0`);
        assert.deepEqual(gridColumnCells(structuralPreview.page, clone.id), secondDuplicateCells);
        assert.equal(structuralPreview.metadata.schema.at(-1)?.id, clone.id);
      } else if (step.kind === "castColumn") {
        assert.deepEqual(gridColumnCells(structuralPreview.page, structuralFirstDuplicate.id), castDuplicateCells);
        assert.deepEqual(
          gridColumnCells(structuralPreview.page, structuralSecondDuplicate.id),
          secondDuplicateCells,
          "Casting the first duplicate must not change its same-named neighbor."
        );
      } else if (step.kind === "formula") {
        const combined = columnReference(structuralPreview.metadata, "combined");
        assert.equal(combined.id, `c:step:${step.id}:0`);
        assert.deepEqual(gridColumnCells(structuralPreview.page, combined.id), combinedCells);
        assert.equal(structuralPreview.metadata.schema.at(-1)?.id, combined.id);
      } else if (step.kind === "textLength") {
        const length = columnReference(structuralPreview.metadata, "label_length");
        assert.equal(length.id, `c:step:${step.id}:0`);
        assert.deepEqual(gridColumnCells(structuralPreview.page, length.id), lengthCells);
        assert.equal(structuralPreview.metadata.schema.at(-1)?.id, length.id);
      } else if (step.kind === "dropColumns") {
        assert.equal(
          structuralPreview.metadata.schema.some((column) => column.id === structuralSecondDuplicate.id),
          false,
          "Drop Columns must remove only the exact reordered second duplicate identity."
        );
        assert.ok(
          structuralPreview.metadata.schema.some((column) => column.id === structuralFirstDuplicate.id),
          "Drop Columns must retain the same-named first duplicate."
        );
      } else if (step.kind === "renameColumn") {
        const renamed = structuralPreview.metadata.schema.find((column) => column.id === structuralFirstDuplicate.id);
        assert.ok(renamed, "Rename Column must preserve the surviving duplicate identity.");
        assert.equal(renamed.name, structuralRenamedFirst.name);
        assert.equal(renamed.position, 1, "Rename Column must bind after select and drop shifted the input twice.");
      }

      recordAcceptanceProgress(`verify:notebook:pandas-structural:${step.kind}:apply`);
      const structuralApplied = await testing.request({
        kind: "applyDraft",
        ...GRID_COLUMN_WINDOW,
        sessionId: structuralSessionId,
        revision: structuralPreview.revision,
        offset: 0,
        limit: 10
      });
      assert.equal(structuralApplied.kind, "planUpdated", `Packaged ${step.kind} must apply structural labels.`);
      if (structuralApplied.kind !== "planUpdated") {
        throw new Error(`Packaged ${step.kind} structural apply did not resolve.`);
      }
      assert.equal(structuralApplied.metadata.steps.length, index + 1);
      assert.deepEqual(
        structuralApplied.metadata.steps,
        structuralSteps.slice(0, index + 1),
        "Applied structural plans must preserve every submitted public stable reference verbatim."
      );
      assert.deepEqual(
        structuralApplied.metadata.schema,
        structuralPreview.metadata.schema,
        "Applying a structural preview must publish the exact previewed schema atomically."
      );
      assert.deepEqual(
        structuralApplied.page,
        structuralPreview.page,
        "Applying a structural preview must publish the exact previewed typed page atomically."
      );
      assert.doesNotMatch(
        JSON.stringify(structuralApplied.metadata.steps),
        /"position"\s*:/u,
        "Applied structural steps must remain position-free at the public boundary."
      );
      structuralRevision = structuralApplied.revision;
      structuralMetadata = structuralApplied.metadata;
      structuralPage = structuralApplied.page;
      if (step.kind === "cloneColumn") {
        structuralClone = columnReference(structuralApplied.metadata, "second_copy");
      } else if (step.kind === "formula") {
        structuralCombined = columnReference(structuralApplied.metadata, "combined");
      } else if (step.kind === "textLength") {
        structuralLength = columnReference(structuralApplied.metadata, "label_length");
      }
    }

    assert.ok(structuralPage, "The structural plan must publish its final typed page.");
    assert.ok(structuralClone, "Clone Column must publish deterministic output lineage.");
    assert.ok(structuralCombined, "Formula must publish deterministic output lineage.");
    assert.ok(structuralLength, "Text Length must publish deterministic output lineage.");
    assert.deepEqual(
      structuralMetadata.schema.map(({ id, name, position }) => ({ id, name, position })),
      [
        { ...structuralIntegerLabel, position: 0 },
        { ...structuralRenamedFirst, position: 1 },
        { ...structuralSecondCategory, position: 2 },
        { ...structuralFirstCategory, position: 3 },
        { ...structuralSecondDatetime, position: 4 },
        { ...structuralFirstDatetime, position: 5 },
        { ...structuralClone, position: 6 },
        { ...structuralCombined, position: 7 },
        { ...structuralLength, position: 8 }
      ]
    );
    assert.deepEqual(gridColumnCells(structuralPage, structuralLength.id), lengthCells);
    assert.deepEqual(gridColumnCells(structuralPage, structuralIntegerLabel.id), integerLabelCells);
    assert.deepEqual(gridColumnCells(structuralPage, structuralRenamedFirst.id), castDuplicateCells);
    assert.deepEqual(gridColumnCells(structuralPage, structuralCombined.id), combinedCells);
    assert.deepEqual(gridColumnCells(structuralPage, structuralClone.id), secondDuplicateCells);
    const structuralSourceBeforeRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(structural_frame.equals(structural_frame_source))"
    );
    assert.match(
      structuralSourceBeforeRestart,
      /\bTrue\b/u,
      "Structural operations must not mutate the originating duplicate-column dataframe."
    );

    recordAcceptanceProgress("verify:notebook:pandas-structural:replay");
    const structuralGeneration = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const structuralReplacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(structuralReplacementGeneration > structuralGeneration);
    const structuralReplayed = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-structural-duplicate-replay",
      sessionId: structuralSessionId,
      revision: structuralRevision,
      offset: 0,
      limit: 10,
      filterModel: structuralMetadata.filterModel
    });
    assert.equal(structuralReplayed.kind, "page", "Structural duplicate/non-string operations must replay.");
    if (structuralReplayed.kind !== "page") {
      throw new Error("Structural duplicate/non-string replay failed.");
    }
    assert.equal(jupyter.testing.stats(notebook.uri)?.generation, structuralReplacementGeneration);
    assert.equal(structuralReplayed.metadata.steps.length, structuralSteps.length);
    assert.deepEqual(
      structuralReplayed.metadata.steps,
      structuralSteps,
      "Kernel replay must preserve the exact public structural plan."
    );
    assert.deepEqual(
      structuralReplayed.metadata.schema.map(({ id, name, position }) => ({ id, name, position })),
      [
        { ...structuralIntegerLabel, position: 0 },
        { ...structuralRenamedFirst, position: 1 },
        { ...structuralSecondCategory, position: 2 },
        { ...structuralFirstCategory, position: 3 },
        { ...structuralSecondDatetime, position: 4 },
        { ...structuralFirstDatetime, position: 5 },
        { ...structuralClone, position: 6 },
        { ...structuralCombined, position: 7 },
        { ...structuralLength, position: 8 }
      ]
    );
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralLength.id), lengthCells);
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralIntegerLabel.id), integerLabelCells);
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralRenamedFirst.id), castDuplicateCells);
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralCombined.id), combinedCells);
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralClone.id), secondDuplicateCells);
    assert.doesNotMatch(
      JSON.stringify(structuralReplayed.metadata.steps),
      /"position"\s*:/u,
      "Kernel replay must retain position-free public structural references."
    );
    const structuralSourceAfterRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(structural_frame.equals(structural_frame_source))"
    );
    assert.match(
      structuralSourceAfterRestart,
      /\bTrue\b/u,
      "Structural replay must leave the recreated notebook dataframe immutable."
    );
    recordAcceptanceProgress("verify:notebook:pandas-structural:close");
    await disposePackagedSessionPanel(
      testing,
      structuralSessionId,
      "the structural duplicate-column Pandas notebook session"
    );
    await waitFor(
      () => testing.diagnostics().sessionCount === 0,
      10_000,
      "the structural duplicate-column Pandas notebook session to close"
    );
    assert.deepEqual(testing.diagnostics().sessions, [], "Structural acceptance must retain no session.");

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "identity_frame",
      fileName: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "identity_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged group-by/by-example duplicate-column Pandas notebook session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    if (!active) throw new Error("Group-by/by-example duplicate-column Pandas session did not become active.");
    const identitySessionId = active.sessionId;
    const identityFirstDuplicate = columnReferenceAt(active.metadata, 0);
    const identitySecondDuplicate = columnReferenceAt(active.metadata, 1);
    const identityIntegerLabel = columnReferenceAt(active.metadata, 2);
    assert.notEqual(
      identityFirstDuplicate.id,
      identitySecondDuplicate.id,
      "Group-by/by-example acceptance requires independently addressable duplicate labels."
    );
    assert.equal(identityIntegerLabel.name, "7");

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:by-example-preview");
    const identityExamplePreview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: active.metadata.revision,
      step: {
        id: "duplicate-by-example-stable-references",
        kind: "byExample",
        params: {
          sourceColumns: [identityIntegerLabel],
          newColumn: "upper_integer_label",
          examples: [
            { inputs: ["alpha"], output: "ALPHA" },
            { inputs: ["bravo"], output: "BRAVO" }
          ]
        }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(
      identityExamplePreview.kind,
      "stepPreview",
      `Stable-reference by-example must preview: ${JSON.stringify(identityExamplePreview)}`
    );
    if (identityExamplePreview.kind !== "stepPreview") {
      throw new Error(`Stable-reference by-example preview did not resolve: ${JSON.stringify(identityExamplePreview)}`);
    }
    assert.match(
      identityExamplePreview.code,
      /_open_wrangler_nullable_string_copy\(df\.iloc\[:, 2\]\)\.astype\('string'\)/u,
      "By-example generated code must address the non-string-labelled source by position."
    );
    assert.deepEqual(
      gridColumnDisplays(
        identityExamplePreview.page,
        columnReference(identityExamplePreview.metadata, "upper_integer_label").id
      ),
      ["ALPHA", "BRAVO", "CHARLIE", "DELTA"]
    );
    assert.equal(identityExamplePreview.metadata.draftStep?.kind, "byExample");
    if (identityExamplePreview.metadata.draftStep?.kind === "byExample") {
      assert.deepEqual(identityExamplePreview.metadata.draftStep.params.sourceColumns, [identityIntegerLabel]);
      assert.equal(identityExamplePreview.metadata.draftStep.params.program?.kind, "case");
      assert.match(
        JSON.stringify(identityExamplePreview.metadata.draftStep.params.program),
        new RegExp(identityIntegerLabel.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")
      );
    }
    assert.doesNotMatch(
      JSON.stringify(identityExamplePreview.metadata.draftStep),
      /"position"\s*:/u,
      "Private by-example positions must not leak into public draft metadata."
    );

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:by-example-apply");
    const identityExampleApplied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: identityExamplePreview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(identityExampleApplied.kind, "planUpdated", "Stable-reference by-example must apply.");
    if (identityExampleApplied.kind !== "planUpdated") {
      throw new Error("Stable-reference by-example apply did not resolve.");
    }

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:group-preview");
    const identityGroupPreview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: identityExampleApplied.revision,
      step: {
        id: "duplicate-group-stable-references",
        kind: "groupBy",
        params: {
          keys: [identityIntegerLabel],
          aggregations: [{ column: identitySecondDuplicate, operation: "sum", alias: "second_duplicate_total" }]
        }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(
      identityGroupPreview.kind,
      "stepPreview",
      `Stable-reference group-by must preview: ${JSON.stringify(identityGroupPreview)}`
    );
    if (identityGroupPreview.kind !== "stepPreview") {
      throw new Error(`Stable-reference group-by preview did not resolve: ${JSON.stringify(identityGroupPreview)}`);
    }
    assert.match(
      identityGroupPreview.code,
      /_group_labels_1 = \[df\.columns\[position\] for position in \[2\]\]/u,
      "Group-by generated code must bind the non-string-labelled key by position."
    );
    assert.match(
      identityGroupPreview.code,
      /pd\.concat\(\[df\.iloc\[:, position\] for position in \[2, 1\]\], axis=1\)/u,
      "Group-by generated code must bind the exact second duplicate aggregation by position."
    );
    assert.doesNotMatch(
      identityGroupPreview.code,
      /df\[['"]duplicate['"]\]/u,
      "Group-by generated code must not fall back to an ambiguous duplicate label."
    );
    assert.equal(identityGroupPreview.metadata.draftStep?.kind, "groupBy");
    if (identityGroupPreview.metadata.draftStep?.kind === "groupBy") {
      assert.deepEqual(identityGroupPreview.metadata.draftStep.params.keys, [identityIntegerLabel]);
      assert.deepEqual(identityGroupPreview.metadata.draftStep.params.aggregations, [
        { column: identitySecondDuplicate, operation: "sum", alias: "second_duplicate_total" }
      ]);
    }
    assert.doesNotMatch(
      JSON.stringify(identityGroupPreview.metadata.draftStep),
      /"position"\s*:/u,
      "Private group-by positions must not leak into public draft metadata."
    );

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:group-apply");
    const identityGroupApplied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: identityGroupPreview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(identityGroupApplied.kind, "planUpdated", "Stable-reference group-by must apply.");
    if (identityGroupApplied.kind !== "planUpdated") {
      throw new Error("Stable-reference group-by apply did not resolve.");
    }
    assert.equal(identityGroupApplied.metadata.steps.length, 2);
    assert.doesNotMatch(
      JSON.stringify(identityGroupApplied.metadata.steps),
      /"position"\s*:/u,
      "Private group-by/by-example positions must not leak into persisted public steps."
    );
    const identitySourceBeforeRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(identity_frame.equals(identity_frame_source))"
    );
    assert.match(
      identitySourceBeforeRestart,
      /\bTrue\b/u,
      "Group-by/by-example steps must not mutate the notebook source before recovery."
    );

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:replay");
    const identityGeneration = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const identityReplacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(identityReplacementGeneration > identityGeneration);
    const identityReplayed = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-group-by-example-stable-reference-replay",
      sessionId: identitySessionId,
      revision: identityGroupApplied.revision,
      offset: 0,
      limit: 10,
      filterModel: identityGroupApplied.metadata.filterModel
    });
    assert.equal(identityReplayed.kind, "page", "Stable-reference group-by/by-example plan must replay.");
    if (identityReplayed.kind !== "page") {
      throw new Error("Stable-reference group-by/by-example replay failed.");
    }
    assert.equal(jupyter.testing.stats(notebook.uri)?.generation, identityReplacementGeneration);
    assert.equal(identityReplayed.page.totalRows, 4);
    assert.equal(identityReplayed.metadata.steps.length, 2);
    assert.deepEqual(gridColumnDisplays(identityReplayed.page, columnReference(identityReplayed.metadata, "7").id), [
      "alpha",
      "bravo",
      "charlie",
      "delta"
    ]);
    assert.deepEqual(
      gridColumnDisplays(
        identityReplayed.page,
        columnReference(identityReplayed.metadata, "second_duplicate_total").id
      ).slice(0, 3),
      ["10.26", "20.74", "10.26"]
    );
    assert.doesNotMatch(
      JSON.stringify(identityReplayed.metadata.steps),
      /"position"\s*:/u,
      "Kernel replay must retain position-free public group-by/by-example references."
    );
    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:close");
    await disposePackagedSessionPanel(
      testing,
      identitySessionId,
      "the stable-reference group-by/by-example notebook session"
    );
    await waitFor(
      () => testing.diagnostics().sessionCount === 0,
      10_000,
      "the stable-reference group-by/by-example notebook session to close"
    );
    assert.deepEqual(
      testing.diagnostics().sessions,
      [],
      "Stable-reference group-by/by-example acceptance must retain no session."
    );
    const identitySourceAfterReplay = await jupyter.testing.execute(
      notebook.uri,
      "print(identity_frame.equals(identity_frame_source))"
    );
    assert.match(
      identitySourceAfterReplay,
      /\bTrue\b/u,
      "Recovered group-by/by-example steps must leave the notebook source immutable."
    );

    recordAcceptanceProgress("verify:notebook:polars:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "polars_frame",
      fileName: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "polars_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged Polars notebook variable session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "polars");
    if (!active) throw new Error("Polars notebook session did not become active.");
    recordAcceptanceProgress("verify:notebook:polars:replay");
    const generation = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const replacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(replacementGeneration > generation);
    const recovered = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-polars-recovery-page",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(recovered.kind, "page", "The Polars notebook session must replay after kernel replacement.");
    if (recovered.kind !== "page") throw new Error("Polars notebook recovery did not return a page.");
    assert.equal(recovered.page.rows[0]?.values[0]?.display, "3");
    recordAcceptanceProgress("verify:notebook:polars:close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the Polars notebook session");
    await waitFor(() => testing.diagnostics().sessionCount === 0, 10_000, "the Polars notebook session to close");

    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      await configuration.update("notebookPreviewProvider", "disabled", vscode.ConfigurationTarget.Workspace);
      previewProviderOverridden = true;
      recordAcceptanceProgress("verify:notebook-renderer-provenance");
      await exercisePackagedRendererProvenance(testing, jupyter, notebook, currentPayload, directory);
      recordAcceptanceProgress("verify:notebook-renderer-same-group-switch");
      await exercisePackagedSameGroupRendererSwitch(jupyter, notebook, currentPayload, directory);
    }

    recordAcceptanceProgress("verify:notebook:permission-denial");
    const denialCalls = jupyter.testing.denialCalls();
    jupyter.testing.setDenied(true);
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "pandas_frame",
      fileName: notebook.uri
    });
    await waitFor(() => jupyter.testing.denialCalls() > denialCalls, 10_000, "the packaged Jupyter permission denial");
    assert.equal(testing.diagnostics().sessionCount, 0);
    jupyter.testing.setDenied(false);
    const deniedPanelTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.label === "Open Wrangler: pandas_frame");
    if (deniedPanelTabs.length > 0) assert.equal(await vscode.window.tabGroups.close(deniedPanelTabs, true), true);
    assert.equal(await notebook.save(), true);
    const originTab = notebookTab(notebook.uri);
    assert.ok(originTab, "The originating notebook tab must still be open after the permission-denial scenario.");
    assert.equal(await vscode.window.tabGroups.close(originTab, true), true);
    await waitFor(
      () =>
        !notebookTab(notebook.uri) &&
        !vscode.window.visibleNotebookEditors.some(
          (editor) => editor.notebook.uri.toString() === notebook.uri.toString()
        ),
      10_000,
      "the originating notebook renderer to dispose before the isolated saved-output scenario"
    );

    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      recordAcceptanceProgress("verify:notebook-renderer-linked-live");
      await exercisePackagedLinkedRendererLiveOpen(testing, jupyter, directory);
    }
    recordAcceptanceProgress("verify:notebook:complete");
  } finally {
    try {
      if (previewProviderOverridden) {
        await configuration.update(
          "notebookPreviewProvider",
          originalWorkspacePreviewProvider,
          vscode.ConfigurationTarget.Workspace
        );
      }
    } finally {
      try {
        await configuration.update("notebookStartMode", originalMode, vscode.ConfigurationTarget.Workspace);
      } finally {
        cleanupAcceptanceTemporaryDirectory(directory);
      }
    }
  }
}

interface NotebookRendererLoadSnapshot {
  readonly rendererResponses: readonly number[];
  readonly rendererRequestFailures: readonly string[];
  readonly pageErrors: readonly string[];
  readonly consoleErrors: readonly string[];
}

interface NotebookRendererLoadObserver {
  snapshot(): NotebookRendererLoadSnapshot;
  dispose(): void;
}

interface NotebookRendererButton {
  readonly page: Page;
  readonly frame: Frame;
  scrollIntoViewIfNeeded(options?: { readonly timeout?: number }): Promise<void>;
  click(options?: { readonly force?: boolean; readonly timeout?: number }): Promise<void>;
  boundingBox(): Promise<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null>;
  evaluate<Result>(pageFunction: (element: unknown) => Result | Promise<Result>): Promise<Result>;
  dispose(): Promise<void>;
}

async function activateNotebookRendererButtonOnce(
  workbench: Page,
  button: NotebookRendererButton,
  immediatelyBeforeClick?: () => void
): Promise<void> {
  const deadline = Date.now() + WORKBENCH_PLAYWRIGHT_TIMEOUT_MS;
  await withAcceptanceOperationDeadline(
    workbench.bringToFront(),
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
    "the private editor workbench to come to front"
  );
  const remainingMs = deadline - Date.now();
  if (remainingMs < 1) {
    throw new Error(`Timed out waiting for the notebook renderer action after ${WORKBENCH_PLAYWRIGHT_TIMEOUT_MS} ms.`);
  }
  await activateExactAcceptanceElementOnce(button, remainingMs, immediatelyBeforeClick);
}

function observeNotebookRendererLoad(workbench: Page): NotebookRendererLoadObserver {
  const rendererResponses: number[] = [];
  const rendererRequestFailures: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const append = (target: string[], value: string): void => {
    if (target.length >= 8) return;
    const normalized = value.replaceAll(/\s+/gu, " ").trim();
    target.push(normalized.slice(0, 512));
  };
  const isRendererRequest = (url: string): boolean => url.includes("notebookRenderer.js");
  const onResponse = (response: Response): void => {
    if (isRendererRequest(response.url()) && rendererResponses.length < 8) {
      rendererResponses.push(response.status());
    }
  };
  const onRequestFailed = (request: Request): void => {
    if (isRendererRequest(request.url())) {
      append(rendererRequestFailures, request.failure()?.errorText ?? "unknown request failure");
    }
  };
  const onPageError = (error: Error): void => {
    append(pageErrors, `${error.name}: ${error.message}`);
  };
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!/(?:module|notebook|renderer|open\s*wrangler|openwrangler)/iu.test(text)) return;
    append(consoleErrors, text);
  };

  workbench.on("response", onResponse);
  workbench.on("requestfailed", onRequestFailed);
  workbench.on("pageerror", onPageError);
  workbench.on("console", onConsole);
  return {
    snapshot: () => ({
      rendererResponses: [...rendererResponses],
      rendererRequestFailures: [...rendererRequestFailures],
      pageErrors: [...pageErrors],
      consoleErrors: [...consoleErrors]
    }),
    dispose: () => {
      workbench.off("response", onResponse);
      workbench.off("requestfailed", onRequestFailed);
      workbench.off("pageerror", onPageError);
      workbench.off("console", onConsole);
    }
  };
}

async function waitForNotebookRendererButton(
  workbench: Page,
  label: string,
  buttonName = "Open in Open Wrangler"
): Promise<NotebookRendererButton> {
  const deadline = Date.now() + NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS;
  discovery: do {
    const browser = workbench.context().browser();
    assertNotebookRendererLifecycle(workbench, browser);
    const targets = openWranglerWebviewTargets(workbench, browser, NOTEBOOK_RENDERER_TARGET_LIMIT);
    const nestedButtons: NotebookRendererButton[] = [];
    let returnedNestedButton: NotebookRendererButton | undefined;
    try {
      for (const target of targets) {
        if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
        try {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break discovery;
          const probeTimeoutMs = Math.min(NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS, remainingMs);
          const nested = await resolveNestedNotebookRendererButtonWithDeadline(
            target.frame,
            label,
            buttonName,
            probeTimeoutMs
          );
          if (nested) nestedButtons.push(nested);
        } catch (error) {
          const discoveryExpired = Date.now() >= deadline;
          if (!(discoveryExpired && isNestedNotebookRendererProbeDeadline(error))) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
          }
          if (discoveryExpired) break discovery;
        }
      }
      if (nestedButtons.length === 1) {
        const candidate = nestedButtons[0]!;
        const remainingMs = deadline - Date.now();
        if (remainingMs > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(NOTEBOOK_RENDERER_ACTION_STABLE_MS, remainingMs))
          );
          try {
            const [ready, box] = await Promise.all([
              candidate.evaluate((element) => {
                type RendererActionElement = {
                  readonly isConnected: boolean;
                  readonly disabled?: boolean;
                  getAttribute(name: string): string | null;
                };
                const action = element as RendererActionElement;
                return (
                  action.isConnected && action.disabled !== true && action.getAttribute("aria-disabled") !== "true"
                );
              }),
              candidate.boundingBox()
            ]);
            if (ready && box && box.width > 0 && box.height > 0) {
              returnedNestedButton = candidate;
              return returnedNestedButton;
            }
          } catch (error) {
            ignoreRetiredRendererProbeFailure(
              workbench,
              workbench.context().browser(),
              candidate.page,
              candidate.frame,
              error
            );
          }
        }
      }
    } finally {
      await Promise.allSettled(
        nestedButtons.filter((button) => button !== returnedNestedButton).map((button) => button.dispose())
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  assertNotebookRendererLifecycle(workbench, browser);
  const diagnostics = await notebookRendererDiagnostics(workbench, browser, label, buttonName);
  assertNotebookRendererLifecycle(workbench, browser);
  throw new Error(`Timed out waiting for the exact notebook renderer action: ${JSON.stringify(diagnostics)}`);
}

async function waitForNotebookRendererPreviewOnly(workbench: Page, label: string): Promise<void> {
  const removedHint = "Run this cell again to open the current dataframe in Open Wrangler.";
  const deadline = Date.now() + NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS;
  do {
    const browser = workbench.context().browser();
    assertNotebookRendererLifecycle(workbench, browser);
    for (const target of openWranglerWebviewTargets(workbench, browser, NOTEBOOK_RENDERER_TARGET_LIMIT)) {
      if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
      try {
        const preview = target.frame.locator("section.openwrangler-notebook").filter({
          hasText: `Open Wrangler preview: ${label}`
        });
        if ((await preview.count()) === 1) {
          const action = preview.getByRole("button", { name: "Open in Open Wrangler", exact: true });
          const previewText = await preview.textContent();
          if ((await action.count()) === 0 && !previewText?.includes(removedHint)) return;
        }

        const nestedMatches = await target.frame.evaluate(
          ({ expectedLabel, forbiddenNote }) => {
            type NestedDocument = NestedElement & { readonly readyState: string };
            type NestedElement = {
              readonly contentDocument?: NestedDocument | null;
              readonly isConnected: boolean;
              readonly textContent: string | null;
              querySelector(selector: string): NestedElement | null;
              querySelectorAll(selector: string): ArrayLike<NestedElement>;
            };
            const outerDocument = (globalThis as unknown as { readonly document: NestedDocument }).document;
            const innerDocument = outerDocument.querySelector("iframe#active-frame")?.contentDocument;
            if (!innerDocument || innerDocument.readyState === "loading") return false;
            const titlePrefix = `Open Wrangler preview: ${expectedLabel} (`;
            const previews = Array.from(innerDocument.querySelectorAll("section.openwrangler-notebook")).filter(
              (section) => (section.querySelector("header > span")?.textContent ?? "").startsWith(titlePrefix)
            );
            if (previews.length !== 1) return false;
            const preview = previews[0]!;
            const openActions = Array.from(preview.querySelectorAll("button")).filter(
              (button) => button.isConnected && (button.textContent ?? "").trim() === "Open in Open Wrangler"
            );
            return openActions.length === 0 && !(preview.textContent ?? "").includes(forbiddenNote);
          },
          { expectedLabel: label, forbiddenNote: removedHint }
        );
        if (nestedMatches) return;
      } catch (error) {
        ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
      }
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  assertNotebookRendererLifecycle(workbench, browser);
  const diagnostics = await notebookRendererDiagnostics(workbench, browser, label, "Open in Open Wrangler");
  throw new Error(`Timed out waiting for the exact preview-only notebook output: ${JSON.stringify(diagnostics)}`);
}

async function resolveNestedNotebookRendererButtonWithDeadline(
  frame: Frame,
  label: string,
  buttonName: string,
  timeoutMs: number
): Promise<NotebookRendererButton | undefined> {
  const pending = resolveNestedNotebookRendererButton(frame, label, buttonName);
  try {
    return await withAcceptanceOperationDeadline(
      pending,
      timeoutMs,
      "the nested notebook renderer action readiness probe"
    );
  } catch (error) {
    void pending.then((button) => button?.dispose()).catch(() => undefined);
    throw error;
  }
}

async function resolveNestedNotebookRendererButton(
  frame: Frame,
  label: string,
  buttonName: string
): Promise<NotebookRendererButton | undefined> {
  const raw = await frame.evaluateHandle(findExactActiveNotebookRendererButton, {
    expectedLabel: label,
    expectedButtonName: buttonName
  });
  const element = raw.asElement() as ElementHandle<unknown> | null;
  if (!element) {
    await raw.dispose();
    return undefined;
  }
  try {
    const [visible, enabled, box] = await Promise.all([
      element.isVisible(),
      element.isEnabled(),
      element.boundingBox()
    ]);
    if (!visible || !enabled || !box || box.width <= 0 || box.height <= 0) {
      await element.dispose();
      return undefined;
    }
  } catch (error) {
    await element.dispose().catch(() => undefined);
    throw error;
  }
  return {
    page: frame.page(),
    frame,
    scrollIntoViewIfNeeded: (options) => element.scrollIntoViewIfNeeded(options),
    click: (options) => element.click(options),
    boundingBox: () => element.boundingBox(),
    evaluate: <Result>(pageFunction: (candidate: unknown) => Result | Promise<Result>) =>
      element.evaluate(pageFunction),
    dispose: () => element.dispose()
  };
}

function isNestedNotebookRendererProbeDeadline(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Timed out waiting for the nested notebook renderer action readiness probe after ")
  );
}

function assertNotebookRendererLifecycle(workbench: Page, browser: Browser | null): void {
  if (workbench.isClosed()) throw new Error("The editor workbench closed during notebook renderer discovery.");
  if (browser !== null && !browser.isConnected()) {
    throw new Error("The editor CDP browser disconnected during notebook renderer discovery.");
  }
}

async function notebookRendererDiagnostics(
  workbench: Page,
  browser: Browser | null,
  label: string,
  buttonName: string
): Promise<unknown> {
  const targets = openWranglerWebviewTargets(workbench, browser, NOTEBOOK_RENDERER_DIAGNOSTIC_TARGET_LIMIT);
  try {
    const diagnostics = await withAcceptanceOperationDeadline(
      Promise.all(
        targets.map(async (target) => {
          if (isRetiredRendererTarget(workbench, target.page, target.frame)) {
            return rendererTargetDiagnostic(target, { retired: true });
          }
          try {
            const preview = target.frame.locator("section.openwrangler-notebook").filter({
              hasText: `Open Wrangler preview: ${label}`
            });
            const button = preview.getByRole("button", { name: buttonName, exact: true });
            const [
              previewCount,
              buttonCount,
              readyState,
              bodyChildren,
              bodyDescendants,
              alerts,
              tables,
              preformatted,
              moduleScripts,
              selectedOutputMimes,
              notebookBacklayerContainers,
              notebookBacklayerCells,
              notebookBacklayerOutputs,
              notebookBacklayerRenderedOutputs,
              notebookBacklayerRendererErrors,
              selectedOutputGeometry
            ] = await Promise.all([
              preview.count(),
              button.count(),
              target.frame.locator(":root").evaluate((root) => root.ownerDocument.readyState),
              target.frame.locator("body > *").count(),
              target.frame.locator("body *").count(),
              target.frame.locator('[role="alert"]').count(),
              target.frame.locator("table").count(),
              target.frame.locator("pre").count(),
              target.frame.locator('script[type="module"]').count(),
              target.frame.locator(".output-inner-container[output-mime-type]").evaluateAll((elements) =>
                elements
                  .slice(0, 16)
                  .map((element) => element.getAttribute("output-mime-type"))
                  .filter((mime): mime is string => typeof mime === "string")
              ),
              target.frame.locator("#container").count(),
              target.frame.locator(".cell_container").count(),
              target.frame.locator(".output_container").count(),
              target.frame.locator(".output").count(),
              target.frame.locator(".no-renderer-error").count(),
              target.frame.locator(".output-inner-container[output-mime-type]").evaluateAll((elements) =>
                elements.slice(0, 16).map((element) => {
                  const rect = element.getBoundingClientRect();
                  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
                  const mime = element.getAttribute("output-mime-type") ?? "missing";
                  return [
                    mime,
                    Math.round(rect.width),
                    Math.round(rect.height),
                    Math.round(rect.left),
                    Math.round(rect.top),
                    style?.display ?? "unknown",
                    style?.visibility ?? "unknown",
                    element.isConnected ? "connected" : "detached"
                  ].join(":");
                })
              )
            ]);
            const [firstButtonVisible, firstButtonEnabled] =
              buttonCount > 0
                ? await Promise.all([
                    button.first().isVisible(),
                    button.first().isEnabled({ timeout: WORKBENCH_DIAGNOSTIC_TIMEOUT_MS })
                  ])
                : [false, false];
            const nestedGuest = await nestedNotebookRendererDiagnostics(target.frame, label, buttonName);
            return rendererTargetDiagnostic(target, {
              retired: false,
              previewCount,
              buttonCount,
              readyState:
                readyState === "loading" || readyState === "interactive" || readyState === "complete"
                  ? readyState
                  : "unavailable",
              bodyChildren,
              bodyDescendants,
              alerts,
              tables,
              preformatted,
              moduleScripts,
              selectedOutputMimes: selectedOutputMimes.join(","),
              notebookBacklayerContainers,
              notebookBacklayerCells,
              notebookBacklayerOutputs,
              notebookBacklayerRenderedOutputs,
              notebookBacklayerRendererErrors,
              selectedOutputGeometry: selectedOutputGeometry.join(","),
              firstButtonVisible,
              firstButtonEnabled,
              ...nestedGuest
            });
          } catch (error) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
            return rendererTargetDiagnostic(target, { retired: true });
          }
        })
      ),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "bounded notebook renderer diagnostics"
    );
    assertNotebookRendererLifecycle(workbench, browser);
    return diagnostics;
  } catch (error) {
    assertNotebookRendererLifecycle(workbench, browser);
    if (error instanceof Error && error.message.startsWith("Timed out waiting for bounded notebook renderer")) {
      return "unavailable within the diagnostics deadline";
    }
    throw error;
  }
}

async function nestedNotebookRendererDiagnostics(
  frame: Frame,
  label: string,
  buttonName: string
): Promise<Record<string, boolean | number | string>> {
  return frame.evaluate(
    ({ expectedLabel, expectedButtonName }) => {
      type Rect = { readonly width: number; readonly height: number };
      type NestedDocument = NestedElement & { readonly readyState: string };
      type NestedElement = {
        readonly contentDocument?: NestedDocument | null;
        readonly isConnected: boolean;
        readonly textContent: string | null;
        getBoundingClientRect(): Rect;
        querySelector(selector: string): NestedElement | null;
        querySelectorAll(selector: string): ArrayLike<NestedElement>;
      };
      const outerDocument = (globalThis as unknown as { readonly document: NestedDocument }).document;
      const activeFrames = Array.from(outerDocument.querySelectorAll("iframe#active-frame"));
      const pendingFrames = Array.from(outerDocument.querySelectorAll("iframe#pending-frame"));
      const innerDocument = activeFrames.length === 1 ? activeFrames[0]?.contentDocument : undefined;
      const empty = {
        nestedActiveFrames: activeFrames.length,
        nestedPendingFrames: pendingFrames.length,
        nestedGuestAccessible: false,
        nestedGuestReadyState: "unavailable",
        nestedContainers: 0,
        nestedCells: 0,
        nestedOutputs: 0,
        nestedRenderedOutputs: 0,
        nestedRendererErrors: 0,
        nestedPreviewCount: 0,
        nestedButtonCount: 0,
        nestedPreviewWidth: 0,
        nestedPreviewHeight: 0,
        nestedButtonWidth: 0,
        nestedButtonHeight: 0
      };
      if (!innerDocument) return empty;

      const titlePrefix = `Open Wrangler preview: ${expectedLabel} (`;
      const previews = Array.from(innerDocument.querySelectorAll("section.openwrangler-notebook")).filter((section) =>
        (section.querySelector("header > span")?.textContent ?? "").startsWith(titlePrefix)
      );
      const buttons = previews.flatMap((section) =>
        Array.from(section.querySelectorAll("button")).filter(
          (button) => button.isConnected && (button.textContent ?? "").trim() === expectedButtonName
        )
      );
      const previewRect = previews.length === 1 ? previews[0]!.getBoundingClientRect() : undefined;
      const buttonRect = buttons.length === 1 ? buttons[0]!.getBoundingClientRect() : undefined;
      return {
        nestedActiveFrames: activeFrames.length,
        nestedPendingFrames: pendingFrames.length,
        nestedGuestAccessible: true,
        nestedGuestReadyState:
          innerDocument.readyState === "loading" ||
          innerDocument.readyState === "interactive" ||
          innerDocument.readyState === "complete"
            ? innerDocument.readyState
            : "unavailable",
        nestedContainers: innerDocument.querySelectorAll("#container").length,
        nestedCells: innerDocument.querySelectorAll(".cell_container").length,
        nestedOutputs: innerDocument.querySelectorAll(".output_container").length,
        nestedRenderedOutputs: innerDocument.querySelectorAll(".output").length,
        nestedRendererErrors: innerDocument.querySelectorAll(".no-renderer-error").length,
        nestedPreviewCount: previews.length,
        nestedButtonCount: buttons.length,
        nestedPreviewWidth: Math.round(previewRect?.width ?? 0),
        nestedPreviewHeight: Math.round(previewRect?.height ?? 0),
        nestedButtonWidth: Math.round(buttonRect?.width ?? 0),
        nestedButtonHeight: Math.round(buttonRect?.height ?? 0)
      };
    },
    { expectedLabel: label, expectedButtonName: buttonName }
  );
}

function releasedNotebookRendererHostDiagnostics(
  notebook: vscode.NotebookDocument,
  cellIndex: number
): Record<string, boolean | number> {
  const mimes = notebook.cellAt(cellIndex).outputs.flatMap((output) => output.items.map((item) => item.mime));
  const displayOrder = vscode.workspace
    .getConfiguration("notebook", notebook.uri)
    .get<unknown[]>("displayOrder", [])
    .filter((item): item is string => typeof item === "string");
  return {
    outputMimeCount: mimes.length,
    customMimeIndex: mimes.indexOf(OPEN_WRANGLER_MIME_V2),
    htmlMimeIndex: mimes.indexOf("text/html"),
    plainMimeIndex: mimes.indexOf("text/plain"),
    displayOrderCount: displayOrder.length,
    customDisplayOrderIndex: displayOrder.indexOf(OPEN_WRANGLER_MIME_V2),
    htmlDisplayOrderIndex: displayOrder.indexOf("text/html"),
    plainDisplayOrderIndex: displayOrder.indexOf("text/plain")
  };
}

async function seedVisiblePersistedPanel(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  const sourceBytes = readFileSync(fixture.fsPath);
  recordAcceptanceProgress("seed:visible-panel:open");
  const opened = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: semicolonCsvSource(fixture),
    backend: "polars",
    pageSize: 200,
    mode: "editing"
  });
  assert.equal(
    opened.kind,
    "sessionOpened",
    opened.kind === "error"
      ? `The persisted-panel seed failed to open: ${opened.code}: ${opened.message}`
      : `The persisted-panel seed returned ${opened.kind}.`
  );
  if (opened.kind !== "sessionOpened") return;
  assert.deepEqual(opened.metadata.shape, {
    rows: PACKAGED_FIRST_USE_ROW_COUNT,
    columns: PACKAGED_SCREENSHOT_COLUMNS.length
  });

  recordAcceptanceProgress("seed:visible-panel:preview");
  const preview = await testing.request({
    kind: "previewStep",
    ...GRID_COLUMN_WINDOW,
    sessionId: opened.metadata.sessionId,
    revision: opened.metadata.revision,
    step: {
      id: PERSISTED_PANEL_STEP_ID,
      kind: "formula",
      params: {
        leftColumn: columnReference(opened.metadata, "revenue"),
        operator: "multiply",
        value: 2,
        newColumn: PERSISTED_PANEL_OUTPUT_COLUMN
      }
    },
    offset: 0,
    limit: 200
  });
  assert.equal(preview.kind, "stepPreview");
  if (preview.kind !== "stepPreview") return;

  recordAcceptanceProgress("seed:visible-panel:apply");
  const applied = await testing.request({
    kind: "applyDraft",
    ...GRID_COLUMN_WINDOW,
    sessionId: opened.metadata.sessionId,
    revision: preview.revision,
    offset: 0,
    limit: 200
  });
  assert.equal(applied.kind, "planUpdated");
  if (applied.kind !== "planUpdated") return;

  recordAcceptanceProgress("seed:visible-panel:view");
  const page = await testing.request({
    kind: "getPage",
    ...GRID_COLUMN_WINDOW,
    viewRequestId: "seed-visible-persisted-panel",
    sessionId: opened.metadata.sessionId,
    revision: applied.revision,
    offset: 400,
    limit: 200,
    filterModel: persistedPanelFilterModel()
  });
  assert.equal(page.kind, "page");
  if (page.kind !== "page") return;
  assert.deepEqual(
    page.metadata.steps.map((step) => step.id),
    [PERSISTED_PANEL_STEP_ID]
  );
  assert.deepEqual(page.metadata.filterModel, persistedPanelFilterModel());
  assert.equal(page.metadata.shape.columns, PACKAGED_SCREENSHOT_COLUMNS.length + 1);
  const selected = columnReference(page.metadata, PERSISTED_PANEL_SELECTED_COLUMN);
  await testing.updateViewState(opened.metadata.sessionId, {
    columnWidths: new Map([[selected.id, PERSISTED_PANEL_COLUMN_WIDTH]]),
    selectedColumnId: selected.id,
    viewport: {
      firstVisibleRow: PERSISTED_PANEL_FIRST_VISIBLE_ROW,
      scrollLeft: PERSISTED_PANEL_SCROLL_LEFT
    }
  });

  recordAcceptanceProgress("seed:visible-panel:close");
  const closed = await testing.request({
    kind: "closeSession",
    sessionId: opened.metadata.sessionId,
    revision: page.revision
  });
  assert.equal(closed.kind, "sessionClosed");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the visible persisted-panel seed session and runtime to close"
  );
  assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Seeding visible state must not modify its source.");
}

async function seedPersistedPlan(
  testing: TestApi,
  fixture: vscode.Uri,
  persistedPanelFixture: vscode.Uri
): Promise<void> {
  await seedVisiblePersistedPanel(testing, persistedPanelFixture);
  const source = csvSource(fixture);
  const filterModel: FilterModel = {
    filters: [],
    sort: [{ column: "sales", direction: "desc", nulls: "last" }]
  };
  for (const target of [
    {
      backend: "polars" as const,
      stepId: "packaged-score",
      multiplier: 2,
      score: "24.0",
      width: 250,
      scrollLeft: 35
    },
    {
      backend: "duckdb" as const,
      stepId: "packaged-duckdb-score",
      multiplier: 3,
      score: "36.0",
      width: 310,
      scrollLeft: 75
    }
  ]) {
    recordAcceptanceProgress(`seed:${target.backend}:open`);
    const opened = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source,
      backend: target.backend,
      pageSize: 20,
      mode: "editing"
    });
    assert.equal(
      opened.kind,
      "sessionOpened",
      `Expected ${target.backend} sessionOpened, received ${JSON.stringify(opened)}`
    );
    if (opened.kind !== "sessionOpened") continue;

    recordAcceptanceProgress(`seed:${target.backend}:preview`);
    const preview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      step: {
        id: target.stepId,
        kind: "formula",
        params: {
          leftColumn: columnReference(opened.metadata, "sales"),
          operator: "multiply",
          value: target.multiplier,
          newColumn: "score"
        }
      },
      offset: 0,
      limit: 20
    });
    assert.equal(preview.kind, "stepPreview");
    if (preview.kind !== "stepPreview") continue;

    recordAcceptanceProgress(`seed:${target.backend}:apply`);
    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: opened.metadata.sessionId,
      revision: preview.revision,
      offset: 0,
      limit: 20
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") continue;

    recordAcceptanceProgress(`seed:${target.backend}:page`);
    const page = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `persisted-${target.backend}-plan-page`,
      sessionId: opened.metadata.sessionId,
      revision: applied.revision,
      offset: 0,
      limit: 20,
      filterModel
    });
    assert.equal(page.kind, "page");
    if (page.kind !== "page") continue;
    assert.equal(page.page.rows[0]?.values[0]?.display, "Berlin");
    assert.equal(page.page.rows[0]?.values[4]?.display, target.score);
    assert.deepEqual(
      page.metadata.steps.map((step) => step.id),
      [target.stepId]
    );
    const salesColumnId = page.metadata.schema.find((column) => column.name === "sales")?.id;
    assert.ok(salesColumnId);
    recordAcceptanceProgress(`seed:${target.backend}:view-state`);
    await testing.updateViewState(opened.metadata.sessionId, {
      columnWidths: new Map([[salesColumnId, target.width]]),
      selectedColumnId: salesColumnId,
      viewport: { firstVisibleRow: SHORT_FIXTURE_FIRST_VISIBLE_ROW, scrollLeft: target.scrollLeft }
    });

    recordAcceptanceProgress(`seed:${target.backend}:close`);
    const closed = await testing.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: page.revision
    });
    assert.equal(closed.kind, "sessionClosed");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `the seeded ${target.backend} session and standalone runtime to close`
    );

    recordAcceptanceProgress(`seed:${target.backend}:readback-open`);
    const readback = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source,
      backend: target.backend,
      pageSize: 20,
      mode: "editing"
    });
    assert.equal(readback.kind, "sessionOpened");
    if (readback.kind !== "sessionOpened") continue;
    assert.deepEqual(
      readback.metadata.steps.map((step) => step.id),
      [target.stepId]
    );
    assert.equal(readback.page.rows[0]?.values[4]?.display, target.score);
    assert.deepEqual(testing.activeSession()?.viewState, {
      filterModel: { ...filterModel, logic: "and" },
      columnWidths: new Map([[salesColumnId, target.width]]),
      selectedColumnId: salesColumnId,
      viewport: { firstVisibleRow: SHORT_FIXTURE_FIRST_VISIBLE_ROW, scrollLeft: target.scrollLeft }
    });
    recordAcceptanceProgress(`seed:${target.backend}:readback-close`);
    const readbackClosed = await testing.request({
      kind: "closeSession",
      sessionId: readback.metadata.sessionId,
      revision: readback.metadata.revision
    });
    assert.equal(readbackClosed.kind, "sessionClosed");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `the ${target.backend} persistence readback session to close`
    );
    recordAcceptanceProgress(`seed:${target.backend}:complete`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

interface VisiblePersistedPanelSnapshot {
  readonly appliedStepText: string;
  readonly selectedColumnWidth: number;
  readonly selectedValues: readonly string[];
  readonly selectedColumnId: string;
  readonly sort: FilterModel["sort"];
  readonly sortLabels: readonly string[];
  readonly status: string;
  readonly viewport: { firstVisibleRow: number; scrollLeft: number };
}

async function assertPersistedSortPriorityInNativeView(workbench: Page): Promise<readonly string[]> {
  const sidebarWasVisible = await workbench
    .locator(".part.sidebar")
    .first()
    .isVisible()
    .catch(() => false);
  await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
  const sidebar = workbench.locator(".part.sidebar:visible");
  const filtersTree = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
  if (!(await filtersTree.isVisible().catch(() => false))) {
    const filtersHeader = sidebar.getByText("Filters / Sorts", { exact: true }).first();
    await filtersHeader.waitFor({ state: "visible", timeout: 10_000 });
    await filtersHeader.click();
  }
  await filtersTree.waitFor({ state: "visible", timeout: 10_000 });
  const revenue = filtersTree
    .getByRole("treeitem", { name: /^revenue, Priority 1 · Descending · nulls last/u })
    .first();
  const market = filtersTree.getByRole("treeitem", { name: /^market, Priority 2 · Descending · nulls last/u }).first();
  await revenue.waitFor({ state: "visible", timeout: 10_000 });
  await market.waitFor({ state: "visible", timeout: 10_000 });
  const labels = [(await revenue.getAttribute("aria-label")) ?? "", (await market.getAttribute("aria-label")) ?? ""];
  assert.match(labels[0] ?? "", /^revenue, Priority 1 · Descending · nulls last/u);
  assert.match(labels[1] ?? "", /^market, Priority 2 · Descending · nulls last/u);
  if (!sidebarWasVisible) {
    await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
      "workbench.action.closeSidebar",
      "workbench.action.toggleSidebarVisibility"
    ]);
  }
  const activeEditorTab = workbench
    .locator(".part.editor .editor-group-container.active .tabs-container .tab.active:visible")
    .last();
  await activeEditorTab.waitFor({ state: "visible", timeout: 10_000 });
  await activeEditorTab.click();
  return labels;
}

async function visiblePersistedPanelSnapshot(
  testing: TestApi,
  workbench: Page,
  sessionId: string
): Promise<VisiblePersistedPanelSnapshot> {
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The visible persistence assertion requires the exact rendered panel.");
  await waitForSettledViewState(testing, "the visible persisted panel to settle before physical inspection");
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId);
  assert.ok(active, "The visible persistence assertion requires its exact active session.");
  assert.deepEqual(
    active.metadata.steps.map((step) => step.id),
    [PERSISTED_PANEL_STEP_ID]
  );
  assert.equal(active.metadata.shape.columns, PACKAGED_SCREENSHOT_COLUMNS.length + 1);
  assert.ok(columnReference(active.metadata, PERSISTED_PANEL_OUTPUT_COLUMN));
  assert.match(active.code ?? "", new RegExp(PERSISTED_PANEL_OUTPUT_COLUMN, "u"));
  assert.deepEqual(active.viewState.filterModel, persistedPanelFilterModel());
  const selected = columnReference(active.metadata, PERSISTED_PANEL_SELECTED_COLUMN);
  assert.equal(active.viewState.selectedColumnId, selected.id);
  assert.equal(active.viewState.columnWidths.get(selected.id), PERSISTED_PANEL_COLUMN_WIDTH);
  assert.equal(active.viewState.viewport.firstVisibleRow, PERSISTED_PANEL_FIRST_VISIBLE_ROW);
  assert.ok(active.viewState.viewport.scrollLeft > 0, "The restored horizontal viewport must remain nonzero.");

  assert.equal((await app.locator('[data-session-badge="backend"]').innerText()).trim(), "POLARS");
  const cleaningPlan = app.getByRole("group", { name: "Cleaning plan" });
  await cleaningPlan.waitFor({ state: "visible", timeout: 10_000 });
  const appliedStepText = (await cleaningPlan.innerText()).replace(/\s+/gu, " ").trim();
  assert.match(appliedStepText, /\b1 applied step\b/u);

  const outputPosition = active.metadata.schema.findIndex((column) => column.name === PERSISTED_PANEL_OUTPUT_COLUMN);
  assert.equal(
    outputPosition,
    PACKAGED_SCREENSHOT_COLUMNS.length,
    "The committed recovery output must remain the final schema column."
  );
  const selectedPosition = active.metadata.schema.findIndex((column) => column.id === selected.id);
  assert.notEqual(selectedPosition, -1);
  const selectedHeader = app.locator(`th[data-grid-column="${selectedPosition}"]`).first();
  await selectedHeader.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await selectedHeader.getAttribute("data-column"), PERSISTED_PANEL_SELECTED_COLUMN);
  assert.equal(await selectedHeader.getAttribute("aria-selected"), "true");
  const selectedColumnWidth = Math.round((await selectedHeader.boundingBox())?.width ?? 0);
  assert.ok(
    Math.abs(selectedColumnWidth - PERSISTED_PANEL_COLUMN_WIDTH) <= 1,
    `The distinctive persisted selected-column width was not rendered: ${selectedColumnWidth}.`
  );

  const visibleRows = app.getByRole("status", { name: "Visible rows" });
  await visibleRows.waitFor({ state: "visible", timeout: 10_000 });
  await waitForLocatorText(
    visibleRows,
    (text) => text.trim() === "Rows 401\u2013600 of 10,000",
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the persisted 401\u2013600 row block to reach the rendered grid"
  );
  const status = (await visibleRows.innerText()).trim();

  const selectedCells = app.locator(`td[data-grid-column="${selectedPosition}"][data-grid-row]`);
  await selectedCells.first().waitFor({ state: "visible", timeout: 10_000 });
  const selectedValues = (await selectedCells.allInnerTexts()).slice(0, 3).map((value) => value.trim());
  assert.equal(selectedValues.length, 3, "The selected persisted column must expose visible values.");
  assert.ok(
    selectedValues.every((value) => Number.isFinite(Number(value.replaceAll(",", "")))),
    `The selected persisted numeric column must remain numeric: ${JSON.stringify(selectedValues)}.`
  );
  assert.equal(await selectedCells.first().getAttribute("aria-selected"), "true");

  const scroller = app.getByTestId("data-grid-scroller");
  const physicalViewport = await scroller.evaluate((element) => {
    const target = element as {
      scrollLeft: number;
      scrollTop: number;
      scrollWidth: number;
      scrollHeight: number;
      clientWidth: number;
      clientHeight: number;
    };
    return {
      scrollLeft: target.scrollLeft,
      scrollTop: target.scrollTop,
      scrollWidth: target.scrollWidth,
      scrollHeight: target.scrollHeight,
      clientWidth: target.clientWidth,
      clientHeight: target.clientHeight
    };
  });
  assert.ok(physicalViewport.scrollLeft > 0, "The rendered grid must retain a nonzero horizontal scroll.");
  assert.ok(physicalViewport.scrollTop > 0, "The rendered grid must retain a nonzero vertical scroll.");
  assert.ok(physicalViewport.scrollWidth > physicalViewport.clientWidth);
  assert.ok(physicalViewport.scrollHeight > physicalViewport.clientHeight);

  assert.equal(status, "Rows 401\u2013600 of 10,000");
  const sortLabels = await assertPersistedSortPriorityInNativeView(workbench);
  await waitForSettledViewState(testing, "the visible persisted panel to settle after native-view inspection");

  return {
    appliedStepText,
    selectedColumnWidth,
    selectedValues,
    selectedColumnId: selected.id,
    sort: active.viewState.filterModel.sort.map((rule) => ({ ...rule })),
    sortLabels,
    status,
    viewport: { ...active.viewState.viewport }
  };
}

async function verifyVisiblePersistedReplayAndRecovery(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  const sourceBytes = readFileSync(fixture.fsPath);
  const insights = vscode.workspace.getConfiguration("openWrangler", fixture);
  const previousInsightsOnOpen = insights.inspect<boolean>("insightsOnOpen")?.globalValue;
  await insights.update("insightsOnOpen", false, vscode.ConfigurationTarget.Global);
  let sessionId: string | undefined;
  try {
    const workbench = await connectToEditorWorkbench();
    recordAcceptanceProgress("verify:visible-replay-recovery:open");
    await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitFor(
      () => {
        const response = testing.panelOpenResponse();
        if (response?.kind === "error") {
          throw new Error(`The persisted Polars panel failed to open: ${response.code}: ${response.message}`);
        }
        const active = testing.activeSession();
        if (
          active?.metadata.source.uri === fixture.toString() &&
          active.metadata.backend === "polars" &&
          !active.metadata.steps.some((step) => step.id === PERSISTED_PANEL_STEP_ID)
        ) {
          throw new Error("The persisted Polars panel opened without its saved cleaning step.");
        }
        return (
          active?.metadata.source.uri === fixture.toString() &&
          active.metadata.backend === "polars" &&
          active.metadata.steps.some((step) => step.id === PERSISTED_PANEL_STEP_ID)
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the fresh editor process to replay the visible persisted Polars plan",
      () => {
        const response = testing.panelOpenResponse();
        const active = testing.activeSession();
        return JSON.stringify({
          openResponse:
            response === undefined
              ? undefined
              : response.kind === "error"
                ? { kind: response.kind, code: response.code }
                : { kind: response.kind },
          active:
            active === undefined
              ? undefined
              : {
                  sourceMatches: active.metadata.source.uri === fixture.toString(),
                  backend: active.metadata.backend,
                  stepIds: active.metadata.steps.slice(0, 16).map((step) => step.id)
                },
          sessionCount: testing.diagnostics().sessionCount,
          runtimeGeneration: testing.runtimeGeneration(),
          runtimeRunning: testing.runtimeRunning()
        });
      }
    );
    const active = testing.activeSession();
    assert.ok(active, "The fresh editor process must publish the persisted panel session.");
    sessionId = active.sessionId;
    await waitFor(
      () => testing.panelHydrated(sessionId!),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the fresh persisted panel renderer to acknowledge its replay"
    );
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The fresh persisted panel must synchronize before physical inspection."
    );
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await workbench.bringToFront();
    const persistedTab = workbench
      .locator(".part.editor .editor-group-container.active .tabs-container .tab.active:visible")
      .filter({ hasText: path.basename(fixture.fsPath) })
      .last();
    await persistedTab.waitFor({ state: "visible", timeout: 10_000 });
    await persistedTab.click();
    recordAcceptanceProgress("verify:visible-replay-recovery:initial-visible-state");
    const initial = await visiblePersistedPanelSnapshot(testing, workbench, sessionId);
    const initialTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const initialApp = await exactSessionApp(initialTarget.frame, sessionId);
    assert.ok(initialApp);
    const initialHeaderProfiles = initialApp.getByRole("button", { name: "Header profiles", exact: true });
    await initialHeaderProfiles.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await initialHeaderProfiles.getAttribute("aria-pressed"),
      "false",
      "The recovery journey must defer profiles until its renderer-owned request."
    );

    const generation = testing.runtimeGeneration();
    const runtimeId = testing.diagnostics().sessions.find((session) => session.publicId === sessionId)?.runtimeId;
    assert.ok(runtimeId);
    recordAcceptanceProgress("verify:visible-replay-recovery:restart");
    testing.restartRuntime("Injected visible panel recovery test.");
    await workbench
      .locator(".notifications-toasts.visible .notification-list-item")
      .first()
      .waitFor({ state: "visible", timeout: 2_000 })
      .catch(() => undefined);
    const availableCommands = new Set(await vscode.commands.getCommands(true));
    if (availableCommands.has("notifications.clearAll")) {
      await vscode.commands.executeCommand("notifications.clearAll");
    }
    if (availableCommands.has("notifications.hideList")) {
      await vscode.commands.executeCommand("notifications.hideList");
    }
    await workbench
      .locator(".notifications-toasts.visible .notification-list-item")
      .first()
      .waitFor({ state: "hidden", timeout: 10_000 });
    recordAcceptanceProgress("verify:visible-replay-recovery:header-profiles");
    await initialHeaderProfiles.click();
    await waitFor(
      () => testing.runtimeGeneration() === generation + 1,
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the renderer-originated Header profiles request to restart the runtime exactly once"
    );
    await waitFor(
      () => {
        const recovered = testing.diagnostics().sessions.find((session) => session.publicId === sessionId);
        return Boolean(recovered && recovered.runtimeId !== runtimeId);
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the visible panel session to bind its replacement runtime"
    );

    const recoveredTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const recoveredApp = await exactSessionApp(recoveredTarget.frame, sessionId);
    assert.ok(recoveredApp);
    const recoveredHeaderProfiles = recoveredApp.getByRole("button", { name: "Header profiles", exact: true });
    await recoveredHeaderProfiles.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await recoveredHeaderProfiles.getAttribute("aria-pressed"), "true");
    const recoveredSelectedHeader = recoveredApp
      .locator(`th[data-column="${PERSISTED_PANEL_SELECTED_COLUMN}"]`)
      .first();
    await recoveredSelectedHeader.waitFor({ state: "visible", timeout: 10_000 });
    await waitForLocatorText(
      recoveredSelectedHeader,
      (text) =>
        !text.includes("Profiling\u2026") &&
        ["Missing", "Distinct", "Min", "Max"].every((label) => text.includes(label)),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "renderer-originated Header profiles to finish on the persisted selected column"
    );
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The recovered renderer must acknowledge its authoritative session snapshot."
    );
    recordAcceptanceProgress("verify:visible-replay-recovery:recovered-visible-state");
    const recovered = await visiblePersistedPanelSnapshot(testing, workbench, sessionId);
    assert.deepEqual(
      recovered,
      initial,
      "Runtime recovery and renderer-originated profiling must preserve the complete visible dataframe state."
    );
    assertExactBytes(
      readFileSync(fixture.fsPath),
      sourceBytes,
      "Persisted replay and recovery must preserve the source bytes."
    );
  } finally {
    if (sessionId) {
      await testing.disposePanelForSession(sessionId);
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        15_000,
        "the visible persistence session and replacement runtime to close"
      );
    }
    await insights.update("insightsOnOpen", previousInsightsOnOpen, vscode.ConfigurationTarget.Global);
    assertExactBytes(
      readFileSync(fixture.fsPath),
      sourceBytes,
      "Persisted replay cleanup must preserve the source bytes."
    );
  }
}

async function verifyPersistedReplayAndRecovery(
  testing: TestApi,
  workspace: vscode.Uri,
  fixture: vscode.Uri
): Promise<void> {
  const sourceText = readFileSync(fixture.fsPath, "utf8");
  recordAcceptanceProgress("verify:replay-recovery:polars-open");
  const restored = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: csvSource(fixture),
    backend: "polars",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(restored.kind, "sessionOpened");
  if (restored.kind !== "sessionOpened") return;
  recordAcceptanceProgress("verify:replay-recovery:polars-opened");
  assert.deepEqual(
    restored.metadata.steps.map((step) => step.id),
    ["packaged-score"]
  );
  assert.equal(restored.metadata.shape.columns, 5);
  assert.equal(restored.page.rows[0]?.values[0]?.display, "Berlin");
  assert.equal(restored.page.rows[0]?.values[4]?.display, "24.0");
  assert.deepEqual(restored.metadata.filterModel.sort, [{ column: "sales", direction: "desc", nulls: "last" }]);
  const restoredSalesId = restored.metadata.schema.find((column) => column.name === "sales")?.id;
  assert.ok(restoredSalesId);
  assert.deepEqual(testing.activeSession()?.viewState, {
    filterModel: restored.metadata.filterModel,
    columnWidths: new Map([[restoredSalesId, 250]]),
    selectedColumnId: restoredSalesId,
    viewport: { firstVisibleRow: SHORT_FIXTURE_FIRST_VISIBLE_ROW, scrollLeft: 35 }
  });

  const secondFixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.tsv");
  const secondSourceText = readFileSync(secondFixture.fsPath, "utf8");
  recordAcceptanceProgress("verify:replay-recovery:pandas-open");
  const second = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: tsvSource(secondFixture),
    backend: "pandas",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(second.kind, "sessionOpened");
  if (second.kind !== "sessionOpened") return;
  recordAcceptanceProgress("verify:replay-recovery:pandas-opened");
  assert.notEqual(second.metadata.sessionId, restored.metadata.sessionId);
  recordAcceptanceProgress("verify:replay-recovery:duckdb-open");
  const third = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: csvSource(fixture),
    backend: "duckdb",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(third.kind, "sessionOpened");
  if (third.kind !== "sessionOpened") return;
  recordAcceptanceProgress("verify:replay-recovery:duckdb-opened");
  assert.deepEqual(
    third.metadata.steps.map((step) => step.id),
    ["packaged-duckdb-score"]
  );
  assert.equal(third.metadata.shape.columns, 5);
  assert.equal(third.page.rows[0]?.values[0]?.display, "Berlin");
  assert.equal(third.page.rows[0]?.values[4]?.display, "36.0");
  assert.deepEqual(third.metadata.filterModel.sort, [{ column: "sales", direction: "desc", nulls: "last" }]);
  const duckdbSalesId = third.metadata.schema.find((column) => column.name === "sales")?.id;
  assert.ok(duckdbSalesId);
  assert.deepEqual(testing.activeSession()?.viewState, {
    filterModel: third.metadata.filterModel,
    columnWidths: new Map([[duckdbSalesId, 310]]),
    selectedColumnId: duckdbSalesId,
    viewport: { firstVisibleRow: SHORT_FIXTURE_FIRST_VISIBLE_ROW, scrollLeft: 75 }
  });
  assert.notEqual(third.metadata.sessionId, restored.metadata.sessionId);
  assert.notEqual(third.metadata.sessionId, second.metadata.sessionId);
  assert.equal(testing.diagnostics().sessionCount, 3);
  testing.setActiveSession(second.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, second.metadata.sessionId);
  testing.setActiveSession(third.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, third.metadata.sessionId);
  testing.setActiveSession(restored.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, restored.metadata.sessionId);

  const beforeRestart = testing.diagnostics();
  const generation = testing.runtimeGeneration();
  recordAcceptanceProgress("verify:replay-recovery:restart");
  testing.restartRuntime("Injected packaged-editor recovery test.");
  recordAcceptanceProgress("verify:replay-recovery:concurrent-replay");
  const [restoredPage, secondPage, thirdPage] = await Promise.all([
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "restart-restored-page",
      sessionId: restored.metadata.sessionId,
      revision: restored.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: restored.metadata.filterModel
    }),
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "restart-second-page",
      sessionId: second.metadata.sessionId,
      revision: second.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: second.metadata.filterModel
    }),
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "restart-duckdb-page",
      sessionId: third.metadata.sessionId,
      revision: third.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: third.metadata.filterModel
    })
  ]);
  recordAcceptanceProgress("verify:replay-recovery:replayed");
  assert.equal(restoredPage.kind, "page", `Polars recovery returned ${JSON.stringify(restoredPage)}.`);
  assert.equal(secondPage.kind, "page", `Pandas recovery returned ${JSON.stringify(secondPage)}.`);
  assert.equal(thirdPage.kind, "page", `DuckDB recovery returned ${JSON.stringify(thirdPage)}.`);
  if (restoredPage.kind !== "page" || secondPage.kind !== "page" || thirdPage.kind !== "page") return;
  assert.equal(testing.runtimeGeneration(), generation + 1, "Concurrent recovery must start exactly one runtime.");
  assert.equal(restoredPage.page.rows[0]?.values[4]?.display, "24.0");
  assert.equal(secondPage.metadata.shape.columns, 4);
  assert.equal(thirdPage.metadata.backend, "duckdb");
  assert.equal(thirdPage.metadata.shape.columns, 5);
  assert.equal(thirdPage.page.rows[0]?.values[4]?.display, "36.0");
  const afterRestart = testing.diagnostics();
  assert.equal(afterRestart.sessionCount, 3);
  for (const before of beforeRestart.sessions) {
    const after = afterRestart.sessions.find((session) => session.publicId === before.publicId);
    assert.ok(after);
    assert.notEqual(after.runtimeId, before.runtimeId, `Expected runtime replay for ${before.sourceLabel}.`);
  }

  const exportDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-export-"));
  try {
    for (const target of [
      {
        name: "polars",
        backend: restoredPage.metadata.backend,
        sessionId: restored.metadata.sessionId,
        revision: restoredPage.revision,
        columns: 5
      },
      {
        name: "pandas",
        backend: secondPage.metadata.backend,
        sessionId: second.metadata.sessionId,
        revision: secondPage.revision,
        columns: 4
      },
      {
        name: "duckdb",
        backend: thirdPage.metadata.backend,
        sessionId: third.metadata.sessionId,
        revision: thirdPage.revision,
        columns: 5
      }
    ]) {
      const csvDestination = path.join(exportDirectory, `${target.name}.csv`);
      const csvExported = await testing.request(persistedReplayExportRequest(target, csvDestination, "csv"));
      assert.equal(csvExported.kind, "dataExported");
      if (csvExported.kind === "dataExported") assert.equal(csvExported.shape.columns, target.columns);
      assert.match(readFileSync(csvDestination, "utf8"), /city,year,sales,active/);

      const parquetDestination = path.join(exportDirectory, `${target.name}.parquet`);
      const parquetExported = await testing.request(
        persistedReplayExportRequest(target, parquetDestination, "parquet")
      );
      assert.equal(parquetExported.kind, "dataExported");
      if (parquetExported.kind === "dataExported") assert.equal(parquetExported.shape.columns, target.columns);
      assert.equal(readFileSync(parquetDestination).subarray(0, 4).toString("ascii"), "PAR1");
    }
    assertExactBytes(
      readFileSync(fixture.fsPath),
      Buffer.from(sourceText, "utf8"),
      "Export must not modify the source fixture."
    );
    assertExactBytes(
      readFileSync(secondFixture.fsPath),
      Buffer.from(secondSourceText, "utf8"),
      "Pandas export must not modify the source fixture."
    );
  } finally {
    cleanupAcceptanceTemporaryDirectory(exportDirectory);
  }

  const firstClosed = await testing.request({
    kind: "closeSession",
    sessionId: restored.metadata.sessionId,
    revision: restoredPage.revision
  });
  const secondClosed = await testing.request({
    kind: "closeSession",
    sessionId: second.metadata.sessionId,
    revision: secondPage.revision
  });
  const thirdClosed = await testing.request({
    kind: "closeSession",
    sessionId: third.metadata.sessionId,
    revision: thirdPage.revision
  });
  assert.equal(firstClosed.kind, "sessionClosed");
  assert.equal(secondClosed.kind, "sessionClosed");
  assert.equal(thirdClosed.kind, "sessionClosed");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "all recovered sessions and the standalone runtime to close"
  );
}

async function exercisePackagedFileInputs(testing: TestApi, workspace: vscode.Uri, python: string): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-file-inputs-"));
  const config = vscode.workspace.getConfiguration("openWrangler");
  const originalBackend = config.get<"auto" | "polars" | "duckdb" | "pandas">("defaultBackend", "auto");
  try {
    writeFileSync(
      path.join(directory, "sample.csv"),
      readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "sample.csv").fsPath)
    );
    const sampleTsv = readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "sample.tsv").fsPath);
    writeFileSync(path.join(directory, "sample-pandas.tsv"), sampleTsv);
    writeFileSync(path.join(directory, "sample-duckdb.tsv"), sampleTsv);
    const sampleJsonl = readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "sample.jsonl").fsPath);
    writeFileSync(path.join(directory, "sample-polars.jsonl"), sampleJsonl);
    writeFileSync(path.join(directory, "sample-duckdb.jsonl"), sampleJsonl);
    writeFileSync(path.join(directory, "configured.csv"), "name;value\nalpha;1\nbeta;2\n", "utf8");
    writeFileSync(
      path.join(directory, "reconfigure.csv"),
      [
        "name;value;category;status;amount;date;note;flag",
        ...Array.from(
          { length: 80 },
          (_, index) =>
            `row-${index};${index};group-${index % 4};${index % 2 === 0 ? "active" : "paused"};${index * 10};2026-07-${String((index % 28) + 1).padStart(2, "0")};note-${index};${index % 2 === 0}`
        )
      ].join("\n") + "\n",
      "utf8"
    );
    writeFileSync(path.join(directory, "configured.tsv"), "name|value\nalpha|1\nbeta|2\n", "utf8");
    const damagedCsvPrefix = Buffer.from(
      `name,value\n${"a".repeat(IMPORT_DETECTION_SAMPLE_BYTES - Buffer.byteLength("name,value\n", "utf8"))}`,
      "utf8"
    );
    assert.equal(damagedCsvPrefix.length, IMPORT_DETECTION_SAMPLE_BYTES);
    writeFileSync(
      path.join(directory, "damaged.csv"),
      Buffer.concat([damagedCsvPrefix, Buffer.from([0xff]), Buffer.from(",1\n", "utf8")])
    );
    writeFileSync(path.join(directory, "damaged.jsonl"), '{"name":"broken"\n', "utf8");
    writeFileSync(path.join(directory, "damaged.parquet"), "PAR1broken", "utf8");
    writeFileSync(path.join(directory, "damaged.xls"), "not-an-excel-workbook", "utf8");
    writeFileSync(
      path.join(directory, "legacy.xls"),
      gunzipSync(
        Buffer.from(
          readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "legacy.xls.gz.base64").fsPath, "utf8").trim(),
          "base64"
        )
      )
    );
    execFileSync(
      python,
      [
        "-c",
        [
          "import sys",
          "from pathlib import Path",
          "import duckdb",
          "import polars as pl",
          "from openpyxl import Workbook",
          "root = Path(sys.argv[1])",
          "pl.DataFrame({'name': ['alpha', 'beta'], 'value': [1, 2], 'active': [True, False]}).write_parquet(root / 'sample.parquet')",
          "connection = duckdb.connect(config={'autoinstall_known_extensions': False, 'autoload_known_extensions': False})",
          "try:",
          "    connection.execute(\"SET TimeZone = 'Pacific/Auckland'\")",
          "    connection.execute(\"CREATE TABLE rich AS SELECT CAST('123456789012345678901234567890.12345678' AS DECIMAL(38,8)) AS exact_decimal, TIMESTAMPTZ '2026-07-16 14:30:00+02:00' AS zoned, [1, 2, NULL]::INTEGER[] AS items, {'label': 'alpha', 'score': 7} AS record UNION ALL SELECT CAST('-0.00000001' AS DECIMAL(38,8)), TIMESTAMPTZ '2026-01-01 00:15:00-08:00', []::INTEGER[], {'label': 'beta', 'score': NULL}\")",
          "    connection.execute(\"COPY rich TO ? (FORMAT PARQUET)\", [str(root / 'sample-duckdb-rich.parquet')])",
          "finally:",
          "    connection.close()",
          "workbook = Workbook()",
          "sheet = workbook.active",
          "sheet.title = 'Overview'",
          "sheet.append(['name', 'value', 'active'])",
          "sheet.append(['ignored-alpha', 11, True])",
          "sheet.append(['ignored-beta', 12, False])",
          "sheet = workbook.create_sheet('Sales')",
          "sheet.append(['name', 'value', 'active'])",
          "sheet.append(['alpha', 1, True])",
          "sheet.append(['beta', 2, False])",
          "workbook.save(root / 'sample.xlsx')"
        ].join("\n"),
        directory
      ],
      { encoding: "utf8" }
    );
    const duckdbRichParquetUri = vscode.Uri.file(path.join(directory, "sample-duckdb-rich.parquet"));
    const duckdbRichParquetSource = readFileSync(duckdbRichParquetUri.fsPath);
    const parquetLaunchUri = vscode.Uri.file(path.join(directory, "sample.parquet"));
    const parquetSource = readFileSync(parquetLaunchUri.fsPath);
    recordAcceptanceProgress("verify:file-inputs:canonical:polars:parquet:open");
    await config.update("defaultBackend", "polars", vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("openWrangler.openFile", parquetLaunchUri);
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.path === parquetLaunchUri.fsPath &&
          active.metadata.backend === "polars" &&
          active.metadata.shape.rows === 2 &&
          active.metadata.shape.columns === 3
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the editor-menu file URI to open through the canonical launch command",
      () =>
        packagedFileOpenDiagnostics(testing, {
          sourceLabel: path.basename(parquetLaunchUri.fsPath),
          backend: "polars",
          shape: { rows: 2, columns: 3 }
        })
    );
    recordAcceptanceProgress("verify:file-inputs:canonical:polars:parquet:opened");
    assertExactBytes(
      readFileSync(parquetLaunchUri.fsPath),
      parquetSource,
      "Opening a source from an editor menu must not modify it."
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the editor-menu file session to dispose"
    );
    recordAcceptanceProgress("verify:file-inputs:canonical:polars:parquet:closed");

    recordAcceptanceProgress("verify:file-inputs:configured");
    await exerciseConfiguredFileImportOptions(testing, directory);
    recordAcceptanceProgress("verify:file-inputs:corrupt");
    await exerciseCorruptFileFailures(testing, directory, config);
    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      recordAcceptanceProgress("verify:file-inputs:configured:public-excel");
      await exercisePublicLegacyExcelImportOptions(testing, directory, config);
      recordAcceptanceProgress("verify:file-inputs:reconfigure");
      await exerciseLiveImportReconfiguration(testing, directory, config);
    }

    const fixtures: Array<{
      uri: vscode.Uri;
      backend: "polars" | "duckdb" | "pandas";
      shape: { rows: number; columns: number };
      verify?: () => Promise<void>;
    }> = [
      {
        uri: vscode.Uri.file(path.join(directory, "sample-pandas.tsv")),
        backend: "pandas" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample-duckdb.tsv")),
        backend: "duckdb" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample-polars.jsonl")),
        backend: "polars" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample-duckdb.jsonl")),
        backend: "duckdb" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.csv")),
        backend: "duckdb" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.parquet")),
        backend: "polars" as const,
        shape: { rows: 2, columns: 3 }
      },
      {
        uri: duckdbRichParquetUri,
        backend: "duckdb" as const,
        shape: { rows: 2, columns: 4 },
        verify: () => verifyDuckDBRichParquetPage(testing, duckdbRichParquetUri, duckdbRichParquetSource)
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.xlsx")),
        backend: "polars" as const,
        shape: { rows: 2, columns: 3 }
      }
    ];

    for (const fixture of fixtures) {
      const extension = path.extname(fixture.uri.fsPath).slice(1).toLowerCase();
      const checkpoint = `verify:file-inputs:${fixture.backend}:${extension}`;
      recordAcceptanceProgress(`${checkpoint}:open`);
      await config.update("defaultBackend", fixture.backend, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand(
        "vscode.openWith",
        fixture.uri,
        "openWrangler.viewer",
        vscode.ViewColumn.One
      );
      await waitFor(
        () => {
          const active = testing.activeSession();
          return (
            active?.metadata.source.path === fixture.uri.fsPath &&
            active.metadata.backend === fixture.backend &&
            active.metadata.shape.rows === fixture.shape.rows &&
            active.metadata.shape.columns === fixture.shape.columns
          );
        },
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        `${path.basename(fixture.uri.fsPath)} to open through the packaged custom editor`,
        () =>
          packagedFileOpenDiagnostics(testing, {
            sourceLabel: path.basename(fixture.uri.fsPath),
            backend: fixture.backend,
            shape: fixture.shape
          })
      );
      recordAcceptanceProgress(`${checkpoint}:opened`);
      await fixture.verify?.();
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        10_000,
        `${path.basename(fixture.uri.fsPath)} to dispose its session and runtime`
      );
      recordAcceptanceProgress(`${checkpoint}:closed`);
    }
  } finally {
    await config.update("defaultBackend", originalBackend, vscode.ConfigurationTarget.Global);
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function verifyDuckDBRichParquetPage(testing: TestApi, source: vscode.Uri, originalBytes: Buffer): Promise<void> {
  const active = testing.activeSession();
  assert.ok(active, "The rich DuckDB Parquet fixture must publish an active session.");
  assert.equal(active.metadata.backend, "duckdb");
  assert.equal(active.metadata.source.path, source.fsPath);
  assert.deepEqual(
    active.metadata.schema.map((column) => [column.name, column.type]),
    [
      ["exact_decimal", "decimal"],
      ["zoned", "datetime"],
      ["items", "list"],
      ["record", "struct"]
    ]
  );

  const response = await testing.request({
    kind: "getPage",
    ...GRID_COLUMN_WINDOW,
    viewRequestId: "packaged-duckdb-rich-parquet-page",
    sessionId: active.sessionId,
    revision: active.metadata.revision,
    offset: 0,
    limit: 20,
    filterModel: active.metadata.filterModel
  });
  assert.equal(response.kind, "page", "The rich DuckDB Parquet fixture must return a typed page.");
  if (response.kind !== "page") return;

  assert.deepEqual(gridColumnCells(response.page, columnReference(response.metadata, "exact_decimal").id)[0], {
    kind: "decimal",
    raw: "123456789012345678901234567890.12345678",
    display: "123456789012345678901234567890.12345678",
    isNull: false,
    isNaN: false
  });
  assert.deepEqual(gridColumnCells(response.page, columnReference(response.metadata, "zoned").id)[0], {
    kind: "datetime",
    raw: "2026-07-16T12:30:00+00:00",
    display: "2026-07-16T12:30:00+00:00",
    isNull: false,
    isNaN: false
  });
  assert.deepEqual(gridColumnCells(response.page, columnReference(response.metadata, "items").id)[0], {
    kind: "list",
    raw: [1, 2, null],
    display: "[1,2,null]",
    isNull: false,
    isNaN: false
  });
  assert.deepEqual(gridColumnCells(response.page, columnReference(response.metadata, "record").id)[0], {
    kind: "struct",
    raw: { label: "alpha", score: 7 },
    display: '{"label":"alpha","score":7}',
    isNull: false,
    isNaN: false
  });
  assert.doesNotThrow(
    () => JSON.parse(JSON.stringify(response.page.rows.map((row) => row.values))),
    "The rich DuckDB page must remain strict-JSON-safe."
  );
  assertExactBytes(readFileSync(source.fsPath), originalBytes, "Opening rich DuckDB Parquet data must not modify it.");

  const replacement = `${source.fsPath}.replacement`;
  writeFileSync(replacement, Buffer.concat([originalBytes, Buffer.from([0])]));
  let replacementCommitted = false;
  await waitFor(
    () => {
      const state = testing.sessionSchedulerState(active.sessionId);
      if (!state?.quiescent) return false;
      // Keep the final scheduler check and source replacement in one
      // extension-host turn. A late webview request cannot start between them.
      renameSync(replacement, source.fsPath);
      replacementCommitted = true;
      return true;
    },
    10_000,
    "the rich DuckDB session scheduler to quiesce before source replacement",
    () =>
      JSON.stringify({
        scheduler: testing.sessionSchedulerState(active.sessionId),
        coordinator: testing.diagnostics()
      })
  );
  assert.equal(replacementCommitted, true, "The rich DuckDB source replacement must commit exactly once.");

  const invalidated = await testing.request({
    kind: "getPage",
    ...GRID_COLUMN_WINDOW,
    viewRequestId: "packaged-duckdb-rich-parquet-source-replaced",
    sessionId: active.sessionId,
    revision: response.revision,
    offset: 0,
    limit: 20,
    filterModel: response.metadata.filterModel
  });
  assert.equal(invalidated.kind, "error", "Replacing the rich DuckDB source must invalidate the live session.");
  if (invalidated.kind !== "error") return;
  assert.equal(invalidated.code, "engine_error");
  assert.equal(invalidated.recoverable, true);
  assert.match(invalidated.message, /source file.*changed or is no longer available.*Reopen the file/iu);
  assert.equal(invalidated.viewRequestId, "packaged-duckdb-rich-parquet-source-replaced");
}

async function exerciseConfiguredFileImportOptions(testing: TestApi, directory: string): Promise<void> {
  const csvPath = path.join(directory, "configured.csv");
  const tsvPath = path.join(directory, "configured.tsv");
  const excelPath = path.join(directory, "sample.xlsx");
  const legacyExcelPath = path.join(directory, "legacy.xls");
  const csvBytes = readFileSync(csvPath);
  const tsvBytes = readFileSync(tsvPath);
  const excelBytes = readFileSync(excelPath);
  const legacyExcelBytes = readFileSync(legacyExcelPath);

  const rejected = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: {
      kind: "file",
      label: "configured.csv",
      path: csvPath,
      importOptions: { delimiter: "", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    },
    backend: "polars",
    pageSize: 20,
    mode: "viewing"
  });
  assert.equal(rejected.kind, "error", "Malformed import options must fail before a session is retained.");
  if (rejected.kind === "error") {
    assert.equal(rejected.code, "invalid_request");
    assert.match(rejected.message, /delimiter must contain exactly one Unicode code point/u);
  }
  assert.equal(testing.diagnostics().sessionCount, 0, "An invalid import attempt must not retain a session.");
  await waitFor(
    () => !testing.runtimeRunning(),
    10_000,
    "the invalid import attempt to release its standalone runtime"
  );

  const cases: Array<{
    label: string;
    source: SessionSource;
    backend: "polars" | "pandas";
    expectedColumns: string[];
    expectedFirstColumn: string[];
  }> = [
    {
      label: "non-default CSV delimiter",
      source: {
        kind: "file",
        label: "configured.csv",
        path: csvPath,
        importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      },
      backend: "polars",
      expectedColumns: ["name", "value"],
      expectedFirstColumn: ["alpha", "beta"]
    },
    {
      label: "non-default TSV delimiter",
      source: {
        kind: "file",
        label: "configured.tsv",
        path: tsvPath,
        importOptions: { delimiter: "|", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      },
      backend: "pandas",
      expectedColumns: ["name", "value"],
      expectedFirstColumn: ["alpha", "beta"]
    },
    {
      label: "Excel sheet name",
      source: {
        kind: "file",
        label: "sample.xlsx",
        path: excelPath,
        importOptions: { sheetName: "Sales" }
      },
      backend: "polars",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["alpha", "beta"]
    },
    {
      label: "zero-based Excel sheet index",
      source: {
        kind: "file",
        label: "sample.xlsx",
        path: excelPath,
        importOptions: { sheetIndex: 1 }
      },
      backend: "pandas",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["alpha", "beta"]
    },
    {
      label: "BIFF Excel sheet name in Polars",
      source: {
        kind: "file",
        label: "legacy.xls",
        path: legacyExcelPath,
        importOptions: { sheetName: "second" }
      },
      backend: "polars",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["second", "résumé"]
    },
    {
      label: "BIFF Excel sheet index in Polars",
      source: {
        kind: "file",
        label: "legacy.xls",
        path: legacyExcelPath,
        importOptions: { sheetIndex: 1 }
      },
      backend: "polars",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["second", "résumé"]
    },
    {
      label: "BIFF Excel sheet name in Pandas",
      source: {
        kind: "file",
        label: "legacy.xls",
        path: legacyExcelPath,
        importOptions: { sheetName: "second" }
      },
      backend: "pandas",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["second", "résumé"]
    },
    {
      label: "BIFF Excel sheet index in Pandas",
      source: {
        kind: "file",
        label: "legacy.xls",
        path: legacyExcelPath,
        importOptions: { sheetIndex: 1 }
      },
      backend: "pandas",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["second", "résumé"]
    }
  ];
  const openedSessions: Array<{ sessionId: string; revision: number }> = [];
  try {
    for (const candidate of cases) {
      recordAcceptanceProgress(
        `verify:file-inputs:configured:${candidate.backend}:${candidate.label.replaceAll(" ", "-")}:open`
      );
      const opened = await testing.request({
        kind: "openSession",
        ...GRID_COLUMN_WINDOW,
        source: candidate.source,
        backend: candidate.backend,
        pageSize: 20,
        mode: "viewing"
      });
      assert.equal(opened.kind, "sessionOpened", `${candidate.label} must open through ${candidate.backend}.`);
      if (opened.kind !== "sessionOpened") continue;
      openedSessions.push({
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision
      });
      assert.equal(opened.metadata.backend, candidate.backend);
      assert.deepEqual(opened.metadata.source, candidate.source);
      assert.deepEqual(
        opened.metadata.schema.map((column) => column.name),
        candidate.expectedColumns
      );
      const firstColumn = opened.metadata.schema[0];
      assert.ok(firstColumn, `${candidate.label} must expose its first selected column.`);
      assert.deepEqual(gridColumnDisplays(opened.page, firstColumn.id), candidate.expectedFirstColumn);
      recordAcceptanceProgress(
        `verify:file-inputs:configured:${candidate.backend}:${candidate.label.replaceAll(" ", "-")}:opened`
      );
    }
  } finally {
    for (const session of openedSessions.reverse()) {
      const closed = await testing.request({
        kind: "closeSession",
        sessionId: session.sessionId,
        revision: session.revision
      });
      assert.equal(closed.kind, "sessionClosed");
    }
  }
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the configured import sessions to close without retaining a runtime"
  );
  assertExactBytes(readFileSync(csvPath), csvBytes, "Configured CSV import must not modify its source.");
  assertExactBytes(readFileSync(tsvPath), tsvBytes, "Configured TSV import must not modify its source.");
  assertExactBytes(readFileSync(excelPath), excelBytes, "Excel sheet selection must not modify its workbook.");
  assertExactBytes(
    readFileSync(legacyExcelPath),
    legacyExcelBytes,
    "BIFF Excel sheet selection must not modify its workbook."
  );
}

async function exercisePublicLegacyExcelImportOptions(
  testing: TestApi,
  directory: string,
  config: vscode.WorkspaceConfiguration
): Promise<void> {
  const page = await connectToEditorWorkbench();
  const source = vscode.Uri.file(path.join(directory, "legacy.xls"));
  const sourceBytes = readFileSync(source.fsPath);

  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the public BIFF import scenarios to start without a retained session or runtime"
  );

  for (const scenario of [
    {
      backend: "polars" as const
    },
    {
      backend: "pandas" as const
    }
  ] as const) {
    const checkpoint = `verify:file-inputs:configured:public-excel:${scenario.backend}`;
    await config.update("defaultBackend", scenario.backend, vscode.ConfigurationTarget.Global);
    recordAcceptanceProgress(`${checkpoint}:open`);
    await vscode.commands.executeCommand("openWrangler.openFile", source);

    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.path === source.fsPath &&
          active.metadata.backend === scenario.backend &&
          active.metadata.shape.rows === 1 &&
          active.metadata.shape.columns === 3
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      `legacy.xls to open its first worksheet automatically through the public ${scenario.backend} workflow`,
      () =>
        packagedFileOpenDiagnostics(testing, {
          sourceLabel: path.basename(source.fsPath),
          backend: scenario.backend,
          shape: { rows: 1, columns: 3 }
        })
    );

    assert.equal(
      await page.locator(".quick-input-widget:visible").filter({ hasText: "Excel sheet" }).count(),
      0,
      `The public ${scenario.backend} BIFF workflow must open its first worksheet without an import prompt.`
    );
    const initiallyActive = testing.activeSession();
    assert.ok(initiallyActive, `The public ${scenario.backend} BIFF workflow must publish an active session.`);
    const stableSessionId = initiallyActive.sessionId;
    const stableSourceIdentity = fileSourceIdentity(initiallyActive.metadata.source);
    assert.deepEqual(
      initiallyActive.metadata.source.importOptions,
      { sheetIndex: 0 },
      `The public ${scenario.backend} BIFF workflow must record its automatic first-sheet selection.`
    );
    assert.deepEqual(
      initiallyActive.metadata.schema.map((column) => column.name),
      ["name", "value", "active"],
      `The public ${scenario.backend} BIFF workflow must expose the first worksheet schema.`
    );
    const initialFirstColumn = initiallyActive.metadata.schema[0];
    assert.ok(initialFirstColumn, `The public ${scenario.backend} BIFF workflow must expose its first column.`);
    const initialGrid = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `public-biff-${scenario.backend}-initial`,
      sessionId: stableSessionId,
      revision: initiallyActive.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: initiallyActive.metadata.filterModel
    });
    assert.equal(
      initialGrid.kind,
      "page",
      `The public ${scenario.backend} BIFF workflow must return its automatic first-sheet page.`
    );
    if (initialGrid.kind !== "page") {
      throw new Error(`The public ${scenario.backend} BIFF workflow did not return its first-sheet page.`);
    }
    assert.deepEqual(
      gridColumnDisplays(initialGrid.page, initialFirstColumn.id),
      ["first"],
      `The public ${scenario.backend} BIFF workflow must initially read the first worksheet.`
    );
    assertExactBytes(
      readFileSync(source.fsPath),
      sourceBytes,
      `The public ${scenario.backend} automatic BIFF open must not modify its source.`
    );
    recordAcceptanceProgress(`${checkpoint}:opened-first-sheet`);

    recordAcceptanceProgress(`${checkpoint}:change-sheet`);
    const changingSheet = vscode.commands.executeCommand("openWrangler.changeImportOptions");
    await acceptSearchableExcelSheet(page, testing, source, stableSessionId, "second");
    await changingSheet;
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === stableSessionId &&
          active.metadata.source.path === source.fsPath &&
          active.metadata.backend === scenario.backend &&
          active.metadata.source.importOptions?.sheetName === "second" &&
          active.metadata.shape.rows === 2 &&
          active.metadata.shape.columns === 3
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      `the public ${scenario.backend} BIFF session to adopt the selected worksheet by name`,
      () =>
        packagedFileOpenDiagnostics(testing, {
          sourceLabel: path.basename(source.fsPath),
          backend: scenario.backend,
          shape: { rows: 2, columns: 3 }
        })
    );

    const active = testing.activeSession();
    assert.ok(active, `The reconfigured public ${scenario.backend} BIFF workflow must remain active.`);
    assert.equal(
      active.sessionId,
      stableSessionId,
      `The public ${scenario.backend} worksheet change must retain the public session identity.`
    );
    assert.deepEqual(
      fileSourceIdentity(active.metadata.source),
      stableSourceIdentity,
      `The public ${scenario.backend} worksheet change must retain the exact source identity.`
    );
    assert.deepEqual(
      active.metadata.source.importOptions,
      { sheetName: "second" },
      `The public ${scenario.backend} BIFF workflow must preserve its selected worksheet name.`
    );
    assert.deepEqual(
      active.metadata.schema.map((column) => column.name),
      ["name", "value", "active"],
      `The public ${scenario.backend} BIFF workflow must expose the selected worksheet schema.`
    );
    assert.equal(
      testing.diagnostics().sessions.filter((session) => session.publicId === stableSessionId).length,
      1,
      `The public ${scenario.backend} worksheet change must retain exactly one private session owner.`
    );
    const firstColumn = active.metadata.schema[0];
    assert.ok(firstColumn, `The public ${scenario.backend} BIFF workflow must expose its first column.`);
    const grid = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `public-biff-${scenario.backend}-second`,
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: active.metadata.filterModel
    });
    assert.equal(grid.kind, "page", `The public ${scenario.backend} BIFF workflow must return a live grid page.`);
    if (grid.kind !== "page") {
      throw new Error(`The public ${scenario.backend} BIFF workflow did not return a page.`);
    }
    assert.deepEqual(
      gridColumnDisplays(grid.page, firstColumn.id),
      ["second", "résumé"],
      `The public ${scenario.backend} BIFF workflow must read the selected worksheet.`
    );
    assertExactBytes(
      readFileSync(source.fsPath),
      sourceBytes,
      `The public ${scenario.backend} BIFF workflow must not modify its source.`
    );
    recordAcceptanceProgress(`${checkpoint}:changed-sheet`);

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `the public ${scenario.backend} BIFF session and runtime to close`
    );
    assert.equal(
      testing.activeSession(),
      undefined,
      `Closing the public ${scenario.backend} BIFF panel must deactivate it.`
    );
    assertExactBytes(
      readFileSync(source.fsPath),
      sourceBytes,
      `Closing the public ${scenario.backend} BIFF workflow must leave its source byte-identical.`
    );
    recordAcceptanceProgress(`${checkpoint}:closed`);
  }
}

async function exerciseCorruptFileFailures(
  testing: TestApi,
  directory: string,
  config: vscode.WorkspaceConfiguration
): Promise<void> {
  await config.update("defaultBackend", "auto", vscode.ConfigurationTarget.Global);
  for (const name of ["damaged.csv", "damaged.jsonl", "damaged.parquet", "damaged.xls"]) {
    const uri = vscode.Uri.file(path.join(directory, name));
    const sourceBytes = readFileSync(uri.fsPath);
    const generationBeforeOpen = testing.runtimeGeneration();
    recordAcceptanceProgress(`verify:file-inputs:corrupt:${path.extname(name).slice(1)}:open`);
    await vscode.commands.executeCommand("vscode.openWith", uri, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitFor(
      () =>
        testing.runtimeGeneration() > generationBeforeOpen &&
        testing.diagnostics().sessionCount === 0 &&
        !testing.runtimeRunning(),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      `${name} to fail without retaining a session or runtime`
    );
    assert.equal(testing.activeSession(), undefined, `${name} must not publish an active session.`);
    assertExactBytes(readFileSync(uri.fsPath), sourceBytes, `${name} must remain byte-identical after a failed open.`);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `${name} failure panel to close without retained runtime state`
    );
    recordAcceptanceProgress(`verify:file-inputs:corrupt:${path.extname(name).slice(1)}:closed`);
  }
}

async function waitForOpenWranglerWebviewButton(
  workbench: Page,
  name: string,
  requireEnabled = false
): Promise<Locator> {
  return (await waitForOpenWranglerWebviewAction(workbench, name, requireEnabled)).action;
}

interface OpenWranglerWebviewAction {
  target: OpenWranglerWebviewTarget;
  action: Locator;
}

async function waitForOpenWranglerWebviewAction(
  workbench: Page,
  name: string,
  requireEnabled = false
): Promise<OpenWranglerWebviewAction> {
  return waitForReplaceableWebviewAction({
    name,
    requireEnabled,
    discoveryTimeoutMs: OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
    diagnosticTimeoutMs: WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
    findCurrent: (deadline) =>
      findCurrentOpenWranglerWebviewAction(workbench, workbench.context().browser(), name, requireEnabled, deadline),
    diagnose: async (failureDeadline) => {
      const browser = workbench.context().browser();
      assertOpenWranglerWebviewLifecycle(workbench, browser);
      return openWranglerWebviewDiagnostics(workbench, browser, name, failureDeadline);
    },
    assertLifecycle: () => assertOpenWranglerWebviewLifecycle(workbench, workbench.context().browser())
  });
}

async function findCurrentOpenWranglerWebviewAction(
  workbench: Page,
  browser: Browser | null,
  name: string,
  requireEnabled: boolean,
  deadline: number
): Promise<OpenWranglerWebviewAction | undefined> {
  return findCurrentWebviewAction({
    name,
    requireEnabled,
    deadline,
    targets: () => openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT),
    isRetired: (target) => isRetiredRendererTarget(workbench, target.page, target.frame),
    actionForTarget: (target, accessibleName) =>
      target.frame.getByRole("button", { name: accessibleName, exact: true }).first(),
    probe: probeRendererButtonReadiness,
    withinDeadline: withAcceptanceOperationDeadline,
    assertLifecycle: () => assertOpenWranglerWebviewLifecycle(workbench, browser),
    ignoreProbeFailure: (target, error) =>
      ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error)
  });
}

interface OpenWranglerWebviewTarget {
  page: Page;
  frame: Frame;
  pageIndex: number;
  frameIndex: number;
  isWorkbenchPage: boolean;
  isMainFrame: boolean;
  protocol: string;
  isWebview: boolean;
  isOpenWranglerWebview: boolean;
}

function openWranglerWebviewTargets(
  workbench: Page,
  browser: Browser | null,
  limit: number
): OpenWranglerWebviewTarget[] {
  const discovered = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  const pages = [workbench, ...discovered.filter((candidate) => candidate !== workbench && !candidate.isClosed())];
  const uniquePages = pages.filter((candidate, index) => pages.indexOf(candidate) === index);
  const targets: OpenWranglerWebviewTarget[] = [];
  for (const [pageIndex, candidate] of uniquePages.entries()) {
    if (candidate !== workbench && candidate.isClosed()) continue;
    const frames = candidate
      .frames()
      .map((frame, frameIndex) => ({ frame, frameIndex, classification: classifyRendererUrl(frame.url()) }));
    for (const { frame, frameIndex, classification } of frames) {
      targets.push({
        page: candidate,
        frame,
        pageIndex,
        frameIndex,
        isWorkbenchPage: candidate === workbench,
        isMainFrame: frame === candidate.mainFrame(),
        ...classification
      });
    }
  }
  return prioritizeNewestRendererTargets(targets, limit);
}

function assertOpenWranglerWebviewLifecycle(workbench: Page, browser: Browser | null): void {
  if (workbench.isClosed()) throw new Error("The editor workbench closed during Open Wrangler webview discovery.");
  if (browser !== null && !browser.isConnected()) {
    throw new Error("The editor CDP browser disconnected during Open Wrangler webview discovery.");
  }
}

function activeEditorTabDiagnostic(): Record<string, boolean | string> {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  const constructorName =
    typeof input === "object" && input !== null
      ? (input as { constructor?: { name?: unknown } }).constructor?.name
      : undefined;
  const viewType =
    typeof input === "object" &&
    input !== null &&
    "viewType" in input &&
    typeof (input as { viewType?: unknown }).viewType === "string"
      ? (input as { viewType: string }).viewType
      : "";
  return {
    label: tab?.label ?? "",
    inputType: typeof constructorName === "string" ? constructorName : typeof input,
    viewType,
    isOpenWranglerSession: tab ? isOpenWranglerSessionTab(tab) : false
  };
}

async function openWranglerGridDiagnostics(
  workbench: Page,
  browser: Browser | null,
  expectedSessionId: string,
  deadline?: number
): Promise<unknown> {
  const allTargets = openWranglerWebviewTargets(workbench, browser, Number.MAX_SAFE_INTEGER);
  const targets = allTargets.slice(0, OPEN_WRANGLER_WEBVIEW_DIAGNOSTIC_TARGET_LIMIT);
  const summary = {
    totalTargets: allTargets.length,
    openWranglerTargets: allTargets.filter((target) => target.isOpenWranglerWebview).length,
    diagnosedTargets: targets.length
  };
  const remainingMs = deadline === undefined ? WORKBENCH_DIAGNOSTIC_TIMEOUT_MS : deadline - Date.now();
  if (remainingMs <= 0) return { ...summary, targets: "unavailable within the diagnostics deadline" };
  try {
    const targetsState = await withAcceptanceOperationDeadline(
      Promise.all(
        targets.map(async (target) => {
          if (isRetiredRendererTarget(workbench, target.page, target.frame)) {
            return rendererTargetDiagnostic(target, { retired: true, attached: false });
          }
          try {
            const apps = target.frame.locator("main.app");
            const sessionIds = (
              await target.frame.locator("main.app[data-session-id]").evaluateAll((elements) =>
                elements
                  .map((element) => element.getAttribute("data-session-id") ?? "")
                  .filter((sessionId) => sessionId.length > 0)
                  .slice(0, 4)
              )
            ).join(",");
            const exactApp = await exactSessionApp(target.frame, expectedSessionId);
            const exactGrid = exactApp?.locator('[data-testid="data-grid-scroller"] [role="grid"]').first();
            const [roots, appCount, gridCount, exactAppVisible, exactGridCount, exactGridVisible] = await Promise.all([
              target.frame.locator("#root").count(),
              apps.count(),
              target.frame.locator('[data-testid="data-grid-scroller"] [role="grid"]').count(),
              exactApp?.isVisible() ?? Promise.resolve(false),
              exactGrid?.count() ?? Promise.resolve(0),
              exactGrid?.isVisible() ?? Promise.resolve(false)
            ]);
            return rendererTargetDiagnostic(target, {
              retired: false,
              attached: !target.frame.isDetached(),
              roots,
              apps: appCount,
              grids: gridCount,
              sessionIds,
              exactAppVisible,
              exactGridCount,
              exactGridVisible
            });
          } catch (error) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
            return rendererTargetDiagnostic(target, { retired: true, attached: false });
          }
        })
      ),
      remainingMs,
      "bounded exact-session Open Wrangler grid diagnostics"
    );
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    return { ...summary, targets: targetsState };
  } catch (error) {
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    if (error instanceof Error && error.message.startsWith("Timed out waiting for bounded exact-session")) {
      return { ...summary, targets: "unavailable within the diagnostics deadline" };
    }
    throw error;
  }
}

async function openWranglerWebviewDiagnostics(
  workbench: Page,
  browser: Browser | null,
  name: string,
  deadline: number
): Promise<unknown> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return "unavailable within the diagnostics deadline";
  const targets = openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_DIAGNOSTIC_TARGET_LIMIT);
  try {
    const diagnostics = await withAcceptanceOperationDeadline(
      Promise.all(
        targets.map(async (target) => {
          if (isRetiredRendererTarget(workbench, target.page, target.frame)) {
            return rendererTargetDiagnostic(target, { retired: true });
          }
          try {
            const button = target.frame.getByRole("button", { name, exact: true });
            const [readyState, roots, appWorkspaces, contentSecurityPolicies, scripts, buttons] = await Promise.all([
              target.frame.locator(":root").evaluate((root) => root.ownerDocument.readyState),
              target.frame.locator("#root").count(),
              target.frame.locator('[data-testid="app-workspace"]').count(),
              target.frame.locator('meta[http-equiv="Content-Security-Policy"]').count(),
              target.frame.locator("script").count(),
              button.count()
            ]);
            const firstButton = button.first();
            const firstButtonVisible = buttons > 0 ? await firstButton.isVisible() : false;
            const firstButtonEnabled = buttons > 0 ? await firstButton.isEnabled() : false;
            const firstButtonAriaBusy = buttons > 0 ? ((await firstButton.getAttribute("aria-busy")) ?? "") : "";
            return rendererTargetDiagnostic(target, {
              readyState:
                readyState === "loading" || readyState === "interactive" || readyState === "complete"
                  ? readyState
                  : "unavailable",
              roots,
              appWorkspaces,
              contentSecurityPolicies,
              scripts,
              buttons,
              firstButtonVisible,
              firstButtonEnabled,
              firstButtonAriaBusy
            });
          } catch (error) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
            return rendererTargetDiagnostic(target, { retired: true });
          }
        })
      ),
      remainingMs,
      "bounded Open Wrangler webview diagnostics"
    );
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    return diagnostics;
  } catch (error) {
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    if (error instanceof Error && error.message.startsWith("Timed out waiting for bounded Open Wrangler")) {
      return "unavailable within the diagnostics deadline";
    }
    throw error;
  }
}

function rendererTargetDiagnostic(
  target: OpenWranglerWebviewTarget,
  detail: Record<string, boolean | number | string>
): Record<string, boolean | number | string> {
  return {
    pageIndex: target.pageIndex,
    frameIndex: target.frameIndex,
    isWorkbenchPage: target.isWorkbenchPage,
    isMainFrame: target.isMainFrame,
    protocol: target.protocol,
    isWebview: target.isWebview,
    isOpenWranglerWebview: target.isOpenWranglerWebview,
    ...detail
  };
}

function fileSourceIdentity(source: SessionSource): Pick<SessionSource, "kind" | "label" | "path" | "uri"> {
  return {
    kind: source.kind,
    label: source.label,
    path: source.path,
    uri: source.uri
  };
}

async function acceptQuickPickOptionWithKeyboard(
  page: Page,
  quickInput: Locator,
  title: string,
  option: string,
  checkpoint?: string,
  waitForPromptToHide = true
): Promise<void> {
  const selected = quickInput.getByRole("option", { name: option }).first();
  await withAcceptanceOperationDeadline(
    selected.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${title} option ${JSON.stringify(option)} to become visible`
  );
  await waitForImportNaturalKeyboardFocus(quickInput, title, "contains");
  const optionCount = await withAcceptanceOperationDeadline(
    quickInput.getByRole("option").count(),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${title} option count`
  );
  assert.ok(
    optionCount > 0 && optionCount <= 16,
    `${title} must expose between 1 and 16 bounded options; received ${optionCount}.`
  );

  let selectedIsFocused = false;
  for (let attempt = 0; attempt <= optionCount; attempt += 1) {
    const className =
      (await withAcceptanceOperationDeadline(
        selected.getAttribute("class", { timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        `${title} option ${JSON.stringify(option)} focus state`
      )) ?? "";
    selectedIsFocused = /(?:^|\s)focused(?:\s|$)/u.test(className);
    if (selectedIsFocused) break;
    if (attempt === optionCount) break;
    await withAcceptanceOperationDeadline(
      page.keyboard.press("ArrowDown"),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      `${title} keyboard navigation to ${JSON.stringify(option)}`
    );
  }

  if (!selectedIsFocused) {
    const visibleOptions = await boundedImportOptionDiagnostics(quickInput);
    throw new Error(
      `${title} did not focus requested option ${JSON.stringify(option)} within ${optionCount} keyboard steps. ` +
        `Visible options: ${JSON.stringify(visibleOptions)}`
    );
  }
  if (checkpoint) recordAcceptanceProgress(`${checkpoint}:focused`);
  if (checkpoint) recordAcceptanceProgress(`${checkpoint}:accept`);
  await withAcceptanceOperationDeadline(
    pressKeyboardKeyPairWithoutTransitionGap(page.keyboard, "Enter"),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${title} option ${JSON.stringify(option)} keyboard acceptance`
  );
  if (waitForPromptToHide) {
    try {
      await withAcceptanceOperationDeadline(
        quickInput.waitFor({ state: "hidden", timeout: 3_000 }),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        `${title} prompt to advance`
      );
    } catch (error) {
      const visibleOptions = await boundedImportOptionDiagnostics(quickInput);
      throw new Error(
        `${title} did not advance after accepting focused option ${JSON.stringify(option)} with Enter. ` +
          `Visible options: ${JSON.stringify(visibleOptions)}`,
        { cause: error }
      );
    }
  }
  if (checkpoint) recordAcceptanceProgress(`${checkpoint}:accepted`);
}

async function acceptSearchableExcelSheet(
  page: Page,
  testing: TestApi,
  expectedSource: vscode.Uri,
  existingSessionId: string,
  sheetName: string
): Promise<void> {
  const sheetPrompt = await waitForImportQuickInput(page, testing, expectedSource, "Excel sheet", existingSessionId);
  const field = sheetPrompt.locator(".quick-input-box input").first();
  await withAcceptanceOperationDeadline(
    field.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the searchable Excel worksheet field to become visible"
  );
  await waitForImportNaturalKeyboardFocus(sheetPrompt, "Excel sheet", "contains");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fieldOwnsFocus = await field.evaluate((element) => element === element.ownerDocument.activeElement);
    if (fieldOwnsFocus) break;
    await withAcceptanceOperationDeadline(
      page.keyboard.press("Shift+Tab"),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "keyboard traversal to the Excel worksheet search field"
    );
  }
  await waitForImportNaturalKeyboardFocus(field, "Excel sheet search", "exact");
  await withAcceptanceOperationDeadline(
    page.keyboard.type(sheetName),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `keyboard entry for the Excel worksheet search ${JSON.stringify(sheetName)}`
  );
  assert.equal(
    await field.inputValue({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    sheetName,
    "The Excel worksheet picker must accept a searchable worksheet query."
  );
  await acceptQuickPickOptionWithKeyboard(page, sheetPrompt, "Excel sheet", sheetName);
}

function packagedFileOpenDiagnostics(
  testing: TestApi,
  expected: {
    sourceLabel: string;
    backend: "polars" | "duckdb" | "pandas";
    shape: { rows: number; columns: number };
  }
): string {
  const active = testing.activeSession();
  const diagnostics = testing.diagnostics();
  return JSON.stringify({
    expected,
    configuredOpenTimeoutMs: getSetting("sessionOpenTimeoutMs", DEFAULT_SESSION_OPEN_TIMEOUT_MS),
    runtimeRunning: testing.runtimeRunning(),
    runtimeGeneration: testing.runtimeGeneration(),
    sessionCount: diagnostics.sessionCount,
    sessions: diagnostics.sessions.map(({ sourceLabel }) => sourceLabel),
    active: active
      ? {
          sourceLabel: active.metadata.source.label,
          backend: active.metadata.backend,
          shape: active.metadata.shape
        }
      : undefined
  });
}

async function exerciseRuntimeSelectionCommands(testing: TestApi, fixture: vscode.Uri, python: string): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-runtime-selection-"));
  const invocationLog = path.join(directory, "python-invocations.log");
  const isolatedPython = createDependencyIsolatedPython(directory, python, invocationLog);
  const config = vscode.workspace.getConfiguration("openWrangler");
  const originalWorkspacePythonPath = config.inspect<string>("pythonPath")?.workspaceValue;
  const lossySource = {
    ...csvSource(fixture),
    importOptions: {
      delimiter: ",",
      encoding: "utf8-lossy",
      quoteChar: '"',
      hasHeader: true
    }
  } as const;
  const legacySource = {
    kind: "file",
    label: "legacy.xls",
    path: path.join(directory, "legacy.xls"),
    importOptions: { sheetIndex: 0 }
  } as const;
  const lossyRequirement = requiredDependencies("pandas", lossySource)[0].installSpec;
  const legacyRequirements = requiredDependencies("pandas", legacySource).map((dependency) => dependency.installSpec);
  const legacyRequirementList = legacyRequirements.join(", ");

  try {
    assert.equal(await vscode.commands.executeCommand("openWrangler.changeRuntime", isolatedPython), isolatedPython);
    assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, isolatedPython);

    const rejected = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "polars",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejected.kind, "error");
    if (rejected.kind === "error") {
      assert.equal(rejected.code, "missing_dependencies");
      assert.match(rejected.message, /Missing: polars>=1\.35\.2,<2\.$/u);
      assert.match(rejected.detail ?? "", /Install Runtime Dependencies/);
    }
    const rejectedDuckDB = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "duckdb",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejectedDuckDB.kind, "error");
    if (rejectedDuckDB.kind === "error") {
      assert.equal(rejectedDuckDB.code, "missing_dependencies");
      assert.match(
        rejectedDuckDB.message,
        /Missing: duckdb>=1\.5\.4,<1\.6, fsspec==2026\.7\.0, pytz>=2026\.3\.post1,<2027\.$/u
      );
      assert.match(rejectedDuckDB.detail ?? "", /Install Runtime Dependencies/);
    }
    const rejectedLossyUtf8 = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: lossySource,
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejectedLossyUtf8.kind, "error");
    if (rejectedLossyUtf8.kind === "error") {
      assert.equal(rejectedLossyUtf8.code, "missing_dependencies");
      assert.equal(rejectedLossyUtf8.message.endsWith(`Missing: ${lossyRequirement}.`), true);
      assert.doesNotMatch(rejectedLossyUtf8.message, /polars|duckdb/iu);
      assert.match(rejectedLossyUtf8.detail ?? "", /Install Runtime Dependencies/);
    }
    const rejectedLegacyExcel = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: legacySource,
      backend: "pandas",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejectedLegacyExcel.kind, "error");
    if (rejectedLegacyExcel.kind === "error") {
      assert.equal(rejectedLegacyExcel.code, "missing_dependencies");
      assert.equal(rejectedLegacyExcel.message.includes(`Missing: ${legacyRequirementList}`), true);
      assert.doesNotMatch(rejectedLegacyExcel.message, /openpyxl/);
      assert.match(rejectedLegacyExcel.detail ?? "", /Install Runtime Dependencies/);
    }
    assert.equal(testing.runtimeRunning(), false, "Missing dependencies must fail before runtime startup.");
    const invocationsBeforeDecline = readFileSync(invocationLog, "utf8");
    const generationBeforeDecline = testing.runtimeGeneration();
    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      const page = await connectToEditorWorkbench();
      const commandOutcome = vscode.commands
        .executeCommand<boolean>("openWrangler.installRuntimeDependencies", true)
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      const earlyOutcome = await Promise.race([
        commandOutcome.then((outcome) => ({ kind: "settled" as const, outcome })),
        new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 500))
      ]);
      assert.equal(
        earlyOutcome.kind,
        "pending",
        `The public dependency command must wait for its real modal, not settle from a caller argument: ${JSON.stringify(earlyOutcome)}`
      );
      const { page: confirmationPage, dialog: confirmation } = await waitForVisibleEditorDialog(
        page,
        `Install ${legacyRequirementList}`
      );
      try {
        await confirmationPage.bringToFront();
        const confirmationMessage = await confirmation.locator(".dialog-message-text").innerText();
        const confirmationDetail = await confirmation.locator(".dialog-message-detail").innerText();
        assert.equal(
          confirmationMessage,
          `Install ${legacyRequirementList} into ${isolatedPython}?`,
          "The real dependency confirmation must identify the exact requirements and interpreter."
        );
        assert.equal(confirmationDetail, "Open Wrangler never installs packages without this confirmation.");
        assert.equal(
          await confirmation.getByRole("button", { name: "Install", exact: true }).count(),
          1,
          "The dependency modal must expose exactly one affirmative Install action."
        );
        await confirmationPage.keyboard.press("Escape");
        await confirmation.waitFor({ state: "hidden", timeout: 10_000 });
        const outcome = await commandOutcome;
        if (outcome.status === "rejected") throw outcome.error;
        assert.equal(
          outcome.value,
          false,
          "A hostile truthy command argument must not bypass the real dependency confirmation."
        );
      } finally {
        if (await confirmation.isVisible().catch(() => false)) {
          await confirmationPage.bringToFront();
          await confirmationPage.keyboard.press("Escape");
          await confirmation.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
        }
      }
    } else {
      assert.equal(
        await testing.declineRuntimeDependencyInstallation(),
        false,
        "The gated non-UI test path must decline without installing dependencies."
      );
    }
    assert.equal(
      readFileSync(invocationLog, "utf8"),
      invocationsBeforeDecline,
      "Declining dependency installation must not invoke the selected Python environment."
    );
    assert.equal(
      testing.runtimeGeneration(),
      generationBeforeDecline,
      "Declining dependency installation must not restart the runtime."
    );
    assert.equal(testing.runtimeRunning(), false, "Declining dependency installation must not start the runtime.");
    assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, isolatedPython);

    assert.equal(await vscode.commands.executeCommand("openWrangler.clearRuntime"), true);
    assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, undefined);
    assert.equal(getSetting("pythonPath", ""), python, "Clearing the workspace override must reveal the fallback.");
  } finally {
    try {
      await config.update("pythonPath", originalWorkspacePythonPath, vscode.ConfigurationTarget.Workspace);
    } finally {
      cleanupAcceptanceTemporaryDirectory(directory);
    }
  }
}

type DependencyGuardCleanupLeg = "guard" | "parent";

function dependencyGuardCleanupOrder(authorized: boolean): readonly DependencyGuardCleanupLeg[] {
  return authorized ? ["guard", "parent"] : ["parent", "guard"];
}

const exerciseDependencyMutationRecovery = createDependencyMutationRecoveryJourney({
  DEPENDENCY_GUARD_HOSTILE_TOKEN,
  GRID_COLUMN_WINDOW,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
  assertDependencyRecoveryDialog,
  connectToEditorWorkbench,
  crashAcceptanceGuardParent,
  csvSource,
  dependencyGuardCleanupOrder,
  settleOrphanedAcceptanceGuard,
  waitFor,
  waitForAcceptanceGuardRelease,
  waitForVisibleEditorDialog
});

async function assertDependencyRecoveryDialog(dialog: Locator, executable: string): Promise<void> {
  assert.equal(
    await dialog.locator(".dialog-message-text").innerText(),
    `Revalidate runtime dependencies in ${executable}?`
  );
  assert.equal(
    await dialog.locator(".dialog-message-detail").innerText(),
    "Open Wrangler found an interrupted dependency change. Revalidation waits for any package writer to exit, imports and version-checks the recorded dependencies, and clears the retained recovery marker only if every check succeeds. It does not install, remove, or overwrite packages."
  );
  assert.equal(
    await dialog.getByRole("button", { name: "Revalidate", exact: true }).count(),
    1,
    "The dependency-recovery modal must expose exactly one affirmative Revalidate action."
  );
}

const exercisePackagedExcelDependencyInstall = createPackagedExcelDependencyInstallJourney({
  OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
  activeEditorTabDiagnostic,
  assertOpenWranglerWebviewLifecycle,
  closeVisibleWorkbenchPart,
  connectToEditorWorkbench,
  excelDependencyInstallDiagnostics,
  findCurrentOpenWranglerGridTarget,
  recordAcceptanceProgress,
  waitFor,
  waitForOpenWranglerWebviewAction,
  waitForVisibleEditorDialog
});

function excelDependencyInstallDiagnostics(
  testing: TestApi,
  expectedSourcePath: string,
  expectedExecutable: string,
  markerExists: boolean,
  invocationExists: boolean
): string {
  const active = testing.activeSession();
  const response = testing.panelOpenResponse();
  const runtimeEnvironment = testing.runtimeEnvironment();
  return JSON.stringify({
    active:
      active === undefined
        ? null
        : {
            backend: active.metadata.backend,
            shape: active.metadata.shape,
            sourceMatches: active.metadata.source.path === expectedSourcePath
          },
    coordinator: testing.diagnostics(),
    invocationExists,
    markerExists,
    response:
      response === undefined
        ? null
        : response.kind === "sessionOpened"
          ? {
              backend: response.metadata.backend,
              kind: response.kind,
              shape: response.metadata.shape,
              sourceMatches: response.metadata.source.path === expectedSourcePath
            }
          : response.kind === "error"
            ? { code: response.code, kind: response.kind, recoverable: response.recoverable }
            : { kind: response.kind },
    runtimeEnvironment:
      runtimeEnvironment === undefined
        ? null
        : {
            executableMatches: sameAcceptanceExecutable(runtimeEnvironment.executable, expectedExecutable),
            source: runtimeEnvironment.source,
            version: runtimeEnvironment.version
          },
    runtimeRunning: testing.runtimeRunning()
  });
}

const PINNED_REAL_PYTHON_EXTENSION_VERSION = "2026.4.0";

async function exerciseRealPythonEnvironmentSelection(
  testing: TestApi,
  workspace: vscode.Uri,
  fixture: vscode.Uri,
  python: string,
  openWranglerExtensionPath: string
): Promise<void> {
  const pythonExtension = vscode.extensions.getExtension<PythonExtension>("ms-python.python");
  assert.ok(pythonExtension, "The opt-in acceptance phase must install the released Python extension.");
  assert.equal(
    pythonExtension.packageJSON.version,
    PINNED_REAL_PYTHON_EXTENSION_VERSION,
    "Real environment-selection acceptance must run against the pinned stable Python extension."
  );
  const pythonApi = await pythonExtension.activate();
  await pythonApi.ready;
  assert.equal(
    typeof pythonApi.environments.updateActiveEnvironmentPath,
    "function",
    "The released Python extension must expose its stable environment-selection API."
  );
  assert.equal(
    typeof pythonApi.environments.onDidChangeActiveEnvironmentPath,
    "function",
    "The released Python extension must expose active-environment change notifications."
  );

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(fixture);
  assert.ok(workspaceFolder, "The Python-environment fixture must belong to the isolated workspace.");
  assert.equal(workspaceFolder.uri.toString(), workspace.toString());
  const config = vscode.workspace.getConfiguration("openWrangler", fixture);
  await config.update("pythonPath", undefined, vscode.ConfigurationTarget.Global);
  await config.update("pythonPath", undefined, vscode.ConfigurationTarget.Workspace);
  assert.equal(
    getSetting("pythonPath", "", fixture),
    "",
    "The real Python-extension phase must not bypass environment selection with an Open Wrangler override."
  );

  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-real-python-environments-"));
  const environmentA = createInstrumentedPythonEnvironment(path.join(directory, "environment-a"), python, "a");
  const environmentB = createInstrumentedPythonEnvironment(path.join(directory, "environment-b"), python, "b");
  const runtimeRoot = path.join(openWranglerExtensionPath, "python");
  assert.equal(
    existsSync(path.join(runtimeRoot, "openwrangler_runtime", "server.py")),
    true,
    "The packaged Open Wrangler runtime must exist before instrumented environment acceptance."
  );
  verifyInstrumentedPythonEnvironmentMarker(environmentA, runtimeRoot);
  verifyInstrumentedPythonEnvironmentMarker(environmentB, runtimeRoot);
  const originalSource = readFileSync(fixture.fsPath);
  const expectedFirstRowScore = "21.0";
  let sessionId: string | undefined;
  let revision = 0;

  try {
    recordAcceptanceProgress("python-environment:select-a");
    await pythonApi.environments.updateActiveEnvironmentPath(environmentA.executable, workspaceFolder);
    await waitForSelectedPythonEnvironment(pythonApi, workspaceFolder, environmentA.executable);

    recordAcceptanceProgress("python-environment:open-a");
    const opened = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "polars",
      pageSize: 20,
      mode: "editing"
    });
    assert.equal(opened.kind, "sessionOpened", `Environment A failed to open the fixture: ${JSON.stringify(opened)}`);
    if (opened.kind !== "sessionOpened") return;
    sessionId = opened.metadata.sessionId;
    revision = opened.metadata.revision;

    const preview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision,
      step: {
        id: "real-python-environment-score",
        kind: "formula",
        params: {
          leftColumn: columnReference(opened.metadata, "sales"),
          operator: "multiply",
          value: 2,
          newColumn: "score"
        }
      },
      offset: 0,
      limit: 20
    });
    assert.equal(preview.kind, "stepPreview");
    if (preview.kind !== "stepPreview") return;
    revision = preview.revision;
    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision,
      offset: 0,
      limit: 20
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") return;
    revision = applied.revision;
    assert.equal(applied.page.rows[0]?.values[4]?.display, expectedFirstRowScore);
    await waitFor(
      () => instrumentedRuntimeStarts(environmentA) >= 1,
      10_000,
      "environment A to launch the Open Wrangler runtime"
    );
    const generationA = testing.runtimeGeneration();
    assert.ok(generationA > 0);

    recordAcceptanceProgress("python-environment:switch-b");
    await pythonApi.environments.updateActiveEnvironmentPath(environmentB.executable, workspaceFolder);
    await waitForSelectedPythonEnvironment(pythonApi, workspaceFolder, environmentB.executable);
    await waitFor(
      () => !testing.runtimeRunning(),
      30_000,
      "the environment-A runtime to stop after the workspace selection changed"
    );

    recordAcceptanceProgress("python-environment:recover-b");
    const recoveredB = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "real-python-environment-b",
      sessionId,
      revision,
      offset: 0,
      limit: 20,
      filterModel: applied.metadata.filterModel
    });
    assert.equal(recoveredB.kind, "page", `Environment B recovery failed: ${JSON.stringify(recoveredB)}`);
    if (recoveredB.kind !== "page") return;
    revision = recoveredB.revision;
    assert.deepEqual(
      recoveredB.metadata.steps.map((step) => step.id),
      ["real-python-environment-score"],
      "The committed plan must replay after the selected Python environment changes."
    );
    assert.equal(recoveredB.page.rows[0]?.values[4]?.display, expectedFirstRowScore);
    await waitFor(
      () => instrumentedRuntimeStarts(environmentB) >= 1,
      10_000,
      "environment B to launch the recovered Open Wrangler runtime"
    );
    assert.equal(
      testing.runtimeGeneration(),
      generationA + 1,
      "One workspace environment switch must create exactly one replacement runtime."
    );

    recordAcceptanceProgress("python-environment:switch-a");
    await pythonApi.environments.updateActiveEnvironmentPath(environmentA.executable, workspaceFolder);
    await waitForSelectedPythonEnvironment(pythonApi, workspaceFolder, environmentA.executable);
    await waitFor(() => !testing.runtimeRunning(), 30_000, "the environment-B runtime to stop after switching back");

    recordAcceptanceProgress("python-environment:recover-a");
    const recoveredA = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "real-python-environment-a-return",
      sessionId,
      revision,
      offset: 0,
      limit: 20,
      filterModel: recoveredB.metadata.filterModel
    });
    assert.equal(recoveredA.kind, "page", `Environment A replay failed: ${JSON.stringify(recoveredA)}`);
    if (recoveredA.kind !== "page") return;
    revision = recoveredA.revision;
    assert.deepEqual(
      recoveredA.metadata.steps.map((step) => step.id),
      ["real-python-environment-score"]
    );
    assert.equal(recoveredA.page.rows[0]?.values[4]?.display, expectedFirstRowScore);
    await waitFor(
      () => instrumentedRuntimeStarts(environmentA) >= 2,
      10_000,
      "environment A to launch the second recovered runtime"
    );
    assert.equal(
      testing.runtimeGeneration(),
      generationA + 2,
      "Switching back must create exactly one further replacement runtime."
    );
    assertExactBytes(readFileSync(fixture.fsPath), originalSource, "Environment recovery must not modify the source.");
  } finally {
    if (sessionId) {
      await testing
        .request({
          kind: "closeSession",
          sessionId,
          revision
        })
        .catch(() => undefined);
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        30_000,
        "the real Python-environment session and runtime to close"
      );
    }
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function waitForSelectedPythonEnvironment(
  pythonApi: PythonExtension,
  resource: vscode.WorkspaceFolder,
  expectedExecutable: string
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 30_000) {
    const active = pythonApi.environments.getActiveEnvironmentPath(resource);
    const resolved = await pythonApi.environments.resolveEnvironment(active);
    const selectedExecutable = resolved?.executable.uri?.fsPath ?? active.path;
    if (sameAcceptanceExecutable(selectedExecutable, expectedExecutable)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the released Python extension to publish the selected environment.");
}

async function settleOrphanedAcceptanceGuard(fixture: DependencyGuardRecoveryFixture, pid: number): Promise<void> {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  createAcceptanceSignalExclusively(fixture.pipRelease, "release\n");
  if (existsSync(fixture.pipStarted) && !existsSync(fixture.pipCompleted)) {
    await waitFor(
      () => existsSync(fixture.pipCompleted),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      `the exact orphaned dependency guard ${pid} to finish its guarded writer during cleanup`
    );
  }
  await waitForAcceptanceGuardRelease(
    fixture,
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `the exact orphaned dependency guard ${pid} to release its environment during cleanup`
  );
}

async function waitForAcceptanceGuardRelease(
  fixture: DependencyGuardRecoveryFixture,
  timeoutMs: number,
  expectation: string
): Promise<Record<string, unknown>> {
  let releasedStatus: Record<string, unknown> | undefined;
  await waitFor(
    () => {
      try {
        const status = readAcceptanceGuardStatus(fixture);
        const released =
          status.protocol === DEPENDENCY_GUARD_PROTOCOL &&
          status.kind === "status" &&
          ((status.state === "dirty" && status.token === DEPENDENCY_GUARD_ACCEPTANCE_TOKEN) ||
            (status.state === "clean" && status.token === null));
        if (released) releasedStatus = status;
        return released;
      } catch {
        return false;
      }
    },
    timeoutMs,
    expectation
  );
  assert.ok(releasedStatus, "Dependency-guard release polling completed without an exact status.");
  return releasedStatus;
}

async function crashAcceptanceGuardParent(
  process: AcceptanceGuardProcess,
  crashFrame: string,
  description: string
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  if (!process.closed) {
    assert.ok(
      process.parentPid !== undefined && process.parentPid > 0,
      `${description} cannot be crashed before its exact Python PID is published.`
    );
    assert.ok(
      !process.child.stdin.destroyed && process.child.stdin.writable,
      `${description} no longer owns a writable crash channel.`
    );
    process.child.stdin.end(Buffer.from(crashFrame, "ascii"));
  }
  const result = await withAcceptanceOperationDeadline(
    process.exit,
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${description} to close`
  );
  const failureDetail = result.stderr.trim() ? ` stderr=${JSON.stringify(result.stderr.trim())}` : "";
  assert.equal(
    result.code,
    DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE,
    `${description} did not exit through its exact crash frame.${failureDetail}`
  );
  assert.equal(result.signal, null, `${description} was terminated by an unexpected signal.`);
  return result;
}

async function exercisePackagedViewingQueries(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  const original = readFileSync(fixture.fsPath, "utf8");
  const filterModel: FilterModel = {
    logic: "or",
    filters: [
      {
        column: "city",
        type: "string",
        predicates: [{ kind: "predicate", operator: "startsWith", value: "M" }]
      },
      {
        column: "sales",
        type: "float",
        predicates: [{ kind: "predicate", operator: "gt", value: 11 }]
      }
    ],
    sort: [
      { column: "active", direction: "asc", nulls: "last" },
      { column: "sales", direction: "desc", nulls: "last" }
    ]
  };

  for (const backend of ["pandas", "polars", "duckdb"] as const) {
    const opened = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend,
      pageSize: 2,
      mode: "viewing"
    });
    assert.equal(opened.kind, "sessionOpened", `${backend} viewing session must open.`);
    if (opened.kind !== "sessionOpened") continue;

    const page = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `${backend}-filter-page`,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 2,
      filterModel
    });
    assert.equal(page.kind, "page", `${backend} advanced filter and multi-sort must return a page.`);
    if (page.kind !== "page") continue;
    assert.equal(page.page.totalRows, 2);
    assert.deepEqual(
      page.page.rows.map((row) => row.values[0]?.display),
      ["Berlin", "Milan"]
    );
    assert.equal(page.metadata.steps.length, 0, "Viewing queries must not become cleaning steps.");
    assert.deepEqual(page.metadata.filterModel, filterModel);

    const summary = await testing.request({
      kind: "getSummary",
      viewRequestId: `${backend}-filter-summary`,
      sessionId: opened.metadata.sessionId,
      revision: page.revision,
      filterModel
    });
    assert.equal(summary.kind, "summary", `${backend} progressive summary must resolve.`);
    if (summary.kind === "summary") {
      assert.equal(summary.summaries.length, 4);
      assert.ok(summary.summaries.every((column) => column.totalCount === 2));
      assert.equal(summary.summaries.find((column) => column.column === "sales")?.numeric?.max, 12);
    }

    const stats = await testing.request({
      kind: "getDatasetStats",
      viewRequestId: `${backend}-filter-stats`,
      sessionId: opened.metadata.sessionId,
      revision: page.revision,
      filterModel
    });
    assert.equal(stats.kind, "datasetStats", `${backend} exact dataset stats must resolve.`);
    if (stats.kind === "datasetStats") {
      assert.equal(stats.stats.missingCells, 0);
      assert.equal(stats.stats.missingRows, 0);
      assert.equal(stats.stats.duplicateRows, 0);
    }

    const values = await testing.request({
      kind: "getColumnValues",
      viewRequestId: `${backend}-filter-values`,
      sessionId: opened.metadata.sessionId,
      revision: page.revision,
      column: "city",
      filterModel,
      search: "il",
      limit: 10
    });
    assert.equal(values.kind, "columnValues", `${backend} searchable column values must resolve.`);
    if (values.kind === "columnValues") {
      assert.deepEqual(values.values, [
        {
          value: "Milan",
          count: 1,
          selectionValue: {
            kind: "typedSelection",
            version: 1,
            columnType: "string",
            cell: { kind: "string", raw: "Milan", display: "Milan", isNull: false, isNaN: false }
          }
        }
      ]);
      assert.equal(values.hasMore, false);
    }

    assert.equal(testing.activeSession()?.metadata.steps.length, 0);
    const closed = await testing.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: page.revision
    });
    assert.equal(closed.kind, "sessionClosed");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `${backend} viewing-query session to dispose`
    );
  }

  assertExactBytes(
    readFileSync(fixture.fsPath),
    Buffer.from(original, "utf8"),
    "Viewing queries must not alter the source."
  );
}

async function exerciseWideColumnProjection(testing: TestApi): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-wide-projection-"));
  const sourcePath = path.join(directory, "wide.csv");
  const columnCount = 417;
  const farColumnOffset = columnCount - 12;
  const names = Array.from({ length: columnCount }, (_, column) => `column_${column.toString().padStart(3, "0")}`);
  const values = (row: number) => names.map((_name, column) => String(row * 1_000 + column));
  const source = [names, values(0), values(1)].map((row) => row.join(",")).join("\n") + "\n";
  writeFileSync(sourcePath, source);

  try {
    for (const backend of ["pandas", "polars", "duckdb"] as const) {
      const opened = await testing.request({
        kind: "openSession",
        source: { kind: "file", label: "wide.csv", path: sourcePath },
        backend,
        pageSize: 2,
        columnOffset: 0,
        columnLimit: 16,
        mode: "viewing"
      });
      assert.equal(opened.kind, "sessionOpened", `${backend} wide projection must open.`);
      if (opened.kind !== "sessionOpened") continue;
      assert.equal(opened.metadata.shape.columns, columnCount);
      assert.deepEqual(
        opened.page.columnIds,
        opened.metadata.schema.slice(0, 16).map((column) => column.id),
        `${backend} initial transport must stay column bounded.`
      );
      assert.ok(opened.page.rows.every((row) => row.values.length === 16));

      const projected = await testing.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: `${backend}-wide-far-columns`,
        offset: 0,
        limit: 2,
        columnOffset: farColumnOffset,
        columnLimit: 12,
        filterModel: {
          logic: "and",
          filters: [
            {
              column: "column_000",
              type: "integer",
              predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
            }
          ],
          sort: [{ column: "column_001", direction: "desc", nulls: "last" }]
        }
      });
      assert.equal(projected.kind, "page", `${backend} far-column block must resolve.`);
      if (projected.kind !== "page") continue;
      assert.equal(projected.page.totalRows, 1, `${backend} must filter on an untransported column.`);
      assert.deepEqual(
        projected.page.columnIds,
        projected.metadata.schema.slice(farColumnOffset, columnCount).map((column) => column.id)
      );
      assert.equal(projected.page.rows[0]?.values[0]?.display, String(1_000 + farColumnOffset));
      assert.equal(projected.page.rows[0]?.values[11]?.display, String(1_000 + columnCount - 1));
      assert.ok(projected.page.rows.every((row) => row.values.length === 12));

      const closed = await testing.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: projected.revision
      });
      assert.equal(closed.kind, "sessionClosed");
    }

    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      const sourceUri = vscode.Uri.file(sourcePath);
      const originalBackend = vscode.workspace
        .getConfiguration("openWrangler")
        .get<"auto" | "polars" | "pandas" | "duckdb">("defaultBackend", "auto");
      await vscode.workspace
        .getConfiguration("openWrangler")
        .update("defaultBackend", "polars", vscode.ConfigurationTarget.Global);
      try {
        recordAcceptanceProgress("verify:wide-projection:picker:open");
        await vscode.commands.executeCommand("openWrangler.openFile", sourceUri);
        await waitFor(
          () => {
            const active = testing.activeSession();
            // Uri.fsPath intentionally lower-cases Windows drive letters, while
            // the raw os.tmpdir() spelling used to create sourcePath need not.
            return (
              active?.metadata.source.uri === sourceUri.toString() &&
              active.metadata.backend === "polars" &&
              active.metadata.shape.rows === 2 &&
              active.metadata.shape.columns === columnCount
            );
          },
          SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
          "the public wide-schema file workflow to open every column",
          () =>
            packagedFileOpenDiagnostics(testing, {
              sourceLabel: path.basename(sourceUri.fsPath),
              backend: "polars",
              shape: { rows: 2, columns: columnCount }
            })
        );

        const active = testing.activeSession();
        assert.ok(active, "The wide-schema picker journey requires its exact active session.");
        assert.equal(
          active.metadata.source.path,
          sourceUri.fsPath,
          "The public file command must retain VS Code's canonical filesystem spelling."
        );
        const sessionId = active.sessionId;
        const finalColumn = active.metadata.schema[columnCount - 1];
        assert.ok(finalColumn, "The wide-schema picker journey requires its final column.");
        const workbench = await connectToEditorWorkbench();
        const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
        const app = await exactSessionApp(target.frame, sessionId);
        assert.ok(app, "The wide-schema picker journey requires its exact visible application.");
        const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });

        recordAcceptanceProgress("verify:wide-projection:picker:all-columns");
        await columnSearch.focus();
        const listbox = app.getByRole("listbox", { name: "Matching columns", exact: true });
        await listbox.waitFor({ state: "visible", timeout: 10_000 });
        const firstOption = listbox.getByRole("option").first();
        assert.equal(
          await firstOption.getAttribute("aria-setsize"),
          String(columnCount),
          "The real column picker must expose the complete schema instead of a 100-result subset."
        );
        assert.equal(
          await app.getByText(/Showing 100 of/u).count(),
          0,
          "The real column picker must not retain the old 100-result cap."
        );

        await columnSearch.press("End");
        const finalOption = listbox.locator(`[role="option"][aria-posinset="${columnCount}"]`);
        await finalOption.waitFor({ state: "visible", timeout: 10_000 });
        assert.match(
          (await finalOption.getAttribute("aria-label")) ?? "",
          /^column_416, /u,
          "End must reach the final column in a 417-column schema."
        );
        assert.equal(
          await finalOption.getAttribute("aria-setsize"),
          String(columnCount),
          "The final virtualized option must retain the complete result count."
        );
        assert.ok(
          (await listbox.getByRole("option").count()) < 30,
          "The complete column picker must remain DOM-bounded while exposing all results."
        );

        await columnSearch.press("Enter");
        await waitFor(
          () => testing.activeSession()?.viewState.selectedColumnId === finalColumn.id,
          10_000,
          "the real column picker to select its final schema column"
        );
        await app.locator('th[data-column="column_416"]').first().waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(
          await app.locator('th[data-column="column_416"]').first().getAttribute("aria-colindex"),
          String(columnCount + 1),
          "The selected far-right grid header must keep its full-schema ARIA coordinate."
        );

        await disposePackagedSessionPanel(testing, sessionId, "the real wide-schema picker session");
        recordAcceptanceProgress("verify:wide-projection:picker:complete");
      } finally {
        await vscode.workspace
          .getConfiguration("openWrangler")
          .update("defaultBackend", originalBackend, vscode.ConfigurationTarget.Global);
      }
    }

    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "wide projected sessions to close"
    );
    assertExactBytes(
      readFileSync(sourcePath),
      Buffer.from(source, "utf8"),
      "Wide projection must not mutate the source."
    );
  } finally {
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function exercisePackagedOperationGroups(testing: TestApi, sourceFixture: vscode.Uri): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-operation-groups-"));
  const sourcePath = path.join(directory, "operations.csv");
  const original = readFileSync(sourceFixture.fsPath, "utf8");
  writeFileSync(sourcePath, original);

  try {
    for (const backend of ["pandas", "polars", "duckdb"] as const) {
      const opened = await testing.request({
        kind: "openSession",
        ...GRID_COLUMN_WINDOW,
        source: csvSource(vscode.Uri.file(sourcePath)),
        backend,
        pageSize: 20,
        mode: "editing"
      });
      assert.equal(opened.kind, "sessionOpened", `${backend} operation-group session must open.`);
      if (opened.kind !== "sessionOpened") continue;

      let revision = opened.metadata.revision;
      let stepCount = 0;
      const steps: TransformStep[] = [
        {
          id: `${backend}-sort`,
          kind: "sortRows",
          params: { rules: [{ column: columnReference(opened.metadata, "sales"), direction: "desc", nulls: "last" }] }
        },
        {
          id: `${backend}-formula`,
          kind: "formula",
          params: {
            leftColumn: columnReference(opened.metadata, "sales"),
            operator: "multiply",
            value: 2,
            newColumn: "score"
          }
        },
        {
          id: `${backend}-text`,
          kind: "upperText",
          params: { column: columnReference(opened.metadata, "city"), newColumn: "city_upper" }
        },
        {
          id: `${backend}-numeric`,
          kind: "roundNumber",
          params: {
            column: { id: `c:step:${backend}-formula:0`, name: "score" },
            decimals: 0,
            newColumn: "rounded_score"
          }
        },
        {
          id: `${backend}-example`,
          kind: "byExample",
          params: {
            sourceColumns: [columnReference(opened.metadata, "city")],
            newColumn: "city_example",
            examples: [
              { inputs: ["Milan"], output: "MILAN" },
              { inputs: ["Rome"], output: "ROME" }
            ]
          }
        },
        {
          id: `${backend}-custom`,
          kind: "customCode",
          params: {
            code:
              backend === "pandas"
                ? 'result = df.assign(custom=df["sales"] + 1)'
                : backend === "polars"
                  ? 'result = df.with_columns((pl.col("sales") + 1).alias("custom"))'
                  : 'result = df.filter("sales IS NOT NULL")'
          }
        },
        {
          id: `${backend}-group`,
          kind: "groupBy",
          params: {
            keys: [columnReference(opened.metadata, "active")],
            aggregations: [
              { column: columnReference(opened.metadata, "sales"), operation: "sum", alias: "total_sales" }
            ]
          }
        }
      ];

      for (const step of steps) {
        const preview = await testing.request({
          kind: "previewStep",
          ...GRID_COLUMN_WINDOW,
          sessionId: opened.metadata.sessionId,
          revision,
          step,
          offset: 0,
          limit: 20
        });
        assert.equal(preview.kind, "stepPreview", `${backend} ${step.kind} must preview.`);
        if (preview.kind !== "stepPreview") break;
        assert.equal(preview.metadata.draftStep?.kind, step.kind);
        assert.match(preview.code, /def clean_data\(df\):/);
        assert.equal(preview.diff.truncated, false);
        if (backend === "polars") assert.doesNotMatch(preview.code, /to_pandas|import pandas/);
        if (backend === "duckdb") {
          assert.match(preview.code, /\bimport duckdb\b/u);
          assert.doesNotMatch(preview.code, DUCKDB_FOREIGN_ENGINE_CONVERSION);
        }
        if (step.kind === "byExample") {
          assert.ok(preview.metadata.draftStep?.params.program, "By-example preview must resolve a program.");
        }

        revision = preview.revision;
        const applied = await testing.request({
          kind: "applyDraft",
          ...GRID_COLUMN_WINDOW,
          sessionId: opened.metadata.sessionId,
          revision,
          offset: 0,
          limit: 20
        });
        assert.equal(applied.kind, "planUpdated", `${backend} ${step.kind} must apply.`);
        if (applied.kind !== "planUpdated") break;
        stepCount += 1;
        revision = applied.revision;
        assert.equal(applied.metadata.steps.length, stepCount);

        if (step.kind === "customCode") {
          const generation = testing.runtimeGeneration();
          testing.restartRuntime(`${backend} custom-code replay acceptance`);
          const replayed = await testing.request({
            kind: "getPage",
            ...GRID_COLUMN_WINDOW,
            viewRequestId: `${backend}-${step.kind}-replay-page`,
            sessionId: opened.metadata.sessionId,
            revision,
            offset: 0,
            limit: 20,
            filterModel: applied.metadata.filterModel
          });
          assert.equal(replayed.kind, "page", `${backend} custom-code plan must replay after restart.`);
          assert.equal(testing.runtimeGeneration(), generation + 1);
          if (replayed.kind === "page") revision = replayed.revision;
        }
      }

      assert.equal(stepCount, steps.length, `${backend} must apply every representative operation group.`);
      const active = testing.activeSession();
      assert.equal(active?.metadata.steps.length, steps.length);
      assert.deepEqual(
        active?.metadata.schema.map((column) => column.name),
        ["active", "total_sales"]
      );
      assert.match(active?.code ?? "", /def clean_data/u, `${backend} must retain executable generated code.`);
      if (backend === "duckdb") {
        assert.match(active?.code ?? "", /\bimport duckdb\b/u);
        assert.doesNotMatch(active?.code ?? "", DUCKDB_FOREIGN_ENGINE_CONVERSION);
      }

      const editedCode = `# edited ${backend} code preview\ndef clean_data(df):\n    return df\n`;
      const priorClipboard = await vscode.env.clipboard.readText();
      testing.setCodeForExport(editedCode);
      const copiedCode = await vscode.commands.executeCommand<string>("openWrangler.copyCode");
      assert.equal(copiedCode, editedCode, `${backend} must copy the edited code buffer.`);
      if ((await vscode.env.clipboard.readText()) === editedCode) {
        await vscode.env.clipboard.writeText(priorClipboard);
      }
      const scriptPath = path.join(directory, `${backend}.clean.py`);
      await assert.rejects(
        testing.exportCodeTo(vscode.Uri.file(sourcePath)),
        /never overwrites the active source/u,
        `${backend} deterministic export must reject the active source.`
      );
      if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT && backend === "pandas") {
        const page = await connectToEditorWorkbench();
        await exerciseRealScriptSaveDialog(page, vscode.Uri.file(sourcePath), scriptPath);
      } else {
        await testing.exportCodeTo(vscode.Uri.file(scriptPath));
      }
      assert.equal(readFileSync(scriptPath, "utf8"), editedCode, `${backend} must export the edited code buffer.`);
      assert.deepEqual(
        readdirSync(directory).filter((name) => name.startsWith(".openwrangler-") && name.endsWith(".tmp")),
        [],
        `${backend} script export must not retain sibling temporary files.`
      );

      const closed = await testing.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision
      });
      assert.equal(closed.kind, "sessionClosed");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        10_000,
        `${backend} operation-group session to dispose`
      );
    }

    assertExactBytes(
      readFileSync(sourcePath),
      Buffer.from(original, "utf8"),
      "Operation previews and applies must not alter the source."
    );
  } finally {
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function exerciseRealScriptSaveDialog(
  page: Page,
  hostileDestination: vscode.Uri,
  destination: string,
  options: Readonly<{ language: "Python" | "R"; defaultSuffix: ".clean.py" | ".clean.R" }> = {
    language: "Python",
    defaultSuffix: ".clean.py"
  }
): Promise<void> {
  const commandOutcome = vscode.commands.executeCommand<boolean>("openWrangler.exportCode", hostileDestination);
  const earlyOutcome = await Promise.race([
    commandOutcome.then((value) => ({ kind: "settled" as const, value })),
    new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 500))
  ]);
  assert.equal(
    earlyOutcome.kind,
    "pending",
    `A caller-provided export URI must not bypass the real Save dialog: ${JSON.stringify(earlyOutcome)}`
  );
  const dialog = page
    .locator(".quick-input-widget:visible")
    .filter({ hasText: `Export Open Wrangler ${options.language} Code` })
    .last();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const input = dialog.locator(".quick-input-box input").first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(
    await input.inputValue(),
    new RegExp(`${options.defaultSuffix.replaceAll(".", "\\.")}$`, "u"),
    "The hostile command argument must not become the default URI."
  );

  await input.fill(path.resolve(destination));
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(await commandOutcome, true, "The real Save dialog must commit the selected script destination.");

  const cancelledDestination = `${destination}.cancelled${path.extname(options.defaultSuffix)}`;
  const cancelledOutcome = vscode.commands.executeCommand<boolean>("openWrangler.exportCode");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(path.resolve(cancelledDestination));
  await input.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(await cancelledOutcome, false, "Cancelling the real Save dialog must not export code.");
  assert.equal(existsSync(cancelledDestination), false, "Save-dialog cancellation must not create a script.");
}

function csvSource(uri: vscode.Uri): SessionSource {
  return {
    kind: "file",
    label: path.basename(uri.fsPath),
    path: uri.fsPath,
    uri: uri.toString(),
    importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
  };
}

function semicolonCsvSource(uri: vscode.Uri): SessionSource {
  return {
    kind: "file",
    label: path.basename(uri.fsPath),
    path: uri.fsPath,
    uri: uri.toString(),
    importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
  };
}

function tsvSource(uri: vscode.Uri): SessionSource {
  return {
    kind: "file",
    label: path.basename(uri.fsPath),
    path: uri.fsPath,
    uri: uri.toString(),
    importOptions: { delimiter: "\t", encoding: "utf-8", quoteChar: '"', hasHeader: true }
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  expectation: string,
  diagnostics?: () => string
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      const detail = diagnostics ? ` Last state: ${diagnostics()}.` : "";
      throw new Error(`Timed out waiting for ${expectation}.${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
