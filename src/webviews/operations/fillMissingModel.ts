import type {
  ColumnReference,
  ColumnSchema,
  ColumnType,
  FillMissingParams,
  FillMissingReplacement,
  TransformSortRule
} from "../../shared/protocol";
import { numericColumnTypes, orderedColumnTypes, portableScalarColumnTypes } from "./operationFieldCompatibility";

export type FillMode =
  | "median"
  | "mean"
  | "mostFrequent"
  | "groupedMedian"
  | "groupedMean"
  | "groupedMostFrequent"
  | "linearInterpolation"
  | "directionalForward"
  | "directionalBackward"
  | "fallbackColumns"
  | "value";

export type FillValueKind = Exclude<
  FillMissingReplacement,
  | { kind: "median" }
  | { kind: "mean" }
  | { kind: "mostFrequent" }
  | { kind: "linearInterpolation" }
  | { kind: "directional" }
  | { kind: "groupedStatistic" }
  | { kind: "fallbackColumns" }
>["kind"];

export const maxFillFallbackColumns = 64;
export const maxFillDirectionalGap = 1_000_000;

const fillValueColumnTypes: ReadonlySet<ColumnType> = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "unknown"
]);
const mostFrequentColumnTypes: ReadonlySet<ColumnType> = new Set(["string", "boolean"]);
const interpolationCoordinateColumnTypes: ReadonlySet<ColumnType> = new Set([
  "integer",
  "float",
  "decimal",
  "date",
  "datetime"
]);
export function fillModesForColumn(column: ColumnSchema | undefined, columns: readonly ColumnSchema[]): FillMode[] {
  const fallback = fallbackColumnsForTarget(column, columns).length > 0 ? (["fallbackColumns"] as const) : [];
  const grouped = groupedKeyColumnsForTarget(column, columns).length > 0;
  const interpolation =
    interpolationCoordinateColumnsForTarget(column, columns).length > 0 ? (["linearInterpolation"] as const) : [];
  const directional =
    directionalOrderColumnsForTarget(column, columns).length > 0
      ? (["directionalForward", "directionalBackward"] as const)
      : [];
  if (column?.type === "float") {
    return [
      "median",
      "mean",
      ...interpolation,
      ...(grouped ? (["groupedMedian", "groupedMean"] as const) : []),
      ...directional,
      ...fallback,
      "value"
    ];
  }
  if (column && numericColumnTypes.has(column.type)) {
    return ["median", ...(grouped ? (["groupedMedian"] as const) : []), ...directional, ...fallback, "value"];
  }
  if (column && mostFrequentColumnTypes.has(column.type)) {
    return [
      "mostFrequent",
      ...(grouped ? (["groupedMostFrequent"] as const) : []),
      ...directional,
      ...fallback,
      "value"
    ];
  }
  if (column && (column.type === "date" || column.type === "datetime")) return [...directional, ...fallback, "value"];
  if (column && portableScalarColumnTypes.has(column.type)) return [...directional];
  return ["value"];
}

export function isInterpolationCoordinateColumn(column: ColumnSchema): boolean {
  if (!interpolationCoordinateColumnTypes.has(column.type)) return false;
  const rawType = column.rawType.toLowerCase();
  return rawType !== "integer64" && !rawType.includes("int128") && !rawType.includes("hugeint");
}

export function interpolationCoordinateColumnsForTarget(
  target: ColumnSchema | undefined,
  columns: readonly ColumnSchema[]
): ColumnSchema[] {
  if (target?.type !== "float") return [];
  return columns.filter((column) => column.id !== target.id && isInterpolationCoordinateColumn(column));
}

export function defaultFillModeForColumn(column: ColumnSchema | undefined, columns: readonly ColumnSchema[]): FillMode {
  return fillModesForColumn(column, columns)[0];
}

export function fallbackColumnsForTarget(
  target: ColumnSchema | undefined,
  columns: readonly ColumnSchema[]
): ColumnSchema[] {
  if (!target || target.type === "unknown") return [];
  return columns.filter((column) => column.id !== target.id && column.type === target.type);
}

export function isDirectionalOrderColumn(column: ColumnSchema): boolean {
  return orderedColumnTypes.has(column.type);
}

