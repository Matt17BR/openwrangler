import { vi } from "vitest";
import type { ExtensionContext } from "vscode";
import type { SessionCoordinator, ActiveSessionSnapshot } from "../extension/sessionCoordinator";
import type { ExportOptions, SessionMetadata, TransformStep } from "../shared/protocol";
import type { NotebookLiveVariableProvider } from "../extension/notebooks/pythonInteractiveCommands";
import type { RLiveVariableProvider } from "../extension/r/rInteractiveCommands";

type CommandHandler = (...args: unknown[]) => unknown;
type NotebookInsertionStatus = "applied" | "stale" | "indeterminate" | "rejected";
interface TestTreeNode {
  label: string;
  id?: string;
  description?: string;
  command?: unknown;
  contextValue?: string;
  tooltip?: unknown;
  viewSortHandle?: unknown;
}
interface TestTreeProvider {
  getChildren(): TestTreeNode[];
  onDidChangeTreeData?(listener: (node: TestTreeNode | undefined) => unknown): { dispose(): void };
}

const nativeMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async () => undefined),
  treeDataProviders: new Map<string, TestTreeProvider>(),
  webviewViewProviders: new Map<string, { resolveWebviewView(view: unknown): void }>(),
  sendEditorAction: vi.fn(() => true),
  sendEditorActionForSession: vi.fn(async () => true),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showSaveDialog: vi.fn(async () => undefined as unknown),
  showQuickPick: vi.fn<(items: readonly unknown[], options?: unknown) => Promise<unknown>>(async () => undefined),
  showInputBox: vi.fn<(options?: unknown) => Promise<string | undefined>>(async () => undefined),
  withProgress: vi.fn(async (_options: unknown, task: () => Promise<unknown>) => task()),
  workspaceFolders: [] as Array<{ uri: unknown }>,
  workspaceTrusted: true,
  notebookDocuments: [] as Array<{ uri: unknown; isClosed: boolean; cellCount: number }>,
  activeNotebookEditor: undefined as
    | { notebook: { uri: unknown; isClosed: boolean; cellCount: number }; selections: Array<{ end: number }> }
    | undefined,
  insertGeneratedNotebookCell: vi.fn(async (): Promise<{ status: NotebookInsertionStatus }> => ({ status: "applied" })),
  insertGeneratedRDocumentCode: vi.fn(async (): Promise<{ status: NotebookInsertionStatus }> => ({ status: "applied" }))
}));

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => unknown>();
    readonly event = (listener: (event: T) => unknown) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void {
      for (const listener of this.listeners) listener(event);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  class TreeItem {
    constructor(
      readonly label: string,
      readonly collapsibleState: number
    ) {}
  }

  class ThemeIcon {
    constructor(readonly id: string) {}
  }

  class Uri {
    private constructor(
      readonly fsPath: string,
      readonly scheme: string,
      readonly authority = ""
    ) {}
    static file(path: string): Uri {
      return new Uri(path, "file");
    }
    static parse(value: string): Uri {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)/u.exec(value);
      return new Uri(match?.[3] ?? value, match?.[1] ?? "file", match?.[2] ?? "");
    }
    static joinPath(base: Uri, ...parts: string[]): Uri {
      const segments: string[] = [];
      for (const segment of [base.fsPath, ...parts].join("/").split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
      }
      return new Uri(`/${segments.join("/")}`, base.scheme, base.authority);
    }
    toString(): string {
      return `${this.scheme}://${this.authority}${this.fsPath}`;
    }
  }

  const disposable = () => ({ dispose: () => undefined });
  return {
    EventEmitter,
    TreeItem,
    TreeItemCollapsibleState: { None: 0 },
    ThemeIcon,
    Uri,
    ViewColumn: { Active: 1 },
    ProgressLocation: { Notification: 15 },
    version: "test",
    commands: {
      executeCommand: nativeMocks.executeCommand,
      registerCommand: (id: string, handler: CommandHandler) => {
        nativeMocks.commands.set(id, handler);
        return disposable();
      }
    },
    window: {
      get activeNotebookEditor() {
        return nativeMocks.activeNotebookEditor;
      },
      registerTreeDataProvider: (id: string, provider: TestTreeProvider) => {
        nativeMocks.treeDataProviders.set(id, provider);
        return disposable();
      },
      registerWebviewViewProvider: (id: string, provider: { resolveWebviewView(view: unknown): void }) => {
        nativeMocks.webviewViewProviders.set(id, provider);
        return disposable();
      },
      showInformationMessage: nativeMocks.showInformationMessage,
      showWarningMessage: nativeMocks.showWarningMessage,
      showErrorMessage: nativeMocks.showErrorMessage,
      showSaveDialog: nativeMocks.showSaveDialog,
      showQuickPick: nativeMocks.showQuickPick,
      showInputBox: nativeMocks.showInputBox,
      withProgress: nativeMocks.withProgress
    },
    workspace: {
      get isTrusted(): boolean {
        return nativeMocks.workspaceTrusted;
      },
      get workspaceFolders() {
        return nativeMocks.workspaceFolders;
      },
      get notebookDocuments() {
        return nativeMocks.notebookDocuments;
      },
      getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
      fs: {}
    },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
      openExternal: vi.fn(async () => true)
    }
  };
});

