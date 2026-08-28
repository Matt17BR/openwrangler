import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ColumnSchema, LiveGridPage, SessionMetadata } from "../../shared/protocol";
import {
  buildGridClipboardPayload,
  collapsedGridClipboardSelection,
  extendGridClipboardSelection,
  gridClipboardSelectionContains,
  gridClipboardSelectionDescription,
  tryAcquireGridClipboardWrite,
  type GridCellCoordinate,
  type GridClipboardMode,
  type GridClipboardResult,
  type GridClipboardSelection
} from "./gridClipboard";
import { useWholeColumnClipboard } from "./useWholeColumnClipboard";
import type { WholeColumnClipboardAction } from "./useWholeColumnClipboard";

export interface GridClipboardController {
  columnCopyAction(column: ColumnSchema): WholeColumnClipboardAction;
  announcement: string;
  copySettlementReceipt: GridClipboardSettlementReceipt;
  copy(mode: GridClipboardMode, ownsResult?: () => boolean): Promise<boolean>;
  copyColumn(columnOrOwnsResult?: ColumnSchema | (() => boolean)): Promise<boolean>;
  focusCell(coordinate: GridCellCoordinate): void;
  getSelectionGeneration(): number;
  isColumnSelected(columnId: string): boolean;
  isRangeSelected(coordinate: GridCellCoordinate): boolean;
  isSelected(coordinate: GridCellCoordinate): boolean;
  resetSelection(coordinate: GridCellCoordinate): void;
  results: Record<GridClipboardMode, GridClipboardResult>;
  selectCell(coordinate: GridCellCoordinate, extend: boolean): void;
  selectColumn(column: ColumnSchema): void;
  selectionDescription: string;
  wholeColumnResult: GridClipboardResult;
}

export interface GridClipboardSettlementReceipt {
  id: number;
  mode: GridClipboardMode | "none";
  status: "idle" | "pending" | "success" | "failure";
}

const wholeColumnOwnsCopyReason = "A whole column is selected. Use Copy column.";
let nextGridClipboardSettlementReceiptId = 0;

function nextGridClipboardSettlementReceipt(): number {
  if (nextGridClipboardSettlementReceiptId >= Number.MAX_SAFE_INTEGER) {
    throw new Error("The clipboard settlement receipt sequence is exhausted.");
  }
  nextGridClipboardSettlementReceiptId += 1;
  return nextGridClipboardSettlementReceiptId;
}

interface ExpectedResultRefreshReceipt {
  contextId: string;
  page: LiveGridPage;
  schema: readonly ColumnSchema[];
  selection: GridClipboardSelection;
  wholeColumnSelectedColumnId: undefined;
}

