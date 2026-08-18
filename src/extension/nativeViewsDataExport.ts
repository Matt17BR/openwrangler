import * as vscode from "vscode";
import type { RowAxisExportPolicy } from "../shared/protocol";
import type { ActiveSessionSnapshot, SessionCoordinator } from "./sessionCoordinator";
import { selectNativeExportOptions } from "./nativeViewsExportOptions";

interface NativeViewsDataExportDependencies {
  readonly defaultExportUri: (snapshot: ActiveSessionSnapshot, suffix: string) => vscode.Uri;
  readonly requireTrustedWorkspace: (action: string) => Promise<boolean>;
}

interface SessionExportPin {
  readonly sessionId: string;
  readonly revision: number;
}

export function createNativeViewsDataExport(
  coordinator: SessionCoordinator,
  dependencies: NativeViewsDataExportDependencies
): (sessionId: string, revision: number) => Promise<boolean> {
  const { defaultExportUri, requireTrustedWorkspace } = dependencies;
  return (sessionId, revision) =>
    exportSessionData(coordinator, { sessionId, revision }, defaultExportUri, requireTrustedWorkspace);
}

async function exportSessionData(
  coordinator: SessionCoordinator,
  pin: SessionExportPin,
  defaultExportUri: NativeViewsDataExportDependencies["defaultExportUri"],
  requireTrustedWorkspace: NativeViewsDataExportDependencies["requireTrustedWorkspace"]
): Promise<boolean> {
  if (!(await requireTrustedWorkspace("export cleaned data"))) return false;
  const initial = pinnedExportSnapshot(coordinator, pin);
  if (!initial) return false;
  const backend = initial.metadata.backend;
  if (initial.metadata.draftStep) {
    void vscode.window.showWarningMessage("Apply or discard the draft step before exporting cleaned data.");
    return false;
  }
  const choices = [
    initial.metadata.capabilities.exportCsv
      ? { label: "CSV", description: "Delimited text", format: "csv" as const }
      : undefined,
    initial.metadata.capabilities.exportParquet
      ? { label: "Parquet", description: "Typed columnar data", format: "parquet" as const }
      : undefined
  ].filter((choice): choice is NonNullable<typeof choice> => Boolean(choice));
  if (!choices.length) {
    void vscode.window.showWarningMessage("This dataframe does not support cleaned-data export.");
    return false;
  }
  const selected = await vscode.window.showQuickPick(choices, {
    title: "Export Cleaned Data",
    placeHolder: "Choose a file format"
  });
  if (!selected) return false;
  const confirmedBeforePolicy = pinnedExportSnapshot(coordinator, pin);
  if (!confirmedBeforePolicy || confirmedBeforePolicy.metadata.draftStep) {
    if (confirmedBeforePolicy?.metadata.draftStep) {
      void vscode.window.showWarningMessage("Apply or discard the draft step before exporting cleaned data.");
    }
    return false;
  }
  if (!hasSameExportBackend(confirmedBeforePolicy, backend)) return false;
  const rowAxisPolicy = await selectPandasRowAxisExportPolicy(confirmedBeforePolicy);
  if (confirmedBeforePolicy.metadata.backend === "pandas" && rowAxisPolicy === undefined) return false;
  const confirmedBeforeOptions = pinnedExportSnapshot(coordinator, pin);
  if (!confirmedBeforeOptions || confirmedBeforeOptions.metadata.draftStep) {
    if (confirmedBeforeOptions?.metadata.draftStep) {
      void vscode.window.showWarningMessage("Apply or discard the draft step before exporting cleaned data.");
    }
    return false;
  }
  if (!hasSameExportBackend(confirmedBeforeOptions, backend)) return false;
  const exportOptions = await selectNativeExportOptions(confirmedBeforeOptions, selected.format, rowAxisPolicy);
  if (!exportOptions) return false;
  const confirmedBeforeSave = pinnedExportSnapshot(coordinator, pin);
  if (!confirmedBeforeSave || confirmedBeforeSave.metadata.draftStep) {
    if (confirmedBeforeSave?.metadata.draftStep) {
      void vscode.window.showWarningMessage("Apply or discard the draft step before exporting cleaned data.");
    }
    return false;
  }
  if (!hasSameExportBackend(confirmedBeforeSave, backend)) return false;
  const stillSupported =
    selected.format === "csv"
      ? confirmedBeforeSave.metadata.capabilities.exportCsv
      : confirmedBeforeSave.metadata.capabilities.exportParquet;
  if (!stillSupported) {
    void vscode.window.showWarningMessage("The selected export format is no longer available for this dataframe.");
    return false;
  }
  const extension = selected.format === "csv" ? ".cleaned.csv" : ".cleaned.parquet";
  const destination = await vscode.window.showSaveDialog({
    title: "Export Cleaned Data",
    defaultUri: defaultExportUri(confirmedBeforeSave, extension),
    filters: selected.format === "csv" ? { CSV: ["csv"] } : { Parquet: ["parquet"] },
    saveLabel: "Export data"
  });
  if (!destination) return false;
  if (destination.scheme !== "file") {
    void vscode.window.showErrorMessage("Cleaned-data export currently requires a file-system destination.");
    return false;
  }
  if (!(await requireTrustedWorkspace("export cleaned data"))) return false;
  const confirmedBeforeDispatch = pinnedExportSnapshot(coordinator, pin);
  if (!confirmedBeforeDispatch || confirmedBeforeDispatch.metadata.draftStep) {
    if (confirmedBeforeDispatch?.metadata.draftStep) {
      void vscode.window.showWarningMessage("Apply or discard the draft step before exporting cleaned data.");
    }
    return false;
  }
  const dispatchSupported =
    selected.format === "csv"
      ? confirmedBeforeDispatch.metadata.capabilities.exportCsv
      : confirmedBeforeDispatch.metadata.capabilities.exportParquet;
  if (!dispatchSupported) {
    void vscode.window.showWarningMessage("The selected export format is no longer available for this dataframe.");
    return false;
  }
  if (!hasSameExportBackend(confirmedBeforeDispatch, backend)) return false;
  try {
    const exported = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Exporting cleaned data…", cancellable: false },
      () => coordinator.exportData(pin.sessionId, pin.revision, destination.fsPath, exportOptions)
    );
    void vscode.window.showInformationMessage(
      `Exported ${exported.shape.rows.toLocaleString()} rows × ${exported.shape.columns.toLocaleString()} columns to ${exported.path}.`
    );
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function hasSameExportBackend(
  snapshot: ActiveSessionSnapshot,
  backend: ActiveSessionSnapshot["metadata"]["backend"]
): boolean {
  if (snapshot.metadata.backend === backend) return true;
  void vscode.window.showWarningMessage(
    "The dataframe backend changed while export was open. Review the current data and try again."
  );
  return false;
}

async function selectPandasRowAxisExportPolicy(
  snapshot: ActiveSessionSnapshot
): Promise<RowAxisExportPolicy | undefined> {
  if (snapshot.metadata.backend !== "pandas") return undefined;
  const rowAxis = snapshot.metadata.rowAxis;
  if (!rowAxis) {
    void vscode.window.showWarningMessage("The Pandas session did not provide row-index metadata for export.");
    return undefined;
  }
  const defaultPolicy: RowAxisExportPolicy = rowAxis.kind === "positional" ? "omit" : "preserve";
  const choices = (
    [
      {
        label: "Preserve index",
        description: "Write the Pandas index to the exported file",
        policy: "preserve" as const
      },
      {
        label: "Omit index",
        description: "Export only ordinary dataframe columns",
        policy: "omit" as const
      }
    ] satisfies Array<{
      label: string;
      description: string;
      policy: RowAxisExportPolicy;
    }>
  ).sort((left, right) => Number(right.policy === defaultPolicy) - Number(left.policy === defaultPolicy));
  const selected = await vscode.window.showQuickPick(choices, {
    title: "Export Pandas Index",
    placeHolder: "Choose whether to preserve the dataframe index"
  });
  return selected?.policy;
}

function pinnedExportSnapshot(
  coordinator: SessionCoordinator,
  pin: SessionExportPin
): ActiveSessionSnapshot | undefined {
  const snapshot = coordinator.sessionSnapshot(pin.sessionId);
  if (!snapshot) {
    void vscode.window.showWarningMessage("The dataframe that started this export is no longer open.");
    return undefined;
  }
  if (snapshot.metadata.revision !== pin.revision) {
    void vscode.window.showWarningMessage(
      "The dataframe changed while export was open. Review the current data and try again."
    );
    return undefined;
  }
  return snapshot;
}
