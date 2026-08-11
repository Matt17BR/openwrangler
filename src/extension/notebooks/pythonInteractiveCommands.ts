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
import {
  isCurrentLiterateDocumentOrigin,
  isUnchangedLiterateDocumentOrigin,
  type LiterateDocumentOrigin
} from "../literateDocumentOrigin";

const PYTHON_CELL_MARKER = /^\s*#\s*(?:%%|<codecell>|In\[\d*?\]|In\[ \])/u;
const MARKDOWN_CELL_MARKER = /^\s*#\s*(?:%%\s*\[markdown\]|<markdowncell>)/iu;
const MAX_INTERACTIVE_CELL_METADATA_TEXT = 64 * 1024;
const PYTHON_CELL_PUBLICATION_TIMEOUT_MS = 10_000;
const PYTHON_CELL_EXECUTION_TIMEOUT_MS = 120_000;

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

interface PythonCellOrigin {
  readonly editor: vscode.TextEditor;
  readonly document: vscode.TextDocument;
  readonly version: number;
  readonly sourceUri: string;
  readonly executionKind: "cell" | "chunk" | "file";
  readonly command:
    | "jupyter.execSelectionInteractive"
    | "jupyter.runcurrentcell"
    | "jupyter.runFileInteractive"
    | "quarto.runCurrentCell";
  readonly commandArguments: readonly unknown[];
  readonly startLine: number;
  readonly endLine: number;
  readonly selection: vscode.Selection;
  readonly selections: readonly vscode.Selection[];
  readonly viewColumn: vscode.ViewColumn;
  readonly literateOrigin?: LiterateDocumentOrigin;
}

interface InteractiveCellIdentity {
  readonly cell: vscode.NotebookCell;
  readonly id: string | undefined;
  readonly lineIndex: number | undefined;
}

interface PreviousInteractiveCells {
  readonly cells: ReadonlySet<vscode.NotebookCell>;
  readonly ids: ReadonlySet<string>;
}

interface AssociatedNotebook {
  readonly notebook: vscode.NotebookDocument;
  readonly cells: readonly InteractiveCellIdentity[];
}

interface VariablePickItem extends vscode.QuickPickItem {
  readonly descriptor: NotebookVariableDescriptor;
}

type PythonExecutedCellResult =
  | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument; readonly cell: vscode.NotebookCell }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "timedOut" }
  | { readonly kind: "stale" };

type PythonCellAttemptResult =
  | { readonly kind: "published"; readonly notebook: vscode.NotebookDocument; readonly cell: vscode.NotebookCell }
  | { readonly kind: "needsKernel"; readonly notebook: vscode.NotebookDocument }
  | { readonly kind: "dispatchRejected" }
  | { readonly kind: "dispatchTimedOut" }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "stale" };

type PythonCellDispatchOutcome =
  | { readonly kind: "fulfilled" }
  | { readonly kind: "rejected" }
  | { readonly kind: "timedOut" }
  | { readonly kind: "cancelled" };

/**
 * Registers the Python-file/Interactive Window actions and keeps a small cache
 * for the one notebook that is currently active. It does not poll kernels and
 * never discovers variables in an inactive notebook.
 */
