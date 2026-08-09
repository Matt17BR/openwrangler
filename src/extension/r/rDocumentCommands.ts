import * as path from "node:path";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { getSetting } from "../configuration";
import { DetachedBridgeRequestError } from "../dataBridge";
import { resolveExecutableCommand } from "../pythonPath";
import { type TextDocumentSessionOrigin, SessionCoordinator } from "../sessionCoordinator";
import { OpenWranglerPanel, restoreEditorGroupAfterQuickPick } from "../webviewPanel";
import { prepareRDocumentSource, rDocumentKind, rDocumentLabel } from "./rDocumentSource";
import { RKernelBridge } from "./rKernelBridge";
import { RProcessSessionTransport, type RProcessVariableDescriptor } from "./rProcessTransport";

export const OPEN_R_DOCUMENT_COMMAND = "openWrangler.runRDocument";

interface RDocumentQuickPickItem extends vscode.QuickPickItem {
  readonly variable: RProcessVariableDescriptor;
}

/**
 * Registers the explicit R document flow. Running this command executes the
 * exact in-memory R source, or the runnable R cells from an R Markdown/Quarto
 * source, once in an Open Wrangler-owned process.
 */
export function registerRDocumentCommands(context: vscode.ExtensionContext, coordinator: SessionCoordinator): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_R_DOCUMENT_COMMAND, async (resource?: unknown) => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage("Trust this workspace before running an R document in Open Wrangler.");
        return false;
      }
      if (!supportsRDocumentExecution()) {
        void vscode.window.showWarningMessage(
          "Running R documents in Open Wrangler currently requires macOS or Linux. Open the dataframe from an IRkernel notebook instead."
        );
        return false;
      }

      const document = await resolveRDocument(resource);
      if (!document) return false;
      const origin = captureRDocumentOrigin(document);
      if (!origin) {
        void vscode.window.showWarningMessage("The R document changed or closed before Open Wrangler could run it.");
        return false;
      }

      const documentText = document.getText();
      let prepared;
      try {
        prepared = prepareRDocumentSource(document.uri.fsPath, documentText);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not prepare ${path.basename(document.uri.fsPath)}: ${errorMessage(error)}`
        );
        return false;
      }
      if (prepared.kind !== "r" && prepared.runnableRChunkCount === 0) {
        if (prepared.rChunkCount > 0) {
          void vscode.window.showInformationMessage(
            `${path.basename(document.uri.fsPath)} does not contain an R code chunk enabled for evaluation.`
          );
        }
        return false;
      }
      const documentLabel = rDocumentLabel(prepared.kind);
      const rscriptPath = configuredRscriptPath(document.uri);
      if (!rscriptPath) {
        void vscode.window.showErrorMessage(
          "Open Wrangler could not find Rscript. Install R or set openWrangler.rscriptPath to its absolute path."
        );
        return false;
      }
      let transport: RProcessSessionTransport;
      try {
        transport = new RProcessSessionTransport({
          runtimeRoot: path.join(context.extensionPath, "r", "openwrangler_runtime"),
          documentText: prepared.executableUnits,
          rscriptPath,
          workingDirectory: path.dirname(document.uri.fsPath)
        });
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not prepare ${path.basename(document.uri.fsPath)}: ${errorMessage(error)}`
        );
        return false;
      }

      let discovery;
      try {
        discovery = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Running ${path.basename(document.uri.fsPath)} and finding dataframes`,
            cancellable: true
          },
          (_progress, cancellation) =>
            transport.discoverVariables({
              cancellation,
              timeoutMs: getSetting<number>("sessionOpenTimeoutMs", 60_000, document.uri)
            })
        );
      } catch (error) {
        const cleanupError = await disposeTransport(transport);
        if (error instanceof DetachedBridgeRequestError && error.reason === "cancellation" && !cleanupError)
          return false;
        void vscode.window.showErrorMessage(
          `Could not run ${documentLabel.toLowerCase()} ${path.basename(document.uri.fsPath)}: ${errorMessage(error)}${cleanupSuffix(cleanupError)}`
        );
        return false;
      }

      if (!isCurrentRDocumentOrigin(origin)) {
        const cleanupError = await disposeTransport(transport);
        if (cleanupError) {
          showCleanupError(cleanupError);
          return false;
        }
        void vscode.window.showWarningMessage(
          "The R document changed while it was running. Run it again before opening a dataframe."
        );
        return false;
      }
      if (discovery.variables.length === 0) {
        const cleanupError = await disposeTransport(transport);
        if (cleanupError) {
          showCleanupError(cleanupError);
          return false;
        }
        void vscode.window.showInformationMessage(
          `${path.basename(document.uri.fsPath)} ran successfully, but it did not create a data.frame, tibble, or data.table.`
        );
        return false;
      }

      const fileName = path.basename(document.uri.fsPath);
      const items = discovery.variables.map((variable) => rDocumentQuickPickItem(variable, fileName));
      let selected: RDocumentQuickPickItem | undefined;
      try {
        selected = await vscode.window.showQuickPick(items, {
          title: `Open Wrangler: Choose a dataframe from ${fileName}`,
          placeHolder: discovery.truncated
            ? "Select a data.frame, tibble, or data.table (the variable list was truncated)"
            : "Select a data.frame, tibble, or data.table",
          matchOnDescription: true,
          matchOnDetail: true,
          ignoreFocusOut: true
        });
      } catch (error) {
        const cleanupError = await disposeTransport(transport);
        void vscode.window.showErrorMessage(
          `Could not choose an R dataframe from ${fileName}: ${errorMessage(error)}${cleanupSuffix(cleanupError)}`
        );
        return false;
      }
      if (!selected || !items.includes(selected)) {
        const cleanupError = await disposeTransport(transport);
        if (cleanupError) showCleanupError(cleanupError);
        return false;
      }
      await restoreEditorGroupAfterQuickPick();
      if (!isCurrentRDocumentOrigin(origin)) {
        const cleanupError = await disposeTransport(transport);
        if (cleanupError) {
          showCleanupError(cleanupError);
          return false;
        }
        void vscode.window.showWarningMessage(
          "The R document changed while the dataframe picker was open. Run it again before opening a dataframe."
        );
        return false;
      }

      const source: SessionSource = {
        kind: "documentVariable",
        label: selected.variable.name,
        variableName: selected.variable.name,
        uri: document.uri.toString()
      };
      const delegate = new RKernelBridge(context, transport);
      try {
        const bridge = coordinator.createBridge(delegate, origin);
        OpenWranglerPanel.create(context, bridge, source, "r");
        return true;
      } catch (error) {
        let cleanupError: unknown;
        try {
          await delegate.dispose();
        } catch (disposeError) {
          cleanupError = disposeError;
        }
        void vscode.window.showErrorMessage(
          `Could not open the selected R dataframe: ${errorMessage(error)}${cleanupSuffix(cleanupError)}`
        );
        return false;
      }
    })
  );
}

export function supportsRDocumentExecution(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux" || platform === "darwin";
}

export function captureRDocumentOrigin(document: vscode.TextDocument): TextDocumentSessionOrigin | undefined {
  if (!isSupportedRDocument(document) || !isSoleOpenTextDocument(document)) return undefined;
  return { kind: "textDocument", document, version: document.version };
}

export function isCurrentRDocumentOrigin(origin: TextDocumentSessionOrigin): boolean {
  const document = origin.document;
  return (
    document.version === origin.version &&
    !document.isClosed &&
    isSupportedRDocument(document) &&
    isSoleOpenTextDocument(document)
  );
}

async function resolveRDocument(resource: unknown): Promise<vscode.TextDocument | undefined> {
  let document: vscode.TextDocument | undefined;
  if (resource instanceof vscode.Uri) {
    if (!isSupportedRUri(resource)) {
      void vscode.window.showWarningMessage(
        "Open Wrangler can run .R, .Rmd, and .qmd documents from local or VS Code remote workspaces."
      );
      return undefined;
    }
    try {
      document = await vscode.workspace.openTextDocument(resource);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open the R document: ${errorMessage(error)}`);
      return undefined;
    }
  } else {
    document = vscode.window.activeTextEditor?.document;
  }

  if (!document || !isSupportedRDocument(document)) {
    void vscode.window.showWarningMessage(
      "Open a local or VS Code remote .R, .Rmd, or .qmd document before running it in Open Wrangler."
    );
    return undefined;
  }
  if (!isSoleOpenTextDocument(document)) {
    void vscode.window.showWarningMessage(
      "Open Wrangler cannot safely run this R document while another document object has the same URI. Close the duplicate and try again."
    );
    return undefined;
  }
  return document;
}

