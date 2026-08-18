import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  DataBackend,
  OpenSessionRequest,
  OpenWranglerResponse,
  PageResponse,
  SessionMetadata,
  SessionMode,
  SessionOpenedResponse,
  SessionSource,
  TransformStep
} from "../shared/protocol";
import type { PersistedViewingState } from "../shared/viewState";
import { isOpenWranglerRequest } from "../shared/protocolValidation";
import type { BridgeRequestOptions } from "./dataBridge";
import { persistedSessionState } from "./sessionPersistence";
import { sessionOpenedResponseMismatch } from "./sessionResponseValidation";
import {
  protocolError,
  publicMetadata,
  SessionResponseCommitter,
  type SessionResponseState
} from "./sessionResponseCommitter";
import { SessionRuntimeCleanup, runtimeCleanupOptions } from "./sessionRuntimeCleanup";
import { recoveryFollowupOptions } from "./sessionRuntimeRequestExecutor";
import {
  gridState,
  initialViewingState,
  RuntimeStateRestoreError,
  SessionRuntimeStateRestorer,
  type RuntimeSessionState
} from "./sessionRuntimeStateRestorer";

class ReconfigurationCancelledError extends Error {}
class ReconfigurationSupersededError extends Error {}

export interface RuntimeReconfigurationSession extends SessionResponseState {
  backendPreference?: DataBackend;
  closing: boolean;
  recoveryRequired: boolean;
}

export interface RuntimeReconfigurationHooks {
  isCoordinatorAvailable(): boolean;
  isCurrent(): boolean;
  originMismatch(request: OpenSessionRequest): string | undefined;
  recoverConfirmedRuntime(): Promise<boolean>;
  invalidateStepInspection(): void;
}

export class SessionRuntimeReconfigurer {
  constructor(
    private readonly runtimeCleanup: SessionRuntimeCleanup,
    private readonly runtimeStateRestorer: SessionRuntimeStateRestorer,
    private readonly responseCommitter: SessionResponseCommitter
  ) {}

