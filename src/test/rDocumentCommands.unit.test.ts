import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, TextDocument } from "vscode";
import type { SessionCoordinator } from "../extension/sessionCoordinator";

type CommandHandler = (resource?: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  textDocuments: [] as TextDocument[],
  trusted: true,
  activeDocument: undefined as TextDocument | undefined,
  openTextDocument: vi.fn<(uri: unknown) => Promise<TextDocument>>(),
  showQuickPick: vi.fn<(items: readonly unknown[]) => Promise<unknown>>(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  discovery: vi.fn(),
  transportDispose: vi.fn(async () => undefined),
  transportOptions: [] as unknown[],
  transportConstructorError: undefined as Error | undefined,
  bridgeDispose: vi.fn(async () => undefined),
  panelCreate: vi.fn(),
  restoreEditorGroupAfterQuickPick: vi.fn(async () => undefined),
  resolveExecutable: vi.fn(() => "/usr/bin/Rscript")
}));

vi.mock("vscode", () => {
  class Uri {
    private constructor(
      readonly fsPath: string,
      readonly scheme = "file",
      readonly authority = ""
    ) {}
    static file(value: string): Uri {
      return new Uri(value);
    }
    static parse(value: string): Uri {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/.*)$/u.exec(value);
      return new Uri(match?.[3] ?? value, match?.[1] ?? "file", match?.[2] ?? "");
    }
    toString(): string {
      return `${this.scheme}://${this.authority}${this.fsPath}`;
    }
  }
  return {
    Uri,
    ProgressLocation: { Notification: 15 },
    commands: {
      registerCommand: (id: string, handler: CommandHandler) => {
        mocks.commands.set(id, handler);
        return { dispose: () => mocks.commands.delete(id) };
      }
    },
    workspace: {
      get isTrusted() {
        return mocks.trusted;
      },
      get textDocuments() {
        return mocks.textDocuments;
      },
      openTextDocument: mocks.openTextDocument
    },
    window: {
      get activeTextEditor() {
        return mocks.activeDocument ? { document: mocks.activeDocument } : undefined;
      },
      withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
        task(undefined, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      showQuickPick: mocks.showQuickPick,
      showInformationMessage: mocks.showInformationMessage,
      showWarningMessage: mocks.showWarningMessage,
      showErrorMessage: mocks.showErrorMessage
    }
  };
});

vi.mock("../extension/configuration", () => ({
  getSetting: (key: string, fallback: unknown) =>
    key === "rscriptPath" ? "/configured/Rscript" : key === "sessionOpenTimeoutMs" ? 45_000 : fallback
}));

vi.mock("../extension/pythonPath", () => ({
  resolveExecutableCommand: mocks.resolveExecutable
}));

vi.mock("../extension/r/rProcessTransport", () => ({
  RProcessSessionTransport: class {
    constructor(options: unknown) {
      if (mocks.transportConstructorError) throw mocks.transportConstructorError;
      mocks.transportOptions.push(options);
    }
    discoverVariables = mocks.discovery;
    dispose = mocks.transportDispose;
  }
}));

vi.mock("../extension/r/rKernelBridge", () => ({
  RKernelBridge: class {
    dispose = mocks.bridgeDispose;
  }
}));

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: { create: mocks.panelCreate },
  restoreEditorGroupAfterQuickPick: mocks.restoreEditorGroupAfterQuickPick
}));

import * as vscode from "vscode";
import {
  OPEN_R_DOCUMENT_COMMAND,
  registerRDocumentCommands,
  supportsRDocumentExecution
} from "../extension/r/rDocumentCommands";

