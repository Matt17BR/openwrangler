import type {
  CancelledResponse,
  DataBackend,
  ErrorResponse,
  OpenWranglerRequest,
  OpenWranglerResponse,
  PageResponse,
  SessionMode,
  SessionSource
} from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";
import type { SessionPresentation } from "../shared/sessionRecovery";
export type { SessionPresentation } from "../shared/sessionRecovery";
import type { SessionOpenProgressStage } from "../shared/sessionOpenProgress";
import type { ExportSourceProtection } from "./files/safeFileExport";

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
  /** Host-owned source identities retained before an export's user interaction. */
  sourceProtection?: ExportSourceProtection;
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
   * Host-only page classification for bounded renderer reads that must not
   * replace or persist the visible grid page.
   */
  ephemeralPage?: boolean;
  /**
   * Host-only file backend selection provenance. A confirmed backend may be
   * pinned for recovery while the user's logical selection remains automatic.
   */
  backendPreference?: DataBackend | "auto";
  /** Host-only progress for an expensive live-notebook session open. */
  onOpenProgress?: (stage: SessionOpenProgressStage) => void;
}

/** Exact private replacement; retained only until its owning panel confirms a fresh view. */
export interface SessionRuntimeReplacement {
  readonly sessionId: string;
  isCurrent(): boolean;
  /** Captures the accepted coordinator view without exposing private runtime identity. */
  captureView(expectedPageRequestId?: string | null): (() => boolean) | undefined;
  /** Called outside an executing request; reads only the current confirmed viewport. */
  readPage(window: {
    limit: number;
    columnOffset: number;
    columnLimit: number;
  }): Promise<{ response: PageResponse | ErrorResponse | CancelledResponse; isCurrent(): boolean } | undefined>;
}

export interface OpenWranglerBridge {
  request(request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse>;
  onDidReplaceRuntime?(listener: (replacement: SessionRuntimeReplacement) => void): { dispose(): void };
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
   * host-only lifecycle operation and is intentionally absent from the runtime protocol.
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
   * operation and is intentionally absent from the runtime protocol.
   */
  reconfigureLiveSessionMode?(
    sessionId: string,
    revision: number,
    mode: SessionMode,
    viewState: GridViewState,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse>;
  /**
   * Replays one stable-ID cleaning-plan replacement or deletion in a private
   * runtime and publishes it only after the complete suffix and view succeed.
   * This host-owned atomic transaction is intentionally absent from the runtime protocol.
   */
  rewriteCleaningPlan?(
    sessionId: string,
    revision: number,
    stepId: string,
    action: "applyDraft" | "deleteStep",
    page: { offset: number; limit: number; columnOffset: number; columnLimit: number },
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
