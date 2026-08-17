import * as assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import { sameAcceptanceExecutable } from "./dependencyInstallLifecycleFixture";
import {
  acceptanceProcessIsAlive,
  launchAcceptanceGuardParent,
  readAcceptanceGuardStatus,
  readDependencyGuardAcceptanceInvocations,
  readDependencyGuardParentAuthorization,
  readDependencyGuardParentState,
  readDependencyGuardProbeInvocations,
  type AcceptanceGuardProcess
} from "./dependencyGuardAcceptanceIo";
import {
  DEPENDENCY_GUARD_ACCEPTANCE_TOKEN,
  DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE,
  DEPENDENCY_GUARD_PROTOCOL,
  createDependencyGuardRecoveryFixture,
  type DependencyGuardRecoveryFixture
} from "./dependencyGuardRecoveryFixture";
import type { TestApi } from "./extensionHostTestApi";
import { withAcceptanceOperationDeadline } from "./playwrightLifecycle";

type DependencyGuardCleanupLeg = "guard" | "parent";

export interface DependencyMutationRecoveryJourneyDependencies {
  readonly DEPENDENCY_GUARD_HOSTILE_TOKEN: string;
  readonly GRID_COLUMN_WINDOW: { readonly columnOffset: number; readonly columnLimit: number };
  readonly WORKBENCH_OPERATION_TIMEOUT_MS: number;
  readonly WORKBENCH_PLAYWRIGHT_TIMEOUT_MS: number;
  readonly assertDependencyRecoveryDialog: (dialog: Locator, executable: string) => Promise<void>;
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly crashAcceptanceGuardParent: (
    process: AcceptanceGuardProcess,
    crashFrame: string,
    description: string
  ) => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  readonly csvSource: (uri: vscode.Uri) => SessionSource;
  readonly dependencyGuardCleanupOrder: (authorized: boolean) => readonly DependencyGuardCleanupLeg[];
  readonly settleOrphanedAcceptanceGuard: (fixture: DependencyGuardRecoveryFixture, pid: number) => Promise<void>;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
  readonly waitForAcceptanceGuardRelease: (
    fixture: DependencyGuardRecoveryFixture,
    timeoutMs: number,
    expectation: string
  ) => Promise<Record<string, unknown>>;
  readonly waitForVisibleEditorDialog: (workbench: Page, text: string) => Promise<{ page: Page; dialog: Locator }>;
}

