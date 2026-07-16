import * as vscode from "vscode";

export const PRODUCT_NAME = "Open Wrangler";
export const EXTENSION_ID = "Matt17BR.openwrangler";
export const COMMAND_PREFIX = "openWrangler";
export const LEGACY_COMMAND_PREFIX = "dataExplorer";
export const CUSTOM_EDITOR_ID = "openWrangler.viewer";
export const LEGACY_CUSTOM_EDITOR_ID = "dataExplorer.viewer";

export const commandNames = [
  "openFile",
  "openPath",
  "launchDataViewer",
  "openNotebookVariable",
  "checkJupyterIntegration",
  "changeRuntime",
  "clearRuntime",
  "installRuntimeDependencies",
  "startOperation",
  "applyStep",
  "discardStep",
  "editLatestStep",
  "undoStep",
  "copyCode",
  "exportCode",
  "insertNotebookCode",
  "exportData",
  "openSourceFile",
  "openWalkthrough",
  "openSettings",
  "reportIssue"
] as const;

export function registerLegacyCommandAliases(context: vscode.ExtensionContext): void {
  for (const name of commandNames) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`${LEGACY_COMMAND_PREFIX}.${name}`, (...args: unknown[]) =>
        vscode.commands.executeCommand(`${COMMAND_PREFIX}.${name}`, ...args)
      )
    );
  }
}
