import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { getSetting } from "../configuration";
import { DetachedBridgeRequestError } from "../dataBridge";
import { SessionCoordinator } from "../sessionCoordinator";
import { OpenWranglerPanel, restoreEditorGroupAfterQuickPick } from "../webviewPanel";
import { RInteractiveSessionTransport } from "./rInteractiveSessionTransport";
import {
  defaultRVscodeWorkspaceWatcherFactory,
  type RVscodeWorkspaceWatcher,
  type RVscodeWorkspaceWatcherFactory
} from "./rVscodeWorkspaceWatcher";
import { OPEN_LITERATE_DOCUMENT_CURSOR_COMMAND, OPEN_R_DOCUMENT_COMMAND } from "./rDocumentCommands";
import { RKernelBridge, type RKernelBridgeTransport } from "./rKernelBridge";
import type { RProcessVariableDescriptor, RProcessVariableDiscovery } from "./rProcessTransport";
import {
  isCurrentLiterateDocumentOrigin,
  isSupportedLiterateUri,
  type LiterateDocumentOrigin
} from "../literateDocumentOrigin";

export const OPEN_R_INTERACTIVE_VARIABLE_COMMAND = "openWrangler.openRInteractiveVariable";
export const OPEN_R_DATAFRAME_COMMAND = "openWrangler.openRDataframe";
export const REFRESH_R_INTERACTIVE_VARIABLES_COMMAND = "openWrangler.refreshRInteractiveVariables";
export const OPEN_CACHED_R_INTERACTIVE_VARIABLE_COMMAND = "openWrangler.openCachedRInteractiveVariable";

interface RInteractiveQuickPickItem extends vscode.QuickPickItem {
  readonly variable: RProcessVariableDescriptor;
}

interface CachedRInteractiveQuickPickItem extends RInteractiveQuickPickItem {
  readonly handle: string;
}

interface CachedRInteractivePickerStateBase {
  readonly generation: number;
  readonly terminal: vscode.Terminal;
  readonly items: readonly CachedRInteractiveQuickPickItem[];
  readonly truncated: boolean;
}

type CachedRInteractivePickerState = CachedRInteractivePickerStateBase &
  (
    | { readonly transport: RInteractiveCommandTransport; readonly watcher?: undefined }
    | { readonly watcher: RVscodeWorkspaceWatcher; readonly transport?: undefined }
  );

