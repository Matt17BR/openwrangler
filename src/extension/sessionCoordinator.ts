import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type {
  ColumnSchema,
  DataBackend,
  ExportOptions,
  OpenWranglerRequest,
  OpenWranglerResponse,
  DataExportedResponse,
  OpenSessionRequest,
  PageResponse,
  SessionMode,
  SessionSource,
  SessionBoundRequest,
  TransformStep
} from "../shared/protocol";
import { isSessionBoundRequest } from "../shared/protocol";
import { sessionModeAction } from "../shared/sessionMode";
import type { GridViewState } from "../shared/viewState";
import { type BridgeRequestOptions, type OpenWranglerBridge, type SessionPresentation } from "./dataBridge";
import { isFileDataBackend } from "./pythonEnvironmentModel";
import {
  canReopenLiveSessionInMode,
  normalizeSessionOrigin,
  sameFileSourceIdentity,
  sessionOriginMismatch,
  type BridgeSessionOrigin,
  type CoordinatedSessionOrigin,
  type TextDocumentSessionOrigin
} from "./sessionOrigin";
import { type SessionPersistenceFailure, SessionPersistenceStore } from "./sessionPersistenceStore";
import {
  persistenceUnavailableError,
  persistenceReadUnavailableError,
  protocolError,
  SessionResponseCommitter,
  stepInspectionKey
} from "./sessionResponseCommitter";
import { requestViewId } from "./sessionRequestScheduler";
import { SessionRuntimeCleanup } from "./sessionRuntimeCleanup";
import { SessionRuntimeEstablisher, type RuntimeEstablishedSession } from "./sessionRuntimeEstablisher";
import { SessionRuntimeRecovery, type RuntimeRecoveryHooks } from "./sessionRuntimeRecovery";
import {
  reconfigurationCancelled,
  SessionRuntimeReconfigurer,
  type RuntimeReconfigurationHooks
} from "./sessionRuntimeReconfigurer";
import {
  isRuntimeStateMutation,
  runtimeRecoveryOptions,
  SessionRuntimeRequestExecutor
} from "./sessionRuntimeRequestExecutor";
import { gridState, reconcileViewingState, SessionRuntimeStateRestorer } from "./sessionRuntimeStateRestorer";
import {
  activeSessionSnapshot,
  sessionCoordinatorDiagnostics,
  sessionModeName,
  sessionRequestExecutionCheckpoint,
  sessionSchedulerState,
  type ActiveSessionSnapshot,
  type SessionCoordinatorDiagnostics,
  type SessionRequestExecutionCheckpoint,
  type SessionSchedulerState
} from "./sessionCoordinatorState";

export type { SessionRequestExecutionLane } from "./sessionRequestScheduler";
export type {
  ActiveSessionSnapshot,
  SessionCoordinatorDiagnostics,
  SessionRequestExecutionCheckpoint,
  SessionSchedulerState
} from "./sessionCoordinatorState";

type CoordinatedSession = RuntimeEstablishedSession;

export type { TextDocumentSessionOrigin } from "./sessionOrigin";

const SHUTDOWN_TIMEOUT_MS = 2_000;

export class SessionCoordinator implements vscode.Disposable {
  private readonly sessions = new Map<string, CoordinatedSession>();
  private readonly pendingOpens = new Map<OpenWranglerBridge, number>();
  private readonly pendingOpenWaiters = new Set<() => void>();
  private readonly activeSessionEmitter = new vscode.EventEmitter<ActiveSessionSnapshot | undefined>();
  private activeSessionId: string | undefined;
  private activePublicationGeneration = 0;
  private disposed = false;
  private persistenceOwnerOrdinal = 0;
  private shutdownPromise: Promise<void> | undefined;
  private readonly sessionEstablishmentTails = new WeakMap<OpenWranglerBridge, Promise<void>>();
  private readonly sessionOwnerDelegates = new WeakMap<CoordinatedSession, OpenWranglerBridge>();
  private readonly runtimeCleanup: SessionRuntimeCleanup;
  private readonly persistence: SessionPersistenceStore;
  private readonly runtimeStateRestorer = new SessionRuntimeStateRestorer();
  private readonly runtimeEstablisher: SessionRuntimeEstablisher;
  private readonly responseCommitter: SessionResponseCommitter;
  private readonly runtimeRequestExecutor: SessionRuntimeRequestExecutor;
  private readonly runtimeReconfigurer: SessionRuntimeReconfigurer;
  private readonly runtimeRecovery: SessionRuntimeRecovery;
  private readonly diagnosticSink: ((message: string) => void) | undefined;

