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

interface ReleasedRKernelRestartTarget extends ReleasedRNotebookKernelTarget {
  readonly routeLabels: readonly string[];
  readonly remote?: Readonly<{
    baseUrl: vscode.Uri;
    token: string;
    runId: string;
    hostname: string;
  }>;
}

interface ReleasedRKernelRestartJourneyDependencies {
  readonly RELEASED_JUPYTER_EXTENSION_VERSION: string;
  readonly RELEASED_JUPYTER_R_KERNEL_CELL: number;
  readonly RELEASED_JUPYTER_R_SETUP_CELL: number;
  readonly assertReleasedRPrivateLibrary: (result: Readonly<Record<string, unknown>>, description: string) => void;
  readonly assertReleasedRVersion: (
    result: Readonly<Record<string, unknown>>,
    target: ReleasedRKernelRestartTarget,
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
  readonly exerciseReleasedRKernelLifecycle: (
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    setup: Readonly<Record<string, unknown>>,
    kernelTarget: ReleasedRKernelRestartTarget,
    phase: "jupyter-r" | "jupyter-r-remote"
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
  readonly recordReleasedRKernelLifecycleCheckpoint: (
    phase: "jupyter-r" | "jupyter-r-remote",
    checkpoint: string
  ) => void;
  readonly releasedJupyterKernelTarget: (phase: "jupyter-r" | "jupyter-r-remote") => ReleasedRKernelRestartTarget;
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
    targetKernel: ReleasedRKernelRestartTarget
  ) => Promise<void>;
  readonly waitForReleasedJupyterConsent: (
    workbench: Page,
    testing: TestApi
  ) => Promise<{ dialog: Locator; allow: Locator; deny: Locator }>;
}

export function createReleasedRKernelRestartJourney({
  RELEASED_JUPYTER_EXTENSION_VERSION,
  RELEASED_JUPYTER_R_KERNEL_CELL,
  RELEASED_JUPYTER_R_SETUP_CELL,
  assertReleasedRPrivateLibrary,
  assertReleasedRVersion,
  bestEffortReleasedJupyterCleanup,
  connectToEditorWorkbench,
  executeReleasedNotebookCell,
  exerciseReleasedRKernelLifecycle,
  getLastAcceptanceProgressCheckpoint,
  notebookCellOutputText,
  recordAcceptanceProgress,
  recordReleasedRAcceptanceSection,
  recordReleasedRKernelLifecycleCheckpoint,
  releasedJupyterKernelTarget,
  releasedNotebookJsonResult,
  selectReleasedJupyterKernel,
  waitForReleasedJupyterConsent
}: ReleasedRKernelRestartJourneyDependencies) {
  async function exerciseReleasedRKernelRestartExtension(
    testing: TestApi,
    extension: vscode.Extension<ExtensionApi>,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile
  ): Promise<void> {
    assert.equal(phase, "jupyter-r", "The focused R kernel-restart journey must use the local Jupyter phase.");
    assert.equal(
      process.env.OPEN_WRANGLER_TEST_SELECTOR,
      "kernel-restart",
      "The minimal R kernel lifecycle profile must be selected explicitly."
    );
    assert.equal(coverage.name, "kernel-restart");
    assert.equal(coverage.coreJourney, false);
    assert.equal(coverage.kernelLifecycle, true);
    recordReleasedRAcceptanceSection(phase, coverage, "notebook", "start");
    assert.equal(testing.diagnostics().sessionCount, 0);
    const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
    assert.equal(jupyterExtension.packageJSON.version, RELEASED_JUPYTER_EXTENSION_VERSION);
    assert.ok(
      !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
      "Native R notebook support must not make Jupyter a hard dependency."
    );

    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-released-jupyter-r-restart-"));
    const notebookPath = path.join(directory, "r-kernel-restart.ipynb");
    const notebookUri = vscode.Uri.file(notebookPath);
    const kernelTarget = releasedJupyterKernelTarget(phase);
    assert.equal(kernelTarget.remote, undefined, "The focused R kernel-restart journey must use hosted R.");
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
      recordReleasedRKernelLifecycleCheckpoint(phase, "fixture-open:start");
      notebook = await vscode.workspace.openNotebookDocument(notebookUri);
      const notebookEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });
      recordReleasedRKernelLifecycleCheckpoint(phase, "fixture-open:complete");
      const workbench = await connectToEditorWorkbench();
      await jupyterExtension.activate();
      await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);
      recordReleasedRKernelLifecycleCheckpoint(phase, "initial-kernel-probe:start");
      await executeReleasedNotebookCell(
        notebook,
        RELEASED_JUPYTER_R_KERNEL_CELL,
        RELEASED_JUPYTER_R_KERNEL_RESULT,
        `${phase}:kernel-restart:initial-kernel-probe`,
        notebookEditor
      );
      recordReleasedRKernelLifecycleCheckpoint(phase, "initial-kernel-probe:complete");
      recordReleasedRKernelLifecycleCheckpoint(phase, "initial-setup:start");
      await executeReleasedNotebookCell(
        notebook,
        RELEASED_JUPYTER_R_SETUP_CELL,
        [RELEASED_JUPYTER_R_SETUP_RESULT, RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX],
        `${phase}:kernel-restart:initial-setup`,
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
      const setup = releasedNotebookJsonResult(setupCell, RELEASED_JUPYTER_R_SETUP_RESULT, "R restart setup");
      assert.deepEqual({ rows: setup.rows, columns: setup.columns }, { rows: 1_205, columns: 25 });
      assertReleasedRVersion(setup, kernelTarget, "R restart setup");
      assertReleasedRPrivateLibrary(setup, "R restart setup");
      assert.equal(setup.collapseVersion, "2.1.7");
      assert.ok(Number.isSafeInteger(Number(setup.pid)) && Number(setup.pid) > 0);
      recordReleasedRKernelLifecycleCheckpoint(phase, "initial-setup:complete");

      recordReleasedRKernelLifecycleCheckpoint(phase, "consent:start");
      const consent = await waitForReleasedJupyterConsent(workbench, testing);
      await consent.allow.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
      recordReleasedRKernelLifecycleCheckpoint(phase, "consent:complete");

      recordReleasedRAcceptanceSection(phase, coverage, "restart", "start");
      await exerciseReleasedRKernelLifecycle(testing, workbench, notebook, setup, kernelTarget, phase);
      recordReleasedRAcceptanceSection(phase, coverage, "restart", "complete");
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

  return exerciseReleasedRKernelRestartExtension;
}
