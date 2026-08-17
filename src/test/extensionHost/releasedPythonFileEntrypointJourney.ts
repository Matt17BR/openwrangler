import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Jupyter } from "@vscode/jupyter-extension";
import type { Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import type { OpenWranglerResponse } from "../../shared/protocol";
import { assertExactBytes } from "./acceptanceSourceFixture";
import type { TestApi } from "./extensionHostTestApi";
import { createReleasedPythonTerminalFailureObserver } from "./releasedPythonTerminalFailure";

type ActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;
type PageResponse = Extract<OpenWranglerResponse, { kind: "page" }>;

interface ReleasedPythonFileKernelTarget {
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

type ReleasedJupyterKernelTarget = ReleasedPythonFileKernelTarget;

interface ReleasedPythonFileVariableExpectation {
  readonly name: string;
  readonly type: string;
  readonly backend: "polars";
  readonly firstValue: string;
  readonly notebookInsert?: boolean;
}

export interface ReleasedPythonFileEntrypointJourneyDependencies {
  readonly RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS: number;
  readonly WORKBENCH_PLAYWRIGHT_TIMEOUT_MS: number;
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
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly invokeReleasedNotebookToolbarVariable: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    variableName: string
  ) => Promise<void>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedJupyterQuickInputDiagnostics: (workbench: Page) => Promise<string[]>;
  readonly releasedJupyterQuickPickRow: (quickInput: Locator, label: string) => Promise<Locator | undefined>;
  readonly releasedJupyterRouteLabel: (
    quickInput: Locator,
    routeLabels: readonly string[]
  ) => Promise<string | undefined>;
  readonly releasedPythonEntrypointDiagnostics: (
    interactive: vscode.NotebookDocument | undefined,
    source: vscode.TextDocument
  ) => string;
  readonly releasedPythonFailureNotification: (workbench: Page) => Promise<string | undefined>;
  readonly showExactReleasedNotebook: (notebook: vscode.NotebookDocument) => Promise<vscode.NotebookEditor>;
  readonly textDocumentTab: (uri: vscode.Uri) => vscode.Tab | undefined;
  readonly visibleReleasedJupyterQuickInput: (workbench: Page) => Promise<Locator | undefined>;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
  readonly waitForReleasedVariableSession: (
    workbench: Page,
    testing: TestApi,
    notebook: vscode.NotebookDocument,
    expected: ReleasedPythonFileVariableExpectation,
    description: string
  ) => Promise<ActiveSession>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: Thenable<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
}

export function createReleasedPythonFileEntrypointJourney({
  RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS,
  WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
  arrangePackagedProductSidebar,
  assertExactOpenNotebookDocument,
  assertExactVisibleReleasedNotebookEditor,
  assertReleasedSessionPage,
  closeExactReleasedPythonInteractiveWindow,
  disposePackagedSessionPanel,
  invokeReleasedNotebookToolbarVariable,
  recordAcceptanceProgress,
  releasedJupyterQuickInputDiagnostics,
  releasedJupyterQuickPickRow,
  releasedJupyterRouteLabel,
  releasedPythonEntrypointDiagnostics,
  releasedPythonFailureNotification,
  showExactReleasedNotebook,
  textDocumentTab,
  visibleReleasedJupyterQuickInput,
  waitFor,
  waitForReleasedVariableSession,
  withBoundedAcceptancePromise
}: ReleasedPythonFileEntrypointJourneyDependencies) {
  return async function exerciseReleasedPythonFileEntrypoint(
    testing: TestApi,
    workbench: Page,
    directory: string,
    kernelTarget: ReleasedJupyterKernelTarget
  ): Promise<void> {
    const checkpoint = "jupyter-allow:python-file-entrypoint";
    const sourcePath = path.join(directory, "python-entrypoint.py");
    const source = vscode.Uri.file(sourcePath);
    const sourceBytes = Buffer.from(
      [
        "# %%",
        "import polars as pl",
        "",
        "python_entry_frame = pl.DataFrame({",
        '    "entry_id": [910001, 910002, 910003],',
        '    "segment": ["alpha", "beta", "gamma"],',
        '    "amount": [12.5, None, 41.25],',
        "})",
        "",
        "# %%",
        'python_entry_not_run = pl.DataFrame({"unexpected": [1]})',
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
    assert.equal(existingInteractive.size, 0, "The Python-file journey must start without an Interactive Window.");

    let interactive: vscode.NotebookDocument | undefined;
    try {
      recordAcceptanceProgress(`${checkpoint}:source`);
      const sourceDocument = await vscode.workspace.openTextDocument(source);
      assert.equal(sourceDocument.languageId, "python");
      const sourceEditor = await vscode.window.showTextDocument(sourceDocument, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false
      });
      sourceEditor.selection = new vscode.Selection(4, 0, 4, 0);
      await waitFor(
        () => vscode.window.activeTextEditor?.document === sourceDocument,
        10_000,
        "the exact Python source before its editor action"
      );

      recordAcceptanceProgress(`${checkpoint}:title-action`);
      await workbench.bringToFront();
      const activeGroup = workbench.locator(".part.editor .editor-group-container.active:visible");
      assert.equal(await activeGroup.count(), 1, "The Python entry point requires one active editor group.");
      const action = activeGroup.getByRole("button", { name: "Open in Open Wrangler", exact: true });
      await action.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      assert.equal(await action.count(), 1, "The Python editor must expose one Open in Open Wrangler title action.");
      assert.equal(await action.isEnabled(), true, "The trusted Python editor title action must be enabled.");
      const initialPythonInvocation = testing.pythonInteractiveDiagnostics()?.invocation ?? 0;
      const observePythonTerminalFailure = createReleasedPythonTerminalFailureObserver({
        initialInvocation: initialPythonInvocation,
        checkpoint,
        recordProgress: recordAcceptanceProgress,
        terminalError: (pythonDiagnostics) =>
          new Error(
            `The Python editor action failed after ${pythonDiagnostics.lastActiveStage ?? "an unknown stage"}. ` +
              `Python Interactive: ${JSON.stringify(pythonDiagnostics)}.`
          )
      });
      await action.click({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });

      const deadline = Date.now() + RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS;
      const traversed = new Set<string>();
      let filterForTarget = false;
      let targetSelected = false;
      let pickerSeen = false;
      do {
        await observePythonTerminalFailure(testing.pythonInteractiveDiagnostics());
        const candidates = vscode.workspace.notebookDocuments.filter(
          (candidate) =>
            !candidate.isClosed &&
            candidate.notebookType === "interactive" &&
            !existingInteractive.has(candidate.uri.toString())
        );
        assert.ok(candidates.length <= 1, "The Python editor action must create at most one Interactive Window.");
        if (candidates[0]) {
          if (interactive) {
            assert.equal(candidates[0], interactive, "The Python editor action replaced its Interactive Window.");
          } else {
            interactive = candidates[0];
            recordAcceptanceProgress(`${checkpoint}:interactive-window`);
          }
        }

        const active = testing.activeSession();
        if (
          interactive &&
          active?.metadata.source.kind === "notebookVariable" &&
          active.metadata.source.variableName === "python_entry_frame" &&
          active.metadata.backend === "polars"
        ) {
          break;
        }

        const pythonFailure = await releasedPythonFailureNotification(workbench);
        if (pythonFailure) throw new Error(`The Python editor action failed (${pythonFailure}).`);

        const picker = await visibleReleasedJupyterQuickInput(workbench);
        if (!picker) {
          await workbench.waitForTimeout(100);
          continue;
        }
        if (!pickerSeen) {
          pickerSeen = true;
          recordAcceptanceProgress(`${checkpoint}:kernel-picker-visible`);
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

      assert.ok(interactive, "The Python editor action must create one exact Interactive Window.");
      const active = testing.activeSession();
      if (
        !active ||
        active.metadata.source.kind !== "notebookVariable" ||
        active.metadata.source.variableName !== "python_entry_frame" ||
        active.metadata.backend !== "polars"
      ) {
        throw new Error(
          "The Python editor action did not open its native Polars dataframe. " +
            `Kernel picker: ${pickerSeen ? (targetSelected ? "target-selected" : "visible") : "not-seen"}. ` +
            `Python Interactive: ${JSON.stringify(testing.pythonInteractiveDiagnostics())}. ` +
            `Coordinator: ${JSON.stringify(testing.diagnostics())}. ` +
            `Quick Input: ${JSON.stringify(await releasedJupyterQuickInputDiagnostics(workbench))}. ` +
            `Interactive Window: ${releasedPythonEntrypointDiagnostics(interactive, sourceDocument)}.`
        );
      }
      assertExactOpenNotebookDocument(interactive, "after the Python editor action opened its dataframe");
      assert.equal(active.metadata.mode, "editing");
      assert.deepEqual(active.metadata.shape, { rows: 3, columns: 3 });
      assert.deepEqual(
        active.metadata.schema.map((column) => column.name),
        ["entry_id", "segment", "amount"]
      );
      assert.equal(active.metadata.capabilities.notebookInsert, true);
      assert.equal(active.metadata.source.uri, interactive.uri.toString());

      const sourceNotebookMatches = vscode.workspace.notebookDocuments.filter(
        (candidate) => !candidate.isClosed && candidate.uri.toString() === active.metadata.source.uri
      );
      assert.equal(sourceNotebookMatches.length, 1);
      assert.equal(sourceNotebookMatches[0], interactive);
      const associatedCells = interactive.getCells().filter((cell) => {
        const metadata = cell.metadata as {
          interactive?: { uristring?: unknown; lineIndex?: unknown };
        };
        return metadata.interactive?.uristring === source.toString() && metadata.interactive.lineIndex === 0;
      });
      assert.equal(
        associatedCells.length,
        1,
        "The live session must come from the exact Python cell dispatched by the editor action."
      );
      const page = await assertReleasedSessionPage(
        testing,
        active,
        "910001",
        "released-jupyter-python-file-polars-page"
      );
      assert.deepEqual(
        page.page.rows.map((row) => row.values.map((value) => value.display)),
        [
          ["910001", "alpha", "12.5"],
          ["910002", "beta", ""],
          ["910003", "gamma", "41.25"]
        ]
      );
      assertExactBytes(
        readFileSync(sourcePath),
        sourceBytes,
        "Opening the Python file must not change its source file."
      );

      recordAcceptanceProgress(`${checkpoint}:close`);
      await disposePackagedSessionPanel(testing, active.sessionId, "the Python editor's live Polars session");
      assert.equal(testing.diagnostics().sessionCount, 0);
      assert.equal(sourceDocument.isClosed, false, "The Python-file journey must retain its exact source document.");

      recordAcceptanceProgress(`${checkpoint}:interactive-toolbar`);
      const interactiveEditor = await showExactReleasedNotebook(interactive);
      const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
      assert.ok(jupyterExtension, "The Python Interactive journey requires the released Jupyter extension.");
      const jupyterApi = await jupyterExtension.activate();
      assertExactOpenNotebookDocument(interactive, "after acquiring Jupyter for its Interactive Window");
      const originalKernel = await jupyterApi.kernels.getKernel(interactive.uri);
      assertExactOpenNotebookDocument(interactive, "after acquiring its Interactive Window kernel");
      assert.ok(originalKernel, "The Python Interactive Window must retain its selected kernel.");
      assertExactVisibleReleasedNotebookEditor(
        interactive,
        interactiveEditor,
        "before invoking its Open Wrangler toolbar action"
      );

      const sidebar = await arrangePackagedProductSidebar(workbench, "operation-catalog");
      const operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
      const liveFrame = operations.getByRole("treeitem", { name: /^python_entry_frame\b/u });
      await liveFrame.waitFor({ state: "visible", timeout: 90_000 });
      assert.match(
        (await liveFrame.innerText()).replace(/\s+/gu, " "),
        /python_entry_frame.*Polars · DataFrame/u,
        "Operations must expose the dataframe from the exact active Python Interactive kernel."
      );
      assert.equal(
        await operations.getByRole("treeitem", { name: /^python_entry_not_run\b/u }).count(),
        0,
        "Opening the first Python cell must not execute a later cell in the source file."
      );

      await showExactReleasedNotebook(interactive);
      assertExactVisibleReleasedNotebookEditor(
        interactive,
        interactiveEditor,
        "after checking its Operations dataframe list"
      );

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

      await invokeReleasedNotebookToolbarVariable(workbench, interactive, "python_entry_frame");
      const reopened = await waitForReleasedVariableSession(
        workbench,
        testing,
        interactive,
        {
          name: "python_entry_frame",
          type: "polars.dataframe.frame.DataFrame",
          backend: "polars",
          firstValue: "910001"
        },
        "the existing Polars dataframe reopened from the exact Python Interactive Window"
      );
      assert.equal(reopened.metadata.mode, "editing");
      assert.deepEqual(reopened.metadata.shape, { rows: 3, columns: 3 });
      await assertReleasedSessionPage(testing, reopened, "910001", "released-jupyter-python-interactive-toolbar-page");

      const currentKernel = await jupyterApi.kernels.getKernel(interactive.uri);
      assertExactOpenNotebookDocument(interactive, "after reopening from its Interactive Window toolbar");
      assert.equal(currentKernel, originalKernel, "The Interactive Window toolbar action must reuse the same kernel.");
      assert.equal(
        interactive.version,
        originalInteractiveVersion,
        "Opening an existing Interactive variable must not edit or execute the Interactive notebook."
      );
      const currentInteractiveCells = interactive.getCells();
      assert.equal(
        currentInteractiveCells.length,
        originalInteractiveCells.length,
        "Opening an existing Interactive variable must not add another cell."
      );
      for (const [index, original] of originalInteractiveCells.entries()) {
        const current = currentInteractiveCells[index];
        assert.equal(current, original.cell, `Interactive cell ${index} changed while opening an existing variable.`);
        assert.deepEqual(
          {
            success: current.executionSummary?.success,
            executionOrder: current.executionSummary?.executionOrder,
            startTime: current.executionSummary?.timing?.startTime,
            endTime: current.executionSummary?.timing?.endTime
          },
          original.executionSummary,
          `Interactive cell ${index} was executed again while opening an existing variable.`
        );
      }
      const currentInteractiveDocuments = vscode.workspace.notebookDocuments.filter(
        (candidate) => !candidate.isClosed && candidate.notebookType === "interactive"
      );
      assert.equal(
        currentInteractiveDocuments.length,
        originalInteractiveDocuments.length,
        "The Interactive Window toolbar action must not create another Interactive Window."
      );
      for (const original of originalInteractiveDocuments) {
        assert.ok(
          currentInteractiveDocuments.includes(original),
          "The Interactive Window toolbar action must retain every exact Interactive document."
        );
      }

      recordAcceptanceProgress(`${checkpoint}:interactive-toolbar-close`);
      await disposePackagedSessionPanel(testing, reopened.sessionId, "the Python Interactive toolbar Polars session");
      assert.equal(testing.diagnostics().sessionCount, 0);
      await closeExactReleasedPythonInteractiveWindow(interactive);
      const sourceTab = textDocumentTab(source);
      assert.ok(sourceTab, "The Python-file journey must retain its exact source tab.");
      assert.equal(
        await withBoundedAcceptancePromise(
          vscode.window.tabGroups.close(sourceTab, true),
          10_000,
          "the Python entry-point source tab to close"
        ),
        true
      );
      await waitFor(() => textDocumentTab(source) === undefined, 10_000, "the Python entry-point source tab to close");
      assert.equal(
        vscode.window.visibleTextEditors.some((editor) => editor.document === sourceDocument),
        false,
        "The closed Python entry-point source must not remain visible in another editor."
      );
      recordAcceptanceProgress(`${checkpoint}:complete`);
    } finally {
      const active = testing.activeSession();
      if (
        active?.metadata.source.kind === "notebookVariable" &&
        active.metadata.source.variableName === "python_entry_frame"
      ) {
        try {
          await disposePackagedSessionPanel(testing, active.sessionId, "the failed Python editor entry-point session");
        } catch {
          // The outer editor-process teardown remains the bounded fallback for the original failure.
        }
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
            "the failed Python entry-point source tab to close"
          );
        } catch {
          // Preserve the original acceptance failure.
        }
      }
      assertExactBytes(
        readFileSync(sourcePath),
        sourceBytes,
        "Python entry-point cleanup must not change its source file."
      );
    }
  };
}
