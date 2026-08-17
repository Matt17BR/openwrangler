import type { SessionMetadata, SessionMode } from "./protocol";

export interface SessionModeAction {
  target: SessionMode;
  label: string;
  title: string;
  disabledReason?: string;
}

export function isLiveSessionModeSwitchSource(metadata: SessionMetadata): boolean {
  if (metadata.backend === "pyspark") return false;
  if (metadata.source.kind === "notebookVariable") return metadata.capabilities.notebookInsert;
  return (
    metadata.source.kind === "rInteractiveVariable" &&
    metadata.backend === "r" &&
    !metadata.capabilities.notebookInsert &&
    metadata.capabilities.documentInsert !== true
  );
}

export function canRequestLiveSessionMode(metadata: SessionMetadata, target: SessionMode): boolean {
  if (metadata.mode === target || !isLiveSessionModeSwitchSource(metadata)) return false;
  return target === "editing" || (metadata.steps.length === 0 && metadata.draftStep === undefined);
}

export function sessionModeAction(metadata: SessionMetadata): SessionModeAction | undefined {
  if (!isLiveSessionModeSwitchSource(metadata)) return undefined;
  if (metadata.mode === "viewing") {
    return {
      target: "editing",
      label: "Switch to Editing",
      title: "Reopen this live dataframe in Editing mode"
    };
  }
  const disabledReason = viewingModeBlockedReason(metadata);
  return {
    target: "viewing",
    label: "Switch to Viewing",
    title: disabledReason ?? "Reopen this live dataframe in Viewing mode",
    ...(disabledReason ? { disabledReason } : {})
  };
}

export function sessionModeLabel(metadata: SessionMetadata): string {
  return metadata.mode === "viewing" && isPermanentlyReadOnly(metadata) ? "Viewing only" : metadata.mode;
}

export function sessionModeDescription(metadata: SessionMetadata): string {
  if (metadata.mode === "editing") {
    const editingDescription = "Editing builds a separate cleaning plan. Open Wrangler keeps the source unchanged.";
    if (!isLiveSessionModeSwitchSource(metadata)) return editingDescription;
    const blockedReason = viewingModeBlockedReason(metadata);
    return [editingDescription, blockedReason ?? "Switch to Viewing to return to read-only exploration."].join(" ");
  }
  if (metadata.backend === "pyspark") {
    return "Open Wrangler supports read-only exploration of live PySpark dataframes. Cleaning steps, generated code, and data export are not available. Filters and sorts change only the current view.";
  }
  if (metadata.backend === "duckdb" && metadata.source.kind === "notebookVariable") {
    return "Open Wrangler supports read-only exploration of live DuckDB notebook relations. Cleaning steps, code insertion, and data export are not available. Filters and sorts change only the current view.";
  }
  if (metadata.source.kind === "notebookOutput") {
    return "This is a saved notebook snapshot, not a live dataframe. Rerun the cell and open its live variable to build a cleaning plan.";
  }
  if (isLiveSessionModeSwitchSource(metadata)) {
    return "Viewing lets you explore this live dataframe without creating a cleaning plan. Filters and sorts change only the current view, and the source stays unchanged. Switch to Editing to build a cleaning plan.";
  }
  return "Viewing lets you explore this dataframe without creating a cleaning plan. Filters and sorts change only the current view, and the source stays unchanged. Reopen it in Editing mode to build a cleaning plan.";
}

export function cleaningUnavailableReason(metadata: SessionMetadata): string {
  if (metadata.mode === "editing") {
    return metadata.draftStep
      ? "Apply or discard the current draft before adding another cleaning step."
      : "Cleaning steps are available in Editing mode.";
  }
  if (isLiveSessionModeSwitchSource(metadata)) {
    return "Switch to Editing in the dataframe toolbar to add cleaning steps.";
  }
  if (metadata.backend === "pyspark") {
    return "Live PySpark dataframes are viewing only in Open Wrangler; cleaning steps are not available.";
  }
  if (metadata.backend === "duckdb" && metadata.source.kind === "notebookVariable") {
    return "Live DuckDB notebook relations are viewing only in Open Wrangler; cleaning steps are not available.";
  }
  if (metadata.source.kind === "notebookOutput") {
    return "Saved notebook snapshots are viewing only. Rerun the cell and open its live variable to add cleaning steps.";
  }
  return "Reopen this dataframe in Editing mode to add cleaning steps.";
}

function viewingModeBlockedReason(metadata: SessionMetadata): string | undefined {
  if (metadata.mode !== "editing") return undefined;
  const appliedSteps = metadata.steps.length;
  if (metadata.draftStep && appliedSteps > 0) {
    return `Discard the current draft, then undo ${appliedSteps === 1 ? "the applied step" : `all ${appliedSteps} applied steps`} before switching to Viewing.`;
  }
  if (metadata.draftStep) return "Discard the current draft before switching to Viewing.";
  if (appliedSteps > 0) {
    return `Undo ${appliedSteps === 1 ? "the applied step" : `all ${appliedSteps} applied steps`} before switching to Viewing.`;
  }
  return undefined;
}

function isPermanentlyReadOnly(metadata: SessionMetadata): boolean {
  return (
    metadata.backend === "pyspark" ||
    (metadata.backend === "duckdb" && metadata.source.kind === "notebookVariable") ||
    metadata.source.kind === "notebookOutput"
  );
}
