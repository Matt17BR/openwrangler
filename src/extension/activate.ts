import * as vscode from "vscode";
import { LazyActivationOwners, type OpenWranglerExtensionApi, type OpenWranglerTestApi } from "./lazyActivationOwners";

export type { OpenWranglerExtensionApi, OpenWranglerTestApi };

interface ActivationState {
  readonly owners: LazyActivationOwners;
  phase: "activating" | "active";
  shutdown?: Promise<void>;
}

let activationState: ActivationState | undefined;
let activeDeactivation: Promise<void> | undefined;

const NOTEBOOK_EDITOR_TITLE_ACTION_CONTEXT = "openWrangler.forceNotebookEditorTitleAction";
export const MAX_SYNCHRONOUS_ACTIVATION_MS = 2_000;

export function isCursorAppName(appName: string): boolean {
  const normalized = appName.trim().toLowerCase();
  return normalized === "cursor" || normalized.startsWith("cursor ");
}

export async function activate(context: vscode.ExtensionContext): Promise<OpenWranglerExtensionApi | undefined> {
  while (activeDeactivation) await activeDeactivation;
  if (activationState) throw new Error("Open Wrangler is already active or activating.");
  const synchronousStartedAt = performance.now();
  const owners = new LazyActivationOwners(context);
  const state: ActivationState = { owners, phase: "activating" };
  activationState = state;
  try {
    // This installs the lightweight activation gates and, when a relevant
    // notebook is already visible, its formatter preparation hooks before the
    // first yield. Runtime and UI owners remain unloaded until their trigger.
    owners.startBeforeFirstYield();
    const synchronousElapsedMs = performance.now() - synchronousStartedAt;
    if (
      !Number.isFinite(synchronousElapsedMs) ||
      synchronousElapsedMs < 0 ||
      synchronousElapsedMs > MAX_SYNCHRONOUS_ACTIVATION_MS
    ) {
      throw new Error(
        `Open Wrangler synchronous activation exceeded its ${MAX_SYNCHRONOUS_ACTIVATION_MS} ms dependency-free budget.`
      );
    }
    await setNotebookEditorTitleActionContext(isCursorAppName(vscode.env.appName));
    assertCurrentActivation(state);
    const api = await owners.extensionApiForCurrentEnvironment();
    assertCurrentActivation(state);
    state.phase = "active";
    return api;
  } catch (error) {
    if (activationState === state) activationState = undefined;
    try {
      await (state.shutdown ??= beginDeactivation(owners));
    } catch (shutdownError) {
      throw new AggregateError(
        [...activationFailures(error), ...activationFailures(shutdownError)],
        "Open Wrangler activation failed and its initialized owners could not shut down cleanly."
      );
    }
    throw error;
  }
}

async function setNotebookEditorTitleActionContext(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", NOTEBOOK_EDITOR_TITLE_ACTION_CONTEXT, value);
}

export function deactivate(): Promise<void> {
  const state = activationState;
  if (state) {
    activationState = undefined;
    return (state.shutdown ??= beginDeactivation(state.owners));
  }
  return activeDeactivation ?? Promise.resolve();
}

function assertCurrentActivation(state: ActivationState): void {
  if (activationState !== state || state.phase !== "activating") {
    throw new Error("Open Wrangler activation was cancelled before it completed.");
  }
}

function beginDeactivation(owners: LazyActivationOwners): Promise<void> {
  if (activeDeactivation) return activeDeactivation;
  const shutdown = owners.shutdown();
  activeDeactivation = shutdown;
  void shutdown.then(
    () => {
      if (activeDeactivation === shutdown) activeDeactivation = undefined;
    },
    () => {
      if (activeDeactivation === shutdown) activeDeactivation = undefined;
    }
  );
  return shutdown;
}

function activationFailures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(activationFailures) : [error];
}
