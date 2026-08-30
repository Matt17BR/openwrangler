import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  DataDiff,
  LiveGridPage,
  SessionMetadata,
  StepInspectionResponse,
  TransformStep
} from "../shared/protocol";
import {
  dataBackendLabel,
  formatSessionRowCount,
  isExactGridPage,
  supportsViewingCapability
} from "../shared/protocol";
import {
  compactFilterModel,
  emptyFilterModel,
  hasActiveFilters,
  prioritizeSortRule,
  replaceViewColumnFilter,
  viewSortModelSignature,
  type FilterModel
} from "../shared/filterModel";
import type { GridViewState } from "../shared/viewState";
import type { SessionOpenProgressStage } from "../shared/sessionOpenProgress";
import { canEditLatestStep, canStartOperation, operationByKind, supportsOperation } from "../shared/operations";
import { sessionModeAction } from "../shared/sessionMode";
import { ActiveFilterBar, type FilterBarRequestLifecycle } from "./filters/ActiveFilterBar";
import { FilterPanel } from "./filters/FilterPanel";
import {
  confirmLatestFilterUndo,
  emptyConfirmedFilterHistory,
  latestConfirmedFilterUndo,
  recordConfirmedFilterTransition,
  sameConfirmedFilters,
  type ConfirmedFilterHistory
} from "./filters/filterHistory";
import { DataGrid, type VisibleColumnRange } from "./grid/DataGrid";
import { SummaryPanel, summaryPanelId, summaryTabId, type SummaryPanelView } from "./summary/SummaryPanel";
import type { ProfileValueMode } from "./profileValueMode";
import { OperationBuilder } from "./operations/OperationBuilder";
import { ColumnSearch } from "./ColumnSearch";
import { draftDiffLabels, fillMissingResultLabel } from "./draftResultPresentation";
import { StepInspectionPanel } from "./StepInspectionPanel";
import { SessionModeControl } from "./SessionModeControl";
import { vscode } from "./vscodeApi";
import { reportWebviewFailure } from "./WebviewErrorBoundary";
import {
  alignedColumnWindow,
  columnWindowFromPage,
  decodeAppHostMessage,
  isSwitchableFileBackend,
  pageCoversColumnWindow,
  sameFilterModel,
  sameFilterRules,
  sameSortRules,
  sessionOpenProgressHeading,
  withoutDatasetStats,
  type ApplyFilterOptions,
  type ColumnRevealRequest,
  type ColumnRevealSynchronization,
  type ColumnWindow,
  type ConfirmedView,
  type ConfirmedViewState,
  type DiffBeforeState,
  type OperationIntent,
  type PageRequestOptions,
  type PendingPageRequest,
  type PendingStepInspection,
  type QueuedOperationIntent,
  type QueuedStepSelection,
  type ViewSortActionTarget
} from "./appState";
import { useOperationDialogLifecycle } from "./operationDialogLifecycle";
import { useImportOptionsLifecycle } from "./importOptionsLifecycle";
import { useProgressiveProfilingLifecycle } from "./progressiveProfilingLifecycle";
import { useRendererPresentationLifecycle } from "./rendererPresentationLifecycle";
import { useSessionModeChangeLifecycle } from "./sessionModeChangeLifecycle";

const webviewConfig = readWebviewConfig();
const pageSize = webviewConfig.fetchBlockSize;
const viewRequestEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let lastViewRequestSequence = 0;

function scheduleWebviewFocusRestoration(restore: () => void): number {
  const webviewOwnedFocus = document.hasFocus();
  return window.requestAnimationFrame(() => {
    if (!webviewOwnedFocus || !document.hasFocus()) return;
    restore();
  });
}

function canRestoreFocusTo(target: HTMLElement | null | undefined): target is HTMLElement {
  return Boolean(
    target?.isConnected &&
    target.tabIndex >= 0 &&
    !target.matches(":disabled") &&
    target.closest("[inert], [hidden], details:not([open])") === null
  );
}

