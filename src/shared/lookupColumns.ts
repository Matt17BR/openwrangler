import type { ColumnType, LookupFile, LookupFileColumn } from "./protocol.generated";

export const MAX_LOOKUP_KEYS = 8;
export const MAX_LOOKUP_OUTPUTS = 64;
export const MAX_LOOKUP_PATH_CHARACTERS = 4096;
export const MAX_LOOKUP_DESCRIBED_COLUMNS = 2048;

export const LOOKUP_KEY_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>(["string", "integer", "boolean", "date"]);

/** Types a looked-up column may have; lists, structs and other nested values can't be added. */
export const LOOKUP_OUTPUT_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "duration"
]);

export const LOOKUP_FILE_EXTENSIONS: Readonly<Record<LookupFile["format"], readonly string[]>> = Object.freeze({
  csv: Object.freeze([".csv"]),
  tsv: Object.freeze([".tsv"]),
  parquet: Object.freeze([".parquet"]),
  jsonl: Object.freeze([".jsonl", ".ndjson"])
});

export const LOOKUP_FILE_FORMATS = Object.freeze(Object.keys(LOOKUP_FILE_EXTENSIONS) as LookupFile["format"][]);

/** The format a lookup file's extension selects, or undefined when Look up columns can't read it. */
export function lookupFileFormat(path: string): LookupFile["format"] | undefined {
  const lower = path.toLowerCase();
  return LOOKUP_FILE_FORMATS.find((format) =>
    LOOKUP_FILE_EXTENSIONS[format].some((extension) => lower.endsWith(extension))
  );
}

/**
 * Whether a path is absolute on POSIX or Windows. The host can't know the runtime's platform, so the runtime still
 * refuses a path its own platform doesn't treat as absolute.
 */
export function isAbsoluteLookupPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(path);
}

export function isLookupFilePath(path: string, format: LookupFile["format"]): boolean {
  return (
    path.length > 0 &&
    Array.from(path).length <= MAX_LOOKUP_PATH_CHARACTERS &&
    !path.includes("\0") &&
    isAbsoluteLookupPath(path) &&
    lookupFileFormat(path) === format
  );
}

/** What the host reports after the webview asks it to choose or describe a lookup file. */
export type LookupFileState =
  | { status: "cancelled" }
  | { status: "failed"; message: string }
  | { status: "described"; file: LookupFile; columns: LookupFileColumn[]; rowCount: number };

export const MAX_LOOKUP_FAILURE_MESSAGE_CHARACTERS = 2048;
