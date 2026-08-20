import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import { createDependencyInstallLifecyclePython } from "./dependencyInstallLifecycleFixture";
import type { TestApi } from "./extensionHostTestApi";

interface DependencyInstallGridColumnWindow {
  readonly columnOffset: number;
  readonly columnLimit: number;
}

export interface DependencyInstallShutdownJourneyDependencies {
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly gridColumnWindow: DependencyInstallGridColumnWindow;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, description: string) => Promise<void>;
  readonly waitForVisibleEditorDialog: (
    workbench: Page,
    text: string
  ) => Promise<{ readonly page: Page; readonly dialog: Locator }>;
  readonly workbenchOperationTimeoutMs: number;
}

export function createDependencyInstallShutdownJourney({
  connectToEditorWorkbench,
  gridColumnWindow,
  recordAcceptanceProgress,
  waitFor,
  waitForVisibleEditorDialog,
  workbenchOperationTimeoutMs
}: DependencyInstallShutdownJourneyDependencies): (testing: TestApi, python: string) => Promise<void> {
  return async function exerciseDependencyInstallShutdownLifecycle(testing: TestApi, python: string): Promise<void> {
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "Dependency-install shutdown acceptance must start after every dataframe session closed."
    );
    assert.equal(
      testing.runtimeRunning(),
      false,
      "Dependency-install shutdown acceptance must start without a live dataframe runtime."
    );

    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-dependency-shutdown-"));
    const lifecycle = createDependencyInstallLifecyclePython(directory, python);
    const config = vscode.workspace.getConfiguration("openWrangler");
    const originalWorkspacePythonPath = config.inspect<string>("pythonPath")?.workspaceValue;
    let shutdown: Promise<void> | undefined;
    let shutdownConfirmed = false;

    try {
      assert.equal(
        await vscode.commands.executeCommand("openWrangler.changeRuntime", lifecycle.executable),
        lifecycle.executable
      );
      const rejected = await testing.request({
        kind: "openSession",
        ...gridColumnWindow,
        source: {
          kind: "file",
          label: "dependency-shutdown.xls",
          path: path.join(directory, "dependency-shutdown.xls"),
          importOptions: { sheetIndex: 0 }
        },
        backend: "pandas",
        pageSize: 20,
        mode: "viewing"
      });
      assert.equal(rejected.kind, "error");
      if (rejected.kind === "error") {
        assert.equal(rejected.code, "missing_dependencies");
        assert.match(rejected.message, /Missing: pandas>=2\.2,<3, xlrd>=2\.0\.1,<3\.$/u);
        assert.doesNotMatch(rejected.message, /openpyxl/);
      }
      assert.equal(testing.runtimeRunning(), false, "The fake pip target must fail before runtime startup.");

      const page = await connectToEditorWorkbench();
      const pendingCommand = vscode.commands
        .executeCommand<boolean>("openWrangler.installRuntimeDependencies", true)
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      let commandState: "pending" | "fulfilled" | "rejected" = "pending";
      void pendingCommand.then((outcome) => {
        commandState = outcome.status;
      });
      const { page: confirmationPage, dialog: confirmation } = await waitForVisibleEditorDialog(
        page,
        "Install pandas>=2.2,<3, xlrd>=2.0.1,<3"
      );
      await confirmationPage.bringToFront();
      assert.equal(
        await confirmation.locator(".dialog-message-text").innerText(),
        `Install pandas>=2.2,<3, xlrd>=2.0.1,<3 into ${lifecycle.executable}?`
      );
      const installButton = confirmation.getByRole("button", { name: "Install", exact: true });
      assert.equal(
        await installButton.count(),
        1,
        "The dependency lifecycle modal must expose exactly one affirmative Install action."
      );
      assert.equal(await installButton.isVisible(), true, "The dependency lifecycle Install action must be visible.");
      assert.equal(await installButton.isEnabled(), true, "The dependency lifecycle Install action must be enabled.");
      recordAcceptanceProgress("verify:dependency-install-confirmation-visible");
      // Native workbench hovers can overlap a modal without changing its focus semantics.
      await installButton.focus({ timeout: workbenchOperationTimeoutMs });
      await installButton.press("Enter", { timeout: workbenchOperationTimeoutMs });
      recordAcceptanceProgress("verify:dependency-install-action-dispatched");
      await confirmation.waitFor({ state: "hidden", timeout: 10_000 });
      recordAcceptanceProgress("verify:dependency-install-dialog-hidden");
      await waitFor(
        () => existsSync(lifecycle.started),
        10_000,
        "the disposable fake pip process to publish its start marker"
      );
      recordAcceptanceProgress("verify:dependency-install-child-started");

      const started = JSON.parse(readFileSync(lifecycle.started, "utf8")) as Record<string, unknown>;
      assert.deepEqual(started.args, ["install", "--no-input", "--no-user", "--", "pandas>=2.2,<3", "xlrd>=2.0.1,<3"]);
      assert.equal(started.pipNoInput, "1", "The owned pip process must receive non-interactive mode.");
      assert.equal(started.pipUser, "0", "The owned pip process must explicitly prohibit user-site installation.");
      assert.equal(
        started.pipConfigFile,
        process.platform === "win32" ? "nul" : devNull,
        "The owned pip process must disable every inherited pip configuration file."
      );
      assert.equal(started.pythonPathPresent, false, "The owned pip process must not inherit PYTHONPATH.");
      assert.equal(started.pythonHomePresent, false, "The owned pip process must not inherit PYTHONHOME.");
      assert.notEqual(
        path.normalize(String(started.cwd)),
        path.normalize(path.dirname(lifecycle.executable)),
        "Dependency installation must not import a neighboring pip module from the interpreter directory."
      );
      assert.match(path.basename(String(started.cwd)), /^openwrangler-pip-/u);
      assert.equal(existsSync(String(started.cwd)), true, "The private pip directory must remain owned until close.");
      if (process.platform !== "win32") {
        assert.equal(statSync(String(started.cwd)).mode & 0o077, 0, "The private pip directory must be mode 0700.");
      }
      assert.equal(
        existsSync(lifecycle.completed),
        false,
        "The fake pip process must remain blocked until the acceptance harness releases it."
      );

      shutdown = testing.shutdownRuntimeBridgeForTesting();
      let shutdownState: "pending" | "fulfilled" | "rejected" = "pending";
      void shutdown.then(
        () => {
          shutdownState = "fulfilled";
        },
        () => {
          shutdownState = "rejected";
        }
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        shutdownState,
        "pending",
        "Runtime-bridge shutdown must remain pending while the exact pip child is still running."
      );
      assert.equal(
        commandState,
        "pending",
        "The public install command must remain pending while its exact pip child is still running."
      );
      assert.equal(
        existsSync(lifecycle.completed),
        false,
        "Runtime-bridge shutdown must not signal or kill the still-blocked pip child."
      );

      writeFileSync(lifecycle.release, "release\n", { encoding: "utf8", flag: "wx" });
      await shutdown;
      shutdownConfirmed = true;
      assert.equal(
        existsSync(lifecycle.completed),
        true,
        "Runtime-bridge shutdown must resolve only after the fake pip child exits naturally."
      );
      const completed = JSON.parse(readFileSync(lifecycle.completed, "utf8")) as Record<string, unknown>;
      assert.deepEqual(completed, { ...started, released: true });

      const outcome = await pendingCommand;
      if (outcome.status === "rejected") throw outcome.error;
      assert.equal(
        outcome.value,
        false,
        "An install that closes during bridge shutdown must not report post-disposal success."
      );
      assert.equal(testing.runtimeRunning(), false);
      assert.equal(testing.diagnostics().sessionCount, 0);
      assert.equal(
        existsSync(String(started.cwd)),
        false,
        "The private pip directory must be removed only after authoritative child close."
      );
    } finally {
      try {
        writeFileSync(lifecycle.release, "release\n", { encoding: "utf8", flag: "wx" });
      } catch {
        // A concurrently observed release is equivalent for bounded cleanup.
      }
      shutdown ??= testing.shutdownRuntimeBridgeForTesting();
      if (!shutdownConfirmed) {
        try {
          await shutdown;
          shutdownConfirmed = true;
        } catch {
          // Preserve the primary acceptance failure. The outer owned-process
          // harness will retain the private root when shutdown is unconfirmed.
        }
      }
      await config.update("pythonPath", originalWorkspacePythonPath, vscode.ConfigurationTarget.Workspace);
      if (shutdownConfirmed) cleanupAcceptanceTemporaryDirectory(directory);
    }
  };
}
