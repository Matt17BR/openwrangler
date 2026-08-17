import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Jupyter } from "@vscode/jupyter-extension";
import type { Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import type { OpenWranglerResponse } from "../../shared/protocol";
import { assertExactBytes } from "./acceptanceSourceFixture";
import type { TestApi } from "./extensionHostTestApi";

type ActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;
type PageResponse = Extract<OpenWranglerResponse, { kind: "page" }>;

interface ReleasedPythonSourceKernelTarget {
  readonly label: string;
  readonly name: string;
  readonly routeLabels: readonly string[];
  readonly remote?: {
    readonly baseUrl: vscode.Uri;
    readonly token: string;
    readonly runId: string;
    readonly hostname: string;
  };
}

type ReleasedJupyterKernelTarget = ReleasedPythonSourceKernelTarget;

interface ReleasedPythonSourceVariableExpectation {
  readonly name: string;
  readonly type: string;
  readonly backend: "pandas";
  readonly firstValue: string;
  readonly notebookInsert?: boolean;
}

export interface ReleasedPythonSourceCellJourneyDependencies {
  readonly RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS: number;
  readonly arrangePackagedProductSidebar: (workbench: Page, scene: "operation-catalog") => Promise<Locator>;
  readonly assertExactOpenNotebookDocument: (notebook: vscode.NotebookDocument, checkpoint: string) => void;
  readonly assertExactVisibleReleasedNotebookEditor: (
    notebook: vscode.NotebookDocument,
    editor: vscode.NotebookEditor,
    checkpoint: string
  ) => void;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ActiveSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<PageResponse>;
  readonly closeExactReleasedPythonInteractiveWindow: (interactive: vscode.NotebookDocument) => Promise<void>;
  readonly completedReleasedPythonSourceCells: (
    interactive: vscode.NotebookDocument,
    source: vscode.Uri
  ) => vscode.NotebookCell[];
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly invokeReleasedNotebookToolbarVariable: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    variableName: string
  ) => Promise<void>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedJupyterQuickPickRow: (quickInput: Locator, label: string) => Promise<Locator | undefined>;
  readonly releasedJupyterRouteLabel: (
    quickInput: Locator,
    routeLabels: readonly string[]
  ) => Promise<string | undefined>;
  readonly releasedPythonSourceCells: (
    interactive: vscode.NotebookDocument,
    source: vscode.Uri
  ) => vscode.NotebookCell[];
  readonly selectReleasedJupyterKernel: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    phase: "jupyter-allow",
    targetKernel: ReleasedPythonSourceKernelTarget
  ) => Promise<void>;
  readonly showExactReleasedNotebook: (notebook: vscode.NotebookDocument) => Promise<vscode.NotebookEditor>;
  readonly textDocumentTab: (uri: vscode.Uri) => vscode.Tab | undefined;
  readonly visibleReleasedJupyterQuickInput: (workbench: Page) => Promise<Locator | undefined>;
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
    expected: ReleasedPythonSourceVariableExpectation,
    description: string
  ) => Promise<ActiveSession>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: Thenable<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
}

