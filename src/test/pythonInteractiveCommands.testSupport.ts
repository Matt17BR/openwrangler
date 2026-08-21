import { vi } from "vitest";
import type {
  ExtensionContext,
  NotebookDocument,
  NotebookDocumentChangeEvent,
  NotebookEditor,
  TextDocument,
  TextEditor
} from "vscode";
import type { SessionCoordinator } from "../extension/sessionCoordinator";
import type { NotebookVariableDiscovery } from "../extension/notebooks/notebookVariableDiscovery";
import type { RNotebookVariableDiscovery } from "../extension/r/rNotebookVariableDiscovery";
import type { LiterateDocumentOrigin } from "../extension/literateDocumentOrigin";
import type { LiterateCodeChunk, LiterateDocumentKind } from "../extension/literateDocumentChunks";

type CommandHandler = (...args: unknown[]) => unknown;
type Listener<T> = (value: T) => unknown;

const pythonMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  commandRegistrationAttempt: 0,
  failCommandRegistrationAttempt: undefined as number | undefined,
  listenerRegistrationAttempt: 0,
  failListenerRegistrationAttempt: undefined as number | undefined,
  lastContext: undefined as ExtensionContext | undefined,
  executeCommand: vi.fn<(id: string, ...args: never[]) => Promise<unknown>>(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showQuickPick: vi.fn(async (items: readonly unknown[]) => items[0]),
  showNotebookDocument: vi.fn(),
  showTextDocument: vi.fn(),
  activeTextEditor: undefined as TextEditor | undefined,
  activeNotebookEditor: undefined as NotebookEditor | undefined,
  visibleNotebookEditors: [] as NotebookEditor[],
  isTrusted: true,
  textDocuments: [] as TextDocument[],
  notebookDocuments: [] as NotebookDocument[],
  activeTextListeners: new Set<Listener<TextEditor | undefined>>(),
  activeNotebookListeners: new Set<Listener<NotebookEditor | undefined>>(),
  visibleNotebookListeners: new Set<Listener<readonly NotebookEditor[]>>(),
  openNotebookListeners: new Set<Listener<NotebookDocument>>(),
  closeNotebookListeners: new Set<Listener<NotebookDocument>>(),
  changeNotebookListeners: new Set<Listener<NotebookDocumentChangeEvent>>(),
  discover: vi.fn<(notebook: NotebookDocument) => Promise<NotebookVariableDiscovery | RNotebookVariableDiscovery>>(),
  openVariable: vi.fn(async () => undefined),
  openRVariable: vi.fn(async () => undefined),
  restoreEditorGroupAfterQuickPick: vi.fn(async () => undefined)
}));

