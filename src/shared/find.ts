import type { CellValue, ColumnType } from "./protocol";

export const MAX_FIND_QUERY_CODE_POINTS = 1_024;

export interface FindOptions {
  readonly text: string;
  readonly matchCase: boolean;
  readonly wholeCell: boolean;
}

export function isFindQuery(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || /\p{Cs}/u.test(value)) return false;
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
