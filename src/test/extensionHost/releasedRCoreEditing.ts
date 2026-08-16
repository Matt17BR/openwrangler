import * as assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { FilterModel } from "../../shared/protocol";
import { assertExactBytes } from "./acceptanceSourceFixture";
import { exportCleanedDataThroughWorkbench } from "./cleanedDataExport";
import type { TestApi } from "./extensionHostTestApi";
import { releasedRNotebookCleanedCsvHeader, releasedRNotebookCleanedCsvRow } from "./releasedDocumentFixtures";
import { assertReleasedRGeneratedCode, assertReleasedRTextLengthGeneratedCode } from "./releasedRGeneratedCode";

type ReleasedRPhase = "jupyter-r" | "jupyter-r-remote";
type ReleasedRPreview = Readonly<{ app: Locator; stepId: string }>;
type ActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;

export interface ReleasedRCoreEditingDependencies {
  readonly GRID_COLUMN_WINDOW: Readonly<{ columnOffset: number; columnLimit: number }>;
  readonly QUEUED_RUNTIME_MUTATION_ACCEPTANCE_TIMEOUT_MS: number;
  readonly WORKBENCH_OPERATION_TIMEOUT_MS: number;
  readonly applyReleasedRQuickSort: (
    workbench: Page,
    testing: TestApi,
    column: string,
    direction: "ascending" | "descending",
    expectedPriority: readonly string[]
  ) => Promise<void>;
  readonly assertParquetFile: (filePath: string, label: string) => void;
  readonly assertReleasedRNotebookCodeInsertion: (
    testing: TestApi,
    notebook: vscode.NotebookDocument,
    active: ActiveSession,
    code: string,
    variableName: string,
    phase: ReleasedRPhase,
    outputDirectory: string
  ) => Promise<number>;
  readonly exerciseRealScriptSaveDialog: (
    page: Page,
    hostileDestination: vscode.Uri,
    destination: string,
    options: Readonly<{ language: "Python" | "R"; defaultSuffix: ".clean.py" | ".clean.R" }>
  ) => Promise<void>;
  readonly exerciseReleasedRCloneEditingLifecycle: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    phase: ReleasedRPhase
  ) => Promise<void>;
  readonly exerciseReleasedRFillMissingJourney: (
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    phase: "jupyter-r"
  ) => Promise<void>;
  readonly exerciseReleasedRPersistentRowsJourney: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    phase: ReleasedRPhase
  ) => Promise<void>;
  readonly exerciseReleasedRRowReductionJourney: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    phase: ReleasedRPhase
  ) => Promise<void>;
  readonly previewReleasedRClone: (
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    sourceName: string,
    newName: string
  ) => Promise<ReleasedRPreview>;
  readonly previewReleasedRDrop: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    sourceName: string,
    variableName?: string,
    checkpointPrefix?: string
  ) => Promise<ReleasedRPreview>;
  readonly previewReleasedRRename: (
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    sourceName: string,
    newName: string,
    replacement?: Readonly<{ replaceStepId: string; previousName: string }>,
    variableName?: string
  ) => Promise<ReleasedRPreview>;
  readonly previewReleasedRSelect: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    selectedNames: readonly string[],
    variableName?: string
  ) => Promise<ReleasedRPreview>;
  readonly previewReleasedRTextLength: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    sourceName: string,
    newColumn: string,
    variableName?: string
  ) => Promise<ReleasedRPreview>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    description: string
  ) => Promise<Locator>;
  readonly requireFreshExactSessionPanelHydration: (
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<void>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForOpenWranglerWebviewAction: (
    workbench: Page,
    name: string,
    requireEnabled?: boolean
  ) => Promise<unknown>;
}

export interface ReleasedRCoreEditingInput {
  readonly testing: TestApi;
  readonly workbench: Page;
  readonly sessionId: string;
  readonly notebook: vscode.NotebookDocument;
  readonly notebookPath: string;
  readonly outputDirectory: string;
  readonly phase: ReleasedRPhase;
  readonly initialApp: Locator;
}

export interface ReleasedRCoreEditingResult {
  readonly app: Locator;
  readonly coreScreenshot: Readonly<{ insertedRCellIndex: number; generatedCode: string }>;
}