  async reopenLiveSessionInMode(
    session: RuntimeReconfigurationSession,
    mode: SessionMode,
    options: BridgeRequestOptions | undefined,
    hooks: RuntimeReconfigurationHooks
  ): Promise<OpenWranglerResponse> {
    const displayMode = modeName(mode);
    if (!hooks.isCurrent()) {
      return protocolError(
        hooks.isCoordinatorAvailable() ? "session_closing" : "coordinator_disposed",
        `The live session closed before ${displayMode} mode could open.`,
        false,
        session.publicId
      );
    }
    if (mode === "viewing" && (session.metadata.steps.length > 0 || session.metadata.draftStep)) {
      return protocolError(
        "viewing_mode_unavailable",
        "Discard the draft and undo every applied step before switching to Viewing mode.",
        true,
        session.publicId
      );
    }
    const originMismatch = hooks.originMismatch(session.openRequest);
    if (originMismatch) return protocolError("invalid_source_origin", originMismatch, true, session.publicId);

    const previous = runtimeState(session);
    const candidateSessionId = randomUUID();
    const candidateRequest: OpenSessionRequest = {
      ...session.openRequest,
      backend: session.metadata.backend,
      mode,
      requestedSessionId: candidateSessionId
    };
    let candidate: RuntimeSessionState | undefined;
    let candidateCleanupAttempted = false;
    const cleanupCandidate = async (): Promise<void> => {
      if (candidateCleanupAttempted) return;
      candidateCleanupAttempted = true;
      await this.runtimeCleanup.close(
        candidate ?? candidateShell(session, candidateSessionId),
        `${mode} candidate`,
        runtimeCleanupOptions(),
        true
      );
    };

    let response: OpenWranglerResponse;
    try {
      response = await session.delegate.request(candidateRequest, {
        ...options,
        requiredKernelSessionId: previous.runtimeId
      });
    } catch (error) {
      await cleanupCandidate();
      return protocolError(
        `${mode}_mode_open_failed`,
        `Open Wrangler could not confirm the ${displayMode} session: ${error instanceof Error ? error.message : String(error)}`,
        true,
        session.publicId
      );
    }
    if (response.kind === "error") {
      await cleanupCandidate();
      if (response.sessionId && response.sessionId !== candidateSessionId) {
        return protocolError(
          "invalid_runtime_response",
          `Ignored an error for ${displayMode} mode correlated to runtime session ${response.sessionId} instead of ${candidateSessionId}.`,
          true,
          session.publicId
        );
      }
      return response.sessionId ? { ...response, sessionId: session.publicId } : response;
    }
    if (response.kind === "cancelled") {
      await cleanupCandidate();
      return response;
    }
    if (response.kind !== "sessionOpened") {
      await cleanupCandidate();
      return protocolError(
        "invalid_runtime_response",
        `The runtime returned ${response.kind} while opening ${displayMode} mode.`,
        true,
        session.publicId
      );
    }

    candidate = runtimeCandidate(session, candidateSessionId, response.metadata);
    const openedMismatch = sessionOpenedResponseMismatch(candidateRequest, response, true);
    if (openedMismatch) {
      await cleanupCandidate();
      return protocolError(
        "invalid_runtime_response",
        `Ignored an invalid ${displayMode} openSession response: ${openedMismatch}`,
        true,
        session.publicId
      );
    }
    const assertCandidateCurrent = (): void => {
      if (!hooks.isCurrent() || hooks.originMismatch(candidateRequest)) throw new ReconfigurationSupersededError();
    };
    let page: PageResponse;
    try {
      assertCandidateCurrent();
      page = await this.runtimeStateRestorer.restoreOneViewingState(
        candidate,
        session.viewState,
        candidateRequest.pageSize,
        candidateRequest.columnOffset,
        candidateRequest.columnLimit,
        "saved",
        recoveryFollowupOptions(options),
        assertCandidateCurrent
      );
      assertCandidateCurrent();
    } catch (error) {
      await cleanupCandidate();
      return protocolError(
        error instanceof ReconfigurationSupersededError ? "invalid_source_origin" : `${mode}_mode_view_restore_failed`,
        error instanceof ReconfigurationSupersededError
          ? `The live dataframe source changed while ${displayMode} mode was opening.`
          : `Open Wrangler could not restore the current view in ${displayMode} mode: ${
              error instanceof Error ? error.message : String(error)
            }`,
        true,
        session.publicId
      );
    }
    const publicRevision = session.publicRevision + 1;
    publishCandidate(session, candidate, candidateRequest, publicRevision);
    session.draftPresentation = undefined;
    session.draftBaseFilterModel = undefined;
    hooks.invalidateStepInspection();
    candidateCleanupAttempted = true;
    candidate = undefined;
    this.runtimeCleanup.track(previous, "retired runtime");
    await this.responseCommitter.persistSession(session);
    return publicOpenedResponse(
      { kind: "sessionOpened", metadata: session.metadata, page: page.page, summaries: [] },
      session.publicId,
      publicRevision,
      session.openRequest.source
    );
  }

