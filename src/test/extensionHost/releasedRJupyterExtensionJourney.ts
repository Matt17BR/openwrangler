import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Jupyter, JupyterServerCollection } from "@vscode/jupyter-extension";
import type { Page } from "playwright-core";
import { supportsRDocumentExecution } from "../../extension/r/rDocumentCommands";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import {
  RELEASED_JUPYTER_R_KERNEL_RESULT,
  RELEASED_JUPYTER_R_SETUP_RESULT,
  writeReleasedRNotebook
} from "./releasedDocumentFixtures";
import type { ExtensionApi, TestApi } from "./extensionHostTestApi";
import {
  RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX,
  releasedNotebookRSetupFailureStage
} from "./releasedNotebookFailure";
import type { ReleasedRAcceptanceCoverageProfile } from "./releasedRAcceptanceCoverage";
import { failedAcceptanceProgressCheckpoint } from "./progress";

type ReleasedRActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;

interface ReleasedJupyterKernelTarget {
  readonly label: string;
  readonly name: string;
  readonly routeLabels: readonly string[];
  readonly remote?: {
    readonly baseUrl: vscode.Uri;
    readonly token: string;
    readonly runId: string;
    readonly hostname: string;
  };
}

interface ReleasedRJupyterExtensionJourneyDependencies {
  readonly RELEASED_JUPYTER_EXTENSION_VERSION: string;
  readonly RELEASED_JUPYTER_R_KERNEL_CELL: number;
  readonly RELEASED_JUPYTER_R_SETUP_CELL: number;
  readonly assertReleasedRPrivateLibrary: (result: Readonly<Record<string, unknown>>, description: string) => void;
  readonly assertReleasedRRuntimeBinding: (
    notebook: vscode.NotebookDocument,
    expectedBinding: boolean,
    checkpoint: string
  ) => Promise<void>;
  readonly assertReleasedRVersion: (
    result: Readonly<Record<string, unknown>>,
    target: ReleasedJupyterKernelTarget,
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
  readonly exerciseReleasedRDocumentJourney: (testing: TestApi, workbench: Page, directory: string) => Promise<void>;
  readonly exerciseReleasedREditingCoverage: (
    testing: TestApi,
    workbench: Page,
    base: ReleasedRActiveSession,
    notebook: vscode.NotebookDocument,
    notebookPath: string,
    directory: string,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    screenshotOutput?: string
  ) => Promise<void>;
  readonly exerciseReleasedREditingModeTransition: (
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    base: ReleasedRActiveSession,
    phase: "jupyter-r" | "jupyter-r-remote"
  ) => Promise<void>;
  readonly exerciseReleasedRGridJourney: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    gridPaging: ReleasedRAcceptanceCoverageProfile["gridPaging"]
  ) => Promise<void>;
  readonly exerciseReleasedRKernelLifecycle: (
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    setup: Record<string, unknown>,
    kernelTarget: ReleasedJupyterKernelTarget,
    phase: "jupyter-r" | "jupyter-r-remote"
  ) => Promise<void>;
  readonly exerciseReleasedRKernelRestartExtension: (
    testing: TestApi,
    extension: vscode.Extension<ExtensionApi>,
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
  readonly exerciseReleasedRNativeFramesExtension: (
    testing: TestApi,
    extension: vscode.Extension<ExtensionApi>,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile
  ) => Promise<void>;
  readonly exerciseReleasedRNotebookMedia: (
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    base: ReleasedRActiveSession,
    phase: "jupyter-r" | "jupyter-r-remote",
    screenshotOutput: string
  ) => Promise<ReleasedRActiveSession>;
  readonly exerciseReleasedRVariableDiscovery: (
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    screenshotOutput?: string
  ) => Promise<ReleasedRActiveSession>;
  readonly getLastAcceptanceProgressCheckpoint: () => string | undefined;
  readonly notebookCellOutputText: (cell: vscode.NotebookCell) => string;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly recordReleasedRAcceptanceSection: (
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    section: string,
    boundary: "start" | "complete"
  ) => void;
  readonly registerReleasedRemoteJupyterServer: (
    jupyter: Jupyter,
    target: ReleasedJupyterKernelTarget
  ) => JupyterServerCollection;
  readonly releasedJupyterKernelTarget: (phase: "jupyter-r" | "jupyter-r-remote") => ReleasedJupyterKernelTarget;
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
    target: ReleasedJupyterKernelTarget
  ) => Promise<void>;
}

