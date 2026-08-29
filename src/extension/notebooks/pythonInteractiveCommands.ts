import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { SessionCoordinator } from "../sessionCoordinator";
import {
  discoverNotebookVariables,
  NotebookVariableDiscoveryError,
  notebookVariablePresentation,
  type NotebookVariableDescriptor,
  type NotebookVariableDiscovery
} from "./notebookVariableDiscovery";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";
import {
  discoverVariablesForSelectedKernel,
  isRNotebookVariableDiscovery,
  openDiscoveredPythonNotebookVariable,
  openDiscoveredRNotebookVariable
} from "./jupyterBridge";
import {
  RNotebookVariableDiscoveryError,
  type RNotebookVariableDescriptor,
  type RNotebookVariableDiscovery
} from "../r/rNotebookVariableDiscovery";
import { restoreEditorGroupAfterQuickPick } from "../webviewPanel";
import { shouldInspectNotebookAutomatically } from "./kernelBridge";
import { isCurrentLiterateDocumentOrigin, type LiterateDocumentOrigin } from "../literateDocumentOrigin";
import {
  allExactSourceCells,
  associatedLiterateNotebooks,
  associatedNotebooks,
  capturePythonCellOrigin,
  isExactPythonOrigin,
  isPythonSourceDocument,
  isSoleOpenTextDocument,
  isSupportedLiveNotebook,
  isUnchangedPythonOrigin,
  pythonOriginFromLiterateDocument,
  type PreviousInteractiveCells,
  type PythonCellOrigin
} from "./pythonInteractiveOrigin";
import {
  PYTHON_CELL_EXECUTION_TIMEOUT_MS,
  PYTHON_CELL_POST_KERNEL_PUBLICATION_GRACE_MS,
  PythonCellDispatchObserver,
  prepareFreshLiteratePythonInteractiveWindow,
  runPythonCellAttempt,
  selectKernelAndRestorePythonOrigin,
  waitForPinnedCellCompletion,
  waitForPublishedCellAfterDispatch,
  waitForTransferredDispatchAfterKernel,
  type PythonCellAttemptResult,
  type PythonInteractiveActiveDiagnosticStage,
  type PythonInteractiveDiagnosticStage
} from "./pythonInteractiveDispatch";

export type {
  PythonInteractiveActiveDiagnosticStage,
  PythonInteractiveDiagnosticStage
} from "./pythonInteractiveDispatch";

const PYTHON_INTERACTIVE_DIAGNOSTIC_HISTORY_LIMIT = 16;

