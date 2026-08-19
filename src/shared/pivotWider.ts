import type { TypedSelectionToken } from "./protocol.generated";
import { portablePivotLongerNameKey, validatePivotLongerOutputName } from "./pivotLonger";

export const MIN_PIVOT_WIDER_OUTPUTS = 2;
export const MAX_PIVOT_WIDER_OUTPUTS = 64;
export const MAX_PIVOT_WIDER_COLUMNS = 2_048;
export const MAX_PIVOT_WIDER_ROWS = 2_147_483_647;

/** Pivot outputs share the portable public-name contract used by Pivot Longer. */
export const portablePivotWiderNameKey = portablePivotLongerNameKey;

export function validatePivotWiderOutputName(value: string, label: string): void {
  validatePivotLongerOutputName(value, label);
}

/**
 * Return the exact public text represented by one canonical names-from key.
 * Pivot Wider deliberately accepts only present string tokens so Pandas,
 * Polars, DuckDB, and Native R compare one portable domain representation.
 */
export function pivotWiderKeyValue(value: TypedSelectionToken): string {
  if (
    value.kind !== "typedSelection" ||
    value.version !== 1 ||
    value.columnType !== "string" ||
    value.cell.kind !== "string" ||
    typeof value.cell.raw !== "string" ||
    value.cell.display !== value.cell.raw ||
    value.cell.isNull !== false ||
    value.cell.isNaN !== false
  ) {
    throw new TypeError("Pivot wider keys must be canonical present string selection tokens.");
  }
  return value.cell.raw;
}
