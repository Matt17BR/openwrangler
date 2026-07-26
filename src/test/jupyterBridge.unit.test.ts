import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, NotebookDocument, NotebookEditor } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type { SessionCoordinator } from "../extension/sessionCoordinator";

type CommandHandler = (...args: unknown[]) => unknown;

const notebookMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  notebookDocuments: [] as NotebookDocument[],
  activeNotebookEditor: undefined as NotebookEditor | undefined,
  activeEditorReads: 0,
  showWarningMessage: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showInputBox: vi.fn(async () => undefined as string | undefined),
  createPanel: vi.fn(),
  kernelOrigins: [] as Array<{ uri: string; document: NotebookDocument | undefined }>,
  getKernel: vi.fn(async () => ({})),
  activateJupyter: vi.fn(async () => ({ kernels: { getKernel: notebookMocks.getKernel } }))
}));

vi.mock("vscode", () => {
  class Uri {
    private constructor(readonly value: string) {}
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
  return {
    Uri,
    commands: {
      registerCommand: (id: string, handler: CommandHandler) => {
        notebookMocks.commands.set(id, handler);
        return { dispose: () => undefined };
      }
    },
    window: {
      get activeNotebookEditor() {
        notebookMocks.activeEditorReads += 1;
        return notebookMocks.activeNotebookEditor;
      },
      showWarningMessage: notebookMocks.showWarningMessage,
      showInformationMessage: notebookMocks.showInformationMessage,
      showInputBox: notebookMocks.showInputBox
    },
    workspace: {
      get notebookDocuments() {
        return notebookMocks.notebookDocuments;
      }
    },
    extensions: {
      getExtension: () => ({ activate: notebookMocks.activateJupyter })
    }
  };
});

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: { create: notebookMocks.createPanel }
}));

vi.mock("../extension/notebooks/kernelBridge", () => ({
  KernelBridge: class {
    constructor(_context: ExtensionContext, document: NotebookDocument) {
      notebookMocks.kernelOrigins.push({ uri: document.uri.toString(), document });
    }
  }
}));

import * as vscode from "vscode";
import { registerNotebookCommands } from "../extension/notebooks/jupyterBridge";

