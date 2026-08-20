import * as vscode from "vscode";
import type { GridViewState } from "../shared/viewState";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionOpenedResponse } from "../shared/protocol";
import type { PythonBridge } from "./pythonBridge";
import type { SessionCoordinator } from "./sessionCoordinator";
import type { TrustedPickleWorkerLifecycle } from "./files/trustedPickleWorker";
import type { NotebookCellResultTracker, NotebookCellResultTrackerDiagnostics } from "./notebooks/notebookCellResult";
import type { NotebookPreviewCoordinator } from "./notebooks/notebookPreviewCoordinator";
import type {
  PythonInteractiveCommandProvider,
  PythonInteractiveDiagnostics
} from "./notebooks/pythonInteractiveCommands";
import type { LiterateRVariableProvider, RLiveVariableProvider } from "./r/rInteractiveCommands";
import type {
  NativeViewsTestController,
  NotebookInsertionDiagnosticStatus,
  ViewSortDispatchStatus
} from "./nativeViews";

const CUSTOM_EDITOR_ID = "openWrangler.viewer";
const NOTEBOOK_PREVIEW_COMMAND = "openWrangler.chooseNotebookPreviewProvider";

const FILE_COMMANDS = ["openWrangler.changeImportOptions", "openWrangler.openFile", "openWrangler.openPath"] as const;
const PICKLE_COMMANDS = ["openWrangler.convertTrustedPickle"] as const;
const NOTEBOOK_COMMANDS = [
  "openWrangler.launchDataViewer",
  "openWrangler.openNotebookVariable",
  "openWrangler.checkJupyterIntegration",
  "openWrangler.runPythonCellAndOpenVariable",
  "openWrangler.refreshNotebookVariables",
  "openWrangler.openCachedNotebookVariable",
  "openWrangler.openNotebookCellResult"
] as const;
const R_COMMANDS = [
  "openWrangler.openRDataframe",
  "openWrangler.openRInteractiveVariable",
  "openWrangler.refreshRInteractiveVariables",
  "openWrangler.openCachedRInteractiveVariable"
] as const;
const R_DOCUMENT_COMMANDS = ["openWrangler.runRDocument", "openWrangler.internal.openLiterateDataframe"] as const;
const RUNTIME_COMMANDS = [
  "openWrangler.changeRuntime",
  "openWrangler.clearRuntime",
  "openWrangler.installRuntimeDependencies",
  "openWrangler.revalidateRuntimeDependencies"
] as const;
const NATIVE_VIEW_COMMANDS = [
  "openWrangler.refreshLiveDataframes",
  "openWrangler.clearViewFilterColumn",
  "openWrangler.openViewSort",
  "openWrangler.moveViewSortUp",
  "openWrangler.moveViewSortDown",
  "openWrangler.removeViewSort",
  "openWrangler.startOperation",
  "openWrangler.applyStep",
  "openWrangler.discardStep",
  "openWrangler.editLatestStep",
  "openWrangler.editSelectedStep",
  "openWrangler.deleteSelectedStep",
  "openWrangler.selectStep",
  "openWrangler.undoStep",
  "openWrangler.copyCode",
  "openWrangler.exportCode",
  "openWrangler.insertRDocumentCode",
  "openWrangler.insertNotebookCode",
  "openWrangler.exportData",
  "openWrangler.internal.exportSessionData",
  "openWrangler.openSourceFile"
] as const;
const NATIVE_TREE_VIEW_IDS = [
  "openWrangler.operations",
  "openWrangler.summary",
  "openWrangler.filters",
  "openWrangler.cleaningSteps"
] as const;

type LazyCommandGroup =
  "file" | "pickle" | "notebookPreview" | "notebook" | "r" | "rDocument" | "runtime" | "native" | "utility";

interface SessionOwner {
  coordinator: SessionCoordinator;
}

interface PythonOwner {
  bridge: PythonBridge;
}

interface NotebookOwner {
  variables: PythonInteractiveCommandProvider;
  cellResults: NotebookCellResultTracker;
}

interface ROwner {
  variables: RLiveVariableProvider & LiterateRVariableProvider;
}

