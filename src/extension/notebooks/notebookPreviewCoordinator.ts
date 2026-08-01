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
    this.subscriptions.push(
      vscode.workspace.onDidOpenNotebookDocument((notebook) => this.schedule(notebook)),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => this.remove(notebook)),
      vscode.window.onDidChangeVisibleNotebookEditors((editors) => this.syncVisibleNotebooks(editors, true)),
      vscode.window.onDidChangeActiveNotebookEditor((editor) => {
        if (editor) this.schedule(editor.notebook, 0, true);
      }),
      vscode.workspace.onDidChangeNotebookDocument((event) => this.schedule(event.notebook, 0, true)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("openWrangler.notebookPreviewProvider")) return;
        this.conflictPromptDismissed = false;
        this.resetEntries();
        this.syncVisibleNotebooks(vscode.window.visibleNotebookEditors);
      }),
      vscode.commands.registerCommand(CHOOSE_PREVIEW_PROVIDER_COMMAND, () => this.chooseProvider())
    );
    this.syncVisibleNotebooks(vscode.window.visibleNotebookEditors);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.resetEntries();
  }

  private schedule(notebook: vscode.NotebookDocument, delayMs = 0, expedite = false): void {
    if (this.disposed || !this.canPrepare(notebook)) return;
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
    const entry: NotebookPreviewEntry = {
      bridge,
      prepared: false,
      retryIndex: 0,
      immediateRetryRequested: false,
      invalidationSubscription: bridge.onDidInvalidateKernel(() => {
        entry.prepared = false;
        entry.retryIndex = 0;
        this.schedule(notebook, RETRY_DELAYS_MS[0]);
      })
    };
    this.entries.set(notebook, entry);
    return entry;
  }

  private remove(notebook: vscode.NotebookDocument): void {
    const entry = this.entries.get(notebook);
    if (!entry) return;
    this.entries.delete(notebook);
    if (entry.timer) clearTimeout(entry.timer);
    entry.invalidationSubscription.dispose();
    entry.bridge.dispose();
  }

  private resetEntries(): void {
    for (const notebook of [...this.entries.keys()]) this.remove(notebook);
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
      notebook.notebookType === "jupyter-notebook" &&
      isSoleOpenNotebookDocument(notebook) &&
      vscode.window.visibleNotebookEditors.some((editor) => editor.notebook === notebook) &&
      vscode.extensions.getExtension(JUPYTER_EXTENSION_ID) !== undefined
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

  private async promptForConflictProvider(): Promise<boolean> {
    const selection = await vscode.window.showInformationMessage(
      "Open Wrangler and Data Wrangler can both render dataframe outputs. Which notebook preview should take priority?",
      { modal: true, detail: "You can change this later with “Open Wrangler: Choose Notebook Preview Provider”." },
      "Use Open Wrangler",
      "Keep Data Wrangler"
    );
    if (selection === "Use Open Wrangler") {
      await updateSetting("notebookPreviewProvider", "openWrangler", vscode.ConfigurationTarget.Global);
      return true;
    }
    if (selection === "Keep Data Wrangler") {
      await updateSetting("notebookPreviewProvider", "dataWrangler", vscode.ConfigurationTarget.Global);
      return false;
    }
    this.conflictPromptDismissed = true;
    return false;
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
