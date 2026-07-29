import * as path from "node:path";
import * as vscode from "vscode";
import type { DataBackend, SessionSource } from "../../shared/protocol";

type ImportOptions = NonNullable<SessionSource["importOptions"]>;

interface ConfirmedFileConfigurationEntry {
  readonly uri: string;
  readonly backend: DataBackend;
  readonly backendPreference: DataBackend | "auto";
  readonly importOptions?: ImportOptions;
}

interface ConfirmedFileConfigurationsRegistry {
  readonly version: 2;
  readonly entries: ConfirmedFileConfigurationEntry[];
}

export interface ConfirmedFileConfiguration {
  readonly backend: DataBackend;
  readonly backendPreference: DataBackend | "auto";
  readonly importOptions?: ImportOptions;
}

export const CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY = "openWrangler.confirmedFileConfigurations.v2";
export const MAX_CONFIRMED_FILE_CONFIGURATIONS = 128;

const writeTails = new WeakMap<object, Promise<void>>();

/**
 * Returns the most recently confirmed source configuration and resolved
 * backend for one exact canonical file URI. Invalid or format-incompatible
 * workspace state is ignored rather than entering a runtime request.
 */
export function confirmedFileConfiguration(
  workspaceState: Pick<vscode.Memento, "get"> | undefined,
  uri: vscode.Uri
): ConfirmedFileConfiguration | undefined {
  if (!workspaceState) return undefined;
  const canonicalUri = uri.toString();
  const entries = decodeRegistry(workspaceState.get<unknown>(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.uri === canonicalUri) {
      return {
        backend: entry.backend,
        backendPreference: entry.backendPreference,
        ...(entry.importOptions ? { importOptions: cloneImportOptions(entry.importOptions) } : {})
      };
    }
  }
  return undefined;
}

/**
 * Records a file configuration only after the caller has received a correlated
 * sessionOpened response. The resolved backend is retained so custom-editor
 * recreation cannot reinterpret saved state after engine availability or the
 * default-backend setting changes.
 */
export function rememberConfirmedFileConfiguration(
  workspaceState: Pick<vscode.Memento, "get" | "update"> | undefined,
  uri: vscode.Uri,
  importOptions: SessionSource["importOptions"],
  backend: DataBackend,
  backendPreference: DataBackend | "auto"
): Promise<void> {
  if (!workspaceState) return Promise.resolve();
  const owner = workspaceState as object;
  const previous = writeTails.get(owner) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const canonicalUri = uri.toString();
      const entries = decodeRegistry(workspaceState.get<unknown>(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY));
      const confirmed = decodeFileConfiguration(uri, backend, backendPreference, importOptions);
      if (!confirmed) return;
      const retained = entries.filter((entry) => entry.uri !== canonicalUri);
      retained.push({ uri: canonicalUri, ...confirmed });
      const bounded = retained.slice(-MAX_CONFIRMED_FILE_CONFIGURATIONS);
      if (sameRegistry(entries, bounded)) return;
      const registry: ConfirmedFileConfigurationsRegistry = { version: 2, entries: bounded };
      await workspaceState.update(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, registry);
    });
  writeTails.set(owner, next);
  void next.then(
    () => {
      if (writeTails.get(owner) === next) writeTails.delete(owner);
    },
    () => {
      if (writeTails.get(owner) === next) writeTails.delete(owner);
    }
  );
  return next;
}

function decodeRegistry(value: unknown): ConfirmedFileConfigurationEntry[] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "entries"]) ||
    value.version !== 2 ||
    !Array.isArray(value.entries)
  ) {
    return [];
  }
  const decoded: ConfirmedFileConfigurationEntry[] = [];
  const candidates = value.entries.slice(-MAX_CONFIRMED_FILE_CONFIGURATIONS);
  for (const candidate of candidates) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["uri", "backend", "backendPreference"], ["importOptions"]) ||
      typeof candidate.uri !== "string" ||
      candidate.uri.length === 0 ||
      !isDataBackend(candidate.backend) ||
      !isBackendPreference(candidate.backendPreference)
    ) {
      continue;
    }
    const uri = parseCanonicalUri(candidate.uri);
    if (!uri) continue;
    const configuration = decodeFileConfiguration(
      uri,
      candidate.backend,
      candidate.backendPreference,
      candidate.importOptions
    );
    if (
      !configuration ||
      requiresImportOptions(uri) !== Object.prototype.hasOwnProperty.call(candidate, "importOptions")
    ) {
      continue;
    }
    decoded.push({ uri: candidate.uri, ...configuration });
  }
  return decoded;
}

