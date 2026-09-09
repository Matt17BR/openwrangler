import type {
  CancelledResponse,
  ColumnSchema,
  DataDiff,
  ErrorResponse,
  PageResponse,
  PlanUpdatedResponse,
  SessionOpenedResponse,
  StepPreviewResponse
} from "./protocol";
import type { SerializedGridViewState } from "./viewState";

export interface SessionPresentation {
  sessionId: string;
  revision: number;
  code: string;
  draft?: {
    diff: DataDiff;
    remainingMissingCells?: number;
    warnings: string[];
    beforeSchema: ColumnSchema[];
  };
}

export interface SessionRecoveryContext {
  sessionId: string;
  revision: number;
  viewContextId: string | null;
  lastPageRequestId: string | null;
  /** Null for refreshes not settling a request from this renderer. */
  request: {
    kind: "getPage" | "previewStep" | "applyDraft" | "discardDraft" | "undoStep" | "redoStep";
    viewRequestId?: string;
  } | null;
}

/** One host publication; no native runtime protocol or duplicate page payload. */
export type SessionRecoveryMessage = {
  kind: "sessionRecovered";
  offeredViewContextId: string;
  context: SessionRecoveryContext;
  presentation: Omit<SessionPresentation, "code">;
  viewState: SerializedGridViewState;
} & (
  | { result: PageResponse | StepPreviewResponse | PlanUpdatedResponse; snapshot?: never }
  | { snapshot: SessionOpenedResponse; result?: ErrorResponse | CancelledResponse }
);

export const RECOVERY_VIEW_CONTEXT_PREFIX = "recovery:";

export function isRecoveryViewContextId(value: string): boolean {
  return value.startsWith(RECOVERY_VIEW_CONTEXT_PREFIX);
}
