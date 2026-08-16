import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookDocumentChangeEvent, NotebookEditor, TextDocument } from "vscode";
import {
  vscodeApi,
  pythonInteractiveMocks,
  setupPythonInteractiveTest,
  literateProvider,
  diagnosticProvider,
  literateOrigin,
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
  pandasFrame,
  type PythonInteractiveTestContext
} from "./pythonInteractiveCommands.testSupport";

const pythonMocks = pythonInteractiveMocks();
const vscode = vscodeApi();

describe("Python Interactive Window literate dispatch", () => {
  let context: PythonInteractiveTestContext["context"];
  let provider: PythonInteractiveTestContext["provider"];
  let coordinator: PythonInteractiveTestContext["coordinator"];

  beforeEach(() => {
    ({ context, provider, coordinator } = setupPythonInteractiveTest());
  });

  it("runs the exact cursor-owned Quarto Python chunk through Jupyter", async () => {
    const source = textDocument(
      "file:///workspace/analysis.qmd",
      "# Analysis\n\n```{python}\n#| label: load-orders\nframe = make_frame()\n```\n"
    );
    const editor = textEditor(source, 4);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(editor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 2,
      codeStartLine: 3,
      codeEndLine: 4,
      closingLine: 5,
      code: "#| label: load-orders\nframe = make_frame()\n"
    });
    const interactive = notebook("untitled:/Interactive-quarto.interactive", "interactive", []);
    pythonMocks.notebookDocuments.push(interactive.document);
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id !== "jupyter.execSelectionInteractive") return undefined;
      interactive.cells.push(
        interactiveCell(interactive.document, source.uri.toString(), 4, "quarto-run", true, "quarto")
      );
      return undefined;
    });
    const frame = pandasFrame("frame");
    pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(true);

    expect(pythonMocks.executeCommand).toHaveBeenCalledWith(
      "jupyter.execSelectionInteractive",
      "#| label: load-orders\nframe = make_frame()\n"
    );
    expect(pythonMocks.discover).toHaveBeenCalledWith(interactive.document);
    expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
  });

  it("reopens the document's Python session from Quarto prose without accepting its R chunk", async () => {
    const source = textDocument(
      "file:///workspace/analysis.qmd",
      "---\njupyter: python3\n---\n```{python}\nframe = make_frame()\n```\n\nChoose the existing dataframe.\n\n```{r}\nr_frame <- data.frame(id = 1:3)\n```\n",
      "quarto"
    );
    const editor = textEditor(source, 7);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(editor, "quarto", undefined, "jupyter");
    const exact = notebook("untitled:/Interactive-quarto-exact.interactive", "interactive", []);
    exact.cells.push(interactiveCell(exact.document, source.uri.toString(), 4, "exact", true, "quarto"));
    const rChunk = notebook("untitled:/Interactive-quarto-r-chunk.interactive", "interactive", []);
    rChunk.cells.push(interactiveCell(rChunk.document, source.uri.toString(), 10, "r-chunk", true, "quarto"));
    const rKernel = notebook("untitled:/Interactive-quarto-r.interactive", "interactive", [], "r");
    rKernel.cells.push(interactiveCell(rKernel.document, source.uri.toString(), 4, "r-kernel", true, "quarto"));
    pythonMocks.notebookDocuments.push(exact.document, rChunk.document, rKernel.document);
    const frame = pandasFrame("frame");
    pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });

    expect(literateProvider(provider).hasAssociatedLiterateSession(origin)).toBe(true);
    await expect(literateProvider(provider).openAssociatedLiterateSession(origin)).resolves.toBe(true);

    expect(pythonMocks.discover).toHaveBeenCalledTimes(1);
    expect(pythonMocks.discover).toHaveBeenCalledWith(exact.document);
    expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, exact.document, frame);
    expect(pythonMocks.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("More than one Python Interactive Window")
    );
  });

  it("does not treat a Quarto R chunk as a Python Interactive Window association", async () => {
    const source = textDocument(
      "file:///workspace/mixed.qmd",
      "```{r}\nframe <- data.frame(id = 1:3)\n```\n",
      "quarto"
    );
    const editor = textEditor(source, 1);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(
      editor,
      "quarto",
      {
        language: "r",
        executableSyntax: true,
        supportedFence: true,
        enabled: true,
        fenceCharacter: "`",
        openingLine: 0,
        codeStartLine: 1,
        codeEndLine: 1,
        closingLine: 2,
        code: "frame <- data.frame(id = 1:3)\n"
      },
      "r"
    );
    const interactive = notebook("untitled:/Interactive-quarto-r-chunk.interactive", "interactive", []);
    interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 1, "r-chunk", true, "quarto"));
    pythonMocks.notebookDocuments.push(interactive.document);

    expect(literateProvider(provider).hasAssociatedLiterateSession(origin)).toBe(false);
    await expect(literateProvider(provider).openAssociatedLiterateSession(origin)).resolves.toBe(false);

    expect(pythonMocks.discover).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
  });

  it("refuses to fabricate an Interactive Window cell for an R-owned Python chunk", async () => {
    const source = textDocument(
      "file:///workspace/analysis.Rmd",
      "```{python load-orders}\n#| echo: false\nframe = make_frame()\n```\n"
    );
    const editor = textEditor(source, 2);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const code = "#| echo: false\nframe = make_frame()\n";
    const origin = literateOrigin(
      editor,
      "rmarkdown",
      {
        language: "python",
        executableSyntax: true,
        supportedFence: true,
        enabled: true,
        fenceCharacter: "`",
        openingLine: 0,
        codeStartLine: 1,
        codeEndLine: 2,
        closingLine: 3,
        code
      },
      "r"
    );

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(false);

    expect(pythonMocks.executeCommand).not.toHaveBeenCalled();
    expect(pythonMocks.discover).not.toHaveBeenCalled();
  });

  it("keeps the captured Quarto result when Jupyter moves the cursor after dispatch", async () => {
    const source = textDocument("file:///workspace/analysis.qmd", "```{python}\nframe = make_frame()\n```\n");
    const editor = textEditor(source, 1);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(editor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 0,
      codeStartLine: 1,
      codeEndLine: 1,
      closingLine: 2,
      code: "frame = make_frame()\n"
    });
    const interactive = notebook("untitled:/Interactive-stale.interactive", "interactive", []);
    pythonMocks.notebookDocuments.push(interactive.document);
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id !== "jupyter.execSelectionInteractive") return undefined;
      const moved = selection(2, 2);
      editor.selection = moved;
      editor.selections = [moved];
      interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 1, "stale-run", true));
      return undefined;
    });
    pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("frame")], truncated: false });

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(true);

    expect(pythonMocks.discover).toHaveBeenCalledWith(interactive.document);
    expect(pythonMocks.openVariable).toHaveBeenCalledOnce();
    expect(pythonMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("reacquires a replacement Quarto editor before the first dispatch", async () => {
    const source = textDocument("file:///workspace/analysis.qmd", "```{python}\nframe = make_frame()\n```\n");
    const capturedEditor = textEditor(source, 1);
    const origin = literateOrigin(capturedEditor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 0,
      codeStartLine: 1,
      codeEndLine: 1,
      closingLine: 2,
      code: "frame = make_frame()\n"
    });
    const replacementEditor = textEditor(source, 1);
    Object.defineProperties(capturedEditor, {
      selection: {
        get: () => {
          throw new Error("disposed editor");
        }
      },
      selections: {
        get: () => {
          throw new Error("disposed editor");
        }
      }
    });
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = replacementEditor;
    const interactive = notebook("untitled:/Interactive-replaced-source.interactive", "interactive", []);
    pythonMocks.notebookDocuments.push(interactive.document);
    pythonMocks.executeCommand.mockImplementation(async (id: string) => {
      if (id !== "jupyter.execSelectionInteractive") return undefined;
      interactive.cells.push(interactiveCell(interactive.document, source.uri.toString(), 1, "quarto-run", true));
      return undefined;
    });
    pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("frame")], truncated: false });

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(true);

    expect(pythonMocks.executeCommand).toHaveBeenCalledWith(
      "jupyter.execSelectionInteractive",
      "frame = make_frame()\n"
    );
    expect(pythonMocks.openVariable).toHaveBeenCalledOnce();
  });

  it("does not retarget a captured Quarto chunk to another editor group", async () => {
    const source = textDocument("file:///workspace/analysis.qmd", "```{python}\nframe = make_frame()\n```\n");
    const capturedEditor = textEditor(source, 1);
    const origin = literateOrigin(capturedEditor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 0,
      codeStartLine: 1,
      codeEndLine: 1,
      closingLine: 2,
      code: "frame = make_frame()\n"
    });
    const otherGroupEditor = textEditor(source, 1);
    Object.defineProperty(otherGroupEditor, "viewColumn", { value: vscode.ViewColumn.Two });
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = otherGroupEditor;

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(false);

    expect(pythonMocks.executeCommand).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
  });

  it("bootstraps a source-owned Interactive Window before one real Quarto dispatch", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument(
        "file:///workspace/analysis.qmd",
        "```{python}\nframe = make_frame()\n```\n",
        "quarto"
      );
      const editor = textEditor(source, 1);
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = editor;
      const origin = literateOrigin(editor, "quarto", {
        language: "python",
        executableSyntax: true,
        supportedFence: true,
        enabled: true,
        fenceCharacter: "`",
        openingLine: 0,
        codeStartLine: 1,
        codeEndLine: 1,
        closingLine: 2,
        code: "frame = make_frame()\n"
      });
      const interactive = notebook("untitled:/Interactive-quarto-kernel.interactive", "interactive", []);
      let interactiveEditor: NotebookEditor | undefined;
      let markerPublished = false;
      let realDispatches = 0;
      pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
        if (id === "notebook.selectKernel") {
          expect(markerPublished).toBe(true);
          expect(argument).toEqual({ notebookEditor: interactiveEditor });
          setTimeout(() => {
            Object.defineProperty(interactive.document, "metadata", {
              value: { metadata: { kernelspec: { language: "python" } } },
              writable: true
            });
            fire(pythonMocks.changeNotebookListeners, {
              notebook: interactive.document,
              cellChanges: [],
              contentChanges: []
            } as unknown as NotebookDocumentChangeEvent);
          }, 50);
          return undefined;
        }
        if (id !== "jupyter.execSelectionInteractive") return undefined;
        if (argument === "") {
          setTimeout(() => {
            pythonMocks.notebookDocuments.push(interactive.document);
            fire(pythonMocks.openNotebookListeners, interactive.document);
            interactiveEditor = publishVisibleNotebookEditor(interactive.document);
          }, 100);
          setTimeout(() => {
            markerPublished = true;
            const systemCell = markupCell(interactive.document, { isInteractiveWindowMessageCell: true });
            interactive.cells.push(systemCell);
            fire(pythonMocks.changeNotebookListeners, {
              notebook: interactive.document,
              cellChanges: [{ cell: systemCell, executionSummary: undefined }],
              contentChanges: [{ addedCells: [systemCell], removedCells: [] }]
            } as unknown as NotebookDocumentChangeEvent);
          }, 250);
          return undefined;
        }
        expect(argument).toBe("frame = make_frame()\n");
        expect(pythonMocks.activeTextEditor?.document).toBe(source);
        realDispatches += 1;
        setTimeout(() => {
          const cell = interactiveCell(interactive.document, source.uri.toString(), 1, "quarto-run", true);
          interactive.cells.push(cell);
          fire(pythonMocks.changeNotebookListeners, {
            notebook: interactive.document,
            cellChanges: [{ cell, executionSummary: cell.executionSummary }],
            contentChanges: [{ addedCells: [cell], removedCells: [] }]
          } as unknown as NotebookDocumentChangeEvent);
        }, 1_500);
        return undefined;
      });
      pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("frame")], truncated: false });

      const opening = literateProvider(provider).runLiterateChunkAndOpen(origin);
      await settle();
      expect(pythonMocks.executeCommand.mock.calls).toEqual([["jupyter.execSelectionInteractive", ""]]);
      await vi.advanceTimersByTimeAsync(100);
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
      await vi.advanceTimersByTimeAsync(149);
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
      await vi.advanceTimersByTimeAsync(1);
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.execSelectionInteractive",
        "notebook.selectKernel"
      ]);
      await vi.advanceTimersByTimeAsync(49);
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.execSelectionInteractive",
        "notebook.selectKernel"
      ]);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.execSelectionInteractive",
        "notebook.selectKernel",
        "jupyter.execSelectionInteractive"
      ]);
      await vi.advanceTimersByTimeAsync(1_499);
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(opening).resolves.toBe(true);

      expect(pythonMocks.executeCommand.mock.calls).toEqual([
        ["jupyter.execSelectionInteractive", ""],
        ["notebook.selectKernel", { notebookEditor: interactiveEditor }],
        ["jupyter.execSelectionInteractive", "frame = make_frame()\n"]
      ]);
      expect(realDispatches).toBe(1);
      expect(pythonMocks.showNotebookDocument).not.toHaveBeenCalled();
      expect(pythonMocks.showTextDocument).toHaveBeenCalledWith(source, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
      });
      expect(pythonMocks.activeTextEditor?.selection.active.line).toBe(1);
      expect(pythonMocks.openVariable).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals the exact fresh Quarto Interactive Window before selecting its kernel", async () => {
    const source = textDocument("file:///workspace/analysis.qmd", "```{python}\nframe = make_frame()\n```\n", "quarto");
    const editor = textEditor(source, 1);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(editor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 0,
      codeStartLine: 1,
      codeEndLine: 1,
      closingLine: 2,
      code: "frame = make_frame()\n"
    });
    const interactive = notebook("untitled:/Interactive-quarto-cursor.interactive", "interactive", []);
    interactive.cells.push(markupCell(interactive.document, { isInteractiveWindowMessageCell: true }));
    let realDispatches = 0;
    pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
      if (id === "jupyter.execSelectionInteractive" && argument === "") {
        pythonMocks.notebookDocuments.push(interactive.document);
        fire(pythonMocks.openNotebookListeners, interactive.document);
        return undefined;
      }
      if (id === "notebook.selectKernel") {
        expect(argument).toEqual({ notebookEditor: pythonMocks.visibleNotebookEditors[0] });
        Object.defineProperty(interactive.document, "metadata", {
          value: { metadata: { kernelspec: { language: "python" } } },
          writable: true
        });
        return undefined;
      }
      if (id === "jupyter.execSelectionInteractive" && argument === "frame = make_frame()\n") {
        expect(pythonMocks.activeTextEditor?.document).toBe(source);
        realDispatches += 1;
        const cell = interactiveCell(interactive.document, source.uri.toString(), 1, "quarto-run", true);
        interactive.cells.push(cell);
        fire(pythonMocks.changeNotebookListeners, {
          notebook: interactive.document,
          cellChanges: [{ cell, executionSummary: cell.executionSummary }],
          contentChanges: [{ addedCells: [cell], removedCells: [] }]
        } as unknown as NotebookDocumentChangeEvent);
        return undefined;
      }
      throw new Error(`Unexpected command ${id}`);
    });
    pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("frame")], truncated: false });

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(true);

    expect(pythonMocks.showNotebookDocument).toHaveBeenCalledOnce();
    expect(pythonMocks.showNotebookDocument).toHaveBeenCalledWith(interactive.document, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
      preview: false
    });
    expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
      "jupyter.execSelectionInteractive",
      "notebook.selectKernel",
      "jupyter.execSelectionInteractive"
    ]);
    expect(realDispatches).toBe(1);
    expect(pythonMocks.openVariable).toHaveBeenCalledOnce();
  });

  it("uses an explicitly auto-selected Python kernel on a fresh Quarto scaffold without reopening the picker", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument(
        "file:///workspace/analysis.qmd",
        "```{python}\nframe = make_frame()\n```\n",
        "quarto"
      );
      const editor = textEditor(source, 1);
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = editor;
      const origin = literateOrigin(editor, "quarto", {
        language: "python",
        executableSyntax: true,
        supportedFence: true,
        enabled: true,
        fenceCharacter: "`",
        openingLine: 0,
        codeStartLine: 1,
        codeEndLine: 1,
        closingLine: 2,
        code: "frame = make_frame()\n"
      });
      const interactive = notebook("untitled:/Interactive-quarto-auto-kernel.interactive", "interactive", []);
      Object.defineProperty(interactive.document, "metadata", {
        value: { metadata: { kernelspec: { language: "python" } } },
        writable: true
      });
      let realDispatches = 0;
      pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
        if (id === "jupyter.execSelectionInteractive" && argument === "") {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          publishVisibleNotebookEditor(interactive.document);
          return undefined;
        }
        if (id === "jupyter.execSelectionInteractive" && argument === "frame = make_frame()\n") {
          expect(pythonMocks.activeTextEditor?.document).toBe(source);
          realDispatches += 1;
          const cell = interactiveCell(interactive.document, source.uri.toString(), 1, "quarto-auto-kernel", true);
          interactive.cells.push(cell);
          fire(pythonMocks.changeNotebookListeners, {
            notebook: interactive.document,
            cellChanges: [{ cell, executionSummary: cell.executionSummary }],
            contentChanges: [{ addedCells: [cell], removedCells: [] }]
          } as unknown as NotebookDocumentChangeEvent);
          return undefined;
        }
        throw new Error(`Unexpected command ${id}`);
      });
      pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("frame")], truncated: false });

      const opening = literateProvider(provider).runLiterateChunkAndOpen(origin);
      await settle();
      expect(pythonMocks.executeCommand.mock.calls).toEqual([["jupyter.execSelectionInteractive", ""]]);
      await vi.advanceTimersByTimeAsync(0);
      await expect(opening).resolves.toBe(true);

      expect(pythonMocks.executeCommand.mock.calls).toEqual([
        ["jupyter.execSelectionInteractive", ""],
        ["jupyter.execSelectionInteractive", "frame = make_frame()\n"]
      ]);
      expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
      expect(realDispatches).toBe(1);
      expect(pythonMocks.showWarningMessage).not.toHaveBeenCalled();
      expect(pythonMocks.openVariable).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let flat Python metadata bypass the fresh Quarto kernel picker contract", async () => {
    const source = textDocument("file:///workspace/analysis.qmd", "```{python}\nframe = make_frame()\n```\n", "quarto");
    const editor = textEditor(source, 1);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(editor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 0,
      codeStartLine: 1,
      codeEndLine: 1,
      closingLine: 2,
      code: "frame = make_frame()\n"
    });
    const interactive = notebook("untitled:/Interactive-quarto-flat-metadata.interactive", "interactive", []);
    interactive.cells.push(markupCell(interactive.document, { isInteractiveWindowMessageCell: true }));
    Object.defineProperty(interactive.document, "metadata", {
      value: { kernelspec: { language: "python" } },
      writable: true
    });
    pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
      if (id === "jupyter.execSelectionInteractive" && argument === "") {
        pythonMocks.notebookDocuments.push(interactive.document);
        fire(pythonMocks.openNotebookListeners, interactive.document);
        publishVisibleNotebookEditor(interactive.document);
        return undefined;
      }
      throw new Error(`Unexpected command ${id}`);
    });

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(false);

    expect(pythonMocks.executeCommand.mock.calls).toEqual([["jupyter.execSelectionInteractive", ""]]);
    expect(pythonMocks.showTextDocument).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
  });

  it("does not let conflicting canonical metadata authorize a fresh Quarto dispatch", async () => {
    const source = textDocument("file:///workspace/analysis.qmd", "```{python}\nframe = make_frame()\n```\n", "quarto");
    const editor = textEditor(source, 1);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(editor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 0,
      codeStartLine: 1,
      codeEndLine: 1,
      closingLine: 2,
      code: "frame = make_frame()\n"
    });
    const interactive = notebook("untitled:/Interactive-quarto-conflicting-metadata.interactive", "interactive", []);
    interactive.cells.push(markupCell(interactive.document, { isInteractiveWindowMessageCell: true }));
    Object.defineProperty(interactive.document, "metadata", {
      value: {
        metadata: {
          kernelspec: { language: "python" },
          language_info: { name: "r" }
        }
      },
      writable: true
    });
    pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
      if (id === "jupyter.execSelectionInteractive" && argument === "") {
        pythonMocks.notebookDocuments.push(interactive.document);
        fire(pythonMocks.openNotebookListeners, interactive.document);
        publishVisibleNotebookEditor(interactive.document);
        return undefined;
      }
      throw new Error(`Unexpected command ${id}`);
    });

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(false);

    expect(pythonMocks.executeCommand.mock.calls).toEqual([["jupyter.execSelectionInteractive", ""]]);
    expect(pythonMocks.executeCommand).not.toHaveBeenCalledWith("notebook.selectKernel", expect.anything());
    expect(pythonMocks.showTextDocument).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
  });

  it("does not dispatch a fresh Quarto chunk when confirmed Python metadata disappears during source restoration", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument(
        "file:///workspace/analysis.qmd",
        "```{python}\nframe = make_frame()\n```\n",
        "quarto"
      );
      const editor = textEditor(source, 1);
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = editor;
      const origin = literateOrigin(editor, "quarto", {
        language: "python",
        executableSyntax: true,
        supportedFence: true,
        enabled: true,
        fenceCharacter: "`",
        openingLine: 0,
        codeStartLine: 1,
        codeEndLine: 1,
        closingLine: 2,
        code: "frame = make_frame()\n"
      });
      const interactive = notebook("untitled:/Interactive-quarto-metadata-race.interactive", "interactive", []);
      interactive.cells.push(markupCell(interactive.document, { isInteractiveWindowMessageCell: true }));
      Object.defineProperty(interactive.document, "metadata", {
        value: { metadata: { kernelspec: { language: "python" } } },
        writable: true
      });
      pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
        if (id === "jupyter.execSelectionInteractive" && argument === "") {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          publishVisibleNotebookEditor(interactive.document);
          return undefined;
        }
        throw new Error(`Unexpected command ${id}`);
      });
      pythonMocks.showTextDocument.mockImplementation(async (document: TextDocument) => {
        Object.defineProperty(interactive.document, "metadata", { value: {}, writable: true });
        const restored = textEditor(document, 0);
        pythonMocks.activeTextEditor = restored;
        pythonMocks.activeNotebookEditor = undefined;
        return restored;
      });

      const opening = literateProvider(provider).runLiterateChunkAndOpen(origin);
      await settle();
      await vi.advanceTimersByTimeAsync(0);
      await expect(opening).resolves.toBe(false);

      expect(pythonMocks.executeCommand.mock.calls).toEqual([["jupyter.execSelectionInteractive", ""]]);
      expect(pythonMocks.showTextDocument).toHaveBeenCalledOnce();
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dispatch a real Quarto chunk when revealing the pinned window returns a replacement", async () => {
    const source = textDocument("file:///workspace/analysis.qmd", "```{python}\nframe = make_frame()\n```\n", "quarto");
    const editor = textEditor(source, 1);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(editor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 0,
      codeStartLine: 1,
      codeEndLine: 1,
      closingLine: 2,
      code: "frame = make_frame()\n"
    });
    const interactive = notebook("untitled:/Interactive-quarto-reveal.interactive", "interactive", []);
    interactive.cells.push(markupCell(interactive.document, { isInteractiveWindowMessageCell: true }));
    const replacement = notebook("untitled:/Interactive-quarto-reveal.interactive", "interactive", []);
    const replacementEditor = { notebook: replacement.document } as NotebookEditor;
    pythonMocks.showNotebookDocument.mockImplementation(async () => {
      pythonMocks.visibleNotebookEditors.push(replacementEditor);
      return replacementEditor;
    });
    pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
      if (id === "jupyter.execSelectionInteractive" && argument === "") {
        pythonMocks.notebookDocuments.push(interactive.document);
        fire(pythonMocks.openNotebookListeners, interactive.document);
        return undefined;
      }
      throw new Error(`Unexpected command ${id}`);
    });

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(false);

    expect(pythonMocks.showNotebookDocument).toHaveBeenCalledOnce();
    expect(pythonMocks.executeCommand.mock.calls).toEqual([["jupyter.execSelectionInteractive", ""]]);
    expect(pythonMocks.showTextDocument).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
  });

  it("does not dispatch a real Quarto chunk when kernel selection closes without Python metadata", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument(
        "file:///workspace/analysis.qmd",
        "```{python}\nframe = make_frame()\n```\n",
        "quarto"
      );
      const editor = textEditor(source, 1);
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = editor;
      const origin = literateOrigin(editor, "quarto", {
        language: "python",
        executableSyntax: true,
        supportedFence: true,
        enabled: true,
        fenceCharacter: "`",
        openingLine: 0,
        codeStartLine: 1,
        codeEndLine: 1,
        closingLine: 2,
        code: "frame = make_frame()\n"
      });
      const interactive = notebook("untitled:/Interactive-quarto-selection.interactive", "interactive", []);
      const systemCell = markupCell(interactive.document, { isInteractiveWindowMessageCell: true });
      interactive.cells.push(systemCell);
      let interactiveEditor: NotebookEditor | undefined;
      pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
        if (id === "jupyter.execSelectionInteractive" && argument === "") {
          pythonMocks.activeTextEditor = undefined;
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          interactiveEditor = publishVisibleNotebookEditor(interactive.document);
          return undefined;
        }
        if (id === "notebook.selectKernel") {
          expect(argument).toEqual({ notebookEditor: interactiveEditor });
          return undefined;
        }
        throw new Error(`Unexpected command ${id}`);
      });

      const opening = literateProvider(provider).runLiterateChunkAndOpen(origin);
      await settle();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(pythonMocks.showWarningMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(opening).resolves.toBe(false);

      expect(pythonMocks.executeCommand.mock.calls).toEqual([
        ["jupyter.execSelectionInteractive", ""],
        ["notebook.selectKernel", { notebookEditor: interactiveEditor }]
      ]);
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(
        "No Python kernel selection was confirmed for the Interactive Window."
      );
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(pythonMocks.showTextDocument).not.toHaveBeenCalled();
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dispatch a Quarto chunk when another exact cell appears during kernel selection", async () => {
    const source = textDocument("file:///workspace/analysis.qmd", "```{python}\nframe = make_frame()\n```\n", "quarto");
    const editor = textEditor(source, 1);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(editor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 0,
      codeStartLine: 1,
      codeEndLine: 1,
      closingLine: 2,
      code: "frame = make_frame()\n"
    });
    const interactive = notebook("untitled:/Interactive-quarto-race.interactive", "interactive", []);
    interactive.cells.push(markupCell(interactive.document, { isInteractiveWindowMessageCell: true }));
    let interactiveEditor: NotebookEditor | undefined;
    let finishSelection!: () => void;
    const selection = new Promise<void>((resolve) => {
      finishSelection = resolve;
    });
    pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
      if (id === "jupyter.execSelectionInteractive" && argument === "") {
        pythonMocks.notebookDocuments.push(interactive.document);
        fire(pythonMocks.openNotebookListeners, interactive.document);
        interactiveEditor = publishVisibleNotebookEditor(interactive.document);
        return undefined;
      }
      if (id === "notebook.selectKernel") {
        expect(argument).toEqual({ notebookEditor: interactiveEditor });
        return await selection;
      }
      throw new Error(`Unexpected command ${id}`);
    });

    const opening = literateProvider(provider).runLiterateChunkAndOpen(origin);
    await settle();
    expect(pythonMocks.executeCommand).toHaveBeenCalledWith("notebook.selectKernel", {
      notebookEditor: interactiveEditor
    });
    const unrelated = interactiveCell(interactive.document, source.uri.toString(), 1, "other-run", true, "quarto");
    interactive.cells.push(unrelated);
    fire(pythonMocks.changeNotebookListeners, {
      notebook: interactive.document,
      cellChanges: [{ cell: unrelated, executionSummary: unrelated.executionSummary }],
      contentChanges: [{ addedCells: [unrelated], removedCells: [] }]
    } as unknown as NotebookDocumentChangeEvent);
    finishSelection();

    await expect(opening).resolves.toBe(false);
    expect(pythonMocks.executeCommand.mock.calls).toEqual([
      ["jupyter.execSelectionInteractive", ""],
      ["notebook.selectKernel", { notebookEditor: interactiveEditor }]
    ]);
    expect(pythonMocks.showTextDocument).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
  });

  it("does not dispatch a Python Quarto chunk after an explicitly R kernel is selected", async () => {
    const source = textDocument("file:///workspace/analysis.qmd", "```{python}\nframe = make_frame()\n```\n", "quarto");
    const editor = textEditor(source, 1);
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = editor;
    const origin = literateOrigin(editor, "quarto", {
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 0,
      codeStartLine: 1,
      codeEndLine: 1,
      closingLine: 2,
      code: "frame = make_frame()\n"
    });
    const interactive = notebook("untitled:/Interactive-quarto-r-kernel.interactive", "interactive", []);
    interactive.cells.push(markupCell(interactive.document, { isInteractiveWindowMessageCell: true }));
    let interactiveEditor: NotebookEditor | undefined;
    pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
      if (id === "jupyter.execSelectionInteractive" && argument === "") {
        pythonMocks.notebookDocuments.push(interactive.document);
        fire(pythonMocks.openNotebookListeners, interactive.document);
        interactiveEditor = publishVisibleNotebookEditor(interactive.document);
        return undefined;
      }
      if (id === "notebook.selectKernel") {
        expect(argument).toEqual({ notebookEditor: interactiveEditor });
        Object.defineProperty(interactive.document, "metadata", {
          value: { metadata: { kernelspec: { language: "r" } } },
          writable: true
        });
        return undefined;
      }
      throw new Error(`Unexpected command ${id}`);
    });

    await expect(literateProvider(provider).runLiterateChunkAndOpen(origin)).resolves.toBe(false);

    expect(pythonMocks.executeCommand.mock.calls).toEqual([
      ["jupyter.execSelectionInteractive", ""],
      ["notebook.selectKernel", { notebookEditor: interactiveEditor }]
    ]);
    expect(pythonMocks.showTextDocument).not.toHaveBeenCalled();
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();
  });

  it("does not retry the one real Quarto dispatch when no cell is published", async () => {
    vi.useFakeTimers();
    try {
      const source = textDocument(
        "file:///workspace/analysis.qmd",
        "```{python}\nframe = make_frame()\n```\n",
        "quarto"
      );
      const editor = textEditor(source, 1);
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = editor;
      const origin = literateOrigin(editor, "quarto", {
        language: "python",
        executableSyntax: true,
        supportedFence: true,
        enabled: true,
        fenceCharacter: "`",
        openingLine: 0,
        codeStartLine: 1,
        codeEndLine: 1,
        closingLine: 2,
        code: "frame = make_frame()\n"
      });
      const interactive = notebook("untitled:/Interactive-quarto-detached.interactive", "interactive", []);
      interactive.cells.push(markupCell(interactive.document, { isInteractiveWindowMessageCell: true }));
      let interactiveEditor: NotebookEditor | undefined;
      let realDispatches = 0;
      pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
        if (id === "jupyter.execSelectionInteractive" && argument === "") {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          interactiveEditor = publishVisibleNotebookEditor(interactive.document);
          return undefined;
        }
        if (id === "notebook.selectKernel") {
          expect(argument).toEqual({ notebookEditor: interactiveEditor });
          Object.defineProperty(interactive.document, "metadata", {
            value: { metadata: { kernelspec: { language: "python" } } },
            writable: true
          });
          return undefined;
        }
        if (id === "jupyter.execSelectionInteractive" && argument === "frame = make_frame()\n") {
          realDispatches += 1;
          return undefined;
        }
        throw new Error(`Unexpected command ${id}`);
      });

      const opening = literateProvider(provider).runLiterateChunkAndOpen(origin);
      let settled = false;
      void opening.finally(() => {
        settled = true;
      });
      await settle();
      await settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.execSelectionInteractive",
        "notebook.selectKernel",
        "jupyter.execSelectionInteractive"
      ]);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(opening).resolves.toBe(false);

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.execSelectionInteractive",
        "notebook.selectKernel",
        "jupyter.execSelectionInteractive"
      ]);
      expect(realDispatches).toBe(1);
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("did not produce"));
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a published Quarto cell that never finishes after kernel selection", async () => {
    vi.useFakeTimers();
    const previousExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    try {
      const source = textDocument(
        "file:///workspace/analysis.qmd",
        "```{python}\nframe = make_frame()\n```\n",
        "quarto"
      );
      const editor = textEditor(source, 1);
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = editor;
      const origin = literateOrigin(editor, "quarto", {
        language: "python",
        executableSyntax: true,
        supportedFence: true,
        enabled: true,
        fenceCharacter: "`",
        openingLine: 0,
        codeStartLine: 1,
        codeEndLine: 1,
        closingLine: 2,
        code: "frame = make_frame()\n"
      });
      const interactive = notebook("untitled:/Interactive-quarto-stalled.interactive", "interactive", []);
      const systemCell = markupCell(interactive.document, { isInteractiveWindowMessageCell: true });
      interactive.cells.push(systemCell);
      let interactiveEditor: NotebookEditor | undefined;
      const cell = interactiveCell(interactive.document, source.uri.toString(), 1, "quarto-run", true, "quarto");
      Object.defineProperty(cell, "executionSummary", { value: undefined, writable: true });
      let realDispatches = 0;
      pythonMocks.executeCommand.mockImplementation(async (id: string, argument?: unknown) => {
        if (id === "jupyter.execSelectionInteractive" && argument === "") {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
          interactiveEditor = publishVisibleNotebookEditor(interactive.document);
          return undefined;
        }
        if (id === "notebook.selectKernel") {
          expect(argument).toEqual({ notebookEditor: interactiveEditor });
          Object.defineProperty(interactive.document, "metadata", {
            value: { metadata: { kernelspec: { language: "python" } } },
            writable: true
          });
          return undefined;
        }
        if (id === "jupyter.execSelectionInteractive" && argument === "frame = make_frame()\n") {
          realDispatches += 1;
          setTimeout(() => {
            interactive.cells.push(cell);
            fire(pythonMocks.changeNotebookListeners, {
              notebook: interactive.document,
              cellChanges: [{ cell, executionSummary: undefined }],
              contentChanges: []
            } as unknown as NotebookDocumentChangeEvent);
          }, 1_500);
          return undefined;
        }
        throw new Error(`Unexpected command ${id}`);
      });
      const listenerCounts = notebookListenerCounts();

      const opening = literateProvider(provider).runLiterateChunkAndOpen(origin);
      let settled = false;
      void opening.finally(() => {
        settled = true;
      });
      await settle();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(diagnosticProvider(provider).diagnosticsForTesting()).toMatchObject({
        invocation: 1,
        stage: "waiting-for-cell-completion",
        lastActiveStage: "waiting-for-cell-completion"
      });
      expect(diagnosticProvider(provider).diagnosticsForTesting()?.stages).toEqual([
        "dispatching-cell",
        "opening-interactive-editor",
        "selecting-kernel",
        "restoring-source-editor",
        "dispatching-cell",
        "waiting-for-cell-publication",
        "waiting-for-cell-completion"
      ]);
      await vi.advanceTimersByTimeAsync(118_499);
      expect(settled).toBe(false);
      expect(pythonMocks.showWarningMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(opening).resolves.toBe(false);

      expect(pythonMocks.executeCommand.mock.calls.map(([id]) => id)).toEqual([
        "jupyter.execSelectionInteractive",
        "notebook.selectKernel",
        "jupyter.execSelectionInteractive"
      ]);
      expect(realDispatches).toBe(1);
      expect(diagnosticProvider(provider).diagnosticsForTesting()).toMatchObject({
        invocation: 1,
        stage: "failed",
        lastActiveStage: "waiting-for-cell-completion"
      });
      expect(pythonMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("within two minutes"));
      expect(pythonMocks.discover).not.toHaveBeenCalled();
      expect(pythonMocks.openVariable).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(notebookListenerCounts()).toEqual(listenerCounts);
    } finally {
      if (previousExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
      else process.env.OPEN_WRANGLER_EXTENSION_TESTS = previousExtensionTests;
      vi.useRealTimers();
    }
  });
});
