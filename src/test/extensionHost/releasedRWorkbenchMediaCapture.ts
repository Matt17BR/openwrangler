import * as assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Frame, Locator, Page } from "playwright-core";
import type { ColumnReference, SessionMetadata } from "../../shared/protocol";
import { exactSessionApp } from "./acknowledgedRenderer";
import { captureNotebookWorkbenchScreenshot } from "./evidenceSceneCapture";
import { packagedScreenshotFileName } from "./evidenceScenes";
import type { TestApi } from "./extensionHostTestApi";
import { PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT } from "./screenshotEvidence";

interface ReleasedRWorkbenchMediaCaptureDependencies {
  readonly alignPackagedSceneRowBoundary: (workbench: Page, app: Locator) => Promise<{ width: number; height: number }>;
  readonly applyReleasedRQuickSort: (
    workbench: Page,
    testing: TestApi,
    column: string,
    direction: "ascending" | "descending",
    expectedPriority: readonly string[]
  ) => Promise<void>;
  readonly arrangePackagedProductSidebar: (workbench: Page, scene: "filter-result") => Promise<Locator>;
  readonly assertMediaColumnTitlesUnclipped: (
    app: Locator,
    columnNames: readonly string[],
    scene: string
  ) => Promise<void>;
  readonly assertOnlyCompleteMediaColumnsVisible: (
    app: Locator,
    expectedNames: readonly string[],
    scene: string
  ) => Promise<void>;
  readonly assertReleasedProfileStat: (panel: Locator, label: string, expected: string) => Promise<void>;
  readonly clearReleasedJupyterScreenshotTransientUi: (workbench: Page) => Promise<void>;
  readonly closeVisibleWorkbenchPart: (
    workbench: Page,
    selector: string,
    commandCandidates: readonly string[]
  ) => Promise<void>;
  readonly columnReference: (metadata: SessionMetadata, name: string) => ColumnReference;
  readonly fitReleasedRMediaColumns: (
    testing: TestApi,
    app: Locator,
    sessionId: string,
    columnNames: readonly [string, string, string]
  ) => Promise<void>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedJupyterScreenshotTheme: () => string;
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
  readonly waitForOpenWranglerGridTarget: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string
  ) => Promise<Readonly<{ frame: Frame }>>;
}

