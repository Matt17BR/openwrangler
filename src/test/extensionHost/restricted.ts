import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { ACCEPTANCE_PROGRESS_PROTOCOL, writeAcceptanceProgressCheckpoint } from "./progress";

export async function run(): Promise<void> {
  recordAcceptanceProgress("restricted:start");
  assert.equal(
    vscode.workspace.isTrusted,
    false,
    "The dedicated packaged-editor profile must open the fixture workspace in Restricted Mode."
  );

  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, "The Restricted Mode acceptance workspace must be open.");
  assert.equal(
    workspace.uri.scheme,
    "file",
    "Restricted Mode acceptance must use the isolated local fixture workspace."
  );

  const extension = vscode.extensions.getExtension("matt17br.openwrangler");
  if (extension) {
    assert.equal(
      extension.packageJSON.capabilities?.untrustedWorkspaces?.supported,
      false,
      "Any exposed Open Wrangler package metadata must declare that Python-backed work is unavailable in untrusted workspaces."
    );
    assert.equal(
      extension.isActive,
      false,
      "Open Wrangler must remain disabled in Restricted Mode, with no coordinator or runtime."
    );
    assert.equal(
      extension.exports,
      undefined,
      "Restricted Mode must not publish the Open Wrangler test API or any live session/runtime coordinator."
    );
  }
  recordAcceptanceProgress("restricted:file-entry-point");
  const fileCommandIsAvailable = (await vscode.commands.getCommands(true)).includes("openWrangler.openFile");
  const fixture = vscode.Uri.joinPath(workspace.uri, "fixtures", "sample.csv");
  let commandSettled = false;
  if (fileCommandIsAvailable) {
    await Promise.race([
      vscode.commands.executeCommand("openWrangler.openFile", fixture).then(
        () => {
          commandSettled = true;
        },
        () => {
          commandSettled = true;
        }
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000))
    ]);
    assert.equal(
      commandSettled,
      true,
      "The blocked Open Wrangler file entry point must settle without waiting for a hidden trust prompt."
    );
  }
  const extensionAfterEntryPoint = vscode.extensions.getExtension("matt17br.openwrangler");
  assert.equal(
    extensionAfterEntryPoint?.isActive ?? false,
    false,
    "Invoking Open in Open Wrangler must not activate the installed extension in Restricted Mode."
  );
  assert.equal(
    extensionAfterEntryPoint?.exports,
    undefined,
    "The blocked or unavailable file entry point must not create a coordinator, session, or Python runtime."
  );
  recordAcceptanceProgress("restricted:pyspark-entry-point");
  const variableCommandIsAvailable = (await vscode.commands.getCommands(true)).includes(
    "openWrangler.launchDataViewer"
  );
  let variableCommandSettled = false;
  if (variableCommandIsAvailable) {
    await Promise.race([
      vscode.commands
        .executeCommand("openWrangler.launchDataViewer", {
          name: "spark_frame",
          type: "pyspark.sql.classic.dataframe.DataFrame",
          fileName: vscode.Uri.joinPath(workspace.uri, "fixtures", "example.ipynb")
        })
        .then(
          () => {
            variableCommandSettled = true;
          },
          () => {
            variableCommandSettled = true;
          }
        ),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000))
    ]);
    assert.equal(
      variableCommandSettled,
      true,
      "The blocked PySpark variable entry point must settle without waiting for a hidden trust prompt."
    );
  }
  const extensionAfterVariableEntryPoint = vscode.extensions.getExtension("matt17br.openwrangler");
  assert.equal(
    extensionAfterVariableEntryPoint?.isActive ?? false,
    false,
    "Invoking the PySpark Variables action must not activate Open Wrangler in Restricted Mode."
  );
  assert.equal(
    extensionAfterVariableEntryPoint?.exports,
    undefined,
    "The blocked PySpark Variables action must not create a coordinator, session, or runtime."
  );
  recordAcceptanceProgress("restricted:activation-blocked");
  assert.equal(
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .some((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === "openWrangler.viewer"),
    false,
    "Restricted Mode must not create an Open Wrangler dataframe session tab."
  );

  recordAcceptanceProgress("restricted:complete");
  console.log("Open Wrangler Restricted Mode acceptance passed.");
}

function recordAcceptanceProgress(checkpoint: string): void {
  const progressPath = process.env.OPEN_WRANGLER_TEST_PROGRESS;
  if (!progressPath) return;
  const runId = process.env.OPEN_WRANGLER_TEST_RUN_ID;
  const phase = process.env.OPEN_WRANGLER_TEST_PHASE;
  if (!runId || !phase) {
    throw new Error("Editor acceptance progress requires the launched run ID and phase.");
  }
  writeAcceptanceProgressCheckpoint(progressPath, {
    protocol: ACCEPTANCE_PROGRESS_PROTOCOL,
    runId,
    phase,
    checkpoint
  });
}
