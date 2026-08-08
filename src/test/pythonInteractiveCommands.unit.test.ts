import { beforeEach, describe, expect, it, vi } from "vitest";
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

type CommandHandler = (...args: unknown[]) => unknown;
type Listener<T> = (value: T) => unknown;

const pythonMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async (_id: string) => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showQuickPick: vi.fn(async (items: readonly unknown[]) => items[0]),
  activeTextEditor: undefined as TextEditor | undefined,
  activeNotebookEditor: undefined as NotebookEditor | undefined,
  textDocuments: [] as TextDocument[],
  notebookDocuments: [] as NotebookDocument[],
  activeTextListeners: new Set<Listener<TextEditor | undefined>>(),
  activeNotebookListeners: new Set<Listener<NotebookEditor | undefined>>(),
  openNotebookListeners: new Set<Listener<NotebookDocument>>(),
  closeNotebookListeners: new Set<Listener<NotebookDocument>>(),
  changeNotebookListeners: new Set<Listener<NotebookDocumentChangeEvent>>(),
  discover: vi.fn<(notebook: NotebookDocument) => Promise<NotebookVariableDiscovery>>(),
  openVariable: vi.fn(async () => undefined)
}));

vi.mock("vscode", () => {
  class Uri {
    readonly path: string;
    readonly scheme: string;
    private constructor(readonly value: string) {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/[^/?#]*)?([^?#]*)/u.exec(value);
      this.scheme = match?.[1] ?? "file";
      this.path = match?.[2] ?? value;
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
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    };
  return {
    Uri,
    EventEmitter,
    NotebookCellKind: { Markup: 1, Code: 2 },
    commands: {
      registerCommand: (id: string, handler: CommandHandler) => {
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
      onDidChangeActiveTextEditor: subscribe(pythonMocks.activeTextListeners),
      onDidChangeActiveNotebookEditor: subscribe(pythonMocks.activeNotebookListeners),
      showInformationMessage: pythonMocks.showInformationMessage,
      showWarningMessage: pythonMocks.showWarningMessage,
      showQuickPick: pythonMocks.showQuickPick
    },
    workspace: {
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
  openDiscoveredPythonNotebookVariable: pythonMocks.openVariable
}));

import * as vscode from "vscode";
import {
  registerPythonInteractiveCommands,
  type PythonLiveVariableProvider
} from "../extension/notebooks/pythonInteractiveCommands";

describe("Python Interactive Window entry points", () => {
  let context: ExtensionContext;
  let provider: PythonLiveVariableProvider;
  const coordinator = {} as SessionCoordinator;

  beforeEach(() => {
    for (const listenerSet of [
      pythonMocks.activeTextListeners,
      pythonMocks.activeNotebookListeners,
      pythonMocks.openNotebookListeners,
      pythonMocks.closeNotebookListeners,
      pythonMocks.changeNotebookListeners
    ]) {
      listenerSet.clear();
    }
    pythonMocks.commands.clear();
    pythonMocks.textDocuments.length = 0;
    pythonMocks.notebookDocuments.length = 0;
    pythonMocks.activeTextEditor = undefined;
    pythonMocks.activeNotebookEditor = undefined;
    pythonMocks.executeCommand.mockReset();
    pythonMocks.executeCommand.mockResolvedValue(undefined);
    pythonMocks.showInformationMessage.mockClear();
    pythonMocks.showWarningMessage.mockClear();
    pythonMocks.showQuickPick.mockReset();
    pythonMocks.showQuickPick.mockImplementation(async (items: readonly unknown[]) => items[0]);
    pythonMocks.discover.mockReset();
    pythonMocks.discover.mockResolvedValue({ variables: [], truncated: false });
    pythonMocks.openVariable.mockClear();
    context = { subscriptions: [], extensionPath: "/extension" } as unknown as ExtensionContext;
    provider = registerPythonInteractiveCommands(context, coordinator);
  });

  it("runs only the current # %% cell and binds the exact resulting Interactive Window", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    fire(pythonMocks.activeTextListeners, pythonMocks.activeTextEditor);

    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id !== "jupyter.runcurrentcell") return undefined;
      interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true));
      pythonMocks.notebookDocuments.push(interactive.document);
      return undefined;
    });
    const frame = pandasFrame("frame");
    pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.executeCommand).toHaveBeenCalledWith("jupyter.runcurrentcell");
    expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("jupyter.runFileInteractive");
    expect(pythonMocks.discover).toHaveBeenCalledWith(interactive.document);
    expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
    expect(pythonMocks.showQuickPick).not.toHaveBeenCalled();
  });

  it("reruns the current cell in its associated window before offering live dataframes", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nfirst = make_frame()\n");
    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "old", true));
    pythonMocks.textDocuments.push(source);
    pythonMocks.notebookDocuments.push(interactive.document);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    fire(pythonMocks.activeTextListeners, pythonMocks.activeTextEditor);
    const first = pandasFrame("first");
    const second = polarsFrame("second");
    pythonMocks.discover.mockResolvedValue({ variables: [first, second], truncated: false });
    pythonMocks.showQuickPick.mockImplementation(async (items: readonly unknown[]) => items[1]);
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "rerun", true));
      }
      return undefined;
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.executeCommand).toHaveBeenCalledWith("jupyter.runcurrentcell");
    expect(pythonMocks.showQuickPick).toHaveBeenCalledOnce();
    expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, second);
  });

  it("does not choose when one cell execution appears in duplicate Interactive Windows", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    const interactiveWindows: ReturnType<typeof notebook>[] = [];
    for (const suffix of ["1", "2"]) {
      const interactive = notebook(`untitled:/Interactive-${suffix}.interactive`, "interactive", []);
      interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, suffix, true));
      pythonMocks.notebookDocuments.push(interactive.document);
      interactiveWindows.push(interactive);
    }
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        for (const [index, interactive] of interactiveWindows.entries()) {
          interactive.cells.push(
            interactiveCell(interactive.document, source.uri.toString(), 0, `new-${index}`, true)
          );
        }
      }
      return undefined;
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.executeCommand).toHaveBeenCalledWith("jupyter.runcurrentcell");
    expect(pythonMocks.discover).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("identify one Interactive Window"));
  });

  it("does not retarget after the originating Python document closes during execution", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        source.isClosed = true;
        pythonMocks.textDocuments.length = 0;
      }
      return undefined;
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.discover).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("changed or closed"));
  });

  it("reports a failed cell instead of discovering variables", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nraise RuntimeError()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "failed", false));
        pythonMocks.notebookDocuments.push(interactive.document);
      }
      return undefined;
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.discover).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("cell failed"));
  });

  it("refreshes only the exact active notebook and exposes cached variables without polling", async () => {
    const active = notebook("file:///workspace/active.ipynb", "jupyter-notebook", [], "python");
    const inactive = notebook("file:///workspace/inactive.ipynb", "jupyter-notebook", [], "python");
    pythonMocks.notebookDocuments.push(active.document, inactive.document);
    pythonMocks.activeNotebookEditor = { notebook: active.document } as NotebookEditor;
    const frame = pandasFrame("frame");
    pythonMocks.discover.mockImplementation(async (document) => ({
      variables: document === active.document ? [frame] : [],
      truncated: false
    }));

    fire(pythonMocks.activeNotebookListeners, pythonMocks.activeNotebookEditor);
    await settle();

    expect(pythonMocks.discover).toHaveBeenCalledWith(active.document);
    expect(pythonMocks.discover).not.toHaveBeenCalledWith(inactive.document);
    const snapshot = provider.snapshot();
    expect(snapshot?.state).toBe("ready");
    expect(snapshot?.variables.map((variable) => variable.label)).toEqual(["frame"]);

    const callsBeforeExecution = pythonMocks.discover.mock.calls.length;
    fire(pythonMocks.changeNotebookListeners, {
      notebook: inactive.document,
      cellChanges: [{ executionSummary: { success: true } }],
      contentChanges: []
    } as unknown as NotebookDocumentChangeEvent);
    await settle();
    expect(pythonMocks.discover).toHaveBeenCalledTimes(callsBeforeExecution);

    const handle = snapshot?.variables[0]?.handle;
    await command("openWrangler.openCachedNotebookVariable")(handle);
    expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, active.document, frame);
  });

  it("does not lose the active notebook when VS Code also reports its focused cell text editor", async () => {
    const active = notebook("file:///workspace/active.ipynb", "jupyter-notebook", [], "python");
    pythonMocks.notebookDocuments.push(active.document);
    pythonMocks.activeNotebookEditor = { notebook: active.document } as NotebookEditor;
    pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("frame")], truncated: false });
    fire(pythonMocks.activeNotebookListeners, pythonMocks.activeNotebookEditor);

    const notebookCellDocument = {
      uri: vscode.Uri.parse("vscode-notebook-cell:///workspace/active.ipynb#cell-1"),
      languageId: "python",
      isClosed: false
    } as TextDocument;
    pythonMocks.activeTextEditor = textEditor(notebookCellDocument, 0);
    fire(pythonMocks.activeTextListeners, pythonMocks.activeTextEditor);
    await settle();

    expect(provider.snapshot()?.notebookLabel).toBe("active.ipynb");
    expect(provider.snapshot()?.variables.map((variable) => variable.label)).toEqual(["frame"]);
  });

  it("refreshes the active notebook after a completed cell execution", async () => {
    const active = notebook("file:///workspace/active.ipynb", "jupyter-notebook", [], "python");
    pythonMocks.notebookDocuments.push(active.document);
    pythonMocks.activeNotebookEditor = { notebook: active.document } as NotebookEditor;
    pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("frame")], truncated: false });
    fire(pythonMocks.activeNotebookListeners, pythonMocks.activeNotebookEditor);
    await settle();
    const initialCalls = pythonMocks.discover.mock.calls.length;

    fire(pythonMocks.changeNotebookListeners, {
      notebook: active.document,
      cellChanges: [{ executionSummary: { success: true, timing: { startTime: 1, endTime: 2 } } }],
      contentChanges: []
    } as unknown as NotebookDocumentChangeEvent);
    await settle();

    expect(pythonMocks.discover.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it("shows a concise empty result", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nvalue = 1\n");
    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "old", true));
    pythonMocks.textDocuments.push(source);
    pythonMocks.notebookDocuments.push(interactive.document);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    pythonMocks.discover.mockResolvedValue({ variables: [], truncated: false });
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "rerun", true));
      }
      return undefined;
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("No live Pandas"));
  });
});

