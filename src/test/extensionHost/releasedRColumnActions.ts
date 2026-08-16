import * as assert from "node:assert/strict";
import type { Browser, Frame, Locator, Page } from "playwright-core";
import { exactSessionApp } from "./acknowledgedRenderer";
import type { TestApi } from "./extensionHostTestApi";
import {
  acquirePreparedAcceptanceAction,
  ignoreRetiredRendererProbeFailure,
  isRetiredRendererTarget,
  pollAcceptanceCondition,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";

interface OpenWranglerWebviewTarget {
  readonly page: Page;
  readonly frame: Frame;
}

export interface ReleasedRColumnActionsDependencies {
  readonly assertOpenWranglerWebviewLifecycle: (workbench: Page, browser: Browser | null) => void;
  readonly openWranglerWebviewTargets: (
    workbench: Page,
    browser: Browser | null,
    limit: number
  ) => readonly OpenWranglerWebviewTarget[];
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    description: string
  ) => Promise<Locator>;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, description: string) => Promise<void>;
  readonly waitForLocatorText: (
    locator: Locator,
    predicate: (text: string) => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: (lastText: string) => string
  ) => Promise<void>;
  readonly waitForOpenWranglerGridTarget: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string
  ) => Promise<Readonly<{ frame: Frame }>>;
  readonly OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT: number;
  readonly WORKBENCH_OPERATION_TIMEOUT_MS: number;
}

