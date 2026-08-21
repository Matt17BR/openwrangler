import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, NotebookDocument, NotebookEditor, Uri } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type { SessionCoordinator } from "../extension/sessionCoordinator";

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
  capture: vi.fn(),
  request: vi.fn(),
  bridgeDisposals: 0,
  registerFormatters: true
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
        return true;
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
    showErrorMessage: rendererMocks.showErrorMessage
  },
  workspace: {
    get notebookDocuments() {
      return rendererMocks.notebookDocuments;
    }
  }
}));

vi.mock("../extension/configuration", () => ({
  getSetting: <T>(_key: string, fallback: T): T => fallback
}));

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: {
    create: rendererMocks.createPanel
  }
}));

vi.mock("../extension/notebooks/kernelBridge", () => ({
  shouldRegisterNotebookFormatters: () => rendererMocks.registerFormatters,
  KernelBridge: class {
    constructor(_context: ExtensionContext, document: NotebookDocument) {
      rendererMocks.kernelNotebookUris.push((document.uri as Uri).toString());
      rendererMocks.kernelNotebookDocuments.push(document);
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
    rendererMocks.capture.mockReset();
    rendererMocks.capture.mockResolvedValue({ backend: "polars", label: "frame", variableName: "frame" });
    rendererMocks.request.mockReset();
    rendererMocks.bridgeDisposals = 0;
    rendererMocks.registerFormatters = true;
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
    const liveMetadata = {
      ...saved.metadata,
      sessionId: "live-session",
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
      .mockResolvedValueOnce({ kind: "sessionClosed", sessionId: "live-session" });
    rendererMocks.inlineListener?.({ editor: exactEditor, message: inlineCandidate("1") });
    await settleMessages();

    expect(tracker.bindInlineUpgrade).toHaveBeenCalledWith(exactEditor, {
      byteLength: 37,
      sha256: "a".repeat(64)
    });
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
    expect(binding.dispose).toHaveBeenCalledOnce();
    expect(rendererMocks.bridgeDisposals).toBe(1);
    expect(rendererMocks.activeEditorReads).toBe(0);
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
    const liveMetadata = {
      ...saved.metadata,
      sessionId: "live-session",
      revision: 3,
      source: { kind: "notebookVariable", label: "frame", variableName: "frame", uri: document.uri.toString() }
    };
    rendererMocks.request
      .mockResolvedValueOnce({ kind: "sessionOpened", metadata: liveMetadata, page: saved.page, summaries: [] })
      .mockResolvedValueOnce({ kind: "page", revision: 3, metadata: liveMetadata, page: saved.page })
      .mockResolvedValueOnce({ kind: "sessionClosed", sessionId: "live-session" });

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
    expect(rendererMocks.inlinePosts).toEqual([]);
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
    expect(rendererMocks.inlinePosts).toEqual([]);
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
    expect(rendererMocks.inlinePosts).toEqual([]);
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("leaves ordinary HTML alone when Open Wrangler is not the selected preview provider", () => {
    const document = notebook("file:///workspace/other-provider.ipynb");
    const exactEditor = editor(document);
    rendererMocks.notebookDocuments.push(document);
    rendererMocks.visibleNotebookEditors.push(exactEditor);
    rendererMocks.registerFormatters = false;
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

function notebook(uri: string, isClosed = false): NotebookDocument {
  return {
    uri: { toString: () => uri },
    isClosed
  } as unknown as NotebookDocument;
}

function editor(document: NotebookDocument): NotebookEditor {
  return { notebook: document } as NotebookEditor;
}

function inlineCandidate(digit: string): unknown {
  return {
    kind: "openWrangler.inlineCandidate",
    protocol: 1,
    token: digit.repeat(32),
    outputItemId: `output-${digit}`,
    byteLength: 37,
    sha256: "a".repeat(64)
  };
}

function inlineBinding(document: NotebookDocument, exactEditor: NotebookEditor) {
  return {
    cell: {},
    notebook: document,
    editor: exactEditor,
    executionOrder: 1,
    sourceFingerprint: "b".repeat(64),
    kernelBinding: {},
    isCurrent: vi.fn(() => true),
    hasCurrentKernel: vi.fn(async () => true),
    dispose: vi.fn()
  };
}

async function settleMessages(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
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
