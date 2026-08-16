import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type {
  ColumnSchema,
  DataBackend,
  OpenWranglerRequest,
  OpenWranglerResponse,
  DataExportedResponse,
  OpenSessionRequest,
  PageResponse,
  SessionMetadata,
  SessionOpenedResponse,
  SessionSource,
  SessionBoundRequest,
  StepInspectionResponse
} from "../shared/protocol";
import { isSessionBoundRequest } from "../shared/protocol";
import type { GridViewState, PersistedViewingState } from "../shared/viewState";
import { type BridgeRequestOptions, type OpenWranglerBridge, type SessionPresentation } from "./dataBridge";
import { isFileDataBackend } from "./pythonEnvironmentModel";
import { isSoleOpenNotebookDocument } from "./notebooks/notebookProvenance";
import type { DecodedPersistedSessionState } from "./sessionPersistence";
import { SessionPersistenceStore } from "./sessionPersistenceStore";
import { sessionOpenedResponseMismatch } from "./sessionResponseValidation";
import {
  protocolError,
  publicMetadata,
  SessionResponseCommitter,
  stepInspectionKey,
  type SessionResponseState
} from "./sessionResponseCommitter";
import { SessionRequestScheduler, requestViewId, type SessionRequestExecutionLane } from "./sessionRequestScheduler";
import { SessionRuntimeCleanup } from "./sessionRuntimeCleanup";
import { SessionRuntimeRecovery, type RuntimeRecoveryHooks } from "./sessionRuntimeRecovery";
import {
  confirmedReplayOpenRequest,
  publicOpenedResponse,
  reconfigurationCancelled,
  SessionRuntimeReconfigurer,
  type RuntimeReconfigurationHooks
} from "./sessionRuntimeReconfigurer";
import {
  isRuntimeStateMutation,
  runtimeRecoveryOptions,
  SessionRuntimeRequestExecutor
} from "./sessionRuntimeRequestExecutor";
import {
  gridState,
  initialViewingState,
  reconcileViewingState,
  SessionRuntimeStateRestorer
} from "./sessionRuntimeStateRestorer";

export type { SessionRequestExecutionLane } from "./sessionRequestScheduler";

interface CoordinatedSession extends SessionResponseState {
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

export interface TextDocumentSessionOrigin {
  readonly kind: "textDocument";
  readonly document: vscode.TextDocument;
  readonly version: number;
}

type CoordinatedSessionOrigin =
  Readonly<{ kind: "notebook"; document: vscode.NotebookDocument }> | TextDocumentSessionOrigin;

type BridgeSessionOrigin = vscode.NotebookDocument | TextDocumentSessionOrigin;

const SHUTDOWN_TIMEOUT_MS = 2_000;

export interface ActiveSessionSnapshot {
  sessionId: string;
  metadata: SessionMetadata;
  code: string;
  viewState: PersistedViewingState;
  stepInspectionActive?: boolean;
  stepInspection?: StepInspectionResponse;
}

export interface SessionCoordinatorDiagnostics {
  activeSessionId?: string;
  sessionCount: number;
  sessions: Array<{
    publicId: string;
    runtimeId: string;
    publicRevision: number;
    runtimeRevision: number;
    sourceLabel: string;
  }>;
}

export interface SessionRequestExecutionCheckpoint {
  sessionId: string;
  state: "active" | "queued";
  lane: SessionRequestExecutionLane;
  requestKind: SessionBoundRequest["kind"];
  viewRequestId: string;
}

export interface SessionSchedulerState {
  sessionId: string;
  quiescent: boolean;
  activeForegroundOperation: boolean;
  activeBackgroundOperation: boolean;
  interactiveQueueLength: number;
  backgroundQueueLength: number;
  terminalOperation: boolean;
}

export class SessionCoordinator implements vscode.Disposable {
  private readonly sessions = new Map<string, CoordinatedSession>();
  private readonly pendingOpens = new Map<OpenWranglerBridge, number>();
  private readonly pendingOpenWaiters = new Set<() => void>();
  private readonly activeSessionEmitter = new vscode.EventEmitter<ActiveSessionSnapshot | undefined>();
  private activeSessionId: string | undefined;
  private disposed = false;
  private shutdownPromise: Promise<void> | undefined;
  private readonly sessionEstablishmentTails = new WeakMap<OpenWranglerBridge, Promise<void>>();
  private readonly runtimeCleanup: SessionRuntimeCleanup;
  private readonly persistence: SessionPersistenceStore;
  private readonly runtimeStateRestorer = new SessionRuntimeStateRestorer();
  private readonly responseCommitter: SessionResponseCommitter;
  private readonly runtimeRequestExecutor: SessionRuntimeRequestExecutor;
  private readonly runtimeReconfigurer: SessionRuntimeReconfigurer;
  private readonly runtimeRecovery: SessionRuntimeRecovery;

