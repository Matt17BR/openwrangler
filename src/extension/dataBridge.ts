import type {
  ColumnSchema,
  DataBackend,
  DataDiff,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMode,
  SessionSource
} from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";
import type { SessionOpenProgressStage } from "../shared/sessionOpenProgress";

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export type DetachedBridgeRequestReason = "timeout" | "cancellation";

/**
 * The host stopped waiting while the transport execution was deliberately
 * left running. This is not transport loss: callers must not replay the
 * request until `settlement` confirms that the original execution finished.
 */
export class DetachedBridgeRequestError extends Error {
  readonly settlement: Promise<void>;

  constructor(
    message: string,
    readonly reason: DetachedBridgeRequestReason,
    readonly dispatched: boolean,
    settlement: Promise<void>
  ) {
    super(message);
    this.name = "DetachedBridgeRequestError";
    this.settlement = settlement.then(
      () => undefined,
      () => undefined
    );
  }
}

export interface BridgeRequestOptions {
  cancellation?: CancellationTokenLike;
  priority?: "interactive" | "background";
  timeoutMs?: number;
  /** Restarts the shared standalone runtime after a timeout unless explicitly disabled. */
  restartRuntimeOnTimeout?: boolean;
  /** For bounded cleanup, return an unknown-session response instead of starting or reacquiring a runtime. */
  startRuntimeIfNeeded?: boolean;
  /**
   * Host-only live-source recovery provenance. A notebook recovery open may
   * dispatch only on the kernel that owns this still-mapped runtime session.
   */
  requiredKernelSessionId?: string;
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
    remainingMissingCells?: number;
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
  /**
   * Atomically replaces a supported live-variable runtime in the requested mode
   * while remaining bound to the same live source. This is a host-only lifecycle
   * operation and is intentionally absent from protocol v2.
   */
  reconfigureLiveSessionMode?(
    sessionId: string,
    revision: number,
    mode: SessionMode,
    viewState: GridViewState,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse>;
  /**
   * Rebinds a live notebook variable after its remote Spark Connect state was
   * lost. This is a host-only, user-initiated recovery operation.
   */
  reconnectLiveSession?(
    sessionId: string,
    revision: number,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse>;
  /** Drops queued profiling/value work for views the webview no longer needs. Active work is left alone. */
  cancelViewRequests?(sessionId: string, viewRequestIds: readonly string[]): void;
  /** Moves one queued profile ahead of passive background work without repeating an active request. */
  prioritizeViewRequest?(sessionId: string, viewRequestId: string): void;
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
