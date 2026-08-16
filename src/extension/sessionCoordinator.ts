import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type {
  ColumnSchema,
  DataBackend,
  OpenWranglerRequest,
  OpenWranglerResponse,
  DataExportedResponse,
  ErrorResponse,
  FilterModel,
  OpenSessionRequest,
  PageResponse,
  SessionMetadata,
  SessionOpenedResponse,
  SessionSource,
  SessionBoundRequest,
  StepInspectionResponse
} from "../shared/protocol";
import { isSessionBoundRequest } from "../shared/protocol";
import { isOpenWranglerRequest } from "../shared/protocolValidation";
import type { GridViewState, PersistedViewingState } from "../shared/viewState";
import {
  DetachedBridgeRequestError,
  type BridgeRequestOptions,
  type OpenWranglerBridge,
  type SessionPresentation
} from "./dataBridge";
import { isFileDataBackend } from "./pythonEnvironmentModel";
import { isSoleOpenNotebookDocument } from "./notebooks/notebookProvenance";
import { persistedSessionState, type DecodedPersistedSessionState } from "./sessionPersistence";
import { SessionPersistenceStore } from "./sessionPersistenceStore";
import { responseMismatch, sessionOpenedResponseMismatch } from "./sessionResponseValidation";
import {
  SessionRequestScheduler,
  requestViewId,
  sessionRequestPriority,
  type SessionRequestExecutionLane
} from "./sessionRequestScheduler";
import { SessionRuntimeCleanup, runtimeCleanupOptions } from "./sessionRuntimeCleanup";
import {
  gridState,
  initialViewingState,
  reconcileViewingState,
  RuntimeStateRestoreError,
  SessionRuntimeStateRestorer,
  type RuntimeSessionState
} from "./sessionRuntimeStateRestorer";

export type { SessionRequestExecutionLane } from "./sessionRequestScheduler";

interface CoordinatedSession extends RuntimeSessionState {
  publicRevision: number;
  openRequest: OpenSessionRequest;
  backendPreference?: DataBackend;
  origin?: CoordinatedSessionOrigin;
  activeViewContextId?: string;
  latestRequestedViewContextId?: string;
  latestRequestedPageRequestId?: string;
  scheduler: SessionRequestScheduler;
  closing: boolean;
  reconfiguring: boolean;
  reconnecting: boolean;
  liveReconnectRequired: boolean;
  recoveryRequired: boolean;
  /** Host-detached runtime work that must settle before this session may issue more work. */
  runtimeSettlementBarrier?: Promise<void>;
  stepInspection?: StepInspectionResponse;
  latestStepInspectionKey?: string;
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
class ReconfigurationCancelledError extends Error {}
class ReconfigurationSupersededError extends Error {}

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

