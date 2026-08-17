import type * as vscode from "vscode";
import type { Page } from "playwright-core";
import type { exerciseReleasedRCategoricalEditingJourney as exerciseReleasedRCategoricalEditingJourneyOwner } from "./releasedRCategoricalEditing";
import type { TestApi } from "./extensionHostTestApi";
import type { ReleasedRAcceptanceCoverageProfile } from "./releasedRAcceptanceCoverage";

type ReleasedRActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;

interface ReleasedREditingCoverageDependencies {
  readonly assertReleasedRRuntimeBinding: (
    notebook: vscode.NotebookDocument,
    expectedBinding: boolean,
    checkpoint: string
  ) => Promise<void>;
  readonly categoricalDependencies: Parameters<typeof exerciseReleasedRCategoricalEditingJourneyOwner>[1];
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly exerciseReleasedREditingJourney: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    notebook: vscode.NotebookDocument,
    notebookPath: string,
    outputDirectory: string,
    phase: "jupyter-r" | "jupyter-r-remote",
    screenshotOutput: string | undefined,
    editingCatalog: "core-catalog" | "clone-lifecycle"
  ) => Promise<void>;
  readonly exerciseReleasedRCategoricalEditingJourney: typeof exerciseReleasedRCategoricalEditingJourneyOwner;
  readonly exerciseReleasedRRepresentativeEditingJourney: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    notebook: vscode.NotebookDocument,
    phase: "jupyter-r" | "jupyter-r-remote"
  ) => Promise<void>;
  readonly exerciseReleasedRValueOperationsJourney: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    notebook: vscode.NotebookDocument,
    notebookPath: string,
    outputDirectory: string,
    phase: "jupyter-r",
    screenshotOutput?: string
  ) => Promise<void>;
  readonly recordReleasedRAcceptanceSection: (
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    section: "editing",
    boundary: "start" | "complete"
  ) => void;
}

export function createReleasedREditingCoverage({
  assertReleasedRRuntimeBinding,
  categoricalDependencies,
  disposePackagedSessionPanel,
  exerciseReleasedREditingJourney,
  exerciseReleasedRCategoricalEditingJourney,
  exerciseReleasedRRepresentativeEditingJourney,
  exerciseReleasedRValueOperationsJourney,
  recordReleasedRAcceptanceSection
}: ReleasedREditingCoverageDependencies) {
  return async function exerciseReleasedREditingCoverage(
    testing: TestApi,
    workbench: Page,
    base: ReleasedRActiveSession,
    notebook: vscode.NotebookDocument,
    notebookPath: string,
    directory: string,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    screenshotOutput?: string
  ): Promise<void> {
    recordReleasedRAcceptanceSection(phase, coverage, "editing", "start");
    if (coverage.editing === "core-catalog" || coverage.editing === "clone-lifecycle") {
      await exerciseReleasedREditingJourney(
        testing,
        workbench,
        base.sessionId,
        notebook,
        notebookPath,
        directory,
        phase,
        screenshotOutput,
        coverage.editing
      );
    } else {
      await exerciseReleasedRRepresentativeEditingJourney(testing, workbench, base.sessionId, notebook, phase);
      if (phase === "jupyter-r" && coverage.focusedEditing === "categorical-operations") {
        await exerciseReleasedRCategoricalEditingJourney(
          { testing, workbench, sessionId: base.sessionId },
          categoricalDependencies
        );
      }
      if (phase === "jupyter-r" && coverage.focusedEditing === "value-operations") {
        await exerciseReleasedRValueOperationsJourney(
          testing,
          workbench,
          base.sessionId,
          notebook,
          notebookPath,
          directory,
          phase,
          screenshotOutput
        );
      }
    }
    recordReleasedRAcceptanceSection(phase, coverage, "editing", "complete");
    await assertReleasedRRuntimeBinding(notebook, true, `${phase}:source-after-editing-journey`);
    await disposePackagedSessionPanel(testing, base.sessionId, "the editable orders R data.frame session");
  };
}
