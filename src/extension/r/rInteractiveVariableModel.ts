import type * as vscode from "vscode";
import type { RProcessVariableDescriptor } from "./rProcessTransport";

export interface RInteractiveQuickPickItem extends vscode.QuickPickItem {
  readonly variable: RProcessVariableDescriptor;
}

export interface RLiveVariableItem {
  readonly handle: string;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

export type RLiveVariableSnapshot =
  | {
      readonly state: "idle" | "loading" | "empty" | "error";
      readonly terminalLabel: string;
      readonly message: string;
      readonly variables: readonly [];
    }
  | {
      readonly state: "ready";
      readonly terminalLabel: string;
      readonly message: string;
      readonly variables: readonly RLiveVariableItem[];
    };

export function rInteractiveQuickPickItem(variable: RProcessVariableDescriptor): RInteractiveQuickPickItem {
  return {
    label: variable.name,
    description: `R · ${rDataframeFlavorLabel(variable.dataframeFlavor)}`,
    detail: "Active R session",
    variable
  };
}

export function rLiveVariableItem(
  variable: RProcessVariableDescriptor,
  handle: string,
  terminalLabel: string
): RLiveVariableItem {
  return Object.freeze({
    handle,
    label: variable.name,
    description: `R · ${rDataframeFlavorLabel(variable.dataframeFlavor)}`,
    detail: terminalLabel
  });
}

export function idleRLiveVariableSnapshot(
  terminal: Pick<vscode.Terminal, "name"> | undefined,
  isOfficial: boolean
): RLiveVariableSnapshot {
  return {
    state: "idle",
    terminalLabel: isOfficial && terminal ? terminal.name : "R session",
    message: isOfficial
      ? "Dataframes appear here after the R prompt returns."
      : "Select the R terminal that owns the dataframe first.",
    variables: []
  };
}

export function watcherFallbackRLiveVariableSnapshot(terminal: Pick<vscode.Terminal, "name">): RLiveVariableSnapshot {
  return {
    state: "idle",
    terminalLabel: terminal.name,
    message: "Choose Refresh R dataframes.",
    variables: []
  };
}

function rDataframeFlavorLabel(flavor: RProcessVariableDescriptor["dataframeFlavor"]): string {
  switch (flavor) {
    case "r.data.frame":
      return "data.frame";
    case "r.tibble":
      return "tibble";
    case "r.data.table":
      return "data.table";
  }
}
