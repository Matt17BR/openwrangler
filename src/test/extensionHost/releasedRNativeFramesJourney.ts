import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Jupyter } from "@vscode/jupyter-extension";
import type { Locator, Page } from "playwright-core";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import type { ExtensionApi, TestApi } from "./extensionHostTestApi";
import { failedAcceptanceProgressCheckpoint } from "./progress";
import type { ReleasedRAcceptanceCoverageProfile } from "./releasedRAcceptanceCoverage";
import {
  RELEASED_JUPYTER_R_KERNEL_RESULT,
  RELEASED_JUPYTER_R_SETUP_RESULT,
  writeReleasedRNotebook,
  type ReleasedRNotebookKernelTarget
} from "./releasedDocumentFixtures";
import {
  RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX,
  releasedNotebookRSetupFailureStage
} from "./releasedNotebookFailure";

interface ReleasedRNativeFramesKernelTarget extends ReleasedRNotebookKernelTarget {
  readonly routeLabels: readonly string[];
  readonly remote?: Readonly<{
    baseUrl: vscode.Uri;
    token: string;
    runId: string;
    hostname: string;
  }>;
}

interface ReleasedRNativeFramesJourneyDependencies {
  readonly RELEASED_JUPYTER_EXTENSION_VERSION: string;
  readonly RELEASED_JUPYTER_R_KERNEL_CELL: number;
  readonly RELEASED_JUPYTER_R_SETUP_CELL: number;
  readonly assertReleasedRPrivateLibrary: (result: Readonly<Record<string, unknown>>, description: string) => void;
  readonly assertReleasedRVersion: (
    result: Readonly<Record<string, unknown>>,
    target: ReleasedRNativeFramesKernelTarget,
    description: string
  ) => void;
  readonly bestEffortReleasedJupyterCleanup: (
    testing: TestApi,
    notebook: vscode.NotebookDocument | undefined,
    phase: "jupyter-r" | "jupyter-r-remote"
  ) => Promise<void>;
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly executeReleasedNotebookCell: (
    notebook: vscode.NotebookDocument,
    index: number,
    expectedText: string | readonly string[] | undefined,
    checkpoint: string,
    expectedEditor?: vscode.NotebookEditor,
    failureDiagnostic?: "r-setup"
  ) => Promise<void>;
  readonly exerciseReleasedRCollapseFrameSessions: (
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile
  ) => Promise<void>;
  readonly exerciseReleasedRNativeFrameSessions: (
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    configuration: vscode.WorkspaceConfiguration,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile
  ) => Promise<void>;
  readonly getLastAcceptanceProgressCheckpoint: () => string | undefined;
  readonly notebookCellOutputText: (cell: vscode.NotebookCell) => string;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly recordReleasedRAcceptanceSection: (
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    section: string,
    boundary: "start" | "complete"
  ) => void;
  readonly recordReleasedRNativeFrameCheckpoint: (
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    frame: string,
    checkpoint: string
  ) => void;
  readonly releasedJupyterKernelTarget: (phase: "jupyter-r" | "jupyter-r-remote") => ReleasedRNativeFramesKernelTarget;
  readonly releasedNotebookJsonResult: (
    cell: vscode.NotebookCell,
    marker: string,
    description: string
  ) => Record<string, unknown>;
  readonly selectReleasedJupyterKernel: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    phase: "jupyter-r" | "jupyter-r-remote",
    targetKernel: ReleasedRNativeFramesKernelTarget
  ) => Promise<void>;
  readonly showExactReleasedNotebook: (notebook: vscode.NotebookDocument) => Promise<vscode.NotebookEditor>;
  readonly waitForReleasedJupyterConsent: (
    workbench: Page,
    testing: TestApi
  ) => Promise<{ dialog: Locator; allow: Locator; deny: Locator }>;
  readonly waitForReleasedRRuntimeBindingCleanup: (
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    phase: "jupyter-r" | "jupyter-r-remote"
  ) => Promise<void>;
}

