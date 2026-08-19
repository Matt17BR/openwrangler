import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { ColumnReference, SessionMetadata } from "../../shared/protocol";
import { assertExactBytes } from "./acceptanceSourceFixture";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import { exportCleanedDataThroughWorkbench } from "./cleanedDataExport";
import { waitForCodePreview } from "./codePreview";
import type { TestApi } from "./extensionHostTestApi";
import {
  PACKAGED_FIRST_USE_ROW_COUNT,
  PACKAGED_SCREENSHOT_COLUMNS,
  PACKAGED_SCREENSHOT_MARKETS,
  packagedFirstUseAccountNoteKind,
  packagedScreenshotRow
} from "./screenshotEvidence";

export interface PackagedFirstUseInteractionDependencies {
  readonly clearReleasedJupyterScreenshotTransientUi: (workbench: Page) => Promise<void>;
  readonly columnReference: (metadata: SessionMetadata, name: string) => ColumnReference;
  readonly previewAndDiscardPreviousRevenue: (
    app: Locator,
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    revenue: ColumnReference
  ) => Promise<Locator>;
  readonly previewApplyAndUndoGroupedRevenue: (
    app: Locator,
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    revenue: ColumnReference
  ) => Promise<Locator>;
  readonly previewMostCommonAccountNote: (app: Locator, testing: TestApi) => Promise<void>;
  readonly exerciseMultiOutputSplitJourney: (
    app: Locator,
    testing: TestApi,
    sessionId: string,
    synchronizeApp: (phase: string) => Promise<Locator>
  ) => Promise<void>;
  readonly exercisePivotLongerJourney: (
    app: Locator,
    testing: TestApi,
    sessionId: string,
    selectedColumnNames: readonly [string, string],
    synchronizeApp: (phase: string) => Promise<Locator>
  ) => Promise<void>;
  readonly exercisePivotWiderJourney: (
    app: Locator,
    testing: TestApi,
    sessionId: string,
    namesFromName: string,
    valuesFromName: string,
    keys: readonly [string, string, ...string[]],
    synchronizeApp: (phase: string) => Promise<Locator>,
    reacquireApp: (phase: string) => Promise<Locator>
  ) => Promise<void>;
  readonly previewUppercaseMarket: (app: Locator, testing: TestApi, newColumn: string) => Promise<void>;
  readonly reacquireAcknowledgedSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<Locator>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly synchronizedSessionApp: (
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
    expectation: string,
    diagnostics?: (lastText: string) => string
  ) => Promise<void>;
  readonly webviewDiscoveryTimeoutMs: number;
}

