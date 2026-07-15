import type { DataExplorerRequest, DataExplorerResponse } from "../shared/protocol";

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface BridgeRequestOptions {
  cancellation?: CancellationTokenLike;
  priority?: "interactive" | "background";
  timeoutMs?: number;
}

export interface DataExplorerBridge {
  request(request: DataExplorerRequest, options?: BridgeRequestOptions): Promise<DataExplorerResponse>;
  setActiveSession?(sessionId: string | undefined): void;
  onIdle?(): void;
}
