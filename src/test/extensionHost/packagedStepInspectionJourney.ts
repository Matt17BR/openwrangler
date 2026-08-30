import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { DEFAULT_SESSION_OPEN_TIMEOUT_MS } from "../../extension/configuration";
import type { ColumnReference, LiveGridPage, SessionMetadata, TransformStep } from "../../shared/protocol";
import { assertExactBytes } from "./acceptanceSourceFixture";
import type { TestApi } from "./extensionHostTestApi";

const SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS = DEFAULT_SESSION_OPEN_TIMEOUT_MS + 15_000;

export interface PackagedStepInspectionJourneyDependencies {
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForSettledViewState: (testing: TestApi, expectation: string) => Promise<void>;
  readonly columnReference: (metadata: SessionMetadata, name: string) => ColumnReference;
  readonly gridColumnDisplays: (page: LiveGridPage, columnId: string) => string[];
  readonly GRID_COLUMN_WINDOW: Readonly<{ columnOffset: number; columnLimit: number }>;
}

export function createPackagedStepInspectionJourney({
  waitFor,
  waitForSettledViewState,
  columnReference,
  gridColumnDisplays,
  GRID_COLUMN_WINDOW
}: PackagedStepInspectionJourneyDependencies) {
  return async function exercisePackagedStepInspection(testing: TestApi, fixture: vscode.Uri): Promise<void> {
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.path === fixture.fsPath &&
          active.metadata.steps.some((step) => step.id === "packaged-score")
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged custom editor to restore its applied cleaning step"
    );
    await waitForSettledViewState(testing, "the confirmed packaged-editor view before step selection");

    const beforeSelection = testing.activeSession();
    assert.ok(beforeSelection, "The packaged custom editor must publish its active session.");
    assert.equal(beforeSelection.stepInspection, undefined);
    const confirmedMetadata = structuredClone(beforeSelection.metadata);
    const confirmedView = structuredClone(beforeSelection.viewState);
    const confirmedCode = beforeSelection.code;

    await vscode.commands.executeCommand("openWrangler.selectStep", "packaged-score");
    await waitFor(
      () => testing.activeSession()?.stepInspection?.stepId === "packaged-score",
      30_000,
      "the packaged editor to inspect the selected applied step"
    );

    const selected = testing.activeSession();
    assert.ok(selected?.stepInspection, "Selecting an applied step must publish its inspection snapshot.");
    const inspection = selected.stepInspection;
    assert.equal(inspection.revision, confirmedMetadata.revision, "Inspection must not advance the session revision.");
    assert.equal(inspection.stepIndex, 0);
    assert.deepEqual(
      inspection.inputSchema.map((column) => column.name),
      ["city", "year", "sales", "active"]
    );
    assert.deepEqual(
      inspection.outputSchema.map((column) => column.name),
      ["city", "year", "sales", "active", "score"]
    );
    assert.deepEqual(inspection.diff.addedColumns, ["score"]);
    assert.deepEqual(inspection.diff.removedColumns, []);
    assert.equal(inspection.diff.truncated, false);
    assert.match(inspection.code, /def clean_data\(df\):/u);
    assert.match(inspection.code, /score/u);
    assert.deepEqual(selected.metadata, confirmedMetadata, "Inspection must leave the confirmed metadata unchanged.");
    assert.deepEqual(selected.viewState, confirmedView, "Inspection must leave the confirmed view unchanged.");

    await vscode.commands.executeCommand("openWrangler.selectStep");
    await waitFor(
      () => testing.activeSession()?.stepInspection === undefined,
      10_000,
      "Original Data to clear the selected applied-step inspection"
    );
    await waitForSettledViewState(testing, "the confirmed packaged-editor view after clearing step selection");

    const restored = testing.activeSession();
    assert.ok(restored, "Clearing an inspection must retain the active dataframe session.");
    assert.equal(restored.stepInspection, undefined);
    assert.deepEqual(restored.metadata, confirmedMetadata, "Clearing must restore the exact confirmed metadata.");
    assert.deepEqual(
      restored.viewState,
      confirmedView,
      "Clearing must restore filters, sorts, widths, selection, and viewport exactly."
    );
    assert.equal(restored.code, confirmedCode, "Clearing must restore the full-plan generated code.");

    const sourceBytes = readFileSync(fixture.fsPath);
    const originalStep = confirmedMetadata.steps[0];
    assert.ok(originalStep, "The packaged history journey requires one confirmed source step.");
    const suffixStep: TransformStep = {
      id: "packaged-history-suffix",
      kind: "cloneColumn",
      params: { column: columnReference(restored.metadata, "sales"), newName: "sales copy" }
    };
    const suffixPreview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: restored.sessionId,
      revision: restored.metadata.revision,
      step: suffixStep,
      offset: 0,
      limit: 20
    });
    assert.equal(suffixPreview.kind, "stepPreview", "The packaged history suffix did not preview.");
    if (suffixPreview.kind !== "stepPreview") return;
    const suffixApplied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: restored.sessionId,
      revision: suffixPreview.revision,
      offset: 0,
      limit: 20
    });
    assert.equal(suffixApplied.kind, "planUpdated", "The packaged history suffix did not apply.");
    if (suffixApplied.kind !== "planUpdated") return;

    const replacementStep: TransformStep = {
      ...originalStep,
      params: { ...originalStep.params, value: 4 }
    } as TransformStep;
    const replacementPreview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: restored.sessionId,
      revision: suffixApplied.revision,
      step: replacementStep,
      replaceStepId: originalStep.id,
      offset: 0,
      limit: 20
    });
    assert.equal(replacementPreview.kind, "stepPreview", "The packaged earlier replacement did not preview.");
    if (replacementPreview.kind !== "stepPreview") return;
    const replacementApplied = await testing.rewriteCleaningPlan(
      restored.sessionId,
      replacementPreview.revision,
      originalStep.id,
      "applyDraft"
    );
    assert.equal(replacementApplied?.kind, "planUpdated", "The packaged earlier replacement did not publish.");
    if (replacementApplied?.kind !== "planUpdated") return;
    assert.deepEqual(
      replacementApplied.metadata.steps.map((step) => step.id),
      [originalStep.id, suffixStep.id],
      "The packaged earlier replacement lost or reordered the unchanged suffix."
    );
    assert.equal(
      gridColumnDisplays(replacementApplied.page, columnReference(replacementApplied.metadata, "score").id)[0],
      "48.0",
      "The packaged earlier replacement did not rebuild the selected step."
    );

    const deleted = await testing.rewriteCleaningPlan(
      restored.sessionId,
      replacementApplied.revision,
      originalStep.id,
      "deleteStep"
    );
    assert.equal(deleted?.kind, "planUpdated", "The packaged earlier deletion did not publish.");
    if (deleted?.kind !== "planUpdated") return;
    assert.deepEqual(
      deleted.metadata.steps.map((step) => step.id),
      [suffixStep.id],
      "The packaged earlier deletion did not preserve the stable suffix ID."
    );
    assert.equal(
      deleted.metadata.schema.some((column) => column.name === "score"),
      false,
      "The packaged earlier deletion retained the deleted output."
    );
    assert.ok(columnReference(deleted.metadata, "sales copy"));

    const suffixUndone = await testing.request({
      kind: "undoStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: restored.sessionId,
      revision: deleted.revision,
      offset: 0,
      limit: 20
    });
    assert.equal(suffixUndone.kind, "planUpdated", "The packaged history suffix did not undo during restoration.");
    if (suffixUndone.kind !== "planUpdated") return;
    const originalPreview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: restored.sessionId,
      revision: suffixUndone.revision,
      step: originalStep,
      offset: 0,
      limit: 20
    });
    assert.equal(originalPreview.kind, "stepPreview", "The packaged source step did not restore.");
    if (originalPreview.kind !== "stepPreview") return;
    const originalApplied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: restored.sessionId,
      revision: originalPreview.revision,
      offset: 0,
      limit: 20
    });
    assert.equal(originalApplied.kind, "planUpdated", "The packaged source plan did not restore.");
    if (originalApplied.kind !== "planUpdated") return;
    assert.deepEqual(originalApplied.metadata.steps, [originalStep]);
    assert.deepEqual(originalApplied.metadata.filterModel, confirmedMetadata.filterModel);
    assert.deepEqual(testing.activeSession()?.viewState, confirmedView);
    assert.equal(originalApplied.code, confirmedCode);
    assertExactBytes(
      readFileSync(fixture.fsPath),
      sourceBytes,
      "Packaged history rewrites must not modify the source."
    );
  };
}
