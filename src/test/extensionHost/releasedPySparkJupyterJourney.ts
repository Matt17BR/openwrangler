import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Jupyter } from "@vscode/jupyter-extension";
import type { Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import type { LiveGridPage, OpenWranglerResponse } from "../../shared/protocol";
import { classifyPySparkVersion } from "../../extension/notebooks/pysparkVersionPolicy.generated";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import type { ExtensionApi, TestApi } from "./extensionHostTestApi";
import { failedAcceptanceProgressCheckpoint } from "./progress";
import { RELEASED_JUPYTER_RESTART_RESULT } from "./releasedJupyterNotebookFixture";
import {
  RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
  RELEASED_JUPYTER_PYSPARK_REBIND_RESULT,
  RELEASED_JUPYTER_PYSPARK_SCHEMA_REBIND_RESULT,
  RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
  writeReleasedPySparkNotebook
} from "./releasedPySparkNotebookFixture";

type ActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;
type PageResponse = Extract<OpenWranglerResponse, { kind: "page" }>;
type ReleasedJupyterPhase = "jupyter-pyspark";

interface ReleasedPySparkKernelTarget {
  readonly label: string;
  readonly name: string;
  readonly routeLabels: readonly string[];
}

interface ReleasedPySparkVariableExpectation {
  readonly name: string;
  readonly type: string;
  readonly backend: "pyspark";
  readonly firstValue: string;
  readonly notebookInsert: false;
}

export type ReleasedPySparkInstalledAcceptanceMode = "stable-qualification" | "prerelease-denial";

export function releasedPySparkInstalledAcceptanceMode(version: unknown): ReleasedPySparkInstalledAcceptanceMode {
  if (typeof version !== "string") {
    throw new Error("Released PySpark acceptance received an unsafe installed version.");
  }
  const classification = classifyPySparkVersion(version);
  switch (classification) {
    case "supported-final":
      return "stable-qualification";
    case "acceptance-denial":
      return "prerelease-denial";
    case "unsupported":
      throw new Error(
        "Released PySpark acceptance received neither a supported final release nor its pinned denial build."
      );
    default:
      classification satisfies never;
      throw new Error("Released PySpark acceptance received an unknown generated version classification.");
  }
}

export function assertReleasedPySparkInstalledAcceptanceMode(
  version: unknown,
  expected: ReleasedPySparkInstalledAcceptanceMode
): ReleasedPySparkInstalledAcceptanceMode {
  const actual = releasedPySparkInstalledAcceptanceMode(version);
  if (actual !== expected) {
    throw new Error(`Released PySpark acceptance expected ${expected} but received ${actual}.`);
  }
  return actual;
}

export interface ReleasedPySparkJupyterJourneyDependencies {
  readonly GRID_COLUMN_WINDOW: { readonly columnOffset: number; readonly columnLimit: number };
  readonly RELEASED_JUPYTER_EXTENSION_VERSION: string;
  readonly SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: number;
  readonly assertExactOpenNotebookDocument: (notebook: vscode.NotebookDocument, checkpoint: string) => void;
  readonly assertReleasedJupyterKernelIdentity: (
    result: Readonly<Record<string, unknown>>,
    target: ReleasedPySparkKernelTarget,
    hostPython: string
  ) => void;
  readonly assertReleasedPySparkPanelAndQueries: (
    testing: TestApi,
    active: ActiveSession,
    variant: "classic" | "connect"
  ) => Promise<PageResponse>;
  readonly bestEffortReleasedJupyterCleanup: (
    testing: TestApi,
    notebook: vscode.NotebookDocument | undefined,
    phase: "jupyter-pyspark"
  ) => Promise<void>;
  readonly captureReleasedJupyterPySparkLive: (
    workbench: Page,
    testing: TestApi,
    active: ActiveSession,
    outputDirectory: string
  ) => Promise<void>;
  readonly captureReleasedJupyterPySparkPicker: (
    workbench: Page,
    testing: TestApi,
    notebook: vscode.NotebookDocument,
    editor: vscode.NotebookEditor,
    outputDirectory: string
  ) => Promise<void>;
  readonly closeReleasedJupyterSessionTabs: () => Promise<void>;
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly dispatchReleasedJupyterVariableAction: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    variableName: string,
    checkpoint: string
  ) => Promise<void>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly executeReleasedNotebookCell: (
    notebook: vscode.NotebookDocument,
    index: number,
    expectedText: string | readonly string[] | undefined,
    checkpoint: string,
    expectedEditor?: vscode.NotebookEditor
  ) => Promise<void>;
  readonly getLastAcceptanceProgressCheckpoint: () => string | undefined;
  readonly gridColumnDisplays: (page: LiveGridPage, columnId: string) => string[];
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedJupyterKernelTarget: (phase: "jupyter-pyspark") => ReleasedPySparkKernelTarget;
  readonly releasedJupyterSessionTabs: () => vscode.Tab[];
  readonly releasedNotebookJsonResult: (
    cell: vscode.NotebookCell,
    marker: string,
    description: string
  ) => Record<string, unknown>;
  readonly restartReleasedJupyterKernelAndWait: (notebook: vscode.NotebookDocument) => Promise<void>;
  readonly selectReleasedJupyterKernel: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    phase: "jupyter-pyspark",
    targetKernel: ReleasedPySparkKernelTarget
  ) => Promise<void>;
  readonly showExactReleasedNotebook: (notebook: vscode.NotebookDocument) => Promise<vscode.NotebookEditor>;
  readonly waitForReleasedJupyterConsent: (
    workbench: Page,
    testing: TestApi
  ) => Promise<{ dialog: Locator; allow: Locator; deny: Locator }>;
  readonly waitForReleasedJupyterTerminalPanelError: (workbench: Page, testing: TestApi) => Promise<string>;
  readonly waitForReleasedVariableSession: (
    workbench: Page,
    testing: TestApi,
    notebook: vscode.NotebookDocument,
    expected: ReleasedPySparkVariableExpectation,
    description: string
  ) => Promise<ActiveSession>;
  readonly waitForStableReleasedJupyterSessionCount: (
    testing: TestApi,
    expected: number,
    stableForMs: number,
    timeoutMs: number
  ) => Promise<void>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: Thenable<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
}

