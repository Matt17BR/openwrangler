import type { CellValue, ColumnSchema, LiveGridPage } from "../../shared/protocol";

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

export const maximumClipboardCells = 100_000;
export const maximumClipboardBytes = 4 * 1024 * 1024;
export const maximumClipboardColumnValues = maximumClipboardCells - 1;
const spreadsheetFormulaPrefix = /^[\s\p{Cc}\uFEFF]*[=+\-@]/u;
const clipboardQuotingCharacter = /["\t\r\n]/u;

interface ClipboardFieldPlan {
  byteLength: number;
  neutralizeFormula: boolean;
  quote: boolean;
}

export interface GridClipboardColumnAccumulator {
  readonly rowCount: number;
  append(cell: CellValue): GridClipboardResult | undefined;
  finish(): GridClipboardResult;
}

/**
 * Accumulates a header and one logical column without ever constructing an
 * output above the shared clipboard byte or cell limit.
 */
export function createGridClipboardColumnAccumulator(header: string): GridClipboardColumnAccumulator {
  const headerPlan = planClipboardField(header, true, maximumClipboardBytes);
  const fields = headerPlan ? [renderClipboardField(header, headerPlan)] : [];
  let outputBytes = headerPlan?.byteLength ?? 0;
  let rowCount = 0;
  let failure: GridClipboardResult | undefined = headerPlan ? undefined : clipboardByteLimitError();

  return {
    get rowCount() {
      return rowCount;
    },
    append(cell) {
      if (failure) return failure;
      if (rowCount >= maximumClipboardColumnValues) {
        failure = clipboardCellLimitError();
        return failure;
      }
      const separatorBytes = 1;
      const plan = planClipboardField(
        cell.display,
        spreadsheetFormulaCanExecute(cell),
        maximumClipboardBytes - outputBytes - separatorBytes
      );
      if (!plan) {
        failure = clipboardByteLimitError();
        return failure;
      }
      outputBytes += separatorBytes + plan.byteLength;
      fields.push(renderClipboardField(cell.display, plan));
      rowCount += 1;
      return undefined;
    },
    finish() {
      if (failure) return failure;
      if (rowCount === 0) return { ok: false, reason: "There are no rows in the current data view." };
      return {
        ok: true,
        payload: {
          text: fields.join("\n"),
          rowCount,
          columnCount: 1,
          includesRowLabel: false,
          completeRow: false
        }
      };
    }
  };
}

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
    return clipboardCellLimitError();
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
    const appendField = (value: string, userDerivedString: boolean): boolean => {
      const separatorBytes = fields.length === 0 ? (outputRows.length === 0 ? 0 : 1) : 1;
      const remainingBytes = maximumClipboardBytes - outputBytes - separatorBytes;
      const plan = planClipboardField(value, userDerivedString, remainingBytes);
      if (!plan) return false;
      outputBytes += separatorBytes + plan.byteLength;
      fields.push(renderClipboardField(value, plan));
      return true;
    };
    if (mode === "row" && row.rowLabel !== undefined) {
      if (!appendField(row.rowLabel, true)) return clipboardByteLimitError();
      includesRowLabel = true;
    }
    for (const column of columnPositions) {
      const cell = row.values[column];
      if (!cell) return { ok: false, reason: "Wait for every selected cell to load before copying." };
      if (!appendField(cell.display, spreadsheetFormulaCanExecute(cell))) return clipboardByteLimitError();
    }
    const outputRow = fields.join("\t");
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

export type GridClipboardWritePhase =
  | { readonly kind: "primary" }
  | { readonly kind: "fallback"; readonly helper?: HTMLTextAreaElement }
  | { readonly kind: "restoreFocus"; readonly helper: HTMLTextAreaElement };

export class GridClipboardOwnershipChangedError extends Error {
  override readonly name = "GridClipboardOwnershipChangedError";

  constructor() {
    super("Clipboard ownership changed before the write completed.");
  }
}

const clipboardFallbackFocusOwners = new WeakSet<Element>();
let activeGridClipboardWrite: object | undefined;

export interface GridClipboardWriteOwner {
  release(): void;
  write(text: string, ownsPhase: (phase: GridClipboardWritePhase) => boolean): Promise<void>;
}

export function tryAcquireGridClipboardWrite(): GridClipboardWriteOwner | undefined {
  if (activeGridClipboardWrite !== undefined) return undefined;
  const token = {};
  let released = false;
  let writeStarted = false;
  let writeSettled = false;
  activeGridClipboardWrite = token;
  return {
    release(): void {
      if (released) return;
      if (writeStarted && !writeSettled) {
        throw new Error("The clipboard write owner cannot be released before its write settles.");
      }
      released = true;
      if (activeGridClipboardWrite === token) activeGridClipboardWrite = undefined;
    },
    async write(text: string, ownsPhase: (phase: GridClipboardWritePhase) => boolean): Promise<void> {
      if (released || writeStarted || activeGridClipboardWrite !== token) {
        throw new Error("The clipboard write owner is no longer current.");
      }
      writeStarted = true;
      try {
        await writeGridClipboardText(text, ownsPhase);
      } finally {
        writeSettled = true;
      }
    }
  };
}

export function gridClipboardFallbackOwnsFocus(element: Element | null): boolean {
  return element !== null && clipboardFallbackFocusOwners.has(element);
}

export async function writeGridClipboardText(
  text: string,
  ownsPhase: (phase: GridClipboardWritePhase) => boolean = () => true
): Promise<void> {
  requireClipboardOwnership(ownsPhase, { kind: "primary" });
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    let primaryFailed = false;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      primaryFailed = true;
    }
    if (!primaryFailed) {
      requireClipboardOwnership(ownsPhase, { kind: "primary" });
      return;
    }
  }

  requireClipboardOwnership(ownsPhase, { kind: "fallback" });

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
  clipboardFallbackFocusOwners.add(input);
  document.body.append(input);
  try {
    requireClipboardOwnership(ownsPhase, { kind: "fallback" });
    input.focus({ preventScroll: true });
    input.select();
    requireClipboardOwnership(ownsPhase, { kind: "fallback", helper: input });
    if (!document.execCommand("copy")) throw new Error("Clipboard access is unavailable in this editor.");
  } finally {
    try {
      if (
        activeElement?.isConnected &&
        document.hasFocus() &&
        document.activeElement === input &&
        ownsPhase({ kind: "restoreFocus", helper: input })
      ) {
        activeElement.focus({ preventScroll: true });
      }
    } finally {
      input.remove();
      clipboardFallbackFocusOwners.delete(input);
    }
  }
}

