import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { insertGeneratedNotebookCell } from "../../extension/notebooks/notebookInsertion";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("matt17br.data-explorer");
  assert.ok(extension, "The Data Explorer extension must be discoverable.");
  await extension.activate();
  assert.equal(extension.isActive, true, "The extension must activate successfully.");
  assert.equal(extension.packageJSON.publisher, "Matt17BR");
  assert.equal(extension.packageJSON.icon, "media/icon.png");
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "icon.png"));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "activity-icon.svg"));
  const testPython = process.env.DATA_EXPLORER_TEST_PYTHON;
  if (testPython) {
    await vscode.workspace
      .getConfiguration("dataExplorer")
      .update("pythonPath", testPython, vscode.ConfigurationTarget.Global);
  }

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "dataExplorer.openPath",
    "dataExplorer.openFile",
    "dataExplorer.launchDataViewer",
    "dataExplorer.openNotebookVariable",
    "dataExplorer.checkJupyterIntegration",
    "dataExplorer.changeRuntime",
    "dataExplorer.clearRuntime",
    "dataExplorer.installRuntimeDependencies",
    "dataExplorer.startOperation",
    "dataExplorer.applyStep",
    "dataExplorer.discardStep",
    "dataExplorer.editLatestStep",
    "dataExplorer.undoStep",
    "dataExplorer.copyCode",
    "dataExplorer.exportCode",
    "dataExplorer.insertNotebookCode",
    "dataExplorer.exportData",
    "dataExplorer.openSourceFile",
    "dataExplorer.openWalkthrough",
    "dataExplorer.openSettings",
    "dataExplorer.reportIssue"
  ]) {
    assert.ok(commands.includes(command), `Expected registered command: ${command}`);
  }

  const contributions = extension.packageJSON.contributes as {
    viewsContainers?: { activitybar?: Array<{ id?: string; icon?: string }> };
    views?: Record<string, Array<{ id?: string }>>;
    configuration?: { properties?: Record<string, unknown> };
    notebookRenderer?: Array<{ mimeTypes?: string[] }>;
  };
  assert.ok(
    contributions.viewsContainers?.activitybar?.some(
      (container) => container.id === "dataExplorer" && container.icon === "media/activity-icon.svg"
    )
  );
  assert.deepEqual(
    contributions.views?.dataExplorer?.map((view) => view.id),
    ["dataExplorer.operations", "dataExplorer.summary", "dataExplorer.filters", "dataExplorer.cleaningSteps"]
  );
  assert.ok(contributions.configuration?.properties?.["dataExplorer.fetchBlockSize"]);
  assert.ok(contributions.configuration?.properties?.["dataExplorer.filterMode"]);
  assert.deepEqual(contributions.notebookRenderer?.[0]?.mimeTypes, [
    "application/vnd.data-explorer.viewer.v1+json",
    "application/vnd.data-explorer.viewer.v2+json"
  ]);
  assert.ok(
    extension.packageJSON.contributes.walkthroughs?.some(
      (walkthrough: { id?: string }) => walkthrough.id === "gettingStarted"
    )
  );

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "The extension-host fixture workspace must be open.");
  const fixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.csv");
  await vscode.commands.executeCommand("vscode.openWith", fixture, "dataExplorer.viewer", vscode.ViewColumn.One);
  await waitFor(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.viewType === "dataExplorer.viewer";
  }, 10_000);

  const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(activeInput instanceof vscode.TabInputCustom);
  assert.equal(activeInput.viewType, "dataExplorer.viewer");
  assert.equal(path.basename(activeInput.uri.fsPath), "sample.csv");
  await vscode.commands.executeCommand("dataExplorer.openSourceFile");
  await waitFor(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
  }, 15_000);
  const sourceInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(sourceInput instanceof vscode.TabInputText, "Open Source File must resolve the active runtime session.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  const notebook = await vscode.workspace.openNotebookDocument(
    "jupyter-notebook",
    new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "value = 1", "python")])
  );
  const inserted = await insertGeneratedNotebookCell(notebook, 1, "def clean_data(df):\n    return df\n", {
    source: "df",
    backend: "polars"
  });
  assert.equal(inserted, true);
  assert.equal(notebook.cellCount, 2);
  assert.equal(notebook.cellAt(1).document.getText(), "def clean_data(df):\n    return df\n");
  assert.deepEqual(notebook.cellAt(1).metadata.dataExplorer, {
    source: "df",
    backend: "polars",
    generated: true
  });

  console.log("Data Explorer extension-host acceptance passed.");
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the Data Explorer custom editor.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
