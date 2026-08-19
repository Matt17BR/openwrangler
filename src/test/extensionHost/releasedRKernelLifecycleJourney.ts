import * as assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { Page } from "playwright-core";
import type { PageResponse } from "../../shared/protocol";
import { RELEASED_JUPYTER_R_KERNEL_RESULT, RELEASED_JUPYTER_R_SETUP_RESULT } from "./releasedDocumentFixtures";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRKernelLifecycleSession = NonNullable<ReturnType<TestApi["activeSession"]>>;

interface ReleasedJupyterKernelTarget {
  readonly remote?: Readonly<{ runId: string; hostname: string }>;
}

interface ReleasedRKernelLifecycleVariableExpectation {
  readonly name: string;
  readonly type: string;
  readonly backend: "r";
  readonly rDataframeFlavor: "r.data.frame";
  readonly firstValue: string;
  readonly notebookInsert: boolean;
}

interface ReleasedRKernelLifecycleDependencies {
  readonly GRID_COLUMN_WINDOW: Readonly<{ columnOffset: number; columnLimit: number }>;
  readonly RELEASED_JUPYTER_R_KERNEL_CELL: number;
  readonly RELEASED_JUPYTER_R_SETUP_CELL: number;
  readonly assertReleasedRPrivateLibrary: (result: Readonly<Record<string, unknown>>, description: string) => void;
  readonly assertReleasedRVersion: (
    result: Readonly<Record<string, unknown>>,
    target: ReleasedJupyterKernelTarget,
    description: string
  ) => void;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ReleasedRKernelLifecycleSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<PageResponse>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly executeReleasedNotebookCell: (
    notebook: vscode.NotebookDocument,
    index: number,
    expectedOutput: string,
    checkpoint: string,
    expectedEditor?: vscode.NotebookEditor
  ) => Promise<void>;
  readonly invokeReleasedNotebookToolbarVariable: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    variableName: string
  ) => Promise<void>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedNotebookJsonResult: (
    cell: vscode.NotebookCell,
    marker: string,
    description: string
  ) => Record<string, unknown>;
  readonly restartReleasedJupyterKernelAndWait: (
    notebook: vscode.NotebookDocument,
    recordCheckpoint: (checkpoint: string) => void
  ) => Promise<void>;
  readonly showExactReleasedNotebook: (notebook: vscode.NotebookDocument) => Promise<vscode.NotebookEditor>;
  readonly waitForReleasedRRuntimeBindingCleanup: (
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    phase: "jupyter-r" | "jupyter-r-remote"
  ) => Promise<void>;
  readonly waitForReleasedVariableSession: (
    workbench: Page,
    testing: TestApi,
    notebook: vscode.NotebookDocument,
    expected: ReleasedRKernelLifecycleVariableExpectation,
    description: string
  ) => Promise<ReleasedRKernelLifecycleSession>;
}

