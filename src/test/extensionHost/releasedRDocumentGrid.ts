import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type { TestApi } from "./extensionHostTestApi";

interface ReleasedRDocumentGridDependencies {
  readonly GRID_COLUMN_WINDOW: Readonly<{ columnOffset: number; columnLimit: number }>;
  readonly applyReleasedRQuickSort: (
    workbench: Page,
    testing: TestApi,
    columnName: string,
    direction: "ascending" | "descending",
    expectedPriority: readonly string[]
  ) => Promise<void>;
  readonly assertReleasedProfileStat: (panel: Locator, label: string, expected: string) => Promise<void>;
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
  readonly waitForLocatorText: (
    locator: Locator,
    predicate: (text: string) => boolean,
    timeoutMs: number,
    expectation: string
  ) => Promise<void>;
}

export function createReleasedRDocumentGrid({
  GRID_COLUMN_WINDOW,
  applyReleasedRQuickSort,
  assertReleasedProfileStat,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor,
  waitForLocatorText
}: ReleasedRDocumentGridDependencies) {
  return async function exerciseReleasedRDocumentGrid(
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ): Promise<void> {
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The plain R renderer must acknowledge its first complete host snapshot."
    );
    const app = await releasedRSessionApp(workbench, testing, sessionId, "the plain R grid session");
    assert.equal((await app.locator('[data-session-badge="backend"]').innerText()).trim(), "R");
    assert.equal((await app.locator('[data-session-badge="mode"]').innerText()).trim(), "EDITING");
    const visibleRows = app.getByRole("status", { name: "Visible rows" });
    await waitForLocatorText(visibleRows, (text) => text.trim() === "Rows 1–200 of 240", 10_000, "the first R block");
    await app.getByRole("button", { name: "Next block", exact: true }).click();
    await waitForLocatorText(
      visibleRows,
      (text) => text.trim() === "Rows 201–240 of 240",
      10_000,
      "the second R block"
    );
    await app.getByRole("button", { name: "Previous block", exact: true }).click();
    await waitForLocatorText(
      visibleRows,
      (text) => text.trim() === "Rows 1–200 of 240",
      10_000,
      "the restored R block"
    );

    const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await columnSearch.fill("score");
    await app
      .getByRole("option", { name: /^score,/u })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await columnSearch.press("Enter");
    await app.getByRole("button", { name: "Column profiles and filters", exact: true }).click();
    const drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    const profile = drawer.getByRole("tabpanel");
    await profile.getByRole("heading", { name: "score", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await assertReleasedProfileStat(profile, "Rows", "240");
    await assertReleasedProfileStat(profile, "Min", "1");
    await assertReleasedProfileStat(profile, "Max", "240");

    await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    const filterPanel = drawer.locator(".filterSortPanel").first();
    await filterPanel.waitFor({ state: "visible", timeout: 10_000 });
    await filterPanel.getByRole("button", { name: "Use advanced filters", exact: true }).click();
    await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "group" });
    await filterPanel.getByLabel("Predicate operator", { exact: true }).selectOption("equals");
    await filterPanel.getByLabel("equals predicate value", { exact: true }).fill("B");
    await filterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.filteredShape.rows === 120 &&
          active.viewState.filterModel.filters.length === 1 &&
          active.viewState.filterModel.filters[0]?.column === "group"
        );
      },
      30_000,
      "the plain R group filter"
    );
    await drawer.getByRole("button", { name: "Close panel" }).click();
    await applyReleasedRQuickSort(workbench, testing, "group", "ascending", ["group"]);
    await applyReleasedRQuickSort(workbench, testing, "score", "descending", ["score", "group"]);
    const active = testing.activeSession();
    assert.ok(active, "The sorted plain R session must remain active.");
    const first = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: active.metadata.revision,
      viewRequestId: "jupyter-r-document-sorted-page",
      offset: 0,
      limit: 1,
      filterModel: active.viewState.filterModel
    });
    assert.equal(first.kind, "page");
    if (first.kind !== "page") throw new Error("The sorted plain R page did not resolve.");
    assert.equal(first.page.totalRows, 120);
    assert.equal(first.page.rows[0]?.values[0]?.display, "240");
    assert.equal(first.page.rows[0]?.values[1]?.display, "B");
    assert.equal(first.page.rows[0]?.values[2]?.display, "240");
  };
}
