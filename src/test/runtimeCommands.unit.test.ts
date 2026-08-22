import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import type { PythonBridge } from "../extension/pythonBridge";

type CommandHandler = (...args: unknown[]) => unknown;

const runtimeMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  registrationAttempt: 0,
  failRegistrationAttempt: undefined as number | undefined,
  disposedRegistrations: vi.fn(),
  disposalFailures: new Map<string, Error>(),
  installMissingDependencies: vi.fn(async () => false),
  revalidateRuntimeDependencies: vi.fn(async () => false),
  clearRuntimeSelection: vi.fn(),
  updateSetting: vi.fn(async () => undefined)
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Workspace: 2 },
  commands: {
    registerCommand: (id: string, handler: CommandHandler) => {
      runtimeMocks.registrationAttempt += 1;
      if (runtimeMocks.registrationAttempt === runtimeMocks.failRegistrationAttempt) {
        throw new Error(`runtime registration failed at ${id}`);
      }
      runtimeMocks.commands.set(id, handler);
      return {
        dispose: () => {
          runtimeMocks.disposedRegistrations(id);
          if (runtimeMocks.commands.get(id) === handler) runtimeMocks.commands.delete(id);
          const failure = runtimeMocks.disposalFailures.get(id);
          if (failure) throw failure;
        }
      };
    }
  },
  window: {
    showInputBox: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined)
  }
}));

vi.mock("../extension/configuration", () => ({
  getSetting: <T>(_key: string, fallback: T): T => fallback,
  updateSetting: runtimeMocks.updateSetting
}));

import { registerRuntimeCommands } from "../extension/runtimeCommands";

describe("runtime dependency command", () => {
  beforeEach(() => {
    runtimeMocks.commands.clear();
    runtimeMocks.registrationAttempt = 0;
    runtimeMocks.failRegistrationAttempt = undefined;
    runtimeMocks.disposedRegistrations.mockReset();
    runtimeMocks.disposalFailures.clear();
    runtimeMocks.installMissingDependencies.mockClear();
    runtimeMocks.installMissingDependencies.mockResolvedValue(false);
    runtimeMocks.revalidateRuntimeDependencies.mockClear();
    runtimeMocks.revalidateRuntimeDependencies.mockResolvedValue(false);
    runtimeMocks.clearRuntimeSelection.mockClear();
    runtimeMocks.updateSetting.mockClear();
  });

  it("ignores arbitrary caller arguments and invokes the always-confirming bridge method without arguments", async () => {
    const bridge = {
      clearRuntimeSelection: vi.fn(),
      installMissingDependencies: runtimeMocks.installMissingDependencies
    } as unknown as PythonBridge;
    const context = { subscriptions: [] } as unknown as ExtensionContext;
    registerRuntimeCommands(context, bridge);

    const result = await command("openWrangler.installRuntimeDependencies")(
      true,
      false,
      { confirmed: true },
      "Install"
    );

    expect(result).toBe(false);
    expect(runtimeMocks.installMissingDependencies).toHaveBeenCalledOnce();
    expect(runtimeMocks.installMissingDependencies.mock.calls[0]).toEqual([]);
  });

  it("ignores arbitrary caller arguments and invokes dependency revalidation without arguments", async () => {
    register();

    const result = await command("openWrangler.revalidateRuntimeDependencies")("environment", "token", {
      confirmed: true
    });

    expect(result).toBe(false);
    expect(runtimeMocks.revalidateRuntimeDependencies).toHaveBeenCalledOnce();
    expect(runtimeMocks.revalidateRuntimeDependencies.mock.calls[0]).toEqual([]);
  });

  it("explicitly invalidates a changed runtime even if the configuration update emits no event", async () => {
    register();

    await command("openWrangler.changeRuntime")("/new/python");

    expect(runtimeMocks.updateSetting).toHaveBeenCalledWith("pythonPath", "/new/python", 2);
    expect(runtimeMocks.clearRuntimeSelection).toHaveBeenCalledOnce();
  });

  it("explicitly invalidates a cleared runtime even when the override was already absent", async () => {
    register();

    await command("openWrangler.clearRuntime")();

    expect(runtimeMocks.updateSetting).toHaveBeenCalledWith("pythonPath", undefined, 2);
    expect(runtimeMocks.clearRuntimeSelection).toHaveBeenCalledOnce();
  });

  it("transactionally disposes every retained command when a later real registration throws", () => {
    runtimeMocks.failRegistrationAttempt = 3;
    const context = { subscriptions: [] } as unknown as ExtensionContext;
    const bridge = {
      clearRuntimeSelection: runtimeMocks.clearRuntimeSelection,
      installMissingDependencies: runtimeMocks.installMissingDependencies,
      revalidateRuntimeDependencies: runtimeMocks.revalidateRuntimeDependencies
    } as unknown as PythonBridge;

    expect(() => registerRuntimeCommands(context, bridge)).toThrow("runtime registration failed");

    expect(context.subscriptions).toEqual([]);
    expect(runtimeMocks.commands.size).toBe(0);
    expect(runtimeMocks.disposedRegistrations.mock.calls.map(([id]) => id)).toEqual([
      "openWrangler.clearRuntime",
      "openWrangler.changeRuntime"
    ]);
  });

  it("preserves the primary registration fault and ordered cleanup faults while attempting every disposal", () => {
    runtimeMocks.failRegistrationAttempt = 3;
    runtimeMocks.disposalFailures.set("openWrangler.clearRuntime", new Error("clear cleanup failed"));
    runtimeMocks.disposalFailures.set("openWrangler.changeRuntime", new Error("change cleanup failed"));
    const context = { subscriptions: [] } as unknown as ExtensionContext;
    const bridge = {
      clearRuntimeSelection: runtimeMocks.clearRuntimeSelection,
      installMissingDependencies: runtimeMocks.installMissingDependencies,
      revalidateRuntimeDependencies: runtimeMocks.revalidateRuntimeDependencies
    } as unknown as PythonBridge;

    const error = captureFailure(() => registerRuntimeCommands(context, bridge));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((failure) => (failure as Error).message)).toEqual([
      "runtime registration failed at openWrangler.installRuntimeDependencies",
      "clear cleanup failed",
      "change cleanup failed"
    ]);
    expect(context.subscriptions).toEqual([]);
    expect(runtimeMocks.commands.size).toBe(0);
  });
});

function register(): void {
  const bridge = {
    clearRuntimeSelection: runtimeMocks.clearRuntimeSelection,
    installMissingDependencies: runtimeMocks.installMissingDependencies,
    revalidateRuntimeDependencies: runtimeMocks.revalidateRuntimeDependencies
  } as unknown as PythonBridge;
  const context = { subscriptions: [] } as unknown as ExtensionContext;
  registerRuntimeCommands(context, bridge);
}

function command(id: string): CommandHandler {
  const handler = runtimeMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}

function captureFailure(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the action to fail.");
}
