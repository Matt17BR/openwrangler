import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import { assertExactBytes } from "./acceptanceSourceFixture";
import type { TestApi } from "./extensionHostTestApi";
import { probeAcceptanceBeforeDeadline } from "./playwrightLifecycle";
import type { ReleasedPythonQuartoDocumentFixture } from "./releasedDocumentFixtures";
import { createReleasedPythonTerminalFailureObserver } from "./releasedPythonTerminalFailure";

const RELEASED_QUARTO_PYTHON_KERNEL_LABEL = "Python (Open Wrangler Quarto)";
const RELEASED_QUARTO_PYTHON_KERNEL_NAME = "python3";

type ReleasedPythonQuartoActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;

interface ReleasedJupyterKernelTarget {
  readonly label: string;
  readonly name: string;
  readonly routeLabels: readonly string[];
}

interface ReleasedPythonQuartoDocumentJourneyDependencies {
  readonly RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS: number;
  readonly WORKBENCH_DIAGNOSTIC_TIMEOUT_MS: number;
  readonly WORKBENCH_OPERATION_TIMEOUT_MS: number;
  readonly activateReleasedRInteractiveTitleAction: (
    workbench: Page,
    sourceDocument: vscode.TextDocument
  ) => Promise<void>;
  readonly arrangePackagedProductSidebar: (workbench: Page, scene: "operation-catalog") => Promise<Locator>;
  readonly assertExactOpenNotebookDocument: (notebook: vscode.NotebookDocument, checkpoint: string) => void;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ReleasedPythonQuartoActiveSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<unknown>;
  readonly boundedReleasedJupyterQuickInputDiagnostics: (workbench: Page) => Promise<string[] | string>;
  readonly closeExactReleasedPythonInteractiveWindow: (interactive: vscode.NotebookDocument) => Promise<void>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
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
  readonly visibleReleasedJupyterConsentCount: (workbench: Page) => Promise<number>;
  readonly visibleReleasedJupyterQuickInput: (workbench: Page) => Promise<Locator | undefined>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForReleasedJupyterConsent: (
    workbench: Page,
    testing: TestApi
  ) => Promise<{ dialog: Locator; allow: Locator; deny: Locator }>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: PromiseLike<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
}

