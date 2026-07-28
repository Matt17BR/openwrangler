import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, NotebookDocument, NotebookEditor } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type { SessionCoordinator } from "../extension/sessionCoordinator";

type CommandHandler = (...args: unknown[]) => unknown;

const notebookMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  notebookDocuments: [] as NotebookDocument[],
  activeNotebookEditor: undefined as NotebookEditor | undefined,
  activeTabInput: undefined as unknown,
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
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    private readonly filesystemPath: string;
    private formatted = false;
    private filesystemPathRead = false;

    private constructor(
      readonly value: string,
      components?: {
        scheme: string;
        authority?: string;
        path?: string;
        query?: string;
        fragment?: string;
      }
    ) {
      const parsed = components ?? uriComponents(value);
      this.scheme = parsed.scheme;
      this.authority = parsed.authority ?? "";
      this.path = parsed.path ?? "";
      this.query = parsed.query ?? "";
      this.fragment = parsed.fragment ?? "";
      this.filesystemPath = this.path;
    }
    static parse(value: string): Uri {
      return new Uri(value);
    }
    static file(path: string): Uri {
      return new Uri(`file://${path}`);
    }
    static from(components: {
      scheme: string;
      authority?: string;
      path?: string;
      query?: string;
      fragment?: string;
    }): Uri {
      return new Uri(uriString(components), components);
    }
    get fsPath(): string {
      this.filesystemPathRead = true;
      return this.filesystemPath;
    }
    toString(): string {
      this.formatted = true;
      return this.value;
    }
    toJSON(): Record<string, unknown> {
      return {
        $mid: 1,
        ...(this.filesystemPathRead
          ? {
              fsPath: this.filesystemPath,
              ...(process.platform === "win32" ? { _sep: 1 } : {})
            }
          : {}),
        ...(this.formatted ? { external: this.value } : {}),
        ...(this.path ? { path: this.path } : {}),
        ...(this.scheme ? { scheme: this.scheme } : {}),
        ...(this.authority ? { authority: this.authority } : {}),
        ...(this.query ? { query: this.query } : {}),
        ...(this.fragment ? { fragment: this.fragment } : {})
      };
    }
  }
  class TabInputNotebook {
    constructor(
      readonly uri: Uri,
      readonly notebookType = "jupyter-notebook"
    ) {}
  }
  function uriComponents(value: string): {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  } {
    const parsed = new URL(value);
    return {
      scheme: parsed.protocol.slice(0, -1),
      authority: parsed.host || undefined,
      path: parsed.pathname,
      query: parsed.search.slice(1) || undefined,
      fragment: parsed.hash.slice(1) || undefined
    };
  }
  function uriString(components: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): string {
    const authority = components.authority ? `//${components.authority}` : components.scheme === "file" ? "//" : "";
    const query = components.query ? `?${components.query}` : "";
    const fragment = components.fragment ? `#${components.fragment}` : "";
    return `${components.scheme}:${authority}${components.path ?? ""}${query}${fragment}`;
  }
  return {
    Uri,
    TabInputNotebook,
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
      tabGroups: {
        activeTabGroup: {
          get activeTab() {
            return notebookMocks.activeTabInput === undefined ? undefined : { input: notebookMocks.activeTabInput };
          }
        }
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
    notebookMocks.activeTabInput = undefined;
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

  it.each([
    "pyspark.sql.dataframe.DataFrame",
    "pyspark.sql.classic.dataframe.DataFrame",
    "pyspark.sql.connect.dataframe.DataFrame"
  ])("pins the %s Variables-view type to the PySpark backend", async (type) => {
    const origin = notebook("file:///workspace/spark.ipynb");
    notebookMocks.notebookDocuments.push(origin);
    const { context, coordinatedBridge } = register();

    await command("openWrangler.launchDataViewer")({
      name: "spark_frame",
      type,
      fileName: origin.uri
    });

    expect(notebookMocks.createPanel).toHaveBeenCalledWith(
      context,
      coordinatedBridge,
      {
        kind: "notebookVariable",
        label: "spark_frame",
        variableName: "spark_frame",
        uri: origin.uri.toString()
      },
      "pyspark"
    );
  });

  it("does not infer PySpark from an unrecognized or lookalike Variables-view type", async () => {
    const origin = notebook("file:///workspace/frame.ipynb");
    notebookMocks.notebookDocuments.push(origin);
    const { context, coordinatedBridge } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame",
      type: "custom.pyspark.sql.dataframe.DataFrame",
      fileName: origin.uri
    });

    expect(notebookMocks.createPanel).toHaveBeenCalledWith(context, coordinatedBridge, {
      kind: "notebookVariable",
      label: "frame",
      variableName: "frame",
      uri: origin.uri.toString()
    });
  });

  it("revives released Jupyter's canonical serialized fileName URI", async () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    notebookMocks.notebookDocuments.push(notebookA, notebookB);
    notebookMocks.activeNotebookEditor = editor(notebookB);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame_a",
      type: "DataFrame",
      fileName: serializedFileUri("/workspace/a.ipynb")
    });

    expect(notebookMocks.kernelOrigins).toEqual([{ uri: notebookA.uri.toString(), document: notebookA }]);
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(notebookA);
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it("accepts matching canonical cached fields in a serialized released-Jupyter fileName", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame",
      fileName: {
        ...serializedFileUri("/workspace/shared.ipynb"),
        external: "file:///workspace/shared.ipynb",
        fsPath: "/workspace/shared.ipynb",
        ...(process.platform === "win32" ? { _sep: 1 } : {})
      }
    });

    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
  });

  it.each([
    ["external", { external: "file:///workspace/shared.ipynb" }],
    [
      "filesystem",
      {
        fsPath: "/workspace/shared.ipynb",
        ...(process.platform === "win32" ? { _sep: 1 } : {})
      }
    ]
  ])("accepts a canonical serialized fileName with only its %s cache", async (_label, cache) => {
    const original = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame",
      fileName: { ...serializedFileUri("/workspace/shared.ipynb"), ...cache }
    });

    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
  });

  it("revives a remote serialized fileName without dropping authority, query, or fragment", async () => {
    const original = notebook("vscode-remote://ssh-remote+host/workspace/shared.ipynb?kernel=remote#cell");
    notebookMocks.notebookDocuments.push(original);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame",
      fileName: {
        $mid: 1,
        scheme: "vscode-remote",
        authority: "ssh-remote+host",
        path: "/workspace/shared.ipynb",
        query: "kernel=remote",
        fragment: "cell"
      }
    });

    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
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

  it("accepts an agreeing serialized released origin and real legacy origin", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const active = notebook("file:///workspace/active.ipynb");
    notebookMocks.notebookDocuments.push(original, active);
    notebookMocks.activeNotebookEditor = editor(active);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame",
      fileName: serializedFileUri("/workspace/shared.ipynb"),
      notebookUri: vscode.Uri.parse(original.uri.toString())
    });

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

  it.each(["notebookUri", "uri"] as const)(
    "rejects a serialized %s legacy field without falling back to the active notebook",
    async (field) => {
      const active = notebook("file:///workspace/active.ipynb");
      notebookMocks.notebookDocuments.push(active);
      notebookMocks.activeNotebookEditor = editor(active);
      const { coordinator } = register();

      await command("openWrangler.launchDataViewer")({
        name: "frame",
        [field]: serializedFileUri("/workspace/active.ipynb")
      });

      expect(coordinator.createBridge).not.toHaveBeenCalled();
      expect(notebookMocks.activeEditorReads).toBe(0);
      expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
        "Open Wrangler received an invalid originating notebook. Launch the variable again from its notebook."
      );
    }
  );

  it.each([
    ["missing marker", { scheme: "file", path: "/workspace/a.ipynb" }],
    ["wrong marker", { $mid: 2, scheme: "file", path: "/workspace/a.ipynb" }],
    ["missing scheme", { $mid: 1, path: "/workspace/a.ipynb" }],
    ["empty path", { $mid: 1, scheme: "file", path: "" }],
    ["unknown key", { $mid: 1, scheme: "file", path: "/workspace/a.ipynb", surprise: true }],
    ["wrong component type", { $mid: 1, scheme: "file", path: 42 }],
    ["explicit undefined component", { $mid: 1, scheme: "file", path: "/workspace/a.ipynb", query: undefined }],
    ["control character", { $mid: 1, scheme: "file", path: "/workspace/\n.ipynb" }],
    ["malformed high surrogate", { $mid: 1, scheme: "file", path: "/workspace/\ud800.ipynb" }],
    ["malformed low surrogate", { $mid: 1, scheme: "file", path: "/workspace/\udc00.ipynb" }],
    ["multibyte overflow", { $mid: 1, scheme: "file", path: `/${"😀".repeat(2_048)}` }],
    [
      "mismatched external cache",
      {
        $mid: 1,
        scheme: "file",
        path: "/workspace/a.ipynb",
        external: "file:///workspace/b.ipynb"
      }
    ],
    [
      "mismatched filesystem cache",
      { $mid: 1, scheme: "file", path: "/workspace/a.ipynb", fsPath: "/workspace/b.ipynb" }
    ],
    ["separator without filesystem cache", { $mid: 1, scheme: "file", path: "/workspace/a.ipynb", _sep: 1 }]
  ])("rejects a serialized fileName with %s", async (_label, fileName) => {
    const active = notebook("file:///workspace/a.ipynb");
    notebookMocks.notebookDocuments.push(active);
    notebookMocks.activeNotebookEditor = editor(active);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({ name: "frame", fileName });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.activeEditorReads).toBe(0);
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler received an invalid originating notebook. Launch the variable again from its notebook."
    );
  });

  it("rejects an oversized serialized fileName before consulting the active notebook", async () => {
    const active = notebook("file:///workspace/a.ipynb");
    notebookMocks.notebookDocuments.push(active);
    notebookMocks.activeNotebookEditor = editor(active);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({
      name: "frame",
      fileName: serializedFileUri(`/${"a".repeat(32 * 1024)}`)
    });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it("rejects a top-level serialized URI instead of treating it as missing provenance", async () => {
    const active = notebook("file:///workspace/a.ipynb");
    notebookMocks.notebookDocuments.push(active);
    notebookMocks.activeNotebookEditor = editor(active);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")(serializedFileUri("/workspace/a.ipynb"), {
      name: "frame"
    });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.activeEditorReads).toBe(0);
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler received an invalid originating notebook. Launch the variable again from its notebook."
    );
  });

  it("rejects an accessor-bearing serialized fileName without invoking the accessor", async () => {
    const active = notebook("file:///workspace/a.ipynb");
    notebookMocks.notebookDocuments.push(active);
    notebookMocks.activeNotebookEditor = editor(active);
    const { coordinator } = register();
    const fileName = serializedFileUri("/workspace/a.ipynb");
    const schemeGetter = vi.fn(() => "file");
    Object.defineProperty(fileName, "scheme", { enumerable: true, get: schemeGetter });

    await command("openWrangler.launchDataViewer")({ name: "frame", fileName });

    expect(schemeGetter).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it.each([
    [
      "null prototype",
      Object.assign(Object.create(null) as Record<string, unknown>, serializedFileUri("/workspace/a.ipynb"))
    ],
    [
      "custom prototype",
      Object.assign(
        Object.create({ inherited: true }) as Record<string, unknown>,
        serializedFileUri("/workspace/a.ipynb")
      )
    ],
    ["frozen properties", Object.freeze(serializedFileUri("/workspace/a.ipynb"))]
  ])("rejects a serialized fileName with %s", async (_label, fileName) => {
    const active = notebook("file:///workspace/a.ipynb");
    notebookMocks.notebookDocuments.push(active);
    notebookMocks.activeNotebookEditor = editor(active);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({ name: "frame", fileName });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it("rejects a symbol-bearing serialized fileName", async () => {
    const active = notebook("file:///workspace/a.ipynb");
    notebookMocks.notebookDocuments.push(active);
    notebookMocks.activeNotebookEditor = editor(active);
    const { coordinator } = register();
    const fileName = serializedFileUri("/workspace/a.ipynb");
    Object.defineProperty(fileName, Symbol("hidden"), { enumerable: true, value: true });

    await command("openWrangler.launchDataViewer")({ name: "frame", fileName });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

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

  it("opens the exact active notebook tab when toolbar focus clears the active notebook editor", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(original.uri, "jupyter-notebook");
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")({
      ui: true,
      notebookEditor: { private: true },
      source: "notebookToolbar"
    });

    expect(notebookMocks.showInputBox).toHaveBeenCalledOnce();
    expect(notebookMocks.kernelOrigins).toEqual([{ uri: original.uri.toString(), document: original }]);
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
  });

  it("rejects disagreeing public active-editor and active-tab notebook origins", async () => {
    const editorNotebook = notebook("file:///workspace/editor.ipynb");
    const tabNotebook = notebook("file:///workspace/tab.ipynb");
    notebookMocks.notebookDocuments.push(editorNotebook, tabNotebook);
    notebookMocks.activeNotebookEditor = editor(editorNotebook);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(tabNotebook.uri, "jupyter-notebook");
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.showInputBox).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler could not identify one active notebook. Return to one notebook and try again."
    );
  });

  it("rejects a direct interactive origin that disagrees with the active notebook", async () => {
    const explicitNotebook = notebook("file:///workspace/explicit.ipynb");
    const activeNotebook = notebook("file:///workspace/active.ipynb");
    notebookMocks.notebookDocuments.push(explicitNotebook, activeNotebook);
    notebookMocks.activeNotebookEditor = editor(activeNotebook);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(activeNotebook.uri, "jupyter-notebook");
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")(explicitNotebook.uri);

    expect(notebookMocks.showInputBox).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler could not identify one active notebook. Return to one notebook and try again."
    );
  });

  it("accepts a direct interactive origin that agrees with the active notebook", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(original.uri, "jupyter-notebook");
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")(vscode.Uri.parse(original.uri.toString()));

    expect(notebookMocks.showInputBox).toHaveBeenCalledOnce();
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
  });

  it("rejects a non-notebook active tab instead of falling back to a stale notebook editor", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.activeTabInput = { uri: vscode.Uri.parse("file:///workspace/source.py") };
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.showInputBox).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler could not identify one active notebook. Return to one notebook and try again."
    );
  });

  it("rejects duplicate active-tab notebook documents before prompting", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const duplicate = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original, duplicate);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(original.uri, "jupyter-notebook");
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.showInputBox).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler could not identify one active notebook. Close duplicate notebook views and try again."
    );
  });

  it("rejects an active notebook tab whose public notebook type does not match the document", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(original.uri, "different-notebook-type");
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.showInputBox).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler could not identify one active notebook. Return to one notebook and try again."
    );
  });

  it("rejects matching non-Jupyter editor and tab origins", async () => {
    const original = notebook("file:///workspace/shared.ipynb", "quarto-notebook");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(original.uri, "quarto-notebook");
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.showInputBox).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler could not identify one active notebook. Return to one notebook and try again."
    );
  });

  it("rejects a direct non-Jupyter notebook origin without active editor or tab state", async () => {
    const original = notebook("file:///workspace/shared.ipynb", "quarto-notebook");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")(original.uri);

    expect(notebookMocks.showInputBox).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler could not identify one active notebook. Return to one notebook and try again."
    );
  });

  it("ignores private toolbar context properties while resolving from public active state", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(original.uri, "jupyter-notebook");
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const privateEditorGetter = vi.fn(() => {
      throw new Error("private notebook editor context must not be read");
    });
    const toolbarContext = { ui: true, source: "notebookToolbar" };
    Object.defineProperty(toolbarContext, "notebookEditor", { get: privateEditorGetter });
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")(toolbarContext);

    expect(privateEditorGetter).not.toHaveBeenCalled();
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
  });

  it("ignores URI-like properties on private toolbar context objects", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(original.uri, "jupyter-notebook");
    notebookMocks.showInputBox.mockResolvedValue("frame");
    const uriGetter = vi.fn(() => vscode.Uri.parse("file:///workspace/private.ipynb"));
    const toolbarContext = { ui: true, source: "notebookToolbar" };
    Object.defineProperty(toolbarContext, "uri", { get: uriGetter });
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")(toolbarContext);

    expect(uriGetter).not.toHaveBeenCalled();
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
  });

  it("does not retarget an active-tab launch after the captured notebook closes during the prompt", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const replacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeTabInput = new vscode.TabInputNotebook(original.uri, "jupyter-notebook");
    notebookMocks.showInputBox.mockImplementationOnce(async () => {
      closeNotebook(original);
      notebookMocks.notebookDocuments.splice(0, 1, replacement);
      notebookMocks.activeTabInput = new vscode.TabInputNotebook(replacement.uri, "jupyter-notebook");
      return "frame";
    });
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.kernelOrigins).toEqual([]);
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and try again."
    );
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

function notebook(uri: string, notebookType = "jupyter-notebook"): NotebookDocument {
  return {
    uri: vscode.Uri.parse(uri),
    notebookType,
    isClosed: false
  } as unknown as NotebookDocument;
}

function closeNotebook(document: NotebookDocument): void {
  Object.defineProperty(document, "isClosed", { configurable: true, value: true });
}

function editor(document: NotebookDocument): NotebookEditor {
  return { notebook: document } as NotebookEditor;
}

function serializedFileUri(path: string): Record<string, unknown> {
  return { $mid: 1, scheme: "file", path };
}
