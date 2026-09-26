import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ColumnSchema, FilterModel, OpenWranglerResponse, SessionMetadata } from "../../shared/protocol";
import { liveGridPageHasMore } from "../../shared/protocol";
import { isOpenWranglerResponse } from "../../shared/protocolValidation";
import { reportWebviewFailure } from "../WebviewErrorBoundary";
import { vscode } from "../vscodeApi";
import {
  createGridClipboardColumnAccumulator,
  GridClipboardOwnershipChangedError,
  maximumClipboardColumnValues,
  tryAcquireGridClipboardWrite,
  type GridClipboardColumnAccumulator,
  type GridClipboardResult,
  type GridClipboardWritePhase
} from "./gridClipboard";

/** "selected" defers reading a column that may exceed the clipboard limit until a copy is requested. */
type WholeColumnClipboardPhase = "idle" | "selected" | "preparing" | "ready" | "error";

interface WholeColumnClipboardState {
  phase: WholeColumnClipboardPhase;
  column?: ColumnSchema;
  copyRequested?: boolean;
  ownerId?: string;
  preparationIdentity?: string;
  result?: GridClipboardResult;
  reason?: string;
  rowCount?: number;
  extent?: ColumnCopyExtent;
}

/** Whether the prepared values are the whole column or only the leading values that fit the clipboard. */
interface ColumnCopyExtent {
  truncated: boolean;
  totalRows: number | null;
}

interface ColumnCopyOwner {
  column: ColumnSchema;
  ownerId: string;
  ownsResult?: () => boolean;
  preparationIdentity: string;
}

interface ActiveColumnPreparation extends ColumnCopyOwner {
  accumulator: GridClipboardColumnAccumulator;
  contextId: string;
  copyFocusOwner?: HTMLElement;
  copyRequested: boolean;
  expectedRows: number | null;
  filterModel: FilterModel;
  nextOffset: number;
  requestId?: string;
  revision: number;
  sessionId: string;
  writeSettlement?: Pick<ColumnWriteRequest, "settle" | "settled">;
}

interface ActiveColumnWrite {
  request: ColumnWriteRequest;
  promise: Promise<void>;
  timeout?: number;
}

interface ColumnWriteRequest extends ColumnCopyOwner {
  extent: ColumnCopyExtent;
  focusOwner?: HTMLElement;
  pendingTimeout?: number;
  requestId: string;
  result: Extract<GridClipboardResult, { ok: true }>;
  settle(): void;
  settled: Promise<void>;
}

export interface WholeColumnClipboardAction {
  ariaLabel: string;
  disabled: boolean;
  menuLabel: string;
  title: string;
}

export interface WholeColumnClipboardController {
  actionForColumn(column: ColumnSchema): WholeColumnClipboardAction;
  announcement: string;
  copy(columnOrOwnsResult?: ColumnSchema | (() => boolean)): Promise<boolean>;
  isColumnSelected(columnId: string): boolean;
  reset(): void;
  selectColumn(column: ColumnSchema): void;
  selectedColumnId?: string;
  selectionDescription: string;
}

const maximumColumnPageSize = 1_000;
const maximumPendingClipboardWriteMs = 10_000;
const clipboardAdapterUnavailableReason =
  "Clipboard access did not settle. Reload this data editor before copying another column.";
let columnRequestSequence = 0;

