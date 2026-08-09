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
  return `Released-Jupyter cell ${cellIndex} failed (${classification}${stage}).`;
}
