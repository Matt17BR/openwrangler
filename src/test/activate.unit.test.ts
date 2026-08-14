import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  bridge: {
    shutdown: vi.fn(),
    reportDiagnostic: vi.fn(),
    declineRuntimeDependencyRevalidationForTesting: vi.fn()
  },
  coordinator: {
    shutdown: vi.fn(),
    createBridge: vi.fn(),
    testingRequestExecutionCheckpoint: vi.fn()
  },
  coordinatedBridge: {
    request: vi.fn(),
    cancelViewRequests: vi.fn()
  },
  pickleWorkers: {
    run: vi.fn(),
    shutdown: vi.fn()
  },
  pythonVariables: {
    onDidChangeVariables: () => ({ dispose: vi.fn() }),
    snapshot: () => undefined,
    diagnosticsForTesting: vi.fn(),
    dispose: vi.fn()
  },
  rVariables: {
    onDidChangeVariables: () => ({ dispose: vi.fn() }),
    snapshot: () => undefined,
    startAutomaticDiscovery: vi.fn(),
    shutdown: vi.fn(),
    dispose: vi.fn()
  },
  notebookCellResults: {
    start: vi.fn(),
    dispose: vi.fn(),
    diagnosticsForTesting: vi.fn()
  },
  panels: {
    disposePanelForSession: vi.fn(),
    retireRendererForSessionForTesting: vi.fn()
  }
}));

vi.mock("../extension/pythonBridge", () => ({
  PythonBridge: vi.fn(function MockPythonBridge() {
    return lifecycle.bridge;
  })
}));

vi.mock("../extension/sessionCoordinator", () => ({
  SessionCoordinator: vi.fn(function MockSessionCoordinator() {
    return lifecycle.coordinator;
  })
}));

vi.mock("../extension/files/fileOpen", () => ({ registerFileCommands: vi.fn() }));
vi.mock("../extension/files/trustedPickleConversion", () => ({ registerTrustedPickleConversion: vi.fn() }));
vi.mock("../extension/files/trustedPickleWorker", () => ({
  TrustedPickleWorkerLifecycle: vi.fn(function MockTrustedPickleWorkerLifecycle() {
    return lifecycle.pickleWorkers;
  })
}));
vi.mock("../extension/notebooks/jupyterBridge", () => ({ registerNotebookCommands: vi.fn() }));
vi.mock("../extension/notebooks/notebookCellResult", () => ({
  NotebookCellResultTracker: vi.fn(function MockNotebookCellResultTracker() {
    return lifecycle.notebookCellResults;
  }),
  registerNotebookCellResultAction: vi.fn()
}));
vi.mock("../extension/notebooks/pythonInteractiveCommands", () => ({
  registerPythonInteractiveCommands: vi.fn(() => lifecycle.pythonVariables)
}));
vi.mock("../extension/notebooks/rendererMessaging", () => ({ registerNotebookRendererMessaging: vi.fn() }));
vi.mock("../extension/notebooks/notebookPreviewCoordinator", () => ({
  NotebookPreviewCoordinator: vi.fn(function MockNotebookPreviewCoordinator() {
    return { dispose: vi.fn() };
  })
}));
vi.mock("../extension/runtimeCommands", () => ({ registerRuntimeCommands: vi.fn() }));
vi.mock("../extension/r/rDocumentCommands", () => ({ registerRDocumentCommands: vi.fn() }));
vi.mock("../extension/r/rInteractiveCommands", () => ({
  registerRInteractiveCommands: vi.fn(() => lifecycle.rVariables)
}));
vi.mock("../extension/nativeViews", () => ({ registerNativeViews: vi.fn(() => ({})) }));
vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: lifecycle.panels
}));

import { activate, deactivate, isCursorAppName } from "../extension/activate";
import { registerNativeViews } from "../extension/nativeViews";
import { NotebookCellResultTracker, registerNotebookCellResultAction } from "../extension/notebooks/notebookCellResult";
import { registerRInteractiveCommands } from "../extension/r/rInteractiveCommands";

