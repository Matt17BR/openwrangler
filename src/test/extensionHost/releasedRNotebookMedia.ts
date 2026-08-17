import * as assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { Page } from "playwright-core";
import type { OpenWranglerResponse } from "../../shared/protocol";
import { RELEASED_JUPYTER_R_MEDIA_RESULT } from "./releasedDocumentFixtures";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;
type ReleasedRPage = Extract<OpenWranglerResponse, { kind: "page" }>;

interface ReleasedRVariableExpectation {
  readonly name: string;
  readonly type: string;
  readonly backend: "r";
  readonly firstValue: string;
  readonly notebookInsert?: boolean;
  readonly rDataframeFlavor: "r.data.frame";
}

interface ReleasedRNotebookMediaDependencies {
  readonly RELEASED_JUPYTER_R_MEDIA_CELL: number;
  readonly assertReleasedRRuntimeBinding: (
    notebook: vscode.NotebookDocument,
    expectedBinding: boolean,
    checkpoint: string
  ) => Promise<void>;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ReleasedRActiveSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<ReleasedRPage>;
  readonly captureReleasedRJupyterWorkbench: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    screenshotOutput: string
  ) => Promise<void>;
  readonly captureReleasedRNotebookGroupByDraft: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    screenshotOutput: string
  ) => Promise<void>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly executeReleasedNotebookCell: (
    notebook: vscode.NotebookDocument,
    index: number,
    expectedText: string,
    checkpoint: string,
    expectedEditor?: vscode.NotebookEditor
  ) => Promise<void>;
  readonly invokeReleasedNotebookToolbarVariable: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    variableName: string
  ) => Promise<void>;
  readonly releasedNotebookJsonResult: (
    cell: vscode.NotebookCell,
    marker: string,
    description: string
  ) => Record<string, unknown>;
  readonly showExactReleasedNotebook: (notebook: vscode.NotebookDocument) => Promise<vscode.NotebookEditor>;
  readonly waitForReleasedVariableSession: (
    workbench: Page,
    testing: TestApi,
    notebook: vscode.NotebookDocument,
    expected: ReleasedRVariableExpectation,
    description: string
  ) => Promise<ReleasedRActiveSession>;
}

export function createReleasedRNotebookMedia({
  RELEASED_JUPYTER_R_MEDIA_CELL,
  assertReleasedRRuntimeBinding,
  assertReleasedSessionPage,
  captureReleasedRJupyterWorkbench,
  captureReleasedRNotebookGroupByDraft,
  disposePackagedSessionPanel,
  executeReleasedNotebookCell,
  invokeReleasedNotebookToolbarVariable,
  releasedNotebookJsonResult,
  showExactReleasedNotebook,
  waitForReleasedVariableSession
}: ReleasedRNotebookMediaDependencies) {
  return async function exerciseReleasedRNotebookMedia(
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    base: ReleasedRActiveSession,
    phase: "jupyter-r" | "jupyter-r-remote",
    screenshotOutput: string
  ): Promise<ReleasedRActiveSession> {
    await disposePackagedSessionPanel(testing, base.sessionId, "the initial R data.frame before media capture");
    const mediaEditor = await showExactReleasedNotebook(notebook);
    await executeReleasedNotebookCell(
      notebook,
      RELEASED_JUPYTER_R_MEDIA_CELL,
      RELEASED_JUPYTER_R_MEDIA_RESULT,
      `${phase}:media-setup`,
      mediaEditor
    );
    const mediaSetup = releasedNotebookJsonResult(
      notebook.cellAt(RELEASED_JUPYTER_R_MEDIA_CELL),
      RELEASED_JUPYTER_R_MEDIA_RESULT,
      "R media setup"
    );
    assert.deepEqual({ rows: mediaSetup.rows, columns: mediaSetup.columns }, { rows: 2_400, columns: 24 });
    await invokeReleasedNotebookToolbarVariable(workbench, notebook, "regional_orders");
    const mediaSession = await waitForReleasedVariableSession(
      workbench,
      testing,
      notebook,
      {
        name: "regional_orders",
        type: "data.frame",
        backend: "r",
        rDataframeFlavor: "r.data.frame",
        firstValue: "2400001",
        notebookInsert: true
      },
      "the representative R orders session"
    );
    await captureReleasedRJupyterWorkbench(workbench, testing, mediaSession.sessionId, screenshotOutput);
    await captureReleasedRNotebookGroupByDraft(workbench, testing, mediaSession.sessionId, screenshotOutput);
    await assertReleasedRRuntimeBinding(notebook, true, `${phase}:media-source-after-capture`);
    await disposePackagedSessionPanel(testing, mediaSession.sessionId, "the representative R orders session");

    await showExactReleasedNotebook(notebook);
    await invokeReleasedNotebookToolbarVariable(workbench, notebook, "orders_frame");
    base = await waitForReleasedVariableSession(
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
      "the orders R data.frame reopened after media capture"
    );
    await assertReleasedSessionPage(testing, base, "1", `${phase}-base-page-after-media`);
    return base;
  };
}
