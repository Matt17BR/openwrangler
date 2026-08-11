import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, TextDocument, TextEditor } from "vscode";
import type { SessionCoordinator } from "../extension/sessionCoordinator";
import type { LiterateDocumentOrigin } from "../extension/literateDocumentOrigin";
import type {
  LiterateRVariableProvider,
  RInteractiveCommandTransport,
  RInteractiveTransportFactory,
  RLiveVariableProvider
} from "../extension/r/rInteractiveCommands";

type CommandHandler = (...args: unknown[]) => Promise<unknown>;
type Listener<T> = (value: T) => unknown;

const mocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  trusted: true,
  terminals: [] as Array<{ name: string; sendText: ReturnType<typeof vi.fn> }>,
  activeTerminal: undefined as { name: string; sendText: ReturnType<typeof vi.fn> } | undefined,
  activeTerminalListeners: new Set<Listener<unknown>>(),
  closeTerminalListeners: new Set<Listener<unknown>>(),
  showQuickPick: vi.fn<(items: readonly unknown[]) => Promise<unknown>>(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
  withProgress: vi.fn(),
  panelCreate: vi.fn(),
  restoreEditorGroupAfterQuickPick: vi.fn(async () => undefined),
  bridgeArguments: [] as unknown[][],
  bridgeDispose: vi.fn(async () => undefined),
  activeEditor: undefined as TextEditor | undefined,
  textDocuments: [] as TextDocument[]
}));

vi.mock("vscode", () => {
  class Uri {
    readonly fsPath: string;
    private constructor(
      readonly path: string,
      readonly scheme = "file"
    ) {
      this.fsPath = path;
    }
    static file(path: string): Uri {
      return new Uri(path);
    }
    static parse(value: string): Uri {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/[^/?#]*)?([^?#]*)/u.exec(value);
      return new Uri(match?.[2] ?? value, match?.[1] ?? "file");
    }
    toString(): string {
      return `${this.scheme}://${this.path}`;
    }
  }
  class EventEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();
    readonly event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  return {
    Uri,
    EventEmitter,
    ProgressLocation: { Notification: 15 },
    commands: {
      registerCommand: (id: string, handler: CommandHandler) => {
        mocks.commands.set(id, handler);
        return { dispose: () => mocks.commands.delete(id) };
      },
      executeCommand: mocks.executeCommand
    },
    workspace: {
      get isTrusted() {
        return mocks.trusted;
      },
      get textDocuments() {
        return mocks.textDocuments;
      }
    },
    window: {
      get terminals() {
        return mocks.terminals;
      },
      get activeTerminal() {
        return mocks.activeTerminal;
      },
      get activeTextEditor() {
        return mocks.activeEditor;
      },
      onDidChangeActiveTerminal: (listener: Listener<unknown>) => {
        mocks.activeTerminalListeners.add(listener);
        return { dispose: () => mocks.activeTerminalListeners.delete(listener) };
      },
      onDidCloseTerminal: (listener: Listener<unknown>) => {
        mocks.closeTerminalListeners.add(listener);
        return { dispose: () => mocks.closeTerminalListeners.delete(listener) };
      },
      withProgress: mocks.withProgress,
      showQuickPick: mocks.showQuickPick,
      showInformationMessage: mocks.showInformationMessage,
      showWarningMessage: mocks.showWarningMessage,
      showErrorMessage: mocks.showErrorMessage
    }
  };
});

vi.mock("../extension/configuration", () => ({
  getSetting: (key: string, fallback: unknown) => (key === "sessionOpenTimeoutMs" ? 45_000 : fallback)
}));

vi.mock("../extension/r/rInteractiveSessionTransport", () => ({
  RInteractiveSessionTransport: class {}
}));

vi.mock("../extension/r/rKernelBridge", () => ({
  RKernelBridge: class {
    constructor(...args: unknown[]) {
      mocks.bridgeArguments.push(args);
    }
    dispose = mocks.bridgeDispose;
  }
}));

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: { create: mocks.panelCreate },
  restoreEditorGroupAfterQuickPick: mocks.restoreEditorGroupAfterQuickPick
}));