function parseCanonicalUri(value: string): vscode.Uri | undefined {
  try {
    const uri = vscode.Uri.parse(value, true);
    return uri.toString() === value ? uri : undefined;
  } catch {
    return undefined;
  }
}

function decodeFormatImportOptions(uri: vscode.Uri, value: unknown): ImportOptions | undefined {
  if (!isRecord(value)) return undefined;
  const extension = path.extname(uri.path || uri.fsPath).toLowerCase();
  if (extension === ".csv" || extension === ".tsv") {
    if (
      !hasExactKeys(value, ["delimiter", "encoding", "quoteChar", "hasHeader"]) ||
      !isSingleCharacter(value.delimiter) ||
      typeof value.encoding !== "string" ||
      value.encoding.trim().length === 0 ||
      !isSingleCharacter(value.quoteChar) ||
      typeof value.hasHeader !== "boolean"
    ) {
      return undefined;
    }
    return {
      delimiter: value.delimiter,
      encoding: value.encoding,
      quoteChar: value.quoteChar,
      hasHeader: value.hasHeader
    };
  }
  if (extension === ".xlsx" || extension === ".xls") {
    if (
      hasExactKeys(value, ["sheetName"]) &&
      typeof value.sheetName === "string" &&
      value.sheetName.trim().length > 0
    ) {
      return { sheetName: value.sheetName };
    }
    if (
      hasExactKeys(value, ["sheetIndex"]) &&
      typeof value.sheetIndex === "number" &&
      Number.isSafeInteger(value.sheetIndex) &&
      value.sheetIndex >= 0
    ) {
      return { sheetIndex: value.sheetIndex };
    }
  }
  return undefined;
}

function decodeFileConfiguration(
  uri: vscode.Uri,
  backend: unknown,
  backendPreference: unknown,
  importOptions: unknown
): Omit<ConfirmedFileConfigurationEntry, "uri"> | undefined {
  if (
    !isDataBackend(backend) ||
    !isBackendPreference(backendPreference) ||
    (backendPreference !== "auto" && backendPreference !== backend)
  ) {
    return undefined;
  }
  const extension = fileExtension(uri);
  if (extension === ".csv" || extension === ".tsv" || extension === ".xlsx" || extension === ".xls") {
    const decoded = decodeFormatImportOptions(uri, importOptions);
    return decoded ? { backend, backendPreference, importOptions: decoded } : undefined;
  }
  if ((extension === ".parquet" || extension === ".jsonl" || extension === ".ndjson") && importOptions === undefined) {
    return { backend, backendPreference };
  }
  return undefined;
}

function requiresImportOptions(uri: vscode.Uri): boolean {
  const extension = fileExtension(uri);
  return extension === ".csv" || extension === ".tsv" || extension === ".xlsx" || extension === ".xls";
}

function fileExtension(uri: vscode.Uri): string {
  return path.extname(uri.path || uri.fsPath).toLowerCase();
}

function sameRegistry(
  left: readonly ConfirmedFileConfigurationEntry[],
  right: readonly ConfirmedFileConfigurationEntry[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneImportOptions(importOptions: ImportOptions): ImportOptions {
  return { ...importOptions };
}

function isDataBackend(value: unknown): value is DataBackend {
  return value === "polars" || value === "pandas" || value === "duckdb";
}

function isBackendPreference(value: unknown): value is DataBackend | "auto" {
  return value === "auto" || isDataBackend(value);
}

function isSingleCharacter(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const codePoints = Array.from(value);
  if (codePoints.length !== 1) return false;
  const codePoint = codePoints[0]?.codePointAt(0);
  return codePoint !== undefined && (codePoint < 0xd800 || codePoint > 0xdfff);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