interface FileOwner {
  module: typeof import("./files/fileOpen");
}

interface NativeOwner {
  controller: NativeViewsTestController;
}

export interface OpenWranglerTestApi {
  request: ReturnType<SessionCoordinator["createBridge"]>["request"];
  setActiveSession(sessionId: string | undefined): void;
  activeSession: SessionCoordinator["activeSession"];
  sessionSnapshot: SessionCoordinator["sessionSnapshot"];
  updateViewState(sessionId: string, state: GridViewState): Promise<void>;
  synchronizePanel(sessionId: string): Promise<boolean>;
  ensurePanelSynchronized(sessionId: string, deadlineMs: number): Promise<boolean>;
  previewPanelStep(
    request: Extract<OpenWranglerRequest, { kind: "previewStep" }>
  ): Promise<SessionOpenedResponse | undefined>;
  rewriteCleaningPlan(
    sessionId: string,
    revision: number,
    stepId: string,
    action: "applyDraft" | "deleteStep"
  ): Promise<OpenWranglerResponse | undefined>;
  panelHydrated(sessionId: string): boolean;
  panelSynchronizable(sessionId: string): boolean;
  panelSynchronizationReceipt(
    sessionId: string
  ): Readonly<{ syncId: string; sessionId: string; revision: number; layoutTransitionPending: boolean }> | undefined;
  retirePanelRenderer(sessionId: string): boolean;
  cancelViewRequests(sessionId: string, viewRequestIds: readonly string[]): void;
  requestExecutionCheckpoint: SessionCoordinator["testingRequestExecutionCheckpoint"];
  sessionSchedulerState: SessionCoordinator["testingSessionSchedulerState"];
  panelOpenResponse(): OpenWranglerResponse | undefined;
  diagnostics: SessionCoordinator["diagnostics"];
  restartRuntime(reason?: string): void;
  runtimeGeneration(): number;
  runtimeRunning(): boolean;
  runtimeEnvironment(): Readonly<{ executable: string; source: string; version: string }> | undefined;
  declineRuntimeDependencyInstallation(): Promise<boolean>;
  declineRuntimeDependencyRevalidation(): Promise<boolean>;
  shutdownRuntimeBridgeForTesting(): Promise<void>;
  disposePanelForSession(sessionId: string): Promise<OpenWranglerResponse | undefined>;
  setCodeForExport(code: string): void;
  exportCodeTo(destination: vscode.Uri): Promise<void>;
  notebookInsertionStatus(): NotebookInsertionDiagnosticStatus | undefined;
  viewSortDispatchStatus(): ViewSortDispatchStatus | undefined;
  notebookCellResultDiagnostics(): NotebookCellResultTrackerDiagnostics | undefined;
  pythonInteractiveDiagnostics(): PythonInteractiveDiagnostics | undefined;
}

export interface OpenWranglerExtensionApi {
  testing?: OpenWranglerTestApi;
}

export interface LazyActivationDiagnostics {
  readonly constructedOwners: readonly string[];
  readonly rDiscoveryStarted: boolean;
}

type NotebookPreviewModule = typeof import("./notebooks/notebookPreviewCoordinator");
type NotebookPreviewLoader = () => NotebookPreviewModule;

const loadNotebookPreviewModule: NotebookPreviewLoader = () =>
  // This intentionally remains a synchronous, non-static load. A relevant
  // notebook that is already visible during activation must install the
  // formatter preparation hooks before activation reaches its first await.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./notebooks/notebookPreviewCoordinator") as NotebookPreviewModule;

