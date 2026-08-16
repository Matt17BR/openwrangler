import * as assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import type { Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import { captureNotebookWorkbenchScreenshot } from "./evidenceSceneCapture";
import { packagedScreenshotFileName } from "./evidenceScenes";
import { probeAcceptanceBeforeDeadline } from "./playwrightLifecycle";
import { PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT } from "./screenshotEvidence";

export interface ReleasedRDocumentMediaDependencies {
  readonly activateReleasedRInteractiveTitleAction: (workbench: Page, document: vscode.TextDocument) => Promise<void>;
  readonly assertReleasedNotebookVariablePickerGeometry: (
    picker: Locator,
    expectedNames: readonly string[]
  ) => Promise<void>;
  readonly clearReleasedJupyterScreenshotTransientUi: (workbench: Page) => Promise<void>;
  readonly closeVisibleWorkbenchPart: (
    workbench: Page,
    selector: string,
    commandIds: readonly string[]
  ) => Promise<void>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedJupyterQuickPickRow: (picker: Locator, name: string) => Promise<Locator | undefined>;
  readonly releasedJupyterScreenshotTheme: () => string;
  readonly releasedQuartoPreviewLocator: (workbench: Page) => Promise<Locator | undefined>;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, description: string) => Promise<void>;
  readonly withBoundedAcceptancePromise: <T>(promise: Promise<T>, timeoutMs: number, description: string) => Promise<T>;
  readonly WORKBENCH_DIAGNOSTIC_TIMEOUT_MS: number;
  readonly WORKBENCH_OPERATION_TIMEOUT_MS: number;
  readonly WORKBENCH_PLAYWRIGHT_TIMEOUT_MS: number;
}

