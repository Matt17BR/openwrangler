import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type { SessionMetadata } from "../../shared/protocol";
import type { TestApi } from "./extensionHostTestApi";

type ValueOperation =
  | "find-replace"
  | "formula"
  | "format-datetime"
  | "min-max-scale"
  | "round"
  | "floor"
  | "ceiling"
  | "capitalize"
  | "lowercase"
  | "uppercase"
  | "strip"
  | "split";

export interface ReleasedRValueOperationDependencies {
  readonly assertReleasedRValueOperationsCleanState: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    checkpoint: "entry" | "formula-undo-restored" | "strip-discard-restored" | "split-discard-restored" | "exit"
  ) => Promise<void>;
  readonly exerciseReleasedRFormulaJourney: (testing: TestApi, workbench: Page, sessionId: string) => Promise<void>;
  readonly exerciseReleasedRFormatDatetimeJourney: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<void>;
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<Readonly<{ app: Locator; dialog: Locator }>>;
  readonly previewAndDiscardReleasedRTextTool: (
    testing: TestApi,
    sessionId: string,
    column: SessionMetadata["schema"][number],
    kind: "stripText" | "splitText"
  ) => Promise<void>;
  readonly previewReleasedRFindReplace: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    sourceName: string,
    find: string,
    replacement: string
  ) => Promise<Readonly<{ app: Locator; stepId: string }>>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly recordReleasedRValueOperationCheckpoint: (operation: ValueOperation, boundary: "start" | "complete") => void;
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
  readonly waitForLocatorText: (
    locator: Locator,
    predicate: (text: string) => boolean,
    timeoutMs: number,
    expectation: string
  ) => Promise<void>;
}

interface ReleasedRValueOperationInput {
  readonly testing: TestApi;
  readonly workbench: Page;
  readonly sessionId: string;
  readonly phase: "jupyter-r";
}

