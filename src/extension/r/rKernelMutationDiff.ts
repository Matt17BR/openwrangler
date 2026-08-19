import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import type {
  CapitalizeTextTransformStep,
  CeilNumberTransformStep,
  CellValue,
  ColumnSchema,
  DataDiff,
  DropDuplicatesTransformStep,
  DropMissingRowsTransformStep,
  FilterRowsTransformStep,
  FindReplaceTransformStep,
  FloorNumberTransformStep,
  FormatDatetimeTransformStep,
  LowerTextTransformStep,
  MinMaxScaleTransformStep,
  MultiLabelBinarizeTransformStep,
  OneHotEncodeTransformStep,
  RoundNumberTransformStep,
  SplitTextTransformStep,
  StripTextTransformStep,
  UpperTextTransformStep
} from "../../shared/protocol";
import { R_FRAME_CONTRACT_LIMITS, type RFrameCell, type RFramePageContract } from "./rFrameContract";
import { cellValueFromR } from "./rKernelFrameMapping";
import type { RKernelViewQuery } from "./rKernelProtocol";
import { isRNumericRoundingStep, type RPreviewTransformStep, type RTransformStep } from "./rKernelTransformBinding";

const R_PRIVATE_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_";

export type RCategoricalTransformStep = OneHotEncodeTransformStep | MultiLabelBinarizeTransformStep;

export function isRCategoricalTransformStep(step: RPreviewTransformStep): step is RCategoricalTransformStep {
  return step.kind === "oneHotEncode" || step.kind === "multiLabelBinarize";
}

export function categoricalRetainedSchema(
  inputSchema: readonly ColumnSchema[],
  step: RCategoricalTransformStep
): readonly ColumnSchema[] {
  const references = step.kind === "oneHotEncode" ? step.params.columns : [step.params.column];
  if (references.length === 0 || references.length > inputSchema.length) {
    throw new TypeError("Categorical encoding requires a bounded non-empty R column selection.");
  }
  const inputById = new Map(inputSchema.map((column) => [column.id, column]));
  const selectedIds = new Set<string>();
  for (const reference of references) {
    const column = inputById.get(reference.id);
    if (!column || column.name !== reference.name) {
      throw new TypeError("A categorical column reference no longer matches the active R dataframe.");
    }
    if (selectedIds.has(column.id)) {
      throw new TypeError("Categorical encoding cannot target the same R column more than once.");
    }
    if (column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
      throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
    }
    selectedIds.add(column.id);
  }
  if (step.kind === "oneHotEncode") {
    if (
      step.params.prefixSeparator !== undefined &&
      Buffer.byteLength(step.params.prefixSeparator, "utf8") > R_FRAME_CONTRACT_LIMITS.textBytes
    ) {
      throw new TypeError("The one-hot prefix separator exceeds the R frame contract text limit.");
    }
    if (step.params.dropOriginal !== undefined && typeof step.params.dropOriginal !== "boolean") {
      throw new TypeError("The one-hot drop-original option must be boolean.");
    }
  } else {
    const source = inputById.get(step.params.column.id) as ColumnSchema;
    if (source.rawType !== "character" && source.rawType !== "factor" && source.rawType !== "ordered factor") {
      throw new TypeError("Multi-label binarization requires an R character or factor column.");
    }
    if (
      step.params.delimiter.length === 0 ||
      Buffer.byteLength(step.params.delimiter, "utf8") > R_FRAME_CONTRACT_LIMITS.textBytes
    ) {
      throw new TypeError("Multi-label binarization requires a bounded non-empty delimiter.");
    }
    if (
      step.params.prefix !== undefined &&
      Buffer.byteLength(step.params.prefix, "utf8") > R_FRAME_CONTRACT_LIMITS.textBytes
    ) {
      throw new TypeError("The multi-label prefix exceeds the R frame contract text limit.");
    }
    if (step.params.dropOriginal !== undefined && typeof step.params.dropOriginal !== "boolean") {
      throw new TypeError("The multi-label drop-original option must be boolean.");
    }
  }
  const dropOriginal =
    step.kind === "oneHotEncode" ? step.params.dropOriginal !== false : step.params.dropOriginal === true;
  return Object.freeze(
    inputSchema
      .filter((column) => !dropOriginal || !selectedIds.has(column.id))
      .map((column, position) => Object.freeze({ ...column, position }))
  );
}

