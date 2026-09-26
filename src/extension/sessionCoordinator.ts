import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type {
  ColumnSchema,
  DataBackend,
  ErrorResponse,
  ExportOptions,
  OpenWranglerRequest,
  OpenWranglerResponse,
  DataExportedResponse,
  OpenSessionRequest,
  PageResponse,
  SessionMetadata,
  SessionMode,
  SessionSource,
  SessionBoundRequest,
  TransformStep
} from "../shared/protocol";
import { isDuckDBTableSource, isRLibrary, isSessionBoundRequest } from "../shared/protocol";
import { sessionModeAction } from "../shared/sessionMode";
import type { GridViewState } from "../shared/viewState";
import {
  type BridgeRequestOptions,
  type FilePlanColumnMappingChooser,
  type FilePlanOpenContext,
  type RLibraryCopyContext,
  type OpenWranglerBridge,
  type SessionPresentation,
  type SessionRuntimeReplacement
} from "./dataBridge";
import { createSecureNonce } from "./secureNonce";
import { isFileDataBackend } from "./pythonEnvironmentModel";
import {
  canReopenLiveSessionInMode,
  captureSessionSourceFiles,
  normalizeSessionOrigin,
  sameFileSourceIdentity,
  sessionOriginMismatch,
  sessionSourceFileUris,
  type BridgeSessionOrigin,
  type CoordinatedSessionOrigin,
  type TextDocumentSessionOrigin
} from "./sessionOrigin";
import { type SessionPersistenceFailure, SessionPersistenceStore } from "./sessionPersistenceStore";
import { persistedSessionState, persistenceKey } from "./sessionPersistence";
import {
  persistenceUnavailableError,
  persistenceReadUnavailableError,
  protocolError,
  publicMetadata,
  SessionResponseCommitter,
  stepInspectionKey
} from "./sessionResponseCommitter";
import { requestViewId } from "./sessionRequestScheduler";
import { SessionRuntimeCleanup } from "./sessionRuntimeCleanup";
import {
  SessionRuntimeEstablisher,
  isRLibraryCopy,
  type RuntimeEstablishedSession,
  type InitialFilePlan,
  type InitialRLibraryCopy,
  type InitialSessionPlan
} from "./sessionRuntimeEstablisher";
import {
  runtimeRecoveryDelegateFactory,
  SessionRuntimeRecovery,
  type RuntimeRecoveryHooks
} from "./sessionRuntimeRecovery";
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
import {
  assertSeparateSessionSource,
  captureExportSourceProtection,
  type ExportSourceProtection,
  type SessionSourceProtection
} from "./files/safeFileExport";

export type { SessionRequestExecutionLane } from "./sessionRequestScheduler";
export type {
  ActiveSessionSnapshot,
  SessionCoordinatorDiagnostics,
  SessionRequestExecutionCheckpoint,
  SessionSchedulerState
} from "./sessionCoordinatorState";

type CoordinatedSession = RuntimeEstablishedSession;

interface RLibraryCopyReservation {
  readonly key: string;
  /** File saved plans are global; live copies stay within their captured bridge family. */
  readonly owner: OpenWranglerBridge | undefined;
}

export type { TextDocumentSessionOrigin } from "./sessionOrigin";

const SHUTDOWN_TIMEOUT_MS = 2_000;

export class SessionCoordinator implements vscode.Disposable {
  private readonly sessions = new Map<string, CoordinatedSession>();
  private readonly pendingOpens = new Map<OpenWranglerBridge, number>();
  private readonly pendingRDependencyRepairs = new Set<vscode.CancellationTokenSource>();
  private readonly pendingRLibraryCopies = new Set<RLibraryCopyReservation>();
  private readonly pendingOpenWaiters = new Set<() => void>();
  private readonly activeSessionEmitter = new vscode.EventEmitter<ActiveSessionSnapshot | undefined>();
  private readonly runtimeReplacementEmitter = new vscode.EventEmitter<{
    owner: OpenWranglerBridge;
    replacement: SessionRuntimeReplacement;
  }>();
  private activeSessionId: string | undefined;
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

