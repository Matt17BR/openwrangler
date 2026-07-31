import type { CellValue, ColumnSchema, ColumnType, GridPage } from "./protocol";

export const R_FRAME_CONTRACT_VERSION = 1 as const;
export const R_RUNTIME_LANGUAGE = "r" as const;

export const R_FRAME_FLAVORS = ["data.frame", "tibble", "grouped-tibble", "rowwise-tibble", "data.table"] as const;
export type RFrameFlavor = (typeof R_FRAME_FLAVORS)[number];

export const R_CODE_DIALECTS = ["base-r", "dplyr", "data.table"] as const;
export type RCodeDialect = (typeof R_CODE_DIALECTS)[number];

export interface RColumnReference {
  readonly id: string;
  readonly name: string;
}

export interface RColumnMetadata {
  readonly columnId: string;
  readonly classNames: readonly string[];
  readonly storageType: string;
  readonly levels?: readonly string[];
  readonly ordered?: boolean;
  readonly timezone?: string;
  readonly durationUnits?: string;
}

export interface RFrameMetadata {
  readonly classNames: readonly string[];
  readonly groupColumns?: readonly RColumnReference[];
  readonly keyColumns?: readonly RColumnReference[];
}

/**
 * Experimental language-neutral handoff emitted by the native R probe.
 *
 * This is deliberately separate from protocol v2. It proves the R semantic
 * boundary before a production R session is added, without weakening the
 * released Python runtime contract or pretending that an R frame is a Pandas
 * backend.
 */
export interface RFramePageContract {
  readonly contractVersion: typeof R_FRAME_CONTRACT_VERSION;
  readonly runtimeLanguage: typeof R_RUNTIME_LANGUAGE;
  readonly frameFlavor: RFrameFlavor;
  readonly codeDialect: RCodeDialect | null;
  readonly shape: { readonly rows: number; readonly columns: number };
  readonly schema: readonly ColumnSchema[];
  readonly columnMetadata: readonly RColumnMetadata[];
  readonly frameMetadata: RFrameMetadata;
  readonly page: GridPage;
  readonly rowNames: readonly string[];
}

const COLUMN_TYPES = new Set<ColumnType>([
  "string",
  "integer",
  "float",
  "boolean",
  "datetime",
  "date",
  "duration",
  "binary",
  "list",
  "unknown"
]);
const CELL_KINDS = new Set<CellValue["kind"]>([
  "null",
  "nan",
  "infinity",
  "boolean",
  "number",
  "integer",
  "string",
  "datetime",
  "date",
  "duration",
  "binary",
  "list",
  "unknown"
]);
const FRAME_FLAVORS = new Set<string>(R_FRAME_FLAVORS);
const CODE_DIALECTS = new Set<string>(R_CODE_DIALECTS);
const FRAME_CLASSES: Readonly<Record<RFrameFlavor, readonly string[]>> = {
  "data.frame": ["data.frame"],
  tibble: ["tbl_df", "tbl", "data.frame"],
  "grouped-tibble": ["grouped_df", "tbl_df", "tbl", "data.frame"],
  "rowwise-tibble": ["rowwise_df", "tbl_df", "tbl", "data.frame"],
  "data.table": ["data.table", "data.frame"]
};
const NUMERIC_SPECIAL_TYPES = new Set<ColumnType>(["float", "date", "datetime", "duration"]);
const MAX_TEXT_BYTES = 65_536;
const MAX_TEXT_VECTOR_ITEMS = 4_096;
const MAX_TEXT_VECTOR_BYTES = 1_048_576;
const MAX_PAGE_ROWS = 10_000;
const MAX_PAGE_CELLS = 100_000;
const MAX_CONTRACT_TEXT_BYTES = 8_388_608;

export function isRFramePageContract(value: unknown): value is RFramePageContract {
  try {
    if (!hasBoundedTextGraph(value)) return false;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "codeDialect",
        "columnMetadata",
        "contractVersion",
        "frameFlavor",
        "frameMetadata",
        "page",
        "rowNames",
        "runtimeLanguage",
        "schema",
        "shape"
      ]) ||
      value.contractVersion !== R_FRAME_CONTRACT_VERSION ||
      value.runtimeLanguage !== R_RUNTIME_LANGUAGE ||
      typeof value.frameFlavor !== "string" ||
      !FRAME_FLAVORS.has(value.frameFlavor) ||
      !(
        value.codeDialect === null ||
        (typeof value.codeDialect === "string" && CODE_DIALECTS.has(value.codeDialect))
      ) ||
      !isShape(value.shape) ||
      !Array.isArray(value.schema) ||
      value.schema.length !== value.shape.columns ||
      !isSchema(value.schema) ||
      !Array.isArray(value.columnMetadata) ||
      value.columnMetadata.length !== value.schema.length ||
      !isColumnMetadata(value.columnMetadata, value.schema) ||
      !isFrameMetadata(value.frameMetadata, value.frameFlavor as RFrameFlavor, value.schema) ||
      !isGridPage(value.page, value.schema, value.shape.rows) ||
      !isStringArray(value.rowNames, MAX_PAGE_ROWS, MAX_CONTRACT_TEXT_BYTES) ||
      value.rowNames.length !== value.page.rows.length
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isShape(value: unknown): value is RFramePageContract["shape"] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["columns", "rows"]) &&
    isSafeNonNegativeInteger(value.rows) &&
    isSafeNonNegativeInteger(value.columns)
  );
}