vi.mock("vscode", () => {
  class Uri {
    readonly path: string;
    readonly fsPath: string;
    readonly scheme: string;
    private constructor(readonly value: string) {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/[^/?#]*)?([^?#]*)/u.exec(value);
      this.scheme = match?.[1] ?? "file";
      this.path = match?.[2] ?? value;
      this.fsPath = this.path;
    }
    static parse(value: string): Uri {
      return new Uri(value);
    }
    static file(path: string): Uri {
      return new Uri(`file://${path}`);
    }
    toString(): string {
      return this.value;
    }
  }
  class EventEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();
    readonly event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  const subscribe =
    <T>(listeners: Set<Listener<T>>) =>
    (listener: Listener<T>) => {
      pythonMocks.listenerRegistrationAttempt += 1;
      if (pythonMocks.listenerRegistrationAttempt === pythonMocks.failListenerRegistrationAttempt) {
        throw new Error("Python listener registration failed");
      }
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    };
  return {
    Uri,
    EventEmitter,
    NotebookCellKind: { Markup: 1, Code: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    commands: {
      registerCommand: (id: string, handler: CommandHandler) => {
        pythonMocks.commandRegistrationAttempt += 1;
        if (pythonMocks.commandRegistrationAttempt === pythonMocks.failCommandRegistrationAttempt) {
          throw new Error(`Python registration failed at ${id}`);
        }
        pythonMocks.commands.set(id, handler);
        return { dispose: () => pythonMocks.commands.delete(id) };
      },
      executeCommand: pythonMocks.executeCommand
    },
    window: {
      get activeTextEditor() {
        return pythonMocks.activeTextEditor;
      },
      get activeNotebookEditor() {
        return pythonMocks.activeNotebookEditor;
      },
      get visibleNotebookEditors() {
        return pythonMocks.visibleNotebookEditors;
      },
      onDidChangeActiveTextEditor: subscribe(pythonMocks.activeTextListeners),
      onDidChangeActiveNotebookEditor: subscribe(pythonMocks.activeNotebookListeners),
      onDidChangeVisibleNotebookEditors: subscribe(pythonMocks.visibleNotebookListeners),
      showInformationMessage: pythonMocks.showInformationMessage,
      showWarningMessage: pythonMocks.showWarningMessage,
      showQuickPick: pythonMocks.showQuickPick,
      showNotebookDocument: pythonMocks.showNotebookDocument,
      showTextDocument: pythonMocks.showTextDocument
    },
    workspace: {
      get isTrusted() {
        return pythonMocks.isTrusted;
      },
      get textDocuments() {
        return pythonMocks.textDocuments;
      },
      get notebookDocuments() {
        return pythonMocks.notebookDocuments;
      },
      onDidOpenNotebookDocument: subscribe(pythonMocks.openNotebookListeners),
      onDidCloseNotebookDocument: subscribe(pythonMocks.closeNotebookListeners),
      onDidChangeNotebookDocument: subscribe(pythonMocks.changeNotebookListeners)
    }
  };
});

vi.mock("../extension/notebooks/notebookVariableDiscovery", async () => {
  const actual = await vi.importActual<typeof import("../extension/notebooks/notebookVariableDiscovery")>(
    "../extension/notebooks/notebookVariableDiscovery"
  );
  return {
    ...actual,
    discoverNotebookVariables: pythonMocks.discover
  };
});

vi.mock("../extension/notebooks/jupyterBridge", () => ({
  discoverVariablesForSelectedKernel: pythonMocks.discover,
  isRNotebookVariableDiscovery: (discovery: NotebookVariableDiscovery | RNotebookVariableDiscovery) =>
    discovery.variables.length > 0 && discovery.variables.every((variable) => "dataframeFlavor" in variable),
  openDiscoveredPythonNotebookVariable: pythonMocks.openVariable,
  openDiscoveredRNotebookVariable: pythonMocks.openRVariable
}));

vi.mock("../extension/webviewPanel", () => ({
  restoreEditorGroupAfterQuickPick: pythonMocks.restoreEditorGroupAfterQuickPick
}));

import * as vscode from "vscode";
import {
  registerPythonInteractiveCommands,
  type LiteratePythonVariableProvider,
  type PythonInteractiveCommandProvider,
  type NotebookLiveVariableProvider
} from "../extension/notebooks/pythonInteractiveCommands";

export interface PythonInteractiveTestContext {
  readonly context: ExtensionContext;
  readonly provider: NotebookLiveVariableProvider;
  readonly coordinator: SessionCoordinator;
}

export function pythonInteractiveMocks(): typeof pythonMocks {
  return pythonMocks;
}

export function vscodeApi(): typeof vscode {
  return vscode;
}

export function setupPythonInteractiveTest(
  failCommandRegistrationAttempt?: number,
  failListenerRegistrationAttempt?: number
): PythonInteractiveTestContext {
  for (const listenerSet of [
    pythonMocks.activeTextListeners,
    pythonMocks.activeNotebookListeners,
    pythonMocks.visibleNotebookListeners,
    pythonMocks.openNotebookListeners,
    pythonMocks.closeNotebookListeners,
    pythonMocks.changeNotebookListeners
  ]) {
    listenerSet.clear();
  }
  pythonMocks.commands.clear();
  pythonMocks.commandRegistrationAttempt = 0;
  pythonMocks.failCommandRegistrationAttempt = failCommandRegistrationAttempt;
  pythonMocks.listenerRegistrationAttempt = 0;
  pythonMocks.failListenerRegistrationAttempt = failListenerRegistrationAttempt;
  pythonMocks.textDocuments.length = 0;
  pythonMocks.notebookDocuments.length = 0;
  pythonMocks.activeTextEditor = undefined;
  pythonMocks.activeNotebookEditor = undefined;
  pythonMocks.visibleNotebookEditors.length = 0;
  pythonMocks.isTrusted = true;
  pythonMocks.executeCommand.mockReset();
  pythonMocks.executeCommand.mockResolvedValue(undefined);
  pythonMocks.showInformationMessage.mockClear();
  pythonMocks.showWarningMessage.mockClear();
  pythonMocks.showQuickPick.mockReset();
  pythonMocks.showQuickPick.mockImplementation(async (items: readonly unknown[]) => items[0]);
  pythonMocks.showNotebookDocument.mockReset();
  pythonMocks.showNotebookDocument.mockImplementation(async (notebookDocument: NotebookDocument) => {
    const editor = { notebook: notebookDocument } as NotebookEditor;
    pythonMocks.activeNotebookEditor = editor;
    pythonMocks.activeTextEditor = undefined;
    pythonMocks.visibleNotebookEditors.splice(0, pythonMocks.visibleNotebookEditors.length, editor);
    return editor;
  });
  pythonMocks.showTextDocument.mockReset();
  pythonMocks.showTextDocument.mockImplementation(async (document: TextDocument) => {
    const editor = textEditor(document, 0);
    pythonMocks.activeTextEditor = editor;
    pythonMocks.activeNotebookEditor = undefined;
    return editor;
  });
  pythonMocks.discover.mockReset();
  pythonMocks.discover.mockResolvedValue({ variables: [], truncated: false });
  pythonMocks.openVariable.mockClear();
  pythonMocks.openRVariable.mockClear();
  pythonMocks.restoreEditorGroupAfterQuickPick.mockReset();
  pythonMocks.restoreEditorGroupAfterQuickPick.mockResolvedValue(undefined);
  const coordinator = {} as SessionCoordinator;
  const context = { subscriptions: [], extensionPath: "/extension" } as unknown as ExtensionContext;
  pythonMocks.lastContext = context;
  const provider = registerPythonInteractiveCommands(context, coordinator);
  return { context, provider, coordinator };
}

export function command(id: string): CommandHandler {
  const handler = pythonMocks.commands.get(id);
  if (!handler) throw new Error(`Missing command ${id}`);
  return handler;
}

export function literateProvider(value: NotebookLiveVariableProvider): LiteratePythonVariableProvider {
  return value as NotebookLiveVariableProvider & LiteratePythonVariableProvider;
}

export function diagnosticProvider(value: NotebookLiveVariableProvider): PythonInteractiveCommandProvider {
  return value as PythonInteractiveCommandProvider;
}

export function literateOrigin(
  editor: TextEditor,
  kind: LiterateDocumentKind,
  chunk: LiterateCodeChunk | undefined,
  pythonExecutionOwner: LiterateDocumentOrigin["pythonExecutionOwner"] = "jupyter"
): LiterateDocumentOrigin {
  const document = editor.document;
  return Object.freeze({
    editor,
    document,
    version: document.version,
    uri: document.uri.toString(),
    kind,
    pythonExecutionOwner,
    viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active,
    selections: Object.freeze(
      editor.selections.map((selected) =>
        Object.freeze({
          anchor: Object.freeze({ line: selected.anchor.line, character: selected.anchor.character }),
          active: Object.freeze({ line: selected.active.line, character: selected.active.character })
        })
      )
    ),
    ...(chunk ? { chunk: Object.freeze(chunk) } : {})
  });
}

export function fire<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of listeners) listener(value);
}