vi.mock("../extension/webviewPanel", () => ({
  SESSION_BOUND_EXPORT_DATA_COMMAND: "openWrangler.internal.exportSessionData",
  OpenWranglerPanel: {
    sendEditorAction: nativeMocks.sendEditorAction,
    sendEditorActionForSession: nativeMocks.sendEditorActionForSession
  }
}));
vi.mock("../extension/notebooks/notebookInsertion", () => ({
  insertGeneratedNotebookCell: nativeMocks.insertGeneratedNotebookCell
}));
vi.mock("../extension/r/rDocumentInsertion", () => ({
  insertGeneratedRDocumentCode: nativeMocks.insertGeneratedRDocumentCode
}));
vi.mock("../extension/configuration", () => ({
  getSetting: <T>(_key: string, fallback: T): T => fallback
}));

import { registerNativeViews } from "../extension/nativeViews";

const appliedStep: TransformStep = {
  id: "applied",
  kind: "dropMissingRows",
  params: {}
};

function resetNativeViewMocks(): void {
  nativeMocks.commands.clear();
  nativeMocks.treeDataProviders.clear();
  nativeMocks.webviewViewProviders.clear();
  nativeMocks.executeCommand.mockClear();
  nativeMocks.sendEditorAction.mockClear();
  nativeMocks.sendEditorAction.mockReturnValue(true);
  nativeMocks.sendEditorActionForSession.mockClear();
  nativeMocks.sendEditorActionForSession.mockResolvedValue(true);
  nativeMocks.showInformationMessage.mockClear();
  nativeMocks.showWarningMessage.mockClear();
  nativeMocks.showErrorMessage.mockClear();
  nativeMocks.showSaveDialog.mockReset();
  nativeMocks.showSaveDialog.mockResolvedValue(undefined);
  nativeMocks.showQuickPick.mockReset();
  nativeMocks.showQuickPick.mockResolvedValue(undefined);
  nativeMocks.showInputBox.mockReset();
  nativeMocks.showInputBox.mockResolvedValue(undefined);
  nativeMocks.withProgress.mockClear();
  nativeMocks.workspaceFolders.length = 0;
  nativeMocks.workspaceTrusted = true;
  nativeMocks.notebookDocuments.length = 0;
  nativeMocks.activeNotebookEditor = undefined;
  nativeMocks.insertGeneratedNotebookCell.mockReset();
  nativeMocks.insertGeneratedNotebookCell.mockResolvedValue({ status: "applied" });
  nativeMocks.insertGeneratedRDocumentCode.mockReset();
  nativeMocks.insertGeneratedRDocumentCode.mockResolvedValue({ status: "applied" });
}

