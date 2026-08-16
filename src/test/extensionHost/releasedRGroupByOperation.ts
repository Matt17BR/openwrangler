import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type { TestApi } from "./extensionHostTestApi";

export interface ReleasedRGroupByOperationDependencies {
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

export interface ReleasedRGroupByOperationInput {
  readonly testing: TestApi;
  readonly workbench: Page;
  readonly sessionId: string;
}

export async function exerciseReleasedRGroupByOperation(
  input: ReleasedRGroupByOperationInput,
  dependencies: ReleasedRGroupByOperationDependencies
): Promise<void> {
  const { testing, workbench, sessionId } = input;
  const {
    openReleasedROperationPicker,
    recordAcceptanceProgress,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor,
    waitForLocatorText
  } = dependencies;
  recordAcceptanceProgress("jupyter-r:editing:group-by-preview-apply-undo");
  const groupBase = testing.activeSession();
  assert.ok(groupBase, "The restored R session must remain available for Group and aggregate.");
  assert.equal(groupBase.metadata.steps.length, 0);
  assert.equal(groupBase.metadata.draftStep, undefined);
  const groupKeyColumn = groupBase.metadata.schema.find((column) => column.name === "group");
  const groupedScoreColumn = groupBase.metadata.schema.find((column) => column.name === "score");
  assert.ok(groupKeyColumn, "The packaged R Group and aggregate journey requires the group column.");
  assert.ok(groupedScoreColumn, "The packaged R Group and aggregate journey requires the score column.");

  const groupPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
  let app = groupPicker.app;
  const groupDialog = groupPicker.dialog;
  await groupDialog.getByPlaceholder("Search operations").fill("group");
  await groupDialog.getByRole("button", { name: /^Group and aggregate\b/u }).click();
  await groupDialog
    .getByRole("group", { name: "Group keys", exact: true })
    .getByRole("checkbox", { name: "group", exact: true })
    .check();
  await groupDialog.getByLabel("Value 1", { exact: true }).selectOption(groupedScoreColumn.id);
  await groupDialog.getByLabel("Calculation 1", { exact: true }).selectOption("sum");
  await groupDialog.getByLabel("Output name", { exact: true }).fill("total_score");
  await groupDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep?.kind === "groupBy" &&
        active.metadata.schema.map((column) => column.name).join(",") === "group,total_score"
      );
    },
    30_000,
    "previewing native R Group and aggregate through its visible form"
  );
  const groupPreview = testing.activeSession();
  assert.ok(groupPreview?.metadata.draftStep?.kind === "groupBy");
  assert.deepEqual(groupPreview.metadata.draftStep.params.keys, [{ id: groupKeyColumn.id, name: groupKeyColumn.name }]);
  assert.deepEqual(groupPreview.metadata.draftStep.params.aggregations, [
    {
      column: { id: groupedScoreColumn.id, name: groupedScoreColumn.name },
      operation: "sum",
      alias: "total_score"
    }
  ]);
  assert.match(groupPreview.code ?? "", /\.ow_group_by\b/u);
  assert.match(groupPreview.code ?? "", /total_score/u);
  assert.doesNotMatch(groupPreview.code ?? "", /\b(?:pandas|polars|python)\b/iu);
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The R Group and aggregate preview must reach its renderer."
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Group and aggregate preview");
  await app
    .getByRole("region", { name: "Draft review" })
    .getByText("Group and aggregate", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  const totalScoreColumn = groupPreview.metadata.schema.find((column) => column.name === "total_score");
  assert.ok(totalScoreColumn, "The R Group and aggregate preview must expose its total_score output.");
  await waitForLocatorText(
    app.locator(`td[data-grid-row="0"][data-grid-column="${totalScoreColumn.position}"]`),
    (text) => text.trim() === "181503",
    10_000,
    "the first visible R grouped sum"
  );
  await waitForLocatorText(
    app.locator(`td[data-grid-row="1"][data-grid-column="${totalScoreColumn.position}"]`),
    (text) => text.trim() === "545112",
    10_000,
    "the second visible R grouped sum"
  );
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return active?.metadata.steps.length === 1 && active.metadata.steps[0]?.kind === "groupBy";
    },
    30_000,
    "applying native R Group and aggregate"
  );
  await requireFreshExactSessionPanelHydration(testing, sessionId, "Applied R Group and aggregate must settle.");
  app = await releasedRSessionApp(workbench, testing, sessionId, "the applied R Group and aggregate session");
  await app.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema.some((column) => column.id === groupedScoreColumn.id)
      );
    },
    30_000,
    "undoing native R Group and aggregate"
  );
}