export function createReleasedPythonSourceCellJourney({
  RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS,
  arrangePackagedProductSidebar,
  assertExactOpenNotebookDocument,
  assertExactVisibleReleasedNotebookEditor,
  assertReleasedSessionPage,
  closeExactReleasedPythonInteractiveWindow,
  completedReleasedPythonSourceCells,
  disposePackagedSessionPanel,
  invokeReleasedNotebookToolbarVariable,
  recordAcceptanceProgress,
  releasedJupyterQuickPickRow,
  releasedJupyterRouteLabel,
  releasedPythonSourceCells,
  selectReleasedJupyterKernel,
  showExactReleasedNotebook,
  textDocumentTab,
  visibleReleasedJupyterQuickInput,
  waitFor,
  waitForReleasedVariableSession,
  withBoundedAcceptancePromise
}: ReleasedPythonSourceCellJourneyDependencies) {
  return async function exerciseReleasedPythonSourceCellDiscovery(
    testing: TestApi,
    workbench: Page,
    directory: string,
    kernelTarget: ReleasedJupyterKernelTarget
  ): Promise<void> {
    const checkpoint = "jupyter-allow:python-source-cell-discovery";
    const sourcePath = path.join(directory, "python-source-cell.py");
    const source = vscode.Uri.file(sourcePath);
    const sourceBytes = Buffer.from(
      [
        "# %%",
        "import pandas as pd",
        "",
        "python_source_frame = pd.DataFrame({",
        '    "source_id": [920001, 920002, 920003],',
        '    "group": ["north", "south", "west"],',
        '    "score": [8.5, None, 19.25],',
        "})",
        "",
        "# %%",
        'python_source_not_run = pd.DataFrame({"unexpected": [1]})',
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(sourcePath, sourceBytes);

    const existingInteractive = new Set(
      vscode.workspace.notebookDocuments
        .filter((candidate) => !candidate.isClosed && candidate.notebookType === "interactive")
        .map((candidate) => candidate.uri.toString())
    );
    assert.equal(
      existingInteractive.size,
      0,
      "The ordinary Python-cell journey must start without an Interactive Window."
    );
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "The ordinary Python-cell journey must start without a session."
    );

    let interactive: vscode.NotebookDocument | undefined;
    let sourceDocument: vscode.TextDocument | undefined;
    try {
      recordAcceptanceProgress(`${checkpoint}:source`);
      sourceDocument = await vscode.workspace.openTextDocument(source);
      assert.equal(sourceDocument.languageId, "python");
      const sourceVersion = sourceDocument.version;
      const sourceEditor = await vscode.window.showTextDocument(sourceDocument, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false
      });
      assert.equal(sourceEditor.document, sourceDocument);
      sourceEditor.selection = new vscode.Selection(4, 0, 4, 0);
      await waitFor(
        () => vscode.window.activeTextEditor?.document === sourceDocument,
        10_000,
        "the exact Python source before its ordinary cell execution"
      );
      const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
      assert.ok(jupyterExtension, "The ordinary Python-cell journey requires the released Jupyter extension.");
      const jupyterApi = await jupyterExtension.activate();

      recordAcceptanceProgress(`${checkpoint}:run-cell`);
      type RunCellState =
        | { readonly kind: "pending" }
        | { readonly kind: "fulfilled" }
        | { readonly kind: "rejected"; readonly error: unknown };
      let runCellState: RunCellState = { kind: "pending" };
      const readRunCellState = (): RunCellState => runCellState;
      const runCellCommand = Promise.resolve(vscode.commands.executeCommand("jupyter.runcurrentcell")).then(
        () => (runCellState = { kind: "fulfilled" }),
        (error: unknown) => (runCellState = { kind: "rejected", error })
      );

      const deadline = Date.now() + RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS;
      const traversed = new Set<string>();
      let filterForTarget = false;
      let targetSelected = false;
      do {
        const candidates = vscode.workspace.notebookDocuments.filter(
          (candidate) =>
            !candidate.isClosed &&
            candidate.notebookType === "interactive" &&
            !existingInteractive.has(candidate.uri.toString())
        );
        assert.ok(
          candidates.length <= 1,
          "One Python source-cell execution must create at most one Interactive Window."
        );
        if (candidates[0]) {
          if (interactive) {
            assert.equal(
              candidates[0],
              interactive,
              "The ordinary Python source-cell execution replaced its Interactive Window."
            );
          } else {
            interactive = candidates[0];
            recordAcceptanceProgress(`${checkpoint}:interactive-window`);
          }
        }

        if (interactive && completedReleasedPythonSourceCells(interactive, source).length === 1) break;
        const currentRunCellState = readRunCellState();
        if (currentRunCellState.kind === "rejected") throw currentRunCellState.error;
        if (interactive && currentRunCellState.kind === "fulfilled") break;

        const picker = await visibleReleasedJupyterQuickInput(workbench);
        if (!picker) {
          await workbench.waitForTimeout(100);
          continue;
        }
        const target = await releasedJupyterQuickPickRow(picker, kernelTarget.label);
        if (target) {
          if (!targetSelected) {
            recordAcceptanceProgress(`${checkpoint}:kernel-picker-target`);
            await target.click();
            targetSelected = true;
          }
          await workbench.waitForTimeout(100);
          continue;
        }
        if (filterForTarget && !(await releasedJupyterRouteLabel(picker, kernelTarget.routeLabels))) {
          const input = picker.locator(".quick-input-box input:visible").first();
          if ((await input.count()) > 0) {
            await input.fill(kernelTarget.label);
            filterForTarget = false;
            await workbench.waitForTimeout(100);
            continue;
          }
        }
        let advanced = false;
        for (const label of ["Select Another Kernel...", ...kernelTarget.routeLabels]) {
          if (traversed.has(label)) continue;
          const row = await releasedJupyterQuickPickRow(picker, label);
          if (!row) continue;
          traversed.add(label);
          recordAcceptanceProgress(`${checkpoint}:kernel-picker-route`);
          await row.click();
          filterForTarget = kernelTarget.routeLabels.includes(label);
          advanced = true;
          break;
        }
        await workbench.waitForTimeout(advanced ? 100 : 50);
      } while (Date.now() < deadline);

      assert.ok(interactive, "Running the ordinary Python source cell must create one exact Interactive Window.");
      const interactiveDocument = interactive;
      assertExactOpenNotebookDocument(
        interactiveDocument,
        "before resolving the ordinary Python source cell's first-run kernel"
      );
      const runCellResult = await withBoundedAcceptancePromise(
        runCellCommand,
        10_000,
        "the ordinary Python source-cell command to finish"
      );
      if (runCellResult.kind === "rejected") throw runCellResult.error;
      assert.equal(runCellResult.kind, "fulfilled", "Jupyter's ordinary Run Cell command must complete.");
      let associatedCells = releasedPythonSourceCells(interactive, source);
      if (associatedCells.length === 0) {
        const selectedKernel = await jupyterApi.kernels.getKernel(interactiveDocument.uri);
        assertExactOpenNotebookDocument(
          interactiveDocument,
          "after resolving the ordinary Python source cell's initial kernel"
        );
        if (selectedKernel) {
          await waitFor(
            () => completedReleasedPythonSourceCells(interactiveDocument, source).length === 1,
            30_000,
            "the ordinary Python source cell to publish through its already selected kernel"
          );
          associatedCells = releasedPythonSourceCells(interactiveDocument, source);
        } else {
          await waitFor(
            () => {
              const editors = vscode.window.visibleNotebookEditors.filter(
                (candidate) => candidate.notebook === interactiveDocument
              );
              return editors.length === 1;
            },
            10_000,
            "the exact first-run Interactive editor before selecting its kernel"
          );
          const [interactiveEditor] = vscode.window.visibleNotebookEditors.filter(
            (candidate) => candidate.notebook === interactiveDocument
          );
          assert.ok(interactiveEditor, "The first-run Interactive Window must expose one exact editor.");
          if (vscode.window.activeNotebookEditor !== interactiveEditor) {
            const groupCount = vscode.window.tabGroups.all.length;
            for (let offset = 0; offset < groupCount; offset += 1) {
              await withBoundedAcceptancePromise(
                vscode.commands.executeCommand("workbench.action.focusNextGroup"),
                10_000,
                "the exact first-run Interactive editor to receive focus"
              );
              if (vscode.window.activeNotebookEditor === interactiveEditor) break;
            }
          }
          assertExactVisibleReleasedNotebookEditor(
            interactiveDocument,
            interactiveEditor,
            "before selecting its first-run kernel"
          );
          recordAcceptanceProgress(`${checkpoint}:select-kernel-after-first-run`);
          await selectReleasedJupyterKernel(
            workbench,
            interactiveDocument,
            interactiveEditor,
            "jupyter-allow",
            kernelTarget
          );
          assertExactOpenNotebookDocument(
            interactiveDocument,
            "after selecting the ordinary Python source cell's first-run kernel"
          );
        }
      }
      if (associatedCells.length === 0) {
        const restoredEditor = await vscode.window.showTextDocument(sourceDocument, {
          preview: false,
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false
        });
        assert.equal(restoredEditor.document, sourceDocument);
        restoredEditor.selection = new vscode.Selection(4, 0, 4, 0);
        await waitFor(
          () => vscode.window.activeTextEditor?.document === sourceDocument,
          10_000,
          "the exact Python source after its first-run kernel selection"
        );
        recordAcceptanceProgress(`${checkpoint}:run-cell-after-kernel`);
        assertExactOpenNotebookDocument(interactiveDocument, "before retrying the ordinary Python source cell");
        await withBoundedAcceptancePromise(
          vscode.commands.executeCommand<void>("jupyter.runcurrentcell"),
          30_000,
          "the ordinary Python source cell to run after kernel selection"
        );
        assertExactOpenNotebookDocument(interactiveDocument, "after retrying the ordinary Python source cell");
        await waitFor(
          () => completedReleasedPythonSourceCells(interactiveDocument, source).length === 1,
          30_000,
          "the ordinary Python source cell to publish after kernel selection"
        );
        associatedCells = releasedPythonSourceCells(interactive, source);
      }
      assert.ok(
        await jupyterApi.kernels.getKernel(interactiveDocument.uri),
        "The ordinary Python source cell must start its exact selected kernel."
      );
      assertExactOpenNotebookDocument(interactiveDocument, "after starting the ordinary Python source cell's kernel");
      assert.equal(associatedCells.length, 1, "The ordinary Python source cell must be associated exactly once.");
      const associatedMetadata = associatedCells[0]?.metadata as {
        interactive?: { lineIndex?: unknown };
      };
      assert.equal(
        associatedMetadata.interactive?.lineIndex,
        0,
        "The sole completed Interactive cell must belong to the first Python source cell."
      );
      assert.equal(
        completedReleasedPythonSourceCells(interactive, source).length,
        1,
        "The ordinary Python source cell must complete exactly once."
      );
      assert.equal(testing.activeSession(), undefined, "Running a Python cell must not open Open Wrangler by itself.");
      assert.equal(
        testing.diagnostics().sessionCount,
        0,
        "Running a Python cell must not retain an Open Wrangler session."
      );
      assert.equal(sourceDocument.version, sourceVersion, "Running a Python cell must not edit its source document.");
      assertExactBytes(readFileSync(sourcePath), sourceBytes, "Running a Python cell must not change its source file.");

      recordAcceptanceProgress(`${checkpoint}:operations`);
      const restoredSourceEditor = await vscode.window.showTextDocument(sourceDocument, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false
      });
      assert.equal(restoredSourceEditor.document, sourceDocument);
      restoredSourceEditor.selection = new vscode.Selection(4, 0, 4, 0);
      await waitFor(
        () => vscode.window.activeTextEditor?.document === sourceDocument,
        10_000,
        "the exact Python source while Operations discovers its Interactive dataframe"
      );
      const sidebar = await arrangePackagedProductSidebar(workbench, "operation-catalog");
      assert.equal(
        vscode.window.activeTextEditor?.document,
        sourceDocument,
        "Opening the Open Wrangler sidebar must retain the exact active Python source."
      );
      const operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
      const liveFrame = operations.getByRole("treeitem", { name: /^python_source_frame\b/u });
      await liveFrame.waitFor({ state: "visible", timeout: 90_000 });
      assert.equal(
        vscode.window.activeTextEditor?.document,
        sourceDocument,
        "Operations must discover the dataframe while the exact Python source remains active."
      );
      assert.equal(
        vscode.window.activeNotebookEditor,
        undefined,
        "Operations discovery must not silently reactivate the Python Interactive Window."
      );
      assert.match(
        (await liveFrame.innerText()).replace(/\s+/gu, " "),
        /python_source_frame.*Pandas · DataFrame/u,
        "Operations must automatically list the Pandas dataframe from the source's Interactive kernel."
      );
      assert.equal(
        await operations.getByRole("treeitem", { name: /^python_source_not_run\b/u }).count(),
        0,
        "Running the first Python source cell must not execute the later sentinel cell."
      );

      recordAcceptanceProgress(`${checkpoint}:interactive-toolbar`);
      const interactiveEditor = await showExactReleasedNotebook(interactive);
      assertExactOpenNotebookDocument(interactive, "after acquiring Jupyter for the ordinary Python cell");
      const originalKernel = await jupyterApi.kernels.getKernel(interactive.uri);
      assertExactOpenNotebookDocument(interactive, "after acquiring the ordinary Python cell's kernel");
      assert.ok(originalKernel, "The ordinary Python source cell must retain its selected kernel.");
      assertExactVisibleReleasedNotebookEditor(interactive, interactiveEditor, "before opening its existing dataframe");

      const originalInteractiveDocuments = vscode.workspace.notebookDocuments.filter(
        (candidate) => !candidate.isClosed && candidate.notebookType === "interactive"
      );
      const originalInteractiveVersion = interactive.version;
      const originalInteractiveCells = interactive.getCells().map((cell) => ({
        cell,
        executionSummary: {
          success: cell.executionSummary?.success,
          executionOrder: cell.executionSummary?.executionOrder,
          startTime: cell.executionSummary?.timing?.startTime,
          endTime: cell.executionSummary?.timing?.endTime
        }
      }));

      await invokeReleasedNotebookToolbarVariable(workbench, interactive, "python_source_frame");
      const opened = await waitForReleasedVariableSession(
        workbench,
        testing,
        interactive,
        {
          name: "python_source_frame",
          type: "pandas.core.frame.DataFrame",
          backend: "pandas",
          firstValue: "920001"
        },
        "the Pandas dataframe opened without rerunning its ordinary Python source cell"
      );
      assert.equal(opened.metadata.mode, "editing");
      assert.deepEqual(opened.metadata.shape, { rows: 3, columns: 3 });
      await assertReleasedSessionPage(testing, opened, "920001", "released-jupyter-python-source-cell-page");

      const currentKernel = await jupyterApi.kernels.getKernel(interactive.uri);
      assertExactOpenNotebookDocument(interactive, "after opening the ordinary Python cell's existing dataframe");
      assert.equal(currentKernel, originalKernel, "Opening the existing dataframe must reuse the same kernel.");
      assert.equal(
        interactive.version,
        originalInteractiveVersion,
        "Opening the existing dataframe must not edit or execute the Interactive notebook."
      );
      const currentInteractiveCells = interactive.getCells();
      assert.equal(
        currentInteractiveCells.length,
        originalInteractiveCells.length,
        "Opening the existing dataframe must not add another Interactive cell."
      );
      for (const [index, original] of originalInteractiveCells.entries()) {
        const current = currentInteractiveCells[index];
        assert.equal(current, original.cell, `Interactive cell ${index} changed while opening the existing dataframe.`);
        assert.deepEqual(
          {
            success: current.executionSummary?.success,
            executionOrder: current.executionSummary?.executionOrder,
            startTime: current.executionSummary?.timing?.startTime,
            endTime: current.executionSummary?.timing?.endTime
          },
          original.executionSummary,
          `Interactive cell ${index} ran again while opening the existing dataframe.`
        );
      }
      assert.equal(
        releasedPythonSourceCells(interactive, source).length,
        1,
        "Opening the existing dataframe must not rerun its source cell."
      );
      assert.equal(
        await operations.getByRole("treeitem", { name: /^python_source_not_run\b/u }).count(),
        0,
        "Opening the existing dataframe must not execute the later sentinel cell."
      );
      const currentInteractiveDocuments = vscode.workspace.notebookDocuments.filter(
        (candidate) => !candidate.isClosed && candidate.notebookType === "interactive"
      );
      assert.equal(
        currentInteractiveDocuments.length,
        originalInteractiveDocuments.length,
        "Opening the existing dataframe must not create another Interactive Window."
      );
      for (const original of originalInteractiveDocuments) {
        assert.ok(
          currentInteractiveDocuments.includes(original),
          "Opening the dataframe must retain its exact Interactive Window."
        );
      }
      assert.equal(sourceDocument.version, sourceVersion, "Opening the dataframe must not edit its Python source.");
      assertExactBytes(
        readFileSync(sourcePath),
        sourceBytes,
        "Opening the dataframe must not change its Python source file."
      );

      recordAcceptanceProgress(`${checkpoint}:close`);
      await disposePackagedSessionPanel(testing, opened.sessionId, "the ordinary Python source-cell Pandas session");
      assert.equal(testing.diagnostics().sessionCount, 0);
      await closeExactReleasedPythonInteractiveWindow(interactive);
      const sourceTab = textDocumentTab(source);
      assert.ok(sourceTab, "The ordinary Python-cell journey must retain its exact source tab.");
      assert.equal(
        await withBoundedAcceptancePromise(
          vscode.window.tabGroups.close(sourceTab, true),
          10_000,
          "the ordinary Python source-cell tab to close"
        ),
        true
      );
      await waitFor(
        () => textDocumentTab(source) === undefined,
        10_000,
        "the ordinary Python source-cell tab to close"
      );
      recordAcceptanceProgress(`${checkpoint}:complete`);
    } finally {
      const active = testing.activeSession();
      if (
        active?.metadata.source.kind === "notebookVariable" &&
        active.metadata.source.variableName === "python_source_frame"
      ) {
        try {
          await disposePackagedSessionPanel(
            testing,
            active.sessionId,
            "the failed ordinary Python source-cell session"
          );
        } catch {
          // The outer editor-process teardown remains the bounded fallback for the original failure.
        }
      }
      if (!interactive) {
        const candidates = vscode.workspace.notebookDocuments.filter(
          (candidate) =>
            !candidate.isClosed &&
            candidate.notebookType === "interactive" &&
            !existingInteractive.has(candidate.uri.toString())
        );
        if (candidates.length === 1) interactive = candidates[0];
      }
      if (interactive && !interactive.isClosed) {
        try {
          await closeExactReleasedPythonInteractiveWindow(interactive);
        } catch {
          // Preserve the original acceptance failure.
        }
      }
      const sourceTab = textDocumentTab(source);
      if (sourceTab) {
        try {
          await withBoundedAcceptancePromise(
            vscode.window.tabGroups.close(sourceTab, true),
            10_000,
            "the failed ordinary Python source-cell tab to close"
          );
        } catch {
          // Preserve the original acceptance failure.
        }
      }
      assertExactBytes(
        readFileSync(sourcePath),
        sourceBytes,
        "Ordinary Python source-cell cleanup must not change its source file."
      );
    }
  };
}
