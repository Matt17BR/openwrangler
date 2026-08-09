import * as path from "path";
import * as vscode from "vscode";
import type {
  DataBackend,
  OpenWranglerRequest,
  OpenWranglerResponse,
  OperationKind,
  SessionMetadata,
  SessionOpenedResponse,
  SessionSource
} from "../shared/protocol";
import { supportsOperation } from "../shared/operations";
import { isOpenWranglerRequest } from "../shared/protocolValidation";
import { decodeGridViewState, type GridViewState } from "../shared/viewState";
import type { SessionOpenProgressStage } from "../shared/sessionOpenProgress";
import type { BridgeRequestOptions, OpenWranglerBridge } from "./dataBridge";
import { getSetting } from "./configuration";
import { rememberConfirmedFileConfiguration } from "./files/confirmedFileConfigurations";
import { ImportCancelledError, promptImportOptions } from "./files/importOptions";
import { automaticBackends } from "./pythonEnvironmentModel";

const PANEL_RUNTIME_CLEANUP_TIMEOUT_MS = 2_000;
const RENDERER_IMPORT_PREPARATION_TIMEOUT_MS = 1_500;
const RENDERER_STARTUP_RECOVERY_TIMEOUT_MS = 5_000;
const MAX_RENDERER_STARTUP_RECOVERY_ATTEMPTS = 2;
const RENDERER_PUBLICATION_TIMEOUT_MS = 5_000;
const RENDERER_SYNCHRONIZATION_ACK_TIMEOUT_MS = 5_000;
export const SESSION_BOUND_EXPORT_DATA_COMMAND = "openWrangler.internal.exportSessionData";

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
  private sessionId: string | undefined;
  private sessionRevision = 0;
  private snapshot: SessionOpenedResponse | undefined;
  private snapshotViewContextId: string | undefined;
  private latestPageViewRequestId: string | undefined;
  private opening: Promise<void> | undefined;
  private openResponse: OpenWranglerResponse | undefined;
  private importChangeTail: Promise<void> = Promise.resolve();
  private currentImportChangeTask: Promise<void> | undefined;
  private nativeImportCommand: Promise<boolean> | undefined;
  private runtimeDependencyInstallTask: Promise<void> | undefined;
  private sessionModeChangeTask: Promise<void> | undefined;
  private reconnectingLiveSource = false;
  private importChangeCancellation: vscode.CancellationTokenSource | undefined;
  private sessionOpenCancellation: vscode.CancellationTokenSource | undefined;
  private readonly forwardedRequests = new Set<Promise<void>>();
  private changingImportOptions = false;
  private rendererReady = false;
  private rendererGeneration = 0;
  private rendererSynchronizationIdentity:
    | {
        syncId: string;
        sessionId: string;
        revision: number;
        layoutTransitionPending: boolean;
      }
    | {
        syncId: string;
        sessionId: null;
        revision: null;
        layoutTransitionPending: false;
      }
    | undefined;
  private rendererHydratedSyncId: string | undefined;
  private rendererViewStateLocked = true;
  private rendererSynchronizationAcknowledgement:
    | {
        syncId: string;
        promise: Promise<boolean>;
        resolve: (hydrated: boolean) => void;
      }
    | undefined;
  private rendererSynchronization: Promise<void> | undefined;
  private rendererSynchronizationRequested = false;
  private rendererSynchronizationNeedsInspectionClear = false;
  private codePreviewRevealedSessionId: string | undefined;
  private pendingRendererImportAction:
    | {
        actionId: string;
        timer: ReturnType<typeof setTimeout>;
        resolve: (preparation: RendererImportPreparation | undefined) => void;
      }
    | undefined;
  private pendingPreReadyImportResponse: OpenWranglerResponse | undefined;
  private unpublishedAuthoritativeSnapshot = false;
  private rendererStartupRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private rendererStartupRecoveryAttempts = 0;
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
    private readonly bridge: OpenWranglerBridge,
    private source: SessionSource,
    private readonly backend?: DataBackend,
    openImmediately = true,
    private backendPreference: DataBackend | "auto" = backend ?? "auto"
  ) {
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "action-icon-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "action-icon-dark.svg")
    };
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))]
    };
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      undefined,
      this.disposables
    );
    this.replaceRendererHtml();
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
    return target.postRendererMessage({ kind: "editorAction", ...message });
  }

  private static visiblePanelForSession(sessionId: string): OpenWranglerPanel | undefined {
    const matches = [...OpenWranglerPanel.panels].filter(
      (panel) => !panel.disposed && panel.panel.visible && panel.sessionId === sessionId
    );
    return matches.length === 1 ? matches[0] : undefined;
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
    if (!target?.rendererReady || target.disposed) return false;
    target.invalidateRendererSynchronization();
    await target.enqueueRendererSynchronization(false);
    const synchronization = target.rendererSynchronizationIdentity;
    if (!synchronization) return false;
    return target.waitForRendererSynchronizationAcknowledgement(synchronization.syncId);
  }

  static async ensurePanelSynchronizedForSession(
    sessionId: string,
    deadlineMs = Number.POSITIVE_INFINITY
  ): Promise<boolean> {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    if (!target?.isRendererSynchronizableForSession(sessionId)) return false;

    const current = target.rendererSynchronizationIdentity;
    if (current?.sessionId === sessionId && current.revision === target.snapshot?.metadata.revision) {
      const acknowledged = await target.waitForRendererSynchronizationAcknowledgement(current.syncId, deadlineMs);
      if (acknowledged && target.rendererSynchronizationIdentity === current && target.hasHydratedRenderer()) {
        return true;
      }
      if (target.hasHydratedRenderer()) return true;
      if (!target.isRendererSynchronizableForSession(sessionId)) return false;
      // A normal renderer pull may have replaced the marker while this
      // readiness-aware test path was waiting. Never retire that newer generation.
      if (target.rendererSynchronizationIdentity !== current) return target.hasHydratedRenderer();
    }

    if (Date.now() >= deadlineMs) return false;
    target.invalidateRendererSynchronization();
    await target.enqueueRendererSynchronization(false);
    const synchronization = target.rendererSynchronizationIdentity;
    if (
      !synchronization ||
      synchronization.sessionId !== sessionId ||
      synchronization.revision !== target.snapshot?.metadata.revision
    ) {
      return false;
    }
    const acknowledged = await target.waitForRendererSynchronizationAcknowledgement(synchronization.syncId, deadlineMs);
    return acknowledged && target.rendererSynchronizationIdentity === synchronization && target.hasHydratedRenderer();
  }

  static panelSynchronizableForSession(sessionId: string): boolean {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    return target?.isRendererSynchronizableForSession(sessionId) ?? false;
  }

  static async previewStepForSessionForTesting(
    request: Extract<OpenWranglerRequest, { kind: "previewStep" }>
  ): Promise<SessionOpenedResponse | undefined> {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === request.sessionId);
    if (!target?.rendererReady || target.disposed) return undefined;
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
  ): Readonly<{ syncId: string; sessionId: string; revision: number }> | undefined {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    const synchronization = target?.rendererSynchronizationIdentity;
    return target?.hasHydratedRenderer() && synchronization?.sessionId === sessionId
      ? {
          syncId: synchronization.syncId,
          sessionId: synchronization.sessionId,
          revision: synchronization.revision
        }
      : undefined;
  }

  static openResponseForTesting(): OpenWranglerResponse | undefined {
    return OpenWranglerPanel.activePanel?.openResponse ?? [...OpenWranglerPanel.panels].at(-1)?.openResponse;
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
    backendPreference: DataBackend | "auto" = backend ?? "auto"
  ): OpenWranglerPanel {
    const panel = vscode.window.createWebviewPanel(
      "openWrangler.session",
      `Open Wrangler: ${source.label}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))]
      }
    );

    return new OpenWranglerPanel(panel, context, bridge, source, backend, true, backendPreference);
  }

  async open(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.disposed || this.sessionId) return;
    const { pageSize, columnLimit } = fetchGridBlockSize(this.backend);
    const isFile = this.source.kind === "file" || this.source.kind === "documentVariable";
    const mode =
      this.backend === "pyspark"
        ? "viewing"
        : getSetting<"editing" | "viewing">(
            isFile ? "fileStartMode" : "notebookStartMode",
            isFile ? "editing" : "viewing"
          );
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.openAttemptGeneration += 1;
    this.activeSessionOpenProgressGeneration = undefined;
    this.sessionOpenProgress = undefined;
    this.sessionOpenCancellation?.cancel();
    this.sessionOpenCancellation?.dispose();
    this.sessionOpenCancellation = undefined;
    this.importChangeCancellation?.cancel();
    this.importChangeCancellation?.dispose();
    this.importChangeCancellation = undefined;
    this.clearRendererStartupRecoveryTimer();
    this.settleRendererImportAction(undefined, undefined);
    this.settleRendererSynchronizationAcknowledgement(undefined, false);
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
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const decoded = this.decodeWebviewMessage(message);
    if (!decoded) {
      return;
    }

    if (decoded.kind === "ready") {
      this.clearRendererStartupRecoveryTimer();
      this.rendererReady = true;
      this.invalidateRendererSynchronization();
      await this.publishSessionOpenProgress();
      if (!this.rendererReady) return;
      await this.enqueueRendererSynchronization(true);
      this.scheduleRendererStartupRecovery();
      return;
    }

    if (decoded.kind === "requestSessionSnapshot") {
      this.clearRendererStartupRecoveryTimer();
      this.rendererReady = true;
      this.invalidateRendererSynchronization();
      await this.publishSessionOpenProgress();
      if (!this.rendererReady) return;
      await this.enqueueRendererSynchronization(false);
      this.scheduleRendererStartupRecovery();
      return;
    }

    if (decoded.kind === "rendererSynchronized") {
      const synchronization = this.rendererSynchronizationIdentity;
      if (
        synchronization?.syncId === decoded.syncId &&
        synchronization.sessionId === decoded.sessionId &&
        synchronization.revision === decoded.revision
      ) {
        this.rendererHydratedSyncId = decoded.syncId;
        this.rendererViewStateLocked = false;
        this.pendingPreReadyImportResponse = undefined;
        this.clearRendererStartupRecoveryTimer();
        this.rendererStartupRecoveryAttempts = 0;
        this.settleRendererSynchronizationAcknowledgement(decoded.syncId, true);
        this.revealCodePreviewAfterRendererSynchronization(synchronization);
      }
      return;
    }

    if (decoded.kind === "setViewContext") {
      this.snapshotViewContextId = decoded.viewContextId;
      if (this.sessionId) this.bridge.setViewContext?.(this.sessionId, decoded.viewContextId);
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
      if (this.changingImportOptions || this.rendererViewStateLocked) {
        await this.postViewState();
      } else if (this.sessionId) {
        await this.bridge.updateViewState?.(this.sessionId, decoded.state);
      }
      return;
    }

    if (decoded.kind === "clearStepInspection") {
      if (this.sessionId) this.bridge.clearStepInspection?.(this.sessionId);
      return;
    }

    if (decoded.kind === "changeImportOptions") {
      let task: Promise<void>;
      if (decoded.actionId !== undefined) {
        if (this.pendingRendererImportAction?.actionId !== decoded.actionId) return;
        task = this.enqueueImportOptionsChange();
        this.settleRendererImportAction(decoded.actionId, { task });
      } else if (this.nativeImportCommand && this.currentImportChangeTask) {
        task = this.currentImportChangeTask;
        this.settleRendererImportAction(undefined, { task });
      } else {
        task = this.enqueueImportOptionsChange();
        this.settleRendererImportAction(undefined, { task });
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

    if (decoded.kind === "exportData") {
      const sessionId = this.sessionId;
      const revision = this.sessionRevision;
      if (!sessionId) return;
      await vscode.commands.executeCommand(SESSION_BOUND_EXPORT_DATA_COMMAND, sessionId, revision);
      return;
    }

    if (decoded.kind === "switchSessionToEditing") {
      await this.switchSessionToEditing(decoded.state);
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
    if (request.kind === "previewStep" && request.step.kind === "customCode" && !vscode.workspace.isTrusted) {
      await this.post({
        kind: "error",
        code: "workspace_untrusted",
        message: "Trust this workspace before running custom Python code.",
        recoverable: true
      });
      return;
    }
    await this.forward(
      request,
      decoded.viewContextId,
      decoded.priority === undefined ? undefined : { priority: decoded.priority }
    );
  }

  private switchSessionToEditing(viewState: GridViewState): Promise<void> {
    if (this.sessionModeChangeTask) return this.sessionModeChangeTask;
    const task = (async () => {
      const sessionId = this.sessionId;
      const revision = this.sessionRevision;
      const metadata = this.snapshot?.metadata;
      if (!sessionId || !metadata || !canSwitchLiveSessionToEditing(metadata) || this.disposed) return;
      if (!this.bridge.reconfigureNotebookSessionForEditing) {
        await this.post({
          kind: "error",
          code: "editing_mode_unavailable",
          message: "This Open Wrangler session cannot switch to Editing mode.",
          recoverable: true,
          sessionId
        });
        return;
      }

      await this.postRendererMessage({ kind: "sessionModeChangeState", busy: true });
      try {
        const response = await this.bridge.reconfigureNotebookSessionForEditing(sessionId, revision, viewState, {
          priority: "interactive",
          backendPreference: this.backendPreference
        });
        if (this.disposed || this.sessionId !== sessionId || this.sessionRevision !== revision) return;
        if (response.kind === "sessionOpened") {
          if (
            response.metadata.sessionId !== sessionId ||
            response.metadata.revision <= revision ||
            response.metadata.mode !== "editing" ||
            response.metadata.source.kind !== metadata.source.kind
          ) {
            await this.post({
              kind: "error",
              code: "invalid_runtime_response",
              message: "Open Wrangler rejected an invalid Editing-mode response.",
              recoverable: true,
              sessionId
            });
            return;
          }
          this.invalidateRendererSynchronization();
          this.source = response.metadata.source;
          this.openResponse = response;
          this.sessionId = response.metadata.sessionId;
          this.sessionRevision = response.metadata.revision;
          this.snapshot = response;
          this.snapshotViewContextId = undefined;
          this.latestPageViewRequestId = undefined;
          await this.post(response);
          await this.postSessionPresentation();
          await this.postViewState();
          if (this.rendererReady) this.scheduleRendererSynchronization(false);
          return;
        }
        await this.post(response);
      } catch (error) {
        if (this.disposed || this.sessionId !== sessionId || this.sessionRevision !== revision) return;
        await this.post({
          kind: "error",
          code: "editing_mode_open_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
          sessionId
        });
      } finally {
        if (!this.disposed) {
          await this.postRendererMessage({ kind: "sessionModeChangeState", busy: false });
        }
      }
    })();
    this.sessionModeChangeTask = task;
    void task.then(
      () => {
        if (this.sessionModeChangeTask === task) this.sessionModeChangeTask = undefined;
      },
      () => {
        if (this.sessionModeChangeTask === task) this.sessionModeChangeTask = undefined;
      }
    );
    return task;
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
        await this.post(response);
        await this.postSessionPresentation();
        await this.postViewState();
        if (this.rendererReady) this.scheduleRendererSynchronization(false);
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
    const generation = ++this.openAttemptGeneration;
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

  private enqueueBackendChange(): Promise<void> {
    const generation = ++this.openAttemptGeneration;
    this.importChangeCancellation?.cancel();
    const task = this.importChangeTail.catch(() => undefined).then(() => this.changeBackend(generation));
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
      await this.opening?.catch(() => undefined);
      if (
        this.disposed ||
        this.sessionId ||
        this.openResponse?.kind !== "error" ||
        this.openResponse.code !== "missing_dependencies"
      ) {
        return;
      }
      await this.postRendererMessage({ kind: "runtimeDependencyInstallState", busy: true });
      try {
        const installed = await vscode.commands.executeCommand<boolean>("openWrangler.installRuntimeDependencies");
        if (!installed || this.disposed || this.sessionId) return;
        this.openResponse = undefined;
        await this.open();
      } catch (error) {
        if (!this.disposed) {
          await this.post({
            kind: "error",
            code: "dependency_install_failed",
            message: error instanceof Error ? error.message : String(error),
            recoverable: true
          });
        }
      } finally {
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

      if (!this.bridge.reconfigureFileSession) {
        await this.postUnpublishedAuthoritativeSnapshot();
        await this.postImportResponse({
          kind: "error",
          code: "import_reconfiguration_unavailable",
          message: "This Open Wrangler session does not support changing import options.",
          recoverable: true
        });
        return;
      }
      const response = await this.bridge.reconfigureFileSession(this.sessionId, this.sessionRevision, nextSource, {
        cancellation: cancellation.token
      });
      if (response.kind === "sessionOpened") {
        this.invalidateRendererSynchronization();
        this.source = response.metadata.source;
        this.openResponse = response;
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.metadata.revision;
        this.snapshot = response;
        this.snapshotViewContextId = undefined;
        this.latestPageViewRequestId = undefined;
        this.unpublishedAuthoritativeSnapshot = true;
        await this.rememberConfirmedFileImportOptions(response.metadata.source, response.metadata.backend);
      }
      if (this.disposed || generation !== this.openAttemptGeneration) return;
      if (response.kind === "sessionOpened") {
        if (OpenWranglerPanel.activePanel === this) this.bridge.setActiveSession?.(this.sessionId);
      }
      if (response.kind !== "sessionOpened") await this.postUnpublishedAuthoritativeSnapshot();
      await this.postImportResponse(response);
      if (response.kind === "sessionOpened") {
        this.unpublishedAuthoritativeSnapshot = false;
        await this.postSessionPresentation();
        await this.postViewState();
      }
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
      if (this.importChangeCancellation === cancellation) {
        this.importChangeCancellation = undefined;
        cancellation.dispose();
      }
      if (!this.disposed && generation === this.openAttemptGeneration) {
        this.changingImportOptions = false;
        await this.postRendererMessage({ kind: "importOptionsState", busy: false });
        if (this.rendererReady) await this.enqueueRendererSynchronization(false);
      }
    }
  }

  private async changeBackend(generation: number): Promise<void> {
    if (
      this.disposed ||
      generation !== this.openAttemptGeneration ||
      this.source.kind !== "file" ||
      !this.sessionId ||
      !this.snapshot ||
      !this.bridge.reconfigureFileSession
    ) {
      return;
    }
    if (this.opening) {
      await this.opening.catch(() => undefined);
      if (this.disposed || generation !== this.openAttemptGeneration || !this.sessionId || !this.snapshot) return;
    }

    const cancellation = new vscode.CancellationTokenSource();
    this.importChangeCancellation?.dispose();
    this.importChangeCancellation = cancellation;
    this.changingImportOptions = true;
    try {
      await this.postRendererMessage({ kind: "importOptionsState", busy: true });
      const compatibleBackends = automaticBackends(this.source);
      const currentBackend = this.snapshot.metadata.backend;
      const backend = (
        await vscode.window.showQuickPick(
          compatibleBackends.map((candidate) => ({
            label: backendDisplayName(candidate),
            description: candidate === currentBackend ? "Current" : undefined,
            backend: candidate
          })),
          {
            title: "Dataframe engine",
            placeHolder: `Current engine: ${backendDisplayName(currentBackend)}`,
            matchOnDescription: true
          },
          cancellation.token
        )
      )?.backend;
      if (
        !backend ||
        cancellation.token.isCancellationRequested ||
        this.disposed ||
        generation !== this.openAttemptGeneration
      ) {
        return;
      }
      if (!compatibleBackends.includes(backend)) {
        await this.post({
          kind: "error",
          code: "unsupported_backend",
          message: `${backendDisplayName(backend)} cannot open this file with its current import options.`,
          recoverable: true,
          sessionId: this.sessionId
        });
        return;
      }
      if (backend === currentBackend) return;

      const metadata = this.snapshot.metadata;
      if (metadata.steps.length > 0 || metadata.draftStep) {
        const applied = metadata.steps.length;
        const planDescription = [
          applied > 0 ? `${applied} applied ${applied === 1 ? "step" : "steps"}` : undefined,
          metadata.draftStep ? "the current draft" : undefined
        ]
          .filter((value): value is string => Boolean(value))
          .join(" and ");
        const confirmation = await vscode.window.showWarningMessage(
          `Switch to ${backendDisplayName(backend)}?`,
          {
            modal: true,
            detail: `Open Wrangler will replay ${planDescription} with ${backendDisplayName(backend)}. If replay fails, the current ${backendDisplayName(currentBackend)} session stays open.`
          },
          "Replay and switch"
        );
        if (
          confirmation !== "Replay and switch" ||
          cancellation.token.isCancellationRequested ||
          this.disposed ||
          generation !== this.openAttemptGeneration
        ) {
          return;
        }
      }

      await this.drainForwardedRequests();
      if (
        this.disposed ||
        generation !== this.openAttemptGeneration ||
        cancellation.token.isCancellationRequested ||
        !this.sessionId
      ) {
        return;
      }
      const response = await this.bridge.reconfigureFileSession(this.sessionId, this.sessionRevision, this.source, {
        cancellation: cancellation.token,
        backendPreference: backend
      });
      if (response.kind === "sessionOpened") {
        this.invalidateRendererSynchronization();
        this.backendPreference = backend;
        this.source = response.metadata.source;
        this.openResponse = response;
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.metadata.revision;
        this.snapshot = response;
        this.snapshotViewContextId = undefined;
        this.latestPageViewRequestId = undefined;
        this.unpublishedAuthoritativeSnapshot = true;
        await this.rememberConfirmedFileImportOptions(response.metadata.source, response.metadata.backend);
        if (OpenWranglerPanel.activePanel === this) this.bridge.setActiveSession?.(this.sessionId);
      } else {
        await this.postUnpublishedAuthoritativeSnapshot();
      }
      if (this.disposed || generation !== this.openAttemptGeneration) return;
      await this.postImportResponse(response);
      if (response.kind === "sessionOpened") {
        this.unpublishedAuthoritativeSnapshot = false;
        await this.postSessionPresentation();
        await this.postViewState();
      }
    } catch (error) {
      if (this.disposed || generation !== this.openAttemptGeneration) return;
      await this.postUnpublishedAuthoritativeSnapshot();
      await this.postImportResponse({
        kind: "error",
        code: "bridge_error",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
        sessionId: this.sessionId
      });
    } finally {
      if (this.importChangeCancellation === cancellation) {
        this.importChangeCancellation = undefined;
        cancellation.dispose();
      }
      if (!this.disposed && generation === this.openAttemptGeneration) {
        this.changingImportOptions = false;
        await this.postRendererMessage({ kind: "importOptionsState", busy: false });
        if (this.rendererReady) await this.enqueueRendererSynchronization(false);
      }
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
      mode: getSetting<"editing" | "viewing">("fileStartMode", "editing")
    };
  }

  private forward(
    request: OpenWranglerRequest,
    viewContextId?: string,
    requestOptions?: BridgeRequestOptions,
    openAttemptGeneration?: number
  ): Promise<void> {
    const task = this.forwardRequest(request, viewContextId, requestOptions, openAttemptGeneration);
    this.forwardedRequests.add(task);
    void task.then(
      () => this.forwardedRequests.delete(task),
      () => this.forwardedRequests.delete(task)
    );
    return task;
  }

  private async drainForwardedRequests(): Promise<void> {
    while (this.forwardedRequests.size > 0) {
      await Promise.allSettled([...this.forwardedRequests]);
    }
  }

  private async forwardRequest(
    request: OpenWranglerRequest,
    viewContextId?: string,
    requestOptions?: BridgeRequestOptions,
    openAttemptGeneration?: number
  ): Promise<void> {
    if (request.kind === "getPage") this.latestPageViewRequestId = request.viewRequestId;
    try {
      const bridgeOptions: BridgeRequestOptions | undefined =
        viewContextId || requestOptions
          ? {
              ...requestOptions,
              ...(viewContextId ? { viewContextId } : {})
            }
          : undefined;
      const response = correlateViewError(request, await this.bridge.request(request, bridgeOptions));
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
      if (request.kind === "openSession") {
        this.openResponse = response;
        this.scheduleRendererStartupRecovery();
      }
      if (response.kind === "sessionOpened") {
        this.invalidateRendererSynchronization();
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.metadata.revision;
        this.snapshot = response;
        this.snapshotViewContextId = undefined;
        if (OpenWranglerPanel.activePanel === this) this.bridge.setActiveSession?.(this.sessionId);
      }
      if (request.kind === "openSession" && response.kind === "sessionOpened") {
        await this.rememberConfirmedFileImportOptions(response.metadata.source, response.metadata.backend);
      }
      if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
        if (response.kind !== "page") this.invalidateRendererSynchronization();
        const acceptsPage =
          response.kind !== "page" ||
          (request.kind === "getPage" &&
            response.viewRequestId === request.viewRequestId &&
            this.latestPageViewRequestId === response.viewRequestId);
        if (acceptsPage) {
          this.sessionId = response.metadata.sessionId;
          this.sessionRevision = response.revision;
          if (response.kind !== "page") this.latestPageViewRequestId = undefined;
        }
        if (this.snapshot && acceptsPage) {
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
      let published = await this.postRuntimeResponse(request, response);
      if (response.kind === "sessionOpened" && published) published = await this.postSessionPresentation();
      if (
        published &&
        (response.kind === "sessionOpened" || response.kind === "stepPreview" || response.kind === "planUpdated")
      ) {
        published = await this.postViewState();
        if (published && this.rendererReady) this.scheduleRendererSynchronization(false);
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
      if (request.kind === "openSession") {
        this.openResponse = response;
        this.scheduleRendererStartupRecovery();
      }
      await this.postRuntimeResponse(request, response);
      if (request.kind === "openSession" && this.rendererReady) this.scheduleRendererSynchronization(false);
    }
  }

  private post(response: OpenWranglerResponse): Promise<boolean> {
    return this.postRendererMessage(response);
  }

  private async postRendererMessage(message: unknown): Promise<boolean> {
    if (this.disposed) return false;
    const generation = this.rendererGeneration;
    const rendererReadyAtPublication = this.rendererReady;
    const hydratedSyncIdAtPublication = this.hasHydratedRenderer() ? this.rendererHydratedSyncId : undefined;
    let publication: Thenable<boolean>;
    try {
      publication = this.panel.webview.postMessage(message);
    } catch {
      this.handleRendererPublicationFailure(generation, rendererReadyAtPublication, hydratedSyncIdAtPublication);
      return false;
    }

    const posted = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (delivered: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(delivered);
      };
      const timer = setTimeout(() => finish(false), RENDERER_PUBLICATION_TIMEOUT_MS);
      void Promise.resolve(publication).then(
        (delivered) => finish(delivered),
        () => finish(false)
      );
    });
    if (!posted) {
      this.handleRendererPublicationFailure(generation, rendererReadyAtPublication, hydratedSyncIdAtPublication);
    }
    return posted && !this.disposed && generation === this.rendererGeneration;
  }

  private handleRendererPublicationFailure(
    generation: number,
    rendererReadyAtPublication: boolean,
    hydratedSyncIdAtPublication: string | undefined
  ): void {
    if (this.disposed || generation !== this.rendererGeneration) return;
    if (this.hasHydratedRenderer() && this.rendererHydratedSyncId !== hydratedSyncIdAtPublication) return;
    if (!rendererReadyAtPublication) {
      this.scheduleRendererStartupRecovery();
      return;
    }
    this.rendererReady = false;
    this.invalidateRendererSynchronization();
    if (this.recoverRendererAfterStartupStall()) return;
    this.scheduleRendererStartupRecovery();
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
    if (!this.disposed && this.rendererReady) {
      await this.enqueueSessionOpenProgressPublication(null);
    }
  }

  private publishSessionOpenProgress(): Promise<void> {
    if (this.disposed || !this.rendererReady || !this.sessionOpenProgress) return Promise.resolve();
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
    if (response.kind === "sessionOpened") {
      if (this.pendingPreReadyImportResponse) this.invalidateRendererSynchronization();
      this.pendingPreReadyImportResponse = undefined;
    } else {
      this.pendingPreReadyImportResponse = response;
      this.invalidateRendererSynchronization();
    }
    await this.post(response);
  }

  private hasHydratedRenderer(): boolean {
    const synchronization = this.rendererSynchronizationIdentity;
    return Boolean(
      this.hasSynchronizedRenderer() &&
      this.snapshot &&
      synchronization &&
      synchronization.sessionId === this.snapshot.metadata.sessionId &&
      synchronization.revision === this.snapshot.metadata.revision
    );
  }

  private hasSynchronizedRenderer(): boolean {
    const synchronization = this.rendererSynchronizationIdentity;
    return Boolean(this.rendererReady && synchronization && this.rendererHydratedSyncId === synchronization.syncId);
  }

  private isRendererSynchronizableForSession(sessionId: string): boolean {
    return Boolean(
      !this.disposed &&
      !this.opening &&
      this.rendererReady &&
      this.sessionId === sessionId &&
      this.snapshot?.metadata.sessionId === sessionId
    );
  }

  private invalidateRendererSynchronization(): void {
    this.settleRendererSynchronizationAcknowledgement(undefined, false);
    this.rendererSynchronizationIdentity = undefined;
    this.rendererHydratedSyncId = undefined;
    this.rendererViewStateLocked = true;
    this.settleRendererImportAction(undefined, undefined);
  }

  private waitForRendererSynchronizationAcknowledgement(
    syncId: string,
    deadlineMs = Number.POSITIVE_INFINITY
  ): Promise<boolean> {
    if (this.hasHydratedRenderer() && this.rendererHydratedSyncId === syncId) return Promise.resolve(true);
    const acknowledgement = this.rendererSynchronizationAcknowledgement;
    if (!acknowledgement || acknowledgement.syncId !== syncId) return Promise.resolve(false);
    const timeoutMs = Math.min(RENDERER_SYNCHRONIZATION_ACK_TIMEOUT_MS, Math.max(0, deadlineMs - Date.now()));
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (hydrated: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(hydrated);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void acknowledgement.promise.then(finish);
    });
  }

  private settleRendererSynchronizationAcknowledgement(syncId: string | undefined, hydrated: boolean): boolean {
    const acknowledgement = this.rendererSynchronizationAcknowledgement;
    if (!acknowledgement || (syncId !== undefined && acknowledgement.syncId !== syncId)) return false;
    this.rendererSynchronizationAcknowledgement = undefined;
    acknowledgement.resolve(hydrated);
    return true;
  }

  private scheduleRendererStartupRecovery(): void {
    if (
      this.disposed ||
      this.hasSynchronizedRenderer() ||
      this.rendererStartupRecoveryAttempts >= MAX_RENDERER_STARTUP_RECOVERY_ATTEMPTS ||
      this.rendererStartupRecoveryTimer ||
      !this.openResponse ||
      !this.panel.visible
    ) {
      return;
    }
    this.rendererStartupRecoveryTimer = setTimeout(() => {
      this.rendererStartupRecoveryTimer = undefined;
      this.recoverRendererAfterStartupStall();
    }, RENDERER_STARTUP_RECOVERY_TIMEOUT_MS);
  }

  private recoverRendererAfterStartupStall(): boolean {
    if (
      this.disposed ||
      this.hasSynchronizedRenderer() ||
      this.rendererStartupRecoveryAttempts >= MAX_RENDERER_STARTUP_RECOVERY_ATTEMPTS ||
      !this.openResponse ||
      !this.panel.visible
    ) {
      return false;
    }
    this.clearRendererStartupRecoveryTimer();
    this.rendererStartupRecoveryAttempts += 1;
    this.replaceRendererHtml();
    this.scheduleRendererStartupRecovery();
    this.bridge.reportDiagnostic?.("Open Wrangler reloaded a renderer that did not complete its startup handshake.");
    return true;
  }

  private replaceRendererHtml(): void {
    this.rendererGeneration += 1;
    this.rendererReady = false;
    this.invalidateRendererSynchronization();
    this.panel.webview.html = this.renderHtml();
  }

  private clearRendererStartupRecoveryTimer(): void {
    if (!this.rendererStartupRecoveryTimer) return;
    clearTimeout(this.rendererStartupRecoveryTimer);
    this.rendererStartupRecoveryTimer = undefined;
  }

  private codePreviewLayoutTransitionPending(): boolean {
    const snapshot = this.snapshot;
    if (!snapshot || !this.panel.active || OpenWranglerPanel.activePanel !== this) return false;
    const behavior = getSetting<"onDraft" | "always" | "never">("panelRevealBehavior", "onDraft");
    const draftStepId = snapshot.metadata.draftStep?.id;
    const changedSession = this.codePreviewRevealedSessionId !== snapshot.metadata.sessionId;
    if (behavior === "never") return false;

    return changedSession && (behavior === "always" || draftStepId !== undefined);
  }

  private revealCodePreviewAfterRendererSynchronization(
    synchronization: NonNullable<OpenWranglerPanel["rendererSynchronizationIdentity"]>
  ): void {
    if (!synchronization.layoutTransitionPending) return;
    const snapshot = this.snapshot;
    const canReveal =
      snapshot !== undefined &&
      synchronization.sessionId === snapshot.metadata.sessionId &&
      synchronization.revision === snapshot.metadata.revision &&
      this.hasHydratedRenderer() &&
      this.codePreviewLayoutTransitionPending();
    if (!canReveal || !snapshot) {
      this.scheduleRendererSynchronization(false);
      return;
    }

    this.codePreviewRevealedSessionId = snapshot.metadata.sessionId;
    void vscode.commands.executeCommand("openWrangler.codePreview.focus", { preserveFocus: true }).then(
      () => {
        if (!this.disposed) this.scheduleRendererSynchronization(false);
      },
      (error: unknown) => {
        this.bridge.reportDiagnostic?.(
          `Open Wrangler could not reveal Code Preview: ${error instanceof Error ? error.message : String(error)}`
        );
        if (!this.disposed) this.scheduleRendererSynchronization(false);
      }
    );
  }

  private requestRendererImportOptionsChange(): Promise<RendererImportPreparation | undefined> {
    if (!this.hasHydratedRenderer()) return Promise.resolve(undefined);
    this.settleRendererImportAction(undefined, undefined);
    const actionId = randomNonce();
    return new Promise<RendererImportPreparation | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.settleRendererImportAction(actionId, undefined);
      }, RENDERER_IMPORT_PREPARATION_TIMEOUT_MS);
      this.pendingRendererImportAction = { actionId, timer, resolve };
      void this.panel.webview.postMessage({ kind: "requestImportOptionsChange", actionId }).then(
        (posted) => {
          if (!posted) this.settleRendererImportAction(actionId, undefined);
        },
        () => this.settleRendererImportAction(actionId, undefined)
      );
    });
  }

  private settleRendererImportAction(
    actionId: string | undefined,
    preparation: RendererImportPreparation | undefined
  ): boolean {
    const pending = this.pendingRendererImportAction;
    if (!pending || (actionId !== undefined && pending.actionId !== actionId)) return false;
    this.pendingRendererImportAction = undefined;
    clearTimeout(pending.timer);
    pending.resolve(preparation);
    return true;
  }

  private scheduleRendererSynchronization(clearInspection: boolean): void {
    void this.enqueueRendererSynchronization(clearInspection).catch(() => {
      this.bridge.reportDiagnostic?.("Open Wrangler could not synchronize the active editor renderer.");
    });
  }

  private enqueueRendererSynchronization(clearInspection: boolean): Promise<void> {
    this.rendererSynchronizationRequested = true;
    this.rendererSynchronizationNeedsInspectionClear ||= clearInspection;
    if (this.rendererSynchronization) return this.rendererSynchronization;

    const synchronization = (async () => {
      try {
        do {
          this.rendererSynchronizationRequested = false;
          const shouldClearInspection = this.rendererSynchronizationNeedsInspectionClear;
          this.rendererSynchronizationNeedsInspectionClear = false;
          await this.synchronizeRenderer(shouldClearInspection);
        } while (!this.disposed && this.rendererSynchronizationRequested);
      } finally {
        this.rendererSynchronization = undefined;
      }
    })();
    this.rendererSynchronization = synchronization;
    return synchronization;
  }

  private async synchronizeRenderer(clearInspection: boolean): Promise<void> {
    if (this.disposed || !this.rendererReady) return;
    const generation = this.rendererGeneration;
    this.rendererViewStateLocked = true;
    if (clearInspection) {
      if (this.sessionId) this.bridge.clearStepInspection?.(this.sessionId);
      await this.postStepInspectionCleared(false);
    }
    if (!this.snapshot && !this.openResponse) await this.open();
    if (this.disposed || !this.rendererReady || generation !== this.rendererGeneration) return;
    const synchronization = this.snapshot
      ? {
          syncId: randomNonce(),
          sessionId: this.snapshot.metadata.sessionId,
          revision: this.snapshot.metadata.revision,
          layoutTransitionPending: this.codePreviewLayoutTransitionPending()
        }
      : {
          syncId: randomNonce(),
          sessionId: null,
          revision: null,
          layoutTransitionPending: false as const
        };
    this.settleRendererImportAction(undefined, undefined);
    this.settleRendererSynchronizationAcknowledgement(undefined, false);
    this.rendererSynchronizationIdentity = synchronization;
    this.rendererHydratedSyncId = undefined;
    let resolveAcknowledgement!: (hydrated: boolean) => void;
    const acknowledgement = new Promise<boolean>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    this.rendererSynchronizationAcknowledgement = {
      syncId: synchronization.syncId,
      promise: acknowledgement,
      resolve: resolveAcknowledgement
    };
    if (this.snapshot) {
      if (!(await this.post(this.snapshot))) return;
      if (!(await this.postSessionPresentation())) return;
      if (!(await this.postViewState())) return;
      this.unpublishedAuthoritativeSnapshot = false;
    } else if (this.openResponse) {
      if (!(await this.post(this.openResponse))) return;
    }
    if (this.pendingPreReadyImportResponse) {
      if (!(await this.post(this.pendingPreReadyImportResponse))) return;
    }
    if (!(await this.postRendererMessage({ kind: "importOptionsState", busy: this.changingImportOptions }))) return;
    if (this.rendererSynchronizationIdentity !== synchronization) {
      this.rendererSynchronizationRequested = true;
      return;
    }
    await this.postRendererMessage({ kind: "rendererSynchronization", ...synchronization });
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

  private async postViewState(): Promise<boolean> {
    if (!this.sessionId) return true;
    const state = this.bridge.getViewState?.(this.sessionId);
    return state ? this.postRendererMessage({ kind: "viewState", state }) : true;
  }

  private async postSessionPresentation(): Promise<boolean> {
    if (!this.sessionId) return true;
    const presentation = this.bridge.getSessionPresentation?.(this.sessionId);
    if (presentation && presentation.sessionId === this.sessionId && presentation.revision === this.sessionRevision) {
      return this.postRendererMessage({ kind: "sessionPresentation", presentation });
    }
    return true;
  }

  private async postUnpublishedAuthoritativeSnapshot(): Promise<void> {
    if (!this.unpublishedAuthoritativeSnapshot || !this.snapshot) return;
    this.unpublishedAuthoritativeSnapshot = false;
    if (!(await this.post(this.snapshot))) return;
    if (!(await this.postSessionPresentation())) return;
    await this.postViewState();
  }

  private async rememberConfirmedFileImportOptions(source: SessionSource, backend: DataBackend): Promise<void> {
    const uri = fileSourceUri(source);
    if (!uri) return;
    try {
      await rememberConfirmedFileConfiguration(
        this.context.workspaceState,
        uri,
        source.importOptions,
        backend,
        this.backendPreference
      );
    } catch (error) {
      this.bridge.reportDiagnostic?.(
        `Open Wrangler could not remember confirmed import options for ${source.label}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private decodeWebviewMessage(message: unknown): WebviewRequest | undefined {
    if (!isRecord(message) || typeof message.kind !== "string") return undefined;
    if (message.kind === "ready") {
      return hasExactKeys(message, ["kind"]) ? { kind: "ready" } : undefined;
    }
    if (message.kind === "requestSessionSnapshot") {
      return hasExactKeys(message, ["kind"]) ? { kind: "requestSessionSnapshot" } : undefined;
    }
    if (message.kind === "rendererSynchronized") {
      const hasSessionIdentity =
        isNonEmptyString(message.sessionId) && Number.isSafeInteger(message.revision) && Number(message.revision) >= 0;
      const hasNoSessionIdentity = message.sessionId === null && message.revision === null;
      return hasExactKeys(message, ["kind", "syncId", "sessionId", "revision"]) &&
        isRendererControlId(message.syncId) &&
        (hasSessionIdentity || hasNoSessionIdentity)
        ? {
            kind: "rendererSynchronized",
            syncId: message.syncId,
            sessionId: hasSessionIdentity ? String(message.sessionId) : null,
            revision: hasSessionIdentity ? Number(message.revision) : null
          }
        : undefined;
    }
    if (message.kind === "setViewContext") {
      return hasExactKeys(message, ["kind", "viewContextId"]) && isNonEmptyString(message.viewContextId)
        ? { kind: "setViewContext", viewContextId: message.viewContextId }
        : undefined;
    }
    if (message.kind === "cancelViewRequests") {
      return hasExactKeys(message, ["kind", "viewRequestIds"]) &&
        Array.isArray(message.viewRequestIds) &&
        message.viewRequestIds.every(isNonEmptyString)
        ? { kind: "cancelViewRequests", viewRequestIds: [...message.viewRequestIds] }
        : undefined;
    }
    if (message.kind === "prioritizeViewRequest") {
      return hasExactKeys(message, ["kind", "viewRequestId"]) && isNonEmptyString(message.viewRequestId)
        ? { kind: "prioritizeViewRequest", viewRequestId: message.viewRequestId }
        : undefined;
    }
    if (message.kind === "updateViewState") {
      if (!hasExactKeys(message, ["kind", "state"])) return undefined;
      const state = decodeGridViewState(message.state);
      return state ? { kind: "updateViewState", state } : undefined;
    }
    if (message.kind === "clearStepInspection") {
      return hasExactKeys(message, ["kind"]) ? { kind: "clearStepInspection" } : undefined;
    }
    if (message.kind === "changeImportOptions") {
      return hasExactKeys(message, ["kind"], ["actionId"]) &&
        (message.actionId === undefined || isRendererControlId(message.actionId))
        ? {
            kind: "changeImportOptions",
            ...(message.actionId === undefined ? {} : { actionId: message.actionId })
          }
        : undefined;
    }
    if (message.kind === "changeBackend") {
      return hasExactKeys(message, ["kind"]) ? { kind: "changeBackend" } : undefined;
    }
    if (message.kind === "installRuntimeDependencies") {
      return hasExactKeys(message, ["kind"]) ? { kind: "installRuntimeDependencies" } : undefined;
    }
    if (message.kind === "exportData") {
      return hasExactKeys(message, ["kind"]) ? { kind: "exportData" } : undefined;
    }
    if (message.kind === "switchSessionToEditing") {
      if (!hasExactKeys(message, ["kind", "state"])) return undefined;
      const state = decodeGridViewState(message.state);
      return state ? { kind: "switchSessionToEditing", state } : undefined;
    }
    if (message.kind === "reconnectLiveSource") {
      return hasExactKeys(message, ["kind"]) ? { kind: "reconnectLiveSource" } : undefined;
    }
    if (
      message.kind !== "runtimeRequest" ||
      !hasExactKeys(message, ["kind", "request"], ["viewContextId", "priority"]) ||
      !isRecord(message.request) ||
      Object.prototype.hasOwnProperty.call(message.request, "sessionId") ||
      Object.prototype.hasOwnProperty.call(message.request, "revision") ||
      (message.viewContextId !== undefined && !isNonEmptyString(message.viewContextId)) ||
      (message.priority !== undefined && message.priority !== "interactive" && message.priority !== "background")
    ) {
      return undefined;
    }
    const request = {
      ...message.request,
      sessionId: this.sessionId ?? "pending-session",
      revision: this.sessionRevision
    };
    if (!isOpenWranglerRequest(request) || !WEBVIEW_RUNTIME_REQUEST_KINDS.has(request.kind)) return undefined;
    if (message.priority !== undefined && request.kind !== "getSummary" && request.kind !== "getDatasetStats") {
      return undefined;
    }
    if (
      request.kind === "previewStep" &&
      (!this.snapshot || !supportsOperation(this.snapshot.metadata.capabilities, request.step.kind))
    ) {
      return undefined;
    }
    return {
      kind: "runtimeRequest",
      request,
      ...(message.viewContextId === undefined ? {} : { viewContextId: message.viewContextId }),
      ...(message.priority === undefined ? {} : { priority: message.priority })
    };
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "webview.js"))
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "webview.css"))
    );
    const nonce = randomNonce();
    const { pageSize: fetchBlockSize, columnLimit: columnBlockSize } = fetchGridBlockSize(this.backend);
    const defaultColumnWidth = getSetting<number>("defaultColumnWidth", 190);
    const insightsOnOpen = getSetting<boolean>("insightsOnOpen", true);
    const filterMode = getSetting<"basic" | "advanced">("filterMode", "basic");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Open Wrangler</title>
