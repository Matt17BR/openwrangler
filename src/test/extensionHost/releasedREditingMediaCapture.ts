import * as assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { ColumnReference, SessionMetadata } from "../../shared/protocol";
import { ensureCodePreviewHeight, revealCodePreviewOperationLine, waitForCodePreview } from "./codePreview";
import { captureNotebookWorkbenchScreenshot } from "./evidenceSceneCapture";
import { packagedScreenshotFileName } from "./evidenceScenes";
import type { TestApi } from "./extensionHostTestApi";
import { PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT } from "./screenshotEvidence";

interface ReleasedREditingMediaCaptureDependencies {
  readonly SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: number;
  readonly arrangePackagedProductSidebar: (workbench: Page, scene: "workflow") => Promise<Locator>;
  readonly assertMediaColumnTitlesUnclipped: (
    app: Locator,
    columnNames: readonly string[],
    scene: string
  ) => Promise<void>;
  readonly clearReleasedJupyterScreenshotTransientUi: (workbench: Page) => Promise<void>;
  readonly closeVisibleWorkbenchPart: (
    workbench: Page,
    selector: string,
    commandCandidates: readonly string[]
  ) => Promise<void>;
  readonly columnReference: (metadata: SessionMetadata, name: string) => ColumnReference;
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<Readonly<{ app: Locator; dialog: Locator }>>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedJupyterScreenshotTheme: () => string;
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
}

