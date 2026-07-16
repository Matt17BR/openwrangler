import type { OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";

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
  /** Opaque identifier for the logical view that owns a profiling request. */
  viewContextId?: string;
}

export interface OpenWranglerBridge {
  request(request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse>;
  /** Drops queued profiling/value work for views the webview no longer needs. Active work is left alone. */
  cancelViewRequests?(sessionId: string, viewRequestIds: readonly string[]): void;
  /** Confirms the opaque logical view currently shown by a webview. */
  setViewContext?(sessionId: string, viewContextId: string): void;
  setActiveSession?(sessionId: string | undefined): void;
  /** Writes a non-fatal coordinator/runtime diagnostic to the owning bridge's diagnostic surface. */
  reportDiagnostic?(message: string): void;
  onIdle?(): void;
}