export function useGridClipboard({
  contextId,
  metadata,
  pageSize,
  schema,
  page,
  initialCoordinate,
  onSelectionWillChange,
  viewContextId
}: {
  contextId: string;
  metadata: SessionMetadata;
  pageSize: number;
  schema: readonly ColumnSchema[];
  page: LiveGridPage;
  initialCoordinate: GridCellCoordinate;
  onSelectionWillChange?: () => void;
  viewContextId?: string;
}): GridClipboardController {
  const [selection, setSelection] = useState(() => collapsedGridClipboardSelection(contextId, initialCoordinate));
  const [announcement, setAnnouncement] = useState("");
  const [copySettlementReceipt, setCopySettlementReceipt] = useState<GridClipboardSettlementReceipt>({
    id: 0,
    mode: "none",
    status: "idle"
  });
  const contextIdRef = useRef(contextId);
  const expectedResultRefreshRef = useRef<ExpectedResultRefreshReceipt | undefined>(undefined);
  const copyActionGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const invalidateSelectionOwner = useCallback(
    (expectedResultRefresh?: ExpectedResultRefreshReceipt): void => {
      onSelectionWillChange?.();
      selectionGenerationRef.current += 1;
      copyActionGenerationRef.current += 1;
      expectedResultRefreshRef.current = expectedResultRefresh;
      setAnnouncement("");
      setCopySettlementReceipt((current) =>
        current.status === "idle" ? current : { id: current.id, mode: "none", status: "idle" }
      );
    },
    [onSelectionWillChange]
  );
  const wholeColumn = useWholeColumnClipboard({ metadata, pageSize, viewContextId });
  const resetWholeColumn = wholeColumn.reset;
  const selectWholeColumn = wholeColumn.selectColumn;
  useLayoutEffect(() => {
    if (contextIdRef.current !== contextId) invalidateSelectionOwner();
    contextIdRef.current = contextId;
  }, [contextId, invalidateSelectionOwner]);
  const rectangleResults = useMemo(
    () => ({
      cell: buildGridClipboardPayload({ mode: "cell", selection, contextId, schema, page }),
      row: buildGridClipboardPayload({ mode: "row", selection, contextId, schema, page }),
      range: buildGridClipboardPayload({ mode: "range", selection, contextId, schema, page })
    }),
    [contextId, page, schema, selection]
  );
  const results = useMemo<Record<GridClipboardMode, GridClipboardResult>>(() => {
    if (!wholeColumn.selectedColumnId) return rectangleResults;
    return {
      cell: { ok: false, reason: wholeColumnOwnsCopyReason },
      row: { ok: false, reason: wholeColumnOwnsCopyReason },
      range: { ok: false, reason: wholeColumnOwnsCopyReason }
    };
  }, [rectangleResults, wholeColumn.selectedColumnId]);
  const resultsRef = useRef(results);
  useLayoutEffect(() => {
    if (resultsRef.current !== results) {
      const receipt = expectedResultRefreshRef.current;
      expectedResultRefreshRef.current = undefined;
      const expectedRefresh =
        receipt !== undefined &&
        receipt.contextId === contextId &&
        receipt.page === page &&
        receipt.schema === schema &&
        receipt.selection === selection &&
        receipt.wholeColumnSelectedColumnId === wholeColumn.selectedColumnId;
      if (!expectedRefresh) invalidateSelectionOwner();
    }
    resultsRef.current = results;
  }, [contextId, invalidateSelectionOwner, page, results, schema, selection, wholeColumn.selectedColumnId]);
  const resetSelection = useCallback(
    (coordinate: GridCellCoordinate): void => {
      const nextSelection = collapsedGridClipboardSelection(contextIdRef.current, coordinate);
      invalidateSelectionOwner({
        contextId: contextIdRef.current,
        page,
        schema,
        selection: nextSelection,
        wholeColumnSelectedColumnId: undefined
      });
      resetWholeColumn();
      setSelection(nextSelection);
      setAnnouncement("");
    },
    [invalidateSelectionOwner, page, resetWholeColumn, schema]
  );
  const selectCell = useCallback(
    (coordinate: GridCellCoordinate, extend: boolean): void => {
      invalidateSelectionOwner();
      resetWholeColumn();
      setSelection((current) =>
        extend
          ? extendGridClipboardSelection(current, contextId, coordinate)
          : collapsedGridClipboardSelection(contextId, coordinate)
      );
      setAnnouncement("");
    },
    [contextId, invalidateSelectionOwner, resetWholeColumn]
  );
  const focusCell = useCallback(
    (coordinate: GridCellCoordinate): void => {
      if (
        !wholeColumn.selectedColumnId &&
        selection.contextId === contextId &&
        selection.focus.row === coordinate.row &&
        selection.focus.column === coordinate.column
      ) {
        return;
      }
      invalidateSelectionOwner();
      resetWholeColumn();
      setSelection((current) =>
        current.contextId === contextId &&
        current.focus.row === coordinate.row &&
        current.focus.column === coordinate.column
          ? current
          : collapsedGridClipboardSelection(contextId, coordinate)
      );
      setAnnouncement("");
    },
    [contextId, invalidateSelectionOwner, resetWholeColumn, selection, wholeColumn.selectedColumnId]
  );
  const copy = useCallback(
    async (mode: GridClipboardMode, additionalOwnership?: () => boolean): Promise<boolean> => {
      const clipboardWrite = tryAcquireGridClipboardWrite();
      if (!clipboardWrite) {
        if (mountedRef.current) setAnnouncement("Wait for the current clipboard copy to finish.");
        return false;
      }
      try {
        const result = results[mode];
        const actionGeneration = ++copyActionGenerationRef.current;
        const actionContextId = contextIdRef.current;
        const ownsAction = (): boolean =>
          mountedRef.current &&
          copyActionGenerationRef.current === actionGeneration &&
          contextIdRef.current === actionContextId &&
          resultsRef.current[mode] === result;
        const ownsResult = (): boolean => {
          if (!ownsAction() || !(additionalOwnership?.() ?? true)) return false;
          return ownsAction();
        };
        if (!result.ok) {
          if (ownsResult()) {
            setCopySettlementReceipt((current) => ({ id: current.id, mode: "none", status: "idle" }));
            setAnnouncement(result.reason);
          }
          return ownsResult();
        }
        if (!ownsResult()) return false;
        const settlementReceiptId = nextGridClipboardSettlementReceipt();
        flushSync(() => {
          setCopySettlementReceipt({ id: settlementReceiptId, mode, status: "pending" });
          setAnnouncement(
            mode === "cell" ? "Copying cell." : mode === "row" ? "Copying row." : "Copying selected cells."
          );
        });
        const clearSettlementReceipt = (): void => {
          if (copyActionGenerationRef.current === actionGeneration) setAnnouncement("");
          setCopySettlementReceipt((current) =>
            current.id === settlementReceiptId ? { id: current.id, mode: "none", status: "idle" } : current
          );
        };
        if (!ownsResult()) {
          clearSettlementReceipt();
          return false;
        }
        try {
          await clipboardWrite.write(result.payload.text, ownsResult);
          if (!ownsResult()) {
            clearSettlementReceipt();
            return false;
          }
          setCopySettlementReceipt({ id: settlementReceiptId, mode, status: "success" });
          setAnnouncement(
            mode === "cell"
              ? "Copied cell."
              : mode === "row"
                ? `Copied ${result.payload.completeRow ? "row" : "loaded row columns"}${result.payload.includesRowLabel ? " with its row label" : ""}.`
                : `Copied ${result.payload.rowCount.toLocaleString()} by ${result.payload.columnCount.toLocaleString()} cell range.`
          );
          return true;
        } catch {
          if (ownsResult()) {
            setCopySettlementReceipt({ id: settlementReceiptId, mode, status: "failure" });
            setAnnouncement("Could not write to the clipboard. Check this editor's clipboard permissions.");
            return true;
          }
          clearSettlementReceipt();
          return false;
        }
      } finally {
        clipboardWrite.release();
      }
    },
    [results]
  );
  const selectColumn = useCallback(
    (column: ColumnSchema): void => {
      invalidateSelectionOwner();
      setAnnouncement("");
      selectWholeColumn(column);
    },
    [invalidateSelectionOwner, selectWholeColumn]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyActionGenerationRef.current += 1;
    };
  }, []);

  return {
    columnCopyAction: wholeColumn.actionForColumn,
    announcement: wholeColumn.selectedColumnId ? wholeColumn.announcement : announcement,
    copy,
    copyColumn: wholeColumn.copy,
    copySettlementReceipt,
    focusCell,
    getSelectionGeneration: () => selectionGenerationRef.current,
    isColumnSelected: wholeColumn.isColumnSelected,
    isRangeSelected: (coordinate) =>
      !wholeColumn.selectedColumnId &&
      (selection.anchor.row !== selection.focus.row || selection.anchor.column !== selection.focus.column) &&
      gridClipboardSelectionContains(selection, contextId, coordinate),
    isSelected: (coordinate) =>
      wholeColumn.selectedColumnId
        ? wholeColumn.isColumnSelected(schema[coordinate.column]?.id ?? "")
        : gridClipboardSelectionContains(selection, contextId, coordinate),
    resetSelection,
    results,
    selectCell,
    selectColumn,
    selectionDescription:
      wholeColumn.selectionDescription ||
      (schema.length === 0 || page.rows.length === 0
        ? "No cells selected"
        : gridClipboardSelectionDescription(selection, contextId)),
    wholeColumnResult: wholeColumn.result
  };
}

