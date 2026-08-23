import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, NotebookDocument, NotebookEditor, Uri } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type { SessionCoordinator } from "../extension/sessionCoordinator";
import { NOTEBOOK_OUTPUT_LIMITS } from "../shared/notebookOutput";

interface RendererEvent {
  editor: NotebookEditor;
  message: unknown;
}

const rendererMocks = vi.hoisted(() => ({
  listener: undefined as ((event: RendererEvent) => void) | undefined,
  inlineListener: undefined as ((event: RendererEvent) => void) | undefined,
  inlinePosts: [] as Array<{ message: unknown; editor: NotebookEditor | undefined }>,
  notebookDocuments: [] as NotebookDocument[],
  visibleNotebookEditors: [] as NotebookEditor[],
  activeNotebookEditor: undefined as NotebookEditor | undefined,
  activeEditorReads: 0,
  showErrorMessage: vi.fn(async () => undefined),
  createPanel: vi.fn(),
  kernelNotebookUris: [] as string[],
  kernelNotebookDocuments: [] as NotebookDocument[],
  kernelBindings: [] as unknown[],
  capture: vi.fn(),
  request: vi.fn(),
  afterInlinePost: undefined as (() => void) | undefined,
  inlinePostResult: undefined as
    ((message: unknown, editor: NotebookEditor | undefined) => Promise<boolean>) | undefined,
  bridgeDisposals: 0,
  registerFormatters: true,
  previewProvider: "ask" as "ask" | "openWrangler" | "dataWrangler" | "disabled",
  dataWranglerInstalled: false,
  providerPromptTerminated: false,
  configurationListeners: [] as Array<(event: { affectsConfiguration(section: string): boolean }) => void>,
  extensionListeners: [] as Array<() => void>,
  visibleEditorListeners: [] as Array<() => void>,
  providerPromptTerminationListeners: [] as Array<() => void>
}));

vi.mock("../extension/notebooks/notebookPreviewCoordinator", () => ({
  onDidTerminateNotebookPreviewProviderPrompt: (listener: () => void) => {
    rendererMocks.providerPromptTerminationListeners.push(listener);
    if (rendererMocks.providerPromptTerminated) listener();
    return { dispose: () => undefined };
  },
  isNotebookPreviewProviderPromptTerminated: () => rendererMocks.providerPromptTerminated
}));

vi.mock("vscode", () => ({
  CancellationTokenSource: class {
    private readonly listeners = new Set<() => void>();
    readonly token = {
      get isCancellationRequested() {
        return false;
      },
      onCancellationRequested: (listener: () => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      }
    };
    cancel(): void {
      Object.defineProperty(this.token, "isCancellationRequested", { configurable: true, value: true });
      for (const listener of this.listeners) listener();
    }
    dispose(): void {
      this.listeners.clear();
    }
  },
  notebooks: {
    createRendererMessaging: (id: string) => ({
      onDidReceiveMessage: (listener: (event: RendererEvent) => void) => {
        if (id === "openWrangler.inlineHtmlUpgrade") rendererMocks.inlineListener = listener;
        else rendererMocks.listener = listener;
        return { dispose: () => undefined };
      },
      postMessage: async (message: unknown, editor: NotebookEditor | undefined) => {
        rendererMocks.inlinePosts.push({ message, editor });
        rendererMocks.afterInlinePost?.();
        return rendererMocks.inlinePostResult?.(message, editor) ?? true;
      }
    })
  },
  window: {
    get visibleNotebookEditors() {
      return rendererMocks.visibleNotebookEditors;
    },
    get activeNotebookEditor() {
      rendererMocks.activeEditorReads += 1;
      return rendererMocks.activeNotebookEditor;
    },
    showErrorMessage: rendererMocks.showErrorMessage,
    onDidChangeVisibleNotebookEditors: (listener: () => void) => {
      rendererMocks.visibleEditorListeners.push(listener);
      return { dispose: () => undefined };
    }
  },
  workspace: {
    get notebookDocuments() {
      return rendererMocks.notebookDocuments;
    },
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => void) => {
      rendererMocks.configurationListeners.push(listener);
      return { dispose: () => undefined };
    }
  },
  extensions: {
    getExtension: (id: string) =>
      id === "ms-toolsai.datawrangler" && rendererMocks.dataWranglerInstalled ? { id } : undefined,
    onDidChange: (listener: () => void) => {
      rendererMocks.extensionListeners.push(listener);
      return { dispose: () => undefined };
    }
  }
}));

vi.mock("../extension/configuration", () => ({
  getSetting: <T>(key: string, fallback: T): T =>
    (key === "notebookPreviewProvider" ? rendererMocks.previewProvider : fallback) as T
}));

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: {
    create: rendererMocks.createPanel
  }
}));

vi.mock("../extension/notebooks/kernelBridge", () => ({
  shouldRegisterNotebookFormatters: () => rendererMocks.registerFormatters,
  KernelBridge: class {
    constructor(
      _context: ExtensionContext,
      document: NotebookDocument,
      _registerFormatters?: boolean,
      _fileOperations?: unknown,
      requiredKernelBinding?: unknown
    ) {
      rendererMocks.kernelNotebookUris.push((document.uri as Uri).toString());
      rendererMocks.kernelNotebookDocuments.push(document);
      rendererMocks.kernelBindings.push(requiredKernelBinding);
    }
    captureExecutedCellResult = rendererMocks.capture;
    request = rendererMocks.request;
    dispose(): void {
      rendererMocks.bridgeDisposals += 1;
    }
  }
}));

import { registerNotebookRendererMessaging } from "../extension/notebooks/rendererMessaging";