export function App() {
  const [metadata, setMetadata] = useState<SessionMetadata | undefined>();
  const [page, setPage] = useState<LiveGridPage | undefined>();
  const [profileValueMode, setProfileValueMode] = useState<ProfileValueMode>("count");
  const [filterModel, setFilterModel] = useState<FilterModel>(emptyFilterModel);
  const [confirmedFilterHistory, setConfirmedFilterHistory] =
    useState<ConfirmedFilterHistory>(emptyConfirmedFilterHistory);
  const [filterBarRequestLifecycle, setFilterBarRequestLifecycle] = useState<FilterBarRequestLifecycle>({});
  const [foregroundError, setForegroundError] = useState<string | undefined>();
  const [foregroundErrorCode, setForegroundErrorCode] = useState<string | undefined>();
  const [failedPageRequest, setFailedPageRequest] = useState<PendingPageRequest | undefined>();
  const [loading, setLoading] = useState(true);
  const [projectionLoading, setProjectionLoading] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [queuedStepSelection, setQueuedStepSelection] = useState<QueuedStepSelection | undefined>();
  const [queuedOperationIntent, setQueuedOperationIntent] = useState<QueuedOperationIntent | undefined>();
  const [runtimeDependencyInstallPending, setRuntimeDependencyInstallPending] = useState(false);
  const [liveSessionReconnectPending, setLiveSessionReconnectPending] = useState(false);
  const [sessionOpenProgress, setSessionOpenProgress] = useState<SessionOpenProgressStage | undefined>();
  const [goToColumnRequest, setGoToColumnRequest] = useState<ColumnRevealRequest | undefined>();
  const goToColumnRequestSequence = useRef(0);
  const goToColumnRequestRef = useRef<ColumnRevealRequest | undefined>(undefined);
  const [filterColumn, setFilterColumn] = useState("");
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [summaryPanelView, setSummaryPanelView] = useState<SummaryPanelView>("column");
  const [diff, setDiff] = useState<DataDiff | undefined>();
  const [remainingMissingCells, setRemainingMissingCells] = useState<number | undefined>();
  const [draftWarnings, setDraftWarnings] = useState<string[]>([]);
  const [stepInspection, setStepInspection] = useState<StepInspectionResponse | undefined>();
  const [pendingStepInspection, setPendingStepInspection] = useState<PendingStepInspection | undefined>();
  const [stepInspectionTarget, setStepInspectionTarget] = useState<PendingStepInspection | undefined>();
  const [stepInspectionError, setStepInspectionError] = useState<string | undefined>();
  const [draftBefore, setDraftBefore] = useState<DiffBeforeState | undefined>();
  const [activeViewContextId, setActiveViewContextId] = useState("");
  const {
    acceptedSynchronization,
    acceptSynchronization,
    clearSynchronization,
    flushGridViewState,
    gridViewState,
    publishGridViewState,
    resetGridViewState,
    restoreGridViewport,
    restoreHostGridViewState,
    takeGridViewStateForSessionModeChange,
    viewStateRestoreVersion
  } = useRendererPresentationLifecycle(metadata);
  const metadataRef = useRef<SessionMetadata | undefined>(undefined);
  const readCurrentSessionMode = useCallback(() => metadataRef.current?.mode, []);
  const {
    pending: sessionModeChangePending,
    target: sessionModeChangeTarget,
    requestModeChange: requestSessionModeChange,
    settleModeChange
  } = useSessionModeChangeLifecycle({
    takeGridViewState: takeGridViewStateForSessionModeChange,
    readCurrentMode: readCurrentSessionMode,
    scheduleFocusRestoration: scheduleWebviewFocusRestoration,
    canRestoreFocus: canRestoreFocusTo
  });
  const {
    dialog: operationDialog,
    openDialog: openOperationDialog,
    closeDialog: closeOperationDialog
  } = useOperationDialogLifecycle({
    scheduleFocusRestoration: scheduleWebviewFocusRestoration,
    canRestoreFocus: canRestoreFocusTo
  });
  const operationOpen = operationDialog !== undefined;
  const {
    pending: importOptionsPending,
    isPending: isImportOptionsPending,
    beginRequest: beginImportOptionsRequest,
    settlePending: settleImportOptionsPending
  } = useImportOptionsLifecycle({
    scheduleFocusRestoration: scheduleWebviewFocusRestoration
  });
  const pageRef = useRef<LiveGridPage | undefined>(undefined);
  const stepInspectionRef = useRef<StepInspectionResponse | undefined>(undefined);
  const pendingStepInspectionRef = useRef<PendingStepInspection | undefined>(undefined);
  const stepInspectionTargetRef = useRef<PendingStepInspection | undefined>(undefined);
  const filterModelRef = useRef<FilterModel>(emptyFilterModel());
  const confirmedFilterHistoryRef = useRef<ConfirmedFilterHistory>(emptyConfirmedFilterHistory());
  const clearFilterColumnActionRef = useRef<(column: string) => void>(() => undefined);
  const changeViewSortActionRef = useRef<(target: ViewSortActionTarget) => void>(() => undefined);
  const sidePanelOpenRef = useRef(false);
  const summaryPanelViewRef = useRef<SummaryPanelView>("column");
  const confirmedView = useRef<ConfirmedView | undefined>(undefined);
  const latestPageRequest = useRef<PendingPageRequest | undefined>(undefined);
  const failedPageRequestRef = useRef<PendingPageRequest | undefined>(undefined);
  const foregroundRequest = useRef<"mutation" | { kind: "page"; viewRequestId: string } | undefined>(undefined);
  const restoreGridFocusForPage = useRef<string | undefined>(undefined);
  const mutationSnapshot = useRef<ConfirmedViewState | undefined>(undefined);
  const importOptionsUiBusyRef = useRef(true);
  const confirmedColumnWindow = useRef<ColumnWindow>(initialColumnWindow());
  const desiredColumnWindow = useRef<ColumnWindow>(initialColumnWindow());
  const inspectionColumnWindow = useRef<ColumnWindow>(initialColumnWindow());
  const sidePanelToggleRef = useRef<HTMLButtonElement | null>(null);
  const sidePanelCloseRef = useRef<HTMLButtonElement | null>(null);
  const sidePanelReturnFocus = useRef<HTMLElement | null>(null);
  const undoPlanReturnFocus = useRef<HTMLButtonElement | null>(null);

  const nextViewRequestId = useCallback(() => {
    lastViewRequestSequence += 1;
    return `view-${viewRequestEpoch}-${lastViewRequestSequence}`;
  }, []);

  useEffect(() => {
    if (!sidePanelOpen) return;
    const frame = scheduleWebviewFocusRestoration(() => sidePanelCloseRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [sidePanelOpen]);

  const storeMetadata = useCallback((next: SessionMetadata | undefined) => {
    metadataRef.current = next;
    setMetadata(next);
  }, []);

  const storePage = useCallback((next: LiveGridPage | undefined) => {
    pageRef.current = next;
    setPage(next);
  }, []);

  const storeStepInspection = useCallback((next: StepInspectionResponse | undefined) => {
    stepInspectionRef.current = next;
    setStepInspection(next);
  }, []);

  const storePendingStepInspection = useCallback((next: PendingStepInspection | undefined) => {
    pendingStepInspectionRef.current = next;
    setPendingStepInspection(next);
  }, []);

  const storeStepInspectionTarget = useCallback((next: PendingStepInspection | undefined) => {
    stepInspectionTargetRef.current = next;
    setStepInspectionTarget(next);
  }, []);

  const storeFilterModel = useCallback((next: FilterModel) => {
    filterModelRef.current = next;
    setFilterModel(next);
  }, []);

  const storeConfirmedFilterHistory = useCallback((next: ConfirmedFilterHistory) => {
    confirmedFilterHistoryRef.current = next;
    setConfirmedFilterHistory(next);
  }, []);

  const resetConfirmedFilterHistory = useCallback(() => {
    storeConfirmedFilterHistory(emptyConfirmedFilterHistory());
  }, [storeConfirmedFilterHistory]);

  const storeFailedPageRequest = useCallback((next: PendingPageRequest | undefined) => {
    failedPageRequestRef.current = next;
    setFailedPageRequest(next);
  }, []);

  const storeGoToColumnRequest = useCallback((next: ColumnRevealRequest | undefined) => {
    goToColumnRequestRef.current = next;
    setGoToColumnRequest(next);
  }, []);

  const requestColumnReveal = useCallback(
    (columnId: string, retainUntilSynchronization?: ColumnRevealSynchronization) => {
      goToColumnRequestSequence.current += 1;
      storeGoToColumnRequest({
        columnId,
        requestId: goToColumnRequestSequence.current,
        ...(retainUntilSynchronization ? { retainUntilSynchronization } : {})
      });
    },
    [storeGoToColumnRequest]
  );

  const handleColumnReveal = useCallback(
    (requestId: number, outcome: "revealed" | "interrupted" = "revealed") => {
      const request = goToColumnRequestRef.current;
      if (!request || request.requestId !== requestId) return;
      if (outcome === "revealed" && request.retainUntilSynchronization) {
        return;
      }
      storeGoToColumnRequest(undefined);
    },
    [storeGoToColumnRequest]
  );

  const setImportOptionsRequestPending = useCallback(
    (pending: boolean): boolean => {
      const wasPending = settleImportOptionsPending(pending);
      if (pending) {
        setQueuedOperationIntent(undefined);
        closeOperationDialog();
        setLoading(true);
      } else if (wasPending && foregroundRequest.current === undefined) setLoading(false);
      return wasPending;
    },
    [closeOperationDialog, settleImportOptionsPending]
  );

  const confirmView = useCallback((next: SessionMetadata, viewContextId: string): ConfirmedView => {
    const confirmed = {
      viewContextId,
      sessionId: next.sessionId,
      revision: next.revision
    };
    confirmedView.current = confirmed;
    setActiveViewContextId(viewContextId);
    vscode.postMessage({ kind: "setViewContext", viewContextId });
    return confirmed;
  }, []);

  const canProfileConfirmedView = useCallback(
    (viewContextId: string): boolean => {
      const confirmed = confirmedView.current;
      const pendingPage = latestPageRequest.current;
      return Boolean(
        confirmed &&
        confirmed.viewContextId === viewContextId &&
        !isImportOptionsPending() &&
        !stepInspectionTargetRef.current &&
        foregroundRequest.current !== "mutation" &&
        (!pendingPage || pendingPage.viewContextId === confirmed.viewContextId)
      );
    },
    [isImportOptionsPending]
  );

  const readConfirmedProfileView = useCallback(() => {
    const currentMetadata = metadataRef.current;
    const currentView = confirmedView.current;
    return currentMetadata && currentView ? { metadata: currentMetadata, view: currentView } : undefined;
  }, []);

  const schemaById = useMemo(() => new Map(metadata?.schema.map((column) => [column.id, column]) ?? []), [metadata]);
  const selectedSummaryColumnId = useMemo(() => {
    const selectedColumnId = gridViewState.selectedColumnId;
    if (selectedColumnId && schemaById.has(selectedColumnId)) return selectedColumnId;
    return metadata?.schema[0]?.id;
  }, [gridViewState.selectedColumnId, metadata?.schema, schemaById]);

  const {
    backgroundDiagnostics,
    cancelPendingProfiling,
    captureProfileState,
    columnValues,
    releaseDrawerProfiling,
    requestValues,
    resetViewProfiling,
    restartProfilingAfterMutation,
    restartProfilingForConfirmedView,
    restoreProfileState,
    settleProfileMessage,
    summaries,
    suspendProfiling,
    updateVisibleSummaryColumns
  } = useProgressiveProfilingLifecycle({
    nextViewRequestId,
    readConfirmedView: readConfirmedProfileView,
    canProfileConfirmedView,
    drawerDemand: {
      open: sidePanelOpen,
      view: summaryPanelView,
      selectedColumnId: selectedSummaryColumnId,
      suspended: importOptionsPending,
      viewContextId: activeViewContextId
    }
  });

  useEffect(() => {
    importOptionsUiBusyRef.current = loading || mutationPending || projectionLoading;
  }, [loading, mutationPending, projectionLoading]);

  const requestImportOptionsChange = useCallback(
    (actionId?: string, trigger?: HTMLButtonElement) => {
      flushGridViewState();
      suspendProfiling();
      if (
        importOptionsUiBusyRef.current ||
        foregroundRequest.current ||
        pendingStepInspectionRef.current?.reason === "projection" ||
        isImportOptionsPending()
      ) {
        return;
      }
      setQueuedOperationIntent(undefined);
      closeOperationDialog();
      setLoading(true);
      beginImportOptionsRequest(actionId, trigger);
    },
    [beginImportOptionsRequest, closeOperationDialog, flushGridViewState, isImportOptionsPending, suspendProfiling]
  );

  const updateImportOptionsPending = useCallback(
    (pending: boolean) => {
      if (pending) suspendProfiling();
      const wasPending = setImportOptionsRequestPending(pending);
      if (!pending && wasPending && metadataRef.current) {
        restartProfilingForConfirmedView();
      }
    },
    [restartProfilingForConfirmedView, setImportOptionsRequestPending, suspendProfiling]
  );

  const captureConfirmedViewState = useCallback((): ConfirmedViewState | undefined => {
    const currentMetadata = metadataRef.current;
    const currentPage = pageRef.current;
    const currentView = confirmedView.current;
    if (!currentMetadata || !currentPage || !currentView) return undefined;
    return {
      view: { ...currentView },
      metadata: currentMetadata,
      page: currentPage,
      columnWindow: { ...confirmedColumnWindow.current },
      ...captureProfileState()
    };
  }, [captureProfileState]);

  const restoreConfirmedViewState = useCallback(
    (previous: ConfirmedViewState) => {
      storeMetadata(previous.metadata);
      storeFilterModel(previous.metadata.filterModel);
      restoreProfileState(previous);
      confirmedColumnWindow.current = { ...previous.columnWindow };
      desiredColumnWindow.current = { ...previous.columnWindow };
      confirmView(previous.metadata, previous.view.viewContextId);
      restartProfilingForConfirmedView();
    },
    [confirmView, restartProfilingForConfirmedView, restoreProfileState, storeFilterModel, storeMetadata]
  );

  const clearStepInspection = useCallback(
    (notifyHost = true, resumeProfiling = true) => {
      storePendingStepInspection(undefined);
      storeStepInspection(undefined);
      storeStepInspectionTarget(undefined);
      inspectionColumnWindow.current = { ...confirmedColumnWindow.current };
      setProjectionLoading(false);
      setStepInspectionError(undefined);
      if (notifyHost) vscode.postMessage({ kind: "clearStepInspection" });
      if (resumeProfiling) restartProfilingForConfirmedView();
    },
    [restartProfilingForConfirmedView, storePendingStepInspection, storeStepInspection, storeStepInspectionTarget]
  );

  const requestOperationIntent = useCallback(
    (intent: OperationIntent, expectedSessionId?: string, expectedRevision?: number) => {
      const currentMetadata = metadataRef.current;
      const selectedStep =
        intent.action === "editStep"
          ? currentMetadata?.steps.find((step) => step.id === intent.stepId)
          : intent.action === "editLatest"
            ? currentMetadata?.steps.at(-1)
            : undefined;
      const canOpen =
        intent.action === "open"
          ? canStartOperation(currentMetadata, intent.operationKind)
          : intent.action === "editLatest"
            ? canEditLatestStep(currentMetadata)
            : selectedStep !== undefined && canStartOperation(currentMetadata, selectedStep.kind);
      if (
        !currentMetadata ||
        (expectedSessionId !== undefined && expectedSessionId !== currentMetadata.sessionId) ||
        (expectedRevision !== undefined && expectedRevision !== currentMetadata.revision) ||
        !canOpen
      ) {
        return;
      }
      if (isImportOptionsPending()) {
        setForegroundError("Wait for the current import-options change to finish.");
        return;
      }
      const pendingForeground = foregroundRequest.current;
      if (pendingForeground === "mutation") {
        setForegroundError(
          intent.action === "open"
            ? "Wait for the current cleaning operation to finish before adding another step."
            : "Wait for the current cleaning operation to finish before editing a step."
        );
        return;
      }
      if (pendingForeground) {
        const pendingPage = latestPageRequest.current;
        if (!pendingPage || pendingPage.viewRequestId !== pendingForeground.viewRequestId) return;
        setQueuedStepSelection(undefined);
        setQueuedOperationIntent({
          ...intent,
          sessionId: currentMetadata.sessionId,
          revision: currentMetadata.revision
        });
        return;
      }
      setQueuedStepSelection(undefined);
      setQueuedOperationIntent(undefined);
      const selectedInputSchema =
        intent.action === "editStep" && stepInspectionRef.current?.stepId === intent.stepId
          ? stepInspectionRef.current.inputSchema
          : undefined;
      if (intent.action === "editStep" && !selectedInputSchema) return;
      if (stepInspectionTargetRef.current) clearStepInspection();
      if (intent.action !== "open" && !selectedStep) return;
      const kind = intent.action === "open" ? intent.operationKind : selectedStep?.kind;
      openOperationDialog({
        ...(kind === undefined ? {} : { kind }),
        ...(selectedStep === undefined ? {} : { editingStep: selectedStep }),
        ...(selectedInputSchema === undefined ? {} : { editingStepInputSchema: selectedInputSchema })
      });
    },
    [clearStepInspection, isImportOptionsPending, openOperationDialog]
  );

  const requestStepInspection = useCallback(
    (
      stepId: string,
      offset = 0,
      columnWindow = inspectionColumnWindow.current,
      reason: PendingStepInspection["reason"] = "selection"
    ) => {
      const currentMetadata = metadataRef.current;
      if (foregroundRequest.current) {
        if (latestPageRequest.current?.reason === "projection") {
          setForegroundError("Wait for the visible columns to finish loading before inspecting a cleaning step.");
        }
        return;
      }
      if (!currentMetadata?.steps.some((step) => step.id === stepId)) {
        return;
      }
      const previousTarget = stepInspectionTargetRef.current;
      const requestedWindow =
        previousTarget?.stepId !== stepId && reason === "selection" ? confirmedColumnWindow.current : columnWindow;
      const normalizedWindow = {
        offset: Math.max(0, Math.floor(requestedWindow.offset)),
        limit: Math.max(1, Math.min(256, Math.floor(requestedWindow.limit)))
      };
      inspectionColumnWindow.current = normalizedWindow;
      const pending: PendingStepInspection = { stepId, offset, columnWindow: normalizedWindow, reason };
      storeStepInspectionTarget(pending);
      storePendingStepInspection(pending);
      setProjectionLoading(reason === "projection");
      if (stepInspectionRef.current?.stepId !== stepId) storeStepInspection(undefined);
      setStepInspectionError(undefined);
      suspendProfiling();
      sidePanelOpenRef.current = false;
      setSidePanelOpen(false);
      vscode.postMessage({
        kind: "runtimeRequest",
        request: {
          kind: "inspectStep",
          stepId,
          offset,
          limit: pageSize,
          columnOffset: normalizedWindow.offset,
          columnLimit: normalizedWindow.limit
        }
      });
    },
    [storePendingStepInspection, storeStepInspection, storeStepInspectionTarget, suspendProfiling]
  );

  const beginMutation = useCallback((): boolean => {
    if (isImportOptionsPending()) {
      setForegroundError("Wait for the current import-options change to finish.");
      return false;
    }
    if (foregroundRequest.current) {
      if (latestPageRequest.current?.reason === "projection") {
        setForegroundError("Wait for the visible columns to finish loading before changing the cleaning plan.");
      } else {
        setForegroundError("Wait for the current data request to finish before changing the cleaning plan.");
      }
      return false;
    }
    const previous = captureConfirmedViewState();
    if (!previous) {
      setForegroundError("Wait for the dataframe view to finish initializing before changing the cleaning plan.");
      return false;
    }
    clearStepInspection(false, false);
    flushGridViewState();
    mutationSnapshot.current = previous;
    setQueuedOperationIntent(undefined);
    resetViewProfiling();
    storeMetadata(withoutDatasetStats(previous.metadata));
    foregroundRequest.current = "mutation";
    setFilterBarRequestLifecycle({});
    setMutationPending(true);
    storeFailedPageRequest(undefined);
    setForegroundError(undefined);
    setProjectionLoading(false);
    setLoading(true);
    return true;
  }, [
    captureConfirmedViewState,
    clearStepInspection,
    flushGridViewState,
    isImportOptionsPending,
    resetViewProfiling,
    storeFailedPageRequest,
    storeMetadata
  ]);

  const deleteStep = useCallback(
    (stepId: string) => {
      const currentMetadata = metadataRef.current;
      if (!currentMetadata?.steps.some((step) => step.id === stepId) || !beginMutation()) return;
      const columnWindow = desiredColumnWindow.current;
      vscode.postMessage({
        kind: "rewriteCleaningPlan",
        action: "deleteStep",
        stepId,
        offset: 0,
        limit: pageSize,
        columnOffset: columnWindow.offset,
        columnLimit: columnWindow.limit
      });
    },
    [beginMutation]
  );

  const restoreViewAfterPageFailure = useCallback(
    (pendingPage: PendingPageRequest, restoreConfirmedViewport = false) => {
      const previous = pendingPage.previousConfirmedState;
      if (pendingPage.changesView && previous) {
        restoreConfirmedViewState(previous);
        return;
      }
      if (!restoreConfirmedViewport) return;
      const confirmedPage = pageRef.current;
      if (!confirmedPage) return;
      const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      const focusedRow = focusedElement?.getAttribute("data-grid-row");
      const focusedColumn = focusedElement?.getAttribute("data-grid-column");
      const focusedViewContextId = confirmedView.current?.viewContextId;
      const focusedCell =
        focusedRow !== null &&
        focusedRow !== undefined &&
        focusedColumn !== null &&
        focusedColumn !== undefined &&
        /^\d+$/u.test(focusedRow) &&
        /^\d+$/u.test(focusedColumn)
          ? { row: focusedRow, column: focusedColumn }
          : undefined;
      const restoreGridFocus = focusedCell !== undefined || focusedElement === document.body;
      restoreGridViewport(confirmedPage.offset);
      if (restoreGridFocus) {
        scheduleWebviewFocusRestoration(() => {
          scheduleWebviewFocusRestoration(() => {
            if (confirmedView.current?.viewContextId !== focusedViewContextId) return;
            const target = focusedCell
              ? document.querySelector<HTMLElement>(
                  `[data-grid-row="${focusedCell.row}"][data-grid-column="${focusedCell.column}"]`
                )
              : document.querySelector<HTMLElement>('[data-testid="data-grid-scroller"] [data-grid-row][tabindex="0"]');
            target?.focus({ preventScroll: true });
          });
        });
      }
    },
    [restoreConfirmedViewState, restoreGridViewport]
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return;
      const response = decodeAppHostMessage(event.data);
      if (!response) return;
      if (response.kind === "sessionOpenProgress") {
        setSessionOpenProgress(response.stage ?? undefined);
        return;
      }
      if (response.kind === "rendererSynchronization") {
        const current = metadataRef.current;
        const matchesSession =
          response.sessionId === null && response.revision === null
            ? current === undefined
            : current?.sessionId === response.sessionId && current.revision === response.revision;
        if (matchesSession) {
          const reveal = goToColumnRequestRef.current;
          if (reveal) {
            const retainUntilSynchronization = reveal.retainUntilSynchronization;
            const retainedRevealMatches =
              retainUntilSynchronization?.sessionId === response.sessionId &&
              retainUntilSynchronization.revision === response.revision;
            // Cursor can report the target as visible before revealing Code
            // Preview narrows the editor. Keep the logical reveal alive while
            // the host says that layout transition is pending, then give the
            // settled layout a fresh request that DataGrid may complete.
            requestColumnReveal(
              reveal.columnId,
              retainedRevealMatches && response.layoutTransitionPending ? retainUntilSynchronization : undefined
            );
          }
          // This marker is the host's publication barrier. Commit every
          // authoritative message that preceded it before allowing recovery
          // pulls or a native view reveal to invalidate the marker.
          acceptSynchronization(response);
        }
        return;
      }
      if (response.kind === "requestImportOptionsChange") {
        requestImportOptionsChange(response.actionId);
        return;
      }
      if (response.kind === "importOptionsState") {
        updateImportOptionsPending(response.busy);
        return;
      }
      if (response.kind === "runtimeDependencyInstallState") {
        setRuntimeDependencyInstallPending(response.busy);
        return;
      }
      if (response.kind === "sessionModeChangeState") {
        settleModeChange(response.busy, response.mode);
        return;
      }
      if (response.kind === "sessionPresentation") {
        const current = metadataRef.current;
        if (
          !current ||
          response.presentation.sessionId !== current.sessionId ||
          response.presentation.revision !== current.revision
        ) {
          return;
        }
        setDiff(response.presentation.draft?.diff);
        setRemainingMissingCells(response.presentation.draft?.remainingMissingCells);
        setDraftBefore(response.presentation.draft ? { schema: response.presentation.draft.beforeSchema } : undefined);
        setDraftWarnings(response.presentation.draft?.warnings ?? []);
        return;
      }
      if (response.kind === "stepInspectionCleared") {
        if (stepInspectionTargetRef.current || pendingStepInspectionRef.current || stepInspectionRef.current) {
          clearStepInspection(false, response.resumeProfiling);
        }
        return;
      }
      if (response.kind === "stepInspectionResult") {
        const pending = pendingStepInspectionRef.current;
        if (
          !pending ||
          pending.stepId !== response.stepId ||
          pending.offset !== response.offset ||
          pageSize !== response.limit ||
          pending.columnWindow.offset !== response.columnOffset ||
          pending.columnWindow.limit !== response.columnLimit
        ) {
          return;
        }
        storePendingStepInspection(undefined);
        setProjectionLoading(false);
        const result = response.response;
        if (result.kind === "error") {
          setStepInspectionError(result.message);
          return;
        }
        if (result.kind === "cancelled") {
          setStepInspectionError(
            "Loading the step was cancelled. Your confirmed data is unchanged. Choose Show confirmed data, then select the step again."
          );
          return;
        }
        const currentMetadata = metadataRef.current;
        if (
          result.stepId !== response.stepId ||
          result.revision !== currentMetadata?.revision ||
          result.inputPage.offset !== response.offset ||
          result.outputPage.offset !== response.offset
        ) {
          setStepInspectionError(
            "Open Wrangler could not safely show the step. Your confirmed data is unchanged. Choose Show confirmed data, then select the step again."
          );
          return;
        }
        inspectionColumnWindow.current = columnWindowFromPage(
          { ...currentMetadata, schema: result.outputSchema },
          result.outputPage,
          pending.columnWindow
        );
        storeStepInspection(result);
        setStepInspectionError(undefined);
        return;
      }
      if (response.kind === "viewState") {
        restoreHostGridViewState(response.state);
        return;
      }
      if (response.kind === "editorAction") {
        if (response.action === "selectStep") {
          const currentMetadata = metadataRef.current;
          const expectedSessionId = response.expectedSessionId ?? currentMetadata?.sessionId;
          if (
            !currentMetadata ||
            expectedSessionId !== currentMetadata.sessionId ||
            (response.expectedRevision !== undefined && response.expectedRevision !== currentMetadata.revision)
          ) {
            return;
          }
          const selection: QueuedStepSelection = {
            sessionId: currentMetadata.sessionId,
            revision: currentMetadata.revision,
            ...(response.stepId ? { stepId: response.stepId } : {})
          };
          setQueuedOperationIntent(undefined);
          if (isImportOptionsPending() || foregroundRequest.current) {
            setQueuedStepSelection(selection);
            return;
          }
          setQueuedStepSelection(undefined);
          if (response.stepId) requestStepInspection(response.stepId);
          else clearStepInspection();
          return;
        }
        if (isImportOptionsPending()) {
          setForegroundError("Wait for the current import-options change to finish.");
          return;
        }
        if (response.action === "openOperation") {
          requestOperationIntent(
            {
              action: "open",
              ...(response.operationKind === undefined ? {} : { operationKind: response.operationKind })
            },
            response.expectedSessionId,
            response.expectedRevision
          );
        } else if (response.action === "editLatest") {
          requestOperationIntent({ action: "editLatest" }, response.expectedSessionId, response.expectedRevision);
        } else if (response.action === "editStep") {
          const currentMetadata = metadataRef.current;
          const stepId = response.stepId;
          if (
            !currentMetadata ||
            response.expectedSessionId !== currentMetadata.sessionId ||
            response.expectedRevision !== currentMetadata.revision ||
            !currentMetadata.steps.some((step) => step.id === stepId)
          ) {
            return;
          }
          if (stepInspectionRef.current?.stepId === stepId) {
            requestOperationIntent(
              { action: "editStep", stepId },
              response.expectedSessionId,
              response.expectedRevision
            );
          } else {
            setQueuedOperationIntent({
              action: "editStep",
              stepId,
              sessionId: currentMetadata.sessionId,
              revision: currentMetadata.revision
            });
            requestStepInspection(stepId);
          }
        } else if (response.action === "deleteStep") {
          const currentMetadata = metadataRef.current;
          const stepId = response.stepId;
          if (
            !currentMetadata ||
            response.expectedSessionId !== currentMetadata.sessionId ||
            response.expectedRevision !== currentMetadata.revision
          ) {
            return;
          }
          deleteStep(stepId);
        } else if (response.action === "clearFilterColumn") {
          if (typeof response.column !== "string") return;
          clearFilterColumnActionRef.current(response.column);
        } else if (response.action === "openFilters") {
          if (stepInspectionTargetRef.current) return;
          const currentMetadata = metadataRef.current;
          if (
            !currentMetadata ||
            (!supportsViewingCapability(currentMetadata.capabilities, "filter") &&
              !supportsViewingCapability(currentMetadata.capabilities, "sort"))
          ) {
            return;
          }
          if (
            typeof response.column === "string" &&
            currentMetadata?.schema.filter((column) => column.name === response.column).length === 1
          ) {
            setFilterColumn(response.column);
          }
          summaryPanelViewRef.current = "filters";
          setSummaryPanelView("filters");
          sidePanelOpenRef.current = true;
          setSidePanelOpen(true);
        } else if (response.action === "changeViewSort") {
          if (!metadataRef.current || !supportsViewingCapability(metadataRef.current.capabilities, "sort")) {
            return;
          }
          changeViewSortActionRef.current({
            column: response.column,
            action: response.sortAction,
            expectedSessionId: response.expectedSessionId,
            expectedSortModelSignature: response.expectedSortModelSignature,
            expectedSortIndex: response.expectedSortIndex
          });
        } else {
          if (!beginMutation()) return;
          const columnWindow = desiredColumnWindow.current;
          vscode.postMessage({
            kind: "runtimeRequest",
            request: {
              kind: response.action,
              offset: 0,
              limit: pageSize,
              columnOffset: columnWindow.offset,
              columnLimit: columnWindow.limit
            }
          });
        }
        return;
      }

      if (response.kind === "error") {
        setForegroundErrorCode(response.code);
        if (response.viewRequestId) {
          const pendingPage = latestPageRequest.current;
          if (pendingPage?.viewRequestId === response.viewRequestId) {
            latestPageRequest.current = undefined;
            setFilterBarRequestLifecycle({ settledRequestId: response.viewRequestId });
            if (
              typeof foregroundRequest.current === "object" &&
              foregroundRequest.current.viewRequestId === response.viewRequestId
            ) {
              foregroundRequest.current = undefined;
              if (pendingPage.reason === "projection") setProjectionLoading(false);
              else setLoading(isImportOptionsPending());
            }
            restoreViewAfterPageFailure(pendingPage, response.code === "pyspark_connect_state_lost");
            storeFailedPageRequest(pendingPage);
            setForegroundError(response.message);
            return;
          }

          const settlement = settleProfileMessage(response);
          if (settlement.foregroundError) setForegroundError(settlement.foregroundError);
          return;
        }
        const shouldRestoreMutation = foregroundRequest.current === "mutation";
        if (shouldRestoreMutation) {
          undoPlanReturnFocus.current = null;
          const previous = mutationSnapshot.current;
          foregroundRequest.current = undefined;
          mutationSnapshot.current = undefined;
          setMutationPending(false);
          setLoading(isImportOptionsPending());
          setProjectionLoading(false);
          if (previous) restoreConfirmedViewState(previous);
        } else if (isImportOptionsPending()) {
          setForegroundError(response.message);
          return;
        } else if (!metadataRef.current) {
          clearSynchronization();
          setLoading(false);
          setProjectionLoading(false);
          setRuntimeDependencyInstallPending(false);
        }
        if (response.code === "pyspark_connect_state_lost") setLiveSessionReconnectPending(false);
        setForegroundError(response.message);
        return;
      }

      if (response.kind === "cancelled") {
        if (!response.viewRequestId) {
          if (
            isImportOptionsPending() &&
            (response.targetRequestId === "change-import-options" ||
              response.targetRequestId.startsWith("reconfigure-import:"))
          ) {
            return;
          }
          const shouldRestoreMutation = foregroundRequest.current === "mutation";
          if (shouldRestoreMutation) {
            undoPlanReturnFocus.current = null;
            const previous = mutationSnapshot.current;
            foregroundRequest.current = undefined;
            mutationSnapshot.current = undefined;
            setMutationPending(false);
            setLoading(isImportOptionsPending());
            setProjectionLoading(false);
            if (previous) restoreConfirmedViewState(previous);
            setForegroundError("The cleaning operation was cancelled.");
          } else if (isImportOptionsPending()) {
            return;
          } else if (!metadataRef.current) {
            clearSynchronization();
            setLoading(false);
            setProjectionLoading(false);
            setForegroundErrorCode(undefined);
            setRuntimeDependencyInstallPending(false);
            setForegroundError("Opening the dataframe was cancelled.");
          }
          return;
        }
        const pendingPage = latestPageRequest.current;
        if (pendingPage?.viewRequestId === response.viewRequestId) {
          latestPageRequest.current = undefined;
          setFilterBarRequestLifecycle({ settledRequestId: response.viewRequestId });
          if (
            typeof foregroundRequest.current === "object" &&
            foregroundRequest.current.viewRequestId === response.viewRequestId
          ) {
            foregroundRequest.current = undefined;
            if (pendingPage.reason === "projection") setProjectionLoading(false);
            else setLoading(isImportOptionsPending());
          }
          restoreViewAfterPageFailure(pendingPage);
          storeFailedPageRequest(pendingPage);
          setForegroundError("Page request was cancelled.");
          return;
        }
        settleProfileMessage(response);
        return;
      }

      if (response.kind === "sessionOpened") {
        const current = metadataRef.current;
        if (current?.sessionId === response.metadata.sessionId && response.metadata.revision < current.revision) {
          return;
        }
        const preservesOpenOperation =
          current?.sessionId === response.metadata.sessionId && current.revision === response.metadata.revision;
        undoPlanReturnFocus.current = null;
        clearSynchronization();
        setImportOptionsRequestPending(false);
        if (!preservesOpenOperation) {
          setQueuedOperationIntent(undefined);
          setQueuedStepSelection(undefined);
          closeOperationDialog();
        }
        latestPageRequest.current = undefined;
        setFilterBarRequestLifecycle({});
        foregroundRequest.current = undefined;
        mutationSnapshot.current = undefined;
        setMutationPending(false);
        setLoading(false);
        setProjectionLoading(false);
        setRuntimeDependencyInstallPending(false);
        setLiveSessionReconnectPending(false);
        setForegroundError(undefined);
        setForegroundErrorCode(undefined);
        storeFailedPageRequest(undefined);
        resetGridViewState();
        storePendingStepInspection(undefined);
        storeStepInspection(undefined);
        storeStepInspectionTarget(undefined);
        setStepInspectionError(undefined);
        setDraftBefore(undefined);
        setDiff(undefined);
        setRemainingMissingCells(undefined);
        setDraftWarnings([]);
        resetConfirmedFilterHistory();
        resetViewProfiling({
          initialSummaries: supportsViewingCapability(response.metadata.capabilities, "profile")
            ? response.summaries
            : [],
          clearOwners: true
        });
        const openedProfileSupported = supportsViewingCapability(response.metadata.capabilities, "profile");
        const openedFilterPanelSupported =
          supportsViewingCapability(response.metadata.capabilities, "filter") ||
          supportsViewingCapability(response.metadata.capabilities, "sort");
        if (!openedProfileSupported && !openedFilterPanelSupported) {
          sidePanelOpenRef.current = false;
          setSidePanelOpen(false);
        } else if (!openedProfileSupported) {
          summaryPanelViewRef.current = "filters";
          setSummaryPanelView("filters");
        } else if (!openedFilterPanelSupported && summaryPanelViewRef.current === "filters") {
          summaryPanelViewRef.current = "column";
          setSummaryPanelView("column");
        }
        confirmView(response.metadata, nextViewRequestId());
        storeMetadata(response.metadata);
        storeFilterModel(response.metadata.filterModel);
        storePage(response.page);
        const openedWindow = columnWindowFromPage(response.metadata, response.page, initialColumnWindow());
        confirmedColumnWindow.current = openedWindow;
        desiredColumnWindow.current = openedWindow;
        inspectionColumnWindow.current = openedWindow;
        return;
      }

      if (response.kind === "page") {
        const pendingPage = latestPageRequest.current;
        if (!pendingPage || pendingPage.viewRequestId !== response.viewRequestId) return;
        latestPageRequest.current = undefined;
        setFilterBarRequestLifecycle({ settledRequestId: response.viewRequestId });
        if (
          typeof foregroundRequest.current === "object" &&
          foregroundRequest.current.viewRequestId === response.viewRequestId
        ) {
          foregroundRequest.current = undefined;
          if (pendingPage.reason === "projection") setProjectionLoading(false);
          else setLoading(isImportOptionsPending());
        }
        setForegroundError(undefined);
        setForegroundErrorCode(undefined);
        storeFailedPageRequest(undefined);

        const previousView = confirmedView.current;
        const sameView = Boolean(
          previousView &&
          previousView.viewContextId === pendingPage.viewContextId &&
          previousView.sessionId === response.metadata.sessionId
        );
        if (!sameView) {
          resetViewProfiling({ preserveColumnValues: true });
        }
        const previousStats = sameView ? metadataRef.current?.stats : undefined;
        const nextMetadata = previousStats
          ? { ...response.metadata, stats: previousStats }
          : withoutDatasetStats(response.metadata);
        if (pendingPage.changesView) {
          if (pendingPage.filterHistoryUndoTarget) {
            storeConfirmedFilterHistory(
              confirmLatestFilterUndo(
                confirmedFilterHistoryRef.current,
                pendingPage.filterHistoryUndoTarget,
                nextMetadata.filterModel
              )
            );
          } else {
            const previousFilterModel = pendingPage.previousConfirmedState?.metadata.filterModel;
            if (previousFilterModel) {
              storeConfirmedFilterHistory(
                recordConfirmedFilterTransition(
                  confirmedFilterHistoryRef.current,
                  previousFilterModel,
                  nextMetadata.filterModel
                )
              );
            }
          }
        }
        confirmView(nextMetadata, pendingPage.viewContextId);
        storeMetadata(nextMetadata);
        storeFilterModel(nextMetadata.filterModel);
        storePage(response.page);
        confirmedColumnWindow.current = columnWindowFromPage(nextMetadata, response.page, pendingPage.columnWindow);
        restartProfilingForConfirmedView();
        if (restoreGridFocusForPage.current === response.viewRequestId) {
          restoreGridFocusForPage.current = undefined;
          scheduleWebviewFocusRestoration(() => {
            document
              .querySelector<HTMLElement>('[data-testid="data-grid-scroller"] [data-grid-row][tabindex="0"]')
              ?.focus();
          });
        }
        return;
      }

      if (response.kind === "stepPreview" || response.kind === "planUpdated") {
        const undoReturnTarget = undoPlanReturnFocus.current;
        undoPlanReturnFocus.current = null;
        clearSynchronization();
        const previous = mutationSnapshot.current;
        latestPageRequest.current = undefined;
        setFilterBarRequestLifecycle({});
        foregroundRequest.current = undefined;
        mutationSnapshot.current = undefined;
        setMutationPending(false);
        setLoading(isImportOptionsPending());
        setProjectionLoading(false);
        setForegroundError(undefined);
        storeFailedPageRequest(undefined);
        resetConfirmedFilterHistory();
        resetViewProfiling();
        const nextMetadata = withoutDatasetStats(response.metadata);
        const undoFocusOriginIsActive =
          undoReturnTarget !== null &&
          (document.activeElement === undoReturnTarget || document.activeElement === document.body);
        const shouldRestoreUndoFocus =
          response.kind === "planUpdated" &&
          nextMetadata.steps.length === 0 &&
          nextMetadata.draftStep === undefined &&
          document.hasFocus() &&
          undoFocusOriginIsActive;
        confirmView(nextMetadata, nextViewRequestId());
        storeMetadata(nextMetadata);
        storeFilterModel(nextMetadata.filterModel);
        storePage(response.page);
        const mutationWindow = columnWindowFromPage(nextMetadata, response.page, desiredColumnWindow.current);
        confirmedColumnWindow.current = mutationWindow;
        desiredColumnWindow.current = mutationWindow;
        inspectionColumnWindow.current = mutationWindow;
        if (response.kind === "stepPreview") {
          const addedColumnName = response.diff.addedColumns[0];
          const addedColumn = nextMetadata.schema.find((column) => column.name === addedColumnName);
          if (addedColumn) {
            requestColumnReveal(addedColumn.id, {
              sessionId: nextMetadata.sessionId,
              revision: response.revision
            });
          } else {
            storeGoToColumnRequest(undefined);
          }
        } else {
          storeGoToColumnRequest(undefined);
        }
        setDiff(response.kind === "stepPreview" ? response.diff : undefined);
        setRemainingMissingCells(response.kind === "stepPreview" ? response.remainingMissingCells : undefined);
        setDraftBefore(
          response.kind === "stepPreview" && previous
            ? {
                schema:
                  response.metadata.draftReplacesStepId === undefined
                    ? previous.metadata.schema
                    : (response.metadata.latestStepInputSchema ?? previous.metadata.schema),
                ...(response.metadata.draftReplacesStepId === undefined &&
                previous.page.offset === response.page.offset &&
                isExactGridPage(previous.page)
                  ? { page: previous.page }
                  : {})
              }
            : undefined
        );
        setDraftWarnings(response.kind === "stepPreview" ? (response.warnings ?? []) : []);
        if (response.kind === "stepPreview") closeOperationDialog();
        else clearStepInspection(false, false);
        restartProfilingAfterMutation(nextMetadata);
        if (shouldRestoreUndoFocus) {
          scheduleWebviewFocusRestoration(() => {
            document.querySelector<HTMLButtonElement>("[data-cleaning-plan-focus-fallback]:not(:disabled)")?.focus();
          });
        }
        return;
      }

      if (response.kind === "summary" || response.kind === "columnValues" || response.kind === "datasetStats") {
        const settlement = settleProfileMessage(response);
        const current = metadataRef.current;
        if (settlement.stats && current) storeMetadata({ ...current, stats: settlement.stats });
        return;
      }
    };
    const listener: typeof handleMessage = (event) => {
      try {
        handleMessage(event);
      } catch {
        reportWebviewFailure("message");
      }
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ kind: "ready" });
    return () => {
      window.removeEventListener("message", listener);
    };
  }, [
    acceptSynchronization,
    beginMutation,
    clearSynchronization,
    clearStepInspection,
    closeOperationDialog,
    confirmView,
    deleteStep,
    isImportOptionsPending,
    nextViewRequestId,
    requestOperationIntent,
    requestImportOptionsChange,
    requestColumnReveal,
    requestStepInspection,
    resetConfirmedFilterHistory,
    resetGridViewState,
    restoreHostGridViewState,
    settleModeChange,
    restartProfilingAfterMutation,
    restartProfilingForConfirmedView,
    restoreConfirmedViewState,
    restoreViewAfterPageFailure,
    resetViewProfiling,
    settleProfileMessage,
    storeConfirmedFilterHistory,
    storeFailedPageRequest,
    storeFilterModel,
    storeGoToColumnRequest,
    setImportOptionsRequestPending,
    storeMetadata,
    storePage,
    storePendingStepInspection,
    storeStepInspection,
    storeStepInspectionTarget,
    updateImportOptionsPending
  ]);

  useEffect(() => {
    if (
      !queuedOperationIntent ||
      loading ||
      mutationPending ||
      projectionLoading ||
      importOptionsPending ||
      foregroundRequest.current
    ) {
      return;
    }
    if (queuedOperationIntent.action === "editStep" && stepInspection?.stepId !== queuedOperationIntent.stepId) {
      return;
    }
    const timer = window.setTimeout(() => {
      setQueuedOperationIntent(undefined);
      requestOperationIntent(queuedOperationIntent, queuedOperationIntent.sessionId, queuedOperationIntent.revision);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    importOptionsPending,
    loading,
    mutationPending,
    projectionLoading,
    queuedOperationIntent,
    requestOperationIntent,
    stepInspection
  ]);

  useEffect(() => {
    if (
      !queuedStepSelection ||
      loading ||
      mutationPending ||
      projectionLoading ||
      importOptionsPending ||
      foregroundRequest.current
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (foregroundRequest.current || isImportOptionsPending()) return;
      setQueuedStepSelection(undefined);
      const currentMetadata = metadataRef.current;
      if (
        !currentMetadata ||
        currentMetadata.sessionId !== queuedStepSelection.sessionId ||
        currentMetadata.revision !== queuedStepSelection.revision
      ) {
        return;
      }
      if (queuedStepSelection.stepId) {
        if (currentMetadata.steps.some((step) => step.id === queuedStepSelection.stepId)) {
          requestStepInspection(queuedStepSelection.stepId);
        }
        return;
      }
      clearStepInspection();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    clearStepInspection,
    importOptionsPending,
    isImportOptionsPending,
    loading,
    mutationPending,
    projectionLoading,
    queuedStepSelection,
    requestStepInspection
  ]);

  const inspectionMode = Boolean(stepInspectionTarget);
  const displayMetadata = useMemo<SessionMetadata | undefined>(() => {
    if (!metadata || !stepInspection) return metadata;
    const shape = { rows: stepInspection.outputPage.totalRows, columns: stepInspection.outputSchema.length };
    return {
      ...metadata,
      shape,
      filteredShape: shape,
      schema: stepInspection.outputSchema,
      ...(metadata.backend === "pandas" ? { rowAxis: stepInspection.outputRowAxis } : {})
    };
  }, [metadata, stepInspection]);
  const displayPage = inspectionMode
    ? pendingStepInspection?.reason === "selection" || pendingStepInspection?.reason === "row"
      ? undefined
      : stepInspection?.outputPage
    : page;
  const selectedInspectionStep = metadata?.steps.find((step) => step.id === stepInspectionTarget?.stepId);
  const inspectionGridViewState = useMemo<GridViewState>(() => {
    const columnIds = new Set(stepInspection?.outputSchema.map((column) => column.id) ?? []);
    return {
      columnWidths: new Map([...gridViewState.columnWidths].filter(([columnId]) => columnIds.has(columnId))),
      viewport: {
        firstVisibleRow: stepInspection?.outputPage.offset ?? stepInspectionTarget?.offset ?? 0,
        scrollLeft: gridViewState.viewport.scrollLeft
      }
    };
  }, [gridViewState.columnWidths, gridViewState.viewport.scrollLeft, stepInspection, stepInspectionTarget]);
  const snapshotMode = metadata?.source.kind === "notebookOutput";
  const filterSupported = metadata ? supportsViewingCapability(metadata.capabilities, "filter") : true;
  const sortSupported = metadata ? supportsViewingCapability(metadata.capabilities, "sort") : true;
  const profileSupported = metadata ? supportsViewingCapability(metadata.capabilities, "profile") : true;
  const columnValuesSupported = metadata ? supportsViewingCapability(metadata.capabilities, "columnValues") : true;
  const filterPanelSupported = filterSupported || sortSupported;
  const filterPanelLabel = filterSupported ? (sortSupported ? "Filters / Sorts" : "Filters") : "Sorts";
  const sidePanelLabel = profileSupported
    ? filterSupported
      ? "Column profiles and filters"
      : sortSupported
        ? "Column profiles and sorts"
        : "Column profiles"
    : filterPanelLabel;

  const requestPage = (
    offset: number,
    model = filterModelRef.current,
    options: PageRequestOptions = {}
  ): string | undefined => {
    if (isImportOptionsPending() || foregroundRequest.current === "mutation" || stepInspectionTargetRef.current) {
      return undefined;
    }
    const currentMetadata = metadataRef.current;
    const viewRequestId = nextViewRequestId();
    const previousContextId = confirmedView.current?.viewContextId;
    const changesView = options.changesView ?? !previousContextId;
    const reason = options.reason ?? (changesView ? "view" : "row");
    const viewContextId = options.viewContextId ?? (changesView ? viewRequestId : (previousContextId ?? viewRequestId));
    const requestedWindow = options.columnWindow ?? desiredColumnWindow.current;
    const columnWindow: ColumnWindow = currentMetadata?.schema.length
      ? {
          offset: Math.max(0, Math.min(Math.floor(requestedWindow.offset), currentMetadata.schema.length - 1)),
          limit: Math.max(1, Math.min(256, Math.floor(requestedWindow.limit)))
        }
      : { offset: 0, limit: Math.max(1, Math.min(256, Math.floor(requestedWindow.limit))) };
    const previousConfirmedState = changesView
      ? (latestPageRequest.current?.previousConfirmedState ?? captureConfirmedViewState())
      : undefined;
    const pendingPage: PendingPageRequest = {
      viewRequestId,
      viewContextId,
      changesView,
      offset,
      model,
      columnWindow,
      reason,
      previousConfirmedState,
      ...(options.filterHistoryUndoTarget ? { filterHistoryUndoTarget: options.filterHistoryUndoTarget } : {})
    };
    latestPageRequest.current = pendingPage;
    foregroundRequest.current = { kind: "page", viewRequestId };
    setFilterBarRequestLifecycle({ pendingRequestId: viewRequestId });
    desiredColumnWindow.current = columnWindow;
    storeFailedPageRequest(undefined);
    setForegroundError(undefined);
    if (changesView) {
      resetViewProfiling({ preserveColumnValues: true });
      if (currentMetadata) storeMetadata(withoutDatasetStats(currentMetadata));
    }
    storeFilterModel(model);
    if (reason === "projection") setProjectionLoading(true);
    else {
      setProjectionLoading(false);
      setLoading(true);
    }
    vscode.postMessage({
      kind: "runtimeRequest",
      viewContextId,
      request: {
        kind: "getPage",
        viewRequestId,
        offset,
        limit: pageSize,
        columnOffset: columnWindow.offset,
        columnLimit: columnWindow.limit,
        filterModel: model
      }
    });
    return viewRequestId;
  };

  const handleVisibleColumnRange = (range: VisibleColumnRange): void => {
    if (isImportOptionsPending()) return;
    if (stepInspectionTargetRef.current) {
      const currentInspection = stepInspectionRef.current;
      const currentMetadata = metadataRef.current;
      if (!currentInspection || !currentMetadata) return;
      const inspectionMetadata: SessionMetadata = {
        ...currentMetadata,
        schema: currentInspection.outputSchema
      };
      const window = alignedColumnWindow(
        range,
        currentInspection.outputSchema.length,
        webviewConfig.fetchColumnBlockSize
      );
      inspectionColumnWindow.current = window;
      if (pageCoversColumnWindow(inspectionMetadata, currentInspection.outputPage, window)) return;
      const pending = pendingStepInspectionRef.current;
      if (pending) return;
      requestStepInspection(currentInspection.stepId, currentInspection.outputPage.offset, window, "projection");
      return;
    }

    const currentMetadata = metadataRef.current;
    const currentPage = pageRef.current;
    if (!currentMetadata || !currentPage) return;
    const window = alignedColumnWindow(range, currentMetadata.schema.length, webviewConfig.fetchColumnBlockSize);
    desiredColumnWindow.current = window;
    if (pageCoversColumnWindow(currentMetadata, currentPage, window)) return;
    const pending = latestPageRequest.current;
    if (pending) return;
    requestPage(currentPage.offset, currentMetadata.filterModel, {
      changesView: false,
      viewContextId: confirmedView.current?.viewContextId,
      columnWindow: window,
      reason: "projection"
    });
  };

  const applyFilters = (model: FilterModel, options: ApplyFilterOptions = {}): string | undefined => {
    if (isImportOptionsPending() || foregroundRequest.current === "mutation" || stepInspectionTargetRef.current) {
      return;
    }
    const nextModel = compactFilterModel(model);
    const pendingPage = latestPageRequest.current;
    let filterHistoryUndoTarget = options.filterHistoryUndoTarget;
    if (filterHistoryUndoTarget && !sameConfirmedFilters(nextModel, filterHistoryUndoTarget)) return;
    if (pendingPage?.filterHistoryUndoTarget) {
      if (!sameConfirmedFilters(nextModel, pendingPage.filterHistoryUndoTarget)) return;
      filterHistoryUndoTarget ??= pendingPage.filterHistoryUndoTarget;
    }
    const capabilityMetadata = metadataRef.current;
    if (
      capabilityMetadata &&
      ((!supportsViewingCapability(capabilityMetadata.capabilities, "filter") &&
        !sameFilterRules(nextModel, filterModelRef.current)) ||
        (!supportsViewingCapability(capabilityMetadata.capabilities, "sort") &&
          !sameSortRules(nextModel, filterModelRef.current)))
    ) {
      return;
    }
    const sameDesiredModel = sameFilterModel(nextModel, filterModelRef.current);
    if (sameDesiredModel && pendingPage && sameFilterModel(nextModel, pendingPage.model)) {
      return;
    }
    storeFilterModel(nextModel);
    const currentMetadata = metadataRef.current;
    const failed = failedPageRequestRef.current;
    if (sameDesiredModel && failed && sameFilterModel(nextModel, failed.model)) {
      return requestPage(failed.offset, failed.model, {
        changesView: failed.changesView,
        viewContextId: failed.viewContextId,
        columnWindow: failed.columnWindow,
        reason: failed.reason,
        ...(failed.filterHistoryUndoTarget
          ? { filterHistoryUndoTarget: failed.filterHistoryUndoTarget }
          : filterHistoryUndoTarget
            ? { filterHistoryUndoTarget }
            : {})
      });
    }
    if (
      sameDesiredModel &&
      !pendingPage &&
      currentMetadata &&
      sameFilterModel(nextModel, currentMetadata.filterModel)
    ) {
      return;
    }

    return requestPage(0, nextModel, {
      changesView: true,
      ...(filterHistoryUndoTarget ? { filterHistoryUndoTarget } : {})
    });
  };

  const undoLatestFilter = (): string | undefined => {
    if (foregroundRequest.current || isImportOptionsPending() || stepInspectionTargetRef.current) return;
    const undo = latestConfirmedFilterUndo(confirmedFilterHistoryRef.current, filterModelRef.current);
    if (!undo) return;
    return applyFilters(undo.model, { filterHistoryUndoTarget: undo.target });
  };

  useEffect(() => {
    clearFilterColumnActionRef.current = (column) => {
      if (
        stepInspectionTargetRef.current ||
        !metadataRef.current ||
        !supportsViewingCapability(metadataRef.current.capabilities, "filter")
      )
        return;
      const current = filterModelRef.current;
      applyFilters({
        ...current,
        filters: current.filters.filter((filter) => filter.column !== column)
      });
    };

    changeViewSortActionRef.current = ({
      column,
      action,
      expectedSessionId,
      expectedSortModelSignature,
      expectedSortIndex
    }) => {
      const current = filterModelRef.current;
      if (
        stepInspectionTargetRef.current ||
        !metadataRef.current ||
        !supportsViewingCapability(metadataRef.current.capabilities, "sort") ||
        metadataRef.current?.sessionId !== expectedSessionId ||
        viewSortModelSignature(current) !== expectedSortModelSignature ||
        !Number.isInteger(expectedSortIndex) ||
        current.sort.filter((rule) => rule.column === column).length !== 1 ||
        current.sort[expectedSortIndex]?.column !== column
      ) {
        return;
      }
      const index = expectedSortIndex;
      if (action === "remove") {
        applyFilters({
          ...current,
          sort: current.sort.filter((_, ruleIndex) => ruleIndex !== index)
        });
        return;
      }
      const nextIndex = index + (action === "moveUp" ? -1 : 1);
      if (nextIndex < 0 || nextIndex >= current.sort.length) return;
      const sort = [...current.sort];
      const currentRule = sort[index];
      const adjacentRule = sort[nextIndex];
      if (!currentRule || !adjacentRule) return;
      applyFilters({
        ...current,
        sort: sort.map((rule, ruleIndex) => {
          if (ruleIndex === index) return adjacentRule;
          if (ruleIndex === nextIndex) return currentRule;
          return rule;
        })
      });
    };
  });

  const previewStep = (step: TransformStep, replaceStepId?: string) => {
    if (!supportsOperation(metadataRef.current?.capabilities, step.kind)) {
      setForegroundError("That cleaning operation is not available for the current dataframe.");
      return;
    }
    if (!beginMutation()) return;
    const columnWindow = desiredColumnWindow.current;
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: "previewStep",
        step,
        ...(replaceStepId === undefined ? {} : { replaceStepId }),
        offset: 0,
        limit: pageSize,
        columnOffset: columnWindow.offset,
        columnLimit: columnWindow.limit
      }
    });
  };

  const sendPlanAction = (action: "applyDraft" | "discardDraft" | "undoStep", undoReturnTarget?: HTMLButtonElement) => {
    if (!beginMutation()) return;
    undoPlanReturnFocus.current =
      action === "undoStep" &&
      metadataRef.current?.steps.length === 1 &&
      metadataRef.current.draftStep === undefined &&
      undoReturnTarget !== undefined &&
      document.hasFocus() &&
      document.activeElement === undoReturnTarget
        ? undoReturnTarget
        : null;
    const columnWindow = desiredColumnWindow.current;
    const draftTarget = metadataRef.current?.draftReplacesStepId;
    const latestStepId = metadataRef.current?.steps.at(-1)?.id;
    if (action === "applyDraft" && draftTarget !== undefined && draftTarget !== latestStepId) {
      vscode.postMessage({
        kind: "rewriteCleaningPlan",
        action,
        stepId: draftTarget,
        offset: 0,
        limit: pageSize,
        columnOffset: columnWindow.offset,
        columnLimit: columnWindow.limit
      });
      return;
    }
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: action,
        offset: 0,
        limit: pageSize,
        columnOffset: columnWindow.offset,
        columnLimit: columnWindow.limit
      }
    });
  };

  const deleteInspectedStep = () => {
    const target = stepInspectionTargetRef.current;
    if (target) deleteStep(target.stepId);
  };

  const selectSummaryPanelView = (view: SummaryPanelView) => {
    const currentMetadata = metadataRef.current;
    if (!currentMetadata) return;
    if (
      (view === "filters" &&
        !supportsViewingCapability(currentMetadata.capabilities, "filter") &&
        !supportsViewingCapability(currentMetadata.capabilities, "sort")) ||
      (view !== "filters" && !supportsViewingCapability(currentMetadata.capabilities, "profile"))
    ) {
      return;
    }
    summaryPanelViewRef.current = view;
    setSummaryPanelView(view);
    if (view !== "filters") return;
    const selectedColumn = selectedSummaryColumnId ? schemaById.get(selectedSummaryColumnId) : undefined;
    if (!selectedColumn) return;
    setFilterColumn(selectedColumn.name);
    requestValues(selectedColumn.name);
  };

  const closeSidePanel = () => {
    sidePanelOpenRef.current = false;
    setSidePanelOpen(false);
    releaseDrawerProfiling();
    const returnTarget = sidePanelReturnFocus.current;
    sidePanelReturnFocus.current = null;
    scheduleWebviewFocusRestoration(() => {
      if (canRestoreFocusTo(returnTarget)) returnTarget.focus();
      else sidePanelToggleRef.current?.focus();
    });
  };

  const handleKeyboardShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const editableTarget = isEditableKeyboardTarget(event.target);
    let handled = false;

    if (event.key === "Escape") {
      if (operationOpen) {
        if (foregroundRequest.current !== "mutation") {
          closeOperationDialog();
          handled = true;
        }
      } else if (stepInspectionTargetRef.current) {
        clearStepInspection();
        handled = true;
      } else if (sidePanelOpenRef.current) {
        closeSidePanel();
        handled = true;
      } else if (metadata?.draftStep) {
        if (!projectionLoading) {
          sendPlanAction("discardDraft");
          handled = true;
        }
      }
    } else if (
      modifier &&
      !event.altKey &&
      !event.shiftKey &&
      event.key === "Enter" &&
      metadata?.draftStep &&
      !projectionLoading
    ) {
      sendPlanAction("applyDraft");
      handled = true;
    } else if (!editableTarget && modifier && event.altKey && !event.shiftKey && key === "z") {
      if (!projectionLoading && !metadata?.draftStep && metadata?.steps.length) {
        const activeElement = document.activeElement;
        const undoReturnTarget =
          activeElement instanceof HTMLButtonElement && activeElement.hasAttribute("data-cleaning-plan-undo")
            ? activeElement
            : undefined;
        sendPlanAction("undoStep", undoReturnTarget);
        handled = true;
      }
    } else if (!editableTarget && modifier && event.shiftKey && !event.altKey && key === "e") {
      if (!projectionLoading && !metadata?.draftStep && metadata?.steps.length) {
        requestOperationIntent({ action: "editLatest" });
        handled = true;
      }
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const retryFailedPage = () => {
    const failed = failedPageRequestRef.current;
    if (!failed) return;
    restoreGridFocusForPage.current = requestPage(failed.offset, failed.model, {
      changesView: failed.changesView,
      viewContextId: failed.viewContextId,
      columnWindow: failed.columnWindow,
      reason: failed.reason,
      ...(failed.filterHistoryUndoTarget ? { filterHistoryUndoTarget: failed.filterHistoryUndoTarget } : {})
    });
  };

  const reconnectLiveSession = () => {
    if (liveSessionReconnectPending) return;
    cancelPendingProfiling();
    setLiveSessionReconnectPending(true);
    vscode.postMessage({ kind: "reconnectLiveSource" });
  };

  const backgroundDiagnosticMessages = [...backgroundDiagnostics.values()].map((diagnostic) => diagnostic.message);
  const projectionStatusId = projectionLoading ? "column-projection-status" : undefined;
  const projectionActionTitle = projectionLoading ? "Wait for the visible columns to finish loading." : undefined;
  const importOptionsDisabled = loading || mutationPending || projectionLoading || importOptionsPending;
  // A terminal open error has already settled the host request. Generic grid
  // loading state can outlive a replaced Cursor renderer, so it must not leave
  // the only recovery action permanently disabled. The host revalidates the
  // exact missing-dependency response before it offers confirmation.
  const installDependencyDisabled = runtimeDependencyInstallPending || importOptionsPending;
  const visibleShape = metadata ? (displayMetadata ?? metadata).filteredShape : undefined;
  const visibleShapeText = visibleShape
    ? visibleShape.rows === null
      ? `${visibleShape.columns.toLocaleString()} columns · rows not counted`
      : `${visibleShape.rows.toLocaleString()} × ${visibleShape.columns.toLocaleString()}`
    : "Preparing session";
  const visibleShapeTitle = visibleShape
    ? `${formatSessionRowCount(visibleShape.rows)} ${visibleShape.rows === 1 ? "row" : "rows"} × ${visibleShape.columns.toLocaleString()} ${visibleShape.columns === 1 ? "column" : "columns"}`
    : undefined;
  const visibleShapeLabel = visibleShape
    ? `${formatSessionRowCount(visibleShape.rows)} ${visibleShape.rows === 1 ? "row" : "rows"} by ${visibleShape.columns.toLocaleString()} ${visibleShape.columns === 1 ? "column" : "columns"}`
    : undefined;

  if (foregroundError && !metadata) {
    return (
      <main className="app app-error">
        <h1>Open Wrangler</h1>
        <p role="alert">{foregroundError}</p>
        <div className="errorActions">
          {foregroundErrorCode === "missing_dependencies" && (
            <button
              type="button"
              className="toolbarButton"
              disabled={installDependencyDisabled}
              aria-busy={runtimeDependencyInstallPending || undefined}
              onClick={(event) => {
                event.currentTarget.blur();
                setRuntimeDependencyInstallPending(true);
                vscode.postMessage({ kind: "installRuntimeDependencies" });
              }}
            >
              <span className="codicon codicon-cloud-download" aria-hidden="true" /> Install required dependency
            </button>
          )}
          {webviewConfig.canChangeImportOptions && (
            <button
              type="button"
              className="toolbarButton"
              disabled={importOptionsDisabled}
              aria-busy={importOptionsPending || undefined}
              data-import-options-action
              title="Change file import options"
              onClick={(event) => requestImportOptionsChange(undefined, event.currentTarget)}
            >
              <span className="codicon codicon-settings-gear" aria-hidden="true" /> Import options
            </button>
          )}
        </div>
        {importOptionsPending && (
          <span className="importOptionsStatus" role="status" aria-live="polite">
            Updating import options…
          </span>
        )}
        {runtimeDependencyInstallPending && (
          <span className="importOptionsStatus" role="status" aria-live="polite">
            Waiting for dependency confirmation…
          </span>
        )}
      </main>
    );
  }

  return (
    <main
      className="app"
      data-session-id={metadata?.sessionId}
      data-renderer-sync-id={
        metadata &&
        acceptedSynchronization?.sessionId === metadata.sessionId &&
        acceptedSynchronization.revision === metadata.revision
          ? acceptedSynchronization.syncId
          : undefined
      }
      tabIndex={-1}
      onKeyDown={handleKeyboardShortcut}
    >
      <div
        className="appWorkspace"
        data-testid="app-workspace"
        inert={operationOpen || sessionModeChangePending}
        aria-hidden={operationOpen ? true : undefined}
      >
        <header
          className={metadata && sessionModeAction(metadata) ? "toolbar toolbarWithSessionModeAction" : "toolbar"}
        >
          <div className="toolbarIdentity">
            <strong>{metadata?.source.label ?? "Loading dataframe..."}</strong>
            <span aria-label={visibleShapeLabel} title={visibleShapeTitle}>
              {visibleShapeText}
            </span>
          </div>
          {metadata && (
            <div className="toolbarActions">
              {metadata.source.kind === "file" && webviewConfig.canChangeImportOptions && (
                <button
                  type="button"
                  className="toolbarButton"
                  disabled={importOptionsDisabled}
                  aria-busy={importOptionsPending || undefined}
                  data-import-options-action
                  title="Change file import options"
                  onClick={(event) => requestImportOptionsChange(undefined, event.currentTarget)}
                >
                  <span className="codicon codicon-settings-gear" aria-hidden="true" /> Import options
                </button>
              )}
              {metadata.mode === "editing" && (
                <button
                  type="button"
                  data-operation-focus-fallback
                  data-cleaning-plan-focus-fallback
                  disabled={loading || projectionLoading || importOptionsPending || !canStartOperation(metadata)}
                  aria-describedby={projectionStatusId}
                  title={
                    projectionActionTitle ??
                    (metadata.draftStep ? "Apply or discard the current draft before adding another step." : undefined)
                  }
                  onClick={() => requestOperationIntent({ action: "open" })}
                >
                  <span className="codicon codicon-add" aria-hidden="true" /> Add step
                </button>
              )}
              {metadata.mode === "editing" && metadata.steps.length > 0 && !metadata.draftStep && (
                <div className="toolbarPlan" role="group" aria-label="Cleaning plan">
                  <span className="toolbarPlanStatus">
                    <span className="codicon codicon-layers" aria-hidden="true" />
                    <span>
                      {metadata.steps.length} applied {metadata.steps.length === 1 ? "step" : "steps"}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="secondaryButton"
                    disabled={loading || projectionLoading || importOptionsPending}
                    aria-describedby={projectionStatusId}
                    aria-keyshortcuts="Control+Shift+E Meta+Shift+E"
                    title={projectionActionTitle ?? "Edit latest step (Ctrl/Cmd+Shift+E)"}
                    onClick={() => requestOperationIntent({ action: "editLatest" })}
                  >
                    Edit latest
                  </button>
                  <button
                    type="button"
                    className="secondaryButton"
                    data-cleaning-plan-undo
                    disabled={loading || projectionLoading || importOptionsPending}
                    aria-describedby={projectionStatusId}
                    aria-keyshortcuts="Control+Alt+Z Meta+Alt+Z"
                    title={projectionActionTitle ?? "Undo latest step (Ctrl/Cmd+Alt+Z)"}
                    onClick={(event) => sendPlanAction("undoStep", event.currentTarget)}
                  >
                    <span className="codicon codicon-discard" aria-hidden="true" /> Undo
                  </button>
                </div>
              )}
              {(metadata.capabilities.exportCsv || metadata.capabilities.exportParquet) && (
                <button
                  type="button"
                  className="toolbarButton"
                  disabled={
                    loading ||
                    mutationPending ||
                    projectionLoading ||
                    importOptionsPending ||
                    metadata.draftStep !== undefined
                  }
                  title={
                    metadata.draftStep
                      ? "Apply or discard the current draft before exporting cleaned data."
                      : "Export cleaned data"
                  }
                  onClick={() => vscode.postMessage({ kind: "exportData" })}
                >
                  <span className="codicon codicon-export" aria-hidden="true" /> Export
                </button>
              )}
              <button
                ref={sidePanelToggleRef}
                type="button"
                className="toolbarButton"
                aria-label={
                  inspectionMode
                    ? "Filters paused during inspection"
                    : profileSupported || filterPanelSupported
                      ? sidePanelLabel
                      : "Profiles and filters unavailable"
                }
                aria-expanded={sidePanelOpen}
                aria-controls="openwrangler-insights-panel"
                disabled={inspectionMode || importOptionsPending || (!profileSupported && !filterPanelSupported)}
                title={
                  inspectionMode
                    ? "Clear the selected-step inspection to use filters and column profiles."
                    : !profileSupported && !filterPanelSupported
                      ? "Column profiles, filters, and sorts are unavailable for this dataframe."
                      : undefined
                }
                onClick={(event) => {
                  if (sidePanelOpenRef.current) {
                    closeSidePanel();
                    return;
                  }
                  sidePanelReturnFocus.current = event.currentTarget;
                  const initialView: SummaryPanelView = profileSupported ? "column" : "filters";
                  summaryPanelViewRef.current = initialView;
                  setSummaryPanelView(initialView);
                  sidePanelOpenRef.current = true;
                  setSidePanelOpen(true);
                }}
              >
                {inspectionMode
                  ? "Filters paused during inspection"
                  : profileSupported
                    ? "Column profiles"
                    : filterPanelSupported
                      ? filterPanelLabel
                      : "Profiles unavailable"}
              </button>
              <ColumnSearch
                columns={(displayMetadata ?? metadata).schema}
                selectedColumnId={gridViewState.selectedColumnId}
                onSelect={requestColumnReveal}
              />
              <SessionModeControl
                metadata={metadata}
                busy={sessionModeChangePending}
                onSwitch={requestSessionModeChange}
              />
              {metadata.backend === "pyspark" && (
                <details className="orderingHelp">
                  <summary
                    aria-describedby="pyspark-ordering-help"
                    className="sessionBadge modeBadge orderingBadge"
                    data-session-badge="ordering"
                  >
                    {filterModel.sort.length === 0 ? "Source order" : "Sorted"}
                    <span className="codicon codicon-info" aria-hidden="true" />
                  </summary>
                  <span id="pyspark-ordering-help" className="orderingHelpText" role="note">
                    {filterModel.sort.length === 0
                      ? "Spark does not guarantee source order. Add a sort with a unique final key when you need repeatable rows."
                      : "Rows tied across every sort key may move when Spark reruns this dataframe. Add a unique final sort key for repeatable rows."}
                  </span>
                </details>
              )}
              {metadata.source.kind === "file" && isSwitchableFileBackend(metadata.backend) ? (
                <button
                  type="button"
                  className="sessionBadge backendBadge backendButton"
                  data-session-badge="backend"
                  disabled={importOptionsDisabled}
                  aria-busy={importOptionsPending || undefined}
                  aria-label={`Change dataframe engine. Current engine: ${dataBackendLabel(metadata.backend)}`}
                  title="Change dataframe engine"
                  onClick={() => vscode.postMessage({ kind: "changeBackend" })}
                >
                  <span>{dataBackendLabel(metadata.backend)}</span>
                  <span className="codicon codicon-chevron-down" aria-hidden="true" />
                </button>
              ) : (
                <span className="sessionBadge backendBadge" data-session-badge="backend">
                  {dataBackendLabel(metadata.backend)}
                </span>
              )}
              {snapshotMode && (
                <span className="sessionBadge modeBadge" data-session-badge="snapshot">
                  Snapshot
                </span>
              )}
              {inspectionMode && (
                <span className="sessionBadge inspectionBadge" data-session-badge="inspection">
                  Step inspection
                </span>
              )}
            </div>
          )}
        </header>

        {metadata && metadata.mode === "editing" && metadata.draftStep && (
          <section className="draftReview" aria-label="Draft review">
            <div className="draftReviewHeading">
              <span className="codicon codicon-beaker" aria-hidden="true" />
              <span className="draftReviewLabel">Draft review</span>
              <strong>{operationByKind(metadata.draftStep.kind).title}</strong>
            </div>
            {diff && (
              <div className="diffStats draftReviewDiff" aria-label="Data diff summary">
                {draftDiffLabels(diff, displayPage?.rows.length ?? 0).map((label) => (
                  <span key={label}>{label}</span>
                ))}
                {remainingMissingCells !== undefined && (
                  <span role="status" aria-live="polite" aria-atomic="true">
                    {fillMissingResultLabel(remainingMissingCells, metadata.draftStep)}
                  </span>
                )}
              </div>
            )}
            {draftWarnings.length > 0 && (
              <div className="draftReviewWarnings" role="alert">
                {draftWarnings.map((warning) => (
                  <span key={warning}>
                    <span className="codicon codicon-warning" aria-hidden="true" /> {warning}
                  </span>
                ))}
              </div>
            )}
            <div className="cleaningActions">
              <button
                type="button"
                className="secondaryButton"
                disabled={loading || projectionLoading || importOptionsPending}
                aria-describedby={projectionStatusId}
                aria-keyshortcuts="Escape"
                title={projectionActionTitle ?? "Discard draft (Escape)"}
                onClick={() => sendPlanAction("discardDraft")}
              >
                Discard
              </button>
              <button
                type="button"
                data-operation-focus-fallback
                disabled={loading || projectionLoading || importOptionsPending}
                aria-describedby={projectionStatusId}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                title={projectionActionTitle ?? "Apply draft (Ctrl/Cmd+Enter)"}
                onClick={() => sendPlanAction("applyDraft")}
              >
                Apply step
              </button>
            </div>
          </section>
        )}

        {metadata && inspectionMode && (
          <StepInspectionPanel
            operationTitle={selectedInspectionStep ? operationByKind(selectedInspectionStep.kind).title : undefined}
            pendingOffset={pendingStepInspection?.offset}
            pageSize={pageSize}
            error={stepInspectionError}
            diff={stepInspection?.diff}
            canModify={Boolean(
              selectedInspectionStep &&
              stepInspection &&
              metadata.mode === "editing" &&
              !metadata.draftStep &&
              !loading &&
              !projectionLoading &&
              !importOptionsPending
            )}
            onEdit={() => {
              if (selectedInspectionStep)
                requestOperationIntent({ action: "editStep", stepId: selectedInspectionStep.id });
            }}
            onDelete={deleteInspectedStep}
            onClear={clearStepInspection}
          />
        )}

        <section className={`layout${sidePanelOpen ? " sidePanelOpen" : ""}`}>
          <section className="gridShell">
            {foregroundError && (
              <div className="errorBanner" role="alert">
                <span>{foregroundError}</span>
                {foregroundErrorCode === "pyspark_connect_state_lost" &&
                  metadata?.backend === "pyspark" &&
                  metadata.source.kind === "notebookVariable" && (
                    <button
                      type="button"
                      className="secondaryButton"
                      disabled={liveSessionReconnectPending}
                      aria-busy={liveSessionReconnectPending || undefined}
                      onClick={reconnectLiveSession}
                    >
                      {liveSessionReconnectPending ? "Reconnecting…" : "Reconnect"}
                    </button>
                  )}
                {failedPageRequest && foregroundErrorCode !== "pyspark_connect_state_lost" && (
                  <button type="button" className="secondaryButton" onClick={retryFailedPage}>
                    Retry page
                  </button>
                )}
              </div>
            )}
            {backgroundDiagnosticMessages.length > 0 && (
              <div className="errorBanner" role="status" aria-label="Profiling diagnostics">
                Profile warning: {backgroundDiagnosticMessages.join(" ")}
              </div>
            )}
            {metadata && filterSupported && (
              <ActiveFilterBar
                metadata={metadata}
                model={filterModel}
                disabled={loading || projectionLoading || mutationPending || importOptionsPending || inspectionMode}
                canUndo={confirmedFilterHistory.entries.length > 0}
                retainVisible={hasActiveFilters(metadata.filterModel)}
                requestLifecycle={filterBarRequestLifecycle}
                onApply={applyFilters}
                onUndo={undoLatestFilter}
              />
            )}
            {loading && displayMetadata && displayPage && (
              <div className="loading" role="status" aria-live="polite">
                Loading...
              </div>
            )}
            {projectionLoading && (
              <div id="column-projection-status" className="loading" role="status" aria-live="polite">
                Loading visible columns… Cleaning actions are temporarily unavailable.
              </div>
            )}
            {displayMetadata && displayPage ? (
              <DataGrid
                key={
                  inspectionMode
                    ? `inspection:${stepInspectionTarget?.stepId ?? "loading"}`
                    : `confirmed:${displayMetadata.sessionId}`
                }
                metadata={displayMetadata}
                page={displayPage}
                summaries={inspectionMode ? [] : summaries}
                profileValueMode={profileValueMode}
                onProfileValueModeChange={sidePanelOpen ? undefined : setProfileValueMode}
                onPage={(offset) => {
                  const stepId = stepInspectionTarget?.stepId;
                  if (stepId) requestStepInspection(stepId, offset, inspectionColumnWindow.current, "row");
                  else
                    requestPage(offset, filterModelRef.current, {
                      columnWindow: desiredColumnWindow.current,
                      reason: "row"
                    });
                }}
                pageSize={pageSize}
                defaultColumnWidth={webviewConfig.defaultColumnWidth}
                insightsOnOpen={inspectionMode ? false : webviewConfig.insightsOnOpen}
                busy={loading || Boolean(pendingStepInspection && pendingStepInspection.reason !== "projection")}
                projecting={projectionLoading || pendingStepInspection?.reason === "projection"}
                viewContextId={
                  inspectionMode ? `inspection:${stepInspectionTarget?.stepId ?? "loading"}` : activeViewContextId
                }
                goToColumnId={goToColumnRequest?.columnId}
                goToColumnRequestId={goToColumnRequest?.requestId}
                onGoToColumnHandled={handleColumnReveal}
                viewState={inspectionMode ? inspectionGridViewState : gridViewState}
                viewStateRestoreVersion={
                  inspectionMode ? (stepInspection?.outputPage.offset ?? 0) : viewStateRestoreVersion
                }
                diff={stepInspection?.diff ?? (metadata?.draftStep ? diff : undefined)}
                beforePage={stepInspection?.inputPage ?? draftBefore?.page}
                beforeSchema={stepInspection?.inputSchema ?? draftBefore?.schema}
                viewControlsDisabled={inspectionMode || importOptionsPending}
                viewControlsDisabledReason={
                  importOptionsPending ? "View controls are unavailable while import options are changing." : undefined
                }
                filterControlsDisabled={!filterSupported}
                sortControlsDisabled={!sortSupported}
                profilesDisabled={!profileSupported}
                sortRules={inspectionMode ? [] : filterModel.sort}
                onSortColumn={(column, direction) =>
                  inspectionMode || !sortSupported
                    ? undefined
                    : applyFilters({
                        ...filterModelRef.current,
                        sort: prioritizeSortRule(filterModelRef.current.sort, {
                          column,
                          direction,
                          nulls: filterModelRef.current.sort.find((rule) => rule.column === column)?.nulls ?? "last"
                        })
                      })
                }
                onClearSortColumn={(column) =>
                  inspectionMode || !sortSupported
                    ? undefined
                    : applyFilters({
                        ...filterModelRef.current,
                        sort: filterModelRef.current.sort.filter((rule) => rule.column !== column)
                      })
                }
                onApplyCellFilter={(filter) => {
                  if (inspectionMode || !filterSupported) return;
                  applyFilters(replaceViewColumnFilter(filterModelRef.current, filter));
                }}
                onApplyProfileFilter={(filter) => {
                  if (inspectionMode || !filterSupported) return;
                  sidePanelReturnFocus.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : sidePanelToggleRef.current;
                  setFilterColumn(filter.column);
                  summaryPanelViewRef.current = "column";
                  setSummaryPanelView("column");
                  sidePanelOpenRef.current = true;
                  setSidePanelOpen(true);
                  flushGridViewState();
                  applyFilters(replaceViewColumnFilter(filterModelRef.current, filter));
                }}
                onOpenFilter={(column) => {
                  if (inspectionMode || !filterSupported) return;
                  sidePanelReturnFocus.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : sidePanelToggleRef.current;
                  setFilterColumn(column);
                  summaryPanelViewRef.current = "filters";
                  setSummaryPanelView("filters");
                  sidePanelOpenRef.current = true;
                  setSidePanelOpen(true);
                  requestValues(column);
                }}
                onVisibleSummaryColumnsChange={
                  inspectionMode || !profileSupported ? () => undefined : updateVisibleSummaryColumns
                }
                onVisibleColumnRangeChange={handleVisibleColumnRange}
                onViewStateChange={inspectionMode || importOptionsPending ? () => undefined : publishGridViewState}
              />
            ) : (
              <div
                className={`emptyState${sessionOpenProgress ? " sessionOpenStatus" : ""}`}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {inspectionMode ? (
                  "Loading selected-step inspection…"
                ) : sessionOpenProgress ? (
                  <>
                    <strong>{sessionOpenProgressHeading(sessionOpenProgress)}</strong>
                    {sessionOpenProgress === "preparingSparkView" && (
                      <p>
                        Loading the first page without counting every row… The exact total appears after the last page.
                      </p>
                    )}
                  </>
                ) : (
                  "Opening session…"
                )}
              </div>
            )}
          </section>
          {sidePanelOpen && !inspectionMode && (profileSupported || filterPanelSupported) && (
            <aside id="openwrangler-insights-panel" className="sidebar" aria-label={sidePanelLabel}>
              <div className="drawerHeader">
                <strong>{profileSupported ? "Column profiles" : filterPanelLabel}</strong>
                <button
                  ref={sidePanelCloseRef}
                  type="button"
                  className="iconButton codicon codicon-close"
                  aria-label="Close panel"
                  onClick={closeSidePanel}
                />
              </div>
              <SummaryPanel
                metadata={metadata}
                summaries={summaries}
                schemaById={schemaById}
                selectedColumnId={selectedSummaryColumnId}
                activeView={summaryPanelView}
                profileSupported={profileSupported}
                filtersSupported={filterPanelSupported}
                viewFiltersSupported={filterSupported}
                filtersDisabled={mutationPending || importOptionsPending}
                filtersLabel={filterPanelLabel}
                filterModel={filterModel}
                profileValueMode={profileValueMode}
                onSelectView={selectSummaryPanelView}
                onProfileValueModeChange={setProfileValueMode}
                onShowMoreValues={
                  filterSupported && columnValuesSupported && !mutationPending && !importOptionsPending
                    ? (column) => {
                        setFilterColumn(column);
                        summaryPanelViewRef.current = "filters";
                        setSummaryPanelView("filters");
                        requestValues(column);
                      }
                    : undefined
                }
                onApplyFilterModel={applyFilters}
              />
              {summaryPanelView === "filters" && (
                <div
                  id={summaryPanelId("filters")}
                  className="filtersViewContent"
                  role="tabpanel"
                  aria-labelledby={summaryTabId("filters")}
                >
                  <FilterPanel
                    key={filterColumn}
                    metadata={metadata}
                    model={filterModel}
                    values={columnValues}
                    activeColumn={filterColumn}
                    defaultAdvanced={webviewConfig.filterMode === "advanced"}
                    disabled={mutationPending || importOptionsPending}
                    filterSupported={filterSupported}
                    sortSupported={sortSupported}
                    columnValuesSupported={columnValuesSupported}
                    onApply={applyFilters}
                    onRequestValues={requestValues}
                  />
                </div>
              )}
            </aside>
          )}
        </section>
      </div>
      {sessionModeChangePending && (
        <span className="sessionModeChangeStatus" role="status" aria-live="polite" aria-atomic="true">
          Opening {sessionModeChangeTarget === "viewing" ? "Viewing" : "Editing"} mode…
        </span>
      )}
      {metadata && operationDialog && (
        <OperationBuilder
          key={`${operationDialog.kind ?? "none"}:${operationDialog.editingStep?.id ?? "new"}`}
          metadata={metadata}
          filterModel={filterModel}
          initialKind={operationDialog.kind}
          initialStep={operationDialog.editingStep}
          editInputSchema={operationDialog.editingStepInputSchema}
          busy={loading || mutationPending || projectionLoading || importOptionsPending}
          onClose={() => {
            if (foregroundRequest.current !== "mutation") closeOperationDialog();
          }}
          onPreview={previewStep}
        />
      )}
    </main>
  );
}

function isEditableKeyboardTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function initialColumnWindow(): ColumnWindow {
  return { offset: 0, limit: webviewConfig.fetchColumnBlockSize };
}

function readWebviewConfig(): {
  fetchBlockSize: number;
  fetchColumnBlockSize: number;
  defaultColumnWidth: number;
  insightsOnOpen: boolean;
  filterMode: "basic" | "advanced";
  canChangeImportOptions: boolean;
} {
  const fetchBlockSize = Number(document.body.dataset.fetchBlockSize ?? 200);
  const fetchColumnBlockSize = Number(document.body.dataset.fetchColumnBlockSize ?? 16);
  const defaultColumnWidth = Number(document.body.dataset.defaultColumnWidth ?? 190);
  return {
    fetchBlockSize: Number.isFinite(fetchBlockSize) ? Math.max(25, Math.min(2000, fetchBlockSize)) : 200,
    fetchColumnBlockSize: Number.isFinite(fetchColumnBlockSize)
      ? Math.max(1, Math.min(256, Math.floor(fetchColumnBlockSize)))
      : 16,
    defaultColumnWidth: Number.isFinite(defaultColumnWidth) ? Math.max(80, Math.min(640, defaultColumnWidth)) : 190,
    insightsOnOpen: document.body.dataset.insightsOnOpen !== "false",
    filterMode: document.body.dataset.filterMode === "advanced" ? "advanced" : "basic",
    canChangeImportOptions: document.body.dataset.canChangeImportOptions === "true"
  };
}
