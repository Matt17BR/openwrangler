import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookLiveVariableProvider } from "../extension/notebooks/pythonInteractiveCommands";
import type { RLiveVariableProvider } from "../extension/r/rInteractiveCommands";
import * as codePreviewLimits from "../shared/codePreviewLimits";
import { stepInspectionResponse } from "./sessionCoordinatorTestFixtures";
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
  treeChildren,
  uncancelledViewToken
} from "./nativeViews.testFixtures";

describe("native state and presentation commands", () => {
  beforeEach(resetNativeViewMocks);

  it("does not defer Open Source File until another dataframe becomes active", async () => {
    const registered = register(exportableSnapshot("original", "original.csv", 1));
    registered.setActiveSession(undefined);

    const action = command("openWrangler.openSourceFile")();
    const immediateMessages = nativeMocks.showInformationMessage.mock.calls.slice();
    registered.setActiveSession(exportableSnapshot("later", "later.csv", 1));
    await action;

    expect(nativeMocks.executeCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
    expect(immediateMessages).toEqual([["The active Open Wrangler session has no reopenable source."]]);
  });

  it("opens the source captured when Open Source File starts", async () => {
    const registered = register(exportableSnapshot("original", "original.csv", 1));

    const action = command("openWrangler.openSourceFile")();
    registered.setActiveSession(exportableSnapshot("later", "later.csv", 1));
    await action;

    expect(nativeMocks.executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({ scheme: "file", fsPath: "/workspace/original.csv" })
    );
    expect(nativeMocks.executeCommand).not.toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({ fsPath: "/workspace/later.csv" })
    );
  });

  it("serializes context writes and settles rollback after deferred and rejected writes", async () => {
    nativeMocks.registrationFailure = "command:openWrangler.openSourceFile";
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
      expect(() => register(active)).toThrow("native registration failed: command:openWrangler.openSourceFile");

      expect(nativeMocks.commands.size).toBe(0);
      expect(nativeMocks.treeDataProviders.size).toBe(0);
      expect(nativeMocks.webviewViewProviders.size).toBe(0);
      expect(nativeMocks.activeRegistrations.size).toBe(0);
      expect(nativeMocks.coordinatorListeners.size).toBe(0);
      expect(nativeMocks.registrationDisposals[0]).toBe("command:openWrangler.internal.exportSessionData");
      expect(nativeMocks.registrationDisposals.at(-1)).toBe("command:openWrangler.refreshLiveDataframes");
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

  it("opens dataset statistics only for the Summary row's displayed session and revision", async () => {
    const initial = exportableSnapshot("session", "sample.csv", 0);
    const registered = register(initial);
    const rows = treeChildren("openWrangler.summary").slice(-2);
    const action = rows[0]!.command as { command: string; arguments: unknown[] };
    expect(action).toEqual({
      command: "openWrangler.internal.openDatasetSummary",
      title: "Calculate dataset statistics",
      arguments: [initial.sessionId, initial.metadata.revision]
    });
    expect(rows[1]!.command).toEqual(action);
    await command(action.command)(...action.arguments);
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledExactlyOnceWith({
      action: "openDatasetSummary",
      expectedSessionId: initial.sessionId,
      expectedRevision: initial.metadata.revision
    });
    nativeMocks.sendEditorActionForSession.mockClear();
    registered.setActiveSession({
      ...initial,
      metadata: { ...initial.metadata, revision: initial.metadata.revision + 1 }
    });
    await command(action.command)(...action.arguments);
    registered.setActiveSession(exportableSnapshot("other", "other.csv", initial.metadata.revision));
    await command(action.command)(...action.arguments);
    expect(nativeMocks.sendEditorActionForSession).not.toHaveBeenCalled();
  });

  it("reuses only previously validated canonical generated source", () => {
    const validate = vi.spyOn(codePreviewLimits, "isCanonicalCodePreviewText");
    try {
      const active = noDraftSnapshot();
      const registered = register(active);
      expect(validate).toHaveBeenCalledWith(active.code);

      validate.mockClear();
      registered.setActiveSession({ ...active });
      registered.setActiveSession({ ...active, code: active.code.replaceAll("\n", "\r\n") });
      expect(validate).not.toHaveBeenCalledWith(active.code);

      const changed = `${active.code}# Changed generated source\n`;
      registered.setActiveSession({ ...active, code: changed });
      expect(validate).toHaveBeenCalledWith(changed);

      const invalid = "\ud800";
      registered.setActiveSession({ ...active, code: invalid });
      expect(validate).toHaveBeenCalledWith(invalid);
      validate.mockClear();
      registered.setActiveSession({ ...active, code: invalid });
      expect(validate).toHaveBeenCalledWith(invalid);

      validate.mockClear();
      registered.setActiveSession({ ...active, code: "" });
      expect(validate).toHaveBeenCalledWith("");
    } finally {
      validate.mockRestore();
    }
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

    provider.resolveWebviewView({ description: undefined, webview }, { state: undefined }, uncancelledViewToken);

    const script = webview.html.match(/<script type="module" nonce="([0-9a-f]{32})" src="([^"]+)"><\/script>/u);
    expect(script).not.toBeNull();
    expect(webview.html).toContain(`font-src test-csp; script-src 'nonce-${script?.[1]}' test-csp`);
    expect(script?.[2]).toBe("file:///tmp/openwrangler/media/codePreview.js");
  });

  it("keeps generated-code actions available when Code Preview resolution is cancelled", async () => {
    const active = noDraftSnapshot();
    register(active);
    await expect(command("openWrangler.copyCode")()).resolves.toBe(active.code);
    const provider = nativeMocks.webviewViewProviders.get("openWrangler.codePreview");
    if (!provider) throw new Error("Expected the Code Preview provider to be registered.");
    const abandoned = {
      webview: {
        set options(_value: unknown) {
          throw new Error("Webview is disposed");
        }
      },
      onDidDispose: vi.fn(() => ({ dispose: () => undefined }))
    };

    expect(() =>
      provider.resolveWebviewView(
        abandoned,
        { state: undefined },
        { ...uncancelledViewToken, isCancellationRequested: true }
      )
    ).not.toThrow();

    expect(abandoned.onDidDispose).not.toHaveBeenCalled();
    await expect(command("openWrangler.copyCode")()).resolves.toBe(active.code);
  });

  it("offers a file entry point before a dataframe is open", () => {
    const registered = register(noDraftSnapshot());
    registered.setActiveSession(undefined);

    expect(treeChildren("openWrangler.operations").map(nodePresentation)).toEqual([
      ["No active dataframe", "Open a source from Data sources"]
    ]);
    expect(treeChildren("openWrangler.dataSources").map((node) => [node.label, node.command])).toEqual([
      ["Open a data file", expect.objectContaining({ command: "openWrangler.openPath" })]
    ]);
    registered.setActiveSession(noDraftSnapshot());
    expect(treeChildren("openWrangler.operations").map((node) => node.label)).toContain("Rename column");
    expect(
      treeChildren("openWrangler.operations").every(
        (node) => (node.command as { command: string }).command === "openWrangler.startOperation"
      )
    ).toBe(true);
    expect(treeChildren("openWrangler.dataSources").map((node) => node.label)).toEqual(["Open a data file"]);
  });

  it("updates source discovery states without refreshing Operations and releases both subscriptions", () => {
    let state: "loading" | "empty" | "error" = "loading";
    const notebookListeners = new Set<() => unknown>();
    const rListeners = new Set<() => unknown>();
    const notebookProvider: NotebookLiveVariableProvider = {
      onDidChangeVariables: (listener) => {
        notebookListeners.add(listener);
        return { dispose: () => notebookListeners.delete(listener) };
      },
      snapshot: () => ({ state, notebookLabel: "analysis.ipynb", message: `Notebook ${state}`, variables: [] }),
      refreshFromCommand: async () => undefined,
      dispose: () => undefined
    };
    const rProvider: RLiveVariableProvider = {
      onDidChangeVariables: (listener) => {
        rListeners.add(listener);
        return { dispose: () => rListeners.delete(listener) };
      },
      startAutomaticDiscovery: () => undefined,
      snapshot: () => ({ state, terminalLabel: "R", message: `R ${state}`, variables: [] }),
      refreshFromCommand: async () => true,
      shutdown: async () => undefined,
      dispose: () => undefined
    };
    register(noDraftSnapshot(), undefined, undefined, notebookProvider, rProvider);
    const sources = nativeMocks.treeDataProviders.get("openWrangler.dataSources")!;
    const sourceChanges = vi.fn();
    const operationChanges = vi.fn();
    const operations = treeChildren("openWrangler.operations").map((node) => node.label);
    expect(operations).toContain("Rename column");
    sources.onDidChangeTreeData!(sourceChanges);
    nativeMocks.treeDataProviders.get("openWrangler.operations")!.onDidChangeTreeData!(operationChanges);
    expect(notebookListeners.size).toBe(1);
    expect(rListeners.size).toBe(1);
    for (state of ["loading", "empty", "error"] as const) {
      for (const listener of [...notebookListeners, ...rListeners]) listener();
      expect(treeChildren("openWrangler.dataSources").map((node) => [node.label, node.command])).toEqual([
        [`Notebook ${state}`, undefined],
        ["Refresh notebook dataframes", expect.objectContaining({ command: "openWrangler.refreshNotebookVariables" })],
        ...(state === "loading"
          ? []
          : [
              [
                "Refresh R dataframes",
                expect.objectContaining({ command: "openWrangler.refreshRInteractiveVariables" })
              ]
            ]),
        [`R ${state}`, undefined],
        ["Open a data file", expect.objectContaining({ command: "openWrangler.openPath" })]
      ]);
      expect(treeChildren("openWrangler.operations").map((node) => node.label)).toEqual(operations);
    }
    expect(sourceChanges).toHaveBeenCalledTimes(6);
    expect(operationChanges).not.toHaveBeenCalled();
    (sources as typeof sources & { dispose(): void }).dispose();
    expect(notebookListeners.size).toBe(0);
    expect(rListeners.size).toBe(0);
  });

  it("shows cached variables from the exact active notebook in Data sources", () => {
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

    expect(treeChildren("openWrangler.dataSources").map((node) => [node.label, node.command])).toEqual([
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
    registered.setActiveSession(exportableSnapshot("different-file", "other.csv", 2));
    expect(treeChildren("openWrangler.dataSources")[0]!.command).toMatchObject({
      command: "openWrangler.openCachedNotebookVariable",
      arguments: ["live-frame-handle"]
    });
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
        action: "start",
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

    expect(treeChildren("openWrangler.dataSources").map((node) => node.label)).toEqual([
      "orders_tbl",
      "Refresh notebook dataframes",
      "Open a data file"
    ]);

    await command("openWrangler.refreshLiveDataframes")();
    expect(refreshNotebook).toHaveBeenCalledOnce();
    expect(refreshTerminal).not.toHaveBeenCalled();
  });

  it("routes the public refresh to an active notebook whose automatic inspection is paused", async () => {
    const refreshNotebook = vi.fn(async () => undefined);
    const refreshTerminal = vi.fn(async () => true);
    const notebookProvider: NotebookLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      snapshot: () => ({
        state: "empty",
        notebookLabel: "foreign-provider.ipynb",
        message: "Automatic notebook inspection is paused for the selected preview provider. Refresh to inspect it.",
        variables: []
      }),
      refreshFromCommand: refreshNotebook,
      dispose: () => undefined
    };
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
    register(noDraftSnapshot(), undefined, undefined, notebookProvider, terminalProvider);

    expect(treeChildren("openWrangler.dataSources").map((node) => node.label)).toContain(
      "Automatic notebook inspection is paused for the selected preview provider. Refresh to inspect it."
    );
    await command("openWrangler.refreshLiveDataframes")();

    expect(refreshNotebook).toHaveBeenCalledOnce();
    expect(refreshTerminal).not.toHaveBeenCalled();
  });

  it("routes the Data sources refresh action to the active R terminal when no notebook is active", async () => {
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

    expect(
      treeChildren("openWrangler.dataSources").map((node) => [node.label, node.description, node.command])
    ).toEqual([
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
    ]);
    registered.setActiveSession(exportableSnapshot("different-file", "other.csv", 2));
    expect(treeChildren("openWrangler.dataSources")[1]!.command).toMatchObject({
      command: "openWrangler.openCachedRInteractiveVariable",
      arguments: ["r-frame-handle"]
    });
  });

  it.each(["R", "R session"])("keeps unread terminal %s discoverable alongside a notebook", (terminalLabel) => {
    const variableProvider: RLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      startAutomaticDiscovery: () => undefined,
      snapshot: () => ({
        state: "idle",
        action: "refresh",
        terminalLabel,
        message: "Dataframes appear here after the R prompt returns.",
        variables: []
      }),
      refreshFromCommand: async () => true,
      shutdown: async () => undefined,
      dispose: () => undefined
    };
    const notebookProvider: NotebookLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      snapshot: () => ({
        state: "ready",
        notebookLabel: "analysis.ipynb",
        message: "Live dataframes",
        variables: [{ handle: "notebook-owner", label: "orders", description: "Pandas", detail: "analysis.ipynb" }]
      }),
      refreshFromCommand: async () => undefined,
      dispose: () => undefined
    };
    const registered = register(noDraftSnapshot(), undefined, undefined, notebookProvider, variableProvider);
    registered.setActiveSession(undefined);

    expect(
      treeChildren("openWrangler.dataSources").map((node) => [node.label, node.description, node.command])
    ).toEqual([
      [
        "orders",
        "Pandas",
        expect.objectContaining({ command: "openWrangler.openCachedNotebookVariable", arguments: ["notebook-owner"] })
      ],
      [
        "Refresh notebook dataframes",
        "analysis.ipynb",
        expect.objectContaining({ command: "openWrangler.refreshNotebookVariables" })
      ],
      [
        "Show R dataframes…",
        terminalLabel,
        expect.objectContaining({ command: "openWrangler.refreshRInteractiveVariables" })
      ],
      [
        "Open a data file",
        "Choose CSV, Parquet, Excel, or JSONL",
        expect.objectContaining({ command: "openWrangler.openPath" })
      ]
    ]);
  });

  it("offers one action that starts R after the previous terminal closed", () => {
    const variableProvider: RLiveVariableProvider = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      startAutomaticDiscovery: () => undefined,
      snapshot: () => ({
        state: "idle",
        action: "start",
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

    expect(
      treeChildren("openWrangler.dataSources").map((node) => [node.label, node.description, node.command])
    ).toEqual([
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
    ]);
  });

  it("keeps saved Formula outputs in native context after later Rename and Drop steps", () => {
    const active = exportableSnapshot("formula-context", "sample.csv", 4);
    const savedOutput = "  東京 *売上* [net]  ";
    const latestOutput = "東京 *売上* [gross]";
    const source = { id: "c:value", name: "value" };
    active.metadata.steps = [
      {
        id: "formula",
        kind: "formula",
        params: { leftColumn: source, rightColumn: source, operator: "add", newColumn: savedOutput }
      },
      {
        id: "rename",
        kind: "renameColumn",
        params: { column: { id: "c:step:formula:0", name: savedOutput }, newName: "retired" }
      },
      {
        id: "drop",
        kind: "dropColumns",
        params: { columns: [{ id: "c:step:formula:0", name: "retired" }] }
      },
      {
        id: "latest",
        kind: "formula",
        params: { leftColumn: source, rightColumn: source, operator: "add", newColumn: latestOutput }
      }
    ];
    active.metadata.schema.push({
      ...active.metadata.schema[0]!,
      id: "c:step:latest:0",
      name: latestOutput,
      position: 1
    });
    active.metadata.shape.columns = 2;
    active.metadata.filteredShape.columns = 2;
    const registered = register(active);
    const onRefresh = vi.fn();
    const subscription = nativeMocks.treeDataProviders
      .get("openWrangler.cleaningSteps")
      ?.onDidChangeTreeData?.(onRefresh);

    const steps = treeChildren("openWrangler.cleaningSteps");
    expect(steps[1]).toMatchObject({
      label: "1. Formula column",
      description: "Applied",
      tooltip: "1. Formula column: Output at this step:   東京 *売上* [net]   · Applied",
      accessibilityInformation: { label: "1. Formula column, Output at this step:   東京 *売上* [net]   · Applied" }
    });
    expect(steps[4]).toMatchObject({
      label: "4. Formula column",
      description: "Latest applied step",
      tooltip: "4. Formula column: Output at this step: 東京 *売上* [gross] · Latest applied step",
      accessibilityInformation: {
        label: "4. Formula column, Output at this step: 東京 *売上* [gross] · Latest applied step"
      }
    });

    const firstFormula = active.metadata.steps[0]!;
    if (firstFormula.kind === "formula") firstFormula.params.newColumn = "revised output";
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(treeChildren("openWrangler.cleaningSteps")[1]?.tooltip).toContain("Output at this step: revised output");

    active.metadata.steps.reverse();
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(treeChildren("openWrangler.cleaningSteps")[1]?.tooltip).toContain(latestOutput);

    active.metadata.steps[0] = { id: "latest", kind: "dropMissingRows", params: {} };
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(3);
    expect(treeChildren("openWrangler.cleaningSteps")[1]?.label).toBe("1. Drop missing rows");

    active.metadata.steps[0]!.id = "replacement-step";
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(4);
    expect(treeChildren("openWrangler.cleaningSteps")[1]?.cleaningStepHandle).toMatchObject({
      stepId: "replacement-step"
    });

    active.metadata.steps.pop();
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(5);
    expect(treeChildren("openWrangler.cleaningSteps")).toHaveLength(4);
    subscription?.dispose();
  });

  it("keeps Cleaning Steps unchanged while fresh viewing and profiling snapshots update Summary", () => {
    const initial = exportableSnapshot("session", "sample.csv", 0);
    const registered = register(initial);
    const onStepsRefresh = vi.fn();
    const onSummaryRefresh = vi.fn();
    const stepsSubscription = nativeMocks.treeDataProviders
      .get("openWrangler.cleaningSteps")
      ?.onDidChangeTreeData?.(onStepsRefresh);
    const summarySubscription = nativeMocks.treeDataProviders
      .get("openWrangler.summary")
      ?.onDidChangeTreeData?.(onSummaryRefresh);
    const initialRows = treeChildren("openWrangler.cleaningSteps");

    const viewed = structuredClone(initial);
    viewed.viewState.selectedColumnId = "c:value";
    viewed.metadata.filteredShape.rows = 1;
    viewed.viewState.filterModel = { filters: [], sort: [{ column: "value", direction: "desc", nulls: "last" }] };
    viewed.metadata.filterModel = viewed.viewState.filterModel;
    registered.setActiveSession(viewed);
    expect(onStepsRefresh).not.toHaveBeenCalled();
    expect(onSummaryRefresh).toHaveBeenCalledTimes(1);
    expect(treeChildren("openWrangler.summary").map(nodePresentation)).toContainEqual(["Shape", "1 × 1"]);

    const profiled = structuredClone(viewed);
    profiled.metadata.stats = {
      missingCells: 0,
      missingRows: 0,
      duplicateRows: 0,
      missingValuesByColumn: [{ column: "value", count: 0 }]
    };
    profiled.metadata.schema[0]!.rawType = "Int32";
    profiled.code = "# unchanged plan with refreshed code presentation";
    profiled.stepInspectionActive = true;
    registered.setActiveSession(profiled);
    expect(onStepsRefresh).not.toHaveBeenCalled();
    expect(onSummaryRefresh).toHaveBeenCalledTimes(2);
    expect(treeChildren("openWrangler.cleaningSteps")).toEqual(initialRows);
    expect(treeChildren("openWrangler.summary").map(nodePresentation)).toContainEqual(["Missing cells", "0"]);
    stepsSubscription?.dispose();
    summarySubscription?.dispose();
  });

  it("refreshes Cleaning Steps for draft and completed inspection transitions", () => {
    const active = exportableSnapshot("session", "sample.csv", 0);
    const registered = register(active);
    const onRefresh = vi.fn();
    const subscription = nativeMocks.treeDataProviders
      .get("openWrangler.cleaningSteps")
      ?.onDidChangeTreeData?.(onRefresh);

    active.metadata.draftStep = { id: "draft", kind: "dropMissingRows", params: {} };
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(treeChildren("openWrangler.cleaningSteps")[1]?.contextValue).toBe("openWrangler.cleaningStep");
    expect(treeChildren("openWrangler.cleaningSteps").at(-1)?.label).toBe("Draft · Drop missing rows");

    active.metadata.draftStep = {
      id: "draft",
      kind: "dropColumns",
      params: { columns: [{ id: "c:value", name: "value" }] }
    };
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(treeChildren("openWrangler.cleaningSteps").at(-1)?.label).toBe("Draft · Drop columns");

    delete active.metadata.draftStep;
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(3);
    expect(treeChildren("openWrangler.cleaningSteps")[1]?.contextValue).toBe("openWrangler.latestCleaningStep");

    active.metadata.steps.push({ ...appliedStep, id: "second-step" });
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(4);
    expect(treeChildren("openWrangler.cleaningSteps")).toHaveLength(3);

    active.stepInspection = stepInspectionResponse({
      kind: "inspectStep",
      sessionId: active.sessionId,
      revision: 0,
      stepId: appliedStep.id,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 16
    });
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(5);
    expect(treeChildren("openWrangler.cleaningSteps").map(nodePresentation)).toEqual([
      ["Current view", "Show current view"],
      ["1. Drop missing rows", "Selected · applied"],
      ["2. Drop missing rows", "Latest applied step"]
    ]);

    active.stepInspection.stepId = "second-step";
    active.stepInspection.stepIndex = 1;
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(6);
    expect(treeChildren("openWrangler.cleaningSteps")[2]?.description).toBe("Selected · latest applied step");

    delete active.stepInspection;
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(7);
    expect(treeChildren("openWrangler.cleaningSteps")[0]?.description).toBe("Selected");

    registered.setActiveSession(undefined);
    expect(onRefresh).toHaveBeenCalledTimes(8);
    expect(treeChildren("openWrangler.cleaningSteps")[0]?.label).toBe("No active dataframe");
    registered.setActiveSession(undefined);
    expect(onRefresh).toHaveBeenCalledTimes(8);
    registered.setActiveSession(active);
    expect(onRefresh).toHaveBeenCalledTimes(9);
    expect(treeChildren("openWrangler.cleaningSteps")).toHaveLength(3);
    subscription?.dispose();
  });

  it("routes cleaning-step selection through the exact active session and rejects stale steps", async () => {
    const registered = register(noDraftSnapshot());
    for (const active of [snapshotWithDraft(), noDraftSnapshot()]) {
      registered.setActiveSession(active);
      const steps = treeChildren("openWrangler.cleaningSteps");
      expect(steps[0]).toMatchObject({
        label: "Current view",
        description: "Selected",
        tooltip: "Current view: Selected",
        accessibilityInformation: { label: "Current view, Selected" },
        command: {
          command: "openWrangler.selectStep",
          title: "Show current view",
          arguments: [{ cleaningStepHandle: { sessionId: "session", revision: 0, stepId: null } }]
        }
      });
      expect(steps.some((node) => node.label.startsWith("Draft ·"))).toBe(Boolean(active.metadata.draftStep));
    }

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

  it.each(["session", "revision"] as const)("refuses retained inspection rows after a %s change", async (change) => {
    const original = exportableSnapshot("original", "original.csv", 0);
    original.stepInspectionActive = true;
    const registered = register(original);
    const onRefresh = vi.fn();
    const subscription = nativeMocks.treeDataProviders
      .get("openWrangler.cleaningSteps")
      ?.onDidChangeTreeData?.(onRefresh);
    const inspectionRows = () => {
      const steps = treeChildren("openWrangler.cleaningSteps");
      return [
        steps.find((node) => (node.cleaningStepHandle as { stepId?: unknown } | undefined)?.stepId === appliedStep.id),
        steps.find((node) => node.label === "Current view"),
        treeChildren("openWrangler.filters").find((node) => node.label === "Filters and sorts paused")
      ];
    };
    const oldRows = inspectionRows();
    const oldRow = oldRows[0];
    expect(oldRow).toBeDefined();

    await command("openWrangler.editSelectedStep")(oldRow);
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledWith({
      action: "editStep",
      stepId: appliedStep.id,
      expectedSessionId: "original",
      expectedRevision: 0
    });
    nativeMocks.sendEditorActionForSession.mockClear();

    const replacement =
      change === "session"
        ? exportableSnapshot("replacement", "replacement.csv", 0)
        : exportableSnapshot("original", "original.csv", 1);
    replacement.stepInspectionActive = true;
    expect(replacement.metadata.steps[0]?.id).toBe(original.metadata.steps[0]?.id);
    registered.setActiveSession(replacement);
    expect(onRefresh).toHaveBeenCalledOnce();

    await command("openWrangler.editSelectedStep")(oldRow);
    expect(nativeMocks.sendEditorActionForSession).not.toHaveBeenCalled();

    for (const row of oldRows) {
      const action = row?.command as { command: string; arguments: unknown[] };
      await command(action.command)(...action.arguments);
    }
    expect(nativeMocks.sendEditorActionForSession).not.toHaveBeenCalled();
    expect(registered.clearActiveStepInspection).not.toHaveBeenCalled();

    for (const [index, row] of inspectionRows().entries()) {
      const action = row?.command as { command: string; arguments: unknown[] };
      await command(action.command)(...action.arguments);
      expect(nativeMocks.sendEditorActionForSession).toHaveBeenLastCalledWith({
        action: "selectStep",
        expectedSessionId: replacement.sessionId,
        expectedRevision: replacement.metadata.revision,
        ...(index === 0 ? { stepId: appliedStep.id } : {})
      });
    }
    expect(nativeMocks.sendEditorActionForSession).toHaveBeenCalledTimes(3);
    expect(registered.clearActiveStepInspection).toHaveBeenCalledTimes(2);
    subscription?.dispose();
  });

  it("refuses malformed bound inspection targets without returning to the current view", async () => {
    const registered = register(noDraftSnapshot());
    for (const target of [
      null,
      {},
      { cleaningStepHandle: null },
      { cleaningStepHandle: { sessionId: "session", revision: 0 } },
      { cleaningStepHandle: { sessionId: "session", revision: 0, stepId: 1 } },
      { cleaningStepHandle: { sessionId: "session", revision: "0", stepId: null } }
    ]) {
      await command("openWrangler.selectStep")(target);
    }
    expect(nativeMocks.sendEditorActionForSession).not.toHaveBeenCalled();
    expect(registered.clearActiveStepInspection).not.toHaveBeenCalled();
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

  it.each([
    ["pyspark", false, "Live PySpark dataframes are viewing only in Open Wrangler; cleaning steps are not available."],
    ["polars", true, "Switch to Editing in the dataframe toolbar to add cleaning steps."]
  ] as const)(
    "explains why a Viewing %s session cannot edit its latest step",
    async (backend, notebookInsert, reason) => {
      const active = exportableSnapshot("viewing-session", "frame", 0);
      active.code = "";
      active.metadata = {
        ...active.metadata,
        backend,
        mode: "viewing",
        source: {
          kind: "notebookVariable",
          label: "frame",
          variableName: "frame",
          uri: "file:///workspace/frame.ipynb"
        },
        steps: [],
        capabilities: {
          ...active.metadata.capabilities,
          editable: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert,
          supportedOperations: notebookInsert ? ["renameColumn"] : []
        }
      };
      register(active);

      await command("openWrangler.editLatestStep")();

      expect(nativeMocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith(reason);
      expect(nativeMocks.sendEditorActionForSession).not.toHaveBeenCalled();
      expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();
    }
  );

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

  it("binds native filter removal to the originating session and complete column group", async () => {
    const original = noDraftSnapshot();
    const city = {
      column: "city",
      type: "string" as const,
      predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: "Milan" }]
    };
    original.viewState.filterModel = { filters: [city], sort: [] };
    const registered = register(original);
    const node = treeChildren("openWrangler.filters")[0]!;
    const { arguments: args } = node.command as { arguments: unknown[] };

    const replacement = noDraftSnapshot();
    replacement.sessionId = "replacement";
    replacement.metadata = { ...replacement.metadata, sessionId: "replacement" };
    replacement.viewState.filterModel = original.viewState.filterModel;
    registered.setActiveSession(replacement);
    await command("openWrangler.clearViewFilterColumn")(...args);
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();

    const changed = noDraftSnapshot();
    changed.viewState.filterModel = {
      filters: [{ ...city, predicates: [{ kind: "predicate", operator: "equals", value: "Paris" }] }],
      sort: []
    };
    registered.setActiveSession(changed);
    await command("openWrangler.clearViewFilterColumn")(...args);
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();

    changed.viewState.filterModel.filters = [city, changed.viewState.filterModel.filters[0]!];
    registered.setActiveSession(changed);
    await command("openWrangler.clearViewFilterColumn")(...args);
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();

    // A saved filter remains removable without a current schema target. Siblings and sorts are independent.
    changed.metadata = { ...changed.metadata, schema: [] };
    changed.viewState.filterModel = {
      filters: [
        {
          ...city,
          valueFilter: { kind: "values", selectedValues: [], includeNulls: false, includeNaN: false }
        },
        { column: "sales", type: "float", predicates: [{ kind: "predicate", operator: "gt", value: 10 }] }
      ],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    };
    registered.setActiveSession(changed);
    await command("openWrangler.clearViewFilterColumn")(...structuredClone(args));
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledExactlyOnceWith({
      action: "clearFilterColumn",
      column: "city",
      expectedSessionId: original.sessionId,
      expectedFilterSignature: JSON.stringify([city])
    });

    nativeMocks.sendEditorAction.mockClear();
    const hiddenColumn = Object.defineProperty(
      {
        expectedSessionId: original.sessionId,
        expectedFilterSignature: JSON.stringify([city]),
        action: "undoStep"
      },
      "column",
      { value: "city" }
    );
    for (const target of [
      "city",
      undefined,
      {},
      { column: "city", expectedSessionId: original.sessionId },
      hiddenColumn
    ]) {
      await command("openWrangler.clearViewFilterColumn")(target);
    }
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();

    changed.viewState.filterModel.filters = [{ ...city, predicates: [] }];
    registered.setActiveSession(changed);
    await command("openWrangler.clearViewFilterColumn")(...args);
    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();
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
    const clearTarget = {
      column: "city",
      expectedSessionId: filtered.sessionId,
      expectedFilterSignature: JSON.stringify([filtered.viewState.filterModel.filters[0]])
    };
    expect(nodes[0]?.command).toEqual({
      command: "openWrangler.clearViewFilterColumn",
      title: "Remove city filter",
      arguments: [clearTarget]
    });

    await command("openWrangler.clearViewFilterColumn")(clearTarget);
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith({
      action: "clearFilterColumn",
      ...clearTarget
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
      arguments: [{ cleaningStepHandle: { sessionId: "session", revision: 0, stepId: null } }]
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
    await command("openWrangler.clearViewFilterColumn")(clearTarget);
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

    await command("openWrangler.clearViewFilterColumn")({
      column: "value",
      expectedSessionId: partial.sessionId,
      expectedFilterSignature: JSON.stringify(partial.viewState.filterModel.filters)
    });
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
      protocolVersion: 4,
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
    const summaryRows = treeChildren("openWrangler.summary");
    expect(summaryRows.map(nodePresentation)).toEqual([
      ["Saved sales preview", "Polars · viewing"],
      ["Shape", "4 × 3"],
      ["Columns", "3"],
      ["Selected column", "score"],
      ["Missing cells", "Not calculated yet"],
      ["Duplicate rows", "Not calculated yet"]
    ]);
    for (const node of summaryRows.slice(-2)) {
      const detail = "Not calculated yet. Select to calculate these statistics in the Dataset view.";
      expect(node).toMatchObject({
        tooltip: `${node.label}: ${detail}`,
        accessibilityInformation: { label: `${node.label}, ${detail}` },
        command: {
          command: "openWrangler.internal.openDatasetSummary",
          arguments: [savedOutput.sessionId, savedOutput.metadata.revision]
        }
      });
    }
    expect(treeChildren("openWrangler.filters").map(nodePresentation)).toEqual([
      ["No filters or sorts", "Current view"]
    ]);
    expect(treeChildren("openWrangler.cleaningSteps").map(nodePresentation)).toEqual([["Current view", "Selected"]]);

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
    provider.resolveWebviewView(codePreviewView, { state: undefined }, uncancelledViewToken);

    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      inspection: null,
      bufferId: expect.any(String),
      bufferVersion: 0,
      bufferInvalid: false,
      code: expect.stringMatching(/Read-only saved notebook snapshot/u),
      editable: false,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "polars",
        codeDialect: "python.polars"
      }
    });
    expect(codePreviewView.description).toBe("Python");
    expect(posted.at(-1)).toMatchObject({ inspection: null });
    const readOnlyBufferId = (posted.at(-1) as { bufferId: string }).bufferId;

    receive?.({
      kind: "codeChanged",
      bufferId: readOnlyBufferId,
      baseVersion: 0,
      bufferVersion: 1,
      changes: [{ from: 0, to: 0, insert: "raise RuntimeError('should be ignored')" }]
    });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      inspection: null,
      bufferId: readOnlyBufferId,
      bufferVersion: 0,
      bufferInvalid: false,
      code: expect.stringMatching(/Read-only saved notebook snapshot/u),
      editable: false,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "polars",
        codeDialect: "python.polars"
      }
    });

    const freshFile = snapshot({
      mode: "editing",
      steps: [],
      source: {
        kind: "file",
        label: "sales\r\nnorth\npart.csv",
        path: "/workspace/sales\r\nnorth\npart.csv",
        uri: "file:///workspace/sales%0D%0Anorth%0Apart.csv"
      }
    });
    freshFile.code = "";
    registered.setActiveSession(freshFile);
    expect(posted.at(-1)).toMatchObject({
      code: "# sales\n# north\n# part.csv\n# Add or select a cleaning step to preview generated code.",
      editable: false,
      bufferInvalid: false
    });
    await expect(command("openWrangler.copyCode")()).resolves.toBe(false);
    expect(nativeMocks.showInformationMessage).toHaveBeenCalledWith(
      "Add a cleaning step before copying generated code."
    );
    expect(freshFile.metadata.source.label).toBe("sales\r\nnorth\npart.csv");

    const editable = noDraftSnapshot();
    editable.metadata.steps.push({ ...appliedStep, id: "second" });
    editable.code = "def clean_data(df):\n    return df.dropna(how='all').head(10)\n";
    registered.setActiveSession(editable);
    expect(treeChildren("openWrangler.operations").every((node) => node.command !== undefined)).toBe(true);
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      inspection: null,
      bufferId: expect.any(String),
      bufferVersion: 0,
      bufferInvalid: false,
      code: editable.code,
      editable: true,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "pandas",
        codeDialect: "python.pandas"
      }
    });
    expect(codePreviewView.description).toBe("Python");
    expect(posted.at(-1)).toMatchObject({ inspection: null });
    const pendingInspection = { ...editable, stepInspectionActive: true };
    registered.setActiveSession(pendingInspection);
    expect(codePreviewView.description).toBe("Python");
    expect(posted.at(-1)).toMatchObject({ inspection: null });
    expect(posted.at(-1)).toMatchObject({ code: editable.code });
    const inspection = stepInspectionResponse(
      {
        kind: "inspectStep",
        sessionId: editable.sessionId,
        revision: editable.metadata.revision,
        stepId: appliedStep.id,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 16
      },
      0,
      "def clean_data(df):\n    return df.dropna(how='all')\n"
    );
    const inspected = { ...pendingInspection, code: inspection.code, stepInspection: inspection };
    registered.setActiveSession(inspected);
    expect(posted.at(-1)).toMatchObject({ inspection: { stepIndex: 0, stepCount: 2 } });
    expect(posted.at(-1)).toMatchObject({ code: inspection.code });
    const editableBufferId = (posted.at(-1) as { bufferId: string }).bufferId;

    receive?.({
      kind: "codeChanged",
      bufferId: editableBufferId,
      baseVersion: 0,
      bufferVersion: 1,
      changes: [{ from: 0, to: inspected.code.length, insert: "raise RuntimeError('unknown field')" }],
      unexpected: true
    });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({ code: inspected.code });

    receive?.({
      kind: "codeChanged",
      bufferId: editableBufferId,
      baseVersion: 0,
      bufferVersion: 1,
      changes: [{ from: 0, to: inspected.code.length, insert: "def clean_data(df):\n    return df.dropna()\n" }]
    });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({
      bufferVersion: 1,
      code: "def clean_data(df):\n    return df.dropna()\n"
    });
    receive?.({
      kind: "codeChanged",
      bufferId: editableBufferId,
      baseVersion: 0,
      bufferVersion: 1,
      changes: [{ from: 0, to: inspected.code.length, insert: "# stale same-buffer edit" }]
    });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({
      bufferVersion: 1,
      code: "def clean_data(df):\n    return df.dropna()\n"
    });

    const crossingCode = "def clean_data(df):\n    return df.dropna()\n# crossing edit\n";
    const crossingCopy = command("openWrangler.copyCode")();
    const crossingRequest = posted.at(-1) as { requestId: string; bufferId: string; bufferVersion: number };
    expect(crossingRequest).toMatchObject({
      kind: "codeSnapshotRequest",
      bufferId: editableBufferId,
      bufferVersion: 1
    });
    receive?.({
      kind: "codeChanged",
      bufferId: editableBufferId,
      baseVersion: 1,
      bufferVersion: 2,
      changes: [
        {
          from: "def clean_data(df):\n    return df.dropna()\n".length,
          to: "def clean_data(df):\n    return df.dropna()\n".length,
          insert: "# crossing edit\n"
        }
      ]
    });
    receive?.({
      kind: "codeSnapshot",
      requestId: crossingRequest.requestId,
      bufferId: crossingRequest.bufferId,
      baseVersion: crossingRequest.bufferVersion,
      bufferVersion: 2,
      code: crossingCode
    });
    await expect(crossingCopy).resolves.toBe(crossingCode);
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({ bufferVersion: 2, code: crossingCode });
    expect(posted.at(-1)).toMatchObject({ inspection: { stepIndex: 0, stepCount: 2 } });

    const currentAfterDisagreement = `${crossingCode}# current edit\n`;
    const disagreeingCopy = command("openWrangler.copyCode")();
    const disagreeingRequest = posted.at(-1) as { requestId: string; bufferId: string; bufferVersion: number };
    receive?.({
      kind: "codeChanged",
      bufferId: editableBufferId,
      baseVersion: 2,
      bufferVersion: 3,
      changes: [
        {
          from: crossingCode.length,
          to: crossingCode.length,
          insert: "# current edit\n"
        }
      ]
    });
    receive?.({
      kind: "codeSnapshot",
      requestId: disagreeingRequest.requestId,
      bufferId: disagreeingRequest.bufferId,
      baseVersion: disagreeingRequest.bufferVersion,
      bufferVersion: 3,
      code: `${crossingCode}# stale snapshot\n`
    });
    await expect(disagreeingCopy).resolves.toBe(false);
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toMatchObject({ bufferVersion: 3, code: currentAfterDisagreement });

    const staleCopy = command("openWrangler.copyCode")();
    const pendingRequest = posted.at(-1) as { requestId: string; bufferId: string; bufferVersion: number };
    expect(pendingRequest).toMatchObject({
      kind: "codeSnapshotRequest",
      bufferId: editableBufferId,
      bufferVersion: 3
    });
    const rEditable = rNotebookSnapshot();
    registered.setActiveSession(rEditable);
    await expect(staleCopy).resolves.toBe(false);
    receive?.({
      kind: "codeSnapshot",
      requestId: pendingRequest.requestId,
      bufferId: pendingRequest.bufferId,
      baseVersion: pendingRequest.bufferVersion,
      bufferVersion: pendingRequest.bufferVersion,
      code: "# late stale buffer"
    });
    receive?.({ kind: "ready" });
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      inspection: null,
      bufferId: expect.any(String),
      bufferVersion: 0,
      bufferInvalid: false,
      code: rEditable.code,
      editable: true,
      runtimeIdentity: {
        runtimeLanguage: "r",
        dataframeFlavor: "r.data.frame",
        codeDialect: "r.base"
      }
    });
    expect(codePreviewView.description).toBe("R");
    expect(posted.at(-1)).toMatchObject({ inspection: null });
    const rInspected = {
      ...rEditable,
      metadata: { ...rEditable.metadata, steps: editable.metadata.steps },
      stepInspectionActive: true,
      stepInspection: { ...inspection, stepId: "second", stepIndex: 1, code: rEditable.code }
    };
    registered.setActiveSession(rInspected);
    expect(posted.at(-1)).toMatchObject({ inspection: { stepIndex: 1, stepCount: 2 } });
    registered.setActiveSession(rEditable);
    expect(codePreviewView.description).toBe("R");
    expect(posted.at(-1)).toMatchObject({ inspection: null });
    expect(posted.at(-1)).toMatchObject({ code: rEditable.code });
    registered.setActiveSession(rInspected);
    const rBuffer = posted.at(-1) as { bufferId: string; bufferVersion: number };
    receive?.({ kind: "codeChangedInvalid", bufferId: rBuffer.bufferId, baseVersion: rBuffer.bufferVersion });
    receive?.({ kind: "ready" });
    expect(codePreviewView.description).toBe("R");
    expect(posted.at(-1)).toMatchObject({ inspection: null });
    expect(posted.at(-1)).toMatchObject({ bufferInvalid: true });
    registered.setActiveSession({ ...rInspected, code: "\ud800" });
    expect(codePreviewView.description).toBe("R");
    expect(posted.at(-1)).toMatchObject({ inspection: null });
    expect(posted.at(-1)).toMatchObject({ bufferInvalid: true });
    registered.setActiveSession({ ...rInspected, code: "" });
    expect(codePreviewView.description).toBe("R");
    expect(posted.at(-1)).toMatchObject({ inspection: null });
    expect(posted.at(-1)).toMatchObject({ bufferInvalid: false, editable: false });

    for (const rLibrary of ["data.table", "collapse"] as const) {
      const restricted = rNotebookSnapshot();
      restricted.code = "";
      restricted.metadata = {
        ...restricted.metadata,
        rLibrary,
        steps: [],
        capabilities: { ...restricted.metadata.capabilities, supportedOperations: [] }
      };
      registered.setActiveSession(restricted);
      expect(posted.at(-1)).toMatchObject({
        code: expect.stringContaining("Choose Base R or dplyr in the engine picker"),
        editable: false,
        runtimeIdentity: { runtimeLanguage: "r", codeDialect: `r.${rLibrary}` }
      });
      expect(treeChildren("openWrangler.operations")).toEqual([
        expect.objectContaining({
          label: "Cleaning unavailable",
          description: expect.stringContaining("Choose Base R or dplyr"),
          command: undefined
        })
      ]);
      await expect(command("openWrangler.copyCode")()).resolves.toBe(false);
      expect(nativeMocks.showInformationMessage).toHaveBeenLastCalledWith(
        expect.stringContaining("Choose Base R or dplyr")
      );
    }

    const viewingOnly = noDraftSnapshot();
    viewingOnly.metadata = { ...viewingOnly.metadata, backend: "pyspark", mode: "viewing" };
    viewingOnly.code = "# A viewing-only backend cannot expose editable generated code.";
    registered.setActiveSession(viewingOnly);
    expect(posted.at(-1)).toEqual({
      kind: "codePreview",
      inspection: null,
      bufferId: expect.any(String),
      bufferVersion: 0,
      bufferInvalid: false,
      code: viewingOnly.code,
      editable: false,
      runtimeIdentity: {
        runtimeLanguage: "python",
        dataframeFlavor: "pyspark",
        codeDialect: null
      }
    });
    expect(codePreviewView.description).toBeUndefined();

    const liveViewing = exportableSnapshot("live-viewing", "live_frame", 0);
    liveViewing.code = "";
    liveViewing.metadata = {
      ...liveViewing.metadata,
      backend: "pyspark",
      mode: "viewing",
      steps: [],
      source: {
        kind: "notebookVariable",
        label: "live_frame",
        variableName: "live_frame",
        uri: "file:///workspace/analysis.ipynb"
      },
      capabilities: {
        ...liveViewing.metadata.capabilities,
        editable: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false,
        supportedOperations: []
      }
    };
    registered.setActiveSession(liveViewing);
    expect(posted.at(-1)).toMatchObject({
      code: "# live_frame\n# Live PySpark dataframes are viewing only in Open Wrangler; cleaning steps are not available.",
      editable: false,
      bufferInvalid: false,
      runtimeIdentity: { dataframeFlavor: "pyspark", codeDialect: null }
    });

    const { env } = await import("vscode");
    const clipboardWrites = vi.mocked(env.clipboard.writeText).mock.calls.length;
    const missingCopy = command("openWrangler.copyCode")();
    registered.setActiveSession({
      ...liveViewing,
      sessionId: "duckdb-viewing",
      metadata: { ...liveViewing.metadata, sessionId: "duckdb-viewing", backend: "duckdb" }
    });
    expect(posted.at(-1)).toMatchObject({
      code: "# live_frame\n# Live DuckDB notebook relations are viewing only in Open Wrangler; cleaning steps are not available.",
      editable: false,
      bufferInvalid: false,
      runtimeIdentity: { dataframeFlavor: "duckdb", codeDialect: "python.duckdb" }
    });
    await expect(missingCopy).resolves.toBe(false);
    expect(nativeMocks.showInformationMessage).toHaveBeenLastCalledWith(
      "Live PySpark dataframes are viewing only in Open Wrangler; cleaning steps are not available."
    );
    expect(env.clipboard.writeText).toHaveBeenCalledTimes(clipboardWrites);

    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);
    expect(nativeMocks.showInformationMessage).toHaveBeenLastCalledWith(
      "Live DuckDB notebook relations are viewing only in Open Wrangler; cleaning steps are not available."
    );
    expect(nativeMocks.showSaveDialog).not.toHaveBeenCalled();
  });

  it("disambiguates a selected duplicate label by its human column position", () => {
    const duplicate = snapshot({ mode: "viewing", steps: [] });
    duplicate.metadata = {
      protocolVersion: 4,
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

  it("shows unavailable duplicate counts alongside exact missing statistics in the native Summary view", () => {
    const partial = exportableSnapshot("partial-summary", "partial.parquet", 0);
    partial.metadata.stats = {
      missingCells: 1,
      missingRows: 1,
      duplicateRows: null,
      missingValuesByColumn: [{ column: "value", count: 1 }]
    };
    register(partial);

    const rows = treeChildren("openWrangler.summary").map(nodePresentation);
    expect(rows).toContainEqual(["Duplicate rows", "Unavailable for these column values"]);
    expect(rows).toContainEqual(["Missing cells", "1"]);
  });
});

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}