  async rewriteCleaningPlan(
    session: RuntimeReconfigurationSession,
    steps: readonly TransformStep[],
    view: PersistedViewingState,
    pageWindow: { offset: number; limit: number; columnOffset: number; columnLimit: number },
    options: BridgeRequestOptions | undefined,
    hooks: RuntimeReconfigurationHooks
  ): Promise<OpenWranglerResponse> {
    if (!hooks.isCurrent()) {
      return protocolError(
        hooks.isCoordinatorAvailable() ? "session_closing" : "coordinator_disposed",
        "The session closed before its cleaning plan could be changed.",
        false,
        session.publicId
      );
    }
    const originMismatch = hooks.originMismatch(session.openRequest);
    if (originMismatch) return protocolError("invalid_source_origin", originMismatch, true, session.publicId);

    const previous = runtimeState(session);
    const candidateSessionId = randomUUID();
    const candidateRequest: OpenSessionRequest = {
      ...session.openRequest,
      backend: session.metadata.backend,
      mode: session.metadata.mode,
      requestedSessionId: candidateSessionId,
      cloneFrom: { sessionId: previous.runtimeId, revision: previous.runtimeRevision }
    };
    let candidate: RuntimeSessionState | undefined;
    let candidateCleanupAttempted = false;
    const cleanupCandidate = async (): Promise<void> => {
      if (candidateCleanupAttempted) return;
      candidateCleanupAttempted = true;
      await this.runtimeCleanup.close(
        candidate ?? candidateShell(session, candidateSessionId),
        "plan rewrite candidate",
        runtimeCleanupOptions(),
        true
      );
    };
    const candidateOptions: BridgeRequestOptions = {
      ...options,
      ...(session.openRequest.source.kind === "file" ? {} : { requiredKernelSessionId: previous.runtimeId })
    };

    let response: OpenWranglerResponse;
    try {
      response = await session.delegate.request(candidateRequest, candidateOptions);
    } catch (error) {
      await cleanupCandidate();
      return protocolError(
        "plan_rewrite_open_failed",
        `Open Wrangler could not open the private plan candidate: ${error instanceof Error ? error.message : String(error)}`,
        true,
        session.publicId
      );
    }
    if (response.kind === "error" || response.kind === "cancelled") {
      await cleanupCandidate();
      return response.kind === "error" && response.sessionId ? { ...response, sessionId: session.publicId } : response;
    }
    if (response.kind !== "sessionOpened") {
      await cleanupCandidate();
      return protocolError(
        "invalid_runtime_response",
        `The runtime returned ${response.kind} while opening the private plan candidate.`,
        true,
        session.publicId
      );
    }
    candidate = runtimeCandidate(session, candidateSessionId, response.metadata);
    const openedMismatch = sessionOpenedResponseMismatch(candidateRequest, response, true);
    if (openedMismatch) {
      await cleanupCandidate();
      return protocolError(
        "invalid_runtime_response",
        `Ignored an invalid plan-candidate openSession response: ${openedMismatch}`,
        true,
        session.publicId
      );
    }
    const openedIdentity = {
      backend: candidate.metadata.backend,
      mode: candidate.metadata.mode,
      source: candidate.metadata.source
    };

    const assertCandidateCurrent = (): void => {
      if (options?.cancellation?.isCancellationRequested) throw new ReconfigurationCancelledError();
      if (!hooks.isCurrent() || hooks.originMismatch(candidateRequest)) throw new ReconfigurationSupersededError();
    };
    const assertCandidatePlan = (): void => {
      const currentCandidate = candidate;
      if (
        !currentCandidate ||
        currentCandidate.metadata.backend !== openedIdentity.backend ||
        currentCandidate.metadata.mode !== openedIdentity.mode ||
        !isDeepStrictEqual(currentCandidate.metadata.source, openedIdentity.source) ||
        currentCandidate.metadata.draftStep !== undefined ||
        !isDeepStrictEqual(currentCandidate.metadata.steps, steps) ||
        (steps.length > 0 && currentCandidate.code.trim().length === 0)
      ) {
        throw new RuntimeStateRestoreError(
          "Open Wrangler could not validate the rebuilt cleaning plan and generated code."
        );
      }
    };
    let page: PageResponse;
    try {
      await this.runtimeStateRestorer.restoreCleaningState(
        candidate,
        { steps: [...steps] },
        pageWindow.columnOffset,
        pageWindow.columnLimit,
        candidateOptions,
        assertCandidateCurrent
      );
      assertCandidateCurrent();
      assertCandidatePlan();
      page = await this.runtimeStateRestorer.restoreOneViewingState(
        candidate,
        view,
        pageWindow.limit,
        pageWindow.columnOffset,
        pageWindow.columnLimit,
        "saved",
        candidateOptions,
        assertCandidateCurrent
      );
      assertCandidateCurrent();
      assertCandidatePlan();
    } catch (error) {
      await cleanupCandidate();
      if (error instanceof ReconfigurationCancelledError || options?.cancellation?.isCancellationRequested) {
        return { kind: "cancelled", targetRequestId: `rewrite-plan:${session.publicId}` };
      }
      return protocolError(
        error instanceof ReconfigurationSupersededError ? "invalid_source_origin" : "plan_rewrite_failed",
        error instanceof ReconfigurationSupersededError
          ? "The dataframe source changed while its cleaning plan was being rebuilt."
          : `Open Wrangler could not replay the selected step and every later step: ${
              error instanceof Error ? error.message : String(error)
            }. The confirmed session was left unchanged.`,
        true,
        session.publicId
      );
    }
    if (!hooks.isCurrent()) {
      await cleanupCandidate();
      return protocolError(
        hooks.isCoordinatorAvailable() ? "session_closing" : "coordinator_disposed",
        "The session closed before its rebuilt cleaning plan could be published.",
        false,
        session.publicId
      );
    }

    if (page.page.totalRows === null) {
      await cleanupCandidate();
      return protocolError(
        "invalid_runtime_response",
        "The editing runtime returned a page without an exact row count.",
        true,
        session.publicId
      );
    }
    const publicRevision = session.publicRevision + 1;
    const publishableCandidate = candidate;
    if (!publishableCandidate) {
      return protocolError(
        "invalid_runtime_response",
        "The private plan candidate disappeared before it could be published.",
        true,
        session.publicId
      );
    }
    const previousPublicRevision = session.publicRevision;
    const previousOpenRequest = session.openRequest;
    const previousRecoveryRequired = session.recoveryRequired;
    const previousActiveViewContextId = session.activeViewContextId;
    const previousLatestRequestedViewContextId = session.latestRequestedViewContextId;
    const previousLatestRequestedPageRequestId = session.latestRequestedPageRequestId;
    const committed = await this.responseCommitter.commitRuntimeReplacement(
      publishableCandidate,
      candidateRequest.source,
      () => hooks.isCurrent() && hooks.originMismatch(candidateRequest) === undefined,
      () => {
        publishCandidate(session, publishableCandidate, candidateRequest, publicRevision);
        session.draftPresentation = undefined;
        session.draftBaseFilterModel = undefined;
        candidateCleanupAttempted = true;
        candidate = undefined;
        return () => {
          session.runtimeId = previous.runtimeId;
          session.runtimeRevision = previous.runtimeRevision;
          session.publicRevision = previousPublicRevision;
          session.openRequest = previousOpenRequest;
          session.metadata = previous.metadata;
          session.code = previous.code;
          session.draftPresentation = previous.draftPresentation;
          session.draftBaseFilterModel = previous.draftBaseFilterModel;
          session.viewChangeEpoch = previous.viewChangeEpoch;
          session.draftBaseViewChangeEpoch = previous.draftBaseViewChangeEpoch;
          session.viewState = previous.viewState;
          session.recoveryRequired = previousRecoveryRequired;
          session.activeViewContextId = previousActiveViewContextId;
          session.latestRequestedViewContextId = previousLatestRequestedViewContextId;
          session.latestRequestedPageRequestId = previousLatestRequestedPageRequestId;
          candidate = publishableCandidate;
          candidateCleanupAttempted = false;
        };
      }
    );
    if (!committed) {
      await cleanupCandidate();
      return protocolError(
        hooks.isCoordinatorAvailable() ? "session_closing" : "coordinator_disposed",
        "The session changed before its rebuilt cleaning plan could be persisted and published.",
        false,
        session.publicId
      );
    }
    hooks.invalidateStepInspection();
    this.runtimeCleanup.track(previous, "retired runtime");
    return {
      kind: "planUpdated",
      action: "apply",
      revision: publicRevision,
      metadata: publicMetadata(session.metadata, session.publicId, publicRevision, session.openRequest.source),
      page: page.page,
      code: session.code
    };
  }