export interface RLiveVariableItem {
  readonly handle: string;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

export type RLiveVariableSnapshot =
  | {
      readonly state: "idle" | "loading" | "empty" | "error";
      readonly terminalLabel: string;
      readonly message: string;
      readonly variables: readonly [];
    }
  | {
      readonly state: "ready";
      readonly terminalLabel: string;
      readonly message: string;
      readonly variables: readonly RLiveVariableItem[];
    };

export interface RLiveVariableProvider extends vscode.Disposable {
  readonly onDidChangeVariables: vscode.Event<void>;
  snapshot(): RLiveVariableSnapshot;
  startAutomaticDiscovery(): void;
  refreshFromCommand(): Promise<boolean>;
  shutdown(): Promise<void>;
}

export interface LiterateRVariableProvider {
  captureActiveSession(): LiterateRSessionIdentity | undefined;
  openLiterateSession(origin: LiterateDocumentOrigin, session: LiterateRSessionIdentity): Promise<boolean>;
  runLiterateChunkAndOpen(
    origin: LiterateDocumentOrigin,
    session: LiterateRSessionIdentity,
    code: string
  ): Promise<boolean>;
}

/** Opaque identity for the exact public VS Code terminal captured before an await. */
export interface LiterateRSessionIdentity {
  readonly terminal: vscode.Terminal;
}

export interface RInteractiveCommandTransport extends RKernelBridgeTransport {
  readonly onDidChangeVariables: vscode.Event<RProcessVariableDiscovery>;
  discoverVariables(options?: {
    readonly cancellation?: vscode.CancellationToken;
    readonly timeoutMs?: number;
  }): Promise<RProcessVariableDiscovery>;
  evaluateAndDiscoverVariables(
    code: string,
    options?: {
      readonly cancellation?: vscode.CancellationToken;
      readonly timeoutMs?: number;
    }
  ): Promise<RProcessVariableDiscovery>;
}

export interface RInteractiveTransportFactory {
  create(
    context: vscode.ExtensionContext,
    options?: Readonly<{ terminalMode?: "active" | "activeOrCreate"; terminal?: vscode.Terminal }>
  ): RInteractiveCommandTransport;
}

const defaultTransportFactory: RInteractiveTransportFactory = Object.freeze({
  create: (
    context: vscode.ExtensionContext,
    options?: Readonly<{ terminalMode?: "active" | "activeOrCreate"; terminal?: vscode.Terminal }>
  ) => new RInteractiveSessionTransport(context, options)
});

const AUTOMATIC_ATTACHMENT_DEBOUNCE_MS = 300;

interface CachedRVariable {
  readonly variable: RProcessVariableDescriptor;
  readonly item: RLiveVariableItem;
}

/** Registers active-R discovery and owns the refreshable list shown in Operations. */
export function registerRInteractiveCommands(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  transportFactory: RInteractiveTransportFactory = defaultTransportFactory,
  watcherFactory: RVscodeWorkspaceWatcherFactory = defaultRVscodeWorkspaceWatcherFactory
): RLiveVariableProvider & LiterateRVariableProvider {
  const provider = new RInteractiveVariableCoordinator(context, coordinator, transportFactory, watcherFactory);
  context.subscriptions.push(
    provider,
    vscode.commands.registerCommand(OPEN_R_DATAFRAME_COMMAND, (resource?: unknown) =>
      isLiterateDocumentResource(resource)
        ? vscode.commands.executeCommand<boolean>(OPEN_LITERATE_DOCUMENT_CURSOR_COMMAND)
        : isOfficialRTerminal(vscode.window.activeTerminal)
          ? provider.chooseAndOpen()
          : vscode.commands.executeCommand<boolean>(OPEN_R_DOCUMENT_COMMAND, resource)
    ),
    vscode.commands.registerCommand(OPEN_R_INTERACTIVE_VARIABLE_COMMAND, () => provider.chooseAndOpen()),
    vscode.commands.registerCommand(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND, () => provider.refreshFromCommand()),
    vscode.commands.registerCommand(OPEN_CACHED_R_INTERACTIVE_VARIABLE_COMMAND, (handle: unknown) =>
      provider.openCachedVariable(handle)
    )
  );
  return provider;
}

class RInteractiveVariableCoordinator implements RLiveVariableProvider, LiterateRVariableProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  private currentSnapshot: RLiveVariableSnapshot;
  private readonly variablesByHandle = new Map<string, CachedRVariable>();
  private readonly managedTransports = new Set<RInteractiveCommandTransport>();
  private ownedTransport: RInteractiveCommandTransport | undefined;
  private ownedTerminal: vscode.Terminal | undefined;
  private transportInvalidationSubscription: vscode.Disposable | undefined;
  private transportVariableChangeSubscription: vscode.Disposable | undefined;
  private workspaceWatcher: RVscodeWorkspaceWatcher | undefined;
  private workspaceWatcherTerminal: vscode.Terminal | undefined;
  private workspaceWatcherInvalidationSubscription: vscode.Disposable | undefined;
  private workspaceWatcherChangeSubscription: vscode.Disposable | undefined;
  private automaticDiscoveryStarted = false;
  private automaticAttachmentTimer: ReturnType<typeof setTimeout> | undefined;
  private automaticAttachmentRunning = false;
  private automaticAttachmentTask: Promise<void> | undefined;
  private automaticAttachmentQueuedTerminal: vscode.Terminal | undefined;
  private generation = 0;
  private disposed = false;
  private shutdownPromise: Promise<void> | undefined;