function isSupportedRDocument(document: vscode.TextDocument): boolean {
  return !document.isClosed && !document.isUntitled && isSupportedRUri(document.uri);
}

function isSupportedRUri(uri: vscode.Uri): boolean {
  return (uri.scheme === "file" || uri.scheme === "vscode-remote") && rDocumentKind(uri.fsPath) !== undefined;
}

function isSoleOpenTextDocument(document: vscode.TextDocument): boolean {
  const serialized = document.uri.toString();
  const matches = vscode.workspace.textDocuments.filter((candidate) => candidate.uri.toString() === serialized);
  return matches.length === 1 && matches[0] === document;
}

function configuredRscriptPath(resource: vscode.Uri): string | undefined {
  const configured = getSetting<string>("rscriptPath", "", resource).trim() || "Rscript";
  return resolveExecutableCommand(configured, process.env, isExecutableFile);
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function rDocumentQuickPickItem(variable: RProcessVariableDescriptor, fileName: string): RDocumentQuickPickItem {
  return {
    label: variable.name,
    description: `R · ${rDataframeFlavorLabel(variable.dataframeFlavor)}`,
    detail: `From this run of ${fileName}`,
    variable
  };
}

function rDataframeFlavorLabel(flavor: RProcessVariableDescriptor["dataframeFlavor"]): string {
  switch (flavor) {
    case "r.data.frame":
      return "data.frame";
    case "r.tibble":
      return "tibble";
    case "r.data.table":
      return "data.table";
  }
}

async function disposeTransport(transport: RProcessSessionTransport): Promise<unknown | undefined> {
  try {
    await transport.dispose();
    return undefined;
  } catch (error) {
    return error;
  }
}

function cleanupSuffix(error: unknown | undefined): string {
  return error === undefined ? "" : ` Open Wrangler also could not close its R process: ${errorMessage(error)}`;
}

function showCleanupError(error: unknown): void {
  void vscode.window.showErrorMessage(`Open Wrangler could not close its R process: ${errorMessage(error)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
