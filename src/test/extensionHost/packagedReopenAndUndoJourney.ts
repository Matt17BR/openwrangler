import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Frame, Locator, Page } from "playwright-core";
import { exactSessionApp } from "./acknowledgedRenderer";
import { assertExactBytes } from "./acceptanceSourceFixture";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import { dismissStaleWorkbenchHover, exportCleanedDataThroughWorkbench } from "./cleanedDataExport";
import type { TestApi } from "./extensionHostTestApi";
import { PACKAGED_FIRST_USE_ROW_COUNT } from "./screenshotEvidence";

export interface PackagedReopenAndUndoDependencies {
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
  readonly waitForAutomaticDelimitedImport: (
    page: Page,
    testing: TestApi,
    expectedSource: vscode.Uri,
    checkpointPrefix: string
  ) => Promise<void>;
  readonly waitForOpenWranglerGridTarget: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string
  ) => Promise<{ readonly frame: Frame }>;
  readonly sessionOpenAcceptanceTimeoutMs: number;
}

export function createPackagedReopenAndUndoJourney(
  dependencies: PackagedReopenAndUndoDependencies
): (
  testing: TestApi,
  workbench: Page,
  fixture: vscode.Uri,
  sourceBytes: Uint8Array,
  editorName: string
) => Promise<void> {
  const {
    recordAcceptanceProgress,
    synchronizedSessionApp,
    waitFor,
    waitForAutomaticDelimitedImport,
    waitForOpenWranglerGridTarget,
    sessionOpenAcceptanceTimeoutMs
  } = dependencies;
  const SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS = sessionOpenAcceptanceTimeoutMs;

  async function previewUppercaseMarketReplacement(
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    stepId: string
  ): Promise<Locator> {
    await dismissStaleWorkbenchHover(workbench);
    await app.getByRole("button", { name: "Edit latest", exact: true }).click();
    const dialog = app.getByRole("dialog", { name: "Edit cleaning step" });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const textColumn = dialog.getByLabel("Text column", { exact: true });
    await textColumn.waitFor({ state: "visible", timeout: 10_000 });
    assert.match((await textColumn.locator("option:checked").innerText()).trim(), /^market$/u);
    const outputColumn = dialog.getByLabel("Output column (blank replaces in place)", { exact: true });
    assert.equal(await outputColumn.inputValue(), "market_upper", "Editing must hydrate the committed output name.");
    await outputColumn.fill("market_caps");
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const applied = active?.metadata.steps[0];
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          active.metadata.steps.length === 1 &&
          applied?.id === stepId &&
          draft?.id === stepId &&
          draft.kind === "upperText" &&
          draft.params.column.name === "market" &&
          draft.params.newColumn === "market_caps" &&
          active.metadata.draftReplacesStepId === stepId &&
          active.metadata.schema.some((column) => column.name === "market_caps") &&
          !active.metadata.schema.some((column) => column.name === "market_upper")
        );
      },
      30_000,
      "the edited Uppercase step to preview as a stable replacement"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const preview = testing.activeSession();
    assert.ok(preview, "The replacement preview must retain its active session.");
    assert.equal(preview.metadata.steps.length, 1, "A replacement preview must not append a second plan entry.");
    assert.match(preview.code ?? "", /\bmarket_caps\b/u);
    assert.doesNotMatch(preview.code ?? "", /\bmarket_upper\b/u);
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const replacementApp = await exactSessionApp(target.frame, sessionId);
    assert.ok(replacementApp, "The edited preview must expose its exact Open Wrangler application.");
    return replacementApp;
  }

  async function exercisePackagedReopenAndUndoJourney(
    testing: TestApi,
    workbench: Page,
    fixture: vscode.Uri,
    sourceBytes: Uint8Array,
    editorName: string
  ): Promise<void> {
    recordAcceptanceProgress("platform-smoke:reopen");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      15_000,
      `the ${editorName} first-use session to close before recovery`
    );
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
      `the CSV source editor before the ${editorName} recovery action`
    );
    const activeEditorGroup = workbench.locator(".part.editor .editor-group-container.active");
    const titleAction = activeEditorGroup
      .locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible')
      .first();
    await titleAction.waitFor({ state: "visible", timeout: 10_000 });
    await titleAction.click();
    await waitForAutomaticDelimitedImport(workbench, testing, fixture, "platform-smoke:reopen-import");
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.uri === fixture.toString() &&
          active.metadata.steps.length === 1 &&
          active.metadata.schema.some((column) => column.name === "market_upper")
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the applied cleaning plan to replay after closing and reopening the source"
    );
    const reopened = testing.activeSession();
    assert.ok(reopened, "Reopening the source must publish its recovered dataframe session.");
    const originalStep = reopened.metadata.steps[0];
    assert.ok(originalStep, "The recovered cleaning plan must retain its applied step.");
    assert.equal(originalStep.kind, "upperText");
    if (originalStep.kind !== "upperText") throw new Error("The recovered first-use step must remain Uppercase.");
    assert.equal(originalStep.params.column.name, "market");
    assert.equal(originalStep.params.newColumn, "market_upper");
    assert.ok(
      reopened.metadata.latestStepInputSchema?.some((column) => column.name === "market"),
      "The recovered step must retain its exact input schema for editing."
    );
    assert.equal(
      reopened.metadata.latestStepInputSchema?.some((column) => column.name === "market_upper"),
      false,
      "The edit schema must describe the step input rather than its committed output."
    );
    const reopenedTarget = await waitForOpenWranglerGridTarget(workbench, testing, reopened.sessionId);
    let reopenedApp = await exactSessionApp(reopenedTarget.frame, reopened.sessionId);
    assert.ok(reopenedApp, "The recovered session must expose its exact Open Wrangler application.");
    await reopenedApp
      .getByRole("group", { name: "Cleaning plan" })
      .getByText("1 applied step")
      .waitFor({ state: "visible", timeout: 10_000 });

    recordAcceptanceProgress("platform-smoke:edit-latest-discard");
    reopenedApp = await previewUppercaseMarketReplacement(
      testing,
      workbench,
      reopenedApp,
      reopened.sessionId,
      originalStep.id
    );
    const replacementReview = reopenedApp.getByRole("region", { name: "Draft review" });
    await replacementReview.getByText("Uppercase", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await reopenedApp.locator('th[data-column="market_caps"]').waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await reopenedApp.locator('th[data-column="market_upper"]').count(),
      0,
      "The replacement preview must render only its edited output schema."
    );
    await replacementReview.getByRole("button", { name: "Discard", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.steps.length === 1 &&
          active.metadata.steps[0]?.id === originalStep.id &&
          active.metadata.draftStep === undefined &&
          active.metadata.draftReplacesStepId === undefined &&
          active.metadata.schema.some((column) => column.name === "market_upper") &&
          !active.metadata.schema.some((column) => column.name === "market_caps")
        );
      },
      30_000,
      "discarding an edited step to restore the exact committed plan"
    );
    const afterReplacementDiscard = testing.activeSession();
    assert.ok(afterReplacementDiscard, "Discarding the edited step must retain the active session.");
    assert.deepEqual(afterReplacementDiscard.metadata.steps, [originalStep]);
    assert.match(afterReplacementDiscard.code ?? "", /\bmarket_upper\b/u);
    assert.doesNotMatch(afterReplacementDiscard.code ?? "", /\bmarket_caps\b/u);
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "Discarding a latest-step replacement must preserve the first-use source bytes."
    );

    recordAcceptanceProgress("platform-smoke:edit-latest-apply");
    reopenedApp = await previewUppercaseMarketReplacement(
      testing,
      workbench,
      reopenedApp,
      reopened.sessionId,
      originalStep.id
    );
    await reopenedApp
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const applied = active?.metadata.steps[0];
        return (
          active?.metadata.steps.length === 1 &&
          applied?.id === originalStep.id &&
          applied.kind === "upperText" &&
          applied.params.column.id === originalStep.params.column.id &&
          applied.params.newColumn === "market_caps" &&
          active.metadata.draftStep === undefined &&
          active.metadata.draftReplacesStepId === undefined &&
          active.metadata.schema.some((column) => column.name === "market_caps") &&
          !active.metadata.schema.some((column) => column.name === "market_upper")
        );
      },
      30_000,
      "applying an edited step as one stable plan replacement"
    );
    const replaced = testing.activeSession();
    assert.ok(replaced, "Applying the edited step must retain the active session.");
    const replacementStep = replaced.metadata.steps[0];
    assert.ok(replacementStep, "The edited plan must contain its one replacement step.");
    assert.equal(replacementStep.id, originalStep.id, "Editing must retain the stable applied-step identity.");
    assert.equal(replaced.metadata.steps.length, 1, "Editing must replace rather than append a cleaning step.");
    assert.match(replaced.code ?? "", /\bmarket_caps\b/u);
    assert.doesNotMatch(replaced.code ?? "", /\bmarket_upper\b/u);
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "Applying a latest-step replacement must preserve the first-use source bytes."
    );

    recordAcceptanceProgress("platform-smoke:edit-latest-export");
    const exportDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-edited-step-export-"));
    const exportPath = path.join(exportDirectory, "regional-orders-edited.csv");
    try {
      await exportCleanedDataThroughWorkbench(reopenedApp, workbench, exportPath);
      await waitFor(() => existsSync(exportPath), 30_000, "the edited-plan CSV export to appear");
      const exportedLines = readFileSync(exportPath, "utf8").trimEnd().split(/\r?\n/u);
      const exportedHeader = exportedLines[0] ?? "";
      assert.equal(exportedLines.length, PACKAGED_FIRST_USE_ROW_COUNT + 1);
      assert.match(exportedHeader, /(?:^|;)market(?:;|$)/u);
      assert.match(exportedHeader, /(?:^|;)market_caps(?:;|$)/u);
      assert.doesNotMatch(exportedHeader, /(?:^|;)market_upper(?:;|$)/u);
      assert.doesNotMatch(
        exportedHeader,
        /(?:^|,)market(?:,|$)/u,
        "The replayed file session must retain its confirmed semicolon export default."
      );
    } finally {
      cleanupAcceptanceTemporaryDirectory(exportDirectory);
    }
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "Exporting a replaced latest step must preserve the first-use source bytes."
    );

    recordAcceptanceProgress("platform-smoke:replacement-reopen");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      15_000,
      `the ${editorName} edited-step session to close before its replay`
    );
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "Closing the edited-step session must preserve the first-use source bytes."
    );
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
      `the CSV source editor before replaying the ${editorName} edited step`
    );
    await workbench.bringToFront();
    const replacementTitleAction = workbench
      .locator(
        '.part.editor .editor-group-container.active .editor-actions [aria-label="Open in Open Wrangler"]:visible'
      )
      .first();
    await replacementTitleAction.waitFor({ state: "visible", timeout: 10_000 });
    await replacementTitleAction.click();
    await waitForAutomaticDelimitedImport(workbench, testing, fixture, "platform-smoke:replacement-reopen-import");
    await waitFor(
      () => {
        const active = testing.activeSession();
        const applied = active?.metadata.steps[0];
        return (
          active?.metadata.source.uri === fixture.toString() &&
          active.metadata.steps.length === 1 &&
          applied?.id === originalStep.id &&
          applied.kind === "upperText" &&
          applied.params.newColumn === "market_caps" &&
          active.metadata.schema.some((column) => column.name === "market_caps") &&
          !active.metadata.schema.some((column) => column.name === "market_upper")
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the edited cleaning step to replay as the sole persisted plan entry"
    );
    const replayed = testing.activeSession();
    assert.ok(replayed, "Replaying the edited step must publish its dataframe session.");
    assert.deepEqual(replayed.metadata.steps, [replacementStep]);
    assert.match(replayed.code ?? "", /\bmarket_caps\b/u);
    assert.doesNotMatch(replayed.code ?? "", /\bmarket_upper\b/u);
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "Replaying the edited step must preserve the first-use source bytes."
    );
    const readPage = async (session: NonNullable<ReturnType<TestApi["activeSession"]>>, viewRequestId: string) => {
      const response = await testing.request(
        {
          kind: "getPage",
          sessionId: session.sessionId,
          revision: session.metadata.revision,
          viewRequestId,
          offset: 0,
          limit: 3,
          columnOffset: 0,
          columnLimit: session.metadata.schema.length,
          filterModel: session.viewState.filterModel
        },
        { ephemeralPage: true }
      );
      assert.equal(response.kind, "page", "The file Undo/Redo check requires a bounded confirmed page.");
      if (response.kind !== "page") throw new Error("The file Undo/Redo check did not receive a page.");
      assert.equal(response.metadata.sessionId, session.sessionId);
      assert.equal(response.revision, session.metadata.revision);
      return response.page;
    };
    const replayedPage = await readPage(replayed, "platform-smoke-before-undo");
    const replayedApp = await synchronizedSessionApp(
      workbench,
      testing,
      replayed.sessionId,
      "The replayed edited step must acknowledge its current session before Undo."
    );
    await replayedApp
      .getByRole("group", { name: "Cleaning plan" })
      .getByText("1 applied step")
      .waitFor({ state: "visible", timeout: 10_000 });

    recordAcceptanceProgress("platform-smoke:undo");
    await dismissStaleWorkbenchHover(workbench);
    await replayedApp.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === replayed.sessionId &&
          active.metadata.revision === replayed.metadata.revision + 1 &&
          active.metadata.steps.length === 0 &&
          active.metadata.draftStep === undefined &&
          active.metadata.schema.some((column) => column.name === "market") &&
          !active.metadata.schema.some((column) => column.name === "market_upper") &&
          !active.metadata.schema.some((column) => column.name === "market_caps")
        );
      },
      30_000,
      "Undo to restore the original schema"
    );
    const undone = testing.activeSession();
    assert.ok(undone, "Undo must retain the exact file session.");
    assert.equal(undone.metadata.canRedo, true);
    const undonePage = await readPage(undone, "platform-smoke-after-undo");
    const undoneApp = await synchronizedSessionApp(
      workbench,
      testing,
      replayed.sessionId,
      "The last Undo must leave its Redo action in the acknowledged renderer."
    );
    const reopenedCleaningPlan = undoneApp.getByRole("group", { name: "Cleaning plan" });
    await reopenedCleaningPlan
      .getByText("0 applied steps", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await reopenedCleaningPlan.getByRole("button", { name: "Redo", exact: true }).waitFor({ state: "visible" });
    assert.equal(await reopenedCleaningPlan.getByRole("button", { name: "Undo", exact: true }).count(), 0);
    assert.equal(await reopenedCleaningPlan.getByRole("button", { name: "Edit latest", exact: true }).count(), 0);
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "Undoing the replayed step must preserve the first-use source bytes."
    );

    recordAcceptanceProgress("platform-smoke:redo");
    await reopenedCleaningPlan.getByRole("button", { name: "Redo", exact: true }).click({ trial: true });
    await vscode.commands.executeCommand("openWrangler.redoStep");
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === replayed.sessionId &&
          active.metadata.revision === undone.metadata.revision + 1 &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          active.metadata.steps[0]?.id === replacementStep.id
        );
      },
      30_000,
      "the registered Redo command to restore the edited file step once"
    );
    const redone = testing.activeSession();
    assert.ok(redone, "Redo must retain the exact file session.");
    assert.equal(redone.metadata.canRedo, false);
    assert.deepEqual(redone.metadata.steps, replayed.metadata.steps);
    assert.deepEqual(redone.metadata.schema, replayed.metadata.schema);
    assert.deepEqual(redone.metadata.source, replayed.metadata.source);
    assert.equal(redone.code, replayed.code);
    assert.deepEqual(await readPage(redone, "platform-smoke-after-redo"), replayedPage);
    assertExactBytes(await vscode.workspace.fs.readFile(fixture), sourceBytes, "Redo must preserve the source bytes.");

    const redoneApp = await synchronizedSessionApp(
      workbench,
      testing,
      replayed.sessionId,
      "The redone file step must reach its renderer before the final Undo."
    );
    await redoneApp.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === replayed.sessionId &&
          active.metadata.revision === redone.metadata.revision + 1 &&
          active.metadata.steps.length === 0 &&
          active.metadata.draftStep === undefined
        );
      },
      30_000,
      "Undo to restore the file journey's original final state"
    );
    const final = testing.activeSession();
    assert.ok(final);
    assert.equal(final.metadata.canRedo, true);
    assert.deepEqual(final.metadata.schema, undone.metadata.schema);
    assert.deepEqual(final.metadata.source, undone.metadata.source);
    assert.equal(final.code, undone.code);
    assert.deepEqual(await readPage(final, "platform-smoke-final-undo"), undonePage);
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "The final Undo must preserve its source."
    );
  }

  return exercisePackagedReopenAndUndoJourney;
}