export class LazyActivationOwners implements vscode.Disposable {
  private readonly commandRegistrations = new Map<LazyCommandGroup, vscode.Disposable[]>();
  private readonly bootstrapSubscriptions: vscode.Disposable[] = [];
  private readonly constructedOwners: string[] = [];
  private customEditorRegistration: vscode.Disposable | undefined;
  private nativeViewRegistrations: vscode.Disposable[] = [];
  private notebookPreview: NotebookPreviewCoordinator | undefined;
  private notebookPreviewModule: NotebookPreviewModule | undefined;
  private sessionOwner: Promise<SessionOwner> | undefined;
  private pythonOwner: Promise<PythonOwner> | undefined;
  private coordinatedPythonBridge: ReturnType<SessionCoordinator["createBridge"]> | undefined;
  private fileOwner: Promise<FileOwner> | undefined;
  private pickleOwner: Promise<TrustedPickleWorkerLifecycle> | undefined;
  private notebookOwner: Promise<NotebookOwner> | undefined;
  private rOwner: Promise<ROwner> | undefined;
  private rDocumentOwner: Promise<void> | undefined;
  private runtimeOwner: Promise<void> | undefined;
  private nativeOwner: Promise<NativeOwner> | undefined;
  private initialNotebookOwner: Promise<NotebookOwner> | undefined;
  private sessionDiagnosticOutput: vscode.OutputChannel | undefined;
  private disposed = false;
  private rDiscoveryStarted = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notebookPreviewLoader: NotebookPreviewLoader = loadNotebookPreviewModule
  ) {}

  startBeforeFirstYield(): void {
    this.assertActive();
    this.installCommandGroup("file", FILE_COMMANDS, () => this.ensureFileOwner());
    this.installCommandGroup("pickle", PICKLE_COMMANDS, () => this.ensurePickleOwner());
    this.installCommandGroup("notebookPreview", [NOTEBOOK_PREVIEW_COMMAND], async () => {
      this.ensureNotebookPreview();
    });
    this.installCommandGroup("notebook", NOTEBOOK_COMMANDS, () => this.ensureNotebookOwner());
    this.installCommandGroup("r", R_COMMANDS, () => this.ensureROwner());
    this.installCommandGroup("rDocument", R_DOCUMENT_COMMANDS, () => this.ensureRDocumentOwner());
    this.installCommandGroup("runtime", RUNTIME_COMMANDS, () => this.ensureRuntimeOwner());
    this.installCommandGroup("native", NATIVE_VIEW_COMMANDS, () => this.ensureNativeOwner());
    this.installUtilityCommands();
    this.installCustomEditorGate();
    this.installNativeViewGates();
    this.installNotebookVisibilityGate();
    this.startVisibleNotebookOwners(true);
  }

  async extensionApiForCurrentEnvironment(): Promise<OpenWranglerExtensionApi | undefined> {
    await this.initialNotebookOwner;
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS !== "1") return undefined;
    return { testing: await this.createTestingApi() };
  }

  diagnosticsForTesting(): LazyActivationDiagnostics {
    return {
      constructedOwners: [...this.constructedOwners],
      rDiscoveryStarted: this.rDiscoveryStarted
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.notebookPreview?.dispose();
    this.notebookPreview = undefined;
    for (const subscription of this.bootstrapSubscriptions.splice(0)) subscription.dispose();
    for (const registrations of this.commandRegistrations.values()) {
      for (const registration of registrations.splice(0)) registration.dispose();
    }
    this.commandRegistrations.clear();
    this.customEditorRegistration?.dispose();
    this.customEditorRegistration = undefined;
    for (const registration of this.nativeViewRegistrations.splice(0)) registration.dispose();
  }

  async shutdown(): Promise<void> {
    this.dispose();
    const failures: unknown[] = [];
    const pickleWorkers = await settledValue(this.pickleOwner);
    const r = await settledValue(this.rOwner);
    const session = await settledValue(this.sessionOwner);
    const python = await settledValue(this.pythonOwner);

    await captureFailure(() => pickleWorkers?.shutdown(), failures);
    await captureFailure(() => r?.variables.shutdown(), failures);
    await captureFailure(() => session?.coordinator.shutdown(), failures);
    await captureFailure(() => python?.bridge.shutdown(), failures);
    this.sessionDiagnosticOutput?.dispose();
    this.sessionDiagnosticOutput = undefined;

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Open Wrangler extension deactivation encountered multiple shutdown failures."
      );
    }
  }

  private installCommandGroup(
    group: LazyCommandGroup,
    commandIds: readonly string[],
    initialize: () => Promise<unknown>
  ): void {
    const registrations = commandIds.map((commandId) =>
      vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
        await initialize();
        this.assertActive();
        return vscode.commands.executeCommand(commandId, ...args);
      })
    );
    this.commandRegistrations.set(group, registrations);
    this.context.subscriptions.push(...registrations);
  }

  private replaceCommandGroup(group: LazyCommandGroup): void {
    const registrations = this.commandRegistrations.get(group);
    if (!registrations) return;
    this.commandRegistrations.delete(group);
    for (const registration of registrations) registration.dispose();
  }

  private installUtilityCommands(): void {
    const registrations = [
      vscode.commands.registerCommand("openWrangler.openWalkthrough", () =>
        vscode.commands.executeCommand(
          "workbench.action.openWalkthrough",
          "Matt17BR.openwrangler#gettingStarted",
          false
        )
      ),
      vscode.commands.registerCommand("openWrangler.openSettings", () =>
        vscode.commands.executeCommand("workbench.action.openSettings", "@ext:Matt17BR.openwrangler")
      ),
      vscode.commands.registerCommand("openWrangler.reportIssue", () =>
        vscode.env.openExternal(
          vscode.Uri.parse(
            `https://github.com/Matt17BR/openwrangler/issues/new?title=${encodeURIComponent("Open Wrangler issue")}&body=${encodeURIComponent(`VS Code: ${vscode.version}\nOS: ${process.platform}\n\nSteps to reproduce:\n`)}`
          )
        )
      )
    ];
    this.commandRegistrations.set("utility", registrations);
    this.context.subscriptions.push(...registrations);
  }

  private installCustomEditorGate(): void {
    const provider = new LazyCustomEditorProvider(async () => {
      const owner = await this.ensureFileOwner();
      return new owner.module.OpenWranglerCustomEditorProvider(
        this.context,
        await this.ensureCoordinatedPythonBridge()
      );
    });
    this.customEditorRegistration = vscode.window.registerCustomEditorProvider(CUSTOM_EDITOR_ID, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: true }
    });
    this.context.subscriptions.push(this.customEditorRegistration);
  }

  private installNativeViewGates(): void {
    this.nativeViewRegistrations = NATIVE_TREE_VIEW_IDS.map((id) =>
      vscode.window.registerTreeDataProvider(id, new LazyTreeProvider(() => this.ensureNativeOwner()))
    );
    this.nativeViewRegistrations.push(
      vscode.window.registerWebviewViewProvider(
        "openWrangler.codePreview",
        new LazyWebviewViewProvider(() => this.ensureNativeOwner()),
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    this.context.subscriptions.push(...this.nativeViewRegistrations);
  }

  private installNotebookVisibilityGate(): void {
    const onNotebookSurface = (): void => this.startVisibleNotebookOwners();
    const subscriptions = [
      vscode.window.onDidChangeVisibleNotebookEditors(onNotebookSurface),
      vscode.window.onDidChangeActiveNotebookEditor(onNotebookSurface),
      vscode.workspace.onDidOpenNotebookDocument(onNotebookSurface),
      vscode.workspace.onDidGrantWorkspaceTrust(onNotebookSurface)
    ];
    this.bootstrapSubscriptions.push(...subscriptions);
    this.context.subscriptions.push(...subscriptions);
  }

  private startVisibleNotebookOwners(initialActivation = false): void {
    if (!this.hasRelevantVisibleNotebook()) return;
    this.ensureNotebookPreview();
    const loading = this.ensureNotebookOwner();
    if (initialActivation) {
      this.initialNotebookOwner = loading;
      return;
    }
    void loading.catch((error: unknown) => this.reportLazyFailure("notebook", error));
  }

  private hasRelevantVisibleNotebook(): boolean {
    return vscode.window.visibleNotebookEditors.some(
      (editor) => editor.notebook.notebookType === "jupyter-notebook" || editor.notebook.notebookType === "interactive"
    );
  }

  private ensureNotebookPreview(): NotebookPreviewCoordinator {
    if (this.notebookPreview) return this.notebookPreview;
    this.assertActive();
    const module = (this.notebookPreviewModule ??= this.notebookPreviewLoader());
    this.replaceCommandGroup("notebookPreview");
    const preview = new module.NotebookPreviewCoordinator(this.context);
    this.notebookPreview = preview;
    this.constructedOwners.push("notebook-preview");
    this.context.subscriptions.push(preview);
    return preview;
  }

  private ensureSessionOwner(): Promise<SessionOwner> {
    return (this.sessionOwner ??= this.loadSessionOwner());
  }

  private async loadSessionOwner(): Promise<SessionOwner> {
    const { SessionCoordinator } = await import("./sessionCoordinator.js");
    this.assertActive();
    const coordinator = new SessionCoordinator(this.context.workspaceState, (message) => {
      let output = this.sessionDiagnosticOutput;
      if (!output) {
        output = vscode.window.createOutputChannel("Open Wrangler");
        this.sessionDiagnosticOutput = output;
        this.context.subscriptions.push(output);
      }
      output.appendLine(message);
    });
    this.constructedOwners.push("session");
    this.context.subscriptions.push(coordinator);
    return { coordinator };
  }

  private ensurePythonOwner(): Promise<PythonOwner> {
    return (this.pythonOwner ??= this.loadPythonOwner());
  }

  private async loadPythonOwner(): Promise<PythonOwner> {
    const { PythonBridge } = await import("./pythonBridge.js");
    this.assertActive();
    const bridge = new PythonBridge(this.context);
    this.constructedOwners.push("python");
    this.context.subscriptions.push(bridge);
    return { bridge };
  }

  private async ensureCoordinatedPythonBridge(): Promise<ReturnType<SessionCoordinator["createBridge"]>> {
    const [session, python] = await Promise.all([this.ensureSessionOwner(), this.ensurePythonOwner()]);
    return (this.coordinatedPythonBridge ??= session.coordinator.createBridge(python.bridge));
  }

  private ensureFileOwner(): Promise<FileOwner> {
    return (this.fileOwner ??= this.loadFileOwner());
  }

  private async loadFileOwner(): Promise<FileOwner> {
    const [module, coordinatedBridge] = await Promise.all([
      import("./files/fileOpen.js"),
      this.ensureCoordinatedPythonBridge()
    ]);
    this.assertActive();
    this.replaceCommandGroup("file");
    this.customEditorRegistration?.dispose();
    this.customEditorRegistration = undefined;
    module.registerFileCommands(this.context, coordinatedBridge);
    this.constructedOwners.push("custom-editor");
    return { module };
  }

  private ensurePickleOwner(): Promise<TrustedPickleWorkerLifecycle> {
    return (this.pickleOwner ??= this.loadPickleOwner());
  }

  private async loadPickleOwner(): Promise<TrustedPickleWorkerLifecycle> {
    const [conversion, workers, python] = await Promise.all([
      import("./files/trustedPickleConversion.js"),
      import("./files/trustedPickleWorker.js"),
      this.ensurePythonOwner()
    ]);
    this.assertActive();
    const lifecycle = new workers.TrustedPickleWorkerLifecycle();
    this.replaceCommandGroup("pickle");
    conversion.registerTrustedPickleConversion(this.context, python.bridge, {
      runWorker: (options) => lifecycle.run(options)
    });
    this.constructedOwners.push("pickle");
    this.context.subscriptions.push(lifecycle);
    return lifecycle;
  }

  private ensureNotebookOwner(): Promise<NotebookOwner> {
    return (this.notebookOwner ??= this.loadNotebookOwner());
  }

  private async loadNotebookOwner(): Promise<NotebookOwner> {
    this.ensureNotebookPreview();
    const [interactive, jupyter, cellResult, renderer, session] = await Promise.all([
      import("./notebooks/pythonInteractiveCommands.js"),
      import("./notebooks/jupyterBridge.js"),
      import("./notebooks/notebookCellResult.js"),
      import("./notebooks/rendererMessaging.js"),
      this.ensureSessionOwner()
    ]);
    this.assertActive();
    const cellResults = new cellResult.NotebookCellResultTracker();
    this.replaceCommandGroup("notebook");
    try {
      const variables = interactive.registerPythonInteractiveCommands(this.context, session.coordinator);
      cellResults.start();
      jupyter.registerNotebookCommands(this.context, session.coordinator);
      cellResult.registerNotebookCellResultAction(this.context, session.coordinator, cellResults);
      renderer.registerNotebookRendererMessaging(this.context, session.coordinator);
      this.constructedOwners.push("notebook");
      this.context.subscriptions.push(cellResults);
      return { variables, cellResults };
    } catch (error) {
      cellResults.dispose();
      throw error;
    }
  }

  private ensureROwner(): Promise<ROwner> {
    return (this.rOwner ??= this.loadROwner());
  }

  private async loadROwner(): Promise<ROwner> {
    const [interactive, session] = await Promise.all([
      import("./r/rInteractiveCommands.js"),
      this.ensureSessionOwner()
    ]);
    this.assertActive();
    this.replaceCommandGroup("r");
    const variables = interactive.registerRInteractiveCommands(this.context, session.coordinator);
    variables.startAutomaticDiscovery();
    this.rDiscoveryStarted = true;
    this.constructedOwners.push("r");
    return { variables };
  }

  private ensureRDocumentOwner(): Promise<void> {
    return (this.rDocumentOwner ??= this.loadRDocumentOwner());
  }

  private async loadRDocumentOwner(): Promise<void> {
    const [documentCommands, notebook, r, session] = await Promise.all([
      import("./r/rDocumentCommands.js"),
      this.ensureNotebookOwner(),
      this.ensureROwner(),
      this.ensureSessionOwner()
    ]);
    this.assertActive();
    this.replaceCommandGroup("rDocument");
    documentCommands.registerRDocumentCommands(this.context, session.coordinator, {
      python: notebook.variables,
      r: r.variables
    });
    this.constructedOwners.push("r-document");
  }

  private ensureRuntimeOwner(): Promise<void> {
    return (this.runtimeOwner ??= this.loadRuntimeOwner());
  }

  private async loadRuntimeOwner(): Promise<void> {
    const [runtime, python] = await Promise.all([import("./runtimeCommands.js"), this.ensurePythonOwner()]);
    this.assertActive();
    this.replaceCommandGroup("runtime");
    runtime.registerRuntimeCommands(this.context, python.bridge);
    this.constructedOwners.push("runtime-commands");
  }

  private ensureNativeOwner(): Promise<NativeOwner> {
    return (this.nativeOwner ??= this.loadNativeOwner());
  }

  private async loadNativeOwner(): Promise<NativeOwner> {
    const [native, notebook, r, session] = await Promise.all([
      import("./nativeViews.js"),
      this.ensureNotebookOwner(),
      this.ensureROwner(),
      this.ensureSessionOwner()
    ]);
    this.assertActive();
    this.replaceCommandGroup("native");
    this.replaceCommandGroup("utility");
    for (const registration of this.nativeViewRegistrations.splice(0)) registration.dispose();
    const controller = native.registerNativeViews(this.context, session.coordinator, notebook.variables, r.variables);
    this.constructedOwners.push("native-views");
    return { controller };
  }

  private async createTestingApi(): Promise<OpenWranglerTestApi> {
    const [file, pickleWorkers, notebook, r, native, session, python, coordinatedBridge, panel] = await Promise.all([
      this.ensureFileOwner(),
      this.ensurePickleOwner(),
      this.ensureNotebookOwner(),
      this.ensureROwner(),
      this.ensureNativeOwner(),
      this.ensureSessionOwner(),
      this.ensurePythonOwner(),
      this.ensureCoordinatedPythonBridge(),
      import("./webviewPanel.js")
    ]);
    void file;
    void pickleWorkers;
    void r;
    await this.ensureRuntimeOwner();
    await this.ensureRDocumentOwner();
    const { OpenWranglerPanel } = panel;
    return {
      request: (request, options) => coordinatedBridge.request(request, options),
      setActiveSession: (sessionId) => session.coordinator.setActive(sessionId),
      activeSession: () => session.coordinator.activeSession(),
      sessionSnapshot: (sessionId) => session.coordinator.sessionSnapshot(sessionId),
      updateViewState: async (sessionId, state) => coordinatedBridge.updateViewState?.(sessionId, state),
      synchronizePanel: (sessionId) => OpenWranglerPanel.synchronizePanelForSession(sessionId),
      ensurePanelSynchronized: (sessionId, deadlineMs) =>
        OpenWranglerPanel.ensurePanelSynchronizedForSession(sessionId, deadlineMs),
      previewPanelStep: (request) => OpenWranglerPanel.previewStepForSessionForTesting(request),
      rewriteCleaningPlan: async (sessionId, revision, stepId, action) =>
        coordinatedBridge.rewriteCleaningPlan?.(sessionId, revision, stepId, action, {
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 32
        }),
      panelHydrated: (sessionId) => OpenWranglerPanel.panelHydratedForSession(sessionId),
      panelSynchronizable: (sessionId) => OpenWranglerPanel.panelSynchronizableForSession(sessionId),
      panelSynchronizationReceipt: (sessionId) => OpenWranglerPanel.panelSynchronizationReceiptForSession(sessionId),
      retirePanelRenderer: (sessionId) => OpenWranglerPanel.retireRendererForSessionForTesting(sessionId),
      cancelViewRequests: (sessionId, viewRequestIds) =>
        coordinatedBridge.cancelViewRequests?.(sessionId, viewRequestIds),
      requestExecutionCheckpoint: (sessionId, requestKind, viewRequestId) =>
        session.coordinator.testingRequestExecutionCheckpoint(sessionId, requestKind, viewRequestId),
      sessionSchedulerState: (sessionId) => session.coordinator.testingSessionSchedulerState(sessionId),
      panelOpenResponse: () => OpenWranglerPanel.openResponseForTesting(),
      diagnostics: () => session.coordinator.diagnostics(),
      restartRuntime: (reason) => python.bridge.restart(reason),
      runtimeGeneration: () => python.bridge.runtimeGeneration,
      runtimeRunning: () => python.bridge.runtimeRunning,
      runtimeEnvironment: () => python.bridge.runtimeEnvironmentForTesting(),
      declineRuntimeDependencyInstallation: () => python.bridge.declineMissingDependencyInstallForTesting(),
      declineRuntimeDependencyRevalidation: () => python.bridge.declineRuntimeDependencyRevalidationForTesting(),
      shutdownRuntimeBridgeForTesting: () => python.bridge.shutdown(),
      disposePanelForSession: (sessionId) => OpenWranglerPanel.disposePanelForSession(sessionId),
      setCodeForExport: (code) => native.controller.setCodeForExport(code),
      exportCodeTo: (destination) => native.controller.exportCodeTo(destination),
      notebookInsertionStatus: () => native.controller.notebookInsertionStatus(),
      viewSortDispatchStatus: () => native.controller.viewSortDispatchStatus(),
      notebookCellResultDiagnostics: () => notebook.cellResults.diagnosticsForTesting(),
      pythonInteractiveDiagnostics: () => notebook.variables.diagnosticsForTesting()
    };
  }

  private reportLazyFailure(owner: string, error: unknown): void {
    if (this.disposed) return;
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    void vscode.window.showErrorMessage(`Open Wrangler could not initialize its ${owner} integration${detail}`);
  }

  private assertActive(): void {
    if (this.disposed)
      throw new Error("Open Wrangler activation was disposed before the requested integration loaded.");
  }
}

class LazyCustomEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly load: () => Promise<
      InstanceType<typeof import("./files/fileOpen").OpenWranglerCustomEditorProvider>
    >
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const provider = await this.load();
    await provider.resolveCustomEditor(document, webviewPanel);
  }
}

class LazyTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  constructor(private readonly load: () => Promise<unknown>) {}

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    await this.load();
    return [];
  }
}

class LazyWebviewViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly load: () => Promise<unknown>) {}

  async resolveWebviewView(): Promise<void> {
    await this.load();
  }
}

async function settledValue<T>(promise: Promise<T> | undefined): Promise<T | undefined> {
  if (!promise) return undefined;
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

async function captureFailure(action: () => Promise<unknown> | undefined, failures: unknown[]): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}
