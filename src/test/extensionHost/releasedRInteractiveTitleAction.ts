import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import { withAcceptanceOperationDeadline } from "./playwrightLifecycle";

const RELEASED_R_EDITOR_TITLE_COMMAND = "openWrangler.openRDataframe";
const RELEASED_R_EDITOR_TITLE_ACTION_NAME_PATTERN = /^(?:Open in Open Wrangler|Open Wrangler: Open R Dataframe)$/u;

interface ReleasedRInteractiveTitleActionDependencies {
  readonly WORKBENCH_DIAGNOSTIC_TIMEOUT_MS: number;
  readonly WORKBENCH_PLAYWRIGHT_TIMEOUT_MS: number;
  readonly releasedCommandOwnedAction: (
    container: Locator,
    commandItem: Locator,
    role: "button" | "menuitem",
    includeHidden?: boolean
  ) => Locator;
  readonly releasedJupyterQuickPickRow: (quickInput: Locator, label: string) => Promise<Locator | undefined>;
  readonly releasedNotebookActionLabelEvidence: (
    action: Locator
  ) => Promise<{ ariaLabel: string; title: string; text: string }>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
}

export function createReleasedRInteractiveTitleActions({
  WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
  releasedCommandOwnedAction,
  releasedJupyterQuickPickRow,
  releasedNotebookActionLabelEvidence,
  waitFor
}: ReleasedRInteractiveTitleActionDependencies) {
  async function invokeReleasedRInteractiveTitleAction(
    workbench: Page,
    directory: string,
    variableName: string
  ): Promise<void> {
    const source = vscode.Uri.file(path.join(directory, "live-session.R"));
    writeFileSync(source.fsPath, "# Dataframes are already loaded in the selected R terminal.\n", "utf8");
    await vscode.commands.executeCommand("vscode.open", source, {
      preview: false,
      viewColumn: vscode.ViewColumn.One
    });
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.toString() === source.toString(),
      10_000,
      "the live-session R source to become active before its title action"
    );
    const sourceDocument = vscode.window.activeTextEditor?.document;
    assert.ok(sourceDocument, "The live-session R source must remain open before its title action.");
    await workbench.bringToFront();
    await activateReleasedRInteractiveTitleAction(workbench, sourceDocument);

    const picker = workbench
      .locator(".quick-input-widget:visible")
      .filter({ hasText: "Open Wrangler: Choose a dataframe from the active R session" })
      .last();
    await picker.waitFor({ state: "visible", timeout: 30_000 });
    const input = picker.locator(".quick-input-box input:visible").first();
    await input.fill(variableName);
    const row = await releasedJupyterQuickPickRow(picker, variableName);
    assert.ok(row, `The stable R title action did not expose ${JSON.stringify(variableName)}.`);
    await row.click();
    await picker.waitFor({ state: "hidden", timeout: 10_000 });
  }

  async function activateReleasedRInteractiveTitleAction(
    workbench: Page,
    sourceDocument: vscode.TextDocument,
    dispatch = true
  ): Promise<void> {
    const activeGroup = workbench.locator(".part.editor .editor-group-container.active:visible").first();
    const activeSourceTab = activeGroup
      .locator(".tabs-container .tab.active:visible")
      .filter({ hasText: path.basename(sourceDocument.uri.fsPath) })
      .last();
    const titleActions = activeGroup.locator(".editor-actions:visible");
    const visibleMenus = workbench.locator(".context-view.monaco-menu-container:visible");
    const moreActions = titleActions.getByRole("button", { name: /^More Actions(?:\.\.\.)?$/u });
    await activeSourceTab.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    assertExactActiveTextEditor(sourceDocument, "before focusing its workbench tab");
    await activeSourceTab.click({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });

    const deadline = Date.now() + 10_000;
    let lastItems: Array<{ label: string; command: string }> = [];
    let lastTitleItems: Array<{ label: string; command: string }> = [];
    do {
      assertExactActiveTextEditor(sourceDocument, "while waiting for its Open Wrangler title action");
      assert.equal(
        await activeSourceTab.isVisible(),
        true,
        "The exact R source must remain the active workbench tab while its title action binds."
      );
      const direct = await resolveReleasedREditorAction(titleActions, "button", "active R editor title");
      if (direct) {
        if (!dispatch) return;
        assertExactActiveTextEditor(sourceDocument, "before dispatching its direct Open Wrangler title action");
        await direct.click({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
        return;
      }
      lastTitleItems = await releasedEditorActionDiagnostics(titleActions, "button");

      assert.equal(await visibleMenus.count(), 0, "R title-action discovery requires no pre-existing workbench menu.");
      if ((await moreActions.count()) === 1 && (await moreActions.first().isVisible())) {
        assert.equal(
          await moreActions.first().isEnabled(),
          true,
          "The active R editor More Actions button must be enabled."
        );
        await moreActions.first().click({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
        const menu = visibleMenus.first();
        let dispatchStarted = false;
        try {
          await workbench.waitForTimeout(150);
          await menu.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
          assert.equal(await visibleMenus.count(), 1, "The R editor More Actions button must open exactly one menu.");
          const action = await resolveReleasedREditorAction(menu, "menuitem", "active R editor overflow");
          if (action) {
            if (!dispatch) return;
            assertExactActiveTextEditor(sourceDocument, "before dispatching its Open Wrangler overflow action");
            assert.equal(
              await activeSourceTab.isVisible(),
              true,
              "The exact R source must remain the active workbench tab before its overflow action is dispatched."
            );
            dispatchStarted = true;
            await action.click({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
            await menu.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
            return;
          }
          lastItems = await releasedEditorActionDiagnostics(menu, "menuitem");
        } finally {
          if (!dispatchStarted && (await visibleMenus.count()) > 0) {
            await workbench.locator("body").press("Escape");
            await menu.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
          }
        }
      }
      if (Date.now() >= deadline) break;
      await workbench.waitForTimeout(50);
    } while (Date.now() < deadline);

    assert.fail(
      "The active R editor did not expose its Open Wrangler action after the workbench title context settled. " +
        `Context: ${JSON.stringify({
          extension: path.extname(sourceDocument.uri.path),
          languageId: sourceDocument.languageId,
          scheme: sourceDocument.uri.scheme,
          trusted: vscode.workspace.isTrusted,
          platform: process.platform,
          activeTabVisible: await activeSourceTab.isVisible().catch(() => false)
        })}. Last visible title actions: ${JSON.stringify(lastTitleItems)}. ` +
        `Last visible overflow items: ${JSON.stringify(lastItems)}.`
    );
  }

  async function resolveReleasedREditorAction(
    container: Locator,
    role: "button" | "menuitem",
    surface: string
  ): Promise<Locator | undefined> {
    const commandItems = container.locator(`.action-item[data-command-id="${RELEASED_R_EDITOR_TITLE_COMMAND}"]`);
    const commandCount = await commandItems.count();
    assert.ok(commandCount < 2, `The ${surface} exposed duplicate Open Wrangler actions.`);
    const byLabel = container.getByRole(role, { name: RELEASED_R_EDITOR_TITLE_ACTION_NAME_PATTERN });
    const labelCount = commandCount === 0 ? await byLabel.count() : 0;
    assert.ok(labelCount < 2, `The ${surface} exposed duplicate labeled Open Wrangler actions.`);
    const action =
      commandCount === 1 ? releasedCommandOwnedAction(container, commandItems.first(), role) : byLabel.first();
    if ((await action.count()) !== 1 || !(await action.isVisible()) || !(await action.isEnabled())) return undefined;
    const evidence = await releasedNotebookActionLabelEvidence(action);
    assert.match(
      evidence.ariaLabel || evidence.title || evidence.text,
      RELEASED_R_EDITOR_TITLE_ACTION_NAME_PATTERN,
      `The ${surface} command exposed an unexpected label. Observed: ${JSON.stringify(evidence)}`
    );
    return action;
  }

  async function releasedEditorActionDiagnostics(
    container: Locator,
    role: "button" | "menuitem"
  ): Promise<Array<{ label: string; command: string }>> {
    return container.getByRole(role).evaluateAll((elements) =>
      elements.slice(0, 32).map((element) => {
        const normalize = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/gu, " ").trim().slice(0, 256);
        const owner = element.closest(".action-item");
        return {
          label: normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent),
          command: normalize(element.getAttribute("data-command-id") || owner?.getAttribute("data-command-id"))
        };
      })
    );
  }

  function assertExactActiveTextEditor(sourceDocument: vscode.TextDocument, phase: string): void {
    assert.equal(
      vscode.window.activeTextEditor?.document,
      sourceDocument,
      `The exact R source must remain active ${phase}.`
    );
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputText, `The exact R source tab must remain active ${phase}.`);
    assert.equal(
      input.uri.toString(),
      sourceDocument.uri.toString(),
      `The exact R source tab must remain active ${phase}.`
    );
  }

  async function assertReleasedWorkbenchHasNoBlockingDialog(workbench: Page, checkpoint: string): Promise<void> {
    const [dialogs, modalBlocks] = await withAcceptanceOperationDeadline(
      Promise.all([
        workbench.locator(".monaco-dialog-box:visible").evaluateAll((elements) =>
          elements.slice(0, 4).map((element) => {
            const normalize = (value: string | null | undefined): string =>
              (value ?? "").replace(/\s+/gu, " ").trim().slice(0, 512);
            return {
              message: normalize(element.querySelector(".dialog-message-text")?.textContent),
              detail: normalize(element.querySelector(".dialog-message-detail")?.textContent),
              buttons: (Array.from(element.querySelectorAll("button")) as Array<{ textContent: string | null }>)
                .slice(0, 8)
                .map((button) => normalize(button.textContent))
            };
          })
        ),
        workbench.locator(".monaco-dialog-modal-block.dimmed:visible").count()
      ]),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      `blocking-dialog diagnostics ${checkpoint}`
    );
    if (dialogs.length === 0 && modalBlocks === 0) return;
    throw new Error(
      `The isolated workbench was blocked by a modal ${checkpoint}: ` + `${JSON.stringify({ dialogs, modalBlocks })}`
    );
  }

  return {
    activateReleasedRInteractiveTitleAction,
    assertReleasedWorkbenchHasNoBlockingDialog,
    invokeReleasedRInteractiveTitleAction
  };
}