function command(id: string): CommandHandler {
  const handler = pythonMocks.commands.get(id);
  if (!handler) throw new Error(`Missing command ${id}`);
  return handler;
}

function fire<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of listeners) listener(value);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function textDocument(uri: string, text: string): TextDocument & { isClosed: boolean } {
  const lines = text.split("\n");
  return {
    uri: vscode.Uri.parse(uri),
    languageId: "python",
    version: 1,
    isClosed: false,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? "" })
  } as unknown as TextDocument & { isClosed: boolean };
}

function textEditor(document: TextDocument, line: number): TextEditor {
  return {
    document,
    selection: { active: { line }, start: { line } }
  } as unknown as TextEditor;
}

function notebook(
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

function interactiveCell(
  notebookDocument: NotebookDocument,
  sourceUri: string,
  lineIndex: number,
  id: string,
  success: boolean
) {
  return {
    index: notebookDocument.cellCount,
    notebook: notebookDocument,
    kind: vscode.NotebookCellKind.Code,
    document: { languageId: "python" },
    metadata: { interactive: { uristring: sourceUri, lineIndex, originalSource: "" }, id },
    executionSummary: { success, timing: { startTime: 1, endTime: 2 } }
  } as unknown as vscode.NotebookCell;
}

function pandasFrame(name: string) {
  return { name, type: "pandas.DataFrame", backend: "pandas" } as const;
}

function polarsFrame(name: string) {
  return { name, type: "polars.dataframe.frame.DataFrame", backend: "polars" } as const;
}
