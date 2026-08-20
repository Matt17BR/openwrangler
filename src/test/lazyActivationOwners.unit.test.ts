import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageMetadata from "../../package.json";

type CommandHandler = (...args: unknown[]) => unknown;
type MockDisposable = { dispose(): void };
type MockExtensionContext = { subscriptions: MockDisposable[] };

const host = vi.hoisted(() => {
  const commands = new Map<string, CommandHandler>();
  const visibleNotebookEditors: Array<{ notebook: { notebookType: string } }> = [];
  const customEditorProviders: unknown[] = [];
  const treeProviders = new Map<string, unknown>();
  const webviewProviders = new Map<string, unknown>();
  const registrationAttempts = new Map<string, number>();
  let registrationFailure: Readonly<{ id: string; attempt: number }> | undefined;
  const listeners = {
    visible: new Set<() => void>(),
    active: new Set<() => void>(),
    open: new Set<() => void>(),
    trust: new Set<() => void>()
  };
  const disposable = (dispose: () => void = () => undefined) => ({ dispose: vi.fn(dispose) });
  const registerCommand = vi.fn((id: string, handler: CommandHandler) => {
    const attempt = (registrationAttempts.get(id) ?? 0) + 1;
    registrationAttempts.set(id, attempt);
    if (registrationFailure?.id === id && registrationFailure.attempt === attempt) {
      throw new Error(`registration failed: ${id} at ${attempt}`);
    }
    if (commands.has(id)) throw new Error(`duplicate command: ${id}`);
    commands.set(id, handler);
    return disposable(() => {
      if (commands.get(id) === handler) commands.delete(id);
    });
  });
  return {
    commands,
    visibleNotebookEditors,
    listeners,
    disposable,
    registerCommand,
    executeCommand: vi.fn(async (id: string, ...args: unknown[]) => commands.get(id)?.(...args)),
    customEditorProviders,
    treeProviders,
    webviewProviders,
    setRegistrationFailure(failure: Readonly<{ id: string; attempt: number }> | undefined): void {
      registrationFailure = failure;
    },
    registerCustomEditorProvider: vi.fn((_id: string, provider: unknown) => {
      customEditorProviders.push(provider);
      return disposable(() => {
        const index = customEditorProviders.indexOf(provider);
        if (index >= 0) customEditorProviders.splice(index, 1);
      });
    }),
    registerTreeDataProvider: vi.fn((id: string, provider: unknown) => {
      treeProviders.set(id, provider);
      return disposable(() => {
        if (treeProviders.get(id) === provider) treeProviders.delete(id);
      });
    }),
    registerWebviewViewProvider: vi.fn((id: string, provider: unknown) => {
      webviewProviders.set(id, provider);
      return disposable(() => {
        if (webviewProviders.get(id) === provider) webviewProviders.delete(id);
      });
    }),
    showErrorMessage: vi.fn(),
    reset(): void {
      commands.clear();
      visibleNotebookEditors.splice(0);
      customEditorProviders.splice(0);
      treeProviders.clear();
      webviewProviders.clear();
      registrationAttempts.clear();
      registrationFailure = undefined;
      for (const set of Object.values(listeners)) set.clear();
      registerCommand.mockClear();
      this.executeCommand.mockClear();
      this.registerCustomEditorProvider.mockClear();
      this.registerTreeDataProvider.mockClear();
      this.registerWebviewViewProvider.mockClear();
      this.showErrorMessage.mockClear();
    }
  };
});

vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return host.disposable(() => this.listeners.delete(listener));
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  },
  commands: {
    registerCommand: host.registerCommand,
    executeCommand: host.executeCommand
  },
  window: {
    get visibleNotebookEditors() {
      return host.visibleNotebookEditors;
    },
    registerCustomEditorProvider: host.registerCustomEditorProvider,
    registerTreeDataProvider: host.registerTreeDataProvider,
    registerWebviewViewProvider: host.registerWebviewViewProvider,
    onDidChangeVisibleNotebookEditors: (listener: () => void) => eventDisposable(host.listeners.visible, listener),
    onDidChangeActiveNotebookEditor: (listener: () => void) => eventDisposable(host.listeners.active, listener),
    showErrorMessage: host.showErrorMessage
  },
  workspace: {
    onDidOpenNotebookDocument: (listener: () => void) => eventDisposable(host.listeners.open, listener),
    onDidGrantWorkspaceTrust: (listener: () => void) => eventDisposable(host.listeners.trust, listener)
  }
}));

const owners = vi.hoisted(() => ({
  pythonConstructed: vi.fn(),
  sessionConstructed: vi.fn(),
  runtimeRegistered: vi.fn(),
  notebookRegistered: vi.fn(),
  rRegistered: vi.fn(),
  rDiscovery: vi.fn(),
  rShutdown: vi.fn(),
  bridgeShutdown: vi.fn(),
  coordinatorShutdown: vi.fn(),
  customEditorResolved: vi.fn(),
  nativeRegistered: vi.fn(),
  notebookVariablesDisposed: vi.fn(),
  notebookCellResultsStarted: vi.fn(),
  notebookCellResultsDisposed: vi.fn(),
  previewDisposed: vi.fn()
}));

const nativeVariables = vi.hoisted(() => ({
  notebook: undefined as
    | {
        snapshot(): unknown;
        refreshFromCommand(): Promise<void>;
      }
    | undefined,
  r: undefined as
    | {
        snapshot(): unknown;
        refreshFromCommand(): Promise<boolean>;
      }
    | undefined
}));

vi.mock("../extension/pythonBridge", () => ({
  PythonBridge: vi.fn(function MockPythonBridge() {
    owners.pythonConstructed();
    return {
      shutdown: owners.bridgeShutdown,
      reportDiagnostic: vi.fn()
    };
  })
}));

vi.mock("../extension/sessionCoordinator", () => ({
  SessionCoordinator: vi.fn(function MockSessionCoordinator() {
    owners.sessionConstructed();
    return {
      shutdown: owners.coordinatorShutdown,
      createBridge: vi.fn(() => ({ request: vi.fn() }))
    };
  })
}));

vi.mock("../extension/runtimeCommands", () => ({
  registerRuntimeCommands: vi.fn((context: MockExtensionContext) => {
    owners.runtimeRegistered();
    registerMockCommands(context, [
      "openWrangler.changeRuntime",
      "openWrangler.clearRuntime",
      "openWrangler.installRuntimeDependencies",
      "openWrangler.revalidateRuntimeDependencies"
    ]);
  })
}));

vi.mock("../extension/files/fileOpen", () => ({
  OpenWranglerCustomEditorProvider: class {
    async resolveCustomEditor(): Promise<void> {
      owners.customEditorResolved();
    }
  },
  registerFileCommands: vi.fn((context: MockExtensionContext) => {
    registerMockCommands(context, [
      "openWrangler.changeImportOptions",
      "openWrangler.openFile",
      "openWrangler.openPath"
    ]);
  })
}));

const rVariables = vi.hoisted(() => ({
  onDidChangeVariables: () => ({ dispose: () => undefined }),
  startAutomaticDiscovery: owners.rDiscovery,
  shutdown: owners.rShutdown,
  dispose: vi.fn(),
  snapshot: vi.fn(),
  refreshFromCommand: vi.fn()
}));

vi.mock("../extension/r/rInteractiveCommands", () => ({
  registerRInteractiveCommands: vi.fn((context: MockExtensionContext) => {
    owners.rRegistered();
    context.subscriptions.push(rVariables);
    registerMockCommands(context, [
      "openWrangler.openRDataframe",
      "openWrangler.openRInteractiveVariable",
      "openWrangler.refreshRInteractiveVariables",
      "openWrangler.openCachedRInteractiveVariable"
    ]);
    return rVariables;
  })
}));

