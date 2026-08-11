export const R_FRAME_CONTRACT_VERSION = 5 as const;

export const R_FRAME_CONTRACT_LIMITS = Object.freeze({
  rows: 2_147_483_647,
  columns: 2_048,
  pageRows: 1_000,
  pageColumns: 256,
  pageCells: 100_000,
  filters: 64,
  predicatesPerFilter: 64,
  selectedValuesPerFilter: 10_000,
  sortRules: 64,
  profileColumns: 64,
  profileSampleRows: 100_000,
  profileChunkRows: 65_536,
  datasetDuplicateSampleRows: 100_000,
  datasetDuplicateSampleCells: 5_000_000,
  topValues: 10,
  histogramBins: 20,
  factorLevels: 100_000,
  textBytes: 8_192,
  nameBytes: 1_024,
  stepIdBytes: 1_024,
  columnIdBytes: 2_048,
  payloadBytes: 16 * 1_024 * 1_024
});

export type RDataframeFlavor = "r.data.frame" | "r.tibble" | "r.data.table";
export type RColumnType = "string" | "integer" | "float" | "boolean" | "datetime" | "date" | "duration";
export type RColumnKind =
  "logical" | "integer" | "double" | "character" | "factor" | "date" | "datetime" | "difftime" | "integer64";

interface RSimpleColumnSemantics {
  readonly kind: "logical" | "integer" | "double" | "character" | "date" | "integer64";
  readonly storageMode: "logical" | "integer" | "double" | "character";
  readonly classes: readonly string[];
}

export interface RFactorColumnSemantics {
  readonly kind: "factor";
  readonly storageMode: "integer";
  readonly classes: readonly string[];
  readonly levels: readonly string[];
  readonly ordered: boolean;
}

export interface RDatetimeColumnSemantics {
  readonly kind: "datetime";
  readonly storageMode: "double";
  readonly classes: readonly ["POSIXct", "POSIXt"];
  readonly timezone: string | null;
}

export interface RDurationColumnSemantics {
  readonly kind: "difftime";
  readonly storageMode: "double";
  readonly classes: readonly ["difftime"];
  readonly units: "secs" | "mins" | "hours" | "days" | "weeks";
}

export type RColumnSemantics =
  RSimpleColumnSemantics | RFactorColumnSemantics | RDatetimeColumnSemantics | RDurationColumnSemantics;

export interface RColumnSchema {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly rawType: string;
  readonly type: RColumnType;
  readonly nullable: boolean;
  readonly semantics: RColumnSemantics;
}

export type RFrameCell =
  | {
      readonly kind: "null";
      readonly raw: null;
      readonly display: "NA";
      readonly isNull: true;
      readonly isNaN: false;
    }
  | {
      readonly kind: "nan";
      readonly raw: null;
      readonly display: "NaN";
      readonly isNull: false;
      readonly isNaN: true;
    }
  | {
      readonly kind: "infinity";
      readonly raw: null;
      readonly display: "Inf" | "-Inf";
      readonly isNull: false;
      readonly isNaN: false;
      readonly sign: -1 | 1;
    }
  | {
      readonly kind: "boolean";
      readonly raw: boolean;
      readonly display: "TRUE" | "FALSE";
      readonly isNull: false;
      readonly isNaN: false;
    }
  | {
      readonly kind: "integer" | "number" | "string" | "datetime" | "date" | "duration";
      readonly raw: string;
      readonly display: string;
      readonly isNull: false;
      readonly isNaN: false;
    };

export interface RFrameRow {
  readonly id: string;
  readonly rowNumber: number;
  readonly rowLabel?: string;
  readonly values: readonly RFrameCell[];
}

export interface RFramePage {
  readonly offset: number;
  readonly limit: number;
  readonly totalRows: number;
  readonly columnOffset: number;
  readonly columnLimit: number;
  readonly columnIds: readonly string[];
  readonly rows: readonly RFrameRow[];
}

export interface RFramePageContract {
  readonly contractVersion: typeof R_FRAME_CONTRACT_VERSION;
  readonly dataframeFlavor: RDataframeFlavor;
  readonly shape: Readonly<{ rows: number; columns: number }>;
  readonly frameSemantics: Readonly<{
    classes: readonly string[];
    rowNames: "positional" | "explicit";
    keyColumnIds: readonly string[];
  }>;
  readonly schema: readonly RColumnSchema[];
  readonly page: RFramePage;
}