describe("notebook renderer messaging", () => {
  beforeEach(() => {
    rendererMocks.listener = undefined;
    rendererMocks.inlineListener = undefined;
    rendererMocks.inlinePosts.length = 0;
    rendererMocks.notebookDocuments.length = 0;
    rendererMocks.visibleNotebookEditors.length = 0;
    rendererMocks.activeNotebookEditor = undefined;
    rendererMocks.activeEditorReads = 0;
    rendererMocks.showErrorMessage.mockClear();
    rendererMocks.createPanel.mockReset();
    rendererMocks.kernelNotebookUris.length = 0;
    rendererMocks.kernelNotebookDocuments.length = 0;
    rendererMocks.kernelBindings.length = 0;
    rendererMocks.capture.mockReset();
    rendererMocks.capture.mockResolvedValue({ backend: "polars", label: "frame", variableName: "frame" });
    rendererMocks.request.mockReset();
    rendererMocks.afterInlinePost = undefined;
    rendererMocks.inlinePostResult = undefined;
    rendererMocks.bridgeDisposals = 0;
    rendererMocks.registerFormatters = true;
    rendererMocks.previewProvider = "ask";
    rendererMocks.dataWranglerInstalled = false;
    rendererMocks.providerPromptTerminated = false;
    rendererMocks.configurationListeners.length = 0;
    rendererMocks.extensionListeners.length = 0;
    rendererMocks.visibleEditorListeners.length = 0;
    rendererMocks.providerPromptTerminationListeners.length = 0;
  });

  it("opens the primary renderer action as the exact current live variable without pinning the saved backend", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    const editorA = editor(notebookA);
    const editorB = editor(notebookB);
    rendererMocks.notebookDocuments.push(notebookA, notebookB);
    rendererMocks.visibleNotebookEditors.push(editorA, editorB);
    rendererMocks.activeNotebookEditor = editorB;
    const { context, coordinator, coordinatedBridge } = register();

    dispatch(editorA, validPayload());

    expect(rendererMocks.kernelNotebookUris).toEqual(["file:///workspace/a.ipynb"]);
    expect(rendererMocks.kernelNotebookDocuments).toEqual([notebookA]);
    expect(coordinator.createBridge).toHaveBeenCalledOnce();
    expect(rendererMocks.createPanel).toHaveBeenCalledWith(context, coordinatedBridge, {
      kind: "notebookVariable",
      label: "frame",
      variableName: "frame",
      uri: "file:///workspace/a.ipynb"
    });
    expect(rendererMocks.createPanel.mock.calls[0]).toHaveLength(3);
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it("opens an opaque live-result handle under the readable output label", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const editorA = editor(notebookA);
    rendererMocks.notebookDocuments.push(notebookA);
    rendererMocks.visibleNotebookEditors.push(editorA);
    const { context, coordinatedBridge } = register();
    const handle = "__openwrangler_live_result_0123456789abcdef0123456789abcdef";

    dispatch(editorA, validPayload(handle));

    expect(rendererMocks.createPanel).toHaveBeenCalledWith(context, coordinatedBridge, {
      kind: "notebookVariable",
      label: "frame",
      variableName: handle,
      uri: "file:///workspace/a.ipynb"
    });
  });

  it("never falls back to a snapshot when the primary action has no live variable link", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    const editorA = editor(notebookA);
    const editorB = editor(notebookB);
    rendererMocks.notebookDocuments.push(notebookA, notebookB);
    rendererMocks.visibleNotebookEditors.push(editorA, editorB);
    rendererMocks.activeNotebookEditor = editorB;
    const { coordinator } = register();

    dispatch(editorA, validPayload(null));

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).toHaveBeenCalledWith(
      "This saved preview is not linked to a live dataframe. Run the cell again to create a fresh Open Wrangler preview, then try again."
    );
    expect(rendererMocks.kernelNotebookUris).toEqual([]);
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it("ignores obsolete alternate notebook actions", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const editorA = editor(notebookA);
    rendererMocks.notebookDocuments.push(notebookA);
    rendererMocks.visibleNotebookEditors.push(editorA);
    const { coordinator } = register();

    rendererMocks.listener?.({
      editor: editorA,
      message: { kind: "openLiveInOpenWrangler", payload: validPayload() }
    });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("keeps the originating notebook when focus changes during dispatch", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    const notebookC = notebook("file:///workspace/c.ipynb");
    const editorA = editor(notebookA);
    const editorB = editor(notebookB);
    const editorC = editor(notebookC);
    rendererMocks.notebookDocuments.push(notebookA, notebookB, notebookC);
    rendererMocks.visibleNotebookEditors.push(editorA, editorB, editorC);
    rendererMocks.activeNotebookEditor = editorB;
    const { coordinator } = register();
    coordinator.createBridge.mockImplementation((bridge: OpenWranglerBridge) => {
      rendererMocks.activeNotebookEditor = editorC;
      return bridge;
    });

    dispatch(editorA, validPayload());

    expect(rendererMocks.kernelNotebookUris).toEqual(["file:///workspace/a.ipynb"]);
    expect(rendererMocks.createPanel).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ uri: "file:///workspace/a.ipynb" })
    );
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it.each([
    ["closed", true, true],
    ["unknown", false, false]
  ])("rejects a %s originating notebook without opening a fallback", (_case, isClosed, includeAsOpen) => {
    const originatingNotebook = notebook("file:///workspace/origin.ipynb", isClosed);
    const otherNotebook = notebook("file:///workspace/other.ipynb");
    const originatingEditor = editor(originatingNotebook);
    const otherEditor = editor(otherNotebook);
    rendererMocks.notebookDocuments.push(otherNotebook);
    if (includeAsOpen) rendererMocks.notebookDocuments.push(originatingNotebook);
    rendererMocks.visibleNotebookEditors.push(originatingEditor, otherEditor);
    rendererMocks.activeNotebookEditor = otherEditor;
    const { coordinator } = register();

    dispatch(originatingEditor, validPayload());

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.kernelNotebookUris).toEqual([]);
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).toHaveBeenCalledWith(
      "The notebook behind this preview is no longer open. Reopen it, run the cell that defines the dataframe, and try again."
    );
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it("rejects a stale originating editor even when another split still shows the same document", () => {
    const originatingNotebook = notebook("file:///workspace/origin.ipynb");
    const staleEditor = editor(originatingNotebook);
    const visibleSplit = editor(originatingNotebook);
    rendererMocks.notebookDocuments.push(originatingNotebook);
    rendererMocks.visibleNotebookEditors.push(visibleSplit);
    rendererMocks.activeNotebookEditor = visibleSplit;
    const { coordinator } = register();

    dispatch(staleEditor, validPayload());

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
  });

  it("rejects a reopened editor and document that merely reuse the originating URI", () => {
    const staleDocument = notebook("file:///workspace/origin.ipynb", true);
    const reopenedDocument = notebook("file:///workspace/origin.ipynb");
    const staleEditor = editor(staleDocument);
    const reopenedEditor = editor(reopenedDocument);
    rendererMocks.notebookDocuments.push(reopenedDocument);
    rendererMocks.visibleNotebookEditors.push(reopenedEditor);
    rendererMocks.activeNotebookEditor = reopenedEditor;
    const { coordinator } = register();

    dispatch(staleEditor, validPayload());

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
  });

  it("rejects a live action while another open document shares the captured URI", () => {
    const originatingNotebook = notebook("file:///workspace/origin.ipynb");
    const overlappingReplacement = notebook("file:///workspace/origin.ipynb");
    const originatingEditor = editor(originatingNotebook);
    rendererMocks.notebookDocuments.push(originatingNotebook, overlappingReplacement);
    rendererMocks.visibleNotebookEditors.push(originatingEditor);
    const { coordinator } = register();

    dispatch(originatingEditor, validPayload());

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.kernelNotebookUris).toEqual([]);
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).toHaveBeenCalledWith(
      "The notebook behind this preview is no longer uniquely open. Close duplicate or replacement notebook views, run the cell if needed, and try again."
    );
  });

  it("rejects a malformed payload without retaining or dispatching an action", () => {
    const originatingNotebook = notebook("file:///workspace/origin.ipynb");
    const originatingEditor = editor(originatingNotebook);
    rendererMocks.notebookDocuments.push(originatingNotebook);
    rendererMocks.visibleNotebookEditors.push(originatingEditor);
    const { coordinator } = register();

    dispatch(originatingEditor, { mimeVersion: 2, metadata: {}, page: {}, summaries: [] });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).toHaveBeenCalledWith(
      "This Open Wrangler notebook output is malformed or unsupported."
    );
  });

  it("rejects an explicit live action when the payload has no variable link", () => {
    const originatingNotebook = notebook("file:///workspace/origin.ipynb");
    const originatingEditor = editor(originatingNotebook);
    rendererMocks.notebookDocuments.push(originatingNotebook);
    rendererMocks.visibleNotebookEditors.push(originatingEditor);
    const { coordinator } = register();

    dispatch(originatingEditor, validPayload(null));

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).toHaveBeenCalledWith(
      "This saved preview is not linked to a live dataframe. Run the cell again to create a fresh Open Wrangler preview, then try again."
    );
  });

  it("does not fall back after a live-open setup failure or retain its origin for the next action", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    const editorA = editor(notebookA);
    const editorB = editor(notebookB);
    rendererMocks.notebookDocuments.push(notebookA, notebookB);
    rendererMocks.visibleNotebookEditors.push(editorA, editorB);
    const { coordinator } = register();
    coordinator.createBridge.mockImplementationOnce(() => {
      throw new Error("Kernel access denied.");
    });

    dispatch(editorA, validPayload());

    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).toHaveBeenCalledWith(
      "Open Wrangler could not access the live dataframe. Select or start the notebook's Python kernel, run the cell that defines frame, and try again. Kernel access denied."
    );

    dispatch(editorB, validPayload());

    expect(rendererMocks.kernelNotebookUris).toEqual(["file:///workspace/a.ipynb", "file:///workspace/b.ipynb"]);
    expect(rendererMocks.createPanel).toHaveBeenCalledOnce();
    expect(rendererMocks.createPanel).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ uri: "file:///workspace/b.ipynb" })
    );
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it("publishes one canonical inline upgrade only to the exact originating editor", async () => {
    const document = notebook("file:///workspace/inline.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(() => binding) };
    register(tracker);
    const saved = validPayload() as ReturnType<typeof validPayload> & {
      metadata: Record<string, unknown>;
      page: Record<string, unknown>;
    };
    const sessionId = `inline-session-${"1".repeat(32)}`;
    const liveMetadata = {
      ...saved.metadata,
      sessionId,
      revision: 3,
      source: {
        kind: "notebookVariable",
        label: "frame",
        variableName: "frame",
        uri: "file:///workspace/inline.ipynb"
      }
    };
    rendererMocks.request
      .mockResolvedValueOnce({ kind: "sessionOpened", metadata: liveMetadata, page: saved.page, summaries: [] })
      .mockResolvedValueOnce({
        kind: "page",
        revision: 3,
        viewRequestId: `inline-${"1".repeat(32)}`,
        metadata: liveMetadata,
        page: saved.page
      })
      .mockResolvedValueOnce({ kind: "sessionClosed", sessionId });
    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("1") });
    await settleMessages();

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledWith(
      exactEditor,
      {
        byteLength: 37,
        sha256: "a".repeat(64)
      },
      expect.anything()
    );
    expect(rendererMocks.request.mock.calls.map(([request]) => request.kind)).toEqual([
      "openSession",
      "getPage",
      "closeSession"
    ]);
    expect(rendererMocks.inlinePosts).toHaveLength(1);
    expect(rendererMocks.inlinePosts[0]?.editor).toBe(exactEditor);
    expect(rendererMocks.inlinePosts[0]?.message).toMatchObject({
      kind: "openWrangler.inlineUpgrade",
      protocol: 1,
      token: "1".repeat(32),
      outputItemId: "output-1",
      payload: {
        mimeVersion: 2,
        metadata: {
          revision: 0,
          source: { kind: "notebookOutput", label: "frame", variableName: "frame" }
        }
      }
    });
    expect(binding.dispose).not.toHaveBeenCalled();
    expect(rendererMocks.bridgeDisposals).toBe(1);
    expect(rendererMocks.activeEditorReads).toBe(0);

    binding.invalidate();
    await settleMessages();
    expect(rendererMocks.inlinePosts[1]).toEqual({
      editor: exactEditor,
      message: {
        kind: "openWrangler.inlineRevoke",
        protocol: 1,
        token: "1".repeat(32),
        outputItemId: "output-1",
        byteLength: 37,
        sha256: "a".repeat(64)
      }
    });
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("accepts the bounded upgrade protocol on the shared ordinary renderer channel", async () => {
    const document = notebook("file:///workspace/shared.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(() => binding) };
    register(tracker);
    const saved = validPayload() as ReturnType<typeof validPayload> & {
      metadata: Record<string, unknown>;
      page: Record<string, unknown>;
    };
    const sessionId = `inline-session-${"3".repeat(32)}`;
    const liveMetadata = {
      ...saved.metadata,
      sessionId,
      revision: 3,
      source: { kind: "notebookVariable", label: "frame", variableName: "frame", uri: document.uri.toString() }
    };
    rendererMocks.request
      .mockResolvedValueOnce({ kind: "sessionOpened", metadata: liveMetadata, page: saved.page, summaries: [] })
      .mockResolvedValueOnce({
        kind: "page",
        revision: 3,
        viewRequestId: `inline-${"3".repeat(32)}`,
        metadata: liveMetadata,
        page: saved.page
      })
      .mockResolvedValueOnce({ kind: "sessionClosed", sessionId });

    rendererMocks.listener?.({ editor: exactEditor, message: inlineCandidate("3") });
    await settleMessages();

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledOnce();
    expect(rendererMocks.inlinePosts).toHaveLength(1);
    expect(rendererMocks.inlinePosts[0]?.editor).toBe(exactEditor);
    expect(rendererMocks.inlinePosts[0]?.message).toMatchObject({
      kind: "openWrangler.inlineUpgrade",
      token: "3".repeat(32)
    });
  });

  it("retains only compact authority for eight near-limit published payloads", async () => {
    const documents = Array.from({ length: 8 }, (_, index) => notebook(`file:///workspace/near-limit-${index}.ipynb`));
    const editors = documents.map((document) => editor(document));
    rendererMocks.notebookDocuments.push(...documents);
    rendererMocks.visibleNotebookEditors.push(...editors);
    const bindings = new Map(
      editors.map((candidateEditor) => [candidateEditor, inlineBinding(candidateEditor.notebook, candidateEditor)])
    );
    register({ bindInlineUpgrade: vi.fn((candidateEditor: NotebookEditor) => bindings.get(candidateEditor)) });
    installNearLimitRuntimeResponses();
    const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation(() => {
      throw new Error("Published inline payloads must not be cloned into operation state.");
    });
    try {
      for (let index = 0; index < editors.length; index += 1) {
        rendererMocks.inlineListener?.({ editor: editors[index]!, message: inlineCandidate(index.toString(16)) });
      }
      await settleMessages();

      const upgrades = rendererMocks.inlinePosts.filter(
        ({ message }) => (message as { kind?: string }).kind === "openWrangler.inlineUpgrade"
      );
      expect(upgrades).toHaveLength(8);
      expect(cloneSpy).not.toHaveBeenCalled();
      const serializedBytes = Buffer.byteLength(
        JSON.stringify((upgrades[0]?.message as { payload?: unknown }).payload),
        "utf8"
      );
      expect(serializedBytes).toBeGreaterThan(15 * 1024 * 1024);
      expect(serializedBytes).toBeLessThanOrEqual(NOTEBOOK_OUTPUT_LIMITS.bytes);
    } finally {
      cloneSpy.mockRestore();
    }
  }, 30_000);

  it("does not consume an overridden cell iterator before delegating topology to the tracker", async () => {
    let iteratorReads = 0;
    let outputsReads = 0;
    const cell = Object.defineProperty({}, "outputs", {
      get: () => {
        outputsReads += 1;
        return [];
      }
    });
    const cells = [cell];
    Object.defineProperty(cells, Symbol.iterator, {
      value: () => ({
        next: () => {
          iteratorReads += 1;
          return iteratorReads <= 2 ? { done: false, value: cell } : { done: true, value: undefined };
        }
      })
    });
    const document = notebook("file:///workspace/over-yielding-cells.ipynb", false, cells);
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(async () => undefined) };
    register(tracker);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("5") });
    await settleMicrotasks();

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledOnce();
    expect(iteratorReads).toBe(0);
    expect(outputsReads).toBe(0);
  });

  it("does not read a caller-controlled outputs getter before the tracker", async () => {
    let outputsReads = 0;
    const cell = Object.defineProperty({}, "outputs", {
      get: () => {
        outputsReads += 1;
        throw new Error("renderer entrypoint must not read cell outputs");
      }
    });
    const document = notebook("file:///workspace/hostile-outputs.ipynb", false, [cell]);
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(async () => undefined) };
    register(tracker);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("5") });
    await settleMicrotasks();

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledOnce();
    expect(outputsReads).toBe(0);
  });

  it("delegates an over-limit empty-output prefix without touching a trailing match", async () => {
    let trailingItemsRead = 0;
    const emptyOutput = { items: [] };
    const trailingOutput = Object.defineProperty({}, "items", {
      get: () => {
        trailingItemsRead += 1;
        return [{ mime: "text/html", data: new Uint8Array(37) }];
      }
    });
    const outputs: unknown[] = Array.from({ length: 100_001 }, () => emptyOutput);
    outputs.push(trailingOutput);
    const document = notebook("file:///workspace/output-container-cap.ipynb", false, [{ outputs }]);
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(async () => undefined) };
    register(tracker);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("5") });
    await settleMicrotasks();

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledOnce();
    expect(trailingItemsRead).toBe(0);
    expect(rendererMocks.inlinePosts.at(-1)?.message).toMatchObject({
      kind: "openWrangler.inlineRevoke",
      token: "5".repeat(32)
    });
  });

  it("admits one of 129 hanging live actions before payload work and enforces its terminal deadline", async () => {
    const document = notebook("file:///workspace/hanging-live-actions.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(async () => binding) });
    installCanonicalRuntimeResponses(document, "6");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("6") });
    await settleMessages();
    const published = rendererMocks.inlinePosts.at(-1)?.message as { payload?: Record<string, unknown> };
    const kernelChecksBeforeAction = binding.hasCurrentKernel.mock.calls.length;
    const hangingKernelCheck = deferred<boolean>();
    binding.hasCurrentKernel.mockReturnValue(hangingKernelCheck.promise);
    let pageReads = 0;
    const revocable = Proxy.revocable(published.payload!, {
      get(target, property, receiver) {
        if (property === "page") pageReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });

    vi.useFakeTimers();
    try {
      for (let index = 0; index < 129; index += 1) {
        rendererMocks.inlineListener?.({
          editor: exactEditor,
          message: { kind: "openInOpenWrangler", payload: revocable.proxy }
        });
      }
      await settleMicrotasks();
      expect(pageReads).toBe(2);
      expect(binding.hasCurrentKernel).toHaveBeenCalledTimes(kernelChecksBeforeAction + 1);

      revocable.revoke();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rendererMocks.inlinePosts.at(-1)?.message).toMatchObject({
        kind: "openWrangler.inlineRevoke",
        token: "6".repeat(32)
      });
      hangingKernelCheck.resolve(true);
      await settleMicrotasks();
      expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues a live action from compact authority after its renderer payload is revoked", async () => {
    const document = notebook("file:///workspace/released-action-payload.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(async () => binding) });
    installCanonicalRuntimeResponses(document, "7");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("7") });
    await settleMessages();
    const published = rendererMocks.inlinePosts.at(-1)?.message as { payload?: Record<string, unknown> };
    const actionKernelCheck = deferred<boolean>();
    binding.hasCurrentKernel.mockReturnValue(actionKernelCheck.promise);
    const revocable = Proxy.revocable(published.payload!, {});

    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { kind: "openInOpenWrangler", payload: revocable.proxy }
    });
    await settleMicrotasks();
    revocable.revoke();
    actionKernelCheck.resolve(true);
    await settleMessages();

    expect(rendererMocks.createPanel).toHaveBeenCalledOnce();
    expect(rendererMocks.createPanel).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ label: "frame", variableName: "frame", uri: document.uri.toString() })
    );
  });

  it("keeps hanging live actions within the global ownership cap", async () => {
    const documents = Array.from({ length: 9 }, (_, index) => notebook(`file:///workspace/action-cap-${index}.ipynb`));
    const editors = documents.map((document) => editor(document));
    const bindings = new Map(
      editors.map((candidateEditor) => [candidateEditor, inlineBinding(candidateEditor.notebook, candidateEditor)])
    );
    rendererMocks.notebookDocuments.push(...documents);
    rendererMocks.visibleNotebookEditors.push(...editors);
    const { context } = register({
      bindInlineUpgrade: vi.fn(async (candidateEditor: NotebookEditor) => bindings.get(candidateEditor))
    });
    const payloads: unknown[] = [];
    for (let index = 0; index < editors.length; index += 1) {
      installCanonicalRuntimeResponses(documents[index]!, String(index));
      rendererMocks.inlineListener?.({ editor: editors[index]!, message: inlineCandidate(String(index)) });
      await settleMessages();
      payloads.push((rendererMocks.inlinePosts.at(-1)?.message as { payload?: unknown }).payload);
    }
    const kernelChecksBeforeActions = [...bindings.values()].map(
      (binding) => binding.hasCurrentKernel.mock.calls.length
    );
    for (const binding of bindings.values())
      binding.hasCurrentKernel.mockReturnValue(new Promise<boolean>(() => undefined));

    for (let index = 0; index < editors.length; index += 1) {
      rendererMocks.inlineListener?.({
        editor: editors[index]!,
        message: { kind: "openInOpenWrangler", payload: payloads[index] }
      });
    }
    await settleMicrotasks();

    const actionKernelChecks = [...bindings.values()].reduce(
      (total, binding, index) => total + binding.hasCurrentKernel.mock.calls.length - kernelChecksBeforeActions[index]!,
      0
    );
    expect(actionKernelChecks).toBe(8);
    expect(bindings.get(editors[8]!)?.dispose).toHaveBeenCalledOnce();
    for (const subscription of context.subscriptions) subscription.dispose();
  });

  it("retains expired never-settling actions in the global ownership cap until their work settles", async () => {
    const documents = Array.from({ length: 24 }, (_, index) =>
      notebook(`file:///workspace/detached-action-cap-${index}.ipynb`)
    );
    const editors = documents.map((document) => editor(document));
    const bindings = new Map(
      editors.map((candidateEditor) => [candidateEditor, inlineBinding(candidateEditor.notebook, candidateEditor)])
    );
    rendererMocks.notebookDocuments.push(...documents);
    rendererMocks.visibleNotebookEditors.push(...editors);
    const { context } = register({
      bindInlineUpgrade: vi.fn(async (candidateEditor: NotebookEditor) => bindings.get(candidateEditor))
    });
    const payloads: unknown[] = [];
    for (let index = 0; index < editors.length; index += 1) {
      const candidate = indexedInlineCandidate(index);
      installCanonicalRuntimeResponses(documents[index]!, candidate.token);
      rendererMocks.inlineListener?.({
        editor: editors[index]!,
        message: candidate
      });
      await settleMessages();
      payloads.push((rendererMocks.inlinePosts.at(-1)?.message as { payload?: unknown }).payload);
    }
    const checksBeforeActions = [...bindings.values()].map((binding) => binding.hasCurrentKernel.mock.calls.length);
    const actionChecks = [...bindings.values()].map(() => deferred<boolean>());
    let liveActionFrames = 0;
    let peakLiveActionFrames = 0;
    [...bindings.values()].forEach((binding, index) => {
      binding.hasCurrentKernel.mockImplementation(() => {
        liveActionFrames += 1;
        peakLiveActionFrames = Math.max(peakLiveActionFrames, liveActionFrames);
        return actionChecks[index]!.promise.finally(() => {
          liveActionFrames -= 1;
        });
      });
    });

    vi.useFakeTimers();
    try {
      for (let generation = 0; generation < 3; generation += 1) {
        for (let offset = 0; offset < 8; offset += 1) {
          const index = generation * 8 + offset;
          rendererMocks.inlineListener?.({
            editor: editors[index]!,
            message: { kind: "openInOpenWrangler", payload: payloads[index] }
          });
        }
        await settleMicrotasks();
        await vi.advanceTimersByTimeAsync(10_000);
      }

      const totalActionChecks = [...bindings.values()].reduce(
        (total, binding, index) => total + binding.hasCurrentKernel.mock.calls.length - checksBeforeActions[index]!,
        0
      );
      expect(totalActionChecks).toBe(8);
      expect(peakLiveActionFrames).toBe(8);
      expect(liveActionFrames).toBe(8);

      for (const subscription of context.subscriptions) subscription.dispose();
      const postsAtDisposal = rendererMocks.inlinePosts.length;
      for (const check of actionChecks.slice(0, 8)) check.resolve(true);
      await settleMicrotasks();

      expect(liveActionFrames).toBe(0);
      expect(rendererMocks.createPanel).not.toHaveBeenCalled();
      expect(rendererMocks.inlinePosts).toHaveLength(postsAtDisposal);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a fresh replacement current when an expired action settles late", async () => {
    const document = notebook("file:///workspace/late-action-replacement.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const originalBinding = inlineBinding(document, exactEditor);
    const replacementBinding = inlineBinding(document, exactEditor);
    const tracker = {
      bindInlineUpgrade: vi
        .fn()
        .mockImplementationOnce(async () => originalBinding)
        .mockImplementationOnce(async () => replacementBinding)
    };
    register(tracker);
    const original = inlineCandidate("a");
    installCanonicalRuntimeResponses(document, original.token);
    rendererMocks.inlineListener?.({ editor: exactEditor, message: original });
    await settleMessages();
    const originalPayload = (rendererMocks.inlinePosts.at(-1)?.message as { payload?: unknown }).payload;
    const lateKernelCheck = deferred<boolean>();
    originalBinding.hasCurrentKernel.mockReturnValue(lateKernelCheck.promise);

    vi.useFakeTimers();
    try {
      rendererMocks.inlineListener?.({
        editor: exactEditor,
        message: { kind: "openInOpenWrangler", payload: originalPayload }
      });
      await settleMicrotasks();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(originalBinding.dispose).toHaveBeenCalledOnce();

      const replacement = { ...inlineCandidate("b"), outputItemId: original.outputItemId };
      installCanonicalRuntimeResponses(document, replacement.token);
      rendererMocks.inlineListener?.({ editor: exactEditor, message: replacement });
      await settleMicrotasks();
      const replacementUpgrade = rendererMocks.inlinePosts.at(-1)?.message as { kind?: string; payload?: unknown };
      expect(replacementUpgrade.kind).toBe("openWrangler.inlineUpgrade");

      lateKernelCheck.resolve(true);
      await settleMicrotasks();
      expect(rendererMocks.inlinePosts.at(-1)?.message).toBe(replacementUpgrade);
      expect(replacementBinding.dispose).not.toHaveBeenCalled();

      rendererMocks.inlineListener?.({
        editor: exactEditor,
        message: { kind: "openInOpenWrangler", payload: replacementUpgrade.payload }
      });
      await settleMicrotasks();
      expect(rendererMocks.createPanel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("single-flights repeated retired-token terminals and ignores disposal and late settlement", async () => {
    const document = notebook("file:///workspace/hanging-retired-terminal.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(async () => binding) };
    const terminal = deferred<boolean>();
    rendererMocks.inlinePostResult = async (message) =>
      (message as { kind?: string }).kind === "openWrangler.inlineRevoke" ? terminal.promise : true;
    const { context } = register(tracker);
    installCanonicalRuntimeResponses(document, "8");
    const replay = inlineCandidate("8");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: replay });
    await settleMessages();
    rendererMocks.inlineListener?.({ editor: exactEditor, message: replay });
    await settleMicrotasks();
    for (let index = 0; index < 129; index += 1) {
      rendererMocks.inlineListener?.({ editor: exactEditor, message: replay });
    }
    await settleMicrotasks();

    expect(
      rendererMocks.inlinePosts.filter(
        ({ message }) => (message as { kind?: string }).kind === "openWrangler.inlineRevoke"
      )
    ).toHaveLength(1);
    for (const subscription of context.subscriptions) subscription.dispose();
    const postsAtDisposal = rendererMocks.inlinePosts.length;
    terminal.resolve(true);
    await settleMicrotasks();
    rendererMocks.inlineListener?.({ editor: exactEditor, message: replay });
    await settleMicrotasks();

    expect(rendererMocks.inlinePosts).toHaveLength(postsAtDisposal);
    expect(tracker.bindInlineUpgrade).toHaveBeenCalledOnce();
  });

  it("keeps a replacement owner current when an evicted receipt's terminal send settles late", async () => {
    const document = notebook("file:///workspace/late-retired-terminal.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const originalBinding = inlineBinding(document, exactEditor);
    const replacementBinding = inlineBinding(document, exactEditor);
    let bindCount = 0;
    const tracker = {
      bindInlineUpgrade: vi.fn(async () => {
        bindCount += 1;
        if (bindCount === 1) return originalBinding;
        if (bindCount === 130) return replacementBinding;
        return undefined;
      })
    };
    const terminal = deferred<boolean>();
    rendererMocks.inlinePostResult = async (message) =>
      (message as { kind?: string }).kind === "openWrangler.inlineRevoke" ? terminal.promise : true;
    register(tracker);
    installCanonicalRuntimeResponses(document, "0");
    const original = inlineCandidate("0");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: original });
    await settleMessages();
    rendererMocks.inlineListener?.({ editor: exactEditor, message: original });
    await settleMicrotasks();
    for (let index = 1; index <= 128; index += 1) {
      rendererMocks.inlineListener?.({ editor: exactEditor, message: indexedInlineCandidate(index) });
      await settleMicrotasks();
    }
    expect(tracker.bindInlineUpgrade).toHaveBeenCalledTimes(129);
    expect(
      rendererMocks.inlinePosts.filter(
        ({ message }) => (message as { kind?: string }).kind === "openWrangler.inlineRevoke"
      )
    ).toHaveLength(8);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: original });
    await settleMessages();
    const replacementUpgrade = rendererMocks.inlinePosts.at(-1)?.message as { kind?: string; payload?: unknown };
    expect(replacementUpgrade.kind).toBe("openWrangler.inlineUpgrade");
    terminal.resolve(true);
    await settleMicrotasks();
    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { kind: "openInOpenWrangler", payload: replacementUpgrade.payload }
    });
    await settleMessages();

    expect(replacementBinding.dispose).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).toHaveBeenCalledOnce();
  });

  it("atomically retires a settling replay and keeps its late completion inert beside a replacement", async () => {
    const document = notebook("file:///workspace/settling-replay.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const lateBinding = inlineBinding(document, exactEditor);
    const replacementBinding = inlineBinding(document, exactEditor);
    const pending = deferred<typeof lateBinding | undefined>();
    let cancellation: { readonly isCancellationRequested: boolean } | undefined;
    const tracker = {
      bindInlineUpgrade: vi
        .fn((_editor, _candidate, token) => {
          cancellation = token;
          return pending.promise;
        })
        .mockImplementationOnce((_editor, _candidate, token) => {
          cancellation = token;
          return pending.promise;
        })
        .mockImplementationOnce(async () => replacementBinding)
    };
    register(tracker);
    installCanonicalRuntimeResponses(document, "b");
    const replay = inlineCandidate("a");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: replay });
    await Promise.resolve();
    rendererMocks.inlineListener?.({ editor: exactEditor, message: replay });
    await settleMicrotasks();
    expect(cancellation?.isCancellationRequested).toBe(true);
    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind?: string }).kind)).toEqual([
      "openWrangler.inlineRevoke"
    ]);

    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { ...inlineCandidate("b"), outputItemId: replay.outputItemId }
    });
    await settleMessages();
    expect(rendererMocks.inlinePosts.at(-1)?.message).toMatchObject({
      kind: "openWrangler.inlineUpgrade",
      token: "b".repeat(32)
    });

    pending.resolve(lateBinding);
    await settleMessages();
    expect(lateBinding.dispose).toHaveBeenCalledOnce();
    expect(rendererMocks.inlinePosts.at(-1)?.message).toMatchObject({
      kind: "openWrangler.inlineUpgrade",
      token: "b".repeat(32)
    });
  });

  it("retires an already-published exact replay before any later live action", async () => {
    const document = notebook("file:///workspace/published-replay.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(() => binding) };
    register(tracker);
    installCanonicalRuntimeResponses(document, "c");
    const replay = inlineCandidate("c");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: replay });
    await settleMessages();
    const upgrade = rendererMocks.inlinePosts.at(-1)?.message as { payload?: unknown };
    rendererMocks.inlineListener?.({ editor: exactEditor, message: replay });
    await settleMessages();
    expect(binding.dispose).toHaveBeenCalledOnce();
    expect(rendererMocks.inlinePosts.at(-1)?.message).toMatchObject({ kind: "openWrangler.inlineRevoke" });

    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { kind: "openInOpenWrangler", payload: upgrade.payload }
    });
    await settleMessages();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();

    rendererMocks.inlineListener?.({ editor: exactEditor, message: replay });
    await settleMessages();
    expect(tracker.bindInlineUpgrade).toHaveBeenCalledOnce();
  });

  it("retires both sides of an active token collision before responding", async () => {
    const document = notebook("file:///workspace/token-collision.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(() => binding) };
    register(tracker);
    installCanonicalRuntimeResponses(document, "4");
    const first = inlineCandidate("4");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: first });
    await settleMessages();
    const postsBeforeCollision = rendererMocks.inlinePosts.length;
    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { ...first, outputItemId: "colliding-output", sha256: "b".repeat(64) }
    });
    await settleMessages();

    expect(binding.dispose).toHaveBeenCalledOnce();
    expect(tracker.bindInlineUpgrade).toHaveBeenCalledOnce();
    expect(rendererMocks.inlinePosts.slice(postsBeforeCollision).map(({ message }) => message)).toEqual([
      {
        kind: "openWrangler.inlineRevoke",
        protocol: 1,
        token: "4".repeat(32),
        outputItemId: "output-4",
        byteLength: 37,
        sha256: "a".repeat(64)
      },
      {
        kind: "openWrangler.inlineRevoke",
        protocol: 1,
        token: "4".repeat(32),
        outputItemId: "colliding-output",
        byteLength: 37,
        sha256: "b".repeat(64)
      }
    ]);
  });

  it("bounds retired replay receipts and evicts the oldest deterministically", async () => {
    const document = notebook("file:///workspace/retired-receipts.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(async () => undefined) };
    register(tracker);

    for (let index = 0; index < 129; index += 1) {
      rendererMocks.inlineListener?.({ editor: exactEditor, message: indexedInlineCandidate(index) });
      await settleMicrotasks();
    }
    expect(tracker.bindInlineUpgrade).toHaveBeenCalledTimes(129);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: indexedInlineCandidate(128) });
    await settleMicrotasks();
    expect(tracker.bindInlineUpgrade).toHaveBeenCalledTimes(129);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: indexedInlineCandidate(0) });
    await settleMicrotasks();
    expect(tracker.bindInlineUpgrade).toHaveBeenCalledTimes(130);
  });

  it("makes late renderer events and operation settlement inert after disposal", async () => {
    vi.useFakeTimers();
    try {
      const document = notebook("file:///workspace/disposed-upgrades.ipynb");
      const exactEditor = editor(document);
      rendererMocks.notebookDocuments.push(document);
      rendererMocks.visibleNotebookEditors.push(exactEditor);
      const binding = inlineBinding(document, exactEditor);
      const capture = deferred<ReturnType<typeof validPayload>>();
      rendererMocks.capture.mockReturnValue(capture.promise);
      const tracker = { bindInlineUpgrade: vi.fn(async () => binding) };
      const { context } = register(tracker);

      rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("d") });
      await settleMicrotasks();
      expect(binding.listenerCount()).toBe(1);
      expect(rendererMocks.capture).toHaveBeenCalledOnce();
      for (const subscription of context.subscriptions) subscription.dispose();
      const terminalPosts = rendererMocks.inlinePosts.length;

      rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("e") });
      binding.invalidate();
      capture.resolve(validPayload());
      await settleMicrotasks();
      await vi.advanceTimersByTimeAsync(20_000);

      expect(tracker.bindInlineUpgrade).toHaveBeenCalledOnce();
      expect(binding.dispose).toHaveBeenCalledOnce();
      expect(binding.listenerCount()).toBe(0);
      expect(rendererMocks.inlinePosts).toHaveLength(terminalPosts);
      expect(rendererMocks.request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes a published upgrade when Open Wrangler stops owning notebook previews", async () => {
    const document = notebook("file:///workspace/provider-revoke.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(() => binding) });
    const saved = validPayload() as ReturnType<typeof validPayload> & {
      metadata: Record<string, unknown>;
      page: Record<string, unknown>;
    };
    const sessionId = `inline-session-${"9".repeat(32)}`;
    const liveMetadata = {
      ...saved.metadata,
      sessionId,
      revision: 3,
      source: { kind: "notebookVariable", label: "frame", variableName: "frame", uri: document.uri.toString() }
    };
    rendererMocks.request
      .mockResolvedValueOnce({ kind: "sessionOpened", metadata: liveMetadata, page: saved.page, summaries: [] })
      .mockResolvedValueOnce({
        kind: "page",
        revision: 3,
        viewRequestId: `inline-${"9".repeat(32)}`,
        metadata: liveMetadata,
        page: saved.page
      })
      .mockResolvedValueOnce({ kind: "sessionClosed", sessionId });

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("9") });
    await settleMessages();
    expect(rendererMocks.inlinePosts).toHaveLength(1);

    rendererMocks.registerFormatters = false;
    for (const listener of rendererMocks.configurationListeners) {
      listener({ affectsConfiguration: (section) => section === "openWrangler.notebookPreviewProvider" });
    }
    await settleMessages();

    expect(rendererMocks.inlinePosts[1]?.message).toMatchObject({
      kind: "openWrangler.inlineRevoke",
      token: "9".repeat(32),
      outputItemId: "output-9"
    });
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("retains the exact first HTML candidate until an unresolved provider choice selects Open Wrangler", async () => {
    const document = notebook("file:///workspace/provider-pending.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    rendererMocks.registerFormatters = false;
    rendererMocks.previewProvider = "ask";
    rendererMocks.dataWranglerInstalled = true;
    const binding = inlineBinding(document, exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(() => binding) };
    register(tracker);
    installCanonicalRuntimeResponses(document, "a");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("a") });
    await settleMessages();

    expect(rendererMocks.inlinePosts).toEqual([
      {
        editor: exactEditor,
        message: expect.objectContaining({
          kind: "openWrangler.inlinePending",
          token: "a".repeat(32),
          outputItemId: "output-a"
        })
      }
    ]);
    expect(tracker.bindInlineUpgrade).not.toHaveBeenCalled();
    expect(rendererMocks.capture).not.toHaveBeenCalled();
    expect(rendererMocks.request).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.activeEditorReads).toBe(0);

    rendererMocks.previewProvider = "openWrangler";
    rendererMocks.registerFormatters = true;
    for (const listener of rendererMocks.configurationListeners) {
      listener({ affectsConfiguration: (section) => section === "openWrangler.notebookPreviewProvider" });
    }
    await settleMessages();

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledOnce();
    expect(tracker.bindInlineUpgrade).toHaveBeenCalledWith(
      exactEditor,
      { byteLength: 37, sha256: "a".repeat(64) },
      expect.anything()
    );
    expect(rendererMocks.inlinePosts.at(-1)).toMatchObject({
      editor: exactEditor,
      message: { kind: "openWrangler.inlineUpgrade", token: "a".repeat(32), outputItemId: "output-a" }
    });
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it("revokes a provider-pending candidate without runtime work when Data Wrangler is selected", async () => {
    const document = notebook("file:///workspace/provider-pending-data-wrangler.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    rendererMocks.registerFormatters = false;
    rendererMocks.previewProvider = "ask";
    rendererMocks.dataWranglerInstalled = true;
    const tracker = { bindInlineUpgrade: vi.fn() };
    register(tracker);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("b") });
    await settleMessages();
    rendererMocks.previewProvider = "dataWrangler";
    for (const listener of rendererMocks.configurationListeners) {
      listener({ affectsConfiguration: (section) => section === "openWrangler.notebookPreviewProvider" });
    }
    await settleMessages();

    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind: string }).kind)).toEqual([
      "openWrangler.inlinePending",
      "openWrangler.inlineRevoke"
    ]);
    expect(tracker.bindInlineUpgrade).not.toHaveBeenCalled();
    expect(rendererMocks.capture).not.toHaveBeenCalled();
    expect(rendererMocks.request).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
  });

  it("revokes a provider-pending candidate when the unresolved modal is dismissed", async () => {
    const document = notebook("file:///workspace/provider-pending-dismissed.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    rendererMocks.registerFormatters = false;
    rendererMocks.previewProvider = "ask";
    rendererMocks.dataWranglerInstalled = true;
    const tracker = { bindInlineUpgrade: vi.fn() };
    register(tracker);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("d") });
    await settleMessages();
    for (const listener of rendererMocks.providerPromptTerminationListeners) listener();
    await settleMessages();

    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind: string }).kind)).toEqual([
      "openWrangler.inlinePending",
      "openWrangler.inlineRevoke"
    ]);
    expect(tracker.bindInlineUpgrade).not.toHaveBeenCalled();
    expect(rendererMocks.capture).not.toHaveBeenCalled();
  });

  it("terminally rejects an exact candidate that arrives after provider-prompt dismissal", async () => {
    const document = notebook("file:///workspace/provider-post-dismissal.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    rendererMocks.registerFormatters = false;
    rendererMocks.previewProvider = "ask";
    rendererMocks.dataWranglerInstalled = true;
    rendererMocks.providerPromptTerminated = true;
    const tracker = { bindInlineUpgrade: vi.fn() };
    register(tracker);

    const candidate = indexedInlineCandidate(31);
    rendererMocks.inlineListener?.({ editor: exactEditor, message: candidate });
    await settleMessages();

    expect(rendererMocks.inlinePosts).toEqual([
      {
        editor: exactEditor,
        message: {
          kind: "openWrangler.inlineRevoke",
          protocol: 1,
          token: candidate.token,
          outputItemId: candidate.outputItemId,
          byteLength: candidate.byteLength,
          sha256: candidate.sha256
        }
      }
    ]);
    expect(tracker.bindInlineUpgrade).not.toHaveBeenCalled();
  });

  it.each(["dismissal", "disposal"])(
    "attempts one exact terminal revoke for nine acknowledged pending candidates during %s",
    async (termination) => {
      const documents = Array.from({ length: 9 }, (_, index) =>
        notebook(`file:///workspace/provider-bulk-${termination}-${index}.ipynb`)
      );
      const editors = documents.map((document) => editor(document));
      rendererMocks.notebookDocuments.push(...documents);
      rendererMocks.visibleNotebookEditors.push(...editors);
      rendererMocks.registerFormatters = false;
      rendererMocks.previewProvider = "ask";
      rendererMocks.dataWranglerInstalled = true;
      const never = new Promise<boolean>(() => undefined);
      rendererMocks.inlinePostResult = async (message) =>
        (message as { kind?: string }).kind === "openWrangler.inlineRevoke" ? never : true;
      const { context } = register({ bindInlineUpgrade: vi.fn() });
      const candidates = editors.map((candidateEditor, index) => {
        const candidate = indexedInlineCandidate(index + 40);
        rendererMocks.inlineListener?.({ editor: candidateEditor, message: candidate });
        return candidate;
      });
      await settleMessages();

      if (termination === "dismissal") {
        rendererMocks.providerPromptTerminated = true;
        for (const listener of rendererMocks.providerPromptTerminationListeners) listener();
      } else {
        for (const subscription of context.subscriptions) subscription.dispose();
      }
      await settleMicrotasks();

      const revokes = rendererMocks.inlinePosts.filter(
        ({ message }) => (message as { kind?: string }).kind === "openWrangler.inlineRevoke"
      );
      expect(revokes).toHaveLength(9);
      expect(revokes).toEqual(
        candidates.map((candidate, index) => ({
          editor: editors[index],
          message: {
            kind: "openWrangler.inlineRevoke",
            protocol: 1,
            token: candidate.token,
            outputItemId: candidate.outputItemId,
            byteLength: candidate.byteLength,
            sha256: candidate.sha256
          }
        }))
      );
    }
  );

  it("sends provider-pending revocation before renderer messaging disposal latches", async () => {
    const document = notebook("file:///workspace/provider-pending-disposal.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    rendererMocks.registerFormatters = false;
    rendererMocks.previewProvider = "ask";
    rendererMocks.dataWranglerInstalled = true;
    const { context } = register({ bindInlineUpgrade: vi.fn() });

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("e") });
    await settleMessages();
    for (const subscription of context.subscriptions) subscription.dispose();
    await settleMessages();

    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind: string }).kind)).toEqual([
      "openWrangler.inlinePending",
      "openWrangler.inlineRevoke"
    ]);
  });

  it("releases a provider-pending candidate when its exact renderer cannot accept the receipt", async () => {
    const document = notebook("file:///workspace/provider-pending-undelivered.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    rendererMocks.registerFormatters = false;
    rendererMocks.previewProvider = "ask";
    rendererMocks.dataWranglerInstalled = true;
    rendererMocks.inlinePostResult = async (message) =>
      (message as { kind?: string }).kind !== "openWrangler.inlinePending";
    const tracker = { bindInlineUpgrade: vi.fn() };
    register(tracker);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("c") });
    await settleMessages();

    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind: string }).kind)).toEqual([
      "openWrangler.inlinePending",
      "openWrangler.inlineRevoke"
    ]);
    expect(tracker.bindInlineUpgrade).not.toHaveBeenCalled();
    expect(rendererMocks.capture).not.toHaveBeenCalled();
    expect(rendererMocks.request).not.toHaveBeenCalled();
  });

  it("cancels a queued pre-eligibility candidate when its exact sender disappears", async () => {
    const document = notebook("file:///workspace/queued-sender.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    const pending = deferred<ReturnType<typeof inlineBinding> | undefined>();
    register({ bindInlineUpgrade: vi.fn(() => pending.promise) });

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("0") });
    await Promise.resolve();
    rendererMocks.visibleNotebookEditors.splice(0);
    for (const listener of rendererMocks.visibleEditorListeners) listener();
    pending.resolve(binding);
    await settleMessages();

    expect(rendererMocks.capture).not.toHaveBeenCalled();
    expect(rendererMocks.request).not.toHaveBeenCalled();
    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind?: string }).kind)).toEqual([
      "openWrangler.inlineRevoke"
    ]);
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("terminally releases eight rejected host candidates before admitting a fresh eligible result", async () => {
    const document = notebook("file:///workspace/host-fairness.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const pending = Array.from({ length: 8 }, () => deferred<ReturnType<typeof inlineBinding> | undefined>());
    let call = 0;
    const tracker = {
      bindInlineUpgrade: vi.fn(() => (call < pending.length ? pending[call++]?.promise : undefined))
    };
    register(tracker);

    for (let index = 0; index < 8; index += 1) {
      rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate(index.toString(16)) });
    }
    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("8") });

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledTimes(7);
    pending[0]?.resolve(undefined);
    await settleMessages();
    expect(tracker.bindInlineUpgrade).toHaveBeenCalledTimes(8);
    for (const eligibility of pending.slice(1)) eligibility.resolve(undefined);
    await settleMessages();

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledTimes(9);
    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind?: string }).kind)).toEqual(
      Array.from({ length: 9 }, () => "openWrangler.inlineRevoke")
    );
  });

  it("keeps aborted hung capture work bounded without starving a different fresh output", async () => {
    const document = notebook("file:///workspace/hung-capture.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const hungFingerprint = "c".repeat(64);
    const freshFingerprint = "d".repeat(64);
    const never = new Promise<never>(() => undefined);
    register({
      bindInlineUpgrade: vi.fn((_editor, candidate: { sha256: string }) => {
        const binding = inlineBinding(document, exactEditor);
        return {
          ...binding,
          sourceFingerprint: candidate.sha256 === "b".repeat(64) ? freshFingerprint : hungFingerprint
        };
      })
    });
    rendererMocks.capture.mockImplementation((_order, fingerprint) =>
      fingerprint === hungFingerprint
        ? never
        : Promise.resolve({ backend: "polars", label: "frame", variableName: "frame" })
    );
    installCanonicalRuntimeResponses(document, "f");

    for (let index = 0; index < 12; index += 1) {
      const digit = (index % 15).toString(16);
      const candidate = { ...inlineCandidate(digit), outputItemId: "hung-output" } as Record<string, unknown>;
      rendererMocks.inlineListener?.({ editor: exactEditor, message: candidate });
      await settleMessages();
      rendererMocks.inlineListener?.({
        editor: exactEditor,
        message: {
          kind: "openWrangler.inlineCancel",
          protocol: 1,
          token: candidate.token,
          outputItemId: candidate.outputItemId
        }
      });
    }
    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { ...inlineCandidate("f"), sha256: "b".repeat(64), outputItemId: "fresh-output" }
    });
    await settleMessages();

    expect(rendererMocks.capture.mock.calls.filter(([, fingerprint]) => fingerprint === hungFingerprint)).toHaveLength(
      1
    );
    expect(
      rendererMocks.inlinePosts.some(
        ({ message }) => (message as { kind?: string }).kind === "openWrangler.inlineUpgrade"
      )
    ).toBe(true);
  });

  it("rechecks a still-idle selected kernel after capture before any runtime session opens", async () => {
    const document = notebook("file:///workspace/kernel-switch.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    binding.hasCurrentKernel.mockResolvedValueOnce(true).mockResolvedValue(false);
    register({ bindInlineUpgrade: vi.fn(() => binding) });

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("a") });
    await settleMessages();

    expect(binding.hasCurrentKernel).toHaveBeenCalledTimes(2);
    expect(rendererMocks.request).not.toHaveBeenCalled();
    expect(rendererMocks.inlinePosts.at(-1)?.message).toMatchObject({
      kind: "openWrangler.inlineRevoke",
      token: "a".repeat(32)
    });
  });

  it("revokes an already published upgrade when the selected kernel changes while the result remains idle", async () => {
    const document = notebook("file:///workspace/post-publication-kernel-switch.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(() => binding) });
    installCanonicalRuntimeResponses(document, "d");
    rendererMocks.afterInlinePost = () => {
      binding.hasCurrentKernel.mockResolvedValue(false);
      rendererMocks.afterInlinePost = undefined;
    };

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("d") });
    await settleMessages();

    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind?: string }).kind)).toEqual([
      "openWrangler.inlineUpgrade",
      "openWrangler.inlineRevoke"
    ]);
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("rechecks the selected kernel at live-action time and revokes a stale idle enhancement", async () => {
    const document = notebook("file:///workspace/action-time-kernel-switch.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(() => binding) });
    installCanonicalRuntimeResponses(document, "0");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("0") });
    await settleMessages();
    const upgrade = rendererMocks.inlinePosts.at(-1)?.message as { kind?: string; payload?: unknown };
    expect(upgrade.kind).toBe("openWrangler.inlineUpgrade");

    binding.hasCurrentKernel.mockResolvedValue(false);
    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { kind: "openInOpenWrangler", payload: upgrade.payload }
    });
    await settleMessages();

    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.inlinePosts.at(-1)?.message).toMatchObject({
      kind: "openWrangler.inlineRevoke",
      token: "0".repeat(32)
    });
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a same-token altered action and opens only the exact host-published source receipt", async () => {
    const document = notebook("file:///workspace/altered-inline-action.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(() => binding) });
    installCanonicalRuntimeResponses(document, "1");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("1") });
    await settleMessages();
    const upgrade = rendererMocks.inlinePosts.at(-1)?.message as { kind?: string; payload?: Record<string, unknown> };
    expect(upgrade.kind).toBe("openWrangler.inlineUpgrade");
    const payload = structuredClone(upgrade.payload) as {
      metadata: { source: { label: string; variableName: string } };
    };
    payload.metadata.source.label = "forged label";
    payload.metadata.source.variableName = "forged_variable";

    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { kind: "openInOpenWrangler", payload }
    });
    await settleMessages();

    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.inlinePosts.at(-1)?.message).toMatchObject({
      kind: "openWrangler.inlineRevoke",
      token: "1".repeat(32)
    });
  });

  it("never routes an inline-renderer action with a substituted session through the saved-output path", async () => {
    const document = notebook("file:///workspace/altered-inline-session.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(() => binding) });
    installCanonicalRuntimeResponses(document, "3");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("3") });
    await settleMessages();
    const upgrade = rendererMocks.inlinePosts.at(-1)?.message as { payload?: Record<string, unknown> };
    const payload = structuredClone(upgrade.payload) as {
      metadata: { sessionId: string; source: { label: string; variableName: string } };
    };
    payload.metadata.sessionId = "forged-saved-session";
    payload.metadata.source.label = "forged label";
    payload.metadata.source.variableName = "forged_variable";

    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { kind: "openInOpenWrangler", payload }
    });
    await settleMessages();

    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.kernelBindings.at(-1)).toBe(binding.kernelBinding);
  });

  it("pins the live-action panel bridge to the exact executed-result kernel generation", async () => {
    const document = notebook("file:///workspace/pinned-inline-action.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(() => binding) });
    installCanonicalRuntimeResponses(document, "2");

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("2") });
    await settleMessages();
    const upgrade = rendererMocks.inlinePosts.at(-1)?.message as { payload?: unknown };
    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { kind: "openInOpenWrangler", payload: upgrade.payload }
    });
    await settleMessages();

    expect(rendererMocks.kernelBindings.at(-1)).toBe(binding.kernelBinding);
    expect(rendererMocks.createPanel).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ label: "frame", variableName: "frame", uri: document.uri.toString() })
    );
  });

  it("terminally revokes a capture that does not settle before the host deadline", async () => {
    vi.useFakeTimers();
    try {
      const document = notebook("file:///workspace/capture-deadline.ipynb");
      const exactEditor = editor(document);
      rendererMocks.notebookDocuments.push(document);
      rendererMocks.visibleNotebookEditors.push(exactEditor);
      const binding = inlineBinding(document, exactEditor);
      register({ bindInlineUpgrade: vi.fn(() => binding) });
      rendererMocks.capture.mockReturnValue(new Promise<never>(() => undefined));

      rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("e") });
      await settleMicrotasks();
      expect(rendererMocks.inlinePosts).toEqual([]);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(rendererMocks.inlinePosts.at(-1)?.message).toMatchObject({
        kind: "openWrangler.inlineRevoke",
        token: "e".repeat(32)
      });
      expect(binding.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves one fair worker for another notebook while eight operations from one owner remain stalled", async () => {
    const documentA = notebook("file:///workspace/stalled-owner.ipynb");
    const documentB = notebook("file:///workspace/fresh-owner.ipynb");
    const editorA = editor(documentA);
    const editorB = editor(documentB);
    rendererMocks.notebookDocuments.push(documentA, documentB);
    rendererMocks.visibleNotebookEditors.push(editorA, editorB);
    const never = new Promise<never>(() => undefined);
    const bindingB = inlineBinding(documentB, editorB);
    const tracker = {
      bindInlineUpgrade: vi.fn((candidateEditor: NotebookEditor) => (candidateEditor === editorA ? never : bindingB))
    };
    register(tracker);
    installCanonicalRuntimeResponses(documentB, "8");

    for (let index = 0; index < 8; index += 1) {
      rendererMocks.inlineListener?.({ editor: editorA, message: inlineCandidate(index.toString(16)) });
    }
    rendererMocks.inlineListener?.({ editor: editorB, message: inlineCandidate("8") });
    await settleMessages();

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledWith(editorB, expect.anything(), expect.anything());
    expect(rendererMocks.inlinePosts).toContainEqual({
      editor: editorB,
      message: expect.objectContaining({ kind: "openWrangler.inlineUpgrade", token: "8".repeat(32) })
    });
  });

  it.each(["source", "requested session", "mode", "open page"] as const)(
    "rejects a session-open response with the wrong %s before page capture",
    async (mismatch) => {
      const document = notebook(`file:///workspace/wrong-${mismatch.replace(" ", "-")}.ipynb`);
      const exactEditor = editor(document);
      rendererMocks.notebookDocuments.push(document);
      rendererMocks.visibleNotebookEditors.push(exactEditor);
      const binding = inlineBinding(document, exactEditor);
      register({ bindInlineUpgrade: vi.fn(() => binding) });
      installCanonicalRuntimeResponses(document, "b", mismatch);

      rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("b") });
      await settleMessages();

      const openRequest = rendererMocks.request.mock.calls[0]?.[0] as { requestedSessionId?: string };
      expect(openRequest.requestedSessionId).toMatch(/^inline-session-[a-f0-9]{32}$/u);
      expect(rendererMocks.request.mock.calls.map(([request]) => request.kind)).toEqual([
        "openSession",
        "closeSession"
      ]);
      expect(rendererMocks.request.mock.calls[1]?.[0]).toMatchObject({
        kind: "closeSession",
        sessionId: openRequest.requestedSessionId
      });
      expect(
        rendererMocks.inlinePosts.some(
          ({ message }) => (message as { kind?: string }).kind === "openWrangler.inlineUpgrade"
        )
      ).toBe(false);
    }
  );

  it.each([
    ["more than 200 rows", 500, 1, 200],
    ["a wide schema", 500, 1_000, 100],
    ["an empty schema", 500, 0, 200]
  ] as const)("uses the canonical formatter capture bound for %s", async (_label, rows, columns, expectedLimit) => {
    const document = notebook(`file:///workspace/capture-${columns}.ipynb`);
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    register({ bindInlineUpgrade: vi.fn(() => inlineBinding(document, exactEditor)) });
    installCanonicalRuntimeResponses(document, "c", undefined, rows, columns, true);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("c") });
    await settleMessages();

    expect(rendererMocks.request.mock.calls.find(([request]) => request.kind === "getPage")?.[0]).toMatchObject({
      limit: expectedLimit,
      columnLimit: Math.max(1, columns)
    });
  });

  it("closes a correlated session before rejecting mismatched runtime metadata", async () => {
    const document = notebook("file:///workspace/mismatched.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(() => binding) };
    register(tracker);
    const saved = validPayload() as ReturnType<typeof validPayload> & { metadata: Record<string, unknown> };
    rendererMocks.request
      .mockResolvedValueOnce({
        kind: "sessionOpened",
        metadata: { ...saved.metadata, backend: "duckdb", sessionId: "mismatch", revision: 1 }
      })
      .mockResolvedValueOnce({ kind: "sessionClosed", sessionId: "mismatch" });

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("5") });
    await settleMessages();

    expect(rendererMocks.request.mock.calls.map(([request]) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind?: string }).kind)).toEqual([
      "openWrangler.inlineRevoke"
    ]);
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a valid page when cleanup acknowledges a different session", async () => {
    const document = notebook("file:///workspace/wrong-close.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(() => binding) });
    const saved = validPayload() as ReturnType<typeof validPayload> & {
      metadata: Record<string, unknown>;
      page: Record<string, unknown>;
    };
    const sessionId = `inline-session-${"7".repeat(32)}`;
    const liveMetadata = {
      ...saved.metadata,
      sessionId,
      revision: 3,
      source: { kind: "notebookVariable", label: "frame", variableName: "frame", uri: document.uri.toString() }
    };
    rendererMocks.request
      .mockResolvedValueOnce({ kind: "sessionOpened", metadata: liveMetadata, page: saved.page, summaries: [] })
      .mockResolvedValueOnce({
        kind: "page",
        revision: 3,
        viewRequestId: `inline-${"7".repeat(32)}`,
        metadata: liveMetadata,
        page: saved.page
      })
      .mockResolvedValueOnce({ kind: "sessionClosed", sessionId: "different-session" });

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("7") });
    await settleMessages();

    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind?: string }).kind)).toEqual([
      "openWrangler.inlineRevoke"
    ]);
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing correlation", undefined, 3, false],
    ["stale correlation", "inline-stale", 3, false],
    ["stale revision", `inline-${"8".repeat(32)}`, 2, false],
    ["changed schema", `inline-${"8".repeat(32)}`, 3, true]
  ])("rejects a private page with %s", async (_label, viewRequestId, revision, changedSchema) => {
    const document = notebook("file:///workspace/page-correlation.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    register({ bindInlineUpgrade: vi.fn(() => binding) });
    const saved = validPayload() as ReturnType<typeof validPayload> & {
      metadata: Record<string, unknown>;
      page: Record<string, unknown>;
    };
    const sessionId = `inline-session-${"8".repeat(32)}`;
    const liveMetadata = {
      ...saved.metadata,
      sessionId,
      revision: 3,
      source: { kind: "notebookVariable", label: "frame", variableName: "frame", uri: document.uri.toString() }
    };
    const pageMetadata = changedSchema
      ? {
          ...liveMetadata,
          schema: [{ ...(saved.metadata.schema as Array<Record<string, unknown>>)[0], id: "c:other" }]
        }
      : liveMetadata;
    rendererMocks.request
      .mockResolvedValueOnce({ kind: "sessionOpened", metadata: liveMetadata, page: saved.page, summaries: [] })
      .mockResolvedValueOnce({
        kind: "page",
        revision,
        ...(viewRequestId ? { viewRequestId } : {}),
        metadata: pageMetadata,
        page: saved.page
      })
      .mockResolvedValueOnce({ kind: "sessionClosed", sessionId });

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("8") });
    await settleMessages();

    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind?: string }).kind)).toEqual([
      "openWrangler.inlineRevoke"
    ]);
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("rejects malformed candidates and suppresses a cancelled in-flight upgrade", async () => {
    const document = notebook("file:///workspace/cancel.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(() => binding) };
    register(tracker);
    const pending = deferred<unknown>();
    rendererMocks.capture.mockReturnValueOnce(pending.promise);

    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: { ...inlineCandidate("2"), html: "forbidden" }
    });
    expect(tracker.bindInlineUpgrade).not.toHaveBeenCalled();

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("2") });
    await Promise.resolve();
    rendererMocks.inlineListener?.({
      editor: exactEditor,
      message: {
        kind: "openWrangler.inlineCancel",
        protocol: 1,
        token: "2".repeat(32),
        outputItemId: "output-2"
      }
    });
    pending.resolve({ backend: "polars", label: "frame", variableName: "frame" });
    await settleMessages();

    expect(rendererMocks.request).not.toHaveBeenCalled();
    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind?: string }).kind)).toEqual([
      "openWrangler.inlineRevoke"
    ]);
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("suppresses a late upgrade after the preview provider changes", async () => {
    const document = notebook("file:///workspace/provider-change.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    const binding = inlineBinding(document, exactEditor);
    const tracker = { bindInlineUpgrade: vi.fn(() => binding) };
    register(tracker);
    const pending = deferred<unknown>();
    rendererMocks.capture.mockReturnValueOnce(pending.promise);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("6") });
    await Promise.resolve();
    rendererMocks.registerFormatters = false;
    pending.resolve({ backend: "polars", label: "frame", variableName: "frame" });
    await settleMessages();

    expect(rendererMocks.request).not.toHaveBeenCalled();
    expect(rendererMocks.inlinePosts.map(({ message }) => (message as { kind?: string }).kind)).toEqual([
      "openWrangler.inlineRevoke"
    ]);
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("leaves ordinary HTML alone when Open Wrangler is not the selected preview provider", () => {
    const document = notebook("file:///workspace/other-provider.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    rendererMocks.registerFormatters = false;
    rendererMocks.previewProvider = "dataWrangler";
    const tracker = { bindInlineUpgrade: vi.fn() };
    register(tracker);

    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("4") });

    expect(tracker.bindInlineUpgrade).not.toHaveBeenCalled();
    expect(rendererMocks.request).not.toHaveBeenCalled();
    expect(rendererMocks.inlinePosts).toEqual([]);
  });
});

