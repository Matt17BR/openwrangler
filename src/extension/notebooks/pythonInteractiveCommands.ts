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
import { openDiscoveredPythonNotebookVariable } from "./jupyterBridge";
import { restoreEditorGroupAfterQuickPick } from "../webviewPanel";

const PYTHON_CELL_MARKER = /^\s*#\s*%%(?:\s|$)/u;
const MARKDOWN_CELL_MARKER = /^\s*#\s*%%.*\[markdown\]/iu;
const MAX_INTERACTIVE_CELL_METADATA_TEXT = 64 * 1024;
const PYTHON_CELL_PUBLICATION_TIMEOUT_MS = 10_000;
const PYTHON_CELL_EXECUTION_TIMEOUT_MS = 120_000;

export interface PythonLiveVariableItem {
  readonly handle: string;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

export type PythonLiveVariableSnapshot =
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
      readonly variables: readonly PythonLiveVariableItem[];
    };

export interface PythonLiveVariableProvider extends vscode.Disposable {
  readonly onDidChangeVariables: vscode.Event<void>;
  snapshot(): PythonLiveVariableSnapshot | undefined;
}

interface CachedVariable {
  readonly descriptor: NotebookVariableDescriptor;
  readonly item: PythonLiveVariableItem;
}

interface PythonCellOrigin {
  readonly editor: vscode.TextEditor;
  readonly document: vscode.TextDocument;
  readonly version: number;
  readonly sourceUri: string;
  readonly startLine: number;
  readonly selection: vscode.Selection;
  readonly viewColumn: vscode.ViewColumn;
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

/**
 * Registers the Python-file/Interactive Window actions and keeps a small cache
 * for the one notebook that is currently active. It does not poll kernels and
 * never discovers variables in an inactive notebook.
 */
export function registerPythonInteractiveCommands(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator
): PythonLiveVariableProvider {
  const provider = new PythonInteractiveCoordinator(context, coordinator);
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

class PythonInteractiveCoordinator implements PythonLiveVariableProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private activeTarget: vscode.NotebookDocument | undefined;
  private activeSource: vscode.TextDocument | undefined;
  private currentSnapshot: PythonLiveVariableSnapshot | undefined;
  private readonly variablesByHandle = new Map<string, CachedVariable>();
  private refreshRunning = false;
  private refreshAgain = false;
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

  snapshot(): PythonLiveVariableSnapshot | undefined {
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
    const origin = capturePythonCellOrigin();
    if (!origin) {
      void vscode.window.showInformationMessage("Place the cursor in a Python code cell marked # %%, then try again.");
      return;
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
    try {
      await vscode.commands.executeCommand("jupyter.runcurrentcell");
    } catch {
      void vscode.window.showWarningMessage(
        "The Jupyter extension could not run this Python cell. Check its kernel and try again."
      );
      return;
    }

    if (!isExactPythonOrigin(origin)) {
      void vscode.window.showWarningMessage(
        "The Python file changed or closed while its cell was running. Run the cell again before opening its dataframe."
      );
      return;
    }

    if (newlyExecutedCell(origin, beforeCells).kind === "missing") {
      const blankWindow = newlyOpenedBlankInteractiveWindow(beforeInteractiveWindows);
      if (blankWindow.kind === "ambiguous") {
        void vscode.window.showWarningMessage(
          "Jupyter opened more than one Interactive Window. Close the extra windows, then try again."
        );
        return;
      }
      if (blankWindow.kind === "found") {
        const restored = await selectKernelAndRestorePythonOrigin(blankWindow.notebook, origin);
        if (!restored) return;
        try {
          await vscode.commands.executeCommand("jupyter.runcurrentcell");
        } catch {
          void vscode.window.showWarningMessage(
            "The Jupyter extension could not run this Python cell after kernel selection. Check its kernel and try again."
          );
          return;
        }
        if (!isExactPythonOrigin(origin)) {
          void vscode.window.showWarningMessage(
            "The Python file changed or closed while its cell was running. Run the cell again before opening its dataframe."
          );
          return;
        }
      }
    }

    const executed = await waitForNewlyExecutedCell(origin, beforeCells);
    if (executed.kind === "stale") {
      void vscode.window.showWarningMessage(
        "The Python file changed or closed while its cell was running. Run the cell again before opening its dataframe."
      );
      return;
    }
    if (executed.kind === "ambiguous") {
      void vscode.window.showWarningMessage(
        "Open Wrangler could not identify one Interactive Window for the executed cell. Focus that window and try again."
      );
      return;
    }
    if (executed.kind === "missing") {
      void vscode.window.showWarningMessage(
        "The cell did not produce an Interactive Window execution. Check the Jupyter output and try again."
      );
      return;
    }
    if (executed.kind === "timedOut") {
      void vscode.window.showWarningMessage(
        "The Python cell did not finish within two minutes. Check the Interactive Window before trying again."
      );
      return;
    }
    if (executed.cell.executionSummary?.success === false) {
      void vscode.window.showWarningMessage(
        "The Python cell failed. Fix the error shown in the Interactive Window, then run it again."
      );
      return;
    }
    await this.discoverChooseAndOpen(executed.notebook, origin);
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
    if (!notebook || !isSupportedPythonNotebook(notebook) || !isSoleOpenNotebookDocument(notebook)) {
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
        notebook && isSupportedPythonNotebook(notebook) && isSoleOpenNotebookDocument(notebook) ? notebook : undefined
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
          const discovery = await discoverNotebookVariables(notebook);
          if (this.activeTarget !== notebook || !isSoleOpenNotebookDocument(notebook)) continue;
          this.publishDiscovery(notebook, discovery);
          if (showEmptyMessage && discovery.variables.length === 0) {
            void vscode.window.showInformationMessage(
              "No live Pandas, Polars, DuckDB, or PySpark dataframe was found in this kernel."
            );
          }
        } catch (error) {
          if (this.activeTarget !== notebook || !isSoleOpenNotebookDocument(notebook)) continue;
          this.variablesByHandle.clear();
          this.currentSnapshot = {
            state: "error",
            notebookLabel: notebookLabel(notebook),
            message:
              error instanceof NotebookVariableDiscoveryError
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

  private publishDiscovery(notebook: vscode.NotebookDocument, discovery: NotebookVariableDiscovery): void {
    this.variablesByHandle.clear();
    const variables = discovery.variables.map((descriptor): PythonLiveVariableItem => {
      const handle = randomUUID();
      const presentation = notebookVariablePresentation(descriptor.type);
      const item = {
        handle,
        label: descriptor.name,
        description: `${presentation.family} · ${presentation.kind}`,
        detail: `Live in ${notebookLabel(notebook)}`
      };
      this.variablesByHandle.set(handle, { descriptor, item });
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

  private async discoverChooseAndOpen(notebook: vscode.NotebookDocument, origin: PythonCellOrigin): Promise<void> {
    if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
      void vscode.window.showWarningMessage(
        "The Python file or Interactive Window changed before Open Wrangler could inspect it. Try again."
      );
      return;
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
      return;
    }
    if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
      void vscode.window.showWarningMessage(
        "The Python file or Interactive Window changed before Open Wrangler could open its dataframe. Try again."
      );
      return;
    }
    if (this.activeTarget === notebook) this.publishDiscovery(notebook, discovery);
    if (discovery.variables.length === 0) {
      void vscode.window.showInformationMessage(
        "No live Pandas, Polars, DuckDB, or PySpark dataframe was found. Run the cell that creates it, then try again."
      );
      return;
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
        return;
      }
      if (!choice || !items.includes(choice)) return;
      await restoreEditorGroupAfterQuickPick();
      if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
        void vscode.window.showWarningMessage(
          "The Python file or Interactive Window changed while focus returned from the picker. Try again."
        );
        return;
      }
      selected = choice.descriptor;
    }
    if (!selected) return;
    await openDiscoveredPythonNotebookVariable(this.context, this.coordinator, notebook, selected);
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
  const activeLine = editor.selection.active.line;
  let startLine = -1;
  for (let line = Math.min(activeLine, document.lineCount - 1); line >= 0; line -= 1) {
    const text = document.lineAt(line).text;
    if (!PYTHON_CELL_MARKER.test(text)) continue;
    if (MARKDOWN_CELL_MARKER.test(text)) return undefined;
    startLine = line;
    break;
  }
  if (startLine < 0) return undefined;
  return {
    editor,
    document,
    version: document.version,
    sourceUri: document.uri.toString(),
    startLine,
    selection: editor.selection,
    viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active
  };
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
      lineIndex === origin.startLine && id !== undefined && !before.ids.has(id) && !before.cells.has(cell)
        ? [{ notebook, cell }]
        : []
    )
  );
  if (candidates.length === 0) return { kind: "missing" };
  const notebooks = new Set(candidates.map(({ notebook }) => notebook));
  if (notebooks.size !== 1) return { kind: "ambiguous" };
  const latest = candidates.reduce((selected, candidate) =>
    candidate.cell.index > selected.cell.index ? candidate : selected
  );
  return { kind: "found", ...latest };
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
      notebook.cellCount === 0 &&
      isSoleOpenNotebookDocument(notebook)
  );
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length !== 1) return { kind: "ambiguous" };
  return { kind: "found", notebook: candidates[0]! };
}

async function selectKernelAndRestorePythonOrigin(
  notebook: vscode.NotebookDocument,
  origin: PythonCellOrigin
): Promise<boolean> {
  if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) return false;
  let notebookEditor: vscode.NotebookEditor;
  try {
    notebookEditor = await vscode.window.showNotebookDocument(notebook, {
      viewColumn: origin.viewColumn,
      preserveFocus: false,
      preview: false
    });
    if (notebookEditor.notebook !== notebook || !isSoleOpenNotebookDocument(notebook)) return false;
    await vscode.commands.executeCommand("notebook.selectKernel", { notebookEditor });
  } catch {
    void vscode.window.showWarningMessage("Jupyter could not select a kernel for the Interactive Window.");
    return false;
  }
  if (!isExactPythonOrigin(origin) || !isSoleOpenNotebookDocument(notebook)) {
    void vscode.window.showWarningMessage(
      "The Python file or Interactive Window changed during kernel selection. Try again."
    );
    return false;
  }
  let restored: vscode.TextEditor;
  try {
    restored = await vscode.window.showTextDocument(origin.document, {
      viewColumn: origin.viewColumn,
      preserveFocus: false,
      preview: false
    });
  } catch {
    void vscode.window.showWarningMessage("Jupyter selected a kernel, but the Python file could not be restored.");
    return false;
  }
  if (restored.document !== origin.document || !isExactPythonOrigin(origin)) {
    void vscode.window.showWarningMessage("The Python file changed while its kernel was being selected. Try again.");
    return false;
  }
  restored.selection = origin.selection;
  if (vscode.window.activeTextEditor !== restored) {
    void vscode.window.showWarningMessage("The Python file could not be focused after kernel selection. Try again.");
    return false;
  }
  return true;
}