export interface NotebookLiveVariableItem {
  readonly handle: string;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

export type NotebookLiveVariableSnapshot =
  | {
      readonly state: "loading" | "empty" | "error";
      readonly notebookLabel: string;
      readonly message: string;
      readonly variables: readonly [];
    }
  | {
      readonly state: "ready";
      readonly notebookLabel: string;
      readonly message: string;
      readonly variables: readonly NotebookLiveVariableItem[];
    };

export interface NotebookLiveVariableProvider extends vscode.Disposable {
  readonly onDidChangeVariables: vscode.Event<void>;
  snapshot(): NotebookLiveVariableSnapshot | undefined;
  refreshFromCommand(): Promise<void>;
}

export interface LiteratePythonVariableProvider {
  runLiterateChunkAndOpen(origin: LiterateDocumentOrigin): Promise<boolean>;
  hasAssociatedLiterateSession(origin: LiterateDocumentOrigin): boolean;
  openAssociatedLiterateSession(origin: LiterateDocumentOrigin): Promise<boolean>;
}

export interface PythonInteractiveDiagnostics {
  readonly invocation: number;
  readonly stage: PythonInteractiveDiagnosticStage;
  readonly lastActiveStage?: PythonInteractiveActiveDiagnosticStage;
  readonly stages: readonly PythonInteractiveDiagnosticStage[];
}

export interface PythonInteractiveCommandProvider extends NotebookLiveVariableProvider, LiteratePythonVariableProvider {
  diagnosticsForTesting(): PythonInteractiveDiagnostics | undefined;
}

type CachedVariable =
  | {
      readonly kind: "python";
      readonly descriptor: NotebookVariableDescriptor;
      readonly item: NotebookLiveVariableItem;
    }
  | {
      readonly kind: "r";
      readonly discovery: RNotebookVariableDiscovery;
      readonly descriptor: RNotebookVariableDescriptor;
      readonly item: NotebookLiveVariableItem;
    };

interface VariablePickItem extends vscode.QuickPickItem {
  readonly descriptor: NotebookVariableDescriptor;
}

/**
 * Registers the Python-file/Interactive Window actions and keeps a small cache
 * for the one notebook that is currently active. It does not poll kernels and
 * never discovers variables in an inactive notebook.
 */
export function registerPythonInteractiveCommands(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator
): PythonInteractiveCommandProvider {
  return registerAtomically(context.subscriptions, () => {
    const provider = new NotebookInteractiveCoordinator(context, coordinator);
    context.subscriptions.push(provider);
    context.subscriptions.push(
      vscode.commands.registerCommand("openWrangler.runPythonCellAndOpenVariable", () =>
        provider.runCellAndOpenVariable()
      )
    );
    context.subscriptions.push(
      vscode.commands.registerCommand("openWrangler.refreshNotebookVariables", () => provider.refreshFromCommand())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand("openWrangler.openCachedNotebookVariable", (handle: unknown) =>
        provider.openCachedVariable(handle)
      )
    );
    return provider;
  });
}

class NotebookInteractiveCoordinator implements NotebookLiveVariableProvider, LiteratePythonVariableProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private activeTarget: vscode.NotebookDocument | undefined;
  private activeSource: vscode.TextDocument | undefined;
  private currentSnapshot: NotebookLiveVariableSnapshot | undefined;
  private readonly variablesByHandle = new Map<string, CachedVariable>();
  private refreshRunning = false;
  private refreshAgain = false;
  private runCellRunning = false;
  private disposed = false;
  private diagnosticInvocation = 0;
  private diagnosticStage: PythonInteractiveDiagnosticStage = "idle";
  private diagnosticLastActiveStage: PythonInteractiveActiveDiagnosticStage | undefined;
  private diagnosticStages: readonly PythonInteractiveDiagnosticStage[] = Object.freeze(["idle"]);