export function isRMinMaxScaleInPlace(step: MinMaxScaleTransformStep): boolean {
  return step.params.newColumn === undefined || step.params.newColumn === step.params.column.name;
}

export function isRFormatDatetimeInPlace(step: FormatDatetimeTransformStep): boolean {
  return step.params.newColumn === undefined || step.params.newColumn === step.params.column.name;
}

export function isRNumericRoundingInPlace(
  step: RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep
): boolean {
  return step.params.newColumn === undefined || step.params.newColumn === step.params.column.name;
}

export function numericRoundingLabel(
  step: RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep
): "Round" | "Floor" | "Ceiling" {
  if (step.kind === "roundNumber") return "Round";
  if (step.kind === "floorNumber") return "Floor";
  return "Ceiling";
}

export function isRRowReductionStep(
  step: RPreviewTransformStep
): step is FilterRowsTransformStep | DropMissingRowsTransformStep | DropDuplicatesTransformStep {
  return step.kind === "filterRows" || step.kind === "dropMissingRows" || step.kind === "dropDuplicates";
}

export function rowOperationLabel(
  step: FilterRowsTransformStep | DropMissingRowsTransformStep | DropDuplicatesTransformStep
): string {
  if (step.kind === "filterRows") return "Filter rows";
  if (step.kind === "dropMissingRows") return "Drop missing rows";
  return "Drop duplicates";
}

