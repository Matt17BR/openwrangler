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
import {
  captureLiterateDocumentOrigin,
  isCurrentLiterateDocumentOrigin,
  type LiterateDocumentOrigin
} from "../literateDocumentOrigin";
import type { LiteratePythonVariableProvider } from "../notebooks/pythonInteractiveCommands";
import type { LiterateRVariableProvider } from "./rInteractiveCommands";

export const OPEN_R_DOCUMENT_COMMAND = "openWrangler.runRDocument";

export interface LiterateDocumentVariableProviders {
  readonly python: LiteratePythonVariableProvider;
  readonly r: LiterateRVariableProvider;
}

interface RDocumentQuickPickItem extends vscode.QuickPickItem {
  readonly variable: RProcessVariableDescriptor;
}

/**
 * Registers the explicit R document flow. Running this command executes the
 * exact in-memory R source, or the runnable R cells from an R Markdown/Quarto
 * source, once in an Open Wrangler-owned process.
 */
export function registerRDocumentCommands(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  literateProviders?: LiterateDocumentVariableProviders
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_R_DOCUMENT_COMMAND, async (resource?: unknown) => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage("Trust this workspace before running an R document in Open Wrangler.");
        return false;
      }
      if (!(resource instanceof vscode.Uri) && literateProviders) {
        const routed = await routeActiveLiterateDocument(literateProviders);
        if (routed !== undefined) return routed;
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
        const filename = path.basename(document.uri.fsPath);
        void vscode.window.showInformationMessage(
          prepared.rChunkCount > 0
            ? `${filename} does not contain an R code chunk enabled for evaluation.`
            : `${filename} does not contain an R code chunk.`
        );
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

async function routeActiveLiterateDocument(providers: LiterateDocumentVariableProviders): Promise<boolean | undefined> {
  let origin: LiterateDocumentOrigin | undefined;
  try {
    origin = captureLiterateDocumentOrigin();
  } catch (error) {
    void vscode.window.showInformationMessage(`Could not read the current code chunk: ${errorMessage(error)}`);
    return false;
  }
  if (!origin) return undefined;
  const chunk = origin.chunk;
  if (
    !chunk ||
    !chunk.executableSyntax ||
    !chunk.supportedFence ||
    !chunk.enabled ||
    (chunk.language !== "python" && chunk.language !== "r")
  ) {
    return await openExistingLiterateSessionOrExplain(origin, providers);
  }

  if (chunk.language === "python") {
    return await providers.python.runLiterateChunkAndOpen(origin);
  }

  const command = origin.kind === "quarto" ? "quarto.runCurrentCell" : "r.runSelection";
  let available: readonly string[];
  try {
    available = await vscode.commands.getCommands(true);
  } catch {
    available = [];
  }
  if (!isCurrentLiterateDocumentOrigin(origin)) {
    showStaleLiterateDocument();
    return false;
  }
  if (!available.includes(command)) {
    if (providers.r.hasActiveSession()) return await providers.r.openLiterateSession(origin);
    void vscode.window.showInformationMessage(
      origin.kind === "quarto"
        ? "Install or enable the Quarto and R extensions, then run this R chunk again."
        : "Install or enable the R extension, then run this R chunk again."
    );
    return false;
  }

  try {
    if (origin.kind === "quarto") {
      await vscode.commands.executeCommand(command, Math.max(1, chunk.openingLine + 1));
    } else {
      await vscode.commands.executeCommand(command, chunk.code);
    }
  } catch (error) {
    if (!isCurrentLiterateDocumentOrigin(origin)) {
      showStaleLiterateDocument();
      return false;
    }
    void vscode.window.showInformationMessage(`Could not run the current R chunk: ${errorMessage(error)}`);
    return false;
  }
  if (!isCurrentLiterateDocumentOrigin(origin)) {
    showStaleLiterateDocument();
    return false;
  }
  if (!providers.r.hasActiveSession()) {
    void vscode.window.showInformationMessage(
      "The R chunk did not produce an active R session. Check the R output, then try again."
    );
    return false;
  }
  return await providers.r.openLiterateSession(origin, true);
}

async function openExistingLiterateSessionOrExplain(
  origin: LiterateDocumentOrigin,
  providers: LiterateDocumentVariableProviders
): Promise<boolean> {
  if (providers.python.hasAssociatedLiterateSession(origin)) {
    return await providers.python.openAssociatedLiterateSession(origin);
  }
  if (providers.r.hasActiveSession()) return await providers.r.openLiterateSession(origin);
  const fenceHint =
    origin.chunk?.language && !origin.chunk.supportedFence
      ? " Use a backtick fence in R Markdown."
      : origin.chunk && !origin.chunk.enabled
        ? " The current chunk is disabled."
        : "";
  void vscode.window.showInformationMessage(
    `Place the cursor in an enabled R or Python code chunk, or select its live session, then try again.${fenceHint}`
  );
  return false;
}

function showStaleLiterateDocument(): void {
  void vscode.window.showWarningMessage(
    "The document or cursor changed while its code chunk was running. Return to the chunk and try again."
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
