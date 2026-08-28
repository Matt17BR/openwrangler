import { historyField, undo, undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { CODE_PREVIEW_EDIT_DEBOUNCE_MS, CODE_PREVIEW_MAX_UTF8_BYTES } from "../shared/codePreviewLimits";
import {
  command,
  nativeMocks,
  noDraftSnapshot,
  register,
  resetNativeViewMocks,
  rNotebookSnapshot
} from "./nativeViews.testFixtures";

const exportFileSafely = vi.hoisted(() => vi.fn(async (_options: { contents: Buffer }) => undefined));
vi.mock("../extension/files/safeFileExport", () => ({ exportFileSafely }));

it("persists only the authoritative terminal Code Preview buffer across real page recreation", async () => {
  vi.useRealTimers();
  resetNativeViewMocks();
  const registered = register(noDraftSnapshot());
  const provider = nativeMocks.webviewViewProviders.get("openWrangler.codePreview");
  if (!provider) throw new Error("Expected the Code Preview provider to be registered.");

  const hostMessages: unknown[] = [];
  const webviewMessages: unknown[] = [];
  let hostListener: ((message: unknown) => void) | undefined;
  let holdNextCodePreview = false;
  let heldCodePreview: unknown;
  let activePage: TestPage | undefined;

  Object.defineProperty(globalThis, "acquireVsCodeApi", {
    configurable: true,
    value: () => ({
      postMessage: (message: unknown) => {
        hostMessages.push(message);
        hostListener?.(message);
      }
    })
  });

  const mountPage = async (): Promise<TestPage> => {
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
    let receive: ((message: unknown) => void) | undefined;
    let dispose: (() => void) | undefined;
    const view = {
      webview: {
        html: "",
        options: {},
        cspSource: "test-csp",
        asWebviewUri: (uri: unknown) => uri,
        postMessage: vi.fn(async (message: unknown) => {
          webviewMessages.push(message);
          if (holdNextCodePreview && messageKind(message) === "codePreview") {
            holdNextCodePreview = false;
            heldCodePreview = message;
            return true;
          }
          window.dispatchEvent(new MessageEvent("message", { data: message, origin: window.location.origin }));
          return true;
        }),
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receive = listener;
          hostListener = listener;
          return {
            dispose: () => {
              if (hostListener === listener) hostListener = undefined;
            }
          };
        }
      },
      onDidDispose: (listener: () => void) => {
        dispose = listener;
        return { dispose: () => (dispose = undefined) };
      }
    };
    provider.resolveWebviewView(view);
    await import("../webviews/codePreviewMain");
    const editorElement = document.querySelector<HTMLElement>(".cm-editor");
    const editor = editorElement ? EditorView.findFromDOM(editorElement) : null;
    if (!editor || !receive) throw new Error("Expected a live CodeMirror/provider bridge.");
    const page = {
      editor,
      dispose: () => dispose?.(),
      staleListener: receive
    };
    activePage = page;
    return page;
  };

  const teardownPage = (page: TestPage): void => {
    window.dispatchEvent(new Event("pagehide"));
    page.dispose();
    document.body.replaceChildren();
    if (activePage === page) activePage = undefined;
  };

  try {
    const firstPage = await mountPage();
    const initialPreview = webviewMessages.at(-1) as CodePreviewEnvelope;
    expect(initialPreview).toMatchObject({ kind: "codePreview", bufferInvalid: false });

    vi.useFakeTimers();
    const burstStart = hostMessages.length;
    for (let index = 0; index < 40; index += 1) {
      firstPage.editor.dispatch({
        changes: { from: firstPage.editor.state.doc.length, insert: String(index % 10) }
      });
    }
    const burstCode = firstPage.editor.state.doc.toString();
    await vi.advanceTimersByTimeAsync(CODE_PREVIEW_EDIT_DEBOUNCE_MS);
    expect(hostMessages.slice(burstStart)).toEqual([
      { kind: "codeChanged", bufferId: initialPreview.bufferId, code: burstCode }
    ]);

    const latestCode = "def clean_data(df):\n    return df  # café 🧪\n";
    firstPage.editor.dispatch({
      changes: { from: 0, to: firstPage.editor.state.doc.length, insert: latestCode }
    });
    const vscode = await import("vscode");
    const writeText = vi.mocked(vscode.env.clipboard.writeText);
    writeText.mockClear();
    await expect(command("openWrangler.copyCode")()).resolves.toBe(latestCode);
    expect(writeText).toHaveBeenCalledWith(latestCode);

    const staleCode = `${latestCode}# stale session edit\n`;
    const staleStart = hostMessages.length;
    firstPage.editor.dispatch({ changes: { from: 0, to: firstPage.editor.state.doc.length, insert: staleCode } });
    holdNextCodePreview = true;
    const replacement = rNotebookSnapshot();
    registered.setActiveSession(replacement);
    const heldReplacement = heldCodePreview as CodePreviewEnvelope;
    expect(heldReplacement).toMatchObject({ kind: "codePreview", bufferInvalid: false, code: replacement.code });
    expect(heldReplacement.bufferId).not.toBe(initialPreview.bufferId);
    await vi.advanceTimersByTimeAsync(CODE_PREVIEW_EDIT_DEBOUNCE_MS);
    teardownPage(firstPage);
    expect(hostMessages.slice(staleStart)).toEqual([
      { kind: "codeChanged", bufferId: initialPreview.bufferId, code: staleCode },
      { kind: "codeChanged", bufferId: initialPreview.bufferId, code: staleCode }
    ]);

    const secondPage = await mountPage();
    expect(secondPage.editor).not.toBe(firstPage.editor);
    expect(secondPage.editor.state.doc.toString()).toBe(replacement.code);
    expect(undo(secondPage.editor)).toBe(false);

    const terminalCode = "clean_data <- function(df) {\n  # terminal valid edit\n  df\n}\n";
    const validTerminalStart = hostMessages.length;
    secondPage.editor.dispatch({
      changes: { from: 0, to: secondPage.editor.state.doc.length, insert: terminalCode }
    });
    teardownPage(secondPage);
    expect(hostMessages.slice(validTerminalStart)).toEqual([
      { kind: "codeChanged", bufferId: heldReplacement.bufferId, code: terminalCode }
    ]);

    const thirdPage = await mountPage();
    expect(thirdPage.editor.state.doc.toString()).toBe(terminalCode);
    const invalidTerminalStart = hostMessages.length;
    thirdPage.editor.dispatch({
      changes: { from: 0, to: thirdPage.editor.state.doc.length, insert: "invalid\ud800terminal" }
    });
    teardownPage(thirdPage);
    expect(hostMessages.slice(invalidTerminalStart)).toEqual([
      { kind: "codeChangedInvalid", bufferId: heldReplacement.bufferId }
    ]);

    const fourthPage = await mountPage();
    const invalidPreview = webviewMessages.at(-1) as CodePreviewEnvelope;
    expect(invalidPreview).toMatchObject({
      kind: "codePreview",
      bufferId: heldReplacement.bufferId,
      bufferInvalid: true
    });
    expect(fourthPage.editor.state.doc.toString()).not.toBe(terminalCode);

    nativeMocks.showSaveDialog.mockClear();
    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);
    expect(nativeMocks.showSaveDialog).not.toHaveBeenCalled();

    const recoveredCode = "clean_data <- function(df) {\n  df |> unique()\n}\n";
    fourthPage.editor.dispatch({
      changes: { from: 0, to: fourthPage.editor.state.doc.length, insert: recoveredCode }
    });
    writeText.mockClear();
    await expect(command("openWrangler.copyCode")()).resolves.toBe(recoveredCode);
    expect(writeText).toHaveBeenCalledWith(recoveredCode);
    teardownPage(fourthPage);

    const fifthPage = await mountPage();
    const recoveredPreview = webviewMessages.at(-1) as CodePreviewEnvelope;
    expect(recoveredPreview).toMatchObject({
      kind: "codePreview",
      bufferId: heldReplacement.bufferId,
      bufferInvalid: false,
      code: recoveredCode
    });
    exportFileSafely.mockClear();
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscode.Uri.file("/tmp/orders.clean.R"));
    await expect(command("openWrangler.exportCode")()).resolves.toBe(true);
    expect(exportFileSafely.mock.calls[0]?.[0]).toMatchObject({ contents: Buffer.from(recoveredCode, "utf8") });

    const staleListener = fifthPage.staleListener;
    teardownPage(fifthPage);
    staleListener({ kind: "codeChanged", bufferId: heldReplacement.bufferId, code: "# disposed stale text" });
    const requestCount = webviewMessages.filter(isSnapshotRequest).length;
    writeText.mockClear();
    await expect(command("openWrangler.copyCode")()).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(webviewMessages.filter(isSnapshotRequest)).toHaveLength(requestCount);
  } finally {
    vi.useRealTimers();
    if (activePage) teardownPage(activePage);
    Reflect.deleteProperty(globalThis, "acquireVsCodeApi");
    document.body.replaceChildren();
    vi.resetModules();
  }
});

