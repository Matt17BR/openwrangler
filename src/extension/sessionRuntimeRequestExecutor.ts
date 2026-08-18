import type { ColumnSchema, ErrorResponse, OpenWranglerResponse, SessionBoundRequest } from "../shared/protocol";
import { DetachedBridgeRequestError, type BridgeRequestOptions } from "./dataBridge";
import { responseMismatch } from "./sessionResponseValidation";
import {
  isCurrentLogicalView,
  isCurrentPageRequest,
  protocolError,
  SessionResponseCommitter,
  type SessionResponseCallbacks,
  type SessionResponseState
} from "./sessionResponseCommitter";
import { requestViewId, sessionRequestPriority, type SessionRequestScheduler } from "./sessionRequestScheduler";

export interface RuntimeRequestSession extends SessionResponseState {
  scheduler: SessionRequestScheduler;
  closing: boolean;
  liveReconnectRequired: boolean;
  recoveryRequired: boolean;
}

export interface RuntimeRequestHooks {
  isCoordinatorAvailable(): boolean;
  waitForRuntimeSettlement(): Promise<void>;
  installRuntimeSettlement(settlement: Promise<void>): void;
  replay(options: BridgeRequestOptions): Promise<boolean>;
  replayAfterRuntimeLoss(
    failedRuntimeId: string,
    options: BridgeRequestOptions,
    requiredSchema?: readonly ColumnSchema[],
    isStillCurrent?: () => boolean
  ): Promise<boolean>;
  close(options?: BridgeRequestOptions): Promise<OpenWranglerResponse>;
  responseCallbacks: SessionResponseCallbacks;
}

export class SessionRuntimeRequestExecutor {
  constructor(private readonly responseCommitter: SessionResponseCommitter) {}

