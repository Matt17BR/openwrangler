import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";
import type { DuckDBTableDiscovery, FilePlanOpenContext, OpenWranglerBridge } from "../extension/dataBridge";
import type { SessionSourceProtection } from "../extension/files/safeFileExport";
import type { SessionSource } from "../shared/protocol";
import { FileBackendUnavailableError } from "../extension/dataBridge";
import { isSessionSource } from "../shared/protocolValidation";
import type { RFileBridgeFactory } from "../extension/files/fileOpen";

type CommandHandler = (...args: unknown[]) => unknown;

const fileMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async () => undefined),
  createPanel: vi.fn(),
  panelConstructor: vi.fn(),
  changeActiveImportOptions: vi.fn(async () => false),
  detectImportOptions: vi.fn<(uri: unknown) => Promise<unknown>>(async () => undefined),
  bridgeRequest: vi.fn<OpenWranglerBridge["request"]>(async () => {
    throw new Error("Unsupported files must not start Python.");
  }),
  stat: vi.fn(async () => ({ type: 1 })),
  showWarningMessage: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showOpenDialog: vi.fn<
    (options?: { filters?: Record<string, string[]>; canSelectMany?: boolean }) => Promise<unknown>
  >(async () => undefined),
  showQuickPick: vi.fn<(items: readonly unknown[]) => Promise<unknown>>(async (items) => items[0]),
  discoverTables: vi.fn<() => Promise<DuckDBTableDiscovery | undefined>>(async () => undefined),
  captureSource: vi.fn(async () => ({ available: true as const, anchors: [] })),
  confirmSource: vi.fn(async (source: SessionSourceProtection) => source),
  trusted: true,
  customEditorProvider: undefined as
    | {
        resolveCustomEditor(
          document: { uri: unknown },
          panel: { dispose(): void },
          token: vscode.CancellationToken
        ): Promise<void>;
      }
    | undefined,
  activeTabInput: undefined as unknown,
  activeTextUri: undefined as unknown,
  enabledFileTypes: ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"] as unknown,
  defaultBackend: "auto",
  workspaceValues: new Map<string, unknown>()
}));

vi.mock("vscode", () => {
  class Uri {
    readonly authority: string;
    readonly path: string;
    readonly query = "";
    readonly fragment = "";

    private constructor(
      readonly scheme: string,
      readonly fsPath: string,
      authority = ""
    ) {
      this.authority = authority;
      this.path = fsPath;
    }

    static file(path: string): Uri {
      return new Uri("file", path);
    }

    static from(components: { scheme: string; path?: string; authority?: string }): Uri {
      return new Uri(components.scheme, components.path ?? "", components.authority);
    }

    static parse(value: string): Uri {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)/u.exec(value);
      if (!match) throw new Error(`Invalid URI: ${value}`);
      return new Uri(match[1] ?? "", match[3] ?? "", match[2] ?? "");
    }

    toString(): string {
      return `${this.scheme}://${this.authority}${this.fsPath}`;
    }
  }

  class TabInputText {
    constructor(readonly uri: Uri) {}
  }

  class TabInputTextDiff {
    constructor(
      readonly original: Uri,
      readonly modified: Uri
    ) {}
  }

  class TabInputCustom {
    constructor(
      readonly uri: Uri,
      readonly viewType: string
    ) {}
  }

  const disposable = () => ({ dispose: () => undefined });
  class CancellationTokenSource {
    private readonly state = { cancelled: false };
    private readonly listeners = new Set<(event: unknown) => unknown>();
    readonly token: vscode.CancellationToken;
    constructor() {
      const state = this.state;
      this.token = {
        get isCancellationRequested(): boolean {
          return state.cancelled;
        },
        onCancellationRequested: (listener: (event: unknown) => unknown) => {
          this.listeners.add(listener);
          return {
            dispose: () => {
              this.listeners.delete(listener);
            }
          };
        }
      };
    }
    cancel(): void {
      this.state.cancelled = true;
      for (const listener of this.listeners) listener(undefined);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  return {
    CancellationTokenSource,
    ProgressLocation: { Notification: 15 },
    Uri,
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    FileType: { File: 1, Directory: 2 },
    ViewColumn: { Active: 1 },
    commands: {
      executeCommand: fileMocks.executeCommand,
      registerCommand: (id: string, handler: CommandHandler) => {
        fileMocks.commands.set(id, handler);
        return disposable();
      }
    },
    window: {
      get activeTextEditor() {
        return fileMocks.activeTextUri ? { document: { uri: fileMocks.activeTextUri } } : undefined;
      },
      tabGroups: {
        activeTabGroup: {
          get activeTab() {
            return fileMocks.activeTabInput ? { input: fileMocks.activeTabInput } : undefined;
          }
        }
      },
      showWarningMessage: fileMocks.showWarningMessage,
      showInformationMessage: fileMocks.showInformationMessage,
      showErrorMessage: fileMocks.showErrorMessage,
      showOpenDialog: fileMocks.showOpenDialog,
      showQuickPick: fileMocks.showQuickPick,
      withProgress: async (_options: unknown, action: (progress: unknown, token: unknown) => Promise<unknown>) =>
        action({}, { isCancellationRequested: false, onCancellationRequested: () => disposable() })
    },
    workspace: {
      get isTrusted() {
        return fileMocks.trusted;
      },
      fs: { stat: fileMocks.stat }
    }
  };
});

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: class OpenWranglerPanel {
    static create(...args: unknown[]): unknown {
      return fileMocks.createPanel(...args);
    }

    static changeActiveImportOptions(): Promise<boolean> {
      return fileMocks.changeActiveImportOptions();
    }

    constructor(...args: unknown[]) {
      fileMocks.panelConstructor(...args);
    }
  }
}));

vi.mock("../extension/files/importOptions", () => ({
  detectImportOptions: fileMocks.detectImportOptions
}));
vi.mock("../extension/files/safeFileExport", () => ({
  captureSessionSourceProtection: fileMocks.captureSource,
  confirmSessionSourceProtection: fileMocks.confirmSource
}));

vi.mock("../extension/configuration", () => ({
  getSetting: <T>(key: string, fallback: T): T =>
    (key === "enabledFileTypes"
      ? fileMocks.enabledFileTypes
      : key === "defaultBackend"
        ? fileMocks.defaultBackend
        : fallback) as T
}));

