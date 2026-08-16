import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { GridPage } from "../../shared/protocol";
import { assertReleasedRRowReductionGeneratedCode } from "./releasedRGeneratedCode";
import type { TestApi } from "./extensionHostTestApi";

interface ReleasedRRowReductionDependencies {
  readonly previewReleasedRDropDuplicates: (testing: TestApi, workbench: Page, sessionId: string) => Promise<string>;
  readonly previewReleasedRDropMissingRows: (testing: TestApi, workbench: Page, sessionId: string) => Promise<string>;
  readonly recordAcceptanceProgress: (stage: string) => void;
  readonly releasedRFirstVisibleRow: (
    testing: TestApi,
    sessionId: string,
    viewRequestId: string
  ) => Promise<GridPage["rows"][number]>;
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<Locator>;
  readonly releasedRVisibleRows: (
    testing: TestApi,
    sessionId: string,
    viewRequestId: string,
    limit: number
  ) => Promise<GridPage["rows"]>;
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
}

export function createReleasedRRowReductionJourney({
  previewReleasedRDropDuplicates,
  previewReleasedRDropMissingRows,
  recordAcceptanceProgress,
  releasedRFirstVisibleRow,
  releasedRSessionApp,
  releasedRVisibleRows,
  requireFreshExactSessionPanelHydration,
  waitFor
}: ReleasedRRowReductionDependencies) {
  return async function exerciseReleasedRRowReductionJourney(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    phase: "jupyter-r" | "jupyter-r-remote"
  ): Promise<void> {
    recordAcceptanceProgress(`${phase}:editing:row-reduction-view`);
    let app = await releasedRSessionApp(workbench, testing, sessionId, "the R row-reduction viewing filter");
    await app.getByRole("button", { name: "Column profiles and filters", exact: true }).click();
    let drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    let filterPanel = drawer.locator(".filterSortPanel").first();
    const advanced = filterPanel.getByRole("button", { name: "Use advanced filters", exact: true });
    if ((await advanced.count()) > 0) await advanced.click();
    await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "row_id" });
    await filterPanel.getByLabel("Predicate operator", { exact: true }).selectOption("between");
    await filterPanel.getByLabel("between predicate value", { exact: true }).fill("1");
    await filterPanel.getByLabel("Between predicate upper bound", { exact: true }).fill("10");
    await filterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.sessionId === sessionId &&
          current.metadata.shape.rows === 1_205 &&
          current.metadata.filteredShape.rows === 10 &&
          current.viewState.filterModel.filters[0]?.column === "row_id"
        );
      },
      30_000,
      "the unrelated R row-reduction viewing filter"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the filtered R row-reduction view");
    drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.getByRole("button", { name: "Close panel" }).click();

    recordAcceptanceProgress(`${phase}:editing:drop-missing-rows`);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Drop missing rows session");
    const missingStepId = await previewReleasedRDropMissingRows(testing, workbench, sessionId);
    let active = testing.activeSession();
    assert.ok(active?.metadata.draftStep?.kind === "dropMissingRows");
    assert.equal(active.metadata.draftStep.id, missingStepId);
    assert.equal(active.metadata.draftStep.params.columns, undefined);
    assert.equal(active.metadata.draftStep.params.how, "any");
    assert.equal(active.metadata.shape.rows, 1_203);
    assert.equal(active.metadata.filteredShape.rows, 9);
    assertReleasedRRowReductionGeneratedCode(active.code ?? "", "dropMissingRows");
    let first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-drop-missing-draft`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, value: first.values[0]?.display },
      { id: "r:r:1", label: "case-0002", value: "2" }
    );

    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Drop missing rows draft");
    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.sessionId === sessionId &&
          current.metadata.draftStep === undefined &&
          current.metadata.steps.length === 1 &&
          current.metadata.steps[0]?.kind === "dropMissingRows" &&
          current.metadata.steps[0].id === missingStepId &&
          current.metadata.shape.rows === 1_203 &&
          current.metadata.filteredShape.rows === 9
        );
      },
      30_000,
      "applying native R Drop missing rows"
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The applied R Drop missing rows step must reach its exact renderer before inspection."
    );
    await vscode.commands.executeCommand("openWrangler.selectStep", missingStepId);
    await waitFor(
      () => testing.activeSession()?.stepInspection?.stepId === missingStepId,
      30_000,
      "the applied native R Drop missing rows inspection"
    );
    let inspection = testing.activeSession()?.stepInspection;
    assert.ok(inspection);
    assert.deepEqual(inspection.diff, {
      addedRows: 0,
      removedRows: 2,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: true
    });
    assert.equal(inspection.inputPage.rows[0]?.id, "r:r:0");
    assert.equal(inspection.outputPage.rows[0]?.id, "r:r:1");
    assertReleasedRRowReductionGeneratedCode(inspection.code, "dropMissingRows");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R Drop missing rows session");
    await app
      .getByRole("region", { name: "Selected applied-step inspection" })
      .getByRole("button", { name: "Show confirmed data", exact: true })
      .click();
    await waitFor(
      () => testing.activeSession()?.stepInspection === undefined,
      10_000,
      "returning from the native R Drop missing rows inspection"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Drop missing rows session before undo");
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.sessionId === sessionId &&
          current.metadata.steps.length === 0 &&
          current.metadata.draftStep === undefined &&
          current.metadata.shape.rows === 1_205 &&
          current.metadata.filteredShape.rows === 10
        );
      },
      30_000,
      "undoing native R Drop missing rows"
    );
    first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-drop-missing-undone`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, value: first.values[0]?.display },
      { id: "r:r:0", label: "case-0001", value: "1" }
    );

    app = await releasedRSessionApp(
      workbench,
      testing,
      sessionId,
      "the R row-reduction session before clearing its view"
    );
    await app.getByRole("button", { name: "Column profiles and filters", exact: true }).click();
    drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    filterPanel = drawer.locator(".filterSortPanel").first();
    await filterPanel.getByRole("button", { name: "Clear all", exact: true }).click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.sessionId === sessionId &&
          current.metadata.filteredShape.rows === 1_205 &&
          current.viewState.filterModel.filters.length === 0
        );
      },
      30_000,
      "clearing the R row-reduction viewing filter"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the cleared R row-reduction view");
    drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.getByRole("button", { name: "Close panel" }).click();

    recordAcceptanceProgress(`${phase}:editing:drop-duplicates`);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Drop duplicates session");
    const duplicateStepId = await previewReleasedRDropDuplicates(testing, workbench, sessionId);
    active = testing.activeSession();
    assert.ok(active?.metadata.draftStep?.kind === "dropDuplicates");
    assert.equal(active.metadata.draftStep.id, duplicateStepId);
    assert.deepEqual(
      active.metadata.draftStep.params.columns?.map((column) => column.name),
      ["group"]
    );
    assert.equal(active.metadata.draftStep.params.keep, "first");
    assert.equal(active.metadata.shape.rows, 2);
    assertReleasedRRowReductionGeneratedCode(active.code ?? "", "dropDuplicates");
    let page = await releasedRVisibleRows(testing, sessionId, `${phase}-drop-duplicates-draft`, 2);
    assert.deepEqual(
      page.map((row) => ({ id: row.id, label: row.rowLabel, group: row.values[1]?.display })),
      [
        { id: "r:r:0", label: "case-0001", group: "A" },
        { id: "r:r:602", label: "case-0603", group: "B" }
      ]
    );

    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Drop duplicates draft");
    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.sessionId === sessionId &&
          current.metadata.draftStep === undefined &&
          current.metadata.steps.length === 1 &&
          current.metadata.steps[0]?.kind === "dropDuplicates" &&
          current.metadata.steps[0].id === duplicateStepId &&
          current.metadata.shape.rows === 2
        );
      },
      30_000,
      "applying native R Drop duplicates"
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The applied R Drop duplicates step must reach its exact renderer before inspection."
    );
    await vscode.commands.executeCommand("openWrangler.selectStep", duplicateStepId);
    await waitFor(
      () => testing.activeSession()?.stepInspection?.stepId === duplicateStepId,
      30_000,
      "the applied native R Drop duplicates inspection"
    );
    inspection = testing.activeSession()?.stepInspection;
    assert.ok(inspection);
    assert.deepEqual(inspection.diff, {
      addedRows: 0,
      removedRows: 1_203,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: true
    });
    assert.deepEqual(
      inspection.outputPage.rows.slice(0, 2).map((row) => row.id),
      ["r:r:0", "r:r:602"]
    );
    assertReleasedRRowReductionGeneratedCode(inspection.code, "dropDuplicates");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R Drop duplicates session");
    await app
      .getByRole("region", { name: "Selected applied-step inspection" })
      .getByRole("button", { name: "Show confirmed data", exact: true })
      .click();
    await waitFor(
      () => testing.activeSession()?.stepInspection === undefined,
      10_000,
      "returning from the native R Drop duplicates inspection"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Drop duplicates session before undo");
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.sessionId === sessionId &&
          current.metadata.steps.length === 0 &&
          current.metadata.draftStep === undefined &&
          current.metadata.shape.rows === 1_205 &&
          (current.code ?? "") === ""
        );
      },
      30_000,
      "undoing native R Drop duplicates"
    );
    page = await releasedRVisibleRows(testing, sessionId, `${phase}-drop-duplicates-undone`, 2);
    assert.deepEqual(
      page.map((row) => ({ id: row.id, label: row.rowLabel, value: row.values[0]?.display })),
      [
        { id: "r:r:0", label: "case-0001", value: "1" },
        { id: "r:r:1", label: "case-0002", value: "2" }
      ]
    );
  };
}