  constructor(workspaceState?: vscode.Memento, diagnosticSink?: (message: string) => void) {
    this.persistence = new SessionPersistenceStore(workspaceState);
    this.responseCommitter = new SessionResponseCommitter(this.persistence);
    this.runtimeRequestExecutor = new SessionRuntimeRequestExecutor(this.responseCommitter);
    this.runtimeCleanup = new SessionRuntimeCleanup(
      (delegate) =>
        this.pendingOpens.has(delegate) || [...this.sessions.values()].some((session) => session.delegate === delegate),
      diagnosticSink
    );
    this.runtimeReconfigurer = new SessionRuntimeReconfigurer(
      this.runtimeCleanup,
      this.runtimeStateRestorer,
      this.responseCommitter
    );
    this.runtimeRecovery = new SessionRuntimeRecovery(this.runtimeCleanup, this.runtimeStateRestorer);
  }

  readonly onDidChangeActiveSession = this.activeSessionEmitter.event;

  createBridge(delegate: OpenWranglerBridge, origin?: BridgeSessionOrigin): OpenWranglerBridge {
    const confirmedOrigin = normalizeSessionOrigin(origin);
    return {
      request: (request, options) => this.request(delegate, request, options, confirmedOrigin),
      listExcelSheets: (sessionId, source, backend, options) =>
        this.listExcelSheets(delegate, sessionId, source, backend, options),
      reconfigureFileSession: (sessionId, revision, source, options) =>
        this.reconfigureFileSession(delegate, sessionId, revision, source, options),
      reconfigureNotebookSessionForEditing: (sessionId, revision, viewState, options) =>
        this.reconfigureNotebookSessionForEditing(delegate, sessionId, revision, viewState, options),
      reconnectLiveSession: (sessionId, revision, options) =>
        this.reconnectLiveSession(delegate, sessionId, revision, options),
      cancelViewRequests: (sessionId, viewRequestIds) => this.cancelViewRequests(sessionId, viewRequestIds),
      prioritizeViewRequest: (sessionId, viewRequestId) => this.prioritizeViewRequest(sessionId, viewRequestId),
      setViewContext: (sessionId, viewContextId) => this.setViewContext(sessionId, viewContextId),
      getViewState: (sessionId) => this.gridViewState(sessionId),
      getSessionPresentation: (sessionId) => this.sessionPresentation(sessionId),
      updateViewState: (sessionId, state) => this.updateGridViewState(sessionId, state),
      clearStepInspection: (sessionId) => this.clearStepInspection(sessionId),
      setActiveSession: (sessionId) => this.setActive(sessionId)
    };
  }

  private async listExcelSheets(
    delegate: OpenWranglerBridge,
    sessionId: string,
    source: SessionSource,
    backend: DataBackend,
    options?: BridgeRequestOptions
  ): Promise<readonly string[] | undefined> {
    if (this.disposed || options?.cancellation?.isCancellationRequested) return undefined;
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.delegate !== delegate ||
      session.closing ||
      session.reconfiguring ||
      session.metadata.backend !== backend ||
      !sameFileSourceIdentity(session.openRequest.source, source)
    ) {
      return undefined;
    }
    return delegate.listExcelSheets?.(session.runtimeId, session.openRequest.source, session.metadata.backend, options);
  }

  private async reconnectLiveSession(
    delegate: OpenWranglerBridge,
    sessionId: string,
    revision: number,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(sessionId);
    if (
      this.disposed ||
      !session ||
      session.delegate !== delegate ||
      session.metadata.backend !== "pyspark" ||
      session.openRequest.source.kind !== "notebookVariable"
    ) {
      return protocolError(
        "pyspark_connect_state_lost",
        "This live PySpark dataframe is no longer available to reconnect.",
        true,
        sessionId
      );
    }
    return this.runtimeRecovery.reconnect(session, revision, options, this.runtimeRecoveryHooks(session));
  }

  setActive(sessionId: string | undefined): void {
    if (sessionId !== this.activeSessionId) {
      const previous = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
      if (previous) this.invalidateStepInspection(previous);
      const next = sessionId ? this.sessions.get(sessionId) : undefined;
      if (next) this.invalidateStepInspection(next);
    }
    this.activeSessionId = sessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    this.activeSessionEmitter.fire(session ? activeSnapshot(session) : undefined);
  }

  activeSession(): ActiveSessionSnapshot | undefined {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    return session ? activeSnapshot(session) : undefined;
  }