  createBridge(
    delegate: OpenWranglerBridge,
    origin?: BridgeSessionOrigin,
    sourceProtection?: Promise<SessionSourceProtection>,
    initialPlan?: InitialSessionPlan
  ): OpenWranglerBridge {
    const confirmedOrigin = normalizeSessionOrigin(origin);
    sourceProtection ??= confirmedOrigin?.kind === "textDocument" ? confirmedOrigin.sourceProtection : undefined;
    return {
      request: async (request, options) => {
        const response = await this.request(delegate, request, options, confirmedOrigin, sourceProtection, initialPlan);
        if (request.kind === "openSession" && response.kind === "sessionOpened") initialPlan = undefined;
        return response;
      },
      captureActiveFilePlan: (chooseColumnMapping) => this.captureActiveFilePlan(chooseColumnMapping),
      captureRLibraryCopy: (sessionId, revision) => this.captureRLibraryCopy(delegate, sessionId, revision),
      prepareFileAutoFallback: (source, options) =>
        delegate.prepareFileAutoFallback?.(source, options) ?? Promise.resolve(undefined),
      discoverDuckDBTables: (source, options) =>
        delegate.discoverDuckDBTables?.(source, options) ?? Promise.resolve(undefined),
      installFileDependencies: (source, backend, options) => {
        if (source.kind !== "file" || backend !== "r")
          return delegate.installFileDependencies?.(source, backend, options) ?? Promise.resolve(false);
        const captured = delegate;
        return this.installRFileDependencies(
          captured,
          source,
          options,
          () => delegate === captured,
          (replacement) => {
            if (delegate !== captured) return false;
            delegate = replacement;
            return true;
          }
        );
      },
      onDidReplaceRuntime: (listener) =>
        this.runtimeReplacementEmitter.event(({ owner, replacement }) => {
          if (owner === delegate) listener(replacement);
        }),
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
      getPagePublication: (sessionId) => this.pagePublication(sessionId),
      getViewState: (sessionId) => this.gridViewState(sessionId),
      getSessionPresentation: (sessionId) => this.sessionPresentation(sessionId),
      keepCopiedPlan: (sessionId) => this.keepCopiedPlan(delegate, sessionId),
      updateViewState: (sessionId, state) => this.updateGridViewState(sessionId, state),
      clearStepInspection: (sessionId) => this.clearStepInspection(sessionId),
      setActiveSession: (sessionId) => this.setActive(sessionId),
      reportDiagnostic: (message) => this.reportDiagnostic(delegate, message)
    };
  }

