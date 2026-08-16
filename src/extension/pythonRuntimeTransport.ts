import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  ErrorResponse,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope
} from "../shared/protocol";
import { PROTOCOL_VERSION } from "../shared/protocol";
import { isRuntimeResponseEnvelope } from "../shared/protocolValidation";
import type { BridgeRequestOptions } from "./dataBridge";
import { runtimeRequestTimeoutMs } from "./configuration";
import {
  PythonSessionOwnership,
  type PythonSessionPendingRequest,
  type PythonSessionRuntime
} from "./pythonSessionOwnership";

export interface PythonRuntimeTransportSlot extends PythonSessionRuntime {
  readonly pendingIds: Set<string>;
  process: ChildProcessWithoutNullStreams | undefined;
  processStart: Promise<ChildProcessWithoutNullStreams> | undefined;
  runtimeExitError: Error | undefined;
}

interface PendingRequest<Runtime extends PythonRuntimeTransportSlot> extends PythonSessionPendingRequest<Runtime> {
  resolve: (response: OpenWranglerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cancellation?: { dispose(): void };
  cancellationRequestId?: string;
  cancellationRequested: boolean;
  dispatched: boolean;
}

export interface PythonRuntimeTransportHooks<Runtime extends PythonRuntimeTransportSlot> {
  readonly sessionOwnership: PythonSessionOwnership<Runtime>;
  restartRuntime(runtime: Runtime, reason: string): void;
  stopRuntimeIfIdle(runtime: Runtime): void;
  runtimeUnavailableError(runtime: Runtime, error?: unknown): Error;
  reportDiagnostic(message: string): void;
}

/** Owns correlated runtime requests, authoritative cancellation, and response framing. */
export class PythonRuntimeTransport<Runtime extends PythonRuntimeTransportSlot> {
  private readonly pending = new Map<string, PendingRequest<Runtime>>();
  private readonly cancellationTargets = new Map<string, { targetRequestId: string; runtime: Runtime }>();

  constructor(private readonly hooks: PythonRuntimeTransportHooks<Runtime>) {}

  runtimeForCancellation(targetRequestId: string): Runtime | undefined {
    return this.pending.get(targetRequestId)?.runtime;
  }

  hasOwnership(runtime: Runtime): boolean {
    for (const pending of this.pending.values()) {
      if (pending.runtime === runtime) return true;
    }
    for (const target of this.cancellationTargets.values()) {
      if (target.runtime === runtime) return true;
    }
    return false;
  }

  cancellationUnavailable(targetRequestId: string): ErrorResponse {
    return {
      kind: "error",
      code: "cancellation_unavailable",
      message: `Open Wrangler runtime request ${targetRequestId} is not available for cancellation.`,
      recoverable: true
    };
  }

  dispatch(
    runtime: Runtime,
    proc: ChildProcessWithoutNullStreams,
    request: OpenWranglerRequest,
    options: BridgeRequestOptions,
    releaseLease: () => void
  ): Promise<OpenWranglerResponse> {
    const requestId = randomUUID();
    const provisionalError = this.hooks.sessionOwnership.reserve(request, runtime, requestId);
    if (provisionalError) {
      this.hooks.stopRuntimeIfIdle(runtime);
      releaseLease();
      return Promise.resolve(provisionalError);
    }
    const envelope: RuntimeRequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      priority:
        options.priority ??
        (request.kind === "getSummary" || request.kind === "getDatasetStats" ? "background" : "interactive"),
      request
    };
    const timeoutMs = runtimeRequestTimeoutMs(request, options.timeoutMs);