  constructor(workspaceState?: vscode.Memento, diagnosticSink?: (message: string) => void) {
    this.diagnosticSink = diagnosticSink;
    this.persistence = new SessionPersistenceStore(workspaceState, (failure) => this.reportPersistenceFailure(failure));
    this.responseCommitter = new SessionResponseCommitter(this.persistence);
    this.runtimeRequestExecutor = new SessionRuntimeRequestExecutor(this.responseCommitter);
    this.runtimeCleanup = new SessionRuntimeCleanup(
      (delegate) =>
        this.pendingOpens.has(delegate) || [...this.sessions.values()].some((session) => session.delegate === delegate),
      diagnosticSink
    );
    this.runtimeEstablisher = new SessionRuntimeEstablisher(
      this.runtimeCleanup,
      this.runtimeStateRestorer,
      this.persistence
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
      reconfigureLiveSessionMode: (sessionId, revision, mode, viewState, options) =>
        this.reconfigureLiveSessionMode(delegate, sessionId, revision, mode, viewState, options),
      rewriteCleaningPlan: (sessionId, revision, stepId, action, page, options) =>
        this.rewriteCleaningPlan(delegate, sessionId, revision, stepId, action, page, options),
      reconnectLiveSession: (sessionId, revision, options) =>
        this.reconnectLiveSession(delegate, sessionId, revision, options),
      cancelViewRequests: (sessionId, viewRequestIds) => this.cancelViewRequests(sessionId, viewRequestIds),
      prioritizeViewRequest: (sessionId, viewRequestId) => this.prioritizeViewRequest(sessionId, viewRequestId),
      setViewContext: (sessionId, viewContextId) => this.setViewContext(sessionId, viewContextId),
      getViewState: (sessionId) => this.gridViewState(sessionId),
      getSessionPresentation: (sessionId) => this.sessionPresentation(sessionId),
      updateViewState: (sessionId, state) => this.updateGridViewState(sessionId, state),
      clearStepInspection: (sessionId) => this.clearStepInspection(sessionId),
      setActiveSession: (sessionId) => this.setActive(sessionId),
      reportDiagnostic: (message) => this.reportDiagnostic(delegate, message)
    };
  }

  private reportDiagnostic(delegate: OpenWranglerBridge, message: string): void {
    try {
      if (delegate.reportDiagnostic) {
        delegate.reportDiagnostic(message);
        return;
      }
    } catch {
      // Fall back to the coordinator's fixed host diagnostic surface.
    }
    try {
      this.diagnosticSink?.(message);
    } catch {
      // Diagnostics must never destabilize the active renderer or session.
    }
  }