  sessionSnapshot(sessionId: string): ActiveSessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    return session && !session.closing ? activeSnapshot(session) : undefined;
  }

  activeNotebookDocument(): vscode.NotebookDocument | undefined {
    const origin = this.activeSessionId ? this.sessions.get(this.activeSessionId)?.origin : undefined;
    return origin?.kind === "notebook" ? origin.document : undefined;
  }

  activeTextDocumentOrigin(): TextDocumentSessionOrigin | undefined {
    const origin = this.activeSessionId ? this.sessions.get(this.activeSessionId)?.origin : undefined;
    return origin?.kind === "textDocument" ? origin : undefined;
  }

  clearActiveStepInspection(): void {
    if (this.activeSessionId) this.clearStepInspection(this.activeSessionId);
  }

  private gridViewState(sessionId: string): GridViewState | undefined {
    const session = this.sessions.get(sessionId);
    return session ? gridState(session.viewState) : undefined;
  }

  private sessionPresentation(sessionId: string): SessionPresentation | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) return undefined;
    return {
      sessionId: session.publicId,
      revision: session.publicRevision,
      code: session.code,
      ...(session.draftPresentation ? { draft: session.draftPresentation } : {})
    };
  }

  private async updateGridViewState(sessionId: string, state: GridViewState): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.reconfiguring) return;
    const next = reconcileViewingState({ ...state, filterModel: session.metadata.filterModel }, session.metadata);
    if (isDeepStrictEqual(next, session.viewState)) return;
    const selectedColumnChanged = next.selectedColumnId !== session.viewState.selectedColumnId;
    session.viewState = next;
    await this.responseCommitter.persistSession(session);
    if (selectedColumnChanged && this.isLiveSession(session) && this.activeSessionId === session.publicId) {
      this.setActive(session.publicId);
    }
  }

  private clearStepInspection(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.reconfiguring) return;
    const changed = Boolean(session.stepInspection || session.latestStepInspectionKey);
    this.invalidateStepInspection(session);
    if (changed && this.isLiveSession(session) && this.activeSessionId === session.publicId) {
      this.activeSessionEmitter.fire(activeSnapshot(session));
    }
  }

  private invalidateStepInspection(session: CoordinatedSession): void {
    session.stepInspection = undefined;
    session.latestStepInspectionKey = undefined;
  }

  private clearPublishedStepInspection(session: CoordinatedSession): void {
    session.stepInspection = undefined;
  }

  diagnostics(): SessionCoordinatorDiagnostics {
    return {
      activeSessionId: this.activeSessionId,
      sessionCount: this.sessions.size,
      sessions: [...this.sessions.values()].map((session) => ({
        publicId: session.publicId,
        runtimeId: session.runtimeId,
        publicRevision: session.publicRevision,
        runtimeRevision: session.runtimeRevision,
        sourceLabel: session.openRequest.source.label
      }))
    };
  }

  testingRequestExecutionCheckpoint(
    sessionId: string,
    requestKind: SessionBoundRequest["kind"],
    viewRequestId: string
  ): SessionRequestExecutionCheckpoint | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || viewRequestId.length === 0) return undefined;
    const checkpoint = session.scheduler.checkpoint(requestKind, viewRequestId);
    return checkpoint ? { sessionId, ...checkpoint } : undefined;
  }

  testingSessionSchedulerState(sessionId: string): SessionSchedulerState | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return { sessionId, ...session.scheduler.snapshot() };
  }

  async exportActiveData(path: string, format: "csv" | "parquet"): Promise<DataExportedResponse> {
    const snapshot = this.activeSession();
    if (!snapshot) throw new Error("Open a dataframe in Open Wrangler before exporting cleaned data.");
    return this.exportData(snapshot.sessionId, snapshot.metadata.revision, path, format);
  }

  async exportData(
    sessionId: string,
    revision: number,
    path: string,
    format: "csv" | "parquet"
  ): Promise<DataExportedResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("The dataframe that started this export is no longer open.");
    const response = await this.request(session.delegate, {
      kind: "exportData",
      sessionId: session.publicId,
      revision,
      path,
      format
    });
    if (response.kind === "error") throw new Error(response.message);
    if (response.kind !== "dataExported") throw new Error("The runtime returned an unexpected export response.");
    return response;
  }

  dispose(): void {
    void this.shutdown().catch(() => undefined);
  }

  shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.shutdownPromise ??= this.shutdownSessions(timeoutMs);
    return this.shutdownPromise;
  }

  private async request(
    delegate: OpenWranglerBridge,
    request: OpenWranglerRequest,
    options?: BridgeRequestOptions,
    origin?: CoordinatedSessionOrigin
  ): Promise<OpenWranglerResponse> {
    if (this.disposed) {
      return protocolError(
        "coordinator_disposed",
        "The Open Wrangler session coordinator has been disposed.",
        false,
        undefined,
        requestViewId(request)
      );
    }
    if (request.kind === "openSession") {
      return this.open(delegate, request, options, origin);
    }
    if (!isSessionBoundRequest(request)) {
      return delegate.request(request, options);
    }

    const session = this.sessions.get(request.sessionId);
    if (!session) {
      return protocolError(
        "unknown_session",
        `Unknown Open Wrangler session: ${request.sessionId}`,
        true,
        undefined,
        requestViewId(request)
      );
    }
    if (request.kind !== "closeSession" && request.revision !== session.publicRevision) {
      return protocolError(
        "stale_request",
        `Ignored stale request revision ${request.revision}; current revision is ${session.publicRevision}.`,
        true,
        session.publicId,
        requestViewId(request)
      );
    }
    if (session.closing) {
      return protocolError(
        "session_closing",
        `Open Wrangler session ${session.publicId} is already closing.`,
        true,
        session.publicId,
        requestViewId(request)
      );
    }
    if (request.kind !== "closeSession" && session.reconfiguring) {
      return protocolError(
        "session_reconfiguring",
        `Open Wrangler session ${session.publicId} is changing its runtime configuration.`,
        true,
        session.publicId,
        requestViewId(request)
      );
    }
    if (request.kind !== "closeSession" && session.reconnecting) {
      return protocolError(
        "session_reconnecting",
        `Open Wrangler is reconnecting ${session.openRequest.source.label}.`,
        true,
        session.publicId,
        requestViewId(request)
      );
    }
    if (request.kind !== "closeSession" && session.liveReconnectRequired) {
      return protocolError(
        "pyspark_connect_state_lost",
        `The Spark server no longer has ${session.openRequest.source.label}. Run the cell that creates it, then choose Reconnect.`,
        true,
        session.publicId,
        requestViewId(request)
      );
    }
    if (request.kind === "closeSession") {
      session.closing = true;
      session.scheduler.cancelBackground();
    }
    if (request.kind === "inspectStep") {
      const inspectionChanged = Boolean(session.stepInspection && session.stepInspection.stepId !== request.stepId);
      if (inspectionChanged) session.stepInspection = undefined;
      session.latestStepInspectionKey = stepInspectionKey(request);
      if (this.isLiveSession(session) && this.activeSessionId === session.publicId) {
        this.activeSessionEmitter.fire(activeSnapshot(session));
      }
    } else if (isRuntimeStateMutation(request)) {
      this.clearStepInspection(session.publicId);
    }
    if (request.kind === "getPage") {
      session.latestRequestedPageRequestId = request.viewRequestId;
      session.latestRequestedViewContextId = options?.viewContextId;
    }
    return session.scheduler.enqueue(request, options);
  }

  private async open(
    delegate: OpenWranglerBridge,
    request: OpenSessionRequest,
    options?: BridgeRequestOptions,
    origin?: CoordinatedSessionOrigin
  ): Promise<OpenWranglerResponse> {
    this.pendingOpens.set(delegate, (this.pendingOpens.get(delegate) ?? 0) + 1);
    try {
      if (
        options?.backendPreference !== undefined &&
        options.backendPreference !== "auto" &&
        request.backend !== options.backendPreference
      ) {
        return protocolError(
          "invalid_backend_preference",
          `The host backend preference ${options.backendPreference} does not match the pinned open-session backend.`,
          false
        );
      }
      const invalidOrigin = sessionOriginMismatch(request, origin);
      if (invalidOrigin) {
        return protocolError("invalid_source_origin", invalidOrigin, true);
      }
      return await this.serializeSessionEstablishment(delegate, () =>
        this.openTracked(delegate, request, options, origin)
      );
    } finally {
      const remaining = (this.pendingOpens.get(delegate) ?? 1) - 1;
      if (remaining > 0) this.pendingOpens.set(delegate, remaining);
      else this.pendingOpens.delete(delegate);
      this.resolvePendingOpenWaitersIfIdle();
      this.runtimeCleanup.releaseIfIdle(delegate);
    }
  }

  private async openTracked(
    delegate: OpenWranglerBridge,
    request: OpenSessionRequest,
    options?: BridgeRequestOptions,
    origin?: CoordinatedSessionOrigin
  ): Promise<OpenWranglerResponse> {
    const invalidOrigin = sessionOriginMismatch(request, origin);
    if (invalidOrigin) return protocolError("invalid_source_origin", invalidOrigin, true);
    const response = await delegate.request(request, options);
    if (response.kind === "error" || response.kind === "cancelled") return response;
    if (response.kind !== "sessionOpened") {
      return protocolError(
        "invalid_runtime_response",
        `The runtime returned ${response.kind} while opening an Open Wrangler session.`,
        true
      );
    }

    const publicId = randomUUID();
    const backendPreference =
      options?.backendPreference === "auto" ? undefined : (options?.backendPreference ?? request.backend);
    const sessionOwner: { current?: CoordinatedSession } = {};
    const scheduler = new SessionRequestScheduler((scheduledRequest, scheduledOptions) => {
      const current = sessionOwner.current;
      if (!current) throw new Error("The session scheduler started before its session was initialized.");
      return this.executeSessionRequest(current, scheduledRequest, scheduledOptions);
    });
    const session: CoordinatedSession = {
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
      return protocolError("invalid_source_origin", staleOrigin, true);
    }
    const openedMismatch = sessionOpenedResponseMismatch(request, response);
    if (openedMismatch) {
      await this.runtimeCleanup.close(session, "invalid open runtime");
      return protocolError(
        "invalid_runtime_response",
        `Ignored an invalid openSession response: ${openedMismatch}`,
        true
      );
    }
    let opened: SessionOpenedResponse = { ...response, summaries: [] };
    const persisted = this.loadPersistedSession(request, response.metadata.backend);
    if (persisted) {
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
        const clean = await delegate.request(session.openRequest, options);
        if (clean.kind === "error" || clean.kind === "cancelled") return clean;
        if (clean.kind !== "sessionOpened") {
          return protocolError(
            "invalid_runtime_response",
            `The runtime returned ${clean.kind} while reopening the immutable source.`,
            true
          );
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
          return protocolError(
            "invalid_runtime_response",
            `Ignored an invalid openSession response while reopening the immutable source: ${cleanMismatch}`,
            true
          );
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
        } catch {
          await this.runtimeCleanup.close(session, "failed saved-state runtime");
          return protocolError(
            "saved_view_restore_failed",
            `Open Wrangler could not restore a confirmed view for ${request.source.label}.`,
            true
          );
        }
        session.publicRevision = session.runtimeRevision;
        opened = {
          kind: "sessionOpened",
          metadata: session.metadata,
          page: page.page,
          summaries: []
        };
      }
    }
    if (this.disposed) {
      await this.runtimeCleanup.close(session, "late-open runtime");
      return protocolError(
        "coordinator_disposed",
        "The Open Wrangler session coordinator was disposed before the dataframe finished opening.",
        false
      );
    }
    const finalOrigin = sessionOriginMismatch(request, origin);
    if (finalOrigin) {
      await this.runtimeCleanup.close(session, "invalid open runtime");
      return protocolError("invalid_source_origin", finalOrigin, true);
    }
    this.sessions.set(publicId, session);
    this.setActive(publicId);
    return publicOpenedResponse(opened, publicId, session.publicRevision, session.openRequest.source);
  }

  private async reconfigureFileSession(
    delegate: OpenWranglerBridge,
    sessionId: string,
    revision: number,
    source: SessionSource,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    if (this.disposed) {
      return protocolError(
        "coordinator_disposed",
        "The Open Wrangler session coordinator has been disposed.",
        false,
        sessionId
      );
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.delegate !== delegate) {
      return protocolError("unknown_session", `Unknown Open Wrangler session: ${sessionId}`, true);
    }
    if (revision !== session.publicRevision) {
      return protocolError(
        "stale_request",
        `Ignored stale import-options revision ${revision}; current revision is ${session.publicRevision}.`,
        true,
        session.publicId
      );
    }
    if (session.closing) {
      return protocolError(
        "session_closing",
        `Open Wrangler session ${session.publicId} is already closing.`,
        true,
        session.publicId
      );
    }
    if (session.reconfiguring) {
      return protocolError(
        "session_reconfiguring",
        `Open Wrangler session ${session.publicId} is already changing its file configuration.`,
        true,
        session.publicId
      );
    }
    if (!sameFileSourceIdentity(session.openRequest.source, source)) {
      return protocolError(
        "invalid_import_source",
        "File options and the dataframe engine can be changed only for the same open file.",
        true,
        session.publicId
      );
    }
    const nextBackendPreference = options?.backendPreference;
    if (
      nextBackendPreference !== undefined &&
      nextBackendPreference !== "auto" &&
      !isFileDataBackend(nextBackendPreference)
    ) {
      return protocolError(
        "unsupported_backend",
        "File sessions can use only the Pandas, Polars, or DuckDB backend.",
        true,
        session.publicId
      );
    }
    const backendSelectionChanged =
      nextBackendPreference === "auto"
        ? session.backendPreference !== undefined
        : nextBackendPreference !== undefined &&
          (session.backendPreference !== nextBackendPreference || session.metadata.backend !== nextBackendPreference);
    if (isDeepStrictEqual(session.openRequest.source.importOptions, source.importOptions) && !backendSelectionChanged) {
      return protocolError(
        "import_options_unchanged",
        "The selected import options and dataframe engine are already active.",
        true,
        session.publicId
      );
    }
    if (options?.cancellation?.isCancellationRequested) return reconfigurationCancelled(session.publicId);

    session.reconfiguring = true;
    session.scheduler.cancelBackground();
    this.pendingOpens.set(delegate, (this.pendingOpens.get(delegate) ?? 0) + 1);
    let replacementPublished = false;
    try {
      await session.scheduler.waitForIdle();
      if (!this.isLiveSession(session) || session.closing) {
        return protocolError(
          this.disposed ? "coordinator_disposed" : "session_closing",
          this.disposed
            ? "The Open Wrangler session coordinator was disposed while import options were changing."
            : `Open Wrangler session ${session.publicId} closed while its import options were changing.`,
          false,
          session.publicId
        );
      }
      if (revision !== session.publicRevision) {
        return protocolError(
          "stale_request",
          `Import options were not changed because the session advanced to revision ${session.publicRevision}.`,
          true,
          session.publicId
        );
      }
      if (options?.cancellation?.isCancellationRequested) return reconfigurationCancelled(session.publicId);
      const response = await this.serializeSessionEstablishment(delegate, () =>
        this.runtimeReconfigurer.replaceFileSession(session, source, options, this.runtimeReconfigurationHooks(session))
      );
      replacementPublished = response.kind === "sessionOpened";
      return response;
    } finally {
      session.reconfiguring = false;
      if (
        replacementPublished &&
        this.isLiveSession(session) &&
        !session.closing &&
        this.activeSessionId === session.publicId
      ) {
        this.activeSessionEmitter.fire(activeSnapshot(session));
      }
      const remaining = (this.pendingOpens.get(delegate) ?? 1) - 1;
      if (remaining > 0) this.pendingOpens.set(delegate, remaining);
      else this.pendingOpens.delete(delegate);
      this.resolvePendingOpenWaitersIfIdle();
      this.runtimeCleanup.releaseIfIdle(delegate);
    }
  }

  private async reconfigureNotebookSessionForEditing(
    delegate: OpenWranglerBridge,
    sessionId: string,
    revision: number,
    viewState: GridViewState,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    if (this.disposed) {
      return protocolError(
        "coordinator_disposed",
        "The Open Wrangler session coordinator has been disposed.",
        false,
        sessionId
      );
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.delegate !== delegate) {
      return protocolError("unknown_session", `Unknown Open Wrangler session: ${sessionId}`, true);
    }
    if (revision !== session.publicRevision) {
      return protocolError(
        "stale_request",
        `Editing mode was not opened because the session advanced to revision ${session.publicRevision}.`,
        true,
        session.publicId
      );
    }
    if (session.closing) {
      return protocolError(
        "session_closing",
        `Open Wrangler session ${session.publicId} is already closing.`,
        true,
        session.publicId
      );
    }
    if (session.reconfiguring) {
      return protocolError(
        "session_reconfiguring",
        `Open Wrangler session ${session.publicId} is already changing its runtime configuration.`,
        true,
        session.publicId
      );
    }
    if (!canReopenLiveSessionForEditing(session)) {
      return protocolError(
        "editing_mode_unavailable",
        "This session cannot be reopened in Editing mode.",
        true,
        session.publicId
      );
    }
    const staleOrigin = sessionOriginMismatch(session.openRequest, session.origin);
    if (staleOrigin) return protocolError("invalid_source_origin", staleOrigin, true, session.publicId);

    const nextViewState = reconcileViewingState(
      { ...viewState, filterModel: session.metadata.filterModel },
      session.metadata
    );
    const selectedColumnChanged = nextViewState.selectedColumnId !== session.viewState.selectedColumnId;
    const viewStateChanged = !isDeepStrictEqual(nextViewState, session.viewState);
    session.viewState = nextViewState;
    session.reconfiguring = true;
    session.scheduler.cancelBackground();
    this.pendingOpens.set(delegate, (this.pendingOpens.get(delegate) ?? 0) + 1);
    let replacementPublished = false;
    try {
      if (viewStateChanged) await this.responseCommitter.persistSession(session);
      await session.scheduler.waitForIdle();
      if (!this.isLiveSession(session) || session.closing) {
        return protocolError(
          this.disposed ? "coordinator_disposed" : "session_closing",
          this.disposed
            ? "The Open Wrangler session coordinator was disposed while Editing mode was opening."
            : `Open Wrangler session ${session.publicId} closed while Editing mode was opening.`,
          false,
          session.publicId
        );
      }
      if (revision !== session.publicRevision) {
        return protocolError(
          "stale_request",
          `Editing mode was not opened because the session advanced to revision ${session.publicRevision}.`,
          true,
          session.publicId
        );
      }
      const originMismatch = sessionOriginMismatch(session.openRequest, session.origin);
      if (originMismatch) return protocolError("invalid_source_origin", originMismatch, true, session.publicId);
      const response = await this.serializeSessionEstablishment(delegate, () =>
        this.runtimeReconfigurer.reopenNotebookForEditing(session, options, this.runtimeReconfigurationHooks(session))
      );
      replacementPublished = response.kind === "sessionOpened";
      return response;
    } finally {
      session.reconfiguring = false;
      if (
        (replacementPublished || (viewStateChanged && selectedColumnChanged)) &&
        this.isLiveSession(session) &&
        !session.closing &&
        this.activeSessionId === session.publicId
      ) {
        this.activeSessionEmitter.fire(activeSnapshot(session));
      }
      const remaining = (this.pendingOpens.get(delegate) ?? 1) - 1;
      if (remaining > 0) this.pendingOpens.set(delegate, remaining);
      else this.pendingOpens.delete(delegate);
      this.resolvePendingOpenWaitersIfIdle();
      this.runtimeCleanup.releaseIfIdle(delegate);
    }
  }

  private runtimeReconfigurationHooks(session: CoordinatedSession): RuntimeReconfigurationHooks {
    return {
      isCoordinatorAvailable: () => !this.disposed,
      isCurrent: () => this.isLiveSession(session) && !session.closing,
      originMismatch: (request) => sessionOriginMismatch(request, session.origin),
      recoverConfirmedRuntime: () =>
        this.runtimeRecovery.replay(session, runtimeRecoveryOptions(), this.runtimeRecoveryHooks(session), false),
      invalidateStepInspection: () => this.invalidateStepInspection(session)
    };
  }

  private cancelViewRequests(sessionId: string, viewRequestIds: readonly string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.scheduler.cancelViewRequests(viewRequestIds);
  }

  private prioritizeViewRequest(sessionId: string, viewRequestId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.reconfiguring) return;
    session.scheduler.prioritizeViewRequest(viewRequestId);
  }

  private setViewContext(sessionId: string, viewContextId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.reconfiguring) return;
    session.activeViewContextId = viewContextId;
    session.latestRequestedViewContextId = viewContextId;
  }

  private executeSessionRequest(
    session: CoordinatedSession,
    publicRequest: SessionBoundRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    return this.runtimeRequestExecutor.execute(session, publicRequest, options, {
      isCoordinatorAvailable: () => !this.disposed,
      waitForRuntimeSettlement: () => this.waitForRuntimeSettlement(session),
      installRuntimeSettlement: (settlement) => this.installRuntimeSettlementBarrier(session, settlement),
      replay: (replayOptions) => this.replay(session, replayOptions),
      replayAfterRuntimeLoss: (failedRuntimeId, replayOptions, requiredSchema, isStillCurrent) =>
        this.replayAfterRuntimeLoss(session, failedRuntimeId, replayOptions, requiredSchema, isStillCurrent),
      close: (closeOptions) => this.closeSession(session, closeOptions),
      responseCallbacks: {
        activate: () => {
          if (this.isLiveSession(session)) this.setActive(session.publicId);
        },
        publishInspection: () => {
          if (this.isLiveSession(session) && this.activeSessionId === session.publicId) {
            this.activeSessionEmitter.fire(activeSnapshot(session));
          }
        }
      }
    });
  }

  private async closeSession(
    session: CoordinatedSession,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    try {
      const response = await this.runtimeCleanup.closeTerminal(session, options);
      if (response.kind === "sessionClosed" && response.sessionId === session.runtimeId) {
        return { ...response, sessionId: session.publicId };
      }
      if (response.kind === "error") {
        return { ...response, sessionId: session.publicId };
      }
      return protocolError(
        "invalid_close_response",
        `The runtime returned ${response.kind} while closing the Open Wrangler session.`,
        false,
        session.publicId
      );
    } finally {
      this.releaseSession(session);
    }
  }

  private releaseSession(session: CoordinatedSession): void {
    if (this.sessions.get(session.publicId) !== session) return;
    this.sessions.delete(session.publicId);
    if (this.activeSessionId === session.publicId) this.setActive(undefined);
    this.runtimeCleanup.releaseIfIdle(session.delegate);
  }

  private installRuntimeSettlementBarrier(session: CoordinatedSession, settlement: Promise<void>): void {
    const preceding = session.runtimeSettlementBarrier ?? Promise.resolve();
    const barrier = preceding.then(
      () => settlement,
      () => settlement
    );
    session.runtimeSettlementBarrier = barrier;
    void barrier.then(() => {
      if (session.runtimeSettlementBarrier === barrier) session.runtimeSettlementBarrier = undefined;
    });
  }

  private async waitForRuntimeSettlement(session: CoordinatedSession): Promise<void> {
    while (session.runtimeSettlementBarrier) {
      await session.runtimeSettlementBarrier;
    }
  }

  private async shutdownSessions(timeoutMs: number): Promise<void> {
    this.disposed = true;
    const sessions = [...this.sessions.values()].map((session) => {
      const alreadyClosing = session.closing;
      session.closing = true;
      session.scheduler.cancelBackground();
      return { session, alreadyClosing };
    });
    const closes = sessions.map(async ({ session, alreadyClosing }) => {
      await session.scheduler.waitForIdle();
      // A notebook host deadline detaches only the waiter; the exact kernel
      // request keeps running. Deactivation must not let terminal close
      // overtake that work. The outer shutdown deadline still bounds how long
      // disposal waits, while this observed chain closes once settlement is
      // authoritative.
      await this.waitForRuntimeSettlement(session);
      if (alreadyClosing) return;
      try {
        await this.closeSession(session);
      } catch {
        // Deactivation still releases local state; a standalone runtime also receives EOF below.
      }
    });

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    await Promise.race([
      Promise.allSettled([...closes, this.waitForPendingOpens(), this.runtimeCleanup.waitForTracked()]),
      new Promise<void>((resolve) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            resolve();
          },
          Math.max(0, timeoutMs)
        );
      })
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      for (const { session } of sessions) session.scheduler.cancelAll();
    }
    for (const { session } of sessions) this.releaseSession(session);
    if (this.activeSessionId) this.setActive(undefined);
    this.activeSessionEmitter.dispose();
  }

  private waitForPendingOpens(): Promise<void> {
    if (this.pendingOpens.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.pendingOpenWaiters.add(resolve));
  }

  private resolvePendingOpenWaitersIfIdle(): void {
    if (this.pendingOpens.size > 0) return;
    for (const resolve of this.pendingOpenWaiters) resolve();
    this.pendingOpenWaiters.clear();
  }

  private loadPersistedSession(
    request: OpenSessionRequest,
    backend: SessionMetadata["backend"]
  ): DecodedPersistedSessionState | undefined {
    return this.persistence.load(request.source, backend);
  }

  private replay(session: CoordinatedSession, options?: BridgeRequestOptions): Promise<boolean> {
    return this.serializeSessionEstablishment(session.delegate, () =>
      this.runtimeRecovery.replay(session, options, this.runtimeRecoveryHooks(session))
    );
  }

  private replayAfterRuntimeLoss(
    session: CoordinatedSession,
    failedRuntimeId: string,
    options?: BridgeRequestOptions,
    requiredSchema?: readonly ColumnSchema[],
    isStillCurrent?: () => boolean,
    onRestoredPage?: (page: PageResponse) => void
  ): Promise<boolean> {
    return this.serializeSessionEstablishment(session.delegate, async () => {
      if (!this.isLiveSession(session) || session.closing) return false;
      if (session.runtimeId !== failedRuntimeId) return true;
      if (isStillCurrent && !isStillCurrent()) return false;
      return this.runtimeRecovery.replay(
        session,
        options,
        this.runtimeRecoveryHooks(session),
        true,
        requiredSchema,
        isStillCurrent,
        onRestoredPage
      );
    });
  }

  private serializeSessionEstablishment<T>(delegate: OpenWranglerBridge, establish: () => Promise<T>): Promise<T> {
    const preceding = this.sessionEstablishmentTails.get(delegate) ?? Promise.resolve();
    const result = preceding.then(establish, establish);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.sessionEstablishmentTails.set(delegate, tail);
    void tail.finally(() => {
      if (this.sessionEstablishmentTails.get(delegate) === tail) this.sessionEstablishmentTails.delete(delegate);
    });
    return result;
  }

  private runtimeRecoveryHooks(session: CoordinatedSession): RuntimeRecoveryHooks {
    return {
      isCurrent: () => this.isLiveSession(session) && !session.closing,
      originMismatch: (request) => sessionOriginMismatch(request, session.origin),
      clearPublishedStepInspection: () => this.clearPublishedStepInspection(session),
      publishActive: () => {
        if (this.activeSessionId === session.publicId) this.activeSessionEmitter.fire(activeSnapshot(session));
      },
      replayAfterRuntimeLoss: (failedRuntimeId, options, requiredSchema, onRestoredPage) =>
        this.replayAfterRuntimeLoss(session, failedRuntimeId, options, requiredSchema, undefined, onRestoredPage)
    };
  }

  private isLiveSession(session: CoordinatedSession): boolean {
    return !this.disposed && this.sessions.get(session.publicId) === session;
  }
}