export function inspectionDiff(
  step: RTransformStep,
  inputSchema: readonly ColumnSchema[],
  outputSchema: readonly ColumnSchema[],
  inputPage: RFramePageContract,
  outputPage: RFramePageContract,
  inputRows: number,
  outputRows: number
): DataDiff {
  if (step.kind === "groupBy" || step.kind === "customCode" || step.kind === "pivotLonger") {
    const inputIds = new Set(inputSchema.map((column) => column.id));
    const outputIds = new Set(outputSchema.map((column) => column.id));
    const fullyRepresented =
      inputPage.page.offset === 0 &&
      inputPage.page.totalRows === inputRows &&
      inputPage.page.rows.length === inputRows &&
      outputPage.page.offset === 0 &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    return {
      addedRows: outputRows,
      removedRows: inputRows,
      addedColumns: outputSchema.filter((column) => !inputIds.has(column.id)).map((column) => column.name),
      removedColumns: inputSchema.filter((column) => !outputIds.has(column.id)).map((column) => column.name),
      changedCells: 0,
      cells: [],
      truncated: !fullyRepresented
    };
  }
  if (step.kind === "sortRows" || isRRowReductionStep(step)) {
    const fullyRepresented =
      inputPage.page.offset === 0 &&
      outputPage.page.offset === 0 &&
      inputPage.page.totalRows === inputRows &&
      inputPage.page.rows.length === inputRows &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    return {
      addedRows: 0,
      removedRows: step.kind === "sortRows" ? 0 : inputRows - outputRows,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: !fullyRepresented
    };
  }
  if (
    inputPage.page.totalRows !== outputPage.page.totalRows ||
    inputPage.page.rows.length !== outputPage.page.rows.length ||
    inputPage.page.rows.some((row, index) => {
      const outputRow = outputPage.page.rows[index];
      return !outputRow || outputRow.id !== row.id || outputRow.rowNumber !== row.rowNumber;
    })
  ) {
    throw new Error("The R kernel returned inspection pages for different rows.");
  }
  const inputIds = new Set(inputSchema.map((column) => column.id));
  const outputIds = new Set(outputSchema.map((column) => column.id));
  const addedColumns = outputSchema.filter((column) => !inputIds.has(column.id)).map((column) => column.name);
  const removedColumns = inputSchema.filter((column) => !outputIds.has(column.id)).map((column) => column.name);
  const textTransformInPlace = isRTextTransformStep(step) && isRTextTransformInPlace(step);
  const numericRoundingInPlace = isRNumericRoundingStep(step) && isRNumericRoundingInPlace(step);
  const minMaxScaleInPlace = step.kind === "minMaxScale" && isRMinMaxScaleInPlace(step);
  const formatDatetimeInPlace = step.kind === "formatDatetime" && isRFormatDatetimeInPlace(step);
  const changedInPlace =
    step.kind === "castColumn" ||
    step.kind === "fillMissingValues" ||
    textTransformInPlace ||
    numericRoundingInPlace ||
    minMaxScaleInPlace ||
    formatDatetimeInPlace;
  if (!changedInPlace) {
    return {
      addedRows: 0,
      removedRows: 0,
      addedColumns,
      removedColumns,
      changedCells: 0,
      cells: [],
      truncated: false
    };
  }

  const columnId = step.params.column.id;
  const inputPosition = inputPage.page.columnIds.indexOf(columnId);
  const outputPosition = outputPage.page.columnIds.indexOf(columnId);
  if (inputPosition < 0 || outputPosition < 0) {
    return {
      addedRows: 0,
      removedRows: 0,
      addedColumns,
      removedColumns,
      changedCells: 0,
      cells: [],
      truncated: true
    };
  }

  const inputRowsById = new Map(inputPage.page.rows.map((row) => [row.id, row]));
  const matchedInputIds = new Set<string>();
  const cells: DataDiff["cells"] = [];
  let changedCells = 0;
  for (const outputRow of outputPage.page.rows) {
    const inputRow = inputRowsById.get(outputRow.id);
    if (!inputRow) continue;
    matchedInputIds.add(inputRow.id);
    const before = cellValueFromR(inputRow.values[inputPosition] as RFrameCell);
    const after = cellValueFromR(outputRow.values[outputPosition] as RFrameCell);
    if (isDeepStrictEqual(before, after)) continue;
    changedCells += 1;
    if (cells.length < 500) {
      cells.push({
        rowNumber: outputRow.rowNumber,
        columnId,
        column: step.params.column.name,
        before,
        after
      });
    }
  }
  const unmatchedRows =
    matchedInputIds.size !== inputPage.page.rows.length || matchedInputIds.size !== outputPage.page.rows.length;
  return {
    addedRows: 0,
    removedRows: 0,
    addedColumns,
    removedColumns,
    changedCells,
    cells,
    truncated:
      unmatchedRows ||
      inputPage.page.totalRows > inputPage.page.rows.length ||
      outputPage.page.totalRows > outputPage.page.rows.length ||
      changedCells > cells.length
  };
}