function isSchema(value: readonly unknown[]): value is readonly ColumnSchema[] {
  const ids = new Set<string>();
  for (let position = 0; position < value.length; position += 1) {
    const column = value[position];
    if (
      !isRecord(column) ||
      !hasExactKeys(column, ["id", "name", "nullable", "position", "rawType", "type"]) ||
      !isBoundedNonEmptyString(column.id) ||
      ids.has(column.id) ||
      !isBoundedString(column.name) ||
      column.position !== position ||
      !isBoundedNonEmptyString(column.rawType) ||
      typeof column.type !== "string" ||
      !COLUMN_TYPES.has(column.type as ColumnType) ||
      typeof column.nullable !== "boolean"
    ) {
      return false;
    }
    ids.add(column.id);
  }
  return true;
}

function isColumnMetadata(value: readonly unknown[], schema: readonly ColumnSchema[]): boolean {
  for (let position = 0; position < value.length; position += 1) {
    const metadata = value[position];
    const column = schema[position];
    if (
      column === undefined ||
      !isRecord(metadata) ||
      !hasOnlyKeys(metadata, [
        "classNames",
        "columnId",
        "durationUnits",
        "levels",
        "ordered",
        "storageType",
        "timezone"
      ]) ||
      metadata.columnId !== column.id ||
      !isStringArray(metadata.classNames) ||
      metadata.classNames.length === 0 ||
      !isBoundedNonEmptyString(metadata.storageType) ||
      column.rawType !== `${metadata.storageType}<${metadata.classNames.join("/")}>` ||
      rSemanticType(metadata.storageType, metadata.classNames) !== column.type ||
      !hasCoherentColumnOptions(metadata, column.type)
    ) {
      return false;
    }
  }
  return true;
}

function hasCoherentColumnOptions(metadata: Record<string, unknown>, columnType: ColumnType): boolean {
  const classes = metadata.classNames as readonly string[];
  const factor = sameStrings(classes, ["factor"]) || sameStrings(classes, ["ordered", "factor"]);
  const posix = sameStrings(classes, ["POSIXct", "POSIXt"]);
  const duration = sameStrings(classes, ["difftime"]);

  if (factor) {
    if (
      columnType !== "string" ||
      !isStringArray(metadata.levels) ||
      new Set(metadata.levels).size !== metadata.levels.length ||
      typeof metadata.ordered !== "boolean" ||
      metadata.ordered !== sameStrings(classes, ["ordered", "factor"])
    ) {
      return false;
    }
  } else if (metadata.levels !== undefined || metadata.ordered !== undefined) {
    return false;
  }

  if (posix) {
    if (columnType !== "datetime" || !isBoundedString(metadata.timezone)) return false;
  } else if (metadata.timezone !== undefined) {
    return false;
  }

  if (duration) {
    if (columnType !== "duration" || !isBoundedNonEmptyString(metadata.durationUnits)) return false;
  } else if (metadata.durationUnits !== undefined) {
    return false;
  }
  return true;
}

function rSemanticType(storageType: string, classes: readonly string[]): ColumnType {
  if (storageType === "double" && sameStrings(classes, ["integer64"])) return "integer";
  if (storageType === "integer" && (sameStrings(classes, ["factor"]) || sameStrings(classes, ["ordered", "factor"]))) {
    return "string";
  }
  if (storageType === "double" && sameStrings(classes, ["Date"])) return "date";
  if (storageType === "double" && sameStrings(classes, ["POSIXct", "POSIXt"])) return "datetime";
  if (storageType === "double" && sameStrings(classes, ["difftime"])) return "duration";
  if (storageType === "logical" && sameStrings(classes, ["logical"])) return "boolean";
  if (storageType === "integer" && sameStrings(classes, ["integer"])) return "integer";
  if (storageType === "double" && sameStrings(classes, ["numeric"])) return "float";
  if (storageType === "character" && sameStrings(classes, ["character"])) return "string";
  if (storageType === "raw" && sameStrings(classes, ["raw"])) return "binary";
  if (storageType === "list" && (sameStrings(classes, ["list"]) || sameStrings(classes, ["AsIs"]))) return "list";
  return "unknown";
}