export function registerPythonInteractiveCommands(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator
): NotebookLiveVariableProvider & LiteratePythonVariableProvider {
  const provider = new NotebookInteractiveCoordinator(context, coordinator);
  context.subscriptions.push(
    provider,
    vscode.commands.registerCommand("openWrangler.runPythonCellAndOpenVariable", () =>
      provider.runCellAndOpenVariable()
    ),
    vscode.commands.registerCommand("openWrangler.refreshNotebookVariables", () => provider.refreshFromCommand()),
    vscode.commands.registerCommand("openWrangler.openCachedNotebookVariable", (handle: unknown) =>
      provider.openCachedVariable(handle)
    )
  );
  return provider;
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

  readonly onDidChangeVariables = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly coordinator: SessionCoordinator
  ) {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveNotebookEditor((editor) => this.onActiveNotebookChanged(editor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveTextEditorChanged(editor)),
      vscode.workspace.onDidOpenNotebookDocument(() => this.onNotebookSetChanged()),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => this.onNotebookClosed(notebook)),
      vscode.workspace.onDidChangeNotebookDocument((event) => this.onNotebookChanged(event))
    );
    this.synchronizeInitialFocus();
  }

  snapshot(): NotebookLiveVariableSnapshot | undefined {
    return this.currentSnapshot;
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
    try {
      await this.performRunCellAndOpenVariable(capturePythonCellOrigin());
    } finally {
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
    try {
      return await this.performRunCellAndOpenVariable(execution);
    } finally {
      this.runCellRunning = false;
    }
  }

  hasAssociatedLiterateSession(origin: LiterateDocumentOrigin): boolean {
    return isCurrentLiterateDocumentOrigin(origin) && associatedNotebooks(origin.uri).length > 0;
  }

  async openAssociatedLiterateSession(origin: LiterateDocumentOrigin): Promise<boolean> {
    if (!isCurrentLiterateDocumentOrigin(origin)) return false;
    const associated = associatedNotebooks(origin.uri);
    if (associated.length === 0) return false;
    if (associated.length !== 1) {
      void vscode.window.showInformationMessage(
        "More than one Python Interactive Window belongs to this document. Close the extra window and try again."
      );
      return false;
    }
    const execution = pythonOriginFromLiterateDocument(origin, false);
    if (!execution) return false;
    return await this.discoverChooseAndOpen(associated[0]!.notebook, execution);
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

    const existingCells = allAssociatedCells(origin.sourceUri).flatMap(({ cells }) => cells);
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
      attempt = await runPythonCellAttempt(origin, observer, operationDeadline, true);
      if (attempt.kind === "needsKernel") {
        const restored = await selectKernelAndRestorePythonOrigin(attempt.notebook, origin, operationDeadline);
        if (!restored) return false;

        const afterSelection = observer.snapshot();
        if (afterSelection.kind === "found") {
          attempt = { kind: "published", notebook: afterSelection.notebook, cell: afterSelection.cell };
        } else if (afterSelection.kind === "ambiguous") {
          attempt = afterSelection;
        } else if (!isExactPythonOrigin(origin)) {
          attempt = { kind: "stale" };
        } else {
          const blankWindow = observer.blankWindow();
          if (blankWindow.kind !== "found" || blankWindow.notebook !== attempt.notebook) {
            attempt = blankWindow.kind === "ambiguous" ? blankWindow : { kind: "missing" };
          } else {
            attempt = await runPythonCellAttempt(origin, observer, operationDeadline, false);
          }
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
    if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
      void vscode.window.showWarningMessage(
        "The Python file or Interactive Window changed before Open Wrangler could inspect it. Try again."
      );
      return false;
    }
    let discovery: NotebookVariableDiscovery;
    try {
      discovery = await discoverNotebookVariables(notebook);
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof NotebookVariableDiscoveryError
          ? error.message
          : "Open Wrangler could not inspect dataframe variables in this Interactive Window."
      );
      return false;
    }
    if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
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
      if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
        void vscode.window.showWarningMessage(
          "The Python file or Interactive Window changed while the picker was open. Try again."
        );
        return false;
      }
      if (!choice || !items.includes(choice)) return false;
      await restoreEditorGroupAfterQuickPick();
      if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
        void vscode.window.showWarningMessage(
          "The Python file or Interactive Window changed while focus returned from the picker. Try again."
        );
        return false;
      }
      selected = choice.descriptor;
    }
    if (!selected) return false;
    await openDiscoveredPythonNotebookVariable(this.context, this.coordinator, notebook, selected);
    return true;
  }
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

function capturePythonCellOrigin(): PythonCellOrigin | undefined {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  if (!editor || !document || !isPythonSourceDocument(document) || !isSoleOpenTextDocument(document)) return undefined;
  let hasCellMarker = false;
  for (let line = 0; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    if (PYTHON_CELL_MARKER.test(text) || MARKDOWN_CELL_MARKER.test(text)) {
      hasCellMarker = true;
      break;
    }
  }
  if (!hasCellMarker) {
    return {
      editor,
      document,
      version: document.version,
      sourceUri: document.uri.toString(),
      executionKind: "file",
      command: "jupyter.runFileInteractive",
      commandArguments: [document.uri],
      startLine: 0,
      endLine: 0,
      selection: editor.selection,
      selections: Object.freeze([...editor.selections]),
      viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active
    };
  }
  const activeLine = editor.selection.active.line;
  let startLine = -1;
  for (let line = Math.min(activeLine, document.lineCount - 1); line >= 0; line -= 1) {
    const text = document.lineAt(line).text;
    if (MARKDOWN_CELL_MARKER.test(text)) return undefined;
    if (!PYTHON_CELL_MARKER.test(text)) continue;
    startLine = line;
    break;
  }
  if (startLine < 0) return undefined;
  return {
    editor,
    document,
    version: document.version,
    sourceUri: document.uri.toString(),
    executionKind: "cell",
    command: "jupyter.runcurrentcell",
    commandArguments: [],
    startLine,
    endLine: startLine,
    selection: editor.selection,
    selections: Object.freeze([...editor.selections]),
    viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active
  };
}

