import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookLiveVariableProvider } from "../extension/notebooks/pythonInteractiveCommands";
import type { RLiveVariableProvider } from "../extension/r/rInteractiveCommands";
import { CODE_PREVIEW_MAX_UTF8_BYTES } from "../shared/codePreviewLimits";
import {
  appliedStep,
  command,
  exportableSnapshot,
  nativeMocks,
  noDraftSnapshot,
  nodePresentation,
  register,
  resetNativeViewMocks,
  rNotebookSnapshot,
  snapshot,
  snapshotWithDraft,
  treeChildren
} from "./nativeViews.testFixtures";

describe("native state and presentation commands", () => {
  beforeEach(resetNativeViewMocks);

  it("serializes context writes and settles rollback after deferred and rejected writes", async () => {
    nativeMocks.registrationFailure = "command:openWrangler.reportIssue";
    const active = snapshotWithDraft();
    active.metadata = {
      ...active.metadata,
      capabilities: {
        ...active.metadata.capabilities,
        notebookInsert: true,
        documentInsert: true
      }
    };
    const firstWrite = deferred();
    const finalRollback = deferred();
    const finalRollbackApplied = deferred();
    const contextValues = new Map<string, boolean>();
    let contextWriteCount = 0;
    const executeContextCommand = async (...args: unknown[]): Promise<undefined> => {
      const [command, key, value] = args;
      if (command !== "setContext" || typeof key !== "string" || typeof value !== "boolean") return undefined;
      contextWriteCount += 1;
      if (contextWriteCount === 1) await firstWrite.promise;
      if (contextWriteCount === 8) await finalRollback.promise;
      if (key === "openWrangler.canInsertNotebookCode" && value) throw new Error("context write rejected");
      contextValues.set(key, value);
      if (contextWriteCount === 8) finalRollbackApplied.resolve();
      return undefined;
    };
    nativeMocks.executeCommand.mockImplementation(executeContextCommand as () => Promise<undefined>);

    try {
      expect(() => register(active)).toThrow("native registration failed: command:openWrangler.reportIssue");

      expect(nativeMocks.commands.size).toBe(0);
      expect(nativeMocks.treeDataProviders.size).toBe(0);
      expect(nativeMocks.webviewViewProviders.size).toBe(0);
      expect(nativeMocks.activeRegistrations.size).toBe(0);
      expect(nativeMocks.coordinatorListeners.size).toBe(0);
      expect(nativeMocks.registrationDisposals[0]).toBe("command:openWrangler.openSettings");
      expect(nativeMocks.registrationDisposals.at(-1)).toBe("tree:openWrangler.operations");
      expect(nativeMocks.executeCommand).toHaveBeenCalledTimes(1);

      firstWrite.resolve();
      await vi.waitFor(() => expect(nativeMocks.executeCommand).toHaveBeenCalledTimes(8));
      expect(contextValues.get("openWrangler.canInsertRDocumentCode")).toBe(true);
      finalRollback.resolve();
      await finalRollbackApplied.promise;

      expect(nativeMocks.executeCommand.mock.calls).toEqual([
        ["setContext", "openWrangler.hasDraft", true],
        ["setContext", "openWrangler.canChangePlan", false],
        ["setContext", "openWrangler.canInsertNotebookCode", true],
        ["setContext", "openWrangler.canInsertRDocumentCode", true],
        ["setContext", "openWrangler.hasDraft", false],
        ["setContext", "openWrangler.canChangePlan", false],
        ["setContext", "openWrangler.canInsertNotebookCode", false],
        ["setContext", "openWrangler.canInsertRDocumentCode", false]
      ]);
      expect(Object.fromEntries(contextValues)).toEqual({
        "openWrangler.hasDraft": false,
        "openWrangler.canChangePlan": false,
        "openWrangler.canInsertNotebookCode": false,
        "openWrangler.canInsertRDocumentCode": false
      });
    } finally {
      firstWrite.resolve();
      finalRollback.resolve();
      nativeMocks.executeCommand.mockImplementation(async () => undefined);
    }
  });

  it("keeps one context write in flight and drains only the latest reentrant update", async () => {
    const initial = snapshotWithDraft();
    initial.metadata = {
      ...initial.metadata,
      capabilities: {
        ...initial.metadata.capabilities,
        notebookInsert: true,
        documentInsert: true
      }
    };
    const latest = noDraftSnapshot();
    const firstWrite = deferred();
    let contextWriteCount = 0;
    const executeContextCommand = async (...args: unknown[]): Promise<undefined> => {
      const [command] = args;
      if (command !== "setContext") return undefined;
      contextWriteCount += 1;
      if (contextWriteCount === 1) await firstWrite.promise;
      if (contextWriteCount === 2) {
        for (const listener of nativeMocks.coordinatorListeners) {
          listener(undefined);
          listener(latest);
        }
      }
      return undefined;
    };
    nativeMocks.executeCommand.mockImplementation(executeContextCommand as () => Promise<undefined>);

    register(initial);
    expect(nativeMocks.executeCommand).toHaveBeenCalledOnce();
    firstWrite.resolve();
    await vi.waitFor(() => expect(nativeMocks.executeCommand).toHaveBeenCalledTimes(8));

    expect(nativeMocks.executeCommand.mock.calls).toEqual([
      ["setContext", "openWrangler.hasDraft", true],
      ["setContext", "openWrangler.canChangePlan", false],
      ["setContext", "openWrangler.canInsertNotebookCode", true],
      ["setContext", "openWrangler.canInsertRDocumentCode", true],
      ["setContext", "openWrangler.hasDraft", false],
      ["setContext", "openWrangler.canChangePlan", true],
      ["setContext", "openWrangler.canInsertNotebookCode", false],
      ["setContext", "openWrangler.canInsertRDocumentCode", false]
    ]);
  });

  it("rolls back coordinator side effects when a native provider constructor fails", () => {
    const failingProvider = {
      onDidChangeVariables: () => {
        throw new Error("notebook provider listener failed");
      },
      snapshot: () => undefined,
      refreshFromCommand: async () => undefined,
      dispose: () => undefined
    } as NotebookLiveVariableProvider;

    expect(() => register(noDraftSnapshot(), undefined, undefined, failingProvider)).toThrow(
      "notebook provider listener failed"
    );

    expect(nativeMocks.commands.size).toBe(0);
    expect(nativeMocks.treeDataProviders.size).toBe(0);
    expect(nativeMocks.webviewViewProviders.size).toBe(0);
    expect(nativeMocks.coordinatorListeners.size).toBe(0);
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

  it("uses a 128-bit nonce in the native Code Preview CSP and script", () => {
    register(noDraftSnapshot());
    const provider = nativeMocks.webviewViewProviders.get("openWrangler.codePreview");
    if (!provider) throw new Error("Expected the Code Preview provider to be registered.");
    const webview = {
      html: "",
      options: {},
      cspSource: "test-csp",
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: () => ({ dispose: () => undefined })
    };

    provider.resolveWebviewView({ description: undefined, webview });

    const script = webview.html.match(/<script type="module" nonce="([0-9a-f]{32})" src="([^"]+)"><\/script>/u);
    expect(script).not.toBeNull();
    expect(webview.html).toContain(`font-src test-csp; script-src 'nonce-${script?.[1]}' test-csp`);
    expect(script?.[2]).toBe("file:///tmp/openwrangler/media/codePreview.js");
  });

  it("never retains or reposts oversized generated code and recovers on a bounded snapshot", () => {
    const active = noDraftSnapshot();
    active.code = `${"é".repeat(CODE_PREVIEW_MAX_UTF8_BYTES / 2)}é`;
    const registered = register(active);
    const provider = nativeMocks.webviewViewProviders.get("openWrangler.codePreview");
    if (!provider) throw new Error("Expected the Code Preview provider to be registered.");
    const posted: unknown[] = [];
    let receive: ((message: unknown) => void) | undefined;
    provider.resolveWebviewView({
      description: undefined,
      webview: {
        html: "",
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
    });

    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toEqual({
      kind: "codePreviewInvalid",
      generation: 1,
      acknowledgedSequence: 0,
      reason: "utf8Bytes",
      editable: false,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "pandas",
        codeDialect: "python.pandas"
      }
    });
    expect(posted.at(-1)).not.toHaveProperty("code");

    active.code = "def clean_data(df):\n    return df\n";
    registered.setActiveSession(active);
    expect(posted.at(-1)).toMatchObject({
      kind: "codePreview",
      generation: 2,
      code: active.code,
      editable: true
    });
  });

  it("disposes replaced view listeners and ignores their delayed edits", () => {
    register(noDraftSnapshot());
    const provider = nativeMocks.webviewViewProviders.get("openWrangler.codePreview");
    if (!provider) throw new Error("Expected the Code Preview provider to be registered.");

    const createView = () => {
      const posted: unknown[] = [];
      let receive: ((message: unknown) => void) | undefined;
      let disposed = false;
      const view = {
        description: undefined as string | undefined,
        webview: {
          html: "",
          options: {},
          cspSource: "test-csp",
          asWebviewUri: (uri: unknown) => uri,
          postMessage: vi.fn(async (message: unknown) => {
            posted.push(message);
            return true;
          }),
          onDidReceiveMessage: (listener: (message: unknown) => void) => {
            receive = listener;
            return {
              dispose: () => {
                disposed = true;
              }
            };
          }
        }
      };
      return { view, posted, receive: () => receive, disposed: () => disposed };
    };

    const first = createView();
    provider.resolveWebviewView(first.view);
    first.receive()?.({ kind: "ready" });
    const second = createView();
    provider.resolveWebviewView(second.view);
    second.receive()?.({ kind: "ready" });

    expect(first.disposed()).toBe(true);
    first.receive()?.({
      kind: "codeChanged",
      generation: 1,
      sequence: 999,
      code: "raise RuntimeError('late replaced view')"
    });
    second.receive()?.({ kind: "ready" });
    expect(second.posted.at(-1)).toMatchObject({
      kind: "codePreview",
      generation: 1,
      acknowledgedSequence: 0,
      code: "def clean_data(df):\n    return df\n"
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

  it("routes selected-step edit and confirmed delete through the exact active session", async () => {
    const registered = register(noDraftSnapshot());
    const stepNode = treeChildren("openWrangler.cleaningSteps").find(
      (node) => (node.cleaningStepHandle as { stepId?: unknown } | undefined)?.stepId === appliedStep.id
    );
    expect(stepNode).toBeDefined();

    await command("openWrangler.editSelectedStep")(stepNode);
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledWith({
      action: "editStep",
      stepId: appliedStep.id,
      expectedSessionId: "session",
      expectedRevision: 0
    });

    nativeMocks.sendEditorActionForSession.mockClear();
    nativeMocks.showWarningMessage.mockResolvedValueOnce("Delete step");
    await command("openWrangler.deleteSelectedStep")(stepNode);
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "Delete Drop missing rows and replay every later cleaning step?",
      { modal: true },
      "Delete step"
    );
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledWith({
      action: "deleteStep",
      stepId: appliedStep.id,
      expectedSessionId: "session",
      expectedRevision: 0
    });

    nativeMocks.sendEditorActionForSession.mockClear();
    nativeMocks.showWarningMessage.mockResolvedValueOnce(undefined);
    await command("openWrangler.deleteSelectedStep")(stepNode);
    expect(nativeMocks.sendEditorActionForSession).not.toHaveBeenCalled();

    const advanced = noDraftSnapshot();
    advanced.metadata = { ...advanced.metadata, revision: 1 };
    registered.setActiveSession(advanced);
    await command("openWrangler.editSelectedStep")(stepNode);
    expect(nativeMocks.sendEditorActionForSession).not.toHaveBeenCalled();
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
    expect(
      operations.every((node) =>
        String(node.tooltip).includes("Apply or discard the current draft before adding another cleaning step.")
      )
    ).toBe(true);

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
    expect(
      operations.every((node) =>
        String(node.tooltip).includes(
          "Saved notebook snapshots are viewing only. Rerun the cell and open its live variable to add cleaning steps."
        )
      )
    ).toBe(true);
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
      generation: 1,
      acknowledgedSequence: 0,
      code: expect.stringMatching(/Read-only saved notebook snapshot/u),
      editable: false,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "polars",
        codeDialect: "python.polars"
      }
    });
    expect(codePreviewView.description).toBe("Python");

    receive?.({ kind: "codeChanged", generation: 1, sequence: 1, code: "raise RuntimeError('should be ignored')" });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      generation: 1,
      acknowledgedSequence: 0,
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
      generation: 2,
      acknowledgedSequence: 0,
      code: editable.code,
      editable: true,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "pandas",
        codeDialect: "python.pandas"
      }
    });

    receive?.({
      kind: "codeChanged",
      generation: 2,
      sequence: 1,
      code: "raise RuntimeError('unknown field')",
      unexpected: true
    });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({ code: editable.code });

    receive?.({
      kind: "codeChanged",
      generation: 2,
      sequence: 1,
      code: "def clean_data(df):\n    return df.dropna()\n"
    });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({ code: "def clean_data(df):\n    return df.dropna()\n" });

    receive?.({ kind: "codeInvalid", generation: 2, sequence: 2, reason: "utf8Bytes" });
    expect(posted.at(-1)).toEqual({
      kind: "codePreviewInvalid",
      generation: 2,
      acknowledgedSequence: 2,
      reason: "utf8Bytes",
      editable: true,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "pandas",
        codeDialect: "python.pandas"
      }
    });
    expect(posted.at(-1)).not.toHaveProperty("code");

    registered.setActiveSession(editable);
    expect(posted.at(-1)).toMatchObject({ kind: "codePreviewInvalid", generation: 2, reason: "utf8Bytes" });

    receive?.({ kind: "codeChanged", generation: 2, sequence: 3, code: "def clean_data(df):\n    return df\n" });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({
      kind: "codePreview",
      generation: 2,
      code: "def clean_data(df):\n    return df\n"
    });

    editable.code = "def clean_data(df):\n    return df.fillna(0)\n";
    registered.setActiveSession(editable);
    expect(posted.at(-1)).toMatchObject({ kind: "codePreview", generation: 3, code: editable.code });
    receive?.({ kind: "codeChanged", generation: 2, sequence: 999, code: "stale <- true" });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({ generation: 3, code: editable.code });

    const rEditable = rNotebookSnapshot();
    registered.setActiveSession(rEditable);
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      generation: 4,
      acknowledgedSequence: 0,
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
      generation: 5,
      acknowledgedSequence: 0,
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
});

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}
