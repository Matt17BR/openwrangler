import * as vscode from "vscode";

export const CONFIGURATION_SECTION = "openWrangler";
export const LEGACY_CONFIGURATION_SECTION = "dataExplorer";

export function getSetting<T>(key: string, fallback: T): T {
  const canonical = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const canonicalExplicit = explicitValue<T>(canonical.inspect<T>(key));
  if (canonicalExplicit !== undefined) return canonicalExplicit;

  const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIGURATION_SECTION);
  const legacyExplicit = explicitValue<T>(legacy.inspect<T>(key));
  if (legacyExplicit !== undefined) return legacyExplicit;

  return canonical.get<T>(key, fallback);
}

export function getExplicitSetting<T>(key: string): T | undefined {
  return (
    explicitValue<T>(vscode.workspace.getConfiguration(CONFIGURATION_SECTION).inspect<T>(key)) ??
    explicitValue<T>(vscode.workspace.getConfiguration(LEGACY_CONFIGURATION_SECTION).inspect<T>(key))
  );
}

export function updateSetting(key: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void> {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION).update(key, value, target);
}

function explicitValue<T>(
  typed:
    | {
        globalValue?: T;
        workspaceValue?: T;
        workspaceFolderValue?: T;
        globalLanguageValue?: T;
        workspaceLanguageValue?: T;
        workspaceFolderLanguageValue?: T;
      }
    | undefined
): T | undefined {
  return (
    typed?.workspaceFolderLanguageValue ??
    typed?.workspaceLanguageValue ??
    typed?.globalLanguageValue ??
    typed?.workspaceFolderValue ??
    typed?.workspaceValue ??
    typed?.globalValue
  );
}