export function publishVisibleNotebookEditor(notebookDocument: NotebookDocument): NotebookEditor {
  const editor = { notebook: notebookDocument } as NotebookEditor;
  pythonMocks.activeNotebookEditor = editor;
  pythonMocks.activeTextEditor = undefined;
  pythonMocks.visibleNotebookEditors.push(editor);
  fire(pythonMocks.visibleNotebookListeners, pythonMocks.visibleNotebookEditors);
  return editor;
}

export function notebookListenerCounts(): {
  readonly visible: number;
  readonly open: number;
  readonly change: number;
  readonly close: number;
} {
  return {
    visible: pythonMocks.visibleNotebookListeners.size,
    open: pythonMocks.openNotebookListeners.size,
    change: pythonMocks.changeNotebookListeners.size,
    close: pythonMocks.closeNotebookListeners.size
  };
}

export async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export function textDocument(uri: string, text: string, languageId = "python"): TextDocument & { isClosed: boolean } {
  const lines = text.split("\n");
  return {
    uri: vscode.Uri.parse(uri),
    languageId,
    version: 1,
    isClosed: false,
    lineCount: lines.length,
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] ?? "" })
  } as unknown as TextDocument & { isClosed: boolean };
}

export function textEditor(document: TextDocument, line: number): TextEditor {
  const selected = selection(line, line);
  return {
    document,
    selection: selected,
    selections: [selected],
    viewColumn: vscode.ViewColumn.One
  } as unknown as TextEditor;
}

