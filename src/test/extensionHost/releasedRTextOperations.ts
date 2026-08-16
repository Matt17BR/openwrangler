import * as assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { Page } from "playwright-core";
import type { SessionMetadata, TransformStep } from "../../shared/protocol";
import type { TestApi } from "./extensionHostTestApi";

interface ReleasedRTextOperationsDependencies {
  readonly exerciseReleasedREditingJourney: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    notebook: vscode.NotebookDocument,
    notebookPath: string,
    outputDirectory: string,
    phase: "jupyter-r",
    screenshotOutput: string | undefined,
    editingCatalog: "value-operations"
  ) => Promise<void>;
}

export function createReleasedRTextOperations({
  exerciseReleasedREditingJourney
}: ReleasedRTextOperationsDependencies) {
  async function previewAndDiscardReleasedRTextTool(
    testing: TestApi,
    sessionId: string,
    column: SessionMetadata["schema"][number],
    kind: "stripText" | "splitText"
  ): Promise<void> {
    const base = testing.activeSession();
    assert.ok(base, `The R ${kind} check requires one active session.`);
    const reference = { id: column.id, name: column.name };
    const step: Extract<TransformStep, { kind: "stripText" | "splitText" }> =
      kind === "stripText"
        ? { id: "released-r-strip-label", kind, params: { column: reference, characters: "row-" } }
        : {
            id: "released-r-split-label",
            kind,
            params: { column: reference, delimiter: "-", index: 1, newColumn: "label_number" }
          };
    const preview = await testing.request({
      kind: "previewStep",
      sessionId,
      revision: base.metadata.revision,
      step,
      offset: 0,
      limit: 1,
      columnOffset: kind === "splitText" ? base.metadata.schema.length : column.position,
      columnLimit: 1
    });
    assert.equal(preview.kind, "stepPreview", `Native R ${kind} must preview.`);
    if (preview.kind !== "stepPreview") throw new Error(`Native R ${kind} did not preview.`);
    assert.equal(preview.page.rows[0]?.values[0]?.display, "0001");
    assert.ok(preview.code.includes(kind === "splitText" ? ".ow_text_delimiter" : ".ow_text_strip_characters"));
    assert.doesNotMatch(preview.code, /\b(?:pandas|polars|python)\b/iu);
    const discarded = await testing.request({
      kind: "discardDraft",
      sessionId,
      revision: preview.revision,
      offset: 0,
      limit: 1,
      columnOffset: 0,
      columnLimit: 1
    });
    assert.equal(discarded.kind, "planUpdated", `Native R ${kind} must discard cleanly.`);
  }

  async function exerciseReleasedRValueOperationsJourney(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    notebook: vscode.NotebookDocument,
    notebookPath: string,
    outputDirectory: string,
    phase: "jupyter-r",
    screenshotOutput?: string
  ): Promise<void> {
    await exerciseReleasedREditingJourney(
      testing,
      workbench,
      sessionId,
      notebook,
      notebookPath,
      outputDirectory,
      phase,
      screenshotOutput,
      "value-operations"
    );
  }

  return { exerciseReleasedRValueOperationsJourney, previewAndDiscardReleasedRTextTool };
}
