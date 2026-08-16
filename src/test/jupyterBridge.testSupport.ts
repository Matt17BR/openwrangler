import { vi } from "vitest";
import type { ExtensionContext, NotebookDocument, NotebookEditor } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type { SessionCoordinator } from "../extension/sessionCoordinator";

type CommandHandler = (...args: unknown[]) => unknown;

const notebookMocks = vi.hoisted(() => ({
  workspaceTrusted: true,
  commands: new Map<string, CommandHandler>(),
  notebookDocuments: [] as NotebookDocument[],
  activeNotebookEditor: undefined as NotebookEditor | undefined,
  activeTabInput: undefined as unknown,
  activeTabIsActive: true,
  activeTabGroupIsActive: true,
  activeTabGroupViewColumn: 1,
  activeEditorReads: 0,
  showWarningMessage: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showQuickPick: vi.fn(async (items: readonly unknown[], _options?: unknown) => items[0]),
  createPanel: vi.fn(),
  restoreEditorGroupAfterQuickPick: vi.fn(async () => undefined),
  kernelOrigins: [] as Array<{ uri: string; document: NotebookDocument | undefined }>,
  rKernelOrigins: [] as Array<{ uri: string; document: NotebookDocument | undefined }>,
  rVerifiedSelections: [] as unknown[],
  rDelegateDisposals: [] as NotebookDocument[],
  tokenSources: [] as Array<{
    readonly token: { isCancellationRequested: boolean };
    disposed: boolean;
  }>,
  executeCode: vi.fn((code: string) => notebookKernelOutputs(code)),
  getKernel: vi.fn(async () => ({
    language: "python",
    executeCode: notebookMocks.executeCode
  })),
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
  class CancellationTokenSource {
    readonly token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    };
    disposed = false;
    constructor() {
      notebookMocks.tokenSources.push(this);
    }
    cancel(): void {
      this.token.isCancellationRequested = true;
    }
    dispose(): void {
      this.disposed = true;
    }
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
    CancellationTokenSource,
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
          get isActive() {
            return notebookMocks.activeTabGroupIsActive;
          },
          get viewColumn() {
            return notebookMocks.activeTabGroupViewColumn;
          },
          get activeTab() {
            return notebookMocks.activeTabInput === undefined
              ? undefined
              : { input: notebookMocks.activeTabInput, isActive: notebookMocks.activeTabIsActive };
          }
        }
      },
      showWarningMessage: notebookMocks.showWarningMessage,
      showInformationMessage: notebookMocks.showInformationMessage,
      showQuickPick: notebookMocks.showQuickPick
    },
    workspace: {
      get isTrusted() {
        return notebookMocks.workspaceTrusted;
      },
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
  OpenWranglerPanel: { create: notebookMocks.createPanel },
  restoreEditorGroupAfterQuickPick: notebookMocks.restoreEditorGroupAfterQuickPick
}));

vi.mock("../extension/notebooks/kernelBridge", () => ({
  shouldRegisterNotebookFormatters: () => true,
  KernelBridge: class {
    constructor(_context: ExtensionContext, document: NotebookDocument) {
      notebookMocks.kernelOrigins.push({ uri: document.uri.toString(), document });
    }
  }
}));

vi.mock("../extension/r/rKernelBridge", () => ({
  RKernelBridge: class {
    static fromVerifiedSelection(
      context: ExtensionContext,
      document: NotebookDocument,
      verifiedSelection: unknown
    ): unknown {
      notebookMocks.rVerifiedSelections.push(verifiedSelection);
      return new this(context, document);
    }
    constructor(_context: ExtensionContext, document: NotebookDocument) {
      notebookMocks.rKernelOrigins.push({ uri: document.uri.toString(), document });
      this.document = document;
    }
    private readonly document: NotebookDocument;
    async dispose(): Promise<void> {
      notebookMocks.rDelegateDisposals.push(this.document);
    }
  }
}));

import * as vscode from "vscode";
import {
  discoverVariablesForSelectedKernel,
  isRNotebookVariableDiscovery,
  openDiscoveredRNotebookVariable,
  registerNotebookCommands
} from "../extension/notebooks/jupyterBridge";
import {
  buildNotebookVariableDiscoveryCode,
  buildPySparkNotebookPreflightCode,
  parsePySparkNotebookPreflightOutput
} from "../extension/notebooks/notebookVariableDiscovery";

export function jupyterBridgeApi(): {
  readonly buildNotebookVariableDiscoveryCode: typeof buildNotebookVariableDiscoveryCode;
  readonly buildPySparkNotebookPreflightCode: typeof buildPySparkNotebookPreflightCode;
  readonly discoverVariablesForSelectedKernel: typeof discoverVariablesForSelectedKernel;
  readonly isRNotebookVariableDiscovery: typeof isRNotebookVariableDiscovery;
  readonly openDiscoveredRNotebookVariable: typeof openDiscoveredRNotebookVariable;
  readonly parsePySparkNotebookPreflightOutput: typeof parsePySparkNotebookPreflightOutput;
  readonly vscode: typeof vscode;
} {
  return {
    buildNotebookVariableDiscoveryCode,
    buildPySparkNotebookPreflightCode,
    discoverVariablesForSelectedKernel,
    isRNotebookVariableDiscovery,
    openDiscoveredRNotebookVariable,
    parsePySparkNotebookPreflightOutput,
    vscode
  };
}

