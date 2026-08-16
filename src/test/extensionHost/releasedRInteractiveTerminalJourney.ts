import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import type { TestApi } from "./extensionHostTestApi";
import { pollAcceptanceCondition } from "./playwrightLifecycle";

type ReleasedRInteractiveActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;

interface ReleasedRInteractiveTerminalJourneyDependencies {
  readonly GRID_COLUMN_WINDOW: Readonly<{ columnOffset: number; columnLimit: number }>;
  readonly SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: number;
  readonly arrangePackagedProductSidebar: (workbench: Page, scene: "operation-catalog") => Promise<Locator>;
  readonly assertReleasedRInteractiveProfileEditingAndExport: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    directory: string
  ) => Promise<void>;
  readonly assertReleasedRInteractiveRows: (operations: Locator) => Promise<void>;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ReleasedRInteractiveActiveSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<unknown>;
  readonly assertReleasedWorkbenchHasNoBlockingDialog: (workbench: Page, checkpoint: string) => Promise<void>;
  readonly createReleasedOfficialRTerminal: (description: string) => Promise<vscode.Terminal>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly invokeReleasedRInteractiveTitleAction: (
    workbench: Page,
    directory: string,
    variableName: string
  ) => Promise<void>;
  readonly isReleasedOfficialRTerminal: (terminal: vscode.Terminal) => boolean;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedRInteractiveMailboxRoots: () => string[];
  readonly seedReleasedRInteractiveFrames: (
    terminal: vscode.Terminal,
    directory: string,
    firstOrderId: number,
    label: string
  ) => Promise<void>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: PromiseLike<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
}

