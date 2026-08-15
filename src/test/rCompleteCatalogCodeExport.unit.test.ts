import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RKernelBridgeTransport } from "../extension/r/rKernelBridge";
import type { ActiveSessionSnapshot, SessionCoordinator } from "../extension/sessionCoordinator";
import type { OperationKind } from "../shared/protocol";
import { operationCatalog } from "../shared/operations";

type CommandHandler = (...args: unknown[]) => unknown;

const nativeMocks = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(async () => undefined),
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showSaveDialog: vi.fn(async () => undefined as unknown),
  workspaceTrusted: true
}));

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => unknown>();
    readonly event = (listener: (event: T) => unknown) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void {
      for (const listener of this.listeners) listener(event);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  class TreeItem {
    constructor(
      readonly label: string,
      readonly collapsibleState: number
    ) {}
  }

  class ThemeIcon {
    constructor(readonly id: string) {}
  }

  class Uri {
    private constructor(
      readonly fsPath: string,
      readonly scheme: string,
      readonly authority = ""
    ) {}
    static file(filePath: string): Uri {
      return new Uri(filePath, "file");
    }
    static parse(value: string): Uri {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)/u.exec(value);
      return new Uri(match?.[3] ?? value, match?.[1] ?? "file", match?.[2] ?? "");
    }
    static joinPath(base: Uri, ...parts: string[]): Uri {
      const segments: string[] = [];
      for (const segment of [base.fsPath, ...parts].join("/").split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
      }
      return new Uri(`/${segments.join("/")}`, base.scheme, base.authority);
    }
    toString(): string {
      return `${this.scheme}://${this.authority}${this.fsPath}`;
    }
  }

  const disposable = () => ({ dispose: () => undefined });
  return {
    EventEmitter,
    ProgressLocation: { Notification: 15 },
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState: { None: 0 },
    Uri,
    ViewColumn: { Active: 1 },
    commands: {
      executeCommand: nativeMocks.executeCommand,
      registerCommand: (id: string, handler: CommandHandler) => {
        nativeMocks.commands.set(id, handler);
        return disposable();
      }
    },
    env: {
      clipboard: { writeText: nativeMocks.clipboardWriteText },
      openExternal: vi.fn(async () => true)
    },
    version: "test",
    window: {
      activeNotebookEditor: undefined,
      registerTreeDataProvider: vi.fn(() => disposable()),
      registerWebviewViewProvider: vi.fn(() => disposable()),
      showErrorMessage: nativeMocks.showErrorMessage,
      showInformationMessage: nativeMocks.showInformationMessage,
      showQuickPick: vi.fn(async () => undefined),
      showSaveDialog: nativeMocks.showSaveDialog,
      showWarningMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options: unknown, task: () => Promise<unknown>) => task())
    },
    workspace: {
      get isTrusted(): boolean {
        return nativeMocks.workspaceTrusted;
      },
      notebookDocuments: [],
      workspaceFolders: [],
      getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
      fs: {}
    }
  };
});

vi.mock("../extension/webviewPanel", () => ({
  SESSION_BOUND_EXPORT_DATA_COMMAND: "openWrangler.internal.exportSessionData",
  OpenWranglerPanel: {
    sendEditorAction: vi.fn(() => true),
    sendEditorActionForSession: vi.fn(async () => true)
  }
}));
vi.mock("../extension/notebooks/notebookInsertion", () => ({
  insertGeneratedNotebookCell: vi.fn(async () => ({ status: "applied" }))
}));
vi.mock("../extension/r/rDocumentInsertion", () => ({
  insertGeneratedRDocumentCode: vi.fn(async () => ({ status: "applied" }))
}));
vi.mock("../extension/configuration", () => ({
  getSetting: <T>(_key: string, fallback: T): T => fallback
}));

import * as vscode from "vscode";
import { registerNativeViews } from "../extension/nativeViews";
import { RKernelBridge } from "../extension/r/rKernelBridge";

const EXPECTED_NATIVE_R_OPERATIONS = Object.freeze([
  "sortRows",
  "filterRows",
  "dropMissingRows",
  "fillMissingValues",
  "dropDuplicates",
  "selectColumns",
  "dropColumns",
  "renameColumn",
  "cloneColumn",
  "castColumn",
  "formula",
  "textLength",
  "oneHotEncode",
  "multiLabelBinarize",
  "findReplace",
  "stripText",
  "splitText",
  "capitalizeText",
  "lowerText",
  "upperText",
  "minMaxScale",
  "roundNumber",
  "floorNumber",
  "ceilNumber",
  "formatDatetime",
  "groupBy",
  "byExample",
  "customCode"
] satisfies readonly OperationKind[]);

