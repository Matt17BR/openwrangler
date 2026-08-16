import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { ColumnReference, SessionMetadata } from "../../shared/protocol";
import type { ReleasedRAcceptanceCoverageProfile } from "./releasedRAcceptanceCoverage";
import type { TestApi } from "./extensionHostTestApi";

interface ReleasedRGridDependencies {
  readonly GRID_COLUMN_WINDOW: Readonly<{ columnOffset: number; columnLimit: number }>;
  readonly applyReleasedRQuickSort: (
    workbench: Page,
    testing: TestApi,
    columnName: string,
    direction: "ascending" | "descending",
    expectedPriority: readonly string[]
  ) => Promise<void>;
  readonly assertReleasedProfileStat: (panel: Locator, label: string, expected: string) => Promise<void>;
  readonly columnReference: (metadata: SessionMetadata, name: string) => ColumnReference;
  readonly openWorkbenchContextMenu: (
    workbench: Page,
    target: Locator,
    requiredActionName: string | undefined,
    surface: string
  ) => Promise<Readonly<{ menu: Locator }>>;
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    expectation: string
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

export function createReleasedRGridJourney({
  GRID_COLUMN_WINDOW,
  applyReleasedRQuickSort,
  assertReleasedProfileStat,
  columnReference,
  openWorkbenchContextMenu,
  releasedRSessionApp,
  waitFor,
  waitForLocatorText
}: ReleasedRGridDependencies) {
  return async function exerciseReleasedRGridJourney(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    paging: ReleasedRAcceptanceCoverageProfile["gridPaging"]
  ): Promise<void> {
    let app = await releasedRSessionApp(
      workbench,
      testing,
      sessionId,
      "the native R renderer's first complete host snapshot"
    );
    assert.equal((await app.locator('[data-session-badge="backend"]').innerText()).trim(), "R");
    assert.equal((await app.locator('[data-session-badge="mode"]').innerText()).trim(), "VIEWING");
    await app
      .getByRole("rowheader", { name: "Row 1, label case-0001", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await app.getByRole("button", { name: "Add step", exact: true }).count(), 0);
    assert.equal(await app.getByRole("button", { name: "Export", exact: true }).count(), 0);
    const active = testing.activeSession();
    assert.ok(active, "The native R profile journey requires an active session.");
    assert.equal(active.sessionId, sessionId, "The native R profile journey must stay on its exact session.");
    const scoreColumn = columnReference(active.metadata, "score");

    const profiles = app.getByRole("button", { name: "Header profiles", exact: true });
    await profiles.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await profiles.isEnabled(), true);
    assert.equal(await profiles.getAttribute("aria-pressed"), "false", "R header profiles must start off.");
    let columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await columnSearch.fill(scoreColumn.name);
    await app
      .getByRole("option", { name: /^score,/u })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await columnSearch.press("Enter");
    await waitFor(
      () => {
        const current = testing.activeSession();
        return current?.sessionId === sessionId && current.viewState.selectedColumnId === scoreColumn.id;
      },
      10_000,
      "the native R grid to select its exact score column before profiling"
    );

    app = await releasedRSessionApp(workbench, testing, sessionId, "the selected native R score profile");
    const profileToggle = app.getByRole("button", { name: "Column profiles and filters", exact: true });
    await profileToggle.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await profileToggle.isEnabled(), true);
    await profileToggle.click();
    let drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    const columnProfile = drawer.getByRole("tabpanel");
    await columnProfile.getByRole("heading", { name: "score", exact: true }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    await assertReleasedProfileStat(columnProfile, "Rows", "1,205");
    await assertReleasedProfileStat(columnProfile, "Distinct", "1,205");
    await assertReleasedProfileStat(columnProfile, "Min", "1");
    await assertReleasedProfileStat(columnProfile, "Max", "1,205");
    await drawer.getByRole("tab", { name: "Dataset", exact: true }).click();
    const datasetProfile = drawer.getByRole("tabpanel");
    await datasetProfile.getByRole("heading", { name: "Dataset", exact: true }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    await assertReleasedProfileStat(datasetProfile, "Rows", "1,205");
    await assertReleasedProfileStat(datasetProfile, "Columns", "25");
    await assertReleasedProfileStat(datasetProfile, "Missing cells", "2");
    await assertReleasedProfileStat(datasetProfile, "Rows with missing values", "2");
    await assertReleasedProfileStat(datasetProfile, "Duplicate rows", "0");

    await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    await drawer.getByRole("heading", { name: "Filters / Sorts", exact: true }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    assert.equal(await drawer.getByText("Filtering is unavailable for this dataframe.", { exact: true }).count(), 0);
    let filterPanel = drawer.locator(".filterSortPanel").first();
    await filterPanel.waitFor({ state: "visible", timeout: 10_000 });
    await filterPanel.getByRole("button", { name: "Use advanced filters", exact: true }).click();
    const acrossColumns = filterPanel.getByRole("combobox", { name: "Across columns", exact: true });
    await acrossColumns.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await acrossColumns.inputValue(), "and");

    await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "score" });
    await filterPanel.getByLabel("Search values for score", { exact: true }).fill("1200");
    await filterPanel.getByRole("button", { name: /Search values/iu }).click();
    const scoreValue = filterPanel.locator(".valueList label.checkboxRow").filter({ hasText: "1200" }).first();
    await scoreValue.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal((await scoreValue.locator("span").innerText()).trim(), "1200");
    assert.equal((await scoreValue.locator("small").innerText()).trim(), "1");
    await scoreValue.getByRole("checkbox").check();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.metadata.filteredShape.rows === 1 &&
          current.viewState.filterModel.filters.length === 1 &&
          current.viewState.filterModel.filters[0]?.column === "score"
        );
      },
      30_000,
      "the selected native R score value to filter the complete frame"
    );

    app = await releasedRSessionApp(workbench, testing, sessionId, "the selected native R score filter");
    drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    filterPanel = drawer.locator(".filterSortPanel").first();
    await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "group" });
    await filterPanel.getByLabel("Predicate operator", { exact: true }).selectOption("equals");
    await filterPanel.getByLabel("equals predicate value", { exact: true }).fill("B");
    await filterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
    await waitFor(
      () => {
        const current = testing.activeSession();
        return (
          current?.metadata.filteredShape.rows === 1 &&
          current.viewState.filterModel.filters.length === 2 &&
          current.viewState.filterModel.sort.length === 0 &&
          (current.viewState.filterModel.logic ?? "and") === "and"
        );
      },
      30_000,
      "the cross-column native R filter to publish its one matching row"
    );
    app = await releasedRSessionApp(
      workbench,
      testing,
      sessionId,
      "the native R filter result before its row and profile are inspected"
    );
    const filteredProfileToggle = app.getByRole("button", { name: "Column profiles and filters", exact: true });
    if ((await filteredProfileToggle.getAttribute("aria-expanded")) !== "true") await filteredProfileToggle.click();
    drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    filterPanel = drawer.locator(".filterSortPanel").first();

    const filteredSession = testing.activeSession();
    assert.ok(filteredSession, "The native R filter journey requires its confirmed session.");
    assert.equal(filteredSession.sessionId, sessionId);
    assert.equal(filteredSession.metadata.filteredShape.rows, 1);
    assert.equal(filteredSession.viewState.filterModel.logic ?? "and", "and");
    assert.deepEqual(filteredSession.viewState.filterModel.sort, []);
    assert.equal(filteredSession.viewState.filterModel.filters.length, 2);
    const scoreFilter = filteredSession.viewState.filterModel.filters.find((filter) => filter.column === "score");
    const groupFilter = filteredSession.viewState.filterModel.filters.find((filter) => filter.column === "group");
    assert.deepEqual(scoreFilter?.valueFilter?.selectedValues, [
      {
        kind: "typedSelection",
        version: 1,
        columnType: "float",
        cell: { kind: "number", raw: 1200, display: "1200", isNull: false, isNaN: false }
      }
    ]);
    assert.deepEqual(groupFilter?.predicates, [{ kind: "predicate", operator: "equals", value: "B" }]);
    await filterPanel.getByText("2 filtered columns", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await filterPanel
      .getByRole("button", { name: "Remove equals 1200 (number) filter from score", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await filterPanel
      .getByRole("button", { name: 'Remove equals "B" filter from group', exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });

    let visibleRows = app.getByRole("status", { name: "Visible rows" });
    await waitForLocatorText(visibleRows, (text) => text.trim() === "Rows 1–1 of 1", 10_000, "the filtered R row");
    await app
      .getByRole("rowheader", { name: "Row 1, label case-1200", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    for (const [column, expected] of [
      [0, "1200"],
      [1, "B"],
      [2, "1200"]
    ] as const) {
      await waitForLocatorText(
        app.locator(`td[data-grid-row="0"][data-grid-column="${column}"]`),
        (text) => text.trim() === expected,
        10_000,
        `the filtered R grid value in column ${column + 1}`
      );
    }

    await drawer.getByRole("tab", { name: "Column", exact: true }).click();
    const filteredColumnProfile = drawer.getByRole("tabpanel");
    await filteredColumnProfile.getByRole("heading", { name: "score", exact: true }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    await assertReleasedProfileStat(filteredColumnProfile, "Rows", "1");
    await assertReleasedProfileStat(filteredColumnProfile, "Distinct", "1");
    await assertReleasedProfileStat(filteredColumnProfile, "Min", "1,200");
    await assertReleasedProfileStat(filteredColumnProfile, "Max", "1,200");

    await drawer.getByRole("tab", { name: "Dataset", exact: true }).click();
    const filteredDatasetProfile = drawer.getByRole("tabpanel");
    await filteredDatasetProfile.getByRole("heading", { name: "Dataset", exact: true }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    await assertReleasedProfileStat(filteredDatasetProfile, "Rows", "1");
    await assertReleasedProfileStat(filteredDatasetProfile, "Columns", "25");
    await assertReleasedProfileStat(filteredDatasetProfile, "Rows before filters", "1,205");
    await assertReleasedProfileStat(filteredDatasetProfile, "Missing cells", "0");
    await assertReleasedProfileStat(filteredDatasetProfile, "Rows with missing values", "0");
    await assertReleasedProfileStat(filteredDatasetProfile, "Duplicate rows", "0");
    const filteredStats = testing.activeSession()?.metadata.stats;
    assert.ok(filteredStats, "The filtered R dataset profile must reach the confirmed host state.");
    assert.equal(filteredStats.missingValuesByColumn.length, 25);
    assert.ok(
      filteredStats.missingValuesByColumn.every((item) => item.count === 0),
      "The one filtered R row must not contain a missing value."
    );

    // The real UI owns the filter and both filtered profile requests above.
    // Read the stable source row only after that visible journey is complete;
    // Clear all below immediately establishes the next webview-owned context.
    const filteredPageRequestId = "jupyter-r-filtered-page";
    const filteredPage = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: testing.activeSession()!.metadata.revision,
      viewRequestId: filteredPageRequestId,
      offset: 0,
      limit: 1,
      filterModel: testing.activeSession()!.viewState.filterModel
    });
    assert.equal(filteredPage.kind, "page");
    if (filteredPage.kind !== "page") throw new Error("The native R filtered page did not resolve.");
    assert.equal(filteredPage.viewRequestId, filteredPageRequestId);
    assert.equal(filteredPage.page.totalRows, 1);
    assert.deepEqual(
      filteredPage.page.rows.map((row) => ({
        id: row.id,
        rowLabel: row.rowLabel,
        values: row.values.slice(0, 3).map((cell) => cell.display)
      })),
      [{ id: "r:r:1199", rowLabel: "case-1200", values: ["1200", "B", "1200"] }]
    );

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
      "Clear all to restore the complete native R frame"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the cleared native R view before paging resumes");
    visibleRows = app.getByRole("status", { name: "Visible rows" });
    columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await waitForLocatorText(
      visibleRows,
      (text) => text.trim() === "Rows 1–200 of 1,205",
      10_000,
      "the restored native R frame"
    );
    drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    if ((await drawer.count()) > 0 && (await drawer.isVisible())) {
      await drawer.getByRole("button", { name: "Close panel" }).click();
    }

    const next = app.getByRole("button", { name: "Next block", exact: true });
    if (paging === "all-blocks") {
      for (const expected of [
        "Rows 201–400 of 1,205",
        "Rows 401–600 of 1,205",
        "Rows 601–800 of 1,205",
        "Rows 801–1,000 of 1,205",
        "Rows 1,001–1,200 of 1,205",
        "Rows 1,201–1,205 of 1,205"
      ]) {
        await next.click();
        await waitForLocatorText(visibleRows, (text) => text.trim() === expected, 10_000, expected);
      }
      assert.equal(await next.isDisabled(), true);

      await columnSearch.fill("extra_20");
      await app
        .getByRole("option", { name: /^extra_20,/u })
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await columnSearch.press("Enter");
      const finalColumn = app.locator('th[data-column="extra_20"]');
      await finalColumn.waitFor({ state: "visible", timeout: 10_000 });
      const finalColumnIndex = testing
        .activeSession()
        ?.metadata.schema.findIndex((column) => column.name === "extra_20");
      assert.ok(finalColumnIndex !== undefined && finalColumnIndex >= 0, "The complete R schema must retain extra_20.");
      await app
        .locator(`td[data-grid-row="1204"][data-grid-column="${finalColumnIndex}"]`)
        .filter({ hasText: "value-20-1205" })
        .waitFor({ state: "visible", timeout: 10_000 });
    } else {
      await next.click();
      await waitForLocatorText(
        visibleRows,
        (text) => text.trim() === "Rows 201–400 of 1,205",
        10_000,
        "the representative second R block"
      );
      await app.getByRole("button", { name: "Previous block", exact: true }).click();
      await waitForLocatorText(
        visibleRows,
        (text) => text.trim() === "Rows 1–200 of 1,205",
        10_000,
        "the representative restored R block"
      );
    }

    await applyReleasedRQuickSort(workbench, testing, "group", "ascending", ["group"]);
    await applyReleasedRQuickSort(workbench, testing, "score", "descending", ["score", "group"]);
    const scoreFirst = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: testing.activeSession()!.metadata.revision,
      viewRequestId: "jupyter-r-score-priority",
      offset: 0,
      limit: 1,
      filterModel: testing.activeSession()!.viewState.filterModel
    });
    assert.equal(scoreFirst.kind, "page");
    if (scoreFirst.kind === "page") assert.equal(scoreFirst.page.rows[0]?.values[0]?.display, "1205");

    await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
    const sidebar = workbench.locator(".part.sidebar:visible");
    const filtersTree = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
    if (!(await filtersTree.isVisible().catch(() => false))) {
      await sidebar.getByText("Filters / Sorts", { exact: true }).first().click();
    }
    const groupPriorityTwo = filtersTree
      .getByRole("treeitem", { name: /^group, Priority 2 · Ascending · nulls last/u })
      .first();
    await groupPriorityTwo.waitFor({ state: "visible", timeout: 10_000 });
    const { menu: sortContextMenu } = await openWorkbenchContextMenu(
      workbench,
      groupPriorityTwo,
      undefined,
      "Filters / Sorts row"
    );
    const moveGroupUp = sortContextMenu.getByRole("menuitem", { name: /Move View Sort Up$/u }).last();
    await moveGroupUp.waitFor({ state: "visible", timeout: 3_000 });
    await moveGroupUp.click();
    await waitFor(
      () =>
        testing
          .activeSession()
          ?.viewState.filterModel.sort.map((rule) => rule.column)
          .join(",") === "group,score",
      10_000,
      "the native R sort priority to move through the Activity Bar"
    );
    const groupFirst = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: testing.activeSession()!.metadata.revision,
      viewRequestId: "jupyter-r-group-priority",
      offset: 0,
      limit: 1,
      filterModel: testing.activeSession()!.viewState.filterModel
    });
    assert.equal(groupFirst.kind, "page");
    if (groupFirst.kind === "page") assert.equal(groupFirst.page.rows[0]?.values[0]?.display, "602");
  };
}
