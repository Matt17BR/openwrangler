import * as assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { FilterModel, GridPage } from "../../shared/protocol";
import { assertReleasedRRowGeneratedCode } from "./releasedRGeneratedCode";
import type { TestApi } from "./extensionHostTestApi";

interface ReleasedRPersistentRowsDependencies {
  readonly applyReleasedRQuickSort: (
    workbench: Page,
    testing: TestApi,
    columnName: string,
    direction: "ascending" | "descending",
    expectedPriority: readonly string[]
  ) => Promise<void>;
  readonly previewReleasedRFilterRows: (testing: TestApi, workbench: Page, sessionId: string) => Promise<string>;
  readonly previewReleasedRSortRows: (testing: TestApi, workbench: Page, sessionId: string) => Promise<string>;
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

export function createReleasedRPersistentRowsJourney({
  applyReleasedRQuickSort,
  previewReleasedRFilterRows,
  previewReleasedRSortRows,
  recordAcceptanceProgress,
  releasedRFirstVisibleRow,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor
}: ReleasedRPersistentRowsDependencies) {
  return async function exerciseReleasedRPersistentRowsJourney(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    phase: "jupyter-r" | "jupyter-r-remote"
  ): Promise<void> {
    recordAcceptanceProgress(`${phase}:editing:persistent-sort`);
    let app = await releasedRSessionApp(workbench, testing, sessionId, "the R persistent-sort session");
    const sortDraftId = await previewReleasedRSortRows(testing, workbench, sessionId);
    let active = testing.activeSession();
    assert.ok(active?.metadata.draftStep?.kind === "sortRows", "The R Sort rows preview must retain its draft.");
    assert.equal(active.metadata.draftStep.id, sortDraftId);
    assert.deepEqual(
      active.metadata.draftStep.params.rules.map((rule) => ({
        column: rule.column.name,
        direction: rule.direction,
        nulls: rule.nulls
      })),
      [
        { column: "group", direction: "asc", nulls: "last" },
        { column: "score", direction: "desc", nulls: "last" }
      ]
    );
    assertReleasedRRowGeneratedCode(active.code ?? "", "sortRows");
    let first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-sort-draft`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, values: first.values.slice(0, 3).map((cell) => cell.display) },
      { id: "r:r:601", label: "case-0602", values: ["602", "A", "602"] }
    );

    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Sort rows draft");
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
          current.metadata.steps[0]?.kind === "sortRows" &&
          current.metadata.steps[0].id === sortDraftId &&
          current.metadata.shape.rows === 1_205
        );
      },
      30_000,
      "applying the native R Sort rows step"
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The applied R Sort rows step must reach its exact renderer before inspection."
    );
    await vscode.commands.executeCommand("openWrangler.selectStep", sortDraftId);
    await waitFor(
      () => testing.activeSession()?.stepInspection?.stepId === sortDraftId,
      30_000,
      "the applied native R Sort rows inspection"
    );
    let inspection = testing.activeSession()?.stepInspection;
    assert.ok(inspection, "The applied R Sort rows step must publish its inspection.");
    assert.deepEqual(inspection.diff, {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: true
    });
    assert.equal(inspection.inputPage.rows[0]?.id, "r:r:0");
    assert.equal(inspection.outputPage.rows[0]?.id, "r:r:601");
    assertReleasedRRowGeneratedCode(inspection.code, "sortRows");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R Sort rows session");
    await app
      .getByRole("region", { name: "Selected applied-step inspection" })
      .getByRole("button", { name: "Show confirmed data", exact: true })
      .click();
    await waitFor(
      () => testing.activeSession()?.stepInspection === undefined,
      10_000,
      "returning from the native R Sort rows inspection"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Sort rows session before undo");
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
      "undoing the native R Sort rows step"
    );
    first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-sort-undone`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, value: first.values[0]?.display },
      { id: "r:r:0", label: "case-0001", value: "1" }
    );

