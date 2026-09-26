import * as path from "path";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type {
  DataBackend,
  CancelledResponse,
  ErrorResponse,
  OpenWranglerRequest,
  OpenWranglerResponse,
  OperationKind,
  RLibrary,
  SessionMetadata,
  SessionMode,
  SessionOpenedResponse,
  SessionSource,
  TransformStep
} from "../shared/protocol";
import { engineLabel, isDuckDBTableSource, rLibraries, sourceDisplayLabel } from "../shared/protocol";
import {
  isRecoveryViewContextId,
  RECOVERY_VIEW_CONTEXT_PREFIX,
  SNAPSHOT_VIEW_CONTEXT_PREFIX,
  type SessionPresentation,
  type SessionRecoveryContext,
  type SessionRecoveryMessage
} from "../shared/sessionRecovery";
import { canRequestLiveSessionMode, sessionModeAction } from "../shared/sessionMode";
import type { ViewFilterRemovalTarget } from "../shared/filterModel";
import { encodeGridViewState, type GridViewState } from "../shared/viewState";
import type { SessionOpenProgressStage } from "../shared/sessionOpenProgress";
import { operationByKind, stepReplaysOnEngine, type FileEngine } from "../shared/operations";
import type {
  BridgeRequestOptions,
  FileReconfigurationOptions,
  OpenWranglerBridge,
  SavedFileWork,
  SessionRuntimeReplacement
} from "./dataBridge";
import {
  configuredRLibrary,
  getSetting,
  readWebviewBootstrapSettings,
  type WebviewBootstrapSettings
} from "./configuration";
import { rememberConfirmedFileConfiguration } from "./files/confirmedFileConfigurations";
import { ImportCancelledError, promptImportOptions } from "./files/importOptions";
import { dependencyGuardRecoveryGuidance } from "./pythonDependencyState";
import { automaticBackends } from "./pythonEnvironmentModel";
import { supportsRFileExecution } from "./r/rscriptPath";
import {
  RendererSynchronizationCoordinator,
  type ImportActivity,
  type RendererImportPreparation,
  type RendererSynchronizationIdentity
} from "./rendererSynchronizationCoordinator";
import { createSecureNonce } from "./secureNonce";
import { decodeWebviewMessage } from "./webviewMessage";

const PANEL_RUNTIME_CLEANUP_TIMEOUT_MS = 2_000;
const RENDERER_SYNCHRONIZATION_ACK_TIMEOUT_MS = 5_000;
const RETIRED_RENDERER_TEST_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';"></head><body></body></html>';
export const SESSION_BOUND_EXPORT_DATA_COMMAND = "openWrangler.internal.exportSessionData";

interface PendingRuntimeReplacement {
  replacement: SessionRuntimeReplacement;
  rendererGeneration: number;
  context: SessionRecoveryContext;
  error?: ErrorResponse | CancelledResponse;
  refresh?: Promise<void>;
  attemptedContext?: SessionRecoveryContext;
  offer?: { message: SessionRecoveryMessage; snapshot: SessionOpenedResponse; isCurrent(): boolean };
}

interface FailedBackendChange {
  readonly source: SessionSource;
  readonly engine: FileEngine;
  readonly plan: NonNullable<FileReconfigurationOptions["plan"]>;
  readonly sessionId: string;
  readonly revision: number;
  readonly generation: number;
}

/** What switching this tab to one engine would do with its cleaning work. */
interface EngineSwitch {
  readonly engine: FileEngine;
  readonly current: boolean;
  readonly saved: SavedFileWork | undefined;
  /** Applied steps before the first one the engine cannot replay. */
  readonly portableSteps: number;
  /** The first applied step, or the draft, that the engine cannot replay. */
  readonly blocked: TransformStep | undefined;
}

/** Resolves the coordinated bridge that runs a file with an engine. */
export type FileEngineBridgeSelector = (source: SessionSource, engine: FileEngine) => Promise<OpenWranglerBridge>;

export async function restoreEditorGroupAfterQuickPick(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  } catch {
    // Experimental forks may not expose this workbench command. Creating the
    // panel still works with their native Quick Input focus behavior.
  }
}