export function createPackagedFirstUseInteractionJourney(
  dependencies: PackagedFirstUseInteractionDependencies
): (
  testing: TestApi,
  workbench: Page,
  sessionId: string,
  fixture: vscode.Uri,
  sourceBytes: Uint8Array
) => Promise<void> {
  const {
    clearReleasedJupyterScreenshotTransientUi,
    columnReference,
    exerciseMultiOutputSplitJourney,
    exercisePivotLongerJourney,
    exercisePivotWiderJourney,
    previewAndDiscardPreviousRevenue,
    previewApplyAndUndoGroupedRevenue,
    previewMostCommonAccountNote,
    previewUppercaseMarket,
    reacquireAcknowledgedSessionApp,
    recordAcceptanceProgress,
    synchronizedSessionApp,
    waitFor,
    waitForLocatorText,
    webviewDiscoveryTimeoutMs
  } = dependencies;
  const OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS = webviewDiscoveryTimeoutMs;

  async function exercisePackagedFirstUseInteractionJourney(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    fixture: vscode.Uri,
    sourceBytes: Uint8Array
  ): Promise<void> {
    let app = await synchronizedSessionApp(
      workbench,
      testing,
      sessionId,
      "The first-use journey must start from the renderer that acknowledged the current session."
    );
    const rediscoverApp = async (phase: string): Promise<Locator> => {
      return synchronizedSessionApp(
        workbench,
        testing,
        sessionId,
        `${phase} requires the renderer that acknowledged the current session.`
      );
    };
    const reacquireApp = async (phase: string): Promise<Locator> => {
      return reacquireAcknowledgedSessionApp(
        workbench,
        testing,
        sessionId,
        `${phase} must keep the current acknowledged renderer receipt.`
      );
    };
    const confirmedMutationDiagnostics = (): string => {
      const active = testing.activeSession();
      return JSON.stringify({
        activeSessionId: active?.sessionId,
        revision: active?.metadata.revision,
        draft: active?.metadata.draftStep?.kind,
        stepCount: active?.metadata.steps.length,
        selectedColumnId: active?.viewState.selectedColumnId,
        scrollLeft: active?.viewState.viewport.scrollLeft,
        scheduler: testing.sessionSchedulerState(sessionId),
        panel: {
          hydrated: testing.panelHydrated(sessionId),
          synchronizable: testing.panelSynchronizable(sessionId),
          receipt: testing.panelSynchronizationReceipt(sessionId)
        }
      });
    };
    const confirmedMutationRendererReady = (): boolean => {
      const active = testing.activeSession();
      const receipt = testing.panelSynchronizationReceipt(sessionId);
      if (!active || active.sessionId !== sessionId || !receipt || receipt.sessionId !== sessionId) return false;
      return testing.panelHydrated(sessionId) && receipt.revision === active.metadata.revision;
    };
    const profileWaitDiagnostics =
      (expectedLabels: readonly string[]) =>
      (lastDrawerText: string): string => {
        const coordinator = testing.diagnostics();
        const normalizedText = lastDrawerText.toLowerCase();
        return JSON.stringify({
          profile: {
            profilingPending: normalizedText.includes("profiling selected column"),
            drawerTextLength: lastDrawerText.length,
            expectedLabels: Object.fromEntries(
              expectedLabels.map((label) => [label, normalizedText.includes(label.toLowerCase())])
            )
          },
          coordinator: {
            activeSessionId: coordinator.activeSessionId,
            sessionCount: coordinator.sessionCount
          },
          scheduler: testing.sessionSchedulerState(sessionId),
          panel: {
            hydrated: testing.panelHydrated(sessionId),
            synchronizable: testing.panelSynchronizable(sessionId),
            receipt: testing.panelSynchronizationReceipt(sessionId)
          }
        });
      };
    const openSidePanel = async (
      view?: "Column" | "Filters / Sorts"
    ): Promise<{ readonly drawer: Locator; readonly toggle: Locator }> => {
      let toggle = app.getByRole("button", { name: "Column profiles and filters" });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
        app = await reacquireApp(`${view ?? "Insights"} panel opening`);
        toggle = app.locator('button[aria-controls="openwrangler-insights-panel"][aria-expanded="true"]');
        await toggle.waitFor({ state: "visible", timeout: 10_000 });
      }
      const drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
      await drawer.waitFor({ state: "visible", timeout: 10_000 });
      if (view) {
        const tab = drawer.getByRole("tab", { name: view, exact: true });
        await tab.waitFor({ state: "visible", timeout: 10_000 });
        if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
      }
      return { drawer, toggle };
    };
    assert.equal(
      await app.getByRole("group", { name: "Cleaning plan" }).count(),
      0,
      "A new dataframe must not waste toolbar space on an empty cleaning-plan group."
    );
    await app.getByRole("button", { name: "Export", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    recordAcceptanceProgress("platform-smoke:column-search");
    let columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await columnSearch.fill("revenue");
    const revenueOption = app.getByRole("option", { name: "revenue, Number column", exact: true });
    await revenueOption.waitFor({ state: "visible", timeout: 10_000 });
    await revenueOption.getByRole("img", { name: "Number column type" }).waitFor({ state: "visible", timeout: 10_000 });
    await columnSearch.press("Enter");
    const revenue = columnReference(testing.activeSession()!.metadata, "revenue");
    await waitFor(
      () => testing.activeSession()?.viewState.selectedColumnId === revenue.id,
      10_000,
      "column search to navigate to the selected numeric column"
    );
    app = await reacquireApp("Revenue column navigation");
    columnSearch = app.getByRole("combobox", { name: "Column", exact: true });

    recordAcceptanceProgress("platform-smoke:insights");
    let { drawer, toggle: insightsToggle } = await openSidePanel("Column");
    await drawer.getByRole("heading", { name: "revenue", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await waitForLocatorText(
      drawer,
      (text) => {
        const normalized = text.toLowerCase();
        return (
          !normalized.includes("profiling selected column") &&
          ["min", "max", "mean", "median", "distribution"].every((label) => normalized.includes(label))
        );
      },
      30_000,
      "complete exact revenue insights",
      profileWaitDiagnostics(["Min", "Max", "Mean", "Median", "Distribution"])
    );
    const histogramBars = drawer.locator(".numericHistogramHitTarget");
    assert.ok(await histogramBars.count(), "Numeric insights must expose keyboard-focusable histogram bins.");
    assert.match(
      (await histogramBars.first().getAttribute("aria-label")) ?? "",
      /: [\d,.]+ rows? \([\d.,]+%\)/u,
      "Every histogram bin must expose its row count and percentage."
    );
    assert.equal(
      await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      "The Insights drawer must not clip content horizontally."
    );

    recordAcceptanceProgress("platform-smoke:text-insights");
    const accountNote = columnReference(testing.activeSession()!.metadata, "account_note");
    await columnSearch.fill("account_note");
    const accountNoteOption = app.getByRole("option", { name: "account_note, Text column", exact: true });
    await accountNoteOption.waitFor({ state: "visible", timeout: 10_000 });
    await accountNoteOption.getByRole("img", { name: "Text column type" }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    await columnSearch.press("Enter");
    await waitFor(
      () => testing.activeSession()?.viewState.selectedColumnId === accountNote.id,
      10_000,
      "column search to navigate to the realistic text column"
    );
    app = await reacquireApp("Account-note column navigation");
    columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    ({ drawer, toggle: insightsToggle } = await openSidePanel("Column"));
    await drawer.getByRole("heading", { name: "account_note", exact: true }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    await waitForLocatorText(
      drawer,
      (text) => {
        const normalized = text.toLowerCase();
        return (
          !normalized.includes("profiling selected column") &&
          ["null", "empty", "min length", "max length", "mean length"].every((label) => normalized.includes(label))
        );
      },
      30_000,
      "complete exact account-note insights",
      profileWaitDiagnostics(["Null", "Empty", "Min length", "Max length", "Mean length"])
    );

    // Inspect exact values only after the user-facing profile has completed, so
    // the acceptance assertion cannot contend with or mask the renderer request.
    const accountNoteProfile = await testing.request({
      kind: "getSummary",
      sessionId,
      revision: testing.activeSession()!.metadata.revision,
      viewRequestId: "platform-smoke-account-note-summary",
      filterModel: testing.activeSession()!.viewState.filterModel,
      columnIds: [accountNote.id]
    });
    assert.equal(accountNoteProfile.kind, "summary", "The realistic text profile must complete natively.");
    if (accountNoteProfile.kind !== "summary") throw new Error("The realistic text profile did not resolve.");
    const accountNoteSummary = accountNoteProfile.summaries[0];
    assert.equal(accountNoteSummary?.columnId, accountNote.id);
    const accountNotePosition = PACKAGED_SCREENSHOT_COLUMNS.length - 1;
    assert.equal(PACKAGED_SCREENSHOT_COLUMNS[accountNotePosition], "account_note");
    const sourceNotes = Array.from({ length: PACKAGED_FIRST_USE_ROW_COUNT }, (_, index) => ({
      kind: packagedFirstUseAccountNoteKind(index),
      value: packagedScreenshotRow(index)[accountNotePosition]!
    }));
    const presentNotes = sourceNotes.filter((item) => item.kind !== "null").map((item) => item.value);
    const lengths = presentNotes.map((value) => [...value].length);
    const expectedNullCount = sourceNotes.filter((item) => item.kind === "null").length;
    const expectedEmptyCount = sourceNotes.filter((item) => item.kind === "empty").length;
    assert.equal(accountNoteSummary?.nullCount, expectedNullCount);
    assert.equal(accountNoteSummary?.text?.emptyCount, expectedEmptyCount);
    assert.equal(accountNoteSummary?.text?.minLength, Math.min(...lengths));
    assert.equal(accountNoteSummary?.text?.maxLength, Math.max(...lengths));
    assert.ok(
      Math.abs(
        (accountNoteSummary?.text?.meanLength ?? Number.NaN) -
          lengths.reduce((sum, length) => sum + length, 0) / lengths.length
      ) < 1e-10,
      "The realistic text profile must publish its exact mean Unicode code-point length."
    );
    const accountNoteText = accountNoteSummary?.text;
    assert.ok(accountNoteText, "The realistic text column must publish exact text metrics.");

    assert.equal(await drawer.locator("dt", { hasText: /^NaN$/u }).count(), 0);
    const expectedVisibleMetrics = new Map<string, string>([
      ["Null", expectedNullCount.toLocaleString()],
      ["Empty", expectedEmptyCount.toLocaleString()],
      ["Min length", accountNoteText.minLength!.toLocaleString(undefined, { maximumFractionDigits: 4 })],
      ["Max length", accountNoteText.maxLength!.toLocaleString(undefined, { maximumFractionDigits: 4 })],
      ["Mean length", accountNoteText.meanLength!.toLocaleString(undefined, { maximumFractionDigits: 4 })]
    ]);
    for (const [label, expectedValue] of expectedVisibleMetrics) {
      const value = drawer
        .locator("dt", { hasText: new RegExp(`^${label}$`, "u") })
        .locator("xpath=following-sibling::dd[1]");
      await value.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(
        (await value.innerText()).trim(),
        expectedValue,
        `${label} must match the exact native profile for the realistic text column.`
      );
    }
    assert.equal(
      await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      "The text Insights drawer must not clip content horizontally."
    );

    recordAcceptanceProgress("platform-smoke:filter");
    ({ drawer, toggle: insightsToggle } = await openSidePanel("Filters / Sorts"));
    let filterPanel = drawer.locator(".filterSortPanel").first();
    await filterPanel.waitFor({ state: "visible", timeout: 10_000 });
    await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "revenue" });
    await filterPanel.getByLabel("Predicate operator").selectOption("gte");
    await filterPanel.getByLabel("gte predicate value").fill("20000");
    await filterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.viewState.filterModel.filters.length === 1 &&
          active.metadata.filteredShape.rows !== null &&
          active.metadata.filteredShape.rows > 0 &&
          active.metadata.filteredShape.rows < PACKAGED_FIRST_USE_ROW_COUNT
        );
      },
      30_000,
      "the realistic numeric filter to update the visible dataframe"
    );
    app = await rediscoverApp("Filtered host state validation");
    columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    // Text profiling intentionally navigated to the far-right account_note
    // column. Return to revenue before inspecting its virtualized grid cell;
    // off-screen columns are correctly absent from the DOM.
    await columnSearch.fill("revenue");
    await app.getByRole("option", { name: "revenue, Number column", exact: true }).waitFor({
      state: "visible",
      timeout: 10_000
    });
    await columnSearch.press("Enter");
    await waitFor(
      () => testing.activeSession()?.viewState.selectedColumnId === revenue.id,
      10_000,
      "column search to return to the filtered numeric column"
    );
    app = await reacquireApp("Filtered revenue navigation");
    columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    ({ drawer, toggle: insightsToggle } = await openSidePanel("Filters / Sorts"));
    filterPanel = drawer.locator(".filterSortPanel").first();
    await filterPanel.waitFor({ state: "visible", timeout: 10_000 });
    const visibleRevenueCell = app.locator('td[data-grid-row="0"][data-grid-column="2"]').first();
    await waitForLocatorText(
      visibleRevenueCell,
      (text) => {
        const value = Number(text.replaceAll(",", ""));
        return Number.isFinite(value) && value >= 20_000;
      },
      10_000,
      "the first visible revenue to satisfy the chosen predicate"
    );
    const visibleRevenue = Number((await visibleRevenueCell.innerText()).replaceAll(",", ""));
    assert.ok(
      Number.isFinite(visibleRevenue) && visibleRevenue >= 20_000,
      `The first visible filtered revenue must satisfy the chosen predicate, received ${visibleRevenue}.`
    );
    await filterPanel.getByRole("button", { name: "Clear all", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.viewState.filterModel.filters.length === 0 &&
          active.viewState.filterModel.sort.length === 0 &&
          active.metadata.filteredShape.rows === PACKAGED_FIRST_USE_ROW_COUNT
        );
      },
      30_000,
      "Clear all to restore the complete dataframe view"
    );
    app = await rediscoverApp("Restored unfiltered view");
    ({ drawer, toggle: insightsToggle } = await openSidePanel("Filters / Sorts"));
    await drawer.getByRole("button", { name: "Close panel" }).click();
    await drawer.waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(
      await insightsToggle.evaluate((element) => element.ownerDocument.activeElement === element),
      true,
      "Closing Insights must restore focus to its toolbar toggle."
    );

    recordAcceptanceProgress("platform-smoke:fill-previous");
    app = await previewAndDiscardPreviousRevenue(app, workbench, testing, sessionId, revenue);

    recordAcceptanceProgress("platform-smoke:fill-grouped-median");
    app = await previewApplyAndUndoGroupedRevenue(app, workbench, testing, sessionId, revenue);

    recordAcceptanceProgress("platform-smoke:fill-most-common");
    await previewMostCommonAccountNote(app, testing);
    app = await rediscoverApp("Most-common fill validation");
    const fillDraft = testing.activeSession();
    assert.equal(fillDraft?.metadata.draftStep?.kind, "fillMissingValues");
    assert.deepEqual(fillDraft?.metadata.draftStep?.params.replacement, { kind: "mostFrequent" });
    assert.equal(fillDraft?.metadata.schema.find((column) => column.id === accountNote.id)?.nullable, false);
    assert.match(fillDraft?.code ?? "", /_ow_polars_most_frequent/u);
    const fillReview = app.getByRole("region", { name: "Draft review" });
    await fillReview.waitFor({ state: "visible", timeout: 10_000 });
    await fillReview.getByText("Fill missing values", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await fillReview.getByRole("button", { name: "Discard", exact: true }).click();
    await waitFor(
      () =>
        testing.activeSession()?.metadata.draftStep === undefined &&
        testing.activeSession()?.metadata.steps.length === 0 &&
        testing.activeSession()?.metadata.schema.find((column) => column.id === accountNote.id)?.nullable === true,
      30_000,
      "discarding the most-common fill preview"
    );
    await fillReview.waitFor({ state: "hidden", timeout: 10_000 });
    await waitFor(
      confirmedMutationRendererReady,
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the discarded most-common fill state to hydrate on its current renderer",
      confirmedMutationDiagnostics
    );
    app = await reacquireApp("Most-common fill discard");

    recordAcceptanceProgress("platform-smoke:draft-discard");
    await previewUppercaseMarket(app, testing, "market_upper");
    const draftCodePreview = await waitForCodePreview(workbench, "market_upper");
    const draftCodePreviewText = await draftCodePreview.innerText();
    assert.match(draftCodePreviewText, /import polars as pl/u);
    assert.match(draftCodePreviewText, /market_upper/u);
    const discardedDraft = testing.activeSession();
    assert.ok(discardedDraft, "The uppercase preview must retain the active dataframe session.");
    assert.equal(discardedDraft.metadata.draftStep?.kind, "upperText");
    const addedColumn = discardedDraft.metadata.schema.find((column) => column.name === "market_upper");
    assert.ok(addedColumn, "The draft grid must preview its added output column.");
    // `view.focus` resolves independently from the workbench's asynchronous
    // panel-title layout. VS Code can briefly report no title while Cursor
    // mirrors the same visible title in both the panel and view headers. The
    // rendered Code Preview webview above is the cross-editor source of truth.
    // Wait for the grid's own reveal publication before binding its current
    // receipt. A test-only synchronization here can replay the preceding host
    // viewport before the trailing view-state publication arrives.
    await waitFor(
      () =>
        confirmedMutationRendererReady() &&
        testing.activeSession()?.metadata.revision === discardedDraft.metadata.revision &&
        testing.panelSynchronizationReceipt(sessionId)?.layoutTransitionPending === false &&
        testing.activeSession()?.viewState.selectedColumnId === addedColumn.id,
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the generated draft column to publish its natural reveal on the current renderer",
      confirmedMutationDiagnostics
    );
    app = await reacquireApp("Post-Code Preview generated-column reveal");
    await app.locator('[data-testid="data-grid-scroller"] [role="grid"]').first().waitFor({
      state: "visible",
      timeout: 10_000
    });
    const draftReview = app.getByRole("region", { name: "Draft review" });
    await draftReview.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await draftReview.count(), 1, "A pending operation must expose exactly one compact draft review.");
    assert.equal(
      await app.getByRole("group", { name: "Cleaning plan" }).count(),
      0,
      "A pending operation must not duplicate its controls in the applied cleaning-plan group."
    );
    await draftReview.getByText("Uppercase", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const draftDiff = draftReview.locator('[aria-label="Data diff summary"]');
    await draftDiff.getByText("+1 column", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await draftDiff.getByText(/values added in this block$/u).waitFor({ state: "visible", timeout: 10_000 });
    const discardDraft = draftReview.getByRole("button", { name: "Discard", exact: true });
    const applyDraft = draftReview.getByRole("button", { name: "Apply step", exact: true });
    await discardDraft.waitFor({ state: "visible", timeout: 10_000 });
    await applyDraft.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await app.getByRole("button", { name: "Discard", exact: true }).count(), 1);
    assert.equal(await app.getByRole("button", { name: "Apply step", exact: true }).count(), 1);
    assert.equal(
      await draftDiff.getByText(/0 changed cells/u).count(),
      0,
      "An added-column preview must not misleadingly report zero changed cells."
    );
    assert.equal(
      await app.locator(".draftCode").count(),
      0,
      "Generated cleaning code must remain in the native Code Preview instead of being duplicated inline."
    );
    assert.equal(
      await app.getByLabel("Generated Python code preview").count(),
      0,
      "The compact draft review must not render a second generated-code surface."
    );
    const addedHeader = app.locator('th[data-column="market_upper"]').first();
    try {
      await addedHeader.waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      const revealDiagnostics = await app.evaluate((root: unknown) => {
        const queryRoot = root as {
          querySelector(selector: string): unknown;
          querySelectorAll(selector: string): Iterable<{ getAttribute(name: string): string | null }> & {
            length: number;
          };
        };
        const scroller = queryRoot.querySelector('[data-testid="data-grid-scroller"]') as {
          scrollLeft: number;
          scrollWidth: number;
          clientWidth: number;
        } | null;
        const search = queryRoot.querySelector('input[aria-label="Column"]') as { value: string } | null;
        const renderedHeaders = Array.from(queryRoot.querySelectorAll("th[data-column]"));
        return {
          selectedSearchValue: search?.value ?? null,
          renderedColumnCount: renderedHeaders.length,
          renderedLastColumn: renderedHeaders.at(-1)?.getAttribute("data-column") ?? null,
          scrollLeft: scroller?.scrollLeft ?? null,
          scrollWidth: scroller?.scrollWidth ?? null,
          clientWidth: scroller?.clientWidth ?? null
        };
      });
      throw new Error(`The generated column was not revealed: ${JSON.stringify(revealDiagnostics)}`, {
        cause: error
      });
    }
    const addedHeaderVisibility = await addedHeader.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const scroller = element.closest('[data-testid="data-grid-scroller"]');
      if (!scroller) return { visible: false };
      const viewport = scroller.getBoundingClientRect();
      return {
        visible: bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1,
        headerLeft: bounds.left,
        headerRight: bounds.right,
        viewportLeft: viewport.left,
        viewportRight: viewport.right,
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth
      };
    });
    assert.equal(
      addedHeaderVisibility.visible,
      true,
      `Previewing a new column must automatically reveal its complete grid header: ${JSON.stringify(
        addedHeaderVisibility
      )}`
    );
    await app
      .locator('td[data-grid-row="0"][data-grid-column="15"]')
      .filter({ hasText: "BENELUX" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await discardDraft.click();
    await waitFor(
      () =>
        testing.activeSession()?.metadata.draftStep === undefined &&
        testing.activeSession()?.metadata.steps.length === 0 &&
        testing.activeSession()?.metadata.schema.some((column) => column.name === "market") === true &&
        testing.activeSession()?.metadata.schema.some((column) => column.name === "market_upper") === false,
      30_000,
      "discarding the preview to restore the confirmed dataframe"
    );
    await draftReview.waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(
      await draftReview.count(),
      0,
      "Discarding the only draft must remove the compact draft-review region."
    );
    await waitFor(
      confirmedMutationRendererReady,
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the discarded uppercase state to hydrate on its current renderer",
      confirmedMutationDiagnostics
    );
    app = await reacquireApp("Uppercase draft discard");

    await exerciseMultiOutputSplitJourney(app, testing, sessionId, rediscoverApp);
    await waitFor(
      confirmedMutationRendererReady,
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the undone multi-output split state to hydrate on its current renderer",
      confirmedMutationDiagnostics
    );
    app = await reacquireApp("Multi-output split undo");

    await exercisePivotLongerJourney(app, testing, sessionId, ["revenue", "gross_margin"], rediscoverApp);
    await waitFor(
      confirmedMutationRendererReady,
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the undone Pivot longer state to hydrate on its current renderer",
      confirmedMutationDiagnostics
    );
    app = await reacquireApp("Pivot longer undo");

    await exercisePivotWiderJourney(
      app,
      testing,
      sessionId,
      "market",
      "revenue",
      PACKAGED_SCREENSHOT_MARKETS,
      rediscoverApp,
      reacquireApp
    );
    await waitFor(
      confirmedMutationRendererReady,
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the undone Pivot wider state to hydrate on its current renderer",
      confirmedMutationDiagnostics
    );
    app = await reacquireApp("Pivot wider undo");

    recordAcceptanceProgress("platform-smoke:draft-apply");
    await previewUppercaseMarket(app, testing, "market_upper");
    app = await rediscoverApp("Draft-apply validation");
    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        if (!active) return false;
        return (
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          active.metadata.schema.some((column) => column.name === "market") &&
          active.metadata.schema.some((column) => column.name === "market_upper")
        );
      },
      30_000,
      "applying the previewed uppercase step"
    );
    await waitFor(
      confirmedMutationRendererReady,
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the applied uppercase state to hydrate on its current renderer",
      confirmedMutationDiagnostics
    );
    app = await reacquireApp("Uppercase draft apply");
    const appliedPlan = app.getByRole("group", { name: "Cleaning plan" });
    await appliedPlan.getByText("1 applied step").waitFor({ state: "visible", timeout: 10_000 });
    assert.match(testing.activeSession()?.code ?? "", /import polars as pl/u);
    assert.match(testing.activeSession()?.code ?? "", /market_upper/u);

    recordAcceptanceProgress("platform-smoke:export");
    const exportDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-first-use-export-"));
    const exportPath = path.join(exportDirectory, "regional-orders-cleaned.csv");
    try {
      await exportCleanedDataThroughWorkbench(app, workbench, exportPath);
      await waitFor(() => existsSync(exportPath), 30_000, "the cleaned CSV export to appear");
      const exportedHeader = readFileSync(exportPath, "utf8").split(/\r?\n/u, 1)[0] ?? "";
      assert.match(exportedHeader, /(?:^|;)market(?:;|$)/u);
      assert.match(exportedHeader, /(?:^|;)market_upper(?:;|$)/u);
      assert.doesNotMatch(
        exportedHeader,
        /(?:^|,)market(?:,|$)/u,
        "The default export must offer and apply the confirmed semicolon import dialect."
      );
      assert.equal(
        readFileSync(exportPath, "utf8").split(/\r?\n/u).filter(Boolean).length,
        PACKAGED_FIRST_USE_ROW_COUNT + 1,
        "The exported CSV must contain every cleaned row plus its header."
      );
    } finally {
      cleanupAcceptanceTemporaryDirectory(exportDirectory);
    }
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "The first-use export journey must preserve its source bytes."
    );
    await clearReleasedJupyterScreenshotTransientUi(workbench);
  }

  return exercisePackagedFirstUseInteractionJourney;
}
