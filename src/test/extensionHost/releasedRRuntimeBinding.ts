import * as assert from "node:assert/strict";
import type * as vscode from "vscode";
import { RELEASED_JUPYTER_R_BINDING_RESULT } from "./releasedDocumentFixtures";
import type { ReleasedRAcceptanceCoverageProfile } from "./releasedRAcceptanceCoverage";

interface ReleasedJupyterKernelTarget {
  readonly remote?: Readonly<{ runId: string; hostname: string }>;
}

interface ReleasedRRuntimeBindingDependencies {
  readonly RELEASED_JUPYTER_R_BINDING_CELL: number;
  readonly executeReleasedNotebookCell: (
    notebook: vscode.NotebookDocument,
    index: number,
    expectedOutput: string,
    checkpoint: string,
    expectedEditor?: vscode.NotebookEditor
  ) => Promise<void>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedNotebookJsonResult: (
    cell: vscode.NotebookCell,
    marker: string,
    description: string
  ) => Record<string, unknown>;
}

export function createReleasedRRuntimeBinding({
  RELEASED_JUPYTER_R_BINDING_CELL,
  executeReleasedNotebookCell,
  recordAcceptanceProgress,
  releasedNotebookJsonResult
}: ReleasedRRuntimeBindingDependencies) {
  function assertReleasedRVersion(
    result: Readonly<Record<string, unknown>>,
    target: ReleasedJupyterKernelTarget,
    description: string
  ): void {
    if (typeof result.rVersion !== "string") {
      assert.fail(`The ${description} must report its R version.`);
    }
    const version = result.rVersion;
    assert.match(
      version,
      /^4\.(?:4|5)\.(?:0|[1-9][0-9]*)$/u,
      `The ${description} must use a supported R 4.4 or 4.5 release.`
    );
    if (target.remote) {
      assert.equal(version, "4.5.2", "The pinned remote R fixture must use exactly R 4.5.2.");
    }
  }

  function assertReleasedRPrivateLibrary(result: Readonly<Record<string, unknown>>, description: string): void {
    assert.equal(result.privateLibraryFirst, true, `The ${description} must put R_LIBS_USER first in .libPaths().`);
    assert.equal(result.irKernelFromPrivateLibrary, true, `The ${description} must load IRkernel from R_LIBS_USER.`);
  }

  async function waitForReleasedRRuntimeBindingCleanup(
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    phase: "jupyter-r" | "jupyter-r-remote"
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let attempt = 0;
    do {
      attempt += 1;
      await executeReleasedNotebookCell(
        notebook,
        RELEASED_JUPYTER_R_BINDING_CELL,
        RELEASED_JUPYTER_R_BINDING_RESULT,
        `${phase}:binding-cleanup-${attempt}`,
        notebookEditor
      );
      const result = releasedNotebookJsonResult(
        notebook.cellAt(RELEASED_JUPYTER_R_BINDING_CELL),
        RELEASED_JUPYTER_R_BINDING_RESULT,
        "R runtime binding probe"
      );
      assert.equal(
        typeof result.runtimeBindingPresent,
        "boolean",
        "The R runtime binding probe must return one boolean."
      );
      assert.equal(
        result.sourceUnchanged,
        true,
        "Opening, querying, and closing the native R session must not change its source data.frame."
      );
      if (result.runtimeBindingPresent === false) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail("The private Open Wrangler R runtime binding remained after the final session closed.");
  }

  async function assertReleasedRRuntimeBinding(
    notebook: vscode.NotebookDocument,
    expectedBinding: boolean,
    checkpoint: string
  ): Promise<void> {
    await executeReleasedNotebookCell(
      notebook,
      RELEASED_JUPYTER_R_BINDING_CELL,
      RELEASED_JUPYTER_R_BINDING_RESULT,
      checkpoint
    );
    const result = releasedNotebookJsonResult(
      notebook.cellAt(RELEASED_JUPYTER_R_BINDING_CELL),
      RELEASED_JUPYTER_R_BINDING_RESULT,
      "R runtime binding and source-integrity probe"
    );
    assert.equal(
      result.runtimeBindingPresent,
      expectedBinding,
      `The R runtime binding must be ${expectedBinding ? "present" : "absent"} during ${checkpoint}.`
    );
    assert.equal(
      result.exportArtifacts,
      0,
      `The R kernel retained a private CSV export artifact during ${checkpoint}.`
    );
    assert.equal(result.sourceUnchanged, true, `The source data.frame changed during ${checkpoint}.`);
    assert.equal(result.tibbleSourceUnchanged, true, `The source tibble changed during ${checkpoint}.`);
    assert.equal(result.tableSourceUnchanged, true, `The source data.table changed during ${checkpoint}.`);
    assert.equal(result.mediaSourceUnchanged, true, `The R media data.frame changed during ${checkpoint}.`);
  }

  function recordReleasedRAcceptanceSection(
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    section: string,
    boundary: "start" | "complete"
  ): void {
    recordAcceptanceProgress(`${phase}:coverage:${coverage.name}:${section}:${boundary}`);
  }

  return {
    assertReleasedRPrivateLibrary,
    assertReleasedRRuntimeBinding,
    assertReleasedRVersion,
    recordReleasedRAcceptanceSection,
    waitForReleasedRRuntimeBindingCleanup
  };
}