import { OpenWranglerCustomEditorProvider, registerFileCommands } from "../extension/files/fileOpen";
import { CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY } from "../extension/files/confirmedFileConfigurations";

describe("file launch command", () => {
  beforeEach(() => {
    fileMocks.commands.clear();
    fileMocks.executeCommand.mockClear();
    fileMocks.createPanel.mockClear();
    fileMocks.panelConstructor.mockClear();
    fileMocks.changeActiveImportOptions.mockReset();
    fileMocks.changeActiveImportOptions.mockResolvedValue(false);
    fileMocks.detectImportOptions.mockReset();
    fileMocks.detectImportOptions.mockResolvedValue(undefined);
    fileMocks.bridgeRequest.mockClear();
    fileMocks.stat.mockReset();
    fileMocks.stat.mockResolvedValue({ type: vscode.FileType.File });
    fileMocks.showWarningMessage.mockClear();
    fileMocks.showInformationMessage.mockClear();
    fileMocks.showErrorMessage.mockClear();
    fileMocks.showOpenDialog.mockReset();
    fileMocks.showOpenDialog.mockResolvedValue(undefined);
    fileMocks.customEditorProvider = undefined;
    fileMocks.activeTabInput = undefined;
    fileMocks.activeTextUri = undefined;
    fileMocks.enabledFileTypes = ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"];
    fileMocks.defaultBackend = "auto";
    fileMocks.workspaceValues.clear();
    fileMocks.trusted = true;
    fileMocks.discoverTables.mockReset();
    fileMocks.discoverTables.mockResolvedValue(undefined);
    fileMocks.captureSource.mockReset().mockResolvedValue({ available: true, anchors: [] });
    fileMocks.confirmSource.mockReset().mockImplementation(async (source) => source);
    fileMocks.showQuickPick.mockReset().mockImplementation(async (items) => items[0]);
  });

  it("delegates the change-import-options command to the active configurable panel", async () => {
    fileMocks.changeActiveImportOptions.mockResolvedValueOnce(true);
    register();

    await command("openWrangler.changeImportOptions")();

    expect(fileMocks.changeActiveImportOptions).toHaveBeenCalledOnce();
    expect(fileMocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it("opens an exact selected DuckDB table from any local filename in viewing mode", async () => {
    const { context } = register();
    const uri = vscode.Uri.file('/workspace/quarter "data"');
    const table = { schema: " sales.$(add) ", name: ' "orders"\\$(add)\n ' };
    fileMocks.defaultBackend = "pandas";
    fileMocks.showOpenDialog.mockResolvedValue([uri]);
    fileMocks.discoverTables.mockResolvedValue({ tables: [table], isCurrent: () => true });
    await command("openWrangler.openDuckDBTable")();
    expect(fileMocks.discoverTables).toHaveBeenCalledWith(
      { kind: "file", label: 'quarter "data"', path: uri.fsPath, uri: uri.toString(), importOptions: undefined },
      expect.objectContaining({ cancellation: expect.anything() })
    );
    expect(fileMocks.captureSource).toHaveBeenCalledWith([uri]);
    expect(fileMocks.showOpenDialog.mock.calls[0]?.[0]?.filters).toBeUndefined();
    expect(fileMocks.showQuickPick.mock.calls[0]?.[0]).toEqual([
      {
        label: String.raw`" \"orders\"\\\u0024(add)\n "`,
        description: String.raw`Schema: " sales.\u0024(add) "`,
        table
      }
    ]);
    expect(fileMocks.createPanel).toHaveBeenCalledWith(
      context,
      expect.anything(),
      {
        kind: "file",
        label: 'quarter "data"',
        path: uri.fsPath,
        uri: uri.toString(),
        importOptions: { duckdbSchema: table.schema, duckdbTable: table.name }
      },
      "duckdb",
      "duckdb",
      "viewing"
    );
    expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
  });

  it("retains the source and interpreter guard until the initial DuckDB open is dispatched", async () => {
    register();
    let current = true;
    fileMocks.showOpenDialog.mockResolvedValue([vscode.Uri.file("/workspace/analytics")]);
    fileMocks.discoverTables.mockResolvedValue({
      tables: [{ schema: "main", name: "orders" }],
      isCurrent: () => current
    });
    await command("openWrangler.openDuckDBTable")();
    const call = fileMocks.createPanel.mock.calls[0]!;
    const scoped = call[1] as OpenWranglerBridge;
    const source = call[2] as SessionSource;
    const request = {
      kind: "openSession" as const,
      source,
      backend: "duckdb" as const,
      pageSize: 1,
      columnOffset: 0,
      columnLimit: 1
    };
    fileMocks.confirmSource.mockResolvedValueOnce({ available: false });
    await expect(scoped.request(request)).resolves.toMatchObject({ kind: "error", code: "duckdb_selection_changed" });
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
    fileMocks.bridgeRequest.mockImplementationOnce(async (_request, options) => {
      expect(options?.cancellation?.isCancellationRequested).toBe(false);
      expect(options?.requiredSourceProtection).toBe(await fileMocks.captureSource.mock.results[0]!.value);
      current = false;
      expect(options?.cancellation?.isCancellationRequested).toBe(true);
      return { kind: "cancelled", targetRequestId: "not-started" };
    });
    await expect(scoped.request(request)).resolves.toMatchObject({ kind: "cancelled" });
    expect(fileMocks.bridgeRequest).toHaveBeenCalledOnce();
  });

  it("rejects a changed DuckDB discovery selection after the table picker", async () => {
    register();
    let current = true;
    fileMocks.showOpenDialog.mockResolvedValue([vscode.Uri.file("/workspace/analytics")]);
    fileMocks.discoverTables.mockResolvedValue({
      tables: [{ schema: "main", name: "orders" }],
      isCurrent: () => current
    });
    fileMocks.showQuickPick.mockImplementationOnce(async (items) => {
      current = false;
      return items[0];
    });
    await command("openWrangler.openDuckDBTable")();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("changed"));
  });

  it("does no DuckDB discovery before trust and explains an empty catalog without opening a panel", async () => {
    register();
    fileMocks.trusted = false;
    await command("openWrangler.openDuckDBTable")();
    expect(fileMocks.showOpenDialog).not.toHaveBeenCalled();
    expect(fileMocks.discoverTables).not.toHaveBeenCalled();
    fileMocks.trusted = true;
    fileMocks.showOpenDialog.mockResolvedValue([vscode.Uri.file("/workspace/empty")]);
    fileMocks.discoverTables.mockResolvedValue({ tables: [], isCurrent: () => true });
    await command("openWrangler.openDuckDBTable")();
    expect(fileMocks.showInformationMessage).toHaveBeenLastCalledWith(expect.stringContaining("no user tables"));
    expect(fileMocks.showQuickPick).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("discards late DuckDB discovery after command-owner disposal", async () => {
    const { context } = register();
    let finish!: (value: DuckDBTableDiscovery) => void;
    fileMocks.discoverTables.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    fileMocks.showOpenDialog.mockResolvedValue([vscode.Uri.file("/workspace/analytics")]);
    const pending = command("openWrangler.openDuckDBTable")();
    await vi.waitFor(() => expect(fileMocks.discoverTables).toHaveBeenCalledOnce());
    for (const subscription of context.subscriptions) subscription.dispose();
    finish({ tables: [{ schema: "main", name: "orders" }], isCurrent: () => true });
    await pending;
    expect(fileMocks.showQuickPick).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("captures the plan before the picker and uses its bridge, backend and import settings", async () => {
    const { context, bridge } = register();
    const target = vscode.Uri.file("/workspace/next.csv");
    const targetBridge: OpenWranglerBridge = { request: vi.fn() };
    const captured: FilePlanOpenContext = {
      backend: "pandas",
      importOptions: { delimiter: ";", encoding: "windows-1252", quoteChar: "'", hasHeader: false },
      isCurrent: () => true,
      createBridge: () => targetBridge
    };
    const capture = vi.fn(() => captured);
    bridge.captureActiveFilePlan = capture;
    fileMocks.showOpenDialog.mockImplementationOnce(async () => {
      expect(capture).toHaveBeenCalledOnce();
      fileMocks.defaultBackend = "duckdb";
      fileMocks.activeTextUri = vscode.Uri.file("/workspace/unrelated.parquet");
      capture.mockReturnValue({
        backend: "polars",
        importOptions: undefined,
        isCurrent: () => true,
        createBridge: () => bridge
      });
      return [target];
    });

    await command("openWrangler.openFileWithPlan")();

    expect(capture).toHaveBeenCalledOnce();
    expect(fileMocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ canSelectMany: false }));
    expect(fileMocks.stat).toHaveBeenCalledWith(target);
    expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).toHaveBeenCalledExactlyOnceWith(
      context,
      targetBridge,
      {
        kind: "file",
        label: "next.csv",
        path: target.fsPath,
        uri: target.toString(),
        importOptions: captured.importOptions
      },
      "pandas",
      "pandas",
      "editing"
    );
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
  });

  it.each([
    "success",
    "cancelled",
    "stale before",
    "stale after",
    "disposed",
    "factory failure",
    "panel failure"
  ] as const)("keeps an R plan target owned through factory handoff: %s", async (outcome) => {
    let current = true;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const native: OpenWranglerBridge = { request: vi.fn(), onIdle: vi.fn() };
    const targetBridge: OpenWranglerBridge = { request: vi.fn(), onIdle: native.onIdle };
    const bind = vi.fn(() => targetBridge);
    const factory = vi.fn<RFileBridgeFactory>(async (_source, bindDelegate) => {
      if (outcome === "factory failure") throw new Error("factory failed");
      const result = bindDelegate!(native);
      await pending;
      return result;
    });
    const { context, bridge } = register(factory);
    bridge.captureActiveFilePlan = () => ({
      backend: "r",
      importOptions: { delimiter: ";" },
      isCurrent: () => current,
      createBridge: bind
    });
    const uri = vscode.Uri.file("/workspace/target.csv");
    fileMocks.showOpenDialog.mockImplementationOnce(async () => {
      if (outcome === "stale before") current = false;
      return outcome === "cancelled" ? undefined : [uri];
    });
    const opening = command("openWrangler.openFileWithPlan")();
    if (outcome === "cancelled" || outcome === "stale before") {
      await opening;
      expect(factory).not.toHaveBeenCalled();
    } else if (outcome === "factory failure") {
      await opening;
      expect(factory).toHaveBeenCalledOnce();
      expect(bind).not.toHaveBeenCalled();
      expect(fileMocks.showErrorMessage).toHaveBeenCalledWith("factory failed");
      expect(native.onIdle).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({ path: uri.fsPath, uri: uri.toString(), importOptions: { delimiter: ";" } }),
        bind
      );
      expect(bind).toHaveBeenCalledExactlyOnceWith(native);
      if (outcome === "stale after") current = false;
      if (outcome === "disposed") for (const subscription of context.subscriptions) subscription.dispose();
      if (outcome === "panel failure")
        fileMocks.createPanel.mockImplementationOnce(() => {
          throw new Error("panel failed");
        });
      finish();
      await opening;
    }
    if (outcome === "success") {
      expect(fileMocks.createPanel).toHaveBeenCalledExactlyOnceWith(
        context,
        targetBridge,
        expect.objectContaining({ path: uri.fsPath }),
        "r",
        "r",
        "editing"
      );
      expect(native.onIdle).not.toHaveBeenCalled();
    } else if (outcome === "stale after" || outcome === "disposed" || outcome === "panel failure") {
      expect(native.onIdle).toHaveBeenCalledOnce();
      expect(fileMocks.createPanel).toHaveBeenCalledTimes(outcome === "panel failure" ? 1 : 0);
    } else expect(fileMocks.createPanel).not.toHaveBeenCalled();
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
    expect(native.request).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "busy"])("explains a %s plan source before opening the picker", async (reason) => {
    const { bridge } = register();
    if (reason === "busy") {
      bridge.captureActiveFilePlan = () => ({
        kind: "error",
        code: "session_busy",
        message: "Wait for the current cleaning operation to finish before opening another file with this plan.",
        recoverable: true
      });
    }

    await command("openWrangler.openFileWithPlan")();

    expect(fileMocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
      reason === "busy"
        ? "Wait for the current cleaning operation to finish before opening another file with this plan."
        : "Open a file with a confirmed cleaning plan before using it on another file."
    );
    expect(fileMocks.showOpenDialog).not.toHaveBeenCalled();
    expect(fileMocks.stat).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "unsupported"])("does not open a plan target when its selection is %s", async (reason) => {
    const { bridge } = register();
    bridge.captureActiveFilePlan = () => ({
      backend: "polars",
      importOptions: undefined,
      isCurrent: () => true,
      createBridge: () => bridge
    });
    fileMocks.showOpenDialog.mockResolvedValueOnce(
      reason === "cancelled" ? undefined : [vscode.Uri.file("/workspace/private.pkl")]
    );

    await command("openWrangler.openFileWithPlan")();

    expect(fileMocks.createPanel).not.toHaveBeenCalled();
    expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
    expect(fileMocks.showWarningMessage).toHaveBeenCalledTimes(reason === "cancelled" ? 0 : 1);
  });

  it("explains when no configurable file panel is active", async () => {
    register();

    await command("openWrangler.changeImportOptions")();

    expect(fileMocks.changeActiveImportOptions).toHaveBeenCalledOnce();
    expect(fileMocks.showInformationMessage).toHaveBeenCalledWith(
      "Open a CSV, TSV, XLSX, or XLS session in Open Wrangler before changing import options."
    );
  });

  it("prefers the URI supplied by an editor or Explorer menu", async () => {
    const { context, bridge } = register();
    const menuUri = vscode.Uri.file("/workspace/menu.PARQUET");
    fileMocks.activeTextUri = vscode.Uri.file("/workspace/other.jsonl");

    await command("openWrangler.openFile")(menuUri);

    expect(fileMocks.stat).toHaveBeenCalledWith(menuUri);
    expect(fileMocks.createPanel).toHaveBeenCalledWith(
      context,
      bridge,
      {
        kind: "file",
        label: "menu.PARQUET",
        path: "/workspace/menu.PARQUET",
        uri: menuUri.toString(),
        importOptions: undefined
      },
      undefined,
      "auto"
    );
  });

  it("forwards an explicit configured backend as both the runtime pin and logical preference", async () => {
    const { context, bridge } = register();
    const menuUri = vscode.Uri.file("/workspace/menu.parquet");
    fileMocks.defaultBackend = "duckdb";

    await command("openWrangler.openFile")(menuUri);

    expect(fileMocks.createPanel).toHaveBeenCalledWith(
      context,
      bridge,
      expect.objectContaining({ uri: menuUri.toString() }),
      "duckdb",
      "duckdb"
    );
  });

  it("opens the selected CSV with the native R file owner when R is the default", async () => {
    const nativeBridge = { request: vi.fn() } as OpenWranglerBridge;
    const createRBridge = vi.fn(async () => nativeBridge);
    const { context } = register(createRBridge);
    const menuUri = vscode.Uri.file("/workspace/native.csv");
    fileMocks.defaultBackend = "r";
    fileMocks.detectImportOptions.mockResolvedValue({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    await command("openWrangler.openFile")(menuUri);

    expect(createRBridge).toHaveBeenCalledWith(
      expect.objectContaining({ path: menuUri.fsPath, uri: menuUri.toString() })
    );
    expect(fileMocks.createPanel).toHaveBeenCalledWith(
      context,
      nativeBridge,
      expect.objectContaining({ uri: menuUri.toString() }),
      "r",
      "r"
    );
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
  });

  it.each(["parquet", "jsonl", "ndjson"])(
    "opens native R %s without an absent import-options property",
    async (extension) => {
      const nativeBridge = { request: vi.fn() } as OpenWranglerBridge;
      const createRBridge = vi.fn(async (source: SessionSource) => {
        expect(isSessionSource(source)).toBe(true);
        expect(Object.hasOwn(source, "importOptions")).toBe(false);
        return nativeBridge;
      });
      const { context } = register(createRBridge);
      const uri = vscode.Uri.file(`/workspace/native.${extension}`);
      fileMocks.defaultBackend = "r";
      fileMocks.detectImportOptions.mockResolvedValue(undefined);
      await command("openWrangler.openFile")(uri);
      expect(createRBridge).toHaveBeenCalledOnce();
      expect(fileMocks.createPanel).toHaveBeenCalledWith(
        context,
        nativeBridge,
        {
          kind: "file",
          label: `native.${extension}`,
          path: uri.fsPath,
          uri: uri.toString()
        },
        "r",
        "r"
      );
      expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    "keeps explicit R engine handoff source-bound (owner remains current: %s)",
    async (remainsCurrent) => {
      let release!: (bridge: OpenWranglerBridge) => void;
      const held = new Promise<OpenWranglerBridge>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const nativeBridge = { request: vi.fn(), onIdle: vi.fn() };
      const createRBridge = vi.fn((_source: SessionSource) => {
        entered();
        return held;
      });
      const { context } = register(createRBridge);
      const source: SessionSource = {
        kind: "file",
        label: "original.csv",
        path: "/workspace/original.csv",
        uri: "file:///workspace/original.csv",
        importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: false }
      };
      const expected = structuredClone(source);
      let current = true;
      const opening = command("openWrangler.internal.openFileWithEngine")(source, "r", () => current);
      try {
        await started;
        source.path = "/workspace/later.csv";
        source.uri = "file:///workspace/later.csv";
        source.importOptions!.delimiter = ",";
        fileMocks.activeTextUri = vscode.Uri.file("/workspace/unrelated.csv");
        current = remainsCurrent;
        release(nativeBridge);
        await opening;
        expect(createRBridge).toHaveBeenCalledExactlyOnceWith(expected);
        expect(createRBridge.mock.calls[0]![0]).not.toBe(source);
        expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
        expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
        expect(nativeBridge.request).not.toHaveBeenCalled();
        if (remainsCurrent) {
          expect(fileMocks.createPanel).toHaveBeenCalledExactlyOnceWith(context, nativeBridge, expected, "r", "r");
          expect(nativeBridge.onIdle).not.toHaveBeenCalled();
        } else {
          expect(fileMocks.createPanel).not.toHaveBeenCalled();
          expect(nativeBridge.onIdle).toHaveBeenCalledOnce();
        }
        expect(fileMocks.showErrorMessage).not.toHaveBeenCalled();
      } finally {
        release(nativeBridge);
        await opening;
      }
    }
  );

  it.each([
    { kind: "file", label: "missing.csv", path: "/workspace/missing.csv" },
    { kind: "file", label: "relative.csv", path: "relative.csv", uri: "file:///workspace/relative.csv" },
    { kind: "file", label: "different.csv", path: "/workspace/different.csv", uri: "file:///workspace/other.csv" },
    {
      kind: "file",
      label: "remote.csv",
      path: "/workspace/remote.csv",
      uri: "vscode-remote://host/workspace/remote.csv"
    },
    {
      kind: "notebookVariable",
      label: "frame",
      variableName: "frame",
      path: "/workspace/frame.csv",
      uri: "file:///workspace/frame.csv"
    }
  ])("refuses an invalid explicit file-engine source $label before acquiring R", async (source) => {
    const createRBridge = vi.fn();
    register(createRBridge);
    await command("openWrangler.internal.openFileWithEngine")(source, "r", () => true);
    expect(createRBridge).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
    expect(fileMocks.stat).not.toHaveBeenCalled();
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
  });

  it("reports an unsupported R file instead of silently falling back to Python", async () => {
    const createRBridge = vi.fn(async () => {
      throw new Error("Native R requires CSV or TSV.");
    });
    register(createRBridge);
    const menuUri = vscode.Uri.file("/workspace/menu.parquet");
    fileMocks.defaultBackend = "r";

    await command("openWrangler.openFile")(menuUri);

    expect(fileMocks.createPanel).not.toHaveBeenCalled();
    expect(fileMocks.showErrorMessage).toHaveBeenCalledWith("Native R requires CSV or TSV.");
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
  });

  it("falls back to text, custom, and modified diff tab resources", async () => {
    const candidates = [
      new vscode.TabInputText(vscode.Uri.file("/workspace/text.jsonl")),
      new vscode.TabInputCustom(vscode.Uri.file("/workspace/custom.parquet"), "thirdParty.csvEditor"),
      new vscode.TabInputTextDiff(
        vscode.Uri.file("/workspace/original.csv"),
        vscode.Uri.file("/workspace/modified.jsonl")
      )
    ];

    for (const input of candidates) {
      fileMocks.activeTabInput = input;
      fileMocks.createPanel.mockClear();
      register();
      await command("openWrangler.openFile")();
      expect(fileMocks.createPanel).toHaveBeenCalledOnce();
    }
  });

  it("falls back to the active text editor when the active tab has no resource", async () => {
    const uri = vscode.Uri.file("/workspace/active.jsonl");
    fileMocks.activeTextUri = uri;
    register();

    await command("openWrangler.openFile")();

    expect(fileMocks.stat).toHaveBeenCalledWith(uri);
    expect(fileMocks.createPanel).toHaveBeenCalledOnce();
  });

  it("accepts uppercase files in a VS Code remote workspace", async () => {
    const uri = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+host",
      path: "/workspace/FRAME.CSV"
    });
    fileMocks.detectImportOptions.mockResolvedValue({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    register();

    await command("openWrangler.openFile")(uri);

    expect(fileMocks.createPanel).toHaveBeenCalledOnce();
    expect(fileMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("treats .ndjson as the exact JSONL launch and picker alias", async () => {
    const selected = vscode.Uri.file("/workspace/events.NDJSON");
    fileMocks.showOpenDialog.mockResolvedValueOnce([selected]);
    register();

    await command("openWrangler.openPath")();

    expect(fileMocks.showOpenDialog).toHaveBeenCalledWith({
      canSelectMany: false,
      filters: {
        "Data files": ["csv", "tsv", "parquet", "jsonl", "ndjson", "xlsx", "xls"]
      }
    });
    expect(fileMocks.stat).toHaveBeenCalledWith(selected);
    expect(fileMocks.detectImportOptions).toHaveBeenCalledWith(selected);
    expect(fileMocks.createPanel).toHaveBeenCalledOnce();
    expect(fileMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("uses the manifest defaults when the file-type setting is not an array", async () => {
    fileMocks.enabledFileTypes = "csv";
    register();

    await command("openWrangler.openPath")();

    expect(fileMocks.showOpenDialog).toHaveBeenCalledWith({
      canSelectMany: false,
      filters: {
        "Data files": ["csv", "tsv", "parquet", "jsonl", "ndjson", "xlsx", "xls"]
      }
    });
  });

  it("keeps only manifest file types from a manually edited array", async () => {
    fileMocks.enabledFileTypes = ["parquet", "ndjson", 7, "jsonl", null, "csv", {}, "xlsx"];
    register();

    await command("openWrangler.openPath")();

    expect(fileMocks.showOpenDialog).toHaveBeenCalledWith({
      canSelectMany: false,
      filters: {
        "Data files": ["parquet", "jsonl", "ndjson", "csv", "xlsx"]
      }
    });
  });

  it("preserves an empty file-type array as an intentional disable-all setting", async () => {
    fileMocks.enabledFileTypes = [];
    register();

    await command("openWrangler.openPath")();

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(
      "Enable at least one Open Wrangler file type in Settings."
    );
    expect(fileMocks.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each(["pkl", "pickle"])("never offers or accepts Python pickle files (%s)", async (extension) => {
    const selected = vscode.Uri.file(`/workspace/untrusted.${extension}`);
    fileMocks.showOpenDialog.mockResolvedValueOnce([selected]);
    register();

    await command("openWrangler.openFile")(selected);

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/supports CSV/i));
    expect(fileMocks.stat).not.toHaveBeenCalled();
    expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();

    await command("openWrangler.openPath")();
    const pickerExtensions = fileMocks.showOpenDialog.mock.calls[0]?.[0]?.filters?.["Data files"];
    expect(pickerExtensions).not.toContain(extension);
  });

  it.each([
    ["untitled", vscode.Uri.from({ scheme: "untitled", path: "Untitled-1.csv" }), /save this data file/i],
    ["virtual", vscode.Uri.from({ scheme: "git", path: "/workspace/data.csv" }), /local files/i],
    ["unsupported", vscode.Uri.file("/workspace/notes.txt"), /supports CSV/i]
  ])("rejects %s resources before filesystem access", async (_case, uri, warning) => {
    register();

    await command("openWrangler.openFile")(uri);

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(warning));
    expect(fileMocks.stat).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("distinguishes a supported but disabled file type", async () => {
    fileMocks.enabledFileTypes = ["csv"];
    register();

    await command("openWrangler.openFile")(vscode.Uri.file("/workspace/data.parquet"));

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(".parquet is disabled in Open Wrangler settings.");
    expect(fileMocks.stat).not.toHaveBeenCalled();
  });

  it("disables .ndjson whenever the single JSONL setting is disabled", async () => {
    fileMocks.enabledFileTypes = ["csv"];
    register();

    await command("openWrangler.openFile")(vscode.Uri.file("/workspace/data.ndjson"));

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(".ndjson is disabled in Open Wrangler settings.");
    expect(fileMocks.stat).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("rejects directories and inaccessible resources without starting a runtime", async () => {
    register();
    const directory = vscode.Uri.file("/workspace/data.csv");
    fileMocks.stat.mockResolvedValueOnce({ type: vscode.FileType.Directory });

    await command("openWrangler.openFile")(directory);

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith("Choose a data file, not a folder.");
    expect(fileMocks.createPanel).not.toHaveBeenCalled();

    fileMocks.stat.mockRejectedValueOnce(new Error("missing"));
    await command("openWrangler.openFile")(vscode.Uri.file("/workspace/missing.csv"));
    expect(fileMocks.showErrorMessage).toHaveBeenCalledWith(
      "Open Wrangler could not access file:///workspace/missing.csv."
    );
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("rejects unknown and special filesystem nodes before starting a runtime", async () => {
    register();
    fileMocks.stat.mockResolvedValueOnce({ type: vscode.FileType.Unknown });

    await command("openWrangler.openFile")(vscode.Uri.file("/workspace/pipe.csv"));

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(
      "Choose a regular data file, not a special filesystem resource."
    );
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("opens the file picker when no usable editor resource exists", async () => {
    fileMocks.activeTabInput = new vscode.TabInputCustom(
      vscode.Uri.file("/workspace/already.csv"),
      "openWrangler.viewer"
    );
    register();

    await command("openWrangler.openFile")();

    expect(fileMocks.executeCommand).toHaveBeenCalledWith("openWrangler.openPath");
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("validates a picker result even when the native dialog returns a disallowed file", async () => {
    const selected = vscode.Uri.file("/workspace/notes.txt");
    fileMocks.showOpenDialog.mockResolvedValueOnce([selected]);
    register();

    await command("openWrangler.openPath")();

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/supports CSV/i));
    expect(fileMocks.stat).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("opens a validated picker result", async () => {
    const selected = vscode.Uri.file("/workspace/data.csv");
    fileMocks.showOpenDialog.mockResolvedValueOnce([selected]);
    const { context, bridge } = register();

    await command("openWrangler.openPath")();

    expect(fileMocks.stat).toHaveBeenCalledWith(selected);
    expect(fileMocks.createPanel).toHaveBeenCalledWith(
      context,
      bridge,
      expect.objectContaining({ path: "/workspace/data.csv" }),
      undefined,
      "auto"
    );
  });

  it("opens a fresh Auto file with R only after Python preflight confirms no compatible engine", async () => {
    const native = { request: vi.fn(), onIdle: vi.fn() };
    const createR = vi.fn(async () => native);
    const { context, bridge } = register(createR);
    bridge.prepareFileAutoFallback = vi.fn(async () => ({
      isCurrent: () => true
    }));

    await command("openWrangler.openFile")(vscode.Uri.file("/workspace/data.csv"));

    expect(bridge.prepareFileAutoFallback).toHaveBeenCalledOnce();
    expect(createR).toHaveBeenCalledWith(expect.objectContaining({ path: "/workspace/data.csv" }));
    expect(fileMocks.createPanel).toHaveBeenCalledWith(
      context,
      native,
      expect.objectContaining({ path: "/workspace/data.csv" }),
      "r",
      "auto"
    );
    expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
    expect(native.onIdle).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps Python selection, repair errors and explicit pins out of R fallback (guarded: %s)",
    async (guarded) => {
      const createR = vi.fn();
      const { bridge } = register(createR);
      bridge.prepareFileAutoFallback = vi.fn(async () =>
        guarded
          ? {
              kind: "error" as const,
              code: "dependency_environment_uncertain",
              message: "Revalidate this Python environment",
              recoverable: true
            }
          : undefined
      );
      await command("openWrangler.openFile")(vscode.Uri.file("/workspace/data.csv"));
      expect(bridge.prepareFileAutoFallback).toHaveBeenCalledOnce();
      expect(createR).not.toHaveBeenCalled();
      expect(fileMocks.createPanel.mock.calls[0]?.[1]).toBe(bridge);
      fileMocks.bridgeRequest.mockResolvedValueOnce({
        kind: "error",
        code: "file_read_failed",
        message: "Invalid CSV",
        recoverable: true
      });
      await expect(
        bridge.request({
          kind: "openSession",
          source: fileMocks.createPanel.mock.calls[0]?.[2],
          pageSize: 1,
          columnOffset: 0,
          columnLimit: 1
        })
      ).resolves.toMatchObject({ code: "file_read_failed" });
      expect(createR).not.toHaveBeenCalled();
      fileMocks.defaultBackend = "pandas";
      await command("openWrangler.openFile")(vscode.Uri.file("/workspace/pinned.csv"));
      expect(bridge.prepareFileAutoFallback).toHaveBeenCalledOnce();
      expect(createR).not.toHaveBeenCalled();
      expect(fileMocks.createPanel.mock.calls.at(-1)?.[3]).toBe("pandas");
    }
  );

  it("releases Auto's unhanded R delegate when its Python selection changes during acquisition", async () => {
    let finish!: (bridge: OpenWranglerBridge) => void;
    const native = { request: vi.fn(), onIdle: vi.fn() };
    const createR = vi.fn(
      () =>
        new Promise<OpenWranglerBridge>((resolve) => {
          finish = resolve;
        })
    );
    const { bridge } = register(createR);
    let current = true;
    bridge.prepareFileAutoFallback = vi.fn(async () => ({ isCurrent: () => current }));
    const opening = command("openWrangler.openFile")(vscode.Uri.file("/workspace/data.csv"));
    await vi.waitFor(() => expect(createR).toHaveBeenCalledOnce());
    current = false;
    finish(native);
    await opening;
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
    expect(native.onIdle).toHaveBeenCalledOnce();
  });

  it("does not probe Python again when recreating an Auto file already confirmed with R", async () => {
    const uri = vscode.Uri.file("/workspace/data.csv");
    const native = { request: vi.fn(), onIdle: vi.fn() };
    const { bridge } = register(vi.fn(async () => native));
    bridge.prepareFileAutoFallback = vi.fn();
    fileMocks.workspaceValues.set(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [
        {
          uri: uri.toString(),
          backend: "r",
          backendPreference: "auto",
          importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
        }
      ]
    });
    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, { dispose: vi.fn() }, resolutionToken());
    expect(bridge.prepareFileAutoFallback).not.toHaveBeenCalled();
    expect(fileMocks.panelConstructor.mock.calls[0]?.slice(2, 7)).toEqual([
      native,
      expect.objectContaining({ path: "/workspace/data.csv" }),
      "r",
      true,
      "auto"
    ]);
  });

  it.each([true, false])(
    "preserves Python repair UI only for expected R absence (unavailable: %s)",
    async (unavailable) => {
      const failure = unavailable
        ? new FileBackendUnavailableError("Set Open Wrangler: Rscript Path to an installed Rscript executable.")
        : new Error("Native bridge construction failed");
      const { context, bridge } = register(
        vi.fn(async () => {
          throw failure;
        })
      );
      bridge.prepareFileAutoFallback = vi.fn(async () => ({
        isCurrent: () => true
      }));
      await command("openWrangler.openFile")(vscode.Uri.file("/workspace/data.csv"));
      if (unavailable) {
        expect(fileMocks.showErrorMessage).not.toHaveBeenCalled();
        expect(fileMocks.createPanel).toHaveBeenCalledWith(
          context,
          bridge,
          expect.objectContaining({ path: "/workspace/data.csv" }),
          undefined,
          "auto"
        );
      } else {
        expect(fileMocks.showErrorMessage).toHaveBeenCalledWith(failure.message);
        expect(fileMocks.createPanel).not.toHaveBeenCalled();
      }
    }
  );

  it("releases a fresh Auto custom editor's R owner when cancelled during factory acquisition", async () => {
    const token = resolutionToken();
    const native = { request: vi.fn(), onIdle: vi.fn() };
    const { bridge } = register(
      vi.fn(async () => {
        token.isCancellationRequested = true;
        return native;
      })
    );
    bridge.prepareFileAutoFallback = vi.fn(async () => ({ isCurrent: () => true }));
    const panel = { dispose: vi.fn() };
    await fileMocks.customEditorProvider?.resolveCustomEditor(
      { uri: vscode.Uri.file("/workspace/data.csv") },
      panel,
      token
    );
    expect(native.onIdle).toHaveBeenCalledOnce();
    expect(fileMocks.panelConstructor).not.toHaveBeenCalled();
    expect(panel.dispose).not.toHaveBeenCalled();
  });

  it("rejects a virtual custom-editor resource before constructing its panel", async () => {
    const panel = { dispose: vi.fn() };
    register();

    await fileMocks.customEditorProvider?.resolveCustomEditor(
      { uri: vscode.Uri.from({ scheme: "git", path: "/workspace/data.csv" }) },
      panel,
      resolutionToken()
    );

    expect(panel.dispose).toHaveBeenCalledOnce();
    expect(fileMocks.panelConstructor).not.toHaveBeenCalled();
    expect(fileMocks.stat).not.toHaveBeenCalled();
  });

  it("validates a supported custom-editor resource before constructing its panel", async () => {
    const uri = vscode.Uri.file("/workspace/data.csv");
    const panel = { dispose: vi.fn() };
    const { context, bridge } = register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel, resolutionToken());

    expect(fileMocks.stat).toHaveBeenCalledWith(uri);
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(fileMocks.panelConstructor).toHaveBeenCalledWith(
      panel,
      context,
      bridge,
      expect.objectContaining({ path: "/workspace/data.csv" }),
      undefined,
      true,
      "auto"
    );
  });

  it("pins a previously auto-resolved Pandas session after the configured default changes", async () => {
    const uri = vscode.Uri.file("/workspace/data.csv");
    const panel = { dispose: vi.fn() };
    const importOptions = {
      delimiter: ";",
      encoding: "windows-1252",
      quoteChar: "'",
      hasHeader: false,
      lineEnding: "cr"
    };
    fileMocks.workspaceValues.set(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [{ uri: uri.toString(), backend: "pandas", backendPreference: "auto", importOptions }]
    });
    fileMocks.defaultBackend = "polars";
    const { context, bridge } = register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel, resolutionToken());

    expect(fileMocks.panelConstructor).toHaveBeenCalledWith(
      panel,
      context,
      bridge,
      expect.objectContaining({
        path: "/workspace/data.csv",
        uri: uri.toString(),
        importOptions
      }),
      "pandas",
      true,
      "auto"
    );
    expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps remembered R custom-editor ownership across factory acquisition (cancelled: %s)",
    async (cancelled) => {
      const uri = vscode.Uri.file("/workspace/remembered.tsv");
      const importOptions = { delimiter: "\t", encoding: "utf-8", quoteChar: '"', hasHeader: true };
      fileMocks.workspaceValues.set(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
        version: 2,
        entries: [{ uri: uri.toString(), backend: "r", backendPreference: "r", importOptions }]
      });
      fileMocks.defaultBackend = "polars";
      const nativeBridge = { request: vi.fn(), onIdle: vi.fn() };
      let release!: (bridge: OpenWranglerBridge) => void;
      const held = new Promise<OpenWranglerBridge>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const createRBridge = vi.fn((_source: SessionSource) => {
        entered();
        return held;
      });
      const { context } = register(createRBridge);
      const panel = { dispose: vi.fn() };
      const token = resolutionToken();
      const opening = fileMocks.customEditorProvider!.resolveCustomEditor({ uri }, panel, token);
      try {
        await started;
        token.isCancellationRequested = cancelled;
        fileMocks.defaultBackend = "pandas";
        fileMocks.activeTextUri = vscode.Uri.file("/workspace/unrelated.csv");
        release(nativeBridge);
        await opening;
        const source = { kind: "file", label: "remembered.tsv", path: uri.fsPath, uri: uri.toString(), importOptions };
        expect(createRBridge).toHaveBeenCalledExactlyOnceWith(source);
        if (cancelled) {
          expect(fileMocks.panelConstructor).not.toHaveBeenCalled();
          expect(nativeBridge.onIdle).toHaveBeenCalledOnce();
        } else {
          expect(fileMocks.panelConstructor).toHaveBeenCalledExactlyOnceWith(
            panel,
            context,
            nativeBridge,
            source,
            "r",
            true,
            "r"
          );
          expect(nativeBridge.onIdle).not.toHaveBeenCalled();
        }
        expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
        expect(fileMocks.bridgeRequest).not.toHaveBeenCalled();
        expect(nativeBridge.request).not.toHaveBeenCalled();
        expect(panel.dispose).not.toHaveBeenCalled();
        expect(fileMocks.showErrorMessage).not.toHaveBeenCalled();
      } finally {
        release(nativeBridge);
        await opening;
      }
    }
  );

  it("keeps an explicit confirmed Parquet preference pinned without adding import options", async () => {
    const uri = vscode.Uri.file("/workspace/data.parquet");
    const panel = { dispose: vi.fn() };
    fileMocks.workspaceValues.set(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [{ uri: uri.toString(), backend: "duckdb", backendPreference: "duckdb" }]
    });
    fileMocks.defaultBackend = "polars";
    const { context, bridge } = register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel, resolutionToken());

    expect(fileMocks.panelConstructor).toHaveBeenCalledWith(
      panel,
      context,
      bridge,
      expect.objectContaining({
        path: "/workspace/data.parquet",
        uri: uri.toString()
      }),
      "duckdb",
      true,
      "duckdb"
    );
    expect(fileMocks.panelConstructor.mock.calls[0]?.[3]).not.toHaveProperty("importOptions");
  });

  it("keeps explicit custom-editor selection available for a picker-disabled format", async () => {
    const uri = vscode.Uri.file("/workspace/data.parquet");
    const panel = { dispose: vi.fn() };
    fileMocks.enabledFileTypes = ["csv"];
    register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel, resolutionToken());

    expect(fileMocks.stat).toHaveBeenCalledWith(uri);
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(fileMocks.panelConstructor).toHaveBeenCalledOnce();
    expect(fileMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it.each(["before validation", "during validation", "during detection"])(
    "abandons a custom editor cancelled %s without constructing or disposing its panel",
    async (phase) => {
      const token = resolutionToken(phase === "before validation");
      fileMocks.stat.mockImplementationOnce(async () => {
        if (phase === "during validation") token.isCancellationRequested = true;
        return { type: vscode.FileType.File };
      });
      fileMocks.detectImportOptions.mockImplementationOnce(async () => {
        if (phase === "during detection") token.isCancellationRequested = true;
        return undefined;
      });
      const panel = { dispose: vi.fn() };
      register();

      await fileMocks.customEditorProvider?.resolveCustomEditor(
        { uri: vscode.Uri.file("/workspace/data.csv") },
        panel,
        token
      );

      expect(fileMocks.panelConstructor).not.toHaveBeenCalled();
      expect(panel.dispose).not.toHaveBeenCalled();
      expect(fileMocks.showWarningMessage).not.toHaveBeenCalled();
      expect(fileMocks.showErrorMessage).not.toHaveBeenCalled();
      if (phase === "before validation") expect(fileMocks.stat).not.toHaveBeenCalled();
      if (phase !== "during detection") expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
    }
  );

  it.each(["directory", "special file", "inaccessible"])(
    "does not report or dispose a cancelled custom editor after %s validation fails",
    async (failure) => {
      const token = resolutionToken();
      fileMocks.stat.mockImplementationOnce(async () => {
        token.isCancellationRequested = true;
        if (failure === "inaccessible") throw new Error("Source is unavailable");
        return { type: failure === "directory" ? vscode.FileType.Directory : 0 };
      });
      const panel = { dispose: vi.fn() };
      register();

      await fileMocks.customEditorProvider?.resolveCustomEditor(
        { uri: vscode.Uri.file("/workspace/data.csv") },
        panel,
        token
      );

      expect(fileMocks.showWarningMessage).not.toHaveBeenCalled();
      expect(fileMocks.showErrorMessage).not.toHaveBeenCalled();
      expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
      expect(fileMocks.panelConstructor).not.toHaveBeenCalled();
      expect(panel.dispose).not.toHaveBeenCalled();
    }
  );
});

function resolutionToken(cancelled = false) {
  return { isCancellationRequested: cancelled, onCancellationRequested: () => ({ dispose: () => undefined }) };
}

function register(createRBridge?: RFileBridgeFactory): {
  context: ExtensionContext;
  bridge: OpenWranglerBridge;
} {
  const context = {
    extensionPath: "/tmp/openwrangler",
    subscriptions: [],
    workspaceState: {
      get: <T>(key: string, fallback?: T): T | undefined =>
        (fileMocks.workspaceValues.has(key) ? fileMocks.workspaceValues.get(key) : fallback) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        fileMocks.workspaceValues.set(key, value);
      }
    }
  } as unknown as ExtensionContext;
  const bridge = {
    request: fileMocks.bridgeRequest,
    discoverDuckDBTables: fileMocks.discoverTables
  } as OpenWranglerBridge;
  registerFileCommands(context, bridge, createRBridge);
  fileMocks.customEditorProvider = new OpenWranglerCustomEditorProvider(context, bridge, createRBridge);
  return { context, bridge };
}

function command(id: string): CommandHandler {
  const handler = fileMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}
