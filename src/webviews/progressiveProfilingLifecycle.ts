import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CancelledResponse,
  ColumnSchema,
  ColumnSummary,
  DatasetStats,
  DatasetStatsResponse,
  ErrorResponse,
  SessionMetadata,
  SummaryResponse,
  ValuesResponse
} from "../shared/protocol";
import { supportsViewingCapability } from "../shared/protocol";
import {
  backgroundDiagnosticKey,
  cloneBackgroundDiagnostics,
  filterModelForColumnValues,
  type BackgroundDiagnostic,
  type ConfirmedView,
  type ConfirmedViewState,
  type PendingBackgroundRequest,
  type SummaryRequestOwner
} from "./appState";
import type { SummaryPanelView } from "./summary/SummaryPanel";
import { vscode } from "./vscodeApi";

const nonCancellableMutationProfileRestartDelayMs = 2_000;

export interface ConfirmedProfileView {
  metadata: SessionMetadata;
  view: ConfirmedView;
}

export interface ProgressiveProfilingDrawerDemand {
  open: boolean;
  view: SummaryPanelView;
  selectedColumnId?: string;
  suspended: boolean;
  viewContextId: string;
}

export type ProgressiveProfileState = Pick<ConfirmedViewState, "summaries" | "columnValues" | "backgroundDiagnostics">;

export type ProgressiveProfileMessage =
  SummaryResponse | DatasetStatsResponse | ValuesResponse | ErrorResponse | CancelledResponse;

export interface ProgressiveProfileSettlement {
  handled: boolean;
  stats?: DatasetStats;
  foregroundError?: string;
}

export interface ProgressiveProfilingLifecycleOptions {
  nextViewRequestId: () => string;
  readConfirmedView: () => ConfirmedProfileView | undefined;
  canProfileConfirmedView: (viewContextId: string) => boolean;
  drawerDemand: ProgressiveProfilingDrawerDemand;
}