export function jupyterBridgeMocks(): typeof notebookMocks {
  return notebookMocks;
}

export function resetNotebookCommandTest(): void {
  notebookMocks.workspaceTrusted = true;
  notebookMocks.commands.clear();
  notebookMocks.notebookDocuments.length = 0;
  notebookMocks.activeNotebookEditor = undefined;
  notebookMocks.activeTabInput = undefined;
  notebookMocks.activeTabIsActive = true;
  notebookMocks.activeTabGroupIsActive = true;
  notebookMocks.activeTabGroupViewColumn = 1;
  notebookMocks.activeEditorReads = 0;
  notebookMocks.showWarningMessage.mockClear();
  notebookMocks.showInformationMessage.mockClear();
  notebookMocks.showQuickPick.mockReset();
  notebookMocks.showQuickPick.mockImplementation(async (items) => items[0]);
  notebookMocks.createPanel.mockReset();
  notebookMocks.restoreEditorGroupAfterQuickPick.mockReset();
  notebookMocks.restoreEditorGroupAfterQuickPick.mockResolvedValue(undefined);
  notebookMocks.kernelOrigins.length = 0;
  notebookMocks.rKernelOrigins.length = 0;
  notebookMocks.rVerifiedSelections.length = 0;
  notebookMocks.rDelegateDisposals.length = 0;
  notebookMocks.tokenSources.length = 0;
  notebookMocks.executeCode.mockReset();
  notebookMocks.executeCode.mockImplementation((code) => notebookKernelOutputs(code));
  notebookMocks.getKernel.mockReset();
  notebookMocks.getKernel.mockResolvedValue({
    language: "python",
    executeCode: notebookMocks.executeCode
  });
  notebookMocks.activateJupyter.mockReset();
  notebookMocks.activateJupyter.mockResolvedValue({ kernels: { getKernel: notebookMocks.getKernel } });
}

export function register(): {
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

export function command(id: string): CommandHandler {
  const handler = notebookMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}

export function notebook(uri: string, notebookType = "jupyter-notebook"): NotebookDocument {
  return {
    uri: vscode.Uri.parse(uri),
    notebookType,
    isClosed: false
  } as unknown as NotebookDocument;
}

export function closeNotebook(document: NotebookDocument): void {
  Object.defineProperty(document, "isClosed", { configurable: true, value: true });
}

export function editor(document: NotebookDocument, viewColumn = 1): NotebookEditor {
  return { notebook: document, viewColumn } as NotebookEditor;
}

export function serializedFileUri(path: string): Record<string, unknown> {
  return { $mid: 1, scheme: "file", path };
}

export function discoveryOutputs(
  code: string,
  payload: unknown = {
    protocolVersion: 1,
    truncated: false,
    variables: [
      {
        name: "frame",
        type: "pandas.DataFrame",
        backend: "pandas"
      }
    ]
  }
): AsyncIterable<{ items: Array<{ mime: string; data: Uint8Array }> }> {
  const marker = code.match(/__OPEN_WRANGLER_VARIABLES_START_([a-f0-9]{32})__/)?.[1];
  if (!marker) throw new Error("Expected notebook discovery code to contain a response marker.");
  const text = [
    `__OPEN_WRANGLER_VARIABLES_START_${marker}__`,
    typeof payload === "string" ? payload : JSON.stringify(payload),
    `__OPEN_WRANGLER_VARIABLES_END_${marker}__`
  ].join("\n");
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: Buffer.from(text, "utf8")
          }
        ]
      };
    }
  };
}

export function rDiscoveryOutputs(
  code: string,
  payload: unknown
): AsyncIterable<{ items: Array<{ mime: string; data: Uint8Array }> }> {
  const marker = code.match(/__OPEN_WRANGLER_R_VARIABLES_START_([a-f0-9]{32})__/)?.[1];
  if (!marker) throw new Error("Expected R notebook discovery code to contain a response marker.");
  const text = [
    `__OPEN_WRANGLER_R_VARIABLES_START_${marker}__`,
    typeof payload === "string" ? payload : JSON.stringify(payload),
    `__OPEN_WRANGLER_R_VARIABLES_END_${marker}__`
  ].join("\n");
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: Buffer.from(text, "utf8")
          }
        ]
      };
    }
  };
}

export function rNotebookKernel(disposeStatusListener: () => void = () => undefined): {
  readonly language: "R";
  readonly status: "idle";
  readonly executeCode: typeof notebookMocks.executeCode;
  onDidChangeStatus(listener: (status: "idle") => unknown): { dispose(): void };
} {
  return {
    language: "R",
    status: "idle",
    executeCode: notebookMocks.executeCode,
    onDidChangeStatus: () => ({ dispose: disposeStatusListener })
  };
}

export function notebookKernelOutputs(
  code: string
): AsyncIterable<{ items: Array<{ mime: string; data: Uint8Array }> }> {
  if (code.includes("__OPEN_WRANGLER_VARIABLES_START_")) return discoveryOutputs(code);
  throw new Error("Expected notebook discovery code.");
}

export function preflightText(marker: string, isPySpark: boolean, version: string | null): string {
  return [
    `__OPEN_WRANGLER_PYSPARK_VERSION_START_${marker}__`,
    JSON.stringify({ isPySpark, protocolVersion: 1, version }),
    `__OPEN_WRANGLER_PYSPARK_VERSION_END_${marker}__`
  ].join("\n");
}

export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
