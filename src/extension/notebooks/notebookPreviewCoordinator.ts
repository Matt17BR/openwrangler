import * as vscode from "vscode";
import { updateSetting } from "../configuration";
import {
  KernelBridge,
  NotebookFormatterPreparationPendingError,
  type NotebookPreviewProvider,
  shouldRegisterNotebookFormatters
} from "./kernelBridge";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";

const DATA_WRANGLER_EXTENSION_ID = "ms-toolsai.datawrangler";
const JUPYTER_EXTENSION_ID = "ms-toolsai.jupyter";
const CHOOSE_PREVIEW_PROVIDER_COMMAND = "openWrangler.chooseNotebookPreviewProvider";
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 15_000] as const;
const providerPromptTerminationListeners = new Set<() => void>();
let providerPromptTerminated = false;
let providerPromptOwner: NotebookPreviewCoordinator | undefined;

export function onDidTerminateNotebookPreviewProviderPrompt(listener: () => void): vscode.Disposable {
  providerPromptTerminationListeners.add(listener);
  if (providerPromptTerminated) listener();
  return { dispose: () => providerPromptTerminationListeners.delete(listener) };
}

export function isNotebookPreviewProviderPromptTerminated(): boolean {
  return providerPromptTerminated;
}

export function requestNotebookPreviewProviderPrompt(notebook: vscode.NotebookDocument): Promise<boolean> {
  return providerPromptOwner?.requestProviderPrompt(notebook) ?? Promise.resolve(false);
}

function setNotebookPreviewProviderPromptOwner(owner: NotebookPreviewCoordinator | undefined): void {
  providerPromptOwner = owner;
}

interface NotebookPreviewEntry {
  bridge: KernelBridge;
  invalidationSubscription: vscode.Disposable;
  prepared: boolean;
  retryIndex: number;
  immediateRetryRequested: boolean;
  timer?: NodeJS.Timeout;
  running?: Promise<void>;
}

