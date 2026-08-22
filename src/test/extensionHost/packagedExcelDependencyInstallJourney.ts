import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import * as path from "node:path";
import type { Browser, Frame, Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import { exactSessionApp } from "./acknowledgedRenderer";
import { assertExactBytes } from "./acceptanceSourceFixture";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import {
  createExcelDependencyInstallPython,
  createPackagedExcelDependencyWorkbook
} from "./excelDependencyInstallFixture";
import type { TestApi } from "./extensionHostTestApi";
import {
  ignoreRetiredRendererProbeFailure,
  isRetiredRendererTarget,
  pollAcceptanceCondition,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";
import { verifyRecoveredExcelGrid as verifyRecoveredExcelGridOwner } from "./recoveredExcelGrid";

interface PackagedExcelWebviewTarget {
  readonly page: Page;
  readonly frame: Frame;
  readonly pageIndex: number;
  readonly frameIndex: number;
  readonly isWorkbenchPage: boolean;
  readonly isMainFrame: boolean;
  readonly protocol: string;
  readonly isWebview: boolean;
  readonly isOpenWranglerWebview: boolean;
}

interface PackagedExcelWebviewAction {
  readonly target: PackagedExcelWebviewTarget;
  readonly action: Locator;
}

export interface PackagedExcelDependencyInstallJourneyDependencies {
  readonly OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS: number;
  readonly SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: number;
  readonly WORKBENCH_OPERATION_TIMEOUT_MS: number;
  readonly WORKBENCH_PLAYWRIGHT_TIMEOUT_MS: number;
  readonly activeEditorTabDiagnostic: () => Record<string, boolean | string>;
  readonly assertOpenWranglerWebviewLifecycle: (workbench: Page, browser: Browser | null) => void;
  readonly closeVisibleWorkbenchPart: (
    workbench: Page,
    selector: string,
    commandCandidates: readonly string[]
  ) => Promise<void>;
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly excelDependencyInstallDiagnostics: (
    testing: TestApi,
    expectedSourcePath: string,
    expectedExecutable: string,
    markerExists: boolean,
    invocationExists: boolean
  ) => string;
  readonly findCurrentOpenWranglerGridTarget: (
    workbench: Page,
    browser: Browser | null,
    testing: TestApi,
    expectedSessionId: string,
    expectedRendererSynchronizationReceipt?: Readonly<{ syncId: string; sessionId: string; revision: number }>,
    deadline?: number
  ) => Promise<PackagedExcelWebviewTarget | undefined>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForOpenWranglerWebviewAction: (
    workbench: Page,
    name: string,
    requireEnabled?: boolean
  ) => Promise<PackagedExcelWebviewAction>;
  readonly waitForVisibleEditorDialog: (workbench: Page, text: string) => Promise<{ page: Page; dialog: Locator }>;
}

export function createPackagedExcelDependencyInstallJourney({
  OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
  activeEditorTabDiagnostic,
  assertOpenWranglerWebviewLifecycle,
  closeVisibleWorkbenchPart,
  connectToEditorWorkbench,
  excelDependencyInstallDiagnostics,
  findCurrentOpenWranglerGridTarget,
  recordAcceptanceProgress,
  waitFor,
  waitForOpenWranglerWebviewAction,
  waitForVisibleEditorDialog
}: PackagedExcelDependencyInstallJourneyDependencies) {
  return async function exercisePackagedExcelDependencyInstall(
    testing: TestApi,
    workspace: vscode.Uri,
    python: string
  ): Promise<void> {
    assert.ok(
      process.env.OPEN_WRANGLER_EDITOR_CDP_PORT,
      "The XLSX dependency-install journey requires the isolated native editor workbench."
    );
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "The XLSX dependency-install journey must start without another dataframe session."
    );
    assert.equal(
      testing.runtimeRunning(),
      false,
      "The XLSX dependency-install journey must start without a live dataframe runtime."
    );

    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-excel-install-"));
    const workbookPath = path.join(directory, "regional-orders.xlsx");
    createPackagedExcelDependencyWorkbook(workbookPath, python);
    const workbook = vscode.Uri.file(workbookPath);
    const workbookBytes = readFileSync(workbookPath);
    const dependency = createExcelDependencyInstallPython(directory, python);
    const config = vscode.workspace.getConfiguration("openWrangler", workspace);
    const originalWorkspacePythonPath = config.inspect<string>("pythonPath")?.workspaceValue;
    const originalGlobalBackend = config.inspect<"auto" | "polars" | "duckdb" | "pandas">(
      "defaultBackend"
    )?.globalValue;
    const workbench = await connectToEditorWorkbench();

    try {
      await workbench.bringToFront();
      await closeVisibleWorkbenchPart(workbench, ".part.panel", [
        "workbench.action.closePanel",
        "workbench.action.togglePanel"
      ]);
      recordAcceptanceProgress("excel-dependency-install:layout-isolated");

      await config.update("defaultBackend", "pandas", vscode.ConfigurationTarget.Global);
      assert.equal(
        await vscode.commands.executeCommand("openWrangler.changeRuntime", dependency.executable),
        dependency.executable,
        "The public runtime command must select the disposable dependency environment."
      );
      assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, dependency.executable);

      recordAcceptanceProgress("excel-dependency-install:open");
      await vscode.commands.executeCommand("vscode.openWith", workbook, "openWrangler.viewer", vscode.ViewColumn.One);
      await waitFor(
        () => {
          const response = testing.panelOpenResponse();
          return response?.kind === "error" && response.code === "missing_dependencies";
        },
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the XLSX panel to report its exact missing dependency",
        () =>
          JSON.stringify({
            response: testing.panelOpenResponse(),
            coordinator: testing.diagnostics(),
            runtimeRunning: testing.runtimeRunning(),
            runtimeEnvironment: testing.runtimeEnvironment()
          })
      );
      const missing = testing.panelOpenResponse();
      assert.equal(missing?.kind, "error");
      if (missing?.kind !== "error") throw new Error("The XLSX dependency error was replaced unexpectedly.");
      assert.equal(missing.code, "missing_dependencies");
      assert.match(missing.message, /cannot open this source with Pandas\. Missing: openpyxl>=3\.1\.5,<4\.$/u);
      assert.doesNotMatch(missing.message, /fastexcel|polars|xlrd/iu);
      assert.equal(testing.activeSession(), undefined);
      assert.equal(testing.diagnostics().sessionCount, 0);
      assert.equal(testing.runtimeRunning(), false, "Missing Excel support must fail before runtime startup.");
      assert.equal(existsSync(dependency.marker), false, "The fake installation marker must not exist before consent.");
      assert.equal(existsSync(dependency.invocation), false, "The private fake pip must not run before consent.");
      assert.equal(
        existsSync(dependency.integrityChecks),
        false,
        "No pip-owned integrity command may run before exact install consent."
      );
      assertExactBytes(readFileSync(workbookPath), workbookBytes, "The failed XLSX open must not modify the workbook.");

      const initialInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(
        initialInput instanceof vscode.TabInputCustom,
        "The failed XLSX open must retain its custom-editor tab."
      );
      assert.equal(initialInput.viewType, "openWrangler.viewer");
      assert.equal(initialInput.uri.toString(), workbook.toString());
      const install = await waitForOpenWranglerWebviewAction(workbench, "Install required dependency", true);
      const errorAlert = install.target.frame.getByRole("alert").filter({ hasText: "openpyxl>=3.1.5,<4" }).first();
      await errorAlert.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      assert.match(
        await errorAlert.innerText(),
        /cannot open this source with Pandas\. Missing: openpyxl>=3\.1\.5,<4\.$/u
      );

      recordAcceptanceProgress("excel-dependency-install:request");
      await withAcceptanceOperationDeadline(
        install.action.click({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS, noWaitAfter: true }),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        "the XLSX error panel dependency-install action"
      );
      const { page: confirmationPage, dialog: confirmation } = await waitForVisibleEditorDialog(
        workbench,
        "Install openpyxl>=3.1.5,<4"
      );
      await confirmationPage.bringToFront();
      assert.equal(
        await confirmation.locator(".dialog-message-text").innerText(),
        `Install openpyxl>=3.1.5,<4 into ${dependency.executable}?`
      );
      assert.equal(
        await confirmation.locator(".dialog-message-detail").innerText(),
        "Open Wrangler never installs packages without this confirmation."
      );
      const installButton = confirmation.getByRole("button", { name: "Install", exact: true });
      assert.equal(
        await installButton.count(),
        1,
        "The XLSX dependency modal must expose exactly one affirmative Install action."
      );
      assert.equal(await installButton.isVisible(), true, "The XLSX dependency Install action must be visible.");
      assert.equal(await installButton.isEnabled(), true, "The XLSX dependency Install action must be enabled.");
      await confirmationPage.mouse.move(1, 1);
      await confirmationPage
        .locator(".monaco-hover:visible")
        .waitFor({ state: "hidden", timeout: 1_000 })
        .catch(() => {});

      recordAcceptanceProgress("excel-dependency-install:confirm");
      await withAcceptanceOperationDeadline(
        installButton.click({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS, noWaitAfter: true }),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        "the literal XLSX dependency Install confirmation"
      );
      await confirmation.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      await waitFor(
        () => existsSync(dependency.marker) && existsSync(dependency.invocation),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        "the private fake pip invocation and install marker"
      );
      recordAcceptanceProgress("excel-dependency-install:marker-created");

      const installedNotice = workbench
        .locator(".notifications-toasts .notification-toast:visible")
        .filter({ hasText: "Open Wrangler runtime dependencies were installed." })
        .last();
      await installedNotice.waitFor({ state: "visible", timeout: WORKBENCH_OPERATION_TIMEOUT_MS });
      const notificationCommands = new Set(await vscode.commands.getCommands(true));
      assert.ok(
        notificationCommands.has("notifications.hideToasts"),
        "The XLSX dependency journey requires the native command that hides acknowledged notification toasts."
      );
      await vscode.commands.executeCommand("notifications.hideToasts");
      const visibleNotificationToasts = workbench.locator(".notifications-toasts .notification-toast:visible");
      assert.equal(
        await pollAcceptanceCondition(async () => (await visibleNotificationToasts.count()) === 0, {
          timeoutMs: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
          intervalMs: 50
        }),
        true,
        "The XLSX dependency journey must hide every acknowledged workbench toast before grid activation."
      );
      recordAcceptanceProgress("excel-dependency-install:notification-hidden");

      await waitFor(
        () => {
          const active = testing.activeSession();
          // The custom editor publishes VS Code's canonical Uri.fsPath spelling;
          // raw os.tmpdir() paths may retain different drive-letter casing on Windows.
          return (
            active?.metadata.source.path === workbook.fsPath &&
            active.metadata.backend === "pandas" &&
            active.metadata.shape.rows === 64 &&
            active.metadata.shape.columns === 6
          );
        },
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the same XLSX panel to reopen as a usable Pandas grid",
        () =>
          excelDependencyInstallDiagnostics(
            testing,
            workbook.fsPath,
            dependency.executable,
            existsSync(dependency.marker),
            existsSync(dependency.invocation)
          )
      );
      const active = testing.activeSession();
      assert.ok(active, "The confirmed XLSX dependency install must publish an active session.");
      recordAcceptanceProgress("excel-dependency-install:session-published");
      const matchingTabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => {
          const input = tab.input;
          return (
            input instanceof vscode.TabInputCustom &&
            input.viewType === "openWrangler.viewer" &&
            input.uri.toString() === workbook.toString()
          );
        });
      assert.equal(
        matchingTabs.length,
        1,
        "Dependency recovery must retain exactly one custom-editor tab for the XLSX source."
      );
      const recoveredTab = matchingTabs[0];
      assert.ok(recoveredTab, "The recovered XLSX custom-editor tab must remain available.");
      assert.equal(recoveredTab.isActive, true, "The recovered XLSX custom-editor tab must remain active.");
      const recoveredInput = recoveredTab.input;
      assert.ok(recoveredInput instanceof vscode.TabInputCustom);
      assert.equal(recoveredInput.viewType, "openWrangler.viewer");
      assert.equal(recoveredInput.uri.toString(), workbook.toString());
      recordAcceptanceProgress("excel-dependency-install:tab-continuity");
      await waitFor(
        () => testing.panelHydrated(active.sessionId),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the recovered XLSX panel to acknowledge its live snapshot",
        () =>
          JSON.stringify({
            activeSessionId: testing.activeSession()?.sessionId,
            activeRevision: testing.activeSession()?.metadata.revision,
            panelHydrated: testing.panelHydrated(active.sessionId),
            panelSynchronizable: testing.panelSynchronizable(active.sessionId),
            panelSynchronizationReceipt: testing.panelSynchronizationReceipt(active.sessionId),
            activeTab: activeEditorTabDiagnostic()
          })
      );
      recordAcceptanceProgress("excel-dependency-install:renderer-hydrated");
      await verifyRecoveredExcelGridOwner({
        sessionId: active.sessionId,
        revision: active.metadata.revision,
        sourceLabel: active.metadata.source.label,
        discoveryTimeoutMs: OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
        operationTimeoutMs: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
        activeSession: () => testing.activeSession(),
        currentReceipt: () => testing.panelSynchronizationReceipt(active.sessionId),
        panelHydrated: () => testing.panelHydrated(active.sessionId),
        panelSynchronizable: () => testing.panelSynchronizable(active.sessionId),
        activeTabDiagnostic: activeEditorTabDiagnostic,
        findCurrentTarget: async (receipt, deadline) => {
          const browser = workbench.context().browser();
          const target = await findCurrentOpenWranglerGridTarget(
            workbench,
            browser,
            testing,
            active.sessionId,
            receipt,
            deadline
          );
          return target ? { browser, target } : undefined;
        },
        bindExactApp: ({ target }, synchronizationId) =>
          exactSessionApp(target.frame, active.sessionId, synchronizationId),
        targetIsRetired: ({ target }) => isRetiredRendererTarget(workbench, target.page, target.frame),
        assertTargetLifecycle: ({ browser }) => assertOpenWranglerWebviewLifecycle(workbench, browser),
        ignoreRetiredProbeFailure: ({ browser, target }, error) =>
          ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error),
        pressTargetKey: ({ target }, key) => target.page.keyboard.press(key),
        recordProgress: recordAcceptanceProgress,
        wait: (durationMs) => workbench.waitForTimeout(durationMs)
      });

      const page = await testing.request({
        kind: "getPage",
        sessionId: active.sessionId,
        revision: active.metadata.revision,
        viewRequestId: "packaged-excel-dependency-install-page",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 6,
        filterModel: active.metadata.filterModel
      });
      assert.equal(page.kind, "page", "The recovered XLSX session must return a live page.");
      if (page.kind !== "page") throw new Error("The recovered XLSX session did not return its grid page.");
      assert.equal(page.page.totalRows, 64);
      assert.deepEqual(
        page.metadata.schema.map((column) => column.name),
        ["order_id", "market", "revenue", "fulfilled", "order_date", "account_status"]
      );
      assert.deepEqual(
        page.page.rows[0]?.values.map((cell) => cell.display),
        ["OW-240001", "DACH", "620.5", "True", "2026-01-01", "Active"]
      );
      recordAcceptanceProgress("excel-dependency-install:runtime-page");

      const invocation = JSON.parse(readFileSync(dependency.invocation, "utf8")) as Record<string, unknown>;
      assert.deepEqual(invocation.args, ["install", "--no-input", "--no-user", "--", "openpyxl>=3.1.5,<4"]);
      assert.equal(invocation.pipNoInput, "1");
      assert.equal(invocation.pipUser, "0");
      assert.equal(invocation.pipConfigFile, process.platform === "win32" ? "nul" : devNull);
      assert.equal(invocation.pythonPathPresent, false);
      assert.equal(invocation.pythonHomePresent, false);
      assert.match(path.basename(String(invocation.cwd)), /^openwrangler-pip-/u);
      assert.equal(readFileSync(dependency.marker, "utf8"), "openpyxl>=3.1.5,<4\n");
      assert.equal(
        readFileSync(dependency.integrityChecks, "utf8"),
        "clean\nclean\nclean\n",
        "The confirmed mutation must run one pre-write, one post-write, and one recovery validation check."
      );
      assertExactBytes(
        readFileSync(workbookPath),
        workbookBytes,
        "Installing and reprobeing XLSX support must leave the source workbook byte-identical."
      );
      recordAcceptanceProgress("excel-dependency-install:install-contract");

      recordAcceptanceProgress("excel-dependency-install:close");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        15_000,
        "the recovered XLSX session and private runtime to terminate"
      );
      assert.deepEqual(testing.diagnostics().sessions, []);
      assertExactBytes(
        readFileSync(workbookPath),
        workbookBytes,
        "Closing the recovered XLSX grid must leave the source workbook byte-identical."
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors").then(undefined, () => undefined);
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        15_000,
        "XLSX dependency-install cleanup to release its session and runtime"
      );
      try {
        await config.update("pythonPath", originalWorkspacePythonPath, vscode.ConfigurationTarget.Workspace);
      } finally {
        try {
          await config.update("defaultBackend", originalGlobalBackend, vscode.ConfigurationTarget.Global);
        } finally {
          cleanupAcceptanceTemporaryDirectory(directory);
        }
      }
    }
  };
}