const temporaryDirectories: string[] = [];

describe("complete native R generated-code export catalog", () => {
  afterEach(async () => {
    nativeMocks.clipboardWriteText.mockClear();
    nativeMocks.commands.clear();
    nativeMocks.executeCommand.mockClear();
    nativeMocks.showErrorMessage.mockClear();
    nativeMocks.showInformationMessage.mockClear();
    nativeMocks.showSaveDialog.mockReset();
    nativeMocks.workspaceTrusted = true;
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it("binds the exact stable ordering to the R contract, native bridge, and public operation catalog", async () => {
    const operations = await advertisedNativeROperations();

    expect(operations).toEqual(EXPECTED_NATIVE_R_OPERATIONS);
    expect(operationCatalog.map(({ kind }) => kind)).toEqual(EXPECTED_NATIVE_R_OPERATIONS);
    await expect(catalogKindsFromDirectRContract()).resolves.toEqual(EXPECTED_NATIVE_R_OPERATIONS);
    expect(new Set(operations).size).toBe(28);
  });

  it("copies and atomically saves each operation's exact executable export buffer", async () => {
    const operations = await advertisedNativeROperations();
    expect(operations).toEqual(EXPECTED_NATIVE_R_OPERATIONS);

    // The direct R complete-catalog contract owns production generation and execution. Generic TypeScript CI does not
    // provision R, so this complementary host test gives every catalog entry a distinct executable buffer and proves
    // that the editable Code Preview, clipboard command, Save dialog, and atomic writer preserve its exact bytes.
    const directory = await mkdtemp(path.join(tmpdir(), "ow-r-catalog-export-"));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, "catalog.R");
    await writeFile(sourcePath, "catalog <- base::data.frame(value = 1L)\n", "utf8");
    const snapshot = rSnapshot(sourcePath, operations);
    const controller = registerNativeViews(extensionContext(), coordinatorFor(snapshot));
    const copyCode = command("openWrangler.copyCode");
    const exportCode = command("openWrangler.exportCode");
    const exportedFiles: string[] = [];

    for (const [index, kind] of operations.entries()) {
      const code = operationLabelledR(kind, index, operations.length);
      const fileName = `${String(index + 1).padStart(2, "0")}-${kind}.clean.R`;
      const destination = path.join(directory, fileName);
      controller.setCodeForExport(code);

      await expect(copyCode()).resolves.toBe(code);
      expect(nativeMocks.clipboardWriteText).toHaveBeenNthCalledWith(index + 1, code);

      nativeMocks.showSaveDialog.mockResolvedValueOnce(vscode.Uri.file(destination));
      await expect(exportCode()).resolves.toBe(true);
      await expect(readFile(destination, "utf8")).resolves.toBe(code);
      exportedFiles.push(fileName);
    }

    expect(exportedFiles).toEqual(
      EXPECTED_NATIVE_R_OPERATIONS.map((kind, index) => `${String(index + 1).padStart(2, "0")}-${kind}.clean.R`)
    );
    expect(nativeMocks.clipboardWriteText).toHaveBeenCalledTimes(28);
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledTimes(28);
    const saveDialogCalls = nativeMocks.showSaveDialog.mock.calls as unknown[][];
    for (const [options] of saveDialogCalls) {
      expect(options).toEqual({
        title: "Export Open Wrangler R Code",
        defaultUri: expect.objectContaining({ fsPath: path.join(directory, "catalog.clean.R") }),
        filters: { "R script": ["R", "r"] },
        saveLabel: "Export code"
      });
    }
    expect((await readdir(directory)).sort()).toEqual(["catalog.R", ...exportedFiles].sort());
    expect(nativeMocks.showErrorMessage).not.toHaveBeenCalled();
  });
});

async function advertisedNativeROperations(): Promise<readonly OperationKind[]> {
  const transport = inertTransport();
  const bridge = new RKernelBridge(extensionContext(), transport);
  try {
    const response = await bridge.request({ kind: "initialize" });
    if (response.kind !== "initialized") throw new Error("Native R bridge did not initialize.");
    return response.capabilities.supportedOperations ?? [];
  } finally {
    await bridge.dispose();
  }
}

async function catalogKindsFromDirectRContract(): Promise<readonly string[]> {
  const source = await readFile(path.resolve("r/tests/complete_catalog_contract.R"), "utf8");
  const matches = [...source.matchAll(/^catalog_kinds <- c\((?<body>[\s\S]*?)^\)$/gmu)];
  if (matches.length !== 1) throw new Error("Expected one exact catalog_kinds vector in the direct R contract.");
  const body = matches[0]?.groups?.body ?? "";
  const kinds = [...body.matchAll(/"(?<kind>[A-Za-z][A-Za-z0-9]*)"/gu)].map((match) => match.groups?.kind ?? "");
  const unparsed = body.replace(/"[A-Za-z][A-Za-z0-9]*"/gu, "").replace(/[\s,]/gu, "");
  if (unparsed.length > 0 || kinds.some((kind) => kind.length === 0)) {
    throw new Error("The direct R catalog_kinds vector contains an unreviewed expression.");
  }
  return kinds;
}

function operationLabelledR(kind: OperationKind, index: number, total: number): string {
  const quotedKind = JSON.stringify(kind);
  return [
    `# Open Wrangler R export catalog receipt ${String(index + 1).padStart(2, "0")}/${total}: ${kind}`,
    "open_wrangler_result <- base::local({",
    `  .ow_operation <- ${quotedKind}`,
    `  base::stopifnot(base::identical(.ow_operation, ${quotedKind}))`,
    "  base::data.frame(operation = .ow_operation, stringsAsFactors = FALSE, check.names = FALSE)",
    "})",
    ""
  ].join("\n");
}

function inertTransport(): RKernelBridgeTransport {
  const invalidation = new vscode.EventEmitter<void>();
  const unexpected = async (): Promise<never> => {
    throw new Error("The catalog capability test must not dispatch an R session request.");
  };
  return {
    onDidInvalidateKernel: invalidation.event,
    open: unexpected,
    getPage: unexpected,
    getSummary: unexpected,
    getDatasetStats: unexpected,
    getColumnValues: unexpected,
    previewStep: unexpected,
    applyDraft: unexpected,
    discardDraft: unexpected,
    undoStep: unexpected,
    inspectStep: unexpected,
    close: vi.fn(async () => undefined),
    isSessionMapped: vi.fn(() => false),
    dispose: vi.fn(async () => invalidation.dispose())
  };
}

function extensionContext(): ExtensionContext {
  return {
    extensionPath: "/tmp/openwrangler",
    extension: { packageJSON: { version: "1.99.6" } },
    subscriptions: []
  } as unknown as ExtensionContext;
}

function coordinatorFor(snapshot: ActiveSessionSnapshot): SessionCoordinator {
  return {
    activeSession: () => snapshot,
    sessionSnapshot: (sessionId: string) => (sessionId === snapshot.sessionId ? snapshot : undefined),
    clearActiveStepInspection: vi.fn(),
    onDidChangeActiveSession: () => ({ dispose: () => undefined })
  } as unknown as SessionCoordinator;
}

function rSnapshot(sourcePath: string, operations: readonly OperationKind[]): ActiveSessionSnapshot {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    code: "open_wrangler_result <- catalog\n",
    metadata: {
      protocolVersion: 2,
      sessionId: "11111111-1111-4111-8111-111111111111",
      revision: 28,
      backend: "r",
      rDataframeFlavor: "r.data.frame",
      mode: "editing",
      source: {
        kind: "documentVariable",
        label: "catalog",
        uri: vscode.Uri.file(sourcePath).toString(),
        variableName: "catalog"
      },
      capabilities: {
        editable: true,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false,
        documentInsert: true,
        supportedOperations: [...operations]
      },
      shape: { rows: 1, columns: 1 },
      filteredShape: { rows: 1, columns: 1 },
      schema: [{ id: "r:c:0", name: "value", position: 0, rawType: "integer", type: "integer", nullable: false }],
      filterModel: { filters: [], sort: [] },
      steps: [{ id: "catalog-step", kind: "customCode", params: { code: "result <- df" } }]
    },
    viewState: {
      filterModel: { filters: [], sort: [] },
      columnWidths: {},
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    }
  };
}

function command(id: string): CommandHandler {
  const handler = nativeMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}