const exactIntegerPattern = /^-?(?:0|[1-9][0-9]*)$/u;
const sourceColumnIdPattern = /^r:c:(0|[1-9][0-9]*)$/u;
const derivedColumnIdPattern = /^c:step:([\s\S]+):(0|[1-9][0-9]*)$/u;
const privateRowIdPrefix = "__open_wrangler_internal_row_id_";
const finiteNumberPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/iu;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const signedInteger64Minimum = -(1n << 63n);
const signedInteger64Maximum = (1n << 63n) - 1n;
const posixClasses = Object.freeze(["POSIXct", "POSIXt"] as const);
const difftimeClasses = Object.freeze(["difftime"] as const);

const flavorClasses: Readonly<Record<RDataframeFlavor, readonly string[]>> = Object.freeze({
  "r.data.frame": Object.freeze(["data.frame"]),
  "r.tibble": Object.freeze(["tbl_df", "tbl", "data.frame"]),
  "r.data.table": Object.freeze(["data.table", "data.frame"])
});

const simpleSemantics = Object.freeze({
  logical: Object.freeze({
    storageMode: "logical",
    classes: Object.freeze(["logical"]),
    rawType: "logical",
    type: "boolean"
  }),
  integer: Object.freeze({
    storageMode: "integer",
    classes: Object.freeze(["integer"]),
    rawType: "integer",
    type: "integer"
  }),
  double: Object.freeze({
    storageMode: "double",
    classes: Object.freeze(["numeric"]),
    rawType: "double",
    type: "float"
  }),
  character: Object.freeze({
    storageMode: "character",
    classes: Object.freeze(["character"]),
    rawType: "character",
    type: "string"
  }),
  date: Object.freeze({
    storageMode: "double",
    classes: Object.freeze(["Date"]),
    rawType: "Date",
    type: "date"
  }),
  integer64: Object.freeze({
    storageMode: "double",
    classes: Object.freeze(["integer64"]),
    rawType: "integer64",
    type: "integer"
  })
} as const);

