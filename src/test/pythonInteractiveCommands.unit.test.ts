import { beforeEach, describe, expect, it } from "vitest";
import type { NotebookDocumentChangeEvent, NotebookEditor, TextDocument } from "vscode";
import type { RNotebookVariableDiscovery } from "../extension/r/rNotebookVariableDiscovery";
import {
  vscodeApi,
  pythonInteractiveMocks,
  setupPythonInteractiveTest,
  command,
  diagnosticProvider,
  fire,
  settle,
  textDocument,
  textEditor,
  notebook,
  interactiveCell,
  pandasFrame,
  polarsFrame,
  type PythonInteractiveTestContext
} from "./pythonInteractiveCommands.testSupport";

const pythonMocks = pythonInteractiveMocks();
const vscode = vscodeApi();

describe("Python Interactive Window coordinator and discovery", () => {
  let context: PythonInteractiveTestContext["context"];
  let provider: PythonInteractiveTestContext["provider"];
  let coordinator: PythonInteractiveTestContext["coordinator"];

  beforeEach(() => {
    ({ context, provider, coordinator } = setupPythonInteractiveTest());
  });

  it("rolls back the real provider and every retained command when grouped registration fails", () => {
    for (const subscription of context.subscriptions) subscription.dispose();

    expect(() => setupPythonInteractiveTest(2)).toThrow("Python registration failed");

    expect(pythonMocks.commands.size).toBe(0);
    expect(pythonMocks.lastContext?.subscriptions).toEqual([]);
    expect(pythonMocks.activeTextListeners.size).toBe(0);
    expect(pythonMocks.activeNotebookListeners.size).toBe(0);
    expect(pythonMocks.visibleNotebookListeners.size).toBe(0);
    expect(pythonMocks.openNotebookListeners.size).toBe(0);
    expect(pythonMocks.closeNotebookListeners.size).toBe(0);
    expect(pythonMocks.changeNotebookListeners.size).toBe(0);
  });

  it("rolls back real constructor listeners when a later listener registration throws", () => {
    for (const subscription of context.subscriptions) subscription.dispose();

    expect(() => setupPythonInteractiveTest(undefined, 3)).toThrow("Python listener registration failed");

    expect(pythonMocks.lastContext?.subscriptions).toEqual([]);
    expect(pythonMocks.activeNotebookListeners.size).toBe(0);
    expect(pythonMocks.activeTextListeners.size).toBe(0);
    expect(pythonMocks.openNotebookListeners.size).toBe(0);
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

  it("starts a bounded diagnostic history for each test invocation", async () => {
    const previousExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    try {
      const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
      pythonMocks.textDocuments.push(source);
      pythonMocks.activeTextEditor = textEditor(source, 1);
      const interactive = notebook("untitled:/Interactive-diagnostics.interactive", "interactive", []);
      let invocation = 0;
      pythonMocks.executeCommand.mockImplementation(async (id: string) => {
        if (id !== "jupyter.runcurrentcell") return undefined;
        invocation += 1;
        const cell = interactiveCell(interactive.document, source.uri.toString(), 0, `run-${invocation}`, true);
        interactive.cells.push(cell);
        if (!pythonMocks.notebookDocuments.includes(interactive.document)) {
          pythonMocks.notebookDocuments.push(interactive.document);
          fire(pythonMocks.openNotebookListeners, interactive.document);
        }
        fire(pythonMocks.changeNotebookListeners, {
          notebook: interactive.document,
          cellChanges: [{ cell, executionSummary: cell.executionSummary }],
          contentChanges: []
        } as unknown as NotebookDocumentChangeEvent);
        return undefined;
      });
      pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("frame")], truncated: false });

      await command("openWrangler.runPythonCellAndOpenVariable")();
      expect(diagnosticProvider(provider).diagnosticsForTesting()).toMatchObject({
        invocation: 1,
        stage: "complete",
        lastActiveStage: "opening-variable"
      });

      await command("openWrangler.runPythonCellAndOpenVariable")();
      const diagnostics = diagnosticProvider(provider).diagnosticsForTesting();
      expect(diagnostics).toMatchObject({ invocation: 2, stage: "complete", lastActiveStage: "opening-variable" });
      expect(diagnostics?.stages[0]).toBe("dispatching-cell");
      expect(diagnostics?.stages.at(-1)).toBe("complete");
      expect(diagnostics?.stages.length).toBeLessThanOrEqual(16);
    } finally {
      if (previousExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
      else process.env.OPEN_WRANGLER_EXTENSION_TESTS = previousExtensionTests;
    }
  });

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

  it("leaves a foreign provider's kernel untouched until an explicit refresh", async () => {
    const active = notebook("file:///workspace/foreign-provider.ipynb", "jupyter-notebook", [], "python");
    pythonMocks.notebookDocuments.push(active.document);
    pythonMocks.activeNotebookEditor = { notebook: active.document } as NotebookEditor;
    pythonMocks.inspectNotebookAutomatically = false;
    pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("frame")], truncated: false });

    fire(pythonMocks.activeNotebookListeners, pythonMocks.activeNotebookEditor);
    await settle();

    fire(pythonMocks.changeNotebookListeners, {
      notebook: active.document,
      cellChanges: [{ executionSummary: { success: true, timing: { startTime: 1, endTime: 2 } } }],
      contentChanges: []
    } as unknown as NotebookDocumentChangeEvent);
    await settle();

    expect(pythonMocks.discover).not.toHaveBeenCalled();
    expect(provider.snapshot()).toMatchObject({
      state: "empty",
      notebookLabel: "foreign-provider.ipynb",
      message: expect.stringContaining("Automatic notebook inspection is paused"),
      variables: []
    });

    await command("openWrangler.refreshNotebookVariables")();

    expect(pythonMocks.discover).toHaveBeenCalledOnce();
    expect(pythonMocks.discover).toHaveBeenCalledWith(active.document);
    expect(provider.snapshot()).toMatchObject({
      state: "ready",
      variables: [expect.objectContaining({ label: "frame" })]
    });
  });

  it("does not let an in-flight automatic discovery overwrite foreign-provider pause state", async () => {
    const active = notebook("file:///workspace/provider-switch.ipynb", "jupyter-notebook", [], "python");
    pythonMocks.notebookDocuments.push(active.document);
    pythonMocks.activeNotebookEditor = { notebook: active.document } as NotebookEditor;
    pythonMocks.discover.mockResolvedValue({ variables: [pandasFrame("initial")], truncated: false });

    fire(pythonMocks.activeNotebookListeners, pythonMocks.activeNotebookEditor);
    await settle();

    const staleHandle = provider.snapshot()?.variables[0]?.handle;
    expect(staleHandle).toBeDefined();

    let releaseLateDiscovery!: () => void;
    const lateDiscovery = new Promise<{ variables: ReturnType<typeof pandasFrame>[]; truncated: false }>((resolve) => {
      releaseLateDiscovery = () => resolve({ variables: [pandasFrame("late")], truncated: false });
    });
    pythonMocks.discover.mockReturnValueOnce(lateDiscovery);
    fire(pythonMocks.changeNotebookListeners, {
      notebook: active.document,
      cellChanges: [{ executionSummary: { success: true } }],
      contentChanges: []
    } as unknown as NotebookDocumentChangeEvent);
    expect(pythonMocks.discover).toHaveBeenCalledTimes(2);

    pythonMocks.inspectNotebookAutomatically = false;
    fire(pythonMocks.changeNotebookListeners, {
      notebook: active.document,
      cellChanges: [{ executionSummary: { success: true } }],
      contentChanges: []
    } as unknown as NotebookDocumentChangeEvent);
    await settle();

    expect(provider.snapshot()).toMatchObject({
      state: "empty",
      message: expect.stringContaining("Automatic notebook inspection is paused"),
      variables: []
    });
    await command("openWrangler.openCachedNotebookVariable")(staleHandle);
    expect(pythonMocks.openVariable).not.toHaveBeenCalled();

    releaseLateDiscovery();
    await settle();

    expect(pythonMocks.discover).toHaveBeenCalledTimes(2);
    expect(provider.snapshot()).toMatchObject({
      state: "empty",
      message: expect.stringContaining("Automatic notebook inspection is paused"),
      variables: []
    });
  });

  it("queues an explicit refresh behind in-flight automatic discovery without losing its mode", async () => {
    const active = notebook("file:///workspace/queued-explicit-refresh.ipynb", "jupyter-notebook", [], "python");
    pythonMocks.notebookDocuments.push(active.document);
    pythonMocks.activeNotebookEditor = { notebook: active.document } as NotebookEditor;

    let releaseAutomaticDiscovery!: () => void;
    const automaticDiscovery = new Promise<{
      variables: ReturnType<typeof pandasFrame>[];
      truncated: false;
    }>((resolve) => {
      releaseAutomaticDiscovery = () => resolve({ variables: [pandasFrame("automatic")], truncated: false });
    });
    let releaseExplicitDiscovery!: () => void;
    const explicitDiscovery = new Promise<{
      variables: ReturnType<typeof pandasFrame>[];
      truncated: false;
    }>((resolve) => {
      releaseExplicitDiscovery = () => resolve({ variables: [pandasFrame("explicit")], truncated: false });
    });
    pythonMocks.discover.mockReturnValueOnce(automaticDiscovery).mockReturnValueOnce(explicitDiscovery);

    fire(pythonMocks.activeNotebookListeners, pythonMocks.activeNotebookEditor);
    await settle();
    expect(pythonMocks.discover).toHaveBeenCalledOnce();

    pythonMocks.inspectNotebookAutomatically = false;
    let refreshSettled = false;
    const refresh = Promise.resolve(command("openWrangler.refreshNotebookVariables")());
    void refresh.then(() => {
      refreshSettled = true;
    });
    await settle();

    expect(refreshSettled).toBe(false);
    expect(pythonMocks.discover).toHaveBeenCalledOnce();

    releaseAutomaticDiscovery();
    await settle();

    expect(refreshSettled).toBe(false);
    expect(pythonMocks.discover).toHaveBeenCalledTimes(2);
    expect(provider.snapshot()).toMatchObject({
      state: "empty",
      message: expect.stringContaining("Automatic notebook inspection is paused"),
      variables: []
    });

    releaseExplicitDiscovery();
    await refresh;

    expect(refreshSettled).toBe(true);
    expect(pythonMocks.discover).toHaveBeenCalledTimes(2);
    expect(provider.snapshot()).toMatchObject({
      state: "ready",
      variables: [expect.objectContaining({ label: "explicit" })]
    });
  });

  it("does not carry explicit mode into an automatic refresh queued during explicit discovery", async () => {
    const active = notebook("file:///workspace/queued-automatic-refresh.ipynb", "jupyter-notebook", [], "python");
    pythonMocks.notebookDocuments.push(active.document);
    pythonMocks.activeNotebookEditor = { notebook: active.document } as NotebookEditor;

    let releaseExplicitDiscovery!: () => void;
    const explicitDiscovery = new Promise<{
      variables: ReturnType<typeof pandasFrame>[];
      truncated: false;
    }>((resolve) => {
      releaseExplicitDiscovery = () => resolve({ variables: [pandasFrame("explicit")], truncated: false });
    });
    pythonMocks.discover
      .mockResolvedValueOnce({ variables: [pandasFrame("initial")], truncated: false })
      .mockReturnValueOnce(explicitDiscovery);

    fire(pythonMocks.activeNotebookListeners, pythonMocks.activeNotebookEditor);
    await settle();
    expect(pythonMocks.discover).toHaveBeenCalledOnce();

    const refresh = Promise.resolve(command("openWrangler.refreshNotebookVariables")());
    await settle();
    expect(pythonMocks.discover).toHaveBeenCalledTimes(2);

    fire(pythonMocks.changeNotebookListeners, {
      notebook: active.document,
      cellChanges: [{ executionSummary: { success: true } }],
      contentChanges: []
    } as unknown as NotebookDocumentChangeEvent);
    pythonMocks.inspectNotebookAutomatically = false;
    releaseExplicitDiscovery();
    await refresh;

    expect(pythonMocks.discover).toHaveBeenCalledTimes(2);
    expect(provider.snapshot()).toMatchObject({
      state: "empty",
      message: expect.stringContaining("Automatic notebook inspection is paused"),
      variables: []
    });
  });

  it("associates a Python source with its first externally executed Interactive cell", async () => {
    const source = textDocument("file:///workspace/analysis.py", "# %%\nframe = make_frame()\n");
    pythonMocks.textDocuments.push(source);
    pythonMocks.activeTextEditor = textEditor(source, 1);
    fire(pythonMocks.activeTextListeners, pythonMocks.activeTextEditor);

    const interactive = notebook("untitled:/Interactive-first-run.interactive", "interactive", []);
    pythonMocks.notebookDocuments.push(interactive.document);
    fire(pythonMocks.openNotebookListeners, interactive.document);
    await settle();
    expect(provider.snapshot()).toBeUndefined();

    const frame = pandasFrame("frame");
    pythonMocks.discover.mockResolvedValue({ variables: [frame], truncated: false });
    const executed = interactiveCell(interactive.document, source.uri.toString(), 0, "first-run", true);
    interactive.cells.push(executed);
    fire(pythonMocks.changeNotebookListeners, {
      notebook: interactive.document,
      contentChanges: [{ addedCells: [executed], removedCells: [] }],
      cellChanges: [{ cell: executed, executionSummary: executed.executionSummary }]
    } as unknown as NotebookDocumentChangeEvent);
    await settle();

    expect(pythonMocks.discover).toHaveBeenCalledWith(interactive.document);
    const snapshot = provider.snapshot();
    expect(snapshot).toEqual(
      expect.objectContaining({
        state: "ready",
        variables: [expect.objectContaining({ label: "frame", description: "Pandas · DataFrame" })]
      })
    );

    await command("openWrangler.openCachedNotebookVariable")(snapshot?.variables[0]?.handle);
    expect(pythonMocks.openVariable).toHaveBeenCalledWith(context, coordinator, interactive.document, frame);
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
