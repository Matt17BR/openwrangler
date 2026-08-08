import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { getSetting } from "../configuration";
import { DetachedBridgeRequestError } from "../dataBridge";
import { SessionCoordinator } from "../sessionCoordinator";
import { OpenWranglerPanel } from "../webviewPanel";
import { RInteractiveSessionTransport } from "./rInteractiveSessionTransport";
import { RKernelBridge, type RKernelBridgeTransport } from "./rKernelBridge";
import type { RProcessVariableDescriptor, RProcessVariableDiscovery } from "./rProcessTransport";

export const OPEN_R_INTERACTIVE_VARIABLE_COMMAND = "openWrangler.openRInteractiveVariable";
export const REFRESH_R_INTERACTIVE_VARIABLES_COMMAND = "openWrangler.refreshRInteractiveVariables";
export const OPEN_CACHED_R_INTERACTIVE_VARIABLE_COMMAND = "openWrangler.openCachedRInteractiveVariable";

interface RInteractiveQuickPickItem extends vscode.QuickPickItem {
  readonly variable: RProcessVariableDescriptor;
}

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
}

export interface RInteractiveCommandTransport extends RKernelBridgeTransport {
  discoverVariables(options?: {
    readonly cancellation?: vscode.CancellationToken;
    readonly timeoutMs?: number;
  }): Promise<RProcessVariableDiscovery>;
}

export interface RInteractiveTransportFactory {
  create(
    context: vscode.ExtensionContext,
    options?: Readonly<{ terminalMode?: "active" | "activeOrCreate" }>
  ): RInteractiveCommandTransport;
}

const defaultTransportFactory: RInteractiveTransportFactory = Object.freeze({
  create: (context: vscode.ExtensionContext, options?: Readonly<{ terminalMode?: "active" | "activeOrCreate" }>) =>
    new RInteractiveSessionTransport(context, options)
});

interface CachedRVariable {
  readonly variable: RProcessVariableDescriptor;
  readonly item: RLiveVariableItem;
}

/** Registers active-R discovery and owns the refreshable list shown in Operations. */
export function registerRInteractiveCommands(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  transportFactory: RInteractiveTransportFactory = defaultTransportFactory
): RLiveVariableProvider {
  const provider = new RInteractiveVariableCoordinator(context, coordinator, transportFactory);
  context.subscriptions.push(
    provider,
    vscode.commands.registerCommand(OPEN_R_INTERACTIVE_VARIABLE_COMMAND, () => provider.chooseAndOpen()),
    vscode.commands.registerCommand(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND, () => provider.refreshFromCommand()),
    vscode.commands.registerCommand(OPEN_CACHED_R_INTERACTIVE_VARIABLE_COMMAND, (handle: unknown) =>
      provider.openCachedVariable(handle)
    )
  );
  return provider;
}

