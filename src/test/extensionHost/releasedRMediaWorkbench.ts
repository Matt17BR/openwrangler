import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { ColumnReference, SessionMetadata } from "../../shared/protocol";
import { pollAcceptanceCondition } from "./playwrightLifecycle";
import type { TestApi } from "./extensionHostTestApi";
import { PACKAGED_SCREENSHOT_VIEWPORT } from "./screenshotEvidence";

interface ReleasedRMediaWorkbenchDependencies {
  readonly columnReference: (metadata: SessionMetadata, name: string) => ColumnReference;
  readonly requireFreshExactSessionPanelHydration: (
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<void>;
}

export function createReleasedRMediaWorkbench({
  columnReference,
  requireFreshExactSessionPanelHydration
}: ReleasedRMediaWorkbenchDependencies) {
  async function fitReleasedRMediaColumns(
    testing: TestApi,
    app: Locator,
    sessionId: string,
    columnNames: readonly [string, string, string]
  ): Promise<void> {
    const scroller = app.locator(".tableScroller").first();
    await scroller.waitFor({ state: "visible", timeout: 10_000 });
    const drawerLeft = await app
      .getByRole("complementary", { name: "Column profiles and filters", exact: true })
      .evaluate((element) => element.getBoundingClientRect().left);
    const geometry = await scroller.evaluate((element) => {
      const target = element as unknown as {
        clientWidth: number;
        getBoundingClientRect(): { left: number };
        querySelector(selector: string): { getBoundingClientRect(): { width: number } } | null;
      };
      const rowHeader = target.querySelector("th.rowHeader");
      if (!rowHeader) throw new Error("The R media grid has no row header.");
      return {
        clientWidth: target.clientWidth,
        left: target.getBoundingClientRect().left,
        rowHeaderWidth: rowHeader.getBoundingClientRect().width
      };
    });
    const visibleWidth = Math.min(geometry.clientWidth, drawerLeft - geometry.left);
    const leadingWidth = 155;
    const trailingWidth = Math.floor(visibleWidth - geometry.rowHeaderWidth - leadingWidth * 2);
    assert.ok(
      trailingWidth >= 140 && trailingWidth <= 240,
      `The R media grid cannot fit three complete columns: ${JSON.stringify({ ...geometry, drawerLeft, visibleWidth, trailingWidth })}.`
    );
    const active = testing.activeSession();
    assert.equal(active?.sessionId, sessionId, "The R media column fit requires the exact active session.");
    assert.ok(active);
    const fittedWidths = { ...active.viewState.columnWidths };
    for (const [index, name] of columnNames.entries()) {
      fittedWidths[columnReference(active.metadata, name).id] = index === 2 ? trailingWidth : leadingWidth;
    }
    await testing.updateViewState(sessionId, {
      ...active.viewState,
      columnWidths: fittedWidths,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(await testing.synchronizePanel(sessionId), true, "The fitted R media grid must synchronize.");
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The fitted R media grid must be acknowledged before capture."
    );
  }

  async function assertOnlyCompleteMediaColumnsVisible(
    app: Locator,
    expectedNames: readonly string[],
    scene: string
  ): Promise<void> {
    const drawerLeft = await app
      .getByRole("complementary", { name: "Column profiles and filters", exact: true })
      .evaluate((element) => element.getBoundingClientRect().left);
    const visible = await app
      .locator(".tableScroller")
      .first()
      .evaluate((element, clipRight) => {
        type HeaderElement = {
          getAttribute(name: string): string | null;
          getBoundingClientRect(): { left: number; right: number };
        };
        type ScrollerElement = HeaderElement & { querySelectorAll(selector: string): ArrayLike<HeaderElement> };
        const scroller = element as unknown as ScrollerElement;
        const bounds = scroller.getBoundingClientRect();
        const viewportRight = Math.min(bounds.right, clipRight);
        return Array.from(scroller.querySelectorAll("th[data-column]")).flatMap((header) => {
          const rectangle = header.getBoundingClientRect();
          if (rectangle.right <= bounds.left + 0.5 || rectangle.left >= viewportRight - 0.5) return [];
          return [
            {
              name: header.getAttribute("data-column"),
              complete: rectangle.left >= bounds.left - 0.5 && rectangle.right <= viewportRight + 0.5,
              left: rectangle.left,
              right: rectangle.right,
              viewportLeft: bounds.left,
              viewportRight
            }
          ];
        });
      }, drawerLeft);
    assert.deepEqual(
      visible.map((header) => header.name),
      expectedNames,
      `${scene} must show exactly three complete columns.`
    );
    assert.ok(
      visible.every((header) => header.complete),
      `${scene} contains a clipped column: ${JSON.stringify(visible)}.`
    );
  }

  async function assertMediaColumnTitlesUnclipped(
    app: Locator,
    columnNames: readonly string[],
    scene: string
  ): Promise<void> {
    for (const columnName of columnNames) {
      const title = app.locator(`th[data-column="${columnName}"] .columnTitle`).first();
      await title.waitFor({ state: "visible", timeout: 10_000 });
      const geometry = await title.evaluate((element) => {
        const target = element as unknown as {
          clientWidth: number;
          scrollWidth: number;
          textContent: string | null;
        };
        return {
          clientWidth: target.clientWidth,
          scrollWidth: target.scrollWidth,
          text: target.textContent?.trim() ?? ""
        };
      });
      assert.equal(geometry.text, columnName, `${scene} must retain the complete ${columnName} title.`);
      assert.ok(
        geometry.scrollWidth <= geometry.clientWidth + 1,
        `${scene} must not clip the ${columnName} title: ${JSON.stringify(geometry)}.`
      );
    }
  }

  async function closeVisibleWorkbenchPart(
    workbench: Page,
    selector: string,
    commandCandidates: readonly string[]
  ): Promise<void> {
    const part = workbench.locator(selector).first();
    if ((await part.count()) === 0 || !(await part.isVisible())) return;
    const commands = new Set(await vscode.commands.getCommands(true));
    const command = commandCandidates.find((candidate) => commands.has(candidate));
    assert.ok(command, `The screenshot workbench cannot close visible part ${selector}.`);
    await vscode.commands.executeCommand(command);
    await part.waitFor({ state: "hidden", timeout: 10_000 });
  }

  async function clearReleasedJupyterScreenshotTransientUi(workbench: Page): Promise<void> {
    const commands = new Set(await vscode.commands.getCommands(true));
    if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
    if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
    await workbench.keyboard.press("Escape");
    await workbench.mouse.move(Math.floor(PACKAGED_SCREENSHOT_VIEWPORT.width * 0.75), 40);
    assert.equal(
      await pollAcceptanceCondition(async () => (await workbench.locator(".monaco-hover:visible").count()) === 0, {
        timeoutMs: 3_000,
        intervalMs: 50
      }),
      true,
      "Notebook screenshot capture must dismiss every workbench hover."
    );
    const transientUi = workbench.locator(
      ".quick-input-widget:visible, .monaco-dialog-box:visible, .context-view.monaco-menu-container:visible, " +
        ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
    );
    await pollAcceptanceCondition(async () => (await transientUi.count()) === 0, {
      timeoutMs: 3_000,
      intervalMs: 50
    });
    const transient = await transientUi.allInnerTexts();
    assert.deepEqual(
      transient.map((text) => text.replace(/\s+/gu, " ").trim().slice(0, 500)),
      [],
      "Notebook screenshot capture must not retain transient workbench UI."
    );
  }

  function releasedJupyterScreenshotTheme(): string {
    return "Default Dark Modern";
  }

  return {
    assertMediaColumnTitlesUnclipped,
    assertOnlyCompleteMediaColumnsVisible,
    clearReleasedJupyterScreenshotTransientUi,
    closeVisibleWorkbenchPart,
    fitReleasedRMediaColumns,
    releasedJupyterScreenshotTheme
  };
}