it("keeps useful undo while bounding retained full-document history", async () => {
  vi.useRealTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const hostMessages: unknown[] = [];
  Object.defineProperty(globalThis, "acquireVsCodeApi", {
    configurable: true,
    value: () => ({ postMessage: (message: unknown) => hostMessages.push(message) })
  });

  try {
    vi.resetModules();
    await import("../webviews/codePreviewMain");
    const editorElement = document.querySelector<HTMLElement>(".cm-editor");
    const editor = editorElement ? EditorView.findFromDOM(editorElement) : null;
    if (!editor) throw new Error("Expected the production Code Preview editor.");
    const firstBufferId = "12345678-1234-4123-8123-123456789abc";
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: codePreviewMessage(firstBufferId, "def clean_data(df):\n    return df\n")
      })
    );

    const original = editor.state.doc.toString();
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: "# ordinary edit\n" } });
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(original);

    const secondBufferId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: codePreviewMessage(secondBufferId, "# replacement buffer\n")
      })
    );
    expect(undo(editor)).toBe(false);

    const scaledDocumentLength = CODE_PREVIEW_MAX_UTF8_BYTES / 64;
    for (let index = 0; index <= 64; index += 1) {
      editor.dispatch({
        changes: {
          from: 0,
          to: editor.state.doc.length,
          insert: String(index % 10).repeat(scaledDocumentLength)
        }
      });
    }
    const expectedSelection = Math.floor(editor.state.doc.length / 2);
    editor.dispatch({ selection: { anchor: expectedSelection } });
    await Promise.resolve();
    expect(editor.state.selection.main.head).toBe(expectedSelection);
    expect(undoDepth(editor.state)).toBe(0);
    expect(undo(editor)).toBe(false);
    const serializedHistory = JSON.stringify(editor.state.toJSON({ history: historyField }));
    expect(Buffer.byteLength(serializedHistory, "utf8")).toBeLessThan(CODE_PREVIEW_MAX_UTF8_BYTES);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    Reflect.deleteProperty(globalThis, "acquireVsCodeApi");
    document.body.replaceChildren();
    vi.resetModules();
  }
});

interface TestPage {
  readonly editor: EditorView;
  readonly dispose: () => void;
  readonly staleListener: (message: unknown) => void;
}

interface CodePreviewEnvelope {
  readonly kind: string;
  readonly bufferId: string;
  readonly bufferInvalid: boolean;
  readonly code: string;
}

function codePreviewMessage(
  bufferId: string,
  code: string
): CodePreviewEnvelope & {
  readonly editable: true;
  readonly runtimeIdentity: {
    readonly runtimeLanguage: "python";
    readonly dataframeFlavor: "pandas";
    readonly codeDialect: "python.pandas";
  };
} {
  return {
    kind: "codePreview",
    bufferId,
    bufferInvalid: false,
    code,
    editable: true,
    runtimeIdentity: {
      runtimeLanguage: "python",
      dataframeFlavor: "pandas",
      codeDialect: "python.pandas"
    }
  };
}

function isSnapshotRequest(value: unknown): boolean {
  return messageKind(value) === "codeSnapshotRequest";
}

function messageKind(value: unknown): unknown {
  return typeof value === "object" && value !== null ? (value as { kind?: unknown }).kind : undefined;
}