function register(
  snapshot: ActiveSessionSnapshot,
  notebookDocument?: { uri: unknown; isClosed: boolean; cellCount: number },
  textDocumentOrigin?: unknown,
  pythonVariables?: NotebookLiveVariableProvider,
  rVariables?: RLiveVariableProvider
): {
  setActiveSession(snapshot: ActiveSessionSnapshot | undefined): void;
  setSession(snapshot: ActiveSessionSnapshot): void;
  exportData: ReturnType<typeof vi.fn>;
  clearActiveStepInspection: ReturnType<typeof vi.fn>;
  notebookInsertionStatus():
    | "applied"
    | "stale"
    | "indeterminate"
    | "rejected"
    | "untrusted"
    | "missing-code"
    | "unsupported-source"
    | "missing-notebook"
    | "missing-source-document"
    | "dispatching"
    | undefined;
  viewSortDispatchStatus():
    | "sent"
    | "invalid-target"
    | "stale-target"
    | "inspection-active"
    | "priority-boundary"
    | "panel-unavailable"
    | "unsupported"
    | undefined;
} {
  let activeSnapshot: ActiveSessionSnapshot | undefined = snapshot;
  const sessions = new Map<string, ActiveSessionSnapshot>([[snapshot.sessionId, snapshot]]);
  const exportData = vi.fn(
    async (sessionId: string, revision: number, destination: string, options: ExportOptions) => ({
      kind: "dataExported" as const,
      revision,
      path: destination,
      format: options.format,
      shape: { rows: 2, columns: 1 }
    })
  );
  const activeSessionListeners = new Set<(snapshot: ActiveSessionSnapshot | undefined) => unknown>();
  const clearActiveStepInspection = vi.fn();
  const coordinator = {
    activeSession: () => activeSnapshot,
    sessionSnapshot: (sessionId: string) => sessions.get(sessionId),
    exportData,
    activeNotebookDocument: () => notebookDocument,
    activeTextDocumentOrigin: () => textDocumentOrigin,
    clearActiveStepInspection,
    onDidChangeActiveSession: (listener: (snapshot: ActiveSessionSnapshot | undefined) => unknown) => {
      activeSessionListeners.add(listener);
      return { dispose: () => activeSessionListeners.delete(listener) };
    }
  } as unknown as SessionCoordinator;
  const context = {
    extensionPath: "/tmp/openwrangler",
    subscriptions: []
  } as unknown as ExtensionContext;
  const nativeViews = registerNativeViews(context, coordinator, pythonVariables, rVariables);
  return {
    setActiveSession(nextSnapshot) {
      activeSnapshot = nextSnapshot;
      if (nextSnapshot) sessions.set(nextSnapshot.sessionId, nextSnapshot);
      for (const listener of activeSessionListeners) listener(nextSnapshot);
    },
    setSession(nextSnapshot) {
      sessions.set(nextSnapshot.sessionId, nextSnapshot);
    },
    exportData,
    clearActiveStepInspection,
    notebookInsertionStatus: () => nativeViews.notebookInsertionStatus(),
    viewSortDispatchStatus: () => nativeViews.viewSortDispatchStatus()
  };
}

function command(id: string): CommandHandler {
  const handler = nativeMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}

function treeChildren(id: string): TestTreeNode[] {
  const provider = nativeMocks.treeDataProviders.get(id);
  if (!provider) throw new Error(`Expected ${id} to be registered.`);
  return provider.getChildren();
}

function nodePresentation(node: TestTreeNode): [string, string | undefined] {
  return [node.label, node.description];
}

function vscodeUri(path: string): unknown {
  return resourceUri("file", path);
}

function resourceUri(scheme: string, fsPath: string, authority = ""): unknown {
  return {
    scheme,
    authority,
    fsPath,
    toString: () => `${scheme}://${authority}${fsPath}`
  };
}

function noDraftSnapshot(): ActiveSessionSnapshot {
  return snapshot({
    mode: "editing",
    steps: [appliedStep]
  });
}

function snapshotWithDraft(): ActiveSessionSnapshot {
  return snapshot({
    mode: "editing",
    steps: [appliedStep],
    draftStep: {
      id: "draft",
      kind: "dropMissingRows",
      params: {}
    }
  });
}

function exportableSnapshot(sessionId: string, label: string, revision: number): ActiveSessionSnapshot {
  const source = { kind: "file" as const, label, path: `/workspace/${label}`, uri: `file:///workspace/${label}` };
  return {
    sessionId,
    code: "def clean_data(df):\n    return df\n",
    metadata: {
      protocolVersion: 2,
      sessionId,
      revision,
      backend: "polars",
      mode: "editing",
      source,
      capabilities: {
        editable: true,
        lazy: true,
        cancel: true,
        exportCsv: true,
        exportParquet: true,
        notebookInsert: false
      },
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [{ id: "c:value", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }],
      filterModel: { filters: [], sort: [] },
      steps: [appliedStep]
    },
    viewState: {
      filterModel: { filters: [], sort: [] },
      columnWidths: {},
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    }
  };
}

