import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  ColumnSummary,
  DataDiff,
  DataRow,
  OpenWranglerResponse,
  GridPage,
  OperationKind,
  SessionMetadata,
  TransformStep,
  ValuesResponse
} from "../shared/protocol";
import { emptyFilterModel, type FilterModel } from "../shared/filterModel";
import { FilterPanel } from "./filters/FilterPanel";
import { DataGrid } from "./grid/DataGrid";
import { SummaryPanel } from "./summary/SummaryPanel";
import { OperationBuilder } from "./operations/OperationBuilder";
import { applySnapshotFilters, snapshotColumnValues, snapshotSummaries } from "./snapshotModel";
import { vscode } from "./vscodeApi";

const webviewConfig = readWebviewConfig();
const pageSize = webviewConfig.fetchBlockSize;
const drawerSummaryConcurrency = 4;
const viewRequestEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let lastViewRequestSequence = 0;

export function App() {
  const [metadata, setMetadata] = useState<SessionMetadata | undefined>();
  const [page, setPage] = useState<GridPage | undefined>();
  const [summaries, setSummaries] = useState<ColumnSummary[]>([]);
  const [filterModel, setFilterModel] = useState<FilterModel>(emptyFilterModel);
  const [columnValues, setColumnValues] = useState<Record<string, ValuesResponse>>({});
  const [snapshotRows, setSnapshotRows] = useState<DataRow[] | undefined>();
  const [foregroundError, setForegroundError] = useState<string | undefined>();
  const [backgroundDiagnostics, setBackgroundDiagnostics] = useState<Record<string, BackgroundDiagnostic>>({});
  const [failedPageRequest, setFailedPageRequest] = useState<PendingPageRequest | undefined>();
  const [loading, setLoading] = useState(true);
  const [mutationPending, setMutationPending] = useState(false);
  const [goToColumn, setGoToColumn] = useState("");
  const [filterColumn, setFilterColumn] = useState("");
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [operationOpen, setOperationOpen] = useState(false);
  const [operationKind, setOperationKind] = useState<OperationKind | undefined>();
  const [editingStep, setEditingStep] = useState<TransformStep | undefined>();
  const [diff, setDiff] = useState<DataDiff | undefined>();
  const [generatedCode, setGeneratedCode] = useState("");
  const [draftWarnings, setDraftWarnings] = useState<string[]>([]);
  const [activeViewContextId, setActiveViewContextId] = useState("");
  const metadataRef = useRef<SessionMetadata | undefined>(undefined);
  const summariesRef = useRef<ColumnSummary[]>([]);
  const columnValuesRef = useRef<Record<string, ValuesResponse>>({});
  const backgroundDiagnosticsRef = useRef<Record<string, BackgroundDiagnostic>>({});
  const filterModelRef = useRef<FilterModel>(emptyFilterModel());
  const snapshotRowsRef = useRef<DataRow[] | undefined>(undefined);
  const sidePanelOpenRef = useRef(false);
  const confirmedView = useRef<ConfirmedView | undefined>(undefined);
  const latestPageRequest = useRef<PendingPageRequest | undefined>(undefined);
  const failedPageRequestRef = useRef<PendingPageRequest | undefined>(undefined);
  const foregroundRequest = useRef<"mutation" | { kind: "page"; viewRequestId: string } | undefined>(undefined);
  const pendingBackgroundRequests = useRef(new Map<string, PendingBackgroundRequest>());
  const pendingSummaryByColumn = useRef(new Map<string, string>());
  const summaryOwnersByColumn = useRef(new Map<string, Set<SummaryRequestOwner>>());
  const drawerSummaryQueue = useRef<string[]>([]);
  const drawerSummaryQueued = useRef(new Set<string>());
  const drawerSummaryActive = useRef(new Set<string>());
  const drawerSummaryExhausted = useRef(new Set<string>());
  const pendingStatsRequest = useRef<string | undefined>(undefined);
  const latestValuesByColumn = useRef(new Map<string, string>());
  const retryTimers = useRef(new Map<number, PendingBackgroundRequest>());
  const restoreGridFocusForPage = useRef<string | undefined>(undefined);
  const mutationSnapshot = useRef<ConfirmedViewState | undefined>(undefined);
  const sidePanelToggleRef = useRef<HTMLButtonElement | null>(null);
  const sidePanelReturnFocus = useRef<HTMLElement | null>(null);

  const nextViewRequestId = useCallback(() => {
    lastViewRequestSequence += 1;
    return `view-${viewRequestEpoch}-${lastViewRequestSequence}`;
  }, []);

  const storeMetadata = useCallback((next: SessionMetadata | undefined) => {
    metadataRef.current = next;
    setMetadata(next);
  }, []);

  const storeFilterModel = useCallback((next: FilterModel) => {
    filterModelRef.current = next;
    setFilterModel(next);
  }, []);

  const storeSummaries = useCallback((next: ColumnSummary[]) => {
    summariesRef.current = next;
    setSummaries(next);
  }, []);

  const storeColumnValues = useCallback((next: Record<string, ValuesResponse>) => {
    columnValuesRef.current = next;
    setColumnValues(next);
  }, []);

  const storeFailedPageRequest = useCallback((next: PendingPageRequest | undefined) => {
    failedPageRequestRef.current = next;
    setFailedPageRequest(next);
  }, []);

  const storeBackgroundDiagnostics = useCallback(
    (
      update:
        | Record<string, BackgroundDiagnostic>
        | ((current: Record<string, BackgroundDiagnostic>) => Record<string, BackgroundDiagnostic>)
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
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [storeBackgroundDiagnostics]
  );

  const releaseBackgroundRequest = useCallback((viewRequestId: string, pending: PendingBackgroundRequest): void => {
    if (pending.kind === "summary" && pendingSummaryByColumn.current.get(pending.column) === viewRequestId) {
      pendingSummaryByColumn.current.delete(pending.column);
    }
    if (pending.kind === "stats" && pendingStatsRequest.current === viewRequestId) {
      pendingStatsRequest.current = undefined;
    }
    if (pending.kind === "values" && latestValuesByColumn.current.get(pending.column) === viewRequestId) {
      latestValuesByColumn.current.delete(pending.column);
    }
  }, []);

  const dropSummaryOwner = useCallback((column: string, owner: SummaryRequestOwner): void => {
    const desiredOwners = summaryOwnersByColumn.current.get(column);
    desiredOwners?.delete(owner);
    if (desiredOwners?.size === 0) summaryOwnersByColumn.current.delete(column);
    for (const pending of pendingBackgroundRequests.current.values()) {
      if (pending.kind === "summary" && pending.column === column) pending.owners.delete(owner);
    }
    for (const pending of retryTimers.current.values()) {
      if (pending.kind === "summary" && pending.column === column) pending.owners.delete(owner);
    }
  }, []);

  const clearDrawerSummaryScheduling = useCallback((): void => {
    drawerSummaryQueue.current = [];
    drawerSummaryQueued.current.clear();
    drawerSummaryActive.current.clear();
    drawerSummaryExhausted.current.clear();
    for (const column of [...summaryOwnersByColumn.current.keys()]) dropSummaryOwner(column, "drawer");
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
        const next: Record<string, BackgroundDiagnostic> = {};
        for (const [key, diagnostic] of Object.entries(current)) {
          if (!diagnosticKeys.has(key) && !shouldCancel(diagnostic.pending)) next[key] = diagnostic;
        }
        return next;
      });
    },
    [releaseBackgroundRequest, storeBackgroundDiagnostics]
  );

  const clearProgressiveData = useCallback(
    (preserveColumnValues = false) => {
      storeSummaries([]);
      if (!preserveColumnValues) storeColumnValues({});
    },
    [storeColumnValues, storeSummaries]
  );

  const resetViewProfiling = useCallback(
    (preserveColumnValues = false) => {
      cancelBackgroundRequests();
      clearDrawerSummaryScheduling();
      clearProgressiveData(preserveColumnValues);
      storeBackgroundDiagnostics({});
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
      foregroundRequest.current !== "mutation" &&
      (!pendingPage || pendingPage.viewContextId === confirmed.viewContextId)
    );
  }, []);

  const sendSummaryColumn = useCallback(
    (column: string, attempt = 1, owner?: SummaryRequestOwner) => {
      if (owner) {
        const owners = summaryOwnersByColumn.current.get(column) ?? new Set<SummaryRequestOwner>();
        owners.add(owner);
        summaryOwnersByColumn.current.set(column, owners);
      }
      const owners = summaryOwnersByColumn.current.get(column);
      if (!owners?.size) return;
      const currentMetadata = metadataRef.current;
      const confirmed = confirmedView.current;
      if (
        !currentMetadata ||
        snapshotRowsRef.current ||
        !confirmed ||
        !canProfileConfirmedView(confirmed.viewContextId) ||
        !currentMetadata.schema.some((candidate) => candidate.name === column) ||
        summariesRef.current.some((summary) => summary.column === column)
      ) {
        return;
      }
      const existingRequestId = pendingSummaryByColumn.current.get(column);
      if (existingRequestId) {
        const existing = pendingBackgroundRequests.current.get(existingRequestId);
        if (existing?.kind === "summary") existing.owners = new Set(owners);
        return;
      }
      const viewRequestId = nextViewRequestId();
      pendingSummaryByColumn.current.set(column, viewRequestId);
      pendingBackgroundRequests.current.set(viewRequestId, {
        kind: "summary",
        viewContextId: confirmed.viewContextId,
        column,
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
          columns: [column]
        }
      });
    },
    [canProfileConfirmedView, nextViewRequestId]
  );

  const releaseSummaryOwner = useCallback(
    (column: string, owner: SummaryRequestOwner) => {
      dropSummaryOwner(column, owner);
      cancelBackgroundRequests(
        (pending) =>
          pending.kind === "summary" &&
          pending.column === column &&
          !(summaryOwnersByColumn.current.get(column)?.size ?? 0)
      );
    },
    [cancelBackgroundRequests, dropSummaryOwner]
  );

  const pumpDrawerSummaryProfiling = useCallback((): void => {
    const currentMetadata = metadataRef.current;
    const confirmed = confirmedView.current;
    if (
      !sidePanelOpenRef.current ||
      !currentMetadata ||
      snapshotRowsRef.current ||
      !confirmed ||
      !canProfileConfirmedView(confirmed.viewContextId)
    ) {
      return;
    }

    while (drawerSummaryActive.current.size < drawerSummaryConcurrency && drawerSummaryQueue.current.length > 0) {
      const column = drawerSummaryQueue.current.shift();
      if (!column) continue;
      drawerSummaryQueued.current.delete(column);
      if (
        !currentMetadata.schema.some((candidate) => candidate.name === column) ||
        summariesRef.current.some((summary) => summary.column === column)
      ) {
        continue;
      }

      sendSummaryColumn(column, 1, "drawer");
      if (pendingSummaryByColumn.current.has(column)) {
        drawerSummaryActive.current.add(column);
        continue;
      }

      dropSummaryOwner(column, "drawer");
      drawerSummaryQueue.current.unshift(column);
      drawerSummaryQueued.current.add(column);
      break;
    }
  }, [canProfileConfirmedView, dropSummaryOwner, sendSummaryColumn]);

  const finishDrawerSummaryColumn = useCallback(
    (column: string, exhausted = false): void => {
      if (!drawerSummaryActive.current.delete(column)) return;
      if (exhausted) drawerSummaryExhausted.current.add(column);
      dropSummaryOwner(column, "drawer");
      pumpDrawerSummaryProfiling();
    },
    [dropSummaryOwner, pumpDrawerSummaryProfiling]
  );

  const enqueueDrawerSummaryColumns = useCallback((): void => {
    const currentMetadata = metadataRef.current;
    if (!sidePanelOpenRef.current || !currentMetadata) return;
    for (const { name } of currentMetadata.schema) {
      if (
        summariesRef.current.some((summary) => summary.column === name) ||
        drawerSummaryQueued.current.has(name) ||
        drawerSummaryActive.current.has(name) ||
        drawerSummaryExhausted.current.has(name)
      ) {
        continue;
      }
      drawerSummaryQueue.current.push(name);
      drawerSummaryQueued.current.add(name);
    }
    pumpDrawerSummaryProfiling();
  }, [pumpDrawerSummaryProfiling]);

  const updateVisibleSummaryColumns = useCallback(
    (columns: string[]) => {
      const next = new Set(columns);
      for (const [column, owners] of [...summaryOwnersByColumn.current]) {
        if (owners.has("grid") && !next.has(column)) releaseSummaryOwner(column, "grid");
      }
      for (const column of next) sendSummaryColumn(column, 1, "grid");
    },
    [releaseSummaryOwner, sendSummaryColumn]
  );

  const restartOwnedSummaryProfiling = useCallback(() => {
    for (const [column, owners] of summaryOwnersByColumn.current) {
      if (owners.size) sendSummaryColumn(column);
    }
  }, [sendSummaryColumn]);

  const requestStatsForConfirmedView = useCallback(
    (attempt = 1) => {
      const currentMetadata = metadataRef.current;
      const confirmed = confirmedView.current;
      if (
        !sidePanelOpenRef.current ||
        !currentMetadata ||
        currentMetadata.stats ||
        snapshotRowsRef.current ||
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

  const captureConfirmedViewState = useCallback((): ConfirmedViewState | undefined => {
    const currentMetadata = metadataRef.current;
    const currentView = confirmedView.current;
    if (!currentMetadata || !currentView) return undefined;
    return {
      view: { ...currentView },
      metadata: currentMetadata,
      summaries: [...summariesRef.current],
      columnValues: { ...columnValuesRef.current },
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

  const beginMutation = useCallback((): boolean => {
    if (foregroundRequest.current) return false;
    const previous = captureConfirmedViewState();
    if (!previous) return false;
    mutationSnapshot.current = previous;
    resetViewProfiling();
    storeMetadata(withoutDatasetStats(previous.metadata));
    foregroundRequest.current = "mutation";
    setMutationPending(true);
    storeFailedPageRequest(undefined);
    setForegroundError(undefined);
    setLoading(true);
    return true;
  }, [captureConfirmedViewState, resetViewProfiling, storeFailedPageRequest, storeMetadata]);

  const pruneSummaryOwners = useCallback(
    (nextMetadata: SessionMetadata) => {
      const validColumns = new Set(nextMetadata.schema.map((column) => column.name));
      for (const column of summaryOwnersByColumn.current.keys()) {
        if (!validColumns.has(column)) summaryOwnersByColumn.current.delete(column);
      }
      cancelBackgroundRequests((pending) => pending.kind === "summary" && !validColumns.has(pending.column));
    },
    [cancelBackgroundRequests]
  );

  const restoreViewAfterPageFailure = useCallback(
    (pendingPage: PendingPageRequest) => {
      const previous = pendingPage.previousConfirmedState;
      if (!pendingPage.changesView || !previous) return;
      restoreConfirmedViewState(previous);
    },
    [restoreConfirmedViewState]
  );

  useEffect(() => {
    const timers = retryTimers.current;
    const listener = (event: MessageEvent<OpenWranglerResponse | EditorActionMessage>) => {
      const response = event.data;
      if (response.kind === "editorAction") {
        if (response.action === "openOperation") {
          setEditingStep(undefined);
          setOperationKind(response.operationKind);
          setOperationOpen(true);
        } else if (response.action === "editLatest") {
          setMetadata((current) => {
            const latest = current?.steps.at(-1);
            if (latest) {
              setEditingStep(latest);
              setOperationKind(latest.kind);
              setOperationOpen(true);
            }
            return current;
          });
        } else {
          if (!beginMutation()) return;
          vscode.postMessage({
            kind: "runtimeRequest",
            request: { kind: response.action, offset: 0, limit: pageSize }
          });
        }
        return;
      }

      if (response.kind === "error") {
        if (response.viewRequestId) {
          const pendingPage = latestPageRequest.current;
          if (pendingPage?.viewRequestId === response.viewRequestId) {
            latestPageRequest.current = undefined;
            if (
              typeof foregroundRequest.current === "object" &&
              foregroundRequest.current.viewRequestId === response.viewRequestId
            ) {
              foregroundRequest.current = undefined;
              setLoading(false);
            }
            restoreViewAfterPageFailure(pendingPage);
            storeFailedPageRequest(pendingPage);
            setForegroundError(response.message);
            return;
          }

          const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
          if (!pending) return;
          pendingBackgroundRequests.current.delete(response.viewRequestId);
          releaseBackgroundRequest(response.viewRequestId, pending);
          if (canProfileConfirmedView(pending.viewContextId)) {
            storeBackgroundDiagnostics((current) => ({
              ...current,
              [backgroundDiagnosticKey(pending)]: { message: response.message, pending }
            }));
            const retryScheduled = scheduleBackgroundRetry(pending);
            if (pending.kind === "summary" && !retryScheduled) finishDrawerSummaryColumn(pending.column, true);
          } else if (pending.kind === "summary") {
            finishDrawerSummaryColumn(pending.column, true);
          }
          return;
        }
        const shouldRestoreMutation = foregroundRequest.current === "mutation";
        if (shouldRestoreMutation) {
          const previous = mutationSnapshot.current;
          foregroundRequest.current = undefined;
          mutationSnapshot.current = undefined;
          setMutationPending(false);
          setLoading(false);
          if (previous) restoreConfirmedViewState(previous);
        } else if (!metadataRef.current) {
          setLoading(false);
        }
        setForegroundError(response.message);
        return;
      }

      if (response.kind === "cancelled") {
        if (!response.viewRequestId) {
          const shouldRestoreMutation = foregroundRequest.current === "mutation";
          if (shouldRestoreMutation) {
            const previous = mutationSnapshot.current;
            foregroundRequest.current = undefined;
            mutationSnapshot.current = undefined;
            setMutationPending(false);
            setLoading(false);
            if (previous) restoreConfirmedViewState(previous);
            setForegroundError("The cleaning operation was cancelled.");
          } else if (!metadataRef.current) {
            setLoading(false);
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
            setLoading(false);
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
          const retryScheduled = scheduleBackgroundRetry(pending);
          if (pending.kind === "summary" && !retryScheduled) finishDrawerSummaryColumn(pending.column, true);
        }
        return;
      }

      if (response.kind === "sessionOpened") {
        latestPageRequest.current = undefined;
        foregroundRequest.current = undefined;
        mutationSnapshot.current = undefined;
        setMutationPending(false);
        setLoading(false);
        setForegroundError(undefined);
        storeFailedPageRequest(undefined);
        resetViewProfiling();
        summaryOwnersByColumn.current.clear();
        confirmView(response.metadata, nextViewRequestId());
        storeMetadata(response.metadata);
        storeFilterModel(response.metadata.filterModel);
        setPage(response.page);
        storeSummaries(response.summaries);
        const rows = response.metadata.source.kind === "notebookOutput" ? response.page.rows : undefined;
        snapshotRowsRef.current = rows;
        setSnapshotRows(rows);
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
          setLoading(false);
        }
        setForegroundError(undefined);
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
        setPage(response.page);
        snapshotRowsRef.current = undefined;
        setSnapshotRows(undefined);
        restartProfilingForConfirmedView();
        if (restoreGridFocusForPage.current === response.viewRequestId) {
          restoreGridFocusForPage.current = undefined;
          window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>('[data-testid="data-grid-scroller"] [tabindex="0"]')?.focus();
          });
        }
        return;
      }

      if (response.kind === "stepPreview" || response.kind === "planUpdated") {
        latestPageRequest.current = undefined;
        foregroundRequest.current = undefined;
        mutationSnapshot.current = undefined;
        setMutationPending(false);
        setLoading(false);
        setForegroundError(undefined);
        storeFailedPageRequest(undefined);
        resetViewProfiling();
        const nextMetadata = withoutDatasetStats(response.metadata);
        pruneSummaryOwners(nextMetadata);
        confirmView(nextMetadata, nextViewRequestId());
        storeMetadata(nextMetadata);
        storeFilterModel(nextMetadata.filterModel);
        setPage(response.page);
        snapshotRowsRef.current = undefined;
        setSnapshotRows(undefined);
        setGeneratedCode(response.code);
        setDiff(response.kind === "stepPreview" ? response.diff : undefined);
        setDraftWarnings(response.kind === "stepPreview" ? (response.warnings ?? []) : []);
        if (response.kind === "stepPreview") setOperationOpen(false);
        restartProfilingForConfirmedView();
        return;
      }

      if (response.kind === "summary") {
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending || pending.kind !== "summary") return;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (!canProfileConfirmedView(pending.viewContextId) || response.revision !== confirmedView.current?.revision) {
          finishDrawerSummaryColumn(pending.column, true);
          return;
        }
        const merged = new Map(summariesRef.current.map((summary) => [summary.column, summary]));
        for (const summary of response.summaries) merged.set(summary.column, summary);
        storeSummaries([...merged.values()]);
        clearBackgroundDiagnostic(pending);
        finishDrawerSummaryColumn(pending.column);
        return;
      }

      if (response.kind === "columnValues") {
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending || pending.kind !== "values") return;
        const isLatest = latestValuesByColumn.current.get(response.column) === response.viewRequestId;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (
          !canProfileConfirmedView(pending.viewContextId) ||
          response.revision !== confirmedView.current?.revision ||
          !isLatest
        ) {
          return;
        }
        latestValuesByColumn.current.delete(response.column);
        storeColumnValues({ ...columnValuesRef.current, [response.column]: response });
        clearBackgroundDiagnostic(pending);
        return;
      }

      if (response.kind === "datasetStats") {
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending || pending.kind !== "stats") return;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (!canProfileConfirmedView(pending.viewContextId) || response.revision !== confirmedView.current?.revision)
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
        if (pending.kind === "summary") sendSummaryColumn(pending.column, pending.attempt + 1);
        else requestStatsForConfirmedView(pending.attempt + 1);
      }, 0);
      retryTimers.current.set(timer, pending);
      return true;
    }
  }, [
    beginMutation,
    canProfileConfirmedView,
    clearBackgroundDiagnostic,
    confirmView,
    finishDrawerSummaryColumn,
    nextViewRequestId,
    pruneSummaryOwners,
    releaseBackgroundRequest,
    requestStatsForConfirmedView,
    restartProfilingForConfirmedView,
    restoreConfirmedViewState,
    restoreViewAfterPageFailure,
    resetViewProfiling,
    sendSummaryColumn,
    storeBackgroundDiagnostics,
    storeColumnValues,
    storeFailedPageRequest,
    storeFilterModel,
    storeMetadata,
    storeSummaries
  ]);

  const schemaByName = useMemo(
    () => new Map(metadata?.schema.map((column) => [column.name, column]) ?? []),
    [metadata]
  );
  const snapshotMode = metadata?.source.kind === "notebookOutput" && snapshotRows !== undefined;

  const requestPage = (
    offset: number,
    model = filterModelRef.current,
    options: PageRequestOptions = {}
  ): string | undefined => {
    if (foregroundRequest.current === "mutation") return undefined;
    const currentMetadata = metadataRef.current;
    const currentSnapshotRows = snapshotRowsRef.current;
    if (currentMetadata && currentSnapshotRows) {
      applySnapshotModel(currentMetadata, currentSnapshotRows, model, offset);
      return undefined;
    }

    const viewRequestId = nextViewRequestId();
    const previousContextId = confirmedView.current?.viewContextId;
    const changesView = options.changesView ?? !previousContextId;
    const viewContextId = options.viewContextId ?? (changesView ? viewRequestId : (previousContextId ?? viewRequestId));
    const previousConfirmedState = changesView
      ? (latestPageRequest.current?.previousConfirmedState ?? captureConfirmedViewState())
      : undefined;
    const pendingPage = { viewRequestId, viewContextId, changesView, offset, model, previousConfirmedState };
    latestPageRequest.current = pendingPage;
    foregroundRequest.current = { kind: "page", viewRequestId };
    storeFailedPageRequest(undefined);
    setForegroundError(undefined);
    if (changesView) {
      resetViewProfiling(true);
      if (currentMetadata) storeMetadata(withoutDatasetStats(currentMetadata));
    }
    storeFilterModel(model);
    setLoading(true);
    vscode.postMessage({
      kind: "runtimeRequest",
      viewContextId,
      request: {
        kind: "getPage",
        viewRequestId,
        offset,
        limit: pageSize,
        filterModel: model
      }
    });
    return viewRequestId;
  };

  const requestValues = (column: string, search?: string) => {
    const currentMetadata = metadataRef.current;
    const currentSnapshotRows = snapshotRowsRef.current;
    const confirmed = confirmedView.current;
    if (!currentMetadata?.schema.some((candidate) => candidate.name === column)) return;
    const viewRequestId = nextViewRequestId();
    const valuesFilterModel = filterModelForColumnValues(currentMetadata.filterModel, column);
    if (currentMetadata && currentSnapshotRows) {
      const values = snapshotColumnValues(
        currentMetadata,
        currentSnapshotRows,
        filterModelForColumnValues(filterModelRef.current, column),
        column,
        search,
        viewRequestId
      );
      storeColumnValues({ ...columnValuesRef.current, [column]: values });
      return;
    }
    if (!currentMetadata || !confirmed || !canProfileConfirmedView(confirmed.viewContextId)) return;

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

  const applyFilters = (model: FilterModel) => {
    if (foregroundRequest.current === "mutation") return;
    const pendingPage = latestPageRequest.current;
    const sameDesiredModel = sameFilterModel(model, filterModelRef.current);
    if (sameDesiredModel && pendingPage && sameFilterModel(model, pendingPage.model)) {
      return;
    }
    storeFilterModel(model);
    const currentMetadata = metadataRef.current;
    const currentSnapshotRows = snapshotRowsRef.current;
    if (currentMetadata && currentSnapshotRows) {
      applySnapshotModel(currentMetadata, currentSnapshotRows, model, 0);
      return;
    }

    const failed = failedPageRequestRef.current;
    if (sameDesiredModel && failed && sameFilterModel(model, failed.model)) {
      requestPage(failed.offset, failed.model, {
        changesView: failed.changesView,
        viewContextId: failed.viewContextId
      });
      return;
    }
    if (sameDesiredModel && !pendingPage && currentMetadata && sameFilterModel(model, currentMetadata.filterModel)) {
      return;
    }

    requestPage(0, model, { changesView: true });
  };

  useEffect(() => {
    if (!sidePanelOpen || !metadata) return;
    enqueueDrawerSummaryColumns();
    requestStatsForConfirmedView();
  }, [activeViewContextId, enqueueDrawerSummaryColumns, metadata, requestStatsForConfirmedView, sidePanelOpen]);

  const previewStep = (step: TransformStep, replaceStepId?: string) => {
    if (!beginMutation()) return;
    vscode.postMessage({
      kind: "runtimeRequest",
      request: { kind: "previewStep", step, replaceStepId, offset: 0, limit: pageSize }
    });
  };

  const sendPlanAction = (action: "applyDraft" | "discardDraft" | "undoStep") => {
    if (!beginMutation()) return;
    vscode.postMessage({
      kind: "runtimeRequest",
      request: { kind: action, offset: 0, limit: pageSize }
    });
  };

  const openNewOperation = (kind?: OperationKind) => {
    if (foregroundRequest.current) return;
    setEditingStep(undefined);
    setOperationKind(kind);
    setOperationOpen(true);
  };

  const editLatestStep = () => {
    if (foregroundRequest.current) return;
    const latest = metadata?.steps.at(-1);
    if (!latest) return;
    setEditingStep(latest);
    setOperationKind(latest.kind);
    setOperationOpen(true);
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
      } else if (metadata?.draftStep) {
        sendPlanAction("discardDraft");
        handled = true;
      }
    } else if (modifier && !event.altKey && !event.shiftKey && event.key === "Enter" && metadata?.draftStep) {
      sendPlanAction("applyDraft");
      handled = true;
    } else if (!editableTarget && modifier && event.altKey && !event.shiftKey && key === "z") {
      if (!metadata?.draftStep && metadata?.steps.length) {
        sendPlanAction("undoStep");
        handled = true;
      }
    } else if (!editableTarget && modifier && event.shiftKey && !event.altKey && key === "e") {
      if (!metadata?.draftStep && metadata?.steps.length) {
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
      viewContextId: failed.viewContextId
    });
  };

  const closeSidePanel = () => {
    sidePanelOpenRef.current = false;
    setSidePanelOpen(false);
    clearDrawerSummaryScheduling();
    cancelBackgroundRequests(
      (pending) =>
        pending.kind === "stats" ||
        pending.kind === "values" ||
        (pending.kind === "summary" && !(summaryOwnersByColumn.current.get(pending.column)?.size ?? 0))
    );
    const returnTarget = sidePanelReturnFocus.current;
    window.requestAnimationFrame(() => {
      if (returnTarget?.isConnected) returnTarget.focus();
      else sidePanelToggleRef.current?.focus();
    });
  };

  const backgroundDiagnosticMessages = Object.values(backgroundDiagnostics).map((diagnostic) => diagnostic.message);

  if (foregroundError && !metadata) {
    return (
      <main className="app app-error">
        <h1>Open Wrangler</h1>
        <p role="alert">{foregroundError}</p>
      </main>
    );
  }

  return (
    <main className="app" onKeyDown={handleKeyboardShortcut}>
      <header className="toolbar">
        <div className="toolbarIdentity">
          <strong>{metadata?.source.label ?? "Loading dataframe..."}</strong>
          <span>
            {metadata
              ? `${metadata.filteredShape.rows.toLocaleString()} rows x ${metadata.filteredShape.columns.toLocaleString()} columns`
              : "Preparing session"}
          </span>
        </div>
        {metadata && (
          <div className="toolbarActions">
            {metadata.mode === "editing" && !snapshotMode && (
              <button type="button" disabled={loading} onClick={() => openNewOperation()}>
                <span className="codicon codicon-add" aria-hidden="true" /> Add step
              </button>
            )}
            <button
              ref={sidePanelToggleRef}
              type="button"
              className="toolbarButton"
              aria-expanded={sidePanelOpen}
              onClick={(event) => {
                if (sidePanelOpenRef.current) {
                  closeSidePanel();
                  return;
                }
                sidePanelReturnFocus.current = event.currentTarget;
                sidePanelOpenRef.current = true;
                setSidePanelOpen(true);
              }}
            >
              Insights & filters
            </button>
            <label className="goToColumn">
              <span>Column</span>
              <input
                list="openwrangler-columns"
                value={goToColumn}
                placeholder="Search columns"
                onChange={(event) => setGoToColumn(event.target.value)}
              />
              <datalist id="openwrangler-columns">
                {metadata.schema.map((column) => (
                  <option key={column.id} value={column.name} />
                ))}
              </datalist>
            </label>
            <span className="modeBadge">{metadata.mode}</span>
            <span className="backendBadge">{metadata.backend}</span>
            {snapshotMode && <span className="modeBadge">Snapshot</span>}
          </div>
        )}
      </header>

      {metadata && metadata.mode === "editing" && (
        <section className="cleaningBar" aria-label="Cleaning plan">
          <div className="cleaningSummary">
            <span className="codicon codicon-layers" aria-hidden="true" />
            <strong>
              {metadata.steps.length} applied {metadata.steps.length === 1 ? "step" : "steps"}
            </strong>
            {metadata.draftStep && <span className="draftBadge">Draft: {metadata.draftStep.kind}</span>}
          </div>
          <div className="cleaningActions">
            {metadata.draftStep ? (
              <>
                <button
                  type="button"
                  className="secondaryButton"
                  disabled={loading}
                  aria-keyshortcuts="Escape"
                  title="Discard draft (Escape)"
                  onClick={() => sendPlanAction("discardDraft")}
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={loading}
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  title="Apply draft (Ctrl/Cmd+Enter)"
                  onClick={() => sendPlanAction("applyDraft")}
                >
                  Apply step
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="secondaryButton"
                  disabled={loading || metadata.steps.length === 0}
                  aria-keyshortcuts="Control+Shift+E Meta+Shift+E"
                  title="Edit latest step (Ctrl/Cmd+Shift+E)"
                  onClick={editLatestStep}
                >
                  Edit latest
                </button>
                <button
                  type="button"
                  className="secondaryButton"
                  disabled={loading || metadata.steps.length === 0}
                  aria-keyshortcuts="Control+Alt+Z Meta+Alt+Z"
                  title="Undo latest step (Ctrl/Cmd+Alt+Z)"
                  onClick={() => sendPlanAction("undoStep")}
                >
                  <span className="codicon codicon-discard" aria-hidden="true" /> Undo
                </button>
              </>
            )}
          </div>
        </section>
      )}

      <section className={`layout${sidePanelOpen ? " sidePanelOpen" : ""}`}>
        <section className="gridShell">
          {foregroundError && (
            <div className="errorBanner" role="alert">
              <span>{foregroundError}</span>
              {failedPageRequest && (
                <button type="button" className="secondaryButton" onClick={retryFailedPage}>
                  Retry page
                </button>
              )}
            </div>
          )}
          {backgroundDiagnosticMessages.length > 0 && (
            <div className="errorBanner" role="status" aria-label="Profiling diagnostics">
              Insights warning: {backgroundDiagnosticMessages.join(" ")}
            </div>
          )}
          {loading && (
            <div className="loading" role="status" aria-live="polite">
              Loading...
            </div>
          )}
          {metadata && page ? (
            <DataGrid
              metadata={metadata}
              page={page}
              summaries={summaries}
              onPage={requestPage}
              pageSize={pageSize}
              defaultColumnWidth={webviewConfig.defaultColumnWidth}
              insightsOnOpen={webviewConfig.insightsOnOpen}
              busy={loading}
              viewContextId={activeViewContextId}
              goToColumn={goToColumn}
              onSortColumn={(column, direction) =>
                applyFilters({
                  ...filterModel,
                  sort: [
                    ...filterModel.sort.filter((rule) => rule.column !== column),
                    { column, direction, nulls: "last" }
                  ]
                })
              }
              onOpenFilter={(column) => {
                sidePanelReturnFocus.current =
                  document.activeElement instanceof HTMLElement ? document.activeElement : sidePanelToggleRef.current;
                setFilterColumn(column);
                sidePanelOpenRef.current = true;
                setSidePanelOpen(true);
                requestValues(column);
              }}
              onVisibleSummaryColumnsChange={updateVisibleSummaryColumns}
            />
          ) : (
            <div className="emptyState">Opening session...</div>
          )}
        </section>
        {sidePanelOpen && (
          <aside className="sidebar" aria-label="Insights and filters">
            <div className="drawerHeader">
              <strong>Insights & filters</strong>
              <button
                type="button"
                className="iconButton codicon codicon-close"
                aria-label="Close panel"
                onClick={closeSidePanel}
              />
            </div>
            <SummaryPanel metadata={metadata} summaries={summaries} schemaByName={schemaByName} />
            <FilterPanel
              key={filterColumn}
              metadata={metadata}
              model={filterModel}
              values={columnValues}
              activeColumn={filterColumn}
              defaultAdvanced={webviewConfig.filterMode === "advanced"}
              disabled={mutationPending}
              onApply={applyFilters}
              onRequestValues={requestValues}
            />
          </aside>
        )}
      </section>
      {metadata?.draftStep && (
        <section className="draftPanel" aria-label="Draft preview">
          <header>
            <div>
              <strong>Previewing {metadata.draftStep.kind}</strong>
              <span>The grid shows the draft result. Apply or discard it explicitly.</span>
            </div>
            {diff && (
              <div className="diffStats" aria-label="Data diff summary">
                <span>+{diff.addedRows} rows</span>
                <span>-{diff.removedRows} rows</span>
                <span>+{diff.addedColumns.length} columns</span>
                <span>-{diff.removedColumns.length} columns</span>
                <span>
                  {diff.changedCells} changed cells{diff.truncated ? " in this block" : ""}
                </span>
              </div>
            )}
            {draftWarnings.length > 0 && (
              <div className="draftWarnings" role="alert">
                {draftWarnings.map((warning) => (
                  <span key={warning}>
                    <span className="codicon codicon-warning" aria-hidden="true" /> {warning}
                  </span>
                ))}
              </div>
            )}
          </header>
          <details className="draftCode" open>
            <summary>
              Generated {metadata.backend === "duckdb" ? "DuckDB" : metadata.backend === "pandas" ? "Pandas" : "Polars"}
              code · edit in Code Preview panel
            </summary>
            <pre tabIndex={0} aria-label="Generated Python code preview">
              <code>{generatedCode}</code>
            </pre>
          </details>
        </section>
      )}
      {metadata && operationOpen && (
        <OperationBuilder
          key={`${operationKind ?? "none"}:${editingStep?.id ?? "new"}`}
          metadata={metadata}
          filterModel={filterModel}
          initialKind={operationKind}
          initialStep={editingStep}
          busy={mutationPending}
          onClose={() => {
            if (foregroundRequest.current !== "mutation") setOperationOpen(false);
          }}
          onPreview={previewStep}
        />
      )}
    </main>
  );

  function applySnapshotModel(metadata: SessionMetadata, rows: DataRow[], model: FilterModel, offset: number): void {
    resetViewProfiling(true);
    const filteredRows = applySnapshotFilters(metadata, rows, model);
    const nextMetadata: SessionMetadata = {
      ...metadata,
      filteredShape: {
        rows: filteredRows.length,
        columns: metadata.shape.columns
      },
      filterModel: model
    };

    setMetadata(nextMetadata);
    metadataRef.current = nextMetadata;
    filterModelRef.current = model;
    setFilterModel(model);
    setPage({
      offset,
      limit: pageSize,
      totalRows: filteredRows.length,
      rows: filteredRows.slice(offset, offset + pageSize)
    });
    const nextSummaries = snapshotSummaries(nextMetadata, filteredRows);
    summariesRef.current = nextSummaries;
    setSummaries(nextSummaries);
    confirmView(nextMetadata, nextViewRequestId());
    setLoading(false);
    setForegroundError(undefined);
    storeFailedPageRequest(undefined);
  }
}