export function createReleasedREditingMediaCapture({
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  arrangePackagedProductSidebar,
  assertMediaColumnTitlesUnclipped,
  clearReleasedJupyterScreenshotTransientUi,
  closeVisibleWorkbenchPart,
  columnReference,
  openReleasedROperationPicker,
  recordAcceptanceProgress,
  releasedJupyterScreenshotTheme,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor
}: ReleasedREditingMediaCaptureDependencies) {
  async function captureReleasedRNotebookGroupByDraft(
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    outputDirectory: string
  ): Promise<void> {
    if (process.platform !== "linux") return;
    assert.equal(path.isAbsolute(outputDirectory), true, "R editing screenshot output must be one absolute directory.");
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
        "the dark R editing screenshot theme"
      );
      await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
        "workbench.action.closeAuxiliaryBar",
        "workbench.action.toggleAuxiliaryBar"
      ]);
      await closeVisibleWorkbenchPart(workbench, ".part.panel", [
        "workbench.action.closePanel",
        "workbench.action.togglePanel"
      ]);

      let app = await releasedRSessionApp(workbench, testing, sessionId, "the R media session before editing");
      const viewing = testing.activeSession();
      assert.equal(viewing?.sessionId, sessionId, "The R editing screenshot must retain its exact live session.");
      assert.ok(viewing, "The R editing screenshot requires one active session.");
      assert.equal(viewing.metadata.backend, "r");
      assert.equal(viewing.metadata.rDataframeFlavor, "r.data.frame");
      assert.equal(viewing.metadata.mode, "viewing");
      assert.equal(viewing.metadata.source.kind, "notebookVariable");
      assert.equal(viewing.metadata.source.variableName, "regional_orders");

      await app.getByRole("button", { name: "Switch to Editing", exact: true }).click();
      await waitFor(
        () => testing.activeSession()?.sessionId === sessionId && testing.activeSession()?.metadata.mode === "editing",
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "switching the representative R notebook dataframe to Editing mode"
      );
      await requireFreshExactSessionPanelHydration(
        testing,
        sessionId,
        "The representative R editing renderer must acknowledge the reopened live session."
      );

      app = await releasedRSessionApp(workbench, testing, sessionId, "the representative R editing session");
      const profileToggle = app.getByRole("button", { name: "Column profiles and filters", exact: true });
      if ((await profileToggle.getAttribute("aria-expanded")) !== "true") await profileToggle.click();
      const drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
      await drawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
      await drawer.getByRole("button", { name: "Clear all", exact: true }).click();
      await waitFor(
        () => {
          const current = testing.activeSession();
          return current?.viewState.filterModel.filters.length === 0 && current.viewState.filterModel.sort.length === 0;
        },
        30_000,
        "clearing the representative R view before Group and aggregate"
      );
      app = await releasedRSessionApp(workbench, testing, sessionId, "the cleared representative R view");
      const clearedDrawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
      await clearedDrawer.getByRole("button", { name: "Close panel", exact: true }).click();
      await clearedDrawer.waitFor({ state: "hidden", timeout: 10_000 });

      const groupPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
      app = groupPicker.app;
      const dialog = groupPicker.dialog;
      await dialog.getByPlaceholder("Search operations").fill("group");
      await dialog.getByRole("button", { name: /^Group and aggregate\b/u }).click();
      const groupKeys = dialog.getByRole("group", { name: "Group keys", exact: true });
      await groupKeys.getByRole("checkbox", { name: "market", exact: true }).check();
      await groupKeys.getByRole("checkbox", { name: "channel", exact: true }).check();
      const editing = testing.activeSession();
      assert.ok(editing, "The representative R Group By form requires one active session.");
      const revenue = columnReference(editing.metadata, "revenue");
      await dialog.getByLabel("Value 1", { exact: true }).selectOption(revenue.id);
      await dialog.getByLabel("Calculation 1", { exact: true }).selectOption("sum");
      await dialog.getByLabel("Output name", { exact: true }).fill("total_revenue");
      await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
      await waitFor(
        () => {
          const current = testing.activeSession();
          return (
            current?.sessionId === sessionId &&
            current.metadata.draftStep?.kind === "groupBy" &&
            current.metadata.schema.map((column) => column.name).join(",") === "market,channel,total_revenue"
          );
        },
        30_000,
        "previewing the representative R Group and aggregate draft"
      );
      await requireFreshExactSessionPanelHydration(
        testing,
        sessionId,
        "The representative R Group By draft must reach its exact renderer."
      );
      const active = testing.activeSession();
      assert.ok(active?.metadata.draftStep?.kind === "groupBy");
      assert.deepEqual(active.metadata.shape, { rows: 12, columns: 3 });
      assert.deepEqual(
        active.metadata.draftStep.params.keys.map((column) => column.name),
        ["market", "channel"]
      );
      assert.deepEqual(active.metadata.draftStep.params.aggregations, [
        { column: revenue, operation: "sum", alias: "total_revenue" }
      ]);
      assert.equal(await testing.synchronizePanel(sessionId), true);

      const firstColumns = active.metadata.schema;
      const firstColumn = firstColumns[0];
      assert.ok(firstColumn, "The R editing screenshot requires at least one visible column.");
      await testing.updateViewState(sessionId, {
        ...active.viewState,
        columnWidths: {
          ...active.viewState.columnWidths,
          ...Object.fromEntries(firstColumns.map((column) => [column.id, column.name === "total_revenue" ? 240 : 190]))
        },
        selectedColumnId: firstColumn.id,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      });
      assert.equal(await testing.synchronizePanel(sessionId), true);

      await vscode.commands.executeCommand("openWrangler.codePreview.focus");
      const codePreview = await waitForCodePreview(workbench, ".ow_generated_result <- base::evalq", "R");
      const generatedCode = active.code ?? "";
      assert.match(generatedCode, /\.ow_group_by\b/u);
      assert.match(generatedCode, /total_revenue/u);
      assert.doesNotMatch(generatedCode, /\b(?:pandas|polars|python)\b/iu);
      const sidebar = await arrangePackagedProductSidebar(workbench, "workflow");
      await sidebar
        .getByRole("tree", { name: /Cleaning Steps/u })
        .getByRole("treeitem", { name: /^Draft · Group and aggregate/u })
        .waitFor({ state: "visible", timeout: 10_000 });
      const exactCodePreview = await ensureCodePreviewHeight(workbench, codePreview, 180);
      await revealCodePreviewOperationLine(exactCodePreview, ".ow_result <- .ow_group_by", "total_revenue");

      app = await releasedRSessionApp(workbench, testing, sessionId, "the R editing screenshot");
      assert.equal((await app.locator('[data-session-badge="backend"]').innerText()).trim(), "R");
      assert.equal((await app.locator('[data-session-badge="mode"]').innerText()).trim(), "EDITING");
      const review = app.getByRole("region", { name: "Draft review" });
      await review.waitFor({ state: "visible", timeout: 10_000 });
      await review.getByText("Group and aggregate", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      await app.locator('th[data-column="total_revenue"]').waitFor({ state: "visible", timeout: 10_000 });
      await app.getByRole("button", { name: "Apply step", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      await app.getByRole("button", { name: "Discard", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      await assertMediaColumnTitlesUnclipped(
        app,
        firstColumns.map((column) => column.name),
        "The R editing notebook scene"
      );
      await clearReleasedJupyterScreenshotTransientUi(workbench);
      assert.equal(testing.activeSession()?.metadata.draftStep?.kind, "groupBy");

      mkdirSync(outputDirectory, { recursive: true });
      recordAcceptanceProgress("jupyter-r:screenshot:editing");
      await captureNotebookWorkbenchScreenshot(
        workbench,
        path.resolve(
          outputDirectory,
          packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-r-editing", "dark")
        )
      );
      await review.getByRole("button", { name: "Discard", exact: true }).click();
      await waitFor(
        () =>
          testing.activeSession()?.sessionId === sessionId && testing.activeSession()?.metadata.draftStep === undefined,
        30_000,
        "discarding the representative R Group By draft after capture"
      );
    } finally {
      await closeVisibleWorkbenchPart(workbench, ".part.panel", [
        "workbench.action.closePanel",
        "workbench.action.togglePanel"
      ]);
      for (const { configuration, key, value } of previousSettings.reverse()) {
        await configuration.update(key, value, vscode.ConfigurationTarget.Global);
      }
      await workbench.setViewportSize(previousViewport);
      await waitFor(
        () => vscode.window.activeColorTheme.kind === previousThemeKind,
        10_000,
        "the R editing workbench to restore its prior color theme"
      );
      await workbench.waitForTimeout(500);
    }
  }

  return captureReleasedRNotebookGroupByDraft;
}