export function createDependencyMutationRecoveryJourney({
  DEPENDENCY_GUARD_HOSTILE_TOKEN,
  GRID_COLUMN_WINDOW,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
  assertDependencyRecoveryDialog,
  connectToEditorWorkbench,
  crashAcceptanceGuardParent,
  csvSource,
  dependencyGuardCleanupOrder,
  settleOrphanedAcceptanceGuard,
  waitFor,
  waitForAcceptanceGuardRelease,
  waitForVisibleEditorDialog
}: DependencyMutationRecoveryJourneyDependencies) {
  return async function exerciseDependencyMutationRecovery(
    testing: TestApi,
    fixture: vscode.Uri,
    python: string,
    helperPath: string
  ): Promise<void> {
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "Dependency-recovery acceptance must start after every dataframe session closed."
    );
    assert.equal(
      testing.runtimeRunning(),
      false,
      "Dependency-recovery acceptance must start without a live dataframe runtime."
    );
    assert.deepEqual(
      dependencyGuardCleanupOrder(false),
      ["parent", "guard"],
      "A pre-authorization guard must lose its exact owned parent before release is status-proved."
    );
    assert.deepEqual(
      dependencyGuardCleanupOrder(true),
      ["guard", "parent"],
      "An authorized writer must be released and status-proved before its looping parent is terminated."
    );

    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-dependency-recovery-"));
    const recovery = createDependencyGuardRecoveryFixture(directory, python, helperPath);
    const config = vscode.workspace.getConfiguration("openWrangler");
    const originalWorkspacePythonPath = config.inspect<string>("pythonPath")?.workspaceValue;
    let guardParent: AcceptanceGuardProcess | undefined;
    let orphanedGuardPid: number | undefined;
    let sessionId: string | undefined;
    let sessionRevision = 0;
    let operationFailed = false;
    let operationFailure: unknown;
    const cleanupFailures: unknown[] = [];

    try {
      guardParent = launchAcceptanceGuardParent(recovery);
      await waitFor(
        () => existsSync(recovery.parentState),
        10_000,
        "the disposable dependency-guard parent to publish exact process ownership"
      );
      const parentState = readDependencyGuardParentState(recovery.parentState);
      guardParent.parentPid = parentState.parentPid;
      orphanedGuardPid = parentState.guardPid;
      assert.notEqual(orphanedGuardPid, parentState.parentPid);
      assert.equal(acceptanceProcessIsAlive(parentState.parentPid), true);
      assert.equal(acceptanceProcessIsAlive(orphanedGuardPid), true);
      await waitFor(
        () => existsSync(recovery.parentAuthorized),
        10_000,
        "the disposable dependency-guard parent to publish exact READY and GO evidence"
      );
      assert.deepEqual(readDependencyGuardParentAuthorization(recovery.parentAuthorized), {
        guardPid: orphanedGuardPid,
        kind: "authorized",
        parentPid: parentState.parentPid,
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
      });
      await waitFor(
        () => existsSync(recovery.pipStarted),
        10_000,
        "the guarded fake pip writer to begin after exact GO authorization"
      );
      assert.equal(
        existsSync(recovery.marker),
        true,
        "The durable recovery marker must exist before simulating abrupt guard-parent termination."
      );
      const markerMetadata = lstatSync(recovery.marker);
      assert.ok(markerMetadata.isFile() && !markerMetadata.isSymbolicLink() && markerMetadata.nlink === 1);
      if (process.platform !== "win32") {
        assert.equal(markerMetadata.mode & 0o077, 0, "The durable dependency marker must remain mode 0600.");
      }
      const pipStarted = JSON.parse(readFileSync(recovery.pipStarted, "utf8")) as Record<string, unknown>;
      assert.deepEqual(pipStarted.args, ["install", "--no-input", "--no-user", "--", recovery.dependency.installSpec]);
      // Crash only the disposable Python parent after exact GO. Its guarded
      // writer is a distinct process and must remain alive, modelling an
      // extension-host-like parent loss without claiming that this editor
      // restarted or power failed.
      const parentExit = await crashAcceptanceGuardParent(
        guardParent,
        recovery.parentCrashFrame,
        "the abruptly terminated dependency-guard parent"
      );
      assert.equal(
        parentExit.code,
        DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE,
        "The exact disposable Python parent must acknowledge the crash frame with os._exit()."
      );
      assert.equal(acceptanceProcessIsAlive(orphanedGuardPid), true, "The guarded writer must outlive its parent.");
      assert.equal(
        existsSync(recovery.marker),
        true,
        "Guard-parent loss after GO must retain the exact durable marker."
      );

      assert.equal(
        await vscode.commands.executeCommand("openWrangler.changeRuntime", recovery.executable),
        recovery.executable
      );
      const invocationsBeforeBlockedOpen = readDependencyGuardAcceptanceInvocations(recovery);
      const dependencyProbesBeforeBlockedOpen = readDependencyGuardProbeInvocations(recovery);
      const generationBeforeBlockedOpen = testing.runtimeGeneration();
      const blocked = await testing.request({
        kind: "openSession",
        ...GRID_COLUMN_WINDOW,
        source: csvSource(fixture),
        backend: "polars",
        pageSize: 20,
        mode: "viewing"
      });
      assert.equal(
        blocked.kind,
        "error",
        `A retained dependency marker must block a fresh open: ${JSON.stringify(blocked)}`
      );
      if (blocked.kind === "error") {
        assert.equal(blocked.code, "dependency_environment_uncertain");
        assert.match(blocked.message, /dependency state is uncertain/iu);
        assert.match(
          blocked.detail ?? "",
          /Another dependency guard currently owns this environment/iu,
          "A live guarded writer must report the busy state without offering concurrent validation."
        );
        assert.doesNotMatch(
          `${blocked.message}\n${blocked.detail ?? ""}`,
          new RegExp(`${DEPENDENCY_GUARD_ACCEPTANCE_TOKEN}|${DEPENDENCY_GUARD_HOSTILE_TOKEN}`, "u"),
          "Recovery diagnostics must never expose a dependency-guard token."
        );
      }
      assert.equal(testing.runtimeGeneration(), generationBeforeBlockedOpen);
      assert.equal(testing.runtimeRunning(), false, "A dirty guard must block before runtime startup.");
      assert.equal(testing.diagnostics().sessionCount, 0, "A dirty guard must not retain a failed session.");
      const blockedOpenInvocations = readDependencyGuardAcceptanceInvocations(recovery).slice(
        invocationsBeforeBlockedOpen.length
      );
      assert.ok(
        blockedOpenInvocations.length >= 2 &&
          blockedOpenInvocations.length <= 4 &&
          blockedOpenInvocations.every(
            (arguments_) =>
              (arguments_.length === 1 && arguments_[0] === "-c") ||
              (arguments_.length === 2 &&
                sameAcceptanceExecutable(arguments_[0], recovery.helperPath) &&
                arguments_[1] === "status")
          ),
        `Blocked-open Python work was not limited to environment/status checks: ${JSON.stringify(blockedOpenInvocations)}`
      );
      assert.deepEqual(
        readDependencyGuardProbeInvocations(recovery),
        dependencyProbesBeforeBlockedOpen,
        "A bridge fresh to the interrupted marker must stop before the ordinary importlib dependency probe."
      );

      assert.equal(
        acceptanceProcessIsAlive(orphanedGuardPid),
        true,
        "The same orphaned guarded writer must still own the journal before public recovery."
      );
      assert.equal(
        await vscode.commands.executeCommand(
          "openWrangler.revalidateRuntimeDependencies",
          true,
          DEPENDENCY_GUARD_HOSTILE_TOKEN,
          recovery.environment
        ),
        false,
        "A live dependency guard lock must make public recovery fail closed."
      );
      assert.equal(existsSync(recovery.marker), true, "Busy recovery must retain the exact marker.");

      writeFileSync(recovery.pipRelease, "release\n", { encoding: "utf8", flag: "wx" });
      await waitFor(
        () => existsSync(recovery.pipCompleted),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        "the orphaned guarded writer to finish its no-network pip fixture"
      );
      const releasedStatus = await waitForAcceptanceGuardRelease(
        recovery,
        WORKBENCH_OPERATION_TIMEOUT_MS,
        "the orphaned dependency guard to release its exact environment after its writer completed"
      );
      assert.equal(existsSync(recovery.marker), true, "Writer completion must not clear an unvalidated marker.");
      assert.deepEqual(releasedStatus, {
        kind: "status",
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        state: "dirty",
        token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
      });

      // The first open observed the journal while its exact writer still held
      // the lock, so it could only fail closed as busy. Ask the production
      // bridge to discover the retained marker once the writer has exited. This
      // binds recovery to the environment and token discovered from disk; the
      // later public command arguments remain deliberately hostile.
      const dependencyProbesBeforeMarkerDiscovery = readDependencyGuardProbeInvocations(recovery);
      const generationBeforeMarkerDiscovery = testing.runtimeGeneration();
      const discovered = await testing.request({
        kind: "openSession",
        ...GRID_COLUMN_WINDOW,
        source: csvSource(fixture),
        backend: "polars",
        pageSize: 20,
        mode: "viewing"
      });
      assert.equal(
        discovered.kind,
        "error",
        `A retained exact dependency marker must block until explicit validation: ${JSON.stringify(discovered)}`
      );
      if (discovered.kind === "error") {
        assert.equal(discovered.code, "dependency_environment_uncertain");
        assert.match(discovered.message, /dependency state is uncertain/iu);
        assert.match(discovered.detail ?? "", /Revalidate Runtime Dependencies/iu);
        assert.doesNotMatch(
          `${discovered.message}\n${discovered.detail ?? ""}`,
          new RegExp(`${DEPENDENCY_GUARD_ACCEPTANCE_TOKEN}|${DEPENDENCY_GUARD_HOSTILE_TOKEN}`, "u"),
          "Exact marker discovery diagnostics must never expose a dependency-guard token."
        );
      }
      assert.equal(testing.runtimeGeneration(), generationBeforeMarkerDiscovery);
      assert.equal(testing.runtimeRunning(), false, "Marker discovery must stop before runtime startup.");
      assert.equal(testing.diagnostics().sessionCount, 0, "Marker discovery must not retain a failed session.");
      assert.deepEqual(
        readDependencyGuardProbeInvocations(recovery),
        dependencyProbesBeforeMarkerDiscovery,
        "Exact marker discovery must stop before the ordinary importlib dependency probe."
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      const page = await connectToEditorWorkbench();
      const declinedCommand = vscode.commands
        .executeCommand<boolean>(
          "openWrangler.revalidateRuntimeDependencies",
          true,
          DEPENDENCY_GUARD_HOSTILE_TOKEN,
          recovery.environment
        )
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      const earlyDecline = await Promise.race([
        declinedCommand.then((outcome) => ({ kind: "settled" as const, outcome })),
        new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 500))
      ]);
      assert.equal(
        earlyDecline.kind,
        "pending",
        `Hostile recovery arguments must not settle the command without its real modal: ${JSON.stringify(earlyDecline)}`
      );
      const { page: declinePage, dialog: declineDialog } = await waitForVisibleEditorDialog(
        page,
        "Revalidate runtime dependencies"
      );
      try {
        await assertDependencyRecoveryDialog(declineDialog, recovery.executable);
        await declinePage.bringToFront();
        await declinePage.keyboard.press("Escape");
        await declineDialog.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
        const declined = await declinedCommand;
        if (declined.status === "rejected") throw declined.error;
        assert.equal(declined.value, false);
      } finally {
        if (await declineDialog.isVisible().catch(() => false)) {
          await declinePage.bringToFront();
          await declinePage.keyboard.press("Escape");
          await declineDialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
        }
      }
      assert.equal(existsSync(recovery.marker), true, "Escaping the real recovery modal must retain the marker.");
      await new Promise<void>((resolve) => setImmediate(resolve));

      const recoveryCommand = vscode.commands
        .executeCommand<boolean>(
          "openWrangler.revalidateRuntimeDependencies",
          DEPENDENCY_GUARD_HOSTILE_TOKEN,
          recovery.environment
        )
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      const { page: recoveryPage, dialog: recoveryDialog } = await waitForVisibleEditorDialog(
        page,
        "Revalidate runtime dependencies"
      );
      await assertDependencyRecoveryDialog(recoveryDialog, recovery.executable);
      await recoveryPage.bringToFront();
      await withAcceptanceOperationDeadline(
        recoveryDialog.getByRole("button", { name: "Revalidate", exact: true }).click(),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        "the exact dependency-revalidation confirmation"
      );
      await recoveryDialog.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      const recovered = await recoveryCommand;
      if (recovered.status === "rejected") throw recovered.error;
      assert.equal(recovered.value, true, "Exact dependency validation must report success.");
      assert.equal(existsSync(recovery.marker), false, "Successful exact validation must clear only its marker.");
      assert.deepEqual(readAcceptanceGuardStatus(recovery), {
        kind: "status",
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        state: "clean",
        token: null
      });

      const opened = await testing.request({
        kind: "openSession",
        ...GRID_COLUMN_WINDOW,
        source: csvSource(fixture),
        backend: "polars",
        pageSize: 20,
        mode: "viewing"
      });
      assert.equal(
        opened.kind,
        "sessionOpened",
        `Validated dependency recovery did not unblock: ${JSON.stringify(opened)}`
      );
      if (opened.kind === "sessionOpened") {
        sessionId = opened.metadata.sessionId;
        sessionRevision = opened.metadata.revision;
        assert.equal(opened.metadata.backend, "polars");
      }
    } catch (error) {
      operationFailed = true;
      operationFailure = error;
    } finally {
      if (
        (orphanedGuardPid === undefined || guardParent?.parentPid === undefined) &&
        existsSync(recovery.parentState)
      ) {
        try {
          const parentState = readDependencyGuardParentState(recovery.parentState);
          orphanedGuardPid = parentState.guardPid;
          if (guardParent) guardParent.parentPid = parentState.parentPid;
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      let processOwnershipConfirmed = orphanedGuardPid !== undefined || guardParent === undefined;
      let exactAuthorizationConfirmed = false;
      if (orphanedGuardPid !== undefined && guardParent && existsSync(recovery.parentAuthorized)) {
        try {
          assert.deepEqual(readDependencyGuardParentAuthorization(recovery.parentAuthorized), {
            guardPid: orphanedGuardPid,
            kind: "authorized",
            parentPid: guardParent.parentPid,
            protocol: DEPENDENCY_GUARD_PROTOCOL,
            token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
          });
          exactAuthorizationConfirmed = true;
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (orphanedGuardPid === undefined && guardParent) {
        processOwnershipConfirmed = false;
        cleanupFailures.push(
          new Error("Dependency-recovery cleanup could not recover the exact guarded-writer identity.")
        );
      }

      const settleGuard = async (): Promise<void> => {
        if (orphanedGuardPid === undefined) return;
        try {
          await settleOrphanedAcceptanceGuard(recovery, orphanedGuardPid);
        } catch (error) {
          processOwnershipConfirmed = false;
          cleanupFailures.push(error);
        }
      };
      const terminateParent = async (): Promise<void> => {
        if (!guardParent || guardParent.closed) return;
        try {
          await crashAcceptanceGuardParent(
            guardParent,
            recovery.parentCrashFrame,
            "the disposable dependency-guard parent"
          );
        } catch (error) {
          processOwnershipConfirmed = false;
          cleanupFailures.push(error);
        }
      };
      for (const cleanupLeg of dependencyGuardCleanupOrder(exactAuthorizationConfirmed)) {
        if (cleanupLeg === "parent") await terminateParent();
        else await settleGuard();
      }
      if (sessionId) {
        try {
          await testing.request({
            kind: "closeSession",
            sessionId,
            revision: sessionRevision
          });
        } catch (error) {
          processOwnershipConfirmed = false;
          cleanupFailures.push(error);
        }
      }
      try {
        await config.update("pythonPath", originalWorkspacePythonPath, vscode.ConfigurationTarget.Workspace);
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await waitFor(
          () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
          30_000,
          "dependency-recovery acceptance sessions and runtime to close"
        );
      } catch (error) {
        processOwnershipConfirmed = false;
        cleanupFailures.push(error);
      }
      if (processOwnershipConfirmed) {
        try {
          cleanupAcceptanceTemporaryDirectory(directory);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
    const failures = operationFailed ? [operationFailure, ...cleanupFailures] : cleanupFailures;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Dependency-recovery acceptance and cleanup reported multiple failures.");
    }
  };
}