export function createReleasedRColumnActions(dependencies: ReleasedRColumnActionsDependencies) {
  const {
    assertOpenWranglerWebviewLifecycle,
    openWranglerWebviewTargets,
    releasedRSessionApp,
    waitFor,
    waitForLocatorText,
    waitForOpenWranglerGridTarget,
    OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT,
    WORKBENCH_OPERATION_TIMEOUT_MS
  } = dependencies;

  async function assertReleasedProfileStat(panel: Locator, label: string, expected: string): Promise<void> {
    const term = panel.getByText(label, { exact: true });
    await term.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await term.evaluate((element) => element.tagName), "DT");
    await waitForLocatorText(
      term.locator("xpath=following-sibling::dd[1]"),
      (text) => text.trim() === expected,
      30_000,
      `${label} to render as ${expected} in the native R profile`
    );
  }

  async function applyReleasedRQuickSort(
    workbench: Page,
    testing: TestApi,
    column: string,
    direction: "ascending" | "descending",
    expectedPriority: readonly string[]
  ): Promise<void> {
    const sessionId = testing.activeSession()?.sessionId;
    assert.ok(sessionId, "The R quick sort requires one active session.");
    const columnId = testing.activeSession()?.metadata.schema.find((candidate) => candidate.name === column)?.id;
    assert.ok(columnId, `The R quick sort requires the ${column} column.`);
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const currentApp = await exactSessionApp(target.frame, sessionId);
    assert.ok(currentApp, `The R ${column} quick sort requires its exact renderer.`);
    const columnSearch = currentApp.getByRole("combobox", { name: "Column", exact: true });
    await columnSearch.fill(column);
    await currentApp
      .getByRole("option", { name: new RegExp(`^${column},`, "u") })
      .first()
      .waitFor({
        state: "visible",
        timeout: 10_000
      });
    await columnSearch.press("Enter");
    const searchClosed = await pollAcceptanceCondition(
      async () => (await columnSearch.getAttribute("aria-expanded")) === "false",
      {
        timeoutMs: 10_000,
        intervalMs: 50,
        wait: (durationMs) => workbench.waitForTimeout(durationMs)
      }
    );
    assert.equal(searchClosed, true, `The R ${column} column search must close after selection.`);
    await waitFor(
      () =>
        testing.activeSession()?.sessionId === sessionId &&
        testing.activeSession()?.viewState.selectedColumnId === columnId,
      10_000,
      `selecting the R ${column} column before sorting`
    );
    const menu = await waitForReleasedRColumnMenu(workbench, sessionId, column);
    await withAcceptanceOperationDeadline(
      menu.page.keyboard.press("Enter"),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      `opening the focused R ${column} column menu`
    );
    const sort = await waitForReleasedRColumnMenuAction(workbench, sessionId, column, `Sort ${direction}`);
    assert.equal(await sort.action.isEnabled(), true, `The R ${column} ${direction} sort must be enabled.`);
    await withAcceptanceOperationDeadline(
      sort.page.keyboard.press("Enter"),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      `activating the focused R ${column} ${direction} sort`
    );
    await waitFor(
      () =>
        testing
          .activeSession()
          ?.viewState.filterModel.sort.map((rule) => rule.column)
          .join(",") === expectedPriority.join(","),
      10_000,
      `${column} to join the native R compound sort`
    );
    const sortedApp = await releasedRSessionApp(workbench, testing, sessionId, `the sorted R ${column} view`);
    const closedMenu = sortedApp.locator(`th[data-column=${JSON.stringify(column)}] details.columnMenu`).first();
    await closedMenu.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await closedMenu.evaluate((element) => element.hasAttribute("open")), false);
  }

  interface ReleasedRColumnMenu {
    page: Page;
    menu: Locator;
    summary: Locator;
  }

  interface ReleasedRColumnMenuAction extends ReleasedRColumnMenu {
    action: Locator;
  }

  async function waitForReleasedRColumnMenu(
    workbench: Page,
    sessionId: string,
    column: string
  ): Promise<ReleasedRColumnMenu> {
    const browser = workbench.context().browser();
    const trialTimeoutMs = 2_000;
    let lastRetryableError: string | undefined;
    const prepared = await acquirePreparedAcceptanceAction({
      timeoutMs: WORKBENCH_OPERATION_TIMEOUT_MS,
      intervalMs: 50,
      acquire: async () => {
        assertOpenWranglerWebviewLifecycle(workbench, browser);
        for (const target of openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT)) {
          if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
          try {
            const app = await exactSessionApp(target.frame, sessionId);
            if (!app) continue;
            const menu = app.locator(`th[data-column=${JSON.stringify(column)}] details.columnMenu`).first();
            const summary = menu.getByLabel(`Column actions for ${column}`, { exact: true });
            if ((await summary.count()) !== 1 || !(await summary.isVisible())) continue;
            return { page: target.page, menu, summary };
          } catch (error) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
          }
        }
        return undefined;
      },
      prepare: async ({ summary }) => {
        await summary.focus({ timeout: trialTimeoutMs });
        assert.equal(
          await summary.evaluate((element) => element.isConnected && element.ownerDocument.activeElement === element),
          true,
          `The R ${column} column menu must own keyboard focus in the exact session renderer.`
        );
      },
      dispose: async () => undefined,
      isRetryablePreparationError: (error) => {
        const retryable = isReleasedRColumnMenuPreparationError(error);
        if (retryable) lastRetryableError = releasedRColumnMenuPreparationDiagnostic(error);
        return retryable;
      },
      wait: (durationMs) => workbench.waitForTimeout(durationMs)
    });
    assert.ok(
      prepared,
      `The R ${column} menu must become keyboard-ready in the exact session renderer. ` +
        `Last retryable cause: ${lastRetryableError ?? "none observed"}.`
    );
    return prepared;
  }

  async function waitForReleasedRColumnMenuAction(
    workbench: Page,
    sessionId: string,
    column: string,
    actionName: string
  ): Promise<ReleasedRColumnMenuAction> {
    const browser = workbench.context().browser();
    const prepared = await acquirePreparedAcceptanceAction({
      timeoutMs: WORKBENCH_OPERATION_TIMEOUT_MS,
      intervalMs: 50,
      acquire: async () => {
        assertOpenWranglerWebviewLifecycle(workbench, browser);
        for (const target of openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT)) {
          if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
          try {
            const app = await exactSessionApp(target.frame, sessionId);
            if (!app) continue;
            const menu = app.locator(`th[data-column=${JSON.stringify(column)}] details.columnMenu`).first();
            const summary = menu.getByLabel(`Column actions for ${column}`, { exact: true });
            const action = menu.getByRole("button", { name: actionName, exact: true });
            if (
              (await menu.count()) !== 1 ||
              !(await menu.evaluate((element) => element.hasAttribute("open"))) ||
              (await summary.count()) !== 1 ||
              (await action.count()) !== 1 ||
              !(await action.isVisible()) ||
              !(await action.isEnabled())
            ) {
              continue;
            }
            return { page: target.page, menu, summary, action };
          } catch (error) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
          }
        }
        return undefined;
      },
      prepare: async ({ action }) => {
        await action.focus({ timeout: 2_000 });
        assert.equal(
          await action.evaluate((element) => element.isConnected && element.ownerDocument.activeElement === element),
          true,
          `The R ${column} ${actionName} action must own keyboard focus in the exact session renderer.`
        );
      },
      dispose: async () => undefined,
      isRetryablePreparationError: isReleasedRColumnMenuPreparationError,
      wait: (durationMs) => workbench.waitForTimeout(durationMs)
    });
    assert.ok(
      prepared,
      `The R ${column} ${actionName} action must become keyboard-ready in the exact session renderer.`
    );
    return prepared;
  }

  function releasedRColumnMenuPreparationDiagnostic(error: unknown): string {
    const name =
      typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
        ? error.name
        : "Error";
    const message = (error instanceof Error ? error.message : String(error)).split(/\r?\n/u, 1)[0];
    return `${name}: ${message.replace(/\s+/gu, " ").trim().slice(0, 240) || "no message"}`;
  }

  function isReleasedRColumnMenuPreparationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      (error as { name?: unknown } | undefined)?.name === "TimeoutError" ||
      /(?:element|node).*(?:detached|not attached|not connected)/iu.test(message)
    );
  }

  return Object.freeze({ applyReleasedRQuickSort, assertReleasedProfileStat });
}
