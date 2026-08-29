import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import { assertExactBytes } from "./acceptanceSourceFixture";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import type { TestApi } from "./extensionHostTestApi";

export interface PackagedTrustedPickleJourneyDependencies {
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForOpenWranglerGridTarget: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string
  ) => Promise<unknown>;
  readonly waitForVisibleEditorDialog: (workbench: Page, text: string) => Promise<{ page: Page; dialog: Locator }>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: Thenable<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
  readonly SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: number;
  readonly WORKBENCH_OPERATION_TIMEOUT_MS: number;
  readonly WORKBENCH_PLAYWRIGHT_TIMEOUT_MS: number;
}

export function createPackagedTrustedPickleJourney({
  recordAcceptanceProgress,
  waitFor,
  waitForOpenWranglerGridTarget,
  waitForVisibleEditorDialog,
  withBoundedAcceptancePromise,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
}: PackagedTrustedPickleJourneyDependencies) {
  async function chooseTrustedPickleDestination(workbench: Page, destination: string): Promise<void> {
    const picker = workbench
      .locator(".quick-input-widget:visible")
      .filter({ hasText: "Convert Trusted Pickle to Parquet" })
      .last();
    await picker.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    const input = picker.locator(".quick-input-box input").first();
    await input.fill(path.resolve(destination));
    await input.press("Enter");
    await picker.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
  }

  return async function exercisePackagedTrustedPickleConversion(
    testing: TestApi,
    workbench: Page,
    testPython: string
  ): Promise<void> {
    assert.equal(testing.diagnostics().sessionCount, 0, "Pickle conversion must start without an open dataframe.");
    assert.equal(testing.runtimeRunning(), false, "Pickle conversion must start without the dataframe runtime.");

    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-trusted-pickle-"));
    const sourcePath = path.join(directory, "trusted-orders.pkl");
    const declinedPath = path.join(directory, "declined.parquet");
    const destinationPath = path.join(directory, "trusted-orders.parquet");
    const source = vscode.Uri.file(sourcePath);
    createHarmlessTrustedPickleFixture(testPython, sourcePath, directory);
    const sourceBytes = readFileSync(sourcePath);
    const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
    const initialWorkerRoots = trustedPickleWorkerRoots();
    const availableCommands = new Set(await vscode.commands.getCommands(true));

    try {
      recordAcceptanceProgress("platform-smoke:trusted-pickle:ordinary-open-rejected");
      const ordinaryOpen = vscode.commands.executeCommand("openWrangler.openFile", source);
      const unsupportedNotice = workbench
        .locator(
          ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
        )
        .filter({ hasText: "Open Wrangler supports CSV, TSV, Parquet, JSONL/NDJSON, XLSX, and XLS files." })
        .last();
      await unsupportedNotice.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      assert.equal(testing.activeSession(), undefined, "Ordinary Open must not create a pickle session.");
      assert.equal(testing.runtimeRunning(), false, "Ordinary Open must not start Python for a pickle.");
      if (availableCommands.has("notifications.clearAll")) {
        await vscode.commands.executeCommand("notifications.clearAll");
      } else {
        await workbench.keyboard.press("Escape");
      }
      await withBoundedAcceptancePromise(ordinaryOpen, WORKBENCH_OPERATION_TIMEOUT_MS, "the rejected pickle open");
      assert.equal(existsSync(declinedPath), false);
      assert.deepEqual(trustedPickleWorkerRoots(), initialWorkerRoots);

      recordAcceptanceProgress("platform-smoke:trusted-pickle:decline");
      const declined = vscode.commands.executeCommand<boolean>("openWrangler.convertTrustedPickle", source);
      await chooseTrustedPickleDestination(workbench, declinedPath);
      const declineDialog = await waitForVisibleEditorDialog(workbench, "Convert trusted-orders.pkl");
      await assertTrustedPickleWarning(declineDialog.dialog);
      await declineDialog.page.bringToFront();
      await declineDialog.page.keyboard.press("Escape");
      await declineDialog.dialog.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      assert.equal(
        await withBoundedAcceptancePromise(declined, WORKBENCH_OPERATION_TIMEOUT_MS, "declining pickle conversion"),
        false
      );
      assert.equal(existsSync(declinedPath), false, "Declining conversion must not create the chosen Parquet file.");
      assert.deepEqual(
        trustedPickleWorkerRoots(),
        initialWorkerRoots,
        "Declining must not leave a pickle worker root."
      );
      assert.deepEqual(
        trustedPickleSiblingTemporaries(directory),
        [],
        "Declining must not reserve a sibling temp file."
      );
      assert.equal(
        createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
        sourceDigest,
        "Declining conversion must preserve the pickle digest."
      );

      recordAcceptanceProgress("platform-smoke:trusted-pickle:convert");
      const converted = vscode.commands.executeCommand<boolean>("openWrangler.convertTrustedPickle", source);
      await chooseTrustedPickleDestination(workbench, destinationPath);
      const conversionDialog = await waitForVisibleEditorDialog(workbench, "Convert trusted-orders.pkl");
      await assertTrustedPickleWarning(conversionDialog.dialog);
      const convertButton = conversionDialog.dialog.getByRole("button", { name: "Convert", exact: true });
      assert.equal(await convertButton.count(), 1, "Trusted pickle conversion must have one explicit Convert action.");
      await convertButton.click({ timeout: WORKBENCH_OPERATION_TIMEOUT_MS, noWaitAfter: true });
      await conversionDialog.dialog.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });

      const completedNotice = workbench
        .locator(
          ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
        )
        .filter({ hasText: "Converted trusted-orders.pkl to trusted-orders.parquet." })
        .last();
      await completedNotice.waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(existsSync(destinationPath), true, "Confirmed conversion must publish the chosen Parquet file.");
      assert.deepEqual(
        trustedPickleWorkerRoots(),
        initialWorkerRoots,
        "The converter must remove its private worker root before reporting success."
      );
      assert.deepEqual(
        trustedPickleSiblingTemporaries(directory),
        [],
        "Publishing the Parquet file must leave no sibling transaction temp."
      );
      assertExactBytes(
        readFileSync(sourcePath),
        sourceBytes,
        "Successful trusted pickle conversion must leave the source byte-identical."
      );
      assert.equal(createHash("sha256").update(readFileSync(sourcePath)).digest("hex"), sourceDigest);

      const openAction = completedNotice.getByRole("button", { name: "Open in Open Wrangler", exact: true });
      assert.equal(await openAction.count(), 1, "The completed conversion notice must expose one Open action.");
      await openAction.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      await workbench.bringToFront();
      await openAction.focus({ timeout: WORKBENCH_OPERATION_TIMEOUT_MS });
      const actionState = await openAction.evaluate((element) => ({
        connected: element.isConnected,
        focused: element.ownerDocument.activeElement === element
      }));
      assert.deepEqual(actionState, { connected: true, focused: true });
      await openAction.press("Enter", { timeout: WORKBENCH_OPERATION_TIMEOUT_MS });
      recordAcceptanceProgress("platform-smoke:trusted-pickle:open-action-dispatched");
      assert.equal(
        await withBoundedAcceptancePromise(
          converted,
          WORKBENCH_OPERATION_TIMEOUT_MS,
          "the trusted pickle completion action"
        ),
        true
      );
      recordAcceptanceProgress("platform-smoke:trusted-pickle:open");
      await waitFor(
        () => testing.activeSession()?.metadata.source.path === vscode.Uri.file(destinationPath).fsPath,
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the converted Parquet file to open in Open Wrangler"
      );
      const active = testing.activeSession();
      assert.ok(active, "Opening the converted Parquet file must publish a dataframe session.");
      assert.deepEqual(active.metadata.shape, { rows: 3, columns: 3 });
      assert.deepEqual(
        active.metadata.schema.map((column) => column.name),
        ["order_id", "market", "revenue"]
      );
      const page = await testing.request({
        kind: "getPage",
        sessionId: active.sessionId,
        revision: active.metadata.revision,
        viewRequestId: "packaged-trusted-pickle-page",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 3,
        filterModel: active.metadata.filterModel
      });
      assert.equal(page.kind, "page");
      if (page.kind !== "page") throw new Error("The converted Parquet file did not return its first grid page.");
      assert.deepEqual(
        page.page.rows.map((row) => row.values.map((cell) => cell.display)),
        [
          ["2400001", "DACH", "620.5"],
          ["2400002", "Nordics", "699.69"],
          ["2400003", "Iberia", "778.88"]
        ]
      );
      await waitForOpenWranglerGridTarget(workbench, testing, active.sessionId);

      recordAcceptanceProgress("platform-smoke:trusted-pickle:cleanup");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        15_000,
        "the converted Parquet session and dataframe runtime to stop"
      );
      assert.deepEqual(testing.diagnostics().sessions, []);
      assert.deepEqual(trustedPickleWorkerRoots(), initialWorkerRoots);
      assert.deepEqual(trustedPickleSiblingTemporaries(directory), []);
      assertExactBytes(readFileSync(sourcePath), sourceBytes, "Pickle acceptance cleanup must preserve the source.");
    } finally {
      await workbench.keyboard.press("Escape").catch(() => {});
      if (availableCommands.has("notifications.clearAll")) {
        await vscode.commands.executeCommand("notifications.clearAll").then(undefined, () => undefined);
      }
      await vscode.commands.executeCommand("workbench.action.closeAllEditors").then(undefined, () => undefined);
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        15_000,
        "trusted pickle acceptance cleanup"
      );
      cleanupAcceptanceTemporaryDirectory(directory);
    }
  };
}