  readonly onDidChangeVariables = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly coordinator: SessionCoordinator,
    private readonly transportFactory: RInteractiveTransportFactory,
    private readonly watcherFactory: RVscodeWorkspaceWatcherFactory
  ) {
    this.currentSnapshot = idleSnapshot(vscode.window.activeTerminal);
    this.subscriptions = [
      vscode.window.onDidChangeActiveTerminal((terminal) => this.onActiveTerminalChanged(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => this.onTerminalClosed(terminal)),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleAutomaticAttachment(vscode.window.activeTerminal))
    ];
  }

  snapshot(): RLiveVariableSnapshot {
    return this.currentSnapshot;
  }

  dispose(): void {
    void this.shutdown().catch((error: unknown) => {
      console.error("Open Wrangler could not shut down its active R session provider.", error);
    });
  }

  startAutomaticDiscovery(): void {
    if (this.disposed || this.automaticDiscoveryStarted) return;
    this.automaticDiscoveryStarted = true;
    this.scheduleAutomaticAttachment(vscode.window.activeTerminal);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    this.generation += 1;
    const automaticAttachmentTask = this.automaticAttachmentTask;
    this.cancelAutomaticAttachment();
    this.releaseWorkspaceWatcher();
    this.releaseOwnedTransport();
    this.variablesByHandle.clear();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.changeEmitter.dispose();
    const transports = [...this.managedTransports];
    this.managedTransports.clear();
    this.shutdownPromise = settleShutdown(automaticAttachmentTask, disposeTransports(transports));
    return this.shutdownPromise;
  }

  async refreshFromCommand(): Promise<boolean> {
    if (!requireTrustedRSession()) return false;
    const terminal = vscode.window.activeTerminal;
    if (!isOfficialRTerminal(terminal)) {
      this.replaceSnapshot({
        state: "idle",
        terminalLabel: "R session",
        message: "Select the R terminal that owns the dataframe first.",
        variables: []
      });
      void vscode.window.showInformationMessage("Select the R terminal that owns the dataframe, then try again.");
      return false;
    }

    this.cancelAutomaticAttachment();
    this.releaseWorkspaceWatcher();
    const prepared = this.prepareRefresh(terminal);
    if (!prepared) return false;

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Refreshing R dataframes",
        cancellable: true
      },
      (_progress, cancellation) =>
        this.refreshExactTerminal(
          terminal,
          prepared.transport,
          prepared.generation,
          prepared.previousCleanup,
          cancellation
        )
    );
  }

  captureActiveSession(): LiterateRSessionIdentity | undefined {
    const terminal = vscode.window.activeTerminal;
    return isExactActiveRTerminal(terminal) ? Object.freeze({ terminal }) : undefined;
  }

  openLiterateSession(origin: LiterateDocumentOrigin, session: LiterateRSessionIdentity): Promise<boolean> {
    if (!isCurrentLiterateDocumentOrigin(origin) || !isCurrentLiterateRSession(session)) {
      return Promise.resolve(false);
    }
    return this.chooseAndOpen(origin, session);
  }

  runLiterateChunkAndOpen(
    origin: LiterateDocumentOrigin,
    session: LiterateRSessionIdentity,
    code: string
  ): Promise<boolean> {
    if (!isCurrentLiterateDocumentOrigin(origin) || !isCurrentLiterateRSession(session)) {
      return Promise.resolve(false);
    }
    return this.chooseAndOpen(origin, session, code);
  }

  async chooseAndOpen(
    origin?: LiterateDocumentOrigin,
    expectedSession?: LiterateRSessionIdentity,
    evaluationCode?: string
  ): Promise<boolean> {
    if (!requireTrustedRSession()) return false;
    if (this.disposed) return false;
    if (origin && !isCurrentLiterateDocumentOrigin(origin)) return false;
    if (expectedSession && !isCurrentLiterateRSession(expectedSession)) return false;
    const documentOrigin = evaluationCode === undefined ? undefined : origin;
    const cached = evaluationCode === undefined ? this.cachedPickerState() : undefined;
    if (cached && (!expectedSession || cached.terminal === expectedSession.terminal)) {
      return this.chooseCachedAndOpen(cached, origin, expectedSession);
    }

    this.releaseWorkspaceWatcher();
    const generation = ++this.generation;
    const previous = this.releaseOwnedTransport();
    if (previous) {
      this.replaceSnapshot(idleSnapshot(vscode.window.activeTerminal));
      const cleanupError = await this.disposeManagedTransport(previous);
      if (!this.isCurrentLiterateRequest(generation, origin, expectedSession)) return false;
      if (cleanupError) {
        showCleanupError(cleanupError);
        return false;
      }
    }
    let transport: RInteractiveCommandTransport;
    try {
      if (expectedSession && !isCurrentLiterateRSession(expectedSession)) return false;
      transport = this.transportFactory.create(this.context, {
        terminalMode: expectedSession ? "active" : "activeOrCreate",
        ...(expectedSession ? { terminal: expectedSession.terminal } : {})
      });
      this.managedTransports.add(transport);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not connect to the active R session: ${errorMessage(error)}`);
      return false;
    }

    let discovery: RProcessVariableDiscovery;
    try {
      discovery = await discoverWithProgress(
        transport,
        evaluationCode === undefined
          ? "Finding dataframes in the active R session"
          : "Running chunk and finding dataframes",
        evaluationCode
      );
    } catch (error) {
      const cleanupError = await this.disposeManagedTransport(transport);
      if (!this.isCurrentLiterateRequest(generation, origin, expectedSession)) return false;
      if (error instanceof DetachedBridgeRequestError && error.reason === "cancellation" && !cleanupError) return false;
      void vscode.window.showErrorMessage(
        `Could not inspect the active R session: ${errorMessage(error)}${cleanupSuffix(cleanupError)}`
      );
      return false;
    }

    if (!this.isCurrentLiterateRequest(generation, origin, expectedSession)) {
      const cleanupError = await this.disposeManagedTransport(transport);
      if (cleanupError) showCleanupError(cleanupError);
      return false;
    }

    if (discovery.variables.length === 0) {
      const cleanupError = await this.disposeManagedTransport(transport);
      if (cleanupError) {
        showCleanupError(cleanupError);
        return false;
      }
      void vscode.window.showInformationMessage(
        "The active R session does not contain a data.frame, tibble, or data.table."
      );
      return false;
    }

    const items = discovery.variables.map(rInteractiveQuickPickItem);
    let picked: RInteractiveQuickPickItem | undefined;
    try {
      picked = await vscode.window.showQuickPick(items, {
        title: "Open Wrangler: Choose a dataframe from the active R session",
        placeHolder: discovery.truncated
          ? "Select a dataframe (the variable list was truncated)"
          : "Select a data.frame, tibble, or data.table",
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
      });
    } catch (error) {
      const cleanupError = await this.disposeManagedTransport(transport);
      if (!this.isCurrentLiterateRequest(generation, origin, expectedSession)) return false;
      void vscode.window.showErrorMessage(
        `Could not choose an R dataframe: ${errorMessage(error)}${cleanupSuffix(cleanupError)}`
      );
      return false;
    }
    if (!this.isCurrentLiterateRequest(generation, origin, expectedSession)) {
      const cleanupError = await this.disposeManagedTransport(transport);
      if (cleanupError) showCleanupError(cleanupError);
      return false;
    }
    if (!picked || !items.includes(picked)) {
      const cleanupError = await this.disposeManagedTransport(transport);
      if (cleanupError) showCleanupError(cleanupError);
      return false;
    }
    await restoreEditorGroupAfterQuickPick();
    if (!this.isCurrentLiterateRequest(generation, origin, expectedSession)) {
      const cleanupError = await this.disposeManagedTransport(transport);
      if (cleanupError) showCleanupError(cleanupError);
      return false;
    }
    if (!this.managedTransports.delete(transport)) return false;
    const opened = await this.openWithTransport(transport, picked.variable, documentOrigin);
    if (opened) this.scheduleAutomaticAttachment(vscode.window.activeTerminal);
    return opened;
  }

  private cachedPickerState(): CachedRInteractivePickerState | undefined {
    const transport = this.ownedTransport;
    const watcher = this.workspaceWatcher;
    const terminal = this.ownedTerminal ?? this.workspaceWatcherTerminal;
    if (
      this.currentSnapshot.state !== "ready" ||
      !terminal ||
      !((transport && terminal === this.ownedTerminal) || (watcher && terminal === this.workspaceWatcherTerminal)) ||
      !vscode.window.terminals.includes(terminal) ||
      !isOfficialRTerminal(terminal)
    ) {
      return undefined;
    }
    const items = this.currentSnapshot.variables.map((item) => {
      const cached = this.variablesByHandle.get(item.handle);
      return cached ? Object.freeze({ ...cached.item, handle: item.handle, variable: cached.variable }) : undefined;
    });
    if (items.some((item) => item === undefined)) return undefined;
    return Object.freeze({
      generation: this.generation,
      terminal,
      items: Object.freeze(items as CachedRInteractiveQuickPickItem[]),
      truncated: this.currentSnapshot.message.startsWith("Showing the first"),
      ...(transport ? { transport } : { watcher: watcher! })
    });
  }

  private async chooseCachedAndOpen(
    state: CachedRInteractivePickerState,
    origin?: LiterateDocumentOrigin,
    expectedSession?: LiterateRSessionIdentity
  ): Promise<boolean> {
    let picked: CachedRInteractiveQuickPickItem | undefined;
    try {
      picked = await vscode.window.showQuickPick(state.items, {
        title: "Open Wrangler: Choose a dataframe from the active R session",
        placeHolder: state.truncated
          ? "Select a dataframe (the variable list was truncated)"
          : "Select a data.frame, tibble, or data.table",
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
      });
    } catch (error) {
      if (
        this.isCurrentCachedPicker(state) &&
        (!origin || isCurrentLiterateDocumentOrigin(origin)) &&
        (!expectedSession || isCurrentLiterateRSession(expectedSession))
      ) {
        void vscode.window.showErrorMessage(`Could not choose an R dataframe: ${errorMessage(error)}`);
      }
      return false;
    }
    if (!picked || !state.items.includes(picked)) return false;
    await restoreEditorGroupAfterQuickPick();
    if (
      !this.isCurrentCachedPicker(state) ||
      (origin && !isCurrentLiterateDocumentOrigin(origin)) ||
      (expectedSession && !isCurrentLiterateRSession(expectedSession))
    ) {
      void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
      return false;
    }
    const cached = this.variablesByHandle.get(picked.handle);
    if (!cached || cached.variable !== picked.variable) {
      void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
      return false;
    }
    if (state.watcher) {
      return this.openWatcherVariable(state, cached.variable);
    }
    const transferred = this.releaseOwnedTransport();
    if (transferred !== state.transport || !this.managedTransports.delete(state.transport)) {
      void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
      return false;
    }
    this.generation += 1;
    this.replaceSnapshot(idleSnapshot(state.terminal));
    const opened = await this.openWithTransport(state.transport, cached.variable);
    if (opened) this.scheduleAutomaticAttachment(vscode.window.activeTerminal);
    return opened;
  }

  private isCurrentCachedPicker(state: CachedRInteractivePickerState): boolean {
    return (
      this.isCurrent(state.generation) &&
      (state.watcher
        ? this.workspaceWatcher === state.watcher && this.workspaceWatcherTerminal === state.terminal
        : this.ownedTransport === state.transport && this.ownedTerminal === state.terminal) &&
      vscode.window.terminals.includes(state.terminal) &&
      isOfficialRTerminal(state.terminal)
    );
  }

  private async openWatcherVariable(
    state: CachedRInteractivePickerState & { readonly watcher: RVscodeWorkspaceWatcher },
    selected: RProcessVariableDescriptor
  ): Promise<boolean> {
    try {
      await state.watcher.verifyCurrent();
    } catch {
      if (this.isCurrentCachedPicker(state)) {
        this.invalidateCurrentSession("The R session changed. Use Refresh R dataframes and try again.");
      }
      return false;
    }
    if (!this.isCurrentCachedPicker(state)) {
      void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
      return false;
    }
    let transport: RInteractiveCommandTransport;
    try {
      transport = this.transportFactory.create(this.context, { terminalMode: "active", terminal: state.terminal });
      this.managedTransports.add(transport);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not connect to the active R session: ${errorMessage(error)}`);
      return false;
    }
    if (!this.isCurrentCachedPicker(state)) {
      const cleanupError = await this.disposeManagedTransport(transport);
      if (cleanupError) showCleanupError(cleanupError);
      return false;
    }
    if (!this.managedTransports.delete(transport)) return false;
    return this.openWithTransport(transport, selected);
  }

  async openCachedVariable(handle: unknown): Promise<boolean> {
    if (typeof handle !== "string") return false;
    if (!requireTrustedRSession()) return false;
    const cached = this.variablesByHandle.get(handle);
    const transport = this.ownedTransport;
    const watcher = this.workspaceWatcher;
    const terminal = this.ownedTerminal ?? this.workspaceWatcherTerminal;
    if (
      !cached ||
      !terminal ||
      !(transport || watcher) ||
      !vscode.window.terminals.includes(terminal) ||
      !isOfficialRTerminal(terminal)
    ) {
      void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
      return false;
    }

    if (watcher) {
      const state = this.cachedPickerState();
      if (!state || state.watcher !== watcher) {
        void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
        return false;
      }
      return this.openWatcherVariable(
        state as CachedRInteractivePickerState & { watcher: RVscodeWorkspaceWatcher },
        cached.variable
      );
    }
    if (!transport) return false;

    const transferred = this.releaseOwnedTransport();
    if (transferred !== transport) {
      void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
      return false;
    }
    if (!this.managedTransports.delete(transport)) {
      void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
      return false;
    }
    this.generation += 1;
    this.replaceSnapshot(idleSnapshot(terminal));
    const opened = await this.openWithTransport(transport, cached.variable);
    if (opened) this.scheduleAutomaticAttachment(vscode.window.activeTerminal);
    return opened;
  }

  private prepareRefresh(
    terminal: vscode.Terminal,
    preserveReadySnapshot = false
  ):
    | Readonly<{
        generation: number;
        transport: RInteractiveCommandTransport;
        previousCleanup: Promise<unknown | undefined>;
      }>
    | undefined {
    if (this.disposed) return undefined;
    const generation = ++this.generation;
    let transport = this.ownedTerminal === terminal ? this.ownedTransport : undefined;
    let previousCleanup = Promise.resolve<unknown | undefined>(undefined);
    if (!transport) {
      if (vscode.window.activeTerminal !== terminal) return undefined;
      try {
        // Construction captures this exact active Terminal before withProgress can yield control.
        transport = this.transportFactory.create(this.context, { terminalMode: "active", terminal });
        this.managedTransports.add(transport);
      } catch (error) {
        this.replaceSnapshot({
          state: "error",
          terminalLabel: terminal.name,
          message: errorMessage(error),
          variables: []
        });
        return undefined;
      }
      const previous = this.releaseOwnedTransport();
      this.ownedTransport = transport;
      this.ownedTerminal = terminal;
      this.transportInvalidationSubscription = transport.onDidInvalidateKernel(() => {
        if (this.ownedTransport === transport)
          this.invalidateCurrentSession("The R session changed. Wait for its prompt before reading it again.");
      });
      this.transportVariableChangeSubscription = transport.onDidChangeVariables((discovery) => {
        if (
          this.ownedTransport === transport &&
          this.ownedTerminal === terminal &&
          vscode.window.terminals.includes(terminal)
        ) {
          this.publishDiscovery(terminal, discovery);
        }
      });
      if (previous) previousCleanup = this.disposeManagedTransport(previous);
    }
    if (!preserveReadySnapshot || this.currentSnapshot.state !== "ready") {
      this.replaceSnapshot({
        state: "loading",
        terminalLabel: terminal.name,
        message: "Finding dataframes…",
        variables: []
      });
    }
    return Object.freeze({ generation, transport, previousCleanup });
  }

  private async refreshExactTerminal(
    terminal: vscode.Terminal,
    transport: RInteractiveCommandTransport,
    generation: number,
    previousCleanup: Promise<unknown | undefined>,
    cancellation: vscode.CancellationToken
  ): Promise<boolean> {
    const cleanupError = await previousCleanup;
    if (cleanupError) showCleanupError(cleanupError);
    if (!this.isCurrentRefresh(terminal, transport, generation)) return false;
    try {
      const discovery = await transport.discoverVariables({
        cancellation,
        timeoutMs: getSetting<number>("sessionOpenTimeoutMs", 60_000)
      });
      if (!this.isCurrentRefresh(terminal, transport, generation)) return false;
      this.publishDiscovery(terminal, discovery);
      return discovery.variables.length > 0;
    } catch (error) {
      if (!this.isCurrentRefresh(terminal, transport, generation)) return false;
      if (error instanceof DetachedBridgeRequestError && error.reason === "cancellation") {
        this.replaceSnapshot(idleSnapshot(terminal));
        return false;
      }
      this.replaceSnapshot({
        state: "error",
        terminalLabel: terminal.name,
        message: errorMessage(error),
        variables: []
      });
      return false;
    }
  }

  private publishDiscovery(terminal: vscode.Terminal, discovery: RProcessVariableDiscovery): void {
    this.variablesByHandle.clear();
    if (discovery.variables.length === 0) {
      this.replaceSnapshot({
        state: "empty",
        terminalLabel: terminal.name,
        message: "No dataframes in this R session.",
        variables: []
      });
      return;
    }
    const items = discovery.variables.map((variable) => {
      const handle = randomUUID();
      const item = Object.freeze({
        handle,
        label: variable.name,
        description: `R · ${rDataframeFlavorLabel(variable.dataframeFlavor)}`,
        detail: terminal.name
      });
      this.variablesByHandle.set(handle, Object.freeze({ variable, item }));
      return item;
    });
    this.replaceSnapshot({
      state: "ready",
      terminalLabel: terminal.name,
      message: discovery.truncated ? "Showing the first dataframes returned by R." : `${items.length} loaded`,
      variables: Object.freeze(items)
    });
  }

  private async openWithTransport(
    transport: RInteractiveCommandTransport,
    selected: RProcessVariableDescriptor,
    origin?: LiterateDocumentOrigin
  ): Promise<boolean> {
    const source: SessionSource = origin
      ? {
          kind: "documentVariable",
          label: selected.name,
          variableName: selected.name,
          uri: origin.uri
        }
      : {
          kind: "rInteractiveVariable",
          label: selected.name,
          variableName: selected.name
        };
    const delegate = new RKernelBridge(this.context, transport, undefined, undefined, selected);
    try {
      const bridge = origin
        ? this.coordinator.createBridge(delegate, {
            kind: "textDocument",
            document: origin.document,
            version: origin.version
          })
        : this.coordinator.createBridge(delegate);
      OpenWranglerPanel.create(this.context, bridge, source, "r");
      return true;
    } catch (error) {
      let cleanupError: unknown;
      try {
        await delegate.dispose();
      } catch (disposeError) {
        cleanupError = disposeError;
      }
      void vscode.window.showErrorMessage(
        `Could not open the selected R dataframe: ${errorMessage(error)}${cleanupSuffix(cleanupError)}`
      );
      return false;
    }
  }

  private onActiveTerminalChanged(terminal: vscode.Terminal | undefined): void {
    const currentTerminal = this.ownedTerminal ?? this.workspaceWatcherTerminal;
    if (!currentTerminal) {
      if (isOfficialRTerminal(terminal)) {
        this.replaceSnapshot(idleSnapshot(terminal));
        this.scheduleAutomaticAttachment(terminal);
      }
      return;
    }
    if (terminal && isOfficialRTerminal(terminal) && terminal !== currentTerminal) {
      this.invalidateCurrentSession("A different R terminal is active. Wait for its prompt before reading it.");
      this.scheduleAutomaticAttachment(terminal);
    }
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    if (terminal === this.ownedTerminal || terminal === this.workspaceWatcherTerminal) {
      this.invalidateCurrentSession("The R terminal closed. Start or select another R session.");
    }
  }

  private invalidateCurrentSession(message: string): void {
    this.generation += 1;
    this.releaseWorkspaceWatcher();
    const transport = this.releaseOwnedTransport();
    this.replaceSnapshot({ state: "idle", terminalLabel: "R session", message, variables: [] });
    if (transport) void this.disposeManagedTransport(transport).then((error) => error && showCleanupError(error));
  }

  private releaseOwnedTransport(): RInteractiveCommandTransport | undefined {
    const transport = this.ownedTransport;
    this.ownedTransport = undefined;
    this.ownedTerminal = undefined;
    this.transportInvalidationSubscription?.dispose();
    this.transportInvalidationSubscription = undefined;
    this.transportVariableChangeSubscription?.dispose();
    this.transportVariableChangeSubscription = undefined;
    this.variablesByHandle.clear();
    return transport;
  }

  private releaseWorkspaceWatcher(): RVscodeWorkspaceWatcher | undefined {
    const watcher = this.workspaceWatcher;
    this.workspaceWatcher = undefined;
    this.workspaceWatcherTerminal = undefined;
    this.workspaceWatcherInvalidationSubscription?.dispose();
    this.workspaceWatcherInvalidationSubscription = undefined;
    this.workspaceWatcherChangeSubscription?.dispose();
    this.workspaceWatcherChangeSubscription = undefined;
    watcher?.dispose();
    this.variablesByHandle.clear();
    return watcher;
  }

  private scheduleAutomaticAttachment(terminal: vscode.Terminal | undefined): void {
    if (
      !this.automaticDiscoveryStarted ||
      this.disposed ||
      !vscode.workspace.isTrusted ||
      !isExactActiveRTerminal(terminal)
    ) {
      return;
    }
    if (
      (this.ownedTransport && this.ownedTerminal === terminal) ||
      (this.workspaceWatcher && this.workspaceWatcherTerminal === terminal)
    ) {
      return;
    }
    if (this.automaticAttachmentRunning) {
      this.automaticAttachmentQueuedTerminal = terminal;
      return;
    }
    this.cancelAutomaticAttachmentTimer();
    this.automaticAttachmentTimer = setTimeout(() => {
      this.automaticAttachmentTimer = undefined;
      this.startAutomaticAttachment(terminal);
    }, AUTOMATIC_ATTACHMENT_DEBOUNCE_MS);
  }

  private startAutomaticAttachment(terminal: vscode.Terminal): void {
    const task = this.runAutomaticAttachment(terminal).catch(() => {
      if (
        !this.disposed &&
        isExactActiveRTerminal(terminal) &&
        !this.ownedTransport &&
        (!this.workspaceWatcher || this.workspaceWatcherTerminal === terminal)
      ) {
        this.releaseWorkspaceWatcher();
        this.replaceSnapshot(watcherFallbackSnapshot(terminal));
      }
    });
    this.automaticAttachmentTask = task;
    void task.finally(() => {
      if (this.automaticAttachmentTask === task) this.automaticAttachmentTask = undefined;
    });
  }

  private async runAutomaticAttachment(terminal: vscode.Terminal): Promise<void> {
    if (
      this.automaticAttachmentRunning ||
      this.disposed ||
      !vscode.workspace.isTrusted ||
      !isExactActiveRTerminal(terminal)
    ) {
      if (this.automaticAttachmentRunning && isExactActiveRTerminal(terminal)) {
        this.automaticAttachmentQueuedTerminal = terminal;
      }
      return;
    }
    this.automaticAttachmentRunning = true;
    try {
      if (
        (this.ownedTransport && this.ownedTerminal === terminal) ||
        (this.workspaceWatcher && this.workspaceWatcherTerminal === terminal)
      ) {
        return;
      }
      const generation = ++this.generation;
      this.releaseWorkspaceWatcher();
      const watcher = this.watcherFactory.create(this.context, terminal);
      if (!watcher) {
        if (this.isCurrent(generation) && isExactActiveRTerminal(terminal)) {
          this.replaceSnapshot(watcherFallbackSnapshot(terminal));
        }
        return;
      }
      this.workspaceWatcher = watcher;
      this.workspaceWatcherTerminal = terminal;
      this.workspaceWatcherInvalidationSubscription = watcher.onDidInvalidate(() => {
        if (this.workspaceWatcher === watcher) {
          this.invalidateCurrentSession("Automatic R discovery stopped. Use Refresh R dataframes to reconnect.");
        }
      });
      this.workspaceWatcherChangeSubscription = watcher.onDidChangeVariables((discovery) => {
        if (
          this.workspaceWatcher === watcher &&
          this.workspaceWatcherTerminal === terminal &&
          vscode.window.terminals.includes(terminal) &&
          isOfficialRTerminal(terminal)
        ) {
          this.publishDiscovery(terminal, discovery);
        }
      });
      if (this.currentSnapshot.state !== "ready") {
        this.replaceSnapshot({
          state: "loading",
          terminalLabel: terminal.name,
          message: "Finding dataframes…",
          variables: []
        });
      }
      try {
        const discovery = await watcher.readInitial();
        if (!this.isCurrentWatcher(terminal, watcher, generation)) return;
        this.publishDiscovery(terminal, discovery);
      } catch {
        if (this.isCurrentWatcher(terminal, watcher, generation)) {
          this.releaseWorkspaceWatcher();
          this.replaceSnapshot(watcherFallbackSnapshot(terminal));
        }
      }
    } finally {
      this.automaticAttachmentRunning = false;
      const queued = this.automaticAttachmentQueuedTerminal;
      this.automaticAttachmentQueuedTerminal = undefined;
      if (queued) this.scheduleAutomaticAttachment(queued);
    }
  }

  private cancelAutomaticAttachmentTimer(): void {
    if (this.automaticAttachmentTimer !== undefined) clearTimeout(this.automaticAttachmentTimer);
    this.automaticAttachmentTimer = undefined;
  }

  private cancelAutomaticAttachment(): void {
    this.cancelAutomaticAttachmentTimer();
    this.automaticAttachmentQueuedTerminal = undefined;
  }

  private replaceSnapshot(snapshot: RLiveVariableSnapshot): void {
    if (this.disposed) return;
    this.currentSnapshot = snapshot;
    if (snapshot.state !== "ready") this.variablesByHandle.clear();
    this.changeEmitter.fire();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private isCurrentLiterateRequest(
    generation: number,
    origin?: LiterateDocumentOrigin,
    session?: LiterateRSessionIdentity
  ): boolean {
    return (
      this.isCurrent(generation) &&
      (!origin || isCurrentLiterateDocumentOrigin(origin)) &&
      (!session || isCurrentLiterateRSession(session))
    );
  }

  private isCurrentRefresh(
    terminal: vscode.Terminal,
    transport: RInteractiveCommandTransport,
    generation: number
  ): boolean {
    return this.isCurrent(generation) && this.ownedTransport === transport && this.ownedTerminal === terminal;
  }

  private isCurrentWatcher(terminal: vscode.Terminal, watcher: RVscodeWorkspaceWatcher, generation: number): boolean {
    return (
      this.isCurrent(generation) &&
      this.workspaceWatcher === watcher &&
      this.workspaceWatcherTerminal === terminal &&
      vscode.window.terminals.includes(terminal) &&
      isOfficialRTerminal(terminal)
    );
  }

  private async disposeManagedTransport(transport: RInteractiveCommandTransport): Promise<unknown | undefined> {
    if (!this.managedTransports.has(transport)) return undefined;
    const error = await disposeTransport(transport);
    this.managedTransports.delete(transport);
    return error;
  }
}

