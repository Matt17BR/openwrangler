import * as assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Frame, Locator, Page } from "playwright-core";
import { assertExactBytes } from "./acceptanceSourceFixture";
import { openAcknowledgedInsightsPanel } from "./acknowledgedInsightsPanel";
import { captureWorkbenchScreenshot } from "./evidenceSceneCapture";
import type { TestApi } from "./extensionHostTestApi";
import { withAcceptanceOperationDeadline } from "./playwrightLifecycle";
import {
  PACKAGED_FIRST_USE_ROW_COUNT,
  PACKAGED_PRODUCT_VIEWPORT,
  PACKAGED_SCREENSHOT_COLUMNS
} from "./screenshotEvidence";

interface WorkbenchContextMenu {
  readonly menu: Locator;
  readonly action?: Locator;
}

export interface PackagedFileLaunchSurfacesDependencies {
  readonly activateReleasedRInteractiveTitleAction: (
    workbench: Page,
    sourceDocument: vscode.TextDocument,
    dispatch?: boolean
  ) => Promise<void>;
  readonly activeEditorTabDiagnostic: () => Record<string, boolean | string>;
  readonly assertOpenWranglerTabBrandIcon: (tab: Locator) => Promise<void>;
  readonly closeVisibleWorkbenchPart: (
    workbench: Page,
    selector: string,
    commandCandidates: readonly string[]
  ) => Promise<void>;
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly exercisePrimarySortJourney: (
    testing: TestApi,
    workbench: Page,
    frame: Frame,
    sessionId: string,
    checkpoint: string
  ) => Promise<void>;
  readonly isOpenWranglerSessionTab: (tab: vscode.Tab) => boolean;
  readonly openEditorTabContextMenu: (
    page: Page,
    tab: Locator,
    requiredActionName?: string
  ) => Promise<WorkbenchContextMenu>;
  readonly openWorkbenchContextMenu: (
    page: Page,
    target: Locator,
    requiredActionName: string | undefined,
    surface: string
  ) => Promise<WorkbenchContextMenu>;
  readonly reacquireAcknowledgedSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<Locator>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForAutomaticDelimitedImport: (
    page: Page,
    testing: TestApi,
    expectedSource: vscode.Uri,
    checkpointPrefix: string
  ) => Promise<void>;
  readonly waitForLocatorCount: (
    locator: Locator,
    expectedCount: number,
    timeoutMs: number,
    expectation: string
  ) => Promise<void>;
  readonly waitForOpenWranglerGridTarget: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string
  ) => Promise<{ readonly frame: Frame }>;
  readonly waitForThirdPartyCustomEditorWorkbench: (
    page: Page,
    activeEditorGroup: Locator,
    fixture: vscode.Uri
  ) => Promise<Locator>;
  readonly fileActionMediaHeight: number;
  readonly sessionOpenAcceptanceTimeoutMs: number;
  readonly webviewDiscoveryTimeoutMs: number;
  readonly workbenchOperationTimeoutMs: number;
  readonly workbenchPlaywrightTimeoutMs: number;
}

