import type { ErrorResponse, OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";
import { isSessionBoundRequest } from "../shared/protocol";

export interface PythonSessionRuntime {
  readonly key: string;
  readonly provisionalSessionIds: Set<string>;
  readonly sessionIds: Set<string>;
}

export interface PythonSessionPendingRequest<Runtime extends PythonSessionRuntime> {
  readonly requestId: string;
  readonly runtime: Runtime;
  readonly request: OpenWranglerRequest;
}

export interface ProvisionalSessionClaim<Runtime extends PythonSessionRuntime> {
  readonly runtime: Runtime;
  readonly openRequestId: string;
  readonly state: "pending" | "closing";
}

interface MutableProvisionalSessionClaim<
  Runtime extends PythonSessionRuntime
> extends ProvisionalSessionClaim<Runtime> {
  state: "pending" | "closing";
}

type RestartRuntime<Runtime extends PythonSessionRuntime> = (runtime: Runtime, reason: string) => void;

/**
 * Owns provisional and confirmed Python runtime-session identities.
 *
 * A requested identity is reserved before dispatch, promoted only by its exact
 * correlated open response, and removed only by its owning scope. Late,
 * ambiguous, or cross-scope responses restart only the offending scope.
 */
export class PythonSessionOwnership<Runtime extends PythonSessionRuntime> {
  private readonly confirmed = new Map<string, Runtime>();
  private readonly provisional = new Map<string, MutableProvisionalSessionClaim<Runtime>>();

  constructor(private readonly restartRuntime: RestartRuntime<Runtime>) {}

  confirmedOwner(sessionId: string): Runtime | undefined {
    return this.confirmed.get(sessionId);
  }

  provisionalClaim(sessionId: string): ProvisionalSessionClaim<Runtime> | undefined {
    const claim = this.provisional.get(sessionId);
    return claim ? { ...claim } : undefined;
  }

  reserve(request: OpenWranglerRequest, runtime: Runtime, openRequestId: string): ErrorResponse | undefined {
    if (request.kind !== "openSession" || !request.requestedSessionId) return undefined;
    const confirmedOwner = this.confirmed.get(request.requestedSessionId);
    const provisional = this.provisional.get(request.requestedSessionId);
    if (confirmedOwner || provisional) {
      const owner = confirmedOwner ?? provisional!.runtime;
      return {
        kind: "error",
        code: "duplicate_runtime_session",
        message: `Open Wrangler runtime session ${request.requestedSessionId} is already owned or reserved by Python scope ${owner.key}.`,
        recoverable: true,
        sessionId: request.requestedSessionId
      };
    }
    this.provisional.set(request.requestedSessionId, {
      runtime,
      openRequestId,
      state: "pending"
    });
    runtime.provisionalSessionIds.add(request.requestedSessionId);
    return undefined;
  }

  markProvisionalClosing(sessionId: string, runtime: Runtime): void {
    const reservation = this.provisional.get(sessionId);
    if (reservation?.runtime === runtime) reservation.state = "closing";
  }

  releaseForRequest(request: OpenWranglerRequest, openRequestId: string, runtime: Runtime): void {
    if (request.kind === "openSession" && request.requestedSessionId) {
      this.releaseProvisional(request.requestedSessionId, openRequestId, runtime);
    }
  }

  releasePendingForRequest(request: OpenWranglerRequest, openRequestId: string, runtime: Runtime): void {
    if (request.kind !== "openSession" || !request.requestedSessionId) return;
    const reservation = this.provisional.get(request.requestedSessionId);
    if (reservation?.state !== "pending") return;
    this.releaseProvisional(request.requestedSessionId, openRequestId, runtime);
  }

  releaseConfirmed(sessionId: string, runtime: Runtime): void {
    if (this.confirmed.get(sessionId) === runtime) this.confirmed.delete(sessionId);
    runtime.sessionIds.delete(sessionId);
  }

  terminateProvisional(sessionId: string, runtime: Runtime): void {
    const reservation = this.provisional.get(sessionId);
    if (reservation?.runtime !== runtime) return;
    this.provisional.delete(sessionId);
    runtime.provisionalSessionIds.delete(sessionId);
  }

  releaseRuntime(runtime: Runtime): void {
    for (const sessionId of runtime.sessionIds) {
      if (this.confirmed.get(sessionId) === runtime) this.confirmed.delete(sessionId);
    }
    runtime.sessionIds.clear();
    for (const sessionId of runtime.provisionalSessionIds) {
      if (this.provisional.get(sessionId)?.runtime === runtime) this.provisional.delete(sessionId);
    }
    runtime.provisionalSessionIds.clear();
  }

  hasClaimsFor(runtime: Runtime): boolean {
    for (const reservation of this.provisional.values()) {
      if (reservation.runtime === runtime) return true;
    }
    for (const owner of this.confirmed.values()) {
      if (owner === runtime) return true;
    }
    return false;
  }

  finalizeResponse(
    pending: PythonSessionPendingRequest<Runtime>,
    response: OpenWranglerResponse
  ): OpenWranglerResponse {
    const { request, runtime } = pending;
    if (request.kind === "openSession") return this.finalizeOpenResponse(pending, response);

    if (isSessionBoundRequest(request)) {
      const correlatedSessionId = runtimeResponseSessionId(response);
      if (correlatedSessionId && correlatedSessionId !== request.sessionId) {
        this.restartRuntime(
          runtime,
          `Runtime response named session ${correlatedSessionId} instead of ${request.sessionId}; restarting the affected Python scope.`
        );
        return invalidRuntimeSessionResponse(
          `The runtime response named session ${correlatedSessionId} instead of ${request.sessionId}.`,
          request.sessionId
        );
      }
      if (
        (request.kind === "closeSession" &&
          response.kind === "sessionClosed" &&
          response.sessionId === request.sessionId) ||
        isConfirmedUnknownSession(response, request.sessionId)
      ) {
        this.releaseConfirmed(request.sessionId, runtime);
        this.terminateProvisional(request.sessionId, runtime);
      }
    }
    return response;
  }

  private finalizeOpenResponse(
    pending: PythonSessionPendingRequest<Runtime>,
    response: OpenWranglerResponse
  ): OpenWranglerResponse {
    const { request, runtime } = pending;
    if (request.kind !== "openSession") return response;
    if (response.kind !== "sessionOpened") {
      this.releaseForRequest(request, pending.requestId, runtime);
      return response;
    }

    const actual = response.metadata.sessionId;
    const expected = request.requestedSessionId;
    if (!expected) {
      if (this.hasOtherSessionClaim(actual, runtime)) return this.duplicateSessionResponse(actual, runtime);
      this.bindConfirmed(actual, runtime);
      return response;
    }
    if (actual !== expected) {
      this.releaseForRequest(request, pending.requestId, runtime);
      this.restartRuntime(
        runtime,
        `Runtime returned session ${actual} instead of requested session ${expected}; restarting the affected Python scope.`
      );
      return invalidRuntimeSessionResponse(
        `The runtime returned session ${actual} instead of requested session ${expected}.`,
        expected
      );
    }
    if (!this.isExactProvisional(expected, pending.requestId, runtime)) {
      return this.invalidTerminatedReservationResponse(expected, runtime);
    }
    if (this.hasOtherSessionClaim(expected, runtime, pending.requestId)) {
      this.releaseForRequest(request, pending.requestId, runtime);
      return this.duplicateSessionResponse(expected, runtime);
    }
    if (!this.promoteProvisional(expected, pending.requestId, runtime)) {
      return this.invalidTerminatedReservationResponse(expected, runtime);
    }
    return response;
  }

  private releaseProvisional(sessionId: string, openRequestId: string, runtime: Runtime): void {
    const reservation = this.provisional.get(sessionId);
    if (reservation?.runtime !== runtime || reservation.openRequestId !== openRequestId) return;
    this.provisional.delete(sessionId);
    runtime.provisionalSessionIds.delete(sessionId);
  }

  private isExactProvisional(sessionId: string, openRequestId: string, runtime: Runtime): boolean {
    const reservation = this.provisional.get(sessionId);
    return (
      reservation?.runtime === runtime && reservation.openRequestId === openRequestId && reservation.state === "pending"
    );
  }

  private promoteProvisional(sessionId: string, openRequestId: string, runtime: Runtime): boolean {
    if (!this.isExactProvisional(sessionId, openRequestId, runtime)) return false;
    this.releaseProvisional(sessionId, openRequestId, runtime);
    if (this.confirmed.has(sessionId)) return false;
    this.bindConfirmed(sessionId, runtime);
    return true;
  }

  private bindConfirmed(sessionId: string, runtime: Runtime): void {
    this.confirmed.set(sessionId, runtime);
    runtime.sessionIds.add(sessionId);
  }

  private hasOtherSessionClaim(sessionId: string, runtime: Runtime, openRequestId?: string): boolean {
    if (this.confirmed.has(sessionId)) return true;
    const provisional = this.provisional.get(sessionId);
    return Boolean(
      provisional &&
      (provisional.runtime !== runtime || openRequestId === undefined || provisional.openRequestId !== openRequestId)
    );
  }

  private invalidTerminatedReservationResponse(sessionId: string, runtime: Runtime): ErrorResponse {
    this.restartRuntime(
      runtime,
      `Runtime opened session ${sessionId} after its exact candidate reservation ended; restarting the affected Python scope.`
    );
    return invalidRuntimeSessionResponse(
      `The runtime opened session ${sessionId} after its candidate reservation was no longer active.`,
      sessionId
    );
  }

  private duplicateSessionResponse(sessionId: string, runtime: Runtime): ErrorResponse {
    this.restartRuntime(
      runtime,
      `Runtime returned duplicate session ${sessionId}; restarting the affected Python scope.`
    );
    return invalidRuntimeSessionResponse(
      `The runtime returned duplicate session identity ${sessionId} from Python scope ${runtime.key}.`,
      sessionId
    );
  }
}

function invalidRuntimeSessionResponse(message: string, sessionId?: string): ErrorResponse {
  return {
    kind: "error",
    code: "invalid_runtime_response",
    message,
    recoverable: true,
    ...(sessionId ? { sessionId } : {})
  };
}

function runtimeResponseSessionId(response: OpenWranglerResponse): string | undefined {
  switch (response.kind) {
    case "sessionOpened":
    case "page":
    case "stepPreview":
    case "planUpdated":
      return response.metadata.sessionId;
    case "sessionClosed":
      return response.sessionId;
    case "error":
      return response.sessionId;
    default:
      return undefined;
  }
}

function isConfirmedUnknownSession(response: OpenWranglerResponse, sessionId: string): boolean {
  if (response.kind !== "error") return false;
  if (response.code === "unknown_session") return response.sessionId === sessionId;
  return (
    response.code === "engine_error" &&
    response.message === `Unknown session: ${sessionId}` &&
    (response.sessionId === undefined || response.sessionId === sessionId)
  );
}
