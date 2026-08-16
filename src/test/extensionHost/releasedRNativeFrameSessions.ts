import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { TestApi } from "./extensionHostTestApi";
import type { ReleasedRAcceptanceCoverageProfile } from "./releasedRAcceptanceCoverage";

type ReleasedRNativeFrameSession = NonNullable<ReturnType<TestApi["activeSession"]>>;

interface ReleasedRNativeFrameExpectation {
  readonly name: string;
  readonly type: string;
  readonly backend: "r";
  readonly rDataframeFlavor: "r.data.frame" | "r.tibble" | "r.data.table";
  readonly firstValue: string;
  readonly notebookInsert: boolean;
}

interface ReleasedRNativeFrameDependencies {
  readonly RELEASED_R_SUPPORTED_OPERATIONS: readonly string[];
  readonly assertReleasedRRuntimeBinding: (
    notebook: vscode.NotebookDocument,
    expectedBinding: boolean,
    checkpoint: string
  ) => Promise<void>;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ReleasedRNativeFrameSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<unknown>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly invokeReleasedNotebookToolbarVariable: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    variableName: string
  ) => Promise<void>;
  readonly previewReleasedRDrop: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    sourceName: string,
    variableName?: string,
    checkpointPrefix?: string
  ) => Promise<Readonly<{ app: Locator; stepId: string }>>;
  readonly previewReleasedRRename: (
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    sourceName: string,
    newName: string,
    replacement?: Readonly<{ replaceStepId: string; previousName: string }>,
    variableName?: string
  ) => Promise<Readonly<{ app: Locator; stepId: string }>>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly recordReleasedRAcceptanceSection: (
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    section: string,
    boundary: "start" | "complete"
  ) => void;
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    description: string
  ) => Promise<Locator>;
  readonly showExactReleasedNotebook: (notebook: vscode.NotebookDocument) => Promise<vscode.NotebookEditor>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForReleasedVariableSession: (
    workbench: Page,
    testing: TestApi,
    notebook: vscode.NotebookDocument,
    expected: ReleasedRNativeFrameExpectation,
    description: string
  ) => Promise<ReleasedRNativeFrameSession>;
}

const RELEASED_R_COLLAPSE_FRAMES = [
  {
    name: "collapse_frame",
    factory: "qDF",
    type: "data.frame",
    backend: "r" as const,
    rDataframeFlavor: "r.data.frame" as const,
    firstValue: "1",
    notebookInsert: true
  },
  {
    name: "collapse_tibble",
    factory: "qTBL",
    type: "tbl_df",
    backend: "r" as const,
    rDataframeFlavor: "r.tibble" as const,
    firstValue: "1",
    notebookInsert: true
  },
  {
    name: "collapse_table",
    factory: "qDT",
    type: "data.table",
    backend: "r" as const,
    rDataframeFlavor: "r.data.table" as const,
    firstValue: "1",
    notebookInsert: true
  }
] as const;