interface EditorActionMessage {
  kind: "editorAction";
  action: "openOperation" | "editLatest" | "applyDraft" | "discardDraft" | "undoStep";
  operationKind?: OperationKind;
}

interface ConfirmedView {
  viewContextId: string;
  sessionId: string;
  revision: number;
}

interface ConfirmedViewState {
  view: ConfirmedView;
  metadata: SessionMetadata;
  summaries: ColumnSummary[];
  columnValues: Record<string, ValuesResponse>;
  backgroundDiagnostics: Record<string, BackgroundDiagnostic>;
}

interface PendingPageRequest {
  viewRequestId: string;
  viewContextId: string;
  changesView: boolean;
  offset: number;
  model: FilterModel;
  previousConfirmedState?: ConfirmedViewState;
}

type SummaryRequestOwner = "grid" | "drawer";

type PendingBackgroundRequest =
  | {
      kind: "summary";
      viewContextId: string;
      column: string;
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
}

function backgroundDiagnosticKey(pending: PendingBackgroundRequest): string {
  if (pending.kind === "stats") return "stats";
  return `${pending.kind}:${pending.column}`;
}

function cloneBackgroundDiagnostics(
  diagnostics: Record<string, BackgroundDiagnostic>
): Record<string, BackgroundDiagnostic> {
  return Object.fromEntries(
    Object.entries(diagnostics).map(([key, diagnostic]) => [
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

function filterModelForColumnValues(model: FilterModel, column: string): FilterModel {
  return {
    ...model,
    filters: model.filters.filter((filter) => filter.column !== column)
  };
}

function filterModelScope(model: FilterModel): string {
  return JSON.stringify({ logic: model.logic ?? "and", filters: model.filters, sort: model.sort });
}

function readWebviewConfig(): {
  fetchBlockSize: number;
  defaultColumnWidth: number;
  insightsOnOpen: boolean;
  filterMode: "basic" | "advanced";
} {
  const fetchBlockSize = Number(document.body.dataset.fetchBlockSize ?? 200);
  const defaultColumnWidth = Number(document.body.dataset.defaultColumnWidth ?? 190);
  return {
    fetchBlockSize: Number.isFinite(fetchBlockSize) ? Math.max(25, Math.min(2000, fetchBlockSize)) : 200,
    defaultColumnWidth: Number.isFinite(defaultColumnWidth) ? Math.max(80, Math.min(640, defaultColumnWidth)) : 190,
    insightsOnOpen: document.body.dataset.insightsOnOpen !== "false",
    filterMode: document.body.dataset.filterMode === "advanced" ? "advanced" : "basic"
  };
}