function register(tracker?: unknown): {
  context: ExtensionContext;
  coordinator: { createBridge: ReturnType<typeof vi.fn> };
  coordinatedBridge: OpenWranglerBridge;
} {
  const context = { subscriptions: [] } as unknown as ExtensionContext;
  const coordinatedBridge = {} as OpenWranglerBridge;
  const coordinator = {
    createBridge: vi.fn(() => coordinatedBridge)
  };
  registerNotebookRendererMessaging(context, coordinator as unknown as SessionCoordinator, tracker as never);
  expect(rendererMocks.listener).toBeTypeOf("function");
  if (tracker) expect(rendererMocks.inlineListener).toBeTypeOf("function");
  return { context, coordinator, coordinatedBridge };
}

function dispatch(origin: NotebookEditor, payload: unknown): void {
  rendererMocks.listener?.({
    editor: origin,
    message: { kind: "openInOpenWrangler", payload }
  });
}

function notebook(uri: string, isClosed = false, cells: readonly unknown[] = []): NotebookDocument {
  return {
    uri: { toString: () => uri },
    isClosed,
    getCells: () => cells
  } as unknown as NotebookDocument;
}

function editor(document: NotebookDocument): NotebookEditor {
  return { notebook: document } as NotebookEditor;
}

function inlineCandidate(digit: string): {
  readonly kind: "openWrangler.inlineCandidate";
  readonly protocol: 1;
  readonly token: string;
  readonly outputItemId: string;
  readonly byteLength: number;
  readonly sha256: string;
} {
  return {
    kind: "openWrangler.inlineCandidate",
    protocol: 1,
    token: digit.repeat(32),
    outputItemId: `output-${digit}`,
    byteLength: 37,
    sha256: "a".repeat(64)
  };
}