  async replaceFileSession(
    session: RuntimeReconfigurationSession,
    source: SessionSource,
    options: BridgeRequestOptions | undefined,
    hooks: RuntimeReconfigurationHooks
  ): Promise<OpenWranglerResponse> {
    if (!hooks.isCurrent()) {
      return protocolError(
        hooks.isCoordinatorAvailable() ? "session_closing" : "coordinator_disposed",
        "The file session closed before its new import options could be opened.",
        false,
        session.publicId
      );
    }

    const persisted = persistedSessionState(
      session.metadata,
      gridState(session.viewState),
      session.draftBaseFilterModel
    );
    const previous = runtimeState(session);
    const candidateSessionId = randomUUID();
    const candidateRequest = replacementOpenRequest(session, source, candidateSessionId, options?.backendPreference);
    if (!isOpenWranglerRequest(candidateRequest)) {
      return protocolError(
        "invalid_import_options",
        "The selected import options are not valid for an Open Wrangler file session.",
        true,
        session.publicId
      );
    }

    let candidate: RuntimeSessionState | undefined;
    let candidateCleanupAttempted = false;
    const cleanupCandidate = async (): Promise<void> => {
      if (candidateCleanupAttempted) return;
      candidateCleanupAttempted = true;
      await this.runtimeCleanup.close(
        candidate ?? candidateShell(session, candidateSessionId),
        "import candidate",
        runtimeCleanupOptions(),
        true
      );
    };
    const recoverConfirmedRuntime = async (): Promise<void> => {
      const recovered = hooks.isCurrent() && (await hooks.recoverConfirmedRuntime());
      session.recoveryRequired = !recovered;
    };

    let response: OpenWranglerResponse;
    try {
      response = await session.delegate.request(candidateRequest, options);
    } catch (error) {
      await cleanupCandidate();
      await recoverConfirmedRuntime();
      return protocolError(
        "import_reconfiguration_transport_failed",
        `Open Wrangler could not confirm the new import session: ${error instanceof Error ? error.message : String(error)}`,
        true,
        session.publicId
      );
    }

    if (response.kind === "error") {
      await cleanupCandidate();
      if (response.sessionId && response.sessionId !== candidateSessionId) {
        return protocolError(
          "invalid_runtime_response",
          `Ignored a replacement error correlated to runtime session ${response.sessionId} instead of ${candidateSessionId}.`,
          true,
          session.publicId
        );
      }
      return response.sessionId ? { ...response, sessionId: session.publicId } : response;
    }
    if (response.kind === "cancelled") {
      await cleanupCandidate();
      return response;
    }
    if (response.kind !== "sessionOpened") {
      await cleanupCandidate();
      return protocolError(
        "invalid_runtime_response",
        `The runtime returned ${response.kind} while changing import options.`,
        true,
        session.publicId
      );
    }

    candidate = runtimeCandidate(session, candidateSessionId, response.metadata);
    const openedMismatch = sessionOpenedResponseMismatch(candidateRequest, response, true);
    if (openedMismatch) {
      await cleanupCandidate();
      return protocolError(
        "invalid_runtime_response",
        `Ignored an invalid replacement openSession response: ${openedMismatch}`,
        true,
        session.publicId
      );
    }
    if (options?.cancellation?.isCancellationRequested) {
      await cleanupCandidate();
      return reconfigurationCancelled(session.publicId);
    }
    if (!hooks.isCurrent()) {
      await cleanupCandidate();
      return protocolError(
        hooks.isCoordinatorAvailable() ? "session_closing" : "coordinator_disposed",
        "The file session closed before its replacement runtime could replay any state.",
        false,
        session.publicId
      );
    }

    let page: PageResponse;
    const assertCandidateCurrent = (): void => {
      if (options?.cancellation?.isCancellationRequested) throw new ReconfigurationCancelledError();
      if (!hooks.isCurrent()) throw new ReconfigurationSupersededError();
    };
    try {
      await this.runtimeStateRestorer.restoreCleaningState(
        candidate,
        persisted.cleaning,
        candidateRequest.columnOffset,
        candidateRequest.columnLimit,
        options,
        assertCandidateCurrent
      );
      assertCandidateCurrent();
      page = await this.runtimeStateRestorer.restoreOneViewingState(
        candidate,
        persisted.view,
        candidateRequest.pageSize,
        candidateRequest.columnOffset,
        candidateRequest.columnLimit,
        "saved",
        options,
        assertCandidateCurrent
      );
      assertCandidateCurrent();
    } catch (error) {
      await cleanupCandidate();
      if (
        !(error instanceof RuntimeStateRestoreError) &&
        !(error instanceof ReconfigurationCancelledError) &&
        !(error instanceof ReconfigurationSupersededError)
      ) {
        await recoverConfirmedRuntime();
      }
      if (error instanceof ReconfigurationSupersededError) {
        return protocolError(
          hooks.isCoordinatorAvailable() ? "session_closing" : "coordinator_disposed",
          "The file session closed while its replacement runtime was restoring state.",
          false,
          session.publicId
        );
      }
      if (error instanceof ReconfigurationCancelledError || options?.cancellation?.isCancellationRequested) {
        return reconfigurationCancelled(session.publicId);
      }
      return protocolError(
        "import_state_replay_failed",
        error instanceof RuntimeStateRestoreError
          ? `${error.message} The active session was left unchanged.`
          : `Open Wrangler could not confirm the replacement runtime: ${
              error instanceof Error ? error.message : String(error)
            }`,
        true,
        session.publicId
      );
    }

    if (!hooks.isCurrent()) {
      await cleanupCandidate();
      return protocolError(
        hooks.isCoordinatorAvailable() ? "session_closing" : "coordinator_disposed",
        "The file session closed before its new import options could be committed.",
        false,
        session.publicId
      );
    }

    const publicRevision = session.publicRevision + 1;
    publishCandidate(session, candidate, candidateRequest, publicRevision);
    if (options?.backendPreference === "auto") delete session.backendPreference;
    else if (options?.backendPreference !== undefined) session.backendPreference = options.backendPreference;
    hooks.invalidateStepInspection();
    candidateCleanupAttempted = true;
    candidate = undefined;
    this.runtimeCleanup.track(previous, "retired runtime");
    await this.responseCommitter.persistSession(session);
    return publicOpenedResponse(
      { kind: "sessionOpened", metadata: session.metadata, page: page.page, summaries: [] },
      session.publicId,
      publicRevision,
      source
    );
  }
}