vi.mock("../extension/notebooks/pythonInteractiveCommands", () => ({
  registerPythonInteractiveCommands: vi.fn((context: MockExtensionContext) => {
    owners.notebookRegistered();
    const variables = {
      onDidChangeVariables: () => ({ dispose: () => undefined }),
      snapshot: vi.fn(),
      refreshFromCommand: vi.fn(async () => undefined),
      dispose: owners.notebookVariablesDisposed,
      diagnosticsForTesting: vi.fn()
    };
    context.subscriptions.push(variables);
    registerMockCommands(context, [
      "openWrangler.runPythonCellAndOpenVariable",
      "openWrangler.refreshNotebookVariables",
      "openWrangler.openCachedNotebookVariable"
    ]);
    return variables;
  })
}));

vi.mock("../extension/notebooks/jupyterBridge", () => ({
  registerNotebookCommands: vi.fn((context: MockExtensionContext) => {
    registerMockCommands(context, [
      "openWrangler.launchDataViewer",
      "openWrangler.openNotebookVariable",
      "openWrangler.checkJupyterIntegration"
    ]);
  })
}));

vi.mock("../extension/notebooks/notebookCellResult", () => ({
  NotebookCellResultTracker: vi.fn(function MockNotebookCellResultTracker() {
    return {
      start: owners.notebookCellResultsStarted,
      dispose: owners.notebookCellResultsDisposed,
      diagnosticsForTesting: vi.fn()
    };
  }),
  registerNotebookCellResultAction: vi.fn((context: MockExtensionContext, _coordinator: unknown, tracker: unknown) => {
    context.subscriptions.push(tracker as { dispose(): void });
    registerMockCommands(context, ["openWrangler.openNotebookCellResult"]);
  })
}));

vi.mock("../extension/notebooks/rendererMessaging", () => ({ registerNotebookRendererMessaging: vi.fn() }));

vi.mock("../extension/nativeViews", () => ({
  registerNativeViews: vi.fn(
    (
      context: MockExtensionContext,
      _coordinator: unknown,
      notebook: typeof nativeVariables.notebook,
      r: typeof nativeVariables.r
    ) => {
      nativeVariables.notebook = notebook;
      nativeVariables.r = r;
      owners.nativeRegistered();
      registerMockCommands(context, [
        "openWrangler.refreshLiveDataframes",
        "openWrangler.clearViewFilterColumn",
        "openWrangler.openViewSort",
        "openWrangler.moveViewSortUp",
        "openWrangler.moveViewSortDown",
        "openWrangler.removeViewSort",
        "openWrangler.startOperation",
        "openWrangler.applyStep",
        "openWrangler.discardStep",
        "openWrangler.editLatestStep",
        "openWrangler.editSelectedStep",
        "openWrangler.deleteSelectedStep",
        "openWrangler.selectStep",
        "openWrangler.undoStep",
        "openWrangler.copyCode",
        "openWrangler.exportCode",
        "openWrangler.insertRDocumentCode",
        "openWrangler.insertNotebookCode",
        "openWrangler.exportData",
        "openWrangler.internal.exportSessionData",
        "openWrangler.openSourceFile",
        "openWrangler.openWalkthrough",
        "openWrangler.openSettings",
        "openWrangler.reportIssue"
      ]);
      return {
        setCodeForExport: vi.fn(),
        exportCodeTo: vi.fn(),
        notebookInsertionStatus: vi.fn(),
        viewSortDispatchStatus: vi.fn()
      };
    }
  )
}));

import type * as vscode from "vscode";
import { LazyActivationOwners } from "../extension/lazyActivationOwners";