describe("notebook command provenance", () => {
  beforeEach(() => {
    notebookMocks.commands.clear();
    notebookMocks.notebookDocuments.length = 0;
    notebookMocks.activeNotebookEditor = undefined;
    notebookMocks.activeEditorReads = 0;
    notebookMocks.showWarningMessage.mockClear();
    notebookMocks.showInformationMessage.mockClear();
    notebookMocks.showInputBox.mockReset();
    notebookMocks.showInputBox.mockResolvedValue(undefined);
    notebookMocks.createPanel.mockReset();
    notebookMocks.kernelOrigins.length = 0;
    notebookMocks.getKernel.mockClear();
    notebookMocks.activateJupyter.mockReset();
    notebookMocks.activateJupyter.mockResolvedValue({ kernels: { getKernel: notebookMocks.getKernel } });
  });

  it("binds a released IJupyterVariable fileName URI to the sole exact open document", async () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    notebookMocks.notebookDocuments.push(notebookA, notebookB);
    notebookMocks.activeNotebookEditor = editor(notebookB);
    const { context, coordinator, coordinatedBridge } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame_a",
      type: "DataFrame",
      fileName: notebookA.uri
    });

    expect(notebookMocks.kernelOrigins).toHaveLength(1);
    expect(notebookMocks.kernelOrigins[0]?.document).toBe(notebookA);
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(notebookA);
    expect(notebookMocks.createPanel).toHaveBeenCalledWith(context, coordinatedBridge, {
      kind: "notebookVariable",
      label: "frame_a",
      variableName: "frame_a",
      uri: notebookA.uri.toString()
    });
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it("binds a variable-viewer URI to its exact open document instead of the active notebook", async () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    notebookMocks.notebookDocuments.push(notebookA, notebookB);
    notebookMocks.activeNotebookEditor = editor(notebookB);
    const { context, coordinator, coordinatedBridge } = register();

    await command("openWrangler.launchDataViewer")({
      variableName: "frame_a",
      notebookUri: notebookA.uri
    });

    expect(notebookMocks.kernelOrigins).toEqual([{ uri: notebookA.uri.toString(), document: notebookA }]);
    expect(coordinator.createBridge).toHaveBeenCalledWith(expect.anything(), notebookA);
    expect(notebookMocks.createPanel).toHaveBeenCalledWith(context, coordinatedBridge, {
      kind: "notebookVariable",
      label: "frame_a",
      variableName: "frame_a",
      uri: notebookA.uri.toString()
    });
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it("accepts agreeing released and legacy origin fields", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const active = notebook("file:///workspace/active.ipynb");
    notebookMocks.notebookDocuments.push(original, active);
    notebookMocks.activeNotebookEditor = editor(active);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame",
      fileName: vscode.Uri.parse(original.uri.toString()),
      notebookUri: vscode.Uri.parse(original.uri.toString()),
      uri: vscode.Uri.parse(original.uri.toString())
    });

    expect(notebookMocks.kernelOrigins).toHaveLength(1);
    expect(notebookMocks.kernelOrigins[0]?.document).toBe(original);
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it.each(["fileName", "notebookUri", "uri"] as const)(
    "rejects a string %s without falling back to the active notebook",
    async (field) => {
      const active = notebook("file:///workspace/active.ipynb");
      notebookMocks.notebookDocuments.push(active);
      notebookMocks.activeNotebookEditor = editor(active);
      const { coordinator } = register();

      await command("openWrangler.launchDataViewer")({
        name: "frame",
        [field]: active.uri.toString()
      });

      expect(coordinator.createBridge).not.toHaveBeenCalled();
      expect(notebookMocks.kernelOrigins).toEqual([]);
      expect(notebookMocks.createPanel).not.toHaveBeenCalled();
      expect(notebookMocks.activeEditorReads).toBe(0);
      expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
        "Open Wrangler received an invalid originating notebook. Launch the variable again from its notebook."
      );
    }
  );

  it("rejects conflicting released and legacy origin fields", async () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    notebookMocks.notebookDocuments.push(notebookA, notebookB);
    notebookMocks.activeNotebookEditor = editor(notebookB);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame",
      fileName: notebookA.uri,
      notebookUri: notebookB.uri
    });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.kernelOrigins).toEqual([]);
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.activeEditorReads).toBe(0);
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler received more than one originating notebook. Launch the variable again from one notebook."
    );
  });

  it("rejects a released variable when two open documents share its fileName URI", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const duplicate = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original, duplicate);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({ name: "frame", fileName: original.uri });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler could not identify one originating notebook. Close duplicate notebook views and try again."
    );
  });

  it("rejects a released variable whose fileName has no open document without using the active notebook", async () => {
    const missing = notebook("file:///workspace/missing.ipynb");
    const active = notebook("file:///workspace/active.ipynb");
    notebookMocks.notebookDocuments.push(active);
    notebookMocks.activeNotebookEditor = editor(active);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({ name: "frame", fileName: missing.uri });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.kernelOrigins).toEqual([]);
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and try again."
    );
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it("does not retarget a released variable after its captured document is replaced", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const replacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    const argument = {
      fileName: original.uri,
      get name(): string {
        closeNotebook(original);
        notebookMocks.notebookDocuments.splice(0, 1, replacement);
        notebookMocks.activeNotebookEditor = editor(replacement);
        return "frame";
      }
    };
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")(argument);

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.kernelOrigins).toEqual([]);
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and try again."
    );
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it("rejects an active notebook when another open document shares its URI", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const overlappingReplacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original, overlappingReplacement);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.showInputBox).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.kernelOrigins).toEqual([]);
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
  });

  it("does not retarget the interactive command after its captured document closes and reopens", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const replacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.showInputBox.mockImplementationOnce(async () => {
      closeNotebook(original);
      notebookMocks.notebookDocuments.splice(0, 1, replacement);
      notebookMocks.activeNotebookEditor = editor(replacement);
      return "frame";
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
    let resolveKernel!: (kernel: object) => void;
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
    resolveKernel({});
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
    let resolveKernel!: (kernel: object) => void;
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
    resolveKernel({});
    await checking;

    expect(notebookMocks.showInformationMessage).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
    );
  });
});

function register(): {
  context: ExtensionContext;
  coordinator: { createBridge: ReturnType<typeof vi.fn> };
  coordinatedBridge: OpenWranglerBridge;
} {
  const context = { subscriptions: [] } as unknown as ExtensionContext;
  const coordinatedBridge = {} as OpenWranglerBridge;
  const coordinator = { createBridge: vi.fn(() => coordinatedBridge) };
  registerNotebookCommands(context, coordinator as unknown as SessionCoordinator);
  return { context, coordinator, coordinatedBridge };
}

function command(id: string): CommandHandler {
  const handler = notebookMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}

function notebook(uri: string): NotebookDocument {
  return { uri: vscode.Uri.parse(uri), isClosed: false } as unknown as NotebookDocument;
}

function closeNotebook(document: NotebookDocument): void {
  Object.defineProperty(document, "isClosed", { configurable: true, value: true });
}

function editor(document: NotebookDocument): NotebookEditor {
  return { notebook: document } as NotebookEditor;
}