export async function exerciseReleasedRValueOperationsBeforeLowercase(
  input: ReleasedRValueOperationInput & Readonly<{ initialApp: Locator }>,
  dependencies: ReleasedRValueOperationDependencies
): Promise<void> {
  const { testing, workbench, sessionId, phase } = input;
  let app = input.initialApp;
  const {
    assertReleasedRValueOperationsCleanState,
    exerciseReleasedRFormulaJourney,
    exerciseReleasedRFormatDatetimeJourney,
    openReleasedROperationPicker,
    previewReleasedRFindReplace,
    recordAcceptanceProgress,
    recordReleasedRValueOperationCheckpoint,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor,
    waitForLocatorText
  } = dependencies;

  recordReleasedRValueOperationCheckpoint("find-replace", "start");
  recordAcceptanceProgress(`${phase}:editing:find-replace-picker-preview-apply-undo`);
  const replaced = await previewReleasedRFindReplace(testing, workbench, sessionId, "group", "A", "Alpha");
  app = replaced.app;
  const replaceReview = app.getByRole("region", { name: "Draft review" });
  await replaceReview.getByText("Find and replace", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await replaceReview.getByRole("button", { name: "Apply step", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const step = active?.metadata.steps[0];
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        step?.kind === "findReplace" &&
        step.id === replaced.stepId &&
        step.params.column.name === "group" &&
        step.params.find === "A" &&
        step.params.replacement === "Alpha" &&
        step.params.regex === false
      );
    },
    30_000,
    "applying native R Find and replace"
  );
  const findApplied = testing.activeSession();
  assert.ok(findApplied, "The applied native R Find and replace step must retain its session.");
  const groupAfterReplace = findApplied.metadata.schema.find((column) => column.name === "group");
  assert.ok(groupAfterReplace, "The native R Find and replace journey must retain group.");
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The applied R Find and replace result must reach its exact renderer before inspection."
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Find and replace session");
  const groupSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await groupSearch.fill(groupAfterReplace.name);
  await app
    .getByRole("option", { name: new RegExp(`^${groupAfterReplace.name},`, "u") })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await groupSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === groupAfterReplace.id,
    10_000,
    "revealing the replaced R column"
  );
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The replaced R column must be visible before its rendered value is checked."
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Find and replace result");
  await app
    .locator(`td[data-grid-row="0"][data-grid-column="${groupAfterReplace.position}"]`)
    .getByText("Alpha", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        (active.code ?? "") === ""
      );
    },
    30_000,
    "undoing native R Find and replace"
  );
  recordReleasedRValueOperationCheckpoint("find-replace", "complete");

  recordReleasedRValueOperationCheckpoint("formula", "start");
  await exerciseReleasedRFormulaJourney(testing, workbench, sessionId);
  await assertReleasedRValueOperationsCleanState(testing, workbench, sessionId, "formula-undo-restored");
  recordReleasedRValueOperationCheckpoint("formula", "complete");

  recordReleasedRValueOperationCheckpoint("format-datetime", "start");
  await exerciseReleasedRFormatDatetimeJourney(testing, workbench, sessionId);
  recordReleasedRValueOperationCheckpoint("format-datetime", "complete");

  recordReleasedRValueOperationCheckpoint("min-max-scale", "start");
  recordAcceptanceProgress(`${phase}:editing:min-max-scale-preview-apply-undo`);
  const minMaxBase = testing.activeSession();
  assert.ok(minMaxBase, "The restored R session must remain available for Min-max scale.");
  const scaleColumn = minMaxBase.metadata.schema.find((column) => column.name === "score");
  assert.ok(scaleColumn, "The packaged R Min-max scale run requires the score column.");

  const minMaxPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
  app = minMaxPicker.app;
  const minMaxDialog = minMaxPicker.dialog;
  await minMaxDialog.getByPlaceholder("Search operations").fill("min-max");
  await minMaxDialog.getByRole("button", { name: /^Min-max scale\b/u }).click();
  await minMaxDialog.getByLabel("Numeric column", { exact: true }).selectOption(scaleColumn.id);
  await minMaxDialog.getByLabel("Output column (blank replaces in place)", { exact: true }).fill("score_scaled");
  await minMaxDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const draft = active?.metadata.draftStep;
      return (
        active?.sessionId === sessionId &&
        draft?.kind === "minMaxScale" &&
        draft.params.column.id === scaleColumn.id &&
        draft.params.newColumn === "score_scaled" &&
        active.metadata.schema.at(-1)?.name === "score_scaled"
      );
    },
    30_000,
    "previewing native R Min-max scale through its visible form"
  );
  const minMaxPreview = testing.activeSession();
  assert.ok(minMaxPreview?.metadata.draftStep?.kind === "minMaxScale");
  const minMaxOutput = minMaxPreview.metadata.schema.at(-1);
  assert.ok(minMaxOutput, "The R Min-max scale preview must append one output column.");
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The R Min-max scale preview must reach its renderer."
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Min-max scale preview");
  const minMaxReview = app.getByRole("region", { name: "Draft review" });
  await minMaxReview.getByText("Min-max scale", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const minMaxColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await minMaxColumnSearch.fill("score_scaled");
  await app
    .getByRole("option", { name: /^score_scaled,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await minMaxColumnSearch.press("Enter");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R Min-max scale result");
  await waitForLocatorText(
    app.locator(`td[data-grid-row="0"][data-grid-column="${minMaxOutput.position}"]`),
    (text) => text.trim() === "0",
    10_000,
    "the visible R Min-max scale minimum"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the typed R Min-max scale preview");
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const applied = active?.metadata.steps[0];
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        applied?.kind === "minMaxScale" &&
        applied.id === minMaxPreview.metadata.draftStep?.id
      );
    },
    30_000,
    "applying native R Min-max scale"
  );
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The applied R Min-max scale step must reach its renderer."
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Min-max scale session");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        !active.metadata.schema.some((column) => column.name === "score_scaled")
      );
    },
    30_000,
    "undoing native R Min-max scale"
  );
  recordReleasedRValueOperationCheckpoint("min-max-scale", "complete");
  recordReleasedRValueOperationCheckpoint("round", "start");
  recordAcceptanceProgress(`${phase}:editing:numeric-rounding-preview-apply-undo`);
  const roundingBase = testing.activeSession();
  assert.ok(roundingBase, "The restored R session must remain available for numeric rounding.");
  assert.deepEqual(roundingBase.viewState.filterModel.filters, []);
  assert.deepEqual(roundingBase.viewState.filterModel.sort, []);
  const roundingColumn = roundingBase.metadata.schema.find((column) => column.name === "fractional_score");
  assert.ok(roundingColumn, "The packaged R numeric-rounding run requires the fractional score column.");

  const roundingPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
  app = roundingPicker.app;
  const roundingDialog = roundingPicker.dialog;
  await roundingDialog.getByPlaceholder("Search operations").fill("round");
  await roundingDialog.getByRole("button", { name: /^Round\b/u }).click();
  await roundingDialog.getByLabel("Numeric column", { exact: true }).selectOption(roundingColumn.id);
  await roundingDialog.getByLabel("Decimal places", { exact: true }).fill("0");
  await roundingDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const draft = active?.metadata.draftStep;
      return (
        active?.sessionId === sessionId &&
        draft?.kind === "roundNumber" &&
        draft.params.column.id === roundingColumn.id &&
        draft.params.decimals === 0
      );
    },
    30_000,
    "previewing native R Round through its visible form"
  );
  const roundingPreview = testing.activeSession();
  assert.ok(roundingPreview?.metadata.draftStep?.kind === "roundNumber");
  assert.match(roundingPreview.code ?? "", /\bround\s*\(/u);
  await requireFreshExactSessionPanelHydration(testing, sessionId, "The R Round preview must reach its renderer.");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Round preview");
  const roundingColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await roundingColumnSearch.fill(roundingColumn.name);
  await app
    .getByRole("option", { name: /^fractional_score,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await roundingColumnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === roundingColumn.id,
    10_000,
    "revealing the R Round target after undoing Min-max scale"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R Round result");
  const roundedCell = app.locator(`td[data-grid-row="0"][data-grid-column="${roundingColumn.position}"]`);
  await roundedCell.waitFor({ state: "visible", timeout: 10_000 });
  const roundedDisplay = Number((await roundedCell.innerText()).trim());
  assert.equal(Number.isFinite(roundedDisplay), true, "The visible R Round preview must contain a number.");
  assert.equal(Number.isInteger(roundedDisplay), true, "The visible R Round preview must use zero decimal places.");
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => testing.activeSession()?.metadata.steps[0]?.kind === "roundNumber",
    30_000,
    "applying native R Round"
  );
  await requireFreshExactSessionPanelHydration(testing, sessionId, "The applied R Round step must reach its renderer.");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Round session");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(() => testing.activeSession()?.metadata.steps.length === 0, 30_000, "undoing native R Round");
  recordReleasedRValueOperationCheckpoint("round", "complete");

  recordReleasedRValueOperationCheckpoint("floor", "start");
  recordAcceptanceProgress(`${phase}:editing:floor-picker-preview-discard`);
  const floorPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
  app = floorPicker.app;
  const floorDialog = floorPicker.dialog;
  await floorDialog.getByPlaceholder("Search operations").fill("floor");
  await floorDialog.getByRole("button", { name: /^Floor\b/u }).click();
  await floorDialog.getByLabel("Numeric column", { exact: true }).selectOption(roundingColumn.id);
  await floorDialog.getByLabel("Output column (blank replaces in place)", { exact: true }).fill("score_floor");
  await floorDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const draft = active?.metadata.draftStep;
      return (
        active?.sessionId === sessionId &&
        draft?.kind === "floorNumber" &&
        draft.params.column.id === roundingColumn.id &&
        draft.params.newColumn === "score_floor" &&
        active.metadata.schema.at(-1)?.id === `c:step:${draft.id}:0`
      );
    },
    30_000,
    "previewing native R Floor through its visible form"
  );
  const floorPreview = testing.activeSession();
  assert.ok(floorPreview?.metadata.draftStep?.kind === "floorNumber");
  assert.match(floorPreview.code ?? "", /\bfloor\s*\(/u);
  await requireFreshExactSessionPanelHydration(testing, sessionId, "The R Floor preview must reach its renderer.");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Floor preview");
  const floorColumn = testing.activeSession()?.metadata.schema.find((column) => column.name === "score_floor");
  assert.ok(floorColumn, "The visible R Floor preview must retain its derived column.");
  const floorColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await floorColumnSearch.fill("score_floor");
  await app
    .getByRole("option", { name: /^score_floor,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await floorColumnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === floorColumn.id,
    10_000,
    "selecting the visible R Floor result"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R Floor result");
  for (const [row, expected] of [
    [0, "1"],
    [1, "-3"]
  ] as const) {
    await waitForLocatorText(
      app.locator(`td[data-grid-row="${row}"][data-grid-column="${floorColumn.position}"]`),
      (text) => text.trim() === expected,
      10_000,
      `the visible R Floor value in row ${row + 1}`
    );
  }
  await app.getByRole("region", { name: "Draft review" }).getByRole("button", { name: "Discard", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        !active.metadata.schema.some((column) => column.name === "score_floor")
      );
    },
    30_000,
    "discarding native R Floor"
  );
  await requireFreshExactSessionPanelHydration(testing, sessionId, "The discarded R Floor draft must settle.");
  recordReleasedRValueOperationCheckpoint("floor", "complete");

  recordReleasedRValueOperationCheckpoint("ceiling", "start");
  const ceilingBase = testing.activeSession();
  assert.ok(ceilingBase, "The restored R session must remain available for Ceiling.");
  const ceilingPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
  app = ceilingPicker.app;
  const ceilingDialog = ceilingPicker.dialog;
  await ceilingDialog.getByPlaceholder("Search operations").fill("ceiling");
  await ceilingDialog.getByRole("button", { name: /^Ceiling\b/u }).click();
  await ceilingDialog.getByLabel("Numeric column", { exact: true }).selectOption(roundingColumn.id);
  await ceilingDialog.getByLabel("Output column (blank replaces in place)", { exact: true }).fill("score_ceiling");
  await ceilingDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const draft = active?.metadata.draftStep;
      return (
        active?.sessionId === sessionId &&
        draft?.kind === "ceilNumber" &&
        draft.params.column.id === roundingColumn.id &&
        draft.params.newColumn === "score_ceiling"
      );
    },
    30_000,
    "previewing native R Ceiling through its visible form"
  );
  const ceilingPreview = testing.activeSession();
  assert.ok(ceilingPreview?.metadata.draftStep?.kind === "ceilNumber");
  assert.equal(ceilingPreview.metadata.schema.at(-1)?.id, `c:step:${ceilingPreview.metadata.draftStep.id}:0`);
  assert.match(ceilingPreview.code ?? "", /\bceiling\s*\(/u);
  await requireFreshExactSessionPanelHydration(testing, sessionId, "The R Ceiling preview must reach its renderer.");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Ceiling preview");
  const ceilingColumn = testing.activeSession()?.metadata.schema.find((column) => column.name === "score_ceiling");
  assert.ok(ceilingColumn, "The visible R Ceiling preview must retain its derived column.");
  const ceilingColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await ceilingColumnSearch.fill("score_ceiling");
  await app
    .getByRole("option", { name: /^score_ceiling,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await ceilingColumnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === ceilingColumn.id,
    10_000,
    "selecting the visible R Ceiling result"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R Ceiling result");
  for (const [row, expected] of [
    [0, "2"],
    [1, "-2"]
  ] as const) {
    await waitForLocatorText(
      app.locator(`td[data-grid-row="${row}"][data-grid-column="${ceilingColumn.position}"]`),
      (text) => text.trim() === expected,
      10_000,
      `the visible R Ceiling value in row ${row + 1}`
    );
  }
  await app.getByRole("region", { name: "Draft review" }).getByRole("button", { name: "Discard", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        !active.metadata.schema.some((column) => column.name === "score_ceiling")
      );
    },
    30_000,
    "discarding native R Ceiling"
  );
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The discarded R Floor and Ceiling previews must reach their renderer."
  );
  recordReleasedRValueOperationCheckpoint("ceiling", "complete");

  recordReleasedRValueOperationCheckpoint("capitalize", "start");
  const capitalizeBase = testing.activeSession();
  assert.ok(capitalizeBase, "The restored R session must remain available for Capitalize.");
  const labelColumn = capitalizeBase.metadata.schema.find((column) => column.name === "label");
  assert.ok(labelColumn, "The packaged R Capitalize journey requires the label column.");

  const capitalizePicker = await openReleasedROperationPicker(testing, workbench, sessionId);
  app = capitalizePicker.app;
  const textDialog = capitalizePicker.dialog;
  await textDialog.getByPlaceholder("Search operations").fill("capitalize");
  await textDialog.getByRole("button", { name: /^Capitalize/u }).click();
  await textDialog.getByLabel("Text column", { exact: true }).selectOption(labelColumn.id);
  await textDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => testing.activeSession()?.metadata.draftStep?.kind === "capitalizeText",
    30_000,
    "previewing native R Capitalize through its visible form"
  );
  const capitalizePreview = testing.activeSession();
  assert.ok(capitalizePreview?.metadata.draftStep?.kind === "capitalizeText");
  assert.match(capitalizePreview.code ?? "", /\btoupper\b/u);
  assert.doesNotMatch(capitalizePreview.code ?? "", /\b(?:pandas|polars|python)\b/iu);
  await requireFreshExactSessionPanelHydration(testing, sessionId, "The R Capitalize preview must reach its renderer.");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Capitalize preview");
  const capitalizeColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await capitalizeColumnSearch.fill(labelColumn.name);
  await app
    .getByRole("option", { name: /^label,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await capitalizeColumnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === labelColumn.id,
    10_000,
    "revealing the R label column after the temporary numeric columns were discarded"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the revealed R Capitalize preview");
  const capitalizeHeader = app.locator('th[data-column="label"]').first();
  await capitalizeHeader.waitFor({ state: "visible", timeout: 10_000 });
  const capitalizeColumnPosition = await capitalizeHeader.getAttribute("data-grid-column");
  assert.equal(capitalizeColumnPosition, String(labelColumn.position));
  await waitForLocatorText(
    app.locator(`td[data-grid-row="0"][data-grid-column="${capitalizeColumnPosition}"]`).first(),
    (text) => text.trim() === "Row-0001",
    10_000,
    "the visible R Capitalize value in row 1"
  );
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => testing.activeSession()?.metadata.steps[0]?.kind === "capitalizeText",
    30_000,
    "applying native R Capitalize"
  );
  await requireFreshExactSessionPanelHydration(testing, sessionId, "R Capitalize must reach its renderer.");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Capitalize session");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(() => testing.activeSession()?.metadata.steps.length === 0, 30_000, "undoing native R Capitalize");
  recordReleasedRValueOperationCheckpoint("capitalize", "complete");
}

