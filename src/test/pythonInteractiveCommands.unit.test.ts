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
import type { RNotebookVariableDiscovery } from "../extension/r/rNotebookVariableDiscovery";

type CommandHandler = (...args: unknown[]) => unknown;
type Listener<T> = (value: T) => unknown;

const pythonMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async (_id: string) => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showQuickPick: vi.fn(async (items: readonly unknown[]) => items[0]),
  showNotebookDocument: vi.fn(),
  showTextDocument: vi.fn(),
  activeTextEditor: undefined as TextEditor | undefined,
  activeNotebookEditor: undefined as NotebookEditor | undefined,
  isTrusted: true,
  textDocuments: [] as TextDocument[],
  notebookDocuments: [] as NotebookDocument[],
  activeTextListeners: new Set<Listener<TextEditor | undefined>>(),
  activeNotebookListeners: new Set<Listener<NotebookEditor | undefined>>(),
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
    ViewColumn: { Active: -1, One: 1 },
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
  type NotebookLiveVariableProvider
} from "../extension/notebooks/pythonInteractiveCommands";

describe("Python Interactive Window entry points", () => {
  let context: ExtensionContext;
  let provider: NotebookLiveVariableProvider;
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

  it("waits for Jupyter to publish and finish the Interactive Window cell", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    fire(pythonMocks.activeTextListeners, pythonMocks.activeTextEditor);

    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    pythonMocks.executeCommand.mockResolvedValue(undefined);
    const frame = polarsFrame("frame");
    pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });

    const opening = command("openWrangler.runPythonCellAndOpenVariable")();
    await settle();
    expect(pythonMocks.discover).not.toHaveBeenCalled();

    const cell = interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true);
    Object.defineProperty(cell, "executionSummary", { value: undefined, writable: true });
    interactive.cells.push(cell);
    pythonMocks.notebookDocuments.push(interactive.document);
    fire(pythonMocks.openNotebookListeners, interactive.document);
    await settle();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    const discoveryCallsBeforeCompletion = pythonMocks.discover.mock.calls.length;

    Object.defineProperty(cell, "executionSummary", {
      value: { success: true, timing: { startTime: 1, endTime: 2 } },
      writable: true
    });
    fire(pythonMocks.changeNotebookListeners, {
      notebook: interactive.document,
      cellChanges: [{ cell, executionSummary: cell.executionSummary }],
      contentChanges: []
    } as unknown as NotebookDocumentChangeEvent);
    await opening;

    expect(pythonMocks.discover.mock.calls.length).toBeGreaterThan(discoveryCallsBeforeCompletion);
    expect(pythonMocks.discover).toHaveBeenCalledWith(interactive.document);
    expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
  });

  it("stops when another matching cell appears before the pinned execution finishes", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    const first = interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true);
    Object.defineProperty(first, "executionSummary", { value: undefined, writable: true });
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        interactive.cells.push(first);
        pythonMocks.notebookDocuments.push(interactive.document);
      }
      return undefined;
    });

    const opening = command("openWrangler.runPythonCellAndOpenVariable")();
    await settle();
    expect(pythonMocks.discover).not.toHaveBeenCalled();
    const second = interactiveCell(interactive.document, source.uri.toString(), 0, "run-2", true);
    interactive.cells.push(second);
    fire(pythonMocks.changeNotebookListeners, {
      notebook: interactive.document,
      cellChanges: [{ cell: second, executionSummary: second.executionSummary }],
      contentChanges: []
    } as unknown as NotebookDocumentChangeEvent);
    await opening;

    expect(pythonMocks.discover).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("more than one matching cell"));
  });

  it("stops when Jupyter retargets the pinned cell metadata during execution", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    const cell = interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true);
    Object.defineProperty(cell, "executionSummary", { value: undefined, writable: true });
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        interactive.cells.push(cell);
        pythonMocks.notebookDocuments.push(interactive.document);
      }
      return undefined;
    });

    const opening = command("openWrangler.runPythonCellAndOpenVariable")();
    await settle();
    Object.defineProperty(cell, "metadata", {
      value: { interactive: { uristring: "file:///workspace/other.py", lineIndex: 0 }, id: "run-1" }
    });
    fire(pythonMocks.changeNotebookListeners, {
      notebook: interactive.document,
      cellChanges: [{ cell }],
      contentChanges: []
    } as unknown as NotebookDocumentChangeEvent);
    await opening;

    expect(pythonMocks.discover).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("did not produce an Interactive Window execution")
    );
  });

  it("selects a kernel once and retries when Jupyter creates a blank Interactive Window", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      const sourceEditor = textEditor(source, 1);
      pythonMocks.activeTextEditor = sourceEditor;
      fire(pythonMocks.activeTextListeners, sourceEditor);

      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      const frame = polarsFrame("frame");
      pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });
      let runCount = 0;
      pythonMocks.executeCommand.mockImplementation(async (id: string) => {
        if (id === "notebook.selectKernel") {
          sourceEditor.selection = selection(77, 79);
          return undefined;
        }
        if (id === "jupyter.runcurrentcell") {
          runCount += 1;
          if (runCount === 1) {
            pythonMocks.notebookDocuments.push(interactive.document);
            fire(pythonMocks.openNotebookListeners, interactive.document);
          } else {
            expect(pythonMocks.activeTextEditor?.document).toBe(source);
            expect(pythonMocks.activeTextEditor?.selection.anchor.line).toBe(1);
            expect(pythonMocks.activeTextEditor?.selection.active.line).toBe(1);
            const cell = interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true);
            interactive.cells.push(cell);
            fire(pythonMocks.changeNotebookListeners, {
              notebook: interactive.document,
              cellChanges: [{ cell, executionSummary: cell.executionSummary }],
              contentChanges: []
            } as unknown as NotebookDocumentChangeEvent);
          }
        }
        return Promise.resolve(undefined);
      });
      const restoredEditor = textEditor(source, 99);
      pythonMocks.showTextDocument.mockImplementation(async (document: TextDocument) => {
        expect(document).toBe(source);
        pythonMocks.activeTextEditor = restoredEditor;
        pythonMocks.activeNotebookEditor = undefined;
        return restoredEditor;
      });
      const listenerCounts = notebookListenerCounts();

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
      await vi.advanceTimersByTimeAsync(10_000);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel",
        "jupyter.runcurrentcell"
      ]);
      expect(pythonMocks.showNotebookDocument).toHaveBeenCalledWith(interactive.document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
      });
      expect(restoredEditor.selection.anchor.line).toBe(1);
      expect(restoredEditor.selection.active.line).toBe(1);
      expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
      expect(vi.getTimerCount()).toBe(0);
      expect(notebookListenerCounts()).toEqual(listenerCounts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats Jupyter's markup-only Interactive Window as blank for kernel selection", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      const sourceEditor = textEditor(source, 1);
      pythonMocks.activeTextEditor = sourceEditor;
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      interactive.cells.push(markupCell(interactive.document));
      const frame = polarsFrame("frame");
      pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });
      let runCount = 0;
      pythonMocks.executeCommand.mockImplementation(async (id: string) => {
        if (id === "jupyter.runcurrentcell") {
          runCount += 1;
          if (runCount === 1) {
            pythonMocks.notebookDocuments.push(interactive.document);
            fire(pythonMocks.openNotebookListeners, interactive.document);
          } else {
            const cell = interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true);
            interactive.cells.push(cell);
            fire(pythonMocks.changeNotebookListeners, {
              notebook: interactive.document,
              cellChanges: [{ cell, executionSummary: cell.executionSummary }],
              contentChanges: []
            } as unknown as NotebookDocumentChangeEvent);
          }
        }
        return undefined;
      });
      const restoredEditor = textEditor(source, 1);
      pythonMocks.showTextDocument.mockImplementation(async () => {
        pythonMocks.activeTextEditor = restoredEditor;
        pythonMocks.activeNotebookEditor = undefined;
        return restoredEditor;
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel",
        "jupyter.runcurrentcell"
      ]);
      expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat an Interactive Window with an unrelated code cell as blank", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      interactive.cells.push(unrelatedCodeCell(interactive.document));
      pythonMocks.executeCommand.mockImplementation(async (id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
        }
        return undefined;
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("did not produce an Interactive Window execution")
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["more than Jupyter's single placeholder", "interactive", undefined, 2],
    ["R notebook metadata", "interactive", "r", 1],
    ["a regular Jupyter notebook", "jupyter-notebook", undefined, 1]
  ])(
    "does not treat a markup-only Interactive Window with %s as blank",
    async (_label, notebookType, language, cellCount) => {
      vi.useFakeTimers();
      try {
        const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
        pythonMocks.textDocuments.push(source);
        pythonMocks.activeTextEditor = textEditor(source, 1);
        const interactive = notebook("untitled:/Interactive-1.interactive", notebookType, [], language);
        for (let index = 0; index < cellCount; index += 1) {
          interactive.cells.push(markupCell(interactive.document));
        }
        pythonMocks.executeCommand.mockImplementation(async (id: string) => {
          if (id === "jupyter.runcurrentcell") {
            pythonMocks.notebookDocuments.push(interactive.document);
            fire(pythonMocks.openNotebookListeners, interactive.document);
          }
          return undefined;
        });

        const opening = command("openWrangler.runPythonCellAndOpenVariable")();
        await settle();
        await vi.advanceTimersByTimeAsync(10_000);
        await opening;

        expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
        expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
        expect(pythonMocks.openVariable).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("does not retry when the first cell appears after its blank Interactive Window", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      const frame = pandasFrame("frame");
      pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });
      pythonMocks.executeCommand.mockImplementation(async (id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
        }
        return Promise.resolve(undefined);
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      expect(pythonMocks.executeCommand).toHaveBeenCalledTimes(1);
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());

      await vi.advanceTimersByTimeAsync(9_999);
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
      const cell = interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true);
      interactive.cells.push(cell);
      fire(pythonMocks.changeNotebookListeners, {
        notebook: interactive.document,
        cellChanges: [{ cell, executionSummary: cell.executionSummary }],
        contentChanges: []
      } as unknown as NotebookDocumentChangeEvent);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retarget kernel recovery when Jupyter replaces its blank Interactive Window", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const first = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      const replacement = notebook("untitled:/Interactive-2.interactive", "interactive", []);
      pythonMocks.executeCommand.mockImplementation(async (id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(first.document);
          fire(pythonMocks.openNotebookListeners, first.document);
        }
        return undefined;
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(5_000);
      Object.defineProperty(first.document, "isClosed", { value: true });
      pythonMocks.notebookDocuments.splice(0, 1, replacement.document);
      fire(pythonMocks.closeNotebookListeners, first.document);
      fire(pythonMocks.openNotebookListeners, replacement.document);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("changed the Interactive Window")
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an exact cell that appears while the first Jupyter command is still pending", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      const frame = pandasFrame("frame");
      pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          return new Promise(() => undefined);
        }
        return Promise.resolve(undefined);
      });
      const listenerCounts = notebookListenerCounts();

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      const cell = interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true);
      interactive.cells.push(cell);
      fire(pythonMocks.changeNotebookListeners, {
        notebook: interactive.document,
        cellChanges: [{ cell, executionSummary: cell.executionSummary }],
        contentChanges: []
      } as unknown as NotebookDocumentChangeEvent);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
      expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
      expect(vi.getTimerCount()).toBe(0);
      expect(notebookListenerCounts()).toEqual(listenerCounts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a newly published exact Interactive Window cell without a private metadata id", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    const frame = pandasFrame("frame");
    pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, undefined, true));
        pythonMocks.notebookDocuments.push(interactive.document);
      }
      return undefined;
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
  });

  it("does not retry an indeterminate Jupyter dispatch that never settles", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          return new Promise(() => undefined);
        }
        return Promise.resolve(undefined);
      });
      const listenerCounts = notebookListenerCounts();

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("didn't confirm"));
      expect(vi.getTimerCount()).toBe(0);
      expect(notebookListenerCounts()).toEqual(listenerCounts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run a third time when the post-kernel retry remains pending", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      let runCount = 0;
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id !== "jupyter.runcurrentcell") return Promise.resolve(undefined);
        runCount += 1;
        if (runCount === 1) {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          return Promise.resolve(undefined);
        }
        return new Promise(() => undefined);
      });
      pythonMocks.showTextDocument.mockImplementation(async (document: TextDocument) => {
        const restored = textEditor(document, 1);
        pythonMocks.activeTextEditor = restored;
        pythonMocks.activeNotebookEditor = undefined;
        return restored;
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel",
        "jupyter.runcurrentcell"
      ]);
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("didn't confirm"));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled kernel picker without retrying the cell", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          return Promise.resolve(undefined);
        }
        if (id === "notebook.selectKernel") return new Promise(() => undefined);
        return Promise.resolve(undefined);
      });
      const listenerCounts = notebookListenerCounts();

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel"
      ]);
      await vi.advanceTimersByTimeAsync(109_999);
      expect(pythonMocks.showWarningMessage).not.toHaveBeenCalledWith("Kernel selection did not finish in time.");
      await vi.advanceTimersByTimeAsync(1);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel"
      ]);
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith("Kernel selection did not finish in time.");
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(notebookListenerCounts()).toEqual(listenerCounts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry when Jupyter rejects a dispatched cell", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    pythonMocks.executeCommand.mockRejectedValueOnce(new Error("Jupyter rejected the command"));

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("didn't confirm"));
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
  });

  it("rejects two new exact cells instead of guessing which execution to use", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        interactive.cells.push(
          interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true),
          interactiveCell(interactive.document, source.uri.toString(), 0, "run-2", true)
        );
        pythonMocks.notebookDocuments.push(interactive.document);
      }
      return undefined;
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("more than one matching cell"));
  });

  it("serializes repeated Python editor actions", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      pythonMocks.executeCommand.mockImplementation((id: string) =>
        id === "jupyter.runcurrentcell" ? new Promise(() => undefined) : Promise.resolve(undefined)
      );

      const first = command("openWrangler.runPythonCellAndOpenVariable")();
      const second = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await second;
      expect(pythonMocks.executeCommand).toHaveBeenCalledTimes(1);
      expect(pythonMocks.showInformationMessage).toHaveBeenCalledWith(
        "Open Wrangler is already running this Python file or cell."
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await first;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when Jupyter never publishes the Interactive Window cell", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(120_000);
      await opening;

      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("did not produce an Interactive Window execution")
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs an ordinary Python file and binds its exact resulting Interactive Window", async () => {
    const source = textDocument("file:///workspace/analysis.py", "frame = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 0);
    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runFileInteractive") {
        interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "run-file", true));
        pythonMocks.notebookDocuments.push(interactive.document);
      }
      return undefined;
    });
    const frame = pandasFrame("frame");
    pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.executeCommand).toHaveBeenCalledWith("jupyter.runFileInteractive", source.uri);
    expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("jupyter.runcurrentcell");
    expect(pythonMocks.discover).toHaveBeenCalledWith(interactive.document);
    expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
  });

  it("selects a kernel once and retries the same ordinary Python file", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "frame = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 0);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      const frame = polarsFrame("frame");
      pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });
      let runCount = 0;
      pythonMocks.executeCommand.mockImplementation(async (id: string) => {
        if (id !== "jupyter.runFileInteractive") return undefined;
        runCount += 1;
        if (runCount === 1) {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
        } else {
          const cell = interactiveCell(interactive.document, source.uri.toString(), 0, "run-file", true);
          interactive.cells.push(cell);
          fire(pythonMocks.changeNotebookListeners, {
            notebook: interactive.document,
            cellChanges: [{ cell, executionSummary: cell.executionSummary }],
            contentChanges: []
          } as unknown as NotebookDocumentChangeEvent);
        }
        return undefined;
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runFileInteractive",
        "notebook.selectKernel",
        "jupyter.runFileInteractive"
      ]);
      expect(pythonMocks.executeCommand).toHaveBeenNthCalledWith(1, "jupyter.runFileInteractive", source.uri);
      expect(pythonMocks.executeCommand).toHaveBeenNthCalledWith(3, "jupyter.runFileInteractive", source.uri);
      expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an ordinary file when Jupyter leaves its dispatch indeterminate", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "frame = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 0);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id !== "jupyter.runFileInteractive") return Promise.resolve(undefined);
        pythonMocks.notebookDocuments.push(interactive.document);
        fire(pythonMocks.openNotebookListeners, interactive.document);
        return new Promise(() => undefined);
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls).toEqual([["jupyter.runFileInteractive", source.uri]]);
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("didn't confirm"));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["# <codecell>", "# In[3]", "# In[ ]"])(
    "treats %s as a Python cell marker instead of running the whole file",
    async (marker) => {
      const source = textDocument("file:///workspace/analysis.py", `${marker}\nframe = make_frame()\n`);
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      pythonMocks.executeCommand.mockImplementation(async (id: string) => {
        if (id === "jupyter.runcurrentcell") {
          interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "run-cell", true));
          pythonMocks.notebookDocuments.push(interactive.document);
        }
        return undefined;
      });
      const frame = pandasFrame("frame");
      pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });

      await command("openWrangler.runPythonCellAndOpenVariable")();

      expect(pythonMocks.executeCommand).toHaveBeenCalledWith("jupyter.runcurrentcell");
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("jupyter.runFileInteractive", expect.anything());
      expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
    }
  );

  it("never runs Python code in an untrusted workspace", async () => {
    const source = textDocument("file:///workspace/analysis.py", "frame = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 0);
    pythonMocks.isTrusted = false;

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.executeCommand).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
      "Trust this workspace before Open Wrangler runs Python code."
    );
  });

  it("does not run the whole file when it contains cells but the cursor is outside a runnable cell", async () => {
    const source = textDocument("file:///workspace/analysis.py", "notes = 'before'\n# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 0);

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.executeCommand).not.toHaveBeenCalled();
    expect(pythonMocks.showInformationMessage).toHaveBeenCalledWith(
      "Place the cursor in a runnable Python cell, then try again."
    );
  });

  it.each(["# %% [markdown]", "# <markdowncell>"])(
    "does not run a markdown cell marked %s as a whole Python file",
    async (marker) => {
      const source = textDocument("file:///workspace/analysis.py", `${marker}\n# notes\n`);
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);

      await command("openWrangler.runPythonCellAndOpenVariable")();

      expect(pythonMocks.executeCommand).not.toHaveBeenCalled();
      expect(pythonMocks.showInformationMessage).toHaveBeenCalledWith(
        "Place the cursor in a runnable Python cell, then try again."
      );
    }
  );

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
    expect(pythonMocks.restoreEditorGroupAfterQuickPick).toHaveBeenCalledOnce();
    expect(pythonMocks.restoreEditorGroupAfterQuickPick.mock.invocationCallOrder[0]).toBeLessThan(
      pythonMocks.openVariable.mock.invocationCallOrder[0]!
    );
  });

  it("rechecks the Python source after returning focus from its dataframe picker", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nfirst = make_frame()\n");
    const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "old", true));
    pythonMocks.textDocuments.push(source);
    pythonMocks.notebookDocuments.push(interactive.document);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    fire(pythonMocks.activeTextListeners, pythonMocks.activeTextEditor);
    pythonMocks.discover.mockResolvedValue({
      variables: [pandasFrame("first"), polarsFrame("second")],
      truncated: false
    });
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id === "jupyter.runcurrentcell") {
        interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, "rerun", true));
      }
      return undefined;
    });
    pythonMocks.restoreEditorGroupAfterQuickPick.mockImplementationOnce(async () => {
      source.isClosed = true;
      pythonMocks.textDocuments.length = 0;
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.restoreEditorGroupAfterQuickPick).toHaveBeenCalledOnce();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
      "The Python file or Interactive Window changed while focus returned from the picker. Try again."
    );
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
          interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 0, `new-${index}`, true));
        }
      }
      return undefined;
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.executeCommand).toHaveBeenCalledWith("jupyter.runcurrentcell");
    expect(pythonMocks.discover).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("more than one matching cell"));
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

  it.each([
    {
      notebookType: "jupyter-notebook",
      activeUri: "file:///workspace/active.ipynb",
      inactiveUri: "file:///workspace/inactive.ipynb"
    },
    {
      notebookType: "interactive",
      activeUri: "untitled:/Interactive-1.interactive",
      inactiveUri: "untitled:/Interactive-2.interactive"
    }
  ])(
    "refreshes only the exact active $notebookType document and exposes cached variables without polling",
    async ({ notebookType, activeUri, inactiveUri }) => {
      const active = notebook(activeUri, notebookType, [], "python");
      const inactive = notebook(inactiveUri, notebookType, [], "python");
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
    }
  );

  it("shows and opens dataframes from the exact active IRkernel notebook", async () => {
    const active = notebook("file:///workspace/analysis-r.ipynb", "jupyter-notebook", [], "r");
    const inactive = notebook("file:///workspace/inactive-r.ipynb", "jupyter-notebook", [], "r");
    pythonMocks.notebookDocuments.push(active.document, inactive.document);
    pythonMocks.activeNotebookEditor = { notebook: active.document } as NotebookEditor;
    const discovery: RNotebookVariableDiscovery = {
      variables: [
        { name: "orders_frame", backend: "r", dataframeFlavor: "r.data.frame" },
        { name: "orders_tbl", backend: "r", dataframeFlavor: "r.tibble" },
        { name: "orders_dt", backend: "r", dataframeFlavor: "r.data.table" }
      ],
      truncated: false
    };
    pythonMocks.discover.mockResolvedValue(discovery);

    fire(pythonMocks.activeNotebookListeners, pythonMocks.activeNotebookEditor);
    await settle();

    expect(pythonMocks.discover).toHaveBeenCalledWith(active.document);
    expect(pythonMocks.discover).not.toHaveBeenCalledWith(inactive.document);
    const snapshot = provider.snapshot();
    expect(snapshot?.state).toBe("ready");
    expect(snapshot?.variables.map((variable) => [variable.label, variable.description])).toEqual([
      ["orders_frame", "R · data.frame"],
      ["orders_tbl", "R · tibble"],
      ["orders_dt", "R · data.table"]
    ]);

    const handle = snapshot?.variables[1]?.handle;
    await command("openWrangler.openCachedNotebookVariable")(handle);
    expect(pythonMocks.openRVariable).toHaveBeenCalledWith(
      context,
      coordinator,
      active.document,
      discovery,
      discovery.variables[1]
    );
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
  });

  it("uses the selected IRkernel when stored notebook metadata still says Python", async () => {
    const active = notebook("file:///workspace/switched-to-r.ipynb", "jupyter-notebook", [], "python");
    pythonMocks.notebookDocuments.push(active.document);
    pythonMocks.activeNotebookEditor = { notebook: active.document } as NotebookEditor;
    pythonMocks.discover.mockResolvedValue({
      variables: [{ name: "orders_tbl", backend: "r", dataframeFlavor: "r.tibble" }],
      truncated: false
    });

    fire(pythonMocks.activeNotebookListeners, pythonMocks.activeNotebookEditor);
    await settle();

    expect(pythonMocks.discover).toHaveBeenCalledWith(active.document);
    expect(provider.snapshot()).toEqual(
      expect.objectContaining({
        state: "ready",
        variables: [expect.objectContaining({ label: "orders_tbl", description: "R · tibble" })]
      })
    );
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

function notebookListenerCounts(): { readonly open: number; readonly change: number; readonly close: number } {
  return {
    open: pythonMocks.openNotebookListeners.size,
    change: pythonMocks.changeNotebookListeners.size,
    close: pythonMocks.closeNotebookListeners.size
  };
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
    selection: selection(line, line),
    viewColumn: vscode.ViewColumn.One
  } as unknown as TextEditor;
}

function selection(anchorLine: number, activeLine: number): TextEditor["selection"] {
  return {
    anchor: { line: anchorLine },
    active: { line: activeLine },
    start: { line: Math.min(anchorLine, activeLine) },
    end: { line: Math.max(anchorLine, activeLine) }
  } as TextEditor["selection"];
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
  id: string | undefined,
  success: boolean
) {
  const metadata = {
    interactive: { uristring: sourceUri, lineIndex, originalSource: "" },
    ...(id === undefined ? {} : { id })
  };
  return {
    index: notebookDocument.cellCount,
    notebook: notebookDocument,
    kind: vscode.NotebookCellKind.Code,
    document: { languageId: "python" },
    metadata,
    executionSummary: { success, timing: { startTime: 1, endTime: 2 } }
  } as unknown as vscode.NotebookCell;
}

function markupCell(notebookDocument: NotebookDocument): vscode.NotebookCell {
  return {
    index: notebookDocument.cellCount,
    notebook: notebookDocument,
    kind: vscode.NotebookCellKind.Markup,
    document: { languageId: "markdown" },
    metadata: {},
    executionSummary: undefined
  } as unknown as vscode.NotebookCell;
}

function unrelatedCodeCell(notebookDocument: NotebookDocument): vscode.NotebookCell {
  return {
    index: notebookDocument.cellCount,
    notebook: notebookDocument,
    kind: vscode.NotebookCellKind.Code,
    document: { languageId: "python" },
    metadata: {},
    executionSummary: undefined
  } as unknown as vscode.NotebookCell;
}

function pandasFrame(name: string) {
  return { name, type: "pandas.DataFrame", backend: "pandas" } as const;
}

function polarsFrame(name: string) {
  return { name, type: "polars.dataframe.frame.DataFrame", backend: "polars" } as const;
}