export function createReleasedRJupyterExtensionJourney({
  RELEASED_JUPYTER_EXTENSION_VERSION,
  RELEASED_JUPYTER_R_KERNEL_CELL,
  RELEASED_JUPYTER_R_SETUP_CELL,
  assertReleasedRPrivateLibrary,
  assertReleasedRRuntimeBinding,
  assertReleasedRVersion,
  bestEffortReleasedJupyterCleanup,
  connectToEditorWorkbench,
  executeReleasedNotebookCell,
  exerciseReleasedRCollapseFrameSessions,
  exerciseReleasedRDocumentJourney,
  exerciseReleasedREditingCoverage,
  exerciseReleasedREditingModeTransition,
  exerciseReleasedRGridJourney,
  exerciseReleasedRKernelLifecycle,
  exerciseReleasedRKernelRestartExtension,
  exerciseReleasedRNativeFrameSessions,
  exerciseReleasedRNativeFramesExtension,
  exerciseReleasedRNotebookMedia,
  exerciseReleasedRVariableDiscovery,
  getLastAcceptanceProgressCheckpoint,
  notebookCellOutputText,
  recordAcceptanceProgress,
  recordReleasedRAcceptanceSection,
  registerReleasedRemoteJupyterServer,
  releasedJupyterKernelTarget,
  releasedNotebookJsonResult,
  selectReleasedJupyterKernel
}: ReleasedRJupyterExtensionJourneyDependencies) {
  return async function exerciseReleasedRJupyterExtension(
    testing: TestApi,
    extension: vscode.Extension<ExtensionApi>,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile
  ): Promise<void> {
    if (coverage.name === "kernel-restart") {
      await exerciseReleasedRKernelRestartExtension(testing, extension, phase, coverage);
      return;
    }
    if (coverage.name === "native-frames") {
      await exerciseReleasedRNativeFramesExtension(testing, extension, phase, coverage);
      return;
    }
    assert.equal(coverage.coreJourney, true, "The ordinary R notebook journey requires a core coverage profile.");
    recordReleasedRAcceptanceSection(phase, coverage, "notebook", "start");
    assert.equal(testing.diagnostics().sessionCount, 0);
    const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
    assert.equal(jupyterExtension.packageJSON.version, RELEASED_JUPYTER_EXTENSION_VERSION);
    assert.ok(
      !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
      "Native R notebook support must not make Jupyter a hard dependency."
    );

    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-released-jupyter-r-"));
    const notebookPath = path.join(directory, "r-dataframes.ipynb");
    const notebookUri = vscode.Uri.file(notebookPath);
    const kernelTarget = releasedJupyterKernelTarget(phase);
    const screenshotOutput =
      phase === "jupyter-r" && process.platform === "linux"
        ? process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS
        : undefined;
    writeReleasedRNotebook(notebookPath, phase, releasedJupyterKernelTarget(phase));
    const configuration = vscode.workspace.getConfiguration("openWrangler");
    const originalProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
      "notebookPreviewProvider"
    )?.workspaceValue;
    const originalNotebookStartMode = configuration.inspect<"viewing" | "editing">("notebookStartMode")?.workspaceValue;
    let notebook: vscode.NotebookDocument | undefined;
    let remoteServerCollection: JupyterServerCollection | undefined;
    let acceptanceError: { readonly value: unknown } | undefined;
    let failureCheckpoint: string | undefined;
    try {
      await configuration.update("notebookPreviewProvider", "disabled", vscode.ConfigurationTarget.Workspace);
      await configuration.update("notebookStartMode", "viewing", vscode.ConfigurationTarget.Workspace);
      notebook = await vscode.workspace.openNotebookDocument(notebookUri);
      const notebookEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });
      const workbench = await connectToEditorWorkbench();
      const jupyterApi = await jupyterExtension.activate();
      if (kernelTarget.remote) {
        remoteServerCollection = registerReleasedRemoteJupyterServer(jupyterApi, kernelTarget);
      }
      await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);
      await executeReleasedNotebookCell(
        notebook,
        RELEASED_JUPYTER_R_KERNEL_CELL,
        RELEASED_JUPYTER_R_KERNEL_RESULT,
        `${phase}:kernel-probe`,
        notebookEditor
      );
      await executeReleasedNotebookCell(
        notebook,
        RELEASED_JUPYTER_R_SETUP_CELL,
        [RELEASED_JUPYTER_R_SETUP_RESULT, RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX],
        `${phase}:setup`,
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
      const setup = releasedNotebookJsonResult(setupCell, RELEASED_JUPYTER_R_SETUP_RESULT, "R setup");
      assert.deepEqual({ rows: setup.rows, columns: setup.columns }, { rows: 1_205, columns: 25 });
      assertReleasedRVersion(setup, kernelTarget, "R setup");
      if (!kernelTarget.remote) assertReleasedRPrivateLibrary(setup, "R setup");
      assert.equal(setup.collapseVersion, "2.1.7");
      assert.ok(Number.isSafeInteger(Number(setup.pid)) && Number(setup.pid) > 0);
      if (kernelTarget.remote) {
        assert.equal(setup.remoteRunId, kernelTarget.remote.runId);
        assert.equal(setup.hostname, kernelTarget.remote.hostname);
      }

      let base = await exerciseReleasedRVariableDiscovery(
        testing,
        workbench,
        notebook,
        notebookEditor,
        phase,
        coverage,
        screenshotOutput
      );
      if (screenshotOutput) {
        base = await exerciseReleasedRNotebookMedia(testing, workbench, notebook, base, phase, screenshotOutput);
      }
      recordReleasedRAcceptanceSection(phase, coverage, "grid", "start");
      await exerciseReleasedRGridJourney(testing, workbench, base.sessionId, coverage.gridPaging);
      recordReleasedRAcceptanceSection(phase, coverage, "grid", "complete");
      await assertReleasedRRuntimeBinding(notebook, true, `${phase}:source-after-filter-journey`);
      await exerciseReleasedREditingModeTransition(testing, workbench, notebook, base, phase);
      await exerciseReleasedREditingCoverage(
        testing,
        workbench,
        base,
        notebook,
        notebookPath,
        directory,
        phase,
        coverage,
        screenshotOutput
      );

      await exerciseReleasedRCollapseFrameSessions(testing, workbench, notebook, phase, coverage);

      if (phase === "jupyter-r" && process.platform === "darwin") {
        assert.equal(
          supportsRDocumentExecution(process.platform),
          true,
          "The ordinary macOS R gate requires the product's direct-document transport."
        );
        recordReleasedRAcceptanceSection(phase, coverage, "document", "start");
        await exerciseReleasedRDocumentJourney(testing, workbench, directory);
        assert.equal(testing.diagnostics().sessionCount, 0, "The plain R journey must release its private processes.");
        recordReleasedRAcceptanceSection(phase, coverage, "document", "complete");
      }

      await exerciseReleasedRNativeFrameSessions(testing, workbench, notebook, configuration, phase, coverage);

      if (coverage.kernelLifecycle) {
        recordReleasedRAcceptanceSection(phase, coverage, "restart", "start");
        await exerciseReleasedRKernelLifecycle(testing, workbench, notebook, setup, kernelTarget, phase);
        recordReleasedRAcceptanceSection(phase, coverage, "restart", "complete");
      }
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
        remoteServerCollection?.dispose();
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
  };
}
