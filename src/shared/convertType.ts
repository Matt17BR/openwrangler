import type { CastColumnParams, ColumnType } from "./protocol";

export type ConvertTypeTarget = CastColumnParams["dtype"];

const numberSources: readonly ColumnType[] = ["string", "integer", "float", "decimal", "boolean"];
const calendarSources: readonly ColumnType[] = ["string", "date", "datetime"];

export const CONVERT_TYPE_SOURCES: ReadonlyMap<ConvertTypeTarget, ReadonlySet<ColumnType>> = new Map([
  ["string", new Set<ColumnType>([...numberSources, "date", "datetime"])],
  ["integer", new Set(numberSources)],
  ["float", new Set(numberSources)],
  ["boolean", new Set(numberSources)],
  ["date", new Set(calendarSources)],
  ["datetime", new Set(calendarSources)]
]);

export const CONVERT_TYPE_LABELS: ReadonlyMap<ConvertTypeTarget, string> = new Map([
  ["string", "Text"],
  ["integer", "Integer"],
  ["float", "Float"],
  ["boolean", "Boolean"],
  ["date", "Date"],
  ["datetime", "Datetime"]
]);

export const CONVERTIBLE_COLUMN_TYPES: ReadonlySet<ColumnType> = new Set(CONVERT_TYPE_SOURCES.get("string"));

export function convertTypeTargets(source: ColumnType): ConvertTypeTarget[] {
  return [...CONVERT_TYPE_SOURCES].filter(([, sources]) => sources.has(source)).map(([target]) => target);
}