function sameFileSourceIdentity(current: SessionSource, replacement: SessionSource): boolean {
  if (current.kind !== "file" || replacement.kind !== "file") return false;
  const { importOptions: _currentImportOptions, ...currentIdentity } = current;
  const { importOptions: _replacementImportOptions, ...replacementIdentity } = replacement;
  return isDeepStrictEqual(currentIdentity, replacementIdentity);
}

function normalizeSessionOrigin(origin: BridgeSessionOrigin | undefined): CoordinatedSessionOrigin | undefined {
  if (!origin) return undefined;
  if (isTextDocumentSessionOrigin(origin)) {
    if (!Number.isSafeInteger(origin.version) || origin.version < 0) {
      throw new TypeError("A source-document origin requires a valid captured document version.");
    }
    return Object.freeze({ kind: "textDocument", document: origin.document, version: origin.version });
  }
  return Object.freeze({ kind: "notebook", document: origin });
}

function isTextDocumentSessionOrigin(origin: BridgeSessionOrigin): origin is TextDocumentSessionOrigin {
  return "kind" in origin && origin.kind === "textDocument";
}

function canReopenLiveSessionForEditing(session: CoordinatedSession): boolean {
  if (session.metadata.mode !== "viewing" || session.metadata.backend === "pyspark") return false;
  if (session.openRequest.source.kind === "notebookVariable") {
    return session.origin?.kind === "notebook" && session.metadata.capabilities.notebookInsert;
  }
  return (
    session.openRequest.source.kind === "rInteractiveVariable" &&
    session.metadata.backend === "r" &&
    session.origin === undefined &&
    !session.metadata.capabilities.notebookInsert &&
    session.metadata.capabilities.documentInsert !== true
  );
}