  async execute(
    session: RuntimeRequestSession,
    publicRequest: SessionBoundRequest,
    options: BridgeRequestOptions | undefined,
    hooks: RuntimeRequestHooks
  ): Promise<OpenWranglerResponse> {
    // A notebook deadline stops only the host wait. Later work stays behind
    // the exact detached request so it cannot overtake an ambiguous mutation.
    await hooks.waitForRuntimeSettlement();
    if (publicRequest.kind !== "closeSession" && publicRequest.revision !== session.publicRevision) {
      return protocolError(
        "stale_request",
        `Ignored stale queued request revision ${publicRequest.revision}; current revision is ${session.publicRevision}.`,
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }
    if (publicRequest.kind !== "closeSession" && session.liveReconnectRequired) {
      return protocolError(
        "pyspark_connect_state_lost",
        `The Spark server no longer has ${session.openRequest.source.label}. Run the cell that creates it, then choose Reconnect.`,
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }
    if (publicRequest.kind !== "closeSession" && session.recoveryRequired) {
      const recovered =
        hooks.isCoordinatorAvailable() && !session.closing && (await hooks.replay(runtimeRecoveryOptions()));
      if (!recovered) {
        return protocolError(
          "runtime_recovery_failed",
          "The prior runtime mutation had an ambiguous transport result and the confirmed session could not be restored.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      session.recoveryRequired = false;
    }
    let requestRuntimeId = session.runtimeId;
    let requestRuntimeRevision = session.runtimeRevision;
    const previousFilterModel = session.metadata.filterModel;
    const isBackground = sessionRequestPriority(publicRequest, options) === "background";
    const rendererBackgroundRead =
      isBackground && isRecoverableRendererBackgroundRead(publicRequest) && options?.viewContextId !== undefined;
    const requestWasCancelled = (): boolean => session.scheduler.isCancelled(requestViewId(publicRequest));
    const rendererBackgroundReadIsCurrent = (): boolean =>
      rendererBackgroundRead && !requestWasCancelled() && isCurrentLogicalView(session, options);
    const canRecoverUnknownSession = (): boolean =>
      hooks.isCoordinatorAvailable() && !session.closing && (!isBackground || rendererBackgroundReadIsCurrent());
    const canRecoverTransport = (): boolean => canRecoverUnknownSession() && isIdempotentReadRequest(publicRequest);
    const liveSourceRecoveryIsCurrent = (): boolean => {
      if (requestWasCancelled()) return false;
      if (publicRequest.kind === "getPage") {
        return options?.ephemeralPage === true
          ? isCurrentLogicalView(session, options)
          : isCurrentPageRequest(session, publicRequest, options);
      }
      return isCurrentLogicalView(session, options);
    };
    const staleBackgroundResponse = (): OpenWranglerResponse =>
      protocolError(
        "stale_response",
        "Ignored a cancelled or superseded profiling request before runtime recovery.",
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    const staleLiveSourceResponse = (): OpenWranglerResponse =>
      protocolError(
        "stale_response",
        "Ignored a cancelled or superseded read before live PySpark recovery.",
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    const runtimeRequest = (): SessionBoundRequest =>
      ({
        ...publicRequest,
        sessionId: session.runtimeId,
        revision: session.runtimeRevision
      }) as SessionBoundRequest;

    if (publicRequest.kind === "closeSession") return hooks.close(options);

    let response: OpenWranglerResponse;
    try {
      response = await session.delegate.request(runtimeRequest(), options);
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError) {
        hooks.installRuntimeSettlement(error.settlement);
        if (error.dispatched && isRuntimeStateMutation(publicRequest)) session.recoveryRequired = true;
        throw error;
      }
      if (isRuntimeStateMutation(publicRequest)) session.recoveryRequired = true;
      if (rendererBackgroundRead && !requestWasCancelled() && !isCurrentLogicalView(session, options)) {
        return staleBackgroundResponse();
      }
      const recovered =
        canRecoverTransport() &&
        (await hooks.replayAfterRuntimeLoss(requestRuntimeId, automaticRecoveryOptions(options)));
      if (!recovered) throw error;
      if (rendererBackgroundRead && !rendererBackgroundReadIsCurrent()) {
        if (requestWasCancelled()) throw error;
        return staleBackgroundResponse();
      }
      requestRuntimeId = session.runtimeId;
      requestRuntimeRevision = session.runtimeRevision;
      response = await session.delegate.request(runtimeRequest(), options);
    }

    if (isUnknownRuntimeSession(response, requestRuntimeId)) {
      const unknownValidationRequest = runtimeValidationRequest(
        publicRequest,
        requestRuntimeId,
        requestRuntimeRevision
      );
      const unknownMismatch = responseMismatch(
        unknownValidationRequest,
        response,
        requestRuntimeId,
        session.metadata.schema
      );
      if (unknownMismatch) return invalidRuntimeResponse(publicRequest, session.publicId, unknownMismatch);
      const confirmedUnknownResponse = { ...response };
      if (rendererBackgroundRead && !requestWasCancelled() && !isCurrentLogicalView(session, options)) {
        return staleBackgroundResponse();
      }
      const recovered =
        canRecoverUnknownSession() &&
        (await hooks.replayAfterRuntimeLoss(requestRuntimeId, automaticRecoveryOptions(options)));
      if (recovered) {
        if (rendererBackgroundRead && !rendererBackgroundReadIsCurrent()) {
          if (requestWasCancelled()) return { ...confirmedUnknownResponse, sessionId: session.publicId };
          return staleBackgroundResponse();
        }
        session.recoveryRequired = false;
        requestRuntimeId = session.runtimeId;
        requestRuntimeRevision = session.runtimeRevision;
        response = await session.delegate.request(runtimeRequest(), options);
      }
    }

    if (isLiveSourceInvalidated(response, requestRuntimeId)) {
      const invalidatedValidationRequest = runtimeValidationRequest(
        publicRequest,
        requestRuntimeId,
        requestRuntimeRevision
      );
      const invalidatedMismatch = responseMismatch(
        invalidatedValidationRequest,
        response,
        requestRuntimeId,
        session.metadata.schema
      );
      if (invalidatedMismatch) return invalidRuntimeResponse(publicRequest, session.publicId, invalidatedMismatch);
      if (!liveSourceRecoveryIsCurrent()) return staleLiveSourceResponse();
      const recovered =
        canRecoverTransport() &&
        liveSourceRecoveryIsCurrent() &&
        (await hooks.replayAfterRuntimeLoss(
          requestRuntimeId,
          automaticRecoveryOptions(options, requestRuntimeId),
          session.metadata.schema,
          liveSourceRecoveryIsCurrent
        ));
      if (recovered) {
        if (!liveSourceRecoveryIsCurrent()) return staleLiveSourceResponse();
        session.recoveryRequired = false;
        requestRuntimeId = session.runtimeId;
        requestRuntimeRevision = session.runtimeRevision;
        response = await session.delegate.request(runtimeRequest(), options);
      }
    }

    if (requestRuntimeId !== session.runtimeId) {
      return protocolError(
        "stale_response",
        "Ignored a response from a replaced runtime session.",
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }

    const validationRequest = runtimeValidationRequest(publicRequest, requestRuntimeId, requestRuntimeRevision);
    const mismatch = responseMismatch(validationRequest, response, requestRuntimeId, session.metadata.schema);
    if (mismatch) {
      if (isRuntimeStateMutation(publicRequest)) session.recoveryRequired = true;
      return invalidRuntimeResponse(publicRequest, session.publicId, mismatch);
    }
    if (options?.ephemeralPage === true && requestWasCancelled()) {
      return protocolError(
        "stale_response",
        "Ignored a cancelled clipboard page after its correlated runtime request settled.",
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }
    if (isPySparkConnectStateLost(response, requestRuntimeId)) {
      session.liveReconnectRequired = true;
      session.scheduler.cancelBackground();
    }

    return this.responseCommitter.commit(
      session,
      publicRequest,
      response,
      requestRuntimeRevision,
      previousFilterModel,
      options,
      hooks.responseCallbacks
    );
  }
}

export function isRuntimeStateMutation(request: SessionBoundRequest): boolean {
  return (
    request.kind === "previewStep" ||
    request.kind === "applyDraft" ||
    request.kind === "discardDraft" ||
    request.kind === "undoStep"
  );
}

export function runtimeRecoveryOptions(): BridgeRequestOptions {
  return { priority: "interactive" };
}

export function automaticRecoveryOptions(
  options?: BridgeRequestOptions,
  requiredKernelSessionId?: string
): BridgeRequestOptions {
  return { ...options, priority: "interactive", ...(requiredKernelSessionId ? { requiredKernelSessionId } : {}) };
}

export function recoveryFollowupOptions(options?: BridgeRequestOptions): BridgeRequestOptions | undefined {
  if (!options?.requiredKernelSessionId) return options;
  const { requiredKernelSessionId: _requiredKernelSessionId, ...followup } = options;
  return followup;
}

function isIdempotentReadRequest(request: SessionBoundRequest): boolean {
  return (
    request.kind === "getPage" ||
    request.kind === "getSummary" ||
    request.kind === "getDatasetStats" ||
    request.kind === "getColumnValues" ||
    request.kind === "inspectStep"
  );
}

function isRecoverableRendererBackgroundRead(request: SessionBoundRequest): boolean {
  return request.kind === "getSummary" || request.kind === "getDatasetStats";
}

function runtimeValidationRequest(
  request: SessionBoundRequest,
  runtimeId: string,
  runtimeRevision: number
): SessionBoundRequest {
  return { ...request, sessionId: runtimeId, revision: runtimeRevision } as SessionBoundRequest;
}

function invalidRuntimeResponse(
  request: SessionBoundRequest,
  publicSessionId: string,
  mismatch: string
): ErrorResponse {
  return protocolError(
    "invalid_runtime_response",
    `Ignored an invalid ${request.kind} response: ${mismatch}`,
    true,
    publicSessionId,
    requestViewId(request)
  );
}

function isUnknownRuntimeSession(
  response: OpenWranglerResponse,
  expectedSessionId: string
): response is ErrorResponse & { code: "unknown_session" | "engine_error" } {
  if (response.kind !== "error") return false;
  if (response.code === "unknown_session") return response.sessionId === expectedSessionId;
  return (
    response.code === "engine_error" &&
    response.message === `Unknown session: ${expectedSessionId}` &&
    (response.sessionId === undefined || response.sessionId === expectedSessionId)
  );
}

function isLiveSourceInvalidated(
  response: OpenWranglerResponse,
  expectedSessionId: string
): response is ErrorResponse & { code: "live_source_invalidated" } {
  return (
    response.kind === "error" &&
    response.code === "live_source_invalidated" &&
    response.recoverable &&
    response.sessionId === expectedSessionId
  );
}

function isPySparkConnectStateLost(
  response: OpenWranglerResponse,
  expectedSessionId: string
): response is ErrorResponse & { code: "pyspark_connect_state_lost" } {
  return (
    response.kind === "error" &&
    response.code === "pyspark_connect_state_lost" &&
    response.recoverable &&
    response.sessionId === expectedSessionId
  );
}