export function decodeRFramePageJson(payload: string): RFramePageContract {
  if (typeof payload !== "string") throw new TypeError("R frame payload must be a string.");
  if (Buffer.byteLength(payload, "utf8") > R_FRAME_CONTRACT_LIMITS.payloadBytes) {
    throw new TypeError("R frame payload exceeds the byte limit.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload) as unknown;
  } catch {
    throw new TypeError("R frame payload is not valid JSON.");
  }
  return decodeRFramePage(decoded);
}

export function decodeRFramePage(value: unknown): RFramePageContract {
  const record = exactRecord(value, [
    "contractVersion",
    "dataframeFlavor",
    "shape",
    "frameSemantics",
    "schema",
    "page"
  ]);
  if (record.contractVersion !== R_FRAME_CONTRACT_VERSION) fail("Unsupported R frame contract version.");
  const dataframeFlavor = decodeFlavor(record.dataframeFlavor);
  const shapeRecord = exactRecord(record.shape, ["rows", "columns"]);
  const shape = Object.freeze({
    rows: boundedInteger(shapeRecord.rows, "shape.rows", R_FRAME_CONTRACT_LIMITS.rows),
    columns: boundedInteger(shapeRecord.columns, "shape.columns", R_FRAME_CONTRACT_LIMITS.columns)
  });

  if (!Array.isArray(record.schema) || record.schema.length !== shape.columns) {
    fail("R frame schema width does not match shape.columns.");
  }
  const schema = Object.freeze(record.schema.map((column, position) => decodeColumn(column, position)));
  const ids = new Set(schema.map((column) => column.id));
  if (ids.size !== schema.length) fail("R frame column IDs must be unique.");

  const frameRecord = exactRecord(record.frameSemantics, ["classes", "rowNames", "keyColumnIds"]);
  const classes = decodeStringArray(frameRecord.classes, "frameSemantics.classes", R_FRAME_CONTRACT_LIMITS.nameBytes);
  if (!arraysEqual(classes, flavorClasses[dataframeFlavor])) {
    fail("R frame classes do not match dataframeFlavor.");
  }
  if (frameRecord.rowNames !== "positional" && frameRecord.rowNames !== "explicit") {
    fail("R frame row-name semantics are unsupported.");
  }
  const keyColumnIds = decodeStringArray(
    frameRecord.keyColumnIds,
    "frameSemantics.keyColumnIds",
    R_FRAME_CONTRACT_LIMITS.columnIdBytes
  );
  if (new Set(keyColumnIds).size !== keyColumnIds.length || keyColumnIds.some((id) => !ids.has(id))) {
    fail("R frame keyColumnIds must be unique schema IDs.");
  }
  if (dataframeFlavor !== "r.data.table" && keyColumnIds.length !== 0) {
    fail("Only data.table frames may publish key columns.");
  }
  const frameSemantics = Object.freeze({ classes, rowNames: frameRecord.rowNames, keyColumnIds });

  const page = decodePage(record.page, shape, schema, frameSemantics.rowNames);
  return Object.freeze({
    contractVersion: R_FRAME_CONTRACT_VERSION,
    dataframeFlavor,
    shape,
    frameSemantics,
    schema,
    page
  });
}

function decodeColumn(value: unknown, position: number): RColumnSchema {
  const record = exactRecord(value, ["id", "name", "position", "rawType", "type", "nullable", "semantics"]);
  const id = boundedString(record.id, `schema[${position}].id`, R_FRAME_CONTRACT_LIMITS.columnIdBytes);
  const sourceIdMatch = sourceColumnIdPattern.exec(id);
  const derivedIdMatch = id.includes("\u0000") ? null : derivedColumnIdPattern.exec(id);
  if (derivedIdMatch && Buffer.byteLength(derivedIdMatch[1] as string, "utf8") > R_FRAME_CONTRACT_LIMITS.stepIdBytes) {
    fail(`schema[${position}].id contains an oversized step identity.`);
  }
  const ordinal = sourceIdMatch ? Number(sourceIdMatch[1]) : derivedIdMatch ? Number(derivedIdMatch[2]) : -1;
  if (ordinal < 0 || ordinal >= R_FRAME_CONTRACT_LIMITS.columns) {
    fail(`schema[${position}].id is not a stable R column ID.`);
  }
  if (record.position !== position) fail(`schema[${position}].position is not contiguous.`);
  const name = boundedString(record.name, `schema[${position}].name`, R_FRAME_CONTRACT_LIMITS.nameBytes);
  if (name.toLowerCase().startsWith(privateRowIdPrefix)) {
    fail(`schema[${position}].name uses Open Wrangler's private row-identity prefix.`);
  }
  const rawType = boundedString(record.rawType, `schema[${position}].rawType`, R_FRAME_CONTRACT_LIMITS.nameBytes);
  if (typeof record.nullable !== "boolean") fail(`schema[${position}].nullable must be boolean.`);
  const semantics = decodeColumnSemantics(record.semantics, `schema[${position}].semantics`);
  const expected = expectedColumnIdentity(semantics);
  if (rawType !== expected.rawType || record.type !== expected.type) {
    fail(`schema[${position}] type metadata does not match its R semantics.`);
  }
  return Object.freeze({
    id,
    name,
    position,
    rawType,
    type: expected.type,
    nullable: record.nullable,
    semantics
  });
}

function decodeColumnSemantics(value: unknown, label: string): RColumnSemantics {
  if (!isRecord(value) || typeof value.kind !== "string") fail(`${label} must identify an R column kind.`);
  const kind = value.kind;
  if (isSimpleKind(kind)) {
    const record = exactRecord(value, ["kind", "storageMode", "classes"]);
    const expected = simpleSemantics[kind];
    if (record.storageMode !== expected.storageMode) fail(`${label}.storageMode does not match ${kind}.`);
    const classes = decodeStringArray(record.classes, `${label}.classes`, R_FRAME_CONTRACT_LIMITS.nameBytes);
    if (!arraysEqual(classes, expected.classes)) fail(`${label}.classes do not match ${kind}.`);
    return Object.freeze({ kind, storageMode: expected.storageMode, classes });
  }
  if (kind === "factor") {
    const record = exactRecord(value, ["kind", "storageMode", "classes", "levels", "ordered"]);
    if (record.storageMode !== "integer" || typeof record.ordered !== "boolean") {
      fail(`${label} has invalid factor metadata.`);
    }
    const classes = decodeStringArray(record.classes, `${label}.classes`, R_FRAME_CONTRACT_LIMITS.nameBytes);
    const expectedClasses = record.ordered ? ["ordered", "factor"] : ["factor"];
    if (!arraysEqual(classes, expectedClasses)) fail(`${label}.classes do not match factor ordering.`);
    const levels = decodeStringArray(
      record.levels,
      `${label}.levels`,
      R_FRAME_CONTRACT_LIMITS.textBytes,
      R_FRAME_CONTRACT_LIMITS.factorLevels
    );
    if (new Set(levels).size !== levels.length) fail(`${label}.levels must be unique.`);
    return Object.freeze({ kind, storageMode: "integer", classes, levels, ordered: record.ordered });
  }
  if (kind === "datetime") {
    const record = exactRecord(value, ["kind", "storageMode", "classes", "timezone"]);
    if (record.storageMode !== "double") fail(`${label}.storageMode does not match datetime.`);
    const classes = decodeStringArray(record.classes, `${label}.classes`, R_FRAME_CONTRACT_LIMITS.nameBytes);
    if (!arraysEqual(classes, ["POSIXct", "POSIXt"])) fail(`${label}.classes do not match POSIXct.`);
    const timezone =
      record.timezone === null
        ? null
        : boundedString(record.timezone, `${label}.timezone`, R_FRAME_CONTRACT_LIMITS.nameBytes);
    return Object.freeze({ kind, storageMode: "double", classes: posixClasses, timezone });
  }
  if (kind === "difftime") {
    const record = exactRecord(value, ["kind", "storageMode", "classes", "units"]);
    if (record.storageMode !== "double") fail(`${label}.storageMode does not match difftime.`);
    const classes = decodeStringArray(record.classes, `${label}.classes`, R_FRAME_CONTRACT_LIMITS.nameBytes);
    if (!arraysEqual(classes, ["difftime"])) fail(`${label}.classes do not match difftime.`);
    if (!isDurationUnit(record.units)) fail(`${label}.units are unsupported.`);
    return Object.freeze({ kind, storageMode: "double", classes: difftimeClasses, units: record.units });
  }
  fail(`${label}.kind is unsupported.`);
}

function expectedColumnIdentity(semantics: RColumnSemantics): { rawType: string; type: RColumnType } {
  if (isSimpleKind(semantics.kind)) return simpleSemantics[semantics.kind];
  if (semantics.kind === "factor") {
    return { rawType: semantics.ordered ? "ordered factor" : "factor", type: "string" };
  }
  if (semantics.kind === "datetime") return { rawType: "POSIXct", type: "datetime" };
  return { rawType: "difftime", type: "duration" };
}

function decodePage(
  value: unknown,
  shape: Readonly<{ rows: number; columns: number }>,
  schema: readonly RColumnSchema[],
  rowNames: "positional" | "explicit"
): RFramePage {
  const record = exactRecord(value, [
    "offset",
    "limit",
    "totalRows",
    "columnOffset",
    "columnLimit",
    "columnIds",
    "rows"
  ]);
  const offset = boundedInteger(record.offset, "page.offset", shape.rows);
  const limit = boundedInteger(record.limit, "page.limit", R_FRAME_CONTRACT_LIMITS.pageRows);
  const totalRows = boundedInteger(record.totalRows, "page.totalRows", R_FRAME_CONTRACT_LIMITS.rows);
  const columnOffset = boundedInteger(record.columnOffset, "page.columnOffset", shape.columns);
  const columnLimit = boundedInteger(record.columnLimit, "page.columnLimit", R_FRAME_CONTRACT_LIMITS.pageColumns);
  if (totalRows > shape.rows) fail("page.totalRows exceeds the source shape.");
  const expectedColumns = schema.slice(columnOffset, Math.min(shape.columns, columnOffset + columnLimit));
  const columnIds = decodeStringArray(record.columnIds, "page.columnIds", R_FRAME_CONTRACT_LIMITS.columnIdBytes);
  if (
    !arraysEqual(
      columnIds,
      expectedColumns.map((column) => column.id)
    )
  ) {
    fail("page.columnIds do not match the requested schema projection.");
  }
  if (!Array.isArray(record.rows)) fail("page.rows must be an array.");
  if (offset > totalRows) fail("page.offset exceeds the filtered row count.");
  const expectedRowCount = Math.min(limit, totalRows - offset);
  if (record.rows.length !== expectedRowCount) fail("page.rows does not match the requested row window.");
  if (record.rows.length * columnIds.length > R_FRAME_CONTRACT_LIMITS.pageCells) {
    fail("R frame page exceeds the cell limit.");
  }
  const rows = Object.freeze(
    record.rows.map((row, index) =>
      decodeRow(row, shape.rows, totalRows, offset + index, expectedColumns, rowNames, `page.rows[${index}]`)
    )
  );
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    fail("R frame page row identities must be unique.");
  }
  return Object.freeze({ offset, limit, totalRows, columnOffset, columnLimit, columnIds, rows });
}