function indexedInlineCandidate(index: number): ReturnType<typeof inlineCandidate> {
  const token = index.toString(16).padStart(32, "0");
  return {
    kind: "openWrangler.inlineCandidate",
    protocol: 1,
    token,
    outputItemId: `indexed-output-${index}`,
    byteLength: 37,
    sha256: "a".repeat(64)
  };
}

function inlineBinding(document: NotebookDocument, exactEditor: NotebookEditor) {
  let current = true;
  const invalidationListeners = new Set<() => void>();
  return {
    cell: {},
    notebook: document,
    editor: exactEditor,
    executionOrder: 1,
    sourceFingerprint: "b".repeat(64),
    kernelBinding: {},
    isCurrent: vi.fn(() => current),
    hasCurrentKernel: vi.fn(async () => current),
    onDidInvalidate(listener: () => void) {
      invalidationListeners.add(listener);
      return { dispose: () => invalidationListeners.delete(listener) };
    },
    listenerCount: () => invalidationListeners.size,
    invalidate() {
      if (!current) return;
      current = false;
      for (const listener of invalidationListeners) listener();
    },
    dispose: vi.fn(() => {
      current = false;
      invalidationListeners.clear();
    })
  };
}

function installCanonicalRuntimeResponses(
  document: NotebookDocument,
  tokenValue: string,
  mismatch?: "source" | "requested session" | "mode" | "open page",
  totalRows = 1,
  columnCount = 1,
  stopAfterPageRequest = false
): void {
  const token = tokenValue.length === 1 ? tokenValue.repeat(32) : tokenValue;
  rendererMocks.request.mockImplementation(async (request) => {
    const schema = Array.from({ length: columnCount }, (_, position) => ({
      id: `c:${position}`,
      name: `column_${position}`,
      position,
      rawType: "Int64",
      type: "integer",
      nullable: false
    }));
    const requestedSessionId = request.requestedSessionId ?? request.sessionId ?? "live-session";
    const sessionId = mismatch === "requested session" ? "wrong-session" : requestedSessionId;
    const source =
      mismatch === "source"
        ? { kind: "notebookVariable", label: "other", variableName: "other", uri: "file:///workspace/other.ipynb" }
        : { kind: "notebookVariable", label: "frame", variableName: "frame", uri: document.uri.toString() };
    const metadata = {
      ...(validPayload() as { metadata: Record<string, unknown> }).metadata,
      sessionId,
      revision: 3,
      ...(mismatch === "mode" ? { mode: "cleaning" } : {}),
      source,
      shape: { rows: totalRows, columns: columnCount },
      filteredShape: { rows: totalRows, columns: columnCount },
      schema
    };
    const row = {
      id: "r:0",
      rowNumber: 0,
      values: schema.map((_, position) => ({
        kind: "integer",
        raw: position,
        display: String(position),
        isNull: false,
        isNaN: false
      }))
    };
    if (request.kind === "openSession") {
      return {
        kind: "sessionOpened",
        metadata,
        page: {
          offset: 0,
          limit: mismatch === "open page" ? 2 : 1,
          totalRows,
          columnIds: schema.map((column) => column.id),
          rows: totalRows === 0 ? [] : [row]
        },
        summaries: []
      };
    }
    if (request.kind === "getPage") {
      if (stopAfterPageRequest) return { kind: "cancelled" };
      return {
        kind: "page",
        revision: request.revision,
        viewRequestId: `inline-${token}`,
        metadata,
        page: {
          offset: 0,
          limit: request.limit,
          totalRows,
          columnIds: schema.map((column) => column.id),
          rows: totalRows === 0 ? [] : [row]
        }
      };
    }
    return { kind: "sessionClosed", sessionId: request.sessionId };
  });
}

