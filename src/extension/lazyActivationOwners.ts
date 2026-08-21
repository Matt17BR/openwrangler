import * as vscode from "vscode";
import type { GridViewState } from "../shared/viewState";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionOpenedResponse } from "../shared/protocol";
import type { PythonBridge } from "./pythonBridge";
import type { SessionCoordinator } from "./sessionCoordinator";
import type { TrustedPickleWorkerLifecycle } from "./files/trustedPickleWorker";
import type { NotebookCellResultTracker, NotebookCellResultTrackerDiagnostics } from "./notebooks/notebookCellResult";
import type { NotebookPreviewCoordinator } from "./notebooks/notebookPreviewCoordinator";
import type {
  NotebookLiveVariableProvider,
  NotebookLiveVariableSnapshot,
  PythonInteractiveCommandProvider,
  PythonInteractiveDiagnostics
} from "./notebooks/pythonInteractiveCommands";
import type { LiterateRVariableProvider, RLiveVariableProvider, RLiveVariableSnapshot } from "./r/rInteractiveCommands";
import type {
  NativeTreeViewId,
  NativeViewsOwner,
  NativeViewsTestController,
  NotebookInsertionDiagnosticStatus,
  ViewSortDispatchStatus
} from "./nativeViews";

const CUSTOM_EDITOR_ID = "openWrangler.viewer";
const NOTEBOOK_PREVIEW_COMMAND = "openWrangler.chooseNotebookPreviewProvider";
const DEFAULT_OWNER_SETTLEMENT_TIMEOUT_MS = 2_000;

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
  owner: NativeViewsOwner;
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
  private readonly ownerRegistrations: OnceDisposable[] = [];
  private readonly explicitlyOwnedDisposables = new Set<vscode.Disposable>();
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
  private testingApiOwner: Promise<OpenWranglerTestApi> | undefined;
  private sessionCoordinator: SessionCoordinator | undefined;
  private pythonBridge: PythonBridge | undefined;
  private pickleWorkers: TrustedPickleWorkerLifecycle | undefined;
  private notebookVariables: PythonInteractiveCommandProvider | undefined;
  private notebookCellResults: NotebookCellResultTracker | undefined;
  private rVariables: (RLiveVariableProvider & LiterateRVariableProvider) | undefined;
  private nativeNotebookVariables:
    LazyLiveVariables<NotebookLiveVariableProvider, NotebookLiveVariableSnapshot | undefined, void> | undefined;
  private nativeRVariables: LazyLiveVariables<RLiveVariableProvider, RLiveVariableSnapshot, boolean> | undefined;
  private sessionDiagnosticOutput: vscode.OutputChannel | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private bootstrapDisposed = false;
  private started = false;
  private disposed = false;
  private rDiscoveryStarted = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notebookPreviewLoader: NotebookPreviewLoader = loadNotebookPreviewModule,
    private readonly ownerSettlementTimeoutMs = DEFAULT_OWNER_SETTLEMENT_TIMEOUT_MS,
    private readonly additionalOwnerPromises: readonly Promise<unknown>[] = []
  ) {}

  startBeforeFirstYield(): void {
    this.assertActive();
    if (this.started) throw new Error("Open Wrangler activation owners have already started.");
    this.started = true;
    this.context.subscriptions.push(this);
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
    return { testing: await (this.testingApiOwner ??= this.createTestingApi()) };
  }

  diagnosticsForTesting(): LazyActivationDiagnostics {
    return {
      constructedOwners: [...this.constructedOwners],
      rDiscoveryStarted: this.rDiscoveryStarted
    };
  }

  dispose(): void {
    void this.shutdown().catch((error: unknown) => {
      console.error("Open Wrangler could not shut down its activation owners.", error);
    });
  }

  shutdown(): Promise<void> {
    return (this.shutdownPromise ??= this.performShutdown());
  }

  private async performShutdown(): Promise<void> {
    this.disposed = true;
    const failureGroups: unknown[][] = [];
    const bootstrapFailures: unknown[] = [];
    this.disposeBootstrap(bootstrapFailures);
    failureGroups.push(bootstrapFailures);
    await this.observeStartedOwners();

    for (const owner of [...this.ownerRegistrations].reverse()) {
      const failures: unknown[] = [];
      captureSynchronousFailure(() => owner.dispose(), failures);
      failureGroups.push(failures);
    }
    const asyncCleanups: Promise<void>[] = [];
    const startAsyncCleanup = (action: () => Promise<unknown> | undefined): void => {
      const failures: unknown[] = [];
      failureGroups.push(failures);
      asyncCleanups.push(captureFailure(action, failures));
    };
    const runSynchronousCleanup = (action: () => void): void => {
      const failures: unknown[] = [];
      failureGroups.push(failures);
      captureSynchronousFailure(action, failures);
    };
    startAsyncCleanup(() => this.pickleWorkers?.shutdown());
    startAsyncCleanup(() => this.rVariables?.shutdown());
    runSynchronousCleanup(() => this.nativeNotebookVariables?.dispose());
    runSynchronousCleanup(() => this.nativeRVariables?.dispose());
    runSynchronousCleanup(() => this.notebookVariables?.dispose());
    runSynchronousCleanup(() => this.notebookCellResults?.dispose());
    startAsyncCleanup(() => this.sessionCoordinator?.shutdown());
    startAsyncCleanup(() => this.pythonBridge?.shutdown());
    runSynchronousCleanup(() => this.notebookPreview?.dispose());
    runSynchronousCleanup(() => this.sessionDiagnosticOutput?.dispose());
    await Promise.all(asyncCleanups);

    this.ownerRegistrations.splice(0);
    this.explicitlyOwnedDisposables.clear();
    this.pickleWorkers = undefined;
    this.rVariables = undefined;
    this.nativeNotebookVariables = undefined;
    this.nativeRVariables = undefined;
    this.notebookCellResults = undefined;
    this.notebookVariables = undefined;
    this.sessionCoordinator = undefined;
    this.pythonBridge = undefined;
    this.notebookPreview = undefined;
    this.sessionDiagnosticOutput = undefined;

    const failures = failureGroups.flat();
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
    const registrations = this.registerDisposablesTransactional(`lazy ${group} commands`, (retain) => {
      for (const commandId of commandIds) {
        retain(
          vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
            await initialize();
            this.assertActive();
            return vscode.commands.executeCommand(commandId, ...args);
          })
        );
      }
    });
    this.commandRegistrations.set(group, registrations);
  }

  private replaceCommandGroup(group: LazyCommandGroup): void {
    const registrations = this.commandRegistrations.get(group);
    if (!registrations) return;
    this.commandRegistrations.delete(group);
    const failures = disposeDisposables(registrations);
    if (failures.length > 0) throw cleanupAggregate(`Could not replace the ${group} activation commands.`, failures);
  }

  private installUtilityCommands(): void {
    const registrations = this.registerDisposablesTransactional("utility commands", (retain) => {
      retain(
        vscode.commands.registerCommand("openWrangler.openWalkthrough", () =>
          vscode.commands.executeCommand(
            "workbench.action.openWalkthrough",
            "Matt17BR.openwrangler#gettingStarted",
            false
          )
        )
      );
      retain(
        vscode.commands.registerCommand("openWrangler.openSettings", () =>
          vscode.commands.executeCommand("workbench.action.openSettings", "@ext:Matt17BR.openwrangler")
        )
      );
      retain(
        vscode.commands.registerCommand("openWrangler.reportIssue", () =>
          vscode.env.openExternal(
            vscode.Uri.parse(
              `https://github.com/Matt17BR/openwrangler/issues/new?title=${encodeURIComponent("Open Wrangler issue")}&body=${encodeURIComponent(`VS Code: ${vscode.version}\nOS: ${process.platform}\n\nSteps to reproduce:\n`)}`
            )
          )
        )
      );
    });
    this.commandRegistrations.set("utility", registrations);
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
  }

  private installNativeViewGates(): void {
    this.nativeViewRegistrations = this.registerDisposablesTransactional("lazy native view providers", (retain) => {
      for (const id of NATIVE_TREE_VIEW_IDS) {
        retain(
          vscode.window.registerTreeDataProvider(
            id,
            new LazyTreeProvider(() =>
              this.ensureNativeOwner().then(({ owner }) => owner.treeProvider(id as NativeTreeViewId))
            )
          )
        );
      }
      retain(
        vscode.window.registerWebviewViewProvider(
          "openWrangler.codePreview",
          new LazyWebviewViewProvider(() => this.ensureNativeOwner().then(({ owner }) => owner.codePreviewProvider())),
          { webviewOptions: { retainContextWhenHidden: true } }
        )
      );
    });
  }

  private installNotebookVisibilityGate(): void {
    const onNotebookSurface = (): void => this.startVisibleNotebookOwners();
    const subscriptions = this.registerDisposablesTransactional("notebook visibility listeners", (retain) => {
      retain(vscode.window.onDidChangeVisibleNotebookEditors(onNotebookSurface));
      retain(vscode.window.onDidChangeActiveNotebookEditor(onNotebookSurface));
      retain(vscode.workspace.onDidOpenNotebookDocument(onNotebookSurface));
      retain(vscode.workspace.onDidGrantWorkspaceTrust(onNotebookSurface));
    });
    this.bootstrapSubscriptions.push(...subscriptions);
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
    this.explicitlyOwnedDisposables.add(preview);
    this.constructedOwners.push("notebook-preview");
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
      }
      output.appendLine(message);
    });
    this.sessionCoordinator = coordinator;
    this.explicitlyOwnedDisposables.add(coordinator);
    this.constructedOwners.push("session");
    return { coordinator };
  }

  private ensurePythonOwner(): Promise<PythonOwner> {
    return (this.pythonOwner ??= this.loadPythonOwner());
  }

  private async loadPythonOwner(): Promise<PythonOwner> {
    const { PythonBridge } = await import("./pythonBridge.js");
    this.assertActive();
    const bridge = new PythonBridge(this.context);
    this.pythonBridge = bridge;
    this.explicitlyOwnedDisposables.add(bridge);
    this.constructedOwners.push("python");
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
    this.captureOwnerRegistration("file", () => module.registerFileCommands(this.context, coordinatedBridge));
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
    this.pickleWorkers = lifecycle;
    this.explicitlyOwnedDisposables.add(lifecycle);
    this.replaceCommandGroup("pickle");
    try {
      this.captureOwnerRegistration("pickle", () =>
        conversion.registerTrustedPickleConversion(this.context, python.bridge, {
          runWorker: (options) => lifecycle.run(options)
        })
      );
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      this.pickleWorkers = undefined;
      this.explicitlyOwnedDisposables.delete(lifecycle);
      await captureFailure(() => lifecycle.shutdown(), cleanupFailures);
      throw withCleanupFailures(error, cleanupFailures, "Trusted pickle activation failed during cleanup.");
    }
    this.constructedOwners.push("pickle");
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
    this.notebookCellResults = cellResults;
    this.explicitlyOwnedDisposables.add(cellResults);
    this.replaceCommandGroup("notebook");
    try {
      let variables: PythonInteractiveCommandProvider | undefined;
      this.captureOwnerRegistration("notebook", () => {
        variables = interactive.registerPythonInteractiveCommands(this.context, session.coordinator);
        this.notebookVariables = variables;
        this.explicitlyOwnedDisposables.add(variables);
        cellResults.start();
        jupyter.registerNotebookCommands(this.context, session.coordinator);
        cellResult.registerNotebookCellResultAction(this.context, session.coordinator, cellResults);
        renderer.registerNotebookRendererMessaging(this.context, session.coordinator);
      });
      if (!variables) throw new Error("Notebook variable registration completed without an owner.");
      this.constructedOwners.push("notebook");
      return { variables, cellResults };
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      const variables = this.notebookVariables;
      this.notebookVariables = undefined;
      this.notebookCellResults = undefined;
      if (variables) captureSynchronousFailure(() => variables.dispose(), cleanupFailures);
      captureSynchronousFailure(() => cellResults.dispose(), cleanupFailures);
      this.explicitlyOwnedDisposables.delete(cellResults);
      if (variables) this.explicitlyOwnedDisposables.delete(variables);
      throw withCleanupFailures(error, cleanupFailures, "Notebook activation failed during rollback.");
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
    let variables: (RLiveVariableProvider & LiterateRVariableProvider) | undefined;
    try {
      this.captureOwnerRegistration("r", () => {
        variables = interactive.registerRInteractiveCommands(this.context, session.coordinator);
        this.rVariables = variables;
        this.explicitlyOwnedDisposables.add(variables);
        variables.startAutomaticDiscovery();
      });
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      this.rVariables = undefined;
      if (variables) this.explicitlyOwnedDisposables.delete(variables);
      await captureFailure(() => variables?.shutdown(), cleanupFailures);
      throw withCleanupFailures(error, cleanupFailures, "R activation failed during rollback.");
    }
    if (!variables) throw new Error("R registration completed without an owner.");
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
    this.captureOwnerRegistration("r-document", () =>
      documentCommands.registerRDocumentCommands(this.context, session.coordinator, {
        python: notebook.variables,
        r: r.variables
      })
    );
    this.constructedOwners.push("r-document");
  }

  private ensureRuntimeOwner(): Promise<void> {
    return (this.runtimeOwner ??= this.loadRuntimeOwner());
  }

  private async loadRuntimeOwner(): Promise<void> {
    const [runtime, python] = await Promise.all([import("./runtimeCommands.js"), this.ensurePythonOwner()]);
    this.assertActive();
    this.replaceCommandGroup("runtime");
    this.captureOwnerRegistration("runtime", () => runtime.registerRuntimeCommands(this.context, python.bridge));
    this.constructedOwners.push("runtime-commands");
  }

  private ensureNativeOwner(): Promise<NativeOwner> {
    return (this.nativeOwner ??= this.loadNativeOwner());
  }

  private async loadNativeOwner(): Promise<NativeOwner> {
    const [native, session] = await Promise.all([import("./nativeViews.js"), this.ensureSessionOwner()]);
    this.assertActive();
    this.replaceCommandGroup("native");
    this.replaceCommandGroup("utility");
    const providerDisposalFailures = disposeDisposables(this.nativeViewRegistrations.splice(0));
    if (providerDisposalFailures.length > 0) {
      throw cleanupAggregate("Could not replace the lazy native view providers.", providerDisposalFailures);
    }
    const rVariables = (this.nativeRVariables ??= new LazyLiveVariables<
      RLiveVariableProvider,
      RLiveVariableSnapshot,
      boolean
    >(
      () => this.ensureROwner().then(({ variables }) => variables),
      {
        state: "loading",
        terminalLabel: "R session",
        message: "Loading the R integration…",
        variables: []
      },
      (error) => this.reportLazyFailure("R", error)
    ));
    const notebookVariables = (this.nativeNotebookVariables ??= new LazyLiveVariables<
      NotebookLiveVariableProvider,
      NotebookLiveVariableSnapshot | undefined,
      void
    >(
      () => this.ensureNotebookOwner().then(({ variables }) => variables),
      {
        state: "loading",
        notebookLabel: "Notebook",
        message: "Loading the notebook integration…",
        variables: []
      },
      (error) => this.reportLazyFailure("notebook", error),
      async (owner) => {
        if (owner.snapshot()) {
          await owner.refreshFromCommand();
          return;
        }
        await rVariables.refreshFromCommand();
      }
    ));
    const owner = this.captureOwnerRegistration("native", () =>
      native.registerNativeViews(this.context, session.coordinator, notebookVariables, rVariables)
    );
    this.constructedOwners.push("native-views");
    return { owner, controller: owner };
  }

  private registerDisposablesTransactional(
    name: string,
    register: (retain: (disposable: vscode.Disposable) => void) => void
  ): vscode.Disposable[] {
    const registrations: vscode.Disposable[] = [];
    try {
      register((disposable) => registrations.push(disposable));
      return registrations;
    } catch (error) {
      throw withCleanupFailures(
        error,
        disposeDisposables(registrations),
        `Open Wrangler could not roll back its partial ${name}.`
      );
    }
  }

  private captureOwnerRegistration<T>(name: string, register: () => T): T {
    const subscriptionStart = this.context.subscriptions.length;
    let value: T;
    try {
      value = register();
    } catch (error) {
      const additions = this.context.subscriptions.splice(subscriptionStart);
      const rollback = additions.filter((item) => !this.explicitlyOwnedDisposables.has(item));
      throw withCleanupFailures(
        error,
        disposeDisposables(rollback),
        `Open Wrangler could not roll back its partial ${name} owner.`
      );
    }
    const additions = this.context.subscriptions.splice(subscriptionStart);
    const owned = additions.filter((item) => !this.explicitlyOwnedDisposables.has(item));
    this.ownerRegistrations.push(new OnceDisposable(name, owned));
    return value;
  }

  private disposeBootstrap(failures: unknown[]): void {
    if (this.bootstrapDisposed) return;
    this.bootstrapDisposed = true;
    failures.push(...disposeDisposables(this.bootstrapSubscriptions.splice(0)));
    for (const registrations of this.commandRegistrations.values()) {
      failures.push(...disposeDisposables(registrations));
    }
    this.commandRegistrations.clear();
    if (this.customEditorRegistration) {
      failures.push(...disposeDisposables([this.customEditorRegistration]));
      this.customEditorRegistration = undefined;
    }
    failures.push(...disposeDisposables(this.nativeViewRegistrations.splice(0)));
  }

  private async observeStartedOwners(): Promise<void> {
    const observed = new Set<Promise<unknown>>();
    const deadline = Date.now() + Math.max(0, this.ownerSettlementTimeoutMs);
    while (true) {
      const pending = this.startedOwnerPromises().filter((promise) => !observed.has(promise));
      if (pending.length === 0) return;
      for (const promise of pending) observed.add(promise);
      const settlement = Promise.allSettled(pending);
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await settlesWithin(settlement, remaining))) {
        // Promise.allSettled has already attached both fulfillment and rejection
        // observers. Late imports re-check disposed state before construction.
        return;
      }
    }
  }

  private startedOwnerPromises(): Promise<unknown>[] {
    return [
      this.sessionOwner,
      this.pythonOwner,
      this.fileOwner,
      this.pickleOwner,
      this.notebookOwner,
      this.rOwner,
      this.rDocumentOwner,
      this.runtimeOwner,
      this.nativeOwner,
      this.nativeNotebookVariables?.startedPromise(),
      this.nativeRVariables?.startedPromise(),
      this.initialNotebookOwner,
      this.testingApiOwner,
      ...this.additionalOwnerPromises
    ].filter((promise): promise is Promise<unknown> => promise !== undefined);
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

interface LiveVariables<S, R> extends vscode.Disposable {
  readonly onDidChangeVariables: vscode.Event<void>;
  snapshot(): S;
  refreshFromCommand(): Promise<R>;
}

class LazyLiveVariables<T extends LiveVariables<S, R>, S, R> implements LiveVariables<S, R> {
  private readonly changed = new vscode.EventEmitter<void>();
  private owner: T | undefined;
  private loading: Promise<T> | undefined;
  private ownerSubscription: vscode.Disposable | undefined;
  private disposed = false;

  readonly onDidChangeVariables = this.changed.event;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly pendingSnapshot: S,
    private readonly reportFailure: (error: unknown) => void,
    private readonly refresh: (owner: T) => Promise<R> = (owner) => owner.refreshFromCommand()
  ) {}

  snapshot(): S {
    if (!this.owner) this.start();
    return this.owner?.snapshot() ?? this.pendingSnapshot;
  }

  async refreshFromCommand(): Promise<R> {
    return this.refresh(await this.ensure());
  }

  startAutomaticDiscovery(): void {
    this.start();
  }

  async shutdown(): Promise<void> {
    this.dispose();
  }

  startedPromise(): Promise<T> | undefined {
    return this.loading;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ownerSubscription?.dispose();
    this.ownerSubscription = undefined;
    this.changed.dispose();
  }

  private start(): void {
    void this.ensure().catch(() => undefined);
  }

  private ensure(): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Open Wrangler live-variable routing was disposed."));
    return (this.loading ??= this.load().then(
      (owner) => {
        if (this.disposed) return owner;
        this.owner = owner;
        this.ownerSubscription = owner.onDidChangeVariables(() => this.changed.fire());
        this.changed.fire();
        return owner;
      },
      (error: unknown) => {
        if (!this.disposed) {
          this.reportFailure(error);
          this.changed.fire();
        }
        throw error;
      }
    ));
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
  private delegate: vscode.TreeDataProvider<vscode.TreeItem> | undefined;

  constructor(private readonly load: () => Promise<vscode.TreeDataProvider<vscode.TreeItem>>) {}

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return this.delegate?.getTreeItem(item) ?? item;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const provider = (this.delegate ??= await this.load());
    return (await provider.getChildren(element)) ?? [];
  }
}

class LazyWebviewViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly load: () => Promise<vscode.WebviewViewProvider>) {}

  async resolveWebviewView(
    view: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): Promise<void> {
    const provider = await this.load();
    await provider.resolveWebviewView(view, context, token);
  }
}

class OnceDisposable implements vscode.Disposable {
  private disposed = false;

  constructor(
    private readonly name: string,
    private readonly disposables: readonly vscode.Disposable[]
  ) {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures = disposeDisposables(this.disposables);
    if (failures.length > 0) {
      throw cleanupAggregate(`Open Wrangler ${this.name} owner cleanup encountered multiple failures.`, failures);
    }
  }
}

function disposeDisposables(disposables: readonly vscode.Disposable[]): unknown[] {
  const failures: unknown[] = [];
  for (const disposable of [...disposables].reverse()) {
    captureSynchronousFailure(() => disposable.dispose(), failures);
  }
  return failures;
}

function captureSynchronousFailure(action: () => void, failures: unknown[]): void {
  try {
    action();
  } catch (error) {
    failures.push(...flattenFailures(error));
  }
}

async function captureFailure(action: () => Promise<unknown> | undefined, failures: unknown[]): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(...flattenFailures(error));
  }
}

function withCleanupFailures(primary: unknown, cleanupFailures: readonly unknown[], message: string): unknown {
  const failures = [...flattenFailures(primary), ...cleanupFailures.flatMap(flattenFailures)];
  return failures.length === 1 ? failures[0] : new AggregateError(failures, message);
}

function cleanupAggregate(message: string, failures: readonly unknown[]): unknown {
  const flattened = failures.flatMap(flattenFailures);
  return flattened.length === 1 ? flattened[0] : new AggregateError(flattened, message);
}

function flattenFailures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(flattenFailures) : [error];
}

async function settlesWithin(settlement: Promise<unknown>, deadlineMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([settlement.then(() => true as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
