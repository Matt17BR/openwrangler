import { beforeEach, describe, expect, it, vi } from "vitest";
import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "vscode";
import type { SessionCoordinator, ActiveSessionSnapshot } from "../extension/sessionCoordinator";
import type { SessionMetadata, TransformStep } from "../shared/protocol";
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

describe("native operation commands", () => {
  beforeEach(() => {
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
    nativeMocks.withProgress.mockClear();
    nativeMocks.workspaceFolders.length = 0;
    nativeMocks.workspaceTrusted = true;
    nativeMocks.notebookDocuments.length = 0;
    nativeMocks.activeNotebookEditor = undefined;
    nativeMocks.insertGeneratedNotebookCell.mockReset();
    nativeMocks.insertGeneratedNotebookCell.mockResolvedValue({ status: "applied" });
    nativeMocks.insertGeneratedRDocumentCode.mockReset();
    nativeMocks.insertGeneratedRDocumentCode.mockResolvedValue({ status: "applied" });
  });

  it("forwards startOperation without a kind to the generic webview operation picker", async () => {
    register(noDraftSnapshot());

    await command("openWrangler.startOperation")();

    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledOnce();
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledWith({
      action: "openOperation",
      expectedSessionId: "session",
      expectedRevision: 0
    });
  });

  it("offers a file entry point before a dataframe is open", () => {
    const registered = register(noDraftSnapshot());
    registered.setActiveSession(undefined);

    expect(treeChildren("openWrangler.operations").map((node) => [node.label, node.command])).toEqual([
      ["Open a data file", expect.objectContaining({ command: "openWrangler.openPath" })]
    ]);
  });

  it("shows cached variables from the exact active notebook in Operations", () => {
    const variableProvider: NotebookLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      snapshot: () => ({
        state: "ready",
        notebookLabel: "analysis.ipynb",
        message: "Live dataframes",
        variables: [
          {
            handle: "live-frame-handle",
            label: "orders",
            description: "Polars · DataFrame",
            detail: "Live in analysis.ipynb"
          }
        ]
      }),
      refreshFromCommand: async () => undefined,
      dispose: () => undefined
    };
    const registered = register(noDraftSnapshot(), undefined, undefined, variableProvider);
    registered.setActiveSession(undefined);

    expect(treeChildren("openWrangler.operations").map((node) => [node.label, node.command])).toEqual([
      [
        "orders",
        expect.objectContaining({
          command: "openWrangler.openCachedNotebookVariable",
          arguments: ["live-frame-handle"]
        })
      ],
      ["Refresh notebook dataframes", expect.objectContaining({ command: "openWrangler.refreshNotebookVariables" })],
      ["Open a data file", expect.objectContaining({ command: "openWrangler.openPath" })]
    ]);
  });

  it("shows IRkernel dataframes without an unrelated terminal prompt and refreshes that notebook", async () => {
    const refreshNotebook = vi.fn(async () => undefined);
    const refreshTerminal = vi.fn(async () => true);
    const notebookProvider: NotebookLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      snapshot: () => ({
        state: "ready",
        notebookLabel: "analysis-r.ipynb",
        message: "Live dataframes",
        variables: [
          {
            handle: "r-notebook-handle",
            label: "orders_tbl",
            description: "R · tibble",
            detail: "Live in analysis-r.ipynb"
          }
        ]
      }),
      refreshFromCommand: refreshNotebook,
      dispose: () => undefined
    };
    const terminalProvider: RLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      startAutomaticDiscovery: () => undefined,
      snapshot: () => ({
        state: "idle",
        terminalLabel: "R session",
        message: "Start or select an R session.",
        variables: []
      }),
      refreshFromCommand: refreshTerminal,
      shutdown: async () => undefined,
      dispose: () => undefined
    };
    const registered = register(noDraftSnapshot(), undefined, undefined, notebookProvider, terminalProvider);
    registered.setActiveSession(undefined);

    expect(treeChildren("openWrangler.operations").map((node) => node.label)).toEqual([
      "orders_tbl",
      "Refresh notebook dataframes",
      "Open a data file"
    ]);

    await command("openWrangler.refreshLiveDataframes")();
    expect(refreshNotebook).toHaveBeenCalledOnce();
    expect(refreshTerminal).not.toHaveBeenCalled();
  });

  it("routes the Operations refresh action to the active R terminal when no notebook is active", async () => {
    const refreshTerminal = vi.fn(async () => true);
    const terminalProvider: RLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      startAutomaticDiscovery: () => undefined,
      snapshot: () => ({
        state: "ready",
        terminalLabel: "R",
        message: "1 loaded",
        variables: [
          {
            handle: "r-terminal-handle",
            label: "orders_dt",
            description: "R · data.table",
            detail: "R"
          }
        ]
      }),
      refreshFromCommand: refreshTerminal,
      shutdown: async () => undefined,
      dispose: () => undefined
    };
    register(noDraftSnapshot(), undefined, undefined, undefined, terminalProvider);

    await command("openWrangler.refreshLiveDataframes")();
    expect(refreshTerminal).toHaveBeenCalledOnce();
  });

  it("shows dataframes discovered in the exact active R terminal", () => {
    const variableProvider: RLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      startAutomaticDiscovery: () => undefined,
      snapshot: () => ({
        state: "ready",
        terminalLabel: "R",
        message: "2 loaded",
        variables: [
          {
            handle: "r-frame-handle",
            label: "shots",
            description: "R · tibble",
            detail: "R"
          },
          {
            handle: "r-table-handle",
            label: "accounts",
            description: "R · data.table",
            detail: "R"
          }
        ]
      }),
      refreshFromCommand: async () => true,
      shutdown: async () => undefined,
      dispose: () => undefined
    };
    const registered = register(noDraftSnapshot(), undefined, undefined, undefined, variableProvider);
    registered.setActiveSession(undefined);

    expect(treeChildren("openWrangler.operations").map((node) => [node.label, node.description, node.command])).toEqual(
      [
        [
          "Refresh R dataframes",
          "R · 2 loaded",
          expect.objectContaining({ command: "openWrangler.refreshRInteractiveVariables" })
        ],
        [
          "shots",
          "R · tibble",
          expect.objectContaining({
            command: "openWrangler.openCachedRInteractiveVariable",
            arguments: ["r-frame-handle"]
          })
        ],
        [
          "accounts",
          "R · data.table",
          expect.objectContaining({
            command: "openWrangler.openCachedRInteractiveVariable",
            arguments: ["r-table-handle"]
          })
        ],
        [
          "Open a data file",
          "Choose CSV, Parquet, Excel, or JSONL",
          expect.objectContaining({ command: "openWrangler.openPath" })
        ]
      ]
    );
  });

  it("puts an explicit R discovery action first while the active terminal has not been read", () => {
    const variableProvider: RLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      startAutomaticDiscovery: () => undefined,
      snapshot: () => ({
        state: "idle",
        terminalLabel: "R",
        message: "Dataframes appear here after the R prompt returns.",
        variables: []
      }),
      refreshFromCommand: async () => true,
      shutdown: async () => undefined,
      dispose: () => undefined
    };
    const registered = register(noDraftSnapshot(), undefined, undefined, undefined, variableProvider);
    registered.setActiveSession(undefined);

    expect(treeChildren("openWrangler.operations").map((node) => [node.label, node.description, node.command])).toEqual(
      [
        ["Show R dataframes…", "R", expect.objectContaining({ command: "openWrangler.refreshRInteractiveVariables" })],
        [
          "Open a data file",
          "Choose CSV, Parquet, Excel, or JSONL",
          expect.objectContaining({ command: "openWrangler.openPath" })
        ]
      ]
    );
  });

  it("offers one action that starts R after the previous terminal closed", () => {
    const variableProvider: RLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      startAutomaticDiscovery: () => undefined,
      snapshot: () => ({
        state: "idle",
        terminalLabel: "R session",
        message: "The R terminal closed. Start or select another R session.",
        variables: []
      }),
      refreshFromCommand: async () => true,
      shutdown: async () => undefined,
      dispose: () => undefined
    };
    const registered = register(noDraftSnapshot(), undefined, undefined, undefined, variableProvider);
    registered.setActiveSession(undefined);

    expect(treeChildren("openWrangler.operations").map((node) => [node.label, node.description, node.command])).toEqual(
      [
        [
          "Start R and show dataframes…",
          "R session",
          expect.objectContaining({ command: "openWrangler.openRInteractiveVariable" })
        ],
        [
          "Open a data file",
          "Choose CSV, Parquet, Excel, or JSONL",
          expect.objectContaining({ command: "openWrangler.openPath" })
        ]
      ]
    );
  });

  it("routes cleaning-step selection through the exact active session and rejects stale steps", async () => {
    const registered = register(noDraftSnapshot());

    await command("openWrangler.selectStep")(appliedStep.id);
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledWith({
      action: "selectStep",
      expectedSessionId: "session",
      expectedRevision: 0,
      stepId: appliedStep.id
    });
    expect(registered.clearActiveStepInspection).not.toHaveBeenCalled();

    nativeMocks.sendEditorActionForSession.mockClear();
    await command("openWrangler.selectStep")("retired-step");
    expect(nativeMocks.sendEditorActionForSession).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "That cleaning step is no longer available in the active dataframe."
    );

    await command("openWrangler.selectStep")();
    expect(registered.clearActiveStepInspection).toHaveBeenCalledOnce();
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledWith({
      action: "selectStep",
      expectedSessionId: "session",
      expectedRevision: 0
    });

    nativeMocks.sendEditorActionForSession.mockResolvedValueOnce(false);
    await command("openWrangler.selectStep")(appliedStep.id);
    expect(nativeMocks.showInformationMessage).toHaveBeenCalledWith(
      "Open the active dataframe editor before selecting a cleaning step."
    );
  });

  it("shows and dispatches only operations advertised by the active dataframe", async () => {
    const limited = noDraftSnapshot();
    limited.metadata = {
      ...limited.metadata,
      capabilities: {
        editable: true,
        lazy: false,
        cancel: true,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false,
        supportedOperations: ["renameColumn"]
      }
    };
    register(limited);

    expect(treeChildren("openWrangler.operations").map((node) => node.label)).toEqual(["Rename column"]);

    await command("openWrangler.startOperation")("customCode");
    expect(nativeMocks.sendEditorActionForSession).not.toHaveBeenCalled();
    expect(nativeMocks.showInformationMessage).toHaveBeenCalledWith("Custom code is not available for this dataframe.");

    await command("openWrangler.startOperation")("renameColumn");
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledOnce();
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledWith({
      action: "openOperation",
      expectedSessionId: "session",
      expectedRevision: 0,
      operationKind: "renameColumn"
    });
  });

  it("pins editLatestStep to the active session revision", async () => {
    register(noDraftSnapshot());

    await command("openWrangler.editLatestStep")();

    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledOnce();
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledWith({
      action: "editLatest",
      expectedSessionId: "session",
      expectedRevision: 0
    });
  });

  it("makes each effective native filter node remove that column filter", async () => {
    const filtered = noDraftSnapshot();
    filtered.viewState.filterModel = {
      logic: "and",
      filters: [
        {
          column: "city",
          type: "string",
          valueFilter: {
            kind: "values",
            selectedValues: ["Berlin"],
            includeNulls: false,
            includeNaN: false
          },
          predicates: [{ kind: "predicate", operator: "contains", value: "er" }]
        },
        {
          column: "sales",
          type: "float",
          valueFilter: {
            kind: "values",
            selectedValues: [],
            includeNulls: false,
            includeNaN: false
          },
          predicates: []
        }
      ],
      sort: [
        { column: "city", direction: "asc", nulls: "last" },
        { column: "sales", direction: "desc", nulls: "first" }
      ]
    };
    const registered = register(filtered);

    const nodes = treeChildren("openWrangler.filters");
    expect(nodes.map(nodePresentation)).toEqual([
      ["city", "1 selected value · 1 condition"],
      ["city", "Priority 1 · Ascending · nulls last"],
      ["sales", "Priority 2 · Descending · nulls first"]
    ]);
    expect(nodes[0]?.command).toEqual({
      command: "openWrangler.clearViewFilterColumn",
      title: "Remove city filter",
      arguments: ["city"]
    });

    await command("openWrangler.clearViewFilterColumn")("city");
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith({
      action: "clearFilterColumn",
      column: "city"
    });

    expect(nodes[1]?.command).toEqual(
      expect.objectContaining({
        command: "openWrangler.openViewSort",
        title: "Edit city sort",
        arguments: ["city", nodes[1]?.viewSortHandle]
      })
    );
    expect(nodes[1]?.contextValue).toBe("openWrangler.viewSortFirst");
    expect(nodes[2]?.contextValue).toBe("openWrangler.viewSortLast");

    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.openViewSort")("sales");
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith({
      action: "openFilters",
      column: "sales"
    });

    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.moveViewSortUp")(nodes[2]);
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith({
      action: "changeViewSort",
      column: "sales",
      sortAction: "moveUp",
      expectedSessionId: "session",
      expectedSortModelSignature: JSON.stringify(filtered.viewState.filterModel.sort),
      expectedSortIndex: 1
    });

    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.moveViewSortUp")({ id: nodes[2]?.id });
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith({
      action: "changeViewSort",
      column: "sales",
      sortAction: "moveUp",
      expectedSessionId: "session",
      expectedSortModelSignature: JSON.stringify(filtered.viewState.filterModel.sort),
      expectedSortIndex: 1
    });

    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.moveViewSortUp")({ viewSortHandle: nodes[2]?.viewSortHandle });
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith({
      action: "changeViewSort",
      column: "sales",
      sortAction: "moveUp",
      expectedSessionId: "session",
      expectedSortModelSignature: JSON.stringify(filtered.viewState.filterModel.sort),
      expectedSortIndex: 1
    });

    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.moveViewSortDown")(nodes[1]);
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith({
      action: "changeViewSort",
      column: "city",
      sortAction: "moveDown",
      expectedSessionId: "session",
      expectedSortModelSignature: JSON.stringify(filtered.viewState.filterModel.sort),
      expectedSortIndex: 0
    });

    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.removeViewSort")(nodes[2]);
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith({
      action: "changeViewSort",
      column: "sales",
      sortAction: "remove",
      expectedSessionId: "session",
      expectedSortModelSignature: JSON.stringify(filtered.viewState.filterModel.sort),
      expectedSortIndex: 1
    });

    nativeMocks.sendEditorAction.mockClear();
    registered.setActiveSession(undefined);
    await command("openWrangler.moveViewSortUp")(nodes[2]);
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();
    registered.setActiveSession(filtered);

    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.moveViewSortUp")(nodes[1]);
    await command("openWrangler.moveViewSortDown")(nodes[2]);
    await command("openWrangler.removeViewSort")("sales");
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();

    filtered.viewState.filterModel = {
      ...filtered.viewState.filterModel,
      sort: [...filtered.viewState.filterModel.sort].reverse()
    };
    registered.setActiveSession(filtered);
    await command("openWrangler.removeViewSort")(nodes[2]);
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();

    filtered.stepInspectionActive = true;
    registered.setActiveSession(filtered);
    const inspectionNodes = treeChildren("openWrangler.filters");
    expect(nodePresentation(inspectionNodes[0]!)).toEqual(["Filters and sorts paused", "Inspecting an applied step"]);
    expect(inspectionNodes[0]?.command).toEqual({
      command: "openWrangler.selectStep",
      title: "Return to current view",
      arguments: []
    });
    for (const node of inspectionNodes.slice(1)) {
      expect(node.command).toBeUndefined();
      expect(node.contextValue).toBeUndefined();
      expect(String(node.tooltip)).toContain("Return to the current view to edit filters and sorts");
    }
    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.moveViewSortDown")(nodes[1]);
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();

    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.clearViewFilterColumn")("sales");
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();

    filtered.stepInspectionActive = undefined;
    registered.setActiveSession(filtered);
    const restoredNodes = treeChildren("openWrangler.filters");
    expect(restoredNodes[0]?.command).toBeDefined();
    expect(restoredNodes[1]?.contextValue).toBe("openWrangler.viewSortFirst");
    expect(restoredNodes[2]?.contextValue).toBe("openWrangler.viewSortLast");
  });

  it("shows unavailable native views and does not dispatch unsupported viewing actions", async () => {
    const partial = exportableSnapshot("partial-session", "partial.csv", 1);
    partial.metadata.capabilities = {
      ...partial.metadata.capabilities,
      filter: false,
      sort: false,
      profile: false,
      columnValues: false
    };
    partial.viewState.filterModel = {
      filters: [
        {
          column: "value",
          type: "integer",
          predicates: [{ kind: "predicate", operator: "gte", value: 1 }]
        }
      ],
      sort: [{ column: "value", direction: "asc", nulls: "last" }]
    };
    register(partial);

    expect(treeChildren("openWrangler.summary").map(nodePresentation)).toContainEqual([
      "Profiles unavailable",
      "This dataframe does not support profiling"
    ]);
    expect(treeChildren("openWrangler.filters").map(nodePresentation)).toEqual([
      ["Filters and sorts unavailable", "Not supported by this dataframe"]
    ]);

    await command("openWrangler.clearViewFilterColumn")("value");
    await command("openWrangler.openViewSort")("value");
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();
    expect(nativeMocks.showInformationMessage).toHaveBeenLastCalledWith("Sorting is unavailable for this dataframe.");
  });

  it("keeps cloned sort handles stable across unrelated updates and rejects an ABA-stale node", async () => {
    const filtered = noDraftSnapshot();
    const originalSort = [
      { column: "city", direction: "asc" as const, nulls: "last" as const },
      { column: "sales", direction: "desc" as const, nulls: "first" as const }
    ];
    filtered.viewState.filterModel = { filters: [], sort: originalSort };
    const registered = register(filtered);
    const provider = nativeMocks.treeDataProviders.get("openWrangler.filters");
    expect(provider).toBeDefined();
    const onRefresh = vi.fn();
    const subscription = provider?.onDidChangeTreeData?.(onRefresh);

    const originalNodes = treeChildren("openWrangler.filters");
    const originalSales = originalNodes[1]!;
    expect(originalSales.id).toMatch(/^openWrangler\.viewSort:/u);

    filtered.viewState = { ...filtered.viewState, selectedColumnId: "c:unrelated" };
    registered.setActiveSession(filtered);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(treeChildren("openWrangler.filters")[1]?.id).toBe(originalSales.id);

    filtered.viewState.filterModel = { filters: [], sort: [...originalSort].reverse() };
    registered.setActiveSession(filtered);
    expect(onRefresh).toHaveBeenCalledOnce();
    treeChildren("openWrangler.filters");

    filtered.viewState.filterModel = { filters: [], sort: originalSort };
    registered.setActiveSession(filtered);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    const refreshedSales = treeChildren("openWrangler.filters")[1]!;
    expect(refreshedSales.id).not.toBe(originalSales.id);

    nativeMocks.sendEditorAction.mockClear();
    await command("openWrangler.moveViewSortUp")({ id: originalSales.id });
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();
    expect(registered.viewSortDispatchStatus()).toBe("stale-target");
    expect(nativeMocks.showInformationMessage).toHaveBeenLastCalledWith(
      "The sort order changed. Use the refreshed Filters / Sorts action."
    );

    await command("openWrangler.moveViewSortUp")({ id: refreshedSales.id });
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "changeViewSort", column: "sales", sortAction: "moveUp" })
    );
    expect(registered.viewSortDispatchStatus()).toBe("sent");
    subscription?.dispose();
  });

  it("rejects malformed sort payloads and surfaces an unavailable owning panel", async () => {
    const filtered = noDraftSnapshot();
    filtered.viewState.filterModel = {
      filters: [],
      sort: [
        { column: "city", direction: "asc", nulls: "last" },
        { column: "sales", direction: "desc", nulls: "first" }
      ]
    };
    const registered = register(filtered);
    const nodes = treeChildren("openWrangler.filters");

    await command("openWrangler.moveViewSortUp")({
      viewSortHandle: { kind: "openWrangler.viewSort", token: "not-a-token", extra: true }
    });
    expect(registered.viewSortDispatchStatus()).toBe("invalid-target");
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();

    nativeMocks.sendEditorAction.mockReturnValueOnce(false);
    await command("openWrangler.moveViewSortUp")({ id: nodes[1]?.id });
    expect(registered.viewSortDispatchStatus()).toBe("panel-unavailable");
    expect(nativeMocks.showInformationMessage).toHaveBeenLastCalledWith(
      "Open the active dataframe editor before changing sort order."
    );
  });

  it("does not forward editLatestStep while a draft is active", async () => {
    register(snapshotWithDraft());
    nativeMocks.showInformationMessage.mockImplementationOnce(() => new Promise<never>(() => undefined));

    const operations = treeChildren("openWrangler.operations");
    expect(operations.every((node) => node.description !== "Apply or discard the current draft")).toBe(true);
    expect(operations.every((node) => String(node.tooltip).includes("Apply or discard the current draft first"))).toBe(
      true
    );

    await command("openWrangler.editLatestStep")();

    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();
    expect(nativeMocks.showInformationMessage).toHaveBeenCalledWith(
      "Apply or discard the current draft before editing the latest step."
    );
  });

  it("reflects a saved notebook snapshot across every native view and active-session changes", async () => {
    const savedOutput = snapshot({
      mode: "viewing",
      steps: [],
      source: { kind: "notebookOutput", label: "Saved sales preview" }
    });
    savedOutput.code = "";
    savedOutput.metadata = {
      protocolVersion: 2,
      sessionId: "saved-snapshot",
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: { kind: "notebookOutput", label: "Saved sales preview" },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: 4, columns: 3 },
      filteredShape: { rows: 4, columns: 3 },
      schema: [
        { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
        { id: "c:score", name: "score", position: 1, rawType: "Int64", type: "integer", nullable: true },
        { id: "c:group", name: "group", position: 2, rawType: "String", type: "string", nullable: false }
      ],
      filterModel: { logic: "and", filters: [], sort: [] },
      steps: []
    };
    savedOutput.viewState.selectedColumnId = "c:score";
    const registered = register(savedOutput);

    const operations = treeChildren("openWrangler.operations");
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((node) => node.description !== "Viewing mode" && node.command === undefined)).toBe(true);
    expect(operations.every((node) => String(node.tooltip).includes("Available in editing mode"))).toBe(true);
    expect(treeChildren("openWrangler.summary").map(nodePresentation)).toEqual([
      ["Saved sales preview", "Polars · viewing"],
      ["Shape", "4 × 3"],
      ["Columns", "3"],
      ["Selected column", "score"],
      ["Missing cells", "Profiling…"],
      ["Duplicate rows", "Profiling…"]
    ]);
    expect(treeChildren("openWrangler.filters").map(nodePresentation)).toEqual([
      ["No filters or sorts", "Current view"]
    ]);
    expect(treeChildren("openWrangler.cleaningSteps").map(nodePresentation)).toEqual([["Original data", "Selected"]]);

    const provider = nativeMocks.webviewViewProviders.get("openWrangler.codePreview");
    if (!provider) throw new Error("Expected the Code Preview provider to be registered.");
    const posted: unknown[] = [];
    let receive: ((message: unknown) => void) | undefined;
    const codePreviewView = {
      description: undefined as string | undefined,
      webview: {
        options: {},
        cspSource: "test-csp",
        asWebviewUri: (uri: unknown) => uri,
        postMessage: vi.fn(async (message: unknown) => {
          posted.push(message);
          return true;
        }),
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receive = listener;
          return { dispose: () => undefined };
        }
      }
    };
    provider.resolveWebviewView(codePreviewView);

    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      code: expect.stringMatching(/Read-only saved notebook snapshot/u),
      editable: false,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "polars",
        codeDialect: "python.polars"
      }
    });
    expect(codePreviewView.description).toBe("Python");

    receive?.({ kind: "codeChanged", code: "raise RuntimeError('should be ignored')" });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      code: expect.stringMatching(/Read-only saved notebook snapshot/u),
      editable: false,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "polars",
        codeDialect: "python.polars"
      }
    });

    const editable = noDraftSnapshot();
    registered.setActiveSession(editable);
    expect(treeChildren("openWrangler.operations").every((node) => node.command !== undefined)).toBe(true);
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      code: editable.code,
      editable: true,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "pandas",
        codeDialect: "python.pandas"
      }
    });

    receive?.({ kind: "codeChanged", code: "raise RuntimeError('unknown field')", unexpected: true });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({ code: editable.code });

    receive?.({ kind: "codeChanged", code: "def clean_data(df):\n    return df.dropna()\n" });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({ code: "def clean_data(df):\n    return df.dropna()\n" });

    const rEditable = rNotebookSnapshot();
    registered.setActiveSession(rEditable);
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      code: rEditable.code,
      editable: true,
      runtimeIdentity: {
        runtimeLanguage: "r",
        dataframeFlavor: "r.data.frame",
        codeDialect: "r.base"
      }
    });
    expect(codePreviewView.description).toBe("R");

    const viewingOnly = noDraftSnapshot();
    viewingOnly.metadata = { ...viewingOnly.metadata, backend: "pyspark", mode: "viewing" };
    viewingOnly.code = "# A viewing-only backend cannot expose editable generated code.";
    registered.setActiveSession(viewingOnly);
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      code: viewingOnly.code,
      editable: false,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "pyspark",
        codeDialect: null
      }
    });
    expect(codePreviewView.description).toBeUndefined();
  });

  it("disambiguates a selected duplicate label by its human column position", () => {
    const duplicate = snapshot({ mode: "viewing", steps: [] });
    duplicate.metadata = {
      protocolVersion: 2,
      sessionId: "duplicate-summary",
      revision: 0,
      backend: "pandas",
      mode: "viewing",
      source: { kind: "notebookVariable", label: "duplicate_frame", variableName: "duplicate_frame" },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: true,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: 2, columns: 2 },
      filteredShape: { rows: 2, columns: 2 },
      schema: [
        { id: "c:left", name: "duplicate", position: 0, rawType: "Int64", type: "integer", nullable: false },
        { id: "c:right", name: "duplicate", position: 1, rawType: "Float64", type: "float", nullable: false }
      ],
      filterModel: { filters: [], sort: [] },
      steps: []
    };
    duplicate.viewState.selectedColumnId = "c:right";
    register(duplicate);

    expect(treeChildren("openWrangler.summary").map(nodePresentation)).toContainEqual([
      "Selected column",
      "duplicate (column 2)"
    ]);
  });

  it("labels sampled duplicate statistics in the native Summary view", () => {
    const sampled = exportableSnapshot("sampled-summary", "sampled.csv", 0);
    sampled.metadata.stats = {
      missingCells: 0,
      missingRows: 0,
      duplicateRows: 4,
      duplicateRowsSampleSize: 50_000,
      missingValuesByColumn: [{ column: "value", count: 0 }]
    };
    register(sampled);

    expect(treeChildren("openWrangler.summary").map(nodePresentation)).toContainEqual([
      "Duplicate rows (sample of 50,000)",
      "4"
    ]);
  });

  it("ignores caller-provided export destinations and still opens the Save dialog", async () => {
    register(noDraftSnapshot());

    const hostileDestination = vscodeUri("/workspace/source.csv");
    await expect(command("openWrangler.exportCode")(hostileDestination)).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Export Open Wrangler Python Code",
        filters: { "Python script": ["py"] },
        saveLabel: "Export code"
      })
    );
    expect(nativeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("uses an R script name and filter when exporting generated R code", async () => {
    register(rNotebookSnapshot());

    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledWith({
      title: "Export Open Wrangler R Code",
      defaultUri: expect.objectContaining({ fsPath: "/workspace/orders.clean.R" }),
      filters: { "R script": ["R", "r"] },
      saveLabel: "Export code"
    });
  });

  it("exports the exact webview session even when another dataframe becomes active during the dialogs", async () => {
    const origin = exportableSnapshot("origin-session", "orders.csv", 3);
    const other = exportableSnapshot("other-session", "customers.csv", 8);
    const registered = register(origin);
    nativeMocks.showQuickPick.mockImplementationOnce(async (items) => {
      registered.setActiveSession(other);
      return (items as Array<{ format: "csv" | "parquet" }>)[0];
    });
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

    await expect(command("openWrangler.internal.exportSessionData")("origin-session", 3)).resolves.toBe(true);

    expect(registered.exportData).toHaveBeenCalledWith("origin-session", 3, "/workspace/orders.cleaned.csv", "csv");
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultUri: expect.objectContaining({ fsPath: "/workspace/orders.cleaned.csv" })
      })
    );
  });

  it("pins a global cleaned-data export before a dialog can change the active session", async () => {
    const origin = exportableSnapshot("origin-session", "orders.csv", 3);
    const other = exportableSnapshot("other-session", "customers.csv", 8);
    const registered = register(origin);
    nativeMocks.showQuickPick.mockImplementationOnce(async (items) => {
      registered.setActiveSession(other);
      return (items as Array<{ format: "csv" | "parquet" }>)[1];
    });
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.parquet"));

    await expect(command("openWrangler.exportData")()).resolves.toBe(true);

    expect(registered.exportData).toHaveBeenCalledWith(
      "origin-session",
      3,
      "/workspace/orders.cleaned.parquet",
      "parquet"
    );
  });

  it("offers only CSV when an editable R document session advertises native export", async () => {
    const active = rDocumentSnapshot();
    active.metadata.capabilities = {
      ...active.metadata.capabilities,
      exportCsv: true,
      exportParquet: false
    };
    const registered = register(active);
    nativeMocks.showQuickPick.mockImplementationOnce(async (items) => (items as unknown[])[0]);
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

    await expect(command("openWrangler.exportData")()).resolves.toBe(true);

    expect(nativeMocks.showQuickPick).toHaveBeenCalledWith(
      [{ label: "CSV", description: "Comma-separated values", format: "csv" }],
      { title: "Export Cleaned Data", placeHolder: "Choose a file format" }
    );
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledWith({
      title: "Export Cleaned Data",
      defaultUri: expect.objectContaining({ fsPath: "/workspace/orders.cleaned.csv" }),
      filters: { CSV: ["csv"] },
      saveLabel: "Export data"
    });
    expect(registered.exportData).toHaveBeenCalledWith("session", 0, "/workspace/orders.cleaned.csv", "csv");
  });

  it("rejects a session-bound export when its originating revision advances during the Save dialog", async () => {
    const origin = exportableSnapshot("origin-session", "orders.csv", 3);
    const registered = register(origin);
    nativeMocks.showQuickPick.mockImplementationOnce(async (items) => (items as unknown[])[0]);
    nativeMocks.showSaveDialog.mockImplementationOnce(async () => {
      registered.setSession(exportableSnapshot("origin-session", "orders.csv", 4));
      return vscodeUri("/workspace/orders.cleaned.csv");
    });

    await expect(command("openWrangler.internal.exportSessionData")("origin-session", 3)).resolves.toBe(false);

    expect(registered.exportData).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "The dataframe changed while export was open. Review the current data and try again."
    );
  });

  it("rechecks Workspace Trust after the cleaned-data Save dialog", async () => {
    const registered = register(exportableSnapshot("origin-session", "orders.csv", 3));
    nativeMocks.showQuickPick.mockImplementationOnce(async (items) => (items as unknown[])[0]);
    nativeMocks.showSaveDialog.mockImplementationOnce(async () => {
      nativeMocks.workspaceTrusted = false;
      return vscodeUri("/workspace/orders.cleaned.csv");
    });

    await expect(command("openWrangler.exportData")()).resolves.toBe(false);

    expect(registered.exportData).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "Trust this workspace before Open Wrangler can export cleaned data."
    );
  });

  it.each([
    { args: [] },
    { args: ["origin-session"] },
    { args: ["", 3] },
    { args: ["origin-session", -1] },
    { args: ["origin-session", 1.5] },
    { args: [{ sessionId: "origin-session" }, 3] }
  ])("rejects malformed session-bound export arguments without opening a dialog", async ({ args }) => {
    register(exportableSnapshot("origin-session", "orders.csv", 3));

    await expect(command("openWrangler.internal.exportSessionData")(...args)).resolves.toBe(false);

    expect(nativeMocks.showQuickPick).not.toHaveBeenCalled();
    expect(nativeMocks.showSaveDialog).not.toHaveBeenCalled();
  });

  it("rechecks Workspace Trust after the Save dialog before writing", async () => {
    register(noDraftSnapshot());
    nativeMocks.showSaveDialog.mockImplementationOnce(async () => {
      nativeMocks.workspaceTrusted = false;
      return vscodeUri("/workspace/clean.py");
    });
    nativeMocks.showWarningMessage.mockImplementationOnce(() => new Promise<never>(() => undefined));

    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "Trust this workspace before Open Wrangler can export code."
    );
    expect(nativeMocks.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Exported Open Wrangler code")
    );
  });

  it("routes a hard-link source alias returned by the public Save dialog through the source guard", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openwrangler-native-export-"));
    const source = path.join(directory, "source.csv");
    const alias = path.join(directory, "source-alias.py");
    const contents = "value\n1\n";
    try {
      await writeFile(source, contents);
      await link(source, alias);
      register(
        snapshot({
          mode: "editing",
          steps: [appliedStep],
          source: {
            kind: "file",
            label: "source.csv",
            path: source,
            uri: "file://malformed-source-metadata"
          }
        })
      );
      nativeMocks.showSaveDialog.mockResolvedValueOnce(resourceUri("file", alias));

      await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

      expect(await readFile(source, "utf8")).toBe(contents);
      expect(await readFile(alias, "utf8")).toBe(contents);
      expect((await readdir(directory)).filter((name) => name.startsWith(".openwrangler-"))).toEqual([]);
      expect(nativeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("never overwrites the active source")
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an exact remote source URI in the default script destination", async () => {
    register(
      snapshot({
        mode: "editing",
        steps: [appliedStep],
        source: {
          kind: "file",
          label: "sales.csv",
          path: "/workspace/data/sales.csv",
          uri: "vscode-remote://ssh-remote+example/workspace/data/sales.csv"
        }
      })
    );

    await command("openWrangler.exportCode")();

    const calls = nativeMocks.showSaveDialog.mock.calls as unknown[][];
    const options = calls[0]?.[0] as {
      defaultUri?: { scheme?: string; authority?: string; fsPath?: string };
    };
    expect(options.defaultUri).toMatchObject({
      scheme: "vscode-remote",
      authority: "ssh-remote+example",
      fsPath: "/workspace/data/sales.clean.py"
    });
  });

  it("rejects a remote source authority that differs from the active workspace host", async () => {
    register(
      snapshot({
        mode: "editing",
        steps: [appliedStep],
        source: {
          kind: "file",
          label: "sales.csv",
          path: "/workspace/data/sales.csv",
          uri: "vscode-remote://ssh-remote+stale/workspace/data/sales.csv"
        }
      })
    );
    nativeMocks.workspaceFolders.push({
      uri: resourceUri("vscode-remote", "/workspace", "ssh-remote+current")
    });
    nativeMocks.showSaveDialog.mockResolvedValueOnce(
      resourceUri("vscode-remote", "/workspace/data/sales.clean.py", "ssh-remote+current")
    );

    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

    expect(nativeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("active source no longer belongs to the current VS Code remote workspace host")
    );
  });

  it("inserts notebook code into the exact originating document while another notebook is active", async () => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    const other = notebookDocument("file:///workspace/other.ipynb", 5);
    nativeMocks.notebookDocuments.push(origin, other);
    nativeMocks.activeNotebookEditor = { notebook: other, selections: [{ end: 1 }] };
    register(notebookVariableSnapshot(), origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(true);

    expect(nativeMocks.insertGeneratedNotebookCell).toHaveBeenCalledWith(
      origin,
      3,
      "def clean_data(df):\n    return df\n",
      { source: "frame", backend: "pandas", languageId: "python" }
    );
  });

  it("inserts generated R into its originating notebook with the R cell language", async () => {
    const origin = notebookDocument("file:///workspace/orders.ipynb", 4);
    const active = rNotebookSnapshot();
    nativeMocks.notebookDocuments.push(origin);
    nativeMocks.activeNotebookEditor = { notebook: origin, selections: [{ end: 2 }] };
    register(active, origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(true);

    expect(nativeMocks.insertGeneratedNotebookCell).toHaveBeenCalledWith(origin, 2, active.code, {
      source: "orders",
      backend: "r",
      languageId: "r"
    });
  });

  it("uses the R-file insertion command only for a document-variable session", async () => {
    const active = rDocumentSnapshot();
    const origin = {
      kind: "textDocument" as const,
      document: {
        uri: { fsPath: "/workspace/analysis.R", toString: () => "file:///workspace/analysis.R" },
        version: 1
      },
      version: 1
    };
    register(active, undefined, origin);

    await expect(command("openWrangler.insertRDocumentCode")()).resolves.toBe(true);

    expect(nativeMocks.insertGeneratedRDocumentCode).toHaveBeenCalledWith(origin, active.code);
    expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
    expect(nativeMocks.showInformationMessage).toHaveBeenCalledWith("Inserted generated R into analysis.R.");
  });

  it("does not wait for an actionless missing-code notification", async () => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    const active = notebookVariableSnapshot();
    active.code = "";
    nativeMocks.notebookDocuments.push(origin);
    nativeMocks.showInformationMessage.mockImplementationOnce(() => new Promise<never>(() => undefined));
    const registered = register(active, origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

    expect(registered.notebookInsertionStatus()).toBe("missing-code");
    expect(nativeMocks.showInformationMessage).toHaveBeenCalledWith(
      "Add a cleaning step before inserting generated code."
    );
    expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
  });

  it("rejects a same-URI replacement instead of retargeting notebook insertion", async () => {
    const origin = notebookDocument("file:///workspace/shared.ipynb", 3, true);
    const replacement = notebookDocument("file:///workspace/shared.ipynb", 4);
    nativeMocks.notebookDocuments.push(replacement);
    nativeMocks.activeNotebookEditor = { notebook: replacement, selections: [{ end: 2 }] };
    nativeMocks.showWarningMessage.mockImplementationOnce(() => new Promise<never>(() => undefined));
    register(notebookVariableSnapshot(), origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

    expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "Reopen the originating notebook before inserting generated code."
    );
  });

  it.each([
    {
      status: "stale" as const,
      channel: "warning" as const,
      message: "changed or was replaced"
    },
    {
      status: "indeterminate" as const,
      channel: "warning" as const,
      message: "Inspect the notebook before retrying"
    },
    {
      status: "rejected" as const,
      channel: "error" as const,
      message: "VS Code could not insert"
    }
  ])("does not report insertion success when the helper result is $status", async ({ status, channel, message }) => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    nativeMocks.notebookDocuments.push(origin);
    nativeMocks.insertGeneratedNotebookCell.mockResolvedValueOnce({ status });
    const registered = register(notebookVariableSnapshot(), origin);
    const messageMock = channel === "warning" ? nativeMocks.showWarningMessage : nativeMocks.showErrorMessage;
    messageMock.mockImplementationOnce(() => new Promise<never>(() => undefined));

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

    expect(registered.notebookInsertionStatus()).toBe(status);
    expect(messageMock).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(nativeMocks.showInformationMessage).not.toHaveBeenCalledWith(
      "Inserted the generated cleaning code into its notebook."
    );
    expect(nativeMocks.insertGeneratedNotebookCell).toHaveBeenCalledOnce();
  });
});

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
    async (sessionId: string, revision: number, destination: string, format: "csv" | "parquet") => ({
      kind: "dataExported" as const,
      revision,
      path: destination,
      format,
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
  result.code = "clean_data <- function(df) {\n  df\n}\n";
  result.metadata = {
    ...result.metadata,
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
  result.code = "clean_data <- function(df) {\n  df\n}\n";
  result.metadata = {
    ...result.metadata,
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
      source: { kind: "file", label: "sample.csv", path: "/tmp/sample.csv" },
      ...plan
    } as SessionMetadata,
    viewState: {
      filterModel: { filters: [], sort: [] },
      columnWidths: {},
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    }
  };
}
