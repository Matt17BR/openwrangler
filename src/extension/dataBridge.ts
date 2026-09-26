import type {
  CancelledResponse,
  ColumnSchema,
  ConfirmedView,
  DataBackend,
  ErrorResponse,
  OpenWranglerRequest,
  OpenWranglerResponse,
  PageResponse,
  RLibrary,
  SessionMode,
  SessionSource
} from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";
import type { SessionPresentation } from "../shared/sessionRecovery";
export type { SessionPresentation } from "../shared/sessionRecovery";
import type { SessionOpenProgressStage } from "../shared/sessionOpenProgress";
import type { ExportSourceProtection, SessionSourceProtection } from "./files/safeFileExport";
import type { DuckDBTableName } from "./files/duckdbTableNames";

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
  /** Host-only original file identity required through initial session establishment. */
  requiredSourceProtection?: SessionSourceProtection;
  /** Host-confirmed viewing state consumed by an edit or Spark page, captured at runtime dispatch. */
  confirmedView?: ConfirmedView;
  /** Original read ownership, checked before a yielded native request dispatches again. */
  isCurrentRead?: () => boolean;
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
  /** Opaque identifier for the logical view that owns this request. */
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

/** Original input columns without a same-name, same-type column in the target, and the target's other columns. */
export interface FilePlanColumnMappingRequest {
  readonly unmatched: readonly ColumnSchema[];
  readonly candidates: readonly ColumnSchema[];
}

/** Resolves original column IDs to target column IDs, or undefined when the user declines or the open is cancelled. */
export type FilePlanColumnMappingChooser = (
  request: FilePlanColumnMappingRequest,
  cancellation?: CancellationTokenLike
) => Promise<ReadonlyMap<string, string> | undefined>;

/** A confirmed file plan captured before choosing its target; replay stays owned by the coordinator. */
export interface FilePlanOpenContext {
  readonly backend: Extract<DataBackend, "pandas" | "polars" | "duckdb" | "r">;
  readonly importOptions: SessionSource["importOptions"];
  readonly rLibrary?: RLibrary;
  isCurrent(): boolean;
  createBridge(targetDelegate?: OpenWranglerBridge): OpenWranglerBridge;
}

/** A pinned R source and applied plan; the original editor retains unfinished work. */
export interface RLibraryCopyContext {
  readonly source: SessionSource;
  readonly rLibrary: RLibrary;
  readonly appliedStepCount: number;
  readonly rerunsCustomCode: boolean;
  isCurrent(): boolean;
  createBridge(library: RLibrary): OpenWranglerBridge;
}

export interface DuckDBTableDiscovery {
  readonly tables: readonly DuckDBTableName[];
  /** The interpreter selection and discovery attempt remain available for the initial open. */
  isCurrent(): boolean;
}

/** A completed Python preflight permits native R selection before any file read. */
export interface FileAutoFallback {
  isCurrent(): boolean;
}

/** Expected compatibility or executable absence, never a data-read failure. */
export class FileBackendUnavailableError extends Error {}

export interface OpenWranglerBridge {
  request(request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse>;
  /** Retains a liveness check for the exact runtime owner of a file session. */
  captureFileSessionOwner?(sessionId: string): (() => boolean) | undefined;
  /** Retains the exact mapped runtime while a native R editing copy is prepared. */
  captureSessionOwner?(sessionId: string): (() => boolean) | undefined;
  /** Pins the active confirmed file plan and its target bridge factory, or returns an eligibility diagnostic. */
  captureActiveFilePlan?(chooseColumnMapping: FilePlanColumnMappingChooser): FilePlanOpenContext | ErrorResponse;
  captureRLibraryCopy?(sessionId: string, revision: number): RLibraryCopyContext | ErrorResponse;
  prepareFileAutoFallback?(
    source: SessionSource,
    options?: BridgeRequestOptions
  ): Promise<FileAutoFallback | ErrorResponse | undefined>;
  discoverDuckDBTables?(
    source: SessionSource,
    options?: BridgeRequestOptions
  ): Promise<DuckDBTableDiscovery | ErrorResponse | undefined>;
  /** Rechecks a failed file open and confirms any installation for that source. True permits a fresh normal open. */
  installFileDependencies?(
    source: SessionSource,
    backend: DataBackend | undefined,
    options?: BridgeRequestOptions
  ): Promise<boolean | ErrorResponse>;
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
  setViewContext?(sessionId: string, viewContextId: string | undefined): void;
  getPagePublication?(sessionId: string): PageResponse | undefined;
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