export function GridClipboardControls({ controller }: { controller: GridClipboardController }) {
  return (
    <div className="gridClipboardControls" role="group" aria-label="Copy grid selection">
      <span
        className="gridClipboardSelectionStatus"
        role="status"
        aria-label="Grid selection"
        aria-live="polite"
        aria-atomic="true"
      >
        {controller.selectionDescription}
      </span>
      {(["cell", "row", "range"] as const).map((mode) => {
        const result = controller.results[mode];
        const label = mode === "cell" ? "Copy cell" : mode === "row" ? "Copy row" : "Copy range";
        const title = result.ok && mode === "row" && !result.payload.completeRow ? "Copy loaded row columns" : label;
        return (
          <button
            key={mode}
            type="button"
            className="gridClipboardButton"
            aria-label={label}
            disabled={!result.ok}
            title={result.ok ? title : result.reason}
            onClick={() => void controller.copy(mode)}
          >
            <span className="codicon codicon-copy" aria-hidden="true" />
            <span className="gridClipboardButtonLabel">{label}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="gridClipboardButton"
        aria-label="Copy column"
        disabled={!controller.wholeColumnResult.ok}
        title={controller.wholeColumnResult.ok ? "Copy column" : controller.wholeColumnResult.reason}
        onClick={() => void controller.copyColumn()}
      >
        <span className="codicon codicon-copy" aria-hidden="true" />
        <span className="gridClipboardButtonLabel">Copy column</span>
      </button>
      <span
        className="gridClipboardAnnouncement"
        role="status"
        aria-label="Clipboard copy result"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={controller.copySettlementReceipt.status === "pending"}
        data-grid-clipboard-settlement-receipt="true"
        data-grid-clipboard-settlement-id={controller.copySettlementReceipt.id}
        data-grid-clipboard-settlement-mode={controller.copySettlementReceipt.mode}
        data-grid-clipboard-settlement-status={controller.copySettlementReceipt.status}
      >
        {controller.announcement}
      </span>
    </div>
  );
}