function modeName(mode: SessionMode): "Editing" | "Viewing" {
  return mode === "editing" ? "Editing" : "Viewing";
}

function runtimeState(session: RuntimeReconfigurationSession): RuntimeSessionState {
  return {
    publicId: session.publicId,
    runtimeId: session.runtimeId,
    runtimeRevision: session.runtimeRevision,
    delegate: session.delegate,
    metadata: session.metadata,
    code: session.code,
    draftPresentation: session.draftPresentation,
    draftBaseFilterModel: session.draftBaseFilterModel,
    viewChangeEpoch: session.viewChangeEpoch,
    draftBaseViewChangeEpoch: session.draftBaseViewChangeEpoch,
    viewState: session.viewState
  };
}

function candidateShell(session: RuntimeReconfigurationSession, runtimeId: string): RuntimeSessionState {
  return {
    publicId: session.publicId,
    runtimeId,
    runtimeRevision: 0,
    delegate: session.delegate,
    metadata: session.metadata,
    code: "",
    viewState: session.viewState
  };
}

function runtimeCandidate(
  session: RuntimeReconfigurationSession,
  runtimeId: string,
  metadata: SessionMetadata
): RuntimeSessionState {
  return {
    publicId: session.publicId,
    runtimeId,
    runtimeRevision: metadata.revision,
    delegate: session.delegate,
    metadata,
    code: "",
    viewState: initialViewingState(metadata)
  };
}