function createHarmlessTrustedPickleFixture(python: string, destination: string, cwd: string): void {
  const source = [
    "import pandas as pd",
    "import sys",
    "frame = pd.DataFrame({",
    "    'order_id': [2400001, 2400002, 2400003],",
    "    'market': ['DACH', 'Nordics', 'Iberia'],",
    "    'revenue': [620.5, 699.69, 778.88],",
    "})",
    "frame.to_pickle(sys.argv[1])"
  ].join("\n");
  execFileSync(python, ["-I", "-c", source, destination], {
    cwd,
    stdio: "ignore",
    timeout: 30_000,
    windowsHide: true
  });
}

async function assertTrustedPickleWarning(dialog: Locator): Promise<void> {
  const message = await dialog.locator(".dialog-message-text").innerText();
  const detail = await dialog.locator(".dialog-message-detail").innerText();
  const prefix = "Convert trusted-orders.pkl with ";
  assert.ok(message.startsWith(prefix) && message.endsWith("?"));
  const python = message.slice(prefix.length, -1);
  assert.ok(path.isAbsolute(python), "The warning must name the resolved absolute Python interpreter.");
  assert.equal(
    detail,
    "Loading a pickle can run Python code with your user permissions. Continue only if you trust trusted-orders.pkl, " +
      `know where it came from, and know it has not been modified. Open Wrangler will use ${python}. ` +
      "The conversion output goes to a separate Parquet file; Open Wrangler does not overwrite the pickle."
  );
}

function trustedPickleWorkerRoots(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("openwrangler-pickle-"))
    .map((entry) => entry.name)
    .sort();
}

function trustedPickleSiblingTemporaries(directory: string): string[] {
  return readdirSync(directory)
    .filter((entry) => /^\.openwrangler-.+-\d+\.tmp$/u.test(entry))
    .sort();
}