  private captureActiveFilePlan(
    chooseColumnMapping: FilePlanColumnMappingChooser
  ): FilePlanOpenContext | ErrorResponse {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (
      !session ||
      !this.isLiveSession(session) ||
      session.openRequest.source.kind !== "file" ||
      (!isFileDataBackend(session.metadata.backend) && session.metadata.backend !== "r") ||
      session.metadata.mode !== "editing" ||
      !session.metadata.capabilities.editable ||
      session.metadata.steps.length === 0 ||
      session.metadata.draftStep ||
      session.metadata.steps.some((step) => step.kind === "customCode") ||
      !session.sourceSchema
    )
      return protocolError(
        "file_plan_unavailable",
        "Open a file with confirmed built-in cleaning steps and no draft before reusing its plan. Custom Code and notebook plans are not supported.",
        true
      );
    if (session.copiedPlanPending)
      return protocolError("file_plan_unavailable", "Keep the copied plan before using it on another file.", true);
    if (!vscode.workspace.isTrusted)
      return protocolError("workspace_untrusted", "Trust this workspace before reusing a cleaning plan.", true);
    const names = session.sourceSchema.map((column) => column.name);
    if (names.some((name) => name.length === 0) || new Set(names).size !== names.length)
      return protocolError(
        "file_plan_ambiguous_schema",
        "Plan reuse requires unique, non-empty source column names.",
        true
      );
    const { delegate, runtimeId, runtimeRevision, publicRevision, openRequest, sourceSchema } = session;
    const ready = (): boolean => {
      const state = session.scheduler.snapshot();
      return (
        !session.closing &&
        !session.reconfiguring &&
        !session.reconnecting &&
        !session.recoveryRequired &&
        !session.runtimeSettlementBarrier &&
        !session.liveReconnectRequired &&
        !state.activeForegroundOperation &&
        state.interactiveQueueLength === 0 &&
        !state.terminalOperation
      );
    };
    if (!ready())
      return protocolError(
        "file_plan_busy",
        "Wait for the current file operation to finish, then reuse its plan.",
        true
      );
    const runtimeIsCurrent = delegate.captureFileSessionOwner?.(runtimeId);
    if (!runtimeIsCurrent?.())
      return protocolError(
        "file_plan_runtime_unavailable",
        "The runtime that supplied this plan is no longer available. Reopen the original file before reusing its plan.",
        true
      );
    const backend = session.metadata.backend;
    let target: SessionSource | undefined;
    const plan: InitialFilePlan = {
      backend,
      ...(backend === "r" ? { rLibrary: session.metadata.rLibrary } : {}),
      importOptions: structuredClone(openRequest.source.importOptions),
      sourceSchema: structuredClone(sourceSchema),
      steps: structuredClone(session.metadata.steps),
      chooseColumnMapping,
      isCurrent: () =>
        vscode.workspace.isTrusted &&
        this.isLiveSession(session) &&
        runtimeIsCurrent() &&
        ready() &&
        session.delegate === delegate &&
        session.runtimeId === runtimeId &&
        session.runtimeRevision === runtimeRevision &&
        session.publicRevision === publicRevision &&
        session.openRequest === openRequest &&
        session.sourceSchema === sourceSchema,
      assertTargetAvailable: async (source, protection) => {
        if (target && !isDeepStrictEqual(target, source)) throw new Error("The selected target changed.");
        target ??= structuredClone(source);
        for (const other of this.sessions.values()) {
          if (other.openRequest.source.kind !== "file") continue;
          const otherProtection = await captureExportSourceProtection(
            sessionSourceFileUris(other.openRequest.source),
            other.sourceProtection
          );
          assertSeparateSessionSource(protection, otherProtection);
        }
      }
    };
    return {
      backend,
      ...(backend === "r" ? { rLibrary: plan.rLibrary } : {}),
      importOptions: structuredClone(plan.importOptions),
      isCurrent: plan.isCurrent,
      createBridge: (targetDelegate) => {
        if (!plan.isCurrent()) throw new Error("The session that supplied this plan changed. Capture its plan again.");
        if (backend === "r" ? !targetDelegate || targetDelegate === delegate : targetDelegate !== undefined)
          throw new Error("The copied plan requires its own matching target runtime.");
        return this.createBridge(targetDelegate ?? delegate, undefined, undefined, plan);
      }
    };
  }

