import * as vscode from "vscode";
import { LazyActivationOwners, type OpenWranglerExtensionApi, type OpenWranglerTestApi } from "./lazyActivationOwners";

export type { OpenWranglerExtensionApi, OpenWranglerTestApi };

let activeOwners: LazyActivationOwners | undefined;

const NOTEBOOK_EDITOR_TITLE_ACTION_CONTEXT = "openWrangler.forceNotebookEditorTitleAction";

export function isCursorAppName(appName: string): boolean {
  const normalized = appName.trim().toLowerCase();
  return normalized === "cursor" || normalized.startsWith("cursor ");
}

export async function activate(context: vscode.ExtensionContext): Promise<OpenWranglerExtensionApi | undefined> {
  const owners = new LazyActivationOwners(context);
  activeOwners = owners;
  try {
    // This installs the lightweight activation gates and, when a relevant
    // notebook is already visible, its formatter preparation hooks before the
    // first yield. Runtime and UI owners remain unloaded until their trigger.
    owners.startBeforeFirstYield();
    await setNotebookEditorTitleActionContext(isCursorAppName(vscode.env.appName));
    return await owners.extensionApiForCurrentEnvironment();
  } catch (error) {
    if (activeOwners === owners) activeOwners = undefined;
    try {
      await owners.shutdown();
    } catch (shutdownError) {
      throw new AggregateError(
        [error, shutdownError],
        "Open Wrangler activation failed and its initialized owners could not shut down cleanly."
      );
    }
    throw error;
  }
}

async function setNotebookEditorTitleActionContext(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", NOTEBOOK_EDITOR_TITLE_ACTION_CONTEXT, value);
}

export async function deactivate(): Promise<void> {
  const owners = activeOwners;
  activeOwners = undefined;
  await owners?.shutdown();
}
