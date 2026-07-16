import * as vscode from "vscode";

export const CONFIGURATION_SECTION = "openWrangler";

export function getSetting<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION, resource).get<T>(key, fallback);
}

export function updateSetting(key: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void> {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION).update(key, value, target);
}