describe("lazy activation owners", () => {
  let active: LazyActivationOwners | undefined;

  beforeEach(() => {
    host.reset();
    for (const mock of Object.values(owners)) mock.mockReset();
    owners.bridgeShutdown.mockResolvedValue(undefined);
    owners.coordinatorShutdown.mockResolvedValue(undefined);
    owners.rShutdown.mockResolvedValue(undefined);
    rVariables.snapshot.mockReset().mockReturnValue({
      state: "empty",
      terminalLabel: "R session",
      message: "No dataframes",
      variables: []
    });
    rVariables.refreshFromCommand.mockReset().mockResolvedValue(false);
    nativeVariables.notebook = undefined;
    nativeVariables.r = undefined;
  });

  afterEach(async () => {
    await active?.shutdown();
    active = undefined;
  });

  it("keeps unrelated activation free of runtime and discovery owners", () => {
    active = createOwners();

    active.startBeforeFirstYield();

    expect(active.diagnosticsForTesting()).toEqual({ constructedOwners: [], rDiscoveryStarted: false });
    expect(owners.pythonConstructed).not.toHaveBeenCalled();
    expect(owners.sessionConstructed).not.toHaveBeenCalled();
    expect(owners.rDiscovery).not.toHaveBeenCalled();
    expect(packageMetadata.contributes.commands.every(({ command }) => host.commands.has(command))).toBe(true);
  });

  it("keeps utility commands independent from native views and R discovery", async () => {
    active = createOwners();
    active.startBeforeFirstYield();

    await host.executeCommand("openWrangler.openSettings");

    expect(host.executeCommand).toHaveBeenCalledWith("workbench.action.openSettings", "@ext:Matt17BR.openwrangler");
    expect(owners.rDiscovery).not.toHaveBeenCalled();
    expect(owners.sessionConstructed).not.toHaveBeenCalled();
    expect(active.diagnosticsForTesting().constructedOwners).toEqual([]);
  });

  it("loads only the Python runtime owner for a runtime command and replays exact arguments", async () => {
    active = createOwners();
    active.startBeforeFirstYield();

    const [first, second] = await Promise.all([
      host.executeCommand("openWrangler.changeRuntime", "python-a"),
      host.executeCommand("openWrangler.clearRuntime", 17)
    ]);

    expect(first).toEqual({ id: "openWrangler.changeRuntime", args: ["python-a"] });
    expect(second).toEqual({ id: "openWrangler.clearRuntime", args: [17] });
    expect(owners.pythonConstructed).toHaveBeenCalledOnce();
    expect(owners.runtimeRegistered).toHaveBeenCalledOnce();
    expect(owners.sessionConstructed).not.toHaveBeenCalled();
    expect(owners.rDiscovery).not.toHaveBeenCalled();
  });

  it("starts R discovery only after an R trigger without constructing Python or notebook owners", async () => {
    active = createOwners();
    active.startBeforeFirstYield();

    await expect(host.executeCommand("openWrangler.openRInteractiveVariable", "frame-a")).resolves.toEqual({
      id: "openWrangler.openRInteractiveVariable",
      args: ["frame-a"]
    });

    expect(owners.rRegistered).toHaveBeenCalledOnce();
    expect(owners.rDiscovery).toHaveBeenCalledOnce();
    expect(owners.sessionConstructed).toHaveBeenCalledOnce();
    expect(owners.pythonConstructed).not.toHaveBeenCalled();
    expect(owners.notebookRegistered).not.toHaveBeenCalled();
    expect(active.diagnosticsForTesting().rDiscoveryStarted).toBe(true);
  });

  it("constructs the custom-editor owner only when an editor is resolved", async () => {
    active = createOwners();
    active.startBeforeFirstYield();
    const provider = host.customEditorProviders[0] as {
      openCustomDocument(uri: unknown): unknown;
      resolveCustomEditor(document: unknown, panel: unknown): Promise<void>;
    };
    const document = provider.openCustomDocument({ scheme: "file", path: "/data.csv" });

    expect(owners.pythonConstructed).not.toHaveBeenCalled();
    await provider.resolveCustomEditor(document, {});

    expect(owners.customEditorResolved).toHaveBeenCalledOnce();
    expect(owners.pythonConstructed).toHaveBeenCalledOnce();
    expect(owners.sessionConstructed).toHaveBeenCalledOnce();
    expect(owners.rDiscovery).not.toHaveBeenCalled();
  });

  it("constructs native views on first non-live view demand without constructing notebook, R, or Python", async () => {
    active = createOwners();
    active.startBeforeFirstYield();
    const provider = host.treeProviders.get("openWrangler.summary") as { getChildren(): Promise<unknown[]> };

    await provider.getChildren();

    expect(owners.nativeRegistered).toHaveBeenCalledOnce();
    expect(owners.notebookRegistered).not.toHaveBeenCalled();
    expect(owners.rDiscovery).not.toHaveBeenCalled();
    expect(owners.pythonConstructed).not.toHaveBeenCalled();
  });

  it.each([
    ["tree", "openWrangler.summary"],
    ["tree", "openWrangler.filters"],
    ["tree", "openWrangler.cleaningSteps"],
    ["webview", "openWrangler.codePreview"]
  ])("keeps the non-live %s surface %s independent from notebook and R owners", async (kind, id) => {
    active = createOwners();
    active.startBeforeFirstYield();

    if (kind === "tree") {
      await (host.treeProviders.get(id) as { getChildren(): Promise<unknown[]> }).getChildren();
    } else {
      await (host.webviewProviders.get(id) as { resolveWebviewView(): Promise<void> }).resolveWebviewView();
    }
    await host.executeCommand("openWrangler.startOperation", { kind: "dropColumns" });

    expect(owners.nativeRegistered).toHaveBeenCalledOnce();
    expect(owners.notebookRegistered).not.toHaveBeenCalled();
    expect(owners.rDiscovery).not.toHaveBeenCalled();
  });

  it("routes live-variable snapshots to their exact lazy notebook and R owners", async () => {
    active = createOwners();
    active.startBeforeFirstYield();
    await (host.treeProviders.get("openWrangler.operations") as { getChildren(): Promise<unknown[]> }).getChildren();

    expect(nativeVariables.notebook?.snapshot()).toBeUndefined();
    expect(nativeVariables.r?.snapshot()).toMatchObject({ state: "loading" });
    await vi.waitFor(() => {
      expect(owners.notebookRegistered).toHaveBeenCalledOnce();
      expect(owners.rDiscovery).toHaveBeenCalledOnce();
    });
    expect(owners.pythonConstructed).not.toHaveBeenCalled();
  });

  it("constructs notebook formatter preparation synchronously for an initially visible notebook", async () => {
    host.visibleNotebookEditors.push({ notebook: { notebookType: "jupyter-notebook" } });
    const previewConstructed = vi.fn();
    active = createOwners(previewConstructed);

    active.startBeforeFirstYield();

    expect(previewConstructed).toHaveBeenCalledOnce();
    expect(active.diagnosticsForTesting().constructedOwners[0]).toBe("notebook-preview");
    await expect(active.extensionApiForCurrentEnvironment()).resolves.toBeUndefined();
    expect(owners.notebookRegistered).toHaveBeenCalledOnce();
    expect(owners.rDiscovery).not.toHaveBeenCalled();
    expect(owners.pythonConstructed).not.toHaveBeenCalled();
  });

  it("rolls back every registration when a lazy command group fails partway", async () => {
    active = createOwners();
    host.setRegistrationFailure({ id: "openWrangler.openPath", attempt: 1 });

    expect(() => active?.startBeforeFirstYield()).toThrow(/registration failed/u);
    expect(host.commands.has("openWrangler.changeImportOptions")).toBe(false);
    expect(host.commands.has("openWrangler.openFile")).toBe(false);
    expect(host.commands.has("openWrangler.openPath")).toBe(false);

    await active.shutdown();
    active = undefined;
  });

  it("rolls back a partially initialized notebook owner and disposes retained handles once", async () => {
    active = createOwners();
    active.startBeforeFirstYield();
    owners.notebookCellResultsStarted.mockImplementationOnce(() => {
      throw new Error("cell result listener failed");
    });

    await expect(host.executeCommand("openWrangler.openNotebookVariable")).rejects.toThrow(
      "cell result listener failed"
    );
    for (const command of [
      "openWrangler.runPythonCellAndOpenVariable",
      "openWrangler.refreshNotebookVariables",
      "openWrangler.openCachedNotebookVariable"
    ]) {
      expect(host.commands.has(command)).toBe(false);
    }
    expect(owners.notebookVariablesDisposed).toHaveBeenCalledOnce();
    expect(owners.notebookCellResultsDisposed).toHaveBeenCalledOnce();

    await active.shutdown();
    expect(owners.notebookVariablesDisposed).toHaveBeenCalledOnce();
    expect(owners.notebookCellResultsDisposed).toHaveBeenCalledOnce();
    active = undefined;
  });

  it("retains the R owner before discovery and rolls back registrations when discovery fails", async () => {
    active = createOwners();
    active.startBeforeFirstYield();
    owners.rDiscovery.mockImplementationOnce(() => {
      throw new Error("R discovery failed");
    });

    await expect(host.executeCommand("openWrangler.openRInteractiveVariable")).rejects.toThrow("R discovery failed");
    for (const command of [
      "openWrangler.openRDataframe",
      "openWrangler.openRInteractiveVariable",
      "openWrangler.refreshRInteractiveVariables",
      "openWrangler.openCachedRInteractiveVariable"
    ]) {
      expect(host.commands.has(command)).toBe(false);
    }
    expect(owners.rShutdown).toHaveBeenCalledOnce();

    await active.shutdown();
    expect(owners.rShutdown).toHaveBeenCalledOnce();
    active = undefined;
  });

  it("disposes visible-notebook owners after a later activation boundary fails", async () => {
    host.visibleNotebookEditors.push({ notebook: { notebookType: "jupyter-notebook" } });
    active = createOwners();
    active.startBeforeFirstYield();
    await active.extensionApiForCurrentEnvironment();

    await active.shutdown();

    expect(owners.previewDisposed).toHaveBeenCalledOnce();
    expect(owners.notebookVariablesDisposed).toHaveBeenCalledOnce();
    expect(owners.notebookCellResultsDisposed).toHaveBeenCalledOnce();
    expect(owners.coordinatorShutdown).toHaveBeenCalledOnce();
    expect(host.commands.size).toBe(0);
    active = undefined;
  });

  it("makes concurrent shutdown single-flight and disposes completed owners once", async () => {
    const coordinator = deferred<void>();
    owners.coordinatorShutdown.mockReturnValueOnce(coordinator.promise);
    active = createOwners();
    active.startBeforeFirstYield();
    await host.executeCommand("openWrangler.openRInteractiveVariable");

    const first = active.shutdown();
    const second = active.shutdown();

    expect(second).toBe(first);
    coordinator.resolve();
    await Promise.all([first, second]);
    expect(owners.rShutdown).toHaveBeenCalledOnce();
    expect(owners.coordinatorShutdown).toHaveBeenCalledOnce();
    expect(owners.previewDisposed).not.toHaveBeenCalled();
    active = undefined;
  });

  it("releases every completed file, runtime, notebook, R, and native owner exactly once", async () => {
    active = createOwners();
    active.startBeforeFirstYield();
    const customEditor = host.customEditorProviders[0] as {
      openCustomDocument(uri: unknown): unknown;
      resolveCustomEditor(document: unknown, panel: unknown): Promise<void>;
    };
    const document = customEditor.openCustomDocument({ scheme: "file", path: "/data.csv" });

    await customEditor.resolveCustomEditor(document, {});
    await host.executeCommand("openWrangler.changeRuntime");
    await (host.treeProviders.get("openWrangler.operations") as { getChildren(): Promise<unknown[]> }).getChildren();
    nativeVariables.notebook?.snapshot();
    nativeVariables.r?.snapshot();
    await vi.waitFor(() => {
      expect(owners.notebookRegistered).toHaveBeenCalledOnce();
      expect(owners.rDiscovery).toHaveBeenCalledOnce();
    });
    await active.shutdown();

    expect(owners.notebookVariablesDisposed).toHaveBeenCalledOnce();
    expect(owners.notebookCellResultsDisposed).toHaveBeenCalledOnce();
    expect(owners.rShutdown).toHaveBeenCalledOnce();
    expect(owners.coordinatorShutdown).toHaveBeenCalledOnce();
    expect(owners.bridgeShutdown).toHaveBeenCalledOnce();
    expect(host.commands.size).toBe(0);
    expect(host.customEditorProviders).toHaveLength(0);
    expect(host.treeProviders.size).toBe(0);
    active = undefined;
  });

  it("observes never-settling and late owner promises without extending the shutdown deadline", async () => {
    const late = deferred<void>();
    const never = new Promise<void>(() => undefined);
    active = createOwners(vi.fn(), 10, [never, late.promise]);
    active.startBeforeFirstYield();

    await expect(active.shutdown()).resolves.toBeUndefined();
    late.reject(new Error("late owner failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    active = undefined;
  });

  it("shuts down only constructed owners and preserves terminal failure order", async () => {
    active = createOwners();
    active.startBeforeFirstYield();
    await host.executeCommand("openWrangler.changeRuntime");
    await host.executeCommand("openWrangler.openRInteractiveVariable");
    const rFailure = new Error("R shutdown failed");
    const coordinatorFailure = new Error("session shutdown failed");
    const pythonFailure = new Error("Python shutdown failed");
    owners.rShutdown.mockRejectedValue(rFailure);
    owners.coordinatorShutdown.mockRejectedValue(coordinatorFailure);
    owners.bridgeShutdown.mockRejectedValue(pythonFailure);

    const error = await active.shutdown().catch((reason: unknown) => reason);
    active = undefined;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([rFailure, coordinatorFailure, pythonFailure]);
    expect(owners.rShutdown).toHaveBeenCalledOnce();
    expect(owners.coordinatorShutdown).toHaveBeenCalledOnce();
    expect(owners.bridgeShutdown).toHaveBeenCalledOnce();
    expect(host.commands.size).toBe(0);
  });
});

function createOwners(
  previewConstructed = vi.fn(),
  ownerSettlementTimeoutMs?: number,
  additionalOwnerPromises: readonly Promise<unknown>[] = []
): LazyActivationOwners {
  const context = { subscriptions: [], workspaceState: {} } as unknown as vscode.ExtensionContext;
  return new LazyActivationOwners(
    context,
    () =>
      ({
        NotebookPreviewCoordinator: class {
          private readonly registration: MockDisposable;

          constructor() {
            previewConstructed();
            this.registration = host.registerCommand("openWrangler.chooseNotebookPreviewProvider", () => undefined);
          }

          dispose(): void {
            this.registration.dispose();
            owners.previewDisposed();
          }
        }
      }) as never,
    ownerSettlementTimeoutMs,
    additionalOwnerPromises
  );
}

function eventDisposable(set: Set<() => void>, listener: () => void): { dispose(): void } {
  set.add(listener);
  return host.disposable(() => set.delete(listener));
}

function registerMockCommands(context: MockExtensionContext, commandIds: readonly string[]): void {
  for (const id of commandIds) {
    context.subscriptions.push(host.registerCommand(id, (...args: unknown[]) => ({ id, args })));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