function decodeRow(
  value: unknown,
  sourceRows: number,
  visibleRows: number,
  expectedRowNumber: number,
  columns: readonly RColumnSchema[],
  rowNames: "positional" | "explicit",
  label: string
): RFrameRow {
  const record = exactRecord(value, ["id", "rowNumber", "values"], ["rowLabel"]);
  const rowNumber = boundedInteger(record.rowNumber, `${label}.rowNumber`, Math.max(0, visibleRows - 1));
  if (rowNumber !== expectedRowNumber) {
    fail(`${label}.rowNumber is not the logical grid position.`);
  }
  const id = boundedString(record.id, `${label}.id`, R_FRAME_CONTRACT_LIMITS.nameBytes);
  const sourceMatch = /^r:r:(0|[1-9][0-9]*)$/.exec(id);
  const sourcePosition = sourceMatch ? Number(sourceMatch[1]) : Number.NaN;
  if (!Number.isSafeInteger(sourcePosition) || sourcePosition < 0 || sourcePosition >= sourceRows) {
    fail(`${label}.id is not an in-range stable source row identity.`);
  }
  const hasRowLabel = Object.prototype.hasOwnProperty.call(record, "rowLabel");
  if (rowNames === "positional" && hasRowLabel) fail(`${label}.rowLabel is invalid for positional row names.`);
  if (rowNames === "explicit" && !hasRowLabel) fail(`${label}.rowLabel is required for explicit row names.`);
  const rowLabel = hasRowLabel
    ? boundedString(record.rowLabel, `${label}.rowLabel`, R_FRAME_CONTRACT_LIMITS.nameBytes)
    : undefined;
  if (!Array.isArray(record.values) || record.values.length !== columns.length) {
    fail(`${label}.values does not match page.columnIds.`);
  }
  const values = Object.freeze(
    record.values.map((cell, index) => decodeCell(cell, columns[index] as RColumnSchema, `${label}.values[${index}]`))
  );
  return Object.freeze({ id, rowNumber, ...(rowLabel === undefined ? {} : { rowLabel }), values });
}