function publishCandidate(
  session: RuntimeReconfigurationSession,
  candidate: RuntimeSessionState,
  request: OpenSessionRequest,
  publicRevision: number
): void {
  session.runtimeId = candidate.runtimeId;
  session.runtimeRevision = candidate.runtimeRevision;
  session.publicRevision = publicRevision;
  session.openRequest = confirmedReplayOpenRequest(request, candidate.metadata);
  session.metadata = candidate.metadata;
  session.code = candidate.code;
  session.draftPresentation = candidate.draftPresentation;
  session.draftBaseFilterModel = candidate.draftBaseFilterModel;
  session.draftBaseViewChangeEpoch = undefined;
  session.viewState = candidate.viewState;
  session.recoveryRequired = false;
  session.activeViewContextId = undefined;
  session.latestRequestedViewContextId = undefined;
  session.latestRequestedPageRequestId = undefined;
}

function replacementOpenRequest(
  session: RuntimeReconfigurationSession,
  source: SessionSource,
  requestedSessionId: string,
  backendPreference: BridgeRequestOptions["backendPreference"] = session.backendPreference
): OpenSessionRequest {
  const {
    source: _previousSource,
    backend: _confirmedBackend,
    requestedSessionId: _previousRequestedSessionId,
    ...stableRequest
  } = session.openRequest;
  return {
    ...stableRequest,
    kind: "openSession",
    source,
    requestedSessionId,
    ...(backendPreference && backendPreference !== "auto" ? { backend: backendPreference } : {})
  };
}

export function confirmedReplayOpenRequest(
  request: OpenSessionRequest,
  metadata: Pick<SessionMetadata, "backend" | "mode">
): OpenSessionRequest {
  const { requestedSessionId: _requestedSessionId, cloneFrom: _cloneFrom, ...stableRequest } = request;
  return {
    ...stableRequest,
    backend: metadata.backend,
    mode: metadata.mode
  };
}

export function reconfigurationCancelled(sessionId: string): OpenWranglerResponse {
  return { kind: "cancelled", targetRequestId: `reconfigure-import:${sessionId}` };
}

export function publicOpenedResponse(
  response: SessionOpenedResponse,
  publicId: string,
  publicRevision: number,
  immutableSource: SessionSource
): SessionOpenedResponse {
  return {
    ...response,
    metadata: publicMetadata(response.metadata, publicId, publicRevision, immutableSource)
  };
}