export function directionalOrderColumnsForTarget(
  target: ColumnSchema | undefined,
  columns: readonly ColumnSchema[]
): ColumnSchema[] {
  if (!target || !portableScalarColumnTypes.has(target.type)) return [];
  return columns.filter((column) => column.id !== target.id && isDirectionalOrderColumn(column));
}

export function isGroupedKeyColumn(column: ColumnSchema): boolean {
  return orderedColumnTypes.has(column.type);
}

export function groupedKeyColumnsForTarget(
  target: ColumnSchema | undefined,
  columns: readonly ColumnSchema[]
): ColumnSchema[] {
  if (!target) return [];
  return columns.filter((column) => column.id !== target.id && isGroupedKeyColumn(column));
}

export function fillTargetColumns(columns: readonly ColumnSchema[]): ColumnSchema[] {
  return columns.filter(
    (column) =>
      fillValueColumnTypes.has(column.type) ||
      (portableScalarColumnTypes.has(column.type) && directionalOrderColumnsForTarget(column, columns).length > 0)
  );
}

export function fillValueKindForColumn(type: ColumnType | undefined): FillValueKind {
  return type === "integer" ||
    type === "float" ||
    type === "decimal" ||
    type === "boolean" ||
    type === "date" ||
    type === "datetime"
    ? type
    : "string";
}

export function fillModeForReplacement(replacement: FillMissingReplacement | undefined): FillMode | undefined {
  if (!replacement) return undefined;
  if (
    replacement.kind === "median" ||
    replacement.kind === "mean" ||
    replacement.kind === "mostFrequent" ||
    replacement.kind === "fallbackColumns"
  ) {
    return replacement.kind;
  }
  if (replacement.kind === "groupedStatistic") {
    return replacement.statistic === "median"
      ? "groupedMedian"
      : replacement.statistic === "mean"
        ? "groupedMean"
        : "groupedMostFrequent";
  }
  if (replacement.kind === "linearInterpolation") return "linearInterpolation";
  if (replacement.kind === "directional") {
    return replacement.direction === "forward" ? "directionalForward" : "directionalBackward";
  }
  return "value";
}

export function explicitFillValueKind(replacement: FillMissingReplacement | undefined): FillValueKind | undefined {
  return replacement &&
    replacement.kind !== "median" &&
    replacement.kind !== "mean" &&
    replacement.kind !== "mostFrequent" &&
    replacement.kind !== "groupedStatistic" &&
    replacement.kind !== "linearInterpolation" &&
    replacement.kind !== "directional" &&
    replacement.kind !== "fallbackColumns"
    ? replacement.kind
    : undefined;
}

export function explicitFillValue(replacement: FillMissingReplacement | undefined): string {
  return explicitFillValueKind(replacement) ? String((replacement as { value: unknown }).value) : "";
}