export function createReleasedPythonQuartoDocumentJourney({
  RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS,
  WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  activateReleasedRInteractiveTitleAction,
  arrangePackagedProductSidebar,
  assertExactOpenNotebookDocument,
  assertReleasedSessionPage,
  boundedReleasedJupyterQuickInputDiagnostics,
  closeExactReleasedPythonInteractiveWindow,
  disposePackagedSessionPanel,
  recordAcceptanceProgress,
  releasedJupyterQuickPickRow,
  releasedJupyterRouteLabel,
  releasedPythonEntrypointDiagnostics,
  releasedPythonFailureNotification,
  showExactReleasedNotebook,
  textDocumentTab,
  visibleReleasedJupyterConsentCount,
  visibleReleasedJupyterQuickInput,
  waitFor,
  waitForReleasedJupyterConsent,
  withBoundedAcceptancePromise
}: ReleasedPythonQuartoDocumentJourneyDependencies) {
  return async function exerciseReleasedPythonQuartoDocumentJourney(
    testing: TestApi,
    workbench: Page,
    fixture: ReleasedPythonQuartoDocumentFixture
  ): Promise<void> {
    const checkpoint = "jupyter-r:document:python-quarto";
    const target: ReleasedJupyterKernelTarget = {
      label: RELEASED_QUARTO_PYTHON_KERNEL_LABEL,
      name: RELEASED_QUARTO_PYTHON_KERNEL_NAME,
      routeLabels: ["Jupyter Kernel...", "Jupyter", "Local Kernel Specs..."]
    };
    const existingInteractive = new Set(
      vscode.workspace.notebookDocuments
        .filter((candidate) => !candidate.isClosed && candidate.notebookType === "interactive")
        .map((candidate) => candidate.uri.toString())
    );
    assert.equal(existingInteractive.size, 0, "The Python Quarto journey must start without an Interactive Window.");
    assert.equal(testing.diagnostics().sessionCount, 0, "The Python Quarto journey must start without a session.");

    let interactive: vscode.NotebookDocument | undefined;
    let sourceDocument: vscode.TextDocument | undefined;
    try {
      recordAcceptanceProgress(`${checkpoint}:source`);
      sourceDocument = await vscode.workspace.openTextDocument(fixture.sourceUri);
      assert.equal(sourceDocument.languageId, "quarto", "The official Quarto extension must own the Python fixture.");
      const sourceText = sourceDocument.getText();
      const sourceVersion = sourceDocument.version;
      const sourceEditor = await vscode.window.showTextDocument(sourceDocument, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false
      });
      const dataframeLine = sourceText.split("\n").findIndex((line) => line.includes(`${fixture.variableName} =`));
      assert.ok(dataframeLine >= 0, "The Python Quarto fixture must contain its dataframe construction line.");
      sourceEditor.selection = new vscode.Selection(dataframeLine, 0, dataframeLine, 0);
      await waitFor(
        () => vscode.window.activeTextEditor?.document === sourceDocument,
        10_000,
        "the exact Python Quarto source before its editor action"
      );

      const initialPythonInvocation = testing.pythonInteractiveDiagnostics()?.invocation ?? 0;
      const terminalFailureSourceDocument = sourceDocument;
      const observePythonTerminalFailure = createReleasedPythonTerminalFailureObserver({
        initialInvocation: initialPythonInvocation,
        checkpoint,
        recordProgress: recordAcceptanceProgress,
        terminalError: async (pythonDiagnostics) => {
          const quickInputDiagnostics = await boundedReleasedJupyterQuickInputDiagnostics(workbench);
          return new Error(
            "The Python Quarto action reported a terminal failure. " +
              `Python Interactive: ${JSON.stringify(pythonDiagnostics)}. ` +
              `Interactive Window: ${releasedPythonEntrypointDiagnostics(interactive, terminalFailureSourceDocument)}. ` +
              `Quick Input: ${JSON.stringify(quickInputDiagnostics)}.`
          );
        }
      });
      recordAcceptanceProgress(`${checkpoint}:title-action`);
      await workbench.bringToFront();
      await activateReleasedRInteractiveTitleAction(workbench, sourceDocument);

      const deadline = Date.now() + RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS;
      const traversed = new Set<string>();
      let filterForTarget = false;
      let targetSelected = false;
      let consentAccepted = false;
      let pickerStage: "not-seen" | "visible" | "route-found" | "target-found" = "not-seen";
      do {
        await observePythonTerminalFailure(testing.pythonInteractiveDiagnostics());
        const candidates = vscode.workspace.notebookDocuments.filter(
          (candidate) =>
            !candidate.isClosed &&
            candidate.notebookType === "interactive" &&
            !existingInteractive.has(candidate.uri.toString())
        );
        assert.ok(candidates.length <= 1, "The Python Quarto action must create at most one Interactive Window.");
        if (candidates[0]) {
          if (interactive) {
            assert.equal(candidates[0], interactive, "The Python Quarto action replaced its Interactive Window.");
          } else {
            interactive = candidates[0];
            recordAcceptanceProgress(`${checkpoint}:interactive-window`);
          }
        }

        const active = testing.activeSession();
        if (
          interactive &&
          active?.metadata.source.kind === "notebookVariable" &&
          active.metadata.source.variableName === fixture.variableName &&
          active.metadata.backend === "pandas"
        ) {
          break;
        }

        const passiveProbeDeadline = Date.now() + WORKBENCH_DIAGNOSTIC_TIMEOUT_MS;
        const pythonFailure = await probeAcceptanceBeforeDeadline(
          () => releasedPythonFailureNotification(workbench),
          passiveProbeDeadline
        );
        if (pythonFailure) {
          throw new Error(`The Python Quarto action failed (${pythonFailure}).`);
        }

        if (
          !consentAccepted &&
          (await probeAcceptanceBeforeDeadline(
            () => visibleReleasedJupyterConsentCount(workbench),
            passiveProbeDeadline
          )) === 1
        ) {
          const consent = await withBoundedAcceptancePromise(
            waitForReleasedJupyterConsent(workbench, testing),
            WORKBENCH_OPERATION_TIMEOUT_MS,
            "Python Quarto released-Jupyter consent"
          );
          recordAcceptanceProgress(`${checkpoint}:consent`);
          await withBoundedAcceptancePromise(
            consent.allow.click(),
            WORKBENCH_OPERATION_TIMEOUT_MS,
            "Python Quarto consent acceptance"
          );
          await withBoundedAcceptancePromise(
            consent.dialog.waitFor({ state: "hidden", timeout: 10_000 }),
            WORKBENCH_OPERATION_TIMEOUT_MS,
            "Python Quarto consent dismissal"
          );
          consentAccepted = true;
          continue;
        }

        const picker = await probeAcceptanceBeforeDeadline(
          () => visibleReleasedJupyterQuickInput(workbench),
          passiveProbeDeadline
        );
        if (!picker) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          continue;
        }
        if (pickerStage === "not-seen") {
          pickerStage = "visible";
          recordAcceptanceProgress(`${checkpoint}:kernel-picker-visible`);
        }
        const kernel = await probeAcceptanceBeforeDeadline(
          () => releasedJupyterQuickPickRow(picker, target.label),
          passiveProbeDeadline
        );
        if (kernel) {
          pickerStage = "target-found";
          if (!targetSelected) {
            recordAcceptanceProgress(`${checkpoint}:kernel-picker-target`);
            await withBoundedAcceptancePromise(
              kernel.click(),
              WORKBENCH_OPERATION_TIMEOUT_MS,
              "Python Quarto target-kernel selection"
            );
            targetSelected = true;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          continue;
        }
        if (
          filterForTarget &&
          !(await probeAcceptanceBeforeDeadline(
            () => releasedJupyterRouteLabel(picker, target.routeLabels),
            passiveProbeDeadline
          ))
        ) {
          const input = picker.locator(".quick-input-box input:visible").first();
          if ((await probeAcceptanceBeforeDeadline(() => input.count(), passiveProbeDeadline)) === 1) {
            await withBoundedAcceptancePromise(
              input.fill(target.label),
              WORKBENCH_OPERATION_TIMEOUT_MS,
              "Python Quarto kernel filtering"
            );
            filterForTarget = false;
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            continue;
          }
        }
        let advanced = false;
        for (const label of ["Select Another Kernel...", ...target.routeLabels]) {
          if (traversed.has(label)) continue;
          const row = await probeAcceptanceBeforeDeadline(
            () => releasedJupyterQuickPickRow(picker, label),
            passiveProbeDeadline
          );
          if (!row) continue;
          if (pickerStage !== "target-found") pickerStage = "route-found";
          traversed.add(label);
          recordAcceptanceProgress(`${checkpoint}:kernel-picker-route`);
          await withBoundedAcceptancePromise(
            row.click(),
            WORKBENCH_OPERATION_TIMEOUT_MS,
            `Python Quarto kernel-route ${JSON.stringify(label)} selection`
          );
          filterForTarget = target.routeLabels.includes(label);
          advanced = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, advanced ? 100 : 50));
      } while (Date.now() < deadline);

      assert.ok(
        interactive,
        `The Python Quarto action must create one exact Interactive Window (picker: ${pickerStage}).`
      );
      const active = testing.activeSession();
      if (
        !active ||
        active.metadata.source.kind !== "notebookVariable" ||
        active.metadata.source.variableName !== fixture.variableName ||
        active.metadata.backend !== "pandas"
      ) {
        throw new Error(
          "The Python Quarto action did not open its Pandas dataframe. " +
            `Kernel picker: ${pickerStage}. ` +
            `Python Interactive: ${JSON.stringify(testing.pythonInteractiveDiagnostics())}. ` +
            `Coordinator: ${JSON.stringify(testing.diagnostics())}. ` +
            `Quick Input: ${JSON.stringify(await boundedReleasedJupyterQuickInputDiagnostics(workbench))}. ` +
            `Interactive Window: ${releasedPythonEntrypointDiagnostics(interactive, sourceDocument)}.`
        );
      }
      assertExactOpenNotebookDocument(interactive, "after the Python Quarto action opened its dataframe");
      assert.equal(active.metadata.mode, "viewing", "Live Quarto notebook variables must honor notebookStartMode.");
      assert.deepEqual(active.metadata.shape, { rows: 3, columns: 3 });
      assert.deepEqual(
        active.metadata.schema.map((column) => column.name),
        ["order_id", "market", "revenue"]
      );
      assert.equal(active.metadata.source.uri, interactive.uri.toString());
      const associatedCells = interactive.getCells().filter((cell) => {
        const metadata = cell.metadata as { interactive?: { uristring?: unknown } };
        return metadata.interactive?.uristring === fixture.sourceUri.toString();
      });
      assert.equal(associatedCells.length, 1, "The Python Quarto action must execute one source-associated chunk.");
      const executedCell = associatedCells[0]!;
      assert.equal(executedCell.executionSummary?.success, true, "The Python Quarto chunk must finish successfully.");
      assert.ok(
        Number(executedCell.executionSummary?.executionOrder) > 0,
        "The Python Quarto chunk must publish one positive execution order."
      );
      assert.match(executedCell.document.getText(), new RegExp(`\\b${fixture.variableName}\\b`, "u"));
      assert.doesNotMatch(executedCell.document.getText(), new RegExp(`\\b${fixture.sentinelName}\\b`, "u"));
      assert.equal(
        interactive.getCells().some((cell) => cell.document.getText().includes(fixture.sentinelName)),
        false,
        "Opening the current Python Quarto chunk must not execute or copy the later chunk."
      );
      await assertReleasedSessionPage(testing, active, "2500001", "released-jupyter-python-quarto-page");
      assert.equal(sourceDocument.version, sourceVersion, "Opening Python Quarto must not edit its source document.");
      assert.equal(sourceDocument.isDirty, false, "Opening Python Quarto must leave its source clean.");
      assert.equal(sourceDocument.getText(), sourceText);
      assertExactBytes(
        readFileSync(fixture.sourceUri.fsPath),
        fixture.immutableFiles[0]!.bytes,
        "Opening Python Quarto must not change its source file."
      );

      recordAcceptanceProgress(`${checkpoint}:close-session`);
      await disposePackagedSessionPanel(testing, active.sessionId, "the Python Quarto Pandas session");
      assert.equal(testing.diagnostics().sessionCount, 0);
      await showExactReleasedNotebook(interactive);
      const sidebar = await arrangePackagedProductSidebar(workbench, "operation-catalog");
      const operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
      const liveFrame = operations.getByRole("treeitem", { name: new RegExp(`^${fixture.variableName}\\b`, "u") });
      await liveFrame.waitFor({ state: "visible", timeout: 90_000 });
      assert.match((await liveFrame.innerText()).replace(/\s+/gu, " "), /Pandas · DataFrame/u);
      assert.equal(
        await operations.getByRole("treeitem", { name: new RegExp(`^${fixture.sentinelName}\\b`, "u") }).count(),
        0,
        "Operations must not list a dataframe from the later Python Quarto chunk."
      );

      recordAcceptanceProgress(`${checkpoint}:cleanup`);
      await closeExactReleasedPythonInteractiveWindow(interactive);
      const sourceTab = textDocumentTab(fixture.sourceUri);
      assert.ok(sourceTab, "The Python Quarto journey must retain its exact source tab.");
      assert.equal(
        await withBoundedAcceptancePromise(
          vscode.window.tabGroups.close(sourceTab, true),
          WORKBENCH_OPERATION_TIMEOUT_MS,
          "the successful Python Quarto source tab cleanup"
        ),
        true
      );
      await waitFor(
        () => textDocumentTab(fixture.sourceUri) === undefined,
        10_000,
        "the Python Quarto source tab to close"
      );
      recordAcceptanceProgress(`${checkpoint}:complete`);
    } finally {
      const active = testing.activeSession();
      if (
        active?.metadata.source.kind === "notebookVariable" &&
        active.metadata.source.variableName === fixture.variableName
      ) {
        try {
          await withBoundedAcceptancePromise(
            disposePackagedSessionPanel(testing, active.sessionId, "the failed Python Quarto session"),
            30_000,
            "the failed Python Quarto session cleanup"
          );
        } catch {
          // Preserve the original acceptance failure.
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
          await withBoundedAcceptancePromise(
            closeExactReleasedPythonInteractiveWindow(interactive),
            30_000,
            "the failed Python Quarto Interactive Window cleanup"
          );
        } catch {
          // Preserve the original acceptance failure.
        }
      }
      const sourceTab = textDocumentTab(fixture.sourceUri);
      if (sourceTab) {
        try {
          await withBoundedAcceptancePromise(
            vscode.window.tabGroups.close(sourceTab, true),
            WORKBENCH_OPERATION_TIMEOUT_MS,
            "the failed Python Quarto source tab cleanup"
          );
        } catch {
          // Preserve the original acceptance failure.
        }
      }
      assertExactBytes(
        readFileSync(fixture.sourceUri.fsPath),
        fixture.immutableFiles[0]!.bytes,
        "Python Quarto cleanup must preserve its source file."
      );
    }
  };
}
