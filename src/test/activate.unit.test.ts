import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  startBeforeFirstYield: vi.fn(),
  extensionApiForCurrentEnvironment: vi.fn(),
  dispose: vi.fn(),
  shutdown: vi.fn()
}));

vi.mock("../extension/lazyActivationOwners", () => ({
  LazyActivationOwners: vi.fn(function MockLazyActivationOwners() {
    return lifecycle;
  })
}));

import { activate, deactivate, isCursorAppName } from "../extension/activate";

describe("extension activation boundary", () => {
  beforeEach(async () => {
    await deactivate();
    lifecycle.startBeforeFirstYield.mockReset();
    lifecycle.extensionApiForCurrentEnvironment.mockReset().mockResolvedValue(undefined);
    lifecycle.dispose.mockReset();
    lifecycle.shutdown.mockReset().mockResolvedValue(undefined);
    (vscode.env as { appName: string }).appName = "Visual Studio Code";
  });

  afterEach(async () => {
    lifecycle.shutdown.mockResolvedValue(undefined);
    await deactivate();
    vi.restoreAllMocks();
  });

  it("starts formatter-sensitive activation gates before the first yield", async () => {
    const contextGate = deferred<void>();
    vi.spyOn(vscode.commands, "executeCommand").mockImplementationOnce(
      () => contextGate.promise as unknown as Thenable<undefined>
    );

    const activation = activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

    expect(lifecycle.startBeforeFirstYield).toHaveBeenCalledOnce();
    expect(lifecycle.extensionApiForCurrentEnvironment).not.toHaveBeenCalled();
    contextGate.resolve();
    await activation;
    expect(lifecycle.extensionApiForCurrentEnvironment).toHaveBeenCalledOnce();
  });

  it("publishes the exact editor-title context before completing activation", async () => {
    (vscode.env as { appName: string }).appName = "Cursor Nightly";
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

    await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

    expect(executeCommand).toHaveBeenCalledWith("setContext", "openWrangler.forceNotebookEditorTitleAction", true);
  });

  it("shuts down an already-started visible-notebook owner when the title context fails", async () => {
    const failure = new Error("setContext unavailable");
    const visibleNotebookOwnerStarted = vi.fn();
    const visibleNotebookOwnerDisposed = vi.fn();
    lifecycle.startBeforeFirstYield.mockImplementationOnce(visibleNotebookOwnerStarted);
    lifecycle.shutdown.mockImplementationOnce(async () => visibleNotebookOwnerDisposed());
    vi.spyOn(vscode.commands, "executeCommand").mockRejectedValueOnce(failure);

    await expect(activate({ subscriptions: [] } as unknown as vscode.ExtensionContext)).rejects.toBe(failure);

    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
    expect(visibleNotebookOwnerStarted).toHaveBeenCalledOnce();
    expect(visibleNotebookOwnerDisposed).toHaveBeenCalledOnce();
    expect(lifecycle.dispose).not.toHaveBeenCalled();
    await deactivate();
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
  });

  it("preserves activation and shutdown failures together", async () => {
    const activationFailure = new Error("setContext unavailable");
    const firstShutdownFailure = new Error("owner cleanup failed");
    const secondShutdownFailure = new Error("output cleanup failed");
    vi.spyOn(vscode.commands, "executeCommand").mockRejectedValueOnce(activationFailure);
    lifecycle.shutdown.mockRejectedValueOnce(
      new AggregateError([firstShutdownFailure, secondShutdownFailure], "ordered owner cleanup failures")
    );

    const error = await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext).catch(
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([activationFailure, firstShutdownFailure, secondShutdownFailure]);
  });

  it("returns only the owner-provided environment-gated API", async () => {
    const api = { testing: { sentinel: true } };
    lifecycle.extensionApiForCurrentEnvironment.mockResolvedValue(api);

    await expect(activate({ subscriptions: [] } as unknown as vscode.ExtensionContext)).resolves.toBe(api);
  });

  it("does not publish a late activation after shutdown begins", async () => {
    const contextGate = deferred<void>();
    vi.spyOn(vscode.commands, "executeCommand").mockImplementationOnce(
      () => contextGate.promise as unknown as Thenable<undefined>
    );
    const activation = activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

    const shutdown = deactivate();
    contextGate.resolve();

    await expect(activation).rejects.toThrow("activation was cancelled");
    await shutdown;
    expect(lifecycle.extensionApiForCurrentEnvironment).not.toHaveBeenCalled();
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
  });

  it("rejects a concurrent activation instead of overwriting its unfinished owner", async () => {
    const contextGate = deferred<void>();
    vi.spyOn(vscode.commands, "executeCommand").mockImplementationOnce(
      () => contextGate.promise as unknown as Thenable<undefined>
    );
    const first = activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

    await expect(activate({ subscriptions: [] } as unknown as vscode.ExtensionContext)).rejects.toThrow(
      "already active or activating"
    );
    expect(lifecycle.startBeforeFirstYield).toHaveBeenCalledOnce();

    contextGate.resolve();
    await first;
  });

  it("waits for unfinished shutdown before reactivation constructs another owner", async () => {
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    const shutdownGate = deferred<void>();
    lifecycle.shutdown.mockReturnValueOnce(shutdownGate.promise);

    const shutdown = deactivate();
    const reactivation = activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    await Promise.resolve();
    expect(lifecycle.startBeforeFirstYield).toHaveBeenCalledOnce();

    shutdownGate.resolve();
    await shutdown;
    await reactivation;
    expect(lifecycle.startBeforeFirstYield).toHaveBeenCalledTimes(2);
  });

  it("delegates terminal cleanup exactly once", async () => {
    await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

    await deactivate();
    await deactivate();

    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
  });

  it("shares one ordered failure across concurrent deactivate calls", async () => {
    const shutdown = deferred<void>();
    const firstFailure = new Error("notebook cleanup failed");
    const secondFailure = new Error("R cleanup failed");
    const cleanupFailure = new AggregateError([firstFailure, secondFailure], "ordered cleanup failures");
    await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    lifecycle.shutdown.mockReturnValueOnce(shutdown.promise);

    const first = deactivate();
    const second = deactivate();

    expect(second).toBe(first);
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
    shutdown.reject(cleanupFailure);
    const failures = await Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error)
    ]);
    expect(failures).toEqual([cleanupFailure, cleanupFailure]);
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
});

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
