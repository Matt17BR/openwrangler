import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageMetadata from "../../package.json";

type CommandHandler = (...args: unknown[]) => unknown;

const host = vi.hoisted(() => {
  const commands = new Map<string, CommandHandler>();
  const visibleNotebookEditors: Array<{ notebook: { notebookType: string } }> = [];
  const customEditorProviders: unknown[] = [];
  const treeProviders = new Map<string, unknown>();
  const listeners = {
    visible: new Set<() => void>(),
    active: new Set<() => void>(),
    open: new Set<() => void>(),
    trust: new Set<() => void>()
  };
  const disposable = (dispose: () => void = () => undefined) => ({ dispose: vi.fn(dispose) });
  const registerCommand = vi.fn((id: string, handler: CommandHandler) => {
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
    registerCustomEditorProvider: vi.fn((_id: string, provider: unknown) => {
      customEditorProviders.push(provider);
      return disposable();
    }),
    registerTreeDataProvider: vi.fn((id: string, provider: unknown) => {
      treeProviders.set(id, provider);
      return disposable();
    }),
    registerWebviewViewProvider: vi.fn(() => disposable()),
    showErrorMessage: vi.fn(),
    reset(): void {
      commands.clear();
      visibleNotebookEditors.splice(0);
      customEditorProviders.splice(0);
      treeProviders.clear();
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
  nativeRegistered: vi.fn()
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
  registerRuntimeCommands: vi.fn(() => {
    owners.runtimeRegistered();
    for (const id of [
      "openWrangler.changeRuntime",
      "openWrangler.clearRuntime",
      "openWrangler.installRuntimeDependencies",
      "openWrangler.revalidateRuntimeDependencies"
    ]) {
      host.registerCommand(id, (...args: unknown[]) => ({ id, args }));
    }
  })
}));

vi.mock("../extension/files/fileOpen", () => ({
  OpenWranglerCustomEditorProvider: class {
    async resolveCustomEditor(): Promise<void> {
      owners.customEditorResolved();
    }
  },
  registerFileCommands: vi.fn(() => {
    for (const id of ["openWrangler.changeImportOptions", "openWrangler.openFile", "openWrangler.openPath"]) {
      host.registerCommand(id, () => id);
    }
  })
}));

const rVariables = vi.hoisted(() => ({
  startAutomaticDiscovery: owners.rDiscovery,
  shutdown: owners.rShutdown,
  dispose: vi.fn(),
  snapshot: vi.fn(),
  refreshFromCommand: vi.fn()
}));

vi.mock("../extension/r/rInteractiveCommands", () => ({
  registerRInteractiveCommands: vi.fn(() => {
    owners.rRegistered();
    for (const id of [
      "openWrangler.openRDataframe",
      "openWrangler.openRInteractiveVariable",
      "openWrangler.refreshRInteractiveVariables",
      "openWrangler.openCachedRInteractiveVariable"
    ]) {
      host.registerCommand(id, (...args: unknown[]) => ({ id, args }));
    }
    return rVariables;
  })
}));

vi.mock("../extension/notebooks/pythonInteractiveCommands", () => ({
  registerPythonInteractiveCommands: vi.fn(() => {
    owners.notebookRegistered();
    for (const id of [
      "openWrangler.runPythonCellAndOpenVariable",
      "openWrangler.refreshNotebookVariables",
      "openWrangler.openCachedNotebookVariable"
    ]) {
      host.registerCommand(id, () => id);
    }
    return { dispose: vi.fn(), diagnosticsForTesting: vi.fn() };
  })
}));

vi.mock("../extension/notebooks/jupyterBridge", () => ({
  registerNotebookCommands: vi.fn(() => {
    for (const id of [
      "openWrangler.launchDataViewer",
      "openWrangler.openNotebookVariable",
      "openWrangler.checkJupyterIntegration"
    ]) {
      host.registerCommand(id, () => id);
    }
  })
}));

vi.mock("../extension/notebooks/notebookCellResult", () => ({
  NotebookCellResultTracker: vi.fn(function MockNotebookCellResultTracker() {
    return { start: vi.fn(), dispose: vi.fn(), diagnosticsForTesting: vi.fn() };
  }),
  registerNotebookCellResultAction: vi.fn(() => {
    host.registerCommand("openWrangler.openNotebookCellResult", () => true);
  })
}));

vi.mock("../extension/notebooks/rendererMessaging", () => ({ registerNotebookRendererMessaging: vi.fn() }));

vi.mock("../extension/nativeViews", () => ({
  registerNativeViews: vi.fn(() => {
    owners.nativeRegistered();
    for (const id of [
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
    ]) {
      host.registerCommand(id, () => id);
    }
    return {
      setCodeForExport: vi.fn(),
      exportCodeTo: vi.fn(),
      notebookInsertionStatus: vi.fn(),
      viewSortDispatchStatus: vi.fn()
    };
  })
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

  it("constructs native views on first view demand without constructing Python", async () => {
    active = createOwners();
    active.startBeforeFirstYield();
    const provider = host.treeProviders.get("openWrangler.operations") as { getChildren(): Promise<unknown[]> };

    await provider.getChildren();

    expect(owners.nativeRegistered).toHaveBeenCalledOnce();
    expect(owners.notebookRegistered).toHaveBeenCalledOnce();
    expect(owners.rDiscovery).toHaveBeenCalledOnce();
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
  });
});

function createOwners(previewConstructed = vi.fn()): LazyActivationOwners {
  const context = { subscriptions: [], workspaceState: {} } as unknown as vscode.ExtensionContext;
  return new LazyActivationOwners(
    context,
    () =>
      ({
        NotebookPreviewCoordinator: class {
          constructor() {
            previewConstructed();
            host.registerCommand("openWrangler.chooseNotebookPreviewProvider", () => undefined);
          }

          dispose(): void {}
        }
      }) as never
  );
}

function eventDisposable(set: Set<() => void>, listener: () => void): { dispose(): void } {
  set.add(listener);
  return host.disposable(() => set.delete(listener));
}