function pandasExportableSnapshot(
  sessionId: string,
  label: string,
  revision: number,
  rowAxis: SessionMetadata["rowAxis"]
): ActiveSessionSnapshot {
  const result = exportableSnapshot(sessionId, label, revision);
  result.metadata = { ...result.metadata, backend: "pandas", rowAxis };
  return result;
}

function notebookVariableSnapshot(): ActiveSessionSnapshot {
  const result = noDraftSnapshot();
  result.metadata = {
    ...result.metadata,
    backend: "pandas",
    source: {
      kind: "notebookVariable",
      label: "frame",
      variableName: "frame",
      uri: "file:///workspace/shared.ipynb"
    },
    capabilities: {
      editable: true,
      lazy: false,
      cancel: true,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: true
    }
  };
  return result;
}

function rNotebookSnapshot(): ActiveSessionSnapshot {
  const result = noDraftSnapshot();
  const { rowAxis: _rowAxis, ...nonPandasMetadata } = result.metadata;
  void _rowAxis;
  result.code = "clean_data <- function(df) {\n  df\n}\n";
  result.metadata = {
    ...nonPandasMetadata,
    backend: "r",
    rDataframeFlavor: "r.data.frame",
    mode: "editing",
    source: {
      kind: "notebookVariable",
      label: "orders",
      variableName: "orders",
      uri: "file:///workspace/orders.ipynb"
    },
    capabilities: {
      editable: true,
      lazy: false,
      cancel: false,
      exportCsv: false,
      exportParquet: false,
      notebookInsert: true,
      supportedOperations: ["renameColumn"]
    }
  };
  return result;
}

function rDocumentSnapshot(): ActiveSessionSnapshot {
  const result = noDraftSnapshot();
  const { rowAxis: _rowAxis, ...nonPandasMetadata } = result.metadata;
  void _rowAxis;
  result.code = "clean_data <- function(df) {\n  df\n}\n";
  result.metadata = {
    ...nonPandasMetadata,
    backend: "r",
    rDataframeFlavor: "r.data.frame",
    mode: "editing",
    source: {
      kind: "documentVariable",
      label: "orders",
      variableName: "orders",
      uri: "file:///workspace/orders.R"
    },
    capabilities: {
      editable: true,
      lazy: false,
      cancel: false,
      exportCsv: false,
      exportParquet: false,
      notebookInsert: false,
      documentInsert: true,
      supportedOperations: ["renameColumn"]
    }
  };
  return result;
}

function notebookDocument(uri: string, cellCount: number, isClosed = false) {
  return {
    uri: { toString: () => uri },
    isClosed,
    cellCount
  };
}

function snapshot(
  plan: Pick<SessionMetadata, "mode" | "steps"> & { draftStep?: TransformStep; source?: SessionMetadata["source"] }
): ActiveSessionSnapshot {
  return {
    sessionId: "session",
    code: "def clean_data(df):\n    return df\n",
    metadata: {
      protocolVersion: 2,
      sessionId: "session",
      revision: 0,
      backend: "pandas",
      rowAxis: { kind: "positional", levelNames: [] },
      source: { kind: "file", label: "sample.csv", path: "/tmp/sample.csv" },
      ...plan
    } as unknown as SessionMetadata,
    viewState: {
      filterModel: { filters: [], sort: [] },
      columnWidths: {},
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    }
  };
}

export {
  appliedStep,
  command,
  exportableSnapshot,
  pandasExportableSnapshot,
  nativeMocks,
  noDraftSnapshot,
  nodePresentation,
  notebookDocument,
  notebookVariableSnapshot,
  register,
  resetNativeViewMocks,
  resourceUri,
  rDocumentSnapshot,
  rNotebookSnapshot,
  snapshot,
  snapshotWithDraft,
  treeChildren,
  vscodeUri
};