export async function exerciseReleasedRValueOperationsAfterLowercase(
  input: ReleasedRValueOperationInput,
  dependencies: ReleasedRValueOperationDependencies
): Promise<void> {
  const { testing, workbench, sessionId, phase } = input;
  const {
    assertReleasedRValueOperationsCleanState,
    previewAndDiscardReleasedRTextTool,
    recordAcceptanceProgress,
    recordReleasedRValueOperationCheckpoint
  } = dependencies;

  recordReleasedRValueOperationCheckpoint("uppercase", "start");
  recordAcceptanceProgress(`${phase}:editing:uppercase-preview-apply-undo`);
  const uppercaseBase = testing.activeSession();
  assert.ok(uppercaseBase, "The restored R session must remain available for Uppercase.");
  const labelColumn = uppercaseBase.metadata.schema.find((column) => column.name === "label");
  assert.ok(labelColumn, "The packaged R Uppercase journey requires the label column.");
  const uppercasePreview = await testing.request({
    kind: "previewStep",
    sessionId,
    revision: uppercaseBase.metadata.revision,
    step: {
      id: "released-r-uppercase-label",
      kind: "upperText",
      params: { column: { id: labelColumn.id, name: labelColumn.name } }
    },
    offset: 0,
    limit: 20,
    columnOffset: labelColumn.position,
    columnLimit: 1
  });
  assert.equal(uppercasePreview.kind, "stepPreview", "Packaged native R Uppercase must preview in place.");
  if (uppercasePreview.kind !== "stepPreview") throw new Error("The packaged R Uppercase preview failed.");
  assert.equal(uppercasePreview.page.rows[0]?.values[0]?.display, "ROW-0001");
  assert.match(uppercasePreview.code, /toupper/u);
  assert.ok(uppercasePreview.diff.changedCells > 0);
  const uppercaseApplied = await testing.request({
    kind: "applyDraft",
    sessionId,
    revision: uppercasePreview.revision,
    offset: 0,
    limit: 20,
    columnOffset: labelColumn.position,
    columnLimit: 1
  });
  assert.equal(uppercaseApplied.kind, "planUpdated", "Packaged native R Uppercase must apply.");
  if (uppercaseApplied.kind !== "planUpdated") throw new Error("The packaged R Uppercase apply failed.");
  assert.equal(uppercaseApplied.page.rows[0]?.values[0]?.display, "ROW-0001");
  const uppercaseUndo = await testing.request({
    kind: "undoStep",
    sessionId,
    revision: uppercaseApplied.revision,
    offset: 0,
    limit: 20,
    columnOffset: labelColumn.position,
    columnLimit: 1
  });
  assert.equal(uppercaseUndo.kind, "planUpdated", "Packaged native R Uppercase must undo.");
  if (uppercaseUndo.kind !== "planUpdated") throw new Error("The packaged R Uppercase undo failed.");
  assert.equal(uppercaseUndo.page.rows[0]?.values[0]?.display, "row-0001");
  recordReleasedRValueOperationCheckpoint("uppercase", "complete");

  recordReleasedRValueOperationCheckpoint("strip", "start");
  await previewAndDiscardReleasedRTextTool(testing, sessionId, labelColumn, "stripText");
  await assertReleasedRValueOperationsCleanState(testing, workbench, sessionId, "strip-discard-restored");
  recordReleasedRValueOperationCheckpoint("strip", "complete");
  recordReleasedRValueOperationCheckpoint("split", "start");
  await previewAndDiscardReleasedRTextTool(testing, sessionId, labelColumn, "splitText");
  await assertReleasedRValueOperationsCleanState(testing, workbench, sessionId, "split-discard-restored");
  recordReleasedRValueOperationCheckpoint("split", "complete");
}