export async function exerciseReleasedRCoreEditingCatalog(
  input: ReleasedRCoreEditingInput,
  dependencies: ReleasedRCoreEditingDependencies
): Promise<ReleasedRCoreEditingResult> {
  const { testing, workbench, sessionId, notebook, notebookPath, outputDirectory, phase } = input;
  let app = input.initialApp;
  const {
    GRID_COLUMN_WINDOW,
    QUEUED_RUNTIME_MUTATION_ACCEPTANCE_TIMEOUT_MS,
    WORKBENCH_OPERATION_TIMEOUT_MS,
    applyReleasedRQuickSort,
    assertParquetFile,
    assertReleasedRNotebookCodeInsertion,
    exerciseRealScriptSaveDialog,
    exerciseReleasedRCloneEditingLifecycle,
    exerciseReleasedRFillMissingJourney,
    exerciseReleasedRPersistentRowsJourney,
    exerciseReleasedRRowReductionJourney,
    previewReleasedRClone,
    previewReleasedRDrop,
    previewReleasedRRename,
    previewReleasedRSelect,
    previewReleasedRTextLength,
    recordAcceptanceProgress,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor,
    waitForOpenWranglerWebviewAction
  } = dependencies;

  if (phase === "jupyter-r") {
    await exerciseReleasedRPersistentRowsJourney(testing, workbench, sessionId, phase);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R session after persistent row operations");
    await exerciseReleasedRRowReductionJourney(testing, workbench, sessionId, phase);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R session after row reduction operations");
    await exerciseReleasedRFillMissingJourney(testing, workbench, app, sessionId, phase);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R session after Fill missing values");
  }

  recordAcceptanceProgress(`${phase}:editing:preview-discard`);
  const discarded = await previewReleasedRRename(testing, workbench, app, sessionId, "row_id", "record_id");
  app = discarded.app;
  const discardedReview = app.getByRole("region", { name: "Draft review" });
  await discardedReview.getByText("Rename column", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await discardedReview
    .locator('[aria-label="Data diff summary"]')
    .getByText("No value changes in this block", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  await app.locator('th[data-column="record_id"]').waitFor({ state: "visible", timeout: 10_000 });
  await discardedReview.getByRole("button", { name: "Discard", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 0 &&
        active.metadata.schema[0]?.name === "row_id" &&
        (active.code ?? "") === ""
      );
    },
    30_000,
    "discarding the native R rename preview"
  );
  await discardedReview.waitFor({ state: "hidden", timeout: 10_000 });

  recordAcceptanceProgress(`${phase}:editing:preview-apply`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R session after discarding its draft");
  const previewed = await previewReleasedRRename(testing, workbench, app, sessionId, "row_id", "record_id");
  app = previewed.app;
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const step = active?.metadata.steps[0];
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        step?.kind === "renameColumn" &&
        step.id === previewed.stepId &&
        step.params.column.name === "row_id" &&
        step.params.newName === "record_id" &&
        active.metadata.schema[0]?.name === "record_id"
      );
    },
    30_000,
    "applying the native R rename step"
  );
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The applied R rename must be acknowledged before inspection."
  );
  const firstApplied = testing.activeSession();
  assert.ok(firstApplied, "The applied native R rename must retain its session.");
  assertReleasedRGeneratedCode(firstApplied.code ?? "", "record_id");
  assert.equal(firstApplied.metadata.capabilities.notebookInsert, true);
  assert.equal(firstApplied.metadata.capabilities.exportCsv, true);
  assert.equal(firstApplied.metadata.capabilities.exportParquet, true);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R rename session");
  await app.getByRole("button", { name: "Export", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

  recordAcceptanceProgress(`${phase}:editing:export-cleaned-csv`);
  const notebookVersionBeforeExport = notebook.version;
  const notebookDirtyBeforeExport = notebook.isDirty;
  const notebookSourcesBeforeExport = notebook.getCells().map((cell) => cell.document.getText());
  const notebookBytesBeforeExport = readFileSync(notebookPath);
  await app.getByRole("button", { name: "Column profiles and filters", exact: true }).click();
  let exportDrawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
  await exportDrawer.waitFor({ state: "visible", timeout: 10_000 });
  await exportDrawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
  let exportFilterPanel = exportDrawer.locator(".filterSortPanel").first();
  const exportAdvancedFilters = exportFilterPanel.getByRole("button", { name: "Use advanced filters", exact: true });
  if ((await exportAdvancedFilters.count()) > 0) await exportAdvancedFilters.click();
  await exportFilterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "group" });
  await exportFilterPanel.getByLabel("Predicate operator", { exact: true }).selectOption("equals");
  await exportFilterPanel.getByLabel("equals predicate value", { exact: true }).fill("B");
  await exportFilterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
  await waitFor(
    () => {
      const current = testing.activeSession();
      return (
        current?.sessionId === sessionId &&
        current.metadata.filteredShape.rows === 603 &&
        current.viewState.filterModel.filters.length === 1 &&
        current.viewState.filterModel.filters[0]?.column === "group"
      );
    },
    30_000,
    "the R notebook export viewing filter"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the filtered R notebook export view");
  exportDrawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
  await exportDrawer.getByRole("button", { name: "Close panel" }).click();
  await exportDrawer.waitFor({ state: "hidden", timeout: WORKBENCH_OPERATION_TIMEOUT_MS });
  await applyReleasedRQuickSort(workbench, testing, "group", "ascending", ["group"]);
  await applyReleasedRQuickSort(workbench, testing, "score", "descending", ["score", "group"]);
  const exportView = testing.activeSession();
  assert.ok(exportView, "The filtered R notebook export requires its exact active session.");
  assert.equal(exportView.sessionId, sessionId);
  assert.equal(exportView.metadata.source.kind, "notebookVariable");
  assert.equal(exportView.metadata.source.uri, notebook.uri.toString());
  assert.equal(exportView.metadata.source.variableName, "orders_frame");
  assert.equal(exportView.metadata.shape.rows, 1_205);
  assert.equal(exportView.metadata.filteredShape.rows, 603);
  const exportViewModel = JSON.parse(JSON.stringify(exportView.viewState.filterModel)) as FilterModel;

  const exportPath = path.join(outputDirectory, `${phase}.orders.clean.csv`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the filtered R notebook session before CSV export");
  await exportCleanedDataThroughWorkbench(app, workbench, exportPath);
  await waitFor(() => existsSync(exportPath), 30_000, "the cleaned R notebook CSV export to appear");
  const exportedLines = readFileSync(exportPath, "utf8").split(/\r?\n/u);
  assert.equal(exportedLines.at(-1), "", "The native R CSV export must end with one newline.");
  exportedLines.pop();
  assert.equal(exportedLines.length, 1_206, "The native R CSV export must contain all source rows plus its header.");
  assert.equal(exportedLines[0], releasedRNotebookCleanedCsvHeader());
  assert.equal(exportedLines[1], releasedRNotebookCleanedCsvRow(1));
  assert.equal(exportedLines[2], releasedRNotebookCleanedCsvRow(2));
  assert.equal(exportedLines[1_205], releasedRNotebookCleanedCsvRow(1_205));
  const parquetExportPath = path.join(outputDirectory, `${phase}.orders.clean.parquet`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R notebook session after CSV export");
  await exportCleanedDataThroughWorkbench(app, workbench, parquetExportPath, "parquet");
  await waitFor(() => existsSync(parquetExportPath), 30_000, "the cleaned R notebook Parquet export to appear");
  assertParquetFile(parquetExportPath, "The public R notebook export");
  assert.deepEqual(
    readdirSync(outputDirectory).filter((name) => name.startsWith(".openwrangler-") && name.endsWith(".tmp")),
    [],
    "R notebook exports must not retain a sibling temporary file."
  );
  assert.deepEqual(
    testing.activeSession()?.viewState.filterModel,
    exportViewModel,
    "Exporting all committed rows must not alter the active viewing filter or sort."
  );
  assert.equal(notebook.version, notebookVersionBeforeExport, "Export must not change the source notebook version.");
  assert.equal(notebook.isDirty, notebookDirtyBeforeExport, "Export must not change the source notebook dirty state.");
  assert.deepEqual(
    notebook.getCells().map((cell) => cell.document.getText()),
    notebookSourcesBeforeExport,
    "Export must not edit any source notebook cell."
  );
  assertExactBytes(
    readFileSync(notebookPath),
    notebookBytesBeforeExport,
    "Export must not change the notebook on disk."
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R notebook session after data export");
  await app.getByRole("button", { name: "Column profiles and filters", exact: true }).click();
  exportDrawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
  await exportDrawer.waitFor({ state: "visible", timeout: 10_000 });
  await exportDrawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
  exportFilterPanel = exportDrawer.locator(".filterSortPanel").first();
  await exportFilterPanel.getByRole("button", { name: "Clear all", exact: true }).click();
  await waitFor(
    () => {
      const current = testing.activeSession();
      return (
        current?.sessionId === sessionId &&
        current.metadata.filteredShape.rows === 1_205 &&
        current.viewState.filterModel.filters.length === 0 &&
        current.viewState.filterModel.sort.length === 0
      );
    },
    30_000,
    "clearing the R notebook export view"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the cleared R notebook export view");
  exportDrawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
  await exportDrawer.getByRole("button", { name: "Close panel" }).click();

  recordAcceptanceProgress(`${phase}:editing:inspect`);
  await vscode.commands.executeCommand("openWrangler.selectStep", previewed.stepId);
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === previewed.stepId,
    30_000,
    "the applied native R rename inspection"
  );
  const inspected = testing.activeSession()?.stepInspection;
  assert.ok(inspected, "Selecting the applied R rename must publish its inspection.");
  assert.deepEqual(
    inspected.inputSchema.slice(0, 3).map((column) => column.name),
    ["row_id", "group", "score"]
  );
  assert.deepEqual(
    inspected.outputSchema.slice(0, 3).map((column) => column.name),
    ["record_id", "group", "score"]
  );
  assert.deepEqual(inspected.diff, {
    addedRows: 0,
    removedRows: 0,
    addedColumns: [],
    removedColumns: [],
    changedCells: 0,
    cells: [],
    truncated: false
  });
  assertReleasedRGeneratedCode(inspected.code, "record_id");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R rename session");
  const inspection = app.getByRole("region", { name: "Selected applied-step inspection" });
  await inspection.getByText(/Inspecting Rename column/u).waitFor({ state: "visible", timeout: 10_000 });
  await inspection
    .locator('[aria-label="Selected step data diff summary"]')
    .getByText("0 changed cells", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  await inspection.getByRole("button", { name: "Show confirmed data", exact: true }).click();
  await waitFor(
    () => testing.activeSession()?.stepInspection === undefined,
    10_000,
    "returning from the native R applied-step inspection"
  );

  recordAcceptanceProgress(`${phase}:editing:edit-latest`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the confirmed R rename session");
  const replacement = await previewReleasedRRename(testing, workbench, app, sessionId, "row_id", "case_id", {
    replaceStepId: previewed.stepId,
    previousName: "record_id"
  });
  app = replacement.app;
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const step = active?.metadata.steps[0];
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        step?.id === previewed.stepId &&
        step.kind === "renameColumn" &&
        step.params.column.name === "row_id" &&
        step.params.newName === "case_id" &&
        active.metadata.schema[0]?.name === "case_id"
      );
    },
    30_000,
    "reapplying the edited native R rename step"
  );
  const reapplied = testing.activeSession();
  assert.ok(reapplied, "The edited native R rename must retain its session.");
  assertReleasedRGeneratedCode(reapplied.code ?? "", "case_id");

  recordAcceptanceProgress(`${phase}:editing:copy-export`);
  const generatedCode = reapplied.code ?? "";
  const priorClipboard = await vscode.env.clipboard.readText();
  try {
    const copied = await vscode.commands.executeCommand<string>("openWrangler.copyCode");
    assert.equal(copied, generatedCode, "The public Copy Generated Code command must copy native R code.");
    assert.equal(
      (await vscode.env.clipboard.readText()).replaceAll("\r\n", "\n"),
      generatedCode.replaceAll("\r\n", "\n")
    );
  } finally {
    await vscode.env.clipboard.writeText(priorClipboard);
  }
  await assert.rejects(
    testing.exportCodeTo(vscode.Uri.file(notebookPath)),
    /never overwrites the active source/u,
    "The deterministic R script writer must reject the originating notebook."
  );
  const scriptPath = path.join(outputDirectory, `${phase}.orders.clean.R`);
  await exerciseRealScriptSaveDialog(workbench, vscode.Uri.file(notebookPath), scriptPath, {
    language: "R",
    defaultSuffix: ".clean.R"
  });
  assert.equal(readFileSync(scriptPath, "utf8"), generatedCode, "The public Save dialog must export native R code.");
  assert.deepEqual(
    readdirSync(outputDirectory).filter((name) => name.startsWith(".openwrangler-") && name.endsWith(".tmp")),
    [],
    "The R script export must not retain sibling temporary files."
  );
  const insertedRCellIndex = await assertReleasedRNotebookCodeInsertion(
    testing,
    notebook,
    reapplied,
    generatedCode,
    "orders_frame",
    phase,
    outputDirectory
  );
  const coreScreenshot = { insertedRCellIndex, generatedCode };

  recordAcceptanceProgress(`${phase}:editing:undo`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R session before undo");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema[0]?.name === "row_id" &&
        (active.code ?? "") === ""
      );
    },
    30_000,
    "undoing the edited native R rename step"
  );
  const restored = testing.activeSession();
  assert.ok(restored, "Undoing the R rename must retain the session.");
  const restoredPage = await testing.request({
    kind: "getPage",
    ...GRID_COLUMN_WINDOW,
    sessionId,
    revision: restored.metadata.revision,
    viewRequestId: `${phase}-editing-restored-page`,
    offset: 0,
    limit: 1,
    filterModel: restored.viewState.filterModel
  });
  assert.equal(restoredPage.kind, "page");
  if (restoredPage.kind !== "page") throw new Error("The undone R session did not return its original page.");
  assert.equal(restoredPage.metadata.schema[0]?.name, "row_id");
  assert.equal(restoredPage.page.rows[0]?.values[0]?.display, "1");

  recordAcceptanceProgress(`${phase}:editing:drop-preview-discard`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the restored R session before Drop Columns");
  const discardedDrop = await previewReleasedRDrop(
    testing,
    workbench,
    sessionId,
    "label",
    "orders_frame",
    `${phase}:editing:drop-code-preview`
  );
  app = discardedDrop.app;
  await app.getByRole("region", { name: "Draft review" }).getByRole("button", { name: "Discard", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema.some((column) => column.name === "label")
      );
    },
    30_000,
    "discarding the native R Drop Columns preview"
  );

  recordAcceptanceProgress(`${phase}:editing:drop-preview-apply-inspect-undo`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the restored R session before applying Drop Columns");
  const dropped = await previewReleasedRDrop(
    testing,
    workbench,
    sessionId,
    "label",
    "orders_frame",
    `${phase}:editing:drop-code-preview`
  );
  app = dropped.app;
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const step = active?.metadata.steps[0];
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        step?.kind === "dropColumns" &&
        step.id === dropped.stepId &&
        !active.metadata.schema.some((column) => column.name === "label")
      );
    },
    30_000,
    "applying the native R Drop Columns step"
  );
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The applied R Drop Columns step must be acknowledged before inspection."
  );
  await vscode.commands.executeCommand("openWrangler.selectStep", dropped.stepId);
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === dropped.stepId,
    30_000,
    "the applied native R Drop Columns inspection"
  );
  const dropInspection = testing.activeSession()?.stepInspection;
  assert.ok(dropInspection, "Selecting the applied R Drop Columns step must publish its inspection.");
  assert.deepEqual(dropInspection.diff.removedColumns, ["label"]);
  assert.equal(
    dropInspection.inputSchema.some((column) => column.name === "label"),
    true
  );
  assert.equal(
    dropInspection.outputSchema.some((column) => column.name === "label"),
    false
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R Drop Columns session");
  await app
    .getByRole("region", { name: "Selected applied-step inspection" })
    .getByRole("button", { name: "Show confirmed data", exact: true })
    .click();
  await waitFor(
    () => testing.activeSession()?.stepInspection === undefined,
    10_000,
    "returning from the native R Drop Columns inspection"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R Drop Columns session before undo");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema.some((column) => column.name === "label")
      );
    },
    30_000,
    "undoing the native R Drop Columns step"
  );

  recordAcceptanceProgress(`${phase}:editing:select-preview-discard`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the restored R session before Select Columns");
  const selected = await previewReleasedRSelect(testing, workbench, sessionId, ["score", "row_id", "label"]);
  app = selected.app;
  await app.getByRole("region", { name: "Draft review" }).getByRole("button", { name: "Discard", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema
          .slice(0, 4)
          .map((column) => column.name)
          .join("\u0000") === "row_id\u0000group\u0000score\u0000label"
      );
    },
    30_000,
    "discarding the native R Select Columns preview"
  );

  recordAcceptanceProgress(`${phase}:editing:select-preview-apply-inspect-undo`);
  app = await releasedRSessionApp(
    workbench,
    testing,
    sessionId,
    "the restored R session before applying Select Columns"
  );
  const appliedSelection = await previewReleasedRSelect(testing, workbench, sessionId, ["score", "row_id", "label"]);
  app = appliedSelection.app;
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const step = active?.metadata.steps[0];
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        step?.kind === "selectColumns" &&
        step.id === appliedSelection.stepId &&
        active.metadata.schema.map((column) => column.name).join("\u0000") === "score\u0000row_id\u0000label"
      );
    },
    30_000,
    "applying the native R Select Columns step"
  );
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The applied R Select Columns step must be acknowledged before inspection."
  );
  await vscode.commands.executeCommand("openWrangler.selectStep", appliedSelection.stepId);
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === appliedSelection.stepId,
    30_000,
    "the applied native R Select Columns inspection"
  );
  const selectInspection = testing.activeSession()?.stepInspection;
  assert.ok(selectInspection, "Selecting the applied R Select Columns step must publish its inspection.");
  const selectedColumnIds = new Set(selectInspection.outputSchema.map((column) => column.id));
  assert.deepEqual(
    selectInspection.diff.removedColumns,
    selectInspection.inputSchema.filter((column) => !selectedColumnIds.has(column.id)).map((column) => column.name)
  );
  assert.deepEqual(
    selectInspection.outputSchema.map((column) => column.name),
    ["score", "row_id", "label"]
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R Select Columns session");
  await app
    .getByRole("region", { name: "Selected applied-step inspection" })
    .getByRole("button", { name: "Show confirmed data", exact: true })
    .click();
  await waitFor(
    () => testing.activeSession()?.stepInspection === undefined,
    10_000,
    "returning from the native R Select Columns inspection"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R Select Columns session before undo");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema
          .slice(0, 4)
          .map((column) => column.name)
          .join("\u0000") === "row_id\u0000group\u0000score\u0000label"
      );
    },
    30_000,
    "undoing the native R Select Columns step"
  );

  recordAcceptanceProgress(`${phase}:editing:clone-preview-discard`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the restored R session before Clone Column");
  const discardedClone = await previewReleasedRClone(testing, workbench, app, sessionId, "score", "score_discarded");
  app = discardedClone.app;
  await app.getByRole("region", { name: "Draft review" }).getByRole("button", { name: "Discard", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        !active.metadata.schema.some((column) => column.name === "score_discarded") &&
        active.metadata.schema
          .slice(0, 4)
          .map((column) => column.name)
          .join("\u0000") === "row_id\u0000group\u0000score\u0000label"
      );
    },
    30_000,
    "discarding the native R Clone Column preview"
  );

  await exerciseReleasedRCloneEditingLifecycle(testing, workbench, sessionId, phase);
  recordAcceptanceProgress(`${phase}:editing:text-length-preview-discard`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the restored R session before Text Length");
  const discardedLength = await previewReleasedRTextLength(
    testing,
    workbench,
    sessionId,
    "label",
    "discarded_label_length"
  );
  app = discardedLength.app;
  await app.getByRole("region", { name: "Draft review" }).getByRole("button", { name: "Discard", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        !active.metadata.schema.some((column) => column.name === "discarded_label_length")
      );
    },
    30_000,
    "discarding the native R Text Length preview"
  );

  recordAcceptanceProgress(`${phase}:editing:text-length-preview-apply-inspect-undo`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the restored R session before applying Text Length");
  const measured = await previewReleasedRTextLength(testing, workbench, sessionId, "label", "label_length");
  app = measured.app;
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const step = active?.metadata.steps[0];
      const output = active?.metadata.schema.at(-1);
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        step?.kind === "textLength" &&
        step.id === measured.stepId &&
        step.params.column.name === "label" &&
        step.params.newColumn === "label_length" &&
        output?.id === `c:step:${measured.stepId}:0` &&
        output.name === "label_length" &&
        output.type === "integer"
      );
    },
    30_000,
    "applying the native R Text Length step"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Text Length step before inspection");
  const appliedLength = testing.activeSession();
  assert.ok(appliedLength, "The applied native R Text Length step must retain its session.");
  assertReleasedRTextLengthGeneratedCode(appliedLength.code ?? "", "label", "label_length");
  const derivedColumnId = `c:step:${measured.stepId}:0`;
  const lengthColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await lengthColumnSearch.fill("label_length");
  await app
    .getByRole("option", { name: /^label_length,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await lengthColumnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === derivedColumnId,
    10_000,
    "selecting the applied native R Text Length output through column search"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R Text Length output column");
  const lengthHeader = app.locator('th[data-column="label_length"]').first();
  await lengthHeader.waitFor({ state: "visible", timeout: 10_000 });
  const lengthColumnPosition = await lengthHeader.getAttribute("data-grid-column");
  assert.notEqual(lengthColumnPosition, null, "The R Text Length output must expose its full-schema grid position.");
  const firstLengthCell = app.locator(`td[data-grid-row="0"][data-grid-column="${lengthColumnPosition}"]`).first();
  await firstLengthCell.getByText("8", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await firstLengthCell.textContent())?.trim(), "8");
  await waitForOpenWranglerWebviewAction(workbench, "Add step", true);
  await vscode.commands.executeCommand("openWrangler.selectStep", measured.stepId);
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === measured.stepId,
    30_000,
    "the applied native R Text Length inspection"
  );
  const lengthInspection = testing.activeSession()?.stepInspection;
  assert.ok(lengthInspection, "Selecting the applied R Text Length step must publish its inspection.");
  assert.deepEqual(lengthInspection.diff, {
    addedRows: 0,
    removedRows: 0,
    addedColumns: ["label_length"],
    removedColumns: [],
    changedCells: 0,
    cells: [],
    truncated: false
  });
  assert.equal(
    lengthInspection.inputSchema.some((column) => column.name === "label_length"),
    false
  );
  assert.deepEqual(
    lengthInspection.outputSchema.at(-1),
    appliedLength.metadata.schema.at(-1),
    "The R Text Length inspection must retain the derived column identity and type."
  );
  assertReleasedRTextLengthGeneratedCode(lengthInspection.code, "label", "label_length");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R Text Length session");
  await app
    .getByRole("region", { name: "Selected applied-step inspection" })
    .getByRole("button", { name: "Show confirmed data", exact: true })
    .click();
  await waitFor(
    () => testing.activeSession()?.stepInspection === undefined,
    10_000,
    "returning from the native R Text Length inspection"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R Text Length session before undo");
  const lengthUndoState = (): Record<string, unknown> => {
    const active = testing.activeSession();
    return {
      revision: active?.metadata.revision,
      appliedRevision: appliedLength.metadata.revision,
      stepCount: active?.metadata.steps.length,
      draft: active?.metadata.draftStep?.kind,
      derivedColumnPresent: active?.metadata.schema.some((column) => column.id === derivedColumnId),
      firstColumns: active?.metadata.schema.slice(0, 4).map((column) => column.name),
      codeEmpty: (active?.code ?? "") === "",
      scheduler: testing.sessionSchedulerState(sessionId),
      panel: {
        hydrated: testing.panelHydrated(sessionId),
        synchronizable: testing.panelSynchronizable(sessionId),
        receipt: testing.panelSynchronizationReceipt(sessionId)
      }
    };
  };
  await waitFor(
    () => {
      const scheduler = testing.sessionSchedulerState(sessionId);
      return (
        scheduler?.sessionId === sessionId &&
        scheduler.activeForegroundOperation === false &&
        scheduler.interactiveQueueLength === 0
      );
    },
    10_000,
    "the native R foreground lane to settle before Undo",
    () => JSON.stringify(lengthUndoState())
  );
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const scheduler = testing.sessionSchedulerState(sessionId);
      return (
        active?.sessionId === sessionId &&
        ((active.metadata.revision ?? appliedLength.metadata.revision) > appliedLength.metadata.revision ||
          scheduler?.activeForegroundOperation === true ||
          (scheduler?.interactiveQueueLength ?? 0) > 0)
      );
    },
    5_000,
    "the native R Text Length Undo click to dispatch once",
    () => JSON.stringify(lengthUndoState())
  );
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        !active.metadata.schema.some((column) => column.id === `c:step:${measured.stepId}:0`) &&
        active.metadata.schema
          .slice(0, 4)
          .map((column) => column.name)
          .join("\u0000") === "row_id\u0000group\u0000score\u0000label" &&
        (active.code ?? "") === ""
      );
    },
    QUEUED_RUNTIME_MUTATION_ACCEPTANCE_TIMEOUT_MS,
    "undoing the native R Text Length step",
    () => JSON.stringify(lengthUndoState())
  );
  assert.ok(coreScreenshot, "The core R editing catalog must retain its notebook insertion receipt.");
  return { app, coreScreenshot };
}
