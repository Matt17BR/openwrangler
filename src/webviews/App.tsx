import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { flushSync } from "react-dom";
import type {
  ColumnSummary,
  ColumnSchema,
  DataDiff,
  OpenWranglerResponse,
  GridPage,
  LiveGridPage,
  OperationKind,
  SessionMetadata,
  StepInspectionResponse,
  TransformStep,
  ValuesResponse
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
  prioritizeSortRule,
  viewSortModelSignature,
  type FilterModel
} from "../shared/filterModel";
import { decodeGridViewState, emptyGridViewState, type GridViewState } from "../shared/viewState";
import { SESSION_OPEN_PROGRESS_STAGES, type SessionOpenProgressStage } from "../shared/sessionOpenProgress";
import { canEditLatestStep, canStartOperation, operationByKind } from "../shared/operations";
import { FilterPanel } from "./filters/FilterPanel";
import { DataGrid, type VisibleColumnRange } from "./grid/DataGrid";
import { SummaryPanel, summaryPanelId, summaryTabId, type SummaryPanelView } from "./summary/SummaryPanel";
import { OperationBuilder } from "./operations/OperationBuilder";
import { ColumnSearch } from "./ColumnSearch";
import { vscode } from "./vscodeApi";

const webviewConfig = readWebviewConfig();
const pageSize = webviewConfig.fetchBlockSize;
const sessionSnapshotRetryDelaysMs = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
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
  const [summaries, setSummaries] = useState<ColumnSummary[]>([]);
  const [filterModel, setFilterModel] = useState<FilterModel>(emptyFilterModel);
  const [columnValues, setColumnValues] = useState<ReadonlyMap<string, ValuesResponse>>(() => new Map());
  const [foregroundError, setForegroundError] = useState<string | undefined>();
  const [foregroundErrorCode, setForegroundErrorCode] = useState<string | undefined>();
  const [backgroundDiagnostics, setBackgroundDiagnostics] = useState<ReadonlyMap<string, BackgroundDiagnostic>>(
    () => new Map()
  );
  const [failedPageRequest, setFailedPageRequest] = useState<PendingPageRequest | undefined>();
  const [loading, setLoading] = useState(true);
  const [projectionLoading, setProjectionLoading] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [importOptionsPending, setImportOptionsPending] = useState(false);
  const [runtimeDependencyInstallPending, setRuntimeDependencyInstallPending] = useState(false);
  const [liveSessionReconnectPending, setLiveSessionReconnectPending] = useState(false);
  const [sessionOpenProgress, setSessionOpenProgress] = useState<SessionOpenProgressStage | undefined>();
  const [goToColumnRequest, setGoToColumnRequest] = useState<ColumnRevealRequest | undefined>();
  const goToColumnRequestSequence = useRef(0);
  const goToColumnRequestRef = useRef<ColumnRevealRequest | undefined>(undefined);
  const [filterColumn, setFilterColumn] = useState("");
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [summaryPanelView, setSummaryPanelView] = useState<SummaryPanelView>("column");
  const [operationOpen, setOperationOpen] = useState(false);
  const [operationKind, setOperationKind] = useState<OperationKind | undefined>();
  const [editingStep, setEditingStep] = useState<TransformStep | undefined>();
  const [diff, setDiff] = useState<DataDiff | undefined>();
  const [draftWarnings, setDraftWarnings] = useState<string[]>([]);
  const [stepInspection, setStepInspection] = useState<StepInspectionResponse | undefined>();
  const [pendingStepInspection, setPendingStepInspection] = useState<PendingStepInspection | undefined>();
  const [stepInspectionTarget, setStepInspectionTarget] = useState<PendingStepInspection | undefined>();
  const [stepInspectionError, setStepInspectionError] = useState<string | undefined>();
  const [draftBefore, setDraftBefore] = useState<DiffBeforeState | undefined>();
  const [activeViewContextId, setActiveViewContextId] = useState("");
  const [gridViewState, setGridViewState] = useState<GridViewState>(emptyGridViewState);
  const [viewStateRestoreVersion, setViewStateRestoreVersion] = useState(0);
  const [pendingRendererSynchronization, setPendingRendererSynchronization] = useState<
    RendererSynchronizationMessage | undefined
  >();
  const pendingRendererSynchronizationRef = useRef<RendererSynchronizationMessage | undefined>(undefined);
  const acknowledgedRendererSynchronizationId = useRef<string | undefined>(undefined);
  const metadataRef = useRef<SessionMetadata | undefined>(undefined);
  const pageRef = useRef<LiveGridPage | undefined>(undefined);
  const stepInspectionRef = useRef<StepInspectionResponse | undefined>(undefined);
  const pendingStepInspectionRef = useRef<PendingStepInspection | undefined>(undefined);
  const stepInspectionTargetRef = useRef<PendingStepInspection | undefined>(undefined);
  const summariesRef = useRef<ColumnSummary[]>([]);
  const columnValuesRef = useRef<ReadonlyMap<string, ValuesResponse>>(new Map());
  const backgroundDiagnosticsRef = useRef<ReadonlyMap<string, BackgroundDiagnostic>>(new Map());
  const filterModelRef = useRef<FilterModel>(emptyFilterModel());
  const clearFilterColumnActionRef = useRef<(column: string) => void>(() => undefined);
  const changeViewSortActionRef = useRef<(target: ViewSortActionTarget) => void>(() => undefined);
  const sidePanelOpenRef = useRef(false);
  const summaryPanelViewRef = useRef<SummaryPanelView>("column");
  const confirmedView = useRef<ConfirmedView | undefined>(undefined);
  const latestPageRequest = useRef<PendingPageRequest | undefined>(undefined);
  const failedPageRequestRef = useRef<PendingPageRequest | undefined>(undefined);
  const foregroundRequest = useRef<"mutation" | { kind: "page"; viewRequestId: string } | undefined>(undefined);
  const pendingBackgroundRequests = useRef(new Map<string, PendingBackgroundRequest>());
  const pendingSummaryByColumnId = useRef(new Map<string, string>());
  const summaryOwnersByColumnId = useRef(new Map<string, Set<SummaryRequestOwner>>());
  const pendingStatsRequest = useRef<string | undefined>(undefined);
  const latestValuesByColumn = useRef(new Map<string, string>());
  const retryTimers = useRef(new Map<number, PendingBackgroundRequest>());
  const restoreGridFocusForPage = useRef<string | undefined>(undefined);
  const mutationSnapshot = useRef<ConfirmedViewState | undefined>(undefined);
  const importOptionsPendingRef = useRef(false);
  const importOptionsUiBusyRef = useRef(true);
  const confirmedColumnWindow = useRef<ColumnWindow>(initialColumnWindow());
  const desiredColumnWindow = useRef<ColumnWindow>(initialColumnWindow());
  const inspectionColumnWindow = useRef<ColumnWindow>(initialColumnWindow());
  const sidePanelToggleRef = useRef<HTMLButtonElement | null>(null);
  const sidePanelCloseRef = useRef<HTMLButtonElement | null>(null);
  const sidePanelReturnFocus = useRef<HTMLElement | null>(null);
  const operationReturnFocus = useRef<HTMLElement | null>(null);
  const undoPlanReturnFocus = useRef<HTMLButtonElement | null>(null);
  const importOptionsReturnFocus = useRef<HTMLButtonElement | null>(null);
  const importOptionsFocusFrame = useRef<number | undefined>(undefined);
  const importOptionsDispatchFrame = useRef<number | undefined>(undefined);
  const operationWasOpen = useRef(false);
  const gridViewStateRef = useRef<GridViewState>(emptyGridViewState());
  const pendingGridViewState = useRef<GridViewState | undefined>(undefined);
  const gridViewStateTimer = useRef<number | undefined>(undefined);

  const nextViewRequestId = useCallback(() => {
    lastViewRequestSequence += 1;
    return `view-${viewRequestEpoch}-${lastViewRequestSequence}`;
  }, []);

  const rememberOperationReturnFocus = useCallback(() => {
    operationReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  const scheduleImportOptionsFocusRestoration = useCallback((returnTarget: HTMLButtonElement) => {
    if (importOptionsFocusFrame.current !== undefined) {
      window.cancelAnimationFrame(importOptionsFocusFrame.current);
    }
    importOptionsFocusFrame.current = scheduleWebviewFocusRestoration(() => {
      importOptionsFocusFrame.current = undefined;
      const targetIsAvailable = returnTarget.isConnected && !returnTarget.matches(":disabled");
      if (targetIsAvailable) {
        returnTarget.focus();
        return;
      }
      document.querySelector<HTMLButtonElement>("[data-import-options-action]:not(:disabled)")?.focus();
    });
  }, []);

  useEffect(
    () => () => {
      if (importOptionsFocusFrame.current !== undefined) {
        window.cancelAnimationFrame(importOptionsFocusFrame.current);
      }
      if (importOptionsDispatchFrame.current !== undefined) {
        window.cancelAnimationFrame(importOptionsDispatchFrame.current);
      }
      importOptionsReturnFocus.current = null;
    },
    []
  );

  useEffect(() => {
    if (operationOpen) {
      operationWasOpen.current = true;
      return;
    }
    if (!operationWasOpen.current) return;
    operationWasOpen.current = false;
    const returnTarget = operationReturnFocus.current;
    operationReturnFocus.current = null;
    const frame = scheduleWebviewFocusRestoration(() => {
      if (canRestoreFocusTo(returnTarget)) {
        returnTarget.focus();
        return;
      }
      document
        .querySelector<HTMLElement>(
          "[data-operation-focus-fallback]:not(:disabled), " +
            '[data-testid="data-grid-scroller"] [tabindex="0"], main.app'
        )
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [operationOpen]);

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

  const storeSummaries = useCallback((next: ColumnSummary[]) => {
    summariesRef.current = next;
    setSummaries(next);
  }, []);

  const storeColumnValues = useCallback((next: ReadonlyMap<string, ValuesResponse>) => {
    columnValuesRef.current = next;
    setColumnValues(next);
  }, []);

  const storeFailedPageRequest = useCallback((next: PendingPageRequest | undefined) => {
    failedPageRequestRef.current = next;
    setFailedPageRequest(next);
  }, []);

  const storeGridViewState = useCallback((next: GridViewState) => {
    gridViewStateRef.current = next;
    setGridViewState(next);
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

  const storeImportOptionsPending = useCallback(
    (pending: boolean) => {
      const wasPending = importOptionsPendingRef.current;
      if (!pending && importOptionsDispatchFrame.current !== undefined) {
        window.cancelAnimationFrame(importOptionsDispatchFrame.current);
        importOptionsDispatchFrame.current = undefined;
      }
      importOptionsPendingRef.current = pending;
      setImportOptionsPending(pending);
      if (pending) {
        setOperationOpen(false);
        setEditingStep(undefined);
        setOperationKind(undefined);
        setLoading(true);
      } else if (wasPending && foregroundRequest.current === undefined) setLoading(false);
      if (!pending && wasPending) {
        const returnTarget = importOptionsReturnFocus.current;
        importOptionsReturnFocus.current = null;
        if (returnTarget) scheduleImportOptionsFocusRestoration(returnTarget);
      }
    },
    [scheduleImportOptionsFocusRestoration]
  );

  const flushGridViewState = useCallback(() => {
    if (gridViewStateTimer.current !== undefined) {
      window.clearTimeout(gridViewStateTimer.current);
      gridViewStateTimer.current = undefined;
    }
    const pending = pendingGridViewState.current;
    pendingGridViewState.current = undefined;
    if (pending) vscode.postMessage({ kind: "updateViewState", state: pending });
  }, []);

  const publishGridViewState = useCallback(
    (next: GridViewState) => {
      storeGridViewState(next);
      pendingGridViewState.current = next;
      if (gridViewStateTimer.current !== undefined) window.clearTimeout(gridViewStateTimer.current);
      gridViewStateTimer.current = window.setTimeout(flushGridViewState, 100);
    },
    [flushGridViewState, storeGridViewState]
  );

  useEffect(() => {
    const flushPendingGridViewState = () => flushGridViewState();
    window.addEventListener("pagehide", flushPendingGridViewState);
    window.addEventListener("beforeunload", flushPendingGridViewState);
    return () => {
      window.removeEventListener("pagehide", flushPendingGridViewState);
      window.removeEventListener("beforeunload", flushPendingGridViewState);
      flushGridViewState();
    };
  }, [flushGridViewState]);

  const storeBackgroundDiagnostics = useCallback(
    (
      update:
        | ReadonlyMap<string, BackgroundDiagnostic>
        | ((current: ReadonlyMap<string, BackgroundDiagnostic>) => ReadonlyMap<string, BackgroundDiagnostic>)
    ) => {
      const next = typeof update === "function" ? update(backgroundDiagnosticsRef.current) : update;
      backgroundDiagnosticsRef.current = next;
      setBackgroundDiagnostics(next);
    },
    []
  );

  const clearBackgroundDiagnostic = useCallback(
    (pending: PendingBackgroundRequest) => {
      const key = backgroundDiagnosticKey(pending);
      storeBackgroundDiagnostics((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    },
    [storeBackgroundDiagnostics]
  );

  const releaseBackgroundRequest = useCallback((viewRequestId: string, pending: PendingBackgroundRequest): void => {
    if (pending.kind === "summary" && pendingSummaryByColumnId.current.get(pending.columnId) === viewRequestId) {
      pendingSummaryByColumnId.current.delete(pending.columnId);
    }
    if (pending.kind === "stats" && pendingStatsRequest.current === viewRequestId) {
      pendingStatsRequest.current = undefined;
    }
    if (pending.kind === "values" && latestValuesByColumn.current.get(pending.column) === viewRequestId) {
      latestValuesByColumn.current.delete(pending.column);
    }
  }, []);

  const dropSummaryOwner = useCallback((columnId: string, owner: SummaryRequestOwner): void => {
    const desiredOwners = summaryOwnersByColumnId.current.get(columnId);
    desiredOwners?.delete(owner);
    if (desiredOwners?.size === 0) summaryOwnersByColumnId.current.delete(columnId);
    for (const pending of pendingBackgroundRequests.current.values()) {
      if (pending.kind === "summary" && pending.columnId === columnId) pending.owners.delete(owner);
    }
    for (const pending of retryTimers.current.values()) {
      if (pending.kind === "summary" && pending.columnId === columnId) pending.owners.delete(owner);
    }
  }, []);

  const clearDrawerSummaryScheduling = useCallback((): void => {
    for (const columnId of [...summaryOwnersByColumnId.current.keys()]) dropSummaryOwner(columnId, "drawer");
  }, [dropSummaryOwner]);

  const cancelBackgroundRequests = useCallback(
    (shouldCancel: (pending: PendingBackgroundRequest) => boolean = () => true) => {
      const cancelledIds: string[] = [];
      const diagnosticKeys = new Set<string>();
      for (const [viewRequestId, pending] of pendingBackgroundRequests.current) {
        if (!shouldCancel(pending)) continue;
        pendingBackgroundRequests.current.delete(viewRequestId);
        releaseBackgroundRequest(viewRequestId, pending);
        cancelledIds.push(viewRequestId);
        diagnosticKeys.add(backgroundDiagnosticKey(pending));
      }
      for (const [timer, pending] of retryTimers.current) {
        if (!shouldCancel(pending)) continue;
        window.clearTimeout(timer);
        retryTimers.current.delete(timer);
        diagnosticKeys.add(backgroundDiagnosticKey(pending));
      }
      if (cancelledIds.length) {
        vscode.postMessage({ kind: "cancelViewRequests", viewRequestIds: cancelledIds });
      }
      storeBackgroundDiagnostics((current) => {
        const next = new Map<string, BackgroundDiagnostic>();
        for (const [key, diagnostic] of current) {
          if (!diagnosticKeys.has(key) && !shouldCancel(diagnostic.pending)) next.set(key, diagnostic);
        }
        return next;
      });
    },
    [releaseBackgroundRequest, storeBackgroundDiagnostics]
  );

  const clearProgressiveData = useCallback(
    (preserveColumnValues = false) => {
      storeSummaries([]);
      if (!preserveColumnValues) storeColumnValues(new Map());
    },
    [storeColumnValues, storeSummaries]
  );

  const resetViewProfiling = useCallback(
    (preserveColumnValues = false) => {
      cancelBackgroundRequests();
      clearDrawerSummaryScheduling();
      clearProgressiveData(preserveColumnValues);
      storeBackgroundDiagnostics(new Map());
    },
    [cancelBackgroundRequests, clearDrawerSummaryScheduling, clearProgressiveData, storeBackgroundDiagnostics]
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

  const canProfileConfirmedView = useCallback((viewContextId: string): boolean => {
    const confirmed = confirmedView.current;
    const pendingPage = latestPageRequest.current;
    return Boolean(
      confirmed &&
      confirmed.viewContextId === viewContextId &&
      !importOptionsPendingRef.current &&
      !stepInspectionTargetRef.current &&
      foregroundRequest.current !== "mutation" &&
      (!pendingPage || pendingPage.viewContextId === confirmed.viewContextId)
    );
  }, []);

  const sendSummaryColumn = useCallback(
    (columnId: string, attempt = 1, owner?: SummaryRequestOwner) => {
      if (owner) {
        const owners = summaryOwnersByColumnId.current.get(columnId) ?? new Set<SummaryRequestOwner>();
        owners.add(owner);
        summaryOwnersByColumnId.current.set(columnId, owners);
      }
      const owners = summaryOwnersByColumnId.current.get(columnId);
      if (!owners?.size) return;
      const currentMetadata = metadataRef.current;
      const confirmed = confirmedView.current;
      if (
        !currentMetadata ||
        !supportsViewingCapability(currentMetadata.capabilities, "profile") ||
        !confirmed ||
        !canProfileConfirmedView(confirmed.viewContextId) ||
        !currentMetadata.schema.some((candidate) => candidate.id === columnId) ||
        summariesRef.current.some((summary) => summary.columnId === columnId)
      ) {
        return;
      }
      const existingRequestId = pendingSummaryByColumnId.current.get(columnId);
      if (existingRequestId) {
        const existing = pendingBackgroundRequests.current.get(existingRequestId);
        if (existing?.kind === "summary") existing.owners = new Set(owners);
        return;
      }
      const viewRequestId = nextViewRequestId();
      pendingSummaryByColumnId.current.set(columnId, viewRequestId);
      pendingBackgroundRequests.current.set(viewRequestId, {
        kind: "summary",
        viewContextId: confirmed.viewContextId,
        columnId,
        attempt,
        owners: new Set(owners)
      });
      vscode.postMessage({
        kind: "runtimeRequest",
        viewContextId: confirmed.viewContextId,
        request: {
          kind: "getSummary",
          viewRequestId,
          filterModel: currentMetadata.filterModel,
          columnIds: [columnId]
        }
      });
    },
    [canProfileConfirmedView, nextViewRequestId]
  );

  const releaseSummaryOwner = useCallback(
    (columnId: string, owner: SummaryRequestOwner) => {
      dropSummaryOwner(columnId, owner);
      cancelBackgroundRequests(
        (pending) =>
          pending.kind === "summary" &&
          pending.columnId === columnId &&
          !(summaryOwnersByColumnId.current.get(columnId)?.size ?? 0)
      );
    },
    [cancelBackgroundRequests, dropSummaryOwner]
  );

  const updateVisibleSummaryColumns = useCallback(
    (columnIds: string[]) => {
      const currentMetadata = metadataRef.current;
      if (!currentMetadata || !supportsViewingCapability(currentMetadata.capabilities, "profile")) return;
      const next = new Set(columnIds);
      for (const [columnId, owners] of [...summaryOwnersByColumnId.current]) {
        if (owners.has("grid") && !next.has(columnId)) releaseSummaryOwner(columnId, "grid");
      }
      for (const columnId of next) sendSummaryColumn(columnId, 1, "grid");
    },
    [releaseSummaryOwner, sendSummaryColumn]
  );

  const restartOwnedSummaryProfiling = useCallback(() => {
    for (const [columnId, owners] of summaryOwnersByColumnId.current) {
      if (owners.size) sendSummaryColumn(columnId);
    }
  }, [sendSummaryColumn]);

  const requestStatsForConfirmedView = useCallback(
    (attempt = 1) => {
      const currentMetadata = metadataRef.current;
      const confirmed = confirmedView.current;
      if (
        !sidePanelOpenRef.current ||
        summaryPanelViewRef.current !== "dataset" ||
        !currentMetadata ||
        !supportsViewingCapability(currentMetadata.capabilities, "profile") ||
        currentMetadata.stats ||
        !confirmed ||
        pendingStatsRequest.current ||
        !canProfileConfirmedView(confirmed.viewContextId)
      ) {
        return;
      }
      const viewRequestId = nextViewRequestId();
      pendingStatsRequest.current = viewRequestId;
      pendingBackgroundRequests.current.set(viewRequestId, {
        kind: "stats",
        viewContextId: confirmed.viewContextId,
        attempt
      });
      vscode.postMessage({
        kind: "runtimeRequest",
        viewContextId: confirmed.viewContextId,
        request: {
          kind: "getDatasetStats",
          viewRequestId,
          filterModel: currentMetadata.filterModel
        }
      });
    },
    [canProfileConfirmedView, nextViewRequestId]
  );

  const restartProfilingForConfirmedView = useCallback(() => {
    restartOwnedSummaryProfiling();
    requestStatsForConfirmedView();
  }, [requestStatsForConfirmedView, restartOwnedSummaryProfiling]);

  useEffect(() => {
    importOptionsUiBusyRef.current = loading || mutationPending || projectionLoading;
  }, [loading, mutationPending, projectionLoading]);

  const requestImportOptionsChange = useCallback(
    (actionId?: string, trigger?: HTMLButtonElement) => {
      flushGridViewState();
      cancelBackgroundRequests();
      clearDrawerSummaryScheduling();
      if (
        importOptionsUiBusyRef.current ||
        foregroundRequest.current ||
        pendingStepInspectionRef.current?.reason === "projection" ||
        importOptionsPendingRef.current
      ) {
        return;
      }
      if (importOptionsFocusFrame.current !== undefined) {
        window.cancelAnimationFrame(importOptionsFocusFrame.current);
        importOptionsFocusFrame.current = undefined;
      }
      if (importOptionsDispatchFrame.current !== undefined) {
        window.cancelAnimationFrame(importOptionsDispatchFrame.current);
        importOptionsDispatchFrame.current = undefined;
      }
      const returnTarget =
        trigger?.isConnected && document.hasFocus() && trigger === document.activeElement ? trigger : null;
      importOptionsReturnFocus.current = returnTarget;
      if (returnTarget) {
        returnTarget.blur();
      } else if (actionId !== undefined && document.hasFocus() && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      flushSync(() => storeImportOptionsPending(true));
      const message = {
        kind: "changeImportOptions",
        ...(actionId === undefined ? {} : { actionId })
      } as const;
      if (actionId !== undefined && trigger === undefined) {
        importOptionsDispatchFrame.current = window.requestAnimationFrame(() => {
          importOptionsDispatchFrame.current = undefined;
          vscode.postMessage(message);
        });
      } else {
        vscode.postMessage(message);
      }
    },
    [cancelBackgroundRequests, clearDrawerSummaryScheduling, flushGridViewState, storeImportOptionsPending]
  );

  const updateImportOptionsPending = useCallback(
    (pending: boolean) => {
      const wasPending = importOptionsPendingRef.current;
      if (pending) {
        cancelBackgroundRequests();
        clearDrawerSummaryScheduling();
      }
      storeImportOptionsPending(pending);
      if (!pending && wasPending && metadataRef.current) {
        restartProfilingForConfirmedView();
      }
    },
    [
      cancelBackgroundRequests,
      clearDrawerSummaryScheduling,
      restartProfilingForConfirmedView,
      storeImportOptionsPending
    ]
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
      summaries: [...summariesRef.current],
      columnValues: new Map(columnValuesRef.current),
      backgroundDiagnostics: cloneBackgroundDiagnostics(backgroundDiagnosticsRef.current)
    };
  }, []);

  const restoreConfirmedViewState = useCallback(
    (previous: ConfirmedViewState) => {
      storeMetadata(previous.metadata);
      storeFilterModel(previous.metadata.filterModel);
      storeSummaries(previous.summaries);
      storeColumnValues(previous.columnValues);
      storeBackgroundDiagnostics(previous.backgroundDiagnostics);
      confirmedColumnWindow.current = { ...previous.columnWindow };
      desiredColumnWindow.current = { ...previous.columnWindow };
      confirmView(previous.metadata, previous.view.viewContextId);
      restartProfilingForConfirmedView();
    },
    [
      confirmView,
      restartProfilingForConfirmedView,
      storeBackgroundDiagnostics,
      storeColumnValues,
      storeFilterModel,
      storeMetadata,
      storeSummaries
    ]
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
      cancelBackgroundRequests();
      clearDrawerSummaryScheduling();
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
    [
      cancelBackgroundRequests,
      clearDrawerSummaryScheduling,
      storePendingStepInspection,
      storeStepInspection,
      storeStepInspectionTarget
    ]
  );

  const beginMutation = useCallback((): boolean => {
    if (importOptionsPendingRef.current) {
      setForegroundError("Wait for the current import-options change to finish.");
      return false;
    }
    if (foregroundRequest.current) {
      if (latestPageRequest.current?.reason === "projection") {
        setForegroundError("Wait for the visible columns to finish loading before changing the cleaning plan.");
      }
      return false;
    }
    const previous = captureConfirmedViewState();
    if (!previous) return false;
    clearStepInspection(false, false);
    flushGridViewState();
    mutationSnapshot.current = previous;
    resetViewProfiling();
    storeMetadata(withoutDatasetStats(previous.metadata));
    foregroundRequest.current = "mutation";
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
    resetViewProfiling,
    storeFailedPageRequest,
    storeMetadata
  ]);

  const pruneSummaryOwners = useCallback(
    (nextMetadata: SessionMetadata) => {
      const validColumnIds = new Set(nextMetadata.schema.map((column) => column.id));
      for (const columnId of summaryOwnersByColumnId.current.keys()) {
        if (!validColumnIds.has(columnId)) summaryOwnersByColumnId.current.delete(columnId);
      }
      cancelBackgroundRequests((pending) => pending.kind === "summary" && !validColumnIds.has(pending.columnId));
    },
    [cancelBackgroundRequests]
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
      publishGridViewState({
        ...gridViewStateRef.current,
        viewport: {
          firstVisibleRow: confirmedPage.offset,
          scrollLeft: gridViewStateRef.current.viewport.scrollLeft
        }
      });
      setViewStateRestoreVersion((current) => current + 1);
      if (restoreGridFocus) {
        scheduleWebviewFocusRestoration(() => {
          scheduleWebviewFocusRestoration(() => {
            if (confirmedView.current?.viewContextId !== focusedViewContextId) return;
            const target = focusedCell
              ? document.querySelector<HTMLElement>(
                  `[data-grid-row="${focusedCell.row}"][data-grid-column="${focusedCell.column}"]`
                )
              : document.querySelector<HTMLElement>('[data-testid="data-grid-scroller"] [tabindex="0"]');
            target?.focus({ preventScroll: true });
          });
        });
      }
    },
    [publishGridViewState, restoreConfirmedViewState]
  );

  useEffect(() => {
    const timers = retryTimers.current;
    const listener = (
      event: MessageEvent<
        | OpenWranglerResponse
        | EditorActionMessage
        | RequestImportOptionsChangeMessage
        | RendererSynchronizationMessage
        | ImportOptionsStateMessage
        | RuntimeDependencyInstallStateMessage
        | SessionOpenProgressMessage
        | SessionPresentationMessage
        | ViewStateMessage
        | StepInspectionResultMessage
        | StepInspectionClearedMessage
      >
    ) => {
      if (event.origin !== window.location.origin) return;
      const response = event.data;
      if (response.kind === "sessionOpenProgress") {
        if (response.stage === null) {
          setSessionOpenProgress(undefined);
        } else if (isSessionOpenProgressStage(response.stage)) {
          setSessionOpenProgress(response.stage);
        }
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
          pendingRendererSynchronizationRef.current = response;
          flushSync(() => setPendingRendererSynchronization(response));
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
          setStepInspectionError("Applied-step inspection was cancelled.");
          return;
        }
        const currentMetadata = metadataRef.current;
        if (
          result.kind !== "stepInspection" ||
          result.stepId !== response.stepId ||
          result.revision !== currentMetadata?.revision ||
          result.inputPage.offset !== response.offset ||
          result.outputPage.offset !== response.offset
        ) {
          setStepInspectionError("Ignored an invalid applied-step inspection response.");
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
        const state = decodeGridViewState(response.state);
        if (!state) return;
        pendingGridViewState.current = undefined;
        if (gridViewStateTimer.current !== undefined) {
          window.clearTimeout(gridViewStateTimer.current);
          gridViewStateTimer.current = undefined;
        }
        storeGridViewState(state);
        setViewStateRestoreVersion((current) => current + 1);
        return;
      }
      if (response.kind === "editorAction") {
        if (importOptionsPendingRef.current) {
          setForegroundError("Wait for the current import-options change to finish.");
          return;
        }
        if (response.action === "openOperation") {
          if (latestPageRequest.current?.reason === "projection") {
            setForegroundError("Wait for the visible columns to finish loading before adding a cleaning step.");
            return;
          }
          if (!canStartOperation(metadataRef.current)) return;
          if (stepInspectionTargetRef.current) clearStepInspection();
          rememberOperationReturnFocus();
          setEditingStep(undefined);
          setOperationKind(response.operationKind);
          setOperationOpen(true);
        } else if (response.action === "editLatest") {
          if (latestPageRequest.current?.reason === "projection") {
            setForegroundError("Wait for the visible columns to finish loading before editing a cleaning step.");
            return;
          }
          if (!canEditLatestStep(metadataRef.current)) return;
          if (stepInspectionTargetRef.current) clearStepInspection();
          rememberOperationReturnFocus();
          setMetadata((current) => {
            const latest = current?.steps.at(-1);
            if (latest) {
              setEditingStep(latest);
              setOperationKind(latest.kind);
              setOperationOpen(true);
            }
            return current;
          });
        } else if (response.action === "selectStep") {
          if (response.stepId) requestStepInspection(response.stepId);
          else clearStepInspection();
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
          if (
            !metadataRef.current ||
            !supportsViewingCapability(metadataRef.current.capabilities, "sort") ||
            typeof response.column !== "string" ||
            (response.sortAction !== "moveUp" &&
              response.sortAction !== "moveDown" &&
              response.sortAction !== "remove") ||
            typeof response.expectedSessionId !== "string" ||
            typeof response.expectedSortModelSignature !== "string" ||
            !Number.isInteger(response.expectedSortIndex)
          ) {
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
            if (
              typeof foregroundRequest.current === "object" &&
              foregroundRequest.current.viewRequestId === response.viewRequestId
            ) {
              foregroundRequest.current = undefined;
              if (pendingPage.reason === "projection") setProjectionLoading(false);
              else setLoading(importOptionsPendingRef.current);
            }
            restoreViewAfterPageFailure(pendingPage, response.code === "pyspark_connect_state_lost");
            storeFailedPageRequest(pendingPage);
            setForegroundError(response.message);
            return;
          }

          const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
          if (!pending) return;
          pendingBackgroundRequests.current.delete(response.viewRequestId);
          releaseBackgroundRequest(response.viewRequestId, pending);
          if (response.code === "pyspark_connect_state_lost") {
            setForegroundError(response.message);
            return;
          }
          if (canProfileConfirmedView(pending.viewContextId)) {
            storeBackgroundDiagnostics((current) => {
              const next = new Map(current);
              next.set(backgroundDiagnosticKey(pending), { message: response.message, pending });
              return next;
            });
            scheduleBackgroundRetry(pending);
          }
          return;
        }
        const shouldRestoreMutation = foregroundRequest.current === "mutation";
        if (shouldRestoreMutation) {
          undoPlanReturnFocus.current = null;
          const previous = mutationSnapshot.current;
          foregroundRequest.current = undefined;
          mutationSnapshot.current = undefined;
          setMutationPending(false);
          setLoading(importOptionsPendingRef.current);
          setProjectionLoading(false);
          if (previous) restoreConfirmedViewState(previous);
        } else if (importOptionsPendingRef.current) {
          setForegroundError(response.message);
          return;
        } else if (!metadataRef.current) {
          pendingRendererSynchronizationRef.current = undefined;
          setPendingRendererSynchronization(undefined);
          acknowledgedRendererSynchronizationId.current = undefined;
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
            importOptionsPendingRef.current &&
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
            setLoading(importOptionsPendingRef.current);
            setProjectionLoading(false);
            if (previous) restoreConfirmedViewState(previous);
            setForegroundError("The cleaning operation was cancelled.");
          } else if (importOptionsPendingRef.current) {
            return;
          } else if (!metadataRef.current) {
            pendingRendererSynchronizationRef.current = undefined;
            setPendingRendererSynchronization(undefined);
            acknowledgedRendererSynchronizationId.current = undefined;
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
          if (
            typeof foregroundRequest.current === "object" &&
            foregroundRequest.current.viewRequestId === response.viewRequestId
          ) {
            foregroundRequest.current = undefined;
            if (pendingPage.reason === "projection") setProjectionLoading(false);
            else setLoading(importOptionsPendingRef.current);
          }
          restoreViewAfterPageFailure(pendingPage);
          storeFailedPageRequest(pendingPage);
          setForegroundError("Page request was cancelled.");
          return;
        }
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (pending) {
          pendingBackgroundRequests.current.delete(response.viewRequestId);
          releaseBackgroundRequest(response.viewRequestId, pending);
          scheduleBackgroundRetry(pending);
        }
        return;
      }

      if (response.kind === "sessionOpened") {
        const current = metadataRef.current;
        if (current?.sessionId === response.metadata.sessionId && response.metadata.revision < current.revision) {
          return;
        }
        undoPlanReturnFocus.current = null;
        pendingRendererSynchronizationRef.current = undefined;
        setPendingRendererSynchronization(undefined);
        acknowledgedRendererSynchronizationId.current = undefined;
        storeImportOptionsPending(false);
        setOperationOpen(false);
        setEditingStep(undefined);
        setOperationKind(undefined);
        latestPageRequest.current = undefined;
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
        storeGridViewState(emptyGridViewState());
        storePendingStepInspection(undefined);
        storeStepInspection(undefined);
        storeStepInspectionTarget(undefined);
        setStepInspectionError(undefined);
        setDraftBefore(undefined);
        setDiff(undefined);
        setDraftWarnings([]);
        resetViewProfiling();
        summaryOwnersByColumnId.current.clear();
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
        const openedWindow = columnWindowFromPage(response.metadata, response.page);
        confirmedColumnWindow.current = openedWindow;
        desiredColumnWindow.current = openedWindow;
        inspectionColumnWindow.current = openedWindow;
        storeSummaries(supportsViewingCapability(response.metadata.capabilities, "profile") ? response.summaries : []);
        return;
      }

      if (response.kind === "page") {
        const pendingPage = latestPageRequest.current;
        if (!pendingPage || pendingPage.viewRequestId !== response.viewRequestId) return;
        latestPageRequest.current = undefined;
        if (
          typeof foregroundRequest.current === "object" &&
          foregroundRequest.current.viewRequestId === response.viewRequestId
        ) {
          foregroundRequest.current = undefined;
          if (pendingPage.reason === "projection") setProjectionLoading(false);
          else setLoading(importOptionsPendingRef.current);
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
          resetViewProfiling(true);
        }
        const previousStats = sameView ? metadataRef.current?.stats : undefined;
        const nextMetadata = previousStats
          ? { ...response.metadata, stats: previousStats }
          : withoutDatasetStats(response.metadata);
        confirmView(nextMetadata, pendingPage.viewContextId);
        storeMetadata(nextMetadata);
        storeFilterModel(nextMetadata.filterModel);
        storePage(response.page);
        confirmedColumnWindow.current = columnWindowFromPage(nextMetadata, response.page, pendingPage.columnWindow);
        restartProfilingForConfirmedView();
        if (restoreGridFocusForPage.current === response.viewRequestId) {
          restoreGridFocusForPage.current = undefined;
          scheduleWebviewFocusRestoration(() => {
            document.querySelector<HTMLElement>('[data-testid="data-grid-scroller"] [tabindex="0"]')?.focus();
          });
        }
        return;
      }

      if (response.kind === "stepPreview" || response.kind === "planUpdated") {
        const undoReturnTarget = undoPlanReturnFocus.current;
        undoPlanReturnFocus.current = null;
        pendingRendererSynchronizationRef.current = undefined;
        setPendingRendererSynchronization(undefined);
        acknowledgedRendererSynchronizationId.current = undefined;
        const previous = mutationSnapshot.current;
        latestPageRequest.current = undefined;
        foregroundRequest.current = undefined;
        mutationSnapshot.current = undefined;
        setMutationPending(false);
        setLoading(importOptionsPendingRef.current);
        setProjectionLoading(false);
        setForegroundError(undefined);
        storeFailedPageRequest(undefined);
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
        pruneSummaryOwners(nextMetadata);
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
        if (response.kind === "stepPreview") setOperationOpen(false);
        restartProfilingForConfirmedView();
        if (shouldRestoreUndoFocus) {
          scheduleWebviewFocusRestoration(() => {
            document.querySelector<HTMLButtonElement>("[data-cleaning-plan-focus-fallback]:not(:disabled)")?.focus();
          });
        }
        return;
      }

      if (response.kind === "summary") {
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending || pending.kind !== "summary") return;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (
          !metadataRef.current ||
          !supportsViewingCapability(metadataRef.current.capabilities, "profile") ||
          !canProfileConfirmedView(pending.viewContextId) ||
          response.revision !== confirmedView.current?.revision
        )
          return;
        const merged = new Map(summariesRef.current.map((summary) => [summary.columnId, summary]));
        for (const summary of response.summaries) merged.set(summary.columnId, summary);
        const schemaOrder = new Map(metadataRef.current?.schema.map((column, index) => [column.id, index]) ?? []);
        storeSummaries(
          [...merged.values()].sort(
            (left, right) =>
              (schemaOrder.get(left.columnId) ?? Number.MAX_SAFE_INTEGER) -
              (schemaOrder.get(right.columnId) ?? Number.MAX_SAFE_INTEGER)
          )
        );
        clearBackgroundDiagnostic(pending);
        return;
      }

      if (response.kind === "columnValues") {
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending || pending.kind !== "values") return;
        const isLatest = latestValuesByColumn.current.get(response.column) === response.viewRequestId;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (
          !metadataRef.current ||
          !supportsViewingCapability(metadataRef.current.capabilities, "columnValues") ||
          !canProfileConfirmedView(pending.viewContextId) ||
          response.revision !== confirmedView.current?.revision ||
          !isLatest
        ) {
          return;
        }
        latestValuesByColumn.current.delete(response.column);
        storeColumnValues(new Map(columnValuesRef.current).set(response.column, response));
        clearBackgroundDiagnostic(pending);
        return;
      }

      if (response.kind === "datasetStats") {
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending || pending.kind !== "stats") return;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (
          !metadataRef.current ||
          !supportsViewingCapability(metadataRef.current.capabilities, "profile") ||
          !canProfileConfirmedView(pending.viewContextId) ||
          response.revision !== confirmedView.current?.revision
        )
          return;
        const current = metadataRef.current;
        if (current) storeMetadata({ ...current, stats: response.stats });
        clearBackgroundDiagnostic(pending);
      }
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ kind: "ready" });
    return () => {
      window.removeEventListener("message", listener);
      for (const timer of timers.keys()) window.clearTimeout(timer);
      timers.clear();
    };

    function scheduleBackgroundRetry(pending: PendingBackgroundRequest): boolean {
      if (pending.kind === "values" || pending.attempt >= 2 || !canProfileConfirmedView(pending.viewContextId))
        return false;
      const timer = window.setTimeout(() => {
        retryTimers.current.delete(timer);
        if (pending.kind === "summary") sendSummaryColumn(pending.columnId, pending.attempt + 1);
        else requestStatsForConfirmedView(pending.attempt + 1);
      }, 0);
      retryTimers.current.set(timer, pending);
      return true;
    }
  }, [
    beginMutation,
    canProfileConfirmedView,
    clearBackgroundDiagnostic,
    clearStepInspection,
    confirmView,
    nextViewRequestId,
    pruneSummaryOwners,
    releaseBackgroundRequest,
    rememberOperationReturnFocus,
    requestImportOptionsChange,
    requestColumnReveal,
    requestStatsForConfirmedView,
    requestStepInspection,
    restartProfilingForConfirmedView,
    restoreConfirmedViewState,
    restoreViewAfterPageFailure,
    resetViewProfiling,
    sendSummaryColumn,
    storeBackgroundDiagnostics,
    storeColumnValues,
    storeFailedPageRequest,
    storeFilterModel,
    storeGridViewState,
    storeGoToColumnRequest,
    storeImportOptionsPending,
    storeMetadata,
    storePage,
    storePendingStepInspection,
    storeStepInspection,
    storeStepInspectionTarget,
    storeSummaries,
    updateImportOptionsPending
  ]);

  useLayoutEffect(() => {
    const synchronization = pendingRendererSynchronization;
    if (!synchronization || acknowledgedRendererSynchronizationId.current === synchronization.syncId) return;
    const matchesCommittedSession =
      synchronization.sessionId === null && synchronization.revision === null
        ? metadata === undefined
        : metadata?.sessionId === synchronization.sessionId && metadata.revision === synchronization.revision;
    if (!matchesCommittedSession) return;
    vscode.postMessage({
      kind: "rendererSynchronized",
      syncId: synchronization.syncId,
      sessionId: synchronization.sessionId,
      revision: synchronization.revision
    });
    acknowledgedRendererSynchronizationId.current = synchronization.syncId;
    flushGridViewState();
  }, [flushGridViewState, metadata, pendingRendererSynchronization]);

  const rendererNeedsSnapshot = pendingRendererSynchronization === undefined;
  useEffect(() => {
    if (!rendererNeedsSnapshot) return;
    let retryIndex = 0;
    let retry: number | undefined;
    const clearRetry = () => {
      if (retry !== undefined) window.clearTimeout(retry);
      retry = undefined;
    };
    const scheduleRetry = () => {
      clearRetry();
      if (document.visibilityState !== "visible" || retryIndex >= sessionSnapshotRetryDelaysMs.length) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        if (document.visibilityState !== "visible" || pendingRendererSynchronizationRef.current !== undefined) {
          return;
        }
        vscode.postMessage({ kind: "requestSessionSnapshot" });
        retryIndex += 1;
        scheduleRetry();
      }, sessionSnapshotRetryDelaysMs[retryIndex]);
    };
    const restoreVisibleSnapshot = () => {
      clearRetry();
      retryIndex = 0;
      if (document.visibilityState === "visible" && pendingRendererSynchronizationRef.current === undefined) {
        vscode.postMessage({ kind: "requestSessionSnapshot" });
        retryIndex = 1;
        scheduleRetry();
      }
    };
    document.addEventListener("visibilitychange", restoreVisibleSnapshot);
    scheduleRetry();
    return () => {
      clearRetry();
      document.removeEventListener("visibilitychange", restoreVisibleSnapshot);
    };
  }, [rendererNeedsSnapshot]);

  const schemaById = useMemo(() => new Map(metadata?.schema.map((column) => [column.id, column]) ?? []), [metadata]);
  const selectedSummaryColumnId = useMemo(() => {
    const selectedColumnId = gridViewState.selectedColumnId;
    if (selectedColumnId && schemaById.has(selectedColumnId)) return selectedColumnId;
    return metadata?.schema[0]?.id;
  }, [gridViewState.selectedColumnId, metadata?.schema, schemaById]);
  const inspectionMode = Boolean(stepInspectionTarget);
  const displayMetadata = useMemo<SessionMetadata | undefined>(() => {
    if (!metadata || !stepInspection) return metadata;
    const shape = { rows: stepInspection.outputPage.totalRows, columns: stepInspection.outputSchema.length };
    return {
      ...metadata,
      shape,
      filteredShape: shape,
      schema: stepInspection.outputSchema
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
      columnWidths: Object.fromEntries(
        Object.entries(gridViewState.columnWidths).filter(([columnId]) => columnIds.has(columnId))
      ),
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

  const requestPage = (
    offset: number,
    model = filterModelRef.current,
    options: PageRequestOptions = {}
  ): string | undefined => {
    if (
      importOptionsPendingRef.current ||
      foregroundRequest.current === "mutation" ||
      stepInspectionTargetRef.current
    ) {
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
      previousConfirmedState
    };
    latestPageRequest.current = pendingPage;
    foregroundRequest.current = { kind: "page", viewRequestId };
    desiredColumnWindow.current = columnWindow;
    storeFailedPageRequest(undefined);
    setForegroundError(undefined);
    if (changesView) {
      resetViewProfiling(true);
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

  const requestValues = (column: string, search?: string) => {
    if (importOptionsPendingRef.current || stepInspectionTargetRef.current) return;
    const currentMetadata = metadataRef.current;
    const confirmed = confirmedView.current;
    if (
      !currentMetadata ||
      !supportsViewingCapability(currentMetadata.capabilities, "filter") ||
      !supportsViewingCapability(currentMetadata.capabilities, "columnValues")
    )
      return;
    if (currentMetadata?.schema.filter((candidate) => candidate.name === column).length !== 1) return;
    const viewRequestId = nextViewRequestId();
    const valuesFilterModel = filterModelForColumnValues(currentMetadata.filterModel, column);
    if (!confirmed || !canProfileConfirmedView(confirmed.viewContextId)) return;

    const previousRequestId = latestValuesByColumn.current.get(column);
    if (previousRequestId) {
      const previous = pendingBackgroundRequests.current.get(previousRequestId);
      if (previous) cancelBackgroundRequests((pending) => pending === previous);
    }

    latestValuesByColumn.current.set(column, viewRequestId);
    pendingBackgroundRequests.current.set(viewRequestId, {
      kind: "values",
      viewContextId: confirmed.viewContextId,
      column
    });
    vscode.postMessage({
      kind: "runtimeRequest",
      viewContextId: confirmed.viewContextId,
      request: {
        kind: "getColumnValues",
        viewRequestId,
        column,
        search,
        limit: 100,
        filterModel: valuesFilterModel
      }
    });
  };

  const handleVisibleColumnRange = (range: VisibleColumnRange): void => {
    if (importOptionsPendingRef.current) return;
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

  const applyFilters = (model: FilterModel) => {
    if (
      importOptionsPendingRef.current ||
      foregroundRequest.current === "mutation" ||
      stepInspectionTargetRef.current
    ) {
      return;
    }
    const nextModel = compactFilterModel(model);
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
    const pendingPage = latestPageRequest.current;
    const sameDesiredModel = sameFilterModel(nextModel, filterModelRef.current);
    if (sameDesiredModel && pendingPage && sameFilterModel(nextModel, pendingPage.model)) {
      return;
    }
    storeFilterModel(nextModel);
    const currentMetadata = metadataRef.current;
    const failed = failedPageRequestRef.current;
    if (sameDesiredModel && failed && sameFilterModel(nextModel, failed.model)) {
      requestPage(failed.offset, failed.model, {
        changesView: failed.changesView,
        viewContextId: failed.viewContextId,
        columnWindow: failed.columnWindow,
        reason: failed.reason
      });
      return;
    }
    if (
      sameDesiredModel &&
      !pendingPage &&
      currentMetadata &&
      sameFilterModel(nextModel, currentMetadata.filterModel)
    ) {
      return;
    }

    requestPage(0, nextModel, { changesView: true });
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
      sort[index] = adjacentRule;
      sort[nextIndex] = currentRule;
      applyFilters({ ...current, sort });
    };
  });

  useEffect(() => {
    if (!sidePanelOpen || !metadata || importOptionsPending) return;

    const desiredColumnId = summaryPanelView === "column" ? selectedSummaryColumnId : undefined;
    for (const [columnId, owners] of [...summaryOwnersByColumnId.current]) {
      if (owners.has("drawer") && columnId !== desiredColumnId) releaseSummaryOwner(columnId, "drawer");
    }

    if (desiredColumnId) sendSummaryColumn(desiredColumnId, 1, "drawer");
    if (summaryPanelView === "dataset") requestStatsForConfirmedView();
    else cancelBackgroundRequests((pending) => pending.kind === "stats");
    if (summaryPanelView !== "filters") cancelBackgroundRequests((pending) => pending.kind === "values");
  }, [
    activeViewContextId,
    cancelBackgroundRequests,
    importOptionsPending,
    metadata,
    releaseSummaryOwner,
    requestStatsForConfirmedView,
    selectedSummaryColumnId,
    sendSummaryColumn,
    sidePanelOpen,
    summaryPanelView
  ]);

  const previewStep = (step: TransformStep, replaceStepId?: string) => {
    if (!beginMutation()) return;
    const columnWindow = desiredColumnWindow.current;
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: "previewStep",
        step,
        replaceStepId,
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

  const openNewOperation = (kind?: OperationKind) => {
    if (importOptionsPendingRef.current) {
      setForegroundError("Wait for the current import-options change to finish.");
      return;
    }
    if (foregroundRequest.current) {
      if (latestPageRequest.current?.reason === "projection") {
        setForegroundError("Wait for the visible columns to finish loading before adding a cleaning step.");
      }
      return;
    }
    if (!canStartOperation(metadataRef.current)) return;
    if (stepInspectionTargetRef.current) clearStepInspection();
    rememberOperationReturnFocus();
    setEditingStep(undefined);
    setOperationKind(kind);
    setOperationOpen(true);
  };

  const editLatestStep = () => {
    if (importOptionsPendingRef.current) {
      setForegroundError("Wait for the current import-options change to finish.");
      return;
    }
    if (foregroundRequest.current) {
      if (latestPageRequest.current?.reason === "projection") {
        setForegroundError("Wait for the visible columns to finish loading before editing a cleaning step.");
      }
      return;
    }
    if (!canEditLatestStep(metadataRef.current)) return;
    if (stepInspectionTargetRef.current) clearStepInspection();
    const latest = metadata?.steps.at(-1);
    if (!latest) return;
    rememberOperationReturnFocus();
    setEditingStep(latest);
    setOperationKind(latest.kind);
    setOperationOpen(true);
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
    clearDrawerSummaryScheduling();
    cancelBackgroundRequests(
      (pending) =>
        pending.kind === "stats" ||
        pending.kind === "values" ||
        (pending.kind === "summary" && !(summaryOwnersByColumnId.current.get(pending.columnId)?.size ?? 0))
    );
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
          setOperationOpen(false);
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
        editLatestStep();
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
      reason: failed.reason
    });
  };

  const reconnectLiveSession = () => {
    if (liveSessionReconnectPending) return;
    cancelBackgroundRequests();
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
    <main className="app" data-session-id={metadata?.sessionId} tabIndex={-1} onKeyDown={handleKeyboardShortcut}>
      <div
        className="appWorkspace"
        data-testid="app-workspace"
        inert={operationOpen}
        aria-hidden={operationOpen ? true : undefined}
      >
        <header className="toolbar">
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
                  onClick={() => openNewOperation()}
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
                    onClick={editLatestStep}
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
                    : profileSupported
                      ? filterPanelSupported
                        ? "Column profiles and filters"
                        : "Column profiles"
                      : filterPanelSupported
                        ? "Filters and sorts"
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
                      ? "Filters / Sorts"
                      : "Profiles unavailable"}
              </button>
              <ColumnSearch
                columns={(displayMetadata ?? metadata).schema}
                selectedColumnId={gridViewState.selectedColumnId}
                onSelect={requestColumnReveal}
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
              <span className="sessionBadge modeBadge" data-session-badge="mode">
                {metadata.backend === "pyspark" || metadata.backend === "r" ? "Viewing only" : metadata.mode}
              </span>
              <span className="sessionBadge backendBadge" data-session-badge="backend">
                {dataBackendLabel(metadata.backend)}
              </span>
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
          <section className="inspectionPanel" aria-label="Selected applied-step inspection">
            <header>
              <div>
                <strong>
                  {pendingStepInspection ? "Loading" : "Inspecting"}{" "}
                  {selectedInspectionStep ? operationByKind(selectedInspectionStep.kind).title : "applied step"}
                </strong>
                <span>
                  This is that step&apos;s input → output boundary. The confirmed dataframe view and filters are
                  unchanged.
                </span>
              </div>
              <button type="button" className="secondaryButton" onClick={() => clearStepInspection()}>
                Show confirmed data
              </button>
            </header>
            {pendingStepInspection && (
              <div role="status" aria-live="polite">
                Loading inspection rows {pendingStepInspection.offset + 1} to {pendingStepInspection.offset + pageSize}…
              </div>
            )}
            {stepInspectionError && (
              <div className="errorBanner" role="alert">
                {stepInspectionError}
              </div>
            )}
            {stepInspection && (
              <div className="diffStats" aria-label="Selected step data diff summary">
                <span>+{stepInspection.diff.addedRows} rows</span>
                <span>-{stepInspection.diff.removedRows} rows</span>
                <span>+{stepInspection.diff.addedColumns.length} columns</span>
                <span>-{stepInspection.diff.removedColumns.length} columns</span>
                <span>
                  {stepInspection.diff.changedCells} changed cells
                  {stepInspection.diff.truncated ? " in this block" : ""}
                </span>
              </div>
            )}
          </section>
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
            <aside id="openwrangler-insights-panel" className="sidebar" aria-label="Column profiles and filters">
              <div className="drawerHeader">
                <strong>{profileSupported ? "Column profiles" : "Filters / Sorts"}</strong>
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
                onSelectView={selectSummaryPanelView}
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
      {metadata && operationOpen && (
        <OperationBuilder
          key={`${operationKind ?? "none"}:${editingStep?.id ?? "new"}`}
          metadata={metadata}
          filterModel={filterModel}
          initialKind={operationKind}
          initialStep={editingStep}
          busy={mutationPending || projectionLoading || importOptionsPending}
          onClose={() => {
            if (foregroundRequest.current !== "mutation") setOperationOpen(false);
          }}
          onPreview={previewStep}
        />
      )}
    </main>
  );
}

type NonSortEditorAction =
  | "openOperation"
  | "editLatest"
  | "selectStep"
  | "clearFilterColumn"
  | "openFilters"
  | "applyDraft"
  | "discardDraft"
  | "undoStep";

type EditorActionMessage =
  | {
      kind: "editorAction";
      action: "changeViewSort";
      column: string;
      sortAction: "moveUp" | "moveDown" | "remove";
      expectedSessionId: string;
      expectedSortModelSignature: string;
      expectedSortIndex: number;
    }
  | {
      kind: "editorAction";
      action: NonSortEditorAction;
      operationKind?: OperationKind;
      stepId?: string;
      column?: string;
    };

interface ViewSortActionTarget {
  column: string;
  action: "moveUp" | "moveDown" | "remove";
  expectedSessionId: string;
  expectedSortModelSignature: string;
  expectedSortIndex: number;
}

interface RequestImportOptionsChangeMessage {
  kind: "requestImportOptionsChange";
  actionId: string;
}

interface RendererSynchronizationMessage {
  kind: "rendererSynchronization";
  syncId: string;
  sessionId: string | null;
  revision: number | null;
  layoutTransitionPending: boolean;
}

interface ImportOptionsStateMessage {
  kind: "importOptionsState";
  busy: boolean;
}

interface RuntimeDependencyInstallStateMessage {
  kind: "runtimeDependencyInstallState";
  busy: boolean;
}

interface SessionOpenProgressMessage {
  kind: "sessionOpenProgress";
  stage: unknown;
}

interface SessionPresentationMessage {
  kind: "sessionPresentation";
  presentation: {
    sessionId: string;
    revision: number;
    code: string;
    draft?: {
      diff: DataDiff;
      warnings: string[];
      beforeSchema: ColumnSchema[];
    };
  };
}

interface ViewStateMessage {
  kind: "viewState";
  state: unknown;
}

interface StepInspectionResultMessage {
  kind: "stepInspectionResult";
  stepId: string;
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
  response: OpenWranglerResponse;
}

interface StepInspectionClearedMessage {
  kind: "stepInspectionCleared";
  resumeProfiling: boolean;
}

interface ConfirmedView {
  viewContextId: string;
  sessionId: string;
  revision: number;
}

interface ConfirmedViewState {
  view: ConfirmedView;
  metadata: SessionMetadata;
  page: LiveGridPage;
  columnWindow: ColumnWindow;
  summaries: ColumnSummary[];
  columnValues: ReadonlyMap<string, ValuesResponse>;
  backgroundDiagnostics: ReadonlyMap<string, BackgroundDiagnostic>;
}

interface PendingStepInspection {
  stepId: string;
  offset: number;
  columnWindow: ColumnWindow;
  reason: "selection" | "row" | "projection";
}

interface DiffBeforeState {
  schema: ColumnSchema[];
  page?: GridPage;
}

interface PendingPageRequest {
  viewRequestId: string;
  viewContextId: string;
  changesView: boolean;
  offset: number;
  model: FilterModel;
  columnWindow: ColumnWindow;
  reason: PageRequestReason;
  previousConfirmedState?: ConfirmedViewState;
}

export interface ColumnWindow {
  offset: number;
  limit: number;
}

interface ColumnRevealSynchronization {
  sessionId: string;
  revision: number;
}

interface ColumnRevealRequest {
  columnId: string;
  requestId: number;
  retainUntilSynchronization?: ColumnRevealSynchronization;
}

type PageRequestReason = "view" | "row" | "projection";

type SummaryRequestOwner = "grid" | "drawer";

type PendingBackgroundRequest =
  | {
      kind: "summary";
      viewContextId: string;
      columnId: string;
      attempt: number;
      owners: Set<SummaryRequestOwner>;
    }
  | { kind: "stats"; viewContextId: string; attempt: number }
  | { kind: "values"; viewContextId: string; column: string };

interface BackgroundDiagnostic {
  message: string;
  pending: PendingBackgroundRequest;
}

interface PageRequestOptions {
  changesView?: boolean;
  viewContextId?: string;
  columnWindow?: ColumnWindow;
  reason?: PageRequestReason;
}

function backgroundDiagnosticKey(pending: PendingBackgroundRequest): string {
  if (pending.kind === "stats") return "stats";
  return `${pending.kind}:${pending.kind === "summary" ? pending.columnId : pending.column}`;
}

function cloneBackgroundDiagnostics(
  diagnostics: ReadonlyMap<string, BackgroundDiagnostic>
): ReadonlyMap<string, BackgroundDiagnostic> {
  return new Map(
    [...diagnostics].map(([key, diagnostic]) => [
      key,
      {
        ...diagnostic,
        pending:
          diagnostic.pending.kind === "summary"
            ? { ...diagnostic.pending, owners: new Set(diagnostic.pending.owners) }
            : { ...diagnostic.pending }
      }
    ])
  );
}

function withoutDatasetStats(metadata: SessionMetadata): SessionMetadata {
  const { stats: _stats, ...rest } = metadata;
  return rest;
}

function isEditableKeyboardTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function sameFilterModel(left: FilterModel, right: FilterModel): boolean {
  return filterModelScope(left) === filterModelScope(right);
}

function sameFilterRules(left: FilterModel, right: FilterModel): boolean {
  return (
    JSON.stringify({ logic: left.logic ?? "and", filters: left.filters }) ===
    JSON.stringify({ logic: right.logic ?? "and", filters: right.filters })
  );
}

function sameSortRules(left: FilterModel, right: FilterModel): boolean {
  return JSON.stringify(left.sort) === JSON.stringify(right.sort);
}

function filterModelForColumnValues(model: FilterModel, column: string): FilterModel {
  return {
    ...model,
    filters: model.filters.filter((filter) => filter.column !== column)
  };
}

function filterModelScope(model: FilterModel): string {
  return JSON.stringify({ logic: model.logic ?? "and", filters: model.filters, sort: model.sort });
}

function initialColumnWindow(): ColumnWindow {
  return { offset: 0, limit: webviewConfig.fetchColumnBlockSize };
}

export function alignedColumnWindow(range: VisibleColumnRange, totalColumns: number, blockSize: number): ColumnWindow {
  const boundedBlockSize = Math.max(1, Math.min(256, Math.floor(blockSize)));
  if (totalColumns <= 0) return { offset: 0, limit: boundedBlockSize };
  const start = Math.max(0, Math.min(Math.floor(range.start), totalColumns - 1));
  const end = Math.max(start + 1, Math.min(Math.ceil(range.end), totalColumns));
  const offset = Math.floor(start / boundedBlockSize) * boundedBlockSize;
  const alignedEnd = Math.min(totalColumns, Math.ceil(end / boundedBlockSize) * boundedBlockSize);
  if (alignedEnd - offset <= 256) return { offset, limit: Math.max(1, alignedEnd - offset) };

  const shiftedOffset = Math.min(start, Math.max(0, totalColumns - 256));
  return { offset: shiftedOffset, limit: Math.max(1, Math.min(256, totalColumns - shiftedOffset)) };
}

function columnWindowFromPage(
  metadata: SessionMetadata,
  page: LiveGridPage,
  fallback: ColumnWindow = initialColumnWindow()
): ColumnWindow {
  if (!metadata.schema.length) return { offset: 0, limit: Math.max(1, fallback.limit) };
  const firstId = page.columnIds[0];
  const firstPosition = firstId === undefined ? -1 : metadata.schema.findIndex((column) => column.id === firstId);
  if (firstPosition < 0 || page.columnIds.length === 0) {
    return {
      offset: Math.max(0, Math.min(fallback.offset, metadata.schema.length - 1)),
      limit: Math.max(1, Math.min(256, fallback.limit))
    };
  }
  return { offset: firstPosition, limit: Math.max(1, Math.min(256, page.columnIds.length)) };
}

function draftDiffLabels(diff: DataDiff, displayedRowCount: number): string[] {
  const labels: string[] = [];
  if (diff.addedRows > 0) labels.push(`+${diff.addedRows.toLocaleString()} ${pluralize(diff.addedRows, "row")}`);
  if (diff.removedRows > 0) labels.push(`-${diff.removedRows.toLocaleString()} ${pluralize(diff.removedRows, "row")}`);
  if (diff.addedColumns.length > 0) {
    labels.push(`+${diff.addedColumns.length.toLocaleString()} ${pluralize(diff.addedColumns.length, "column")}`);
  }
  if (diff.removedColumns.length > 0) {
    labels.push(`-${diff.removedColumns.length.toLocaleString()} ${pluralize(diff.removedColumns.length, "column")}`);
  }
  if (diff.changedCells > 0) {
    labels.push(
      `${diff.changedCells.toLocaleString()} existing ${pluralize(diff.changedCells, "cell")} changed${
        diff.truncated ? " in this block" : ""
      }`
    );
  }
  const addedValues = displayedRowCount * diff.addedColumns.length;
  if (addedValues > 0) {
    labels.push(`${addedValues.toLocaleString()} ${pluralize(addedValues, "value")} added in this block`);
  }
  if (labels.length === 0) labels.push("No value changes in this block");
  return labels;
}

function pluralize(value: number, singular: string): string {
  return value === 1 ? singular : `${singular}s`;
}

function sessionOpenProgressHeading(stage: SessionOpenProgressStage): string {
  switch (stage) {
    case "acquiringKernel":
      return "Connecting to the notebook kernel…";
    case "bootstrappingRuntime":
      return "Preparing Open Wrangler in the kernel…";
    case "openingNotebookVariable":
      return "Opening the live notebook variable…";
    case "preparingSparkView":
      return "Preparing PySpark 4.2 (viewing only)…";
  }
}

function isSessionOpenProgressStage(value: unknown): value is SessionOpenProgressStage {
  return typeof value === "string" && (SESSION_OPEN_PROGRESS_STAGES as readonly string[]).includes(value);
}

function pageCoversColumnWindow(metadata: SessionMetadata, page: LiveGridPage, window: ColumnWindow): boolean {
  if (!metadata.schema.length) return page.columnIds.length === 0;
  const expectedIds = metadata.schema
    .slice(window.offset, Math.min(metadata.schema.length, window.offset + window.limit))
    .map((column) => column.id);
  if (!expectedIds.length) return false;
  const first = page.columnIds.indexOf(expectedIds[0]);
  return (
    first >= 0 &&
    first + expectedIds.length <= page.columnIds.length &&
    expectedIds.every((columnId, index) => page.columnIds[first + index] === columnId)
  );
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