export function useWholeColumnClipboard({
  metadata,
  viewContextId
}: {
  metadata: SessionMetadata;
  viewContextId?: string;
}): WholeColumnClipboardController {
  const [state, setState] = useState<WholeColumnClipboardState>({ phase: "idle" });
  const [announcement, setAnnouncement] = useState("");
  const stateRef = useRef(state);
  const activeRef = useRef<ActiveColumnPreparation | undefined>(undefined);
  const writeRef = useRef<ActiveColumnWrite | undefined>(undefined);
  const pendingWriteRef = useRef<ColumnWriteRequest | undefined>(undefined);
  const startWriteRef = useRef<(request: ColumnWriteRequest) => void>(() => undefined);
  const writeGenerationTerminalRef = useRef(false);
  const mountedRef = useRef(true);
  const preparationIdentity = `${metadata.sessionId}:${metadata.revision}:${viewContextId ?? "unavailable"}:${metadata.schema.map((column) => column.id).join("\u0000")}`;
  const preparationIdentityRef = useRef(preparationIdentity);
  const latestPreparationIdentityRef = useRef(preparationIdentity);
  const unavailableReason =
    viewContextId === undefined || viewContextId.startsWith("inspection:")
      ? "Whole-column copy is unavailable in this data view."
      : undefined;
  const expectedRows = metadata.filteredShape.rows;
  const availabilityReason = wholeColumnAvailabilityReason(unavailableReason, expectedRows);

  const publishState = useCallback((next: WholeColumnClipboardState): void => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const cancelActive = useCallback(
    (publishIdle: boolean): void => {
      const active = activeRef.current;
      const requestId = active?.requestId;
      activeRef.current = undefined;
      active?.writeSettlement?.settle();
      const pendingWrite = pendingWriteRef.current;
      pendingWriteRef.current = undefined;
      if (pendingWrite) settleWriteRequest(pendingWrite);
      if (requestId) vscode.postMessage({ kind: "cancelViewRequests", viewRequestIds: [requestId] });
      if (publishIdle) {
        publishState({ phase: "idle" });
        setAnnouncement("");
      }
    },
    [publishState]
  );

  const fail = useCallback(
    (active: ActiveColumnPreparation, reason: string): void => {
      if (activeRef.current !== active) return;
      activeRef.current = undefined;
      active.writeSettlement?.settle();
      publishState({
        phase: "error",
        column: active.column,
        ownerId: active.ownerId,
        preparationIdentity: active.preparationIdentity,
        reason
      });
      setAnnouncement(reason);
    },
    [publishState]
  );

  const ownerIsCurrent = useCallback((owner: ColumnCopyOwner): boolean => {
    const ownsAction = (): boolean => {
      const current = stateRef.current;
      return (
        mountedRef.current &&
        latestPreparationIdentityRef.current === owner.preparationIdentity &&
        current.preparationIdentity === owner.preparationIdentity &&
        current.ownerId === owner.ownerId &&
        current.column?.id === owner.column.id &&
        current.copyRequested === true
      );
    };
    if (!ownsAction() || !(owner.ownsResult?.() ?? true)) return false;
    return ownsAction();
  }, []);

  const ownsClipboardPhase = useCallback(
    (request: ColumnWriteRequest, phase: GridClipboardWritePhase): boolean => {
      if (writeGenerationTerminalRef.current || !ownerIsCurrent(request) || !document.hasFocus()) return false;
      const focusOwner = request.focusOwner;
      if (!focusOwner) return phase.kind === "primary";
      if (!focusOwner.isConnected) return false;
      const activeElement = document.activeElement;
      if (phase.kind === "restoreFocus") return activeElement === phase.helper;
      if (phase.kind === "fallback" && phase.helper) return activeElement === phase.helper;
      return activeElement === focusOwner || (activeElement instanceof Node && focusOwner.contains(activeElement));
    },
    [ownerIsCurrent]
  );

  const clearMatchingBusyState = useCallback(
    (owner: ColumnCopyOwner): void => {
      const current = stateRef.current;
      if (
        current.copyRequested === true &&
        current.ownerId === owner.ownerId &&
        current.preparationIdentity === owner.preparationIdentity &&
        current.column?.id === owner.column.id
      ) {
        publishState({ ...current, copyRequested: false });
      }
    },
    [publishState]
  );

  const releaseWriteRequest = useCallback(
    (request: ColumnWriteRequest, reason: string, settle = true): void => {
      if (!(request.ownsResult?.() ?? true)) {
        clearMatchingBusyState(request);
        if (settle) settleWriteRequest(request);
        return;
      }
      if (stateRef.current.ownerId === request.ownerId) {
        publishState({ ...stateRef.current, copyRequested: false });
        setAnnouncement(reason);
      } else if (stateRef.current.phase === "idle") {
        setAnnouncement(reason);
      }
      if (settle) settleWriteRequest(request);
    },
    [clearMatchingBusyState, publishState]
  );

  const startWrite = useCallback(
    (request: ColumnWriteRequest): void => {
      if (!ownsClipboardPhase(request, { kind: "primary" })) {
        releaseWriteRequest(
          request,
          "The data view or focus changed before the prepared column could be copied. Select the column again."
        );
        return;
      }
      const clipboardWrite = tryAcquireGridClipboardWrite();
      if (!clipboardWrite) {
        releaseWriteRequest(request, "Wait for the current clipboard copy to finish.");
        return;
      }
      const promise = (async () => {
        try {
          await clipboardWrite.write(request.result.payload.text, (phase) => ownsClipboardPhase(request, phase));
          if (writeGenerationTerminalRef.current) return;
          if (!ownerIsCurrent(request)) {
            clearMatchingBusyState(request);
            return;
          }
          publishState({ ...stateRef.current, copyRequested: false });
          setAnnouncement(copiedColumnAnnouncement(request.column, request.result.payload.rowCount, request.extent));
        } catch (error) {
          if (writeGenerationTerminalRef.current) return;
          const ownershipChanged = error instanceof GridClipboardOwnershipChangedError;
          releaseWriteRequest(
            request,
            ownershipChanged
              ? "The data view or focus changed before the prepared column could be copied. Select the column again."
              : "Could not write to the clipboard. Check this editor's clipboard permissions."
          );
        } finally {
          clipboardWrite.release();
        }
      })();
      const activeWrite: ActiveColumnWrite = { promise, request };
      activeWrite.timeout = window.setTimeout(() => {
        if (writeRef.current?.request.requestId !== request.requestId) return;
        activeWrite.timeout = undefined;
        writeGenerationTerminalRef.current = true;
        releaseWriteRequest(request, clipboardAdapterUnavailableReason, false);
        const pending = pendingWriteRef.current;
        pendingWriteRef.current = undefined;
        if (pending) releaseWriteRequest(pending, clipboardAdapterUnavailableReason);
      }, maximumPendingClipboardWriteMs);
      writeRef.current = activeWrite;
      void promise.finally(() => {
        if (activeWrite.timeout !== undefined) window.clearTimeout(activeWrite.timeout);
        activeWrite.timeout = undefined;
        if (writeRef.current?.request.requestId === request.requestId) writeRef.current = undefined;
        settleWriteRequest(request);
        if (writeGenerationTerminalRef.current) return;
        const pending = pendingWriteRef.current;
        pendingWriteRef.current = undefined;
        if (pending) {
          if (pending.pendingTimeout !== undefined) window.clearTimeout(pending.pendingTimeout);
          pending.pendingTimeout = undefined;
          startWriteRef.current(pending);
        }
      });
    },
    [clearMatchingBusyState, ownerIsCurrent, ownsClipboardPhase, publishState, releaseWriteRequest]
  );

  useLayoutEffect(() => {
    startWriteRef.current = startWrite;
  }, [startWrite]);

  const writePreparedResult = useCallback(
    async (
      owner: ColumnCopyOwner,
      result: Extract<GridClipboardResult, { ok: true }>,
      extent: ColumnCopyExtent,
      focusOwner: HTMLElement | undefined
    ): Promise<boolean> => {
      if (!ownerIsCurrent(owner)) {
        clearMatchingBusyState(owner);
        return false;
      }
      if (writeGenerationTerminalRef.current) {
        publishState({ ...stateRef.current, copyRequested: false });
        setAnnouncement(clipboardAdapterUnavailableReason);
        return owner.ownsResult?.() ?? true;
      }
      const currentWrite = writeRef.current;
      if (currentWrite?.request.ownerId === owner.ownerId) {
        await currentWrite.promise;
        return owner.ownsResult?.() ?? true;
      }
      if (pendingWriteRef.current?.ownerId === owner.ownerId) {
        await pendingWriteRef.current.settled;
        return owner.ownsResult?.() ?? true;
      }
      const deferred = createWriteSettlement();
      const request: ColumnWriteRequest = {
        ...owner,
        extent,
        focusOwner,
        requestId: nextColumnRequestId("write-owner"),
        result,
        ...deferred
      };
      if (currentWrite) {
        const displaced = pendingWriteRef.current;
        pendingWriteRef.current = request;
        if (displaced) settleWriteRequest(displaced);
        request.pendingTimeout = window.setTimeout(() => {
          if (pendingWriteRef.current?.requestId !== request.requestId) return;
          pendingWriteRef.current = undefined;
          releaseWriteRequest(
            request,
            `Column ${owner.column.name} was not copied because the previous clipboard write did not settle. Try again.`
          );
        }, maximumPendingClipboardWriteMs);
        setAnnouncement(`Column ${owner.column.name} is ready and will copy after the current write finishes.`);
      } else {
        startWrite(request);
      }
      await request.settled;
      return owner.ownsResult?.() ?? true;
    },
    [clearMatchingBusyState, ownerIsCurrent, publishState, releaseWriteRequest, startWrite]
  );

  const finish = useCallback(
    (active: ActiveColumnPreparation, result: GridClipboardResult, truncated: boolean): void => {
      if (activeRef.current !== active) return;
      activeRef.current = undefined;
      if (!result.ok) {
        active.writeSettlement?.settle();
        publishState({
          phase: "error",
          column: active.column,
          ownerId: active.ownerId,
          preparationIdentity: active.preparationIdentity,
          reason: result.reason
        });
        setAnnouncement(result.reason);
        return;
      }
      const extent: ColumnCopyExtent = { truncated, totalRows: active.expectedRows };
      publishState({
        phase: "ready",
        column: active.column,
        ownerId: active.ownerId,
        preparationIdentity: active.preparationIdentity,
        copyRequested: active.copyRequested,
        result,
        rowCount: result.payload.rowCount,
        extent
      });
      if (active.copyRequested) {
        void writePreparedResult(active, result, extent, active.copyFocusOwner).finally(() =>
          active.writeSettlement?.settle()
        );
      }
    },
    [publishState, writePreparedResult]
  );

  const requestNext = useCallback(
    (active: ActiveColumnPreparation): void => {
      if (activeRef.current !== active) return;
      const remainingKnownRows =
        Math.min(active.expectedRows ?? maximumClipboardColumnValues, maximumClipboardColumnValues) - active.nextOffset;
      if (remainingKnownRows <= 0) {
        const truncated = active.expectedRows !== null && active.nextOffset < active.expectedRows;
        finish(active, active.accumulator.finish(), truncated);
        return;
      }
      const limit = Math.min(maximumColumnPageSize, remainingKnownRows);
      const requestId = nextColumnRequestId();
      active.requestId = requestId;
      vscode.postMessage({
        kind: "runtimeRequest",
        purpose: "clipboardColumn",
        viewContextId: active.contextId,
        request: {
          kind: "getPage",
          viewRequestId: requestId,
          offset: active.nextOffset,
          limit,
          columnOffset: active.column.position,
          columnLimit: 1,
          filterModel: active.filterModel
        }
      });
    },
    [finish]
  );

  const handleResponse = useCallback(
    (response: OpenWranglerResponse): void => {
      const active = activeRef.current;
      if (!active || !("viewRequestId" in response) || response.viewRequestId !== active.requestId) return;
      active.requestId = undefined;
      if (response.kind === "error") {
        fail(active, "Could not prepare this column for copying. Select it again to retry.");
        return;
      }
      if (response.kind === "cancelled") {
        fail(active, "Column copy preparation was cancelled. Select the column again to retry.");
        return;
      }
      if (response.kind !== "page") return;
      const page = response.page;
      const responseColumn = response.metadata.schema[active.column.position];
      if (
        response.metadata.sessionId !== active.sessionId ||
        response.revision !== active.revision ||
        responseColumn?.id !== active.column.id ||
        page.offset !== active.nextOffset ||
        page.columnIds.length !== 1 ||
        page.columnIds[0] !== active.column.id ||
        (active.expectedRows !== null && page.totalRows !== active.expectedRows) ||
        page.rows.some(
          (row, index) =>
            row.rowNumber !== active.nextOffset + index || row.values.length !== 1 || row.values[0] === undefined
        )
      ) {
        fail(active, "The data view changed while this column was being prepared. Select the column again.");
        return;
      }
      if (active.expectedRows === null && page.totalRows !== null) active.expectedRows = page.totalRows;
      for (const row of page.rows) {
        const failure = active.accumulator.append(row.values[0]);
        if (failure && !failure.ok) {
          fail(active, failure.reason);
          return;
        }
        if (active.accumulator.full) break;
      }
      active.nextOffset += page.rows.length;
      const hasMore = liveGridPageHasMore(page);
      if (active.accumulator.full || (hasMore && active.accumulator.rowCount >= maximumClipboardColumnValues)) {
        finish(active, active.accumulator.finish(), true);
        return;
      }
      if (hasMore) {
        if (page.rows.length === 0) {
          fail(active, "The data view returned an incomplete column page. Select the column again.");
          return;
        }
        requestNext(active);
        return;
      }
      if (active.expectedRows !== null && active.accumulator.rowCount !== active.expectedRows) {
        fail(active, "The data view changed while this column was being prepared. Select the column again.");
        return;
      }
      finish(active, active.accumulator.finish(), false);
    },
    [fail, finish, requestNext]
  );

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      try {
        if (event.origin !== window.location.origin) return;
        const activeRequestId = activeRef.current?.requestId;
        if (!activeRequestId) return;
        if (typeof event.data !== "object" || event.data === null || !Object.hasOwn(event.data, "viewRequestId")) {
          return;
        }
        if (
          (event.data as { viewRequestId?: unknown }).viewRequestId !== activeRequestId ||
          !isOpenWranglerResponse(event.data)
        ) {
          return;
        }
        handleResponse(event.data);
      } catch {
        reportWebviewFailure("message");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [handleResponse]);

  useLayoutEffect(() => {
    latestPreparationIdentityRef.current = preparationIdentity;
    if (preparationIdentityRef.current === preparationIdentity) return;
    preparationIdentityRef.current = preparationIdentity;
    cancelActive(true);
  }, [cancelActive, preparationIdentity]);

  useEffect(() => {
    mountedRef.current = true;
    writeGenerationTerminalRef.current = false;
    return () => {
      mountedRef.current = false;
      writeGenerationTerminalRef.current = true;
      const activeWrite = writeRef.current;
      if (activeWrite?.timeout !== undefined) window.clearTimeout(activeWrite.timeout);
      if (activeWrite) {
        activeWrite.timeout = undefined;
      }
      cancelActive(false);
    };
  }, [cancelActive]);

  const startPreparation = useCallback(
    (column: ColumnSchema, copyRequested: boolean, ownsResult?: () => boolean): ActiveColumnPreparation | undefined => {
      cancelActive(false);
      setAnnouncement("");
      if (availabilityReason || !viewContextId) {
        const reason = availabilityReason ?? "Whole-column copy is unavailable in this data view.";
        publishState({ phase: "error", column, reason });
        setAnnouncement(reason);
        return undefined;
      }
      const active: ActiveColumnPreparation = {
        accumulator: createGridClipboardColumnAccumulator(column.name),
        column,
        contextId: viewContextId,
        copyFocusOwner: copyRequested ? captureClipboardFocusOwner() : undefined,
        copyRequested,
        expectedRows,
        filterModel: metadata.filterModel,
        nextOffset: 0,
        ownerId: nextColumnRequestId("owner"),
        ownsResult,
        preparationIdentity,
        revision: metadata.revision,
        sessionId: metadata.sessionId,
        writeSettlement: copyRequested ? createWriteSettlement() : undefined
      };
      activeRef.current = active;
      publishState({
        phase: "preparing",
        column,
        copyRequested,
        ownerId: active.ownerId,
        preparationIdentity
      });
      if (copyRequested) {
        setAnnouncement(`Preparing column ${column.name}. Copy will complete when it is ready.`);
      }
      requestNext(active);
      return active;
    },
    [
      cancelActive,
      availabilityReason,
      expectedRows,
      metadata.filterModel,
      metadata.revision,
      metadata.sessionId,
      preparationIdentity,
      publishState,
      requestNext,
      viewContextId
    ]
  );

  const selectColumn = useCallback(
    (column: ColumnSchema): void => {
      const current = stateRef.current;
      if (
        current.column?.id === column.id &&
        current.preparationIdentity === preparationIdentity &&
        (current.phase === "selected" || current.phase === "preparing" || current.phase === "ready")
      ) {
        return;
      }
      if (
        !availabilityReason &&
        viewContextId &&
        (expectedRows === null || expectedRows > maximumClipboardColumnValues)
      ) {
        cancelActive(false);
        setAnnouncement("");
        publishState({ phase: "selected", column, preparationIdentity });
        return;
      }
      startPreparation(column, false);
    },
    [availabilityReason, cancelActive, expectedRows, preparationIdentity, publishState, startPreparation, viewContextId]
  );

  const copy = useCallback(
    async (columnOrOwnsResult?: ColumnSchema | (() => boolean)): Promise<boolean> => {
      const current = stateRef.current;
      const selectedColumn = current.phase === "selected" ? current.column : undefined;
      const column = typeof columnOrOwnsResult === "function" ? selectedColumn : (columnOrOwnsResult ?? selectedColumn);
      const ownsResult = typeof columnOrOwnsResult === "function" ? columnOrOwnsResult : undefined;
      const ownsExternalResult = (): boolean => ownsResult?.() ?? true;
      if (!ownsExternalResult()) return false;
      if (writeGenerationTerminalRef.current) {
        if (current.copyRequested) publishState({ ...current, copyRequested: false });
        if (ownsExternalResult()) setAnnouncement(clipboardAdapterUnavailableReason);
        return ownsExternalResult();
      }
      if (
        column &&
        (current.column?.id !== column.id ||
          current.phase === "idle" ||
          current.phase === "selected" ||
          current.phase === "error" ||
          current.preparationIdentity !== preparationIdentity)
      ) {
        const started = startPreparation(column, true, ownsResult);
        if (started?.writeSettlement) await started.writeSettlement.settled;
        return ownsExternalResult();
      }
      const active = activeRef.current;
      if (current.phase === "preparing" && active && active.column.id === current.column?.id) {
        if (!active.copyRequested) {
          active.copyRequested = true;
          active.copyFocusOwner = captureClipboardFocusOwner();
          active.ownsResult = ownsResult;
          active.writeSettlement = createWriteSettlement();
          publishState({ ...current, copyRequested: true });
        }
        if (ownsExternalResult()) {
          setAnnouncement(`Preparing column ${active.column.name}. Copy will complete when it is ready.`);
        }
        if (active.writeSettlement) await active.writeSettlement.settled;
        return ownsExternalResult();
      }
      if (current.phase === "ready" && current.result?.ok && current.column && current.ownerId && current.extent) {
        if (current.copyRequested) return ownsExternalResult();
        publishState({ ...current, copyRequested: true });
        return writePreparedResult(
          {
            column: current.column,
            ownerId: current.ownerId,
            ownsResult,
            preparationIdentity
          },
          current.result,
          current.extent,
          captureClipboardFocusOwner()
        );
      }
      if (ownsExternalResult()) {
        setAnnouncement(current.reason ?? "Select a column header before copying.");
      }
      return ownsExternalResult();
    },
    [preparationIdentity, publishState, startPreparation, writePreparedResult]
  );

  const reset = useCallback((): void => cancelActive(true), [cancelActive]);
  const isColumnSelected = useCallback(
    (columnId: string): boolean => state.column?.id === columnId,
    [state.column?.id]
  );
  const actionForColumn = useCallback(
    (column: ColumnSchema): WholeColumnClipboardAction => {
      if (availabilityReason) {
        return {
          ariaLabel: `Copy column ${column.name}`,
          disabled: true,
          menuLabel: "Copy column",
          title: availabilityReason
        };
      }
      const selected = state.column?.id === column.id;
      if (!selected || state.phase === "idle" || state.phase === "selected") {
        return expectedRows !== null && expectedRows > maximumClipboardColumnValues
          ? leadingValuesAction(column, maximumClipboardColumnValues, expectedRows)
          : {
              ariaLabel: `Copy column ${column.name}`,
              disabled: false,
              menuLabel: "Copy column",
              title: "Copy column"
            };
      }
      if (state.phase === "preparing") {
        return {
          ariaLabel: state.copyRequested ? `Copying column ${column.name}` : `Copy column ${column.name} when ready`,
          disabled: state.copyRequested === true,
          menuLabel: state.copyRequested ? "Copying when ready…" : "Copy column when ready",
          title: state.copyRequested ? "Copying column" : "Copy column when ready"
        };
      }
      if (state.phase === "ready") {
        if (state.copyRequested) {
          return {
            ariaLabel: `Copying column ${column.name}`,
            disabled: true,
            menuLabel: "Copying…",
            title: "Copying column"
          };
        }
        if (state.extent?.truncated && state.rowCount !== undefined) {
          return leadingValuesAction(column, state.rowCount, state.extent.totalRows);
        }
        return {
          ariaLabel: `Copy column ${column.name}`,
          disabled: false,
          menuLabel: "Copy column",
          title: "Copy column"
        };
      }
      return {
        ariaLabel: `Retry copy column ${column.name}`,
        disabled: false,
        menuLabel: "Retry copy column",
        title: state.reason ?? "Select the column again to retry."
      };
    },
    [availabilityReason, expectedRows, state]
  );

  return {
    actionForColumn,
    announcement,
    copy,
    isColumnSelected,
    reset,
    selectColumn,
    selectedColumnId: state.column?.id,
    selectionDescription: describeWholeColumnState(state, expectedRows)
  };
}

function wholeColumnAvailabilityReason(
  unavailableReason: string | undefined,
  expectedRows: number | null
): string | undefined {
  if (unavailableReason) return unavailableReason;
  return expectedRows === 0 ? "There are no rows in the current data view." : undefined;
}

const clipboardLimitText = "The clipboard holds up to 100,000 cells or 4 MiB";

function leadingValuesText(count: number, totalRows: number | null): string {
  return totalRows === null
    ? `the first ${count.toLocaleString()} values`
    : `the first ${count.toLocaleString()} of ${totalRows.toLocaleString()} values`;
}

function leadingValuesAction(
  column: ColumnSchema,
  count: number,
  totalRows: number | null
): WholeColumnClipboardAction {
  return {
    ariaLabel: `Copy ${leadingValuesText(count, totalRows)} of column ${column.name}`,
    disabled: false,
    menuLabel: `Copy first ${count.toLocaleString()} values`,
    title: `${clipboardLimitText}, so this copies ${leadingValuesText(count, totalRows)}. Export the data to keep every value.`
  };
}

function copiedColumnAnnouncement(column: ColumnSchema, rowCount: number, extent: ColumnCopyExtent): string {
  return extent.truncated
    ? `Copied ${leadingValuesText(rowCount, extent.totalRows)} of column ${column.name} and its header. ${clipboardLimitText}.`
    : `Copied column ${column.name} with ${rowCount.toLocaleString()} values and its header.`;
}

function describeWholeColumnState(state: WholeColumnClipboardState, expectedRows: number | null): string {
  if (!state.column) return "";
  if (state.phase === "selected") {
    return expectedRows === null
      ? `Whole filtered and sorted column ${state.column.name} selected.`
      : `Whole filtered and sorted column ${state.column.name} selected, ${expectedRows.toLocaleString()} rows.`;
  }
  if (state.phase === "preparing") {
    return `Whole filtered and sorted column ${state.column.name} selected. Preparing copy.`;
  }
  if (state.phase === "ready") {
    return state.extent?.truncated && state.rowCount !== undefined
      ? `Whole filtered and sorted column ${state.column.name} selected; ${leadingValuesText(state.rowCount, state.extent.totalRows)} fit the clipboard.`
      : `Whole filtered and sorted column ${state.column.name} selected, ${state.rowCount?.toLocaleString()} rows.`;
  }
  return `Whole filtered and sorted column ${state.column.name} selected. ${state.reason ?? "Copy is unavailable."}`;
}

function nextColumnRequestId(prefix = "clipboard-column"): string {
  columnRequestSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${columnRequestSequence.toString(36)}`;
}

function captureClipboardFocusOwner(): HTMLElement | undefined {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || activeElement === document.body) return undefined;
  return activeElement;
}

function createWriteSettlement(): Pick<ColumnWriteRequest, "settle" | "settled"> {
  let settled = false;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    settle: () => {
      if (settled) return;
      settled = true;
      resolve();
    },
    settled: promise
  };
}

function settleWriteRequest(request: ColumnWriteRequest): void {
  if (request.pendingTimeout !== undefined) window.clearTimeout(request.pendingTimeout);
  request.pendingTimeout = undefined;
  request.settle();
}
