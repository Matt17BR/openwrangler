import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type {
  DataBackend,
  OpenSessionRequest,
  OpenWranglerResponse,
  PageResponse,
  SessionBoundRequest,
  SessionOpenedResponse
} from "../shared/protocol";
import { DetachedBridgeRequestError, type BridgeRequestOptions, type OpenWranglerBridge } from "./dataBridge";
import type { CoordinatedSessionOrigin } from "./sessionOrigin";
import { captureSessionSourceFiles, sessionOriginMismatch } from "./sessionOrigin";
import { confirmSessionSourceProtection, type SessionSourceProtection } from "./files/safeFileExport";
import { SessionPersistenceStore } from "./sessionPersistenceStore";
import { sessionOpenedResponseMismatch } from "./sessionResponseValidation";
import { protocolError, type SessionResponseState } from "./sessionResponseCommitter";
import { SessionRequestScheduler } from "./sessionRequestScheduler";
import { SessionRuntimeCleanup } from "./sessionRuntimeCleanup";
import { confirmedReplayOpenRequest, publicOpenedResponse } from "./sessionRuntimeReconfigurer";
import { initialViewingState, SessionRuntimeStateRestorer } from "./sessionRuntimeStateRestorer";

export interface RuntimeEstablishedSession extends SessionResponseState {
  backendPreference?: DataBackend;
  origin?: CoordinatedSessionOrigin;
  scheduler: SessionRequestScheduler;
  closing: boolean;
  reconfiguring: boolean;
  reconnecting: boolean;
  liveReconnectRequired: boolean;
  recoveryRequired: boolean;
  /** Host-detached runtime work that must settle before this session may issue more work. */
  runtimeSettlementBarrier?: Promise<void>;
}

export type RuntimeEstablishmentResult =
  | { established: false; response: OpenWranglerResponse }
  | { established: true; response: SessionOpenedResponse; session: RuntimeEstablishedSession };

export interface RuntimeEstablishmentHooks {
  isCoordinatorAvailable(): boolean;
  executeSessionRequest(
    session: RuntimeEstablishedSession,
    request: SessionBoundRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse>;
}

export class SessionRuntimeEstablisher {
  constructor(
    private readonly runtimeCleanup: SessionRuntimeCleanup,
    private readonly runtimeStateRestorer: SessionRuntimeStateRestorer,
    private readonly persistence: SessionPersistenceStore
  ) {}

  async establish(
    delegate: OpenWranglerBridge,
    request: OpenSessionRequest,
    options: BridgeRequestOptions | undefined,
    origin: CoordinatedSessionOrigin | undefined,
    hooks: RuntimeEstablishmentHooks,
    sourceProtection?: SessionSourceProtection
  ): Promise<RuntimeEstablishmentResult> {
    const invalidOrigin = sessionOriginMismatch(request, origin);
    if (invalidOrigin) {
      return { established: false, response: protocolError("invalid_source_origin", invalidOrigin, true) };
    }
    sourceProtection ??= await captureSessionSourceFiles(request.source);
    if (!hooks.isCoordinatorAvailable()) {
      return {
        established: false,
        response: protocolError(
          "coordinator_disposed",
          "The Open Wrangler session coordinator was disposed before the dataframe opened.",
          false
        )
      };
    }
    if (options?.cancellation?.isCancellationRequested) {
      return { established: false, response: { kind: "cancelled", targetRequestId: "not-started" } };
    }
    const response = await delegate.request(request, options);
    if (response.kind === "error" || response.kind === "cancelled") {
      return { established: false, response };
    }
    if (response.kind !== "sessionOpened") {
      return {
        established: false,
        response: protocolError(
          "invalid_runtime_response",
          `The runtime returned ${response.kind} while opening an Open Wrangler session.`,
          true
        )
      };
    }

    const publicId = randomUUID();
    const backendPreference =
      options?.backendPreference === "auto" ? undefined : (options?.backendPreference ?? request.backend);
    const sessionOwner: { current?: RuntimeEstablishedSession } = {};
    const scheduler = new SessionRequestScheduler((scheduledRequest, scheduledOptions) => {
      const current = sessionOwner.current;
      if (!current) throw new Error("The session scheduler started before its session was initialized.");
      return hooks.executeSessionRequest(current, scheduledRequest, scheduledOptions);
    });
    const session: RuntimeEstablishedSession = {
      sourceProtection,
      publicId,
      runtimeId: response.metadata.sessionId,
      publicRevision: response.metadata.revision,
      runtimeRevision: response.metadata.revision,
      openRequest: confirmedReplayOpenRequest(request, response.metadata),
      ...(backendPreference ? { backendPreference } : {}),
      ...(origin ? { origin } : {}),
      delegate,
      scheduler,
      metadata: response.metadata,
      code: "",
      viewState: initialViewingState(response.metadata),
      viewChangeEpoch: 0,
      closing: false,
      reconfiguring: false,
      reconnecting: false,
      liveReconnectRequired: false,
      recoveryRequired: false
    };
    sessionOwner.current = session;
    const staleOrigin = sessionOriginMismatch(request, origin);
    if (staleOrigin) {
      await this.runtimeCleanup.close(session, "invalid open runtime");
      return { established: false, response: protocolError("invalid_source_origin", staleOrigin, true) };
    }
    const openedMismatch = sessionOpenedResponseMismatch(request, response);
    if (openedMismatch) {
      await this.runtimeCleanup.close(session, "invalid open runtime");
      return {
        established: false,
        response: protocolError(
          "invalid_runtime_response",
          `Ignored an invalid openSession response: ${openedMismatch}`,
          true
        )
      };
    }

    const restored = await this.restorePersistedSession(session, request, response, hooks, options);
    if (!restored.established) return restored;
    if (session.sourceProtection) {
      session.sourceProtection = await confirmSessionSourceProtection(session.sourceProtection);
    }
    if (!hooks.isCoordinatorAvailable()) {
      await this.runtimeCleanup.close(session, "late-open runtime");
      return {
        established: false,
        response: protocolError(
          "coordinator_disposed",
          "The Open Wrangler session coordinator was disposed before the dataframe finished opening.",
          false
        )
      };
    }
    const finalOrigin = sessionOriginMismatch(request, origin);
    if (finalOrigin) {
      await this.runtimeCleanup.close(session, "invalid open runtime");
      return { established: false, response: protocolError("invalid_source_origin", finalOrigin, true) };
    }
    return {
      established: true,
      session,
      response: publicOpenedResponse(restored.response, publicId, session.publicRevision, session.openRequest.source)
    };
  }

