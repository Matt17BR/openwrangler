import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ColumnSchema, LiveGridPage, SessionMetadata } from "../../shared/protocol";
import {
  buildGridClipboardPayload,
  collapsedGridClipboardSelection,
  extendGridClipboardSelection,
  gridClipboardSelectionContains,
  gridClipboardSelectionDescription,
  type GridCellCoordinate,
  type GridClipboardMode,
  type GridClipboardResult,
  writeGridClipboardText
} from "./gridClipboard";
import { useWholeColumnClipboard } from "./useWholeColumnClipboard";

export interface GridClipboardController {
  announcement: string;
  copy(mode: GridClipboardMode, ownsResult?: () => boolean): Promise<void>;
  copyColumn(ownsResult?: () => boolean): Promise<void>;
  focusCell(coordinate: GridCellCoordinate): void;
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

const wholeColumnOwnsCopyReason = "A whole column is selected. Use Copy column.";

export function useGridClipboard({
  contextId,
  metadata,
  pageSize,
  schema,
  page,
  initialCoordinate,
  viewContextId
}: {
  contextId: string;
  metadata: SessionMetadata;
  pageSize: number;
  schema: readonly ColumnSchema[];
  page: LiveGridPage;
  initialCoordinate: GridCellCoordinate;
  viewContextId?: string;
}): GridClipboardController {
  const [selection, setSelection] = useState(() => collapsedGridClipboardSelection(contextId, initialCoordinate));
  const [announcement, setAnnouncement] = useState("");
  const contextIdRef = useRef(contextId);
  const wholeColumn = useWholeColumnClipboard({ metadata, pageSize, viewContextId });
  const resetWholeColumn = wholeColumn.reset;
  useLayoutEffect(() => {
    contextIdRef.current = contextId;
  }, [contextId]);
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
  const resetSelection = useCallback(
    (coordinate: GridCellCoordinate): void => {
      resetWholeColumn();
      setSelection(collapsedGridClipboardSelection(contextIdRef.current, coordinate));
      setAnnouncement("");
    },
    [resetWholeColumn]
  );
  const selectCell = useCallback(
    (coordinate: GridCellCoordinate, extend: boolean): void => {
      resetWholeColumn();
      setSelection((current) =>
        extend
          ? extendGridClipboardSelection(current, contextId, coordinate)
          : collapsedGridClipboardSelection(contextId, coordinate)
      );
      setAnnouncement("");
    },
    [contextId, resetWholeColumn]
  );
  const focusCell = useCallback(
    (coordinate: GridCellCoordinate): void => {
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
    [contextId, resetWholeColumn]
  );
  const copy = useCallback(
    async (mode: GridClipboardMode, ownsResult: () => boolean = () => true): Promise<void> => {
      const result = results[mode];
      if (!result.ok) {
        if (ownsResult()) setAnnouncement(result.reason);
        return;
      }
      try {
        await writeGridClipboardText(result.payload.text, ownsResult);
        if (!ownsResult()) return;
        setAnnouncement(
          mode === "cell"
            ? "Copied cell."
            : mode === "row"
              ? `Copied ${result.payload.completeRow ? "row" : "loaded row columns"}${result.payload.includesRowLabel ? " with its row label" : ""}.`
              : `Copied ${result.payload.rowCount.toLocaleString()} by ${result.payload.columnCount.toLocaleString()} cell range.`
        );
      } catch {
        if (ownsResult()) {
          setAnnouncement("Could not write to the clipboard. Check this editor's clipboard permissions.");
        }
      }
    },
    [results]
  );

  return {
    announcement: wholeColumn.selectedColumnId ? wholeColumn.announcement : announcement,
    copy,
    copyColumn: wholeColumn.copy,
    focusCell,
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
    selectColumn: wholeColumn.selectColumn,
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
        title={
          controller.wholeColumnResult.ok
            ? "Copy whole filtered and sorted column"
            : controller.wholeColumnResult.reason
        }
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
      >
        {controller.announcement}
      </span>
    </div>
  );
}