function pythonOriginFromLiterateDocument(
  origin: LiterateDocumentOrigin,
  requireChunk = true
): PythonCellOrigin | undefined {
  if (!isCurrentLiterateDocumentOrigin(origin)) return undefined;
  const chunk = origin.chunk;
  if (requireChunk && chunk?.language !== "python") return undefined;
  if (requireChunk && origin.pythonExecutionOwner !== "jupyter") return undefined;
  const startLine = chunk?.openingLine ?? origin.selections[0]?.active.line;
  if (startLine === undefined) return undefined;
  const command = origin.kind === "quarto" ? "quarto.runCurrentCell" : "jupyter.execSelectionInteractive";
  const commandArguments =
    origin.kind === "quarto" ? [Math.max(1, (chunk?.openingLine ?? startLine) + 1)] : [chunk?.code ?? ""];
  return Object.freeze({
    editor: origin.editor,
    document: origin.document,
    version: origin.version,
    sourceUri: origin.uri,
    executionKind: "chunk",
    command,
    commandArguments: Object.freeze(commandArguments),
    startLine,
    endLine: chunk?.closingLine ?? startLine,
    selection: origin.editor.selection,
    selections: Object.freeze([...origin.editor.selections]),
    viewColumn: origin.viewColumn,
    literateOrigin: origin
  });
}

function isPythonSourceDocument(document: vscode.TextDocument): boolean {
  const scheme = document.uri.scheme;
  return (
    document.languageId === "python" &&
    (scheme === "file" || scheme === "vscode-remote" || scheme === "untitled") &&
    document.uri.path.toLowerCase().endsWith(".py")
  );
}

function isExactPythonOrigin(origin: PythonCellOrigin): boolean {
  if (origin.literateOrigin) return isCurrentLiterateDocumentOrigin(origin.literateOrigin);
  return (
    !origin.document.isClosed &&
    origin.document.version === origin.version &&
    isSoleOpenTextDocument(origin.document) &&
    origin.document.uri.toString() === origin.sourceUri
  );
}

function isSoleOpenTextDocument(document: vscode.TextDocument): boolean {
  if (document.isClosed) return false;
  const uri = document.uri.toString();
  let found = false;
  for (const openDocument of vscode.workspace.textDocuments) {
    if (openDocument.isClosed || openDocument.uri.toString() !== uri) continue;
    if (openDocument !== document || found) return false;
    found = true;
  }
  return found;
}

function isSupportedPythonNotebook(notebook: vscode.NotebookDocument): boolean {
  if (notebook.notebookType !== "interactive" && notebook.notebookType !== "jupyter-notebook") return false;
  const language = notebookLanguageHint(notebook);
  return language === undefined || language === "python";
}