  private async restorePersistedSession(
    session: RuntimeEstablishedSession,
    request: OpenSessionRequest,
    response: SessionOpenedResponse,
    hooks: RuntimeEstablishmentHooks,
    options?: BridgeRequestOptions
  ): Promise<RuntimeEstablishmentResult> {
    let opened: SessionOpenedResponse = { ...response, summaries: [] };
    const persisted = this.persistence.load(request.source, response.metadata.backend);
    if (!persisted) return { established: true, session, response: opened };

    let cleaningRestored = false;
    try {
      await this.runtimeStateRestorer.restoreCleaningState(
        session,
        persisted.cleaning,
        request.columnOffset,
        request.columnLimit,
        options
      );
      cleaningRestored = true;
    } catch {
      await this.runtimeCleanup.close(session, "saved-plan fallback runtime");
      if (session.openRequest.source.kind === "file")
        session.sourceProtection = await captureSessionSourceFiles(session.openRequest.source);
      if (!hooks.isCoordinatorAvailable()) {
        return {
          established: false,
          response: protocolError(
            "coordinator_disposed",
            "The Open Wrangler session coordinator was disposed before original data reopened.",
            false
          )
        };
      }
      if (options?.cancellation?.isCancellationRequested) {
        return { established: false, response: { kind: "cancelled", targetRequestId: "not-started" } };
      }
      const staleOrigin = sessionOriginMismatch(session.openRequest, session.origin);
      if (staleOrigin)
        return { established: false, response: protocolError("invalid_source_origin", staleOrigin, true) };
      const clean = await session.delegate.request(session.openRequest, options);
      if (clean.kind === "error" || clean.kind === "cancelled") return { established: false, response: clean };
      if (clean.kind !== "sessionOpened") {
        return {
          established: false,
          response: protocolError(
            "invalid_runtime_response",
            `The runtime returned ${clean.kind} while reopening the immutable source.`,
            true
          )
        };
      }
      session.runtimeId = clean.metadata.sessionId;
      session.runtimeRevision = clean.metadata.revision;
      session.publicRevision = clean.metadata.revision;
      session.metadata = clean.metadata;
      session.code = "";
      session.draftPresentation = undefined;
      session.draftBaseFilterModel = undefined;
      session.viewState = initialViewingState(clean.metadata);
      const cleanMismatch = sessionOpenedResponseMismatch(session.openRequest, clean);
      if (cleanMismatch) {
        await this.runtimeCleanup.close(session, "invalid open runtime");
        return {
          established: false,
          response: protocolError(
            "invalid_runtime_response",
            `Ignored an invalid openSession response while reopening the immutable source: ${cleanMismatch}`,
            true
          )
        };
      }
      opened = { ...clean, summaries: [] };
      void vscode.window.showWarningMessage(
        `Open Wrangler could not replay the saved cleaning plan for ${request.source.label}. Original data was opened instead.`
      );
    }

    if (cleaningRestored) {
      let page: PageResponse;
      try {
        page = await this.runtimeStateRestorer.restoreViewingState(
          session,
          persisted.view,
          request.pageSize,
          request.columnOffset,
          request.columnLimit,
          options
        );
      } catch (error) {
        if (error instanceof DetachedBridgeRequestError) {
          this.runtimeCleanup.trackDelegateSettlement(
            session.delegate,
            error.settlement.then(() => this.runtimeCleanup.close(session, "failed saved-state runtime"))
          );
        } else {
          await this.runtimeCleanup.close(session, "failed saved-state runtime");
        }
        return {
          established: false,
          response: protocolError(
            "saved_view_restore_failed",
            `Open Wrangler could not restore a confirmed view for ${request.source.label}.`,
            true
          )
        };
      }
      session.publicRevision = session.runtimeRevision;
      opened = {
        kind: "sessionOpened",
        metadata: session.metadata,
        page: page.page,
        summaries: []
      };
    }
    return { established: true, session, response: opened };
  }
}