const RELEASED_R_ADDITIONAL_NATIVE_FRAMES = [
  {
    name: "orders_tibble",
    type: "tbl_df",
    backend: "r" as const,
    rDataframeFlavor: "r.tibble" as const,
    firstValue: "1",
    notebookInsert: true
  },
  {
    name: "orders_table",
    type: "data.table",
    backend: "r" as const,
    rDataframeFlavor: "r.data.table" as const,
    firstValue: "1",
    notebookInsert: true
  }
] as const;
export function createReleasedRNativeFrameSessions({
  RELEASED_R_SUPPORTED_OPERATIONS,
  assertReleasedRRuntimeBinding,
  assertReleasedSessionPage,
  disposePackagedSessionPanel,
  invokeReleasedNotebookToolbarVariable,
  previewReleasedRDrop,
  previewReleasedRRename,
  recordAcceptanceProgress,
  recordReleasedRAcceptanceSection,
  releasedRSessionApp,
  showExactReleasedNotebook,
  waitFor,
  waitForReleasedVariableSession
}: ReleasedRNativeFrameDependencies) {
  function recordReleasedRNativeFrameCheckpoint(
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    frame: string,
    checkpoint: string
  ): void {
    recordAcceptanceProgress(`${phase}:coverage:${coverage.name}:native-frame:${frame}:${checkpoint}`);
  }

  async function exerciseReleasedRCollapseFrameSessions(
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile
  ): Promise<void> {
    if (!coverage.openCollapseSessions) return;
    recordReleasedRAcceptanceSection(phase, coverage, "collapse-open", "start");
    for (const expected of RELEASED_R_COLLAPSE_FRAMES) {
      recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "view-open:start");
      await showExactReleasedNotebook(notebook);
      await invokeReleasedNotebookToolbarVariable(workbench, notebook, expected.name);
      const session = await waitForReleasedVariableSession(
        workbench,
        testing,
        notebook,
        expected,
        `the collapse::${expected.factory}() session`
      );
      recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "view-open:complete");
      assert.deepEqual(session.metadata.shape, { rows: 1_205, columns: 25 });
      await assertReleasedSessionPage(testing, session, "1", `${phase}-${expected.name}-page`);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "view-page:complete");
      await disposePackagedSessionPanel(testing, session.sessionId, `the collapse::${expected.factory}() session`);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "view-cleanup:complete");
    }
    recordReleasedRAcceptanceSection(phase, coverage, "collapse-open", "complete");
  }

  async function exerciseReleasedRNativeFrameSessions(
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    configuration: vscode.WorkspaceConfiguration,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile
  ): Promise<void> {
    if (coverage.openNativeFramesInViewingMode) {
      recordReleasedRAcceptanceSection(phase, coverage, "native-viewing", "start");
      for (const expected of RELEASED_R_ADDITIONAL_NATIVE_FRAMES) {
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "view-open:start");
        await showExactReleasedNotebook(notebook);
        await invokeReleasedNotebookToolbarVariable(workbench, notebook, expected.name);
        const session = await waitForReleasedVariableSession(
          workbench,
          testing,
          notebook,
          expected,
          `the native ${expected.rDataframeFlavor} session`
        );
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "view-open:complete");
        await assertReleasedSessionPage(testing, session, "1", `${phase}-${expected.name}-page`);
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "view-page:complete");
        await disposePackagedSessionPanel(
          testing,
          session.sessionId,
          `the native ${expected.rDataframeFlavor} session`
        );
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "view-cleanup:complete");
      }
      recordReleasedRAcceptanceSection(phase, coverage, "native-viewing", "complete");
    }

    if (coverage.nativeFrameEditing === "none") return;
    recordReleasedRAcceptanceSection(phase, coverage, "native-editing", "start");
    await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);
    for (const expected of RELEASED_R_ADDITIONAL_NATIVE_FRAMES) {
      recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "editing-open:start");
      await showExactReleasedNotebook(notebook);
      await invokeReleasedNotebookToolbarVariable(workbench, notebook, expected.name);
      const session = await waitForReleasedVariableSession(
        workbench,
        testing,
        notebook,
        expected,
        `the editable native ${expected.rDataframeFlavor} session`
      );
      assert.equal(session.metadata.mode, "editing");
      assert.deepEqual(session.metadata.capabilities.supportedOperations, RELEASED_R_SUPPORTED_OPERATIONS);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "editing-session:complete");
      let app = await releasedRSessionApp(workbench, testing, session.sessionId, `the editable ${expected.name}`);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "editing-renderer:complete");
      const checkRename = coverage.nativeFrameEditing === "rename-and-drop" || expected.rDataframeFlavor === "r.tibble";
      if (checkRename) {
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "rename-preview:start");
        const previewed = await previewReleasedRRename(
          testing,
          workbench,
          app,
          session.sessionId,
          "row_id",
          "record_id",
          undefined,
          expected.name
        );
        app = previewed.app;
        assert.equal(testing.activeSession()?.metadata.rDataframeFlavor, expected.rDataframeFlavor);
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "rename-preview:complete");
        await app
          .getByRole("region", { name: "Draft review" })
          .getByRole("button", { name: "Discard", exact: true })
          .click();
        await waitFor(
          () => {
            const active = testing.activeSession();
            return (
              active?.sessionId === session.sessionId &&
              active.metadata.draftStep === undefined &&
              active.metadata.steps.length === 0 &&
              active.metadata.schema[0]?.name === "row_id"
            );
          },
          30_000,
          `discarding the native ${expected.rDataframeFlavor} rename preview`
        );
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "rename-discard:complete");
      }
      const checkDrop =
        coverage.nativeFrameEditing === "rename-and-drop" || expected.rDataframeFlavor === "r.data.table";
      if (checkDrop) {
        app = await releasedRSessionApp(workbench, testing, session.sessionId, `the restored ${expected.name}`);
        const droppedColumn = expected.rDataframeFlavor === "r.data.table" ? "row_id" : "label";
        const dropCheckpoint = `${phase}:coverage:${coverage.name}:native-frame:${expected.name}:drop-code-preview`;
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "drop-preview:start");
        const dropPreview = await previewReleasedRDrop(
          testing,
          workbench,
          session.sessionId,
          droppedColumn,
          expected.name,
          dropCheckpoint
        );
        app = dropPreview.app;
        assert.equal(testing.activeSession()?.metadata.rDataframeFlavor, expected.rDataframeFlavor);
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "drop-preview:complete");
        await app
          .getByRole("region", { name: "Draft review" })
          .getByRole("button", { name: "Discard", exact: true })
          .click();
        await waitFor(
          () => {
            const active = testing.activeSession();
            return (
              active?.sessionId === session.sessionId &&
              active.metadata.draftStep === undefined &&
              active.metadata.steps.length === 0 &&
              active.metadata.schema.some((column) => column.name === droppedColumn)
            );
          },
          30_000,
          `discarding the native ${expected.rDataframeFlavor} Drop Columns preview`
        );
        recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "drop-discard:complete");
      }
      await assertReleasedRRuntimeBinding(notebook, true, `${phase}:${expected.name}:after-native-edit`);
      recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "source-binding:complete");
      await disposePackagedSessionPanel(
        testing,
        session.sessionId,
        `the editable native ${expected.rDataframeFlavor} session`
      );
      recordReleasedRNativeFrameCheckpoint(phase, coverage, expected.name, "editing-cleanup:complete");
    }
    await configuration.update("notebookStartMode", "viewing", vscode.ConfigurationTarget.Workspace);
    recordReleasedRAcceptanceSection(phase, coverage, "native-editing", "complete");
  }

  return {
    exerciseReleasedRCollapseFrameSessions,
    exerciseReleasedRNativeFrameSessions,
    recordReleasedRNativeFrameCheckpoint
  };
}
