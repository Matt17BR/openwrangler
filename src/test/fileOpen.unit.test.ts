import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";

type CommandHandler = (...args: unknown[]) => unknown;

const fileMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async () => undefined),
  createPanel: vi.fn(),
  panelConstructor: vi.fn(),
  changeActiveImportOptions: vi.fn(async () => false),
  detectImportOptions: vi.fn<(uri: unknown) => Promise<unknown>>(async () => undefined),
  bridgeRequest: vi.fn(async () => {
    throw new Error("Unsupported files must not start Python.");
  }),
  stat: vi.fn(async () => ({ type: 1 })),
  showWarningMessage: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showOpenDialog: vi.fn<
    (options?: { filters?: Record<string, string[]>; canSelectMany?: boolean }) => Promise<unknown>
  >(async () => undefined),
  customEditorProvider: undefined as
    | {
        resolveCustomEditor(document: { uri: unknown }, panel: { dispose(): void }): Promise<void>;
      }
    | undefined,
  customEditorProviderOptions: undefined as unknown,
  activeTabInput: undefined as unknown,
  activeTextUri: undefined as unknown,
  enabledFileTypes: ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"],
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
  return {
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
      registerCustomEditorProvider: (
        _id: string,
        provider: typeof fileMocks.customEditorProvider,
        options: unknown
      ) => {
        fileMocks.customEditorProvider = provider;
        fileMocks.customEditorProviderOptions = options;
        return disposable();
      },
      showWarningMessage: fileMocks.showWarningMessage,
      showInformationMessage: fileMocks.showInformationMessage,
      showErrorMessage: fileMocks.showErrorMessage,
      showOpenDialog: fileMocks.showOpenDialog
    },
    workspace: {
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

vi.mock("../extension/configuration", () => ({
  getSetting: <T>(key: string, fallback: T): T =>
    (key === "enabledFileTypes"
      ? fileMocks.enabledFileTypes
      : key === "defaultBackend"
        ? fileMocks.defaultBackend
        : fallback) as T
}));

import { registerFileCommands } from "../extension/files/fileOpen";
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
    fileMocks.customEditorProviderOptions = undefined;
    fileMocks.activeTabInput = undefined;
    fileMocks.activeTextUri = undefined;
    fileMocks.enabledFileTypes = ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"];
    fileMocks.defaultBackend = "auto";
    fileMocks.workspaceValues.clear();
  });

  it("delegates the change-import-options command to the active configurable panel", async () => {
    fileMocks.changeActiveImportOptions.mockResolvedValueOnce(true);
    register();

    await command("openWrangler.changeImportOptions")();

    expect(fileMocks.changeActiveImportOptions).toHaveBeenCalledOnce();
    expect(fileMocks.showInformationMessage).not.toHaveBeenCalled();
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

  it("ignores an R backend value manually written into file settings", async () => {
    const { context, bridge } = register();
    const menuUri = vscode.Uri.file("/workspace/menu.parquet");
    fileMocks.defaultBackend = "r";

    await command("openWrangler.openFile")(menuUri);

    expect(fileMocks.createPanel).toHaveBeenCalledWith(
      context,
      bridge,
      expect.objectContaining({ uri: menuUri.toString() }),
      undefined,
      "auto"
    );
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

  it("rejects a virtual custom-editor resource before constructing its panel", async () => {
    const panel = { dispose: vi.fn() };
    register();

    await fileMocks.customEditorProvider?.resolveCustomEditor(
      { uri: vscode.Uri.from({ scheme: "git", path: "/workspace/data.csv" }) },
      panel
    );

    expect(panel.dispose).toHaveBeenCalledOnce();
    expect(fileMocks.panelConstructor).not.toHaveBeenCalled();
    expect(fileMocks.stat).not.toHaveBeenCalled();
  });

  it("validates a supported custom-editor resource before constructing its panel", async () => {
    const uri = vscode.Uri.file("/workspace/data.csv");
    const panel = { dispose: vi.fn() };
    const { context, bridge } = register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel);

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
      hasHeader: false
    };
    fileMocks.workspaceValues.set(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [{ uri: uri.toString(), backend: "pandas", backendPreference: "auto", importOptions }]
    });
    fileMocks.defaultBackend = "polars";
    const { context, bridge } = register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel);

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
    expect(fileMocks.customEditorProviderOptions).toMatchObject({
      supportsMultipleEditorsPerDocument: false
    });
    expect(fileMocks.detectImportOptions).not.toHaveBeenCalled();
  });

  it("keeps an explicit confirmed Parquet preference pinned without adding import options", async () => {
    const uri = vscode.Uri.file("/workspace/data.parquet");
    const panel = { dispose: vi.fn() };
    fileMocks.workspaceValues.set(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [{ uri: uri.toString(), backend: "duckdb", backendPreference: "duckdb" }]
    });
    fileMocks.defaultBackend = "polars";
    const { context, bridge } = register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel);

    expect(fileMocks.panelConstructor).toHaveBeenCalledWith(
      panel,
      context,
      bridge,
      expect.objectContaining({
        path: "/workspace/data.parquet",
        uri: uri.toString(),
        importOptions: undefined
      }),
      "duckdb",
      true,
      "duckdb"
    );
  });

  it("keeps explicit custom-editor selection available for a picker-disabled format", async () => {
    const uri = vscode.Uri.file("/workspace/data.parquet");
    const panel = { dispose: vi.fn() };
    fileMocks.enabledFileTypes = ["csv"];
    register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel);

    expect(fileMocks.stat).toHaveBeenCalledWith(uri);
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(fileMocks.panelConstructor).toHaveBeenCalledOnce();
    expect(fileMocks.showWarningMessage).not.toHaveBeenCalled();
  });
});

function register(): { context: ExtensionContext; bridge: OpenWranglerBridge } {
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
  const bridge = { request: fileMocks.bridgeRequest } as OpenWranglerBridge;
  registerFileCommands(context, bridge);
  return { context, bridge };
}

function command(id: string): CommandHandler {
  const handler = fileMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}
