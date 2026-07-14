import * as path from "path";
import * as vscode from "vscode";
import type { DataBackend, SessionSource } from "../../shared/protocol";
import type { DataExplorerBridge } from "../dataBridge";
import { DataExplorerPanel } from "../webviewPanel";

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
    const source = fileSource(document.uri);
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

      DataExplorerPanel.create(context, bridge, fileSource(target), getDefaultBackend());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.openPath", async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          "Data files": ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"]
        }
      });
      const selected = files?.[0];
      if (!selected) {
        return;
      }

      DataExplorerPanel.create(context, bridge, fileSource(selected), getDefaultBackend());
    })
  );
};

const fileSource = (uri: vscode.Uri): SessionSource => ({
  kind: "file",
  label: path.basename(uri.fsPath),
  path: uri.fsPath
});

const getDefaultBackend = (): DataBackend | undefined => {
  const configured = vscode.workspace
    .getConfiguration("dataExplorer")
    .get<DataBackend | "auto">("defaultBackend", "auto");
  return configured === "auto" ? undefined : configured;
};
