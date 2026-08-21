import * as vscode from "vscode";
import { PythonBridge } from "./pythonBridge";
import { getSetting, updateSetting } from "./configuration";

export function registerRuntimeCommands(context: vscode.ExtensionContext, bridge: PythonBridge): void {
  registerAtomically(context.subscriptions, () => {
    context.subscriptions.push(
      vscode.commands.registerCommand("openWrangler.changeRuntime", async (providedPath?: unknown) => {
        const current = getSetting<string>("pythonPath", "");
        const selected =
          typeof providedPath === "string"
            ? providedPath
            : await vscode.window.showInputBox({
                title: "Change Open Wrangler Python Runtime",
                prompt:
                  "Enter a Python 3.10-3.14 executable path. Leave the setting empty to use the Python extension selection.",
                value: current,
                placeHolder: "/path/to/python"
              });
        if (selected === undefined) return;
        await updateSetting("pythonPath", selected.trim() || undefined, vscode.ConfigurationTarget.Workspace);
        bridge.clearRuntimeSelection();
        void vscode.window.showInformationMessage(
          "Open Wrangler will use the new Python runtime for the next request."
        );
        return selected.trim();
      })
    );
    context.subscriptions.push(
      vscode.commands.registerCommand("openWrangler.clearRuntime", async () => {
        await updateSetting("pythonPath", undefined, vscode.ConfigurationTarget.Workspace);
        bridge.clearRuntimeSelection();
        void vscode.window.showInformationMessage(
          "Open Wrangler will use the selected Python extension environment, then a system interpreter."
        );
        return true;
      })
    );
    context.subscriptions.push(
      vscode.commands.registerCommand("openWrangler.installRuntimeDependencies", () =>
        bridge.installMissingDependencies()
      )
    );
    context.subscriptions.push(
      vscode.commands.registerCommand("openWrangler.revalidateRuntimeDependencies", () =>
        bridge.revalidateRuntimeDependencies()
      )
    );
  });
}

function registerAtomically(subscriptions: vscode.Disposable[], register: () => void): void {
  const start = subscriptions.length;
  try {
    register();
  } catch (error) {
    const failures: unknown[] = [error];
    for (const disposable of subscriptions.splice(start).reverse()) {
      try {
        disposable.dispose();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "Open Wrangler runtime command registration failed during rollback.");
  }
}
