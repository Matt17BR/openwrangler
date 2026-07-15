import * as path from "path";
import * as vscode from "vscode";
import type { DataBackend, SessionSource } from "../../shared/protocol";
import type { DataExplorerBridge } from "../dataBridge";
import { DataExplorerPanel } from "../webviewPanel";
import { defaultImportOptions, ImportCancelledError, promptImportOptions } from "./importOptions";

export class DataExplorerCustomEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: DataExplorerBridge
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return {
      uri,
      dispose: () => undefined
    };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const source = fileSource(document.uri, defaultImportOptions(document.uri));
    const defaultBackend = getDefaultBackend();
    new DataExplorerPanel(webviewPanel, this.context, this.bridge, source, defaultBackend);
  }
}

export const registerFileCommands = (context: vscode.ExtensionContext, bridge: DataExplorerBridge): void => {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "dataExplorer.viewer",
      new DataExplorerCustomEditorProvider(context, bridge),
      {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.openFile", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        await vscode.commands.executeCommand("dataExplorer.openPath");
        return;
      }
      if (!isEnabledFileType(target)) {
        await vscode.window.showWarningMessage(
          `${path.extname(target.fsPath) || "This file type"} is disabled in Data Explorer settings.`
        );
        return;
      }

      try {
        DataExplorerPanel.create(
          context,
          bridge,
          fileSource(target, await promptImportOptions(target)),
          getDefaultBackend()
        );
      } catch (error) {
        if (!(error instanceof ImportCancelledError)) throw error;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.openPath", async () => {
      const enabledFileTypes = getEnabledFileTypes();
      if (enabledFileTypes.length === 0) {
        await vscode.window.showWarningMessage("Enable at least one Data Explorer file type in Settings.");
        return;
      }
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          "Data files": enabledFileTypes
        }
      });
      const selected = files?.[0];
      if (!selected) {
        return;
      }

      try {
        DataExplorerPanel.create(
          context,
          bridge,
          fileSource(selected, await promptImportOptions(selected)),
          getDefaultBackend()
        );
      } catch (error) {
        if (!(error instanceof ImportCancelledError)) throw error;
      }
    })
  );
};

const fileSource = (uri: vscode.Uri, importOptions?: SessionSource["importOptions"]): SessionSource => ({
  kind: "file",
  label: path.basename(uri.fsPath),
  path: uri.fsPath,
  uri: uri.toString(),
  importOptions
});

const getDefaultBackend = (): DataBackend | undefined => {
  const configured = vscode.workspace
    .getConfiguration("dataExplorer")
    .get<DataBackend | "auto">("defaultBackend", "auto");
  return configured === "auto" ? undefined : configured;
};

const allFileTypes = ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"];

const getEnabledFileTypes = (): string[] =>
  vscode.workspace.getConfiguration("dataExplorer").get<string[]>("enabledFileTypes", allFileTypes);

const isEnabledFileType = (uri: vscode.Uri): boolean =>
  getEnabledFileTypes().includes(path.extname(uri.fsPath).slice(1).toLowerCase());