function installNearLimitRuntimeResponses(): void {
  const schema = [{ id: "c:0", name: "payload", position: 0, rawType: "string", type: "string", nullable: false }];
  const display = "d".repeat(60_000);
  const raw = "r".repeat(20_000);
  const rows = Array.from({ length: 200 }, (_, rowNumber) => ({
    id: `r:${rowNumber}`,
    rowNumber,
    values: [{ kind: "string", raw, display, isNull: false, isNaN: false }]
  }));
  const sources = new Map<string, { kind: "notebookVariable"; label: string; variableName: string; uri: string }>();
  rendererMocks.request.mockImplementation(async (request) => {
    const sessionId = request.requestedSessionId ?? request.sessionId;
    if (!sessionId) throw new Error("The near-limit fixture requires an exact session identity.");
    if (request.kind === "openSession") {
      if (request.source.kind !== "notebookVariable" || request.source.variableName === undefined) {
        throw new Error("The near-limit fixture requires a notebook-variable source.");
      }
      sources.set(sessionId, {
        kind: "notebookVariable",
        label: request.source.label,
        variableName: request.source.variableName,
        uri: request.source.uri
      });
    }
    const source = sources.get(sessionId);
    if (!source) throw new Error("The near-limit fixture lost its exact source.");
    const metadata = {
      ...(validPayload() as { metadata: Record<string, unknown> }).metadata,
      sessionId,
      revision: 3,
      source,
      shape: { rows: 200, columns: 1 },
      filteredShape: { rows: 200, columns: 1 },
      schema
    };
    if (request.kind === "openSession") {
      return {
        kind: "sessionOpened",
        metadata,
        page: { offset: 0, limit: 1, totalRows: 200, columnIds: ["c:0"], rows: rows.slice(0, 1) },
        summaries: []
      };
    }
    if (request.kind === "getPage") {
      return {
        kind: "page",
        revision: request.revision,
        viewRequestId: request.viewRequestId,
        metadata,
        page: { offset: 0, limit: 200, totalRows: 200, columnIds: ["c:0"], rows }
      };
    }
    sources.delete(sessionId);
    return { kind: "sessionClosed", sessionId };
  });
}

async function settleMessages(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function validPayload(variableName: string | null = "frame"): unknown {
  return {
    mimeVersion: 2,
    metadata: {
      protocolVersion: 2,
      sessionId: "snapshot",
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: {
        kind: "notebookOutput",
        label: "frame",
        ...(variableName ? { variableName } : {})
      },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: 1, columns: 1 },
      filteredShape: { rows: 1, columns: 1 },
      schema: [{ id: "c:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }],
      filterModel: { filters: [], sort: [] },
      steps: []
    },
    page: {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: ["c:0"],
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
        }
      ]
    },
    summaries: []
  };
}