  readonly onDidChangeVariables = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly coordinator: SessionCoordinator
  ) {
    try {
      registerAtomically(this.subscriptions, () => {
        this.subscriptions.push(
          vscode.window.onDidChangeActiveNotebookEditor((editor) => this.onActiveNotebookChanged(editor))
        );
        this.subscriptions.push(
          vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveTextEditorChanged(editor))
        );
        this.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument(() => this.onNotebookSetChanged()));
        this.subscriptions.push(
          vscode.workspace.onDidCloseNotebookDocument((notebook) => this.onNotebookClosed(notebook))
        );
        this.subscriptions.push(vscode.workspace.onDidChangeNotebookDocument((event) => this.onNotebookChanged(event)));
        this.synchronizeInitialFocus();
      });
    } catch (error) {
      try {
        this.changeEmitter.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Open Wrangler Python variable owner construction failed during rollback."
        );
      }
      throw error;
    }
  }

  snapshot(): NotebookLiveVariableSnapshot | undefined {
    return this.currentSnapshot;
  }

  diagnosticsForTesting(): PythonInteractiveDiagnostics | undefined {
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS !== "1") return undefined;
    return Object.freeze({
      invocation: this.diagnosticInvocation,
      stage: this.diagnosticStage,
      lastActiveStage: this.diagnosticLastActiveStage,
      stages: this.diagnosticStages
    });
  }

  dispose(): void {
    this.disposed = true;
    this.activeTarget = undefined;
    this.activeSource = undefined;
    this.variablesByHandle.clear();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.changeEmitter.dispose();
  }

  async runCellAndOpenVariable(): Promise<void> {
    if (this.runCellRunning) {
      void vscode.window.showInformationMessage("Open Wrangler is already running this Python file or cell.");
      return;
    }
    this.runCellRunning = true;
    this.beginDiagnostics();
    let succeeded = false;
    try {
      succeeded = await this.performRunCellAndOpenVariable(capturePythonCellOrigin());
    } finally {
      this.finishDiagnostics(succeeded);
      this.runCellRunning = false;
    }
  }

  async runLiterateChunkAndOpen(origin: LiterateDocumentOrigin): Promise<boolean> {
    if (this.runCellRunning) {
      void vscode.window.showInformationMessage("Open Wrangler is already running a Python file or chunk.");
      return false;
    }
    const execution = pythonOriginFromLiterateDocument(origin);
    if (!execution) return false;
    this.runCellRunning = true;
    this.beginDiagnostics();
    let succeeded = false;
    try {
      succeeded = await this.performRunCellAndOpenVariable(execution);
      return succeeded;
    } finally {
      this.finishDiagnostics(succeeded);
      this.runCellRunning = false;
    }
  }

  hasAssociatedLiterateSession(origin: LiterateDocumentOrigin): boolean {
    return isCurrentLiterateDocumentOrigin(origin) && associatedLiterateNotebooks(origin).length > 0;
  }

  async openAssociatedLiterateSession(origin: LiterateDocumentOrigin): Promise<boolean> {
    if (!isCurrentLiterateDocumentOrigin(origin)) return false;
    const associated = associatedLiterateNotebooks(origin);
    if (associated.length === 0) return false;
    if (associated.length !== 1) {
      void vscode.window.showInformationMessage(
        "More than one Python Interactive Window belongs to this document. Close the extra window and try again."
      );
      return false;
    }
    const execution = pythonOriginFromLiterateDocument(origin, false);
    if (!execution) return false;
    this.beginDiagnostics("discovering-variables");
    let succeeded = false;
    try {
      succeeded = await this.discoverChooseAndOpen(associated[0]!.notebook, execution);
      return succeeded;
    } finally {
      this.finishDiagnostics(succeeded);
    }
  }

  private async performRunCellAndOpenVariable(origin: PythonCellOrigin | undefined): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("Trust this workspace before Open Wrangler runs Python code.");
      return false;
    }
    if (!origin) {
      void vscode.window.showInformationMessage("Place the cursor in a runnable Python cell, then try again.");
      return false;
    }

    const existingCells = allExactSourceCells(origin.sourceUri).flatMap(({ cells }) => cells);
    const beforeCells: PreviousInteractiveCells = {
      cells: new Set(existingCells.map(({ cell }) => cell)),
      ids: new Set(existingCells.flatMap(({ id }) => (id === undefined ? [] : [id])))
    };
    const beforeInteractiveWindows = new Set(
      vscode.workspace.notebookDocuments.filter(
        (notebook) => notebook.notebookType === "interactive" && !notebook.isClosed
      )
    );
    const operationDeadline = Date.now() + PYTHON_CELL_EXECUTION_TIMEOUT_MS;
    const observer = new PythonCellDispatchObserver(origin, beforeCells, beforeInteractiveWindows);
    let attempt: PythonCellAttemptResult;
    try {
      let pinnedLiterateNotebook: vscode.NotebookDocument | undefined;
      if (origin.command === "jupyter.execSelectionInteractive" && beforeInteractiveWindows.size === 0) {
        const bootstrap = await prepareFreshLiteratePythonInteractiveWindow(
          origin,
          observer,
          operationDeadline,
          (stage) => this.setDiagnosticStage(stage)
        );
        if (bootstrap.kind !== "ready") {
          if (bootstrap.kind === "dispatchRejected") {
            void vscode.window.showWarningMessage("Jupyter could not prepare a Python Interactive Window.");
          } else if (bootstrap.kind === "timedOut" || bootstrap.kind === "missing") {
            void vscode.window.showWarningMessage(
              "Jupyter did not finish preparing the Python Interactive Window in time. Try again."
            );
          } else if (bootstrap.kind === "selectionFailed") {
            // The exact picker/restoration helper already reported why it could
            // not establish a selected kernel. Do not replace that diagnostic
            // with a misleading source-staleness warning.
          } else if (bootstrap.kind === "stale") {
            void vscode.window.showWarningMessage(
              "The Python document changed while its Interactive Window was being prepared. Try again."
            );
          } else {
            void vscode.window.showWarningMessage(
              "Jupyter opened more than one candidate Interactive Window. Close the extra window and try again."
            );
          }
          return false;
        }
        pinnedLiterateNotebook = bootstrap.notebook;
      }

      const allowKernelRecovery = origin.command !== "jupyter.execSelectionInteractive";
      attempt = await runPythonCellAttempt(
        origin,
        observer,
        operationDeadline,
        allowKernelRecovery,
        (stage) => this.setDiagnosticStage(stage),
        "dispatching-cell",
        pinnedLiterateNotebook,
        pinnedLiterateNotebook !== undefined
      );
      if (attempt.kind === "needsKernel") {
        const kernelAttempt = attempt;
        const pendingDispatch = kernelAttempt.retryAllowed ? undefined : kernelAttempt.pendingDispatch;
        try {
          const restored = await selectKernelAndRestorePythonOrigin(
            attempt.notebook,
            origin,
            operationDeadline,
            observer,
            (stage) => this.setDiagnosticStage(stage)
          );
          if (!restored) return false;

          this.setDiagnosticStage("waiting-for-cell-publication");
          const afterSelection = pendingDispatch
            ? await waitForTransferredDispatchAfterKernel(
                origin,
                observer,
                kernelAttempt.notebook,
                pendingDispatch,
                operationDeadline
              )
            : await waitForPublishedCellAfterDispatch(
                observer,
                Math.min(operationDeadline, Date.now() + PYTHON_CELL_POST_KERNEL_PUBLICATION_GRACE_MS),
                false
              );
          if (afterSelection.kind === "published") {
            attempt = afterSelection;
          } else if (afterSelection.kind === "ambiguous") {
            attempt = afterSelection;
          } else if (afterSelection.kind === "stale" || !isExactPythonOrigin(origin)) {
            attempt = { kind: "stale" };
          } else {
            const retryAllowed =
              kernelAttempt.retryAllowed ||
              (origin.command === "jupyter.runcurrentcell" && pendingDispatch?.outcome()?.kind === "fulfilled");
            if (!retryAllowed) {
              attempt =
                pendingDispatch?.outcome()?.kind === "rejected"
                  ? { kind: "dispatchRejected" }
                  : { kind: "dispatchTimedOut" };
            } else {
              const blankWindow = observer.blankWindow();
              if (blankWindow.kind !== "found" || blankWindow.notebook !== attempt.notebook) {
                attempt = blankWindow.kind === "ambiguous" ? blankWindow : { kind: "missing" };
              } else {
                attempt = await runPythonCellAttempt(
                  origin,
                  observer,
                  operationDeadline,
                  false,
                  (stage) => this.setDiagnosticStage(stage),
                  "retrying-cell"
                );
              }
            }
          }
        } finally {
          pendingDispatch?.dispose();
        }
      }
    } finally {
      observer.dispose();
    }

    if (attempt.kind === "dispatchRejected") {
      void vscode.window.showWarningMessage(
        `Jupyter didn't confirm whether this Python ${origin.executionKind} started. Check the Interactive Window before running it again.`
      );
      return false;
    }
    if (attempt.kind === "dispatchTimedOut") {
      void vscode.window.showWarningMessage(
        `Jupyter didn't confirm whether this Python ${origin.executionKind} started. Check the Interactive Window before running it again.`
      );
      return false;
    }
    if (attempt.kind === "stale") {
      void vscode.window.showWarningMessage(
        "The Python file changed or closed while Python was running. Run it again before opening its dataframe."
      );
      return false;
    }
    if (attempt.kind === "ambiguous") {
      void vscode.window.showWarningMessage(
        "Jupyter changed the Interactive Window or produced more than one matching cell. Check the window before trying again."
      );
      return false;
    }
    if (attempt.kind === "missing" || attempt.kind === "needsKernel") {
      void vscode.window.showWarningMessage(
        `The Python ${origin.executionKind} did not produce an Interactive Window execution. Check the Jupyter output and try again.`
      );
      return false;
    }

    this.setDiagnosticStage("waiting-for-cell-completion");
    const executed = await waitForPinnedCellCompletion(
      origin,
      beforeCells,
      attempt.notebook,
      attempt.cell,
      operationDeadline
    );
    if (executed.kind === "stale") {
      void vscode.window.showWarningMessage(
        "The Python file changed or closed while Python was running. Run it again before opening its dataframe."
      );
      return false;
    }
    if (executed.kind === "ambiguous") {
      void vscode.window.showWarningMessage(
        "Jupyter changed the Interactive Window or produced more than one matching cell. Check the window before trying again."
      );
      return false;
    }
    if (executed.kind === "missing") {
      void vscode.window.showWarningMessage(
        `The Python ${origin.executionKind} did not produce an Interactive Window execution. Check the Jupyter output and try again.`
      );
      return false;
    }
    if (executed.kind === "timedOut") {
      void vscode.window.showWarningMessage(
        `The Python ${origin.executionKind} did not finish within two minutes. Check the Interactive Window before trying again.`
      );
      return false;
    }
    if (executed.cell.executionSummary?.success === false) {
      void vscode.window.showWarningMessage(
        `The Python ${origin.executionKind} failed. Fix the error shown in the Interactive Window, then run it again.`
      );
      return false;
    }
    return await this.discoverChooseAndOpen(executed.notebook, origin);
  }

  async refreshFromCommand(): Promise<void> {
    if (!this.activeTarget || !isSoleOpenNotebookDocument(this.activeTarget)) {
      void vscode.window.showInformationMessage(
        "Focus a Jupyter notebook or Python Interactive Window before refreshing live dataframes."
      );
      return;
    }
    await this.refreshActive(true);
  }

  async openCachedVariable(handle: unknown): Promise<void> {
    if (typeof handle !== "string") return;
    const cached = this.variablesByHandle.get(handle);
    const notebook = this.activeTarget;
    if (!cached || !notebook || !isSoleOpenNotebookDocument(notebook)) {
      void vscode.window.showInformationMessage(
        "That live dataframe is no longer available. Refresh the list and try again."
      );
      return;
    }
    if (cached.kind === "r") {
      await openDiscoveredRNotebookVariable(
        this.context,
        this.coordinator,
        notebook,
        cached.discovery,
        cached.descriptor
      );
      return;
    }
    await openDiscoveredPythonNotebookVariable(this.context, this.coordinator, notebook, cached.descriptor);
  }

  private synchronizeInitialFocus(): void {
    const textEditor = vscode.window.activeTextEditor;
    if (textEditor && isPythonSourceDocument(textEditor.document)) {
      this.onActiveTextEditorChanged(textEditor);
      return;
    }
    this.onActiveNotebookChanged(vscode.window.activeNotebookEditor);
  }

  private onActiveNotebookChanged(editor: vscode.NotebookEditor | undefined): void {
    this.activeSource = undefined;
    const notebook = editor?.notebook;
    if (!notebook || !isSupportedLiveNotebook(notebook) || !isSoleOpenNotebookDocument(notebook)) {
      this.setActiveTarget(undefined);
      return;
    }
    this.setActiveTarget(notebook);
  }

  private onActiveTextEditorChanged(editor: vscode.TextEditor | undefined): void {
    const document = editor?.document;
    if (!document || !isPythonSourceDocument(document) || !isSoleOpenTextDocument(document)) {
      this.activeSource = undefined;
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      this.setActiveTarget(
        notebook && isSupportedLiveNotebook(notebook) && isSoleOpenNotebookDocument(notebook) ? notebook : undefined
      );
      return;
    }
    this.activeSource = document;
    this.synchronizeSourceAssociation();
  }

  private onNotebookSetChanged(): void {
    if (this.activeSource) this.synchronizeSourceAssociation();
  }

  private onNotebookClosed(notebook: vscode.NotebookDocument): void {
    if (this.activeTarget === notebook) this.setActiveTarget(undefined);
    if (this.activeSource) this.synchronizeSourceAssociation();
  }

  private onNotebookChanged(event: vscode.NotebookDocumentChangeEvent): void {
    if (this.activeSource) this.synchronizeSourceAssociation();
    if (
      this.activeTarget === event.notebook &&
      event.cellChanges.some(
        (change) =>
          change.executionSummary?.success !== undefined || change.executionSummary?.timing?.endTime !== undefined
      )
    ) {
      void this.refreshActive(false);
    }
  }

  private synchronizeSourceAssociation(): void {
    const source = this.activeSource;
    if (!source || !isSoleOpenTextDocument(source)) {
      this.activeSource = undefined;
      this.setActiveTarget(undefined);
      return;
    }
    const matches = associatedNotebooks(source.uri.toString());
    this.setActiveTarget(matches.length === 1 ? matches[0]!.notebook : undefined);
  }

  private setActiveTarget(notebook: vscode.NotebookDocument | undefined): void {
    if (this.activeTarget === notebook) return;
    this.activeTarget = notebook;
    this.variablesByHandle.clear();
    if (!notebook) {
      this.currentSnapshot = undefined;
      this.changeEmitter.fire();
      return;
    }
    this.currentSnapshot = {
      state: "loading",
      notebookLabel: notebookLabel(notebook),
      message: "Looking for live dataframes…",
      variables: []
    };
    this.changeEmitter.fire();
    void this.refreshActive(false);
  }

  private async refreshActive(showEmptyMessage: boolean): Promise<void> {
    if (!showEmptyMessage && !shouldInspectNotebookAutomatically()) {
      this.variablesByHandle.clear();
      if (this.currentSnapshot !== undefined) {
        this.currentSnapshot = undefined;
        this.changeEmitter.fire();
      }
      return;
    }
    if (this.refreshRunning) {
      this.refreshAgain = true;
      return;
    }
    this.refreshRunning = true;
    try {
      do {
        this.refreshAgain = false;
        const notebook = this.activeTarget;
        if (!notebook || !isSoleOpenNotebookDocument(notebook)) return;
        try {
          const discovery = await discoverVariablesForSelectedKernel(notebook);
          if (this.activeTarget !== notebook || !isSoleOpenNotebookDocument(notebook)) continue;
          this.publishDiscovery(notebook, discovery);
          if (showEmptyMessage && discovery.variables.length === 0) {
            void vscode.window.showInformationMessage(
              "No live Pandas, Polars, DuckDB, PySpark, or R dataframe was found in this kernel."
            );
          }
        } catch (error) {
          if (this.activeTarget !== notebook || !isSoleOpenNotebookDocument(notebook)) continue;
          this.variablesByHandle.clear();
          this.currentSnapshot = {
            state: "error",
            notebookLabel: notebookLabel(notebook),
            message:
              error instanceof NotebookVariableDiscoveryError || error instanceof RNotebookVariableDiscoveryError
                ? error.message
                : "Open Wrangler could not inspect this notebook kernel.",
            variables: []
          };
          this.changeEmitter.fire();
        }
      } while (this.refreshAgain && !this.disposed);
    } finally {
      this.refreshRunning = false;
    }
  }

  private publishDiscovery(
    notebook: vscode.NotebookDocument,
    discovery: NotebookVariableDiscovery | RNotebookVariableDiscovery
  ): void {
    this.variablesByHandle.clear();
    const rDiscovery = isRNotebookVariableDiscovery(discovery) ? discovery : undefined;
    const variables = discovery.variables.map((descriptor): NotebookLiveVariableItem => {
      const handle = randomUUID();
      let item: NotebookLiveVariableItem;
      if ("dataframeFlavor" in descriptor) {
        if (!rDiscovery) throw new Error("Open Wrangler received a mixed notebook dataframe discovery.");
        item = {
          handle,
          label: descriptor.name,
          description: `R · ${rDataframeFlavorLabel(descriptor.dataframeFlavor)}`,
          detail: `Live in ${notebookLabel(notebook)}`
        };
        this.variablesByHandle.set(handle, { kind: "r", discovery: rDiscovery, descriptor, item });
      } else {
        const presentation = notebookVariablePresentation(descriptor.type);
        item = {
          handle,
          label: descriptor.name,
          description: `${presentation.family} · ${presentation.kind}`,
          detail: `Live in ${notebookLabel(notebook)}`
        };
        this.variablesByHandle.set(handle, { kind: "python", descriptor, item });
      }
      return item;
    });
    this.currentSnapshot =
      variables.length === 0
        ? {
            state: "empty",
            notebookLabel: notebookLabel(notebook),
            message: "No live dataframes. Run a cell, then refresh.",
            variables: []
          }
        : {
            state: "ready",
            notebookLabel: notebookLabel(notebook),
            message: discovery.truncated ? "Live dataframes · list truncated" : "Live dataframes",
            variables
          };
    this.changeEmitter.fire();
  }

  private async discoverChooseAndOpen(notebook: vscode.NotebookDocument, origin: PythonCellOrigin): Promise<boolean> {
    if (!isUnchangedPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
      void vscode.window.showWarningMessage(
        "The Python file or Interactive Window changed before Open Wrangler could inspect it. Try again."
      );
      return false;
    }
    let discovery: NotebookVariableDiscovery;
    try {
      this.setDiagnosticStage("discovering-variables");
      discovery = await discoverNotebookVariables(notebook);
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof NotebookVariableDiscoveryError
          ? error.message
          : "Open Wrangler could not inspect dataframe variables in this Interactive Window."
      );
      return false;
    }
    if (!isUnchangedPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
      void vscode.window.showWarningMessage(
        "The Python file or Interactive Window changed before Open Wrangler could open its dataframe. Try again."
      );
      return false;
    }
    if (this.activeTarget === notebook) this.publishDiscovery(notebook, discovery);
    if (discovery.variables.length === 0) {
      void vscode.window.showInformationMessage(
        "No live Pandas, Polars, DuckDB, or PySpark dataframe was found. Run the cell that creates it, then try again."
      );
      return false;
    }

    let selected: NotebookVariableDescriptor | undefined;
    if (discovery.variables.length === 1) {
      selected = discovery.variables[0];
    } else {
      const items = discovery.variables.map(variablePickItem);
      const choice = await vscode.window.showQuickPick(items, {
        title: "Open Wrangler: Open Live Dataframe",
        placeHolder: discovery.truncated
          ? "Select a dataframe (the discovery list was truncated)"
          : "Select a dataframe from this Interactive Window",
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
      });
      if (!isUnchangedPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
        void vscode.window.showWarningMessage(
          "The Python file or Interactive Window changed while the picker was open. Try again."
        );
        return false;
      }
      if (!choice || !items.includes(choice)) return false;
      await restoreEditorGroupAfterQuickPick();
      if (!isUnchangedPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
        void vscode.window.showWarningMessage(
          "The Python file or Interactive Window changed while focus returned from the picker. Try again."
        );
        return false;
      }
      selected = choice.descriptor;
    }
    if (!selected) return false;
    this.setDiagnosticStage("opening-variable");
    await openDiscoveredPythonNotebookVariable(this.context, this.coordinator, notebook, selected);
    return true;
  }

  private beginDiagnostics(initialStage: PythonInteractiveDiagnosticStage = "dispatching-cell"): void {
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS !== "1") return;
    this.diagnosticInvocation += 1;
    this.diagnosticStage = initialStage;
    this.diagnosticLastActiveStage = activeDiagnosticStage(initialStage);
    this.diagnosticStages = Object.freeze([initialStage]);
  }

  private finishDiagnostics(succeeded: boolean): void {
    this.setDiagnosticStage(succeeded ? "complete" : "failed");
  }

  private setDiagnosticStage(stage: PythonInteractiveDiagnosticStage): void {
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS !== "1" || this.diagnosticStage === stage) return;
    this.diagnosticStage = stage;
    this.diagnosticLastActiveStage = activeDiagnosticStage(stage) ?? this.diagnosticLastActiveStage;
    this.diagnosticStages = Object.freeze(
      [...this.diagnosticStages, stage].slice(-PYTHON_INTERACTIVE_DIAGNOSTIC_HISTORY_LIMIT)
    );
  }
}

