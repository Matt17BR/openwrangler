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
vi.mock("../extension/notebooks/jupyterBridge", () => ({ registerNotebookCommands: vi.fn() }));
vi.mock("../extension/notebooks/rendererMessaging", () => ({ registerNotebookRendererMessaging: vi.fn() }));
vi.mock("../extension/notebooks/notebookPreviewCoordinator", () => ({
  NotebookPreviewCoordinator: vi.fn(function MockNotebookPreviewCoordinator() {
    return { dispose: vi.fn() };
  })
}));
vi.mock("../extension/runtimeCommands", () => ({ registerRuntimeCommands: vi.fn() }));
vi.mock("../extension/nativeViews", () => ({ registerNativeViews: vi.fn(() => ({})) }));
vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: { disposePanelForSession: vi.fn() }
}));

import { activate, deactivate, isCursorAppName } from "../extension/activate";

describe("extension deactivation", () => {
  const originalExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;

  beforeEach(async () => {
    delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    (vscode.env as { appName: string }).appName = "Visual Studio Code";
    lifecycle.bridge.shutdown.mockReset().mockResolvedValue(undefined);
    lifecycle.bridge.reportDiagnostic.mockReset();
    lifecycle.bridge.declineRuntimeDependencyRevalidationForTesting.mockReset().mockResolvedValue(false);
    lifecycle.coordinator.shutdown.mockReset().mockResolvedValue(undefined);
    lifecycle.coordinator.testingRequestExecutionCheckpoint.mockReset();
    lifecycle.coordinatedBridge.request.mockReset();
    lifecycle.coordinatedBridge.cancelViewRequests.mockReset();
    lifecycle.coordinator.createBridge.mockReset().mockReturnValue(lifecycle.coordinatedBridge);
    await activate({ subscriptions: [], workspaceState: {} } as unknown as vscode.ExtensionContext);
  });

  afterEach(async () => {
    lifecycle.bridge.shutdown.mockResolvedValue(undefined);
    lifecycle.coordinator.shutdown.mockResolvedValue(undefined);
    await deactivate();
    vi.restoreAllMocks();
    if (originalExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    else process.env.OPEN_WRANGLER_EXTENSION_TESTS = originalExtensionTests;
  });

  it("waits for coordinator shutdown before starting bridge shutdown", async () => {
    const coordinatorGate = deferred<void>();
    lifecycle.coordinator.shutdown.mockReturnValue(coordinatorGate.promise);

    const deactivation = deactivate();
    expect(lifecycle.coordinator.shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.bridge.shutdown).not.toHaveBeenCalled();

    coordinatorGate.resolve();
    await expect(deactivation).resolves.toBeUndefined();
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

  it("aggregates coordinator and bridge failures in shutdown order", async () => {
    const coordinatorFailure = new Error("coordinator drain failed");
    const bridgeFailure = new Error("runtime exit was not confirmed");
    lifecycle.coordinator.shutdown.mockRejectedValue(coordinatorFailure);
    lifecycle.bridge.shutdown.mockRejectedValue(bridgeFailure);

    const error = await deactivate().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([coordinatorFailure, bridgeFailure]);
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

  it("exposes exact scheduler checkpoints only through the environment-gated test API", async () => {
    await deactivate();
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    lifecycle.coordinator.testingRequestExecutionCheckpoint.mockReturnValue({
      sessionId: "session-a",
      state: "active",
      lane: "background",
      requestKind: "getSummary",
      viewRequestId: "profile-a"
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

  it("waits for the editor-title override before registering extension services", async () => {
    await deactivate();
    lifecycle.coordinator.createBridge.mockClear();
    const contextGate = deferred<void>();
    vi.spyOn(vscode.commands, "executeCommand").mockImplementationOnce(
      () => contextGate.promise as unknown as Thenable<undefined>
    );

    const activation = activate({
      subscriptions: [],
      workspaceState: {}
    } as unknown as vscode.ExtensionContext);
    await Promise.resolve();
    expect(lifecycle.coordinator.createBridge).not.toHaveBeenCalled();

    contextGate.resolve(undefined);
    await activation;
    expect(lifecycle.coordinator.createBridge).toHaveBeenCalledOnce();
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
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