  private captureRLibraryCopy(
    owner: OpenWranglerBridge,
    sessionId: string,
    revision: number
  ): RLibraryCopyContext | ErrorResponse {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      this.sessionOwnerDelegates.get(session) !== owner ||
      session.metadata.backend !== "r" ||
      !isRLibrary(session.metadata.rLibrary) ||
      session.publicRevision !== revision
    )
      return protocolError(
        "r_library_copy_unavailable",
        "Reopen the R library picker from the current dataframe.",
        true,
        sessionId
      );
    if (session.copiedPlanPending) return copiedPlanPendingError(session.publicId);
    const { delegate, runtimeId, runtimeRevision, publicRevision, openRequest, origin, sourceProtection } = session;
    const currentLibrary = session.metadata.rLibrary;
    const runtimeIsCurrent = delegate.captureSessionOwner?.(runtimeId);
    const current = (): boolean => {
      const scheduler = session.scheduler.snapshot();
      return (
        vscode.workspace.isTrusted &&
        this.isLiveSession(session) &&
        !session.closing &&
        !session.reconfiguring &&
        !session.reconnecting &&
        !session.recoveryRequired &&
        !session.runtimeSettlementBarrier &&
        !session.liveReconnectRequired &&
        !session.scheduler.hasPendingRequest(isRuntimeStateMutation) &&
        !scheduler.terminalOperation &&
        runtimeIsCurrent?.() === true &&
        session.delegate === delegate &&
        session.runtimeId === runtimeId &&
        session.runtimeRevision === runtimeRevision &&
        session.publicRevision === publicRevision &&
        session.openRequest === openRequest &&
        sessionOriginMismatch(openRequest, origin) === undefined
      );
    };
    const scheduler = session.scheduler.snapshot();
    if (!current() || scheduler.activeForegroundOperation || scheduler.interactiveQueueLength > 0)
      return protocolError(
        "r_library_copy_unavailable",
        "Wait for the current R operation to finish, then open the library picker again.",
        true,
        sessionId
      );
    const source = structuredClone(openRequest.source);
    const steps = structuredClone(session.metadata.steps);
    return {
      source,
      rLibrary: currentLibrary,
      appliedStepCount: steps.length,
      rerunsCustomCode: steps.some((step) => step.kind === "customCode"),
      isCurrent: current,
      createBridge: (rLibrary) => {
        if (!isRLibrary(rLibrary) || rLibrary === currentLibrary || !current())
          throw new Error("The R library choice or original session changed. Open the library picker again.");
        const targetKey = persistenceKey(source, "r", rLibrary);
        const plan: InitialRLibraryCopy = {
          kind: "rLibraryCopy",
          backend: "r",
          rLibrary,
          source,
          cloneFrom: { sessionId: runtimeId, revision: runtimeRevision },
          steps,
          isCurrent: current,
          assertTargetAvailable: async (target) => {
            if (!isDeepStrictEqual(source, target)) throw new Error("The R copy source changed.");
            for (const other of this.sessions.values()) {
              if (
                other.metadata.backend === "r" &&
                (source.kind === "file" || other.delegate === delegate) &&
                persistenceKey(other.openRequest.source, "r", other.metadata.rLibrary) === targetKey
              )
                throw new Error(
                  "An editor already owns this source with the selected R library. Use that editor instead."
                );
            }
          }
        };
        return this.createBridge(
          delegate,
          origin?.kind === "notebook" ? origin.document : origin,
          sourceProtection ? Promise.resolve(sourceProtection) : undefined,
          plan
        );
      }
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

  private pagePublication(sessionId: string): PageResponse | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.reconfiguring || !session.committedPage) return undefined;
    return {
      kind: "page",
      ...session.committedPage,
      revision: session.publicRevision,
      metadata: publicMetadata(session.metadata, session.publicId, session.publicRevision, session.openRequest.source)
    };
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
      ...(session.draftPresentation ? { draft: session.draftPresentation } : {}),
      ...(session.copiedPlanPending ? { copiedPlanPending: true as const } : {})
    };
  }

  private async keepCopiedPlan(delegate: OpenWranglerBridge, sessionId: string): Promise<ErrorResponse | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session || this.sessionOwnerDelegates.get(session) !== delegate)
      return protocolError("unknown_session", `Unknown Open Wrangler session: ${sessionId}`, true);
    if (!session.copiedPlanPending) return undefined;
    if (!vscode.workspace.isTrusted)
      return protocolError(
        "workspace_untrusted",
        "Trust this workspace before keeping a copied plan.",
        true,
        sessionId
      );
    const { runtimeId, publicRevision, openRequest } = session;
    const isCurrent = (): boolean =>
      this.isLiveSession(session) &&
      !session.closing &&
      !session.reconfiguring &&
      !session.recoveryRequired &&
      session.copiedPlanPending === true &&
      session.runtimeId === runtimeId &&
      session.publicRevision === publicRevision &&
      session.openRequest === openRequest;
    if (!isCurrent())
      return protocolError(
        "copied_plan_busy",
        "Wait for the copied plan to finish updating, then keep it.",
        true,
        sessionId
      );
    const saved = await this.persistence.commitRuntimeReplacement(
      openRequest.source,
      persistedSessionState(session.metadata, gridState(session.viewState)),
      isCurrent,
      () => {
        session.copiedPlanPending = false;
        return () => {
          if (!this.isLiveSession(session) || session.runtimeId !== runtimeId) return false;
          session.copiedPlanPending = true;
          return true;
        };
      },
      { requireAbsent: true }
    );
    if (saved.kind === "committed") {
      if (this.activeSessionId === session.publicId) this.activeSessionEmitter.fire(activeSessionSnapshot(session));
      return undefined;
    }
    if (saved.kind === "unavailable")
      return protocolError(
        "persistence_unavailable",
        "Open Wrangler could not save the copied plan. Retry after workspace storage is available.",
        true,
        sessionId
      );
    return isCurrent()
      ? protocolError(
          "file_plan_target_changed",
          `${openRequest.source.label} now has other saved Open Wrangler work, so the copied plan was not saved. Discard this copy to keep that work.`,
          true,
          sessionId
        )
      : protocolError(
          "copied_plan_busy",
          "Wait for the copied plan to finish updating, then keep it.",
          true,
          sessionId
        );
  }

  private async updateGridViewState(sessionId: string, state: GridViewState): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.reconfiguring) return;
    const next = reconcileViewingState({ ...state, filterModel: session.metadata.filterModel }, session.metadata);
    if (isDeepStrictEqual(next, session.viewState)) return;
    const selectedColumnChanged = next.selectedColumnId !== session.viewState.selectedColumnId;
    session.viewState = next;
    const isCurrent = () => this.isLiveSession(session) && !session.closing && !session.reconfiguring;
    if (!session.copiedPlanPending) {
      const persistenceResult = await this.responseCommitter.persistSession(session, isCurrent);
      if (persistenceResult.kind === "stale" || !isCurrent()) return;
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
    options: ExportOptions,
    sourceProtection?: ExportSourceProtection
  ): Promise<DataExportedResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("The dataframe that started this export is no longer open.");
    if (session.metadata.backend === "pandas" && options.rowAxisPolicy === undefined) {
      throw new Error("Pandas export requires an explicit preserve-or-omit index choice.");
    }
    if (session.metadata.backend !== "pandas" && options.rowAxisPolicy !== undefined) {
      throw new Error(`The ${session.metadata.backend} backend does not accept a Pandas row-axis policy.`);
    }
    const response = await this.request(
      session.delegate,
      {
        kind: "exportData",
        sessionId: session.publicId,
        revision,
        path,
        options
      },
      sourceProtection ? { sourceProtection } : undefined
    );
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
    origin?: CoordinatedSessionOrigin,
    sourceProtection?: Promise<SessionSourceProtection>,
    initialPlan?: InitialSessionPlan
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
      return this.open(delegate, request, options, origin, sourceProtection, initialPlan);
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
    if (session.copiedPlanPending && isRuntimeStateMutation(request))
      return copiedPlanPendingError(session.publicId, requestViewId(request));
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
    if (request.kind === "exportData" && !options?.sourceProtection) {
      try {
        options = {
          ...options,
          sourceProtection: await captureExportSourceProtection(
            sessionSourceFileUris(session.openRequest.source),
            session.sourceProtection
          )
        };
      } catch (error) {
        return protocolError(
          "source_protection_unavailable",
          error instanceof Error ? error.message : String(error),
          true,
          session.publicId
        );
      }
      if (!this.isLiveSession(session) || session.closing)
        return protocolError(
          "unknown_session",
          "The dataframe that started this export is no longer open.",
          true,
          session.publicId
        );
    }
    return session.scheduler.enqueue(request, options);
  }

  private async open(
    delegate: OpenWranglerBridge,
    request: OpenSessionRequest,
    options?: BridgeRequestOptions,
    origin?: CoordinatedSessionOrigin,
    sourceProtection?: Promise<SessionSourceProtection>,
    initialPlan?: InitialSessionPlan
  ): Promise<OpenWranglerResponse> {
    const copy = isRLibraryCopy(initialPlan) ? initialPlan : undefined;
    const copyOwner = request.source.kind === "file" ? undefined : delegate;
    let copyToken: RLibraryCopyReservation | undefined;
    if (copy) {
      if (
        request.backend !== "r" ||
        request.rLibrary !== copy.rLibrary ||
        request.mode !== "editing" ||
        !isDeepStrictEqual(request.source, copy.source) ||
        !copy.isCurrent()
      )
        return protocolError(
          "r_library_copy_changed",
          "The original R source or library choice changed. Open the library picker again.",
          true
        );
      const copyKey = persistenceKey(copy.source, "r", copy.rLibrary);
      if (
        [...this.pendingRLibraryCopies].some(
          (reservation) => reservation.key === copyKey && reservation.owner === copyOwner
        ) ||
        [...this.sessions.values()].some(
          (session) =>
            session.metadata.backend === "r" &&
            (copy.source.kind === "file" || session.delegate === delegate) &&
            persistenceKey(session.openRequest.source, "r", session.metadata.rLibrary) === copyKey
        )
      )
        return protocolError(
          "r_library_target_occupied",
          "An editor already owns or is opening this source with the selected R library. Use that editor instead.",
          true
        );
      if (copy.source.kind === "file") {
        const absent = this.persistence.checkAbsent(copy.source, "r", copy.rLibrary);
        if (absent.kind !== "absent")
          return protocolError(
            absent.kind === "occupied" ? "r_library_target_occupied" : "persistence_unavailable",
            absent.kind === "occupied"
              ? "This file already has saved work with the selected R library. Choose that library again, then select Open file separately."
              : "Open Wrangler could not read workspace storage. Retry after storage is available.",
            true
          );
      }
      copyToken = { key: copyKey, owner: copyOwner };
      this.pendingRLibraryCopies.add(copyToken);
      request = { ...request, requestedSessionId: randomUUID(), cloneFrom: copy.cloneFrom };
    }
    const copyTargetFailure = (metadata?: SessionMetadata): OpenWranglerResponse | undefined => {
      if ((metadata?.backend ?? request.backend) !== "r") return undefined;
      const key = persistenceKey(request.source, "r", metadata?.rLibrary ?? request.rLibrary);
      const reserved = [...this.pendingRLibraryCopies].find(
        (reservation) => reservation.key === key && reservation.owner === copyOwner
      );
      if ((reserved && reserved !== copyToken) || (copyToken && reserved !== copyToken))
        return protocolError(
          "r_library_target_occupied",
          "An editing copy owns this source and R library while it opens. Wait for it to finish, then use its editor.",
          true
        );
      return undefined;
    };
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
      const retainedSource = await (options?.requiredSourceProtection ??
        sourceProtection ??
        captureSessionSourceFiles(request.source));
      return await this.serializeSessionEstablishment(delegate, () =>
        this.openTracked(delegate, request, options, origin, retainedSource, initialPlan, copyTargetFailure)
      );
    } finally {
      if (copyToken) this.pendingRLibraryCopies.delete(copyToken);
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
    origin?: CoordinatedSessionOrigin,
    sourceProtection?: SessionSourceProtection,
    initialPlan?: InitialSessionPlan,
    copyTargetFailure?: (metadata?: SessionMetadata) => OpenWranglerResponse | undefined
  ): Promise<OpenWranglerResponse> {
    const provisionalOwner = `opening:${++this.persistenceOwnerOrdinal}`;
    try {
      const attempt = await this.persistence.withOpeningOwner(
        provisionalOwner,
        request.source,
        request.backend,
        () =>
          this.runtimeEstablisher.establish(
            delegate,
            request,
            options,
            origin,
            {
              isCoordinatorAvailable: () => !this.disposed,
              copyTargetFailure,
              executeSessionRequest: (session, scheduledRequest, scheduledOptions) =>
                this.executeSessionRequest(session, scheduledRequest, scheduledOptions)
            },
            sourceProtection,
            initialPlan
          ),
        request.rLibrary
      );
      const result = attempt.value;
      if (attempt.readFailure) {
        if (result.established) {
          await this.runtimeCleanup.close(result.session, "failed saved-state runtime");
          this.runtimeCleanup.releaseIfIdle(result.session.delegate);
        }
        return persistenceReadUnavailableError();
      }
      if (!result.established) return result.response;
      const conflict = copyTargetFailure?.(result.session.metadata);
      if (conflict) {
        await this.runtimeCleanup.close(result.session, "late-open runtime");
        return conflict;
      }
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
    if (session.copiedPlanPending) return copiedPlanPendingError(session.publicId);
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
    if (isDuckDBTableSource(session.openRequest.source) || isDuckDBTableSource(source)) {
      return protocolError(
        "unsupported_import_source",
        "DuckDB tables keep their selected database, table and engine. Close this viewer and use Open DuckDB Table to choose another table.",
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
    if (session.copiedPlanPending) return copiedPlanPendingError(session.publicId);
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
      const query =
        action === "applyDraft" &&
        session.draftBaseView &&
        session.draftBaseView.viewChangeEpoch === session.viewChangeEpoch
          ? session.draftBaseView
          : session.metadata;
      const view = {
        ...session.viewState,
        filterModel: query.filterModel
      };
      const rewriteSettlement = new Promise<void>((resolve) => {
        resolveRewriteSettlement = resolve;
      });
      this.installRuntimeSettlementBarrier(session, rewriteSettlement);
      const response = await this.serializeSessionEstablishment(runtimeDelegate, () =>
        this.runtimeReconfigurer.rewriteCleaningPlan(
          session,
          steps,
          view,
          query.schema,
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
    if (session.copiedPlanPending) return copiedPlanPendingError(session.publicId);
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
      const nextViewState = reconcileViewingState(
        { ...viewState, filterModel: session.metadata.filterModel },
        session.metadata
      );
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

  private setViewContext(sessionId: string, viewContextId: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.reconfiguring) return;
    session.activeViewContextId = viewContextId;
    session.latestRequestedViewContextId = viewContextId;
    if (viewContextId === undefined) {
      session.latestRequestedPageRequestId = undefined;
      session.committedPage = undefined;
    }
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
        replay: (replayOptions, isStillCurrent) => this.replay(session, replayOptions, isStillCurrent),
        replayAfterRuntimeLoss: (failedRuntimeId, replayOptions, requiredSchema, isStillCurrent) =>
          this.replayAfterRuntimeLoss(session, failedRuntimeId, replayOptions, requiredSchema, isStillCurrent),
        close: (closeOptions) => this.closeSession(session, closeOptions),
        responseCallbacks: {
          activate: (registerRollback) => {
            registerRollback?.(() => {
              if (this.isLiveSession(session) && this.activeSessionId === session.publicId) {
                this.activeSessionEmitter.fire(activeSessionSnapshot(session));
              }
              return true;
            });
            if (this.isLiveSession(session) && this.activeSessionId === session.publicId) {
              this.activeSessionEmitter.fire(activeSessionSnapshot(session));
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
    for (const cancellation of this.pendingRDependencyRepairs) cancellation.cancel();
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
    this.runtimeReplacementEmitter.dispose();
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

  private replay(
    session: CoordinatedSession,
    options?: BridgeRequestOptions,
    isStillCurrent?: () => boolean
  ): Promise<boolean> {
    const failedRuntimeId = session.runtimeId;
    const failedDelegate = session.delegate;
    return this.serializeSessionEstablishment(failedDelegate, async () => {
      await this.waitForRuntimeSettlement(session);
      if (!this.isLiveSession(session) || session.closing) return false;
      if (isStillCurrent && !isStillCurrent()) return false;
      if (session.runtimeId !== failedRuntimeId || session.delegate !== failedDelegate || !session.recoveryRequired) {
        return true;
      }
      return this.runtimeRecovery.replay(
        session,
        options,
        this.runtimeRecoveryHooks(session),
        true,
        undefined,
        isStillCurrent
      );
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

  private installRFileDependencies(
    delegate: OpenWranglerBridge,
    source: SessionSource,
    options: BridgeRequestOptions | undefined,
    ownsDelegate: () => boolean,
    replaceDelegate: (replacement: OpenWranglerBridge) => boolean
  ): Promise<boolean | ErrorResponse> {
    const current = (): boolean =>
      !this.disposed &&
      vscode.workspace.isTrusted &&
      !options?.cancellation?.isCancellationRequested &&
      ownsDelegate() &&
      !this.pendingOpens.has(delegate) &&
      ![...this.sessions.values()].some(
        (session) => session.delegate === delegate || this.sessionOwnerDelegates.get(session) === delegate
      );
    const factory = runtimeRecoveryDelegateFactory(delegate);
    if (!factory || !current() || this.runtimeCleanup.isSettling(delegate)) return Promise.resolve(false);
    const cancellation = new vscode.CancellationTokenSource();
    const cancellationSubscription = options?.cancellation?.onCancellationRequested(() => cancellation.cancel());
    this.pendingRDependencyRepairs.add(cancellation);
    const repair = this.serializeSessionEstablishment(delegate, async () => {
      if (!current()) return false;
      const ready = await delegate.installFileDependencies?.(source, "r", {
        ...options,
        cancellation: cancellation.token
      });
      if (!current()) return false;
      if (ready !== true) return ready ?? false;
      const replacement = await factory.createRuntimeRecoveryDelegate();
      let published = false;
      try {
        if (replacement.delegate === delegate)
          throw new Error("Native R dependency repair requires a fresh verified file runtime.");
        if (!current() || !replaceDelegate(replacement.delegate)) return false;
        published = true;
        return true;
      } finally {
        if (!published) await replacement.dispose();
      }
    }).finally(() => {
      this.pendingRDependencyRepairs.delete(cancellation);
      cancellationSubscription?.dispose();
      cancellation.dispose();
    });
    this.runtimeCleanup.trackDelegateSettlement(
      delegate,
      repair.then(() => undefined)
    );
    return repair;
  }

  private runtimeRecoveryHooks(session: CoordinatedSession): RuntimeRecoveryHooks {
    return {
      isCurrent: () => this.isLiveSession(session) && !session.closing,
      originMismatch: (request) => sessionOriginMismatch(request, session.origin),
      installRuntimeSettlement: (settlement) => this.installRuntimeSettlementBarrier(session, settlement),
      clearPublishedStepInspection: () => this.clearPublishedStepInspection(session),
      didReplaceRuntime: () => this.publishRuntimeReplacement(session),
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

  private publishRuntimeReplacement(session: CoordinatedSession): void {
    const runtimeId = session.runtimeId;
    const delegate = session.delegate;
    const owner = this.sessionOwnerDelegates.get(session) ?? delegate;
    const isCurrent = (): boolean =>
      this.isLiveSession(session) &&
      !session.closing &&
      session.runtimeId === runtimeId &&
      session.delegate === delegate;
    const captureView = (expectedPageRequestId?: string | null): (() => boolean) | undefined => {
      if (
        !isCurrent() ||
        session.reconfiguring ||
        session.reconnecting ||
        (expectedPageRequestId !== undefined &&
          (session.latestRequestedPageRequestId ?? null) !== expectedPageRequestId)
      )
        return undefined;
      const revision = session.publicRevision;
      const pageRequestId = session.latestRequestedPageRequestId;
      const viewContextId = session.activeViewContextId;
      const requestedViewContextId = session.latestRequestedViewContextId;
      return () =>
        isCurrent() &&
        !session.reconfiguring &&
        !session.reconnecting &&
        session.publicRevision === revision &&
        session.latestRequestedPageRequestId === pageRequestId &&
        session.activeViewContextId === viewContextId &&
        session.latestRequestedViewContextId === requestedViewContextId;
    };
    this.runtimeReplacementEmitter.fire({
      owner,
      replacement: {
        sessionId: session.publicId,
        isCurrent,
        captureView,
        readPage: async (window) => {
          // The panel calls this outside the originating execution. Waiting
          // here cannot join the request that owns the scheduler's active slot.
          await session.scheduler.waitForIdle();
          const viewIsCurrent = captureView();
          if (!viewIsCurrent) return undefined;
          const response = await this.request(
            owner,
            {
              kind: "getPage",
              sessionId: session.publicId,
              revision: session.publicRevision,
              viewRequestId: `recovery-page:${createSecureNonce()}`,
              offset: session.viewState.viewport.firstVisibleRow,
              ...window,
              filterModel: session.metadata.filterModel
            },
            { ephemeralPage: true, viewContextId: session.activeViewContextId }
          );
          if (!viewIsCurrent()) return undefined;
          if (response.kind !== "page" && response.kind !== "error" && response.kind !== "cancelled") {
            throw new Error("The recovered viewport request did not return a page.");
          }
          return { response, isCurrent: viewIsCurrent };
        }
      }
    });
  }
}

function copiedPlanPendingError(sessionId: string, viewRequestId?: string): ErrorResponse {
  return protocolError(
    "copied_plan_pending",
    "Keep the copied plan before changing it. Nothing is saved for this file until you keep it.",
    true,
    sessionId,
    viewRequestId
  );
}
