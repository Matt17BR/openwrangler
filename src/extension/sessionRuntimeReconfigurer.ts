import { randomUUID } from "node:crypto";
import type {
  DataBackend,
  OpenSessionRequest,
  OpenWranglerResponse,
  PageResponse,
  SessionMetadata,
  SessionOpenedResponse,
  SessionSource
} from "../shared/protocol";
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

  async reopenNotebookForEditing(
    session: RuntimeReconfigurationSession,
    options: BridgeRequestOptions | undefined,
    hooks: RuntimeReconfigurationHooks
  ): Promise<OpenWranglerResponse> {
    if (!hooks.isCurrent()) {
      return protocolError(
        hooks.isCoordinatorAvailable() ? "session_closing" : "coordinator_disposed",
        "The live session closed before Editing mode could open.",
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
      mode: "editing",
      requestedSessionId: candidateSessionId
    };
    let candidate: RuntimeSessionState | undefined;
    let candidateCleanupAttempted = false;
    const cleanupCandidate = async (): Promise<void> => {
      if (candidateCleanupAttempted) return;
      candidateCleanupAttempted = true;
      await this.runtimeCleanup.close(
        candidate ?? candidateShell(session, candidateSessionId),
        "editing candidate",
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
        "editing_mode_open_failed",
        `Open Wrangler could not confirm the Editing session: ${error instanceof Error ? error.message : String(error)}`,
        true,
        session.publicId
      );
    }
    if (response.kind === "error") {
      await cleanupCandidate();
      if (response.sessionId && response.sessionId !== candidateSessionId) {
        return protocolError(
          "invalid_runtime_response",
          `Ignored an Editing-mode error correlated to runtime session ${response.sessionId} instead of ${candidateSessionId}.`,
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
        `The runtime returned ${response.kind} while opening Editing mode.`,
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
        `Ignored an invalid Editing openSession response: ${openedMismatch}`,
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
        error instanceof ReconfigurationSupersededError ? "invalid_source_origin" : "editing_mode_view_restore_failed",
        error instanceof ReconfigurationSupersededError
          ? "The live dataframe source changed while Editing mode was opening."
          : `Open Wrangler could not restore the current view in Editing mode: ${
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

function runtimeState(session: RuntimeReconfigurationSession): RuntimeSessionState {
  return {
    publicId: session.publicId,
    runtimeId: session.runtimeId,
    runtimeRevision: session.runtimeRevision,
    delegate: session.delegate,
    metadata: session.metadata,
    code: session.code,
    draftBaseFilterModel: session.draftBaseFilterModel,
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
  const { requestedSessionId: _requestedSessionId, ...stableRequest } = request;
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
