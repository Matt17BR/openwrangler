import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DataBackend } from "../../shared/protocol";
import { buildPythonProcessEnvironment } from "../pythonProcessEnvironment";

const execFileAsync = promisify(execFile);
const EXCEL_SHEET_DISCOVERY_TIMEOUT_MS = 15_000;
const EXCEL_SHEET_DISCOVERY_OUTPUT_BYTES = 256 * 1024;
const MAX_EXCEL_SHEETS = 4_096;
const MAX_EXCEL_SHEET_NAME_CHARACTERS = 1_024;
const MAX_EXCEL_SHEET_NAME_BYTES = 65_536;

export interface ExcelSheetDiscoveryRequest {
  readonly pythonPath: string;
  readonly extensionPath: string;
  readonly sourcePath: string;
  readonly backend: DataBackend;
  readonly signal?: AbortSignal;
}

export interface ExcelSheetDiscoveryProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly shell: false;
  readonly signal?: AbortSignal;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type ExcelSheetDiscoveryExecutor = (
  executable: string,
  arguments_: readonly string[],
  options: ExcelSheetDiscoveryProcessOptions
) => Promise<{ stdout: string }>;

const defaultExecutor: ExcelSheetDiscoveryExecutor = async (executable, arguments_, options) => {
  const result = await execFileAsync(executable, [...arguments_], options);
  return { stdout: result.stdout };
};

export async function discoverExcelSheetNames(
  request: ExcelSheetDiscoveryRequest,
  execute: ExcelSheetDiscoveryExecutor = defaultExecutor
): Promise<readonly string[]> {
  if (request.backend !== "pandas" && request.backend !== "polars") {
    throw new Error(`${request.backend} does not support Excel worksheet discovery.`);
  }
  const extension = path.extname(request.sourcePath).toLowerCase();
  if (extension !== ".xls" && extension !== ".xlsx") {
    throw new Error("Excel worksheet discovery accepts only .xls or .xlsx sources.");
  }

  const runtimeRoot = path.join(request.extensionPath, "python");
  const result = await execute(
    request.pythonPath,
    ["-s", "-m", "openwrangler_runtime.excel_sheets", "--backend", request.backend, "--source", request.sourcePath],
    {
      cwd: request.extensionPath,
      env: {
        ...buildPythonProcessEnvironment(),
        PYTHONPATH: runtimeRoot
      },
      encoding: "utf8",
      maxBuffer: EXCEL_SHEET_DISCOVERY_OUTPUT_BYTES,
      shell: false,
      signal: request.signal,
      timeout: EXCEL_SHEET_DISCOVERY_TIMEOUT_MS,
      windowsHide: true
    }
  );
  return decodeExcelSheetNames(result.stdout);
}

export function decodeExcelSheetNames(value: string): readonly string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("The Python runtime returned malformed Excel worksheet metadata.");
  }
  if (!Array.isArray(decoded) || decoded.length < 1 || decoded.length > MAX_EXCEL_SHEETS) {
    throw new Error("The Python runtime returned an invalid Excel worksheet count.");
  }

  let totalBytes = 0;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of decoded) {
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_EXCEL_SHEET_NAME_CHARACTERS) {
      throw new Error("The Python runtime returned an invalid Excel worksheet name.");
    }
    totalBytes += Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_EXCEL_SHEET_NAME_BYTES) {
      throw new Error("The Python runtime returned too much Excel worksheet-name data.");
    }
    if (seen.has(value)) {
      throw new Error("The Python runtime returned duplicate Excel worksheet names.");
    }
    seen.add(value);
    names.push(value);
  }
  return names;
}
