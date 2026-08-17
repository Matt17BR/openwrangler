import type { CellValue, ColumnSchema, GridPage } from "../../shared/protocol";
import { R_FRAME_CONTRACT_LIMITS, type RFrameCell, type RFramePageContract } from "./rFrameContract";
import type { RKernelPageWindow, RKernelViewQuery } from "./rKernelProtocol";

export function validateRPageWindow(
  rowOffset: number,
  rowLimit: number,
  columnOffset: number,
  columnLimit: number
): void {
  if (!Number.isSafeInteger(rowOffset) || rowOffset < 0 || rowOffset > R_FRAME_CONTRACT_LIMITS.rows) {
    throw new TypeError("The R row offset is outside the supported range.");
  }
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > R_FRAME_CONTRACT_LIMITS.pageRows) {
    throw new TypeError(`R pages may contain at most ${R_FRAME_CONTRACT_LIMITS.pageRows} rows.`);
  }
  if (!Number.isSafeInteger(columnOffset) || columnOffset < 0 || columnOffset > R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("The R column offset is outside the supported range.");
  }
  if (!Number.isSafeInteger(columnLimit) || columnLimit < 1 || columnLimit > R_FRAME_CONTRACT_LIMITS.pageColumns) {
    throw new TypeError(`R pages may contain at most ${R_FRAME_CONTRACT_LIMITS.pageColumns} columns.`);
  }
  if (rowLimit * columnLimit > R_FRAME_CONTRACT_LIMITS.pageCells) {
    throw new TypeError(`R pages may contain at most ${R_FRAME_CONTRACT_LIMITS.pageCells} cells.`);
  }
}

export function rPageWindow(
  rowOffset: number,
  rowLimit: number,
  columnOffset: number,
  columnLimit: number,
  view: RKernelViewQuery
): RKernelPageWindow {
  return Object.freeze({ rowOffset, rowLimit, columnOffset, columnLimit, view });
}

export function emptyRViewQuery(): RKernelViewQuery {
  return Object.freeze({ filters: Object.freeze([]), sorts: Object.freeze([]) });
}

export function gridPageFromRContract(contract: RFramePageContract): GridPage {
  return {
    offset: contract.page.offset,
    limit: contract.page.limit,
    totalRows: contract.page.totalRows,
    columnIds: [...contract.page.columnIds],
    rows: contract.page.rows.map((row) => ({
      id: row.id,
      rowNumber: row.rowNumber,
      ...(row.rowLabel === undefined ? {} : { rowLabel: row.rowLabel }),
      values: row.values.map(cellValueFromR)
    }))
  };
}

export function sameRSchema(expected: readonly ColumnSchema[], actual: RFramePageContract["schema"]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((column, index) => {
      const candidate = actual[index];
      return (
        candidate !== undefined &&
        candidate.id === column.id &&
        candidate.name === column.name &&
        candidate.position === column.position &&
        candidate.rawType === column.rawType &&
        candidate.type === column.type &&
        candidate.nullable === column.nullable
      );
    })
  );
}

export function schemaFromRContract(contract: RFramePageContract): readonly ColumnSchema[] {
  return Object.freeze(
    contract.schema.map<ColumnSchema>((column) =>
      Object.freeze({
        id: column.id,
        name: column.name,
        position: column.position,
        rawType: column.rawType,
        type: column.type,
        nullable: column.nullable
      })
    )
  );
}

export function copyRSchema(schema: readonly ColumnSchema[]): ColumnSchema[] {
  return schema.map((column) => ({ ...column }));
}

export function cellValueFromR(cell: RFrameCell): CellValue {
  if (cell.kind === "number") {
    const raw = Number(cell.raw);
    if (!Number.isFinite(raw)) throw new TypeError("The R frame returned a non-finite value as a finite double.");
    return { ...cell, raw };
  }
  return { ...cell };
}
