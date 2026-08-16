import type { OpenWranglerRequest, OpenWranglerResponse, SessionBoundRequest } from "../shared/protocol";
import type { BridgeRequestOptions } from "./dataBridge";

export type SessionRequestExecutionLane = "foreground" | "background";

export interface ScheduledRequestCheckpoint {
  readonly state: "active" | "queued";
  readonly lane: SessionRequestExecutionLane;
  readonly requestKind: SessionBoundRequest["kind"];
  readonly viewRequestId: string;
}

export interface SessionRequestSchedulerSnapshot {
  readonly quiescent: boolean;
  readonly activeForegroundOperation: boolean;
  readonly activeBackgroundOperation: boolean;
  readonly interactiveQueueLength: number;
  readonly backgroundQueueLength: number;
  readonly terminalOperation: boolean;
}

interface QueuedSessionOperation {
  request: SessionBoundRequest;
  options?: BridgeRequestOptions;
  resolve(response: OpenWranglerResponse): void;
  reject(error: unknown): void;
}

type ExecuteSessionRequest = (
  request: SessionBoundRequest,
  options?: BridgeRequestOptions
) => Promise<OpenWranglerResponse>;

export class SessionRequestScheduler {
  private activeForegroundOperation: Promise<void> | undefined;
  private activeForegroundRequest: SessionBoundRequest | undefined;
  private activeBackgroundOperation: Promise<void> | undefined;
  private activeBackgroundRequest: SessionBoundRequest | undefined;
  private interactiveQueue: QueuedSessionOperation[] = [];
  private backgroundQueue: QueuedSessionOperation[] = [];
  private terminalOperation: QueuedSessionOperation | undefined;
  private readonly idleWaiters = new Set<() => void>();
  private readonly cancelledActiveViewRequestIds = new Set<string>();

  constructor(private readonly execute: ExecuteSessionRequest) {}