export function createReleasedRNativeFramesJourney({
  RELEASED_JUPYTER_EXTENSION_VERSION,
  RELEASED_JUPYTER_R_KERNEL_CELL,
  RELEASED_JUPYTER_R_SETUP_CELL,
  assertReleasedRPrivateLibrary,
  assertReleasedRVersion,
  bestEffortReleasedJupyterCleanup,
  connectToEditorWorkbench,
  executeReleasedNotebookCell,
  exerciseReleasedRCollapseFrameSessions,
  exerciseReleasedRNativeFrameSessions,
  getLastAcceptanceProgressCheckpoint,
  notebookCellOutputText,
  recordAcceptanceProgress,
  recordReleasedRAcceptanceSection,
  recordReleasedRNativeFrameCheckpoint,
  releasedJupyterKernelTarget,
  releasedNotebookJsonResult,
  selectReleasedJupyterKernel,
  showExactReleasedNotebook,
  waitForReleasedJupyterConsent,
  waitForReleasedRRuntimeBindingCleanup
}: ReleasedRNativeFramesJourneyDependencies) {
  async function exerciseReleasedRNativeFramesExtension(
    testing: TestApi,
    extension: vscode.Extension<ExtensionApi>,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile
  ): Promise<void> {
    assert.equal(phase, "jupyter-r", "The focused native R-frame journey must use the local Jupyter phase.");
    assert.equal(
      process.env.OPEN_WRANGLER_TEST_SELECTOR,
      "native-frames",
      "The native R-frame coverage profile must be selected explicitly."
    );
    assert.equal(coverage.name, "native-frames");
    assert.equal(coverage.coreJourney, false);
    assert.equal(coverage.kernelLifecycle, false);
    assert.notEqual(coverage.nativeFrameEditing, "none");
    recordReleasedRAcceptanceSection(phase, coverage, "notebook", "start");
    assert.equal(testing.diagnostics().sessionCount, 0);
    const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
    assert.equal(jupyterExtension.packageJSON.version, RELEASED_JUPYTER_EXTENSION_VERSION);
    assert.ok(
      !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
      "Native R notebook support must not make Jupyter a hard dependency."
    );

    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-released-jupyter-r-native-frames-"));
    const notebookPath = path.join(directory, "r-native-frames.ipynb");
    const notebookUri = vscode.Uri.file(notebookPath);
    const kernelTarget = releasedJupyterKernelTarget(phase);
    assert.equal(kernelTarget.remote, undefined, "The focused native R-frame journey must use hosted R.");
    writeReleasedRNotebook(notebookPath, phase, releasedJupyterKernelTarget(phase));
    const configuration = vscode.workspace.getConfiguration("openWrangler");
    const originalProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
      "notebookPreviewProvider"
    )?.workspaceValue;
    const originalNotebookStartMode = configuration.inspect<"viewing" | "editing">("notebookStartMode")?.workspaceValue;
    let notebook: vscode.NotebookDocument | undefined;
    let acceptanceError: { readonly value: unknown } | undefined;
    let failureCheckpoint: string | undefined;
    try {
      await configuration.update("notebookPreviewProvider", "disabled", vscode.ConfigurationTarget.Workspace);
      await configuration.update("notebookStartMode", "viewing", vscode.ConfigurationTarget.Workspace);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "open:start");
      notebook = await vscode.workspace.openNotebookDocument(notebookUri);
      const notebookEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });
      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "open:complete");
      const workbench = await connectToEditorWorkbench();
      await jupyterExtension.activate();
      await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "kernel-probe:start");
      await executeReleasedNotebookCell(
        notebook,
        RELEASED_JUPYTER_R_KERNEL_CELL,
        RELEASED_JUPYTER_R_KERNEL_RESULT,
        `${phase}:native-frames:kernel-probe`,
        notebookEditor
      );
      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "kernel-probe:complete");
      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "setup:start");
      await executeReleasedNotebookCell(
        notebook,
        RELEASED_JUPYTER_R_SETUP_CELL,
        [RELEASED_JUPYTER_R_SETUP_RESULT, RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX],
        `${phase}:native-frames:setup`,
        notebookEditor,
        "r-setup"
      );
      const setupCell = notebook.cellAt(RELEASED_JUPYTER_R_SETUP_CELL);
      const setupFailureStage = releasedNotebookRSetupFailureStage(setupCell.outputs);
      if (setupFailureStage !== undefined) {
        throw new Error(`Released-Jupyter R setup failed at stage ${setupFailureStage}.`);
      }
      if (!notebookCellOutputText(setupCell).includes(RELEASED_JUPYTER_R_SETUP_RESULT)) {
        throw new Error("Released-Jupyter R setup returned a malformed fixed diagnostic.");
      }
      const setup = releasedNotebookJsonResult(setupCell, RELEASED_JUPYTER_R_SETUP_RESULT, "native R-frame setup");
      assert.deepEqual({ rows: setup.rows, columns: setup.columns }, { rows: 1_205, columns: 25 });
      assertReleasedRVersion(setup, kernelTarget, "native R-frame setup");
      assertReleasedRPrivateLibrary(setup, "native R-frame setup");
      assert.equal(setup.collapseVersion, "2.1.7");
      assert.ok(Number.isSafeInteger(Number(setup.pid)) && Number(setup.pid) > 0);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "setup:complete");

      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "consent:start");
      const consent = await waitForReleasedJupyterConsent(workbench, testing);
      await consent.allow.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "consent:complete");

      await exerciseReleasedRCollapseFrameSessions(testing, workbench, notebook, phase, coverage);
      await exerciseReleasedRNativeFrameSessions(testing, workbench, notebook, configuration, phase, coverage);
      assert.equal(
        testing.diagnostics().sessionCount,
        0,
        "The focused native R-frame journey must close every session."
      );
      const cleanupEditor = await showExactReleasedNotebook(notebook);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "binding-cleanup:start");
      await waitForReleasedRRuntimeBindingCleanup(notebook, cleanupEditor, phase);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, "fixture", "binding-cleanup:complete");
    } catch (error) {
      failureCheckpoint = failedAcceptanceProgressCheckpoint(phase, getLastAcceptanceProgressCheckpoint());
      acceptanceError = { value: error };
    } finally {
      try {
        await configuration.update(
          "notebookStartMode",
          originalNotebookStartMode,
          vscode.ConfigurationTarget.Workspace
        );
      } catch (error) {
        acceptanceError ??= { value: error };
      }
      try {
        await configuration.update("notebookPreviewProvider", originalProvider, vscode.ConfigurationTarget.Workspace);
      } catch (error) {
        acceptanceError ??= { value: error };
      }
      try {
        await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
      } catch (error) {
        acceptanceError ??= { value: error };
      }
      try {
        cleanupAcceptanceTemporaryDirectory(directory);
      } catch (error) {
        acceptanceError ??= { value: error };
      }
      if (failureCheckpoint) recordAcceptanceProgress(failureCheckpoint);
    }
    if (acceptanceError) throw acceptanceError.value;
    recordReleasedRAcceptanceSection(phase, coverage, "notebook", "complete");
  }

  return exerciseReleasedRNativeFramesExtension;
}
