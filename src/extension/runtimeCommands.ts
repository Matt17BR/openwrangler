import * as vscode from "vscode";
import { PythonBridge } from "./pythonBridge";

export function registerRuntimeCommands(context: vscode.ExtensionContext, bridge: PythonBridge): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.changeRuntime", async (providedPath?: unknown) => {
      const config = vscode.workspace.getConfiguration("dataExplorer");
      const current = config.get<string>("pythonPath", "");
      const selected =
        typeof providedPath === "string"
          ? providedPath
          : await vscode.window.showInputBox({
              title: "Change Data Explorer Python Runtime",
              prompt:
                "Enter a Python 3.10-3.14 executable path. Leave the setting empty to use the Python extension selection.",
              value: current,
              placeHolder: "/path/to/python"
            });
      if (selected === undefined) return;
      await config.update("pythonPath", selected.trim() || undefined, vscode.ConfigurationTarget.Workspace);
      bridge.clearRuntimeSelection();
      void vscode.window.showInformationMessage("Data Explorer will use the new Python runtime for the next request.");
      return selected.trim();
    }),
    vscode.commands.registerCommand("dataExplorer.clearRuntime", async () => {
      await vscode.workspace
        .getConfiguration("dataExplorer")
        .update("pythonPath", undefined, vscode.ConfigurationTarget.Workspace);
      bridge.clearRuntimeSelection();
      void vscode.window.showInformationMessage(
        "Data Explorer will use the selected Python extension environment, then a system interpreter."
      );
      return true;
    }),
    vscode.commands.registerCommand("dataExplorer.installRuntimeDependencies", (confirmed?: unknown) =>
      bridge.installMissingDependencies(typeof confirmed === "boolean" ? confirmed : undefined)
    )
  );
}
