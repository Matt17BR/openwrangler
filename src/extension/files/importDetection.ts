import * as path from "node:path";
import type { SessionSource } from "../../shared/protocol";

export const IMPORT_DETECTION_SAMPLE_BYTES = 64 * 1024;

type ImportOptions = NonNullable<SessionSource["importOptions"]>;

const DELIMITERS = [",", "\t", ";", "|"] as const;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

interface ParsedSample {
  readonly rows: readonly (readonly string[])[];
  readonly quotedFields: number;
}

interface DelimiterCandidate {
  readonly delimiter: string;
  readonly quoteChar: string;
  readonly rows: readonly (readonly string[])[];
  readonly score: number;
}

export function detectedImportOptionsFromSample(filename: string, sample: Uint8Array): ImportOptions | undefined {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".xlsx" || extension === ".xls") return { sheetIndex: 0 };
  if (extension !== ".csv" && extension !== ".tsv") return undefined;

  const { text, encoding } = decodeSample(sample);
  const fallbackDelimiter = extension === ".tsv" ? "\t" : ",";
  const candidate = detectDialect(text, fallbackDelimiter);
  return {
    delimiter: candidate.delimiter,
    encoding,
    quoteChar: candidate.quoteChar,
    hasHeader: likelyHasHeader(candidate.rows)
  };
}

function decodeSample(sample: Uint8Array): { text: string; encoding: string } {
  const hasBom = UTF8_BOM.every((value, index) => sample[index] === value);
  const bytes = hasBom ? sample.subarray(UTF8_BOM.length) : sample;
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8"
    };
  } catch {
    // Invalid UTF-8 in delimited business exports is most commonly Windows-1252.
    // The runtime owns the full decode; this bounded detector only needs the
    // ASCII structural characters, which have the same byte values.
    return {
      text: new TextDecoder("windows-1252").decode(bytes),
      encoding: "windows-1252"
    };
  }
}

function detectDialect(text: string, fallbackDelimiter: string): DelimiterCandidate {
  const candidates = DELIMITERS.map((delimiter) => dialectCandidate(text, delimiter));
  const viable = candidates.filter(({ rows }) => rows.length >= 2 && rows[0]!.length >= 2);
  return (
    viable.sort((left, right) => right.score - left.score || delimiterOrder(left, right))[0] ?? {
      delimiter: fallbackDelimiter,
      quoteChar: '"',
      rows: parseDelimitedSample(text, fallbackDelimiter, '"').rows,
      score: 0
    }
  );
}

function dialectCandidate(text: string, delimiter: string): DelimiterCandidate {
  const standard = parseDelimitedSample(text, delimiter, '"');
  const single = parseDelimitedSample(text, delimiter, "'");
  // Apostrophes in ordinary prose must never make single quotes look like a
  // dialect. Require repeated, structurally valid single-quoted fields and an
  // advantage over standard CSV quoting before selecting it.
  const parsed =
    single.quotedFields >= 2 && single.quotedFields > standard.quotedFields && sampleScore(single.rows) > 0
      ? single
      : standard;
  const quoteChar = parsed === single ? "'" : '"';
  return {
    delimiter,
    quoteChar,
    rows: parsed.rows,
    score: sampleScore(parsed.rows) + Math.min(parsed.quotedFields, 20)
  };
}

function delimiterOrder(left: DelimiterCandidate, right: DelimiterCandidate): number {
  return (
    DELIMITERS.indexOf(left.delimiter as (typeof DELIMITERS)[number]) -
    DELIMITERS.indexOf(right.delimiter as (typeof DELIMITERS)[number])
  );
}

function sampleScore(rows: readonly (readonly string[])[]): number {
  if (rows.length < 2) return -1;
  const widths = new Map<number, number>();
  for (const row of rows.slice(0, 100)) widths.set(row.length, (widths.get(row.length) ?? 0) + 1);
  const [modeWidth, modeCount] = [...widths.entries()].sort(
    ([leftWidth, leftCount], [rightWidth, rightCount]) => rightCount - leftCount || rightWidth - leftWidth
  )[0] ?? [0, 0];
  if (modeWidth < 2) return -1;
  const inconsistent = Math.min(rows.length, 100) - modeCount;
  return modeCount * 1_000 + modeWidth * 10 - inconsistent * 2_000;
}

function parseDelimitedSample(text: string, delimiter: string, quoteChar: string): ParsedSample {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quotedField = false;
  let quotedFields = 0;

  const finishField = (): void => {
    row.push(field);
    field = "";
    if (quotedField) quotedFields += 1;
    quotedField = false;
  };
  const finishRow = (): void => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length && rows.length < 101; index += 1) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === quoteChar) {
        if (text[index + 1] === quoteChar) {
          field += quoteChar;
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === quoteChar && field.length === 0) {
      inQuotes = true;
      quotedField = true;
    } else if (character === delimiter) {
      finishField();
    } else if (character === "\n") {
      finishRow();
    } else if (character !== "\r") {
      field += character;
    }
  }

  // Keep a complete non-quoted final record even without a trailing newline.
  // A prefix-truncated record may be inconsistent, which scoring already
  // penalizes without discarding ordinary two-row files.
  if (!inQuotes && (field.length > 0 || row.length > 0)) finishRow();
  return { rows, quotedFields };
}

function likelyHasHeader(rows: readonly (readonly string[])[]): boolean {
  if (rows.length < 2) return true;
  const width = rows[0]!.length;
  const comparable = rows.slice(1, 21).filter((row) => row.length === width);
  if (width === 0 || comparable.length === 0) return true;

  const firstTypes = rows[0]!.map(cellType);
  if (firstTypes.every((type) => type === "number")) return false;
  let headerSignals = 0;
  for (let column = 0; column < width; column += 1) {
    const laterTypes = comparable.map((row) => cellType(row[column] ?? ""));
    const dominant = mode(laterTypes);
    if (firstTypes[column] === "text" && dominant !== "text" && dominant !== "empty") headerSignals += 1;
  }
  if (headerSignals > 0) return true;

  const allRowsAreTyped = [rows[0]!, ...comparable].every((row) =>
    row.every((cell) => {
      const type = cellType(cell);
      return type !== "text" && type !== "empty";
    })
  );
  return !allRowsAreTyped;
}

function cellType(value: string): "empty" | "number" | "boolean" | "date" | "text" {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "empty";
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(trimmed)) return "number";
  if (/^(?:true|false)$/iu.test(trimmed)) return "boolean";
  if (/^\d{4}-\d{2}-\d{2}(?:[T ][^\s]+)?$/u.test(trimmed)) return "date";
  return "text";
}

function mode<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}