    const persistentFilterViewCheckpoint = `${phase}:editing:persistent-filter-view`;
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:open`);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R session before building a filtered view");
    const profiles = app.getByRole("button", { name: "Column profiles and filters", exact: true });
    await profiles.click();
    let drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:drawer-open`);
    await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    let filterPanel = drawer.locator(".filterSortPanel").first();
    const advanced = filterPanel.getByRole("button", { name: "Use advanced filters", exact: true });
    if ((await advanced.count()) > 0) await advanced.click();
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:advanced-mode`);
    await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "group" });
    await filterPanel.getByLabel("Predicate operator", { exact: true }).selectOption("equals");
    await filterPanel.getByLabel("equals predicate value", { exact: true }).fill("B");
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:predicate-ready`);
    await filterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:predicate-dispatched`);
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.metadata.filteredShape.rows === 603 &&
          current.viewState.filterModel.filters.length === 1 &&
          current.viewState.filterModel.filters[0]?.column === "group"
        );
      },
      30_000,
      "the R group viewing filter"
    );
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:predicate-confirmed`);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the filtered R persistent-row view");
    drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.getByRole("button", { name: "Close panel" }).click();
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:drawer-closed`);
    await applyReleasedRQuickSort(workbench, testing, "group", "ascending", ["group"]);
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:group-sort-confirmed`);
    await applyReleasedRQuickSort(workbench, testing, "score", "descending", ["score", "group"]);
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:score-sort-confirmed`);
    active = testing.activeSession();
    assert.ok(active, "The R persistent-filter journey requires its active view.");
    assert.equal(active.metadata.shape.rows, 1_205);
    assert.equal(active.metadata.filteredShape.rows, 603);
    assert.equal(active.viewState.filterModel.filters.length, 1);
    assert.deepEqual(
      active.viewState.filterModel.sort.map((rule) => ({
        column: rule.column,
        direction: rule.direction,
        nulls: rule.nulls
      })),
      [
        { column: "score", direction: "desc", nulls: "last" },
        { column: "group", direction: "asc", nulls: "last" }
      ]
    );
    const viewingModel = JSON.parse(JSON.stringify(active.viewState.filterModel)) as FilterModel;
    const expectedFilteredFirst = {
      id: "r:r:1204",
      label: "case-1205",
      values: ["1205", "B", "1205"]
    };
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:model-confirmed`);
    first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-filter-view`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, values: first.values.slice(0, 3).map((cell) => cell.display) },
      expectedFilteredFirst
    );
    recordAcceptanceProgress(`${persistentFilterViewCheckpoint}:complete`);

    recordAcceptanceProgress(`${phase}:editing:persistent-filter-discard`);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R view before Filter rows preview");
    const discardedFilterId = await previewReleasedRFilterRows(testing, workbench, sessionId);
    active = testing.activeSession();
    assert.ok(active?.metadata.draftStep?.kind === "filterRows", "The R Filter rows preview must retain its draft.");
    assert.equal(active.metadata.draftStep.id, discardedFilterId);
    assert.equal(active.metadata.shape.rows, 603);
    assert.deepEqual(active.viewState.filterModel, viewingModel);
    assertReleasedRRowGeneratedCode(active.code ?? "", "filterRows");
    first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-filter-draft`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, values: first.values.slice(0, 3).map((cell) => cell.display) },
      expectedFilteredFirst
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Filter rows draft before discard");
    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.sessionId === sessionId &&
          current.metadata.steps.length === 0 &&
          current.metadata.draftStep === undefined &&
          current.metadata.shape.rows === 1_205 &&
          current.metadata.filteredShape.rows === 603 &&
          isDeepStrictEqual(current.viewState.filterModel, viewingModel) &&
          (current.code ?? "") === ""
        );
      },
      30_000,
      "discarding the native R Filter rows preview without changing its view"
    );
    first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-filter-discarded`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, values: first.values.slice(0, 3).map((cell) => cell.display) },
      expectedFilteredFirst
    );

    recordAcceptanceProgress(`${phase}:editing:persistent-filter-apply`);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R view before applying Filter rows");
    const filterStepId = await previewReleasedRFilterRows(testing, workbench, sessionId);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Filter rows draft before apply");
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
          current.metadata.steps[0]?.kind === "filterRows" &&
          current.metadata.steps[0].id === filterStepId &&
          current.metadata.shape.rows === 603 &&
          current.metadata.filteredShape.rows === 603 &&
          isDeepStrictEqual(current.viewState.filterModel, viewingModel)
        );
      },
      30_000,
      "applying the native R Filter rows step"
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The applied R Filter rows step must reach its exact renderer before inspection."
    );
    await vscode.commands.executeCommand("openWrangler.selectStep", filterStepId);
    await waitFor(
      () => testing.activeSession()?.stepInspection?.stepId === filterStepId,
      30_000,
      "the applied native R Filter rows inspection"
    );
    inspection = testing.activeSession()?.stepInspection;
    assert.ok(inspection, "The applied R Filter rows step must publish its inspection.");
    assert.deepEqual(inspection.diff, {
      addedRows: 0,
      removedRows: 602,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: true
    });
    assert.equal(inspection.inputPage.rows[0]?.id, "r:r:0");
    assert.equal(inspection.outputPage.rows[0]?.id, "r:r:1204");
    assertReleasedRRowGeneratedCode(inspection.code, "filterRows");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R Filter rows session");
    await app
      .getByRole("region", { name: "Selected applied-step inspection" })
      .getByRole("button", { name: "Show confirmed data", exact: true })
      .click();
    await waitFor(
      () => testing.activeSession()?.stepInspection === undefined,
      10_000,
      "returning from the native R Filter rows inspection"
    );
    first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-filter-applied`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, values: first.values.slice(0, 3).map((cell) => cell.display) },
      expectedFilteredFirst
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R Filter rows session before undo");
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.sessionId === sessionId &&
          current.metadata.steps.length === 0 &&
          current.metadata.draftStep === undefined &&
          current.metadata.shape.rows === 1_205 &&
          current.metadata.filteredShape.rows === 603 &&
          isDeepStrictEqual(current.viewState.filterModel, viewingModel) &&
          (current.code ?? "") === ""
        );
      },
      30_000,
      "undoing the native R Filter rows step without changing its view"
    );
    first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-filter-undone`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, values: first.values.slice(0, 3).map((cell) => cell.display) },
      expectedFilteredFirst
    );

    app = await releasedRSessionApp(workbench, testing, sessionId, "the R session before clearing its test view");
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
          current?.metadata.filteredShape.rows === 1_205 &&
          current.viewState.filterModel.filters.length === 0 &&
          current.viewState.filterModel.sort.length === 0
        );
      },
      30_000,
      "clearing the native R persistent-row acceptance view"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the cleared R persistent-row view");
    drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.getByRole("button", { name: "Close panel" }).click();
    first = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-persistent-rows-cleanup`);
    assert.deepEqual(
      { id: first.id, label: first.rowLabel, value: first.values[0]?.display },
      { id: "r:r:0", label: "case-0001", value: "1" }
    );
  };
}
