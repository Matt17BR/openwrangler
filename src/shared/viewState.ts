import type { FilterModel } from "./filterModel";

export interface GridViewportState {
  firstVisibleRow: number;
  scrollLeft: number;
}

/** Host-owned, non-destructive grid presentation state. */
export interface GridViewState {
  columnWidths: Record<string, number>;
  selectedColumnId?: string;
  viewport: GridViewportState;
}

/** The complete viewing state persisted independently from the cleaning plan. */
export interface PersistedViewingState extends GridViewState {
  filterModel: FilterModel;
}

export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 640;

export function emptyGridViewState(): GridViewState {
  return {
    columnWidths: {},
    viewport: { firstVisibleRow: 0, scrollLeft: 0 }
  };
}

export function decodeGridViewState(value: unknown): GridViewState | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["columnWidths", "viewport"], ["selectedColumnId"])) {
    return undefined;
  }
  if (!isRecord(value.columnWidths) || !isRecord(value.viewport)) return undefined;
  if (!hasExactKeys(value.viewport, ["firstVisibleRow", "scrollLeft"])) return undefined;
  if (
    !isBoundedPosition(value.viewport.firstVisibleRow, true) ||
    !isBoundedPosition(value.viewport.scrollLeft, false)
  ) {
    return undefined;
  }
  if (
    value.selectedColumnId !== undefined &&
    (typeof value.selectedColumnId !== "string" || value.selectedColumnId.length === 0)
  ) {
    return undefined;
  }
  const columnWidths: Array<[string, number]> = [];
  for (const [columnId, width] of Object.entries(value.columnWidths)) {
    if (
      !columnId ||
      typeof width !== "number" ||
      !Number.isFinite(width) ||
      width < MIN_COLUMN_WIDTH ||
      width > MAX_COLUMN_WIDTH
    ) {
      return undefined;
    }
    columnWidths.push([columnId, width]);
  }
  return {
    columnWidths: Object.fromEntries(columnWidths),
    ...(value.selectedColumnId === undefined ? {} : { selectedColumnId: value.selectedColumnId }),
    viewport: {
      firstVisibleRow: value.viewport.firstVisibleRow,
      scrollLeft: value.viewport.scrollLeft
    }
  };
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