function isSupportedLiveNotebook(notebook: vscode.NotebookDocument): boolean {
  return notebook.notebookType === "interactive" || notebook.notebookType === "jupyter-notebook";
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

function notebookLanguageHint(notebook: vscode.NotebookDocument): string | undefined {
  const metadata = notebook.metadata;
  for (const candidate of [
    nestedString(metadata, "kernelspec", "language"),
    nestedString(metadata, "language_info", "name")
  ]) {
    if (candidate) return candidate.trim().toLowerCase();
  }
  for (const cell of notebook.getCells()) {
    if (cell.kind !== vscode.NotebookCellKind.Code) continue;
    const languageId = cell.document.languageId.trim().toLowerCase();
    if (languageId) return languageId;
  }
  return undefined;
}

function nestedString(record: unknown, parent: string, child: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const nested = record[parent];
  return isRecord(nested) && typeof nested[child] === "string" ? nested[child] : undefined;
}

function associatedNotebooks(sourceUri: string): AssociatedNotebook[] {
  return allAssociatedCells(sourceUri).filter(({ cells }) => cells.length > 0);
}

function allAssociatedCells(sourceUri: string): AssociatedNotebook[] {
  const matches: AssociatedNotebook[] = [];
  for (const notebook of vscode.workspace.notebookDocuments) {
    if (!isSupportedPythonNotebook(notebook) || !isSoleOpenNotebookDocument(notebook)) continue;
    const cells = notebook.getCells().flatMap((cell): InteractiveCellIdentity[] => {
      const identity = interactiveCellIdentity(cell, sourceUri);
      return identity ? [identity] : [];
    });
    if (cells.length > 0) matches.push({ notebook, cells });
  }
  return matches;
}

function interactiveCellIdentity(
  cell: vscode.NotebookCell,
  expectedSourceUri: string
): InteractiveCellIdentity | undefined {
  try {
    const metadata = cell.metadata;
    if (!isRecord(metadata) || !isRecord(metadata.interactive)) return undefined;
    const source = metadata.interactive.uristring;
    if (
      typeof source !== "string" ||
      source.length === 0 ||
      source.length > MAX_INTERACTIVE_CELL_METADATA_TEXT ||
      source !== expectedSourceUri
    ) {
      return undefined;
    }
    const id =
      typeof metadata.id === "string" && metadata.id.length > 0 && metadata.id.length <= 256 ? metadata.id : undefined;
    const lineIndex =
      typeof metadata.interactive.lineIndex === "number" &&
      Number.isSafeInteger(metadata.interactive.lineIndex) &&
      metadata.interactive.lineIndex >= 0
        ? metadata.interactive.lineIndex
        : undefined;
    return { cell, id, lineIndex };
  } catch {
    return undefined;
  }
}

function newlyExecutedCell(
  origin: PythonCellOrigin,
  before: PreviousInteractiveCells
):
  | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument; readonly cell: vscode.NotebookCell }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" } {
  const candidates = allAssociatedCells(origin.sourceUri).flatMap(({ notebook, cells }) =>
    cells.flatMap(({ cell, id, lineIndex }) =>
      lineIndex !== undefined &&
      lineIndex >= origin.startLine &&
      lineIndex <= origin.endLine &&
      !before.cells.has(cell) &&
      (id === undefined || !before.ids.has(id))
        ? [{ notebook, cell }]
        : []
    )
  );
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length !== 1) return { kind: "ambiguous" };
  return { kind: "found", ...candidates[0]! };
}

function newlyOpenedBlankInteractiveWindow(
  before: ReadonlySet<vscode.NotebookDocument>
):
  | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" } {
  const candidates = vscode.workspace.notebookDocuments.filter(
    (notebook) =>
      !before.has(notebook) &&
      !notebook.isClosed &&
      notebook.notebookType === "interactive" &&
      isSupportedPythonNotebook(notebook) &&
      isEmptyInteractiveWindow(notebook) &&
      isSoleOpenNotebookDocument(notebook)
  );
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length !== 1) return { kind: "ambiguous" };
  return { kind: "found", notebook: candidates[0]! };
}

function isEmptyInteractiveWindow(notebook: vscode.NotebookDocument): boolean {
  const cells = notebook.getCells();
  if (cells.length === 0) return true;
  if (cells.length !== 1) return false;
  const [cell] = cells;
  return (
    cell?.kind === vscode.NotebookCellKind.Markup &&
    cell.document.languageId.trim().toLowerCase() === "markdown" &&
    isRecord(cell.metadata) &&
    !("interactive" in cell.metadata)
  );
}

