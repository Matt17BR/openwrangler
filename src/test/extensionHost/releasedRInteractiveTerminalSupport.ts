import * as assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import { exportCleanedDataThroughWorkbench } from "./cleanedDataExport";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRInteractiveSupportActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;

interface ReleasedRInteractiveTerminalSupportDependencies {
  readonly RELEASED_R_SUPPORTED_OPERATIONS: readonly string[];
  readonly SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: number;
  readonly assertParquetFile: (filePath: string, label: string) => void;
  readonly assertReleasedProfileStat: (panel: Locator, label: string, expected: string) => Promise<void>;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ReleasedRInteractiveSupportActiveSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<unknown>;
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
  readonly withBoundedAcceptancePromise: <T>(
    promise: PromiseLike<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
}

export function createReleasedRInteractiveTerminalSupport({
  RELEASED_R_SUPPORTED_OPERATIONS,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  assertParquetFile,
  assertReleasedProfileStat,
  assertReleasedSessionPage,
  recordAcceptanceProgress,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor,
  withBoundedAcceptancePromise
}: ReleasedRInteractiveTerminalSupportDependencies) {
  async function createReleasedOfficialRTerminal(description: string): Promise<vscode.Terminal> {
    const before = new Set(vscode.window.terminals);
    await withBoundedAcceptancePromise(
      vscode.commands.executeCommand("r.createRTerm", true),
      30_000,
      `starting ${description} through the official R extension`
    );
    await waitFor(
      () =>
        vscode.window.terminals.filter((terminal) => !before.has(terminal) && isReleasedOfficialRTerminal(terminal))
          .length === 1,
      30_000,
      `${description} to create one identifiable official R terminal`
    );
    const terminal = vscode.window.terminals.find(
      (candidate) => !before.has(candidate) && isReleasedOfficialRTerminal(candidate)
    );
    assert.ok(terminal, `${description} must create one official R terminal.`);
    terminal.show(false);
    await waitFor(() => vscode.window.activeTerminal === terminal, 10_000, `${description} to become active`);
    return terminal;
  }

  function isReleasedOfficialRTerminal(terminal: vscode.Terminal): boolean {
    return terminal.name === "R" || terminal.name === "R Interactive";
  }

  async function seedReleasedRInteractiveFrames(
    terminal: vscode.Terminal,
    directory: string,
    firstOrderId: number,
    label: string
  ): Promise<void> {
    const marker = `__OW_R_INTERACTIVE_${label.toUpperCase()}_READY__`;
    const markerPath = path.join(directory, `${label}-ready.txt`);
    const code = [
      ".ow_row <- 0:239",
      `base_orders <- data.frame(order_id = ${firstOrderId} + .ow_row, market = rep(c('DACH', 'Nordics', 'Iberia', 'France'), length.out = 240), revenue = 100.5 + (.ow_row * 1.25), fulfilled = (.ow_row %% 3L) != 0L, order_date = as.Date('2026-01-01') + .ow_row, stringsAsFactors = FALSE)`,
      "tibble_orders <- tibble::as_tibble(base_orders)",
      "table_orders <- data.table::as.data.table(base_orders)",
      "rm(.ow_row)",
      `writeLines(${JSON.stringify(marker)}, ${JSON.stringify(markerPath)}, useBytes = TRUE)`
    ].join("; ");
    terminal.sendText(code, true);
    await waitFor(
      () => {
        if (!existsSync(markerPath)) return false;
        try {
          return readFileSync(markerPath, "utf8") === `${marker}\n`;
        } catch {
          return false;
        }
      },
      30_000,
      `${label} synthetic frames to finish in the exact R terminal`
    );
  }

  async function assertReleasedRInteractiveRows(operations: Locator): Promise<void> {
    for (const [name, flavor] of [
      ["base_orders", "data.frame"],
      ["tibble_orders", "tibble"],
      ["table_orders", "data.table"]
    ] as const) {
      const row = operations.getByRole("treeitem", { name: new RegExp(`^${name}\\b`, "u") }).first();
      await row.waitFor({ state: "visible", timeout: 30_000 });
      assert.match((await row.innerText()).replace(/\s+/gu, " "), new RegExp(`^${name}.*R · ${flavor}`, "u"));
    }
  }

  async function assertReleasedRInteractiveProfileEditingAndExport(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    directory: string
  ): Promise<void> {
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The active R terminal renderer must acknowledge its first complete snapshot."
    );
    let app = await releasedRSessionApp(workbench, testing, sessionId, "the active R terminal session");
    assert.equal((await app.locator('[data-session-badge="backend"]').innerText()).trim(), "R");
    assert.equal((await app.locator('[data-session-badge="mode"]').innerText()).trim(), "VIEWING");
    const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await columnSearch.fill("revenue");
    await app
      .getByRole("option", { name: /^revenue,/u })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await columnSearch.press("Enter");
    await app.getByRole("button", { name: "Column profiles and filters", exact: true }).click();
    const drawer = app.getByRole("complementary", { name: "Column profiles and filters", exact: true });
    const profile = drawer.getByRole("tabpanel");
    await profile.getByRole("heading", { name: "revenue", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await assertReleasedProfileStat(profile, "Rows", "240");
    await assertReleasedProfileStat(profile, "Min", "100.5");
    await assertReleasedProfileStat(profile, "Max", "399.25");
    await drawer.getByRole("button", { name: "Close panel", exact: true }).click();
    recordAcceptanceProgress("jupyter-r:interactive:profile-complete");

    app = await releasedRSessionApp(workbench, testing, sessionId, "the profiled active R terminal session");
    const beforeRevision = testing.activeSession()?.metadata.revision;
    assert.ok(beforeRevision !== undefined);
    await app.getByRole("button", { name: "Switch to Editing", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.mode === "editing" &&
          active.metadata.revision > beforeRevision
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the active R terminal dataframe to switch to Editing mode"
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The Editing-mode active R terminal renderer must acknowledge the replacement runtime."
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the editable active R terminal session");
    assert.equal((await app.locator('[data-session-badge="backend"]').innerText()).trim(), "R");
    assert.equal((await app.locator('[data-session-badge="mode"]').innerText()).trim(), "EDITING");
    const active = testing.activeSession();
    assert.ok(active, "The Editing-mode active R terminal session must remain confirmed.");
    assert.equal(active.metadata.rDataframeFlavor, "r.data.frame");
    assert.equal(active.metadata.capabilities.editable, true);
    assert.equal(active.metadata.capabilities.exportCsv, true);
    assert.equal(active.metadata.capabilities.exportParquet, true);
    assert.deepEqual(active.metadata.capabilities.supportedOperations, RELEASED_R_SUPPORTED_OPERATIONS);
    recordAcceptanceProgress("jupyter-r:interactive:editing-ready");

    recordAcceptanceProgress("jupyter-r:interactive:export-csv");
    const csvPath = path.join(directory, "base-orders.cleaned.csv");
    await exportCleanedDataThroughWorkbench(app, workbench, csvPath, "csv");
    await waitFor(() => existsSync(csvPath), 30_000, "the active R terminal CSV export to appear");
    const csvLines = readFileSync(csvPath, "utf8").trimEnd().split(/\r?\n/u);
    assert.equal(csvLines.length, 241, "The active R terminal CSV export must contain its header and all 240 rows.");
    assert.match(csvLines[0] ?? "", /order_id.*market.*revenue.*fulfilled.*order_date/u);
    assert.match(csvLines[1] ?? "", /3400001/u);

    recordAcceptanceProgress("jupyter-r:interactive:export-parquet");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the CSV-exported active R terminal session");
    const parquetPath = path.join(directory, "base-orders.cleaned.parquet");
    await exportCleanedDataThroughWorkbench(app, workbench, parquetPath, "parquet");
    await waitFor(() => existsSync(parquetPath), 30_000, "the active R terminal Parquet export to appear");
    assertParquetFile(parquetPath, "The active R terminal Parquet export");

    const afterExports = testing.activeSession();
    assert.ok(afterExports, "The active R terminal session must remain open after both exports.");
    assert.equal(afterExports.sessionId, sessionId);
    assert.equal(afterExports.metadata.revision, active.metadata.revision);
    assert.equal(afterExports.metadata.steps.length, 0);
    await assertReleasedSessionPage(testing, afterExports, "3400001", "jupyter-r-interactive-post-export-page");
    recordAcceptanceProgress("jupyter-r:interactive:export-complete");
  }

  function releasedRInteractiveMailboxRoots(): string[] {
    return readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("openwrangler-r-live-"))
      .map((entry) => path.join(tmpdir(), entry.name))
      .sort();
  }

  return {
    assertReleasedRInteractiveProfileEditingAndExport,
    assertReleasedRInteractiveRows,
    createReleasedOfficialRTerminal,
    isReleasedOfficialRTerminal,
    releasedRInteractiveMailboxRoots,
    seedReleasedRInteractiveFrames
  };
}
