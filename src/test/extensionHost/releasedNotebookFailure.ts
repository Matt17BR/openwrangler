interface NotebookOutputShape {
  readonly items: readonly {
    readonly mime: string;
    readonly data?: Uint8Array;
  }[];
}

const NOTEBOOK_ERROR_MIME = "application/vnd.code.notebook.error";
const NOTEBOOK_DIAGNOSTIC_MIMES = new Set([
  NOTEBOOK_ERROR_MIME,
  "application/vnd.code.notebook.stdout",
  "application/vnd.code.notebook.stderr"
]);
export const RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX = "OPEN_WRANGLER_R_SETUP_FAILED:";
const R_SETUP_FAILURE_PREFIX = Buffer.from(RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX, "utf8");
const R_SETUP_FAILURE_STAGES = new Set([
  "base-frame",
  "tibble",
  "data-table",
  "collapse-load",
  "collapse-data-frame",
  "collapse-tibble",
  "collapse-data-table",
  "collapse-grouped",
  "collapse-indexed",
  "snapshots",
  "result"
]);
const FAILURE_SCAN_MAX_ITEMS = 32;
const FAILURE_SCAN_MAX_BYTES = 16 * 1024;
const R_ERROR_PACKAGE_ALLOWLIST = ["IRkernel", "collapse", "data.table", "jsonlite", "tibble"] as const;

interface DecodedNotebookError {
  readonly message: string;
  readonly name: string;
  readonly stack: string;
}

function decodeNotebookError(data: Uint8Array): DecodedNotebookError | undefined {
  if (data.byteLength === 0 || data.byteLength > FAILURE_SCAN_MAX_BYTES) return undefined;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.message !== "string") return undefined;
    if (record.name.length > 128 || record.message.length > FAILURE_SCAN_MAX_BYTES) return undefined;
    if (record.stack !== undefined && typeof record.stack !== "string") return undefined;
    const stack = record.stack ?? "";
    if (stack.length > FAILURE_SCAN_MAX_BYTES) return undefined;
    return { name: record.name, message: record.message, stack };
  } catch {
    return undefined;
  }
}

function fixedNotebookErrorDiagnostic(error: DecodedNotebookError): string | undefined {
  const text = `${error.name}\n${error.message}\n${error.stack}`;
  const parseLocation = /:(\d{1,6}):(\d{1,6}):\s*unexpected\s+([^\r\n]{1,64})/iu.exec(text);
  if (parseLocation) {
    const detail = parseLocation[3].toLowerCase();
    const category = detail.includes("end of input")
      ? "unexpected end of input"
      : detail.includes("symbol")
        ? "unexpected symbol"
        : detail.includes("string")
          ? "unexpected string"
          : detail.includes("numeric")
            ? "unexpected number"
            : "unexpected token";
    return `R parse error at ${Number(parseLocation[1])}:${Number(parseLocation[2])} (${category})`;
  }
  if (/\bkernel\b[^\r\n]{0,256}\blocated in an insecure location\b/iu.test(text)) {
    return "kernel spec not trusted";
  }
  if (/\btimeout waiting for (?:the )?ports? to (?:get|be) used\b/iu.test(text)) {
    return "kernel port wait timed out";
  }
  if (/\b(?:connection timeout|timed out (?:while )?waiting for (?:a )?kernel connection)\b/iu.test(text)) {
    return "kernel connection timed out";
  }
  if (/\bconnection file not found in kernelspec json args\b/iu.test(text)) {
    return "kernel spec missing connection file";
  }
  if (/(?:(?:failed|unable) to start (?:the )?kernel|\bkernel\b[^\r\n]{0,128}\bwas not started)\b/iu.test(text)) {
    return "kernel failed to start";
  }
  if (/\bkernel(?:\s+[‘'"][^’'"\r\n]{0,128}[’'"])?\s+(?:died|stopped|terminated)\b/iu.test(text)) {
    return "kernel stopped";
  }
  if (/\b(?:kernel|session)(?: has been| was)? disposed\b/iu.test(text)) return "kernel session disposed";
  if (/\b(?:cancelled|canceled|cancellation)\b/iu.test(text)) return "execution cancelled";
  for (const packageName of R_ERROR_PACKAGE_ALLOWLIST) {
    const escaped = packageName.replaceAll(".", "\\.");
    if (new RegExp(`there is no package called [‘'"]${escaped}[’'"]`, "iu").test(text)) {
      return `missing R package ${packageName}`;
    }
  }
  if (/\b(?:unable to load shared object|dll load failed)\b/iu.test(text)) return "R package failed to load";
  if (/\bSyntaxError\b[^\r\n]{0,256}\binvalid syntax\b/iu.test(text)) return "kernel language mismatch";
  return undefined;
}

