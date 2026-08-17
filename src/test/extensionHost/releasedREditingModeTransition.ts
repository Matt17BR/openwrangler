import * as assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;

interface ReleasedREditingModeTransitionDependencies {
  readonly SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: number;
  readonly assertExactOpenNotebookDocument: (notebook: vscode.NotebookDocument, checkpoint: string) => void;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
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

export function createReleasedREditingModeTransition({
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  assertExactOpenNotebookDocument,
  recordAcceptanceProgress,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor
}: ReleasedREditingModeTransitionDependencies) {
  return async function exerciseReleasedREditingModeTransition(
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    base: ReleasedRActiveSession,
    phase: "jupyter-r" | "jupyter-r-remote"
  ): Promise<void> {
    const viewingStateBeforeEditing = testing.activeSession()?.viewState;
    assert.ok(viewingStateBeforeEditing, "The R mode switch requires the confirmed Viewing-mode presentation.");
    assert.deepEqual(
      viewingStateBeforeEditing.filterModel.sort.map((rule) => rule.column),
      ["group", "score"],
      "The R mode switch acceptance must begin with a real compound sort to prove view replay."
    );
    const viewingRevision = testing.activeSession()?.metadata.revision;
    assert.ok(viewingRevision !== undefined);
    assertExactOpenNotebookDocument(notebook, "before switching the live R variable to Editing mode");
    let editingApp = await releasedRSessionApp(workbench, testing, base.sessionId, "the viewing R session");
    const switchToEditing = editingApp.getByRole("button", { name: "Switch to Editing", exact: true });
    await switchToEditing.waitFor({ state: "visible", timeout: 10_000 });
    recordAcceptanceProgress(`${phase}:editing:switch`);
    await switchToEditing.click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === base.sessionId &&
          active.metadata.mode === "editing" &&
          active.metadata.revision > viewingRevision &&
          active.viewState.filterModel.sort.map((rule) => rule.column).join(",") === "group,score"
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the exact live R session to reopen in Editing mode with its view intact",
      () => JSON.stringify(testing.diagnostics())
    );
    assertExactOpenNotebookDocument(notebook, "after switching the live R variable to Editing mode");
    await requireFreshExactSessionPanelHydration(
      testing,
      base.sessionId,
      "The Editing-mode R session must acknowledge its atomically replaced runtime."
    );
    editingApp = await releasedRSessionApp(workbench, testing, base.sessionId, "the switched R session");
    assert.equal(await editingApp.getByRole("button", { name: "Switch to Editing", exact: true }).count(), 0);
    assert.equal((await editingApp.locator('[data-session-badge="mode"]').innerText()).trim(), "EDITING");
    await editingApp.getByRole("button", { name: "Column profiles and filters", exact: true }).click();
    const editingDrawer = editingApp.getByRole("complementary", {
      name: "Column profiles and filters",
      exact: true
    });
    await editingDrawer.getByRole("tab", { name: "Filters / Sorts", exact: true }).click();
    await editingDrawer.getByRole("button", { name: "Clear all", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === base.sessionId &&
          active.viewState.filterModel.filters.length === 0 &&
          active.viewState.filterModel.sort.length === 0
        );
      },
      30_000,
      "clearing the replayed R view before the cleaning journey"
    );
    editingApp = await releasedRSessionApp(workbench, testing, base.sessionId, "the cleared R editing view");
    await editingApp
      .getByRole("complementary", { name: "Column profiles and filters", exact: true })
      .getByRole("button", { name: "Close panel" })
      .click();
  };
}
