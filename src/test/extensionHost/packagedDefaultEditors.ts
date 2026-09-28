import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import * as vscode from "vscode";
import { customEditorTabDiagnostic, findExactCustomEditorTab } from "./customEditorTabs";
import type { TestApi } from "./extensionHostTestApi";

export interface PackagedDefaultEditorsDependencies {
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly sessionOpenTimeoutMs: number;
}

export async function exercisePackagedDefaultEditors(
  testing: TestApi,
  workspace: vscode.Uri,
  python: string,
  { recordAcceptanceProgress, waitFor, sessionOpenTimeoutMs }: PackagedDefaultEditorsDependencies
): Promise<void> {
  const workbench = vscode.workspace.getConfiguration("workbench");
  const associations = workbench.inspect<Record<string, string>>("editorAssociations");
  assert.deepEqual(
    [associations?.globalValue, associations?.workspaceValue, associations?.workspaceFolderValue],
    [undefined, undefined, undefined],
    "Default-editor acceptance requires a profile and workspace without editor associations."
  );
  // The outer runner removes these sources after editor and runtime settlement.
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-default-editors-"));
  execFileSync(
    python,
    [
      "-c",
      [
        "import sys",
        "from pathlib import Path",
        "import polars as pl",
        "from openpyxl import Workbook",
        "root = Path(sys.argv[1])",
        "pl.DataFrame({'name': ['alpha', 'beta'], 'value': [1, 2]}).write_parquet(root / 'default.parquet')",
        "workbook = Workbook()",
        "workbook.active.append(['name', 'value'])",
        "workbook.active.append(['alpha', 1])",
        "workbook.save(root / 'default.xlsx')"
      ].join("\n"),
      directory
    ],
    { encoding: "utf8" }
  );
  writeFileSync(
    path.join(directory, "default.xls"),
    gunzipSync(
      Buffer.from(
        readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "legacy.xls.gz.base64").fsPath, "utf8").trim(),
        "base64"
      )
    )
  );
  writeFileSync(path.join(directory, "default.csv"), "name,value\nalpha,1\n");

  for (const name of ["default.parquet", "default.xlsx", "default.xls"]) {
    const uri = vscode.Uri.file(path.join(directory, name));
    recordAcceptanceProgress(`default-editor:${path.extname(name).slice(1)}`);
    await vscode.commands.executeCommand("vscode.open", uri, { preview: false, viewColumn: vscode.ViewColumn.One });
    await waitFor(
      () =>
        testing.activeSession()?.metadata.source.path === uri.fsPath &&
        findExactCustomEditorTab<vscode.Tab>(vscode.window.tabGroups.all, "openWrangler.viewer", uri.toString()) !==
          undefined,
      sessionOpenTimeoutMs,
      `${name} to open in Open Wrangler without an editor association`,
      () =>
        JSON.stringify({
          tabs: customEditorTabDiagnostic(vscode.window.tabGroups.all, "openWrangler.viewer", uri.toString()),
          sessionCount: testing.diagnostics().sessionCount
        })
    );
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the default-editor sessions to close"
  );

  const opensInTextEditor = async (uri: vscode.Uri, reason: string): Promise<void> => {
    await vscode.commands.executeCommand("vscode.open", uri, { preview: false, viewColumn: vscode.ViewColumn.One });
    await waitFor(
      () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputText && input.uri.toString() === uri.toString();
      },
      10_000,
      `${reason} to open ${path.basename(uri.fsPath)} in the text editor`
    );
    const customTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType.startsWith("openWrangler.") &&
          tab.input.uri.toString() === uri.toString()
      );
    assert.equal(customTabs.length, 0, `${reason} must not also open Open Wrangler.`);
    assert.equal(testing.diagnostics().sessionCount, 0, `${reason} must not open a session.`);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  };

  recordAcceptanceProgress("default-editor:csv");
  await opensInTextEditor(vscode.Uri.file(path.join(directory, "default.csv")), "No editor association");

  recordAcceptanceProgress("default-editor:association");
  await workbench.update("editorAssociations", { "*.parquet": "default" }, vscode.ConfigurationTarget.Global);
  try {
    await opensInTextEditor(
      vscode.Uri.file(path.join(directory, "default.parquet")),
      "An explicit text-editor association"
    );
  } finally {
    await workbench.update("editorAssociations", undefined, vscode.ConfigurationTarget.Global);
  }
}