export function createPackagedFileLaunchSurfaces(
  dependencies: PackagedFileLaunchSurfacesDependencies
): (testing: TestApi, fixture: vscode.Uri, outputDirectory?: string) => Promise<void> {
  const {
    activateReleasedRInteractiveTitleAction,
    activeEditorTabDiagnostic,
    assertOpenWranglerTabBrandIcon,
    closeVisibleWorkbenchPart,
    connectToEditorWorkbench,
    exercisePrimarySortJourney,
    isOpenWranglerSessionTab,
    openEditorTabContextMenu,
    openWorkbenchContextMenu,
    reacquireAcknowledgedSessionApp,
    recordAcceptanceProgress,
    waitFor,
    waitForAutomaticDelimitedImport,
    waitForLocatorCount,
    waitForOpenWranglerGridTarget,
    waitForThirdPartyCustomEditorWorkbench,
    fileActionMediaHeight,
    sessionOpenAcceptanceTimeoutMs,
    webviewDiscoveryTimeoutMs,
    workbenchOperationTimeoutMs,
    workbenchPlaywrightTimeoutMs
  } = dependencies;
  const PACKAGED_FILE_ACTION_MEDIA_HEIGHT = fileActionMediaHeight;
  const SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS = sessionOpenAcceptanceTimeoutMs;
  const OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS = webviewDiscoveryTimeoutMs;
  const WORKBENCH_OPERATION_TIMEOUT_MS = workbenchOperationTimeoutMs;
  const WORKBENCH_PLAYWRIGHT_TIMEOUT_MS = workbenchPlaywrightTimeoutMs;

  async function exercisePackagedFileLaunchSurfaces(
    testing: TestApi,
    fixture: vscode.Uri,
    outputDirectory?: string
  ): Promise<void> {
    recordAcceptanceProgress("verify:file-launch:setup");
    const sourceBytes = readFileSync(fixture.fsPath);
    const page = await connectToEditorWorkbench();
    const editor = process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor";
    const activeEditorGroup = page.locator(".part.editor .editor-group-container.active");
    const titleAction = activeEditorGroup.locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible');

    if (outputDirectory) {
      await page.setViewportSize(PACKAGED_PRODUCT_VIEWPORT);
      assert.deepEqual(
        await page.evaluate(() => {
          const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
          return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
        }),
        PACKAGED_PRODUCT_VIEWPORT,
        "File-action public media requires the dedicated 1440 by 900 logical editor viewport."
      );
    }

    if (editor === "cursor") {
      const pinnedTitleActions = vscode.workspace
        .getConfiguration("cursor.general")
        .inspect<string[]>("pinnedTitleActions");
      assert.ok(pinnedTitleActions, "Cursor must register its pinned-title-action setting.");
      assert.ok(
        pinnedTitleActions.defaultValue?.includes("openWrangler.openFile"),
        "The packaged Cursor default must pin the canonical file action."
      );
      assert.equal(
        pinnedTitleActions.globalValue,
        undefined,
        "Cursor acceptance must not persist a user-level title-action setting."
      );
      assert.equal(
        pinnedTitleActions.workspaceValue,
        undefined,
        "Cursor acceptance must not persist a workspace title-action setting."
      );
    }

    const availableCommands = new Set(await vscode.commands.getCommands(true));
    const auxiliaryBar = page.locator(".part.auxiliarybar");
    if ((await auxiliaryBar.count()) > 0 && (await auxiliaryBar.isVisible())) {
      const closeAuxiliaryBar = availableCommands.has("workbench.action.closeAuxiliaryBar")
        ? "workbench.action.closeAuxiliaryBar"
        : availableCommands.has("workbench.action.toggleAuxiliaryBar")
          ? "workbench.action.toggleAuxiliaryBar"
          : undefined;
      if (closeAuxiliaryBar) await vscode.commands.executeCommand(closeAuxiliaryBar);
    }
    if (availableCommands.has("notifications.clearAll")) {
      await vscode.commands.executeCommand("notifications.clearAll");
    }
    if (availableCommands.has("notifications.hideList")) {
      await vscode.commands.executeCommand("notifications.hideList");
    }

    const rTitleSources = [
      ["title-action.R", "orders <- data.frame(order_id = 1L)\n"],
      ["title-action.Rmd", "```{r}\norders <- data.frame(order_id = 1L)\n```\n"],
      ["title-action.qmd", "```{r}\norders <- data.frame(order_id = 1L)\n```\n"]
    ] as const;
    const rTitleUris = rTitleSources.map(([name]) => vscode.Uri.file(path.join(path.dirname(fixture.fsPath), name)));
    try {
      for (const [[, contents], source] of rTitleSources.map((entry, index) => [entry, rTitleUris[index]] as const)) {
        writeFileSync(source.fsPath, contents, { encoding: "utf8", flag: "wx" });
        recordAcceptanceProgress(`verify:r-title-action:${path.extname(source.fsPath).slice(1).toLowerCase()}`);
        await vscode.commands.executeCommand("vscode.open", source, {
          preview: false,
          viewColumn: vscode.ViewColumn.One
        });
        await waitFor(
          () => vscode.window.activeTextEditor?.document.uri.toString() === source.toString(),
          10_000,
          `the ${path.extname(source.fsPath)} source to become active before checking its title action`
        );
        const sourceDocument = vscode.window.activeTextEditor?.document;
        assert.ok(sourceDocument, `The ${path.extname(source.fsPath)} source must remain open for its title action.`);
        await page.bringToFront();
        await activateReleasedRInteractiveTitleAction(page, sourceDocument, false);
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      }
    } finally {
      for (const source of rTitleUris) rmSync(source.fsPath, { force: true });
    }

    recordAcceptanceProgress("verify:file-launch:explorer-context:source");
    await vscode.commands.executeCommand("vscode.open", fixture, {
      preview: false,
      viewColumn: vscode.ViewColumn.One
    });
    await waitFor(
      () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
      },
      10_000,
      "the exact source text editor before revealing its Explorer row"
    );
    assert.ok(
      availableCommands.has("workbench.files.action.showActiveFileInExplorer"),
      "The installed editor must expose its native active-file Explorer reveal command."
    );
    await vscode.commands.executeCommand("workbench.files.action.showActiveFileInExplorer");
    await page.bringToFront();
    const explorer = page.locator(".part.sidebar .explorer-folders-view:visible").first();
    await explorer.waitFor({ state: "visible", timeout: 10_000 });
    const explorerRows = explorer
      .locator('.monaco-list-row[role="treeitem"]:visible')
      .filter({ hasText: path.basename(fixture.fsPath) });
    await waitForLocatorCount(explorerRows, 1, 10_000, "one exact deterministic fixture row in Explorer");
    const explorerRow = explorerRows.first();
    assert.equal(
      (await explorerRow.innerText()).replace(/\s+/gu, " ").trim(),
      path.basename(fixture.fsPath),
      "The Explorer context journey must target the exact copied fixture row."
    );
    recordAcceptanceProgress("verify:file-launch:explorer-context:menu");
    const { menu: explorerContextMenu, action: explorerMenuAction } = await openWorkbenchContextMenu(
      page,
      explorerRow,
      "Open in Open Wrangler",
      "Explorer row"
    );
    assert.ok(explorerMenuAction, "The Explorer row must expose Open in Open Wrangler.");
    assert.equal(
      await explorerContextMenu.getByRole("menuitem", { name: "Open in Open Wrangler", exact: true }).count(),
      1,
      "The Explorer context menu must expose exactly one canonical Open in Open Wrangler action."
    );
    assert.equal((await explorerMenuAction.innerText()).trim(), "Open in Open Wrangler");
    recordAcceptanceProgress("verify:file-launch:explorer-context:open");
    await explorerMenuAction.click();
    await waitForAutomaticDelimitedImport(page, testing, fixture, "verify:file-launch:explorer-context:import");
    await waitFor(
      () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the physical Explorer context action to open its exact copied fixture"
    );
    const explorerSession = testing.activeSession();
    assert.ok(explorerSession);
    assert.deepEqual(explorerSession.metadata.shape, {
      rows: PACKAGED_FIRST_USE_ROW_COUNT,
      columns: PACKAGED_SCREENSHOT_COLUMNS.length
    });
    assert.deepEqual(explorerSession.metadata.source.importOptions, {
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    await waitFor(
      () => testing.panelHydrated(explorerSession.sessionId),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the Explorer-launched dataframe renderer to acknowledge its exact session"
    );
    assert.equal(await testing.synchronizePanel(explorerSession.sessionId), true);
    const explorerGridTarget = await waitForOpenWranglerGridTarget(page, testing, explorerSession.sessionId);
    const explorerGrid = explorerGridTarget.frame.getByRole("grid", {
      name: `Data grid for ${explorerSession.metadata.source.label}`
    });
    await explorerGrid.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await explorerGrid.getAttribute("aria-colcount"), String(PACKAGED_SCREENSHOT_COLUMNS.length + 1));
    assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "The Explorer action must not modify its source.");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the Explorer context launch session to dispose"
    );
    assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "Explorer launch cleanup must preserve source bytes.");

    recordAcceptanceProgress("verify:file-launch:title-action:source");
    await vscode.commands.executeCommand("vscode.open", fixture, {
      preview: false,
      viewColumn: vscode.ViewColumn.One
    });
    await waitFor(
      () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
      },
      10_000,
      "the source text editor before file-launch interaction"
    );
    await page.bringToFront();
    try {
      await titleAction.first().waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      const visibleEditorLabels = await page
        .locator(".part.editor .editor-group-container.active [aria-label]:visible")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
      const moreActions = activeEditorGroup.locator('[aria-label="More Actions..."]:visible').first();
      let overflowItems: string[] = [];
      if ((await moreActions.count()) > 0) {
        await moreActions.click();
        overflowItems = await page
          .locator('.context-view.monaco-menu-container [role="menuitem"]:visible')
          .allInnerTexts();
        await page.keyboard.press("Escape");
      }
      throw new Error(
        `Open Wrangler editor-title action was not visible. Visible editor labels: ${JSON.stringify(visibleEditorLabels)}. Editor overflow items: ${JSON.stringify(overflowItems)}`,
        { cause: error }
      );
    }
    if (outputDirectory) {
      recordAcceptanceProgress("verify:file-launch:title-action:screenshot");
      mkdirSync(outputDirectory, { recursive: true });
      await titleAction.first().hover();
      await page
        .locator(".monaco-hover:visible")
        .filter({ hasText: "Open in Open Wrangler" })
        .waitFor({ state: "visible", timeout: 2_000 })
        .catch(() => {});
      await captureWorkbenchScreenshot(
        page,
        path.resolve(outputDirectory, `${editor}-file-title-action.png`),
        PACKAGED_FILE_ACTION_MEDIA_HEIGHT
      );
      await page.keyboard.press("Escape");
    }

    recordAcceptanceProgress("verify:file-launch:title-action:open");
    await titleAction.first().click();
    await waitForAutomaticDelimitedImport(page, testing, fixture, "verify:file-launch:title-action:import");
    await waitFor(
      () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the editor-title action to open the selected source"
    );
    const active = testing.activeSession();
    assert.ok(active, "The editor-title action must publish its dataframe session.");
    assert.deepEqual(
      active.metadata.shape,
      { rows: PACKAGED_FIRST_USE_ROW_COUNT, columns: PACKAGED_SCREENSHOT_COLUMNS.length },
      "The file-launch journey must exercise the complete realistic first-use dataframe."
    );
    assert.deepEqual(
      active.metadata.schema.map((column) => column.name),
      [...PACKAGED_SCREENSHOT_COLUMNS],
      "The file-launch journey must retain every realistic first-use column before interaction."
    );
    await waitFor(
      () => testing.panelHydrated(active.metadata.sessionId),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the exact editor-title panel to finish opening and acknowledge its current renderer snapshot",
      () =>
        JSON.stringify({
          sessionId: active.metadata.sessionId,
          coordinator: testing.diagnostics(),
          activeTab: activeEditorTabDiagnostic()
        })
    );
    assert.equal(
      await withAcceptanceOperationDeadline(
        testing.synchronizePanel(active.metadata.sessionId),
        OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
        "the exact editor-title Open Wrangler panel synchronization"
      ),
      true,
      "The editor-title session must own a synchronized Open Wrangler grid panel."
    );
    await waitFor(
      () => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        return Boolean(
          tab && isOpenWranglerSessionTab(tab) && tab.label === `Open Wrangler: ${active.metadata.source.label}`
        );
      },
      10_000,
      "the editor-title Open Wrangler session tab to remain active",
      () => JSON.stringify(activeEditorTabDiagnostic())
    );
    await waitForOpenWranglerGridTarget(page, testing, active.metadata.sessionId);
    recordAcceptanceProgress("verify:file-launch:title-action:histogram-modes");
    const acknowledgedApp = await reacquireAcknowledgedSessionApp(
      page,
      testing,
      active.metadata.sessionId,
      "The editor-title insights action requires the current acknowledged renderer."
    );
    const { panel: insights } = await openAcknowledgedInsightsPanel(acknowledgedApp, () =>
      reacquireAcknowledgedSessionApp(
        page,
        testing,
        active.metadata.sessionId,
        "The opened editor-title insights panel requires the current acknowledged renderer."
      )
    );
    const histogramControl = insights.locator(".numericHistogramHitTarget");
    const histogramStatus = insights.locator(".summaryDistributionChart .miniChartCaption");
    await histogramControl.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await histogramControl.count(), 1, "The full packaged journey must expose one histogram control.");
    await histogramControl.focus();
    await histogramControl.press("Home");
    const countLabel = await histogramControl.getAttribute("aria-label");
    const countStatus = (await histogramStatus.innerText()).trim();
    assert.match(countStatus, /: [\d,.]+ rows?$/u);
    assert.match(countLabel ?? "", /: [\d,.]+ rows? \([\d.,]+%\);/u);
    assert.ok(countLabel?.startsWith(`${countStatus} (`));
    assert.equal(await histogramStatus.getAttribute("title"), countLabel);
    assert.equal(await histogramStatus.getAttribute("role"), null);
    assert.equal(await histogramStatus.getAttribute("aria-live"), null);

    const counts = insights.getByRole("button", { name: "Counts", exact: true });
    const percent = insights.getByRole("button", { name: "%", exact: true });
    assert.equal(await counts.getAttribute("aria-pressed"), "true");
    assert.equal(await percent.getAttribute("aria-pressed"), "false");
    await percent.click();
    assert.equal(await counts.getAttribute("aria-pressed"), "false");
    assert.equal(await percent.getAttribute("aria-pressed"), "true");
    await histogramControl.focus();
    await histogramControl.press("Home");
    const percentLabel = await histogramControl.getAttribute("aria-label");
    const percentStatus = (await histogramStatus.innerText()).trim();
    assert.match(percentStatus, /: [\d.,]+%$/u);
    assert.doesNotMatch(percentStatus, /rows?/u);
    assert.match(percentLabel ?? "", /: [\d.,]+% \([\d,.]+ rows?\);/u);
    assert.ok(percentLabel?.startsWith(`${percentStatus} (`));
    assert.equal(await histogramStatus.getAttribute("title"), percentLabel);
    await counts.click();
    assert.equal(await counts.getAttribute("aria-pressed"), "true");
    await insights.getByRole("button", { name: "Close panel" }).click();
    await insights.waitFor({ state: "hidden", timeout: 10_000 });
    const currentGridTarget = await waitForOpenWranglerGridTarget(page, testing, active.metadata.sessionId);
    await exercisePrimarySortJourney(
      testing,
      page,
      currentGridTarget.frame,
      active.metadata.sessionId,
      "verify:file-launch:title-action:sort-journey"
    );
    assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "The editor-title action must not modify its source.");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the editor-title launch session to dispose"
    );

    recordAcceptanceProgress("verify:file-launch:tab-context:menu");
    const sourceTab = page
      .locator(".part.editor .tabs-container .tab")
      .filter({ hasText: path.basename(fixture.fsPath) })
      .last();
    const activeSourceTab = page
      .locator(".part.editor .editor-group-container.active .tabs-container .tab.active")
      .filter({ hasText: path.basename(fixture.fsPath) })
      .last();
    await sourceTab.waitFor({ state: "visible", timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.bringToFront();
    await sourceTab.click();
    await activeSourceTab.waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(
      () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
      },
      10_000,
      "the source tab to become active before opening its context menu"
    );
    await closeVisibleWorkbenchPart(page, ".part.sidebar", [
      "workbench.action.closeSidebar",
      "workbench.action.toggleSidebarVisibility"
    ]);
    const { menu: tabContextMenu, action: tabMenuAction } = await openEditorTabContextMenu(
      page,
      activeSourceTab,
      "Open in Open Wrangler"
    );
    assert.ok(tabMenuAction, "The source-tab context menu must expose Open in Open Wrangler.");
    assert.equal(
      (await tabMenuAction.innerText()).trim(),
      "Open in Open Wrangler",
      "The editor-tab context action must use the compact product label."
    );
    let liveTabContextMenu = tabContextMenu;
    let liveTabMenuAction = tabMenuAction;
    if (outputDirectory) {
      recordAcceptanceProgress("verify:file-launch:tab-context:screenshot");
      await tabContextMenu.waitFor({ state: "visible", timeout: 1_000 });
      const menuGeometry = await tabContextMenu.evaluate((element) => {
        type MenuElement = {
          readonly clientWidth: number;
          readonly ownerDocument: {
            readonly defaultView?: { readonly innerHeight: number; readonly innerWidth: number };
          };
          readonly scrollWidth: number;
          readonly textContent: string | null;
          getBoundingClientRect(): { bottom: number; left: number; right: number; top: number };
          querySelectorAll(selector: string): ArrayLike<MenuElement>;
        };
        const root = element as unknown as MenuElement;
        const bounds = root.getBoundingClientRect();
        const viewport = root.ownerDocument.defaultView;
        const items = Array.from(root.querySelectorAll('[role="menuitem"]'));
        return {
          bottom: bounds.bottom,
          clippedItems: items
            .filter((item) => item.scrollWidth > item.clientWidth + 1)
            .map((item) => item.textContent?.replace(/\s+/gu, " ").trim() ?? ""),
          insideViewport:
            bounds.left >= -1 &&
            bounds.top >= -1 &&
            bounds.right <= (viewport?.innerWidth ?? 0) + 1 &&
            bounds.bottom <= (viewport?.innerHeight ?? 0) + 1
        };
      });
      assert.equal(
        menuGeometry.insideViewport,
        true,
        "The complete editor-tab menu must fit inside the media viewport."
      );
      assert.ok(
        menuGeometry.bottom <= PACKAGED_FILE_ACTION_MEDIA_HEIGHT,
        "The complete editor-tab menu must fit inside the retained 1440 by 865 media frame."
      );
      assert.deepEqual(menuGeometry.clippedItems, [], "The editor-tab media menu must not clip any visible item text.");
      await captureWorkbenchScreenshot(
        page,
        path.resolve(outputDirectory, `${editor}-tab-context-menu.png`),
        PACKAGED_FILE_ACTION_MEDIA_HEIGHT
      );
      if (await tabContextMenu.isVisible().catch(() => false)) {
        await page.keyboard.press("Escape");
        await tabContextMenu.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      }
      const reopened = await openEditorTabContextMenu(page, activeSourceTab, "Open in Open Wrangler");
      assert.ok(reopened.action, "The live editor-tab menu must still expose Open in Open Wrangler after capture.");
      liveTabContextMenu = reopened.menu;
      liveTabMenuAction = reopened.action;
    }
    recordAcceptanceProgress("verify:file-launch:tab-context:open");
    await liveTabMenuAction.click();
    await liveTabContextMenu.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    await waitFor(
      () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the editor-tab context action to open the selected source"
    );
    assertExactBytes(readFileSync(fixture.fsPath), sourceBytes, "The editor-tab action must not modify its source.");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the editor-tab launch session to dispose"
    );

    // A custom-editor tab becomes active in the extension host before Electron
    // has necessarily rebound editor/title actions to that tab's resource. Drop
    // the prior source tab so a still-rendering action can never retain its URI,
    // then require the third-party webview itself before clicking the action.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => vscode.window.tabGroups.all.every((group) => group.tabs.length === 0),
      10_000,
      "all prior file-launch tabs to close before third-party editor routing"
    );
    await page.bringToFront();
    await activeEditorGroup.locator(".tabs-container .tab.active").last().waitFor({ state: "hidden", timeout: 10_000 });
    await titleAction.first().waitFor({ state: "hidden", timeout: 10_000 });

    recordAcceptanceProgress("verify:file-launch:third-party-editor:source");
    const customEditorFixture = vscode.Uri.file(path.join(path.dirname(fixture.fsPath), "sample.csv"));
    const customEditorSourceBytes = readFileSync(customEditorFixture.fsPath);
    await vscode.commands.executeCommand(
      "vscode.openWith",
      customEditorFixture,
      "openwrangler-tests.csvEditor",
      vscode.ViewColumn.One
    );
    await waitFor(
      () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return (
          input instanceof vscode.TabInputCustom &&
          input.viewType === "openwrangler-tests.csvEditor" &&
          input.uri.toString() === customEditorFixture.toString()
        );
      },
      10_000,
      "the third-party CSV custom editor before file-launch interaction"
    );
    await page.bringToFront();
    const customEditorTitleAction = await waitForThirdPartyCustomEditorWorkbench(
      page,
      activeEditorGroup,
      customEditorFixture
    );
    recordAcceptanceProgress("verify:file-launch:third-party-editor:open");
    await customEditorTitleAction.click();
    recordAcceptanceProgress("verify:file-launch:third-party-editor:import");
    const importCheckpoint = "verify:file-launch:third-party-editor:import";
    await waitForAutomaticDelimitedImport(page, testing, customEditorFixture, importCheckpoint);
    recordAcceptanceProgress(`${importCheckpoint}:options-complete`);
    recordAcceptanceProgress(`${importCheckpoint}:session-open`);
    await waitFor(
      () => testing.activeSession()?.metadata.source.path === customEditorFixture.fsPath,
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the third-party custom-editor title action to open the selected CSV source"
    );
    recordAcceptanceProgress(`${importCheckpoint}:opened`);
    assert.deepEqual(testing.activeSession()?.metadata.source.importOptions, {
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    assertExactBytes(
      readFileSync(customEditorFixture.fsPath),
      customEditorSourceBytes,
      "The third-party custom-editor title action must not modify its source."
    );
    recordAcceptanceProgress(`${importCheckpoint}:close`);
    await withAcceptanceOperationDeadline(
      vscode.commands.executeCommand("workbench.action.closeActiveEditor"),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the third-party CSV session editor to close"
    );
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the third-party custom-editor launch session to dispose"
    );
    recordAcceptanceProgress(`${importCheckpoint}:closed`);

    recordAcceptanceProgress("verify:file-launch:duplicate-action-guards");
    await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitFor(
      () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the custom editor before duplicate-action verification"
    );
    await page.bringToFront();
    await page.waitForTimeout(250);
    assert.equal(
      await titleAction.count(),
      0,
      "The Open Wrangler custom editor must not offer a duplicate open action."
    );
    const openWranglerTab = activeEditorGroup
      .locator(".tabs-container .tab.active")
      .filter({ hasText: path.basename(fixture.fsPath) })
      .last();
    await assertOpenWranglerTabBrandIcon(openWranglerTab);
    const { menu: openWranglerContextMenu } = await openEditorTabContextMenu(page, openWranglerTab);
    assert.equal(
      await openWranglerContextMenu.getByRole("menuitem", { name: "Open in Open Wrangler", exact: true }).count(),
      0,
      "The Open Wrangler custom-editor tab must not offer a duplicate open action."
    );
    await page.keyboard.press("Escape");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the launch-surface custom editor to dispose"
    );
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    recordAcceptanceProgress("verify:file-launch:complete");
  }

  return exercisePackagedFileLaunchSurfaces;
}