export function assertMutationDiff(
  step: RTransformStep,
  inputSchema: readonly ColumnSchema[],
  outputSchema: readonly ColumnSchema[],
  inputRows: number,
  outputRows: number,
  outputPage: RFramePageContract,
  diff: DataDiff,
  view: RKernelViewQuery
): void {
  if (step.kind === "pivotLonger") {
    const selectedIds = new Set(step.params.columns.map((column) => column.id));
    const retained = inputSchema.filter((column) => !selectedIds.has(column.id));
    const expectedIds = [...retained.map((column) => column.id), `c:step:${step.id}:0`, `c:step:${step.id}:1`];
    const fullyRepresented =
      outputPage.page.offset === 0 &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    const valid =
      isDeepStrictEqual(
        outputSchema.map((column) => column.id),
        expectedIds
      ) &&
      diff.addedRows === outputRows &&
      diff.removedRows === inputRows &&
      isDeepStrictEqual(diff.addedColumns, [step.params.labelColumn, step.params.valueColumn]) &&
      isDeepStrictEqual(
        diff.removedColumns,
        inputSchema.filter((column) => selectedIds.has(column.id)).map((column) => column.name)
      ) &&
      diff.changedCells === 0 &&
      diff.cells.length === 0 &&
      (fullyRepresented || diff.truncated);
    if (!valid) throw new Error("The R kernel returned an invalid Pivot longer diff.");
    return;
  }
  if (step.kind === "customCode") {
    const inputIds = new Set(inputSchema.map((column) => column.id));
    const outputIds = new Set(outputSchema.map((column) => column.id));
    const expectedAdded = outputSchema.filter((column) => !inputIds.has(column.id)).map((column) => column.name);
    const expectedRemoved = inputSchema.filter((column) => !outputIds.has(column.id)).map((column) => column.name);
    const outputFullyRepresented =
      outputPage.page.offset === 0 &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    const inputFullyRepresented =
      view.filters.length === 0 && outputPage.page.offset === 0 && outputPage.page.limit >= inputRows;
    const expectedTruncated = !(inputFullyRepresented && outputFullyRepresented);
    const valid =
      diff.addedRows === outputRows &&
      diff.removedRows === inputRows &&
      isDeepStrictEqual(diff.addedColumns, expectedAdded) &&
      isDeepStrictEqual(diff.removedColumns, expectedRemoved) &&
      diff.changedCells === 0 &&
      diff.cells.length === 0 &&
      diff.truncated === expectedTruncated;
    if (!valid) throw new Error("The R kernel returned an invalid custom-code diff.");
    return;
  }
  if (step.kind === "groupBy") {
    const keyIds = new Set(step.params.keys.map((column) => column.id));
    const expectedOutputIds = [
      ...step.params.keys.map((column) => column.id),
      ...step.params.aggregations.map((_aggregation, index) => `c:step:${step.id}:${index}`)
    ];
    const expectedAdded = step.params.aggregations.map((aggregation) => aggregation.alias);
    const expectedRemoved = inputSchema.filter((column) => !keyIds.has(column.id)).map((column) => column.name);
    const outputFullyRepresented =
      outputPage.page.offset === 0 &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    const inputFullyRepresented = outputPage.page.offset === 0 && outputPage.page.limit >= inputRows;
    const expectedTruncated = !(inputFullyRepresented && outputFullyRepresented);
    const valid =
      isDeepStrictEqual(
        outputSchema.map((column) => column.id),
        expectedOutputIds
      ) &&
      diff.addedRows === outputRows &&
      diff.removedRows === inputRows &&
      isDeepStrictEqual(diff.addedColumns, expectedAdded) &&
      isDeepStrictEqual(diff.removedColumns, expectedRemoved) &&
      diff.changedCells === 0 &&
      diff.cells.length === 0 &&
      diff.truncated === expectedTruncated;
    if (!valid) throw new Error("The R kernel returned an invalid Group and aggregate diff.");
    return;
  }
  if (step.kind === "sortRows" || isRRowReductionStep(step)) {
    const expectedRemovedRows = step.kind === "sortRows" ? 0 : inputRows - outputRows;
    const fullyRepresented =
      outputPage.page.offset === 0 &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    const valid =
      isDeepStrictEqual(inputSchema, outputSchema) &&
      diff.addedRows === 0 &&
      diff.removedRows === expectedRemovedRows &&
      diff.addedColumns.length === 0 &&
      diff.removedColumns.length === 0 &&
      diff.changedCells === 0 &&
      diff.cells.length === 0 &&
      (fullyRepresented || diff.truncated);
    if (!valid) throw new Error("The R kernel returned an invalid row-operation diff.");
    return;
  }
  if (isRCategoricalTransformStep(step)) {
    const retainedSchema = categoricalRetainedSchema(inputSchema, step);
    const retainedIds = new Set(retainedSchema.map((column) => column.id));
    const generatedSchema = outputSchema.slice(retainedSchema.length);
    const expectedOutputIds = [
      ...retainedSchema.map((column) => column.id),
      ...generatedSchema.map((_column, ordinal) => `c:step:${step.id}:${ordinal}`)
    ];
    const expectedRemoved = inputSchema.filter((column) => !retainedIds.has(column.id)).map((column) => column.name);
    const valid =
      isDeepStrictEqual(
        outputSchema.map((column) => column.id),
        expectedOutputIds
      ) &&
      diff.addedRows === 0 &&
      diff.removedRows === 0 &&
      isDeepStrictEqual(
        diff.addedColumns,
        generatedSchema.map((column) => column.name)
      ) &&
      isDeepStrictEqual(diff.removedColumns, expectedRemoved) &&
      diff.changedCells === 0 &&
      diff.cells.length === 0 &&
      diff.truncated === false;
    if (!valid) throw new Error("The R kernel returned an invalid categorical-encoding diff.");
    return;
  }
  const outputIds = outputSchema.map((column) => column.id);
  const outputIdSet = new Set(outputIds);
  const inputIds = inputSchema.map((column) => column.id);
  const expectedRemoved = inputSchema.filter((column) => !outputIdSet.has(column.id)).map((column) => column.name);
  const textTransformInPlace = isRTextTransformStep(step) && isRTextTransformInPlace(step);
  const numericRoundingInPlace = isRNumericRoundingStep(step) && isRNumericRoundingInPlace(step);
  const minMaxScaleInPlace = step.kind === "minMaxScale" && isRMinMaxScaleInPlace(step);
  const formatDatetimeInPlace = step.kind === "formatDatetime" && isRFormatDatetimeInPlace(step);
  const changedInPlace =
    textTransformInPlace ||
    numericRoundingInPlace ||
    minMaxScaleInPlace ||
    formatDatetimeInPlace ||
    step.kind === "fillMissingValues" ||
    step.kind === "castColumn";
  const expectedAdded =
    step.kind === "cloneColumn"
      ? [step.params.newName]
      : step.kind === "formula"
        ? [step.params.newColumn]
        : step.kind === "byExample"
          ? [step.params.newColumn]
          : step.kind === "textLength"
            ? [step.params.newColumn]
            : isRTextTransformStep(step) && !textTransformInPlace
              ? [step.params.newColumn as string]
              : isRNumericRoundingStep(step) && !numericRoundingInPlace
                ? [step.params.newColumn as string]
                : step.kind === "minMaxScale" && !minMaxScaleInPlace
                  ? [step.params.newColumn as string]
                  : step.kind === "formatDatetime" && !formatDatetimeInPlace
                    ? [step.params.newColumn as string]
                    : [];
  const stepMatches =
    step.kind === "selectColumns"
      ? isDeepStrictEqual(
          outputIds,
          step.params.columns.map((column) => column.id)
        ) && expectedRemoved.length === inputSchema.length - step.params.columns.length
      : step.kind === "dropColumns"
        ? isDeepStrictEqual(
            outputIds,
            inputIds.filter((id) => !step.params.columns.some((column) => column.id === id))
          ) && expectedRemoved.length === step.params.columns.length
        : step.kind === "cloneColumn"
          ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
          : step.kind === "formula"
            ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
            : step.kind === "byExample"
              ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
              : step.kind === "textLength"
                ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
                : isRTextTransformStep(step) && !textTransformInPlace
                  ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
                  : isRNumericRoundingStep(step) && !numericRoundingInPlace
                    ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
                    : step.kind === "minMaxScale" && !minMaxScaleInPlace
                      ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) &&
                        expectedRemoved.length === 0
                      : step.kind === "formatDatetime" && !formatDatetimeInPlace
                        ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) &&
                          expectedRemoved.length === 0
                        : isDeepStrictEqual(outputIds, inputIds) && expectedRemoved.length === 0;
  const projectedPosition = changedInPlace ? outputPage.page.columnIds.indexOf(step.params.column.id) : -1;
  const changedInput = changedInPlace
    ? inputSchema.find((column) => column.id === step.params.column.id && column.name === step.params.column.name)
    : undefined;
  const outputRowsByNumber = new Map(outputPage.page.rows.map((row) => [row.rowNumber, row]));
  const cellsMatch =
    changedInPlace && changedInput
      ? diff.changedCells <= outputPage.page.rows.length &&
        (projectedPosition >= 0 || (diff.changedCells === 0 && diff.cells.length === 0 && diff.truncated)) &&
        diff.cells.every((cell) => {
          const outputRow = outputRowsByNumber.get(cell.rowNumber);
          return (
            projectedPosition >= 0 &&
            outputRow !== undefined &&
            cell.columnId === step.params.column.id &&
            cell.column === step.params.column.name &&
            cell.before !== null &&
            cell.after !== null &&
            isCellCompatibleWithColumn(cell.before, changedInput) &&
            !isDeepStrictEqual(cell.before, cell.after) &&
            isDeepStrictEqual(cell.after, cellValueFromR(outputRow.values[projectedPosition] as RFrameCell))
          );
        }) &&
        diff.changedCells >= diff.cells.length &&
        (diff.truncated || diff.changedCells === diff.cells.length)
      : diff.changedCells === 0 && diff.cells.length === 0 && diff.truncated === false;
  const valid =
    diff.addedRows === 0 &&
    diff.removedRows === 0 &&
    isDeepStrictEqual(diff.addedColumns, expectedAdded) &&
    isDeepStrictEqual(diff.removedColumns, expectedRemoved) &&
    cellsMatch &&
    stepMatches;
  if (!valid) throw new Error("The R kernel returned a mutation diff for the wrong columns or cells.");
}