import * as vscode from "vscode";
import {
  OPEN_CACHED_R_INTERACTIVE_VARIABLE_COMMAND,
  OPEN_R_DATAFRAME_COMMAND,
  OPEN_R_INTERACTIVE_VARIABLE_COMMAND,
  REFRESH_R_INTERACTIVE_VARIABLES_COMMAND,
  registerRInteractiveCommands
} from "../extension/r/rInteractiveCommands";

const tibble = { name: "orders", backend: "r" as const, dataframeFlavor: "r.tibble" as const };

describe("active R session commands", () => {
  beforeEach(() => {
    mocks.commands.clear();
    mocks.trusted = true;
    mocks.terminals = [];
    mocks.activeTerminal = undefined;
    mocks.activeEditor = undefined;
    mocks.textDocuments.length = 0;
    mocks.activeTerminalListeners.clear();
    mocks.closeTerminalListeners.clear();
    mocks.showQuickPick.mockReset();
    mocks.showInformationMessage.mockReset();
    mocks.showWarningMessage.mockReset();
    mocks.showErrorMessage.mockReset();
    mocks.executeCommand.mockReset();
    mocks.executeCommand.mockResolvedValue(true);
    mocks.withProgress.mockReset();
    mocks.withProgress.mockImplementation(
      async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
        task(undefined, cancellationToken())
    );
    mocks.panelCreate.mockReset();
    mocks.restoreEditorGroupAfterQuickPick.mockReset();
    mocks.restoreEditorGroupAfterQuickPick.mockResolvedValue(undefined);
    mocks.bridgeArguments.length = 0;
    mocks.bridgeDispose.mockClear();
  });

  it("picks and opens a live dataframe from an explicit active-R command", async () => {
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    const { factory, coordinator } = registerWith([transport]);

    await expect(command(OPEN_R_INTERACTIVE_VARIABLE_COMMAND)()).resolves.toBe(true);

    expect(factory.create).toHaveBeenCalledWith(expect.anything(), { terminalMode: "activeOrCreate" });
    expect(transport.discoverVariables).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).toHaveBeenCalledWith(expect.anything());
    expect(mocks.bridgeArguments[0]?.[4]).toEqual(tibble);
    expect(mocks.panelCreate).toHaveBeenCalledWith(
      expect.objectContaining({ extensionPath: "/extension" }),
      expect.anything(),
      { kind: "rInteractiveVariable", label: "orders", variableName: "orders" },
      "r"
    );
    expect(mocks.restoreEditorGroupAfterQuickPick).toHaveBeenCalledOnce();
    expect(mocks.restoreEditorGroupAfterQuickPick.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.panelCreate.mock.invocationCallOrder[0]!
    );
    expect(transport.dispose).not.toHaveBeenCalled();
  });

  it("opens a fresh R chunk session against the exact literate document origin", async () => {
    setActiveTerminal(rTerminal("R"));
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    const source = literateDocument("/workspace/orders.qmd");
    const editor = textEditor(source, 2);
    mocks.textDocuments.push(source);
    mocks.activeEditor = editor;
    const origin = literateOrigin(editor);
    const { provider, coordinator, factory } = registerWith([transport]);
    const session = literateRProvider(provider).captureActiveSession();
    expect(session).toBeDefined();
    if (!session) throw new Error("Expected the active R terminal to be captured.");

    await expect(literateRProvider(provider).openLiterateSession(origin, session, true)).resolves.toBe(true);

    expect(transport.discoverVariables).toHaveBeenCalledOnce();
    expect(factory.create).toHaveBeenCalledWith(expect.anything(), { terminalMode: "active" });
    expect(coordinator.createBridge).toHaveBeenCalledWith(expect.anything(), {
      kind: "textDocument",
      document: source,
      version: 1
    });
    expect(mocks.panelCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        kind: "documentVariable",
        label: "orders",
        variableName: "orders",
        uri: "file:///workspace/orders.qmd"
      },
      "r"
    );
  });

  it("keeps an existing R-session fallback terminal-owned outside a freshly run chunk", async () => {
    setActiveTerminal(rTerminal("R"));
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    const source = literateDocument("/workspace/orders.qmd");
    const editor = textEditor(source, 2);
    mocks.textDocuments.push(source);
    mocks.activeEditor = editor;
    const origin = literateOrigin(editor);
    const { provider, coordinator } = registerWith([transport]);
    const session = literateRProvider(provider).captureActiveSession();
    expect(session).toBeDefined();
    if (!session) throw new Error("Expected the active R terminal to be captured.");

    await expect(literateRProvider(provider).openLiterateSession(origin, session)).resolves.toBe(true);

    expect(coordinator.createBridge).toHaveBeenCalledWith(expect.anything());
    expect(mocks.panelCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { kind: "rInteractiveVariable", label: "orders", variableName: "orders" },
      "r"
    );
  });

  it("disposes R discovery when the exact literate cursor changes across its await", async () => {
    setActiveTerminal(rTerminal("R"));
    const transport = transportMock();
    const source = literateDocument("/workspace/orders.Rmd");
    const editor = textEditor(source, 2);
    mocks.textDocuments.push(source);
    mocks.activeEditor = editor;
    const origin = literateOrigin(editor, "rmarkdown");
    transport.discoverVariables.mockImplementationOnce(async () => {
      const moved = selection(3);
      editor.selection = moved;
      editor.selections = [moved];
      return discovery(tibble);
    });
    const { provider, coordinator } = registerWith([transport]);
    const session = literateRProvider(provider).captureActiveSession();
    expect(session).toBeDefined();
    if (!session) throw new Error("Expected the active R terminal to be captured.");

    await expect(literateRProvider(provider).openLiterateSession(origin, session, true)).resolves.toBe(false);

    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });

  it("disposes discovery when another R terminal becomes active", async () => {
    const original = rTerminal("R");
    const replacement = rTerminal("R Interactive");
    setActiveTerminal(original);
    const transport = transportMock();
    transport.discoverVariables.mockImplementationOnce(async () => {
      emitActiveTerminal(replacement);
      return discovery(tibble);
    });
    const source = literateDocument("/workspace/orders.qmd");
    const editor = textEditor(source, 2);
    mocks.textDocuments.push(source);
    mocks.activeEditor = editor;
    const origin = literateOrigin(editor);
    const { provider, coordinator } = registerWith([transport]);
    const session = literateRProvider(provider).captureActiveSession();
    if (!session) throw new Error("Expected the original R terminal to be captured.");

    await expect(literateRProvider(provider).openLiterateSession(origin, session, true)).resolves.toBe(false);

    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });

  it("does not reconnect after prior-transport cleanup changes the pinned R terminal", async () => {
    const original = rTerminal("R");
    const replacement = rTerminal("R Interactive");
    setActiveTerminal(original);
    const previous = transportMock();
    previous.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    const next = transportMock();
    const source = literateDocument("/workspace/orders.qmd");
    const editor = textEditor(source, 2);
    mocks.textDocuments.push(source);
    mocks.activeEditor = editor;
    const origin = literateOrigin(editor);
    const { provider, factory, coordinator } = registerWith([previous, next]);
    await expect(provider.refreshFromCommand()).resolves.toBe(true);
    const session = literateRProvider(provider).captureActiveSession();
    if (!session) throw new Error("Expected the original R terminal to be captured.");
    previous.dispose.mockImplementationOnce(async () => {
      emitActiveTerminal(replacement);
    });

    await expect(literateRProvider(provider).openLiterateSession(origin, session, true)).resolves.toBe(false);

    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(next.discoverVariables).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
  });

  it("uses the active R session from the stable editor action", async () => {
    setActiveTerminal(rTerminal("R"));
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    registerWith([transport]);

    await expect(command(OPEN_R_DATAFRAME_COMMAND)()).resolves.toBe(true);

    expect(transport.discoverVariables).toHaveBeenCalledOnce();
    expect(mocks.executeCommand).not.toHaveBeenCalledWith("openWrangler.runRDocument", expect.anything());
    expect(mocks.panelCreate).toHaveBeenCalledOnce();
  });

  it("routes a mixed literate editor through cursor-aware dispatch even when R is active", async () => {
    setActiveTerminal(rTerminal("R"));
    const source = literateDocument("/workspace/orders.qmd");
    mocks.textDocuments.push(source);
    mocks.activeEditor = textEditor(source, 2);
    registerWith([]);

    await expect(command(OPEN_R_DATAFRAME_COMMAND)()).resolves.toBe(true);

    expect(mocks.executeCommand).toHaveBeenCalledWith("openWrangler.runRDocument");
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });

  it("does not route an explicit different literate resource through the active cursor", async () => {
    const source = literateDocument("/workspace/active.qmd");
    const resource = (vscode.Uri as unknown as { file(path: string): vscode.Uri }).file("/workspace/other.qmd");
    mocks.textDocuments.push(source);
    mocks.activeEditor = textEditor(source, 2);
    registerWith([]);

    await expect(command(OPEN_R_DATAFRAME_COMMAND)(resource)).resolves.toBe(true);

    expect(mocks.executeCommand).toHaveBeenCalledWith("openWrangler.runRDocument", resource);
  });

  it("reuses the refreshed terminal transport from the stable editor action", async () => {
    const terminal = rTerminal("R");
    setActiveTerminal(terminal);
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    const { factory, provider } = registerWith([transport]);

    await expect(command(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND)()).resolves.toBe(true);
    await expect(command(OPEN_R_DATAFRAME_COMMAND)()).resolves.toBe(true);

    expect(factory.create).toHaveBeenCalledOnce();
    expect(factory.create).toHaveBeenCalledWith(expect.anything(), { terminalMode: "active" });
    expect(transport.discoverVariables).toHaveBeenCalledOnce();
    expect(mocks.bridgeArguments[0]?.[1]).toBe(transport);
    expect(mocks.bridgeArguments[0]?.[4]).toEqual(tibble);
    expect(provider.snapshot().state).toBe("idle");
    expect(transport.dispose).not.toHaveBeenCalled();
  });

  it("keeps a refreshed terminal transport when its stable picker is dismissed", async () => {
    const terminal = rTerminal("R");
    setActiveTerminal(terminal);
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    mocks.showQuickPick.mockResolvedValueOnce(undefined);
    const { factory, provider } = registerWith([transport]);

    await expect(command(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND)()).resolves.toBe(true);
    const ready = provider.snapshot();
    await expect(command(OPEN_R_DATAFRAME_COMMAND)()).resolves.toBe(false);

    expect(factory.create).toHaveBeenCalledOnce();
    expect(transport.discoverVariables).toHaveBeenCalledOnce();
    expect(provider.snapshot()).toBe(ready);
    expect(transport.dispose).not.toHaveBeenCalled();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });

  it("rejects a cached picker selection after the active R terminal changes", async () => {
    const first = rTerminal("R");
    const second = rTerminal("R Interactive");
    setActiveTerminal(first);
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    const choose = deferred<"choose">();
    mocks.showQuickPick.mockImplementationOnce(async (items) => {
      await choose.promise;
      return items[0];
    });
    const { provider } = registerWith([transport]);

    await expect(command(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND)()).resolves.toBe(true);
    const opening = command(OPEN_R_DATAFRAME_COMMAND)();
    await vi.waitFor(() => expect(mocks.showQuickPick).toHaveBeenCalledOnce());

    emitActiveTerminal(second);
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledOnce());
    choose.resolve("choose");
    await expect(opening).resolves.toBe(false);

    expect(provider.snapshot()).toMatchObject({
      state: "idle",
      message: "A different R terminal is active. Wait for its prompt before reading it."
    });
    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });

  it("runs the current R document when no official R terminal is active", async () => {
    const resource = { scheme: "file", path: "/workspace/analysis.R" };
    registerWith([]);

    await expect(command(OPEN_R_DATAFRAME_COMMAND)(resource)).resolves.toBe(true);

    expect(mocks.executeCommand).toHaveBeenCalledWith("openWrangler.runRDocument", resource);
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });

  it("rechecks the active R picker after returning focus", async () => {
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    const { provider, coordinator } = registerWith([transport]);
    mocks.restoreEditorGroupAfterQuickPick.mockImplementationOnce(async () => {
      await provider.shutdown();
      return undefined;
    });

    await expect(command(OPEN_R_INTERACTIVE_VARIABLE_COMMAND)()).resolves.toBe(false);

    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });

  it("refreshes the exact active R terminal and transfers that transport when a cached row opens", async () => {
    const terminal = rTerminal("R");
    setActiveTerminal(terminal);
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    const { provider, factory } = registerWith([transport]);

    await expect(command(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND)()).resolves.toBe(true);
    expect(factory.create).toHaveBeenCalledWith(expect.anything(), { terminalMode: "active" });
    expect(provider.snapshot()).toMatchObject({
      state: "ready",
      terminalLabel: "R",
      variables: [{ label: "orders", description: "R · tibble" }]
    });
    const snapshot = provider.snapshot();
    if (snapshot.state !== "ready") throw new Error("Expected a refreshed R dataframe list.");

    await expect(command(OPEN_CACHED_R_INTERACTIVE_VARIABLE_COMMAND)(snapshot.variables[0]!.handle)).resolves.toBe(
      true
    );

    expect(mocks.bridgeArguments[0]?.[1]).toBe(transport);
    expect(mocks.bridgeArguments[0]?.[4]).toEqual(tibble);
    expect(transport.dispose).not.toHaveBeenCalled();
    expect(provider.snapshot().state).toBe("idle");
  });

  it("binds the active R terminal before progress can yield to a focus change", async () => {
    const first = rTerminal("R");
    const second = rTerminal("R Interactive");
    setActiveTerminal(first);
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    let runProgress: (() => Promise<unknown>) | undefined;
    mocks.withProgress.mockImplementationOnce(
      (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
        new Promise((resolve, reject) => {
          runProgress = () => task(undefined, cancellationToken()).then(resolve, reject);
        })
    );
    const { provider, factory } = registerWith([transport]);

    const refresh = command(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND)();
    expect(factory.create).toHaveBeenCalledWith(expect.anything(), { terminalMode: "active" });
    expect(provider.snapshot()).toMatchObject({ state: "loading", terminalLabel: "R" });

    emitActiveTerminal(second);
    await runProgress?.();
    await expect(refresh).resolves.toBe(false);

    expect(transport.discoverVariables).not.toHaveBeenCalled();
    expect(provider.snapshot()).toMatchObject({
      state: "idle",
      message: "A different R terminal is active. Wait for its prompt before reading it."
    });
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledOnce());
  });

  it("awaits and invalidates a picker transport during shutdown", async () => {
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    const quickPick = deferred<"first">();
    const disposal = deferred<undefined>();
    transport.dispose.mockReturnValue(disposal.promise);
    mocks.showQuickPick.mockImplementationOnce(async (items) => {
      await quickPick.promise;
      return items[0];
    });
    const { provider } = registerWith([transport]);

    const opening = command(OPEN_R_INTERACTIVE_VARIABLE_COMMAND)();
    await vi.waitFor(() => expect(mocks.showQuickPick).toHaveBeenCalledOnce());

    const shutdown = provider.shutdown();
    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
    disposal.resolve(undefined);
    await expect(shutdown).resolves.toBeUndefined();

    quickPick.resolve("first");
    await expect(opening).resolves.toBe(false);
    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });

  it("shuts down a cached-list transport exactly once", async () => {
    const terminal = rTerminal("R");
    setActiveTerminal(terminal);
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    const { provider } = registerWith([transport]);
    await command(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND)();

    const first = provider.shutdown();
    const second = provider.shutdown();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();

    expect(transport.dispose).toHaveBeenCalledOnce();
  });

  it("does not guess an R session when a shell terminal is active", async () => {
    setActiveTerminal({ name: "bash", sendText: vi.fn() });
    const { provider, factory } = registerWith([]);

    await expect(command(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND)()).resolves.toBe(false);

    expect(factory.create).not.toHaveBeenCalled();
    expect(provider.snapshot()).toMatchObject({
      state: "idle",
      message: "Select the R terminal that owns the dataframe first."
    });
    expect(mocks.showInformationMessage).toHaveBeenCalledOnce();
  });

  it("makes the active R session discoverable without sending code automatically", () => {
    const terminal = rTerminal("R");
    const { provider, factory } = registerWith([]);

    emitActiveTerminal(terminal);

    expect(factory.create).not.toHaveBeenCalled();
    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(provider.snapshot()).toMatchObject({
      state: "idle",
      terminalLabel: "R",
      message: "Reads the selected R session. Wait for the R prompt first."
    });
  });

  it("keeps a refreshed list when focus moves to a shell and clears it for another R terminal", async () => {
    const first = rTerminal("R");
    const second = rTerminal("R Interactive");
    setActiveTerminal(first);
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    const { provider } = registerWith([transport]);
    await command(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND)();

    emitActiveTerminal({ name: "bash", sendText: vi.fn() });
    expect(provider.snapshot().state).toBe("ready");

    emitActiveTerminal(second);
    expect(provider.snapshot()).toMatchObject({
      state: "idle",
      message: "A different R terminal is active. Wait for its prompt before reading it."
    });
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledOnce());
  });

  it("clears a refreshed list when its exact R terminal closes", async () => {
    const terminal = rTerminal("R");
    setActiveTerminal(terminal);
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    const { provider } = registerWith([transport]);
    await command(REFRESH_R_INTERACTIVE_VARIABLES_COMMAND)();

    emitClosedTerminal(terminal);

    expect(provider.snapshot()).toMatchObject({
      state: "idle",
      terminalLabel: "R session",
      message: "The R terminal closed. Start or select another R session.",
      variables: []
    });
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledOnce());
  });

  it("releases the transport when the dataframe picker is dismissed", async () => {
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce(discovery(tibble));
    mocks.showQuickPick.mockResolvedValueOnce(undefined);
    registerWith([transport]);

    await expect(command(OPEN_R_INTERACTIVE_VARIABLE_COMMAND)()).resolves.toBe(false);

    expect(mocks.showQuickPick).toHaveBeenCalledOnce();
    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });

  it("explains an empty active R session and releases the picker transport", async () => {
    const transport = transportMock();
    transport.discoverVariables.mockResolvedValueOnce({ variables: [], truncated: false });
    registerWith([transport]);

    await expect(command(OPEN_R_INTERACTIVE_VARIABLE_COMMAND)()).resolves.toBe(false);

    expect(mocks.showQuickPick).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      "The active R session does not contain a data.frame, tibble, or data.table."
    );
    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
  });
});