async function selectKernelAndRestorePythonOrigin(
  notebook: vscode.NotebookDocument,
  origin: PythonCellOrigin,
  operationDeadline: number
): Promise<boolean> {
  if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
    void vscode.window.showWarningMessage(
      "The Python file or Interactive Window changed while its kernel was being selected. Try again."
    );
    return false;
  }
  const shown = await settleBeforeDeadline(
    () =>
      vscode.window.showNotebookDocument(notebook, {
        viewColumn: origin.viewColumn,
        preserveFocus: false,
        preview: false
      }),
    operationDeadline
  );
  if (shown.kind === "timedOut") {
    void vscode.window.showWarningMessage("Jupyter did not finish opening the Interactive Window in time.");
    return false;
  }
  if (shown.kind === "rejected") {
    void vscode.window.showWarningMessage("Jupyter could not select a kernel for the Interactive Window.");
    return false;
  }
  const notebookEditor = shown.value;
  if (
    notebookEditor.notebook !== notebook ||
    !isSoleOpenNotebookDocument(notebook) ||
    !isUnchangedPythonOrigin(origin) ||
    (origin.literateOrigin !== undefined && vscode.window.activeNotebookEditor !== notebookEditor)
  ) {
    void vscode.window.showWarningMessage(
      "The Python file or Interactive Window changed while its kernel was being selected. Try again."
    );
    return false;
  }
  const selected = await settleBeforeDeadline(
    () => vscode.commands.executeCommand("notebook.selectKernel", { notebookEditor }),
    operationDeadline
  );
  if (selected.kind === "timedOut") {
    void vscode.window.showWarningMessage("Kernel selection did not finish in time.");
    return false;
  }
  if (selected.kind === "rejected") {
    void vscode.window.showWarningMessage("Jupyter could not select a kernel for the Interactive Window.");
    return false;
  }
  if (
    !isUnchangedPythonOrigin(origin) ||
    !isSoleOpenNotebookDocument(notebook) ||
    (origin.literateOrigin !== undefined && vscode.window.activeNotebookEditor !== notebookEditor)
  ) {
    void vscode.window.showWarningMessage(
      "The Python file or Interactive Window changed during kernel selection. Try again."
    );
    return false;
  }
  const restoredResult = await settleBeforeDeadline(
    () =>
      vscode.window.showTextDocument(origin.document, {
        viewColumn: origin.viewColumn,
        preserveFocus: false,
        preview: false
      }),
    operationDeadline
  );
  if (restoredResult.kind === "timedOut") {
    void vscode.window.showWarningMessage("The Python file could not be restored in time.");
    return false;
  }
  if (restoredResult.kind === "rejected") {
    void vscode.window.showWarningMessage("Jupyter selected a kernel, but the Python file could not be restored.");
    return false;
  }
  const restored = restoredResult.value;
  if (
    restored.document !== origin.document ||
    (origin.literateOrigin !== undefined && restored !== origin.editor) ||
    !isExactPythonOrigin(origin)
  ) {
    void vscode.window.showWarningMessage("The Python file changed while its kernel was being selected. Try again.");
    return false;
  }
  restored.selection = origin.selection;
  restored.selections = [...origin.selections];
  if (vscode.window.activeTextEditor !== restored) {
    void vscode.window.showWarningMessage("The Python file could not be focused after kernel selection. Try again.");
    return false;
  }
  return true;
}

function isUnchangedPythonOrigin(origin: PythonCellOrigin): boolean {
  return origin.literateOrigin ? isUnchangedLiterateDocumentOrigin(origin.literateOrigin) : isExactPythonOrigin(origin);
}

function settleBeforeDeadline<T>(
  work: () => Thenable<T>,
  deadline: number
): Promise<
  { readonly kind: "fulfilled"; readonly value: T } | { readonly kind: "rejected" } | { readonly kind: "timedOut" }
> {
  if (Date.now() >= deadline) return Promise.resolve({ kind: "timedOut" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      result:
        | { readonly kind: "fulfilled"; readonly value: T }
        | { readonly kind: "rejected" }
        | { readonly kind: "timedOut" }
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "timedOut" }), Math.max(0, deadline - Date.now()));
    let pending: Thenable<T>;
    try {
      pending = work();
    } catch {
      finish({ kind: "rejected" });
      return;
    }
    void Promise.resolve(pending).then(
      (value) => finish({ kind: "fulfilled", value }),
      () => finish({ kind: "rejected" })
    );
  });
}