export function useProgressiveProfilingLifecycle({
  nextViewRequestId,
  readConfirmedView,
  canProfileConfirmedView,
  drawerDemand
}: ProgressiveProfilingLifecycleOptions) {
  const [summaries, setSummaries] = useState<ColumnSummary[]>([]);
  const [columnValues, setColumnValues] = useState<ReadonlyMap<string, ValuesResponse>>(() => new Map());
  const [backgroundDiagnostics, setBackgroundDiagnostics] = useState<ReadonlyMap<string, BackgroundDiagnostic>>(
    () => new Map()
  );
  const summariesRef = useRef<ColumnSummary[]>([]);
  const columnValuesRef = useRef<ReadonlyMap<string, ValuesResponse>>(new Map());
  const backgroundDiagnosticsRef = useRef<ReadonlyMap<string, BackgroundDiagnostic>>(new Map());
  const pendingBackgroundRequests = useRef(new Map<string, PendingBackgroundRequest>());
  const pendingSummaryByColumnId = useRef(new Map<string, string>());
  const summaryOwnersByColumnId = useRef(new Map<string, Set<SummaryRequestOwner>>());
  const pendingStatsRequest = useRef<string | undefined>(undefined);
  const latestValuesByColumn = useRef(new Map<string, string>());
  const retryTimers = useRef(new Map<number, PendingBackgroundRequest>());
  const mutationProfileRestartTimer = useRef<number | undefined>(undefined);
  const drawerDemandRef = useRef(drawerDemand);

  useEffect(() => {
    drawerDemandRef.current = drawerDemand;
  }, [drawerDemand]);

  const storeSummaries = useCallback((next: ColumnSummary[]) => {
    summariesRef.current = next;
    setSummaries(next);
  }, []);

  const storeColumnValues = useCallback((next: ReadonlyMap<string, ValuesResponse>) => {
    columnValuesRef.current = next;
    setColumnValues(next);
  }, []);

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

  const cancelMutationProfileRestart = useCallback(() => {
    if (mutationProfileRestartTimer.current === undefined) return;
    window.clearTimeout(mutationProfileRestartTimer.current);
    mutationProfileRestartTimer.current = undefined;
  }, []);

  const cancelPendingProfiling = useCallback(() => {
    cancelBackgroundRequests();
  }, [cancelBackgroundRequests]);

  const suspendProfiling = useCallback(() => {
    cancelPendingProfiling();
    clearDrawerSummaryScheduling();
  }, [cancelPendingProfiling, clearDrawerSummaryScheduling]);

  const resetViewProfiling = useCallback(
    (
      options: {
        preserveColumnValues?: boolean;
        initialSummaries?: ColumnSummary[];
        clearOwners?: boolean;
      } = {}
    ) => {
      cancelMutationProfileRestart();
      suspendProfiling();
      if (options.clearOwners) summaryOwnersByColumnId.current.clear();
      storeSummaries(options.initialSummaries ?? []);
      if (!options.preserveColumnValues) storeColumnValues(new Map());
      storeBackgroundDiagnostics(new Map());
    },
    [cancelMutationProfileRestart, storeBackgroundDiagnostics, storeColumnValues, storeSummaries, suspendProfiling]
  );

  const captureProfileState = useCallback(
    (): ProgressiveProfileState => ({
      summaries: [...summariesRef.current],
      columnValues: new Map(columnValuesRef.current),
      backgroundDiagnostics: cloneBackgroundDiagnostics(backgroundDiagnosticsRef.current)
    }),
    []
  );

  const restoreProfileState = useCallback(
    (previous: ProgressiveProfileState) => {
      storeSummaries([...previous.summaries]);
      storeColumnValues(new Map(previous.columnValues));
      storeBackgroundDiagnostics(cloneBackgroundDiagnostics(previous.backgroundDiagnostics));
    },
    [storeBackgroundDiagnostics, storeColumnValues, storeSummaries]
  );

  const sendSummaryColumn = useCallback(
    (columnId: string, attempt = 1, owner?: SummaryRequestOwner) => {
      const existingRequestId = pendingSummaryByColumnId.current.get(columnId);
      const existingRequest = existingRequestId ? pendingBackgroundRequests.current.get(existingRequestId) : undefined;
      const promoteForDrawer =
        owner === "drawer" && existingRequest?.kind === "summary" && !existingRequest.owners.has("drawer");
      if (owner) {
        const owners = summaryOwnersByColumnId.current.get(columnId) ?? new Set<SummaryRequestOwner>();
        owners.add(owner);
        summaryOwnersByColumnId.current.set(columnId, owners);
      }
      const owners = summaryOwnersByColumnId.current.get(columnId);
      if (!owners?.size) return;
      const current = readConfirmedView();
      if (
        !current ||
        !supportsViewingCapability(current.metadata.capabilities, "profile") ||
        !canProfileConfirmedView(current.view.viewContextId) ||
        !current.metadata.schema.some((candidate) => candidate.id === columnId) ||
        summariesRef.current.some((summary) => summary.columnId === columnId)
      ) {
        return;
      }
      if (existingRequestId) {
        if (existingRequest?.kind === "summary" && promoteForDrawer) {
          vscode.postMessage({ kind: "prioritizeViewRequest", viewRequestId: existingRequestId });
        }
        if (existingRequest?.kind === "summary") existingRequest.owners = new Set(owners);
        return;
      }
      const viewRequestId = nextViewRequestId();
      pendingSummaryByColumnId.current.set(columnId, viewRequestId);
      pendingBackgroundRequests.current.set(viewRequestId, {
        kind: "summary",
        viewContextId: current.view.viewContextId,
        columnId,
        attempt,
        owners: new Set(owners)
      });
      vscode.postMessage({
        kind: "runtimeRequest",
        priority: owners.has("drawer") ? "interactive" : "background",
        viewContextId: current.view.viewContextId,
        request: {
          kind: "getSummary",
          viewRequestId,
          filterModel: current.metadata.filterModel,
          columnIds: [columnId]
        }
      });
    },
    [canProfileConfirmedView, nextViewRequestId, readConfirmedView]
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
      const current = readConfirmedView();
      if (!current || !supportsViewingCapability(current.metadata.capabilities, "profile")) return;
      const next = new Set(columnIds);
      for (const [columnId, owners] of [...summaryOwnersByColumnId.current]) {
        if (owners.has("grid") && !next.has(columnId)) releaseSummaryOwner(columnId, "grid");
      }
      for (const columnId of next) {
        if (mutationProfileRestartTimer.current !== undefined) {
          const owners = summaryOwnersByColumnId.current.get(columnId) ?? new Set<SummaryRequestOwner>();
          owners.add("grid");
          summaryOwnersByColumnId.current.set(columnId, owners);
          continue;
        }
        sendSummaryColumn(columnId, 1, "grid");
      }
    },
    [readConfirmedView, releaseSummaryOwner, sendSummaryColumn]
  );

  const restartOwnedSummaryProfiling = useCallback(() => {
    for (const [columnId, owners] of summaryOwnersByColumnId.current) {
      if (owners.size) sendSummaryColumn(columnId);
    }
  }, [sendSummaryColumn]);

  const requestStatsForConfirmedView = useCallback(
    (attempt = 1) => {
      const demand = drawerDemandRef.current;
      const current = readConfirmedView();
      if (
        !demand.open ||
        demand.view !== "dataset" ||
        demand.suspended ||
        !current ||
        !supportsViewingCapability(current.metadata.capabilities, "profile") ||
        current.metadata.stats ||
        pendingStatsRequest.current ||
        !canProfileConfirmedView(current.view.viewContextId)
      ) {
        return;
      }
      const viewRequestId = nextViewRequestId();
      pendingStatsRequest.current = viewRequestId;
      pendingBackgroundRequests.current.set(viewRequestId, {
        kind: "stats",
        viewContextId: current.view.viewContextId,
        attempt
      });
      vscode.postMessage({
        kind: "runtimeRequest",
        viewContextId: current.view.viewContextId,
        request: {
          kind: "getDatasetStats",
          viewRequestId,
          filterModel: current.metadata.filterModel
        }
      });
    },
    [canProfileConfirmedView, nextViewRequestId, readConfirmedView]
  );

  const restartProfilingForConfirmedView = useCallback(() => {
    const demand = drawerDemandRef.current;
    const current = readConfirmedView();
    if (
      demand.open &&
      demand.view === "column" &&
      !demand.suspended &&
      demand.viewContextId === current?.view.viewContextId &&
      demand.selectedColumnId
    ) {
      sendSummaryColumn(demand.selectedColumnId, 1, "drawer");
    }
    restartOwnedSummaryProfiling();
    requestStatsForConfirmedView();
  }, [readConfirmedView, requestStatsForConfirmedView, restartOwnedSummaryProfiling, sendSummaryColumn]);

  const pruneSummaryOwners = useCallback(
    (schema: readonly ColumnSchema[]) => {
      const validColumnIds = new Set(schema.map((column) => column.id));
      for (const columnId of summaryOwnersByColumnId.current.keys()) {
        if (!validColumnIds.has(columnId)) summaryOwnersByColumnId.current.delete(columnId);
      }
      cancelBackgroundRequests((pending) => pending.kind === "summary" && !validColumnIds.has(pending.columnId));
    },
    [cancelBackgroundRequests]
  );

  const restartProfilingAfterMutation = useCallback(
    (metadata: SessionMetadata) => {
      pruneSummaryOwners(metadata.schema);
      cancelMutationProfileRestart();
      if (metadata.capabilities.cancel !== false) {
        restartProfilingForConfirmedView();
        return;
      }
      mutationProfileRestartTimer.current = window.setTimeout(() => {
        mutationProfileRestartTimer.current = undefined;
        restartProfilingForConfirmedView();
      }, nonCancellableMutationProfileRestartDelayMs);
    },
    [cancelMutationProfileRestart, pruneSummaryOwners, restartProfilingForConfirmedView]
  );

  const requestValues = useCallback(
    (column: string, search?: string) => {
      const current = readConfirmedView();
      if (
        !current ||
        !supportsViewingCapability(current.metadata.capabilities, "filter") ||
        !supportsViewingCapability(current.metadata.capabilities, "columnValues") ||
        current.metadata.schema.filter((candidate) => candidate.name === column).length !== 1
      ) {
        return;
      }
      const viewRequestId = nextViewRequestId();
      if (!canProfileConfirmedView(current.view.viewContextId)) return;
      const previousRequestId = latestValuesByColumn.current.get(column);
      if (previousRequestId) {
        const previous = pendingBackgroundRequests.current.get(previousRequestId);
        if (previous) cancelBackgroundRequests((pending) => pending === previous);
      }
      latestValuesByColumn.current.set(column, viewRequestId);
      pendingBackgroundRequests.current.set(viewRequestId, {
        kind: "values",
        viewContextId: current.view.viewContextId,
        column
      });
      vscode.postMessage({
        kind: "runtimeRequest",
        viewContextId: current.view.viewContextId,
        request: {
          kind: "getColumnValues",
          viewRequestId,
          column,
          search,
          limit: 100,
          filterModel: filterModelForColumnValues(current.metadata.filterModel, column)
        }
      });
    },
    [canProfileConfirmedView, cancelBackgroundRequests, nextViewRequestId, readConfirmedView]
  );

  const scheduleBackgroundRetry = useCallback(
    (pending: PendingBackgroundRequest): boolean => {
      if (pending.kind === "values" || pending.attempt >= 2 || !canProfileConfirmedView(pending.viewContextId)) {
        return false;
      }
      const timer = window.setTimeout(() => {
        retryTimers.current.delete(timer);
        if (pending.kind === "summary") sendSummaryColumn(pending.columnId, pending.attempt + 1);
        else requestStatsForConfirmedView(pending.attempt + 1);
      }, 0);
      retryTimers.current.set(timer, pending);
      return true;
    },
    [canProfileConfirmedView, requestStatsForConfirmedView, sendSummaryColumn]
  );

  const settleProfileMessage = useCallback(
    (response: ProgressiveProfileMessage): ProgressiveProfileSettlement => {
      if (response.kind === "error" || response.kind === "cancelled") {
        if (!response.viewRequestId) return { handled: false };
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending) return { handled: false };
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (response.kind === "error") {
          if (response.code === "pyspark_connect_state_lost") {
            return { handled: true, foregroundError: response.message };
          }
          if (canProfileConfirmedView(pending.viewContextId)) {
            storeBackgroundDiagnostics((current) => {
              const next = new Map(current);
              next.set(backgroundDiagnosticKey(pending), { message: response.message, pending });
              return next;
            });
            scheduleBackgroundRetry(pending);
          }
        } else {
          scheduleBackgroundRetry(pending);
        }
        return { handled: true };
      }

      const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
      if (!pending) return { handled: false };

      if (response.kind === "summary") {
        if (pending.kind !== "summary") return { handled: false };
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        const current = readConfirmedView();
        if (
          !current ||
          !supportsViewingCapability(current.metadata.capabilities, "profile") ||
          !canProfileConfirmedView(pending.viewContextId) ||
          response.revision !== current.view.revision
        ) {
          return { handled: true };
        }
        const merged = new Map(summariesRef.current.map((summary) => [summary.columnId, summary]));
        for (const summary of response.summaries) merged.set(summary.columnId, summary);
        const schemaOrder = new Map(current.metadata.schema.map((column, index) => [column.id, index]));
        storeSummaries(
          [...merged.values()].sort(
            (left, right) =>
              (schemaOrder.get(left.columnId) ?? Number.MAX_SAFE_INTEGER) -
              (schemaOrder.get(right.columnId) ?? Number.MAX_SAFE_INTEGER)
          )
        );
        clearBackgroundDiagnostic(pending);
        return { handled: true };
      }

      if (response.kind === "columnValues") {
        if (pending.kind !== "values") return { handled: false };
        const isLatest = latestValuesByColumn.current.get(response.column) === response.viewRequestId;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        const current = readConfirmedView();
        if (
          !current ||
          !supportsViewingCapability(current.metadata.capabilities, "columnValues") ||
          !canProfileConfirmedView(pending.viewContextId) ||
          response.revision !== current.view.revision ||
          !isLatest
        ) {
          return { handled: true };
        }
        latestValuesByColumn.current.delete(response.column);
        storeColumnValues(new Map(columnValuesRef.current).set(response.column, response));
        clearBackgroundDiagnostic(pending);
        return { handled: true };
      }

      if (pending.kind !== "stats") return { handled: false };
      pendingBackgroundRequests.current.delete(response.viewRequestId);
      releaseBackgroundRequest(response.viewRequestId, pending);
      const current = readConfirmedView();
      if (
        !current ||
        !supportsViewingCapability(current.metadata.capabilities, "profile") ||
        !canProfileConfirmedView(pending.viewContextId) ||
        response.revision !== current.view.revision
      ) {
        return { handled: true };
      }
      clearBackgroundDiagnostic(pending);
      return { handled: true, stats: response.stats };
    },
    [
      canProfileConfirmedView,
      clearBackgroundDiagnostic,
      readConfirmedView,
      releaseBackgroundRequest,
      scheduleBackgroundRetry,
      storeBackgroundDiagnostics,
      storeColumnValues,
      storeSummaries
    ]
  );

  const releaseDrawerProfiling = useCallback(() => {
    clearDrawerSummaryScheduling();
    cancelBackgroundRequests(
      (pending) =>
        pending.kind === "stats" ||
        pending.kind === "values" ||
        (pending.kind === "summary" && !(summaryOwnersByColumnId.current.get(pending.columnId)?.size ?? 0))
    );
  }, [cancelBackgroundRequests, clearDrawerSummaryScheduling]);

  useEffect(() => {
    if (!drawerDemand.open || drawerDemand.suspended) return;
    const desiredColumnId = drawerDemand.view === "column" ? drawerDemand.selectedColumnId : undefined;
    for (const [columnId, owners] of [...summaryOwnersByColumnId.current]) {
      if (owners.has("drawer") && columnId !== desiredColumnId) releaseSummaryOwner(columnId, "drawer");
    }
    if (desiredColumnId) sendSummaryColumn(desiredColumnId, 1, "drawer");
    if (drawerDemand.view === "dataset") requestStatsForConfirmedView();
    else cancelBackgroundRequests((pending) => pending.kind === "stats");
    if (drawerDemand.view !== "filters") cancelBackgroundRequests((pending) => pending.kind === "values");
  }, [
    cancelBackgroundRequests,
    drawerDemand.open,
    drawerDemand.selectedColumnId,
    drawerDemand.suspended,
    drawerDemand.view,
    drawerDemand.viewContextId,
    releaseSummaryOwner,
    requestStatsForConfirmedView,
    sendSummaryColumn
  ]);

  useEffect(
    () => () => {
      cancelMutationProfileRestart();
      for (const timer of retryTimers.current.keys()) window.clearTimeout(timer);
      retryTimers.current.clear();
    },
    [cancelMutationProfileRestart]
  );

  return {
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
  };
}
