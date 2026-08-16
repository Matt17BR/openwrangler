import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { assertReleasedRCastGeneratedCode } from "./releasedRGeneratedCode";
import type { TestApi } from "./extensionHostTestApi";

export interface ReleasedRCastOperationDependencies {
  readonly previewReleasedRCast: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    sourceName: string,
    dtype: "string" | "integer" | "float" | "boolean" | "date" | "datetime",
    variableName?: string
  ) => Promise<Readonly<{ app: Locator; stepId: string }>>;
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
}

export interface ReleasedRCastOperationInput {
  readonly testing: TestApi;
  readonly workbench: Page;
  readonly sessionId: string;
  readonly phase: "jupyter-r" | "jupyter-r-remote";
  readonly initialApp: Locator;
}

export async function exerciseReleasedRCastOperation(
  input: ReleasedRCastOperationInput,
  dependencies: ReleasedRCastOperationDependencies
): Promise<void> {
  const { testing, workbench, sessionId, phase } = input;
  let app = input.initialApp;
  const {
    previewReleasedRCast,
    recordAcceptanceProgress,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor
  } = dependencies;

  recordAcceptanceProgress(`${phase}:editing:convert-type-preview-apply-undo`);
  const castBase = testing.activeSession();
  assert.ok(castBase, "The restored R session must remain available for Convert type.");
  const scoreColumn = castBase.metadata.schema.find((column) => column.name === "score");
  assert.ok(scoreColumn, "The packaged R Convert type journey requires the score column.");
  assert.equal(scoreColumn.type, "float");
  assert.equal(scoreColumn.rawType, "double");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the restored R session before Convert type");
  const castColumnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await castColumnSearch.fill("score");
  await app
    .getByRole("option", { name: /^score,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await castColumnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === scoreColumn.id,
    10_000,
    "selecting score through the R column search"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R score-column session before Convert type");
  await app.locator('th[data-column="score"]').first().waitFor({ state: "visible", timeout: 10_000 });
  const converted = await previewReleasedRCast(testing, workbench, sessionId, "score", "integer");
  app = converted.app;
  const castReview = app.getByRole("region", { name: "Draft review" });
  await castReview.getByText("Convert type", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await castReview
    .locator('[aria-label="Data diff summary"]')
    .getByText(/^[1-9][\d,]* existing cells? changed(?: in this block)?$/u)
    .waitFor({ state: "visible", timeout: 10_000 });
  await castReview.getByRole("button", { name: "Apply step", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const step = active?.metadata.steps[0];
      const output = active?.metadata.schema.find((column) => column.id === scoreColumn.id);
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        step?.kind === "castColumn" &&
        step.id === converted.stepId &&
        step.params.column.id === scoreColumn.id &&
        step.params.column.name === "score" &&
        step.params.dtype === "integer" &&
        output?.name === "score" &&
        output.position === scoreColumn.position &&
        output.type === "integer" &&
        output.rawType === "integer"
      );
    },
    30_000,
    "applying the native R Convert type step"
  );
  const castApplied = testing.activeSession();
  assert.ok(castApplied, "The applied native R Convert type step must retain its session.");
  assertReleasedRCastGeneratedCode(castApplied.code ?? "", "score", "integer");
  const castPage = await testing.request({
    kind: "getPage",
    sessionId,
    revision: castApplied.metadata.revision,
    viewRequestId: `${phase}-editing-cast-page`,
    offset: 0,
    limit: 1,
    filterModel: castApplied.viewState.filterModel,
    columnOffset: scoreColumn.position,
    columnLimit: 1
  });
  assert.equal(castPage.kind, "page");
  if (castPage.kind !== "page") throw new Error("The applied R Convert type step did not return its output page.");
  assert.deepEqual(castPage.page.columnIds, [scoreColumn.id]);
  assert.deepEqual(castPage.page.rows[0]?.values[0], {
    kind: "integer",
    raw: "1",
    display: "1",
    isNull: false,
    isNaN: false
  });
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The applied R Convert type step must be acknowledged before undo."
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the R Convert type session before undo");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const restoredScore = active?.metadata.schema.find((column) => column.id === scoreColumn.id);
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        restoredScore?.name === "score" &&
        restoredScore.position === scoreColumn.position &&
        restoredScore.type === "float" &&
        restoredScore.rawType === "double" &&
        (active.code ?? "") === ""
      );
    },
    30_000,
    "undoing the native R Convert type step"
  );
  const castRestored = testing.activeSession();
  assert.ok(castRestored, "Undoing the R Convert type step must retain the session.");
  const restoredCastPage = await testing.request({
    kind: "getPage",
    sessionId,
    revision: castRestored.metadata.revision,
    viewRequestId: `${phase}-editing-cast-restored-page`,
    offset: 0,
    limit: 1,
    filterModel: castRestored.viewState.filterModel,
    columnOffset: scoreColumn.position,
    columnLimit: 1
  });
  assert.equal(restoredCastPage.kind, "page");
  if (restoredCastPage.kind !== "page") {
    throw new Error("The undone R Convert type step did not return its original page.");
  }
  assert.deepEqual(restoredCastPage.page.columnIds, [scoreColumn.id]);
  assert.deepEqual(restoredCastPage.page.rows[0]?.values[0], {
    kind: "number",
    raw: 1,
    display: "1",
    isNull: false,
    isNaN: false
  });
}