  constructor(workspaceState?: vscode.Memento, diagnosticSink?: (message: string) => void) {
    this.persistence = new SessionPersistenceStore(workspaceState);
    this.runtimeCleanup = new SessionRuntimeCleanup(
      (delegate) =>
        this.pendingOpens.has(delegate) || [...this.sessions.values()].some((session) => session.delegate === delegate),
      diagnosticSink
    );
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
    const unavailable = (message: string): ErrorResponse =>
      protocolError("pyspark_connect_state_lost", message, true, sessionId);
    if (
      this.disposed ||
      !session ||
      session.delegate !== delegate ||
      session.metadata.backend !== "pyspark" ||
      session.openRequest.source.kind !== "notebookVariable"
    ) {
      return unavailable("This live PySpark dataframe is no longer available to reconnect.");
    }
    if (revision !== session.publicRevision) {
      return unavailable(
        "The Open Wrangler view changed before reconnecting. Try Reconnect again from the current view."
      );
    }
    if (!session.liveReconnectRequired) {
      return protocolError(
        "pyspark_connect_reconnect_not_required",
        "This live PySpark dataframe does not need to reconnect.",
        true,
        session.publicId
      );
    }
    if (session.closing || session.reconfiguring || session.reconnecting) {
      return unavailable("Open Wrangler is already closing or reconnecting this dataframe.");
    }

    session.reconnecting = true;
    session.scheduler.cancelBackground();
    try {
      await session.scheduler.waitForIdle();
      if (
        !this.isLiveSession(session) ||
        session.closing ||
        session.publicRevision !== revision ||
        !session.liveReconnectRequired
      ) {
        return unavailable("The Open Wrangler view changed before the dataframe could reconnect.");
      }

      const failedRuntimeId = session.runtimeId;
      let restoredPage: PageResponse | undefined;
      const recovered = await this.replayAfterRuntimeLoss(
        session,
        failedRuntimeId,
        automaticRecoveryOptions(options, failedRuntimeId),
        session.metadata.schema,
        undefined,
        (page) => {
          restoredPage = page;
        }
      );
      if (!recovered || !restoredPage) {
        return unavailable(
          `Open Wrangler could not reconnect ${session.openRequest.source.variableName}. ` +
            "Run the cell that creates it, then choose Reconnect again."
        );
      }

      session.liveReconnectRequired = false;
      return {
        kind: "sessionOpened",
        metadata: publicMetadata(
          session.metadata,
          session.publicId,
          session.publicRevision,
          session.openRequest.source
        ),
        page: restoredPage.page,
        summaries: []
      };
    } finally {
      session.reconnecting = false;
    }
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
    await this.persistSession(session);
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
        this.reconfigureFileSessionExclusive(session, source, options)
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
      if (viewStateChanged) await this.persistSession(session);
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
        this.reconfigureNotebookSessionForEditingExclusive(session, options)
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

  private async reconfigureNotebookSessionForEditingExclusive(
    session: CoordinatedSession,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    if (!this.isLiveSession(session) || session.closing) {
      return protocolError(
        this.disposed ? "coordinator_disposed" : "session_closing",
        "The live session closed before Editing mode could open.",
        false,
        session.publicId
      );
    }
    const originMismatch = sessionOriginMismatch(session.openRequest, session.origin);
    if (originMismatch) return protocolError("invalid_source_origin", originMismatch, true, session.publicId);

    const previous: RuntimeSessionState = {
      publicId: session.publicId,
      runtimeId: session.runtimeId,
      runtimeRevision: session.runtimeRevision,
      delegate: session.delegate,
      metadata: session.metadata,
      code: session.code,
      draftBaseFilterModel: session.draftBaseFilterModel,
      viewState: session.viewState
    };
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
        candidate ?? {
          publicId: session.publicId,
          runtimeId: candidateSessionId,
          runtimeRevision: 0,
          delegate: session.delegate,
          metadata: session.metadata,
          code: "",
          viewState: session.viewState
        },
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

    candidate = {
      publicId: session.publicId,
      runtimeId: candidateSessionId,
      runtimeRevision: response.metadata.revision,
      delegate: session.delegate,
      metadata: response.metadata,
      code: "",
      viewState: initialViewingState(response.metadata)
    };
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
      if (!this.isLiveSession(session) || session.closing) throw new ReconfigurationSupersededError();
      if (sessionOriginMismatch(candidateRequest, session.origin)) throw new ReconfigurationSupersededError();
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
    session.runtimeId = candidate.runtimeId;
    session.runtimeRevision = candidate.runtimeRevision;
    session.publicRevision = publicRevision;
    session.openRequest = confirmedReplayOpenRequest(candidateRequest, candidate.metadata);
    session.metadata = candidate.metadata;
    session.code = candidate.code;
    session.draftPresentation = undefined;
    session.draftBaseFilterModel = undefined;
    session.viewState = candidate.viewState;
    session.recoveryRequired = false;
    session.activeViewContextId = undefined;
    session.latestRequestedViewContextId = undefined;
    session.latestRequestedPageRequestId = undefined;
    this.invalidateStepInspection(session);
    candidateCleanupAttempted = true;
    candidate = undefined;
    this.runtimeCleanup.track(previous, "retired runtime");
    await this.persistSession(session);
    return publicOpenedResponse(
      { kind: "sessionOpened", metadata: session.metadata, page: page.page, summaries: [] },
      session.publicId,
      publicRevision,
      session.openRequest.source
    );
  }

  private async reconfigureFileSessionExclusive(
    session: CoordinatedSession,
    source: SessionSource,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    if (!this.isLiveSession(session) || session.closing) {
      return protocolError(
        this.disposed ? "coordinator_disposed" : "session_closing",
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
    const previous: RuntimeSessionState = {
      publicId: session.publicId,
      runtimeId: session.runtimeId,
      runtimeRevision: session.runtimeRevision,
      delegate: session.delegate,
      metadata: session.metadata,
      code: session.code,
      draftBaseFilterModel: session.draftBaseFilterModel,
      viewState: session.viewState
    };
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
        candidate ?? {
          publicId: session.publicId,
          runtimeId: candidateSessionId,
          runtimeRevision: 0,
          delegate: session.delegate,
          metadata: session.metadata,
          code: "",
          viewState: session.viewState
        },
        "import candidate",
        runtimeCleanupOptions(),
        true
      );
    };
    const recoverConfirmedRuntime = async (): Promise<void> => {
      const recovered =
        this.isLiveSession(session) &&
        !session.closing &&
        (await this.replayExclusive(session, runtimeRecoveryOptions(), false));
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

    candidate = {
      publicId: session.publicId,
      runtimeId: candidateSessionId,
      runtimeRevision: response.metadata.revision,
      delegate: session.delegate,
      metadata: response.metadata,
      code: "",
      viewState: initialViewingState(response.metadata)
    };
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
    if (!this.isLiveSession(session) || session.closing) {
      await cleanupCandidate();
      return protocolError(
        this.disposed ? "coordinator_disposed" : "session_closing",
        "The file session closed before its replacement runtime could replay any state.",
        false,
        session.publicId
      );
    }

    let page: PageResponse;
    const assertCandidateCurrent = (): void => {
      if (options?.cancellation?.isCancellationRequested) throw new ReconfigurationCancelledError();
      if (!this.isLiveSession(session) || session.closing) throw new ReconfigurationSupersededError();
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
          this.disposed ? "coordinator_disposed" : "session_closing",
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

    if (!this.isLiveSession(session) || session.closing) {
      await cleanupCandidate();
      return protocolError(
        this.disposed ? "coordinator_disposed" : "session_closing",
        "The file session closed before its new import options could be committed.",
        false,
        session.publicId
      );
    }

    const publicRevision = session.publicRevision + 1;
    session.runtimeId = candidate.runtimeId;
    session.runtimeRevision = candidate.runtimeRevision;
    session.publicRevision = publicRevision;
    session.openRequest = confirmedReplayOpenRequest(candidateRequest, candidate.metadata);
    if (options?.backendPreference === "auto") delete session.backendPreference;
    else if (options?.backendPreference !== undefined) session.backendPreference = options.backendPreference;
    session.metadata = candidate.metadata;
    session.code = candidate.code;
    session.draftPresentation = candidate.draftPresentation;
    session.draftBaseFilterModel = candidate.draftBaseFilterModel;
    session.viewState = candidate.viewState;
    session.recoveryRequired = false;
    session.activeViewContextId = undefined;
    session.latestRequestedViewContextId = undefined;
    session.latestRequestedPageRequestId = undefined;
    this.invalidateStepInspection(session);
    candidateCleanupAttempted = true;
    candidate = undefined;
    this.runtimeCleanup.track(previous, "retired runtime");
    await this.persistSession(session);
    return publicOpenedResponse(
      {
        kind: "sessionOpened",
        metadata: session.metadata,
        page: page.page,
        summaries: []
      },
      session.publicId,
      publicRevision,
      source
    );
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

  private isCurrentPageRequest(
    session: CoordinatedSession,
    request: Extract<SessionBoundRequest, { kind: "getPage" }>,
    options?: BridgeRequestOptions
  ): boolean {
    return (
      request.viewRequestId === session.latestRequestedPageRequestId &&
      (options?.viewContextId === undefined || options.viewContextId === session.latestRequestedViewContextId)
    );
  }

  private async executeSessionRequest(
    session: CoordinatedSession,
    publicRequest: SessionBoundRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    // A notebook deadline only stops the host from waiting; it never
    // interrupts Jupyter. Keep later work (including recovery and terminal
    // close) behind the exact detached execution so nothing can overtake or
    // replay a request that may still be running.
    await this.waitForRuntimeSettlement(session);
    // Closing is a terminal barrier and intentionally rebases to the latest
    // runtime revision. Every other queued request must still target the public
    // revision that was current when it entered the queue.
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
      const recovered = !this.disposed && !session.closing && (await this.replay(session, runtimeRecoveryOptions()));
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
      !this.disposed && !session.closing && (!isBackground || rendererBackgroundReadIsCurrent());
    const canRecoverTransport = (): boolean => canRecoverUnknownSession() && isIdempotentReadRequest(publicRequest);
    const liveSourceRecoveryIsCurrent = (): boolean => {
      if (requestWasCancelled()) return false;
      if (publicRequest.kind === "getPage") return this.isCurrentPageRequest(session, publicRequest, options);
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

    if (publicRequest.kind === "closeSession") {
      return this.closeSession(session, options);
    }

    let response: OpenWranglerResponse;
    try {
      response = await session.delegate.request(runtimeRequest(), options);
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError) {
        this.installRuntimeSettlementBarrier(session, error.settlement);
        if (error.dispatched && isRuntimeStateMutation(publicRequest)) session.recoveryRequired = true;
        throw error;
      }
      if (isRuntimeStateMutation(publicRequest)) session.recoveryRequired = true;
      // A transport failure is ambiguous for mutations and exports: the remote
      // runtime may have committed before delivery failed. Only pure reads may
      // be replayed and reissued automatically.
      if (rendererBackgroundRead && !requestWasCancelled() && !isCurrentLogicalView(session, options)) {
        return staleBackgroundResponse();
      }
      const recovered =
        canRecoverTransport() &&
        (await this.replayAfterRuntimeLoss(session, requestRuntimeId, automaticRecoveryOptions(options)));
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
      const unknownValidationRequest = {
        ...publicRequest,
        sessionId: requestRuntimeId,
        revision: requestRuntimeRevision
      } as SessionBoundRequest;
      const unknownMismatch = responseMismatch(
        unknownValidationRequest,
        response,
        requestRuntimeId,
        session.metadata.schema
      );
      if (unknownMismatch) {
        return protocolError(
          "invalid_runtime_response",
          `Ignored an invalid ${publicRequest.kind} response: ${unknownMismatch}`,
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      const confirmedUnknownResponse = { ...response };
      // An explicit unknown-session response proves the request did not run, so
      // replay and reissue are safe for interactive operations and current,
      // renderer-owned idempotent profiling reads.
      if (rendererBackgroundRead && !requestWasCancelled() && !isCurrentLogicalView(session, options)) {
        return staleBackgroundResponse();
      }
      const recovered =
        canRecoverUnknownSession() &&
        (await this.replayAfterRuntimeLoss(session, requestRuntimeId, automaticRecoveryOptions(options)));
      if (recovered) {
        if (rendererBackgroundRead && !rendererBackgroundReadIsCurrent()) {
          if (requestWasCancelled()) {
            return { ...confirmedUnknownResponse, sessionId: session.publicId };
          }
          return staleBackgroundResponse();
        }
        session.recoveryRequired = false;
        requestRuntimeId = session.runtimeId;
        requestRuntimeRevision = session.runtimeRevision;
        response = await session.delegate.request(runtimeRequest(), options);
      }
    }

    if (isLiveSourceInvalidated(response, requestRuntimeId)) {
      const invalidatedValidationRequest = {
        ...publicRequest,
        sessionId: requestRuntimeId,
        revision: requestRuntimeRevision
      } as SessionBoundRequest;
      const invalidatedMismatch = responseMismatch(
        invalidatedValidationRequest,
        response,
        requestRuntimeId,
        session.metadata.schema
      );
      if (invalidatedMismatch) {
        return protocolError(
          "invalid_runtime_response",
          `Ignored an invalid ${publicRequest.kind} response: ${invalidatedMismatch}`,
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      if (!liveSourceRecoveryIsCurrent()) return staleLiveSourceResponse();
      const recovered =
        canRecoverTransport() &&
        liveSourceRecoveryIsCurrent() &&
        (await this.replayAfterRuntimeLoss(
          session,
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

    const validationRequest = {
      ...publicRequest,
      sessionId: requestRuntimeId,
      revision: requestRuntimeRevision
    } as SessionBoundRequest;
    const mismatch = responseMismatch(validationRequest, response, requestRuntimeId, session.metadata.schema);
    if (mismatch) {
      if (isRuntimeStateMutation(publicRequest)) session.recoveryRequired = true;
      return protocolError(
        "invalid_runtime_response",
        `Ignored an invalid ${publicRequest.kind} response: ${mismatch}`,
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }
    if (isPySparkConnectStateLost(response, requestRuntimeId)) {
      session.liveReconnectRequired = true;
      session.scheduler.cancelBackground();
    }

    if (publicRequest.kind === "inspectStep" && response.kind === "stepInspection") {
      const expectedIndex = session.metadata.steps.findIndex((step) => step.id === publicRequest.stepId);
      if (expectedIndex < 0 || response.stepIndex !== expectedIndex) {
        return protocolError(
          "invalid_runtime_response",
          `Ignored an invalid inspectStep response: runtime reported step index ${response.stepIndex} instead of ${expectedIndex}.`,
          true,
          session.publicId
        );
      }
      if (session.latestStepInspectionKey !== stepInspectionKey(publicRequest)) {
        return protocolError(
          "stale_response",
          "Ignored an applied-step inspection superseded by a newer selection.",
          true,
          session.publicId
        );
      }
      const inspection = { ...response, revision: session.publicRevision };
      session.stepInspection = inspection;
      if (this.isLiveSession(session) && this.activeSessionId === session.publicId) {
        this.activeSessionEmitter.fire(activeSnapshot(session));
      }
      return inspection;
    }

    if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
      const pageRequest = response.kind === "page" && publicRequest.kind === "getPage" ? publicRequest : undefined;
      if (response.kind === "page" && (!pageRequest || response.viewRequestId !== pageRequest.viewRequestId)) {
        return protocolError(
          "stale_response",
          "Ignored a page response correlated to a different request.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      if (pageRequest && !this.isCurrentPageRequest(session, pageRequest, options)) {
        return protocolError(
          "stale_response",
          "Ignored a page from a superseded logical view.",
          true,
          session.publicId,
          pageRequest.viewRequestId
        );
      }
      if (response.revision < requestRuntimeRevision) {
        return protocolError(
          "stale_response",
          "Ignored a stale grid response.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      const filterChanged = !sameFilterModel(previousFilterModel, response.metadata.filterModel);
      const revisionChanged = response.revision !== requestRuntimeRevision;
      const planChanged = response.kind === "stepPreview" || response.kind === "planUpdated";
      const shapeChanged =
        !isDeepStrictEqual(session.metadata.shape, response.metadata.shape) ||
        !isDeepStrictEqual(session.metadata.filteredShape, response.metadata.filteredShape);
      const stateChanged = filterChanged || revisionChanged || planChanged || shapeChanged;
      const nextViewState = reconcileViewingState(
        {
          ...gridState(session.viewState),
          filterModel: response.metadata.filterModel,
          ...(filterChanged && response.kind === "page"
            ? {
                viewport: {
                  firstVisibleRow: response.page.offset,
                  scrollLeft: session.viewState.viewport.scrollLeft
                }
              }
            : {})
        },
        response.metadata
      );
      const viewContextChanged = Boolean(
        pageRequest &&
        session.activeViewContextId !== undefined &&
        options?.viewContextId !== session.activeViewContextId
      );
      const draftPresentation: SessionPresentation["draft"] | undefined =
        response.kind === "stepPreview"
          ? {
              diff: response.diff,
              ...(response.remainingMissingCells === undefined
                ? {}
                : { remainingMissingCells: response.remainingMissingCells }),
              warnings: [...(response.warnings ?? [])],
              beforeSchema:
                response.metadata.draftReplacesStepId === undefined
                  ? session.metadata.schema
                  : (response.metadata.latestStepInputSchema ?? session.metadata.schema)
            }
          : undefined;
      const nextDraftBaseFilterModel =
        response.kind === "stepPreview"
          ? previousFilterModel
          : response.kind === "planUpdated"
            ? undefined
            : session.draftBaseFilterModel;
      const commitState = (): void => {
        if (pageRequest) {
          session.activeViewContextId = options?.viewContextId;
        } else if (planChanged) {
          session.activeViewContextId = undefined;
          session.latestRequestedViewContextId = undefined;
          session.latestRequestedPageRequestId = undefined;
        }
        session.publicRevision += response.revision - requestRuntimeRevision;
        session.runtimeRevision = response.revision;
        if (stateChanged) {
          session.metadata = response.metadata;
          session.viewState = nextViewState;
        }
        if (viewContextChanged) session.metadata = withoutDatasetStats(session.metadata);
        if (response.kind === "stepPreview" || response.kind === "planUpdated") {
          session.code = response.code;
          session.draftPresentation = draftPresentation;
          session.draftBaseFilterModel = nextDraftBaseFilterModel;
        }
      };
      if (pageRequest && stateChanged) {
        const committed = await this.persistCurrentPage(
          session,
          response.metadata,
          nextViewState,
          () => this.isCurrentPageRequest(session, pageRequest, options),
          () => {
            commitState();
            if (this.isLiveSession(session)) this.setActive(session.publicId);
          }
        );
        if (!committed) {
          return protocolError(
            "stale_response",
            "Ignored a page superseded while its viewing state was being saved.",
            true,
            session.publicId,
            pageRequest.viewRequestId
          );
        }
      } else {
        commitState();
        if (stateChanged) await this.persistSession(session);
        if ((stateChanged || viewContextChanged) && this.isLiveSession(session)) this.setActive(session.publicId);
      }
      return {
        ...response,
        revision: session.publicRevision,
        metadata: publicMetadata(session.metadata, session.publicId, session.publicRevision, session.openRequest.source)
      };
    }
    if (response.kind === "summary" || response.kind === "columnValues") {
      if (response.revision < requestRuntimeRevision || !isCurrentLogicalView(session, options)) {
        return protocolError(
          "stale_response",
          "Ignored a stale or superseded profiling response.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "dataExported") {
      if (response.revision < requestRuntimeRevision) {
        return protocolError(
          "stale_response",
          "Ignored a stale export response.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "datasetStats") {
      if (response.revision < requestRuntimeRevision || !isCurrentLogicalView(session, options)) {
        return protocolError(
          "stale_response",
          "Ignored stale or superseded dataset statistics.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      if (
        publicRequest.kind === "getDatasetStats" &&
        options?.viewContextId !== undefined &&
        options.viewContextId === session.activeViewContextId
      ) {
        session.metadata = { ...session.metadata, stats: response.stats };
        if (this.isLiveSession(session)) this.setActive(session.publicId);
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "error" && response.sessionId) {
      return { ...response, sessionId: session.publicId };
    }
    return response;
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

  private async persistSession(session: CoordinatedSession): Promise<void> {
    const state = persistedSessionState(session.metadata, gridState(session.viewState), session.draftBaseFilterModel);
    await this.persistence.save(session.openRequest.source, state);
  }

  private async persistCurrentPage(
    session: CoordinatedSession,
    metadata: SessionMetadata,
    viewState: PersistedViewingState,
    isCurrent: () => boolean,
    commit: () => void
  ): Promise<boolean> {
    const state = persistedSessionState(metadata, gridState(viewState), session.draftBaseFilterModel);
    return this.persistence.commitCurrent(session.openRequest.source, state, isCurrent, commit);
  }

  private replay(session: CoordinatedSession, options?: BridgeRequestOptions): Promise<boolean> {
    return this.serializeSessionEstablishment(session.delegate, () => this.replayExclusive(session, options));
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
      return this.replayExclusive(session, options, true, requiredSchema, isStillCurrent, onRestoredPage);
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

  private async replayExclusive(
    session: CoordinatedSession,
    options?: BridgeRequestOptions,
    publishActive = true,
    requiredSchema?: readonly ColumnSchema[],
    isStillCurrent?: () => boolean,
    onRestoredPage?: (page: PageResponse) => void
  ): Promise<boolean> {
    if (!this.isLiveSession(session) || session.closing) return false;
    if (isStillCurrent && !isStillCurrent()) return false;
    if (session.origin && sessionOriginMismatch(session.openRequest, session.origin)) return false;
    const persisted = persistedSessionState(
      session.metadata,
      gridState(session.viewState),
      session.draftBaseFilterModel
    );
    const previous: RuntimeSessionState = {
      publicId: session.publicId,
      runtimeId: session.runtimeId,
      runtimeRevision: session.runtimeRevision,
      delegate: session.delegate,
      metadata: session.metadata,
      code: session.code,
      draftBaseFilterModel: session.draftBaseFilterModel,
      viewState: session.viewState
    };
    let candidate: RuntimeSessionState | undefined;
    let restoredPage: PageResponse | undefined;
    try {
      const response = await session.delegate.request(session.openRequest, options);
      if (isStillCurrent && !isStillCurrent()) throw new Error("The recovery request was superseded.");
      if (response.kind !== "sessionOpened") return false;
      candidate = {
        publicId: session.publicId,
        runtimeId: response.metadata.sessionId,
        runtimeRevision: response.metadata.revision,
        delegate: session.delegate,
        metadata: response.metadata,
        code: "",
        viewState: initialViewingState(response.metadata)
      };
      if (session.origin && sessionOriginMismatch(session.openRequest, session.origin)) {
        throw new Error("The originating source changed while recovery was opening its runtime session.");
      }
      const openedMismatch = sessionOpenedResponseMismatch(session.openRequest, response, true);
      if (openedMismatch) throw new Error(openedMismatch);
      if (requiredSchema && !isDeepStrictEqual(response.metadata.schema, requiredSchema)) {
        throw new Error("The recreated live dataframe schema no longer matches the confirmed Open Wrangler view.");
      }
      restoredPage = await this.runtimeStateRestorer.restoreRuntimeState(
        candidate,
        persisted,
        session.metadata.backend === "pyspark" ? session.openRequest.pageSize : 1,
        session.openRequest.columnOffset,
        session.openRequest.columnLimit,
        recoveryFollowupOptions(options),
        requiredSchema !== undefined
      );
      if (isStillCurrent && !isStillCurrent()) throw new Error("The recovery request was superseded.");
      if (session.origin && sessionOriginMismatch(session.openRequest, session.origin)) {
        throw new Error("The originating source changed while recovery was restoring its runtime session.");
      }
    } catch {
      if (candidate) await this.runtimeCleanup.close(candidate, "recovery candidate");
      return false;
    }

    if (!this.isLiveSession(session) || session.closing || (isStillCurrent && !isStillCurrent())) {
      await this.runtimeCleanup.close(candidate, "recovery candidate");
      return false;
    }

    // Grid-only presentation updates are intentionally not serialized through
    // the runtime request queue. Preserve the latest user scroll, widths, and
    // selection rather than overwriting them with the pre-recovery snapshot.
    const latestGridPresentation = gridState(session.viewState);
    const restoredPySparkViewportWasBound =
      candidate.metadata.backend === "pyspark" &&
      persisted.view !== undefined &&
      !isDeepStrictEqual(candidate.viewState.viewport, persisted.view.viewport);
    session.runtimeId = candidate.runtimeId;
    session.runtimeRevision = candidate.runtimeRevision;
    session.metadata = candidate.metadata;
    session.code = candidate.code;
    session.draftPresentation = candidate.draftPresentation;
    session.draftBaseFilterModel = candidate.draftBaseFilterModel;
    session.viewState = reconcileViewingState(
      {
        ...latestGridPresentation,
        ...(restoredPySparkViewportWasBound ? { viewport: candidate.viewState.viewport } : {}),
        filterModel: candidate.metadata.filterModel
      },
      candidate.metadata
    );
    this.clearPublishedStepInspection(session);
    if (publishActive && this.activeSessionId === session.publicId)
      this.activeSessionEmitter.fire(activeSnapshot(session));
    if (restoredPage) onRestoredPage?.(restoredPage);
    this.runtimeCleanup.track(previous, "retired runtime");
    return true;
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

function replacementOpenRequest(
  session: CoordinatedSession,
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

function confirmedReplayOpenRequest(
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

function reconfigurationCancelled(sessionId: string): OpenWranglerResponse {
  return {
    kind: "cancelled",
    targetRequestId: `reconfigure-import:${sessionId}`
  };
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

function isRuntimeStateMutation(request: SessionBoundRequest): boolean {
  return (
    request.kind === "previewStep" ||
    request.kind === "applyDraft" ||
    request.kind === "discardDraft" ||
    request.kind === "undoStep"
  );
}

function sameFilterModel(left: FilterModel, right: FilterModel): boolean {
  return isDeepStrictEqual(normalizeFilterModel(left), normalizeFilterModel(right));
}

function isCurrentLogicalView(session: CoordinatedSession, options?: BridgeRequestOptions): boolean {
  return (
    options?.viewContextId === undefined ||
    (options.viewContextId === session.activeViewContextId &&
      options.viewContextId === session.latestRequestedViewContextId)
  );
}

function withoutDatasetStats(metadata: SessionMetadata): SessionMetadata {
  const { stats: _stats, ...withoutStats } = metadata;
  return withoutStats;
}

function runtimeRecoveryOptions(): BridgeRequestOptions {
  return { priority: "interactive" };
}

function automaticRecoveryOptions(
  options?: BridgeRequestOptions,
  requiredKernelSessionId?: string
): BridgeRequestOptions {
  return { ...options, priority: "interactive", ...(requiredKernelSessionId ? { requiredKernelSessionId } : {}) };
}

function recoveryFollowupOptions(options?: BridgeRequestOptions): BridgeRequestOptions | undefined {
  if (!options?.requiredKernelSessionId) return options;
  const { requiredKernelSessionId: _requiredKernelSessionId, ...followup } = options;
  return followup;
}

function normalizeFilterModel(model: FilterModel): unknown {
  return {
    logic: model.logic ?? "and",
    filters: model.filters.map((filter) => ({ ...filter, logic: filter.logic ?? "and" })),
    sort: model.sort
  };
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

function publicMetadata(
  metadata: SessionMetadata,
  publicId: string,
  publicRevision: number,
  immutableSource: SessionSource
): SessionMetadata {
  return {
    ...metadata,
    source: immutableSource,
    sessionId: publicId,
    revision: publicRevision
  };
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

function stepInspectionKey(request: Extract<SessionBoundRequest, { kind: "inspectStep" }>): string {
  return `${request.revision}:${request.stepId}:${request.offset}:${request.limit}:${request.columnOffset}:${request.columnLimit}`;
}

function publicOpenedResponse(
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

function protocolError(
  code: string,
  message: string,
  recoverable: boolean,
  sessionId?: string,
  viewRequestId?: string
): ErrorResponse {
  return {
    kind: "error",
    code,
    message,
    recoverable,
    ...(sessionId ? { sessionId } : {}),
    ...(viewRequestId ? { viewRequestId } : {})
  };
}
