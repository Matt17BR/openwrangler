import * as assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { DataRow, FilterModel } from "../../shared/protocol";
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
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<Readonly<{ app: Locator; dialog: Locator }>>;
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
  readonly reacquireAcknowledgedSessionApp: ReleasedRCoreEditingDependencies["releasedRSessionApp"];
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
    openReleasedROperationPicker,
    previewReleasedRClone,
    previewReleasedRDrop,
    previewReleasedRRename,
    previewReleasedRSelect,
    previewReleasedRTextLength,
    recordAcceptanceProgress,
    reacquireAcknowledgedSessionApp,
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

    recordAcceptanceProgress(`${phase}:editing:mark-duplicates-preview-apply-undo`);
    const duplicateBase = testing.activeSession();
    assert.ok(duplicateBase?.sessionId === sessionId);
    assert.equal(duplicateBase.metadata.steps.length, 0);
    assert.equal(duplicateBase.metadata.draftStep, undefined);
    assert.deepEqual(duplicateBase.viewState.filterModel, { filters: [], sort: [] });
    const duplicateSource = duplicateBase.metadata.schema.find((column) => column.name === "group");
    assert.ok(duplicateSource);
    const duplicateSourceBytes = readFileSync(notebookPath);
    const duplicateNotebookVersion = notebook.version;
    const duplicateNotebookDirty = notebook.isDirty;
    const duplicateNotebookCells = notebook.getCells().map((cell) => cell.document.getText());
    const readDuplicateSample = async (active: ActiveSession): Promise<DataRow[]> => {
      const rows: DataRow[] = [];
      for (const offset of [0, 602]) {
        const response = await testing.request(
          {
            kind: "getPage",
            sessionId,
            revision: active.metadata.revision,
            viewRequestId: `${phase}-duplicates-${active.metadata.revision}-${offset}`,
            offset,
            limit: 2,
            filterModel: duplicateBase.viewState.filterModel,
            columnOffset: 0,
            columnLimit: active.metadata.schema.length
          },
          { ephemeralPage: true }
        );
        assert.equal(response.kind, "page");
        if (response.kind !== "page") throw new Error("The native R duplicate sample did not return a page.");
        assert.equal(response.metadata.sessionId, sessionId);
        assert.equal(response.revision, active.metadata.revision);
        assert.equal(response.page.totalRows, 1205);
        assert.equal(response.page.offset, offset);
        assert.equal(response.page.rows.length, 2);
        assert.deepEqual(
          response.page.columnIds,
          active.metadata.schema.map((column) => column.id)
        );
        rows.push(...response.page.rows);
      }
      return rows;
    };
    const duplicateOriginalRows = await readDuplicateSample(duplicateBase);
    assert.deepEqual(
      duplicateOriginalRows.map((row) => row.values[duplicateSource.position]?.raw),
      ["A", "A", "B", "B"]
    );
    const duplicatePicker = await openReleasedROperationPicker(testing, workbench, sessionId);
    await duplicatePicker.dialog.getByPlaceholder("Search operations").fill("mark duplicates");
    await duplicatePicker.dialog.getByRole("button", { name: /^Mark duplicates\b/u }).click();
    await duplicatePicker.dialog.getByRole("checkbox", { name: "group", exact: true }).check();
    await duplicatePicker.dialog.getByLabel("New column", { exact: true }).fill("group_repeated");
    await duplicatePicker.dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () =>
        testing.activeSession()?.sessionId === sessionId &&
        testing.activeSession()?.metadata.draftStep?.kind === "markDuplicates",
      30_000,
      "previewing Mark Duplicates through the native R form"
    );
    const duplicatePreview = testing.activeSession();
    assert.ok(duplicatePreview?.metadata.draftStep?.kind === "markDuplicates");
    const duplicateStep = duplicatePreview.metadata.draftStep;
    assert.deepEqual(duplicateStep.params, {
      columns: [{ id: duplicateSource.id, name: duplicateSource.name }],
      newColumn: "group_repeated"
    });
    const duplicateOutput = duplicatePreview.metadata.schema.at(-1);
    assert.ok(duplicateOutput);
    assert.equal(duplicateOutput.id, `c:step:${duplicateStep.id}:0`);
    assert.equal(duplicateOutput.position, duplicateBase.metadata.schema.length);
    assert.equal(duplicateOutput.name, "group_repeated");
    assert.equal(duplicateOutput.type, "boolean");
    assert.equal(duplicateOutput.rawType, "logical");
    assert.equal(duplicateOutput.nullable, false);
    assert.deepEqual(duplicatePreview.metadata.schema.slice(0, -1), duplicateBase.metadata.schema);
    assertReleasedRGeneratedCode(duplicatePreview.code ?? "", "group_repeated");
    const duplicatePreviewRows = await readDuplicateSample(duplicatePreview);
    assert.deepEqual(
      duplicatePreviewRows.map((row) => ({ ...row, values: row.values.slice(0, -1) })),
      duplicateOriginalRows
    );
    assert.deepEqual(
      duplicatePreviewRows.map((row) => row.values.at(-1)),
      Array.from({ length: 4 }, () => ({ kind: "boolean", raw: true, display: "TRUE", isNull: false, isNaN: false }))
    );
    await requireFreshExactSessionPanelHydration(testing, sessionId, "The R duplicate draft must reach its renderer.");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Mark Duplicates draft");
    const duplicateReview = app.getByRole("region", { name: "Draft review" });
    await duplicateReview.getByText("Mark duplicates", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await duplicateReview.getByRole("button", { name: "Apply step", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          active.metadata.steps[0]?.id === duplicateStep.id
        );
      },
      30_000,
      "applying native R Mark Duplicates"
    );
    const duplicateApplied = testing.activeSession();
    assert.ok(duplicateApplied);
    assert.deepEqual(duplicateApplied.metadata.steps, [duplicateStep]);
    assert.deepEqual(duplicateApplied.metadata.schema, duplicatePreview.metadata.schema);
    assert.equal(duplicateApplied.code, duplicatePreview.code);
    assert.deepEqual(await readDuplicateSample(duplicateApplied), duplicatePreviewRows);
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The applied R duplicate flag must reach its renderer."
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Mark Duplicates session");
    const duplicateColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await duplicateColumnSearch.fill(duplicateOutput.name);
    await app
      .getByRole("option", { name: /^group_repeated,/u })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await duplicateColumnSearch.press("Enter");
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.revision === duplicateApplied.metadata.revision &&
          active.viewState.selectedColumnId === duplicateOutput.id
        );
      },
      10_000,
      "selecting the applied native R duplicate flag through column search"
    );
    app = await reacquireAcknowledgedSessionApp(workbench, testing, sessionId, "the selected native R duplicate flag");
    const duplicateHeader = app.locator('th[data-column="group_repeated"]').first();
    await duplicateHeader.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await duplicateHeader.getAttribute("data-grid-column"), String(duplicateOutput.position));
    const duplicateCellSelector = `td[data-grid-row="0"][data-grid-column="${duplicateOutput.position}"]`;
    const duplicateCell = app.locator(duplicateCellSelector).first();
    await duplicateCell.getByText("TRUE", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    assert.equal((await duplicateCell.innerText()).trim(), "TRUE");
    await app.locator(`${duplicateCellSelector}:focus`).waitFor({ state: "visible", timeout: 10_000 });
    const duplicateExposure = await duplicateCell.evaluate((element, column) => {
      type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
      type GridElement = {
        clientWidth: number;
        clientHeight: number;
        clientLeft: number;
        clientTop: number;
        offsetWidth: number;
        getBoundingClientRect(): Rect;
        closest(selector: string): GridElement | null;
        querySelector(selector: string): GridElement | null;
        contains(target: unknown): boolean;
        ownerDocument: {
          activeElement: unknown;
          documentElement: { clientWidth: number; clientHeight: number };
          elementFromPoint(x: number, y: number): unknown;
        };
      };
      const cell = element as unknown as GridElement;
      const scroller = cell.closest(".tableScroller");
      const workspace = cell.closest(".app");
      const rowHeader = cell.closest("tr")?.querySelector('[role="rowheader"]');
      const header = scroller?.querySelector(`th[data-grid-column="${column}"]`);
      if (!scroller || !workspace || !rowHeader || !header)
        throw new Error("The revealed R cell requires its grid, column header and row label.");
      const clientBounds = (target: GridElement) => {
        const rect = target.getBoundingClientRect();
        const scale = rect.width / target.offsetWidth;
        const left = rect.left + target.clientLeft * scale;
        const top = rect.top + target.clientTop * scale;
        return { left, top, right: left + target.clientWidth * scale, bottom: top + target.clientHeight * scale };
      };
      const viewport = clientBounds(scroller);
      const workspaceBounds = clientBounds(workspace);
      const documentViewport = cell.ownerDocument.documentElement;
      const outer = {
        left: Math.max(0, workspaceBounds.left),
        top: Math.max(0, workspaceBounds.top),
        right: Math.min(documentViewport.clientWidth, workspaceBounds.right),
        bottom: Math.min(documentViewport.clientHeight, workspaceBounds.bottom)
      };
      const bounds = cell.getBoundingClientRect();
      const contentLeft = Math.max(viewport.left, rowHeader.getBoundingClientRect().right);
      const left = Math.max(bounds.left, contentLeft, outer.left);
      const right = Math.min(bounds.right, viewport.right, outer.right);
      const top = Math.max(viewport.top, outer.top, header.getBoundingClientRect().bottom);
      const bottom = Math.min(viewport.bottom, outer.bottom);
      const requiredWidth = Math.min(bounds.width, Math.max(0, viewport.right - contentLeft));
      const hit = cell.ownerDocument.elementFromPoint((left + right) / 2, (bounds.top + bounds.bottom) / 2);
      return {
        requiredWidth,
        visibleWidth: Math.max(0, right - left),
        fullHeight: bounds.top >= top - 1 && bounds.bottom <= bottom + 1,
        hit: hit === cell || cell.contains(hit),
        focused: cell.ownerDocument.activeElement === cell,
        cell: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
        viewport,
        outer
      };
    }, duplicateOutput.position);
    assert.ok(
      duplicateExposure.requiredWidth > 0 &&
        duplicateExposure.visibleWidth + 1 >= duplicateExposure.requiredWidth &&
        duplicateExposure.fullHeight &&
        duplicateExposure.hit &&
        duplicateExposure.focused,
      `The native R duplicate flag must expose its available width and full row inside the workbench. ${JSON.stringify(duplicateExposure)}`
    );
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 0 &&
          !active.metadata.schema.some((column) => column.id === duplicateOutput.id)
        );
      },
      30_000,
      "undoing native R Mark Duplicates"
    );
    const duplicateRestored = testing.activeSession();
    assert.ok(duplicateRestored);
    assert.deepEqual(duplicateRestored.metadata.schema, duplicateBase.metadata.schema);
    assert.equal(duplicateRestored.code ?? "", duplicateBase.code ?? "");
    assert.deepEqual(duplicateRestored.viewState.filterModel, duplicateBase.viewState.filterModel);
    assert.deepEqual(await readDuplicateSample(duplicateRestored), duplicateOriginalRows);
    assert.equal(notebook.version, duplicateNotebookVersion);
    assert.equal(notebook.isDirty, duplicateNotebookDirty);
    assert.deepEqual(
      notebook.getCells().map((cell) => cell.document.getText()),
      duplicateNotebookCells
    );
    assertExactBytes(
      readFileSync(notebookPath),
      duplicateSourceBytes,
      "Mark Duplicates must preserve the source notebook."
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R session after undoing Mark Duplicates");

    recordAcceptanceProgress(`${phase}:editing:dense-rank-preview-apply-undo`);
    const rankBase = testing.activeSession();
    assert.ok(rankBase?.sessionId === sessionId);
    assert.equal(rankBase.metadata.steps.length, 0);
    assert.equal(rankBase.metadata.draftStep, undefined);
    assert.deepEqual(rankBase.viewState.filterModel, { filters: [], sort: [] });
    const rankSource = rankBase.metadata.schema.find((column) => column.name === "fractional_score");
    assert.ok(rankSource, "The R rank fixture must expose fractional_score.");
    const rankSourceBytes = readFileSync(notebookPath);
    const rankNotebookVersion = notebook.version;
    const rankNotebookDirty = notebook.isDirty;
    const rankNotebookCells = notebook.getCells().map((cell) => cell.document.getText());
    const readRankSample = async (
      active: ActiveSession,
      column: ActiveSession["metadata"]["schema"][number],
      label: string
    ): Promise<DataRow[]> => {
      const rows: DataRow[] = [];
      for (const [offset, limit] of [
        [0, 2],
        [602, 1],
        [1204, 1]
      ] as const) {
        const response = await testing.request(
          {
            kind: "getPage",
            sessionId,
            revision: active.metadata.revision,
            viewRequestId: `${phase}-rank-${label}-${offset}`,
            offset,
            limit,
            filterModel: rankBase.viewState.filterModel,
            columnOffset: column.position,
            columnLimit: 1
          },
          { ephemeralPage: true }
        );
        assert.equal(response.kind, "page");
        if (response.kind !== "page") throw new Error("The native R rank sample did not return a page.");
        assert.equal(response.metadata.sessionId, sessionId);
        assert.equal(response.revision, active.metadata.revision);
        assert.equal(response.page.totalRows, 1205);
        assert.equal(response.page.offset, offset);
        assert.equal(response.page.rows.length, limit);
        assert.deepEqual(response.page.columnIds, [column.id]);
        rows.push(...response.page.rows);
      }
      return rows;
    };
    const sourceSample = await readRankSample(rankBase, rankSource, "source");
    assert.deepEqual(
      [sourceSample[0], sourceSample[1], sourceSample[3]].map((row) => row?.values[0]?.raw),
      [1.25, -2.25, 1205.25]
    );
    assert.equal(sourceSample[2]?.values[0]?.isNull, true);
    const rankPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
    const rankDialog = rankPicker.dialog;
    await rankDialog.getByPlaceholder("Search operations").fill("rank");
    await rankDialog.getByRole("button", { name: /^Dense rank\b/u }).click();
    await rankDialog.getByLabel("Numeric column", { exact: true }).selectOption(rankSource.id);
    assert.equal(await rankDialog.getByLabel("Direction", { exact: true }).inputValue(), "asc");
    await rankDialog.getByLabel("Direction", { exact: true }).selectOption("desc");
    await rankDialog.getByLabel("New column", { exact: true }).fill("fractional_rank");
    await rankDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () =>
        testing.activeSession()?.sessionId === sessionId &&
        testing.activeSession()?.metadata.draftStep?.kind === "denseRank",
      30_000,
      "previewing Dense Rank through the native R form"
    );
    const rankPreview = testing.activeSession();
    assert.ok(rankPreview?.metadata.draftStep?.kind === "denseRank");
    const rankStep = rankPreview.metadata.draftStep;
    assert.deepEqual(rankStep.params, {
      column: { id: rankSource.id, name: rankSource.name },
      direction: "desc",
      newColumn: "fractional_rank"
    });
    const rankOutput = rankPreview.metadata.schema.at(-1);
    assert.ok(rankOutput);
    assert.equal(rankOutput.id, `c:step:${rankStep.id}:0`);
    assert.equal(rankOutput.position, rankBase.metadata.schema.length);
    assert.equal(rankOutput.name, "fractional_rank");
    assert.equal(rankOutput.type, "integer");
    assert.equal(rankOutput.rawType, "integer");
    assert.equal(rankOutput.nullable, true);
    assert.deepEqual(rankPreview.metadata.schema.slice(0, -1), rankBase.metadata.schema);
    assertReleasedRGeneratedCode(rankPreview.code ?? "", "fractional_rank");
    const previewRanks = await readRankSample(rankPreview, rankOutput, "preview");
    assert.deepEqual(
      previewRanks.map((row) => row.values[0]),
      ["602", "603", undefined, "1"].map((raw) =>
        raw === undefined
          ? sourceSample[2]?.values[0]
          : { kind: "integer", raw, display: raw, isNull: false, isNaN: false }
      )
    );
    assert.deepEqual(
      previewRanks.map(({ values: _values, ...row }) => row),
      sourceSample.map(({ values: _values, ...row }) => row)
    );
    await requireFreshExactSessionPanelHydration(testing, sessionId, "The R rank draft must reach its renderer.");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Dense Rank draft");
    const rankReview = app.getByRole("region", { name: "Draft review" });
    await rankReview.getByText("Dense rank", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await rankReview.getByRole("button", { name: "Apply step", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          active.metadata.steps[0]?.id === rankStep.id
        );
      },
      30_000,
      "applying native R Dense Rank"
    );
    const rankApplied = testing.activeSession();
    assert.ok(rankApplied);
    assert.deepEqual(rankApplied.metadata.steps, [rankStep]);
    assert.deepEqual(rankApplied.metadata.schema, rankPreview.metadata.schema);
    assert.equal(rankApplied.code, rankPreview.code);
    assert.deepEqual(await readRankSample(rankApplied, rankOutput, "applied"), previewRanks);
    await requireFreshExactSessionPanelHydration(testing, sessionId, "The applied R rank must reach its renderer.");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Dense Rank session");
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 0 &&
          !active.metadata.schema.some((column) => column.id === rankOutput.id)
        );
      },
      30_000,
      "undoing native R Dense Rank"
    );
    const rankRestored = testing.activeSession();
    assert.ok(rankRestored);
    assert.deepEqual(rankRestored.metadata.schema, rankBase.metadata.schema);
    assert.equal(rankRestored.code ?? "", rankBase.code ?? "");
    assert.deepEqual(rankRestored.viewState.filterModel, rankBase.viewState.filterModel);
    assert.deepEqual(await readRankSample(rankRestored, rankSource, "restored"), sourceSample);
    assert.equal(notebook.version, rankNotebookVersion);
    assert.equal(notebook.isDirty, rankNotebookDirty);
    assert.deepEqual(
      notebook.getCells().map((cell) => cell.document.getText()),
      rankNotebookCells
    );
    assertExactBytes(readFileSync(notebookPath), rankSourceBytes, "Dense Rank must preserve the source notebook.");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R session after undoing Dense Rank");
    const rankRestoredFirstColumn = rankRestored.metadata.schema[0];
    assert.equal(rankRestoredFirstColumn?.name, "row_id");
    assert.ok(rankRestoredFirstColumn);
    const rankColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await rankColumnSearch.waitFor({ state: "visible", timeout: 10_000 });
    await rankColumnSearch.fill(rankRestoredFirstColumn.name);
    await app
      .getByRole("option", { name: /^row_id,/u })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await rankColumnSearch.press("Enter");
    await waitFor(
      () => {
        const active = testing.activeSession();
        return active?.sessionId === sessionId && active.viewState.selectedColumnId === rankRestoredFirstColumn.id;
      },
      10_000,
      "selecting the restored first R column after Dense Rank"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the restored first R column after Dense Rank");
    await app.locator('th[data-column="row_id"]').waitFor({ state: "visible", timeout: 10_000 });
    await app
      .locator('td[data-grid-row="0"][data-grid-column="0"]')
      .first()
      .getByText("1", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
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
  const readRenamePage = async (session: ActiveSession, viewRequestId: string) => {
    const response = await testing.request(
      {
        kind: "getPage",
        ...GRID_COLUMN_WINDOW,
        sessionId,
        revision: session.metadata.revision,
        viewRequestId,
        offset: 0,
        limit: 1,
        filterModel: session.viewState.filterModel
      },
      { ephemeralPage: true }
    );
    assert.equal(response.kind, "page", "The native R rename check requires its bounded confirmed page.");
    if (response.kind !== "page") throw new Error("The native R rename check did not return a page.");
    assert.equal(response.metadata.sessionId, sessionId);
    assert.equal(response.revision, session.metadata.revision);
    return response;
  };
  const reappliedPage = await readRenamePage(reapplied, `${phase}-editing-before-undo-page`);

  recordAcceptanceProgress(`${phase}:editing:undo`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R session before undo");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.revision === reapplied.metadata.revision + 1 &&
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
  assert.equal(restored.metadata.canRedo, true);
  const restoredPage = await readRenamePage(restored, `${phase}-editing-restored-page`);
  assert.equal(restoredPage.metadata.schema[0]?.name, "row_id");
  assert.equal(restoredPage.page.rows[0]?.values[0]?.display, "1");

  recordAcceptanceProgress(`${phase}:editing:redo`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the undone native R rename before Redo");
  assert.equal(await app.getByRole("button", { name: "Undo", exact: true }).count(), 0);
  assert.equal(await app.getByRole("button", { name: "Edit latest", exact: true }).count(), 0);
  await app.getByRole("button", { name: "Redo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.revision === restored.metadata.revision + 1 &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        active.metadata.steps[0]?.id === previewed.stepId
      );
    },
    30_000,
    "Redo to restore the edited native R rename once"
  );
  const redone = testing.activeSession();
  assert.ok(redone, "Redo must retain the native R session.");
  assert.equal(redone.metadata.canRedo, false);
  assert.deepEqual(redone.metadata.steps, reapplied.metadata.steps);
  assert.deepEqual(redone.metadata.schema, reapplied.metadata.schema);
  assert.deepEqual(redone.metadata.source, reapplied.metadata.source);
  assert.equal(redone.code, generatedCode, "Redo must restore the same copied, saved and inserted native R plan.");
  assert.deepEqual((await readRenamePage(redone, `${phase}-editing-redone-page`)).page, reappliedPage.page);

  app = await releasedRSessionApp(workbench, testing, sessionId, "the redone native R rename before final Undo");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.revision === redone.metadata.revision + 1 &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined
      );
    },
    30_000,
    "Undo to restore the native R core journey before Drop Columns"
  );
  const final = testing.activeSession();
  assert.ok(final);
  assert.equal(final.metadata.canRedo, true);
  assert.deepEqual(final.metadata.schema, restored.metadata.schema);
  assert.deepEqual(final.metadata.source, restored.metadata.source);
  assert.equal(final.code, restored.code);
  assert.deepEqual((await readRenamePage(final, `${phase}-editing-final-undo-page`)).page, restoredPage.page);

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
  recordAcceptanceProgress(`${phase}:editing:text-length:restored-session-app:start`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the restored R session before applying Text Length");
  recordAcceptanceProgress(`${phase}:editing:text-length:restored-session-app:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:preview:start`);
  const measured = await previewReleasedRTextLength(testing, workbench, sessionId, "label", "label_length");
  recordAcceptanceProgress(`${phase}:editing:text-length:preview:complete`);
  app = measured.app;
  recordAcceptanceProgress(`${phase}:editing:text-length:apply-click:start`);
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  recordAcceptanceProgress(`${phase}:editing:text-length:apply-click:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:apply-confirmed:start`);
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
  recordAcceptanceProgress(`${phase}:editing:text-length:apply-confirmed:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:applied-session-app:start`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Text Length step before inspection");
  recordAcceptanceProgress(`${phase}:editing:text-length:applied-session-app:complete`);
  const appliedLength = testing.activeSession();
  assert.ok(appliedLength, "The applied native R Text Length step must retain its session.");
  assertReleasedRTextLengthGeneratedCode(appliedLength.code ?? "", "label", "label_length");
  const derivedColumnId = `c:step:${measured.stepId}:0`;
  const lengthColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  recordAcceptanceProgress(`${phase}:editing:text-length:column-search-fill:start`);
  await lengthColumnSearch.fill("label_length");
  recordAcceptanceProgress(`${phase}:editing:text-length:column-search-fill:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:column-option-visible:start`);
  await app
    .getByRole("option", { name: /^label_length,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  recordAcceptanceProgress(`${phase}:editing:text-length:column-option-visible:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:column-search-enter:start`);
  await lengthColumnSearch.press("Enter");
  recordAcceptanceProgress(`${phase}:editing:text-length:column-search-enter:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:column-selected:start`);
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === derivedColumnId,
    10_000,
    "selecting the applied native R Text Length output through column search"
  );
  recordAcceptanceProgress(`${phase}:editing:text-length:column-selected:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:selected-session-app:start`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R Text Length output column");
  recordAcceptanceProgress(`${phase}:editing:text-length:selected-session-app:complete`);
  const lengthHeader = app.locator('th[data-column="label_length"]').first();
  recordAcceptanceProgress(`${phase}:editing:text-length:header-visible:start`);
  await lengthHeader.waitFor({ state: "visible", timeout: 10_000 });
  recordAcceptanceProgress(`${phase}:editing:text-length:header-visible:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:header-position:start`);
  const lengthColumnPosition = await lengthHeader.getAttribute("data-grid-column");
  recordAcceptanceProgress(`${phase}:editing:text-length:header-position:complete`);
  assert.notEqual(lengthColumnPosition, null, "The R Text Length output must expose its full-schema grid position.");
  const firstLengthCell = app.locator(`td[data-grid-row="0"][data-grid-column="${lengthColumnPosition}"]`).first();
  recordAcceptanceProgress(`${phase}:editing:text-length:cell-visible:start`);
  await firstLengthCell.getByText("8", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  recordAcceptanceProgress(`${phase}:editing:text-length:cell-visible:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:cell-text:start`);
  assert.equal((await firstLengthCell.textContent())?.trim(), "8");
  recordAcceptanceProgress(`${phase}:editing:text-length:cell-text:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:add-step-ready:start`);
  await waitForOpenWranglerWebviewAction(workbench, "Add step", true);
  recordAcceptanceProgress(`${phase}:editing:text-length:add-step-ready:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:inspection-command:start`);
  await vscode.commands.executeCommand("openWrangler.selectStep", measured.stepId);
  recordAcceptanceProgress(`${phase}:editing:text-length:inspection-command:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:inspection-confirmed:start`);
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === measured.stepId,
    30_000,
    "the applied native R Text Length inspection"
  );
  recordAcceptanceProgress(`${phase}:editing:text-length:inspection-confirmed:complete`);
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
  recordAcceptanceProgress(`${phase}:editing:text-length:inspection-session-app:start`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R Text Length session");
  recordAcceptanceProgress(`${phase}:editing:text-length:inspection-session-app:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:confirmed-data-click:start`);
  await app
    .getByRole("region", { name: "Selected applied-step inspection" })
    .getByRole("button", { name: "Show confirmed data", exact: true })
    .click();
  recordAcceptanceProgress(`${phase}:editing:text-length:confirmed-data-click:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:confirmed-data-restored:start`);
  await waitFor(
    () => testing.activeSession()?.stepInspection === undefined,
    10_000,
    "returning from the native R Text Length inspection"
  );
  recordAcceptanceProgress(`${phase}:editing:text-length:confirmed-data-restored:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-session-app:start`);
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R Text Length session before undo");
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-session-app:complete`);
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
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-lane-idle:start`);
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
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-lane-idle:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-click:start`);
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-click:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-dispatched:start`);
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
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-dispatched:complete`);
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-confirmed:start`);
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
  recordAcceptanceProgress(`${phase}:editing:text-length:undo-confirmed:complete`);
  assert.ok(coreScreenshot, "The core R editing catalog must retain its notebook insertion receipt.");
  return { app, coreScreenshot };
}