class PythonCellDispatchObserver implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(
    private readonly origin: PythonCellOrigin,
    private readonly beforeCells: PreviousInteractiveCells,
    private readonly beforeInteractiveWindows: ReadonlySet<vscode.NotebookDocument>
  ) {
    const changed = (): void => this.changeEmitter.fire();
    this.subscriptions = [
      vscode.workspace.onDidOpenNotebookDocument(changed),
      vscode.workspace.onDidChangeNotebookDocument(changed),
      vscode.workspace.onDidCloseNotebookDocument(changed)
    ];
  }

  snapshot():
    | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument; readonly cell: vscode.NotebookCell }
    | { readonly kind: "missing" }
    | { readonly kind: "ambiguous" }
    | { readonly kind: "stale" } {
    if (!isExactPythonOrigin(this.origin)) return { kind: "stale" };
    return newlyExecutedCell(this.origin, this.beforeCells);
  }

  blankWindow():
    | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument }
    | { readonly kind: "missing" }
    | { readonly kind: "ambiguous" } {
    return newlyOpenedBlankInteractiveWindow(this.beforeInteractiveWindows);
  }

  waitForChange(timeoutMs: number): Promise<"changed" | "timedOut" | "cancelled"> {
    return this.cancelableWaitForChange(timeoutMs).promise;
  }

  cancelableWaitForChange(timeoutMs: number): {
    readonly promise: Promise<"changed" | "timedOut" | "cancelled">;
    dispose(): void;
  } {
    if (this.disposed || timeoutMs <= 0) {
      return { promise: Promise.resolve("timedOut"), dispose: () => undefined };
    }
    let cancel = (): void => undefined;
    const promise = new Promise<"changed" | "timedOut" | "cancelled">((resolve) => {
      let settled = false;
      const finish = (result: "changed" | "timedOut" | "cancelled"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription.dispose();
        resolve(result);
      };
      const subscription = this.changeEmitter.event(() => finish("changed"));
      const timer = setTimeout(() => finish("timedOut"), timeoutMs);
      cancel = () => finish("cancelled");
    });
    return { promise, dispose: () => cancel() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.changeEmitter.dispose();
  }
}

async function runPythonCellAttempt(
  origin: PythonCellOrigin,
  observer: PythonCellDispatchObserver,
  operationDeadline: number,
  allowKernelRecovery: boolean
): Promise<PythonCellAttemptResult> {
  if (Date.now() >= operationDeadline) return { kind: "dispatchTimedOut" };
  const initial = observer.snapshot();
  if (initial.kind === "found") return { kind: "published", notebook: initial.notebook, cell: initial.cell };
  if (initial.kind !== "missing") return initial;

  const dispatchDeadline = Math.min(operationDeadline, Date.now() + PYTHON_CELL_PUBLICATION_TIMEOUT_MS);
  const dispatch = boundedPythonCellDispatch(origin, dispatchDeadline);
  try {
    while (true) {
      const snapshot = observer.snapshot();
      if (snapshot.kind === "found") return { kind: "published", notebook: snapshot.notebook, cell: snapshot.cell };
      if (snapshot.kind !== "missing") return snapshot;

      const remaining = dispatchDeadline - Date.now();
      const change = observer.cancelableWaitForChange(remaining);
      const event = await Promise.race([
        dispatch.promise.then((outcome) => ({ kind: "dispatch" as const, outcome })),
        change.promise.then((outcome) => ({ kind: "change" as const, outcome }))
      ]).finally(() => change.dispose());
      if (event.kind === "change" && event.outcome === "changed") continue;

      const afterDispatch = observer.snapshot();
      if (afterDispatch.kind === "found") {
        return { kind: "published", notebook: afterDispatch.notebook, cell: afterDispatch.cell };
      }
      if (afterDispatch.kind !== "missing") return afterDispatch;
      if (event.kind === "change") return { kind: "dispatchTimedOut" };
      if (event.outcome.kind === "rejected") return { kind: "dispatchRejected" };
      if (event.outcome.kind === "timedOut" || event.outcome.kind === "cancelled") {
        return { kind: "dispatchTimedOut" };
      }
      break;
    }
  } finally {
    dispatch.dispose();
  }

  return await waitForPublishedCellAfterDispatch(observer, operationDeadline, allowKernelRecovery);
}

