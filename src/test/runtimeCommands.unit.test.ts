import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import type { PythonBridge } from "../extension/pythonBridge";

type CommandHandler = (...args: unknown[]) => unknown;

const runtimeMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  installMissingDependencies: vi.fn(async () => false),
  clearRuntimeSelection: vi.fn(),
  updateSetting: vi.fn(async () => undefined)
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Workspace: 2 },
  commands: {
    registerCommand: (id: string, handler: CommandHandler) => {
      runtimeMocks.commands.set(id, handler);
      return { dispose: () => undefined };
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
    runtimeMocks.installMissingDependencies.mockClear();
    runtimeMocks.installMissingDependencies.mockResolvedValue(false);
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
});

function register(): void {
  const bridge = {
    clearRuntimeSelection: runtimeMocks.clearRuntimeSelection,
    installMissingDependencies: runtimeMocks.installMissingDependencies
  } as unknown as PythonBridge;
  const context = { subscriptions: [] } as unknown as ExtensionContext;
  registerRuntimeCommands(context, bridge);
}

function command(id: string): CommandHandler {
  const handler = runtimeMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}
