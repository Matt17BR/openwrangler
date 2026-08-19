import type { FilterModel } from "./filterModel";

export interface GridViewportState {
  firstVisibleRow: number;
  scrollLeft: number;
}

/** Host-owned, non-destructive grid presentation state. */
export interface GridViewState {
  columnWidths: ReadonlyMap<string, number>;
  selectedColumnId?: string;
  viewport: GridViewportState;
}

/** JSON-safe representation used only across renderer and persistence boundaries. */
export interface SerializedGridViewState {
  columnWidths: Array<[string, number]>;
  selectedColumnId?: string;
  viewport: GridViewportState;
}

/** The complete viewing state persisted independently from the cleaning plan. */
export interface PersistedViewingState extends GridViewState {
  filterModel: FilterModel;
}

export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 640;
export const MAX_GRID_COLUMN_WIDTHS = 2_048;
export const MAX_GRID_COLUMN_ID_CODE_UNITS = 65_536;
export const MAX_GRID_COLUMN_WIDTH_ID_CODE_UNITS = 1_048_576;

export function emptyGridViewState(): GridViewState {
  return {
    columnWidths: new Map(),
    viewport: { firstVisibleRow: 0, scrollLeft: 0 }
  };
}

export function encodeGridViewState(state: GridViewState): SerializedGridViewState | undefined {
  const columnWidths = encodeColumnWidths(state.columnWidths);
  if (
    !columnWidths ||
    !isBoundedPosition(state.viewport.firstVisibleRow, true) ||
    !isBoundedPosition(state.viewport.scrollLeft, false) ||
    (state.selectedColumnId !== undefined && !isBoundedColumnId(state.selectedColumnId))
  ) {
    return undefined;
  }
  return {
    columnWidths,
    ...(state.selectedColumnId === undefined ? {} : { selectedColumnId: state.selectedColumnId }),
    viewport: { ...state.viewport }
  };
}

export function decodeGridViewState(value: unknown): GridViewState | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["columnWidths", "viewport"], ["selectedColumnId"])) {
    return undefined;
  }
  if (!Array.isArray(value.columnWidths) || !isRecord(value.viewport)) return undefined;
  if (!hasExactKeys(value.viewport, ["firstVisibleRow", "scrollLeft"])) return undefined;
  if (
    !isBoundedPosition(value.viewport.firstVisibleRow, true) ||
    !isBoundedPosition(value.viewport.scrollLeft, false)
  ) {
    return undefined;
  }
  if (value.selectedColumnId !== undefined && !isBoundedColumnId(value.selectedColumnId)) {
    return undefined;
  }
  const columnWidths = decodeColumnWidths(value.columnWidths);
  if (!columnWidths) return undefined;
  return {
    columnWidths,
    ...(value.selectedColumnId === undefined ? {} : { selectedColumnId: value.selectedColumnId }),
    viewport: {
      firstVisibleRow: value.viewport.firstVisibleRow,
      scrollLeft: value.viewport.scrollLeft
    }
  };
}

export function setGridColumnWidth(
  current: ReadonlyMap<string, number>,
  columnId: string,
  width: number
): ReadonlyMap<string, number> {
  if (!isBoundedColumnId(columnId) || !isColumnWidth(width)) return current;
  const next = new Map(current);
  if (!next.has(columnId) && next.size >= MAX_GRID_COLUMN_WIDTHS) {
    const oldestColumnId = next.keys().next().value as string | undefined;
    if (oldestColumnId !== undefined) next.delete(oldestColumnId);
  }
  next.delete(columnId);
  next.set(columnId, width);
  return next;
}

function encodeColumnWidths(columnWidths: ReadonlyMap<string, number>): Array<[string, number]> | undefined {
  if (columnWidths.size > MAX_GRID_COLUMN_WIDTHS) return undefined;
  const encoded: Array<[string, number]> = [];
  let remainingIdCodeUnits = MAX_GRID_COLUMN_WIDTH_ID_CODE_UNITS;
  for (const [columnId, width] of columnWidths) {
    if (!isBoundedColumnId(columnId) || columnId.length > remainingIdCodeUnits || !isColumnWidth(width)) {
      return undefined;
    }
    remainingIdCodeUnits -= columnId.length;
    encoded.push([columnId, width]);
  }
  return encoded;
}

function decodeColumnWidths(value: unknown[]): ReadonlyMap<string, number> | undefined {
  if (value.length > MAX_GRID_COLUMN_WIDTHS) return undefined;
  const decoded = new Map<string, number>();
  let remainingIdCodeUnits = MAX_GRID_COLUMN_WIDTH_ID_CODE_UNITS;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [columnId, width] = entry;
    if (
      !isBoundedColumnId(columnId) ||
      columnId.length > remainingIdCodeUnits ||
      !isColumnWidth(width) ||
      decoded.has(columnId)
    ) {
      return undefined;
    }
    remainingIdCodeUnits -= columnId.length;
    decoded.set(columnId, width);
  }
  return decoded;
}

function isColumnWidth(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_COLUMN_WIDTH && value <= MAX_COLUMN_WIDTH;
}

function isBoundedColumnId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_GRID_COLUMN_ID_CODE_UNITS;
}

function isBoundedPosition(value: unknown, integer: boolean): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER &&
    (!integer || Number.isSafeInteger(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
