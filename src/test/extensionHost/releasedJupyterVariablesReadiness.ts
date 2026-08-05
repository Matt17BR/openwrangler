export const RELEASED_JUPYTER_VARIABLE_DIAGNOSTIC_FRAME_LIMIT = 12;

export type ReleasedJupyterVariableFrameKind = "workbench" | "jupyter" | "webview" | "other";
export type ReleasedJupyterVariableDocumentState = "loading" | "interactive" | "complete" | "unknown";
export type ReleasedJupyterVariableEmptyState = "loading" | "empty" | "other" | "none";
export type ReleasedJupyterVariableNotebookState = "exact" | "other" | "none";

export interface ReleasedJupyterVariableFrameProbe {
  readonly kind: ReleasedJupyterVariableFrameKind | string;
  readonly readyState: ReleasedJupyterVariableDocumentState | string;
  readonly bodyChildren: number;
  readonly mainPanels: number;
  readonly tables: number;
  readonly tableVisible: boolean;
  readonly variableCells: number;
  readonly emptyState: ReleasedJupyterVariableEmptyState | string;
}

export interface ReleasedJupyterVariableReadinessState {
  readonly activeNotebook: ReleasedJupyterVariableNotebookState;
  readonly frameCount: number;
  readonly framesTruncated: boolean;
  readonly frames: readonly ReleasedJupyterVariableFrameProbe[];
}

export function releasedJupyterVariableFrameKind(
  url: string,
  isWorkbenchMainFrame: boolean
): ReleasedJupyterVariableFrameKind {
  if (isWorkbenchMainFrame) return "workbench";
  if (/^vscode-webview:.*(?:[?&])extensionId=ms-toolsai\.jupyter(?:&|$)/u.test(url)) return "jupyter";
  if (url.startsWith("vscode-webview:")) return "webview";
  return "other";
}

export function boundedReleasedJupyterVariableReadinessState(
  activeNotebook: ReleasedJupyterVariableNotebookState,
  frameCount: number,
  frames: readonly ReleasedJupyterVariableFrameProbe[]
): ReleasedJupyterVariableReadinessState {
  const normalizedFrameCount = boundedCount(frameCount);
  return {
    activeNotebook,
    frameCount: normalizedFrameCount,
    framesTruncated: normalizedFrameCount > RELEASED_JUPYTER_VARIABLE_DIAGNOSTIC_FRAME_LIMIT,
    frames: frames.slice(0, RELEASED_JUPYTER_VARIABLE_DIAGNOSTIC_FRAME_LIMIT).map((frame) => ({
      kind: isFrameKind(frame.kind) ? frame.kind : "other",
      readyState: isDocumentState(frame.readyState) ? frame.readyState : "unknown",
      bodyChildren: boundedCount(frame.bodyChildren),
      mainPanels: boundedCount(frame.mainPanels),
      tables: boundedCount(frame.tables),
      tableVisible: frame.tableVisible === true,
      variableCells: boundedCount(frame.variableCells),
      emptyState: isEmptyState(frame.emptyState) ? frame.emptyState : "other"
    }))
  };
}

export function releasedJupyterVariableViewIsReady(state: ReleasedJupyterVariableReadinessState): boolean {
  return state.frames.some(
    (frame) => frame.kind === "jupyter" && frame.readyState === "complete" && frame.bodyChildren > 0
  );
}

export function shouldRefocusReleasedJupyterVariableNotebook(
  editor: string | undefined,
  phase: string | undefined,
  activeNotebook: ReleasedJupyterVariableNotebookState
): boolean {
  return editor === "cursor" && phase === "jupyter-remote" && activeNotebook !== "exact";
}

export function releasedJupyterVariableReadinessCheckpoint(state: ReleasedJupyterVariableReadinessState): string {
  const jupyter = state.frames.find((frame) => frame.kind === "jupyter");
  const suffix = state.framesTruncated ? "+" : "";
  if (!jupyter) return `a=${state.activeNotebook};f=${state.frameCount}${suffix};j=none`;
  return [
    `a=${state.activeNotebook}`,
    `f=${state.frameCount}${suffix}`,
    `j=${jupyter.readyState}`,
    `b=${jupyter.bodyChildren}`,
    `p=${jupyter.mainPanels}`,
    `t=${jupyter.tables}`,
    `v=${jupyter.tableVisible ? 1 : 0}`,
    `c=${jupyter.variableCells}`,
    `e=${jupyter.emptyState}`
  ].join(";");
}

function boundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, 999);
}

function isFrameKind(value: string): value is ReleasedJupyterVariableFrameKind {
  return value === "workbench" || value === "jupyter" || value === "webview" || value === "other";
}

function isDocumentState(value: string): value is ReleasedJupyterVariableDocumentState {
  return value === "loading" || value === "interactive" || value === "complete" || value === "unknown";
}

function isEmptyState(value: string): value is ReleasedJupyterVariableEmptyState {
  return value === "loading" || value === "empty" || value === "other" || value === "none";
}