export function createReleasedRWorkbenchMediaCapture({
  alignPackagedSceneRowBoundary,
  applyReleasedRQuickSort,
  arrangePackagedProductSidebar,
  assertMediaColumnTitlesUnclipped,
  assertOnlyCompleteMediaColumnsVisible,
  assertReleasedProfileStat,
  clearReleasedJupyterScreenshotTransientUi,
  closeVisibleWorkbenchPart,
  columnReference,
  fitReleasedRMediaColumns,
  recordAcceptanceProgress,
  releasedJupyterScreenshotTheme,
  releasedRSessionApp,
  waitFor,
  waitForOpenWranglerGridTarget
}: ReleasedRWorkbenchMediaCaptureDependencies) {
  async function captureReleasedRJupyterWorkbench(
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    outputDirectory: string
  ): Promise<void> {
    if (process.platform !== "linux") return;
    assert.equal(
      path.isAbsolute(outputDirectory),
      true,
      "R notebook screenshot output must be one absolute directory."
    );
    const previousViewport = await workbench.evaluate(() => {
      const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
      return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
    });
    const previousThemeKind = vscode.window.activeColorTheme.kind;
    const workbenchConfiguration = vscode.workspace.getConfiguration("workbench");
    const breadcrumbs = vscode.workspace.getConfiguration("breadcrumbs");
    const windowConfiguration = vscode.workspace.getConfiguration("window");
    const settings = [
      { configuration: windowConfiguration, key: "autoDetectColorScheme" },
      { configuration: windowConfiguration, key: "autoDetectHighContrast" },
      { configuration: windowConfiguration, key: "commandCenter" },
      { configuration: windowConfiguration, key: "title" },
      { configuration: workbenchConfiguration, key: "colorTheme" },
      { configuration: workbenchConfiguration, key: "statusBar.visible" },
      { configuration: breadcrumbs, key: "enabled" }
    ] as const;
    const previousSettings = settings.map(({ configuration, key }) => ({
      configuration,
      key,
      value: configuration.inspect(key)?.globalValue
    }));

    try {
      await workbench.setViewportSize(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT);
      assert.deepEqual(
        await workbench.evaluate(() => {
          const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
          return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
        }),
        PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
        "The R workbench scene requires the standard 1440 by 900 editor viewport."
      );
      await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
      await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
      await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
      await windowConfiguration.update(
        "title",
        "${activeEditorShort}${separator}Open Wrangler",
        vscode.ConfigurationTarget.Global
      );
      await workbenchConfiguration.update(
        "colorTheme",
        releasedJupyterScreenshotTheme(),
        vscode.ConfigurationTarget.Global
      );
      await workbenchConfiguration.update("statusBar.visible", false, vscode.ConfigurationTarget.Global);
      await breadcrumbs.update("enabled", false, vscode.ConfigurationTarget.Global);
      await waitFor(
        () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
        10_000,
        "the dark R notebook screenshot theme"
      );
      await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
        "workbench.action.closeAuxiliaryBar",
        "workbench.action.toggleAuxiliaryBar"
      ]);
      await closeVisibleWorkbenchPart(workbench, ".part.panel", [
        "workbench.action.closePanel",
        "workbench.action.togglePanel"
      ]);
      await clearReleasedJupyterScreenshotTransientUi(workbench);

      const active = testing.activeSession();
      assert.equal(active?.sessionId, sessionId, "The R screenshot must retain the exact live session.");
      assert.ok(active, "The R screenshot requires one active dataframe session.");
      assert.equal(active.metadata.backend, "r");
      assert.equal(active.metadata.mode, "viewing");
      assert.equal(active.metadata.source.kind, "notebookVariable");
      assert.equal(active.metadata.source.variableName, "regional_orders");
      assert.deepEqual(active.metadata.shape, { rows: 2_400, columns: 24 });
      assert.deepEqual(active.metadata.filterModel.filters, []);
      assert.deepEqual(active.metadata.filterModel.sort, []);
      assert.deepEqual(active.metadata.steps, []);
      assert.equal(active.metadata.draftStep, undefined);

      const readyTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
      const readyApp = await exactSessionApp(readyTarget.frame, sessionId);
      assert.ok(readyApp, "The R screenshot requires the exact live Open Wrangler renderer.");
      await waitFor(
        () => testing.panelSynchronizable(sessionId),
        10_000,
        "the R screenshot renderer to complete its host handshake"
      );
      const revenue = columnReference(active.metadata, "revenue");
      await applyReleasedRQuickSort(workbench, testing, "revenue", "descending", ["revenue"]);
      await applyReleasedRQuickSort(workbench, testing, "priority", "ascending", ["priority", "revenue"]);

      let target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
      let app = await exactSessionApp(target.frame, sessionId);
      assert.ok(app, "The synchronized R screenshot requires its exact renderer generation.");
      const profileToggle = app.getByRole("button", { name: "Column profiles and filters", exact: true });
      if ((await profileToggle.getAttribute("aria-expanded")) !== "true") await profileToggle.click();
      let drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
      await drawer.waitFor({ state: "visible", timeout: 10_000 });
      await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
      let filterPanel = drawer.locator(".filterSortPanel").first();
      await filterPanel.waitFor({ state: "visible", timeout: 10_000 });
      const advancedMode = filterPanel.getByRole("button", { name: "Use advanced filters", exact: true });
      if ((await advancedMode.count()) > 0 && (await advancedMode.isVisible())) await advancedMode.click();
      await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "revenue" });
      await filterPanel.getByLabel("Predicate operator", { exact: true }).selectOption("gte");
      await filterPanel.getByLabel("gte predicate value", { exact: true }).fill("20000");
      await filterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
      await waitFor(
        () => {
          const current = testing.activeSession();
          return (
            current?.sessionId === sessionId &&
            current.viewState.filterModel.filters.length === 1 &&
            current.viewState.filterModel.filters[0]?.column === "revenue"
          );
        },
        30_000,
        "the first R media filter"
      );
      app = await releasedRSessionApp(workbench, testing, sessionId, "the first R media filter");
      drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
      await drawer.waitFor({ state: "visible", timeout: 10_000 });
      await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
      filterPanel = drawer.locator(".filterSortPanel").first();
      await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "market" });
      await filterPanel.getByLabel("Predicate operator", { exact: true }).selectOption("equals");
      await filterPanel.getByLabel("equals predicate value", { exact: true }).fill("Nordics");
      await filterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
      await waitFor(
        () => {
          const current = testing.activeSession();
          return (
            current?.metadata.filteredShape.rows === 113 &&
            current.viewState.filterModel.filters.length === 2 &&
            current.viewState.filterModel.sort.map((rule) => rule.column).join(",") === "priority,revenue"
          );
        },
        30_000,
        "the R media filters and ordered sorts to publish one combined view"
      );
      app = await releasedRSessionApp(
        workbench,
        testing,
        sessionId,
        "the R media filter result before its profile is captured"
      );
      const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
      await columnSearch.fill("revenue");
      await app
        .getByRole("option", { name: /^revenue,/u })
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await columnSearch.press("Enter");
      await waitFor(
        () => testing.activeSession()?.viewState.selectedColumnId === revenue.id,
        10_000,
        "the R media scene to select its revenue column"
      );
      app = await releasedRSessionApp(workbench, testing, sessionId, "the R media revenue selection before profiling");
      drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
      const selectedProfileToggle = app.getByRole("button", { name: "Column profiles and filters", exact: true });
      if ((await selectedProfileToggle.getAttribute("aria-expanded")) !== "true") await selectedProfileToggle.click();
      await drawer.waitFor({ state: "visible", timeout: 10_000 });
      await drawer.getByRole("tab", { name: "Column", exact: true }).click();
      const profile = drawer.getByRole("tabpanel");
      await profile
        .getByRole("heading", { name: "revenue", exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      await assertReleasedProfileStat(profile, "Rows", "113");
      await assertReleasedProfileStat(profile, "Distinct", "113");
      await assertReleasedProfileStat(profile, "Min", "20,000");
      await assertReleasedProfileStat(profile, "Max", "24,480");

      const sidebar = await arrangePackagedProductSidebar(workbench, "filter-result");
      const filtersTree = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
      for (const item of [
        /^revenue, 1 condition/u,
        /^market, 1 condition/u,
        /^priority, Priority 1 · Ascending · nulls last/u,
        /^revenue, Priority 2 · Descending · nulls last/u
      ]) {
        await filtersTree.getByRole("treeitem", { name: item }).first().waitFor({ state: "visible", timeout: 10_000 });
      }
      target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
      app = await exactSessionApp(target.frame, sessionId);
      assert.ok(app, "The arranged R screenshot must retain its exact renderer.");
      assert.equal((await app.locator('[data-session-badge="backend"]').innerText()).trim(), "R");
      assert.equal((await app.locator('[data-session-badge="mode"]').innerText()).trim(), "VIEWING");
      assert.equal(await app.getByRole("button", { name: "Add step", exact: true }).count(), 0);
      assert.equal(await app.getByRole("button", { name: "Export", exact: true }).count(), 0);
      await app
        .getByRole("status", { name: "Visible rows", exact: true })
        .filter({ hasText: "Rows 1–113 of 113" })
        .waitFor({ state: "visible", timeout: 10_000 });
      await app
        .getByRole("rowheader", { name: "Row 1, label OW-2402390", exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      await fitReleasedRMediaColumns(testing, app, sessionId, ["order_id", "market", "revenue"]);
      target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
      app = await exactSessionApp(target.frame, sessionId);
      assert.ok(app, "The fitted R screenshot must retain its exact renderer.");
      await assertMediaColumnTitlesUnclipped(app, ["order_id", "market", "revenue"], "The R notebook media scene");
      await assertOnlyCompleteMediaColumnsVisible(app, ["order_id", "market", "revenue"], "The R notebook media scene");
      const alignedViewport = await alignPackagedSceneRowBoundary(workbench, app);
      target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
      app = await exactSessionApp(target.frame, sessionId);
      assert.ok(app, "The row-aligned R screenshot must retain its exact renderer.");
      await assertOnlyCompleteMediaColumnsVisible(app, ["order_id", "market", "revenue"], "The R notebook media scene");

      const commands = new Set(await vscode.commands.getCommands(true));
      if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
      if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
      await workbench.mouse.move(Math.floor(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT.width * 0.75), 40);
      await workbench.waitForTimeout(500);
      const transient = await workbench
        .locator(
          ".quick-input-widget:visible, .monaco-dialog-box:visible, .context-view.monaco-menu-container:visible, " +
            ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible, " +
            ".monaco-hover:visible"
        )
        .allInnerTexts();
      assert.deepEqual(
        transient.map((text) => text.replace(/\s+/gu, " ").trim().slice(0, 500)),
        [],
        "R screenshot capture must not retain transient workbench UI."
      );

      mkdirSync(outputDirectory, { recursive: true });
      recordAcceptanceProgress("jupyter-r:screenshot:workbench");
      await captureNotebookWorkbenchScreenshot(
        workbench,
        path.resolve(
          outputDirectory,
          packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-r", "dark")
        ),
        alignedViewport
      );
    } finally {
      for (const { configuration, key, value } of previousSettings.reverse()) {
        await configuration.update(key, value, vscode.ConfigurationTarget.Global);
      }
      await workbench.setViewportSize(previousViewport);
      await waitFor(
        () => vscode.window.activeColorTheme.kind === previousThemeKind,
        10_000,
        "the R notebook workbench to restore its prior color theme"
      );
      await workbench.waitForTimeout(500);
    }
  }

  return captureReleasedRJupyterWorkbench;
}
