import type {
  ColumnSchema,
  DataBackend,
  DataDiff,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionSource
} from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";
import type { SessionOpenProgressStage } from "../shared/sessionOpenProgress";

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface BridgeRequestOptions {
  cancellation?: CancellationTokenLike;
  priority?: "interactive" | "background";
  timeoutMs?: number;
  /** Restarts the shared standalone runtime after a timeout unless explicitly disabled. */
  restartRuntimeOnTimeout?: boolean;
  /** For bounded cleanup, return an unknown-session response instead of starting or reacquiring a runtime. */
  startRuntimeIfNeeded?: boolean;
  /** Opaque identifier for the logical view that owns a profiling request. */
  viewContextId?: string;
  /**
   * Host-only file backend selection provenance. A confirmed backend may be
   * pinned for recovery while the user's logical selection remains automatic.
   */
  backendPreference?: DataBackend | "auto";
  /** Host-only progress for an expensive live-notebook session open. */
  onOpenProgress?: (stage: SessionOpenProgressStage) => void;
}

export interface SessionPresentation {
  sessionId: string;
  revision: number;
  code: string;
  draft?: {
    diff: DataDiff;
    warnings: string[];
    beforeSchema: ColumnSchema[];
  };
}

export interface OpenWranglerBridge {
  request(request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse>;
  /**
   * Lists the worksheets in the exact workbook owned by a live file session.
   * The coordinator translates public session identity before delegation.
   */
  listExcelSheets?(
    sessionId: string,
    source: SessionSource,
    backend: DataBackend,
    options?: BridgeRequestOptions
  ): Promise<readonly string[] | undefined>;
  /**
   * Atomically replaces the private runtime behind an existing file session
   * after opening the same source with different import options. This is a
   * host-only lifecycle operation and is intentionally absent from protocol v2.
   */
  reconfigureFileSession?(
    sessionId: string,
    revision: number,
    source: SessionSource,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse>;
  /** Drops queued profiling/value work for views the webview no longer needs. Active work is left alone. */
  cancelViewRequests?(sessionId: string, viewRequestIds: readonly string[]): void;
  /** Confirms the opaque logical view currently shown by a webview. */
  setViewContext?(sessionId: string, viewContextId: string): void;
  /** Returns the host-owned grid presentation for a live session. */
  getViewState?(sessionId: string): GridViewState | undefined;
  /** Returns generated code and any confirmed draft presentation for panel recreation or runtime replacement. */
  getSessionPresentation?(sessionId: string): SessionPresentation | undefined;
  /** Persists a validated non-destructive grid presentation update. */
  updateViewState?(sessionId: string, state: GridViewState): Promise<void>;
  /** Clears the bounded, host-only applied-step inspection without changing the dataframe view. */
  clearStepInspection?(sessionId: string): void;
  setActiveSession?(sessionId: string | undefined): void;
  /** Writes a non-fatal coordinator/runtime diagnostic to the owning bridge's diagnostic surface. */
  reportDiagnostic?(message: string): void;
  onIdle?(): void;
}