export function createReleasedRInteractiveTerminalJourney({
  GRID_COLUMN_WINDOW,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  arrangePackagedProductSidebar,
  assertReleasedRInteractiveProfileEditingAndExport,
  assertReleasedRInteractiveRows,
  assertReleasedSessionPage,
  assertReleasedWorkbenchHasNoBlockingDialog,
  createReleasedOfficialRTerminal,
  disposePackagedSessionPanel,
  invokeReleasedRInteractiveTitleAction,
  isReleasedOfficialRTerminal,
  recordAcceptanceProgress,
  releasedRInteractiveMailboxRoots,
  seedReleasedRInteractiveFrames,
  waitFor,
  withBoundedAcceptancePromise
}: ReleasedRInteractiveTerminalJourneyDependencies) {
  return async function exerciseReleasedRInteractiveTerminalJourney(testing: TestApi, workbench: Page): Promise<void> {
    recordAcceptanceProgress("jupyter-r:interactive:start");
    assert.equal(vscode.workspace.isTrusted, true, "Inspecting the active R session requires a trusted workspace.");
    assert.equal(testing.diagnostics().sessionCount, 0, "The active R journey must start without another session.");
    const existingRTerminals = vscode.window.terminals.filter(isReleasedOfficialRTerminal);
    assert.equal(
      existingRTerminals.length,
      0,
      `The active R journey must start without an earlier official R terminal; found ${
        existingRTerminals.map((terminal) => terminal.name).join(", ") || "none"
      }.`
    );
    await assertReleasedWorkbenchHasNoBlockingDialog(workbench, "before starting the first active R terminal");
    const commands = new Set(await vscode.commands.getCommands(true));
    assert.ok(commands.has("r.createRTerm"), "The pinned official R extension must expose r.createRTerm.");

    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-r-interactive-"));
    const initialMailboxes = releasedRInteractiveMailboxRoots();
    const configuration = vscode.workspace.getConfiguration("openWrangler");
    const originalNotebookStartMode = configuration.inspect<"viewing" | "editing">("notebookStartMode")?.workspaceValue;
    let sourceTerminal: vscode.Terminal | undefined;
    let replacementTerminal: vscode.Terminal | undefined;
    let sessionId: string | undefined;

    try {
      await configuration.update("notebookStartMode", "viewing", vscode.ConfigurationTarget.Workspace);

      recordAcceptanceProgress("jupyter-r:interactive:first-terminal");
      sourceTerminal = await createReleasedOfficialRTerminal("the first active R session");
      await assertReleasedWorkbenchHasNoBlockingDialog(workbench, "after starting the first active R terminal");
      await seedReleasedRInteractiveFrames(sourceTerminal, directory, 2_400_001, "first");
      recordAcceptanceProgress("jupyter-r:interactive:first-terminal:seeded");
      assert.equal(vscode.window.activeTerminal, sourceTerminal, "Discovery must stay on the exact active R terminal.");
      let sidebar = await arrangePackagedProductSidebar(workbench, "operation-catalog");
      let operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
      await assertReleasedRInteractiveRows(operations);
      assert.deepEqual(
        releasedRInteractiveMailboxRoots(),
        initialMailboxes,
        "Automatic vscode-R workspace discovery must not bootstrap the native terminal bridge."
      );
      sourceTerminal.sendText("callback_orders <- data.frame(id = 1:3)", true);
      await operations
        .getByRole("treeitem", { name: /^callback_orders\b/u })
        .waitFor({ state: "visible", timeout: 30_000 });
      assert.deepEqual(
        releasedRInteractiveMailboxRoots(),
        initialMailboxes,
        "A later user expression must still update Operations without an Open Wrangler terminal bootstrap."
      );
      recordAcceptanceProgress("jupyter-r:interactive:first-terminal:discovery-complete");

      recordAcceptanceProgress("jupyter-r:interactive:first-terminal-close");
      sourceTerminal.dispose();
      await waitFor(
        () => sourceTerminal !== undefined && !vscode.window.terminals.includes(sourceTerminal),
        10_000,
        "the first official R terminal to close"
      );
      assert.equal(
        await pollAcceptanceCondition(
          async () => (await operations.getByRole("treeitem", { name: /^base_orders\b/u }).count()) === 0,
          { timeoutMs: 10_000, intervalMs: 50 }
        ),
        true,
        "Closing the terminal must invalidate its cached Operations rows."
      );
      await operations
        .getByRole("treeitem", { name: /^Start R and show dataframes\b/u })
        .waitFor({ state: "visible", timeout: 10_000 });
      assert.deepEqual(releasedRInteractiveMailboxRoots(), initialMailboxes);
      if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
      sourceTerminal = undefined;

      recordAcceptanceProgress("jupyter-r:interactive:replacement-terminal");
      replacementTerminal = await createReleasedOfficialRTerminal("the replacement active R session");
      await seedReleasedRInteractiveFrames(replacementTerminal, directory, 3_400_001, "replacement");
      recordAcceptanceProgress("jupyter-r:interactive:replacement-terminal:seeded");
      assert.equal(vscode.window.activeTerminal, replacementTerminal, "The replacement R terminal must be active.");

      sidebar = await arrangePackagedProductSidebar(workbench, "operation-catalog");
      operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
      await assertReleasedRInteractiveRows(operations);
      assert.deepEqual(releasedRInteractiveMailboxRoots(), initialMailboxes);
      recordAcceptanceProgress("jupyter-r:interactive:open-base-frame");
      await invokeReleasedRInteractiveTitleAction(workbench, directory, "base_orders");
      await waitFor(
        () => releasedRInteractiveMailboxRoots().length === initialMailboxes.length + 1,
        10_000,
        "the explicitly opened R dataframe to bootstrap one private mailbox"
      );
      await waitFor(
        () => {
          const active = testing.activeSession();
          return (
            active?.metadata.source.kind === "rInteractiveVariable" &&
            active.metadata.source.variableName === "base_orders" &&
            active.metadata.backend === "r" &&
            active.metadata.rDataframeFlavor === "r.data.frame"
          );
        },
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the base data.frame selected from Operations to open",
        () => JSON.stringify(testing.diagnostics())
      );
      const opened = testing.activeSession();
      assert.ok(opened, "The active R terminal selection must publish a session.");
      sessionId = opened.sessionId;
      assert.equal(opened.metadata.mode, "viewing");
      assert.deepEqual(opened.metadata.shape, { rows: 240, columns: 5 });
      assert.equal(opened.metadata.capabilities.notebookInsert, false);
      assert.notEqual(opened.metadata.capabilities.documentInsert, true);
      recordAcceptanceProgress("jupyter-r:interactive:session-opened");
      await assertReleasedSessionPage(testing, opened, "3400001", "jupyter-r-interactive-page");
      await assertReleasedRInteractiveProfileEditingAndExport(testing, workbench, opened.sessionId, directory);

      recordAcceptanceProgress("jupyter-r:interactive:replacement-terminal-close");
      const confirmed = testing.activeSession();
      assert.ok(confirmed, "The active R terminal session must remain confirmed before terminal close.");
      replacementTerminal.dispose();
      await waitFor(
        () => replacementTerminal !== undefined && !vscode.window.terminals.includes(replacementTerminal),
        10_000,
        "the replacement official R terminal to close"
      );
      const stale = await withBoundedAcceptancePromise(
        testing.request({
          kind: "getPage",
          ...GRID_COLUMN_WINDOW,
          viewRequestId: "jupyter-r-interactive-terminal-closed",
          sessionId: confirmed.sessionId,
          revision: confirmed.metadata.revision,
          offset: 0,
          limit: 10,
          filterModel: confirmed.viewState.filterModel
        }),
        10_000,
        "the active R page after its exact terminal closed"
      );
      assert.equal(stale.kind, "error");
      if (stale.kind !== "error") throw new Error("A closed R terminal unexpectedly returned a dataframe page.");
      assert.equal(stale.code, "r_kernel_changed");
      assert.equal(stale.recoverable, true);
      await disposePackagedSessionPanel(testing, confirmed.sessionId, "the terminal-invalidated active R session");
      sessionId = undefined;
      await waitFor(
        () => isDeepStrictEqual(releasedRInteractiveMailboxRoots(), initialMailboxes),
        10_000,
        "the closed active R session to remove its private mailbox"
      );
      replacementTerminal = undefined;
      recordAcceptanceProgress("jupyter-r:interactive:complete");
    } finally {
      if (sessionId) await testing.disposePanelForSession(sessionId).catch(() => undefined);
      sourceTerminal?.dispose();
      replacementTerminal?.dispose();
      await configuration.update("notebookStartMode", originalNotebookStartMode, vscode.ConfigurationTarget.Workspace);
      await waitFor(
        () => isDeepStrictEqual(releasedRInteractiveMailboxRoots(), initialMailboxes),
        10_000,
        "active R acceptance cleanup to remove every private mailbox"
      );
      cleanupAcceptanceTemporaryDirectory(directory);
    }
  };
}
