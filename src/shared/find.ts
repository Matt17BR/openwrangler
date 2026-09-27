import type { CellValue, ColumnType } from "./protocol";

export const MAX_FIND_QUERY_CODE_POINTS = 1_024;

export interface FindOptions {
  readonly text: string;
  readonly matchCase: boolean;
  readonly wholeCell: boolean;
}

export function isFindQuery(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isFindReplacement(value);
}

/** Replacement text has the query's bounds but may be empty. */
export function isFindReplacement(value: unknown): value is string {
  if (typeof value !== "string" || /\p{Cs}/u.test(value)) return false;
  let codePoints = 0;
  for (const _codePoint of value) {
    codePoints += 1;
    if (codePoints > MAX_FIND_QUERY_CODE_POINTS) return false;
  }
  return true;
}

function foldAscii(text: string): string {
  return text.replace(/[A-Z]+/gu, (letters) => letters.toLowerCase());
}

/**
 * Whether a cell's display matches Find the way every runtime decides it. Without match case only ASCII letters
 * fold, datetime cells also match with a space for their T, and missing, NaN and nested cells never match.
 */
export function cellMatchesFind(cell: CellValue, columnType: ColumnType, options: FindOptions): boolean {
  if (cell.isNull || cell.isNaN || columnType === "list" || columnType === "struct") return false;
  let needle = options.matchCase ? options.text : foldAscii(options.text);
  let display = options.matchCase ? cell.display : foldAscii(cell.display);
  if (columnType === "datetime") {
    needle = needle.replace(options.matchCase ? /(?<![A-Za-z])T(?![A-Za-z])/gu : /(?<![a-z])t(?![a-z])/gu, " ");
    display = display.replaceAll(options.matchCase ? "T" : "t", " ");
  }
  return options.wholeCell ? display === needle : display.includes(needle);
}

const FIND_CHARACTERS: ReadonlyMap<ColumnType, ReadonlySet<string>> = new Map([
  ["integer", new Set("0123456789-")],
  ["float", new Set("0123456789-+.eEinfinityINFINITY")],
  ["boolean", new Set("truefalsTRUEFALS")],
  ["date", new Set("0123456789-:.+ Tt")],
  ["datetime", new Set("0123456789-:.+ Tt")]
]);

/** Whether a displayed value of this type can contain the text at all; the runtimes skip other columns alike. */
export function findCouldMatch(columnType: ColumnType, text: string): boolean {
  if (columnType === "list" || columnType === "struct") return false;
  const allowed = FIND_CHARACTERS.get(columnType);
  if (allowed === undefined) return true;
  for (const character of text) if (!allowed.has(character)) return false;
  return true;
}

/** Column types whose display text Replace can parse back into the column. */
export const REPLACEABLE_COLUMN_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>([
  "string",
  "integer",
  "float",
  "boolean",
  "decimal",
  "date",
  "datetime"
]);

/**
 * Whether every Python and R engine shows the same text in the cells this Replace can match. Among floats they spell
 * only infinities differently, which a search of digits and signs never reaches; booleans read True in Python and
 * TRUE in R, which only a whole-cell search that ignores case treats alike.
 */
export function replaceMatchesIsPortable(columnType: ColumnType, options: FindOptions): boolean {
  if (columnType === "string" || columnType === "integer" || columnType === "date") return true;
  if (columnType === "float") return /^[0-9.+\-eE]+$/u.test(options.text);
  return columnType === "boolean" && options.wholeCell && !options.matchCase;
}
