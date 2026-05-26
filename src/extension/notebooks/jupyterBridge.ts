import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { PythonBridge } from "../pythonBridge";
import { DataExplorerPanel } from "../webviewPanel";

interface JupyterLikeApi {
  getKernel?: (uri: vscode.Uri) => unknown;
}

export const registerNotebookCommands = (context: vscode.ExtensionContext, bridge: PythonBridge): void => {
  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.openNotebookVariable", async () => {
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      if (!notebook) {
        vscode.window.showWarningMessage("Open a Jupyter notebook before launching a notebook variable in Data Explorer.");
        return;
      }

      const variableName = await vscode.window.showInputBox({
        title: "Open Notebook Variable in Data Explorer",
        prompt: "Enter a Pandas or Polars dataframe variable name from the active notebook kernel.",
        validateInput: (value) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : "Enter a valid Python variable name.")
      });
      if (!variableName) {
        return;
      }

      const source: SessionSource = {
        kind: "notebookVariable",
        label: variableName,
        variableName
      };
      const panel = DataExplorerPanel.create(context, bridge, source);
      await panel.open();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.checkJupyterIntegration", async () => {
      const jupyter = vscode.extensions.getExtension<JupyterLikeApi>("ms-toolsai.jupyter");
      if (!jupyter) {
        vscode.window.showInformationMessage("Install the VS Code Jupyter extension to launch live notebook variables.");
        return;
      }
      await jupyter.activate();
      vscode.window.showInformationMessage("Data Explorer found the Jupyter extension.");
    })
  );
};