function isMarkerPrefixBoundary(value: number): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0d || value === 0x0a || value === 0x22;
}

function isMarkerStageTerminator(bytes: Buffer, stageEnd: number): boolean {
  if (stageEnd === bytes.byteLength) return true;
  const value = bytes[stageEnd];
  if (value === 0x22 || value === 0x0d || value === 0x0a) return true;
  return (
    value === 0x5c && stageEnd + 1 < bytes.byteLength && (bytes[stageEnd + 1] === 0x6e || bytes[stageEnd + 1] === 0x72)
  );
}

export function releasedNotebookOutputClassification(outputs: readonly NotebookOutputShape[]): string {
  return outputs.some((output) => output.items.some((item) => item.mime === NOTEBOOK_ERROR_MIME))
    ? "notebook-error-output"
    : "no-notebook-error-output";
}

export function releasedNotebookErrorDiagnostic(outputs: readonly NotebookOutputShape[]): string | undefined {
  const diagnostics = new Set<string>();
  let itemCount = 0;
  let byteCount = 0;
  for (const output of outputs) {
    for (const item of output.items) {
      itemCount += 1;
      if (itemCount > FAILURE_SCAN_MAX_ITEMS) return undefined;
      if (item.mime !== NOTEBOOK_ERROR_MIME) continue;
      if (item.data === undefined) return undefined;
      if (item.data.byteLength > FAILURE_SCAN_MAX_BYTES - byteCount) return undefined;
      byteCount += item.data.byteLength;
      const decoded = decodeNotebookError(item.data);
      if (!decoded) return undefined;
      const diagnostic = fixedNotebookErrorDiagnostic(decoded);
      if (!diagnostic) return undefined;
      diagnostics.add(diagnostic);
    }
  }
  return diagnostics.size === 1 ? diagnostics.values().next().value : undefined;
}

export function releasedNotebookRSetupFailureStage(outputs: readonly NotebookOutputShape[]): string | undefined {
  const diagnosticItems: Buffer[] = [];
  let itemCount = 0;
  let byteCount = 0;
  for (const output of outputs) {
    for (const item of output.items) {
      itemCount += 1;
      if (itemCount > FAILURE_SCAN_MAX_ITEMS) return undefined;
      if (!NOTEBOOK_DIAGNOSTIC_MIMES.has(item.mime) || item.data === undefined) continue;
      if (item.data.byteLength > FAILURE_SCAN_MAX_BYTES - byteCount) return undefined;
      const bytes = Buffer.from(item.data);
      byteCount += bytes.byteLength;
      diagnosticItems.push(bytes);
    }
  }

  const bytes = Buffer.concat(diagnosticItems).subarray(0, byteCount);
  const markers = new Set<string>();
  let searchFrom = 0;
  while (searchFrom < bytes.byteLength) {
    const markerIndex = bytes.indexOf(R_SETUP_FAILURE_PREFIX, searchFrom);
    if (markerIndex < 0) break;
    if (markerIndex > 0 && !isMarkerPrefixBoundary(bytes[markerIndex - 1])) {
      searchFrom = markerIndex + R_SETUP_FAILURE_PREFIX.byteLength;
      continue;
    }
    const stageStart = markerIndex + R_SETUP_FAILURE_PREFIX.byteLength;
    let stageEnd = stageStart;
    while (stageEnd < bytes.byteLength) {
      const value = bytes[stageEnd];
      if ((value >= 0x61 && value <= 0x7a) || (value >= 0x30 && value <= 0x39) || value === 0x2d) {
        stageEnd += 1;
        continue;
      }
      break;
    }
    if (stageEnd === stageStart) return undefined;
    if (!isMarkerStageTerminator(bytes, stageEnd)) return undefined;
    const stageBytes = bytes.subarray(stageStart, stageEnd);
    const stage = stageBytes.toString("ascii");
    if (!R_SETUP_FAILURE_STAGES.has(stage)) return undefined;
    markers.add(stage);
    searchFrom = stageEnd;
  }
  return markers.size === 1 ? markers.values().next().value : undefined;
}

export function releasedNotebookExecutionFailureMessage(
  cellIndex: number,
  outputs: readonly NotebookOutputShape[],
  rSetupStage?: string
): string {
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0) {
    throw new Error("A released-Jupyter notebook failure requires one valid cell index.");
  }
  const classification = releasedNotebookOutputClassification(outputs);
  const stage =
    rSetupStage !== undefined && R_SETUP_FAILURE_STAGES.has(rSetupStage) ? `; R setup stage ${rSetupStage}` : "";
  const errorDiagnostic = releasedNotebookErrorDiagnostic(outputs);
  const diagnostic = errorDiagnostic ? `; ${errorDiagnostic}` : "";
  return `Released-Jupyter cell ${cellIndex} failed (${classification}${stage}${diagnostic}).`;
}