function decodeCell(value: unknown, column: RColumnSchema, label: string): RFrameCell {
  if (!isRecord(value) || typeof value.kind !== "string") fail(`${label} must identify a cell kind.`);
  if (value.kind === "infinity") {
    const record = exactRecord(value, ["kind", "raw", "display", "isNull", "isNaN", "sign"]);
    const sign = record.sign;
    const display = sign === -1 ? "-Inf" : "Inf";
    if (
      column.semantics.kind !== "double" ||
      record.raw !== null ||
      record.isNull !== false ||
      record.isNaN !== false ||
      (sign !== -1 && sign !== 1) ||
      record.display !== display
    ) {
      fail(`${label} has invalid infinity metadata.`);
    }
    return Object.freeze({
      kind: "infinity",
      raw: null,
      display,
      isNull: false,
      isNaN: false,
      sign
    });
  }
  const record = exactRecord(value, ["kind", "raw", "display", "isNull", "isNaN"]);
  if (record.kind === "null") {
    if (
      !column.nullable ||
      record.raw !== null ||
      record.display !== "NA" ||
      record.isNull !== true ||
      record.isNaN !== false
    ) {
      fail(`${label} has invalid NA metadata.`);
    }
    return Object.freeze({ kind: "null", raw: null, display: "NA", isNull: true, isNaN: false });
  }
  if (record.kind === "nan") {
    if (
      column.semantics.kind !== "double" ||
      record.raw !== null ||
      record.display !== "NaN" ||
      record.isNull !== false ||
      record.isNaN !== true
    ) {
      fail(`${label} has invalid NaN metadata.`);
    }
    return Object.freeze({ kind: "nan", raw: null, display: "NaN", isNull: false, isNaN: true });
  }
  if (record.isNull !== false || record.isNaN !== false) fail(`${label} has inconsistent missing-value flags.`);
  const display = boundedString(record.display, `${label}.display`, R_FRAME_CONTRACT_LIMITS.textBytes);
  const expectedKind = expectedCellKind(column.semantics.kind);
  if (record.kind !== expectedKind) fail(`${label}.kind does not match its R column.`);

  if (expectedKind === "boolean") {
    if (typeof record.raw !== "boolean" || display !== (record.raw ? "TRUE" : "FALSE")) {
      fail(`${label} has invalid logical data.`);
    }
    return Object.freeze({ kind: "boolean", raw: record.raw, display, isNull: false, isNaN: false });
  }

  const raw = boundedString(record.raw, `${label}.raw`, R_FRAME_CONTRACT_LIMITS.textBytes);
  validateRawValue(raw, column.semantics, label);
  return Object.freeze({ kind: expectedKind, raw, display, isNull: false, isNaN: false });
}