async function discoverWithProgress(
  transport: RInteractiveCommandTransport,
  title = "Finding dataframes in the active R session",
  evaluationCode?: string
): Promise<RProcessVariableDiscovery> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (_progress, cancellation) => {
      const options = {
        cancellation,
        timeoutMs: getSetting<number>("sessionOpenTimeoutMs", 60_000)
      };
      return evaluationCode === undefined
        ? transport.discoverVariables(options)
        : transport.evaluateAndDiscoverVariables(evaluationCode, options);
    }
  );
}

async function settleShutdown(
  automaticAttachmentTask: Promise<void> | undefined,
  transportDisposal: Promise<void>
): Promise<void> {
  const results = await Promise.allSettled([automaticAttachmentTask, transportDisposal]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Open Wrangler could not stop its R session provider.");
}

function rInteractiveQuickPickItem(variable: RProcessVariableDescriptor): RInteractiveQuickPickItem {
  return {
    label: variable.name,
    description: `R · ${rDataframeFlavorLabel(variable.dataframeFlavor)}`,
    detail: "Active R session",
    variable
  };
}

function rDataframeFlavorLabel(flavor: RProcessVariableDescriptor["dataframeFlavor"]): string {
  switch (flavor) {
    case "r.data.frame":
      return "data.frame";
    case "r.tibble":
      return "tibble";
    case "r.data.table":
      return "data.table";
  }
}

function idleSnapshot(terminal: vscode.Terminal | undefined): RLiveVariableSnapshot {
  return {
    state: "idle",
    terminalLabel: isOfficialRTerminal(terminal) ? terminal.name : "R session",
    message: isOfficialRTerminal(terminal)
      ? "Dataframes appear here after the R prompt returns."
      : "Select the R terminal that owns the dataframe first.",
    variables: []
  };
}

function watcherFallbackSnapshot(terminal: vscode.Terminal): RLiveVariableSnapshot {
  return {
    state: "idle",
    terminalLabel: terminal.name,
    message: "Choose Refresh R dataframes.",
    variables: []
  };
}

function isOfficialRTerminal(terminal: vscode.Terminal | undefined): terminal is vscode.Terminal {
  return terminal?.name === "R" || terminal?.name === "R Interactive";
}

function isExactActiveRTerminal(terminal: vscode.Terminal | undefined): terminal is vscode.Terminal {
  return Boolean(
    terminal &&
    vscode.window.activeTerminal === terminal &&
    vscode.window.terminals.includes(terminal) &&
    isOfficialRTerminal(terminal)
  );
}

function isCurrentLiterateRSession(session: LiterateRSessionIdentity): boolean {
  return isExactActiveRTerminal(session.terminal);
}

function isLiterateDocumentResource(resource: unknown): boolean {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (!activeUri || !isSupportedLiterateUri(activeUri)) return false;
  return !(resource instanceof vscode.Uri) || resource.toString() === activeUri.toString();
}

function requireTrustedRSession(): boolean {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage("Trust this workspace before inspecting the active R session.");
  return false;
}

async function disposeTransport(transport: RInteractiveCommandTransport): Promise<unknown | undefined> {
  try {
    await transport.dispose();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function disposeTransports(transports: readonly RInteractiveCommandTransport[]): Promise<void> {
  const results = await Promise.allSettled(transports.map((transport) => transport.dispose()));
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Open Wrangler could not release all active R session bridges.");
  }
}

function cleanupSuffix(error: unknown | undefined): string {
  return error === undefined
    ? ""
    : ` Open Wrangler also could not release its R session bridge: ${errorMessage(error)}`;
}

function showCleanupError(error: unknown): void {
  void vscode.window.showErrorMessage(`Open Wrangler could not release its R session bridge: ${errorMessage(error)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