    return new Promise<OpenWranglerResponse>((resolve, reject) => {
      if (runtime.runtimeExitError) {
        this.hooks.sessionOwnership.releaseForRequest(request, requestId, runtime);
        releaseLease();
        reject(runtime.runtimeExitError);
        return;
      }
      if (proc.stdin.destroyed || !proc.stdin.writable) {
        this.hooks.sessionOwnership.releaseForRequest(request, requestId, runtime);
        releaseLease();
        reject(this.hooks.runtimeUnavailableError(runtime));
        return;
      }

      const timer = setTimeout(() => {
        const pending = this.takePending(requestId);
        if (!pending) return;
        this.sendCancellation(runtime, requestId, false);
        pending.reject(new Error(`Open Wrangler runtime request ${request.kind} timed out after ${timeoutMs} ms.`));
        if (request.kind === "openSession" || options.restartRuntimeOnTimeout !== false) {
          this.hooks.restartRuntime(runtime, "Runtime request timed out; restarting so sessions can be replayed.");
        } else {
          this.hooks.sessionOwnership.releasePendingForRequest(pending.request, pending.requestId, pending.runtime);
          this.hooks.stopRuntimeIfIdle(pending.runtime);
        }
      }, timeoutMs);
      const pending: PendingRequest<Runtime> = {
        requestId,
        resolve,
        reject,
        timer,
        runtime,
        request,
        cancellationRequested: false,
        dispatched: false
      };
      this.pending.set(requestId, pending);
      runtime.pendingIds.add(requestId);
      releaseLease();
      const cancellation = options.cancellation?.onCancellationRequested(() => this.cancelRequest(requestId));
      pending.cancellation = cancellation;
      if (!this.pending.has(requestId)) cancellation?.dispose();
      if (options.cancellation?.isCancellationRequested) this.cancelRequest(requestId);
      if (!this.pending.has(requestId)) return;

      try {
        pending.dispatched = true;
        proc.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
          if (!error) return;
          const pending = this.takePending(requestId);
          if (pending) {
            this.hooks.sessionOwnership.releasePendingForRequest(pending.request, pending.requestId, runtime);
            pending.reject(this.hooks.runtimeUnavailableError(runtime, error));
          }
          this.hooks.stopRuntimeIfIdle(runtime);
        });
      } catch (error) {
        const pending = this.takePending(requestId);
        if (pending) {
          this.hooks.sessionOwnership.releasePendingForRequest(pending.request, pending.requestId, runtime);
          pending.reject(this.hooks.runtimeUnavailableError(runtime, error));
        }
        this.hooks.stopRuntimeIfIdle(runtime);
      }
    });
  }

  handleLine(runtime: Runtime, proc: ChildProcessWithoutNullStreams, line: string): void {
    if (runtime.process !== proc) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.hooks.reportDiagnostic("Invalid runtime response: non-JSON payload omitted.");
      return;
    }
    if (!isRuntimeResponseEnvelope(parsed)) {
      this.hooks.reportDiagnostic("Invalid runtime response: non-protocol-v2 payload omitted.");
      return;
    }
    const envelope: RuntimeResponseEnvelope = parsed;

    const cancellationTarget = this.cancellationTargets.get(envelope.requestId);
    if (cancellationTarget) {
      if (cancellationTarget.runtime !== runtime) {
        this.hooks.reportDiagnostic(
          `Ignored a cancellation response from Python scope ${runtime.key} owned by ${cancellationTarget.runtime.key}.`
        );
        return;
      }
      this.cancellationTargets.delete(envelope.requestId);
      const target = this.pending.get(cancellationTarget.targetRequestId);
      if (target?.cancellationRequestId === envelope.requestId) target.cancellationRequestId = undefined;
      if (
        envelope.response.kind === "cancelled" &&
        envelope.response.targetRequestId === cancellationTarget.targetRequestId
      ) {
        this.hooks.reportDiagnostic(
          `Open Wrangler runtime accepted cancellation for queued request ${cancellationTarget.targetRequestId}; waiting for that request's correlated response.`
        );
      } else if (envelope.response.kind !== "error" || envelope.response.code !== "cancellation_unavailable") {
        this.hooks.reportDiagnostic(
          `Open Wrangler runtime returned ${envelope.response.kind} while cancelling request ${cancellationTarget.targetRequestId}; waiting for the authoritative result.`
        );
      }
      return;
    }

    const owner = this.pending.get(envelope.requestId);
    if (owner && owner.runtime !== runtime) {
      this.hooks.reportDiagnostic(
        `Ignored a response from Python scope ${runtime.key} for a request owned by ${owner.runtime.key}.`
      );
      return;
    }
    const pending = this.takePending(envelope.requestId);
    if (!pending) return;
    pending.resolve(this.hooks.sessionOwnership.finalizeResponse(pending, envelope.response));
    this.hooks.stopRuntimeIfIdle(runtime);
  }

  rejectRuntime(runtime: Runtime, error: Error): void {
    for (const requestId of [...runtime.pendingIds]) this.takePending(requestId)?.reject(error);
    for (const [requestId, target] of this.cancellationTargets) {
      if (target.runtime === runtime) this.cancellationTargets.delete(requestId);
    }
  }

  private takePending(requestId: string): PendingRequest<Runtime> | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    pending.runtime.pendingIds.delete(requestId);
    clearTimeout(pending.timer);
    try {
      pending.cancellation?.dispose();
    } catch (error) {
      try {
        this.hooks.reportDiagnostic(
          `Open Wrangler could not dispose a runtime cancellation listener: ${error instanceof Error ? error.message : String(error)}`
        );
      } catch {
        // Pending ownership must still be released when diagnostics are unavailable.
      }
    }
    if (pending.cancellationRequestId) this.cancellationTargets.delete(pending.cancellationRequestId);
    return pending;
  }

  private cancelRequest(targetRequestId: string): void {
    const pending = this.pending.get(targetRequestId);
    if (!pending || pending.cancellationRequested) return;
    pending.cancellationRequested = true;
    if (!pending.dispatched) {
      const cancelled = this.takePending(targetRequestId);
      if (cancelled) {
        this.hooks.sessionOwnership.releasePendingForRequest(cancelled.request, cancelled.requestId, cancelled.runtime);
        cancelled.resolve({ kind: "cancelled", targetRequestId: "not-started" });
        this.hooks.stopRuntimeIfIdle(cancelled.runtime);
      }
      return;
    }
    this.sendCancellation(pending.runtime, targetRequestId, true);
  }

  private sendCancellation(runtime: Runtime, targetRequestId: string, trackResponse: boolean): void {
    const proc = runtime.process;
    if (!proc?.stdin.writable) return;
    const requestId = randomUUID();
    const envelope: RuntimeRequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      priority: "interactive",
      request: { kind: "cancelRequest", targetRequestId }
    };
    if (trackResponse) {
      const pending = this.pending.get(targetRequestId);
      if (!pending || pending.runtime !== runtime) return;
      pending.cancellationRequestId = requestId;
      this.cancellationTargets.set(requestId, { targetRequestId, runtime });
    }
    try {
      proc.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (!error || !trackResponse) return;
        this.clearCancellationRequest(requestId, targetRequestId);
        this.hooks.reportDiagnostic(
          `Open Wrangler could not request cancellation for ${targetRequestId}: ${error.message}. Waiting for the authoritative result.`
        );
      });
    } catch (error) {
      if (!trackResponse) return;
      this.clearCancellationRequest(requestId, targetRequestId);
      this.hooks.reportDiagnostic(
        `Open Wrangler could not request cancellation for ${targetRequestId}: ${error instanceof Error ? error.message : String(error)}. Waiting for the authoritative result.`
      );
    }
  }

  private clearCancellationRequest(requestId: string, targetRequestId: string): void {
    this.cancellationTargets.delete(requestId);
    const pending = this.pending.get(targetRequestId);
    if (pending?.cancellationRequestId === requestId) pending.cancellationRequestId = undefined;
  }
}
