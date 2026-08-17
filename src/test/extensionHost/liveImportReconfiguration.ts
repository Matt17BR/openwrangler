import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Frame, Locator, Page } from "playwright-core";
import type { SessionSource } from "../../shared/protocol";
import { sameRendererSynchronizationReceipt } from "./acknowledgedRenderer";
import { assertExactBytes } from "./acceptanceSourceFixture";
import type { TestApi } from "./extensionHostTestApi";
import { waitForImportRendererRecovery } from "./importRendererRecovery";
import {
  observeExactRendererRetirement,
  pressKeyboardKeyPairWithoutTransitionGap,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";

interface RendererSynchronizationReceipt {
  readonly syncId: string;
  readonly sessionId: string;
  readonly revision: number;
}

interface ExactSessionWebviewAction {
  readonly action: Locator;
  readonly target: { readonly page: Page; readonly frame: Frame };
}

interface GridViewportMeasurement {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly clientWidth: number;
}

export interface LiveImportReconfigurationDependencies {
  readonly acceptQuickPickOptionWithKeyboard: (
    page: Page,
    quickInput: Locator,
    title: string,
    option: string,
    checkpoint?: string,
    waitForPromptToHide?: boolean
  ) => Promise<void>;
  readonly activeEditorTabDiagnostic: () => Record<string, boolean | string>;
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly fileSourceIdentity: (source: SessionSource) => Pick<SessionSource, "kind" | "label" | "path" | "uri">;
  readonly isOpenWranglerSessionTab: (tab: vscode.Tab) => boolean;
  readonly openEditorTabContextMenu: (
    page: Page,
    tab: Locator,
    requiredActionName?: string
  ) => Promise<{ readonly menu: Locator; readonly action?: Locator }>;
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
  readonly waitForExactSessionWebviewAction: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string,
    name: string,
    requireEnabled?: boolean,
    expectedReceipt?: RendererSynchronizationReceipt
  ) => Promise<ExactSessionWebviewAction>;
  readonly waitForExactSessionWebviewButton: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string,
    name: string,
    requireEnabled?: boolean,
    expectedReceipt?: RendererSynchronizationReceipt
  ) => Promise<Locator>;
  readonly waitForImportNaturalKeyboardFocus: (
    target: Locator,
    title: string,
    relationship: "contains" | "exact"
  ) => Promise<void>;
  readonly waitForImportQuickInput: (
    page: Page,
    testing: TestApi,
    expectedSource: vscode.Uri,
    title: string,
    existingSessionId?: string
  ) => Promise<Locator>;
  readonly waitForOpenWranglerWebviewButton: (
    workbench: Page,
    name: string,
    requireEnabled?: boolean
  ) => Promise<Locator>;
  readonly sessionOpenAcceptanceTimeoutMs: number;
  readonly workbenchOperationTimeoutMs: number;
  readonly workbenchPlaywrightTimeoutMs: number;
}