function registerWith(transports: ReturnType<typeof transportMock>[]): {
  readonly provider: RLiveVariableProvider;
  readonly factory: { create: ReturnType<typeof vi.fn> };
  readonly coordinator: ReturnType<typeof coordinatorMock>;
} {
  const context = { extensionPath: "/extension", subscriptions: [] } as unknown as ExtensionContext;
  const coordinator = coordinatorMock();
  const factory = {
    create: vi.fn(() => {
      const transport = transports.shift();
      if (!transport) throw new Error("No transport prepared for this test.");
      return transport as unknown as RInteractiveCommandTransport;
    })
  };
  const provider = registerRInteractiveCommands(
    context,
    coordinator as unknown as SessionCoordinator,
    factory as unknown as RInteractiveTransportFactory
  );
  return { provider, factory, coordinator };
}

function command(id: string): CommandHandler {
  const handler = mocks.commands.get(id);
  if (!handler) throw new Error(`${id} was not registered.`);
  return handler;
}

function literateRProvider(provider: RLiveVariableProvider): LiterateRVariableProvider {
  return provider as RLiveVariableProvider & LiterateRVariableProvider;
}

function literateDocument(filePath: string): TextDocument {
  return {
    uri: (vscode.Uri as unknown as { file(path: string): vscode.Uri }).file(filePath),
    version: 1,
    isClosed: false,
    isUntitled: false
  } as TextDocument;
}

