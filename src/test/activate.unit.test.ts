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

  it("disposes the activation owner when the title context fails", async () => {
    const failure = new Error("setContext unavailable");
    vi.spyOn(vscode.commands, "executeCommand").mockRejectedValueOnce(failure);

    await expect(activate({ subscriptions: [] } as unknown as vscode.ExtensionContext)).rejects.toBe(failure);

    expect(lifecycle.dispose).toHaveBeenCalledOnce();
    await deactivate();
    expect(lifecycle.shutdown).not.toHaveBeenCalled();
  });

  it("returns only the owner-provided environment-gated API", async () => {
    const api = { testing: { sentinel: true } };
    lifecycle.extensionApiForCurrentEnvironment.mockResolvedValue(api);

    await expect(activate({ subscriptions: [] } as unknown as vscode.ExtensionContext)).resolves.toBe(api);
  });

  it("delegates terminal cleanup exactly once", async () => {
    await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

    await deactivate();
    await deactivate();

    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
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

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
