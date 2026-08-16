import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { revealCodePreviewText, waitForCodePreview } from "./codePreview";
import type { TestApi } from "./extensionHostTestApi";
import {
  assertReleasedRFormatDatetimeGeneratedCode,
  assertReleasedRFormulaGeneratedCode
} from "./releasedRGeneratedCode";

export interface ReleasedRFormulaDatetimeDependencies {
  readonly RELEASED_R_SUPPORTED_OPERATIONS: readonly string[];
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<Readonly<{ app: Locator; dialog: Locator }>>;
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
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
  readonly waitForLocatorText: (
    locator: Locator,
    predicate: (text: string) => boolean,
    timeoutMs: number,
    expectation: string
  ) => Promise<void>;
}

export function createReleasedRFormulaDatetimeOperations(dependencies: ReleasedRFormulaDatetimeDependencies): Readonly<{
  exerciseReleasedRFormulaJourney: (testing: TestApi, workbench: Page, sessionId: string) => Promise<void>;
  exerciseReleasedRFormatDatetimeJourney: (testing: TestApi, workbench: Page, sessionId: string) => Promise<void>;
}> {
  const {
    RELEASED_R_SUPPORTED_OPERATIONS,
    openReleasedROperationPicker,
    recordAcceptanceProgress,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor,
    waitForLocatorText
  } = dependencies;

  async function exerciseReleasedRFormulaJourney(testing: TestApi, workbench: Page, sessionId: string): Promise<void> {
    recordAcceptanceProgress("jupyter-r:editing:formula-preview-apply-undo");
    const base = testing.activeSession();
    assert.ok(base, "The restored R session must remain available for Formula.");
    assert.equal(base.metadata.steps.length, 0);
    assert.equal(base.metadata.draftStep, undefined);
    const score = base.metadata.schema.find((column) => column.name === "score");
    assert.ok(score, "The packaged R Formula journey requires the score column.");

    const picker = await openReleasedROperationPicker(testing, workbench, sessionId);
    const dialog = picker.dialog;
    const catalog = dialog.getByRole("navigation", { name: "Operation catalog" });
    const choices = catalog.locator("button.operationChoice");
    assert.equal(
      await choices.count(),
      RELEASED_R_SUPPORTED_OPERATIONS.length,
      "The packaged R picker must expose exactly its advertised operation catalog."
    );
    for (const expected of [
      /^Formula column\b/u,
      /^Format datetime\b/u,
      /^One-hot encode\b/u,
      /^Multi-label binarize\b/u,
      /^Transform by example\b/u,
      /^Custom code\b/u
    ]) {
      assert.equal(await catalog.getByRole("button", { name: expected }).count(), 1);
    }
    await dialog.getByPlaceholder("Search operations").fill("formula");
    await dialog.getByRole("button", { name: /^Formula column\b/u }).click();
    await dialog.getByLabel("Left column", { exact: true }).selectOption(score.id);
    await dialog.getByLabel("Operator", { exact: true }).selectOption("add");
    await dialog.getByLabel("Numeric value", { exact: true }).fill("2");
    await dialog.getByLabel("New column", { exact: true }).fill("score_plus_two");
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "formula" &&
          draft.params.leftColumn.id === score.id &&
          draft.params.operator === "add" &&
          draft.params.value === 2 &&
          draft.params.newColumn === "score_plus_two" &&
          active.metadata.schema.at(-1)?.id === `c:step:${draft.id}:0`
        );
      },
      30_000,
      "previewing native R Formula through its visible form"
    );
    const preview = testing.activeSession();
    assert.ok(preview?.metadata.draftStep?.kind === "formula");
    const output = preview.metadata.schema.at(-1);
    assert.ok(output, "The R Formula preview must append its derived output.");
    assert.equal(output.name, "score_plus_two");
    assert.equal(output.type, "float");
    assert.equal(output.rawType, "double");
    assert.equal(output.nullable, score.nullable);
    assertReleasedRFormulaGeneratedCode(preview.code ?? "", "score", "score_plus_two", "add", 2);
    const codePreview = await waitForCodePreview(workbench, undefined, "R");
    const visibleCode = await revealCodePreviewText(codePreview, ".ow_formula_values");
    assertReleasedRFormulaGeneratedCode(visibleCode, "score", "score_plus_two", "add", 2);
    const previewPage = await testing.request({
      kind: "getPage",
      sessionId,
      revision: preview.metadata.revision,
      viewRequestId: "jupyter-r-formula-preview-page",
      offset: 0,
      limit: 2,
      filterModel: preview.viewState.filterModel,
      columnOffset: output.position,
      columnLimit: 1
    });
    assert.equal(previewPage.kind, "page");
    if (previewPage.kind !== "page") throw new Error("The packaged R Formula preview did not return its page.");
    assert.deepEqual(previewPage.page.columnIds, [output.id]);
    assert.deepEqual(
      previewPage.page.rows.map((row) => row.values[0]?.raw),
      [3, 4]
    );
    await requireFreshExactSessionPanelHydration(testing, sessionId, "The R Formula preview must reach its renderer.");
    let app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Formula preview");
    const review = app.getByRole("region", { name: "Draft review" });
    await review.getByText("Formula column", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const outputSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await outputSearch.fill(output.name);
    await app
      .getByRole("option", { name: /^score_plus_two,/u })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await outputSearch.press("Enter");
    await waitFor(
      () => testing.activeSession()?.viewState.selectedColumnId === output.id,
      10_000,
      "revealing the visible R Formula output"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R Formula preview");
    await waitForLocatorText(
      app.locator(`td[data-grid-row="0"][data-grid-column="${output.position}"]`),
      (text) => text.trim() === "3",
      10_000,
      "the visible R Formula value"
    );
    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          active.metadata.steps[0]?.kind === "formula" &&
          active.metadata.schema.at(-1)?.id === output.id
        );
      },
      30_000,
      "applying native R Formula"
    );
    const applied = testing.activeSession();
    assert.ok(applied, "The applied R Formula must retain its session.");
    assertReleasedRFormulaGeneratedCode(applied.code ?? "", "score", "score_plus_two", "add", 2);
    await requireFreshExactSessionPanelHydration(testing, sessionId, "The applied R Formula must reach its renderer.");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Formula session");
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.steps.length === 0 &&
          active.metadata.draftStep === undefined &&
          !active.metadata.schema.some((column) => column.id === output.id) &&
          (active.code ?? "") === ""
        );
      },
      30_000,
      "undoing native R Formula"
    );
  }

  async function exerciseReleasedRFormatDatetimeJourney(
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ): Promise<void> {
    recordAcceptanceProgress("jupyter-r:editing:format-datetime-preview-apply-undo");
    const base = testing.activeSession();
    assert.ok(base, "The restored R session must remain available for Format datetime.");
    assert.equal(base.metadata.steps.length, 0);
    assert.equal(base.metadata.draftStep, undefined);
    const date = base.metadata.schema.find((column) => column.name === "extra_19");
    assert.ok(date, "The packaged R Format datetime journey requires its Date column.");
    assert.equal(date.type, "date");
    assert.equal(date.rawType, "Date");

    const picker = await openReleasedROperationPicker(testing, workbench, sessionId);
    const dialog = picker.dialog;
    await dialog.getByPlaceholder("Search operations").fill("format datetime");
    await dialog.getByRole("button", { name: /^Format datetime\b/u }).click();
    await dialog.getByLabel("Date or datetime column", { exact: true }).selectOption(date.id);
    await dialog.getByLabel("strftime format", { exact: true }).fill("%d/%m/%Y");
    await dialog.getByLabel("Output column (blank replaces in place)", { exact: true }).fill("formatted_date");
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "formatDatetime" &&
          draft.params.column.id === date.id &&
          draft.params.format === "%d/%m/%Y" &&
          draft.params.newColumn === "formatted_date" &&
          active.metadata.schema.at(-1)?.id === `c:step:${draft.id}:0`
        );
      },
      30_000,
      "previewing native R Format datetime through its visible form"
    );
    const preview = testing.activeSession();
    assert.ok(preview?.metadata.draftStep?.kind === "formatDatetime");
    const output = preview.metadata.schema.at(-1);
    assert.ok(output, "The R Format datetime preview must append its text output.");
    assert.equal(output.type, "string");
    assert.equal(output.rawType, "character");
    assert.equal(output.name, "formatted_date");
    assert.equal(output.nullable, date.nullable);
    assertReleasedRFormatDatetimeGeneratedCode(preview.code ?? "", "extra_19", "formatted_date", "%d/%m/%Y");
    const codePreview = await waitForCodePreview(workbench, undefined, "R");
    const visibleCode = await revealCodePreviewText(codePreview, ".ow_datetime_values");
    assertReleasedRFormatDatetimeGeneratedCode(visibleCode, "extra_19", "formatted_date", "%d/%m/%Y");
    const previewPage = await testing.request({
      kind: "getPage",
      sessionId,
      revision: preview.metadata.revision,
      viewRequestId: "jupyter-r-format-datetime-preview-page",
      offset: 0,
      limit: 2,
      filterModel: preview.viewState.filterModel,
      columnOffset: output.position,
      columnLimit: 1
    });
    assert.equal(previewPage.kind, "page");
    if (previewPage.kind !== "page") {
      throw new Error("The packaged R Format datetime preview did not return its page.");
    }
    assert.deepEqual(previewPage.page.columnIds, [output.id]);
    assert.deepEqual(
      previewPage.page.rows.map((row) => row.values[0]?.display),
      ["01/01/2026", "02/01/2026"]
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The R Format datetime preview must reach its renderer."
    );
    let app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Format datetime preview");
    const review = app.getByRole("region", { name: "Draft review" });
    await review.getByText("Format datetime", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const outputSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await outputSearch.fill(output.name);
    await app
      .getByRole("option", { name: /^formatted_date,/u })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await outputSearch.press("Enter");
    await waitFor(
      () => testing.activeSession()?.viewState.selectedColumnId === output.id,
      10_000,
      "revealing the visible R Format datetime output"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R Format datetime preview");
    await waitForLocatorText(
      app.locator(`td[data-grid-row="0"][data-grid-column="${output.position}"]`),
      (text) => text.trim() === "01/01/2026",
      10_000,
      "the visible R Format datetime value"
    );
    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          active.metadata.steps[0]?.kind === "formatDatetime" &&
          active.metadata.schema.at(-1)?.id === output.id
        );
      },
      30_000,
      "applying native R Format datetime"
    );
    const applied = testing.activeSession();
    assert.ok(applied, "The applied R Format datetime must retain its session.");
    assertReleasedRFormatDatetimeGeneratedCode(applied.code ?? "", "extra_19", "formatted_date", "%d/%m/%Y");
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The applied R Format datetime must reach its renderer."
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Format datetime session");
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.steps.length === 0 &&
          active.metadata.draftStep === undefined &&
          !active.metadata.schema.some((column) => column.id === output.id) &&
          active.metadata.schema.some((column) => column.id === date.id && column.rawType === "Date") &&
          (active.code ?? "") === ""
        );
      },
      30_000,
      "undoing native R Format datetime"
    );
  }

  return Object.freeze({ exerciseReleasedRFormulaJourney, exerciseReleasedRFormatDatetimeJourney });
}