  private reportPersistenceFailure(failure: SessionPersistenceFailure): void {
    const operation =
      failure.kind === "read"
        ? "read/availability"
        : failure.kind === "save"
          ? "ordinary save"
          : failure.kind === "rollback"
            ? "rollback"
            : "runtime replacement";
    const detail = failure.cause.code ? `${failure.cause.name} (${failure.cause.code})` : failure.cause.name;
    try {
      this.diagnosticSink?.(`Open Wrangler workspace persistence ${operation} failed: ${detail}`);
    } catch {
      // Diagnostics must never destabilize the active renderer or session.
    }
    if (!failure.firstInEpoch || this.disposed) return;
    try {
      void Promise.resolve(
        vscode.window.showWarningMessage(
          failure.kind === "read"
            ? "Open Wrangler could not read workspace recovery state. Retry after workspace storage is available; recent changes may not survive an editor restart."
            : "Open Wrangler could not save workspace recovery state. The current session remains open, but recent changes may not survive an editor restart."
        )
      ).catch(() => undefined);
    } catch {
      // A failed warning surface must not destabilize the active session.
    }
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
      this.sessionOwnerDelegates.get(session) !== delegate ||
      session.closing ||
      session.reconfiguring ||
      session.metadata.backend !== backend ||
      !sameFileSourceIdentity(session.openRequest.source, source)
    ) {
      return undefined;
    }
    return session.delegate.listExcelSheets?.(
      session.runtimeId,
      session.openRequest.source,
      session.metadata.backend,
      options
    );
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
      this.sessionOwnerDelegates.get(session) !== delegate ||
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
    this.activePublicationGeneration += 1;
    this.activeSessionId = sessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    this.activeSessionEmitter.fire(session ? activeSessionSnapshot(session) : undefined);
  }

  activeSession(): ActiveSessionSnapshot | undefined {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    return session ? activeSessionSnapshot(session) : undefined;
  }

  sessionSnapshot(sessionId: string): ActiveSessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    return session && !session.closing ? activeSessionSnapshot(session) : undefined;
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
    const previous = session.viewState;
    session.viewState = next;
    const persistenceResult = await this.responseCommitter.persistSession(session);
    if (persistenceResult.kind === "unavailable" && session.viewState === next) {
      session.viewState = previous;
      return;
    }
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
      this.activeSessionEmitter.fire(activeSessionSnapshot(session));
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
    return sessionCoordinatorDiagnostics(this.activeSessionId, this.sessions.values());
  }

  testingRequestExecutionCheckpoint(
    sessionId: string,
    requestKind: SessionBoundRequest["kind"],
    viewRequestId: string
  ): SessionRequestExecutionCheckpoint | undefined {
    return sessionRequestExecutionCheckpoint(sessionId, this.sessions.get(sessionId), requestKind, viewRequestId);
  }

  testingSessionSchedulerState(sessionId: string): SessionSchedulerState | undefined {
    return sessionSchedulerState(sessionId, this.sessions.get(sessionId));
  }

  async exportActiveData(path: string, options: ExportOptions): Promise<DataExportedResponse> {
    const snapshot = this.activeSession();
    if (!snapshot) throw new Error("Open a dataframe in Open Wrangler before exporting cleaned data.");
    return this.exportData(snapshot.sessionId, snapshot.metadata.revision, path, options);
  }

  async exportData(
    sessionId: string,
    revision: number,
    path: string,
    options: ExportOptions
  ): Promise<DataExportedResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("The dataframe that started this export is no longer open.");
    if (session.metadata.backend === "pandas" && options.rowAxisPolicy === undefined) {
      throw new Error("Pandas export requires an explicit preserve-or-omit index choice.");
    }
    if (session.metadata.backend !== "pandas" && options.rowAxisPolicy !== undefined) {
      throw new Error(`The ${session.metadata.backend} backend does not accept a Pandas row-axis policy.`);
    }
    const response = await this.request(session.delegate, {
      kind: "exportData",
      sessionId: session.publicId,
      revision,
      path,
      options
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
        this.activeSessionEmitter.fire(activeSessionSnapshot(session));
      }
    } else if (isRuntimeStateMutation(request)) {
      this.clearStepInspection(session.publicId);
    }
    if (request.kind === "getPage" && options?.ephemeralPage !== true) {
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
    const provisionalOwner = `opening:${++this.persistenceOwnerOrdinal}`;
    try {
      const attempt = await this.persistence.withOpeningOwner(provisionalOwner, request.source, request.backend, () =>
        this.runtimeEstablisher.establish(delegate, request, options, origin, {
          isCoordinatorAvailable: () => !this.disposed,
          executeSessionRequest: (session, scheduledRequest, scheduledOptions) =>
            this.executeSessionRequest(session, scheduledRequest, scheduledOptions)
        })
      );
      const result = attempt.value;
      if (attempt.readFailure) {
        if (result.established) await this.runtimeCleanup.close(result.session, "failed saved-state runtime");
        return persistenceReadUnavailableError();
      }
      if (!result.established) return result.response;
      this.responseCommitter.retainSession(result.session);
      this.sessionOwnerDelegates.set(result.session, delegate);
      this.sessions.set(result.session.publicId, result.session);
      this.setActive(result.session.publicId);
      return result.response;
    } finally {
      await this.persistence.releaseOwner(provisionalOwner);
    }
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
    if (!session || this.sessionOwnerDelegates.get(session) !== delegate) {
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
    const runtimeDelegate = session.delegate;
    this.pendingOpens.set(runtimeDelegate, (this.pendingOpens.get(runtimeDelegate) ?? 0) + 1);
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
      const response = await this.serializeSessionEstablishment(runtimeDelegate, () =>
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
        this.activeSessionEmitter.fire(activeSessionSnapshot(session));
      }
      const remaining = (this.pendingOpens.get(runtimeDelegate) ?? 1) - 1;
      if (remaining > 0) this.pendingOpens.set(runtimeDelegate, remaining);
      else this.pendingOpens.delete(runtimeDelegate);
      this.resolvePendingOpenWaitersIfIdle();
      this.runtimeCleanup.releaseIfIdle(runtimeDelegate);
    }
  }

  private async rewriteCleaningPlan(
    delegate: OpenWranglerBridge,
    sessionId: string,
    revision: number,
    stepId: string,
    action: "applyDraft" | "deleteStep",
    page: { offset: number; limit: number; columnOffset: number; columnLimit: number },
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
    if (!session || this.sessionOwnerDelegates.get(session) !== delegate) {
      return protocolError("unknown_session", `Unknown Open Wrangler session: ${sessionId}`, true);
    }
    if (revision !== session.publicRevision) {
      return protocolError(
        "stale_request",
        `The cleaning plan was not changed because the session advanced to revision ${session.publicRevision}.`,
        true,
        session.publicId
      );
    }
    if (session.closing || session.reconfiguring || session.reconnecting) {
      return protocolError(
        session.closing ? "session_closing" : "session_reconfiguring",
        session.closing
          ? `Open Wrangler session ${session.publicId} is already closing.`
          : `Open Wrangler session ${session.publicId} is already changing its runtime state.`,
        true,
        session.publicId
      );
    }
    if (session.metadata.mode !== "editing") {
      return protocolError(
        "editing_mode_required",
        "Cleaning-plan steps can be changed only in Editing mode.",
        true,
        session.publicId
      );
    }
    const matches = session.metadata.steps.flatMap((step, index) => (step.id === stepId ? [index] : []));
    if (matches.length !== 1) {
      return protocolError(
        "invalid_step",
        matches.length === 0 ? `Unknown applied step: ${stepId}` : `Applied step ID is not unique: ${stepId}`,
        true,
        session.publicId
      );
    }
    const stepIndex = matches[0];
    let steps: TransformStep[];
    if (action === "applyDraft") {
      const draft = session.metadata.draftStep;
      if (!draft || session.metadata.draftReplacesStepId !== stepId || draft.id !== stepId) {
        return protocolError(
          "invalid_draft",
          "The selected applied step no longer owns the current replacement draft.",
          true,
          session.publicId
        );
      }
      steps = session.metadata.steps.map((step, index) => (index === stepIndex ? draft : step));
    } else {
      if (session.metadata.draftStep) {
        return protocolError(
          "draft_active",
          "Apply or discard the current draft before deleting a step.",
          true,
          session.publicId
        );
      }
      steps = session.metadata.steps.filter((_step, index) => index !== stepIndex);
    }

    const view = {
      ...session.viewState,
      filterModel:
        action === "applyDraft" &&
        session.draftBaseFilterModel &&
        session.draftBaseViewChangeEpoch === session.viewChangeEpoch
          ? session.draftBaseFilterModel
          : session.metadata.filterModel
    };
    let resolveRewriteSettlement: (() => void) | undefined;
    session.reconfiguring = true;
    session.scheduler.cancelBackground();
    const runtimeDelegate = session.delegate;
    this.pendingOpens.set(runtimeDelegate, (this.pendingOpens.get(runtimeDelegate) ?? 0) + 1);
    let published = false;
    try {
      await session.scheduler.waitForIdle();
      if (!this.isLiveSession(session) || session.closing) {
        return protocolError(
          this.disposed ? "coordinator_disposed" : "session_closing",
          "The session closed before its cleaning plan could be changed.",
          false,
          session.publicId
        );
      }
      if (revision !== session.publicRevision) {
        return protocolError(
          "stale_request",
          `The cleaning plan was not changed because the session advanced to revision ${session.publicRevision}.`,
          true,
          session.publicId
        );
      }
      const rewriteSettlement = new Promise<void>((resolve) => {
        resolveRewriteSettlement = resolve;
      });
      this.installRuntimeSettlementBarrier(session, rewriteSettlement);
      const response = await this.serializeSessionEstablishment(runtimeDelegate, () =>
        this.runtimeReconfigurer.rewriteCleaningPlan(
          session,
          steps,
          view,
          page,
          options,
          this.runtimeReconfigurationHooks(session)
        )
      );
      published = response.kind === "planUpdated";
      return response;
    } finally {
      session.reconfiguring = false;
      if (published && this.isLiveSession(session) && !session.closing && this.activeSessionId === session.publicId) {
        this.activeSessionEmitter.fire(activeSessionSnapshot(session));
      }
      const remaining = (this.pendingOpens.get(runtimeDelegate) ?? 1) - 1;
      if (remaining > 0) this.pendingOpens.set(runtimeDelegate, remaining);
      else this.pendingOpens.delete(runtimeDelegate);
      this.resolvePendingOpenWaitersIfIdle();
      this.runtimeCleanup.releaseIfIdle(runtimeDelegate);
      resolveRewriteSettlement?.();
    }
  }

  private async reconfigureLiveSessionMode(
    delegate: OpenWranglerBridge,
    sessionId: string,
    revision: number,
    mode: SessionMode,
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
    if (!session || this.sessionOwnerDelegates.get(session) !== delegate) {
      return protocolError("unknown_session", `Unknown Open Wrangler session: ${sessionId}`, true);
    }
    if (revision !== session.publicRevision) {
      return protocolError(
        "stale_request",
        `${sessionModeName(mode)} mode was not opened because the session advanced to revision ${session.publicRevision}.`,
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
    if (!canReopenLiveSessionInMode(session, mode)) {
      const action = sessionModeAction(session.metadata);
      return protocolError(
        `${mode}_mode_unavailable`,
        action?.target === mode && action.disabledReason
          ? action.disabledReason
          : `This session cannot be reopened in ${sessionModeName(mode)} mode.`,
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
    session.reconfiguring = true;
    session.scheduler.cancelBackground();
    const runtimeDelegate = session.delegate;
    this.pendingOpens.set(runtimeDelegate, (this.pendingOpens.get(runtimeDelegate) ?? 0) + 1);
    let replacementPublished = false;
    try {
      await session.scheduler.waitForIdle();
      if (!this.isLiveSession(session) || session.closing) {
        return protocolError(
          this.disposed ? "coordinator_disposed" : "session_closing",
          this.disposed
            ? `The Open Wrangler session coordinator was disposed while ${sessionModeName(mode)} mode was opening.`
            : `Open Wrangler session ${session.publicId} closed while ${sessionModeName(mode)} mode was opening.`,
          false,
          session.publicId
        );
      }
      if (revision !== session.publicRevision) {
        return protocolError(
          "stale_request",
          `${sessionModeName(mode)} mode was not opened because the session advanced to revision ${session.publicRevision}.`,
          true,
          session.publicId
        );
      }
      const originMismatch = sessionOriginMismatch(session.openRequest, session.origin);
      if (originMismatch) return protocolError("invalid_source_origin", originMismatch, true, session.publicId);
      const response = await this.serializeSessionEstablishment(runtimeDelegate, () =>
        this.runtimeReconfigurer.reopenLiveSessionInMode(
          session,
          mode,
          nextViewState,
          options,
          this.runtimeReconfigurationHooks(session)
        )
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
        this.activeSessionEmitter.fire(activeSessionSnapshot(session));
      }
      const remaining = (this.pendingOpens.get(runtimeDelegate) ?? 1) - 1;
      if (remaining > 0) this.pendingOpens.set(runtimeDelegate, remaining);
      else this.pendingOpens.delete(runtimeDelegate);
      this.resolvePendingOpenWaitersIfIdle();
      this.runtimeCleanup.releaseIfIdle(runtimeDelegate);
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

  private async executeSessionRequest(
    session: CoordinatedSession,
    publicRequest: SessionBoundRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    if (isRuntimeStateMutation(publicRequest)) {
      const staged = await this.responseCommitter.stageMutation(session);
      if (staged.kind === "unavailable") {
        return persistenceUnavailableError(session.publicId, requestViewId(publicRequest));
      }
    }
    try {
      const response = await this.runtimeRequestExecutor.execute(session, publicRequest, options, {
        isCoordinatorAvailable: () => !this.disposed,
        waitForRuntimeSettlement: () => this.waitForRuntimeSettlement(session),
        installRuntimeSettlement: (settlement) => this.installRuntimeSettlementBarrier(session, settlement),
        replay: (replayOptions) => this.replay(session, replayOptions),
        replayAfterRuntimeLoss: (failedRuntimeId, replayOptions, requiredSchema, isStillCurrent) =>
          this.replayAfterRuntimeLoss(session, failedRuntimeId, replayOptions, requiredSchema, isStillCurrent),
        close: (closeOptions) => this.closeSession(session, closeOptions),
        responseCallbacks: {
          activate: (registerRollback) => {
            if (this.isLiveSession(session)) {
              const rollback = registerRollback ? this.captureActivePublicationRollback(session) : undefined;
              if (rollback && registerRollback) {
                const generation = this.activePublicationGeneration + 1;
                registerRollback(() => rollback(generation));
              }
              this.setActive(session.publicId);
            }
          },
          publishInspection: () => {
            if (this.isLiveSession(session) && this.activeSessionId === session.publicId) {
              this.activeSessionEmitter.fire(activeSessionSnapshot(session));
            }
          }
        }
      });
      const restored = await this.responseCommitter.restoreStagedMutation(session);
      if (restored?.kind === "unavailable") {
        if (response.kind === "error" || response.kind === "cancelled") {
          throw new AggregateError(
            [response, restored.failure],
            "The runtime result and persistence rollback both failed."
          );
        }
        return persistenceUnavailableError(session.publicId, requestViewId(publicRequest));
      }
      return response;
    } catch (error) {
      const restored = await this.responseCommitter.restoreStagedMutation(session);
      if (restored?.kind === "unavailable") {
        throw new AggregateError(
          [error, restored.failure],
          "The runtime request and persistence rollback both failed."
        );
      }
      throw error;
    }
  }

  private async closeSession(
    session: CoordinatedSession,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    await this.waitForRuntimeSettlement(session);
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
    this.responseCommitter.releaseSession(session.publicId);
    if (this.activeSessionId === session.publicId) this.setActive(undefined);
    this.runtimeCleanup.releaseIfIdle(session.delegate);
  }

  private captureActivePublicationRollback(session: CoordinatedSession): (generation: number) => boolean {
    const previousActiveSessionId = this.activeSessionId;
    const previousActiveSession = previousActiveSessionId ? this.sessions.get(previousActiveSessionId) : undefined;
    const inspections = new Map<
      CoordinatedSession,
      Pick<CoordinatedSession, "stepInspection" | "latestStepInspectionKey">
    >();
    const captureInspection = (candidate: CoordinatedSession | undefined): void => {
      if (candidate && !inspections.has(candidate)) {
        inspections.set(candidate, {
          stepInspection: candidate.stepInspection,
          latestStepInspectionKey: candidate.latestStepInspectionKey
        });
      }
    };
    captureInspection(previousActiveSession);
    captureInspection(session);

    return (generation) => {
      if (
        this.activePublicationGeneration !== generation ||
        this.sessions.get(session.publicId) !== session ||
        (previousActiveSessionId !== undefined && this.sessions.get(previousActiveSessionId) !== previousActiveSession)
      ) {
        return false;
      }
      for (const [candidate, inspection] of inspections) {
        candidate.stepInspection = inspection.stepInspection;
        candidate.latestStepInspectionKey = inspection.latestStepInspectionKey;
      }
      this.activePublicationGeneration += 1;
      this.activeSessionId = previousActiveSessionId;
      const active = previousActiveSessionId ? this.sessions.get(previousActiveSessionId) : undefined;
      this.activeSessionEmitter.fire(active ? activeSessionSnapshot(active) : undefined);
      return true;
    };
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
    const settleAfterProducersQuiesce = Promise.allSettled([...closes, this.waitForPendingOpens()]).then(() =>
      this.runtimeCleanup.waitForTracked()
    );
    await Promise.race([
      settleAfterProducersQuiesce,
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

  private replay(session: CoordinatedSession, options?: BridgeRequestOptions): Promise<boolean> {
    const failedRuntimeId = session.runtimeId;
    const failedDelegate = session.delegate;
    return this.serializeSessionEstablishment(failedDelegate, async () => {
      await this.waitForRuntimeSettlement(session);
      if (!this.isLiveSession(session) || session.closing) return false;
      if (session.runtimeId !== failedRuntimeId || session.delegate !== failedDelegate || !session.recoveryRequired) {
        return true;
      }
      return this.runtimeRecovery.replay(session, options, this.runtimeRecoveryHooks(session));
    });
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
      await this.waitForRuntimeSettlement(session);
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
      installRuntimeSettlement: (settlement) => this.installRuntimeSettlementBarrier(session, settlement),
      clearPublishedStepInspection: () => this.clearPublishedStepInspection(session),
      publishActive: () => {
        if (this.activeSessionId === session.publicId) this.activeSessionEmitter.fire(activeSessionSnapshot(session));
      },
      replayAfterRuntimeLoss: (failedRuntimeId, options, requiredSchema, onRestoredPage) =>
        this.replayAfterRuntimeLoss(session, failedRuntimeId, options, requiredSchema, undefined, onRestoredPage)
    };
  }

  private isLiveSession(session: CoordinatedSession): boolean {
    return !this.disposed && this.sessions.get(session.publicId) === session;
  }
}