export class OpenWranglerPanel {
  private static activePanel: OpenWranglerPanel | undefined;
  private static readonly panels = new Set<OpenWranglerPanel>();
  private static fileEngineBridges: FileEngineBridgeSelector | undefined;
  private sessionId: string | undefined;
  private sessionRevision = 0;
  private snapshot: SessionOpenedResponse | undefined;
  private snapshotViewContextId: string | undefined;
  private snapshotOffer: { viewContextId: string; sent: boolean } | undefined;
  private latestPageViewRequestId: string | undefined;
  private opening: Promise<void> | undefined;
  private openResponse: OpenWranglerResponse | undefined;
  private importChangeTail: Promise<void> = Promise.resolve();
  private currentImportChangeTask: Promise<void> | undefined;
  private nativeImportCommand: Promise<boolean> | undefined;
  private runtimeDependencyInstallTask: Promise<void> | undefined;
  private failedBackendChange: FailedBackendChange | undefined;
  private sessionModeChangeTask: Promise<void> | undefined;
  private reconnectingLiveSource = false;
  private importChangeCancellation: vscode.CancellationTokenSource | undefined;
  private sessionOpenCancellation: vscode.CancellationTokenSource | undefined;
  private readonly forwardedRequests = new Map<
    Promise<void>,
    { generation: number | undefined; page?: { sessionId: string; requestId: string } }
  >();
  private pendingRuntimeReplacement: PendingRuntimeReplacement | undefined;
  private changingImportOptions = false;
  private importActivity: ImportActivity | undefined;
  private replacementSubscription: { dispose(): void } | undefined;
  private readonly rendererSync: RendererSynchronizationCoordinator;
  private codePreviewReveal: { sessionId: string; pending: boolean } | undefined;
  private unpublishedAuthoritativeSnapshot = false;
  private openAttemptGeneration = 0;
  private activeSessionOpenProgressGeneration: number | undefined;
  private sessionOpenProgress:
    | {
        generation: number;
        stage: SessionOpenProgressStage;
      }
    | undefined;
  private sessionOpenProgressPublication: Promise<void> = Promise.resolve();
  private closing: Promise<OpenWranglerResponse> | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private bridge: OpenWranglerBridge,
    private source: SessionSource,
    private backend?: DataBackend,
    openImmediately = true,
    private backendPreference: DataBackend | "auto" = backend ?? "auto",
    private readonly initialMode?: SessionMode,
    private rLibrary?: RLibrary
  ) {
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "action-icon-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "action-icon-dark.svg")
    };
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))]
    };
    this.rendererSync = new RendererSynchronizationCoordinator({
      postMessage: (message) => {
        if (
          message &&
          typeof message === "object" &&
          "kind" in message &&
          (message.kind === "sessionOpened" || message.kind === "stepPreview" || message.kind === "planUpdated")
        ) {
          const response = message as Extract<
            OpenWranglerResponse,
            { kind: "sessionOpened" | "stepPreview" | "planUpdated" }
          >;
          const state = this.bridge.getViewState?.(response.metadata.sessionId);
          const viewState = state && encodeGridViewState(state);
          if (state && !viewState) return Promise.resolve(false);
          const publication = { ...response, ...(viewState ? { viewState } : {}) };
          if (response.kind !== "sessionOpened") return this.panel.webview.postMessage(publication);
          const presentation = this.bridge.getSessionPresentation?.(response.metadata.sessionId);
          let rendererPresentation: Omit<SessionPresentation, "code"> | undefined;
          if (
            presentation?.sessionId === response.metadata.sessionId &&
            presentation.revision === response.metadata.revision
          ) {
            const { code: _code, ...rest } = presentation;
            rendererPresentation = rest;
          }
          const offer =
            this.snapshotOffer && !this.snapshotOffer.sent
              ? this.snapshotOffer
              : { viewContextId: `${SNAPSHOT_VIEW_CONTEXT_PREFIX}${createSecureNonce()}`, sent: false };
          this.snapshotOffer = offer;
          offer.sent = true;
          const offeredViewContextId = offer.viewContextId;
          this.latestPageViewRequestId = undefined;
          this.snapshotViewContextId = undefined;
          if (this.sessionId) this.bridge.setViewContext?.(this.sessionId, undefined);
          return this.panel.webview.postMessage({
            ...publication,
            offeredViewContextId,
            ...(rendererPresentation ? { presentation: rendererPresentation } : {})
          });
        }
        return this.panel.webview.postMessage(message);
      },
      replaceRenderer: () => {
        this.panel.webview.html = this.renderHtml();
      },
      isVisible: () => this.panel.visible,
      getSnapshot: () => this.snapshot,
      prepareSnapshot: () => this.prepareSnapshot(),
      getOpenResponse: () => this.openResponse,
      isSnapshotPending: () => this.currentRuntimeReplacement() !== undefined,
      isImportBusy: () => this.changingImportOptions,
      importActivity: () => this.importActivity,
      ensureSessionOpen: () => this.open(),
      clearStepInspection: () => {
        if (this.sessionId) this.bridge.clearStepInspection?.(this.sessionId);
      },
      layoutTransitionPending: () => this.codePreviewLayoutTransitionPending(),
      didSynchronize: (synchronization) => this.revealCodePreviewAfterRendererSynchronization(synchronization),
      didPublishAuthoritativeSnapshot: () => {
        this.unpublishedAuthoritativeSnapshot = false;
        const pending = this.currentRuntimeReplacement();
        if (pending) {
          pending.context = this.recoveryContext(null);
          pending.error = undefined;
          pending.offer = undefined;
          this.scheduleRecoveryRefresh();
        }
      },
      reportDiagnostic: (message) => this.bridge.reportDiagnostic?.(message)
    });
    this.subscribeToRuntimeReplacement();
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      undefined,
      this.disposables
    );
    this.rendererSync.replaceRenderer();
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.onDidChangeViewState(
      ({ webviewPanel }) => {
        if (webviewPanel.active) this.activate();
        else if (!webviewPanel.visible) this.deactivate();
        else this.scheduleRendererStartupRecovery();
      },
      undefined,
      this.disposables
    );
    OpenWranglerPanel.panels.add(this);
    if (this.panel.active) this.activate();
    if (openImmediately) void this.open();
  }

  static sendEditorAction(message: EditorActionMessage): boolean {
    const target =
      "expectedSessionId" in message && typeof message.expectedSessionId === "string"
        ? OpenWranglerPanel.visiblePanelForSession(message.expectedSessionId)
        : OpenWranglerPanel.activePanel;
    if (!target?.panel.visible) return false;
    if (message.action === "openOperation" || message.action === "editLatest") {
      target.panel.reveal(target.panel.viewColumn, false);
    }
    void target.postRendererMessage({ kind: "editorAction", ...message });
    return true;
  }

  static async sendEditorActionForSession(
    message: EditorActionMessage & { expectedSessionId: string; expectedRevision: number }
  ): Promise<boolean> {
    let target = OpenWranglerPanel.visiblePanelForSession(message.expectedSessionId);
    if (
      !target ||
      target.snapshot?.metadata.sessionId !== message.expectedSessionId ||
      target.snapshot.metadata.revision !== message.expectedRevision
    ) {
      return false;
    }
    if (!target.hasHydratedRenderer()) {
      const synchronized = await OpenWranglerPanel.ensurePanelSynchronizedForSession(
        message.expectedSessionId,
        Date.now() + RENDERER_SYNCHRONIZATION_ACK_TIMEOUT_MS
      );
      if (!synchronized) return false;
      target = OpenWranglerPanel.visiblePanelForSession(message.expectedSessionId);
    }
    if (
      !target ||
      !target.hasHydratedRenderer() ||
      target.snapshot?.metadata.sessionId !== message.expectedSessionId ||
      target.snapshot.metadata.revision !== message.expectedRevision
    ) {
      return false;
    }
    if (message.action === "openOperation" || message.action === "editLatest") {
      target.panel.reveal(target.panel.viewColumn, false);
    }
    if (message.action === "openDatasetSummary") target.panel.reveal(target.panel.viewColumn, false);
    return target.postRendererMessage({ kind: "editorAction", ...message });
  }

  private static visiblePanelForSession(sessionId: string): OpenWranglerPanel | undefined {
    const matches = [...OpenWranglerPanel.panels].filter(
      (panel) => !panel.disposed && panel.panel.visible && panel.sessionId === sessionId
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  static retireRendererForSessionForTesting(sessionId: string): boolean {
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS !== "1") return false;
    const target = OpenWranglerPanel.visiblePanelForSession(sessionId);
    if (!target?.hasHydratedRenderer()) return false;
    // Replace only the physical document. Keeping the host's renderer receipt,
    // watchdog, session, and runtime untouched reproduces an editor that
    // silently retires a hydrated webview after accepting a publication.
    target.panel.webview.html = RETIRED_RENDERER_TEST_HTML;
    return true;
  }

  static async disposePanelForSession(sessionId: string): Promise<OpenWranglerResponse | undefined> {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    if (!target) return undefined;
    target.dispose();
    target.panel.dispose();
    return target.closing;
  }

  static async synchronizePanelForSession(sessionId: string): Promise<boolean> {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    if (!target?.rendererSync.rendererReady || target.disposed) return false;
    target.invalidateRendererSynchronization();
    await target.enqueueRendererSynchronization(false);
    const synchronization = target.rendererSync.currentSynchronization;
    if (!synchronization) return false;
    return target.waitForRendererSynchronizationAcknowledgement(synchronization.syncId);
  }

  static async ensurePanelSynchronizedForSession(
    sessionId: string,
    deadlineMs = Number.POSITIVE_INFINITY
  ): Promise<boolean> {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    if (!target?.isRendererSynchronizableForSession(sessionId)) return false;

    const current = target.rendererSync.currentSynchronization;
    if (current?.sessionId === sessionId && current.revision === target.snapshot?.metadata.revision) {
      const acknowledged = await target.waitForRendererSynchronizationAcknowledgement(current.syncId, deadlineMs);
      if (acknowledged && target.rendererSync.currentSynchronization === current && target.hasHydratedRenderer()) {
        return true;
      }
      if (target.hasHydratedRenderer()) return true;
      if (!target.isRendererSynchronizableForSession(sessionId)) return false;
      // A normal renderer pull may have replaced the marker while this
      // readiness-aware test path was waiting. Never retire that newer generation.
      if (target.rendererSync.currentSynchronization !== current) return target.hasHydratedRenderer();
    }

    if (Date.now() >= deadlineMs) return false;
    target.invalidateRendererSynchronization();
    await target.enqueueRendererSynchronization(false);
    const synchronization = target.rendererSync.currentSynchronization;
    if (
      !synchronization ||
      synchronization.sessionId !== sessionId ||
      synchronization.revision !== target.snapshot?.metadata.revision
    ) {
      return false;
    }
    const acknowledged = await target.waitForRendererSynchronizationAcknowledgement(synchronization.syncId, deadlineMs);
    return (
      acknowledged && target.rendererSync.currentSynchronization === synchronization && target.hasHydratedRenderer()
    );
  }

  static panelSynchronizableForSession(sessionId: string): boolean {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    return target?.isRendererSynchronizableForSession(sessionId) ?? false;
  }

  static async previewStepForSessionForTesting(
    request: Extract<OpenWranglerRequest, { kind: "previewStep" }>
  ): Promise<SessionOpenedResponse | undefined> {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === request.sessionId);
    if (!target?.rendererSync.rendererReady || target.disposed) return undefined;
    await target.forward(request);
    return target.snapshot?.metadata.draftStep?.id === request.step.id &&
      target.snapshot.metadata.revision > request.revision
      ? target.snapshot
      : undefined;
  }

  static panelHydratedForSession(sessionId: string): boolean {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    return Boolean(
      target && !target.disposed && !target.opening && target.sessionId === sessionId && target.hasHydratedRenderer()
    );
  }

  static panelSynchronizationReceiptForSession(
    sessionId: string
  ): Readonly<{ syncId: string; sessionId: string; revision: number; layoutTransitionPending: boolean }> | undefined {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    const synchronization = target?.rendererSync.currentSynchronization;
    return target?.hasHydratedRenderer() &&
      synchronization?.sessionId === sessionId &&
      synchronization.revision !== null
      ? {
          syncId: synchronization.syncId,
          sessionId: synchronization.sessionId,
          revision: synchronization.revision,
          layoutTransitionPending: synchronization.layoutTransitionPending
        }
      : undefined;
  }

  static openResponseForTesting(): OpenWranglerResponse | undefined {
    return OpenWranglerPanel.activePanel?.openResponse ?? [...OpenWranglerPanel.panels].at(-1)?.openResponse;
  }

  static observeNextNotebookPanelOpenForTesting(expected: {
    uri: string;
    variableName: string;
  }): () => OpenWranglerResponse | undefined {
    const { uri, variableName } = expected;
    const previousPanels = new WeakSet(OpenWranglerPanel.panels);
    let observed: OpenWranglerPanel | undefined;
    return () => {
      const matches = [...OpenWranglerPanel.panels].filter(
        (panel) =>
          !previousPanels.has(panel) &&
          panel.source.kind === "notebookVariable" &&
          panel.source.uri === uri &&
          panel.source.variableName === variableName
      );
      if (matches.length > 1) {
        throw new Error("More than one new notebook panel matches the observed opening.");
      }
      observed ??= matches[0];
      return observed && matches[0] === observed && !observed.disposed && observed.openAttemptGeneration === 1
        ? observed.openResponse
        : undefined;
    };
  }

  static changeActiveImportOptions(): Promise<boolean> {
    const active = OpenWranglerPanel.activePanel;
    if (!active?.panel.active || !canChangeImportOptions(active.source)) return Promise.resolve(false);
    return active.runNativeImportOptionsCommand();
  }

  static create(
    context: vscode.ExtensionContext,
    bridge: OpenWranglerBridge,
    source: SessionSource,
    backend?: DataBackend,
    backendPreference: DataBackend | "auto" = backend ?? "auto",
    initialMode?: SessionMode,
    rLibrary?: RLibrary
  ): OpenWranglerPanel {
    const panel = vscode.window.createWebviewPanel(
      "openWrangler.session",
      `Open Wrangler: ${sourceDisplayLabel(source)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))]
      }
    );

    return new OpenWranglerPanel(
      panel,
      context,
      bridge,
      source,
      backend,
      true,
      backendPreference,
      initialMode,
      rLibrary
    );
  }

  async open(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.disposed || this.sessionId) return;
    if (this.backend === "r" && this.rLibrary === undefined) {
      this.rLibrary = configuredRLibrary(this.source.uri ? vscode.Uri.parse(this.source.uri) : undefined);
    }
    const { pageSize, columnLimit } = fetchGridBlockSize(this.backend);
    const isFile = this.source.kind === "file" || this.source.kind === "documentVariable";
    const mode =
      this.backend === "pyspark"
        ? "viewing"
        : (this.initialMode ??
          getSetting<"editing" | "viewing">(
            isFile ? "fileStartMode" : "notebookStartMode",
            isFile ? "editing" : "viewing"
          ));
    const generation = ++this.openAttemptGeneration;
    const reportsNotebookOpenProgress = this.source.kind === "notebookVariable";
    if (reportsNotebookOpenProgress) this.activeSessionOpenProgressGeneration = generation;
    const cancellation = new vscode.CancellationTokenSource();
    this.sessionOpenCancellation?.cancel();
    this.sessionOpenCancellation?.dispose();
    this.sessionOpenCancellation = cancellation;
    const opening = this.forward(
      {
        kind: "openSession",
        source: this.source,
        backend: this.backend,
        ...(this.backend === "r" ? { rLibrary: this.rLibrary } : {}),
        pageSize,
        columnOffset: 0,
        columnLimit,
        mode
      },
      undefined,
      {
        // KernelBridge treats this as a host-only detach signal. It never
        // forwards cancellation to Jupyter's executeCode token.
        cancellation: cancellation.token,
        backendPreference: this.backendPreference,
        ...(reportsNotebookOpenProgress
          ? { onOpenProgress: (stage: SessionOpenProgressStage) => this.updateSessionOpenProgress(generation, stage) }
          : {})
      },
      generation
    );
    this.opening = opening;
    try {
      await opening;
    } finally {
      await this.clearSessionOpenProgress(generation);
      if (this.opening === opening) this.opening = undefined;
      if (this.sessionOpenCancellation === cancellation) {
        this.sessionOpenCancellation = undefined;
        cancellation.dispose();
      }
    }
  }

  /** Registers how panels reach each file engine's runtime; the file commands own the bridges. */
  static registerFileEngineBridges(selector: FileEngineBridgeSelector): vscode.Disposable {
    OpenWranglerPanel.fileEngineBridges = selector;
    return {
      dispose: () => {
        if (OpenWranglerPanel.fileEngineBridges === selector) OpenWranglerPanel.fileEngineBridges = undefined;
      }
    };
  }

  private subscribeToRuntimeReplacement(): void {
    this.replacementSubscription?.dispose();
    this.replacementSubscription = this.bridge.onDidReplaceRuntime?.((replacement) => {
      if (this.disposed || this.sessionId !== replacement.sessionId || !replacement.isCurrent()) return;
      this.pendingRuntimeReplacement = {
        replacement,
        rendererGeneration: this.rendererSync.rendererGeneration,
        context: this.recoveryContext(null)
      };
      this.rendererSync.invalidate();
      this.rendererSync.clearStartupRecoveryTimer();
      // Let the reporting request enrol before deciding whether an idle read is needed.
      void Promise.resolve().then(() => this.scheduleRecoveryRefresh());
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failedBackendChange = undefined;
    this.pendingRuntimeReplacement = undefined;
    this.openAttemptGeneration += 1;
    this.activeSessionOpenProgressGeneration = undefined;
    this.sessionOpenProgress = undefined;
    this.sessionOpenCancellation?.cancel();
    this.sessionOpenCancellation?.dispose();
    this.sessionOpenCancellation = undefined;
    this.importChangeCancellation?.cancel();
    this.importChangeCancellation?.dispose();
    this.importChangeCancellation = undefined;
    this.rendererSync.dispose();
    OpenWranglerPanel.panels.delete(this);
    this.deactivate();
    if (this.sessionId) {
      this.closing = this.bridge.request(
        {
          kind: "closeSession",
          sessionId: this.sessionId,
          revision: this.sessionRevision
        },
        panelRuntimeCleanupOptions()
      );
      void this.closing.catch(() => undefined);
      this.sessionId = undefined;
    }
    this.replacementSubscription?.dispose();
    this.replacementSubscription = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const decoded = decodeWebviewMessage(message, {
      sessionId: this.sessionId,
      sessionRevision: this.sessionRevision,
      snapshot: this.snapshot
    });
    if (!decoded) {
      return;
    }

    if (decoded.kind === "ready") {
      this.rendererSync.rendererStarted(true);
      const recovery = this.currentRuntimeReplacement();
      if (recovery) {
        this.latestPageViewRequestId = undefined;
        this.snapshotViewContextId = undefined;
        recovery.context = this.recoveryContext(null);
        recovery.error = undefined;
        recovery.offer = undefined;
      }
      await this.publishSessionOpenProgress();
      if (!this.rendererSync.rendererReady) return;
      await this.enqueueRendererSynchronization(true);
      this.rendererSync.scheduleStartupRecovery();
      this.publishPendingRecoveryOffer();
      return;
    }

    if (decoded.kind === "webviewFailure") {
      this.bridge.reportDiagnostic?.(
        decoded.phase === "message"
          ? "Open Wrangler webview message handling stopped. A renderer reload was offered."
          : "Open Wrangler webview rendering stopped. A renderer reload was offered."
      );
      return;
    }

    if (decoded.kind === "requestSessionSnapshot") {
      this.rendererSync.rendererStarted();
      await this.publishSessionOpenProgress();
      if (!this.rendererSync.rendererReady) return;
      await this.enqueueRendererSynchronization(false);
      this.rendererSync.scheduleStartupRecovery();
      this.publishPendingRecoveryOffer();
      return;
    }

    if (decoded.kind === "rendererSynchronized") {
      this.rendererSync.acknowledge(decoded);
      return;
    }

    if (decoded.kind === "rendererRetiring") {
      this.rendererSync.retire(decoded);
      return;
    }

    if (decoded.kind === "setViewContext") {
      if (isRecoveryViewContextId(decoded.viewContextId) && decoded.viewContextId !== this.snapshotViewContextId) {
        const pending = this.currentRuntimeReplacement();
        const offer = pending?.offer;
        if (
          this.sessionModeChangeTask ||
          !offer ||
          offer.message.offeredViewContextId !== decoded.viewContextId ||
          !offer.isCurrent()
        )
          return;
        this.pendingRuntimeReplacement = undefined;
        this.snapshotOffer = undefined;
        this.snapshot = offer.snapshot;
        this.sessionRevision = offer.snapshot.metadata.revision;
        if (offer.message.result?.kind === "stepPreview" || offer.message.result?.kind === "planUpdated") {
          this.latestPageViewRequestId = undefined;
        }
        this.snapshotViewContextId = decoded.viewContextId;
        this.bridge.setViewContext?.(pending.replacement.sessionId, decoded.viewContextId);
        const persistence = decoded.state
          ? this.bridge.updateViewState?.(pending.replacement.sessionId, decoded.state)
          : undefined;
        void this.rendererSync.synchronizeAcceptedSnapshot();
        await persistence;
        return;
      }
      if (decoded.state) return;
      if (this.snapshotOffer) {
        if (!this.snapshotOffer.sent || decoded.viewContextId !== this.snapshotOffer.viewContextId) return;
      } else if (
        decoded.viewContextId.startsWith(SNAPSHOT_VIEW_CONTEXT_PREFIX) &&
        decoded.viewContextId !== this.snapshotViewContextId
      ) {
        return;
      }
      const pending = this.currentRuntimeReplacement();
      const currentForeground = [...this.forwardedRequests.values()].some(
        ({ generation }) => generation === this.rendererSync.rendererGeneration
      );
      if (pending && pending.rendererGeneration !== this.rendererSync.rendererGeneration && currentForeground) return;
      this.snapshotOffer = undefined;
      this.snapshotViewContextId = decoded.viewContextId;
      if (this.sessionId) this.bridge.setViewContext?.(this.sessionId, decoded.viewContextId);
      if (pending?.context.request === null && !currentForeground) {
        pending.context = this.recoveryContext(null);
        pending.offer = undefined;
        this.scheduleRecoveryRefresh();
      }
      return;
    }

    if (decoded.kind === "cancelViewRequests") {
      if (this.sessionId && decoded.viewRequestIds.length) {
        this.bridge.cancelViewRequests?.(this.sessionId, decoded.viewRequestIds);
      }
      return;
    }

    if (decoded.kind === "prioritizeViewRequest") {
      if (this.sessionId) this.bridge.prioritizeViewRequest?.(this.sessionId, decoded.viewRequestId);
      return;
    }

    if (decoded.kind === "updateViewState") {
      if (this.currentRuntimeReplacement()) return;
      if (this.changingImportOptions || this.rendererSync.rendererViewStateLocked) return;
      if (this.sessionId) {
        await this.bridge.updateViewState?.(this.sessionId, decoded.state);
      }
      return;
    }

    if (decoded.kind === "cancelImportChange") {
      if (this.importActivity) this.importChangeCancellation?.cancel();
      return;
    }
    if (decoded.kind === "clearStepInspection") {
      if (this.sessionId) this.bridge.clearStepInspection?.(this.sessionId);
      return;
    }

    if (decoded.kind === "rewriteCleaningPlan") {
      if (!this.sessionId || !this.snapshot || !this.bridge.rewriteCleaningPlan) return;
      try {
        const response = await this.bridge.rewriteCleaningPlan(
          this.sessionId,
          this.sessionRevision,
          decoded.stepId,
          decoded.action,
          {
            offset: decoded.offset,
            limit: decoded.limit,
            columnOffset: decoded.columnOffset,
            columnLimit: decoded.columnLimit
          }
        );
        if (response.kind === "planUpdated") {
          this.invalidateRendererSynchronization();
          this.sessionId = response.metadata.sessionId;
          this.sessionRevision = response.revision;
          this.latestPageViewRequestId = undefined;
          this.snapshotViewContextId = undefined;
          this.snapshot = {
            ...this.snapshot,
            metadata: withoutDatasetStats(response.metadata),
            page: response.page,
            summaries: []
          };
        }
        const published = await this.post(response);
        if (published && response.kind === "planUpdated" && this.rendererSync.rendererReady) {
          this.rendererSync.schedulePublishedViewSynchronization();
        }
      } catch (error) {
        await this.post({
          kind: "error",
          code: "bridge_error",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
          sessionId: this.sessionId
        });
      }
      return;
    }

    if (decoded.kind === "changeImportOptions") {
      let task: Promise<void>;
      if (decoded.actionId !== undefined) {
        if (!this.rendererSync.expectsImportAction(decoded.actionId)) return;
        task = this.enqueueImportOptionsChange();
        this.rendererSync.settleImportAction(decoded.actionId, { task });
      } else if (this.nativeImportCommand && this.currentImportChangeTask) {
        task = this.currentImportChangeTask;
        this.rendererSync.settleImportAction(undefined, { task });
      } else {
        task = this.enqueueImportOptionsChange();
        this.rendererSync.settleImportAction(undefined, { task });
      }
      await task;
      return;
    }

    if (decoded.kind === "changeBackend") {
      await this.enqueueBackendChange();
      return;
    }

    if (decoded.kind === "installRuntimeDependencies") {
      await this.installRuntimeDependencies();
      return;
    }

    if (decoded.kind === "keepCopiedPlan") {
      await this.keepCopiedPlan();
      return;
    }

    if (decoded.kind === "discardCopiedPlan") {
      if (this.sessionId && this.bridge.getSessionPresentation?.(this.sessionId)?.copiedPlanPending)
        this.panel.dispose();
      return;
    }

    if (decoded.kind === "exportData") {
      const sessionId = this.sessionId;
      const revision = this.sessionRevision;
      if (!sessionId) return;
      await vscode.commands.executeCommand(SESSION_BOUND_EXPORT_DATA_COMMAND, sessionId, revision);
      return;
    }

    if (decoded.kind === "switchSessionMode") {
      await this.switchSessionMode(decoded.mode, decoded.state);
      return;
    }

    if (decoded.kind === "reconnectLiveSource") {
      await this.reconnectLiveSource();
      return;
    }

    if (this.changingImportOptions || this.sessionModeChangeTask) {
      await this.post({
        kind: "error",
        code: "session_reconfiguring",
        message: "Wait for the current session change to finish.",
        recoverable: true,
        ...viewRequestIdProperty(decoded.request)
      });
      return;
    }

    if (!this.sessionId) {
      await this.post({
        kind: "error",
        code: "session_not_open",
        message: "Session has not been opened yet.",
        recoverable: true,
        ...viewRequestIdProperty(decoded.request)
      });
      return;
    }

    const request = decoded.request;
    const requestOptions: BridgeRequestOptions | undefined =
      decoded.purpose === "clipboardColumn"
        ? { ephemeralPage: true }
        : decoded.priority === undefined
          ? undefined
          : { priority: decoded.priority };
    await this.forward(request, decoded.viewContextId, requestOptions);
  }

  private switchSessionMode(mode: SessionMode, viewState: GridViewState): Promise<void> {
    if (this.sessionModeChangeTask) return this.sessionModeChangeTask;
    const task = (async () => {
      const sessionId = this.sessionId;
      const revision = this.sessionRevision;
      const metadata = this.snapshot?.metadata;
      if (!sessionId || !metadata || this.disposed) return;
      if (!canRequestLiveSessionMode(metadata, mode)) {
        const action = sessionModeAction(metadata);
        await this.post({
          kind: "error",
          code: `${mode}_mode_unavailable`,
          message:
            action?.target === mode && action.disabledReason
              ? action.disabledReason
              : `This Open Wrangler session cannot switch to ${modeName(mode)} mode.`,
          recoverable: true,
          sessionId
        });
        return;
      }
      if (!this.bridge.reconfigureLiveSessionMode) {
        await this.post({
          kind: "error",
          code: `${mode}_mode_unavailable`,
          message: `This Open Wrangler session cannot switch to ${modeName(mode)} mode.`,
          recoverable: true,
          sessionId
        });
        return;
      }

      await this.postRendererMessage({ kind: "sessionModeChangeState", busy: true, mode });
      try {
        const response = await this.bridge.reconfigureLiveSessionMode(sessionId, revision, mode, viewState, {
          priority: "interactive",
          backendPreference: this.backendPreference
        });
        if (this.disposed || this.sessionId !== sessionId || this.sessionRevision !== revision) return;
        if (response.kind === "sessionOpened") {
          if (
            response.metadata.sessionId !== sessionId ||
            response.metadata.revision <= revision ||
            response.metadata.mode !== mode ||
            response.metadata.source.kind !== metadata.source.kind
          ) {
            await this.post({
              kind: "error",
              code: "invalid_runtime_response",
              message: `Open Wrangler rejected an invalid ${modeName(mode)}-mode response.`,
              recoverable: true,
              sessionId
            });
            return;
          }
          this.pendingRuntimeReplacement = undefined;
          this.invalidateRendererSynchronization();
          this.source = response.metadata.source;
          this.openResponse = response;
          this.sessionId = response.metadata.sessionId;
          this.sessionRevision = response.metadata.revision;
          this.snapshot = response;
          this.snapshotViewContextId = undefined;
          this.latestPageViewRequestId = undefined;
          if ((await this.post(response)) && this.rendererSync.rendererReady) {
            this.rendererSync.schedulePublishedViewSynchronization();
          }
          return;
        }
        await this.post(response);
      } catch (error) {
        if (this.disposed || this.sessionId !== sessionId || this.sessionRevision !== revision) return;
        await this.post({
          kind: "error",
          code: `${mode}_mode_open_failed`,
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
          sessionId
        });
      }
    })().finally(async () => {
      if (this.sessionModeChangeTask !== task) return;
      this.sessionModeChangeTask = undefined;
      if (!this.disposed) {
        await this.postRendererMessage({ kind: "sessionModeChangeState", busy: false, mode });
      }
      const pending = this.currentRuntimeReplacement();
      if (!pending) return;
      if (!pending.offer?.isCurrent()) {
        pending.offer = undefined;
        pending.context = { ...pending.context };
      }
      this.publishPendingRecoveryOffer();
    });
    this.sessionModeChangeTask = task;
    return task;
  }

  private async keepCopiedPlan(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || !this.bridge.keepCopiedPlan) return;
    const failure = await this.bridge.keepCopiedPlan(sessionId);
    if (this.disposed || this.sessionId !== sessionId) return;
    const presentation = this.bridge.getSessionPresentation?.(sessionId);
    if (presentation) {
      const { code: _code, ...rendererPresentation } = presentation;
      await this.postRendererMessage({ kind: "sessionPresentation", presentation: rendererPresentation });
    }
    if (failure) void vscode.window.showErrorMessage(failure.message);
  }

  private async reconnectLiveSource(): Promise<void> {
    const sessionId = this.sessionId;
    const revision = this.sessionRevision;
    if (!sessionId || this.disposed || this.reconnectingLiveSource) return;
    if (!this.bridge.reconnectLiveSession) {
      await this.post({
        kind: "error",
        code: "pyspark_connect_state_lost",
        message: "This Open Wrangler session cannot reconnect the live PySpark dataframe.",
        recoverable: true,
        sessionId
      });
      return;
    }

    this.reconnectingLiveSource = true;
    try {
      const response = await this.bridge.reconnectLiveSession(sessionId, revision, { priority: "interactive" });
      if (this.disposed || this.sessionId !== sessionId || this.sessionRevision !== revision) return;
      if (response.kind === "sessionOpened") {
        if (response.metadata.sessionId !== sessionId || response.metadata.revision !== revision) {
          await this.post({
            kind: "error",
            code: "pyspark_connect_state_lost",
            message: "Open Wrangler rejected a reconnect response for a different dataframe view.",
            recoverable: true,
            sessionId
          });
          return;
        }
        this.invalidateRendererSynchronization();
        this.openResponse = response;
        this.snapshot = response;
        this.snapshotViewContextId = undefined;
        this.latestPageViewRequestId = undefined;
        if ((await this.post(response)) && this.rendererSync.rendererReady) {
          this.rendererSync.schedulePublishedViewSynchronization();
        }
        return;
      }
      await this.post(response);
    } catch (error) {
      if (this.disposed || this.sessionId !== sessionId || this.sessionRevision !== revision) return;
      await this.post({
        kind: "error",
        code: "pyspark_connect_state_lost",
        message:
          error instanceof Error
            ? `Open Wrangler could not reconnect the live PySpark dataframe: ${error.message}`
            : "Open Wrangler could not reconnect the live PySpark dataframe.",
        recoverable: true,
        sessionId
      });
    } finally {
      this.reconnectingLiveSource = false;
    }
  }

  private enqueueImportOptionsChange(): Promise<void> {
    this.failedBackendChange = undefined;
    const generation = ++this.openAttemptGeneration;
    this.sessionOpenCancellation?.cancel();
    this.importChangeCancellation?.cancel();
    const task = this.importChangeTail.catch(() => undefined).then(() => this.changeImportOptions(generation));
    this.importChangeTail = task.catch(() => undefined);
    this.currentImportChangeTask = task;
    void task.then(
      () => {
        if (this.currentImportChangeTask === task) this.currentImportChangeTask = undefined;
      },
      () => {
        if (this.currentImportChangeTask === task) this.currentImportChangeTask = undefined;
      }
    );
    return task;
  }

  private enqueueBackendChange(retry?: FailedBackendChange): Promise<void> {
    const generation = retry?.generation ?? ++this.openAttemptGeneration;
    if (!retry) this.failedBackendChange = undefined;
    this.sessionOpenCancellation?.cancel();
    this.importChangeCancellation?.cancel();
    const task = this.importChangeTail.catch(() => undefined).then(() => this.changeBackend(generation, retry));
    this.importChangeTail = task.catch(() => undefined);
    this.currentImportChangeTask = task;
    void task.then(
      () => {
        if (this.currentImportChangeTask === task) this.currentImportChangeTask = undefined;
      },
      () => {
        if (this.currentImportChangeTask === task) this.currentImportChangeTask = undefined;
      }
    );
    return task;
  }

  private runNativeImportOptionsCommand(): Promise<boolean> {
    if (this.nativeImportCommand) return this.nativeImportCommand;
    const command = (async () => {
      const current = this.currentImportChangeTask;
      if (current) {
        await current;
        return true;
      }
      if (this.hasHydratedRenderer()) {
        const preparation = await this.requestRendererImportOptionsChange();
        if (preparation) {
          await preparation.task;
          return true;
        }
      }
      await (this.currentImportChangeTask ?? this.enqueueImportOptionsChange());
      return true;
    })();
    this.nativeImportCommand = command;
    void command.then(
      () => {
        if (this.nativeImportCommand === command) this.nativeImportCommand = undefined;
      },
      () => {
        if (this.nativeImportCommand === command) this.nativeImportCommand = undefined;
      }
    );
    return command;
  }

  private installRuntimeDependencies(): Promise<void> {
    if (this.runtimeDependencyInstallTask) return this.runtimeDependencyInstallTask;
    const task = (async () => {
      const retry = this.failedBackendChange;
      if (retry) {
        try {
          if (this.isCurrentBackendChange(retry)) await this.enqueueBackendChange(retry);
          else this.failedBackendChange = undefined;
        } finally {
          if (!this.disposed) await this.postRendererMessage({ kind: "runtimeDependencyInstallState", busy: false });
        }
        return;
      }
      const generation = this.openAttemptGeneration;
      const source = this.source;
      const backend = this.backend;
      await this.opening?.catch(() => undefined);
      if (
        this.disposed ||
        generation !== this.openAttemptGeneration ||
        this.sessionId ||
        this.source.kind !== "file" ||
        this.openResponse?.kind !== "error" ||
        this.openResponse.code !== "missing_dependencies"
      ) {
        if (!this.disposed) await this.postRendererMessage({ kind: "runtimeDependencyInstallState", busy: false });
        return;
      }
      const cancellation = new vscode.CancellationTokenSource();
      this.sessionOpenCancellation?.cancel();
      this.sessionOpenCancellation?.dispose();
      this.sessionOpenCancellation = cancellation;
      const isCurrent = (): boolean =>
        !this.disposed &&
        !this.sessionId &&
        generation === this.openAttemptGeneration &&
        this.source === source &&
        this.backend === backend &&
        !cancellation.token.isCancellationRequested;
      try {
        await this.postRendererMessage({ kind: "runtimeDependencyInstallState", busy: true });
        if (!isCurrent()) return;
        const ready = await this.bridge.installFileDependencies?.(source, backend, {
          cancellation: cancellation.token
        });
        if (!ready || !isCurrent()) return;
        if (ready !== true) {
          this.openResponse = ready;
          await this.post(ready);
          if (isCurrent() && this.rendererSync.rendererReady) this.scheduleRendererSynchronization(false);
          return;
        }
        this.openResponse = undefined;
        await this.open();
      } catch (error) {
        if (isCurrent()) {
          await this.post({
            kind: "error",
            code: "dependency_install_failed",
            message: dependencyGuardRecoveryGuidance(error),
            recoverable: true
          });
        }
      } finally {
        if (this.sessionOpenCancellation === cancellation) {
          this.sessionOpenCancellation = undefined;
          cancellation.dispose();
        }
        if (!this.disposed) {
          await this.postRendererMessage({ kind: "runtimeDependencyInstallState", busy: false });
        }
      }
    })();
    this.runtimeDependencyInstallTask = task;
    void task.then(
      () => {
        if (this.runtimeDependencyInstallTask === task) this.runtimeDependencyInstallTask = undefined;
      },
      () => {
        if (this.runtimeDependencyInstallTask === task) this.runtimeDependencyInstallTask = undefined;
      }
    );
    return task;
  }

  private async changeImportOptions(generation: number): Promise<void> {
    if (this.disposed || generation !== this.openAttemptGeneration || !canChangeImportOptions(this.source)) {
      return;
    }
    if (this.opening) {
      this.sessionOpenCancellation?.cancel();
      await this.opening.catch(() => undefined);
      if (this.disposed || generation !== this.openAttemptGeneration) return;
    }

    const cancellation = new vscode.CancellationTokenSource();
    this.importChangeCancellation?.dispose();
    this.importChangeCancellation = cancellation;
    const announceBusy = !this.changingImportOptions;
    this.changingImportOptions = true;
    let targetBridge: OpenWranglerBridge | undefined;
    try {
      if (announceBusy) {
        await this.postRendererMessage({ kind: "importOptionsState", busy: true });
      }
      const uri = fileSourceUri(this.source);
      if (!uri) {
        await this.postUnpublishedAuthoritativeSnapshot();
        await this.postImportResponse({
          kind: "error",
          code: "invalid_import_source",
          message: "Open Wrangler cannot resolve the file behind this session.",
          recoverable: true
        });
        return;
      }

      let importOptions: NonNullable<SessionSource["importOptions"]> | undefined;
      try {
        const extension = path.extname(uri.fsPath).toLowerCase();
        const isExcelSource = extension === ".xlsx" || extension === ".xls";
        const sheetNames =
          isExcelSource && this.sessionId && this.snapshot?.metadata.backend
            ? await this.bridge.listExcelSheets?.(this.sessionId, this.source, this.snapshot.metadata.backend, {
                cancellation: cancellation.token
              })
            : undefined;
        if (this.disposed || generation !== this.openAttemptGeneration) return;
        if (cancellation.token.isCancellationRequested) throw new ImportCancelledError();
        importOptions = await promptImportOptions(uri, this.source.importOptions, cancellation.token, sheetNames);
      } catch (error) {
        if (error instanceof ImportCancelledError) {
          if (this.disposed || generation !== this.openAttemptGeneration) return;
          await this.postUnpublishedAuthoritativeSnapshot();
          await this.postImportResponse(reconfigurationCancelledResponse());
          return;
        }
        throw error;
      }
      if (this.disposed || generation !== this.openAttemptGeneration) return;
      if (cancellation.token.isCancellationRequested) {
        await this.postUnpublishedAuthoritativeSnapshot();
        await this.postImportResponse(reconfigurationCancelledResponse());
        return;
      }
      if (this.sessionId) {
        await this.drainForwardedRequests();
        if (this.disposed || generation !== this.openAttemptGeneration) return;
        if (cancellation.token.isCancellationRequested) {
          await this.postUnpublishedAuthoritativeSnapshot();
          await this.postImportResponse(reconfigurationCancelledResponse());
          return;
        }
      }

      const nextSource: SessionSource = {
        ...this.source,
        ...(importOptions === undefined ? { importOptions: undefined } : { importOptions })
      };
      if (!this.sessionId) {
        const previousSource = this.source;
        this.source = nextSource;
        await this.forward(
          this.fileOpenRequest(nextSource),
          undefined,
          { cancellation: cancellation.token, backendPreference: this.backendPreference },
          generation
        );
        if (!this.sessionId) this.source = previousSource;
        return;
      }

      const metadata = this.snapshot?.metadata;
      const engine = metadata && fileEngine(metadata);
      if (!engine) return;
      this.importActivity = { activity: "Reopening with the new import options…" };
      await this.postRendererMessage({ kind: "importOptionsState", busy: true, ...this.importActivity });
      targetBridge = await this.fileEngineBridge(nextSource, engine);
      if (this.disposed || generation !== this.openAttemptGeneration) return;
      const response = await this.reconfigureOnBridge(targetBridge, this.sessionId, this.sessionRevision, nextSource, {
        cancellation: cancellation.token
      });
      if (response.kind === "sessionOpened") await this.adoptReconfiguredSession(response);
      if (this.disposed || generation !== this.openAttemptGeneration) return;
      if (response.kind !== "sessionOpened") await this.postUnpublishedAuthoritativeSnapshot();
      await this.postImportResponse(response);
    } catch (error) {
      if (this.disposed || generation !== this.openAttemptGeneration) return;
      await this.postUnpublishedAuthoritativeSnapshot();
      await this.postImportResponse({
        kind: "error",
        code: "bridge_error",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true
      });
    } finally {
      if (targetBridge && targetBridge !== this.bridge) targetBridge.onIdle?.();
      if (this.importChangeCancellation === cancellation) {
        this.importChangeCancellation = undefined;
        cancellation.dispose();
      }
      await this.finishImportChange(generation);
    }
  }

  private isCurrentBackendChange(attempt: FailedBackendChange): boolean {
    return (
      !this.disposed &&
      attempt.generation === this.openAttemptGeneration &&
      attempt.source === this.source &&
      attempt.sessionId === this.sessionId &&
      attempt.revision === this.sessionRevision
    );
  }

  private async changeBackend(generation: number, retry?: FailedBackendChange): Promise<void> {
    if (
      this.disposed ||
      generation !== this.openAttemptGeneration ||
      (this.source.kind !== "file" && this.snapshot?.metadata.backend !== "r") ||
      isDuckDBTableSource(this.source) ||
      !this.sessionId ||
      !this.snapshot ||
      (retry !== undefined && !this.isCurrentBackendChange(retry))
    ) {
      return;
    }
    if (this.opening) {
      await this.opening.catch(() => undefined);
      if (this.disposed || generation !== this.openAttemptGeneration || !this.sessionId || !this.snapshot) return;
    }
    if (this.source.kind !== "file") {
      await this.changeLiveRLibrary(generation);
      return;
    }

    const cancellation = new vscode.CancellationTokenSource();
    this.importChangeCancellation?.dispose();
    this.importChangeCancellation = cancellation;
    this.changingImportOptions = true;
    let targetBridge: OpenWranglerBridge | undefined;
    try {
      await this.postRendererMessage({ kind: "importOptionsState", busy: true });
      const source = this.source;
      const sessionId = this.sessionId;
      const revision = this.sessionRevision;
      const current = (): boolean =>
        !this.disposed &&
        generation === this.openAttemptGeneration &&
        source === this.source &&
        sessionId === this.sessionId &&
        revision === this.sessionRevision &&
        !cancellation.token.isCancellationRequested;
      const metadata = this.snapshot.metadata;
      const from = fileEngine(metadata);
      if (!from) return;
      const engines: FileEngine[] = automaticBackends(source).map((backend) => ({ backend }));
      if (
        from.backend === "r" ||
        (fileSourceUri(source)?.scheme === "file" &&
          /\.(csv|tsv|parquet|jsonl|ndjson|xlsx|xls)$/iu.test(source.path ?? "") &&
          supportsRFileExecution())
      ) {
        engines.push(...rLibraries.map((rLibrary) => ({ backend: "r" as const, rLibrary })));
      }
      const switches = engines.map((engine) => this.engineSwitch(metadata, from, engine));
      const picked =
        retry?.engine ??
        (await vscode.window.showQuickPick(
          switches.map((candidate) => ({
            label: engineLabel(candidate.engine.backend, candidate.engine.rLibrary),
            description: engineSwitchDescription(metadata, candidate),
            ...candidate.engine
          })),
          {
            title: "Dataframe engine",
            placeHolder: `Current: ${engineLabel(from.backend, from.rLibrary)}`,
            matchOnDescription: true
          },
          cancellation.token
        ));
      const selected = picked && switches.find((candidate) => sameEngine(candidate.engine, picked));
      if (!selected || selected.current || !current()) return;
      const plan = retry?.plan ?? (await chooseEngineSwitchPlan(metadata, from, selected));
      if (!plan || !current()) return;

      await this.drainForwardedRequests();
      if (!current() || (retry !== undefined && !this.isCurrentBackendChange(retry))) return;
      const attempt: FailedBackendChange = retry ?? {
        source,
        engine: selected.engine,
        plan,
        sessionId,
        revision,
        generation
      };
      const pendingEngine = engineLabel(attempt.engine.backend, attempt.engine.rLibrary);
      this.importActivity = { activity: `Switching to ${pendingEngine}…`, pendingEngine };
      await this.postRendererMessage({ kind: "importOptionsState", busy: true, ...this.importActivity });
      targetBridge = await this.fileEngineBridge(attempt.source, attempt.engine);
      if (!this.isCurrentBackendChange(attempt) || cancellation.token.isCancellationRequested) return;
      if (retry) {
        await this.postRendererMessage({ kind: "runtimeDependencyInstallState", busy: true });
        if (!this.isCurrentBackendChange(attempt) || cancellation.token.isCancellationRequested) return;
        const ready = await targetBridge.installFileDependencies?.(attempt.source, attempt.engine.backend, {
          cancellation: cancellation.token
        });
        if (!ready || !this.isCurrentBackendChange(attempt) || cancellation.token.isCancellationRequested) return;
        if (ready !== true) {
          await this.postImportResponse(ready);
          return;
        }
      }
      const response = await this.reconfigureOnBridge(
        targetBridge,
        attempt.sessionId,
        attempt.revision,
        attempt.source,
        {
          cancellation: cancellation.token,
          backendPreference: attempt.engine.backend,
          ...(attempt.engine.rLibrary ? { rLibrary: attempt.engine.rLibrary } : {}),
          plan: attempt.plan
        }
      );
      if (!this.isCurrentBackendChange(attempt) || cancellation.token.isCancellationRequested) return;
      this.failedBackendChange =
        response.kind === "error" && response.code === "missing_dependencies" ? attempt : undefined;
      if (response.kind === "sessionOpened") {
        this.backendPreference = attempt.engine.backend;
        await this.adoptReconfiguredSession(response);
      } else {
        await this.postUnpublishedAuthoritativeSnapshot();
      }
      if (this.disposed || generation !== this.openAttemptGeneration) return;
      await this.postImportResponse(response);
    } catch (error) {
      if (this.disposed || generation !== this.openAttemptGeneration || (retry && !this.isCurrentBackendChange(retry)))
        return;
      await this.postUnpublishedAuthoritativeSnapshot();
      await this.postImportResponse({
        kind: "error",
        code: retry ? "dependency_install_failed" : "bridge_error",
        message: retry
          ? dependencyGuardRecoveryGuidance(error)
          : error instanceof Error
            ? error.message
            : String(error),
        recoverable: true,
        sessionId: this.sessionId
      });
    } finally {
      if (targetBridge && targetBridge !== this.bridge) targetBridge.onIdle?.();
      if (this.importChangeCancellation === cancellation) {
        this.importChangeCancellation = undefined;
        cancellation.dispose();
      }
      await this.finishImportChange(generation);
    }
  }

  private engineSwitch(metadata: SessionMetadata, from: FileEngine, engine: FileEngine): EngineSwitch {
    if (sameEngine(from, engine))
      return { engine, current: true, saved: undefined, portableSteps: metadata.steps.length, blocked: undefined };
    const blockedIndex = metadata.steps.findIndex((step) => !stepReplaysOnEngine(step, from, engine));
    const draft = metadata.draftStep;
    return {
      engine,
      current: false,
      saved: this.bridge.savedFileWork?.(this.source, engine),
      portableSteps: blockedIndex < 0 ? metadata.steps.length : blockedIndex,
      blocked:
        blockedIndex >= 0
          ? metadata.steps[blockedIndex]
          : draft && !stepReplaysOnEngine(draft, from, engine)
            ? draft
            : undefined
    };
  }

  /** Python engines share one runtime, and one R runtime serves every library for the same import options. */
  private async fileEngineBridge(source: SessionSource, engine: FileEngine): Promise<OpenWranglerBridge> {
    const current = this.snapshot?.metadata.backend;
    if (
      engine.backend === "r"
        ? current === "r" && isDeepStrictEqual(source.importOptions, this.source.importOptions)
        : current !== "r"
    )
      return this.bridge;
    const select = OpenWranglerPanel.fileEngineBridges;
    if (!select) throw new Error(`${engineLabel(engine.backend, engine.rLibrary)} is unavailable in this window.`);
    return select(source, engine);
  }

  private async reconfigureOnBridge(
    target: OpenWranglerBridge,
    sessionId: string,
    revision: number,
    source: SessionSource,
    options: FileReconfigurationOptions
  ): Promise<OpenWranglerResponse> {
    if (!this.bridge.reconfigureFileSession) {
      return {
        kind: "error",
        code: "import_reconfiguration_unavailable",
        message: "This Open Wrangler session does not support changing its file configuration.",
        recoverable: true
      };
    }
    const response = await this.bridge.reconfigureFileSession(
      sessionId,
      revision,
      source,
      target === this.bridge ? options : { ...options, targetBridge: target }
    );
    if (response.kind === "sessionOpened" && target !== this.bridge) {
      this.bridge = target;
      this.subscribeToRuntimeReplacement();
    }
    return response;
  }

  private async adoptReconfiguredSession(response: SessionOpenedResponse): Promise<void> {
    this.invalidateRendererSynchronization();
    const blockSizeChanged =
      fetchGridBlockSize(this.backend).pageSize !== fetchGridBlockSize(response.metadata.backend).pageSize;
    this.source = response.metadata.source;
    this.openResponse = response;
    this.sessionId = response.metadata.sessionId;
    this.sessionRevision = response.metadata.revision;
    this.snapshot = response;
    this.snapshotViewContextId = undefined;
    this.latestPageViewRequestId = undefined;
    this.unpublishedAuthoritativeSnapshot = true;
    await this.rememberConfirmedFileImportOptions(response.metadata);
    if (OpenWranglerPanel.activePanel === this) this.bridge.setActiveSession?.(this.sessionId);
    if (blockSizeChanged) this.rendererSync.replaceRenderer();
  }

  /** Live R sources keep their captured frame, so another library opens as an editing copy of it. */
  private async changeLiveRLibrary(generation: number): Promise<void> {
    if (!this.sessionId || !this.snapshot) return;
    const cancellation = new vscode.CancellationTokenSource();
    this.importChangeCancellation?.dispose();
    this.importChangeCancellation = cancellation;
    this.changingImportOptions = true;
    try {
      await this.postRendererMessage({ kind: "importOptionsState", busy: true });
      const source = this.source;
      const sessionId = this.sessionId;
      const revision = this.sessionRevision;
      const current = (): boolean =>
        !this.disposed &&
        generation === this.openAttemptGeneration &&
        source === this.source &&
        sessionId === this.sessionId &&
        revision === this.sessionRevision &&
        !cancellation.token.isCancellationRequested;
      const copy = this.bridge.captureRLibraryCopy?.(sessionId, revision);
      const currentLibrary = this.snapshot.metadata.rLibrary;
      const selected = await vscode.window.showQuickPick(
        rLibraries.map((library) => ({
          label: engineLabel("r", library),
          description: library === currentLibrary ? "Current" : "Open editing copy",
          rLibrary: library
        })),
        {
          title: "Dataframe engine",
          placeHolder: `Current: ${engineLabel("r", currentLibrary)}`,
          matchOnDescription: true
        },
        cancellation.token
      );
      if (!selected || selected.rLibrary === currentLibrary || !current()) return;
      if (!copy || "kind" in copy) {
        await this.post(
          copy ?? {
            kind: "error",
            code: "r_library_copy_unavailable",
            message:
              "This R session cannot open an editing copy right now. Wait for pending work to finish and try again.",
            recoverable: true,
            sessionId
          }
        );
        return;
      }
      const targetLibrary = selected.rLibrary;
      if (copy.appliedStepCount > 0) {
        const confirmation = await vscode.window.showWarningMessage(
          `Open an editing copy with ${engineLabel("r", targetLibrary)}?`,
          {
            modal: true,
            detail: `The new tab replays ${countText(copy.appliedStepCount, "applied step")} from this session's captured source. This tab keeps its draft, redo history and view.${copy.rerunsCustomCode ? " Applied Custom Code runs again in the original R environment and may have side effects." : ""}`
          },
          "Open editing copy"
        );
        if (confirmation !== "Open editing copy") return;
      }
      if (!current() || !copy.isCurrent()) return;
      OpenWranglerPanel.create(
        this.context,
        copy.createBridge(targetLibrary),
        copy.source,
        "r",
        "r",
        "editing",
        targetLibrary
      );
    } finally {
      if (this.importChangeCancellation === cancellation) {
        this.importChangeCancellation = undefined;
        cancellation.dispose();
      }
      await this.finishImportChange(generation);
    }
  }

  private async finishImportChange(generation: number): Promise<void> {
    if (this.disposed || generation !== this.openAttemptGeneration) return;
    this.changingImportOptions = false;
    this.importActivity = undefined;
    if (this.rendererSync.rendererReady) await this.enqueueRendererSynchronization(false);
    if (this.disposed || generation !== this.openAttemptGeneration) return;
    if (!this.rendererSync.rendererReady || this.currentRuntimeReplacement()) {
      await this.postRendererMessage({ kind: "importOptionsState", busy: false });
      if (generation === this.openAttemptGeneration) this.publishPendingRecoveryOffer();
    }
  }

  private fileOpenRequest(source: SessionSource): Extract<OpenWranglerRequest, { kind: "openSession" }> {
    const { pageSize, columnLimit } = fetchGridBlockSize(this.backend);
    return {
      kind: "openSession",
      source,
      ...(this.backendPreference === "auto" ? {} : { backend: this.backendPreference }),
      pageSize,
      columnOffset: 0,
      columnLimit,
      mode: this.initialMode ?? getSetting<"editing" | "viewing">("fileStartMode", "editing")
    };
  }

  private forward(
    request: OpenWranglerRequest,
    viewContextId?: string,
    requestOptions?: BridgeRequestOptions,
    openAttemptGeneration?: number
  ): Promise<void> {
    const generation = this.rendererSync.rendererGeneration;
    const task = this.forwardRequest(request, viewContextId, requestOptions, openAttemptGeneration);
    this.forwardedRequests.set(task, {
      generation: isRecoveryForegroundRequest(request, requestOptions) ? generation : undefined,
      ...(request.kind === "getPage" && requestOptions?.ephemeralPage !== true
        ? { page: { sessionId: request.sessionId, requestId: request.viewRequestId } }
        : {})
    });
    const settled = (): void => {
      this.forwardedRequests.delete(task);
      this.scheduleRecoveryRefresh();
    };
    void task.then(settled, settled);
    return task;
  }

  private async drainForwardedRequests(): Promise<void> {
    while (this.forwardedRequests.size > 0) {
      await Promise.allSettled(this.forwardedRequests.keys());
    }
  }

  private async forwardRequest(
    request: OpenWranglerRequest,
    viewContextId?: string,
    requestOptions?: BridgeRequestOptions,
    openAttemptGeneration?: number
  ): Promise<void> {
    if (request.kind === "previewStep" && request.step.kind === "customCode" && !vscode.workspace.isTrusted) {
      await this.post({
        kind: "error",
        code: "workspace_untrusted",
        message: "Trust this workspace before running custom code.",
        recoverable: true
      });
      return;
    }
    if (request.kind === "redoStep" && !vscode.workspace.isTrusted) {
      await this.post({
        kind: "error",
        code: "workspace_untrusted",
        message: "Trust this workspace before redoing a cleaning step.",
        recoverable: true,
        sessionId: request.sessionId,
        viewRequestId: request.viewRequestId
      });
      return;
    }
    const ephemeralPage = request.kind === "getPage" && requestOptions?.ephemeralPage === true;
    if (
      request.kind === "getPage" &&
      !ephemeralPage &&
      viewContextId !== undefined &&
      (this.snapshotViewContextId === undefined || this.snapshotOffer !== undefined)
    ) {
      await this.post({
        kind: "error",
        code: "stale_response",
        message: "Ignored a page from a view awaiting snapshot confirmation.",
        recoverable: true,
        sessionId: request.sessionId,
        viewRequestId: request.viewRequestId
      });
      return;
    }
    if (request.kind === "getPage" && !ephemeralPage) {
      this.latestPageViewRequestId = request.viewRequestId;
    }
    const recoveryContext = this.recoveryContext(isRecoveryForegroundRequest(request, requestOptions) ? request : null);
    const rendererGeneration = this.rendererSync.rendererGeneration;
    const pendingAtStart = this.currentRuntimeReplacement();
    if (pendingAtStart && isRecoveryForegroundRequest(request, requestOptions)) pendingAtStart.offer = undefined;
    try {
      const bridgeOptions: BridgeRequestOptions | undefined = viewContextId
        ? { ...requestOptions, viewContextId }
        : requestOptions;
      const response = correlateViewError(request, await this.bridge.request(request, bridgeOptions));
      if (request.kind === "applyDraft" && response.kind === "error") {
        try {
          // Error codes are arbitrary protocol strings. Retain only known
          // categories, before recovery or disposal can suppress publication.
          const code = [
            "engine_error",
            "runtime_error",
            "stale_request",
            "stale_response",
            "unknown_session",
            "invalid_runtime_response",
            "runtime_recovery_failed",
            "persistence_unavailable",
            "live_source_invalidated",
            "r_kernel_changed"
          ].includes(response.code)
            ? response.code
            : "other";
          this.bridge.reportDiagnostic?.(
            `Open Wrangler Apply returned an error: ${JSON.stringify({
              code,
              recoverable: response.recoverable,
              requestedRevision:
                Number.isSafeInteger(request.revision) && request.revision >= 0 ? request.revision : null,
              responseSessionMatches: response.sessionId === undefined ? null : response.sessionId === request.sessionId
            })}`
          );
        } catch {
          // A diagnostic sink must not replace the returned refusal.
        }
      }
      if (
        request.kind === "openSession" &&
        openAttemptGeneration !== undefined &&
        openAttemptGeneration !== this.openAttemptGeneration
      ) {
        if (response.kind === "sessionOpened") {
          await this.bridge.request(
            {
              kind: "closeSession",
              sessionId: response.metadata.sessionId,
              revision: response.metadata.revision
            },
            panelRuntimeCleanupOptions()
          );
        }
        return;
      }
      if (this.disposed) {
        if (response.kind === "sessionOpened") {
          await this.bridge.request(
            {
              kind: "closeSession",
              sessionId: response.metadata.sessionId,
              revision: response.metadata.revision
            },
            panelRuntimeCleanupOptions()
          );
        }
        return;
      }
      const recovery = this.currentRuntimeReplacement();
      if (recovery && request.kind !== "openSession") {
        if (isRecoveryForegroundRequest(request, requestOptions)) {
          const retiredPublication = rendererGeneration !== this.rendererSync.rendererGeneration;
          if (retiredPublication && this.latestPageViewRequestId !== undefined) return;
          const currentPage =
            request.kind !== "getPage" ||
            this.latestPageViewRequestId === request.viewRequestId ||
            (retiredPublication && this.latestPageViewRequestId === undefined);
          if (currentPage) {
            recovery.context = retiredPublication ? this.recoveryContext(null) : recoveryContext;
            recovery.error = undefined;
            if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
              const current = recovery.replacement.captureView(
                response.kind === "page" ? response.viewRequestId : null
              );
              if (current) {
                await this.publishRecovery(recovery, response, current);
                return;
              }
            } else if (response.kind === "error" || response.kind === "cancelled") {
              if (!retiredPublication) recovery.error = response;
              return;
            }
          }
        }
        // Old profile owners will be retired by the accepted atomic view.
        if (response.kind === "summary" || response.kind === "datasetStats" || response.kind === "columnValues") return;
      }
      if (
        request.kind === "redoStep" &&
        response.kind === "error" &&
        response.code === "redo_unavailable" &&
        response.sessionId === request.sessionId &&
        response.viewRequestId === request.viewRequestId &&
        this.snapshot?.metadata.sessionId === request.sessionId &&
        this.snapshot.metadata.revision === request.revision
      ) {
        this.invalidateRendererSynchronization();
        this.snapshot = { ...this.snapshot, metadata: { ...this.snapshot.metadata, canRedo: false } };
      }
      if (request.kind === "openSession") {
        this.openResponse = response;
        this.scheduleRendererStartupRecovery();
      }
      if (response.kind === "sessionOpened") {
        this.pendingRuntimeReplacement = undefined;
        this.invalidateRendererSynchronization();
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.metadata.revision;
        this.snapshot = response;
        this.snapshotViewContextId = undefined;
        if (OpenWranglerPanel.activePanel === this) this.bridge.setActiveSession?.(this.sessionId);
      }
      if (request.kind === "openSession" && response.kind === "sessionOpened") {
        await this.rememberConfirmedFileImportOptions(response.metadata);
      }
      if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
        if (response.kind !== "page") this.invalidateRendererSynchronization();
        const acceptsPage =
          response.kind !== "page" ||
          (ephemeralPage && request.kind === "getPage" && response.viewRequestId === request.viewRequestId) ||
          (request.kind === "getPage" &&
            response.viewRequestId === request.viewRequestId &&
            this.latestPageViewRequestId === response.viewRequestId);
        if (acceptsPage && !ephemeralPage) {
          this.sessionId = response.metadata.sessionId;
          this.sessionRevision = response.revision;
          if (response.kind !== "page") this.latestPageViewRequestId = undefined;
        }
        if (this.snapshot && acceptsPage && !ephemeralPage) {
          const sameView =
            response.kind === "page" && viewContextId !== undefined && viewContextId === this.snapshotViewContextId;
          const metadata =
            sameView && this.snapshot.metadata.stats
              ? { ...response.metadata, stats: this.snapshot.metadata.stats }
              : withoutDatasetStats(response.metadata);
          this.snapshot = {
            ...this.snapshot,
            metadata,
            page: response.page,
            summaries: sameView ? this.snapshot.summaries : []
          };
          this.snapshotViewContextId = response.kind === "page" ? viewContextId : undefined;
        }
      }
      if (
        response.kind === "summary" &&
        request.kind === "getSummary" &&
        response.viewRequestId === request.viewRequestId &&
        this.snapshot &&
        viewContextId !== undefined &&
        viewContextId === this.snapshotViewContextId
      ) {
        const summaries = new Map(this.snapshot.summaries.map((summary) => [summary.columnId, summary]));
        for (const summary of response.summaries) summaries.set(summary.columnId, summary);
        const schemaOrder = new Map(this.snapshot.metadata.schema.map((column, index) => [column.id, index]));
        this.snapshot = {
          ...this.snapshot,
          summaries: [...summaries.values()].sort(
            (left, right) =>
              (schemaOrder.get(left.columnId) ?? Number.MAX_SAFE_INTEGER) -
              (schemaOrder.get(right.columnId) ?? Number.MAX_SAFE_INTEGER)
          )
        };
      }
      if (
        response.kind === "datasetStats" &&
        request.kind === "getDatasetStats" &&
        response.viewRequestId === request.viewRequestId &&
        this.snapshot &&
        viewContextId !== undefined &&
        viewContextId === this.snapshotViewContextId
      ) {
        this.snapshot = {
          ...this.snapshot,
          metadata: { ...this.snapshot.metadata, stats: response.stats }
        };
      }
      if (request.kind === "openSession" && response.kind === "sessionOpened" && this.changingImportOptions) {
        await this.postImportResponse(response);
        return;
      }
      const published = await this.postRuntimeResponse(request, response);
      if (
        published &&
        this.rendererSync.rendererReady &&
        (response.kind === "sessionOpened" || response.kind === "stepPreview" || response.kind === "planUpdated")
      ) {
        this.rendererSync.schedulePublishedViewSynchronization();
      }
    } catch (error) {
      if (this.disposed) return;
      if (
        request.kind === "openSession" &&
        openAttemptGeneration !== undefined &&
        openAttemptGeneration !== this.openAttemptGeneration
      ) {
        return;
      }
      const response: OpenWranglerResponse = {
        kind: "error",
        code: "bridge_error",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
        ...viewRequestIdProperty(request)
      };
      const recovery = this.currentRuntimeReplacement();
      if (recovery && isRecoveryForegroundRequest(request, requestOptions)) {
        const retiredPublication = rendererGeneration !== this.rendererSync.rendererGeneration;
        if (retiredPublication && this.latestPageViewRequestId !== undefined) return;
        if (
          request.kind !== "getPage" ||
          this.latestPageViewRequestId === request.viewRequestId ||
          (retiredPublication && this.latestPageViewRequestId === undefined)
        ) {
          recovery.context = retiredPublication ? this.recoveryContext(null) : recoveryContext;
          recovery.error = retiredPublication ? undefined : response;
        }
        return;
      }
      if (request.kind === "openSession") {
        this.openResponse = response;
        this.scheduleRendererStartupRecovery();
      }
      await this.postRuntimeResponse(request, response);
      if (request.kind === "openSession" && this.rendererSync.rendererReady) {
        this.scheduleRendererSynchronization(false);
      }
    }
  }

  private recoveryContext(request: OpenWranglerRequest | null): SessionRecoveryContext {
    return {
      sessionId: this.sessionId ?? "",
      revision: request && "revision" in request ? request.revision : this.sessionRevision,
      viewContextId: this.snapshotViewContextId ?? null,
      lastPageRequestId: this.latestPageViewRequestId ?? null,
      request:
        request && isRecoveryForegroundRequest(request)
          ? { kind: request.kind, ...viewRequestIdProperty(request) }
          : null
    };
  }

  private currentRuntimeReplacement(): PendingRuntimeReplacement | undefined {
    const pending = this.pendingRuntimeReplacement;
    if (
      pending &&
      (this.disposed || this.sessionId !== pending.replacement.sessionId || !pending.replacement.isCurrent())
    ) {
      this.pendingRuntimeReplacement = undefined;
      return undefined;
    }
    return pending;
  }

  private publishPendingRecoveryOffer(): void {
    const pending = this.currentRuntimeReplacement();
    if (!pending || !this.rendererSync.rendererReady || this.sessionModeChangeTask) return;
    if (pending.offer?.isCurrent()) {
      void this.postRendererMessage(pending.offer.message);
    } else {
      pending.offer = undefined;
      this.scheduleRecoveryRefresh();
    }
  }

  private scheduleRecoveryRefresh(): void {
    const pending = this.currentRuntimeReplacement();
    if (
      !pending ||
      pending.refresh ||
      pending.attemptedContext === pending.context ||
      pending.offer ||
      this.sessionModeChangeTask ||
      !this.rendererSync.rendererReady ||
      [...this.forwardedRequests.values()].some(({ generation }) => generation !== undefined)
    )
      return;
    const context = pending.context;
    pending.attemptedContext = context;
    const { pageSize: limit, columnLimit } = fetchGridBlockSize(this.backend);
    const window = {
      limit,
      columnOffset: Math.max(
        0,
        this.snapshot?.metadata.schema.findIndex((column) => column.id === this.snapshot?.page.columnIds[0]) ?? 0
      ),
      columnLimit: this.snapshot?.page.columnIds.length || columnLimit
    };
    pending.refresh = (async () => {
      try {
        const read = await pending.replacement.readPage(window);
        if (
          this.currentRuntimeReplacement() !== pending ||
          pending.context !== context ||
          this.sessionModeChangeTask ||
          [...this.forwardedRequests.values()].some(({ generation }) => generation !== undefined)
        )
          return;
        if (!read || !read.isCurrent()) return;
        if (read.response.kind === "page") {
          await this.publishRecovery(
            pending,
            { kind: "sessionOpened", metadata: read.response.metadata, page: read.response.page, summaries: [] },
            read.isCurrent
          );
        } else if (pending.error) {
          // A failed refresh cannot invent a complete replacement. Preserve
          // the originating terminal failure and let later user work refresh.
          const error = pending.error;
          pending.error = undefined;
          await this.post(error);
        } else {
          this.warnRecoveryReadFailure();
        }
      } catch {
        if (
          this.currentRuntimeReplacement() !== pending ||
          pending.context !== context ||
          this.sessionModeChangeTask ||
          [...this.forwardedRequests.values()].some(({ generation }) => generation !== undefined)
        )
          return;
        if (pending.error) {
          const error = pending.error;
          pending.error = undefined;
          await this.post(error);
        } else this.warnRecoveryReadFailure();
      }
    })().finally(() => {
      if (this.currentRuntimeReplacement() === pending) {
        pending.refresh = undefined;
        // A newer completed request can supersede this read. This is not a
        // retry of a failed read: only that newly owned outcome is scheduled.
        if (pending.context !== context) this.scheduleRecoveryRefresh();
      }
    });
  }

  private warnRecoveryReadFailure(): void {
    void vscode.window.showWarningMessage(
      "Open Wrangler recovered the runtime but could not refresh the grid. Try another page or reopen the dataset."
    );
  }

  private async publishRecovery(
    pending: PendingRuntimeReplacement,
    response: Extract<OpenWranglerResponse, { kind: "sessionOpened" | "page" | "stepPreview" | "planUpdated" }>,
    viewIsCurrent: () => boolean
  ): Promise<void> {
    const presentation = this.bridge.getSessionPresentation?.(pending.replacement.sessionId);
    const state = this.bridge.getViewState?.(pending.replacement.sessionId);
    const viewState = state && encodeGridViewState(state);
    if (
      !presentation ||
      !viewState ||
      presentation.sessionId !== response.metadata.sessionId ||
      presentation.revision !== response.metadata.revision ||
      this.currentRuntimeReplacement() !== pending ||
      this.sessionModeChangeTask ||
      !viewIsCurrent()
    )
      return;
    const context = pending.context;
    const metadata = withoutDatasetStats(response.metadata);
    const snapshot: SessionOpenedResponse = { kind: "sessionOpened", metadata, page: response.page, summaries: [] };
    const { code: _code, ...rendererPresentation } = presentation;
    const message: SessionRecoveryMessage = {
      kind: "sessionRecovered",
      offeredViewContextId: `${RECOVERY_VIEW_CONTEXT_PREFIX}${createSecureNonce()}`,
      context,
      presentation: rendererPresentation,
      viewState,
      ...(response.kind === "sessionOpened" || context.request === null
        ? { snapshot, ...(pending.error ? { result: pending.error } : {}) }
        : { result: { ...response, metadata } })
    };
    pending.offer = {
      message,
      snapshot,
      isCurrent: () =>
        this.currentRuntimeReplacement() === pending &&
        pending.context === context &&
        (this.latestPageViewRequestId ?? null) === context.lastPageRequestId &&
        viewIsCurrent()
    };
    if (this.rendererSync.rendererReady) await this.postRendererMessage(message);
    // The exact offered context, not completion of this await, owns retirement.
  }

  private post(response: OpenWranglerResponse): Promise<boolean> {
    return this.postRendererMessage(response);
  }

  private postRendererMessage(message: unknown): Promise<boolean> {
    return this.rendererSync.postMessage(message);
  }

  private updateSessionOpenProgress(generation: number, stage: SessionOpenProgressStage): void {
    if (
      this.disposed ||
      generation !== this.openAttemptGeneration ||
      generation !== this.activeSessionOpenProgressGeneration
    ) {
      return;
    }
    this.sessionOpenProgress = { generation, stage };
    void this.publishSessionOpenProgress();
  }

  private async clearSessionOpenProgress(generation: number): Promise<void> {
    if (this.activeSessionOpenProgressGeneration === generation) {
      this.activeSessionOpenProgressGeneration = undefined;
    }
    if (this.sessionOpenProgress?.generation !== generation) return;
    this.sessionOpenProgress = undefined;
    if (!this.disposed && this.rendererSync.rendererReady) {
      await this.enqueueSessionOpenProgressPublication(null);
    }
  }

  private publishSessionOpenProgress(): Promise<void> {
    if (this.disposed || !this.rendererSync.rendererReady || !this.sessionOpenProgress) return Promise.resolve();
    return this.enqueueSessionOpenProgressPublication(this.sessionOpenProgress.stage);
  }

  private enqueueSessionOpenProgressPublication(stage: SessionOpenProgressStage | null): Promise<void> {
    this.sessionOpenProgressPublication = this.sessionOpenProgressPublication.then(async () => {
      if (this.disposed) return;
      try {
        await this.postRendererMessage({ kind: "sessionOpenProgress", stage });
      } catch {
        // A renderer may disappear between scheduling and delivery. Progress is
        // presentational and must never change the session-open outcome.
      }
    });
    return this.sessionOpenProgressPublication;
  }

  private async postImportResponse(response: OpenWranglerResponse): Promise<void> {
    await this.rendererSync.postImportResponse(response);
  }

  private hasHydratedRenderer(): boolean {
    return this.rendererSync.hasHydratedRenderer();
  }

  private isRendererSynchronizableForSession(sessionId: string): boolean {
    return Boolean(
      !this.disposed &&
      !this.opening &&
      this.rendererSync.rendererReady &&
      this.sessionId === sessionId &&
      this.snapshot?.metadata.sessionId === sessionId
    );
  }

  private invalidateRendererSynchronization(): void {
    this.rendererSync.invalidate();
  }

  private waitForRendererSynchronizationAcknowledgement(
    syncId: string,
    deadlineMs = Number.POSITIVE_INFINITY
  ): Promise<boolean> {
    return this.rendererSync.waitForAcknowledgement(syncId, deadlineMs);
  }

  private scheduleRendererStartupRecovery(): void {
    this.rendererSync.scheduleStartupRecovery();
  }

  private clearRendererStartupRecoveryTimer(): void {
    this.rendererSync.clearStartupRecoveryTimer();
  }

  private codePreviewLayoutTransitionPending(): boolean {
    if (this.codePreviewReveal?.pending) return true;
    const snapshot = this.snapshot;
    if (!snapshot || !this.panel.active || OpenWranglerPanel.activePanel !== this) return false;
    const behavior = getSetting<"onDraft" | "always" | "never">("panelRevealBehavior", "onDraft");
    const draftStepId = snapshot.metadata.draftStep?.id;
    const changedSession = this.codePreviewReveal?.sessionId !== snapshot.metadata.sessionId;
    if (behavior === "never") return false;

    return changedSession && (behavior === "always" || draftStepId !== undefined);
  }

  private revealCodePreviewAfterRendererSynchronization(synchronization: RendererSynchronizationIdentity): void {
    if (!synchronization.layoutTransitionPending || this.codePreviewReveal?.pending) return;
    const snapshot = this.snapshot;
    const canReveal =
      snapshot !== undefined &&
      synchronization.sessionId === snapshot.metadata.sessionId &&
      synchronization.revision === snapshot.metadata.revision &&
      this.hasHydratedRenderer() &&
      this.codePreviewLayoutTransitionPending();
    if (!canReveal || !snapshot) {
      if (this.hasHydratedRenderer()) this.rendererSync.schedulePublishedViewSynchronization();
      else this.scheduleRendererSynchronization(false);
      return;
    }

    const reveal = { sessionId: snapshot.metadata.sessionId, pending: true };
    this.codePreviewReveal = reveal;
    const settleLayout = (): void => {
      reveal.pending = false;
      if (!this.disposed && this.codePreviewReveal === reveal) {
        this.rendererSync.schedulePublishedViewSynchronization();
      }
    };
    void vscode.commands
      .executeCommand("openWrangler.codePreview.open", { preserveFocus: true })
      .then(settleLayout, (error: unknown) => {
        this.bridge.reportDiagnostic?.(
          `Open Wrangler could not reveal Code Preview: ${error instanceof Error ? error.message : String(error)}`
        );
        settleLayout();
      });
  }

  private requestRendererImportOptionsChange(): Promise<RendererImportPreparation | undefined> {
    return this.rendererSync.requestImportOptionsChange();
  }

  private scheduleRendererSynchronization(clearInspection: boolean): void {
    this.rendererSync.scheduleSynchronization(clearInspection);
  }

  private prepareSnapshot(): void | Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || !this.snapshot) return;
    const generation = this.rendererSync.rendererGeneration;
    const offer = { viewContextId: `${SNAPSHOT_VIEW_CONTEXT_PREFIX}${createSecureNonce()}`, sent: false };
    this.snapshotOffer = offer;
    const settle = (): void | Promise<void> => {
      if (
        this.disposed ||
        this.sessionId !== sessionId ||
        generation !== this.rendererSync.rendererGeneration ||
        this.snapshotOffer !== offer ||
        this.currentRuntimeReplacement()
      )
        return;
      const committed = this.bridge.getPagePublication?.(sessionId);
      const requestId = committed?.viewRequestId;
      const publication =
        requestId === undefined
          ? undefined
          : [...this.forwardedRequests].find(
              ([, owner]) => owner.page?.sessionId === sessionId && owner.page.requestId === requestId
            )?.[0];
      if (publication) return publication.then(settle, settle);
      if (
        committed &&
        this.snapshot &&
        (this.snapshot.page !== committed.page ||
          this.snapshot.metadata.revision !== committed.revision ||
          this.snapshot.metadata.filterModel !== committed.metadata.filterModel)
      ) {
        this.snapshot = {
          ...this.snapshot,
          metadata: withoutDatasetStats(committed.metadata),
          page: committed.page,
          summaries: []
        };
        this.sessionRevision = committed.revision;
      }
      this.latestPageViewRequestId = undefined;
      this.snapshotViewContextId = undefined;
      this.bridge.setViewContext?.(sessionId, undefined);
    };
    return settle();
  }

  private enqueueRendererSynchronization(clearInspection: boolean): Promise<void> {
    return this.rendererSync.enqueueSynchronization(clearInspection);
  }

  private activate(): void {
    if (this.disposed) return;
    const previous = OpenWranglerPanel.activePanel;
    if (previous !== this) {
      OpenWranglerPanel.activePanel = this;
      if (previous) void previous.postStepInspectionCleared(false);
      void this.postStepInspectionCleared(true);
    }
    void vscode.commands.executeCommand(
      "setContext",
      "openWrangler.canChangeImportOptions",
      canChangeImportOptions(this.source)
    );
    this.bridge.setActiveSession?.(this.sessionId);
    this.scheduleRendererStartupRecovery();
  }

  private deactivate(): void {
    this.clearRendererStartupRecoveryTimer();
    if (OpenWranglerPanel.activePanel !== this) return;
    OpenWranglerPanel.activePanel = undefined;
    this.bridge.setActiveSession?.(undefined);
    void vscode.commands.executeCommand("setContext", "openWrangler.canChangeImportOptions", false);
  }

  private async postStepInspectionCleared(resumeProfiling: boolean): Promise<void> {
    if (this.disposed) return;
    await this.postRendererMessage({ kind: "stepInspectionCleared", resumeProfiling });
  }

  private postRuntimeResponse(request: OpenWranglerRequest, response: OpenWranglerResponse): Promise<boolean> {
    if (request.kind === "inspectStep") {
      return this.postRendererMessage({
        kind: "stepInspectionResult",
        stepId: request.stepId,
        offset: request.offset,
        limit: request.limit,
        columnOffset: request.columnOffset,
        columnLimit: request.columnLimit,
        response
      });
    }
    return this.post(response);
  }

  private async postUnpublishedAuthoritativeSnapshot(): Promise<void> {
    if (!this.unpublishedAuthoritativeSnapshot || !this.snapshot) return;
    if (this.changingImportOptions && this.rendererSync.rendererReady) return;
    this.unpublishedAuthoritativeSnapshot = false;
    await this.post(this.snapshot);
  }

  private async rememberConfirmedFileImportOptions(metadata: SessionMetadata): Promise<void> {
    const { source, backend, rLibrary } = metadata;
    this.backend = backend;
    this.rLibrary = rLibrary;
    this.panel.title = `Open Wrangler: ${sourceDisplayLabel(source)} (${engineLabel(backend, rLibrary)})`;
    const uri = fileSourceUri(source);
    if (!uri) return;
    try {
      await rememberConfirmedFileConfiguration(
        this.context.workspaceState,
        uri,
        source.importOptions,
        backend,
        this.backendPreference,
        rLibrary
      );
    } catch (error) {
      try {
        this.bridge.reportDiagnostic?.(
          `Open Wrangler could not remember confirmed import options for ${source.label}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } catch {
        // A diagnostic failure must not undo an accepted session.
      }
      if (this.disposed) return;
      try {
        void Promise.resolve(
          vscode.window.showWarningMessage(
            "Open Wrangler could not save this file's import settings and dataframe engine. The current session remains available, but reopening may use different settings or a different engine."
          )
        ).catch(() => undefined);
      } catch {
        // A failed warning surface must not destabilize the active session.
      }
    }
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "webview.js"))
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "webview.css"))
    );
    const nonce = createSecureNonce();
    const bootstrapSettings = readWebviewBootstrapSettings();
    const { pageSize: fetchBlockSize, columnLimit: columnBlockSize } = fetchGridBlockSize(
      this.backend,
      bootstrapSettings
    );
    const bootstrapAttributes = serializeBootstrapAttributes({
      ...bootstrapSettings,
      fetchBlockSize,
      fetchColumnBlockSize: columnBlockSize,
      canChangeImportOptions: canChangeImportOptions(this.source)
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Open Wrangler</title>
</head>
<body ${bootstrapAttributes}>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function fileEngine(metadata: SessionMetadata): FileEngine | undefined {
  const { backend, rLibrary } = metadata;
  if (backend === "r") return { backend, rLibrary: rLibrary ?? "base" };
  return backend === "pandas" || backend === "polars" || backend === "duckdb" ? { backend } : undefined;
}

function sameEngine(left: FileEngine, right: FileEngine): boolean {
  return left.backend === right.backend && (left.backend !== "r" || left.rLibrary === right.rLibrary);
}

function countText(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

function stepsText(count: number): string {
  return count === 1 ? "step" : countText(count, "step");
}

function workText(steps: number, draft: boolean): string {
  return [steps > 0 ? countText(steps, "applied step") : undefined, draft ? "a draft" : undefined]
    .filter((part): part is string => part !== undefined)
    .join(" and ");
}

/** Applying a draft keeps its step ID, so saved work that this tab has built on is a prefix of the tab's work. */
function tabContainsSavedWork(metadata: SessionMetadata, saved: SavedFileWork): boolean {
  const { draftStep } = saved;
  return (
    saved.steps.every((step, index) => metadata.steps[index]?.id === step.id) &&
    (draftStep === undefined ||
      draftStep.id === metadata.steps[saved.steps.length]?.id ||
      (saved.steps.length === metadata.steps.length && draftStep.id === metadata.draftStep?.id))
  );
}

/** Edit latest keeps a step's ID, so restoring saved work over this tab needs every tab step to match a saved one. */
function savedWorkContainsTab(metadata: SessionMetadata, saved: SavedFileWork): boolean {
  const same = (step: TransformStep, other: TransformStep | undefined) =>
    other !== undefined && stepSignature(step) === stepSignature(other);
  const { steps, draftStep } = metadata;
  return (
    steps.every((step, index) => same(step, saved.steps[index])) &&
    (draftStep === undefined ||
      same(draftStep, saved.steps[steps.length]) ||
      (steps.length === saved.steps.length && same(draftStep, saved.draftStep)))
  );
}

const sourceColumnId = /^(?:c:source:|r:c:)(0|[1-9][0-9]*)$/u;

/** Python engines name a file's source columns `c:source:N` and R `r:c:N`, so source references compare by position. */
function stepSignature(value: unknown, key?: string): string {
  if (Array.isArray(value)) return `[${value.map((item) => stepSignature(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${fields.map(([name, field]) => `${JSON.stringify(name)}:${stepSignature(field, name)}`).join(",")}}`;
  }
  return JSON.stringify(key === "id" && typeof value === "string" ? value.replace(sourceColumnId, "source:$1") : value);
}

function engineSwitchDescription(metadata: SessionMetadata, target: EngineSwitch): string | undefined {
  if (target.current) return "Current";
  const { saved, blocked } = target;
  const otherSaved = saved && !tabContainsSavedWork(metadata, saved) ? saved : undefined;
  if (otherSaved && savedWorkContainsTab(metadata, otherSaved))
    return `Restores ${workText(otherSaved.steps.length, otherSaved.draftStep !== undefined)}`;
  if (blocked) return `${operationByKind(blocked.kind).title} can't move`;
  if (otherSaved) return "Has other saved work";
  const hasWork = metadata.steps.length > 0 || metadata.draftStep !== undefined;
  return hasWork ? `Replays ${workText(metadata.steps.length, metadata.draftStep !== undefined)}` : undefined;
}

function blockedReason(step: TransformStep, from: FileEngine): string {
  const title = operationByKind(step.kind).title;
  switch (step.kind) {
    case "customCode":
      return `${title} is written for ${from.backend === "r" ? "R" : engineLabel(from.backend)} dataframes.`;
    case "extractStructFields":
      return `${title} needs Python · Polars, Python · DuckDB or R.`;
    case "explodeList":
      return `${title} needs Python · Polars or R.`;
    default:
      return `${title} can't run with the selected engine.`;
  }
}

/**
 * Asks only when the switch would lose work: the target has saved work that differs from this tab's, or a step cannot
 * replay there. The source engine keeps its own saved work either way.
 */
async function chooseEngineSwitchPlan(
  metadata: SessionMetadata,
  from: FileEngine,
  target: EngineSwitch
): Promise<FileReconfigurationOptions["plan"] | undefined> {
  const hasDraft = metadata.draftStep !== undefined;
  const conflicting = target.saved && !tabContainsSavedWork(metadata, target.saved) ? target.saved : undefined;
  const { blocked } = target;
  if (!conflicting && !blocked) return "current";
  if (conflicting && savedWorkContainsTab(metadata, conflicting)) return "saved";

  const toLabel = engineLabel(target.engine.backend, target.engine.rLibrary);
  const restoresSource = `Switching back to ${engineLabel(from.backend, from.rLibrary)} restores this tab's work.`;
  const draftOnly = target.portableSteps === metadata.steps.length;
  const keep = draftOnly
    ? { label: "Switch without the draft", plan: { steps: target.portableSteps } }
    : target.portableSteps > 0
      ? { label: `Replay the first ${stepsText(target.portableSteps)}`, plan: { steps: target.portableSteps } }
      : undefined;
  if (!conflicting) {
    if (!blocked) return "current";
    const fresh = "Start without steps";
    const choices = draftOnly
      ? metadata.steps.length > 0
        ? "The applied steps can move without the draft."
        : `${toLabel} can start without the draft.`
      : keep
        ? `You can replay the ${stepsText(target.portableSteps)} before it or start without steps.`
        : `${toLabel} can start without steps.`;
    const choice = await vscode.window.showWarningMessage(
      `${operationByKind(blocked.kind).title} can't run with ${toLabel}`,
      { modal: true, detail: `${blockedReason(blocked, from)} ${choices} ${restoresSource}` },
      ...(keep ? [keep.label] : []),
      ...(draftOnly ? [] : [fresh])
    );
    if (keep && choice === keep.label) return keep.plan;
    return choice === fresh ? { steps: 0 } : undefined;
  }
  const restore = "Restore saved work";
  const carry = blocked ? keep : { label: "Use this tab's work", plan: "current" as const };
  const choice = await vscode.window.showWarningMessage(
    `${toLabel} has other saved work for this file`,
    {
      modal: true,
      detail: [
        `It has ${workText(conflicting.steps.length, conflicting.draftStep !== undefined)}.`,
        `This tab has ${workText(metadata.steps.length, hasDraft)}.`,
        ...(blocked ? [blockedReason(blocked, from)] : []),
        restoresSource
      ].join(" ")
    },
    restore,
    ...(carry ? [carry.label] : [])
  );
  if (choice === restore) return "saved";
  return carry && choice === carry.label ? carry.plan : undefined;
}

function fetchGridBlockSize(
  backend?: DataBackend,
  settings = readWebviewBootstrapSettings()
): { pageSize: number; columnLimit: number } {
  const columnLimit = settings.fetchColumnBlockSize;
  const transportRowLimit = Math.floor(100_000 / columnLimit) - (backend === "pyspark" ? 2 : 0);
  const pageSize = Math.min(settings.fetchBlockSize, transportRowLimit);
  return {
    pageSize: backend === "r" ? Math.min(pageSize, 1_000) : pageSize,
    columnLimit
  };
}

function serializeBootstrapAttributes(
  settings: WebviewBootstrapSettings & { readonly canChangeImportOptions: boolean }
): string {
  return [
    ["data-fetch-block-size", settings.fetchBlockSize],
    ["data-fetch-column-block-size", settings.fetchColumnBlockSize],
    ["data-default-column-width", settings.defaultColumnWidth],
    ["data-insights-on-open", settings.insightsOnOpen],
    ["data-filter-mode", settings.filterMode],
    ["data-can-change-import-options", settings.canChangeImportOptions]
  ]
    .map(([name, value]) => `${name}="${escapeHtmlAttribute(String(value))}"`)
    .join(" ");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function panelRuntimeCleanupOptions(): BridgeRequestOptions {
  return {
    priority: "interactive",
    timeoutMs: PANEL_RUNTIME_CLEANUP_TIMEOUT_MS,
    restartRuntimeOnTimeout: false,
    startRuntimeIfNeeded: false
  };
}

function correlateViewError(request: OpenWranglerRequest, response: OpenWranglerResponse): OpenWranglerResponse {
  if ((response.kind !== "error" && response.kind !== "cancelled") || response.viewRequestId) return response;
  return { ...response, ...viewRequestIdProperty(request) };
}

function viewRequestIdProperty(request: { kind: string; viewRequestId?: unknown }): { viewRequestId?: string } {
  return typeof request.viewRequestId === "string" && request.viewRequestId
    ? { viewRequestId: request.viewRequestId }
    : {};
}

function isRecoveryForegroundRequest(
  request: OpenWranglerRequest,
  options?: BridgeRequestOptions
): request is Extract<OpenWranglerRequest, { kind: NonNullable<SessionRecoveryContext["request"]>["kind"] }> {
  return (
    (request.kind === "getPage" && options?.ephemeralPage !== true) ||
    request.kind === "previewStep" ||
    request.kind === "applyDraft" ||
    request.kind === "discardDraft" ||
    request.kind === "undoStep" ||
    request.kind === "redoStep"
  );
}

function withoutDatasetStats(metadata: SessionMetadata): SessionMetadata {
  const { stats: _stats, ...rest } = metadata;
  return rest;
}

function canChangeImportOptions(source: SessionSource): boolean {
  if (source.kind !== "file" || isDuckDBTableSource(source)) return false;
  const extension = path.extname(source.path ?? source.uri ?? "").toLowerCase();
  return extension === ".csv" || extension === ".tsv" || extension === ".xlsx" || extension === ".xls";
}

function modeName(mode: SessionMode): "Editing" | "Viewing" {
  return mode === "editing" ? "Editing" : "Viewing";
}

function fileSourceUri(source: SessionSource): vscode.Uri | undefined {
  if (source.kind !== "file") return undefined;
  if (source.uri) return vscode.Uri.parse(source.uri);
  return source.path ? vscode.Uri.file(source.path) : undefined;
}

function reconfigurationCancelledResponse(): OpenWranglerResponse {
  return { kind: "cancelled", targetRequestId: "change-import-options" };
}

type NonSortEditorAction =
  | "openOperation"
  | "editLatest"
  | "editStep"
  | "deleteStep"
  | "selectStep"
  | "clearFilterColumn"
  | "openFilters"
  | "applyDraft"
  | "discardDraft"
  | "undoStep"
  | "redoStep"
  | "goToRow";

export type EditorActionMessage =
  | ({ action: "clearFilterColumn" } & ViewFilterRemovalTarget)
  | { action: "openDatasetSummary"; expectedSessionId: string; expectedRevision: number }
  | {
      action: "changeViewSort";
      column: string;
      sortAction: "moveUp" | "moveDown" | "remove";
      expectedSessionId: string;
      expectedSortModelSignature: string;
      expectedSortIndex: number;
    }
  | {
      action: Exclude<NonSortEditorAction, "clearFilterColumn">;
      expectedSessionId?: string;
      expectedRevision?: number;
      operationKind?: OperationKind;
      stepId?: string;
      column?: string;
    };
