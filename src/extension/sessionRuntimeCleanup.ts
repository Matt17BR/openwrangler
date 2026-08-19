import type { ErrorResponse, OpenWranglerResponse } from "../shared/protocol";
import { DetachedBridgeRequestError, type BridgeRequestOptions, type OpenWranglerBridge } from "./dataBridge";

const RUNTIME_CLEANUP_TIMEOUT_MS = 2_000;

export type RuntimeCleanupRole =
  | "import candidate"
  | "plan rewrite candidate"
  | "recovery candidate"
  | "retired runtime"
  | "saved-plan fallback runtime"
  | "failed saved-state runtime"
  | "editing candidate"
  | "viewing candidate"
  | "invalid open runtime"
  | "late-open runtime"
  | "terminal runtime";

export interface RuntimeCleanupTarget {
  readonly runtimeId: string;
  readonly runtimeRevision: number;
  readonly delegate: OpenWranglerBridge;
}

type DelegateIsActive = (delegate: OpenWranglerBridge) => boolean;

/**
 * Owns bounded runtime-session cleanup and delegate-idle publication.
 *
 * Detached replacement cleanup is deliberately tracked outside a live public
 * session. A delegate becomes idle only after its last coordinator owner and
 * every detached cleanup have both settled.
 */
export class SessionRuntimeCleanup {
  private readonly detached = new Set<Promise<void>>();
  private readonly detachedCounts = new Map<OpenWranglerBridge, number>();

  constructor(
    private readonly delegateIsActive: DelegateIsActive,
    private readonly diagnosticSink?: (message: string) => void
  ) {}

  async closeTerminal(target: RuntimeCleanupTarget, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    try {
      const response = await target.delegate.request(
        {
          kind: "closeSession",
          sessionId: target.runtimeId,
          revision: target.runtimeRevision
        },
        terminalRuntimeCleanupOptions(options)
      );
      if (response.kind === "sessionClosed" && response.sessionId === target.runtimeId) return response;
      if (isTerminalSessionCleanupFailure(response, target.runtimeId)) {
        this.report(target, "terminal runtime", `runtime cleanup completed with an error: ${response.message}`);
        return response;
      }

      this.report(
        target,
        "terminal runtime",
        `initial close was not authoritative: ${cleanupResponseDescription(response, target.runtimeId)}`
      );
      await this.close(target, "terminal runtime");
      return response;
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError) {
        this.report(
          target,
          "terminal runtime",
          "the host stopped waiting; the original exact-kernel close remains observed"
        );
        throw error;
      }
      this.report(
        target,
        "terminal runtime",
        `initial close transport failed: ${error instanceof Error ? error.message : String(error)}`
      );
      await this.close(target, "terminal runtime");
      throw error;
    }
  }

  async close(
    target: RuntimeCleanupTarget,
    role: RuntimeCleanupRole,
    options: BridgeRequestOptions = runtimeCleanupOptions(),
    unknownSessionIsClean = false
  ): Promise<void> {
    try {
      const response = await target.delegate.request(
        {
          kind: "closeSession",
          sessionId: target.runtimeId,
          revision: target.runtimeRevision
        },
        options
      );
      if (response.kind === "sessionClosed" && response.sessionId === target.runtimeId) return;
      if (unknownSessionIsClean && isConfirmedAbsentSession(response, target.runtimeId)) return;
      this.report(target, role, cleanupResponseDescription(response, target.runtimeId));
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError) {
        // The bridge still owns and observes this exact close. Keep retired
        // runtime accounting live until that request really settles; never
        // issue a second close merely because the host waiter detached.
        await error.settlement;
        return;
      }
      this.report(target, role, error instanceof Error ? error.message : String(error));
    }
  }

  track(target: RuntimeCleanupTarget, role: RuntimeCleanupRole): void {
    const cleanup = this.close(target, role);
    this.trackDelegateSettlement(target.delegate, cleanup);
  }

  /**
   * Retains one already-owned delegate settlement for coordinator shutdown and
   * idle accounting without making the request that installed it wait.
   */
  trackDelegateSettlement(delegate: OpenWranglerBridge, settlement: Promise<void>): Promise<void> {
    const cleanup = settlement.then(
      () => undefined,
      () => undefined
    );
    this.detached.add(cleanup);
    this.detachedCounts.set(delegate, (this.detachedCounts.get(delegate) ?? 0) + 1);
    const complete = (): void => {
      this.detached.delete(cleanup);
      const remaining = (this.detachedCounts.get(delegate) ?? 1) - 1;
      if (remaining > 0) this.detachedCounts.set(delegate, remaining);
      else this.detachedCounts.delete(delegate);
      this.releaseIfIdle(delegate);
    };
    void cleanup.then(complete, complete);
    return cleanup;
  }

  async waitForTracked(): Promise<void> {
    while (this.detached.size > 0) {
      await Promise.allSettled([...this.detached]);
    }
  }

  releaseIfIdle(delegate: OpenWranglerBridge): void {
    if (!this.detachedCounts.has(delegate) && !this.delegateIsActive(delegate)) delegate.onIdle?.();
  }

  private report(target: RuntimeCleanupTarget, role: RuntimeCleanupRole, detail: string): void {
    const message = `Open Wrangler could not confirm cleanup of ${role} session ${target.runtimeId}: ${detail}`;
    try {
      if (target.delegate.reportDiagnostic) target.delegate.reportDiagnostic(message);
      else this.diagnosticSink?.(message);
    } catch {
      try {
        this.diagnosticSink?.(message);
      } catch {
        // Diagnostics must never destabilize the live replacement session.
      }
    }
  }
}

export function runtimeCleanupOptions(): BridgeRequestOptions {
  return {
    priority: "interactive",
    timeoutMs: RUNTIME_CLEANUP_TIMEOUT_MS,
    restartRuntimeOnTimeout: false,
    startRuntimeIfNeeded: false
  };
}

function terminalRuntimeCleanupOptions(options?: BridgeRequestOptions): BridgeRequestOptions {
  return {
    ...options,
    priority: "interactive",
    timeoutMs: options?.timeoutMs ?? RUNTIME_CLEANUP_TIMEOUT_MS,
    restartRuntimeOnTimeout: false,
    startRuntimeIfNeeded: false
  };
}

function isConfirmedAbsentSession(response: OpenWranglerResponse, expectedSessionId: string): boolean {
  if (response.kind !== "error") return false;
  if (response.code === "unknown_session") return response.sessionId === expectedSessionId;
  return (
    response.code === "engine_error" &&
    response.message === `Unknown session: ${expectedSessionId}` &&
    (response.sessionId === undefined || response.sessionId === expectedSessionId)
  );
}

function isTerminalSessionCleanupFailure(
  response: OpenWranglerResponse,
  expectedSessionId: string
): response is ErrorResponse & { code: "session_cleanup_failed" } {
  return (
    response.kind === "error" &&
    response.code === "session_cleanup_failed" &&
    response.recoverable === false &&
    response.sessionId === expectedSessionId
  );
}

function cleanupResponseDescription(response: OpenWranglerResponse, expectedSessionId: string): string {
  if (response.kind === "sessionClosed") {
    return `runtime acknowledged session ${response.sessionId} instead of ${expectedSessionId}`;
  }
  if (response.kind === "error") return `${response.code}: ${response.message}`;
  if (response.kind === "cancelled") return `close was cancelled (${response.targetRequestId})`;
  return `runtime returned ${response.kind}`;
}