export function createReleasedPySparkJupyterJourney({
  GRID_COLUMN_WINDOW,
  RELEASED_JUPYTER_EXTENSION_VERSION,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  assertExactOpenNotebookDocument,
  assertReleasedJupyterKernelIdentity,
  assertReleasedPySparkPanelAndQueries,
  bestEffortReleasedJupyterCleanup,
  captureReleasedJupyterPySparkLive,
  captureReleasedJupyterPySparkPicker,
  closeReleasedJupyterSessionTabs,
  connectToEditorWorkbench,
  dispatchReleasedJupyterVariableAction,
  disposePackagedSessionPanel,
  executeReleasedNotebookCell,
  getLastAcceptanceProgressCheckpoint,
  gridColumnDisplays,
  recordAcceptanceProgress,
  releasedJupyterKernelTarget,
  releasedJupyterSessionTabs,
  releasedNotebookJsonResult,
  restartReleasedJupyterKernelAndWait,
  selectReleasedJupyterKernel,
  showExactReleasedNotebook,
  waitForReleasedJupyterConsent,
  waitForReleasedJupyterTerminalPanelError,
  waitForReleasedVariableSession,
  waitForStableReleasedJupyterSessionCount,
  withBoundedAcceptancePromise
}: ReleasedPySparkJupyterJourneyDependencies) {
  async function exerciseReleasedPySparkInstalledPrereleaseDenial(
    testing: TestApi,
    notebook: vscode.NotebookDocument,
    workbench: Page,
    productVersion: string,
    screenshotOutput: string | undefined
  ): Promise<void> {
    const checkpoint = "jupyter-pyspark:installed-prerelease-denial";
    assert.equal(testing.diagnostics().sessionCount, 0);
    assert.equal(testing.activeSession(), undefined);
    assert.equal(releasedJupyterSessionTabs().length, 0);
    recordAcceptanceProgress(`${checkpoint}:dispatch`);
    await showExactReleasedNotebook(notebook);
    await withBoundedAcceptancePromise(
      vscode.commands.executeCommand("openWrangler.launchDataViewer", {
        name: "spark_classic_frame",
        type: "pyspark.sql.classic.dataframe.DataFrame",
        fileName: notebook.uri
      }),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the installed PySpark prerelease denial dispatch"
    );
    if (!screenshotOutput) {
      const consent = await waitForReleasedJupyterConsent(workbench, testing);
      await consent.allow.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    }
    const denial = (await waitForReleasedJupyterTerminalPanelError(workbench, testing)).replace(/\s+/gu, " ").trim();
    assert.match(denial, /requires a final PySpark 4\.2\.x release/u);
    assert.equal(denial.includes(productVersion), false, "The denial must not echo the rejected installed version.");
    await waitForStableReleasedJupyterSessionCount(testing, 0, 2_000, 10_000);
    assert.equal(testing.diagnostics().sessionCount, 0);
    assert.equal(testing.activeSession(), undefined);

    recordAcceptanceProgress(`${checkpoint}:kernel-session-receipt`);
    await executeReleasedNotebookCell(
      notebook,
      4,
      RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
      `${checkpoint}:kernel-session-receipt`,
      await showExactReleasedNotebook(notebook)
    );
    const kernelReceipt = releasedNotebookJsonResult(
      notebook.cellAt(4),
      RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
      "installed PySpark prerelease denial runtime receipt"
    );
    assert.equal(kernelReceipt.runtimeSessions, 0, "A rejected prerelease must not create a runtime session.");
    assert.deepEqual(kernelReceipt.runtimeSessionIds, []);
    await closeReleasedJupyterSessionTabs();
    assert.equal(releasedJupyterSessionTabs().length, 0);
    recordAcceptanceProgress(`${checkpoint}:complete`);
    console.log("Open Wrangler installed PySpark prerelease denial passed.");
  }

  return async function exerciseReleasedPySparkJupyterExtension(
    testing: TestApi,
    extension: vscode.Extension<ExtensionApi>,
    testPython: string,
    expectedAcceptanceMode: ReleasedPySparkInstalledAcceptanceMode = "stable-qualification"
  ): Promise<void> {
    const phase: ReleasedJupyterPhase = "jupyter-pyspark";
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "Released PySpark acceptance must start without a retained Open Wrangler session."
    );
    assert.ok(
      !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
      "File-backed Open Wrangler use must not acquire a hard Jupyter extension dependency."
    );

    const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
    assert.equal(jupyterExtension.packageJSON.version, RELEASED_JUPYTER_EXTENSION_VERSION);

    const kernelTarget = releasedJupyterKernelTarget(phase);
    const screenshotOutput = process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS;
    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-released-jupyter-pyspark-"));
    const notebookPath = path.join(
      directory,
      screenshotOutput ? "regional-orders-spark.ipynb" : "jupyter-pyspark.ipynb"
    );
    const notebookUri = vscode.Uri.file(notebookPath);
    writeReleasedPySparkNotebook(notebookPath, extension.extensionPath, releasedJupyterKernelTarget("jupyter-pyspark"));
    const configuration = vscode.workspace.getConfiguration("openWrangler");
    const originalNotebookPreviewProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
      "notebookPreviewProvider"
    )?.workspaceValue;

    let notebook: vscode.NotebookDocument | undefined;
    let failureCheckpoint: string | undefined;
    try {
      // This phase validates the first explicit toolbar request. Keep proactive
      // formatter preparation out of the way so its own kernel-access consent
      // cannot be mistaken for (or dismissed by) screenshot setup.
      await configuration.update("notebookPreviewProvider", "disabled", vscode.ConfigurationTarget.Workspace);
      recordAcceptanceProgress(`${phase}:notebook-open`);
      notebook = await vscode.workspace.openNotebookDocument(notebookUri);
      assertExactOpenNotebookDocument(notebook, "after opening the released PySpark fixture");
      const notebookEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });
      assert.equal(notebookEditor.notebook, notebook);

      const workbench = await connectToEditorWorkbench();
      const jupyterApi = await jupyterExtension.activate();
      assertExactOpenNotebookDocument(notebook, "after activating released Jupyter for PySpark acceptance");
      recordAcceptanceProgress(`${phase}:kernel-select`);
      await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);

      const visibleNotebook = await showExactReleasedNotebook(notebook);
      await executeReleasedNotebookCell(
        notebook,
        0,
        RELEASED_JUPYTER_RESTART_RESULT,
        `${phase}:kernel-warmup`,
        visibleNotebook
      );
      const warmKernel = releasedNotebookJsonResult(
        notebook.cellAt(0),
        RELEASED_JUPYTER_RESTART_RESULT,
        "PySpark kernel warmup"
      );
      assertReleasedJupyterKernelIdentity(warmKernel, kernelTarget, testPython);
      assert.equal(warmKernel.runtime, false, "The PySpark kernel must start without Open Wrangler preloaded.");

      recordAcceptanceProgress(`${phase}:classic-setup`);
      const classicEditor = await showExactReleasedNotebook(notebook);
      await executeReleasedNotebookCell(
        notebook,
        1,
        RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
        `${phase}:classic-setup`,
        classicEditor
      );
      const classicSetup = releasedNotebookJsonResult(
        notebook.cellAt(1),
        RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
        "PySpark Classic setup"
      );
      const productVersion = classicSetup.productVersion;
      const installedAcceptanceMode = assertReleasedPySparkInstalledAcceptanceMode(
        productVersion,
        expectedAcceptanceMode
      );
      const classicJavaMajor = Number(classicSetup.javaVersion);
      assert.ok(
        Number.isSafeInteger(classicJavaMajor) && classicJavaMajor >= 17,
        `PySpark 4.2 requires Java 17 or newer; the notebook reported ${JSON.stringify(classicSetup.javaVersion)}.`
      );
      assert.equal(classicSetup.module, "pyspark.sql.classic.dataframe");
      assert.equal(classicSetup.workerPythonPinned, true);
      assert.deepEqual(classicSetup.conversionTraps, ["toPandas", "toArrow", "mapInPandas", "mapInArrow"]);
      assert.deepEqual(classicSetup.variantConversionTraps, ["toPandas", "toArrow", "mapInPandas", "mapInArrow"]);

      if (installedAcceptanceMode === "prerelease-denial") {
        await exerciseReleasedPySparkInstalledPrereleaseDenial(
          testing,
          notebook,
          workbench,
          String(productVersion),
          screenshotOutput
        );
        return;
      }
      assert.equal(productVersion, "4.2.0", "Stable qualification must use the pinned released PySpark version.");

      if (screenshotOutput) {
        await captureReleasedJupyterPySparkPicker(workbench, testing, notebook, classicEditor, screenshotOutput);
      }

      recordAcceptanceProgress(`${phase}:unsupported-variant`);
      await showExactReleasedNotebook(notebook);
      await vscode.commands.executeCommand("jupyter.openVariableView");
      await dispatchReleasedJupyterVariableAction(
        workbench,
        notebook,
        "spark_unsupported_variant_frame",
        `${phase}:unsupported-variant-action`
      );
      if (!screenshotOutput) {
        const consent = await waitForReleasedJupyterConsent(workbench, testing);
        await consent.allow.click();
        await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
      }
      const unsupportedVariantError = (await waitForReleasedJupyterTerminalPanelError(workbench, testing))
        .replace(/\s+/gu, " ")
        .trim();
      assert.match(
        unsupportedVariantError,
        /required viewing profiles.*'payload' \(variant\).*Convert these columns in Spark/u
      );
      await waitForStableReleasedJupyterSessionCount(testing, 0, 2_000, 10_000);
      assert.equal(testing.activeSession(), undefined, "An unsupported PySpark Variant frame must not become active.");
      await closeReleasedJupyterSessionTabs();
      assert.equal(releasedJupyterSessionTabs().length, 0);

      recordAcceptanceProgress(`${phase}:classic-variables`);
      await showExactReleasedNotebook(notebook);
      await vscode.commands.executeCommand("jupyter.openVariableView");
      await dispatchReleasedJupyterVariableAction(
        workbench,
        notebook,
        "spark_classic_frame",
        `${phase}:classic-action`
      );
      const classic = await waitForReleasedVariableSession(
        workbench,
        testing,
        notebook,
        {
          name: "spark_classic_frame",
          type: "pyspark.sql.classic.dataframe.DataFrame",
          backend: "pyspark",
          firstValue: "",
          notebookInsert: false
        },
        "the PySpark Classic DataFrame opened from the real Jupyter Variables view"
      );
      assert.equal(classic.metadata.mode, "viewing");
      assert.deepEqual(classic.metadata.capabilities, {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      });
      const classicPage = await assertReleasedPySparkPanelAndQueries(testing, classic, "classic");

      recordAcceptanceProgress(`${phase}:classic-same-kernel-rebind`);
      await executeReleasedNotebookCell(
        notebook,
        2,
        RELEASED_JUPYTER_PYSPARK_REBIND_RESULT,
        `${phase}:classic-same-kernel-rebind`,
        await showExactReleasedNotebook(notebook)
      );
      const reboundClassicSetup = releasedNotebookJsonResult(
        notebook.cellAt(2),
        RELEASED_JUPYTER_PYSPARK_REBIND_RESULT,
        "same-kernel PySpark Classic rebind"
      );
      assert.equal(Number(reboundClassicSetup.pid), Number(classicSetup.pid));
      assert.notEqual(
        reboundClassicSetup.sessionId,
        classicSetup.sessionId,
        "A same-kernel PySpark rebind must own a new user SparkSession."
      );
      const reboundClassic = await withBoundedAcceptancePromise(
        testing.request({
          kind: "getPage",
          ...GRID_COLUMN_WINDOW,
          viewRequestId: "released-jupyter-pyspark-classic-same-kernel-rebind",
          sessionId: classic.sessionId,
          revision: classicPage.revision,
          offset: 0,
          limit: 1,
          filterModel: classicPage.metadata.filterModel
        }),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the released-Jupyter PySpark Classic page after same-kernel SparkSession replacement"
      );
      assert.equal(reboundClassic.kind, "page");
      if (reboundClassic.kind !== "page") {
        throw new Error("The released-Jupyter PySpark Classic same-kernel rebind did not return a page.");
      }
      assert.equal(reboundClassic.metadata.sessionId, classic.sessionId);
      assert.deepEqual(reboundClassic.metadata.filterModel, classicPage.metadata.filterModel);
      const reboundClassicRecordId = reboundClassic.metadata.schema.find((column) => column.name === "record_id");
      assert.ok(reboundClassicRecordId);
      assert.deepEqual(
        gridColumnDisplays(reboundClassic.page, reboundClassicRecordId.id),
        ["102"],
        "The same-kernel recovery must return the recreated variable, not a cached row from the stopped SparkSession."
      );

      recordAcceptanceProgress(`${phase}:classic-changed-schema-rebind`);
      const confirmedClassic = testing.sessionSnapshot(classic.sessionId);
      assert.ok(
        confirmedClassic,
        "The confirmed PySpark Classic session must remain retained before schema replacement."
      );
      assert.equal(confirmedClassic.sessionId, classic.sessionId);
      const confirmedClassicSnapshot = structuredClone(confirmedClassic);
      await executeReleasedNotebookCell(
        notebook,
        3,
        RELEASED_JUPYTER_PYSPARK_SCHEMA_REBIND_RESULT,
        `${phase}:classic-changed-schema-rebind`,
        await showExactReleasedNotebook(notebook)
      );
      const changedClassicSetup = releasedNotebookJsonResult(
        notebook.cellAt(3),
        RELEASED_JUPYTER_PYSPARK_SCHEMA_REBIND_RESULT,
        "same-kernel changed-schema PySpark Classic rebind"
      );
      assert.equal(Number(changedClassicSetup.pid), Number(reboundClassicSetup.pid));
      assert.notEqual(
        changedClassicSetup.sessionId,
        reboundClassicSetup.sessionId,
        "A changed-schema PySpark rebind must own a new user SparkSession."
      );
      assert.deepEqual(changedClassicSetup.schema, [
        { name: "record_id", type: "bigint" },
        { name: "category_label", type: "string" },
        { name: "amount", type: "double" }
      ]);
      const changedSchema = await withBoundedAcceptancePromise(
        testing.request({
          kind: "getPage",
          ...GRID_COLUMN_WINDOW,
          viewRequestId: "released-jupyter-pyspark-classic-changed-schema-rebind",
          sessionId: classic.sessionId,
          revision: reboundClassic.revision,
          offset: 0,
          limit: 1,
          filterModel: reboundClassic.metadata.filterModel
        }),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the released-Jupyter PySpark Classic page after a changed-schema SparkSession replacement"
      );
      assert.equal(changedSchema.kind, "error");
      if (changedSchema.kind !== "error") {
        throw new Error("The released-Jupyter changed-schema PySpark rebind did not fail closed.");
      }
      assert.equal(changedSchema.code, "live_source_invalidated");
      assert.equal(changedSchema.recoverable, true);
      assert.equal(changedSchema.sessionId, classic.sessionId);
      assert.equal(changedSchema.viewRequestId, "released-jupyter-pyspark-classic-changed-schema-rebind");
      assert.match(changedSchema.message, /If its columns or types changed, reopen the variable instead\./u);
      const unchangedClassic = testing.sessionSnapshot(classic.sessionId);
      assert.ok(unchangedClassic, "A rejected PySpark schema replacement must retain the confirmed public session.");
      assert.deepEqual(unchangedClassic, confirmedClassicSnapshot);
      const changedSchemaDiagnostics = testing.diagnostics();
      assert.equal(changedSchemaDiagnostics.sessionCount, 1);
      assert.equal(changedSchemaDiagnostics.sessions.length, 1);
      assert.equal(changedSchemaDiagnostics.sessions[0]?.publicId, classic.sessionId);
      assert.equal(releasedJupyterSessionTabs().length, 1);

      recordAcceptanceProgress(`${phase}:classic-changed-schema-owner-session`);
      await executeReleasedNotebookCell(
        notebook,
        4,
        RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
        `${phase}:classic-changed-schema-owner-session`,
        await showExactReleasedNotebook(notebook)
      );
      const changedSchemaOwner = releasedNotebookJsonResult(
        notebook.cellAt(4),
        RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
        "changed-schema PySpark Classic owner session"
      );
      assert.equal(changedSchemaOwner.sessionId, changedClassicSetup.sessionId);
      assert.equal(changedSchemaOwner.count, 3);
      assert.equal(
        changedSchemaOwner.runtimeSessions,
        1,
        "Rejecting a changed schema must close only its candidate and retain the confirmed runtime session."
      );
      assert.deepEqual(
        changedSchemaOwner.runtimeSessionIds,
        [changedSchemaDiagnostics.sessions[0]?.runtimeId],
        "The sole surviving kernel runtime must be the exact confirmed Open Wrangler runtime."
      );

      recordAcceptanceProgress(`${phase}:classic-restart`);
      await restartReleasedJupyterKernelAndWait(notebook);
      await executeReleasedNotebookCell(
        notebook,
        0,
        RELEASED_JUPYTER_RESTART_RESULT,
        `${phase}:classic-restart-probe`,
        await showExactReleasedNotebook(notebook)
      );
      const replacementKernel = releasedNotebookJsonResult(
        notebook.cellAt(0),
        RELEASED_JUPYTER_RESTART_RESULT,
        "PySpark replacement kernel"
      );
      assertReleasedJupyterKernelIdentity(replacementKernel, kernelTarget, testPython);
      assert.notEqual(
        Number(replacementKernel.pid),
        Number(classicSetup.pid),
        "Restarting the PySpark notebook must replace the kernel process."
      );
      assert.equal(
        replacementKernel.runtime,
        replacementKernel.bootstrap,
        "Runtime availability in the replacement PySpark kernel must come from its own Open Wrangler bootstrap."
      );

      recordAcceptanceProgress(`${phase}:classic-restart-setup`);
      await executeReleasedNotebookCell(
        notebook,
        1,
        RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
        `${phase}:classic-restart-setup`,
        await showExactReleasedNotebook(notebook)
      );
      const restartedClassicSetup = releasedNotebookJsonResult(
        notebook.cellAt(1),
        RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
        "restarted PySpark Classic setup"
      );
      assert.equal(Number(restartedClassicSetup.pid), Number(replacementKernel.pid));
      assert.equal(restartedClassicSetup.workerPythonPinned, true);
      assert.notEqual(
        restartedClassicSetup.sessionId,
        classicSetup.sessionId,
        "The replacement kernel must own a new user SparkSession."
      );

      recordAcceptanceProgress(`${phase}:classic-restart-replay`);
      const replayedClassic = await withBoundedAcceptancePromise(
        testing.request({
          kind: "getPage",
          ...GRID_COLUMN_WINDOW,
          viewRequestId: "released-jupyter-pyspark-classic-restart-replay",
          sessionId: classic.sessionId,
          revision: reboundClassic.revision,
          offset: 0,
          limit: 1,
          filterModel: reboundClassic.metadata.filterModel
        }),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the released-Jupyter PySpark Classic page after kernel replacement"
      );
      assert.equal(replayedClassic.kind, "page");
      if (replayedClassic.kind !== "page") {
        throw new Error("The released-Jupyter PySpark Classic restart replay did not return a page.");
      }
      assert.equal(
        replayedClassic.metadata.sessionId,
        classic.sessionId,
        "Kernel recovery must preserve the public Open Wrangler session identity."
      );
      assert.equal(replayedClassic.metadata.backend, "pyspark");
      const replayedRecordId = replayedClassic.metadata.schema.find((column) => column.name === "record_id");
      assert.ok(replayedRecordId);
      assert.deepEqual(gridColumnDisplays(replayedClassic.page, replayedRecordId.id), ["2"]);

      await disposePackagedSessionPanel(testing, classic.sessionId, "the released-Jupyter PySpark Classic session");

      recordAcceptanceProgress(`${phase}:classic-owner-session`);
      await executeReleasedNotebookCell(
        notebook,
        4,
        RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
        `${phase}:classic-owner-session`,
        await showExactReleasedNotebook(notebook)
      );
      const classicClose = releasedNotebookJsonResult(
        notebook.cellAt(4),
        RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
        "PySpark Classic close"
      );
      assert.equal(classicClose.sessionId, restartedClassicSetup.sessionId);
      assert.equal(classicClose.count, 3, "Closing Open Wrangler must leave the user's Classic SparkSession usable.");
      assert.equal(classicClose.runtimeSessions, 0, "Classic cleanup must close every Open Wrangler kernel session.");
      assert.deepEqual(classicClose.runtimeSessionIds, []);

      if (screenshotOutput) {
        recordAcceptanceProgress(`${phase}:orders-variables`);
        await showExactReleasedNotebook(notebook);
        await vscode.commands.executeCommand("jupyter.openVariableView");
        await showExactReleasedNotebook(notebook);
        await dispatchReleasedJupyterVariableAction(
          workbench,
          notebook,
          "spark_orders_frame",
          `${phase}:orders-action`
        );
        const orders = await waitForReleasedVariableSession(
          workbench,
          testing,
          notebook,
          {
            name: "spark_orders_frame",
            type: "pyspark.sql.classic.dataframe.DataFrame",
            backend: "pyspark",
            firstValue: "",
            notebookInsert: false
          },
          "the realistic PySpark Classic orders DataFrame opened from the real Jupyter Variables view"
        );
        assert.deepEqual(orders.metadata.shape, { rows: null, columns: 15 });
        assert.equal(orders.metadata.mode, "viewing");
        assert.equal(orders.metadata.capabilities.editable, false);
        assert.equal(orders.metadata.capabilities.exportCsv, false);
        assert.equal(orders.metadata.capabilities.exportParquet, false);
        await captureReleasedJupyterPySparkLive(workbench, testing, orders, screenshotOutput);
        await disposePackagedSessionPanel(testing, orders.sessionId, "the released-Jupyter PySpark orders session");
      }

      recordAcceptanceProgress(`${phase}:connect-variables`);
      await showExactReleasedNotebook(notebook);
      await vscode.commands.executeCommand("jupyter.openVariableView");
      const connectEditor = await showExactReleasedNotebook(notebook);
      await executeReleasedNotebookCell(
        notebook,
        5,
        RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
        `${phase}:connect-setup`,
        connectEditor
      );
      const connectSetup = releasedNotebookJsonResult(
        notebook.cellAt(5),
        RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
        "local Spark Connect setup"
      );
      assert.equal(connectSetup.productVersion, "4.2.0");
      assert.equal(connectSetup.module, "pyspark.sql.connect.dataframe");
      assert.equal(connectSetup.workerPythonPinned, true);
      assert.deepEqual(connectSetup.conversionTraps, ["toPandas", "toArrow", "mapInPandas", "mapInArrow"]);

      await dispatchReleasedJupyterVariableAction(
        workbench,
        notebook,
        "spark_connect_frame",
        `${phase}:connect-action`
      );
      const connect = await waitForReleasedVariableSession(
        workbench,
        testing,
        notebook,
        {
          name: "spark_connect_frame",
          type: "pyspark.sql.connect.dataframe.DataFrame",
          backend: "pyspark",
          firstValue: "",
          notebookInsert: false
        },
        "the local Spark Connect DataFrame opened from the real Jupyter Variables view"
      );
      const connectPage = await assertReleasedPySparkPanelAndQueries(testing, connect, "connect");

      recordAcceptanceProgress(`${phase}:connect-same-kernel-rebind`);
      await executeReleasedNotebookCell(
        notebook,
        6,
        RELEASED_JUPYTER_PYSPARK_REBIND_RESULT,
        `${phase}:connect-same-kernel-rebind`,
        await showExactReleasedNotebook(notebook)
      );
      const reboundConnectSetup = releasedNotebookJsonResult(
        notebook.cellAt(6),
        RELEASED_JUPYTER_PYSPARK_REBIND_RESULT,
        "same-kernel Spark Connect rebind"
      );
      assert.equal(Number(reboundConnectSetup.pid), Number(connectSetup.pid));
      assert.notEqual(
        reboundConnectSetup.sessionId,
        connectSetup.sessionId,
        "A same-kernel Spark Connect rebind must own a new user SparkSession."
      );
      const reboundConnect = await withBoundedAcceptancePromise(
        testing.request({
          kind: "getPage",
          ...GRID_COLUMN_WINDOW,
          viewRequestId: "released-jupyter-pyspark-connect-same-kernel-rebind",
          sessionId: connect.sessionId,
          revision: connectPage.revision,
          offset: 0,
          limit: 1,
          filterModel: connectPage.metadata.filterModel
        }),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the released-Jupyter Spark Connect page after same-kernel SparkSession replacement"
      );
      assert.equal(reboundConnect.kind, "page");
      if (reboundConnect.kind !== "page") {
        throw new Error("The released-Jupyter Spark Connect same-kernel rebind did not return a page.");
      }
      assert.equal(reboundConnect.metadata.sessionId, connect.sessionId);
      assert.deepEqual(reboundConnect.metadata.filterModel, connectPage.metadata.filterModel);
      const reboundConnectRecordId = reboundConnect.metadata.schema.find((column) => column.name === "record_id");
      assert.ok(reboundConnectRecordId);
      assert.deepEqual(
        gridColumnDisplays(reboundConnect.page, reboundConnectRecordId.id),
        ["102"],
        "Connect recovery must return the recreated variable, not a cached row from the stopped session."
      );
      await disposePackagedSessionPanel(testing, connect.sessionId, "the released-Jupyter Spark Connect session");

      recordAcceptanceProgress(`${phase}:connect-owner-session`);
      await executeReleasedNotebookCell(
        notebook,
        7,
        RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
        `${phase}:connect-owner-session`,
        await showExactReleasedNotebook(notebook)
      );
      const connectClose = releasedNotebookJsonResult(
        notebook.cellAt(7),
        RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
        "local Spark Connect close"
      );
      assert.equal(connectClose.sessionId, reboundConnectSetup.sessionId);
      assert.equal(connectClose.count, 3, "Closing Open Wrangler must leave the user's Connect SparkSession usable.");
      assert.equal(testing.diagnostics().sessionCount, 0);
      assert.equal(releasedJupyterSessionTabs().length, 0);
      assert.ok(jupyterApi, "The released Jupyter API must remain active through PySpark cleanup.");
    } catch (error) {
      failureCheckpoint = failedAcceptanceProgressCheckpoint(phase, getLastAcceptanceProgressCheckpoint());
      throw error;
    } finally {
      try {
        await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
        await configuration.update(
          "notebookPreviewProvider",
          originalNotebookPreviewProvider,
          vscode.ConfigurationTarget.Workspace
        );
        cleanupAcceptanceTemporaryDirectory(directory);
      } finally {
        if (failureCheckpoint) recordAcceptanceProgress(failureCheckpoint);
      }
    }
  };
}