describe("extension deactivation", () => {
  const originalExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;

  beforeEach(async () => {
    delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    (vscode.env as { appName: string }).appName = "Visual Studio Code";
    lifecycle.bridge.shutdown.mockReset().mockResolvedValue(undefined);
    lifecycle.bridge.reportDiagnostic.mockReset();
    lifecycle.bridge.declineRuntimeDependencyRevalidationForTesting.mockReset().mockResolvedValue(false);
    lifecycle.coordinator.shutdown.mockReset().mockResolvedValue(undefined);
    lifecycle.pickleWorkers.run.mockReset();
    lifecycle.pickleWorkers.shutdown.mockReset().mockResolvedValue(undefined);
    lifecycle.rVariables.shutdown.mockReset().mockResolvedValue(undefined);
    lifecycle.rVariables.startAutomaticDiscovery.mockReset();
    lifecycle.notebookCellResults.start.mockReset();
    lifecycle.notebookCellResults.dispose.mockReset();
    lifecycle.notebookCellResults.diagnosticsForTesting.mockReset();
    lifecycle.pythonVariables.diagnosticsForTesting.mockReset();
    lifecycle.coordinator.testingRequestExecutionCheckpoint.mockReset();
    lifecycle.panels.retireRendererForSessionForTesting.mockReset();
    lifecycle.coordinatedBridge.request.mockReset();
    lifecycle.coordinatedBridge.cancelViewRequests.mockReset();
    lifecycle.coordinator.createBridge.mockReset().mockReturnValue(lifecycle.coordinatedBridge);
    vi.mocked(registerRInteractiveCommands).mockClear();
    vi.mocked(registerNativeViews).mockClear();
    await activate({ subscriptions: [], workspaceState: {} } as unknown as vscode.ExtensionContext);
  });

  afterEach(async () => {
    lifecycle.bridge.shutdown.mockResolvedValue(undefined);
    lifecycle.coordinator.shutdown.mockResolvedValue(undefined);
    lifecycle.pickleWorkers.shutdown.mockResolvedValue(undefined);
    await deactivate();
    vi.restoreAllMocks();
    if (originalExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    else process.env.OPEN_WRANGLER_EXTENSION_TESTS = originalExtensionTests;
  });

  it("waits for coordinator shutdown before starting bridge shutdown", async () => {
    const coordinatorGate = deferred<void>();
    lifecycle.coordinator.shutdown.mockReturnValue(coordinatorGate.promise);

    const deactivation = deactivate();
    expect(lifecycle.pickleWorkers.shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.bridge.shutdown).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(lifecycle.coordinator.shutdown).toHaveBeenCalledOnce());

    coordinatorGate.resolve();
    await expect(deactivation).resolves.toBeUndefined();
    expect(lifecycle.bridge.shutdown).toHaveBeenCalledOnce();
  });

  it("passes the registered active-R provider to the native Operations view", () => {
    expect(registerRInteractiveCommands).toHaveBeenCalledOnce();
    expect(registerRInteractiveCommands).toHaveBeenCalledWith(expect.anything(), lifecycle.coordinator);
    expect(registerNativeViews).toHaveBeenCalledOnce();
    expect(registerNativeViews).toHaveBeenCalledWith(
      expect.anything(),
      lifecycle.coordinator,
      lifecycle.pythonVariables,
      lifecycle.rVariables
    );
    expect(lifecycle.rVariables.startAutomaticDiscovery).toHaveBeenCalledOnce();
  });

  it("waits for active pickle workers before starting coordinator or bridge shutdown", async () => {
    const workerGate = deferred<void>();
    lifecycle.pickleWorkers.shutdown.mockReturnValue(workerGate.promise);

    const deactivation = deactivate();
    expect(lifecycle.pickleWorkers.shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.coordinator.shutdown).not.toHaveBeenCalled();
    expect(lifecycle.bridge.shutdown).not.toHaveBeenCalled();

    workerGate.resolve();
    await expect(deactivation).resolves.toBeUndefined();
    expect(lifecycle.coordinator.shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.bridge.shutdown).toHaveBeenCalledOnce();
  });

  it("waits for active R cleanup before starting coordinator or bridge shutdown", async () => {
    const rGate = deferred<void>();
    lifecycle.rVariables.shutdown.mockReturnValue(rGate.promise);

    const deactivation = deactivate();
    await Promise.resolve();
    expect(lifecycle.rVariables.shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.coordinator.shutdown).not.toHaveBeenCalled();
    expect(lifecycle.bridge.shutdown).not.toHaveBeenCalled();

    rGate.resolve();
    await expect(deactivation).resolves.toBeUndefined();
    expect(lifecycle.coordinator.shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.bridge.shutdown).toHaveBeenCalledOnce();
  });

  it("preserves a sole coordinator failure after still shutting down the bridge", async () => {
    const coordinatorFailure = new Error("coordinator drain failed");
    lifecycle.coordinator.shutdown.mockRejectedValue(coordinatorFailure);

    await expect(deactivate()).rejects.toBe(coordinatorFailure);
    expect(lifecycle.bridge.shutdown).toHaveBeenCalledOnce();
  });

  it("preserves a sole bridge shutdown failure", async () => {
    const bridgeFailure = new Error("runtime exit was not confirmed");
    lifecycle.bridge.shutdown.mockRejectedValue(bridgeFailure);

    await expect(deactivate()).rejects.toBe(bridgeFailure);
  });

  it("aggregates worker, coordinator, and bridge failures in shutdown order", async () => {
    const workerFailure = new Error("pickle worker exit was not confirmed");
    const coordinatorFailure = new Error("coordinator drain failed");
    const bridgeFailure = new Error("runtime exit was not confirmed");
    lifecycle.pickleWorkers.shutdown.mockRejectedValue(workerFailure);
    lifecycle.coordinator.shutdown.mockRejectedValue(coordinatorFailure);
    lifecycle.bridge.shutdown.mockRejectedValue(bridgeFailure);

    const error = await deactivate().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([workerFailure, coordinatorFailure, bridgeFailure]);
    expect((error as Error).message).toBe(
      "Open Wrangler extension deactivation encountered multiple shutdown failures."
    );
  });

  it("exposes exact bridge shutdown only through the environment-gated test API", async () => {
    await deactivate();
    lifecycle.bridge.shutdown.mockReset().mockResolvedValue(undefined);
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";

    const api = await activate({
      subscriptions: [],
      workspaceState: {}
    } as unknown as vscode.ExtensionContext);
    await expect(api?.testing?.shutdownRuntimeBridgeForTesting()).resolves.toBeUndefined();

    expect(lifecycle.bridge.shutdown).toHaveBeenCalledOnce();
  });

  it("exposes coordinator-owned queued view cancellation only through the environment-gated test API", async () => {
    await deactivate();
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";

    const api = await activate({
      subscriptions: [],
      workspaceState: {}
    } as unknown as vscode.ExtensionContext);
    api?.testing?.cancelViewRequests("session-a", ["profile-a"]);

    expect(lifecycle.coordinatedBridge.cancelViewRequests).toHaveBeenCalledWith("session-a", ["profile-a"]);
  });

  it("exposes exact renderer retirement only through the environment-gated test API", async () => {
    await deactivate();
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    lifecycle.panels.retireRendererForSessionForTesting.mockReturnValue(true);

    const api = await activate({
      subscriptions: [],
      workspaceState: {}
    } as unknown as vscode.ExtensionContext);

    expect(api?.testing?.retirePanelRenderer("session-a")).toBe(true);
    expect(lifecycle.panels.retireRendererForSessionForTesting).toHaveBeenCalledOnce();
    expect(lifecycle.panels.retireRendererForSessionForTesting).toHaveBeenCalledWith("session-a");
  });

  it("exposes exact scheduler and notebook-result diagnostics only through the environment-gated test API", async () => {
    await deactivate();
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    lifecycle.coordinator.testingRequestExecutionCheckpoint.mockReturnValue({
      sessionId: "session-a",
      state: "active",
      lane: "background",
      requestKind: "getSummary",
      viewRequestId: "profile-a"
    });
    lifecycle.notebookCellResults.diagnosticsForTesting.mockReturnValue({
      stage: "unseen",
      statusItem: "not-requested",
      reason: undefined
    } as never);
    lifecycle.pythonVariables.diagnosticsForTesting.mockReturnValue({
      invocation: 2,
      stage: "selecting-kernel",
      lastActiveStage: "selecting-kernel",
      stages: ["dispatching-cell", "waiting-for-cell-publication", "selecting-kernel"]
    });

    const api = await activate({
      subscriptions: [],
      workspaceState: {}
    } as unknown as vscode.ExtensionContext);

    expect(api?.testing?.requestExecutionCheckpoint("session-a", "getSummary", "profile-a")).toEqual({
      sessionId: "session-a",
      state: "active",
      lane: "background",
      requestKind: "getSummary",
      viewRequestId: "profile-a"
    });
    expect(lifecycle.coordinator.testingRequestExecutionCheckpoint).toHaveBeenCalledWith(
      "session-a",
      "getSummary",
      "profile-a"
    );
    expect(api?.testing?.notebookCellResultDiagnostics()).toEqual({
      stage: "unseen",
      statusItem: "not-requested",
      reason: undefined
    });
    expect(lifecycle.notebookCellResults.diagnosticsForTesting).toHaveBeenCalledOnce();
    expect(api?.testing?.pythonInteractiveDiagnostics()).toEqual({
      invocation: 2,
      stage: "selecting-kernel",
      lastActiveStage: "selecting-kernel",
      stages: ["dispatching-cell", "waiting-for-cell-publication", "selecting-kernel"]
    });
    expect(lifecycle.pythonVariables.diagnosticsForTesting).toHaveBeenCalledOnce();
  });

  it("exposes only a decline path for dependency revalidation through the environment-gated test API", async () => {
    await deactivate();
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";

    const api = await activate({
      subscriptions: [],
      workspaceState: {}
    } as unknown as vscode.ExtensionContext);

    await expect(api?.testing?.declineRuntimeDependencyRevalidation()).resolves.toBe(false);
    expect(lifecycle.bridge.declineRuntimeDependencyRevalidationForTesting).toHaveBeenCalledOnce();

    const testingApi = api?.testing as unknown as Record<string, unknown>;
    expect(testingApi.authorizeRuntimeDependencyRevalidation).toBeUndefined();
    expect(testingApi.runtimeDependencyRevalidationToken).toBeUndefined();
    expect(testingApi.runtimeDependencyRevalidationTarget).toBeUndefined();
    expect(testingApi.clearRuntimeDependencyMarker).toBeUndefined();
  });

  it.each([
    ["Cursor", true],
    ["Cursor Nightly", true],
    [" cursor insiders ", true],
    ["Visual Studio Code", false],
    ["VSCodium", false],
    ["", false]
  ])("classifies the editor host name %j without broad fork guessing", (appName, expected) => {
    expect(isCursorAppName(appName)).toBe(expected);
  });

  it.each([
    ["Cursor", true],
    ["Visual Studio Code", false]
  ])("publishes the immutable editor-title override for %s", async (appName, expected) => {
    await deactivate();
    (vscode.env as { appName: string }).appName = appName;
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

    await activate({ subscriptions: [], workspaceState: {} } as unknown as vscode.ExtensionContext);

    expect(executeCommand).toHaveBeenCalledWith("setContext", "openWrangler.forceNotebookEditorTitleAction", expected);
  });

  it("observes first-cell execution while waiting for the editor-title override", async () => {
    await deactivate();
    lifecycle.coordinator.createBridge.mockClear();
    lifecycle.notebookCellResults.start.mockClear();
    vi.mocked(NotebookCellResultTracker).mockClear();
    vi.mocked(registerNotebookCellResultAction).mockClear();
    const contextGate = deferred<void>();
    vi.spyOn(vscode.commands, "executeCommand").mockImplementationOnce(
      () => contextGate.promise as unknown as Thenable<undefined>
    );

    const activation = activate({
      subscriptions: [],
      workspaceState: {}
    } as unknown as vscode.ExtensionContext);
    await Promise.resolve();
    expect(NotebookCellResultTracker).toHaveBeenCalledOnce();
    expect(lifecycle.notebookCellResults.start).toHaveBeenCalledOnce();
    expect(registerNotebookCellResultAction).not.toHaveBeenCalled();
    expect(lifecycle.coordinator.createBridge).not.toHaveBeenCalled();

    contextGate.resolve(undefined);
    await activation;
    expect(lifecycle.coordinator.createBridge).toHaveBeenCalledOnce();
    expect(registerNotebookCellResultAction).toHaveBeenCalledWith(
      expect.anything(),
      lifecycle.coordinator,
      lifecycle.notebookCellResults
    );
  });

  it("fails activation before services register when the editor-title override cannot be published", async () => {
    await deactivate();
    lifecycle.coordinator.createBridge.mockClear();
    const failure = new Error("setContext unavailable");
    vi.spyOn(vscode.commands, "executeCommand").mockRejectedValueOnce(failure);

    await expect(
      activate({ subscriptions: [], workspaceState: {} } as unknown as vscode.ExtensionContext)
    ).rejects.toBe(failure);
    expect(lifecycle.coordinator.createBridge).not.toHaveBeenCalled();
    expect(lifecycle.notebookCellResults.dispose).toHaveBeenCalledOnce();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
