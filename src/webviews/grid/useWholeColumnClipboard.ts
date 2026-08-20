import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ColumnSchema, FilterModel, OpenWranglerResponse, SessionMetadata } from "../../shared/protocol";
import { liveGridPageHasMore } from "../../shared/protocol";
import { isOpenWranglerResponse } from "../../shared/protocolValidation";
import { reportWebviewFailure } from "../WebviewErrorBoundary";
import { vscode } from "../vscodeApi";
import {
  clipboardCellLimitError,
  createGridClipboardColumnAccumulator,
  maximumClipboardCells,
  type GridClipboardColumnAccumulator,
  type GridClipboardResult,
  writeGridClipboardText
} from "./gridClipboard";

type WholeColumnClipboardPhase = "idle" | "preparing" | "ready" | "error";

interface WholeColumnClipboardState {
  phase: WholeColumnClipboardPhase;
  column?: ColumnSchema;
  result?: GridClipboardResult;
  reason?: string;
  rowCount?: number;
}

interface ActiveColumnPreparation {
  accumulator: GridClipboardColumnAccumulator;
  column: ColumnSchema;
  contextId: string;
  expectedRows: number | null;
  filterModel: FilterModel;
  nextOffset: number;
  requestId?: string;
  revision: number;
  sessionId: string;
}

export interface WholeColumnClipboardController {
  announcement: string;
  copy(ownsResult?: () => boolean): Promise<boolean>;
  isColumnSelected(columnId: string): boolean;
  reset(): void;
  result: GridClipboardResult;
  selectColumn(column: ColumnSchema): void;
  selectedColumnId?: string;
  selectionDescription: string;
}

const maximumColumnPageSize = 1_000;
let columnRequestSequence = 0;