export function createReleasedRDocumentMedia(dependencies: ReleasedRDocumentMediaDependencies) {
  const {
    activateReleasedRInteractiveTitleAction,
    assertReleasedNotebookVariablePickerGeometry,
    clearReleasedJupyterScreenshotTransientUi,
    closeVisibleWorkbenchPart,
    recordAcceptanceProgress,
    releasedJupyterQuickPickRow,
    releasedJupyterScreenshotTheme,
    releasedQuartoPreviewLocator,
    waitFor,
    withBoundedAcceptancePromise,
    WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
    WORKBENCH_OPERATION_TIMEOUT_MS,
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
  } = dependencies;

  async function prepareReleasedRDocumentScreenshotWorkbench(
    workbench: Page,
    source: vscode.Uri,
    variableName: string
  ): Promise<() => Promise<void>> {
    if (process.platform !== "linux") return async () => {};
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
    const restore = async () => {
      for (const { configuration, key, value } of [...previousSettings].reverse()) {
        await configuration.update(key, value, vscode.ConfigurationTarget.Global);
      }
      await workbench.setViewportSize(previousViewport);
      await waitFor(
        () => vscode.window.activeColorTheme.kind === previousThemeKind,
        10_000,
        "the Quarto workbench to restore its prior color theme"
      );
      await workbench.waitForTimeout(500);
    };

    try {
      await workbench.setViewportSize(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT);
      assert.deepEqual(
        await workbench.evaluate(() => {
          const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
          return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
        }),
        PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
        "The Quarto picker scene requires the standard 1440 by 900 editor viewport."
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
        "the dark Quarto screenshot theme"
      );
      await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
        "workbench.action.closeSidebar",
        "workbench.action.toggleSidebarVisibility"
      ]);
      await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
        "workbench.action.closeAuxiliaryBar",
        "workbench.action.toggleAuxiliaryBar"
      ]);
      await closeVisibleWorkbenchPart(workbench, ".part.panel", [
        "workbench.action.closePanel",
        "workbench.action.togglePanel"
      ]);
      await clearReleasedJupyterScreenshotTransientUi(workbench);

      const matches = vscode.workspace.textDocuments.filter(
        (document) => document.uri.toString() === source.toString()
      );
      assert.equal(matches.length, 1, "Quarto media capture requires one exact open source document.");
      const document = matches[0]!;
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.One
      });
      const dataLine = document
        .getText()
        .split("\n")
        .findIndex((line) => line.includes(`${variableName} <-`));
      assert.ok(dataLine >= 0, "The Quarto media fixture must contain its dataframe construction line.");
      editor.selection = new vscode.Selection(dataLine, 0, dataLine, 0);
      editor.revealRange(
        new vscode.Range(Math.max(0, dataLine - 4), 0, dataLine + 3, 0),
        vscode.TextEditorRevealType.InCenter
      );
      await workbench.waitForTimeout(500);
      return restore;
    } catch (error) {
      await restore();
      throw error;
    }
  }

  async function invokeReleasedRDocumentTitleAction(
    workbench: Page,
    source: vscode.Uri,
    variableName: string,
    screenshotOutput?: string
  ): Promise<void> {
    const captureScreenshot = screenshotOutput !== undefined && process.platform === "linux";
    const restore = captureScreenshot
      ? await prepareReleasedRDocumentScreenshotWorkbench(workbench, source, variableName)
      : async () => {};
    try {
      const matches = vscode.workspace.textDocuments.filter(
        (document) => document.uri.toString() === source.toString()
      );
      assert.equal(matches.length, 1, "The R document title action requires one exact open source document.");
      const document = matches[0]!;
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.One
      });
      const chunkLine = document
        .getText()
        .split("\n")
        .findIndex((line) => line.includes(`${variableName} <-`));
      assert.ok(chunkLine >= 0, "The R document title action requires a cursor-owned dataframe chunk.");
      editor.selection = new vscode.Selection(chunkLine, 0, chunkLine, 0);
      await waitFor(
        () => vscode.window.activeTextEditor === editor && editor.document === document,
        10_000,
        "the exact R document editor to become active before its cursor-owned action"
      );
      await workbench.bringToFront();
      await activateReleasedRInteractiveTitleAction(workbench, document);
      const title = "Open Wrangler: Choose a dataframe from the active R session";
      const picker = workbench.locator(".quick-input-widget:visible").filter({ hasText: title }).last();
      await picker.waitFor({ state: "visible", timeout: 30_000 });
      const input = picker.locator(".quick-input-box input:visible").first();
      await input.fill(variableName);
      const row = await releasedJupyterQuickPickRow(picker, variableName);
      assert.ok(row, `The R document title action did not expose ${JSON.stringify(variableName)}.`);
      if (captureScreenshot) {
        const commands = new Set(await vscode.commands.getCommands(true));
        assert.ok(commands.has("notifications.hideToasts"), "Quarto media capture requires toast hiding support.");
        await vscode.commands.executeCommand("notifications.hideToasts");
        await workbench
          .locator(".notifications-toasts .notification-toast:visible")
          .first()
          .waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
        await assertReleasedNotebookVariablePickerGeometry(picker, [variableName]);
        await assertReleasedRDocumentPickerMediaGeometry(workbench, picker, variableName);
        mkdirSync(screenshotOutput, { recursive: true });
        recordAcceptanceProgress("jupyter-r:screenshot:quarto-picker");
        await captureNotebookWorkbenchScreenshot(
          workbench,
          path.resolve(
            screenshotOutput,
            packagedScreenshotFileName(
              process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor",
              "r-quarto-variable-picker",
              "dark"
            )
          )
        );
      }
      await row.click();
      await picker.waitFor({ state: "hidden", timeout: 10_000 });
    } finally {
      await restore();
    }
  }

  async function assertReleasedRDocumentPickerMediaGeometry(
    workbench: Page,
    picker: Locator,
    variableName: string
  ): Promise<void> {
    const sourceLine = workbench
      .locator(".part.editor .editor-group-container.active .view-lines .view-line:visible")
      .filter({ hasText: `${variableName} <-` })
      .first();
    await sourceLine.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    const preview = await probeAcceptanceBeforeDeadline(
      () => releasedQuartoPreviewLocator(workbench),
      Date.now() + WORKBENCH_DIAGNOSTIC_TIMEOUT_MS
    );
    assert.ok(preview, "The Quarto media scene requires the official rendered preview.");
    const [lineText, lineBounds, pickerBounds, previewBounds] = await withBoundedAcceptancePromise(
      Promise.all([sourceLine.innerText(), sourceLine.boundingBox(), picker.boundingBox(), preview.boundingBox()]),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "Quarto picker media geometry"
    );
    assert.match(lineText, new RegExp(`${variableName}\\s*<-\\s*utils::read\\.csv`, "u"));
    assert.ok(lineBounds, "The Quarto picker scene requires a measurable dataframe source line.");
    assert.ok(pickerBounds, "The Quarto picker scene requires a measurable picker.");
    assert.ok(previewBounds, "The Quarto picker scene requires a measurable rendered preview.");
    const crop = { left: 0, top: 20, right: 1_440, bottom: 780 };
    for (const [subject, bounds] of [
      ["source line", lineBounds],
      ["picker", pickerBounds],
      ["rendered preview", previewBounds]
    ] as const) {
      assert.ok(
        bounds.x >= crop.left &&
          bounds.y >= crop.top &&
          bounds.x + bounds.width <= crop.right &&
          bounds.y + bounds.height <= crop.bottom,
        `The Quarto ${subject} must fit inside the README detail crop: ${JSON.stringify(bounds)}.`
      );
    }
  }

  return invokeReleasedRDocumentTitleAction;
}