export function createLiveImportReconfiguration(
  dependencies: LiveImportReconfigurationDependencies
): (testing: TestApi, directory: string, config: vscode.WorkspaceConfiguration) => Promise<void> {
  const {
    acceptQuickPickOptionWithKeyboard,
    activeEditorTabDiagnostic,
    connectToEditorWorkbench,
    fileSourceIdentity,
    isOpenWranglerSessionTab,
    openEditorTabContextMenu,
    recordAcceptanceProgress,
    waitFor,
    waitForAutomaticDelimitedImport,
    waitForExactSessionWebviewAction,
    waitForExactSessionWebviewButton,
    waitForImportNaturalKeyboardFocus,
    waitForImportQuickInput,
    waitForOpenWranglerWebviewButton,
    sessionOpenAcceptanceTimeoutMs,
    workbenchOperationTimeoutMs,
    workbenchPlaywrightTimeoutMs
  } = dependencies;
  const SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS = sessionOpenAcceptanceTimeoutMs;
  const WORKBENCH_OPERATION_TIMEOUT_MS = workbenchOperationTimeoutMs;
  const WORKBENCH_PLAYWRIGHT_TIMEOUT_MS = workbenchPlaywrightTimeoutMs;

  async function focusAndSynchronizeExactSessionPanel(
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string,
    expectedSourceLabel: string
  ): Promise<{
    action: Locator;
    receipt: Readonly<{ syncId: string; sessionId: string; revision: number; layoutTransitionPending: boolean }>;
  }> {
    const expectedTabLabel = `Open Wrangler: ${expectedSourceLabel}`;
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await waitFor(
      () => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        return Boolean(tab && tab.label === expectedTabLabel && isOpenWranglerSessionTab(tab));
      },
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the exact Open Wrangler custom editor to remain active after its import Quick Input closed",
      () =>
        JSON.stringify({
          expectedSessionId,
          expectedTabLabel,
          activeTab: activeEditorTabDiagnostic(),
          panelHydrated: testing.panelHydrated(expectedSessionId),
          coordinator: testing.diagnostics()
        })
    );

    // Cursor may temporarily retire a custom-editor renderer while its final
    // Quick Input closes. Focusing is one non-mutating user action; require the
    // exact session's physical grid before asking the host for a fresh,
    // authoritative renderer acknowledgement.
    await waitForExactSessionWebviewButton(workbench, testing, expectedSessionId, "Import options");
    await waitFor(
      () => testing.panelHydrated(expectedSessionId),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the exact import-reconfigured renderer to acknowledge its current host snapshot",
      () =>
        JSON.stringify({
          expectedSessionId,
          activeTab: activeEditorTabDiagnostic(),
          panelHydrated: testing.panelHydrated(expectedSessionId),
          coordinator: testing.diagnostics()
        })
    );
    assert.equal(
      await testing.synchronizePanel(expectedSessionId),
      true,
      "The focused import-reconfigured renderer must acknowledge one authoritative synchronization."
    );
    const receipt = testing.panelSynchronizationReceipt(expectedSessionId);
    assert.ok(receipt, "The focused import-reconfigured renderer must retain its exact synchronization receipt.");
    const action = await waitForExactSessionWebviewButton(
      workbench,
      testing,
      expectedSessionId,
      "Import options",
      true,
      receipt
    );
    assert.equal(
      sameRendererSynchronizationReceipt(receipt, testing.panelSynchronizationReceipt(expectedSessionId)),
      true,
      "The focused import-reconfigured renderer receipt must remain current through physical discovery."
    );
    return { action, receipt };
  }

  function stableImportReconfigurationSnapshot(active: ReturnType<TestApi["activeSession"]>): unknown {
    if (!active) return undefined;
    const { stats: _progressiveStats, ...metadata } = active.metadata;
    return {
      sessionId: active.sessionId,
      metadata,
      code: active.code,
      viewState: active.viewState,
      stepInspection: active.stepInspection
    };
  }

  function stableImportDiagnostics(
    diagnostics: ReturnType<TestApi["diagnostics"]>
  ): ReturnType<TestApi["diagnostics"]> {
    return structuredClone(diagnostics);
  }

  async function waitForOpenWranglerGridViewport(
    action: Locator,
    expected: Pick<GridViewportMeasurement, "scrollTop" | "scrollLeft">
  ): Promise<GridViewportMeasurement> {
    return withAcceptanceOperationDeadline(
      action.evaluate(
        (_element, target) =>
          new Promise<GridViewportMeasurement>((resolve, reject) => {
            const scroller = _element.ownerDocument.querySelector('[data-testid="data-grid-scroller"]');
            if (!scroller) {
              reject(new Error("The Open Wrangler grid scroller is unavailable."));
              return;
            }
            const deadline = performance.now() + 5_000;
            const read = (): GridViewportMeasurement => ({
              scrollTop: scroller.scrollTop,
              scrollLeft: scroller.scrollLeft,
              scrollHeight: scroller.scrollHeight,
              scrollWidth: scroller.scrollWidth,
              clientHeight: scroller.clientHeight,
              clientWidth: scroller.clientWidth
            });
            const poll = () => {
              const current = read();
              const overflowed =
                current.scrollHeight > current.clientHeight && current.scrollWidth > current.clientWidth;
              const positioned =
                Math.abs(current.scrollTop - target.scrollTop) <= 1 &&
                Math.abs(current.scrollLeft - target.scrollLeft) <= 1;
              if (overflowed && positioned) {
                resolve(current);
                return;
              }
              if (performance.now() >= deadline) {
                resolve(current);
                return;
              }
              setTimeout(poll, 25);
            };
            poll();
          }),
        expected
      ),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the synchronized Open Wrangler grid viewport"
    );
  }

  async function acceptDelimitedImportOptions(
    page: Page,
    testing: TestApi,
    expectedSource: vscode.Uri,
    existingSessionId: string | undefined,
    checkpointPrefix: string,
    selection: {
      delimiter: string;
      encoding: string;
      header: string;
      quoteChar: string;
    }
  ): Promise<void> {
    for (const { key, title, option } of [
      { key: "delimiter", title: "Delimiter", option: selection.delimiter },
      { key: "encoding", title: "Text encoding", option: selection.encoding },
      { key: "header", title: "Header row", option: selection.header }
    ]) {
      const checkpoint = `${checkpointPrefix}:${key}`;
      recordAcceptanceProgress(`${checkpoint}:wait`);
      const quickInput = await waitForImportQuickInput(page, testing, expectedSource, title, existingSessionId);
      recordAcceptanceProgress(`${checkpoint}:visible`);
      await acceptQuickPickOptionWithKeyboard(page, quickInput, title, option, checkpoint);
    }

    const quoteCheckpoint = `${checkpointPrefix}:quote`;
    recordAcceptanceProgress(`${quoteCheckpoint}:wait`);
    const quoteInput = await waitForImportQuickInput(
      page,
      testing,
      expectedSource,
      "Quote character",
      existingSessionId
    );
    recordAcceptanceProgress(`${quoteCheckpoint}:visible`);
    const field = quoteInput.locator(".quick-input-box input").first();
    await withAcceptanceOperationDeadline(
      field.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the configured quote-character field to become visible"
    );
    await waitForImportNaturalKeyboardFocus(field, "Quote character", "exact");
    await withAcceptanceOperationDeadline(
      field.fill(selection.quoteChar, { timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the configured quote character"
    );
    recordAcceptanceProgress(`${quoteCheckpoint}:focused`);
    recordAcceptanceProgress(`${quoteCheckpoint}:accept`);
    await withAcceptanceOperationDeadline(
      pressKeyboardKeyPairWithoutTransitionGap(page.keyboard, "Enter"),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the configured quote character acceptance"
    );
    await withAcceptanceOperationDeadline(
      quoteInput.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the quote-character prompt to close"
    );
    recordAcceptanceProgress(`${quoteCheckpoint}:accepted`);
  }

  async function exerciseLiveImportReconfiguration(
    testing: TestApi,
    directory: string,
    config: vscode.WorkspaceConfiguration
  ): Promise<void> {
    const page = await connectToEditorWorkbench();
    const configured = vscode.Uri.file(path.join(directory, "reconfigure.csv"));
    const configuredBytes = readFileSync(configured.fsPath);
    await config.update("defaultBackend", "auto", vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const opening = vscode.commands.executeCommand("openWrangler.openFile", configured);
    await waitForAutomaticDelimitedImport(page, testing, configured, "verify:file-inputs:reconfigure:initial-options");
    await opening;
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.path === configured.fsPath &&
          active.metadata.shape.rows === 80 &&
          active.metadata.shape.columns === 8
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the semicolon CSV to open with automatically detected import options"
    );

    const before = testing.activeSession();
    assert.ok(before, "The configurable CSV must publish an active session.");
    assert.deepEqual(
      before.metadata.source.importOptions,
      {
        delimiter: ";",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      },
      "Automatic import detection must establish the baseline before reconfiguration selects a real alternative."
    );
    const stableSessionId = before.sessionId;
    const stableSourceIdentity = fileSourceIdentity(before.metadata.source);
    const initialDiagnostics = testing.diagnostics();
    const initialRuntimeId = initialDiagnostics.sessions.find(
      (session) => session.publicId === stableSessionId
    )?.runtimeId;
    assert.ok(initialRuntimeId, "The active configurable CSV must own a runtime session.");

    const changeTitleAction = page
      .locator(
        '.part.editor .editor-group-container.active .editor-actions [aria-label*="Change Import Options"]:visible'
      )
      .first();
    await withAcceptanceOperationDeadline(
      changeTitleAction.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the generic Open Wrangler Change Import Options title action"
    );
    await withAcceptanceOperationDeadline(
      changeTitleAction.click(),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the generic Open Wrangler Change Import Options title action click"
    );
    await acceptDelimitedImportOptions(
      page,
      testing,
      configured,
      stableSessionId,
      "verify:file-inputs:reconfigure:title-options",
      {
        delimiter: "Semicolon",
        encoding: "utf-8",
        header: "First row contains column names",
        quoteChar: "'"
      }
    );
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === stableSessionId &&
          active.metadata.source.path === configured.fsPath &&
          active.metadata.shape.rows === 80 &&
          active.metadata.shape.columns === 8 &&
          active.metadata.source.importOptions?.delimiter === ";" &&
          active.metadata.source.importOptions.quoteChar === "'"
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the live CSV session to atomically adopt its semicolon import options"
    );
    // The test API can observe replacement metadata while the coordinator is
    // still persisting it. Restore focus after the final Quick Input and require
    // the exact session's physical, authoritative renderer before continuing.
    await focusAndSynchronizeExactSessionPanel(page, testing, stableSessionId, path.basename(configured.fsPath));
    recordAcceptanceProgress("verify:file-inputs:reconfigure:title-options:renderer-synchronized");

    const changed = testing.activeSession();
    assert.ok(changed, "The reconfigured CSV must remain active.");
    assert.equal(changed.sessionId, stableSessionId, "Import reconfiguration must retain the public session ID.");
    assert.deepEqual(
      fileSourceIdentity(changed.metadata.source),
      stableSourceIdentity,
      "Import reconfiguration must retain the exact source identity."
    );
    assert.deepEqual(changed.metadata.source.importOptions, {
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: "'",
      hasHeader: true
    });
    assertExactBytes(
      readFileSync(configured.fsPath),
      configuredBytes,
      "Live reconfiguration must not modify its source."
    );
    const changedRuntimeId = testing
      .diagnostics()
      .sessions.find((session) => session.publicId === stableSessionId)?.runtimeId;
    assert.ok(changedRuntimeId, "The reconfigured public session must retain one private runtime.");
    assert.notEqual(
      changedRuntimeId,
      initialRuntimeId,
      "A successful import reconfiguration must replace, not mutate, its private runtime."
    );
    const retainedColumn = changed.metadata.schema.find((column) => column.name === "value");
    assert.ok(retainedColumn, "The reconfigured CSV must expose its value column for reload-state acceptance.");
    const retainedColumnWidths = Object.fromEntries(changed.metadata.schema.map((column) => [column.id, 640]));
    const retainedViewState = {
      selectedColumnId: retainedColumn.id,
      columnWidths: retainedColumnWidths,
      viewport: { firstVisibleRow: 1, scrollLeft: 23 }
    };
    assert.equal(
      await testing.synchronizePanel(stableSessionId),
      true,
      "The reconfigured renderer must settle its authoritative default view before acceptance injects retained state."
    );
    recordAcceptanceProgress("verify:file-inputs:reconfigure:view-state:default-synchronized");
    await testing.updateViewState(stableSessionId, retainedViewState);
    assert.equal(
      await testing.synchronizePanel(stableSessionId),
      true,
      "The acceptance view-state injection must commit through the real renderer before native import actions."
    );
    recordAcceptanceProgress("verify:file-inputs:reconfigure:view-state:retained-synchronized");
    const retainedRendererReceipt = testing.panelSynchronizationReceipt(stableSessionId);
    assert.ok(retainedRendererReceipt, "The retained import view must own an acknowledged renderer receipt.");
    const synchronizedGridTarget = await waitForExactSessionWebviewAction(
      page,
      testing,
      stableSessionId,
      "Import options",
      true,
      retainedRendererReceipt
    );
    const physicalViewport = await waitForOpenWranglerGridViewport(synchronizedGridTarget.action, {
      scrollTop: 29,
      scrollLeft: 23
    });
    recordAcceptanceProgress("verify:file-inputs:reconfigure:view-state:physical");
    assert.ok(
      physicalViewport.scrollHeight > physicalViewport.clientHeight,
      "The import-reconfiguration fixture must overflow the real grid vertically."
    );
    assert.ok(
      physicalViewport.scrollWidth > physicalViewport.clientWidth,
      "The import-reconfiguration fixture must overflow the real grid horizontally."
    );
    assert.ok(
      Math.abs(physicalViewport.scrollTop - 29) <= 1,
      "The real grid must commit the injected first visible row before cancellation acceptance."
    );
    assert.ok(
      Math.abs(physicalViewport.scrollLeft - 23) <= 1,
      "The real grid must commit the injected horizontal viewport before cancellation acceptance."
    );
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.viewState.selectedColumnId === retainedViewState.selectedColumnId &&
          changed.metadata.schema.every((column) => active.viewState.columnWidths[column.id] === 640) &&
          active.viewState.viewport.firstVisibleRow === 1 &&
          active.viewState.viewport.scrollLeft === 23
        );
      },
      5_000,
      "the reconfigured CSV view state to persist under its confirmed source and backend",
      () =>
        JSON.stringify({
          expected: retainedViewState,
          actual: testing.activeSession()?.viewState
        })
    );
    recordAcceptanceProgress("verify:file-inputs:reconfigure:view-state:persisted");

    const snapshotBeforeRendererRetirement = stableImportReconfigurationSnapshot(testing.activeSession());
    const diagnosticsBeforeRendererRetirement = stableImportDiagnostics(testing.diagnostics());
    assert.equal(
      testing.retirePanelRenderer(stableSessionId),
      true,
      "Acceptance must physically retire the exact visible hydrated import renderer."
    );
    await observeExactRendererRetirement(
      page,
      page.context().browser(),
      synchronizedGridTarget.target.page,
      synchronizedGridTarget.target.frame,
      () =>
        withAcceptanceOperationDeadline(
          synchronizedGridTarget.action.waitFor({
            state: "detached",
            timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
          }),
          WORKBENCH_OPERATION_TIMEOUT_MS,
          "the exact acknowledged import renderer to retire physically"
        )
    );
    const recoveredRendererReceipt = await waitForImportRendererRecovery(
      testing,
      stableSessionId,
      changed.metadata.revision,
      retainedRendererReceipt,
      {
        retirementTimeoutMs: WORKBENCH_OPERATION_TIMEOUT_MS,
        recoveryTimeoutMs: SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        onRetired: () => recordAcceptanceProgress("verify:file-inputs:reconfigure:renderer-retirement-received"),
        diagnostics: () => testing.diagnostics(),
        waitForCondition: (condition, timeoutMs, description, diagnostic) =>
          waitFor(condition, timeoutMs, description, diagnostic)
      }
    );
    const recoveredRendererTarget = await waitForExactSessionWebviewAction(
      page,
      testing,
      stableSessionId,
      "Import options",
      true,
      recoveredRendererReceipt
    );
    const recoveredRenderer = {
      action: recoveredRendererTarget.action,
      receipt: recoveredRendererReceipt
    };
    assert.notEqual(
      recoveredRenderer.receipt.syncId,
      retainedRendererReceipt.syncId,
      "Renderer recovery must acknowledge a physically new document."
    );
    assert.equal(recoveredRenderer.receipt.sessionId, stableSessionId);
    assert.equal(recoveredRenderer.receipt.revision, changed.metadata.revision);
    assert.deepEqual(
      stableImportReconfigurationSnapshot(testing.activeSession()),
      snapshotBeforeRendererRetirement,
      "Renderer recovery must retain the exact confirmed session snapshot."
    );
    assert.deepEqual(
      stableImportDiagnostics(testing.diagnostics()),
      diagnosticsBeforeRendererRetirement,
      "Renderer recovery must retain the same public and private runtime ownership."
    );
    assertExactBytes(
      readFileSync(configured.fsPath),
      configuredBytes,
      "Renderer recovery must leave the configured source byte-identical."
    );
    const recoveredPhysicalViewport = await waitForOpenWranglerGridViewport(recoveredRenderer.action, {
      scrollTop: 29,
      scrollLeft: 23
    });
    assert.ok(
      recoveredPhysicalViewport.scrollHeight > recoveredPhysicalViewport.clientHeight,
      "The recovered import renderer must retain vertical grid overflow."
    );
    assert.ok(
      recoveredPhysicalViewport.scrollWidth > recoveredPhysicalViewport.clientWidth,
      "The recovered import renderer must retain horizontal grid overflow."
    );
    assert.ok(
      Math.abs(recoveredPhysicalViewport.scrollTop - 29) <= 1,
      "The recovered renderer must restore the confirmed first visible row physically."
    );
    assert.ok(
      Math.abs(recoveredPhysicalViewport.scrollLeft - 23) <= 1,
      "The recovered renderer must restore the confirmed horizontal viewport physically."
    );
    recordAcceptanceProgress("verify:file-inputs:reconfigure:renderer-recovered");

    const activeTab = page
      .locator(".part.editor .editor-group-container.active .tabs-container .tab.active")
      .filter({ hasText: path.basename(configured.fsPath) })
      .last();
    const { action: tabImportAction } = await openEditorTabContextMenu(
      page,
      activeTab,
      "Open Wrangler: Change Import Options"
    );
    assert.ok(tabImportAction, "The generic Open Wrangler tab must expose Change Import Options.");
    await tabImportAction.click();
    const delimiterPrompt = await waitForImportQuickInput(page, testing, configured, "Delimiter", stableSessionId);
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.viewState.selectedColumnId === retainedViewState.selectedColumnId &&
          changed.metadata.schema.every((column) => active.viewState.columnWidths[column.id] === 640) &&
          active.viewState.viewport.firstVisibleRow === 1 &&
          active.viewState.viewport.scrollLeft === 23
        );
      },
      5_000,
      "the native import action to flush the physically confirmed renderer view"
    );
    const confirmedBeforeCancellation = stableImportReconfigurationSnapshot(testing.activeSession());
    const diagnosticsBeforeCancellation = stableImportDiagnostics(testing.diagnostics());
    await waitForImportNaturalKeyboardFocus(delimiterPrompt, "Delimiter", "contains");
    await withAcceptanceOperationDeadline(
      page.keyboard.press("Escape"),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the live import-options cancellation"
    );
    await withAcceptanceOperationDeadline(
      delimiterPrompt.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the cancelled live import-options prompt to close"
    );
    assert.deepEqual(
      stableImportReconfigurationSnapshot(testing.activeSession()),
      confirmedBeforeCancellation,
      "Cancelling import reconfiguration must preserve the exact confirmed active snapshot."
    );
    assert.deepEqual(
      stableImportDiagnostics(testing.diagnostics()),
      diagnosticsBeforeCancellation,
      "Cancelling import reconfiguration must not create, replace, or retain a runtime session."
    );

    const gridImportAction = await waitForExactSessionWebviewButton(page, testing, stableSessionId, "Import options");
    await gridImportAction.click();
    const gridDelimiterPrompt = await waitForImportQuickInput(page, testing, configured, "Delimiter", stableSessionId);
    await waitForImportNaturalKeyboardFocus(gridDelimiterPrompt, "Delimiter", "contains");
    await withAcceptanceOperationDeadline(
      page.keyboard.press("Escape"),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the live-grid import-options cancellation"
    );
    await withAcceptanceOperationDeadline(
      gridDelimiterPrompt.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the live-grid import-options prompt to close"
    );
    assert.deepEqual(
      stableImportReconfigurationSnapshot(testing.activeSession()),
      confirmedBeforeCancellation,
      "The live-grid Import options action must preserve the confirmed session when cancelled."
    );
    assert.deepEqual(
      stableImportDiagnostics(testing.diagnostics()),
      diagnosticsBeforeCancellation,
      "The live-grid Import options action must not create a candidate when its prompt is cancelled."
    );

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the reconfigured CSV panel to close cleanly"
    );
    // Runtime cleanup can finish before VS Code removes the closing session tab
    // and editor input. Opening the same URI as a custom editor during that gap
    // can race editor resolution, especially on macOS. Require the public tab
    // model to finish closing before the reload.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => vscode.window.tabGroups.all.every((group) => group.tabs.length === 0),
      10_000,
      "the reconfigured CSV session tab to close before same-source custom-editor reload"
    );
    const conflictingDefaultBackend = changed.metadata.backend === "pandas" ? "polars" : "pandas";
    await config.update("defaultBackend", conflictingDefaultBackend, vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand("vscode.openWith", configured, "openWrangler.viewer", vscode.ViewColumn.One);
      await waitFor(
        () => {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          return (
            input instanceof vscode.TabInputCustom &&
            input.viewType === "openWrangler.viewer" &&
            input.uri.toString() === configured.toString()
          );
        },
        10_000,
        "the fresh Open Wrangler custom-editor input for the confirmed source"
      );
      await waitFor(
        () => {
          const active = testing.activeSession();
          return (
            active?.metadata.source.path === configured.fsPath &&
            active.metadata.backend === changed.metadata.backend &&
            active.metadata.source.importOptions?.delimiter === ";" &&
            active.metadata.shape.rows === 80 &&
            active.metadata.shape.columns === 8 &&
            active.viewState.selectedColumnId === retainedColumn.id &&
            changed.metadata.schema.every((column) => active.viewState.columnWidths[column.id] === 640) &&
            active.viewState.viewport.firstVisibleRow === 1 &&
            active.viewState.viewport.scrollLeft === 23
          );
        },
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the custom editor to reload the last confirmed import options, backend, and view",
        () => {
          const active = testing.activeSession();
          return JSON.stringify({
            active: Boolean(active),
            sourceMatches: active?.metadata.source.path === configured.fsPath,
            backendMatches: active?.metadata.backend === changed.metadata.backend,
            importOptionsMatch:
              active?.metadata.source.importOptions?.delimiter === ";" &&
              active.metadata.source.importOptions.quoteChar === "'" &&
              active.metadata.source.importOptions.hasHeader === true,
            shapeMatches: active?.metadata.shape.rows === 80 && active.metadata.shape.columns === 8,
            selectedColumnMatches: active?.viewState.selectedColumnId === retainedColumn.id,
            widthsMatch:
              active !== undefined &&
              changed.metadata.schema.every((column) => active.viewState.columnWidths[column.id] === 640),
            firstVisibleRowMatches: active?.viewState.viewport.firstVisibleRow === 1,
            scrollLeftMatches: active?.viewState.viewport.scrollLeft === 23
          });
        }
      );
      assertExactBytes(
        readFileSync(configured.fsPath),
        configuredBytes,
        "Reloading the confirmed file configuration must not modify its source."
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        10_000,
        "the reloaded configurable CSV custom editor to close cleanly"
      );
      await config.update("defaultBackend", "auto", vscode.ConfigurationTarget.Global);
    }

    const damaged = vscode.Uri.file(path.join(directory, "damaged.csv"));
    const damagedBytes = readFileSync(damaged.fsPath);
    const generationBeforeFailure = testing.runtimeGeneration();
    await vscode.commands.executeCommand("vscode.openWith", damaged, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitFor(
      () =>
        testing.runtimeGeneration() > generationBeforeFailure &&
        testing.diagnostics().sessionCount === 0 &&
        !testing.runtimeRunning(),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the strict UTF-8 open to fail without retaining a corrupt file session"
    );
    assert.equal(testing.activeSession(), undefined, "The corrupt initial open must not publish an active session.");

    const errorImportAction = await waitForOpenWranglerWebviewButton(page, "Import options");
    await errorImportAction.click();
    await acceptDelimitedImportOptions(
      page,
      testing,
      damaged,
      undefined,
      "verify:file-inputs:reconfigure:damaged-options",
      {
        delimiter: "Comma",
        encoding: "utf8-lossy",
        header: "First row contains column names",
        quoteChar: '"'
      }
    );
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.path === damaged.fsPath &&
          active.metadata.backend === "pandas" &&
          active.metadata.shape.rows === 1 &&
          active.metadata.shape.columns === 2
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the failed file panel to retry successfully with lossy UTF-8"
    );
    const recovered = testing.activeSession();
    assert.ok(recovered, "The lossy UTF-8 retry must publish an active session.");
    assert.deepEqual(recovered.metadata.source.importOptions, {
      delimiter: ",",
      encoding: "utf8-lossy",
      quoteChar: '"',
      hasHeader: true
    });
    assertExactBytes(readFileSync(damaged.fsPath), damagedBytes, "Retrying a corrupt source must not modify it.");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the recovered corrupt-file panel to close cleanly"
    );
  }

  return exerciseLiveImportReconfiguration;
}