export function isRTextTransformStep(
  step: RTransformStep
): step is
  | FindReplaceTransformStep
  | StripTextTransformStep
  | SplitTextTransformStep
  | CapitalizeTextTransformStep
  | LowerTextTransformStep
  | UpperTextTransformStep {
  return (
    step.kind === "findReplace" ||
    step.kind === "stripText" ||
    step.kind === "splitText" ||
    step.kind === "capitalizeText" ||
    step.kind === "lowerText" ||
    step.kind === "upperText"
  );
}

export function isRTextTransformInPlace(
  step:
    | FindReplaceTransformStep
    | StripTextTransformStep
    | SplitTextTransformStep
    | CapitalizeTextTransformStep
    | LowerTextTransformStep
    | UpperTextTransformStep
): boolean {
  return step.params.newColumn === undefined || step.params.newColumn === step.params.column.name;
}

export function isCellCompatibleWithColumn(cell: CellValue, column: ColumnSchema): boolean {
  if (cell.isNull) return column.nullable && cell.kind === "null";
  if (cell.isNaN) return column.type === "float" && cell.kind === "nan";
  if (cell.kind === "infinity") return column.type === "float";
  const expectedKinds: Readonly<Record<ColumnSchema["type"], readonly CellValue["kind"][]>> = {
    string: ["string"],
    integer: ["integer"],
    float: ["number"],
    decimal: ["decimal"],
    boolean: ["boolean"],
    datetime: ["datetime"],
    date: ["date"],
    duration: ["duration"],
    binary: [],
    list: [],
    struct: [],
    unknown: []
  };
  return cell.isNull === false && cell.isNaN === false && expectedKinds[column.type].includes(cell.kind);
}

export function copyDiff(diff: DataDiff): DataDiff {
  return {
    addedRows: diff.addedRows,
    removedRows: diff.removedRows,
    addedColumns: [...diff.addedColumns],
    removedColumns: [...diff.removedColumns],
    changedCells: diff.changedCells,
    cells: diff.cells.map((cell) => ({
      ...cell,
      before: cell.before ? { ...cell.before } : null,
      after: cell.after ? { ...cell.after } : null
    })),
    truncated: diff.truncated
  };
}