  enqueue(request: SessionBoundRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    return new Promise((resolve, reject) => {
      const operation: QueuedSessionOperation = { request, options, resolve, reject };
      if (request.kind === "closeSession") {
        // Closing is a terminal barrier. The coordinator discards queued
        // background work first; accepted foreground work still settles in order.
        this.terminalOperation = operation;
      } else if (sessionRequestPriority(request, options) === "background") {
        this.backgroundQueue.push(operation);
      } else {
        this.interactiveQueue.push(operation);
      }
      this.startNext();
    });
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  cancelBackground(): void {
    this.cancelOperations(this.backgroundQueue.splice(0));
  }

  cancelAll(): void {
    this.cancelOperations(this.interactiveQueue.splice(0));
    this.cancelOperations(this.backgroundQueue.splice(0));
    this.startNext();
  }

  cancelViewRequests(viewRequestIds: readonly string[]): void {
    if (viewRequestIds.length === 0) return;
    const cancelled = new Set(viewRequestIds);
    for (const active of [this.activeForegroundRequest, this.activeBackgroundRequest]) {
      const viewRequestId = active ? requestViewId(active) : undefined;
      if (active && viewRequestId && cancelled.has(viewRequestId) && isCancellableQueuedViewRequest(active)) {
        this.cancelledActiveViewRequestIds.add(viewRequestId);
      }
    }
    const discarded: QueuedSessionOperation[] = [];
    const retainUncancelled = (queue: QueuedSessionOperation[]): QueuedSessionOperation[] =>
      queue.filter((operation) => {
        const viewRequestId = requestViewId(operation.request);
        if (viewRequestId && cancelled.has(viewRequestId) && isCancellableQueuedViewRequest(operation.request)) {
          discarded.push(operation);
          return false;
        }
        return true;
      });
    this.interactiveQueue = retainUncancelled(this.interactiveQueue);
    this.backgroundQueue = retainUncancelled(this.backgroundQueue);
    this.cancelOperations(discarded);
    this.startNext();
  }

  prioritizeViewRequest(viewRequestId: string): void {
    const index = this.backgroundQueue.findIndex(
      (operation) =>
        requestViewId(operation.request) === viewRequestId && isCancellableQueuedViewRequest(operation.request)
    );
    if (index < 0) return;
    const [operation] = this.backgroundQueue.splice(index, 1);
    if (!operation) return;
    operation.options = { ...operation.options, priority: "interactive" };
    // Preserve the original request and correlation ID while moving only its
    // scheduling lane.
    this.interactiveQueue.push(operation);
    this.startNext();
  }

  isCancelled(viewRequestId: string | undefined): boolean {
    return Boolean(viewRequestId && this.cancelledActiveViewRequestIds.has(viewRequestId));
  }

  checkpoint(requestKind: SessionBoundRequest["kind"], viewRequestId: string): ScheduledRequestCheckpoint | undefined {
    if (viewRequestId.length === 0) return undefined;
    const checkpoints: ScheduledRequestCheckpoint[] = [];
    const append = (
      request: SessionBoundRequest | undefined,
      state: ScheduledRequestCheckpoint["state"],
      lane: SessionRequestExecutionLane
    ): void => {
      if (request?.kind !== requestKind || requestViewId(request) !== viewRequestId) return;
      checkpoints.push({ state, lane, requestKind, viewRequestId });
    };
    append(this.activeForegroundRequest, "active", "foreground");
    append(this.activeBackgroundRequest, "active", "background");
    for (const operation of this.interactiveQueue) append(operation.request, "queued", "foreground");
    for (const operation of this.backgroundQueue) append(operation.request, "queued", "background");
    if (checkpoints.length > 1) {
      throw new Error(`The test-only scheduler checkpoint is ambiguous for ${requestKind}/${viewRequestId}.`);
    }
    return checkpoints[0];
  }

  snapshot(): SessionRequestSchedulerSnapshot {
    return {
      quiescent: this.isIdle(),
      activeForegroundOperation: this.activeForegroundOperation !== undefined,
      activeBackgroundOperation: this.activeBackgroundOperation !== undefined,
      interactiveQueueLength: this.interactiveQueue.length,
      backgroundQueueLength: this.backgroundQueue.length,
      terminalOperation: this.terminalOperation !== undefined
    };
  }

  private startNext(): void {
    if (!this.activeForegroundOperation && this.interactiveQueue.length > 0) {
      const next = this.interactiveQueue[0];
      if (
        !this.activeBackgroundOperation ||
        (this.activeBackgroundRequest &&
          canRunAlongsideBackground(next.request, next.options, this.activeBackgroundRequest))
      ) {
        this.interactiveQueue.shift();
        this.startOperation(next, "foreground");
      }
    }

    if (
      !this.activeForegroundOperation &&
      !this.activeBackgroundOperation &&
      this.interactiveQueue.length === 0 &&
      this.backgroundQueue.length === 0
    ) {
      const terminal = this.terminalOperation;
      this.terminalOperation = undefined;
      if (terminal) this.startOperation(terminal, "foreground");
    }

    if (
      !this.activeForegroundOperation &&
      !this.activeBackgroundOperation &&
      this.interactiveQueue.length === 0 &&
      this.backgroundQueue.length > 0
    ) {
      const background = this.backgroundQueue.shift();
      if (background) this.startOperation(background, "background");
    }

    this.resolveIdleWaiters();
  }

  private startOperation(operation: QueuedSessionOperation, lane: SessionRequestExecutionLane): void {
    if (lane === "foreground") this.activeForegroundRequest = operation.request;
    else this.activeBackgroundRequest = operation.request;
    const activeOperation = this.execute(operation.request, operation.options)
      .then(operation.resolve, operation.reject)
      .finally(() => {
        if (lane === "foreground" && this.activeForegroundOperation === activeOperation) {
          this.activeForegroundOperation = undefined;
          this.activeForegroundRequest = undefined;
        }
        if (lane === "background" && this.activeBackgroundOperation === activeOperation) {
          this.activeBackgroundOperation = undefined;
          this.activeBackgroundRequest = undefined;
        }
        const viewRequestId = requestViewId(operation.request);
        if (viewRequestId) this.cancelledActiveViewRequestIds.delete(viewRequestId);
        this.startNext();
      });
    if (lane === "foreground") this.activeForegroundOperation = activeOperation;
    else this.activeBackgroundOperation = activeOperation;
  }

  private cancelOperations(operations: QueuedSessionOperation[]): void {
    for (const operation of operations) {
      const viewRequestId = requestViewId(operation.request);
      operation.resolve({
        kind: "cancelled",
        targetRequestId: `session-queue:${operation.request.kind}`,
        ...(viewRequestId ? { viewRequestId } : {})
      });
    }
  }

  private isIdle(): boolean {
    return (
      !this.activeForegroundOperation &&
      !this.activeBackgroundOperation &&
      this.interactiveQueue.length === 0 &&
      this.backgroundQueue.length === 0 &&
      !this.terminalOperation
    );
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

export function sessionRequestPriority(
  request: SessionBoundRequest,
  options?: BridgeRequestOptions
): NonNullable<BridgeRequestOptions["priority"]> {
  if (options?.priority) return options.priority;
  return request.kind === "getSummary" || request.kind === "getDatasetStats" ? "background" : "interactive";
}

export function requestViewId(request: OpenWranglerRequest): string | undefined {
  return "viewRequestId" in request && typeof request.viewRequestId === "string" ? request.viewRequestId : undefined;
}

function canRunAlongsideBackground(
  request: SessionBoundRequest,
  options: BridgeRequestOptions | undefined,
  activeBackgroundRequest: SessionBoundRequest
): boolean {
  if (activeBackgroundRequest.kind !== "getSummary" && activeBackgroundRequest.kind !== "getDatasetStats") {
    return false;
  }
  return (
    request.kind === "getPage" ||
    request.kind === "getColumnValues" ||
    (request.kind === "getSummary" && options?.priority === "interactive")
  );
}

function isCancellableQueuedViewRequest(request: SessionBoundRequest): boolean {
  return request.kind === "getSummary" || request.kind === "getDatasetStats" || request.kind === "getColumnValues";
}