function isFrameMetadata(
  value: unknown,
  flavor: RFrameFlavor,
  schema: readonly ColumnSchema[]
): value is RFrameMetadata {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["classNames", "groupColumns", "keyColumns"]) ||
    !isStringArray(value.classNames) ||
    !sameStrings(value.classNames, FRAME_CLASSES[flavor])
  ) {
    return false;
  }

  const grouped = flavor === "grouped-tibble" || flavor === "rowwise-tibble";
  if (grouped) {
    if (!isColumnReferenceArray(value.groupColumns, schema) || value.keyColumns !== undefined) return false;
  } else if (value.groupColumns !== undefined) {
    return false;
  }
  if (flavor === "data.table") {
    if (value.keyColumns !== undefined && !isColumnReferenceArray(value.keyColumns, schema)) return false;
  } else if (value.keyColumns !== undefined) {
    return false;
  }
  return true;
}

function isColumnReferenceArray(value: unknown, schema: readonly ColumnSchema[]): value is readonly RColumnReference[] {
  if (!Array.isArray(value) || value.length > schema.length || value.length > MAX_TEXT_VECTOR_ITEMS) return false;
  const byId = new Map(schema.map((column) => [column.id, column]));
  const ids = new Set<string>();
  let nameBytes = 0;
  for (const reference of value) {
    if (
      !isRecord(reference) ||
      !hasExactKeys(reference, ["id", "name"]) ||
      !isBoundedNonEmptyString(reference.id) ||
      ids.has(reference.id) ||
      !isBoundedString(reference.name)
    ) {
      return false;
    }
    const column = byId.get(reference.id);
    if (column === undefined || column.name !== reference.name) return false;
    nameBytes += utf8ByteLength(reference.name)!;
    if (nameBytes > MAX_TEXT_VECTOR_BYTES) return false;
    ids.add(reference.id);
  }
  return true;
}

function isGridPage(value: unknown, schema: readonly ColumnSchema[], totalRows: number): value is GridPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["columnIds", "limit", "offset", "rows", "totalRows"]) ||
    !isSafeNonNegativeInteger(value.offset) ||
    !isSafePositiveInteger(value.limit) ||
    value.limit > MAX_PAGE_ROWS ||
    value.totalRows !== totalRows ||
    value.offset > totalRows ||
    !Array.isArray(value.columnIds) ||
    !Array.isArray(value.rows)
  ) {
    return false;
  }
  const schemaPositions = new Map(schema.map((column, position) => [column.id, position]));
  const projectedSchema: ColumnSchema[] = [];
  let previousPosition = -1;
  const projectedIds = new Set<string>();
  for (const columnId of value.columnIds) {
    if (!isBoundedNonEmptyString(columnId) || projectedIds.has(columnId)) return false;
    const position = schemaPositions.get(columnId);
    if (position === undefined || position <= previousPosition) return false;
    const column = schema[position];
    if (column === undefined) return false;
    previousPosition = position;
    projectedIds.add(columnId);
    projectedSchema.push(column);
  }
  if (value.columnIds.length > 0 && value.limit > Math.floor(MAX_PAGE_CELLS / value.columnIds.length)) {
    return false;
  }
  if (value.rows.length > value.limit || value.offset + value.rows.length > totalRows) return false;
  const rowIds = new Set<string>();
  for (let rowOffset = 0; rowOffset < value.rows.length; rowOffset += 1) {
    const row = value.rows[rowOffset];
    if (
      !isRecord(row) ||
      !hasExactKeys(row, ["id", "rowNumber", "values"]) ||
      !isBoundedNonEmptyString(row.id) ||
      rowIds.has(row.id) ||
      row.rowNumber !== value.offset + rowOffset ||
      !Array.isArray(row.values) ||
      row.values.length !== value.columnIds.length
    ) {
      return false;
    }
    for (let index = 0; index < row.values.length; index += 1) {
      const column = projectedSchema[index];
      if (column === undefined || !isCellValue(row.values[index], column)) return false;
    }
    rowIds.add(row.id);
  }
  return true;
}