function registerAtomically<T>(subscriptions: vscode.Disposable[], register: () => T): T {
  const start = subscriptions.length;
  try {
    return register();
  } catch (error) {
    const failures: unknown[] = [error];
    for (const disposable of subscriptions.splice(start).reverse()) {
      try {
        disposable.dispose();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "Open Wrangler Python variable registration failed during rollback.");
  }
}

function activeDiagnosticStage(
  stage: PythonInteractiveDiagnosticStage
): PythonInteractiveActiveDiagnosticStage | undefined {
  return stage === "idle" || stage === "complete" || stage === "failed" ? undefined : stage;
}

function variablePickItem(descriptor: NotebookVariableDescriptor): VariablePickItem {
  const presentation = notebookVariablePresentation(descriptor.type);
  return {
    label: descriptor.name,
    description: `${presentation.family} · ${presentation.kind}`,
    detail: descriptor.backend === "pyspark" ? "Live viewing-only session" : "Live notebook session",
    descriptor
  };
}

function rDataframeFlavorLabel(flavor: RNotebookVariableDescriptor["dataframeFlavor"]): string {
  switch (flavor) {
    case "r.data.frame":
      return "data.frame";
    case "r.tibble":
      return "tibble";
    case "r.data.table":
      return "data.table";
  }
}

function notebookLabel(notebook: vscode.NotebookDocument): string {
  const path = notebook.uri.path;
  const slash = path.lastIndexOf("/");
  const label = path.slice(slash + 1);
  return label || (notebook.notebookType === "interactive" ? "Interactive Window" : "notebook");
}