function waitForNewlyExecutedCell(
  origin: PythonCellOrigin,
  before: PreviousInteractiveCells
): Promise<PythonExecutedCellResult> {
  const completedCandidate = (): PythonExecutedCellResult | undefined => {
    if (!isExactPythonOrigin(origin)) return { kind: "stale" };
    const candidate = newlyExecutedCell(origin, before);
    if (candidate.kind !== "found") return candidate.kind === "ambiguous" ? candidate : undefined;
    const summary = candidate.cell.executionSummary;
    if (summary?.success === undefined && summary?.timing?.endTime === undefined) return undefined;
    return candidate;
  };

  const immediate = completedCandidate();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];
    const finish = (result: PythonExecutedCellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(publicationTimeout);
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
    const publicationTimeout = setTimeout(() => {
      if (!isExactPythonOrigin(origin)) {
        finish({ kind: "stale" });
        return;
      }
      const candidate = newlyExecutedCell(origin, before);
      if (candidate.kind === "missing") finish(candidate);
      else if (candidate.kind === "ambiguous") finish(candidate);
    }, PYTHON_CELL_PUBLICATION_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      if (!isExactPythonOrigin(origin)) {
        finish({ kind: "stale" });
        return;
      }
      const candidate = newlyExecutedCell(origin, before);
      if (candidate.kind === "found") finish({ kind: "timedOut" });
      else finish(candidate);
    }, PYTHON_CELL_EXECUTION_TIMEOUT_MS);
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