export class NotebookPreviewCoordinator implements vscode.Disposable {
  private readonly entries = new Map<vscode.NotebookDocument, NotebookPreviewEntry>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private conflictPrompt: Promise<boolean> | undefined;
  private conflictPromptDismissed = false;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    providerPromptTerminated = false;
    const executionPreparationProvider: vscode.NotebookCellStatusBarItemProvider = {
      provideCellStatusBarItems: (cell) => {
        // VS Code also invokes status providers for idle cells and while the
        // kernel picker is active. This callback may expedite an explicitly
        // selected Open Wrangler provider, but it never owns the provider prompt.
        this.schedule(cell.notebook, 0, true);
        return undefined;
      }
    };
    try {
      this.subscriptions.push(
        vscode.notebooks.registerNotebookCellStatusBarItemProvider("jupyter-notebook", executionPreparationProvider)
      );
      this.subscriptions.push(
        vscode.notebooks.registerNotebookCellStatusBarItemProvider("interactive", executionPreparationProvider)
      );
      this.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument((notebook) => this.schedule(notebook)));
      this.subscriptions.push(vscode.workspace.onDidCloseNotebookDocument((notebook) => this.remove(notebook)));
      this.subscriptions.push(
        vscode.window.onDidChangeVisibleNotebookEditors((editors) => this.syncVisibleNotebooks(editors, true))
      );
      this.subscriptions.push(
        vscode.window.onDidChangeActiveNotebookEditor((editor) => {
          if (editor) this.schedule(editor.notebook, 0, true);
        })
      );
      this.subscriptions.push(
        vscode.workspace.onDidChangeNotebookDocument((event) => this.schedule(event.notebook, 0, true))
      );
      this.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
          if (!event.affectsConfiguration("openWrangler.notebookPreviewProvider")) return;
          providerPromptTerminated = false;
          this.conflictPromptDismissed = false;
          this.resetEntries();
          this.syncVisibleNotebooks(vscode.window.visibleNotebookEditors);
        })
      );
      this.subscriptions.push(
        vscode.commands.registerCommand(CHOOSE_PREVIEW_PROVIDER_COMMAND, () => this.chooseProvider())
      );
      this.syncVisibleNotebooks(vscode.window.visibleNotebookEditors);
      setNotebookPreviewProviderPromptOwner(this);
    } catch (error) {
      throw combinedFailure(
        error,
        this.disposeResources(),
        "Open Wrangler notebook preview construction failed during rollback."
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    const failures = this.disposeResources();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Open Wrangler notebook preview cleanup encountered multiple failures.");
    }
  }

  private schedule(notebook: vscode.NotebookDocument, delayMs = 0, expedite = false): void {
    if (this.disposed || !this.canPrepare(notebook)) return;
    if (this.hasUnresolvedProviderConflict()) return;
    const entry = this.entry(notebook);
    if (entry.prepared) return;
    if (entry.running) {
      if (expedite) entry.immediateRetryRequested = true;
      return;
    }
    if (entry.timer) {
      if (!expedite) return;
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (delayMs === 0) {
      this.startPreparation(notebook, entry);
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.startPreparation(notebook, entry);
    }, delayMs);
  }

  private startPreparation(notebook: vscode.NotebookDocument, entry: NotebookPreviewEntry): void {
    if (this.disposed || !this.canPrepare(notebook)) {
      this.remove(notebook);
      return;
    }
    if (entry.prepared || entry.running) return;
    const running = this.prepare(notebook, entry).finally(() => {
      if (entry.running !== running) return;
      entry.running = undefined;
      const immediateRetryRequested = entry.immediateRetryRequested;
      entry.immediateRetryRequested = false;
      if (immediateRetryRequested && !entry.prepared && this.entries.get(notebook) === entry && !this.disposed) {
        this.schedule(notebook, 0, true);
      }
    });
    entry.running = running;
  }

  private async prepare(notebook: vscode.NotebookDocument, entry: NotebookPreviewEntry): Promise<void> {
    if (!(await this.resolveOpenWranglerProvider())) return;
    if (this.disposed || this.entries.get(notebook) !== entry) return;
    if (!this.canPrepare(notebook)) {
      this.remove(notebook);
      return;
    }
    try {
      await entry.bridge.prepareNotebookFormatter();
      entry.prepared = true;
      entry.retryIndex = 0;
    } catch (error) {
      if (error instanceof NotebookFormatterPreparationPendingError) {
        const settlement = await error.settlement;
        if (!this.canPrepare(notebook) || this.disposed || this.entries.get(notebook) !== entry) {
          this.remove(notebook);
          return;
        }
        if (settlement.kind === "prepared") {
          entry.prepared = true;
          entry.retryIndex = 0;
          return;
        }
        if (settlement.kind === "generationChanged") entry.retryIndex = 0;
      }
      if (!this.canPrepare(notebook) || this.disposed) {
        this.remove(notebook);
        return;
      }
      const delay = RETRY_DELAYS_MS[Math.min(entry.retryIndex, RETRY_DELAYS_MS.length - 1)]!;
      entry.retryIndex = Math.min(entry.retryIndex + 1, RETRY_DELAYS_MS.length - 1);
      this.deferRetry(notebook, entry, delay);
    }
  }

  private deferRetry(notebook: vscode.NotebookDocument, entry: NotebookPreviewEntry, delayMs: number): void {
    if (entry.timer || this.disposed) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.startPreparation(notebook, entry);
    }, delayMs);
  }

  private entry(notebook: vscode.NotebookDocument): NotebookPreviewEntry {
    const existing = this.entries.get(notebook);
    if (existing) return existing;
    const bridge = new KernelBridge(this.context, notebook);
    let invalidationSubscription: vscode.Disposable;
    try {
      invalidationSubscription = bridge.onDidInvalidateKernel(() => {
        const current = this.entries.get(notebook);
        if (!current) return;
        current.prepared = false;
        current.retryIndex = 0;
        this.schedule(notebook, RETRY_DELAYS_MS[0]);
      });
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      captureCleanup(() => bridge.dispose(), cleanupFailures);
      throw combinedFailure(
        error,
        cleanupFailures,
        "Open Wrangler notebook preview bridge construction failed during rollback."
      );
    }
    const entry: NotebookPreviewEntry = {
      bridge,
      prepared: false,
      retryIndex: 0,
      immediateRetryRequested: false,
      invalidationSubscription
    };
    this.entries.set(notebook, entry);
    return entry;
  }

  private remove(notebook: vscode.NotebookDocument): void {
    const entry = this.entries.get(notebook);
    if (!entry) return;
    this.entries.delete(notebook);
    if (entry.timer) clearTimeout(entry.timer);
    const failures: unknown[] = [];
    captureCleanup(() => entry.invalidationSubscription.dispose(), failures);
    captureCleanup(() => entry.bridge.dispose(), failures);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Open Wrangler notebook preview entry cleanup encountered multiple failures.");
    }
  }

  private resetEntries(): void {
    const failures: unknown[] = [];
    for (const notebook of [...this.entries.keys()]) captureCleanup(() => this.remove(notebook), failures);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Open Wrangler notebook preview reset encountered multiple failures.");
    }
  }

  private disposeResources(): unknown[] {
    this.disposed = true;
    if (providerPromptOwner === this) setNotebookPreviewProviderPromptOwner(undefined);
    if (this.conflictPrompt) this.publishProviderPromptTermination();
    const failures: unknown[] = [];
    for (const subscription of this.subscriptions.splice(0).reverse()) {
      captureCleanup(() => subscription.dispose(), failures);
    }
    captureCleanup(() => this.resetEntries(), failures);
    return failures;
  }

  private syncVisibleNotebooks(editors: readonly vscode.NotebookEditor[], expedite = false): void {
    const visible = new Set(editors.map((editor) => editor.notebook));
    for (const notebook of this.entries.keys()) {
      if (!visible.has(notebook)) this.remove(notebook);
    }
    for (const notebook of visible) this.schedule(notebook, 0, expedite);
  }

  private canPrepare(notebook: vscode.NotebookDocument): boolean {
    return (
      vscode.workspace.isTrusted &&
      (notebook.notebookType === "jupyter-notebook" || notebook.notebookType === "interactive") &&
      isSoleOpenNotebookDocument(notebook) &&
      vscode.window.visibleNotebookEditors.some((editor) => editor.notebook === notebook) &&
      vscode.extensions.getExtension(JUPYTER_EXTENSION_ID) !== undefined
    );
  }

  private hasUnresolvedProviderConflict(): boolean {
    return (
      !shouldRegisterNotebookFormatters() &&
      vscode.workspace
        .getConfiguration("openWrangler")
        .get<NotebookPreviewProvider>("notebookPreviewProvider", "ask") === "ask" &&
      vscode.extensions.getExtension(DATA_WRANGLER_EXTENSION_ID) !== undefined
    );
  }

  private async resolveOpenWranglerProvider(): Promise<boolean> {
    if (shouldRegisterNotebookFormatters()) return true;
    const preference = vscode.workspace
      .getConfiguration("openWrangler")
      .get<NotebookPreviewProvider>("notebookPreviewProvider", "ask");
    if (preference !== "ask" || vscode.extensions.getExtension(DATA_WRANGLER_EXTENSION_ID) === undefined) {
      return false;
    }
    if (this.conflictPromptDismissed) return false;
    this.conflictPrompt ??= this.promptForConflictProvider().finally(() => {
      this.conflictPrompt = undefined;
    });
    return this.conflictPrompt;
  }

  requestProviderPrompt(notebook: vscode.NotebookDocument): Promise<boolean> {
    if (this.disposed || !this.canPrepare(notebook)) return Promise.resolve(false);
    return this.resolveOpenWranglerProvider();
  }

  private async promptForConflictProvider(): Promise<boolean> {
    let selection: string | undefined;
    try {
      selection = await vscode.window.showInformationMessage(
        "Open Wrangler and Data Wrangler can both render dataframe outputs. Which notebook preview should take priority?",
        { modal: true, detail: "You can change this later with “Open Wrangler: Choose Notebook Preview Provider”." },
        "Use Open Wrangler",
        "Keep Data Wrangler"
      );
    } catch (error) {
      this.publishProviderPromptTermination();
      throw error;
    }
    if (this.disposed) {
      this.publishProviderPromptTermination();
      return false;
    }
    if (selection === "Use Open Wrangler") {
      try {
        await updateSetting("notebookPreviewProvider", "openWrangler", vscode.ConfigurationTarget.Global);
      } catch (error) {
        this.publishProviderPromptTermination();
        throw error;
      }
      return true;
    }
    if (selection === "Keep Data Wrangler") {
      try {
        await updateSetting("notebookPreviewProvider", "dataWrangler", vscode.ConfigurationTarget.Global);
      } catch (error) {
        this.publishProviderPromptTermination();
        throw error;
      }
      return false;
    }
    this.publishProviderPromptTermination();
    return false;
  }

  private publishProviderPromptTermination(): void {
    if (this.conflictPromptDismissed) return;
    this.conflictPromptDismissed = true;
    providerPromptTerminated = true;
    for (const listener of providerPromptTerminationListeners) listener();
  }

  private async chooseProvider(): Promise<void> {
    const current = vscode.workspace
      .getConfiguration("openWrangler")
      .get<NotebookPreviewProvider>("notebookPreviewProvider", "ask");
    const selection = await vscode.window.showQuickPick(
      [
        {
          label: "Open Wrangler",
          description: "Render supported dataframe outputs with Open Wrangler",
          value: "openWrangler" as const
        },
        {
          label: "Data Wrangler",
          description: "Leave automatic dataframe output rendering to Microsoft Data Wrangler",
          value: "dataWrangler" as const
        },
        {
          label: "Disabled",
          description: "Do not install an automatic dataframe output formatter",
          value: "disabled" as const
        }
      ],
      {
        title: "Open Wrangler: Choose Notebook Preview Provider",
        placeHolder: `Current provider: ${providerLabel(current)}`,
        ignoreFocusOut: true
      }
    );
    if (!selection) return;
    await updateSetting("notebookPreviewProvider", selection.value, vscode.ConfigurationTarget.Global);
    if (selection.value !== "openWrangler") {
      vscode.window.showInformationMessage(
        "The new notebook preview provider will take effect in newly started or restarted Python kernels."
      );
    }
  }
}

function providerLabel(provider: NotebookPreviewProvider): string {
  if (provider === "openWrangler") return "Open Wrangler";
  if (provider === "dataWrangler") return "Data Wrangler";
  if (provider === "disabled") return "Disabled";
  return "Ask when another provider is installed";
}

function captureCleanup(cleanup: () => void, failures: unknown[]): void {
  try {
    cleanup();
  } catch (error) {
    failures.push(...flattenFailures(error));
  }
}

function combinedFailure(primary: unknown, cleanupFailures: readonly unknown[], message: string): unknown {
  return cleanupFailures.length === 0
    ? primary
    : new AggregateError([...flattenFailures(primary), ...cleanupFailures.flatMap(flattenFailures)], message);
}

function flattenFailures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(flattenFailures) : [error];
}