function isCellValue(value: unknown, column: ColumnSchema): value is CellValue {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["display", "isNaN", "isNull", "kind", "raw", "sign"]) ||
    typeof value.kind !== "string" ||
    !CELL_KINDS.has(value.kind as CellValue["kind"]) ||
    !isBoundedString(value.display) ||
    typeof value.isNull !== "boolean" ||
    typeof value.isNaN !== "boolean"
  ) {
    return false;
  }
  if (value.kind === "null") {
    return (
      column.nullable &&
      value.display === "" &&
      value.isNull &&
      !value.isNaN &&
      value.sign === undefined &&
      value.raw === undefined
    );
  }
  if (value.kind === "nan") {
    return (
      NUMERIC_SPECIAL_TYPES.has(column.type) &&
      value.display === "NaN" &&
      !value.isNull &&
      value.isNaN &&
      value.sign === undefined &&
      value.raw === undefined
    );
  }
  if (value.kind === "infinity") {
    return (
      NUMERIC_SPECIAL_TYPES.has(column.type) &&
      !value.isNull &&
      !value.isNaN &&
      (value.sign === -1 || value.sign === 1) &&
      value.display === (value.sign === -1 ? "-Infinity" : "Infinity") &&
      value.raw === undefined
    );
  }
  if (value.isNull || value.isNaN || value.sign !== undefined || !Object.hasOwn(value, "raw")) return false;
  switch (value.kind) {
    case "boolean":
      return (
        column.type === "boolean" && typeof value.raw === "boolean" && value.display === (value.raw ? "TRUE" : "FALSE")
      );
    case "number":
      return column.type === "float" && typeof value.raw === "number" && Number.isFinite(value.raw);
    case "duration":
      return column.type === "duration" && typeof value.raw === "number" && Number.isFinite(value.raw);
    case "integer":
      return column.type === "integer" && isCanonicalRInteger(value.raw, value.display, column.rawType);
    case "string":
      return column.type === "string" && isBoundedString(value.raw) && value.display === value.raw;
    case "datetime":
      return (
        column.type === "datetime" &&
        isBoundedString(value.raw) &&
        value.display === value.raw &&
        /^-?\d+-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}$/u.test(value.raw)
      );
    case "date":
      return (
        column.type === "date" &&
        isBoundedString(value.raw) &&
        value.display === value.raw &&
        /^-?\d+-\d{2}-\d{2}$/u.test(value.raw)
      );
    case "binary":
      return (
        column.type === "binary" &&
        isBoundedString(value.raw) &&
        value.display === value.raw &&
        /^[0-9a-f]{2}$/u.test(value.raw)
      );
    case "list":
      return (
        column.type === "list" &&
        isBoundedString(value.raw) &&
        value.display === value.raw &&
        /^(?:<NULL>|<(?:logical|integer|double|complex|character)\[1\]: NA>|<double\[1\]: (?:NaN|-?Infinity)>|<list-value:[A-Za-z][A-Za-z0-9]*>)$/u.test(
          value.raw
        )
      );
    case "unknown":
      return (
        column.type === "unknown" &&
        isBoundedString(value.raw) &&
        value.display === value.raw &&
        value.raw === unknownRDisplay(column.rawType)
      );
    default:
      return false;
  }
}

function isCanonicalRInteger(raw: unknown, display: string, rawType: string): boolean {
  if (rawType === "integer<integer>") {
    return (
      typeof raw === "number" &&
      Number.isInteger(raw) &&
      raw >= -2_147_483_647 &&
      raw <= 2_147_483_647 &&
      display === String(raw)
    );
  }
  if (rawType !== "double<integer64>" || !isBoundedString(raw) || !/^-?(?:0|[1-9]\d*)$/u.test(raw)) {
    return false;
  }
  const parsed = BigInt(raw);
  return parsed >= -9_223_372_036_854_775_807n && parsed <= 9_223_372_036_854_775_807n && display === raw;
}

function unknownRDisplay(rawType: string): string | undefined {
  const separator = rawType.indexOf("<");
  if (separator <= 0 || !rawType.endsWith(">")) return undefined;
  return `<${rawType.slice(separator + 1, -1)}>`;
}

function isStringArray(
  value: unknown,
  maxItems = MAX_TEXT_VECTOR_ITEMS,
  maxBytes = MAX_TEXT_VECTOR_BYTES
): value is readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  let bytes = 0;
  for (const item of value) {
    if (!isBoundedString(item)) return false;
    bytes += utf8ByteLength(item)!;
    if (bytes > maxBytes) return false;
  }
  return true;
}

function isBoundedString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = utf8ByteLength(value);
  return bytes !== undefined && bytes <= MAX_TEXT_BYTES;
}

function isBoundedNonEmptyString(value: unknown): value is string {
  return isBoundedString(value) && value.length > 0;
}

function utf8ByteLength(value: string): number | undefined {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function hasBoundedTextGraph(value: unknown): boolean {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let bytes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (
      item === undefined ||
      typeof item === "bigint" ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      return false;
    }
    if (typeof item === "string") {
      const itemBytes = utf8ByteLength(item);
      if (itemBytes === undefined || itemBytes > MAX_TEXT_BYTES) return false;
      bytes += itemBytes;
      if (bytes > MAX_CONTRACT_TEXT_BYTES) return false;
    } else if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return false;
      seen.add(item);
      if (Array.isArray(item)) stack.push(...item);
      else stack.push(...Object.values(item));
    }
  }
  return true;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key));
}
