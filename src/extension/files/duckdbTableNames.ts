import * as path from "node:path";
import { buildPythonProcessEnvironment } from "../pythonProcessEnvironment";
import { executePythonMetadataProcess, type PythonMetadataExecutor } from "./pythonMetadataProcess";

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface DuckDBTableName {
  readonly schema: string;
  readonly name: string;
  readonly kind: "table" | "view";
}

export interface DuckDBTableDiscoveryRequest {
  readonly pythonPath: string;
  readonly extensionPath: string;
  readonly sourcePath: string;
  readonly signal?: AbortSignal;
}

export type DuckDBTableDiscoveryExecutor = PythonMetadataExecutor;

export async function discoverDuckDBTableNames(
  request: DuckDBTableDiscoveryRequest,
  execute: DuckDBTableDiscoveryExecutor = executePythonMetadataProcess
): Promise<readonly DuckDBTableName[]> {
  const result = await execute(
    request.pythonPath,
    ["-s", "-m", "openwrangler_runtime.duckdb_tables", "--source", request.sourcePath],
    {
      cwd: request.extensionPath,
      env: { ...buildPythonProcessEnvironment(), PYTHONPATH: path.join(request.extensionPath, "python") },
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      signal: request.signal,
      timeout: 15_000,
      windowsHide: true
    }
  );
  return decodeDuckDBTableNames(result.stdout);
}

export function decodeDuckDBTableNames(value: string): readonly DuckDBTableName[] {
  const invalid = (): never => {
    throw new Error("The Python runtime returned invalid DuckDB table metadata.");
  };
  if (Buffer.byteLength(value, "utf8") > MAX_OUTPUT_BYTES) return invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return invalid();
  }
  if (!Array.isArray(decoded) || decoded.length > 4_096) return invalid();
  const tables: DuckDBTableName[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of decoded) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(entry, "schema") ||
      !Object.prototype.hasOwnProperty.call(entry, "name") ||
      (entry.kind !== "table" && entry.kind !== "view")
    )
      return invalid();
    for (const name of [entry.schema, entry.name]) {
      if (typeof name !== "string" || name.length === 0 || name.length > 2_048 || name.includes("\0")) {
        return invalid();
      }
      let characters = 0;
      for (const character of name) {
        const point = character.codePointAt(0)!;
        if (++characters > 1_024 || (point >= 0xd800 && point <= 0xdfff)) return invalid();
      }
      totalBytes += Buffer.byteLength(name, "utf8");
      if (totalBytes > 65_536) return invalid();
    }
    const identity = JSON.stringify([entry.schema, entry.name]);
    if (seen.has(identity)) return invalid();
    seen.add(identity);
    tables.push(Object.freeze({ schema: entry.schema, name: entry.name, kind: entry.kind }));
  }
  return Object.freeze(tables);
}
