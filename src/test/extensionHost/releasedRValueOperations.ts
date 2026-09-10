import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type { TestApi } from "./extensionHostTestApi";

type ValueOperation = "find-replace" | "formula" | "format-datetime" | "capitalize";

export interface ReleasedRValueOperationDependencies {
  readonly assertReleasedRValueOperationsCleanState: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    checkpoint: "entry" | "formula-undo-restored" | "exit"
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

export async function exerciseReleasedRValueOperations(
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
    "revealing the R label column after the previous operation was undone"
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
  app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Capitalize session");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(() => testing.activeSession()?.metadata.steps.length === 0, 30_000, "undoing native R Capitalize");
  recordReleasedRValueOperationCheckpoint("capitalize", "complete");
}