export function useWholeColumnClipboard({
  metadata,
  pageSize,
  viewContextId
}: {
  metadata: SessionMetadata;
  pageSize: number;
  viewContextId?: string;
}): WholeColumnClipboardController {
  const [state, setState] = useState<WholeColumnClipboardState>({ phase: "idle" });
  const [announcement, setAnnouncement] = useState("");
  const stateRef = useRef(state);
  const activeRef = useRef<ActiveColumnPreparation | undefined>(undefined);
  const copyActionGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const preparationIdentity = `${metadata.sessionId}:${metadata.revision}:${viewContextId ?? "unavailable"}:${metadata.schema.map((column) => column.id).join("\u0000")}`;
  const preparationIdentityRef = useRef(preparationIdentity);
  const unavailableReason =
    viewContextId === undefined || viewContextId.startsWith("inspection:")
      ? "Whole-column copy is unavailable in this data view."
      : undefined;

  const publishState = useCallback((next: WholeColumnClipboardState): void => {
    copyActionGenerationRef.current += 1;
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const cancelActive = useCallback(
    (publishIdle: boolean): void => {
      const requestId = activeRef.current?.requestId;
      activeRef.current = undefined;
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
      publishState({ phase: "error", column: active.column, reason });
      setAnnouncement(reason);
    },
    [publishState]
  );

  const requestNext = useCallback(
    (active: ActiveColumnPreparation): void => {
      if (activeRef.current !== active) return;
      const remainingKnownRows =
        active.expectedRows === null
          ? maximumClipboardCells - active.nextOffset
          : active.expectedRows - active.nextOffset;
      if (remainingKnownRows <= 0) {
        const result = active.accumulator.finish();
        activeRef.current = undefined;
        publishState(
          result.ok
            ? { phase: "ready", column: active.column, result, rowCount: result.payload.rowCount }
            : { phase: "error", column: active.column, reason: result.reason }
        );
        if (!result.ok) setAnnouncement(result.reason);
        return;
      }
      const limit = Math.min(Math.max(1, pageSize), maximumColumnPageSize, remainingKnownRows);
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
    [pageSize, publishState]
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
      }
      active.nextOffset += page.rows.length;
      if (liveGridPageHasMore(page)) {
        if (page.rows.length === 0) {
          fail(active, "The data view returned an incomplete column page. Select the column again.");
          return;
        }
        if (active.accumulator.rowCount >= maximumClipboardCells) {
          const limit = clipboardCellLimitError();
          fail(active, limit.ok ? "" : limit.reason);
          return;
        }
        requestNext(active);
        return;
      }
      if (active.expectedRows !== null && active.accumulator.rowCount !== active.expectedRows) {
        fail(active, "The data view changed while this column was being prepared. Select the column again.");
        return;
      }
      const result = active.accumulator.finish();
      activeRef.current = undefined;
      publishState(
        result.ok
          ? { phase: "ready", column: active.column, result, rowCount: result.payload.rowCount }
          : { phase: "error", column: active.column, reason: result.reason }
      );
      if (!result.ok) setAnnouncement(result.reason);
    },
    [fail, publishState, requestNext]
  );

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      try {
        if (event.origin !== window.location.origin || !isOpenWranglerResponse(event.data)) return;
        handleResponse(event.data);
      } catch {
        reportWebviewFailure("message");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [handleResponse]);

  useLayoutEffect(() => {
    if (preparationIdentityRef.current === preparationIdentity) return;
    preparationIdentityRef.current = preparationIdentity;
    cancelActive(true);
  }, [cancelActive, preparationIdentity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyActionGenerationRef.current += 1;
      cancelActive(false);
    };
  }, [cancelActive]);

  const selectColumn = useCallback(
    (column: ColumnSchema): void => {
      cancelActive(false);
      setAnnouncement("");
      if (unavailableReason || !viewContextId) {
        const reason = unavailableReason ?? "Whole-column copy is unavailable in this data view.";
        publishState({ phase: "error", column, reason });
        setAnnouncement(reason);
        return;
      }
      const expectedRows = metadata.filteredShape.rows;
      if (expectedRows !== null && expectedRows > maximumClipboardCells) {
        const result = clipboardCellLimitError();
        const reason = result.ok ? "" : result.reason;
        publishState({ phase: "error", column, reason });
        setAnnouncement(reason);
        return;
      }
      if (expectedRows === 0) {
        const reason = "There are no rows in the current data view.";
        publishState({ phase: "error", column, reason });
        setAnnouncement(reason);
        return;
      }
      const active: ActiveColumnPreparation = {
        accumulator: createGridClipboardColumnAccumulator(),
        column,
        contextId: viewContextId,
        expectedRows,
        filterModel: metadata.filterModel,
        nextOffset: 0,
        revision: metadata.revision,
        sessionId: metadata.sessionId
      };
      activeRef.current = active;
      publishState({ phase: "preparing", column });
      requestNext(active);
    },
    [
      cancelActive,
      metadata.filteredShape.rows,
      metadata.filterModel,
      metadata.revision,
      metadata.sessionId,
      publishState,
      requestNext,
      unavailableReason,
      viewContextId
    ]
  );

  const copy = useCallback(async (additionalOwnership?: () => boolean): Promise<boolean> => {
    const current = stateRef.current;
    const actionGeneration = ++copyActionGenerationRef.current;
    const actionIdentity = preparationIdentityRef.current;
    const ownsAction = (): boolean =>
      mountedRef.current &&
      copyActionGenerationRef.current === actionGeneration &&
      preparationIdentityRef.current === actionIdentity &&
      stateRef.current === current;
    const ownsResult = (): boolean => {
      if (!ownsAction() || !(additionalOwnership?.() ?? true)) return false;
      return ownsAction();
    };
    if (current.phase !== "ready" || !current.result?.ok || !current.column) {
      if (ownsResult()) setAnnouncement(current.reason ?? "Wait for the selected column to finish preparing.");
      return ownsResult();
    }
    try {
      await writeGridClipboardText(current.result.payload.text, ownsResult);
      if (!ownsResult()) return false;
      setAnnouncement(
        `Copied ${current.result.payload.rowCount.toLocaleString()} cells from column ${current.column.name}.`
      );
      return true;
    } catch {
      if (ownsResult()) {
        setAnnouncement("Could not write to the clipboard. Check this editor's clipboard permissions.");
        return true;
      }
      return false;
    }
  }, []);

  const result = useMemo<GridClipboardResult>(() => {
    if (state.phase === "ready" && state.result) return state.result;
    if (state.phase === "error") return { ok: false, reason: state.reason ?? "Column copy is unavailable." };
    if (state.phase === "preparing") return { ok: false, reason: "Preparing the whole column for copying." };
    return { ok: false, reason: "Select a column header to copy the whole filtered and sorted column." };
  }, [state]);
  const reset = useCallback((): void => cancelActive(true), [cancelActive]);
  const isColumnSelected = useCallback(
    (columnId: string): boolean => state.column?.id === columnId,
    [state.column?.id]
  );

  return {
    announcement,
    copy,
    isColumnSelected,
    reset,
    result,
    selectColumn,
    selectedColumnId: state.column?.id,
    selectionDescription: describeWholeColumnState(state)
  };
}

function describeWholeColumnState(state: WholeColumnClipboardState): string {
  if (!state.column) return "";
  if (state.phase === "preparing") {
    return `Whole filtered and sorted column ${state.column.name} selected. Preparing copy.`;
  }
  if (state.phase === "ready") {
    return `Whole filtered and sorted column ${state.column.name} selected, ${state.rowCount?.toLocaleString()} rows.`;
  }
  return `Whole filtered and sorted column ${state.column.name} selected. ${state.reason ?? "Copy is unavailable."}`;
}

function nextColumnRequestId(): string {
  columnRequestSequence += 1;
  return `clipboard-column-${Date.now().toString(36)}-${columnRequestSequence.toString(36)}`;
}
