import * as assert from "node:assert/strict";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRLowercaseApi = Pick<TestApi, "activeSession" | "request">;

export interface ReleasedRLowercaseOperationInput {
  readonly testing: ReleasedRLowercaseApi;
  readonly sessionId: string;
  readonly phase: "jupyter-r" | "jupyter-r-remote";
  readonly catalog: "core-catalog" | "value-operations";
  readonly recordProgress: (checkpoint: string) => void;
  readonly recordValueOperationBoundary: (boundary: "start" | "complete") => void;
}

export async function exerciseReleasedRLowercaseOperation(input: ReleasedRLowercaseOperationInput): Promise<void> {
  const { testing, sessionId, phase, catalog, recordProgress, recordValueOperationBoundary } = input;
  assert.ok(
    (phase === "jupyter-r-remote" && catalog === "core-catalog") ||
      (phase === "jupyter-r" && catalog === "value-operations"),
    "The released R Lowercase coordinator accepts only its remote-core or local-value owner."
  );

  if (catalog === "value-operations") recordValueOperationBoundary("start");
  recordProgress(`${phase}:editing:lowercase-preview-apply-undo`);
  const lowercaseBase = testing.activeSession();
  assert.ok(lowercaseBase, "The restored R session must remain available for Lowercase.");
  const groupColumn = lowercaseBase.metadata.schema.find((column) => column.name === "group");
  assert.ok(groupColumn, "The packaged R Lowercase journey requires the group column.");
  const lowercasePreview = await testing.request({
    kind: "previewStep",
    sessionId,
    revision: lowercaseBase.metadata.revision,
    step: {
      id: "released-r-lowercase-group",
      kind: "lowerText",
      params: { column: { id: groupColumn.id, name: groupColumn.name } }
    },
    offset: 0,
    limit: 20,
    columnOffset: 0,
    columnLimit: 8
  });
  assert.equal(lowercasePreview.kind, "stepPreview", "Packaged native R Lowercase must preview in place.");
  if (lowercasePreview.kind !== "stepPreview") throw new Error("The packaged R Lowercase preview failed.");
  assert.equal(lowercasePreview.metadata.schema.find((column) => column.id === groupColumn.id)?.rawType, "character");
  assert.equal(lowercasePreview.page.rows[0]?.values[1]?.display, "a");
  assert.match(lowercasePreview.code, /tolower/u);
  assert.ok(lowercasePreview.diff.changedCells > 0);
  const lowercaseApplied = await testing.request({
    kind: "applyDraft",
    sessionId,
    revision: lowercasePreview.revision,
    offset: 0,
    limit: 20,
    columnOffset: 0,
    columnLimit: 8
  });
  assert.equal(lowercaseApplied.kind, "planUpdated", "Packaged native R Lowercase must apply.");
  if (lowercaseApplied.kind !== "planUpdated") throw new Error("The packaged R Lowercase apply failed.");
  assert.equal(lowercaseApplied.page.rows[0]?.values[1]?.display, "a");
  const lowercaseUndo = await testing.request({
    kind: "undoStep",
    sessionId,
    revision: lowercaseApplied.revision,
    offset: 0,
    limit: 20,
    columnOffset: 0,
    columnLimit: 8
  });
  assert.equal(lowercaseUndo.kind, "planUpdated", "Packaged native R Lowercase must undo.");
  if (lowercaseUndo.kind !== "planUpdated") throw new Error("The packaged R Lowercase undo failed.");
  assert.equal(lowercaseUndo.page.rows[0]?.values[1]?.display, "A");
  if (catalog === "value-operations") recordValueOperationBoundary("complete");
}