function requireClipboardOwnership(
  ownsPhase: (phase: GridClipboardWritePhase) => boolean,
  phase: GridClipboardWritePhase
): void {
  if (!ownsPhase(phase)) throw new GridClipboardOwnershipChangedError();
}

function spreadsheetFormulaCanExecute(cell: CellValue): boolean {
  return cell.kind === "string" || cell.kind === "unknown";
}

function planClipboardField(
  value: string,
  userDerivedString: boolean,
  maximumBytes: number
): ClipboardFieldPlan | undefined {
  const neutralizeFormula = userDerivedString && spreadsheetFormulaPrefix.test(value);
  const quote = clipboardQuotingCharacter.test(value);
  let byteLength = (neutralizeFormula ? 1 : 0) + (quote ? 2 : 0);
  if (byteLength > maximumBytes) return undefined;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (quote && codeUnit === 0x22) byteLength += 1;
    if (codeUnit <= 0x7f) byteLength += 1;
    else if (codeUnit <= 0x7ff) byteLength += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 3;
      }
    } else {
      byteLength += 3;
    }
    if (byteLength > maximumBytes) return undefined;
  }

  return { byteLength, neutralizeFormula, quote };
}

function renderClipboardField(value: string, plan: ClipboardFieldPlan): string {
  if (!plan.quote) return plan.neutralizeFormula ? `'${value}` : value;
  return `"${plan.neutralizeFormula ? "'" : ""}${value.replaceAll('"', '""')}"`;
}

function clipboardByteLimitError(): GridClipboardResult {
  return { ok: false, reason: "Copy is limited to 4 MiB of displayed text. Select a smaller range." };
}

export function clipboardCellLimitError(): GridClipboardResult {
  return {
    ok: false,
    reason: `Copy is limited to ${maximumClipboardCells.toLocaleString()} cells. Select a smaller range.`
  };
}
