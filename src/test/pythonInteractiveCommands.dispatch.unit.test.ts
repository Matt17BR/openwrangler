import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookDocumentChangeEvent, NotebookEditor, TextDocument } from "vscode";
import {
  pythonInteractiveMocks,
  setupPythonInteractiveTest,
  command,
  diagnosticProvider,
  fire,
  publishVisibleNotebookEditor,
  notebookListenerCounts,
  settle,
  textDocument,
  textEditor,
  selection,
  notebook,
  interactiveCell,
  markupCell,
  unrelatedCodeCell,
  pandasFrame,
  polarsFrame,
  type PythonInteractiveTestContext
} from "./pythonInteractiveCommands.testSupport";

const pythonMocks = pythonInteractiveMocks();

describe("Python Interactive Window cell dispatch", () => {
  let context: PythonInteractiveTestContext["context"];
  let provider: PythonInteractiveTestContext["provider"];
  let coordinator: PythonInteractiveTestContext["coordinator"];

  beforeEach(() => {
    ({ context, provider, coordinator } = setupPythonInteractiveTest());
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
            publishVisibleNotebookEditor(interactive.document);
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
      await vi.advanceTimersByTimeAsync(11_000);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel",
        "jupyter.runcurrentcell"
      ]);
      expect(pythonMocks.showNotebookDocument).not.toHaveBeenCalled();
      expect(restoredEditor.selection.anchor.line).toBe(1);
      expect(restoredEditor.selection.active.line).toBe(1);
      expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
      expect(vi.getTimerCount()).toBe(0);
      expect(notebookListenerCounts()).toEqual(listenerCounts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a marked Python scaffold after its pending first dispatch finishes without a cell", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      const sourceEditor = textEditor(source, 1);
      pythonMocks.activeTextEditor = sourceEditor;

      const interactive = notebook("untitled:/Interactive-pending.interactive", "interactive", []);
      const systemCell = markupCell(interactive.document, { isInteractiveWindowMessageCell: true });
      Object.defineProperty(systemCell, "executionSummary", { value: {}, writable: true });
      interactive.cells.push(systemCell);
      const interactiveEditor = { notebook: interactive.document } as NotebookEditor;
      const frame = pandasFrame("frame");
      pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });
      let runCount = 0;
      let finishFirstDispatch!: () => void;
      const firstDispatch = new Promise<undefined>((resolve) => {
        finishFirstDispatch = () => resolve(undefined);
      });
      pythonMocks.executeCommand.mockImplementation((id: string, argument?: { notebookEditor?: NotebookEditor }) => {
        if (id === "notebook.selectKernel") {
          expect(argument?.notebookEditor).toBe(interactiveEditor);
          Object.defineProperty(interactive.document, "metadata", {
            value: { kernelspec: { language: "python" } },
            writable: true
          });
          finishFirstDispatch();
          return Promise.resolve(undefined);
        }
        if (id !== "jupyter.runcurrentcell") return Promise.resolve(undefined);
        runCount += 1;
        if (runCount === 1) {
          pythonMocks.activeTextEditor = undefined;
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          setTimeout(() => {
            pythonMocks.activeNotebookEditor = interactiveEditor;
            pythonMocks.visibleNotebookEditors.push(interactiveEditor);
            fire(pythonMocks.visibleNotebookListeners, pythonMocks.visibleNotebookEditors);
          }, 250);
          return firstDispatch;
        }
        expect(pythonMocks.activeTextEditor?.document).toBe(source);
        expect(pythonMocks.activeTextEditor?.selection.active.line).toBe(1);
        const cell = interactiveCell(interactive.document, source.uri.toString(), 0, "run-1", true);
        interactive.cells.push(cell);
        fire(pythonMocks.changeNotebookListeners, {
          notebook: interactive.document,
          cellChanges: [{ cell, executionSummary: cell.executionSummary }],
          contentChanges: []
        } as unknown as NotebookDocumentChangeEvent);
        return Promise.resolve(undefined);
      });
      pythonMocks.showTextDocument.mockImplementation(async (document: TextDocument) => {
        expect(document).toBe(source);
        const restored = textEditor(document, 99);
        pythonMocks.activeTextEditor = restored;
        pythonMocks.activeNotebookEditor = undefined;
        return restored;
      });
      const listenerCounts = notebookListenerCounts();

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      expect(pythonMocks.showNotebookDocument).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(249);
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel"
      ]);
      await vi.advanceTimersByTimeAsync(999);
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel"
      ]);
      await vi.advanceTimersByTimeAsync(1);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel",
        "jupyter.runcurrentcell"
      ]);
      expect(
        interactive.cells.filter(
          (cell) =>
            (cell.metadata as { interactive?: { uristring?: unknown } }).interactive?.uristring ===
            source.uri.toString()
        )
      ).toHaveLength(1);
      expect(pythonMocks.discover).toHaveBeenCalledOnce();
      expect(pythonMocks.openVariable).toHaveBeenCalledOnce();
      expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
      expect(vi.getTimerCount()).toBe(0);
      expect(notebookListenerCounts()).toEqual(listenerCounts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats Quarto's unassociated markup scaffold as blank for kernel selection", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      const sourceEditor = textEditor(source, 1);
      pythonMocks.activeTextEditor = sourceEditor;
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      interactive.cells.push(
        markupCell(interactive.document, {
          interactive: { uristring: "untitled:/quarto-python-cell.py", lineIndex: 0 }
        })
      );
      const frame = polarsFrame("frame");
      pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });
      let runCount = 0;
      pythonMocks.executeCommand.mockImplementation(async (id: string) => {
        if (id === "jupyter.runcurrentcell") {
          runCount += 1;
          if (runCount === 1) {
            pythonMocks.notebookDocuments.push(interactive.document);
            publishVisibleNotebookEditor(interactive.document);
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
      await vi.advanceTimersByTimeAsync(11_000);
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
    ["more than Jupyter's single placeholder", "interactive", undefined, 2, false],
    ["unmarked R metadata and an empty execution summary", "interactive", "r", 1, false],
    ["a regular Jupyter notebook", "jupyter-notebook", undefined, 1, false],
    ["an exact source association", "interactive", undefined, 1, true]
  ])(
    "does not treat a markup-only Interactive Window with %s as blank",
    async (_label, notebookType, language, cellCount, associated) => {
      vi.useFakeTimers();
      try {
        const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
        pythonMocks.textDocuments.push(source);
        pythonMocks.activeTextEditor = textEditor(source, 1);
        const interactive = notebook("untitled:/Interactive-1.interactive", notebookType, [], language);
        for (let index = 0; index < cellCount; index += 1) {
          const cell = markupCell(
            interactive.document,
            associated ? { interactive: { uristring: source.uri.toString(), lineIndex: 0 } } : {}
          );
          if (language === "r") Object.defineProperty(cell, "executionSummary", { value: {}, writable: true });
          interactive.cells.push(cell);
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
        await vi.advanceTimersByTimeAsync(associated ? 120_000 : 10_000);
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
      const replacement = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(first.document);
          fire(pythonMocks.openNotebookListeners, first.document);
          return new Promise(() => undefined);
        }
        return Promise.resolve(undefined);
      });
      const listenerCounts = notebookListenerCounts();

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      Object.defineProperty(first.document, "isClosed", { value: true });
      pythonMocks.notebookDocuments.splice(0, 1, replacement.document);
      fire(pythonMocks.closeNotebookListeners, first.document);
      fire(pythonMocks.openNotebookListeners, replacement.document);
      publishVisibleNotebookEditor(replacement.document);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      expect(pythonMocks.showNotebookDocument).not.toHaveBeenCalled();
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("changed while its kernel was being selected")
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(notebookListenerCounts()).toEqual(listenerCounts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops kernel recovery when a second blank Interactive Window opens during selection", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const first = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      const second = notebook("untitled:/Interactive-2.interactive", "interactive", []);
      let finishKernelSelection!: () => void;
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(first.document);
          publishVisibleNotebookEditor(first.document);
          fire(pythonMocks.openNotebookListeners, first.document);
        }
        if (id === "notebook.selectKernel") {
          return new Promise<undefined>((resolve) => {
            finishKernelSelection = () => resolve(undefined);
          });
        }
        return Promise.resolve(undefined);
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel"
      ]);
      pythonMocks.notebookDocuments.push(second.document);
      fire(pythonMocks.openNotebookListeners, second.document);
      finishKernelSelection();
      await settle();
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel"
      ]);
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("changed during kernel selection")
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not select a kernel when one dispatch opens two blank Interactive Windows", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    const first = notebook("untitled:/Interactive-1.interactive", "interactive", []);
    const second = notebook("untitled:/Interactive-2.interactive", "interactive", []);
    pythonMocks.executeCommand.mockImplementation((id: string) => {
      if (id !== "jupyter.runcurrentcell") return Promise.resolve(undefined);
      pythonMocks.notebookDocuments.push(first.document, second.document);
      fire(pythonMocks.openNotebookListeners, first.document);
      fire(pythonMocks.openNotebookListeners, second.document);
      return new Promise(() => undefined);
    });

    await command("openWrangler.runPythonCellAndOpenVariable")();

    expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
    expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("more than one matching cell"));
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
          publishVisibleNotebookEditor(interactive.document);
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

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel"
      ]);
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

  it("stops when Jupyter never publishes the exact Interactive Window editor", async () => {
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
      await vi.advanceTimersByTimeAsync(10_001);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual(["jupyter.runcurrentcell"]);
      expect(pythonMocks.showNotebookDocument).not.toHaveBeenCalled();
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
        "Jupyter did not finish opening the Interactive Window in time."
      );
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
          publishVisibleNotebookEditor(interactive.document);
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
      await vi.advanceTimersByTimeAsync(11_000);
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
    const previousExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(interactive.document);
          publishVisibleNotebookEditor(interactive.document);
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
      expect(diagnosticProvider(provider).diagnosticsForTesting()).toEqual({
        invocation: 1,
        stage: "selecting-kernel",
        lastActiveStage: "selecting-kernel",
        stages: ["dispatching-cell", "waiting-for-cell-publication", "selecting-kernel"]
      });
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
      expect(diagnosticProvider(provider).diagnosticsForTesting()).toEqual({
        invocation: 1,
        stage: "failed",
        lastActiveStage: "selecting-kernel",
        stages: ["dispatching-cell", "waiting-for-cell-publication", "selecting-kernel", "failed"]
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(notebookListenerCounts()).toEqual(listenerCounts);
    } finally {
      vi.useRealTimers();
      if (previousExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
      else process.env.OPEN_WRANGLER_EXTENSION_TESTS = previousExtensionTests;
    }
  });

  it("does not retry when the visible Interactive editor changes during kernel selection", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      const originalEditor = { notebook: interactive.document } as NotebookEditor;
      let finishKernelSelection!: () => void;
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id === "jupyter.runcurrentcell") {
          pythonMocks.notebookDocuments.push(interactive.document);
          pythonMocks.visibleNotebookEditors.push(originalEditor);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          return Promise.resolve(undefined);
        }
        if (id === "notebook.selectKernel") {
          return new Promise<undefined>((resolve) => {
            finishKernelSelection = () => resolve(undefined);
          });
        }
        return Promise.resolve(undefined);
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel"
      ]);

      pythonMocks.visibleNotebookEditors.splice(0, 1, {
        notebook: interactive.document
      } as NotebookEditor);
      finishKernelSelection();
      await settle();
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runcurrentcell",
        "notebook.selectKernel"
      ]);
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("changed during kernel selection")
      );
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
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
          publishVisibleNotebookEditor(interactive.document);
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
      await vi.advanceTimersByTimeAsync(11_000);
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

  it("selects a kernel but does not retry an ordinary file with an indeterminate dispatch", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument("file:///workspace/analysis.py", "frame = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 0);
      const interactive = notebook("untitled:/Interactive-1.interactive", "interactive", []);
      pythonMocks.executeCommand.mockImplementation((id: string) => {
        if (id !== "jupyter.runFileInteractive") return Promise.resolve(undefined);
        pythonMocks.notebookDocuments.push(interactive.document);
        publishVisibleNotebookEditor(interactive.document);
        fire(pythonMocks.openNotebookListeners, interactive.document);
        return new Promise(() => undefined);
      });

      const opening = command("openWrangler.runPythonCellAndOpenVariable")();
      await settle();
      await vi.advanceTimersByTimeAsync(10_001);
      await opening;

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.runFileInteractive",
        "notebook.selectKernel"
      ]);
      expect(pythonMocks.executeCommand).toHaveBeenNthCalledWith(1, "jupyter.runFileInteractive", source.uri);
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
});