class RInteractiveVariableCoordinator implements RLiveVariableProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  private currentSnapshot: RLiveVariableSnapshot;
  private readonly variablesByHandle = new Map<string, CachedRVariable>();
  private ownedTransport: RInteractiveCommandTransport | undefined;
  private ownedTerminal: vscode.Terminal | undefined;
  private transportInvalidationSubscription: vscode.Disposable | undefined;
  private generation = 0;
  private disposed = false;

  readonly onDidChangeVariables = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly coordinator: SessionCoordinator,
    private readonly transportFactory: RInteractiveTransportFactory
  ) {
    this.currentSnapshot = idleSnapshot(vscode.window.activeTerminal);
    this.subscriptions = [
      vscode.window.onDidChangeActiveTerminal((terminal) => this.onActiveTerminalChanged(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => this.onTerminalClosed(terminal))
    ];
  }

  snapshot(): RLiveVariableSnapshot {
    return this.currentSnapshot;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    const transport = this.releaseOwnedTransport();
    this.variablesByHandle.clear();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.changeEmitter.dispose();
    if (transport) void disposeTransport(transport).then((error) => error && showCleanupError(error));
  }

  async refreshFromCommand(): Promise<boolean> {
    if (!requireTrustedRSession()) return false;
    const terminal = vscode.window.activeTerminal;
    if (!isOfficialRTerminal(terminal)) {
      this.replaceSnapshot({
        state: "idle",
        terminalLabel: "R session",
        message: "Select an R terminal, then refresh.",
        variables: []
      });
      void vscode.window.showInformationMessage("Select the R terminal that owns the dataframe, then refresh again.");
      return false;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Refreshing R dataframes",
        cancellable: true
      },
      (_progress, cancellation) => this.refreshExactTerminal(terminal, cancellation)
    );
  }

  async chooseAndOpen(): Promise<boolean> {
    if (!requireTrustedRSession()) return false;
    let transport: RInteractiveCommandTransport;
    try {
      transport = this.transportFactory.create(this.context, { terminalMode: "activeOrCreate" });
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not connect to the active R session: ${errorMessage(error)}`);
      return false;
    }

    let discovery: RProcessVariableDiscovery;
    try {
      discovery = await discoverWithProgress(transport);
    } catch (error) {
      const cleanupError = await disposeTransport(transport);
      if (error instanceof DetachedBridgeRequestError && error.reason === "cancellation" && !cleanupError) return false;
      void vscode.window.showErrorMessage(
        `Could not inspect the active R session: ${errorMessage(error)}${cleanupSuffix(cleanupError)}`
      );
      return false;
    }

    if (discovery.variables.length === 0) {
      const cleanupError = await disposeTransport(transport);
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
      const cleanupError = await disposeTransport(transport);
      void vscode.window.showErrorMessage(
        `Could not choose an R dataframe: ${errorMessage(error)}${cleanupSuffix(cleanupError)}`
      );
      return false;
    }
    if (!picked || !items.includes(picked)) {
      const cleanupError = await disposeTransport(transport);
      if (cleanupError) showCleanupError(cleanupError);
      return false;
    }
    return this.openWithTransport(transport, picked.variable);
  }

  async openCachedVariable(handle: unknown): Promise<boolean> {
    if (typeof handle !== "string") return false;
    if (!requireTrustedRSession()) return false;
    const cached = this.variablesByHandle.get(handle);
    const transport = this.ownedTransport;
    const terminal = this.ownedTerminal;
    if (
      !cached ||
      !transport ||
      !terminal ||
      !vscode.window.terminals.includes(terminal) ||
      !isOfficialRTerminal(terminal)
    ) {
      void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
      return false;
    }

    const transferred = this.releaseOwnedTransport();
    if (transferred !== transport) {
      void vscode.window.showInformationMessage("That R dataframe list is stale. Refresh it and try again.");
      return false;
    }
    this.generation += 1;
    this.replaceSnapshot(idleSnapshot(terminal));
    return this.openWithTransport(transport, cached.variable);
  }

  private async refreshExactTerminal(
    terminal: vscode.Terminal,
    cancellation: vscode.CancellationToken
  ): Promise<boolean> {
    if (this.disposed) return false;
    const generation = ++this.generation;
    let transport = this.ownedTerminal === terminal ? this.ownedTransport : undefined;
    if (!transport) {
      try {
        // Construction captures the exact active Terminal object before the first await.
        transport = this.transportFactory.create(this.context, { terminalMode: "active" });
      } catch (error) {
        this.replaceSnapshot({
          state: "error",
          terminalLabel: terminal.name,
          message: errorMessage(error),
          variables: []
        });
        return false;
      }
      const previous = this.releaseOwnedTransport();
      this.ownedTransport = transport;
      this.ownedTerminal = terminal;
      this.transportInvalidationSubscription = transport.onDidInvalidateKernel(() => {
        if (this.ownedTransport === transport)
          this.invalidateOwnedTransport("The R session changed. Refresh it again.");
      });
      if (previous) {
        const cleanupError = await disposeTransport(previous);
        if (cleanupError) showCleanupError(cleanupError);
      }
    }

    if (
      this.disposed ||
      generation !== this.generation ||
      this.ownedTransport !== transport ||
      this.ownedTerminal !== terminal
    ) {
      return false;
    }

    this.replaceSnapshot({
      state: "loading",
      terminalLabel: terminal.name,
      message: "Finding dataframes…",
      variables: []
    });
    try {
      const discovery = await transport.discoverVariables({
        cancellation,
        timeoutMs: getSetting<number>("sessionOpenTimeoutMs", 60_000)
      });
      if (
        this.disposed ||
        generation !== this.generation ||
        this.ownedTransport !== transport ||
        this.ownedTerminal !== terminal
      ) {
        return false;
      }
      this.publishDiscovery(terminal, discovery);
      return discovery.variables.length > 0;
    } catch (error) {
      if (
        this.disposed ||
        generation !== this.generation ||
        this.ownedTransport !== transport ||
        this.ownedTerminal !== terminal
      ) {
        return false;
      }
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
    selected: RProcessVariableDescriptor
  ): Promise<boolean> {
    const source: SessionSource = {
      kind: "rInteractiveVariable",
      label: selected.name,
      variableName: selected.name
    };
    const delegate = new RKernelBridge(this.context, transport, undefined, undefined, selected);
    try {
      const bridge = this.coordinator.createBridge(delegate);
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
    if (!this.ownedTerminal) {
      if (isOfficialRTerminal(terminal) && this.currentSnapshot.state === "idle") {
        this.replaceSnapshot(idleSnapshot(terminal));
      }
      return;
    }
    if (terminal && isOfficialRTerminal(terminal) && terminal !== this.ownedTerminal) {
      this.invalidateOwnedTransport("A different R terminal is active. Refresh to list its dataframes.");
    }
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    if (terminal === this.ownedTerminal) {
      this.invalidateOwnedTransport("The R terminal closed. Start or select an R session, then refresh.");
    }
  }

  private invalidateOwnedTransport(message: string): void {
    this.generation += 1;
    const transport = this.releaseOwnedTransport();
    this.replaceSnapshot({ state: "idle", terminalLabel: "R session", message, variables: [] });
    if (transport) void disposeTransport(transport).then((error) => error && showCleanupError(error));
  }

  private releaseOwnedTransport(): RInteractiveCommandTransport | undefined {
    const transport = this.ownedTransport;
    this.ownedTransport = undefined;
    this.ownedTerminal = undefined;
    this.transportInvalidationSubscription?.dispose();
    this.transportInvalidationSubscription = undefined;
    this.variablesByHandle.clear();
    return transport;
  }

  private replaceSnapshot(snapshot: RLiveVariableSnapshot): void {
    if (this.disposed) return;
    this.currentSnapshot = snapshot;
    if (snapshot.state !== "ready") this.variablesByHandle.clear();
    this.changeEmitter.fire();
  }
}

async function discoverWithProgress(
  transport: RInteractiveCommandTransport,
  title = "Finding dataframes in the active R session"
): Promise<RProcessVariableDiscovery> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (_progress, cancellation) =>
      transport.discoverVariables({
        cancellation,
        timeoutMs: getSetting<number>("sessionOpenTimeoutMs", 60_000)
      })
  );
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
      ? "Refresh to list dataframes from this R session."
      : "Select an R terminal, then refresh.",
    variables: []
  };
}

function isOfficialRTerminal(terminal: vscode.Terminal | undefined): terminal is vscode.Terminal {
  return terminal?.name === "R" || terminal?.name === "R Interactive";
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
