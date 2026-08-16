import type { ColumnSchema, LiveGridPage } from "../../shared/protocol";

export interface GridCellCoordinate {
  row: number;
  column: number;
}

export interface GridClipboardSelection {
  contextId: string;
  anchor: GridCellCoordinate;
  focus: GridCellCoordinate;
}

export type GridClipboardMode = "cell" | "row" | "range";

export interface GridClipboardPayload {
  text: string;
  rowCount: number;
  columnCount: number;
  includesRowLabel: boolean;
  completeRow: boolean;
}

export type GridClipboardResult = { ok: true; payload: GridClipboardPayload } | { ok: false; reason: string };

const maximumClipboardCells = 100_000;
const maximumClipboardBytes = 4 * 1024 * 1024;

export function collapsedGridClipboardSelection(
  contextId: string,
  coordinate: GridCellCoordinate
): GridClipboardSelection {
  return { contextId, anchor: coordinate, focus: coordinate };
}

export function extendGridClipboardSelection(
  selection: GridClipboardSelection,
  contextId: string,
  coordinate: GridCellCoordinate
): GridClipboardSelection {
  return selection.contextId === contextId
    ? { ...selection, focus: coordinate }
    : collapsedGridClipboardSelection(contextId, coordinate);
}

export function gridClipboardSelectionBounds(selection: GridClipboardSelection): {
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
} {
  return {
    firstRow: Math.min(selection.anchor.row, selection.focus.row),
    lastRow: Math.max(selection.anchor.row, selection.focus.row),
    firstColumn: Math.min(selection.anchor.column, selection.focus.column),
    lastColumn: Math.max(selection.anchor.column, selection.focus.column)
  };
}

export function gridClipboardSelectionContains(
  selection: GridClipboardSelection,
  contextId: string,
  coordinate: GridCellCoordinate
): boolean {
  if (selection.contextId !== contextId) return false;
  const bounds = gridClipboardSelectionBounds(selection);
  return (
    coordinate.row >= bounds.firstRow &&
    coordinate.row <= bounds.lastRow &&
    coordinate.column >= bounds.firstColumn &&
    coordinate.column <= bounds.lastColumn
  );
}

export function gridClipboardSelectionDescription(selection: GridClipboardSelection, contextId: string): string {
  if (selection.contextId !== contextId) return "No cells selected";
  const bounds = gridClipboardSelectionBounds(selection);
  const rows = bounds.lastRow - bounds.firstRow + 1;
  const columns = bounds.lastColumn - bounds.firstColumn + 1;
  return rows === 1 && columns === 1
    ? `1 cell selected, row ${bounds.firstRow + 1}, column ${bounds.firstColumn + 1}`
    : `${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"} by ${columns.toLocaleString()} ${columns === 1 ? "column" : "columns"} selected`;
}

export function buildGridClipboardPayload({
  mode,
  selection,
  contextId,
  schema,
  page
}: {
  mode: GridClipboardMode;
  selection: GridClipboardSelection;
  contextId: string;
  schema: readonly ColumnSchema[];
  page: LiveGridPage;
}): GridClipboardResult {
  if (selection.contextId !== contextId) {
    return { ok: false, reason: "Select a cell in the current data view before copying." };
  }
  if (schema.length === 0 || page.rows.length === 0) {
    return { ok: false, reason: "There are no loaded cells to copy." };
  }

  const selectedBounds = gridClipboardSelectionBounds(selection);
  const bounds =
    mode === "cell"
      ? {
          firstRow: selection.focus.row,
          lastRow: selection.focus.row,
          firstColumn: selection.focus.column,
          lastColumn: selection.focus.column
        }
      : mode === "row"
        ? {
            firstRow: selection.focus.row,
            lastRow: selection.focus.row,
            firstColumn: selection.focus.column,
            lastColumn: selection.focus.column
          }
        : selectedBounds;
  if (
    bounds.firstRow < 0 ||
    bounds.lastRow < bounds.firstRow ||
    bounds.firstColumn < 0 ||
    bounds.lastColumn >= schema.length
  ) {
    return { ok: false, reason: "The selection is outside the current data view." };
  }

  const rowCount = bounds.lastRow - bounds.firstRow + 1;
  const schemaColumnIds = new Set(schema.map((column) => column.id));
  if (mode === "row" && page.columnIds.some((columnId) => !schemaColumnIds.has(columnId))) {
    return { ok: false, reason: "The loaded row does not match the current data view." };
  }
  const loadedColumnIds = new Set(page.columnIds);
  const columnIds =
    mode === "row"
      ? schema.filter((column) => loadedColumnIds.has(column.id)).map((column) => column.id)
      : schema.slice(bounds.firstColumn, bounds.lastColumn + 1).map((column) => column.id);
  const columnCount = columnIds.length;
  if (columnCount === 0) return { ok: false, reason: "There are no loaded cells to copy." };
  if (rowCount * columnCount > maximumClipboardCells) {
    return {
      ok: false,
      reason: `Copy is limited to ${maximumClipboardCells.toLocaleString()} cells. Select a smaller range.`
    };
  }

  const rowsByNumber = new Map(page.rows.map((row) => [row.rowNumber, row]));
  const pageColumnById = new Map(page.columnIds.map((columnId, index) => [columnId, index]));
  const columnPositions: number[] = [];
  for (const columnId of columnIds) {
    const pageColumn = pageColumnById.get(columnId);
    if (pageColumn === undefined) {
      return { ok: false, reason: "Wait for every selected column to load before copying." };
    }
    columnPositions.push(pageColumn);
  }

  const outputRows: string[] = [];
  let outputBytes = 0;
  let includesRowLabel = false;
  for (let rowNumber = bounds.firstRow; rowNumber <= bounds.lastRow; rowNumber += 1) {
    const row = rowsByNumber.get(rowNumber);
    if (!row) return { ok: false, reason: "Wait for every selected row to load before copying." };
    const fields: string[] = [];
    for (const column of columnPositions) {
      const cell = row.values[column];
      if (!cell) return { ok: false, reason: "Wait for every selected cell to load before copying." };
      fields.push(clipboardField(cell.display));
    }
    if (mode === "row" && row.rowLabel !== undefined) {
      fields.unshift(clipboardField(row.rowLabel));
      includesRowLabel = true;
    }
    const outputRow = fields.join("\t");
    outputBytes += new TextEncoder().encode(outputRow).byteLength + (outputRows.length === 0 ? 0 : 1);
    if (outputBytes > maximumClipboardBytes) {
      return { ok: false, reason: "Copy is limited to 4 MiB of displayed text. Select a smaller range." };
    }
    outputRows.push(outputRow);
  }

  return {
    ok: true,
    payload: {
      text: outputRows.join("\n"),
      rowCount,
      columnCount,
      includesRowLabel,
      completeRow:
        mode !== "row" || (columnCount === schema.length && schema.every((column) => loadedColumnIds.has(column.id)))
    }
  };
}

export async function writeGridClipboardText(text: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // VS Code-like hosts differ in Clipboard API permission handling. Keep the
    // user-gesture-scoped DOM copy path as a compatibility fallback.
  }

  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    throw new Error("Clipboard access is unavailable in this editor.");
  }
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.setAttribute("aria-hidden", "true");
  input.style.position = "fixed";
  input.style.inset = "0 auto auto -10000px";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard access is unavailable in this editor.");
  } finally {
    input.remove();
    activeElement?.focus({ preventScroll: true });
  }
}

function clipboardField(value: string): string {
  if (!/["\t\r\n]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
