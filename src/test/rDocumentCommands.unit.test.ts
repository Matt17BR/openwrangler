import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, TextDocument, TextEditor } from "vscode";
import type { SessionCoordinator } from "../extension/sessionCoordinator";
import type { LiterateDocumentVariableProviders } from "../extension/r/rDocumentCommands";

type CommandHandler = (resource?: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  textDocuments: [] as TextDocument[],
  trusted: true,
  activeEditor: undefined as TextEditor | undefined,
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
  resolveExecutable: vi.fn(() => "/usr/bin/Rscript"),
  executeCommand: vi.fn(async () => undefined),
  getCommands: vi.fn(async () => [] as string[])
}));

vi.mock("vscode", () => {
  class Uri {
    private constructor(
      readonly fsPath: string,
      readonly scheme = "file",
      readonly authority = ""
    ) {
      this.path = fsPath;
    }
    readonly path: string;
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
    ViewColumn: { Active: -1, One: 1 },
    commands: {
      registerCommand: (id: string, handler: CommandHandler) => {
        mocks.commands.set(id, handler);
        return { dispose: () => mocks.commands.delete(id) };
      },
      executeCommand: mocks.executeCommand,
      getCommands: mocks.getCommands
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
        return mocks.activeEditor;
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
    mocks.activeEditor = undefined;
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
    mocks.executeCommand.mockReset();
    mocks.executeCommand.mockResolvedValue(undefined);
    mocks.getCommands.mockReset();
    mocks.getCommands.mockResolvedValue([]);
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

  it("routes the primary Quarto action to the Python chunk at the exact cursor", async () => {
    const source = [
      "# Mixed analysis",
      "",
      "```{r}",
      "orders_r <- data.frame(id = 1:3)",
      "```",
      "",
      "~~~{python}",
      "#| label: load-python-orders",
      "orders_python = make_frame()",
      "~~~~",
      ""
    ].join("\n");
    const document = rDocument("/workspace/analysis/orders.qmd", source);
    const editor = textEditor(document, 8);
    mocks.textDocuments.push(document);
    mocks.activeEditor = editor;
    const providers = literateProviders();
    providers.python.runLiterateChunkAndOpen.mockResolvedValueOnce(true);
    register(coordinatorMock(), providers.value);

    await expect(command()()).resolves.toBe(true);

    expect(providers.python.runLiterateChunkAndOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        editor,
        document,
        version: 1,
        uri: "file:///workspace/analysis/orders.qmd",
        chunk: expect.objectContaining({
          language: "python",
          fenceCharacter: "~",
          openingLine: 6,
          closingLine: 9
        })
      })
    );
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.transportOptions).toHaveLength(0);
  });

  it("runs only the cursor-owned Quarto R chunk through the official Quarto command", async () => {
    const source = [
      "```{python}",
      "ignore_me = True",
      "```",
      "",
      "```{r load-orders}",
      "#| label: load-orders",
      "orders <- data.frame(id = 1:3)",
      "```",
      ""
    ].join("\n");
    const document = rDocument("/workspace/orders.qmd", source);
    const editor = textEditor(document, 6);
    mocks.textDocuments.push(document);
    mocks.activeEditor = editor;
    mocks.getCommands.mockResolvedValue(["quarto.runCurrentCell"]);
    const providers = literateProviders();
    providers.r.hasActiveSession.mockReturnValue(true);
    providers.r.openLiterateSession.mockResolvedValueOnce(true);
    register(coordinatorMock(), providers.value);

    await expect(command()()).resolves.toBe(true);

    expect(mocks.executeCommand).toHaveBeenCalledWith("quarto.runCurrentCell", 5);
    expect(providers.r.openLiterateSession).toHaveBeenCalledWith(
      expect.objectContaining({ editor, document, chunk: expect.objectContaining({ language: "r" }) }),
      true
    );
    expect(mocks.transportOptions).toHaveLength(0);
  });

  it("runs only the cursor-owned R Markdown R chunk through the official R command", async () => {
    const document = rDocument(
      "/workspace/orders.Rmd",
      "```{r load-orders, echo=FALSE}\n#| label: load-orders\norders <- data.frame(id = 1:3)\n```\n"
    );
    const editor = textEditor(document, 2);
    mocks.textDocuments.push(document);
    mocks.activeEditor = editor;
    mocks.getCommands.mockResolvedValue(["r.runSelection"]);
    const providers = literateProviders();
    providers.r.hasActiveSession.mockReturnValue(true);
    providers.r.openLiterateSession.mockResolvedValueOnce(true);
    register(coordinatorMock(), providers.value);

    await expect(command()()).resolves.toBe(true);

    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "r.runSelection",
      "#| label: load-orders\norders <- data.frame(id = 1:3)\n"
    );
    expect(mocks.executeCommand).not.toHaveBeenCalledWith("r.runSource", expect.anything());
    expect(providers.r.openLiterateSession).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("falls back to the exact associated Python session when the cursor is outside a chunk", async () => {
    const document = rDocument("/workspace/orders.qmd", "# Orders\n\nChoose the existing dataframe.\n");
    mocks.textDocuments.push(document);
    mocks.activeEditor = textEditor(document, 2);
    const providers = literateProviders();
    providers.python.hasAssociatedLiterateSession.mockReturnValue(true);
    providers.python.openAssociatedLiterateSession.mockResolvedValueOnce(true);
    register(coordinatorMock(), providers.value);

    await expect(command()()).resolves.toBe(true);

    expect(providers.python.openAssociatedLiterateSession).toHaveBeenCalledOnce();
    expect(providers.r.openLiterateSession).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it("does not route a result after the exact Quarto cursor changes across command discovery", async () => {
    const document = rDocument("/workspace/orders.qmd", "```{r}\norders <- data.frame(id = 1:3)\n```\n");
    const editor = textEditor(document, 1);
    mocks.textDocuments.push(document);
    mocks.activeEditor = editor;
    mocks.getCommands.mockImplementationOnce(async () => {
      const moved = selection(2);
      editor.selection = moved;
      editor.selections = [moved];
      return ["quarto.runCurrentCell"];
    });
    const providers = literateProviders();
    register(coordinatorMock(), providers.value);

    await expect(command()()).resolves.toBe(false);

    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(providers.r.openLiterateSession).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("document or cursor changed"));
  });

  it("does not fall back to an all-document run when the literate origin is ambiguous", async () => {
    const source = "```{r}\norders <- data.frame(id = 1:3)\n```\n";
    const document = rDocument("/workspace/orders.qmd", source);
    const duplicate = rDocument("/workspace/orders.qmd", source);
    mocks.textDocuments.push(document, duplicate);
    mocks.activeEditor = textEditor(document, 1);
    register(coordinatorMock(), literateProviders().value);

    await expect(command()()).resolves.toBe(false);

    expect(mocks.transportOptions).toHaveLength(0);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("exact document and cursor"));
  });

  it("explains the supported chunk or session choices once when neither exists", async () => {
    const document = rDocument("/workspace/orders.Rmd", "~~~{python}\nframe = make_frame()\n~~~\n");
    mocks.textDocuments.push(document);
    mocks.activeEditor = textEditor(document, 1);
    const providers = literateProviders();
    register(coordinatorMock(), providers.value);

    await expect(command()()).resolves.toBe(false);

    expect(mocks.showInformationMessage).toHaveBeenCalledOnce();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/backtick fence/u));
    expect(mocks.executeCommand).not.toHaveBeenCalled();
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

  it("explains when a Quarto document does not contain R cells", async () => {
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
    expect(mocks.showInformationMessage).toHaveBeenCalledWith("orders.qmd does not contain an R code chunk.");
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

function register(
  coordinator: ReturnType<typeof coordinatorMock>,
  providers?: LiterateDocumentVariableProviders
): void {
  const context = { extensionPath: "/extension", subscriptions: [] } as unknown as ExtensionContext;
  registerRDocumentCommands(context, coordinator as unknown as SessionCoordinator, providers);
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

function textEditor(document: TextDocument, line: number): TextEditor {
  const selected = selection(line);
  return {
    document,
    selection: selected,
    selections: [selected],
    viewColumn: vscode.ViewColumn.One
  } as unknown as TextEditor;
}

function selection(line: number): TextEditor["selection"] {
  return {
    anchor: { line, character: 0 },
    active: { line, character: 0 },
    start: { line, character: 0 },
    end: { line, character: 0 }
  } as TextEditor["selection"];
}

function literateProviders() {
  const python = {
    runLiterateChunkAndOpen: vi.fn(async () => false),
    hasAssociatedLiterateSession: vi.fn(() => false),
    openAssociatedLiterateSession: vi.fn(async () => false)
  };
  const r = {
    hasActiveSession: vi.fn(() => false),
    openLiterateSession: vi.fn(async () => false)
  };
  return {
    python,
    r,
    value: { python, r } as LiterateDocumentVariableProviders
  };
}