export function retainDistinctAvailableIds(
  ids: readonly string[],
  availableColumns: readonly ColumnSchema[],
  limit = Number.POSITIVE_INFINITY
): string[] {
  const availableIds = new Set(availableColumns.map((column) => column.id));
  const seen = new Set<string>();
  return ids
    .filter((id) => {
      if (!availableIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, limit);
}

export function normalizeFillNumericValue(kind: FillValueKind, value: string): string {
  const trimmed = value.trim();
  if (kind === "integer") {
    if (!/^[+-]?[0-9]+$/u.test(trimmed)) return trimmed;
    try {
      return BigInt(trimmed).toString();
    } catch {
      return trimmed;
    }
  }
  if (kind !== "float" && kind !== "decimal") return value;
  const match = trimmed.match(/^([+-]?)(?:(\d+)(\.\d*)?|(\.\d+))([eE][+-]?\d+)?$/u);
  if (!match) return trimmed;
  const [, sign, wholeText = "", fractionAfterWhole, fractionOnly, exponent = ""] = match;
  const whole = (wholeText || "0").replace(/^0+(?=\d)/u, "");
  const fraction = fractionOnly !== undefined ? fractionOnly.slice(1) : fractionAfterWhole?.slice(1);
  const coefficient = fraction === undefined ? whole : `${whole}.${fraction || "0"}`;
  return `${sign === "-" ? "-" : ""}${coefficient}${exponent}`;
}

export function buildFillMissingParams(form: FormData, availableColumns: readonly ColumnSchema[]): FillMissingParams {
  const value = (name: string) => String(form.get(name) ?? "");
  const columnReference = (name: string) => referenceForId(value(name), availableColumns);
  const requiredColumnReferences = (name: string, label: string): [ColumnReference, ...ColumnReference[]] => {
    const references = form
      .getAll(name)
      .map(String)
      .map((id) => referenceForId(id, availableColumns));
    if (references.length === 0) throw new Error(`${label} requires at least one compatible column.`);
    return references as [ColumnReference, ...ColumnReference[]];
  };

  const fillMode = value("fillMode");
  if (fillMode === "median" || fillMode === "mean" || fillMode === "mostFrequent") {
    return { column: columnReference("column"), replacement: { kind: fillMode } };
  }
  if (fillMode === "linearInterpolation") {
    const column = columnReference("column");
    const coordinate = columnReference("fillInterpolationCoordinate");
    if (coordinate.id === column.id) {
      throw new Error("The fill target and interpolation coordinate must be different columns.");
    }
    const maxGap = value("fillInterpolationMaxGap").trim();
    validateGap(maxGap, "Maximum missing cells in a run");
    return {
      column,
      replacement: {
        kind: "linearInterpolation",
        coordinate,
        ...(maxGap === "" ? {} : { maxGap: Number(maxGap) })
      }
    };
  }
  if (fillMode === "directionalForward" || fillMode === "directionalBackward") {
    const column = columnReference("column");
    const orderColumns = requiredColumnReferences("fillOrderColumn", "Directional fill order");
    if (orderColumns.some((orderColumn) => orderColumn.id === column.id)) {
      throw new Error("A fill target cannot also be one of its calculation-order columns.");
    }
    const directions = form.getAll("fillOrderDirection").map(String);
    const nulls = form.getAll("fillOrderNulls").map(String);
    const maxGap = value("fillMaxGap").trim();
    validateGap(maxGap, "Maximum gap length");
    const orderBy = orderColumns.map((orderColumn, index) => ({
      column: orderColumn,
      direction: directions[index] as TransformSortRule["direction"],
      nulls: nulls[index] as TransformSortRule["nulls"]
    })) as [TransformSortRule, ...TransformSortRule[]];
    return {
      column,
      replacement: {
        kind: "directional",
        direction: fillMode === "directionalForward" ? "forward" : "backward",
        orderBy,
        ...(maxGap === "" ? {} : { maxGap: Number(maxGap) })
      }
    };
  }
  if (fillMode === "groupedMedian" || fillMode === "groupedMean" || fillMode === "groupedMostFrequent") {
    const column = columnReference("column");
    const keys = requiredColumnReferences("fillGroupKeys", "Grouped fill");
    if (keys.some((key) => key.id === column.id)) {
      throw new Error("A fill target cannot also be one of its group keys.");
    }
    return {
      column,
      replacement: {
        kind: "groupedStatistic",
        statistic: fillMode === "groupedMedian" ? "median" : fillMode === "groupedMean" ? "mean" : "mostFrequent",
        keys
      }
    };
  }
  if (fillMode === "fallbackColumns") {
    const column = columnReference("column");
    const columns = requiredColumnReferences("fallbackColumns", "Fallback-column fill");
    if (columns.some((fallback) => fallback.id === column.id)) {
      throw new Error("A fill target cannot also be one of its fallback columns.");
    }
    return { column, replacement: { kind: "fallbackColumns", columns } };
  }

  const replacementKind = value("fillValueKind") as FillValueKind;
  const rawValue = value("fillValue");
  return {
    column: columnReference("column"),
    replacement: {
      kind: replacementKind,
      value: replacementKind === "boolean" ? rawValue === "true" : normalizeFillNumericValue(replacementKind, rawValue)
    } as FillMissingReplacement
  };
}

function validateGap(value: string, label: string): void {
  if (value !== "" && (!/^[1-9][0-9]*$/u.test(value) || Number(value) > maxFillDirectionalGap)) {
    throw new Error(`${label} must be a whole number from 1 to ${maxFillDirectionalGap.toLocaleString()}.`);
  }
}

function referenceForId(id: string, columns: readonly ColumnSchema[]): ColumnReference {
  const column = columns.find((candidate) => candidate.id === id);
  if (!column) throw new Error("The selected column is no longer available.");
  return { id: column.id, name: column.name };
}
