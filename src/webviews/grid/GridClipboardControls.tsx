import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ColumnSchema, LiveGridPage } from "../../shared/protocol";
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

export interface GridClipboardController {
  announcement: string;
  copy(mode: GridClipboardMode): Promise<void>;
  focusCell(coordinate: GridCellCoordinate): void;
  isSelected(coordinate: GridCellCoordinate): boolean;
  resetSelection(coordinate: GridCellCoordinate): void;
  results: Record<GridClipboardMode, GridClipboardResult>;
  selectCell(coordinate: GridCellCoordinate, extend: boolean): void;
  selectionDescription: string;
}

export function useGridClipboard({
  contextId,
  schema,
  page,
  initialCoordinate
}: {
  contextId: string;
  schema: readonly ColumnSchema[];
  page: LiveGridPage;
  initialCoordinate: GridCellCoordinate;
}): GridClipboardController {
  const [selection, setSelection] = useState(() => collapsedGridClipboardSelection(contextId, initialCoordinate));
  const [announcement, setAnnouncement] = useState("");
  const contextIdRef = useRef(contextId);
  useLayoutEffect(() => {
    contextIdRef.current = contextId;
  }, [contextId]);
  const results = useMemo(
    () => ({
      cell: buildGridClipboardPayload({ mode: "cell", selection, contextId, schema, page }),
      row: buildGridClipboardPayload({ mode: "row", selection, contextId, schema, page }),
      range: buildGridClipboardPayload({ mode: "range", selection, contextId, schema, page })
    }),
    [contextId, page, schema, selection]
  );
  const resetSelection = useCallback((coordinate: GridCellCoordinate): void => {
    setSelection(collapsedGridClipboardSelection(contextIdRef.current, coordinate));
    setAnnouncement("");
  }, []);
  const selectCell = useCallback(
    (coordinate: GridCellCoordinate, extend: boolean): void => {
      setSelection((current) =>
        extend
          ? extendGridClipboardSelection(current, contextId, coordinate)
          : collapsedGridClipboardSelection(contextId, coordinate)
      );
      setAnnouncement("");
    },
    [contextId]
  );
  const focusCell = useCallback(
    (coordinate: GridCellCoordinate): void => {
      setSelection((current) =>
        current.contextId === contextId &&
        current.focus.row === coordinate.row &&
        current.focus.column === coordinate.column
          ? current
          : collapsedGridClipboardSelection(contextId, coordinate)
      );
      setAnnouncement("");
    },
    [contextId]
  );
  const copy = useCallback(
    async (mode: GridClipboardMode): Promise<void> => {
      const result = results[mode];
      if (!result.ok) {
        setAnnouncement(result.reason);
        return;
      }
      try {
        await writeGridClipboardText(result.payload.text);
        setAnnouncement(
          mode === "cell"
            ? "Copied cell."
            : mode === "row"
              ? `Copied ${result.payload.completeRow ? "row" : "loaded row columns"}${result.payload.includesRowLabel ? " with its row label" : ""}.`
              : `Copied ${result.payload.rowCount.toLocaleString()} by ${result.payload.columnCount.toLocaleString()} cell range.`
        );
      } catch {
        setAnnouncement("Could not write to the clipboard. Check this editor's clipboard permissions.");
      }
    },
    [results]
  );

  return {
    announcement,
    copy,
    focusCell,
    isSelected: (coordinate) => gridClipboardSelectionContains(selection, contextId, coordinate),
    resetSelection,
    results,
    selectCell,
    selectionDescription:
      schema.length === 0 || page.rows.length === 0
        ? "No cells selected"
        : gridClipboardSelectionDescription(selection, contextId)
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