export function selection(anchorLine: number, activeLine: number): TextEditor["selection"] {
  return {
    anchor: { line: anchorLine, character: 0 },
    active: { line: activeLine, character: 0 },
    start: { line: Math.min(anchorLine, activeLine), character: 0 },
    end: { line: Math.max(anchorLine, activeLine), character: 0 }
  } as TextEditor["selection"];
}

export function notebook(
  uri: string,
  notebookType: string,
  initialCells: Array<ReturnType<typeof interactiveCell>>,
  language?: string
): { document: NotebookDocument; cells: Array<ReturnType<typeof interactiveCell>> } {
  const cells = initialCells;
  const document = {
    uri: vscode.Uri.parse(uri),
    notebookType,
    metadata: language ? { kernelspec: { language } } : {},
    isClosed: false,
    getCells: () => cells,
    get cellCount() {
      return cells.length;
    }
  } as unknown as NotebookDocument;
  return { document, cells };
}

export function interactiveCell(
  notebookDocument: NotebookDocument,
  sourceUri: string,
  lineIndex: number,
  id: string | undefined,
  success: boolean,
  languageId = "python"
) {
  const metadata = {
    interactive: { uristring: sourceUri, lineIndex, originalSource: "" },
    ...(id === undefined ? {} : { id })
  };
  return {
    index: notebookDocument.cellCount,
    notebook: notebookDocument,
    kind: vscode.NotebookCellKind.Code,
    document: { languageId },
    metadata,
    executionSummary: { success, timing: { startTime: 1, endTime: 2 } }
  } as unknown as vscode.NotebookCell;
}

export function markupCell(
  notebookDocument: NotebookDocument,
  metadata: Readonly<Record<string, unknown>> = {}
): vscode.NotebookCell {
  return {
    index: notebookDocument.cellCount,
    notebook: notebookDocument,
    kind: vscode.NotebookCellKind.Markup,
    document: { languageId: "markdown" },
    metadata,
    executionSummary: undefined
  } as unknown as vscode.NotebookCell;
}

export function unrelatedCodeCell(notebookDocument: NotebookDocument): vscode.NotebookCell {
  return {
    index: notebookDocument.cellCount,
    notebook: notebookDocument,
    kind: vscode.NotebookCellKind.Code,
    document: { languageId: "python" },
    metadata: {},
    executionSummary: undefined
  } as unknown as vscode.NotebookCell;
}

export function pandasFrame(name: string) {
  return { name, type: "pandas.DataFrame", backend: "pandas" } as const;
}

export function polarsFrame(name: string) {
  return { name, type: "polars.dataframe.frame.DataFrame", backend: "polars" } as const;
}
