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
import { isOpenWranglerRequest } from "../shared/protocolValidation";
import { decodeGridViewState, type GridViewState } from "../shared/viewState";
import type { BridgeRequestOptions, OpenWranglerBridge } from "./dataBridge";
import { getSetting } from "./configuration";
import { rememberConfirmedFileConfiguration } from "./files/confirmedFileConfigurations";
import { ImportCancelledError, promptImportOptions } from "./files/importOptions";

const PANEL_RUNTIME_CLEANUP_TIMEOUT_MS = 2_000;
const RENDERER_IMPORT_PREPARATION_TIMEOUT_MS = 1_500;

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
  private importChangeCancellation: vscode.CancellationTokenSource | undefined;
  private readonly forwardedRequests = new Set<Promise<void>>();
  private changingImportOptions = false;
  private rendererReady = false;
  private rendererSynchronizationIdentity:
    | {
        syncId: string;
        sessionId: string;
        revision: number;
      }
    | {
        syncId: string;
        sessionId: null;
        revision: null;
      }
    | undefined;
  private rendererHydratedSyncId: string | undefined;
  private rendererSynchronization: Promise<void> | undefined;
  private rendererSynchronizationRequested = false;
  private rendererSynchronizationNeedsInspectionClear = false;
  private pendingRendererImportAction:
    | {
        actionId: string;
        timer: ReturnType<typeof setTimeout>;
        resolve: (accepted: boolean) => void;
      }
    | undefined;
  private pendingPreReadyImportResponse: OpenWranglerResponse | undefined;
  private unpublishedAuthoritativeSnapshot = false;
  private openAttemptGeneration = 0;
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
    private readonly backendPreference: DataBackend | "auto" = backend ?? "auto"
  ) {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))]
    };
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      undefined,
      this.disposables
    );
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    OpenWranglerPanel.panels.add(this);
    if (this.panel.active) this.activate();
    if (openImmediately) void this.open();
    this.panel.onDidChangeViewState(
      ({ webviewPanel }) => {
        if (webviewPanel.active) this.activate();
        else this.deactivate();
      },
      undefined,
      this.disposables
    );
  }

  static sendEditorAction(message: EditorActionMessage): boolean {
    const active = OpenWranglerPanel.activePanel;
    if (!active?.panel.active) return false;
    if (message.action === "openOperation" || message.action === "editLatest" || message.action === "selectStep") {
      active.panel.reveal(active.panel.viewColumn, false);
    }
    void active.panel.webview.postMessage({ kind: "editorAction", ...message });
    return true;
  }

  static async disposePanelForSession(sessionId: string): Promise<OpenWranglerResponse | undefined> {
    const target = [...OpenWranglerPanel.panels].find((panel) => panel.sessionId === sessionId);
    if (!target) return undefined;
    target.dispose();
    target.panel.dispose();
    return target.closing;
  }

  static async changeActiveImportOptions(): Promise<boolean> {
    const active = OpenWranglerPanel.activePanel;
    if (!active?.panel.active || !canChangeImportOptions(active.source)) return false;
    if (active.hasHydratedRenderer() && (await active.requestRendererImportOptionsChange())) return true;
    await active.enqueueImportOptionsChange();
    return true;
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

    // Live sources must not depend on a renderer-ready event before the host
    // starts their session. Some editor builds can delay that event while a
    // previous webview tab is closing; the retained snapshot is posted again
    // when the renderer eventually becomes ready. Saved output stays lazy so
    // an unopened snapshot panel does not retain an unnecessary host session.
    return new OpenWranglerPanel(
      panel,
      context,
      bridge,
      source,
      backend,
      source.kind !== "notebookOutput",
      backendPreference
    );
  }

  async open(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.disposed || this.sessionId) return;
    const pageSize = getSetting<number>("fetchBlockSize", 200);
    const columnLimit = fetchColumnBlockSize();
    const isFile = this.source.kind === "file";
    const mode = getSetting<"editing" | "viewing">(
      isFile ? "fileStartMode" : "notebookStartMode",
      isFile ? "editing" : "viewing"
    );
    const generation = ++this.openAttemptGeneration;
    const cancellation = new vscode.CancellationTokenSource();
    this.importChangeCancellation?.cancel();
    this.importChangeCancellation?.dispose();
    this.importChangeCancellation = cancellation;
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
      { cancellation: cancellation.token, backendPreference: this.backendPreference },
      generation
    );
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
      if (this.importChangeCancellation === cancellation) {
        this.importChangeCancellation = undefined;
        cancellation.dispose();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.openAttemptGeneration += 1;
    this.importChangeCancellation?.cancel();
    this.importChangeCancellation?.dispose();
    this.importChangeCancellation = undefined;
    this.settleRendererImportAction(undefined, false);
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
      this.rendererReady = true;
      this.invalidateRendererSynchronization();
      await this.enqueueRendererSynchronization(true);
      return;
    }

    if (decoded.kind === "requestSessionSnapshot") {
      this.rendererReady = true;
      this.invalidateRendererSynchronization();
      await this.enqueueRendererSynchronization(false);
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
        this.pendingPreReadyImportResponse = undefined;
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

    if (decoded.kind === "updateViewState") {
      if (this.changingImportOptions) {
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
      if (decoded.actionId !== undefined) {
        if (!this.settleRendererImportAction(decoded.actionId, true)) return;
      } else {
        this.settleRendererImportAction(undefined, true);
      }
      await this.enqueueImportOptionsChange();
      return;
    }

    if (this.changingImportOptions) {
      await this.post({
        kind: "error",
        code: "session_reconfiguring",
        message: "Wait for the current import-options change to finish.",
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
    await this.forward(request, decoded.viewContextId);
  }

  private enqueueImportOptionsChange(): Promise<void> {
    const generation = ++this.openAttemptGeneration;
    this.importChangeCancellation?.cancel();
    const task = this.importChangeTail.catch(() => undefined).then(() => this.changeImportOptions(generation));
    this.importChangeTail = task.catch(() => undefined);
    return task;
  }

  private async changeImportOptions(generation: number): Promise<void> {
    if (this.disposed || generation !== this.openAttemptGeneration || !canChangeImportOptions(this.source)) {
      return;
    }
    if (this.opening) {
      this.importChangeCancellation?.cancel();
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
        await this.panel.webview.postMessage({ kind: "importOptionsState", busy: true });
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
        importOptions = await promptImportOptions(uri, this.source.importOptions, cancellation.token);
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
        await this.panel.webview.postMessage({ kind: "importOptionsState", busy: false });
        if (this.rendererReady) await this.enqueueRendererSynchronization(false);
      }
    }
  }

  private fileOpenRequest(source: SessionSource): Extract<OpenWranglerRequest, { kind: "openSession" }> {
    const pageSize = getSetting<number>("fetchBlockSize", 200);
    return {
      kind: "openSession",
      source,
      ...(this.backendPreference === "auto" ? {} : { backend: this.backendPreference }),
      pageSize,
      columnOffset: 0,
      columnLimit: fetchColumnBlockSize(),
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
      if (request.kind === "openSession" && response.kind === "sessionOpened") {
        await this.rememberConfirmedFileImportOptions(response.metadata.source, response.metadata.backend);
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
      if (request.kind === "openSession") this.openResponse = response;
      if (response.kind === "sessionOpened") {
        this.invalidateRendererSynchronization();
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.metadata.revision;
        this.snapshot = response;
        this.snapshotViewContextId = undefined;
        if (OpenWranglerPanel.activePanel === this) this.bridge.setActiveSession?.(this.sessionId);
      }
      if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
        if (response.kind !== "page") this.invalidateRendererSynchronization();
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.revision;
        const acceptsPage =
          response.kind !== "page" ||
          (request.kind === "getPage" &&
            response.viewRequestId === request.viewRequestId &&
            this.latestPageViewRequestId === response.viewRequestId);
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
        const summaries = new Map(this.snapshot.summaries.map((summary) => [summary.column, summary]));
        for (const summary of response.summaries) summaries.set(summary.column, summary);
        this.snapshot = { ...this.snapshot, summaries: [...summaries.values()] };
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
      await this.postRuntimeResponse(request, response);
      if (response.kind === "sessionOpened") await this.postSessionPresentation();
      if (response.kind === "sessionOpened" || response.kind === "stepPreview" || response.kind === "planUpdated") {
        await this.postViewState();
        if (this.rendererReady) this.scheduleRendererSynchronization(false);
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
      if (request.kind === "openSession") this.openResponse = response;
      await this.postRuntimeResponse(request, response);
      if (request.kind === "openSession" && this.rendererReady) this.scheduleRendererSynchronization(false);
    }
  }

  private async post(response: OpenWranglerResponse): Promise<void> {
    if (this.disposed) return;
    await this.panel.webview.postMessage(response);
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
      this.rendererReady &&
      this.snapshot &&
      synchronization &&
      this.rendererHydratedSyncId === synchronization.syncId &&
      synchronization.sessionId === this.snapshot.metadata.sessionId &&
      synchronization.revision === this.snapshot.metadata.revision
    );
  }

  private invalidateRendererSynchronization(): void {
    this.rendererSynchronizationIdentity = undefined;
    this.rendererHydratedSyncId = undefined;
    this.settleRendererImportAction(undefined, false);
  }

  private requestRendererImportOptionsChange(): Promise<boolean> {
    if (!this.hasHydratedRenderer()) return Promise.resolve(false);
    this.settleRendererImportAction(undefined, false);
    const actionId = randomNonce();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.settleRendererImportAction(actionId, false);
      }, RENDERER_IMPORT_PREPARATION_TIMEOUT_MS);
      this.pendingRendererImportAction = { actionId, timer, resolve };
      void this.panel.webview.postMessage({ kind: "requestImportOptionsChange", actionId }).then(
        (posted) => {
          if (!posted) this.settleRendererImportAction(actionId, false);
        },
        () => this.settleRendererImportAction(actionId, false)
      );
    });
  }

  private settleRendererImportAction(actionId: string | undefined, accepted: boolean): boolean {
    const pending = this.pendingRendererImportAction;
    if (!pending || (actionId !== undefined && pending.actionId !== actionId)) return false;
    this.pendingRendererImportAction = undefined;
    clearTimeout(pending.timer);
    pending.resolve(accepted);
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
      do {
        this.rendererSynchronizationRequested = false;
        const shouldClearInspection = this.rendererSynchronizationNeedsInspectionClear;
        this.rendererSynchronizationNeedsInspectionClear = false;
        await this.synchronizeRenderer(shouldClearInspection);
      } while (!this.disposed && this.rendererSynchronizationRequested);
    })();
    this.rendererSynchronization = synchronization;
    void synchronization.then(
      () => {
        if (this.rendererSynchronization === synchronization) this.rendererSynchronization = undefined;
      },
      () => {
        if (this.rendererSynchronization === synchronization) this.rendererSynchronization = undefined;
      }
    );
    return synchronization;
  }

  private async synchronizeRenderer(clearInspection: boolean): Promise<void> {
    if (this.disposed) return;
    if (clearInspection) {
      if (this.sessionId) this.bridge.clearStepInspection?.(this.sessionId);
      await this.postStepInspectionCleared(false);
    }
    if (!this.snapshot && !this.openResponse) await this.open();
    const synchronization = this.snapshot
      ? {
          syncId: randomNonce(),
          sessionId: this.snapshot.metadata.sessionId,
          revision: this.snapshot.metadata.revision
        }
      : {
          syncId: randomNonce(),
          sessionId: null,
          revision: null
        };
    this.settleRendererImportAction(undefined, false);
    this.rendererSynchronizationIdentity = synchronization;
    this.rendererHydratedSyncId = undefined;
    if (this.snapshot) {
      await this.post(this.snapshot);
      await this.postSessionPresentation();
      await this.postViewState();
      this.unpublishedAuthoritativeSnapshot = false;
    } else if (this.openResponse) {
      await this.post(this.openResponse);
    }
    if (this.pendingPreReadyImportResponse) {
      await this.post(this.pendingPreReadyImportResponse);
    }
    await this.panel.webview.postMessage({ kind: "importOptionsState", busy: this.changingImportOptions });
    if (this.rendererSynchronizationIdentity !== synchronization) {
      this.rendererSynchronizationRequested = true;
      return;
    }
    await this.panel.webview.postMessage({ kind: "rendererSynchronization", ...synchronization });
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
  }

  private deactivate(): void {
    if (OpenWranglerPanel.activePanel !== this) return;
    OpenWranglerPanel.activePanel = undefined;
    this.bridge.setActiveSession?.(undefined);
    void vscode.commands.executeCommand("setContext", "openWrangler.canChangeImportOptions", false);
  }

  private async postStepInspectionCleared(resumeProfiling: boolean): Promise<void> {
    if (this.disposed) return;
    await this.panel.webview.postMessage({ kind: "stepInspectionCleared", resumeProfiling });
  }

  private async postRuntimeResponse(request: OpenWranglerRequest, response: OpenWranglerResponse): Promise<void> {
    if (request.kind === "inspectStep") {
      await this.panel.webview.postMessage({
        kind: "stepInspectionResult",
        stepId: request.stepId,
        offset: request.offset,
        limit: request.limit,
        columnOffset: request.columnOffset,
        columnLimit: request.columnLimit,
        response
      });
      return;
    }
    await this.post(response);
  }

  private async postViewState(): Promise<void> {
    if (!this.sessionId) return;
    const state = this.bridge.getViewState?.(this.sessionId);
    if (state) await this.panel.webview.postMessage({ kind: "viewState", state });
  }

  private async postSessionPresentation(): Promise<void> {
    if (!this.sessionId) return;
    const presentation = this.bridge.getSessionPresentation?.(this.sessionId);
    if (presentation && presentation.sessionId === this.sessionId && presentation.revision === this.sessionRevision) {
      await this.panel.webview.postMessage({ kind: "sessionPresentation", presentation });
    }
  }

  private async postUnpublishedAuthoritativeSnapshot(): Promise<void> {
    if (!this.unpublishedAuthoritativeSnapshot || !this.snapshot) return;
    this.unpublishedAuthoritativeSnapshot = false;
    await this.post(this.snapshot);
    await this.postSessionPresentation();
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
    if (
      message.kind !== "runtimeRequest" ||
      !hasExactKeys(message, ["kind", "request"], ["viewContextId"]) ||
      !isRecord(message.request) ||
      Object.prototype.hasOwnProperty.call(message.request, "sessionId") ||
      Object.prototype.hasOwnProperty.call(message.request, "revision") ||
      (message.viewContextId !== undefined && !isNonEmptyString(message.viewContextId))
    ) {
      return undefined;
    }
    const request = {
      ...message.request,
      sessionId: this.sessionId ?? "pending-session",
      revision: this.sessionRevision
    };
    if (!isOpenWranglerRequest(request) || !WEBVIEW_RUNTIME_REQUEST_KINDS.has(request.kind)) return undefined;
    return {
      kind: "runtimeRequest",
      request,
      ...(message.viewContextId === undefined ? {} : { viewContextId: message.viewContextId })
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
    const fetchBlockSize = getSetting<number>("fetchBlockSize", 200);
    const columnBlockSize = fetchColumnBlockSize();
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
  | { kind: "updateViewState"; state: GridViewState }
  | { kind: "clearStepInspection" }
  | { kind: "changeImportOptions"; actionId?: string }
  | {
      kind: "runtimeRequest";
      request: OpenWranglerRequest;
      viewContextId?: string;
    };

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

export interface EditorActionMessage {
  action: "openOperation" | "editLatest" | "selectStep" | "applyDraft" | "discardDraft" | "undoStep";
  operationKind?: OperationKind;
  stepId?: string;
}

const randomNonce = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
};