function sessionOriginMismatch(
  request: OpenSessionRequest,
  origin: CoordinatedSessionOrigin | undefined
): string | undefined {
  if (request.source.kind === "documentVariable" && origin?.kind !== "textDocument") {
    return "A live document-variable session requires its exact originating text document.";
  }
  if (!origin) return undefined;
  return origin.kind === "notebook"
    ? notebookOriginMismatch(request, origin.document)
    : textDocumentOriginMismatch(request, origin);
}

function notebookOriginMismatch(request: OpenSessionRequest, notebook: vscode.NotebookDocument): string | undefined {
  if (request.source.kind !== "notebookVariable" || !request.source.uri) {
    return "Notebook provenance may be attached only to a live notebook-variable session.";
  }
  if (request.source.uri !== notebook.uri.toString()) {
    return "The notebook variable source did not match its originating notebook document.";
  }
  if (!isSoleOpenNotebookDocument(notebook)) {
    return "The originating notebook is no longer open. Reopen it and try again.";
  }
  return undefined;
}

function textDocumentOriginMismatch(
  request: OpenSessionRequest,
  origin: TextDocumentSessionOrigin
): string | undefined {
  if (request.source.kind !== "documentVariable" || !request.source.uri) {
    return "Source-document provenance may be attached only to a live document-variable session.";
  }
  const document = origin.document;
  if (request.source.uri !== document.uri.toString()) {
    return "The document variable source did not match its originating text document.";
  }
  const matches = vscode.workspace.textDocuments.filter((candidate) => candidate.uri.toString() === request.source.uri);
  if (document.isClosed || matches.length !== 1 || matches[0] !== document) {
    return "The originating source document is no longer uniquely open. Reopen it and try again.";
  }
  if (document.version !== origin.version) {
    return "The originating source document changed after Open Wrangler captured it. Run the file again.";
  }
  return undefined;
}

function activeSnapshot(session: CoordinatedSession): ActiveSessionSnapshot {
  const stepInspection = session.stepInspection;
  return {
    sessionId: session.publicId,
    metadata: publicMetadata(session.metadata, session.publicId, session.publicRevision, session.openRequest.source),
    code: stepInspection?.code ?? session.code,
    viewState: session.viewState,
    ...(session.latestStepInspectionKey ? { stepInspectionActive: true } : {}),
    ...(stepInspection ? { stepInspection } : {})
  };
}