</head>
<body data-fetch-block-size="${fetchBlockSize}" data-fetch-column-block-size="${columnBlockSize}" data-default-column-width="${defaultColumnWidth}" data-insights-on-open="${insightsOnOpen}" data-filter-mode="${filterMode}" data-can-change-import-options="${canChangeImportOptions(this.source)}">
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function fetchColumnBlockSize(): number {
  const configured = getSetting<number>("fetchColumnBlockSize", 16);
  return Number.isInteger(configured) ? Math.min(256, Math.max(1, configured)) : 16;
}

function fetchGridBlockSize(backend?: DataBackend): { pageSize: number; columnLimit: number } {
  const configuredRows = getSetting<number>("fetchBlockSize", 200);
  const pageSize = Number.isInteger(configuredRows) ? Math.min(2_000, Math.max(25, configuredRows)) : 200;
  const columnLimit = fetchColumnBlockSize();
  if (backend !== "r") return { pageSize, columnLimit };
  return {
    pageSize: Math.min(pageSize, 1_000, Math.floor(100_000 / columnLimit)),
    columnLimit
  };
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

function withoutDatasetStats(metadata: SessionMetadata): SessionMetadata {
  const { stats: _stats, ...rest } = metadata;
  return rest;
}

type WebviewRequest =
  | { kind: "ready" }
  | { kind: "requestSessionSnapshot" }
  | {
      kind: "rendererSynchronized";
      syncId: string;
      sessionId: string | null;
      revision: number | null;
    }
  | { kind: "setViewContext"; viewContextId: string }
  | { kind: "cancelViewRequests"; viewRequestIds: string[] }
  | { kind: "prioritizeViewRequest"; viewRequestId: string }
  | { kind: "updateViewState"; state: GridViewState }
  | { kind: "clearStepInspection" }
  | { kind: "changeImportOptions"; actionId?: string }
  | { kind: "changeBackend" }
  | { kind: "installRuntimeDependencies" }
  | { kind: "exportData" }
  | { kind: "switchSessionToEditing"; state: GridViewState }
  | { kind: "reconnectLiveSource" }
  | {
      kind: "runtimeRequest";
      request: OpenWranglerRequest;
      viewContextId?: string;
      priority?: "interactive" | "background";
    };

interface RendererImportPreparation {
  readonly task: Promise<void>;
}

const WEBVIEW_RUNTIME_REQUEST_KINDS = new Set<OpenWranglerRequest["kind"]>([
  "getPage",
  "getSummary",
  "getDatasetStats",
  "getColumnValues",
  "inspectStep",
  "previewStep",
  "applyDraft",
  "discardDraft",
  "undoStep"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRendererControlId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{32}$/u.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function canChangeImportOptions(source: SessionSource): boolean {
  if (source.kind !== "file") return false;
  const extension = path.extname(source.path ?? source.uri ?? "").toLowerCase();
  return extension === ".csv" || extension === ".tsv" || extension === ".xlsx" || extension === ".xls";
}

function backendDisplayName(backend: DataBackend): string {
  if (backend === "duckdb") return "DuckDB";
  if (backend === "polars") return "Polars";
  if (backend === "pandas") return "Pandas";
  if (backend === "pyspark") return "PySpark";
  return "R";
}

function canSwitchLiveSessionToEditing(metadata: SessionMetadata): boolean {
  if (metadata.mode !== "viewing" || metadata.backend === "pyspark") return false;
  if (metadata.source.kind === "notebookVariable") return metadata.capabilities.notebookInsert;
  return (
    metadata.source.kind === "rInteractiveVariable" &&
    metadata.backend === "r" &&
    !metadata.capabilities.notebookInsert &&
    metadata.capabilities.documentInsert !== true
  );
}

function fileSourceUri(source: SessionSource): vscode.Uri | undefined {
  if (source.kind !== "file") return undefined;
  if (source.uri) return vscode.Uri.parse(source.uri);
  return source.path ? vscode.Uri.file(source.path) : undefined;
}

function reconfigurationCancelledResponse(): OpenWranglerResponse {
  return { kind: "cancelled", targetRequestId: "change-import-options" };
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

type NonSortEditorAction =
  | "openOperation"
  | "editLatest"
  | "selectStep"
  | "clearFilterColumn"
  | "openFilters"
  | "applyDraft"
  | "discardDraft"
  | "undoStep";

export type EditorActionMessage =
  | {
      action: "changeViewSort";
      column: string;
      sortAction: "moveUp" | "moveDown" | "remove";
      expectedSessionId: string;
      expectedSortModelSignature: string;
      expectedSortIndex: number;
    }
  | {
      action: NonSortEditorAction;
      expectedSessionId?: string;
      expectedRevision?: number;
      operationKind?: OperationKind;
      stepId?: string;
      column?: string;
    };

const randomNonce = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
};