function boundedPythonCellDispatch(
  origin: PythonCellOrigin,
  deadline: number
): {
  readonly promise: Promise<PythonCellDispatchOutcome>;
  dispose(): void;
} {
  let cancel = (): void => undefined;
  const promise = new Promise<PythonCellDispatchOutcome>((resolve) => {
    let settled = false;
    const finish = (result: PythonCellDispatchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "timedOut" }), Math.max(0, deadline - Date.now()));
    let command: Thenable<unknown>;
    try {
      command = vscode.commands.executeCommand(origin.command, ...origin.commandArguments);
    } catch {
      finish({ kind: "rejected" });
      return;
    }
    void Promise.resolve(command).then(
      () => finish({ kind: "fulfilled" }),
      () => finish({ kind: "rejected" })
    );
    cancel = () => finish({ kind: "cancelled" });
  });
  return { promise, dispose: () => cancel() };
}

async function waitForPublishedCellAfterDispatch(
  observer: PythonCellDispatchObserver,
  operationDeadline: number,
  allowKernelRecovery: boolean
): Promise<PythonCellAttemptResult> {
  const publicationDeadline = Math.min(operationDeadline, Date.now() + PYTHON_CELL_PUBLICATION_TIMEOUT_MS);
  let pinnedBlankWindow: vscode.NotebookDocument | undefined;
  while (true) {
    const snapshot = observer.snapshot();
    if (snapshot.kind === "found") {
      return { kind: "published", notebook: snapshot.notebook, cell: snapshot.cell };
    }
    if (snapshot.kind !== "missing") return snapshot;

    const blankWindow = observer.blankWindow();
    if (blankWindow.kind === "ambiguous") return blankWindow;
    if (blankWindow.kind === "found") {
      if (pinnedBlankWindow && pinnedBlankWindow !== blankWindow.notebook) return { kind: "ambiguous" };
      pinnedBlankWindow ??= blankWindow.notebook;
    } else if (pinnedBlankWindow) {
      return { kind: "missing" };
    }
    const event = await observer.waitForChange(publicationDeadline - Date.now());
    if (event === "changed") continue;

    const finalSnapshot = observer.snapshot();
    if (finalSnapshot.kind === "found") {
      return { kind: "published", notebook: finalSnapshot.notebook, cell: finalSnapshot.cell };
    }
    if (finalSnapshot.kind !== "missing") return finalSnapshot;
    if (event === "cancelled") return { kind: "dispatchTimedOut" };
    if (pinnedBlankWindow) {
      const finalBlank = observer.blankWindow();
      if (finalBlank.kind === "ambiguous") return finalBlank;
      if (finalBlank.kind !== "found" || finalBlank.notebook !== pinnedBlankWindow) return { kind: "missing" };
      return allowKernelRecovery ? { kind: "needsKernel", notebook: pinnedBlankWindow } : { kind: "missing" };
    }
    return { kind: "missing" };
  }
}

function waitForPinnedCellCompletion(
  origin: PythonCellOrigin,
  before: PreviousInteractiveCells,
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  operationDeadline: number
): Promise<PythonExecutedCellResult> {
  const completedCandidate = (): PythonExecutedCellResult | undefined => {
    if (!isExactPythonOrigin(origin)) return { kind: "stale" };
    const candidate = newlyExecutedCell(origin, before);
    if (candidate.kind !== "found") return candidate;
    if (candidate.notebook !== notebook || candidate.cell !== cell) return { kind: "ambiguous" };
    const summary = cell.executionSummary;
    if (summary?.success === undefined && summary?.timing?.endTime === undefined) return undefined;
    return { kind: "found", notebook, cell };
  };

  const immediate = completedCandidate();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];
    const finish = (result: PythonExecutedCellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
      resolve(result);
    };
    const check = (): void => {
      const result = completedCandidate();
      if (result) finish(result);
    };
    subscriptions.push(
      vscode.workspace.onDidOpenNotebookDocument(check),
      vscode.workspace.onDidChangeNotebookDocument(check),
      vscode.workspace.onDidCloseNotebookDocument(check)
    );
    const timeout = setTimeout(
      () => {
        if (!isExactPythonOrigin(origin)) {
          finish({ kind: "stale" });
          return;
        }
        finish({ kind: "timedOut" });
      },
      Math.max(0, operationDeadline - Date.now())
    );
    check();
  });
}

function notebookLabel(notebook: vscode.NotebookDocument): string {
  const path = notebook.uri.path;
  const slash = path.lastIndexOf("/");
  const label = path.slice(slash + 1);
  return label || (notebook.notebookType === "interactive" ? "Interactive Window" : "notebook");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