function textEditor(document: TextDocument, line: number): TextEditor {
  const selected = selection(line);
  return {
    document,
    selection: selected,
    selections: [selected],
    viewColumn: 1
  } as unknown as TextEditor;
}

function selection(line: number): TextEditor["selection"] {
  const position = { line, character: 0 };
  return { anchor: position, active: position, start: position, end: position } as TextEditor["selection"];
}

function literateOrigin(editor: TextEditor, kind: "quarto" | "rmarkdown" = "quarto"): LiterateDocumentOrigin {
  const selected = editor.selection;
  return Object.freeze({
    editor,
    document: editor.document,
    version: editor.document.version,
    uri: editor.document.uri.toString(),
    kind,
    pythonExecutionOwner: kind === "rmarkdown" ? "r" : "unknown",
    viewColumn: 1,
    selections: Object.freeze([
      Object.freeze({
        anchor: Object.freeze({ line: selected.anchor.line, character: selected.anchor.character }),
        active: Object.freeze({ line: selected.active.line, character: selected.active.character })
      })
    ])
  });
}

function coordinatorMock() {
  return { createBridge: vi.fn(() => ({ request: vi.fn() })) };
}

function transportMock() {
  const invalidationListeners = new Set<() => unknown>();
  return {
    discoverVariables: vi.fn(),
    dispose: vi.fn(async () => undefined),
    onDidInvalidateKernel: (listener: () => unknown) => {
      invalidationListeners.add(listener);
      return { dispose: () => invalidationListeners.delete(listener) };
    }
  };
}

function rTerminal(name: "R" | "R Interactive") {
  return { name, sendText: vi.fn() };
}

function setActiveTerminal(terminal: { name: string; sendText: ReturnType<typeof vi.fn> }): void {
  mocks.terminals = [terminal];
  mocks.activeTerminal = terminal;
}

function emitActiveTerminal(terminal: { name: string; sendText: ReturnType<typeof vi.fn> }): void {
  if (!mocks.terminals.includes(terminal)) mocks.terminals.push(terminal);
  mocks.activeTerminal = terminal;
  for (const listener of mocks.activeTerminalListeners) listener(terminal);
}

function emitClosedTerminal(terminal: { name: string; sendText: ReturnType<typeof vi.fn> }): void {
  mocks.terminals = mocks.terminals.filter((candidate) => candidate !== terminal);
  if (mocks.activeTerminal === terminal) mocks.activeTerminal = undefined;
  for (const listener of mocks.closeTerminalListeners) listener(terminal);
}

function discovery(
  variable: typeof tibble | { readonly name: string; readonly backend: "r"; readonly dataframeFlavor: "r.data.table" }
) {
  return { variables: [variable], truncated: false };
}

function cancellationToken() {
  return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
