import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeNotebook,
  command,
  editor,
  jupyterBridgeMocks,
  notebook,
  register,
  resetNotebookCommandTest
} from "./jupyterBridge.testSupport";

const notebookMocks = jupyterBridgeMocks();

describe("notebook command lifecycle provenance", () => {
  beforeEach(resetNotebookCommandTest);

  it("does not retarget the interactive command after its captured document closes and reopens", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const replacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.showQuickPick.mockImplementationOnce(async (items) => {
      closeNotebook(original);
      notebookMocks.notebookDocuments.splice(0, 1, replacement);
      notebookMocks.activeNotebookEditor = editor(replacement);
      return items[0];
    });
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.kernelOrigins).toEqual([]);
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and try again."
    );
    expect(notebookMocks.activeEditorReads).toBe(1);
  });

  it("does not check a replacement notebook after Jupyter activation closes the captured document", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const replacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.activateJupyter.mockImplementationOnce(async () => {
      closeNotebook(original);
      notebookMocks.notebookDocuments.splice(0, 1, replacement);
      notebookMocks.activeNotebookEditor = editor(replacement);
      return { kernels: { getKernel: notebookMocks.getKernel } };
    });
    register();

    await command("openWrangler.checkJupyterIntegration")();

    expect(notebookMocks.getKernel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
    );
    expect(notebookMocks.activeEditorReads).toBe(1);
  });

  it("discards a kernel lookup when the captured notebook closes before it resolves", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const replacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    let resolveKernel!: (kernel: Awaited<ReturnType<typeof notebookMocks.getKernel>>) => void;
    notebookMocks.getKernel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveKernel = resolve;
        })
    );
    register();

    const checking = command("openWrangler.checkJupyterIntegration")();
    await vi.waitFor(() => expect(notebookMocks.getKernel).toHaveBeenCalledWith(original.uri));
    closeNotebook(original);
    notebookMocks.notebookDocuments.splice(0, 1, replacement);
    notebookMocks.activeNotebookEditor = editor(replacement);
    resolveKernel({
      language: "python",
      executeCode: notebookMocks.executeCode
    });
    await checking;

    expect(notebookMocks.showInformationMessage).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
    );
    expect(notebookMocks.activeEditorReads).toBe(1);
  });

  it("discards a kernel lookup when a same-URI document overlaps before it resolves", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const overlappingReplacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    let resolveKernel!: (kernel: Awaited<ReturnType<typeof notebookMocks.getKernel>>) => void;
    notebookMocks.getKernel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveKernel = resolve;
        })
    );
    register();

    const checking = command("openWrangler.checkJupyterIntegration")();
    await vi.waitFor(() => expect(notebookMocks.getKernel).toHaveBeenCalledWith(original.uri));
    notebookMocks.notebookDocuments.push(overlappingReplacement);
    resolveKernel({
      language: "python",
      executeCode: notebookMocks.executeCode
    });
    await checking;

    expect(notebookMocks.showInformationMessage).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
    );
  });
});