describe("R document command", () => {
  beforeEach(() => {
    mocks.commands.clear();
    mocks.textDocuments.length = 0;
    mocks.trusted = true;
    mocks.activeDocument = undefined;
    mocks.openTextDocument.mockReset();
    mocks.showQuickPick.mockReset();
    mocks.showInformationMessage.mockReset();
    mocks.showWarningMessage.mockReset();
    mocks.showErrorMessage.mockReset();
    mocks.discovery.mockReset();
    mocks.discovery.mockResolvedValue({
      variables: [{ name: "orders", backend: "r", dataframeFlavor: "r.data.frame" }],
      truncated: false
    });
    mocks.transportDispose.mockClear();
    mocks.transportOptions.length = 0;
    mocks.transportConstructorError = undefined;
    mocks.bridgeDispose.mockClear();
    mocks.panelCreate.mockReset();
    mocks.restoreEditorGroupAfterQuickPick.mockReset();
    mocks.restoreEditorGroupAfterQuickPick.mockResolvedValue(undefined);
    mocks.resolveExecutable.mockClear();
    mocks.resolveExecutable.mockReturnValue("/usr/bin/Rscript");
  });

  it("runs the exact in-memory R file, selects a frame, and binds its document origin", async () => {
    const document = rDocument("/workspace/analysis/orders.R", "orders <- data.frame(id = 1:3)\n");
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    const coordinator = coordinatorMock();
    register(coordinator);

    await expect(command()(vscode.Uri.file("/workspace/analysis/orders.R"))).resolves.toBe(true);

    expect(mocks.transportOptions).toEqual([
      {
        runtimeRoot: "/extension/r/openwrangler_runtime",
        documentText: ["orders <- data.frame(id = 1:3)\n"],
        rscriptPath: "/usr/bin/Rscript",
        workingDirectory: "/workspace/analysis"
      }
    ]);
    expect(coordinator.createBridge).toHaveBeenCalledWith(expect.anything(), {
      kind: "textDocument",
      document,
      version: 1
    });
    expect(mocks.panelCreate).toHaveBeenCalledWith(
      expect.objectContaining({ extensionPath: "/extension" }),
      expect.anything(),
      {
        kind: "documentVariable",
        label: "orders",
        variableName: "orders",
        uri: "file:///workspace/analysis/orders.R"
      },
      "r"
    );
    expect(mocks.restoreEditorGroupAfterQuickPick).toHaveBeenCalledOnce();
    expect(mocks.restoreEditorGroupAfterQuickPick.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.panelCreate.mock.invocationCallOrder[0]!
    );
    expect(mocks.transportDispose).not.toHaveBeenCalled();
  });

  it("rechecks the R document after returning focus from its picker", async () => {
    const document = rDocument("/workspace/orders.R", "orders <- data.frame(id = 1:3)\n");
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    mocks.restoreEditorGroupAfterQuickPick.mockImplementationOnce(async () => {
      (document as { version: number }).version = 2;
    });
    const coordinator = coordinatorMock();
    register(coordinator);

    await expect(command()(vscode.Uri.file("/workspace/orders.R"))).resolves.toBe(false);

    expect(mocks.transportDispose).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("changed"));
  });

  it("disposes the R process if the source changes while the picker is open", async () => {
    const document = rDocument("/workspace/orders.R", "orders <- data.frame(id = 1:3)\n");
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    mocks.showQuickPick.mockImplementation(async (items) => {
      (document as { version: number }).version = 2;
      return items[0];
    });
    const coordinator = coordinatorMock();
    register(coordinator);

    await expect(command()(vscode.Uri.file("/workspace/orders.R"))).resolves.toBe(false);

    expect(mocks.transportDispose).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("changed"));
  });

  it("runs an R file through a VS Code remote workspace URI", async () => {
    const uri = vscode.Uri.parse("vscode-remote://ssh-remote+host/workspace/analysis/orders.R");
    const document = {
      ...rDocument("/workspace/analysis/orders.R", "orders <- data.frame(id = 1:3)\n"),
      uri
    } as TextDocument;
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    const coordinator = coordinatorMock();
    register(coordinator);

    await expect(command()(uri)).resolves.toBe(true);

    expect(mocks.transportOptions).toContainEqual(
      expect.objectContaining({ workingDirectory: "/workspace/analysis", rscriptPath: "/usr/bin/Rscript" })
    );
    expect(mocks.panelCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        kind: "documentVariable",
        uri: "vscode-remote://ssh-remote+host/workspace/analysis/orders.R"
      }),
      "r"
    );
  });

  it("runs only enabled R cells from an exact Quarto document capture", async () => {
    const source = [
      "---",
      "title: Orders",
      "---",
      "",
      "```{r}",
      "orders <- data.frame(id = 1:3)",
      "```",
      "",
      "```{python}",
      "do_not_run = True",
      "```",
      ""
    ].join("\n");
    const document = rDocument("/workspace/analysis/orders.qmd", source);
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    mocks.showQuickPick.mockImplementation(async (items) => items[0]);
    const coordinator = coordinatorMock();
    register(coordinator);

    await expect(command()(vscode.Uri.file("/workspace/analysis/orders.qmd"))).resolves.toBe(true);

    expect(mocks.transportOptions).toContainEqual({
      runtimeRoot: "/extension/r/openwrangler_runtime",
      documentText: ["orders <- data.frame(id = 1:3)\n"],
      rscriptPath: "/usr/bin/Rscript",
      workingDirectory: "/workspace/analysis"
    });
    expect(coordinator.createBridge).toHaveBeenCalledWith(expect.anything(), {
      kind: "textDocument",
      document,
      version: 1
    });
    expect(mocks.panelCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ uri: "file:///workspace/analysis/orders.qmd" }),
      "r"
    );
  });

  it("does not start R for a literate document without a runnable R cell", async () => {
    const document = rDocument(
      "/workspace/analysis/orders.Rmd",
      "# Orders\n\n```{r setup, eval=FALSE}\nstop('disabled')\n```\n"
    );
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    register(coordinatorMock());

    await expect(command()(vscode.Uri.file("/workspace/analysis/orders.Rmd"))).resolves.toBe(false);

    expect(mocks.transportOptions).toHaveLength(0);
    expect(mocks.discovery).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      "orders.Rmd does not contain an R code chunk enabled for evaluation."
    );
  });

  it("quietly ignores a Quarto document without R cells", async () => {
    const document = rDocument(
      "/workspace/analysis/orders.qmd",
      "---\ntitle: Orders\nformat: html\n---\n\n```{python}\norders = [1, 2, 3]\n```\n"
    );
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    register(coordinatorMock());

    await expect(command()(vscode.Uri.file("/workspace/analysis/orders.qmd"))).resolves.toBe(false);

    expect(mocks.transportOptions).toHaveLength(0);
    expect(mocks.discovery).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("does not execute an R file in an untrusted workspace", async () => {
    mocks.trusted = false;
    const coordinator = coordinatorMock();
    register(coordinator);

    await expect(command()()).resolves.toBe(false);

    expect(mocks.discovery).not.toHaveBeenCalled();
    expect(mocks.transportOptions).toHaveLength(0);
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("Trust this workspace"));
  });

  it("keeps plain R execution disabled on Windows until it can own the complete process tree", () => {
    expect(supportsRDocumentExecution("linux")).toBe(true);
    expect(supportsRDocumentExecution("darwin")).toBe(true);
    expect(supportsRDocumentExecution("win32")).toBe(false);
    expect(supportsRDocumentExecution("freebsd")).toBe(false);
  });

  it("reports an invalid R source capture instead of rejecting the command", async () => {
    const document = rDocument("/workspace/orders.R", "orders <- data.frame(id = 1:3)\n");
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    mocks.transportConstructorError = new RangeError("The R document exceeds the supported 64 MiB source limit.");
    register(coordinatorMock());

    await expect(command()(vscode.Uri.file("/workspace/orders.R"))).resolves.toBe(false);

    expect(mocks.discovery).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Could not prepare orders.R: The R document exceeds the supported 64 MiB source limit."
    );
  });

  it("reports cleanup failures instead of losing an R process after an empty run", async () => {
    const document = rDocument("/workspace/orders.R", "value <- 1L\n");
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    mocks.discovery.mockResolvedValueOnce({ variables: [], truncated: false });
    mocks.transportDispose.mockRejectedValueOnce(new Error("process still running"));
    register(coordinatorMock());

    await expect(command()(vscode.Uri.file("/workspace/orders.R"))).resolves.toBe(false);

    expect(mocks.transportDispose).toHaveBeenCalledOnce();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Open Wrangler could not close its R process: process still running"
    );
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it("disposes the exact R process if the dataframe picker rejects", async () => {
    const document = rDocument("/workspace/orders.qmd", "```{r}\norders <- data.frame(id = 1:3)\n```\n");
    mocks.textDocuments.push(document);
    mocks.openTextDocument.mockResolvedValue(document);
    mocks.showQuickPick.mockRejectedValueOnce(new Error("window closed"));
    register(coordinatorMock());

    await expect(command()(vscode.Uri.file("/workspace/orders.qmd"))).resolves.toBe(false);

    expect(mocks.transportDispose).toHaveBeenCalledOnce();
    expect(mocks.panelCreate).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Could not choose an R dataframe from orders.qmd: window closed"
    );
  });
});

function register(coordinator: ReturnType<typeof coordinatorMock>): void {
  const context = { extensionPath: "/extension", subscriptions: [] } as unknown as ExtensionContext;
  registerRDocumentCommands(context, coordinator as unknown as SessionCoordinator);
}

function command(): CommandHandler {
  const handler = mocks.commands.get(OPEN_R_DOCUMENT_COMMAND);
  if (!handler) throw new Error("The R document command was not registered.");
  return handler;
}

function coordinatorMock() {
  return {
    createBridge: vi.fn(() => ({ request: vi.fn() }))
  };
}

function rDocument(fsPath: string, text: string): TextDocument {
  return {
    uri: vscode.Uri.file(fsPath),
    version: 1,
    isClosed: false,
    isUntitled: false,
    getText: () => text
  } as TextDocument;
}