export function createReleasedRKernelLifecycle({
  GRID_COLUMN_WINDOW,
  RELEASED_JUPYTER_R_KERNEL_CELL,
  RELEASED_JUPYTER_R_SETUP_CELL,
  assertReleasedRPrivateLibrary,
  assertReleasedRVersion,
  assertReleasedSessionPage,
  disposePackagedSessionPanel,
  executeReleasedNotebookCell,
  invokeReleasedNotebookToolbarVariable,
  recordAcceptanceProgress,
  releasedNotebookJsonResult,
  restartReleasedJupyterKernelAndWait,
  showExactReleasedNotebook,
  waitForReleasedRRuntimeBindingCleanup,
  waitForReleasedVariableSession
}: ReleasedRKernelLifecycleDependencies) {
  function recordReleasedRKernelLifecycleCheckpoint(phase: "jupyter-r" | "jupyter-r-remote", checkpoint: string): void {
    recordAcceptanceProgress(`${phase}:kernel-restart:${checkpoint}`);
  }

  async function exerciseReleasedRKernelLifecycle(
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    setup: Readonly<Record<string, unknown>>,
    kernelTarget: ReleasedJupyterKernelTarget,
    phase: "jupyter-r" | "jupyter-r-remote"
  ): Promise<void> {
    recordReleasedRKernelLifecycleCheckpoint(phase, "notebook-show:start");
    await showExactReleasedNotebook(notebook);
    recordReleasedRKernelLifecycleCheckpoint(phase, "notebook-show:complete");
    recordReleasedRKernelLifecycleCheckpoint(phase, "variable-invoke:start");
    await invokeReleasedNotebookToolbarVariable(workbench, notebook, "orders_frame");
    recordReleasedRKernelLifecycleCheckpoint(phase, "variable-invoke:complete");
    recordReleasedRKernelLifecycleCheckpoint(phase, "session-receipt:start");
    const openedBeforeRestart = await waitForReleasedVariableSession(
      workbench,
      testing,
      notebook,
      {
        name: "orders_frame",
        type: "data.frame",
        backend: "r",
        rDataframeFlavor: "r.data.frame",
        firstValue: "1",
        notebookInsert: true
      },
      "the R restart session"
    );
    recordReleasedRKernelLifecycleCheckpoint(phase, "session-receipt:complete");
    recordReleasedRKernelLifecycleCheckpoint(phase, "scalar-step:start");
    const groupColumn = openedBeforeRestart.metadata.schema.find((column) => column.name === "group");
    assert.ok(groupColumn, "The R restart journey requires its scalar group column.");
    const preview = await testing.request({
      kind: "previewStep",
      sessionId: openedBeforeRestart.sessionId,
      revision: openedBeforeRestart.metadata.revision,
      step: {
        id: "released-r-kernel-restart-lowercase",
        kind: "lowerText",
        params: { column: { id: groupColumn.id, name: groupColumn.name } }
      },
      offset: 0,
      limit: 10,
      ...GRID_COLUMN_WINDOW
    });
    assert.equal(preview.kind, "stepPreview", "The R restart scalar step must preview before the restart.");
    if (preview.kind !== "stepPreview") throw new Error("The R restart scalar preview failed.");
    assert.equal(preview.page.rows[0]?.values[groupColumn.position]?.display, "a");
    assert.match(preview.code, /tolower/u);
    const applied = await testing.request({
      kind: "applyDraft",
      sessionId: openedBeforeRestart.sessionId,
      revision: preview.revision,
      offset: 0,
      limit: 10,
      ...GRID_COLUMN_WINDOW
    });
    assert.equal(applied.kind, "planUpdated", "The R restart scalar step must commit before the restart.");
    if (applied.kind !== "planUpdated") throw new Error("The R restart scalar apply failed.");
    assert.equal(applied.page.rows[0]?.values[groupColumn.position]?.display, "a");
    assert.equal(applied.metadata.steps.length, 1);
    await testing.updateViewState(openedBeforeRestart.sessionId, {
      selectedColumnId: groupColumn.id,
      columnWidths: new Map([[groupColumn.id, 210]]),
      viewport: { firstVisibleRow: 4, scrollLeft: 11 }
    });
    const beforeRestart = testing.sessionSnapshot(openedBeforeRestart.sessionId);
    assert.ok(beforeRestart, "The committed R restart session must remain available.");
    assert.equal(beforeRestart.metadata.revision, applied.revision);
    assert.deepEqual(beforeRestart.metadata.steps, applied.metadata.steps);
    assert.equal(beforeRestart.metadata.draftStep, undefined);
    assert.equal(beforeRestart.code, applied.code);
    assert.ok(beforeRestart.code, "The committed R restart session must retain generated code.");
    assert.deepEqual(beforeRestart.metadata.source, openedBeforeRestart.metadata.source);
    assert.equal(beforeRestart.viewState.selectedColumnId, groupColumn.id);
    assert.deepEqual(beforeRestart.viewState.columnWidths, new Map([[groupColumn.id, 210]]));
    assert.deepEqual(beforeRestart.viewState.viewport, { firstVisibleRow: 4, scrollLeft: 11 });
    recordReleasedRKernelLifecycleCheckpoint(phase, "scalar-step:complete");
    await restartReleasedJupyterKernelAndWait(notebook, (checkpoint) =>
      recordReleasedRKernelLifecycleCheckpoint(phase, `restart-${checkpoint}`)
    );

    recordReleasedRKernelLifecycleCheckpoint(phase, "replacement-show:start");
    const replacementEditor = await showExactReleasedNotebook(notebook);
    recordReleasedRKernelLifecycleCheckpoint(phase, "replacement-show:complete");
    recordReleasedRKernelLifecycleCheckpoint(phase, "replacement-kernel-probe:start");
    await executeReleasedNotebookCell(
      notebook,
      RELEASED_JUPYTER_R_KERNEL_CELL,
      RELEASED_JUPYTER_R_KERNEL_RESULT,
      `${phase}:replacement-kernel-probe`,
      replacementEditor
    );
    recordReleasedRKernelLifecycleCheckpoint(phase, "replacement-kernel-probe:complete");
    recordReleasedRKernelLifecycleCheckpoint(phase, "replacement-setup:start");
    await executeReleasedNotebookCell(
      notebook,
      RELEASED_JUPYTER_R_SETUP_CELL,
      RELEASED_JUPYTER_R_SETUP_RESULT,
      `${phase}:replacement-setup`,
      replacementEditor
    );
    const replacementSetup = releasedNotebookJsonResult(
      notebook.cellAt(RELEASED_JUPYTER_R_SETUP_CELL),
      RELEASED_JUPYTER_R_SETUP_RESULT,
      "replacement R setup"
    );
    assert.notEqual(Number(replacementSetup.pid), Number(setup.pid));
    assertReleasedRVersion(replacementSetup, kernelTarget, "replacement R setup");
    if (!kernelTarget.remote) assertReleasedRPrivateLibrary(replacementSetup, "replacement R setup");
    assert.equal(replacementSetup.collapseVersion, "2.1.7");
    if (kernelTarget.remote) {
      assert.equal(replacementSetup.remoteRunId, kernelTarget.remote.runId);
      assert.equal(replacementSetup.hostname, kernelTarget.remote.hostname);
    }
    recordReleasedRKernelLifecycleCheckpoint(phase, "replacement-setup:complete");

    recordReleasedRKernelLifecycleCheckpoint(phase, "recovery-trigger:start");
    const failed = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      sessionId: beforeRestart.sessionId,
      revision: beforeRestart.metadata.revision,
      viewRequestId: `${phase}-restarted-session`,
      offset: 0,
      limit: 10,
      filterModel: beforeRestart.metadata.filterModel
    });
    assert.equal(failed.kind, "error");
    if (failed.kind !== "error") throw new Error("The restarted R session unexpectedly returned data.");
    assert.equal(failed.code, "r_kernel_changed");
    assert.equal(failed.recoverable, true);
    assert.equal(failed.sessionId, beforeRestart.sessionId);
    recordReleasedRKernelLifecycleCheckpoint(phase, "recovery-trigger:complete");

    const recovered = testing.sessionSnapshot(beforeRestart.sessionId);
    assert.ok(recovered, "Native-R recovery must retain the exact public session.");
    assert.equal(recovered.sessionId, beforeRestart.sessionId);
    assert.deepEqual(recovered.metadata, beforeRestart.metadata);
    assert.equal(recovered.code, beforeRestart.code);
    assert.deepEqual(recovered.viewState, beforeRestart.viewState);
    recordReleasedRKernelLifecycleCheckpoint(phase, "recovery-page:start");
    const recoveredPage = await assertReleasedSessionPage(testing, recovered, "1", `${phase}-recovered-page`);
    assert.equal(
      recoveredPage.page.rows[0]?.values[groupColumn.position]?.display,
      "a",
      "The recovered R page must contain the committed scalar output."
    );
    recordReleasedRKernelLifecycleCheckpoint(phase, "recovery-page:complete");
    recordReleasedRKernelLifecycleCheckpoint(phase, "recovery-session-cleanup:start");
    await disposePackagedSessionPanel(testing, recovered.sessionId, "the recovered R session");
    assert.equal(testing.diagnostics().sessionCount, 0);
    recordReleasedRKernelLifecycleCheckpoint(phase, "recovery-session-cleanup:complete");
    recordReleasedRKernelLifecycleCheckpoint(phase, "binding-cleanup-show:start");
    const cleanupEditor = await showExactReleasedNotebook(notebook);
    recordReleasedRKernelLifecycleCheckpoint(phase, "binding-cleanup-show:complete");
    recordReleasedRKernelLifecycleCheckpoint(phase, "binding-cleanup-wait:start");
    await waitForReleasedRRuntimeBindingCleanup(notebook, cleanupEditor, phase);
    recordReleasedRKernelLifecycleCheckpoint(phase, "binding-cleanup-wait:complete");
  }

  return {
    exerciseReleasedRKernelLifecycle,
    recordReleasedRKernelLifecycleCheckpoint
  };
}
