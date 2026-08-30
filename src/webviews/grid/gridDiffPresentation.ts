import type { CellDiff, CellValue, ColumnSchema, DataDiff, GridPage, LiveGridPage } from "../../shared/protocol";

interface GridDiffCellPresentation {
  accessibilityLabel: string;
  state: "added" | "changed";
}

interface GridDiffPresentation {
  addedColumnIds: ReadonlySet<string>;
  addedColumns: ReadonlyArray<{ name: string; rawType: string | undefined }>;
  removedColumns: ReadonlyArray<{ name: string; rawType: string | undefined }>;
  cell(rowId: string, columnId: string): GridDiffCellPresentation | undefined;
}

export function createGridDiffPresentation(
  diff: DataDiff | undefined,
  page: LiveGridPage,
  schema: readonly ColumnSchema[],
  beforePage: GridPage | undefined,
  beforeSchema: readonly ColumnSchema[] | undefined
): GridDiffPresentation | undefined {
  if (!diff) return undefined;

  const addedColumnIds = resolveAddedColumnIds(diff.addedColumns, schema, beforeSchema);
  const changedCellsByRowId = new Map<string, Map<string, CellDiff>>();
  const rowsById = new Map(page.rows.map((row) => [row.id, row]));
  const rowsByNumber = new Map(page.rows.map((row) => [row.rowNumber, row]));
  const beforeRowsById = new Map(beforePage?.rows.map((row) => [row.id, row]) ?? []);
  const pagePositionById = new Map(page.columnIds.map((columnId, position) => [columnId, position]));
  const beforePositionById = new Map(beforePage?.columnIds.map((columnId, position) => [columnId, position]) ?? []);
  const schemaById = new Map(schema.map((column) => [column.id, column]));
  const comparableColumns = page.columnIds.flatMap((columnId, afterPosition) => {
    const column = schemaById.get(columnId);
    const beforePosition = beforePositionById.get(columnId);
    return column && beforePosition !== undefined ? [{ column, beforePosition, afterPosition }] : [];
  });
  const rememberChangedCell = (rowId: string, columnId: string, cellDiff: CellDiff): void => {
    const rowCells = changedCellsByRowId.get(rowId);
    if (rowCells) {
      rowCells.set(columnId, cellDiff);
      return;
    }
    changedCellsByRowId.set(rowId, new Map([[columnId, cellDiff]]));
  };

  if (beforePage && beforeSchema) {
    for (const row of page.rows) {
      const beforeRow = beforeRowsById.get(row.id);
      if (!beforeRow) continue;
      for (const { column, beforePosition, afterPosition } of comparableColumns) {
        const before = beforeRow.values[beforePosition];
        const after = row.values[afterPosition];
        if (!before || !after || sameCellValue(before, after)) continue;
        rememberChangedCell(row.id, column.id, {
          rowNumber: row.rowNumber,
          columnId: column.id,
          column: column.name,
          before,
          after
        });
      }
    }
  }

  for (const cellDiff of diff.cells) {
    const row = rowsByNumber.get(cellDiff.rowNumber);
    if (!row || changedCellsByRowId.get(row.id)?.has(cellDiff.columnId)) continue;
    const afterPosition = pagePositionById.get(cellDiff.columnId);
    if (afterPosition === undefined || !sameCellValue(row.values[afterPosition], cellDiff.after)) continue;
    rememberChangedCell(row.id, cellDiff.columnId, cellDiff);
  }

  return {
    addedColumnIds,
    addedColumns: diff.addedColumns.map((name) => ({
      name,
      rawType: schema.find((column) => column.name === name)?.rawType
    })),
    removedColumns: diff.removedColumns.map((name) => ({
      name,
      rawType: beforeSchema?.find((column) => column.name === name)?.rawType
    })),
    cell(rowId, columnId) {
      const row = rowsById.get(rowId);
      const column = schemaById.get(columnId);
      if (!row || !column) return undefined;
      const changedCell = changedCellsByRowId.get(rowId)?.get(columnId);
      if (changedCell) {
        return {
          state: "changed",
          accessibilityLabel: changedCellLabel(column.name, row.rowNumber, changedCell)
        };
      }
      if (!addedColumnIds.has(columnId)) return undefined;
      const position = pagePositionById.get(columnId);
      return {
        state: "added",
        accessibilityLabel: addedCellLabel(
          column.name,
          row.rowNumber,
          position === undefined ? undefined : row.values[position]
        )
      };
    }
  };
}

function resolveAddedColumnIds(
  addedColumnNames: readonly string[],
  schema: readonly ColumnSchema[],
  beforeSchema: readonly ColumnSchema[] | undefined
): ReadonlySet<string> {
  const remainingByName = countNames(addedColumnNames);
  const beforeIds = new Set(beforeSchema?.map((column) => column.id) ?? []);
  const addedIds = new Set<string>();
  const takeMatchingColumns = (columns: readonly ColumnSchema[]): void => {
    for (const column of columns) {
      const remaining = remainingByName.get(column.name) ?? 0;
      if (remaining <= 0 || addedIds.has(column.id)) continue;
      addedIds.add(column.id);
      remainingByName.set(column.name, remaining - 1);
    }
  };
  if (beforeSchema) takeMatchingColumns(schema.filter((column) => !beforeIds.has(column.id)));
  takeMatchingColumns(schema);
  return addedIds;
}

function countNames(names: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

function sameCellValue(left: CellValue | null | undefined, right: CellValue | null | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.kind === right.kind &&
    left.display === right.display &&
    left.isNull === right.isNull &&
    left.isNaN === right.isNaN &&
    left.sign === right.sign &&
    sameJsonValue(left.raw, right.raw)
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]))
  );
}

function changedCellLabel(column: string, rowNumber: number, diff: CellDiff): string {
  return `${column}, row ${rowNumber + 1}: changed from ${describeCellValue(diff.before)} to ${describeCellValue(diff.after)}`;
}

function addedCellLabel(column: string, rowNumber: number, value: CellValue | undefined): string {
  return `${column}, row ${rowNumber + 1}: added column; before column absent; after ${describeCellValue(value)}`;
}

function describeCellValue(value: CellValue | null | undefined): string {
  if (!value) return "no value";
  if (value.isNull) return "null";
  if (value.isNaN) return "NaN";
  if (value.display.length === 0) return value.kind === "string" ? "empty string" : "empty value";
  const normalized = value.display.replace(/\s+/gu, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized;
}
