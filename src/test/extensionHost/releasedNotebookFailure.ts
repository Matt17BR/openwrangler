interface NotebookOutputShape {
  readonly items: readonly {
    readonly mime: string;
    readonly data?: Uint8Array;
  }[];
}

const NOTEBOOK_ERROR_MIME = "application/vnd.code.notebook.error";
const NOTEBOOK_STREAM_MIMES = new Set(["application/vnd.code.notebook.stdout", "application/vnd.code.notebook.stderr"]);
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

export function releasedNotebookOutputClassification(outputs: readonly NotebookOutputShape[]): string {
  return outputs.some((output) => output.items.some((item) => item.mime === NOTEBOOK_ERROR_MIME))
    ? "notebook-error-output"
    : "no-notebook-error-output";
}

export function releasedNotebookRSetupFailureStage(outputs: readonly NotebookOutputShape[]): string | undefined {
  const streamItems: Buffer[] = [];
  let itemCount = 0;
  let byteCount = 0;
  for (const output of outputs) {
    for (const item of output.items) {
      itemCount += 1;
      if (itemCount > FAILURE_SCAN_MAX_ITEMS) return undefined;
      if (!NOTEBOOK_STREAM_MIMES.has(item.mime) || item.data === undefined) continue;
      if (item.data.byteLength > FAILURE_SCAN_MAX_BYTES - byteCount) return undefined;
      const bytes = Buffer.from(item.data);
      byteCount += bytes.byteLength;
      streamItems.push(bytes);
    }
  }

  const markers: string[] = [];
  for (const rawLine of Buffer.concat(streamItems).subarray(0, byteCount).toString("latin1").split("\n")) {
    const line = Buffer.from(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine, "latin1");
    if (!line.subarray(0, R_SETUP_FAILURE_PREFIX.byteLength).equals(R_SETUP_FAILURE_PREFIX)) continue;
    const stageBytes = line.subarray(R_SETUP_FAILURE_PREFIX.byteLength);
    if (stageBytes.byteLength === 0 || !stageBytes.every((value) => value >= 0x20 && value <= 0x7e)) return undefined;
    const stage = stageBytes.toString("ascii");
    if (!R_SETUP_FAILURE_STAGES.has(stage)) return undefined;
    markers.push(stage);
  }
  return markers.length === 1 ? markers[0] : undefined;
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