function expectedCellKind(kind: RColumnKind): Exclude<RFrameCell["kind"], "null" | "nan" | "infinity"> {
  switch (kind) {
    case "logical":
      return "boolean";
    case "integer":
    case "integer64":
      return "integer";
    case "double":
      return "number";
    case "character":
    case "factor":
      return "string";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "difftime":
      return "duration";
  }
}

function validateRawValue(raw: string, semantics: RColumnSemantics, label: string): void {
  if (semantics.kind === "integer") {
    if (!exactIntegerPattern.test(raw)) fail(`${label}.raw is not an exact R integer.`);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < -2_147_483_647 || value > 2_147_483_647) {
      fail(`${label}.raw is outside the R integer range.`);
    }
    return;
  }
  if (semantics.kind === "integer64") {
    if (!exactIntegerPattern.test(raw)) fail(`${label}.raw is not an exact integer64 value.`);
    const value = BigInt(raw);
    if (value <= signedInteger64Minimum || value > signedInteger64Maximum) {
      fail(`${label}.raw is outside the signed integer64 range.`);
    }
    return;
  }
  if (semantics.kind === "double" || semantics.kind === "datetime" || semantics.kind === "difftime") {
    if (!finiteNumberPattern.test(raw) || !Number.isFinite(Number(raw))) {
      fail(`${label}.raw is not a finite R double.`);
    }
    return;
  }
  if (semantics.kind === "factor" && !semantics.levels.includes(raw)) {
    fail(`${label}.raw is not one of the factor levels.`);
  }
  if (semantics.kind === "date" && !isValidIsoDate(raw)) fail(`${label}.raw is not a valid ISO date.`);
}

function isValidIsoDate(value: string): boolean {
  const match = isoDatePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  return day <= (daysInMonth[month - 1] as number);
}

function decodeFlavor(value: unknown): RDataframeFlavor {
  if (value === "r.data.frame" || value === "r.tibble" || value === "r.data.table") return value;
  fail("R frame dataframeFlavor is unsupported.");
}

function isSimpleKind(value: string): value is keyof typeof simpleSemantics {
  return Object.prototype.hasOwnProperty.call(simpleSemantics, value);
}

function isDurationUnit(value: unknown): value is RDurationColumnSemantics["units"] {
  return value === "secs" || value === "mins" || value === "hours" || value === "days" || value === "weeks";
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(`${label} must be a whole number from 0 through ${maximum}.`);
  }
  return value as number;
}

function boundedString(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || !hasValidUnicodeScalars(value) || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail(`${label} must be a bounded UTF-8 string.`);
  }
  return value;
}

function hasValidUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function decodeStringArray(
  value: unknown,
  label: string,
  maximumBytes: number,
  maximumItems = Number.MAX_SAFE_INTEGER
): readonly string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length > maximumItems) fail(`${label} has too many items.`);
  return Object.freeze(value.map((item, index) => boundedString(item, `${label}[${index}]`, maximumBytes)));
}

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> {
  if (!isRecord(value)) fail("R frame value must be an object.");
  const actual = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    actual.some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    fail("R frame object has missing or unknown fields.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(message: string): never {
  throw new TypeError(message);
}
