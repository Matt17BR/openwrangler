import * as assert from "node:assert/strict";
import type { Locator } from "playwright-core";
import * as vscode from "vscode";
import type { CellValue } from "../../shared/protocol";
import type { TestApi } from "./extensionHostTestApi";

export interface PivotWiderJourneyDependencies {
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
}

export async function exercisePivotWiderJourney(
  app: Locator,
  testing: TestApi,
  sessionId: string,
  namesFromName: string,
  valuesFromName: string,
  keys: readonly [string, string, ...string[]],
  synchronizeApp: (phase: string) => Promise<Locator>,
  dependencies: PivotWiderJourneyDependencies
): Promise<void> {
  const { recordAcceptanceProgress, waitFor } = dependencies;
  const checkpoint = `pivot-wider:${namesFromName}:${valuesFromName}`;
  recordAcceptanceProgress(`${checkpoint}:start`);
  const initial = testing.activeSession();
  assert.ok(initial?.sessionId === sessionId, "Pivot wider requires the exact active dataframe session.");
  assert.equal(initial.metadata.draftStep, undefined);
  assert.equal(initial.metadata.steps.length, 0);
  const namesFrom = initial.metadata.schema.find((column) => column.name === namesFromName);
  const valuesFrom = initial.metadata.schema.find((column) => column.name === valuesFromName);
  assert.ok(namesFrom && valuesFrom, "The installed Pivot wider journey requires both exact source columns.");
  assert.equal(namesFrom.type, "string", "Pivot wider names-from must be a text or factor column.");
  assert.notEqual(namesFrom.id, valuesFrom.id);
  const sourceValueResponse = await testing.request({
    kind: "getPage",
    sessionId,
    revision: initial.metadata.revision,
    viewRequestId: `${checkpoint}:source`,
    offset: 0,
    limit: 1,
    filterModel: initial.viewState.filterModel,
    columnOffset: valuesFrom.position,
    columnLimit: 1
  });
  assert.equal(sourceValueResponse.kind, "page");
  if (sourceValueResponse.kind !== "page") throw new Error("Pivot wider source value did not resolve.");
  const sourceValue = sourceValueResponse.page.rows[0]?.values[0] as CellValue | undefined;
  assert.ok(sourceValue, "Pivot wider requires one first-row source value.");

  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("pivot wider");
  await dialog.getByRole("button", { name: /^Pivot wider\b/u }).click();
  await dialog.getByLabel("Names from", { exact: true }).selectOption({ label: namesFromName });
  await dialog.getByLabel("Values from", { exact: true }).selectOption({ label: valuesFromName });
  while ((await dialog.getByLabel(/^Key [0-9]+$/u).count()) < keys.length) {
    await dialog.getByRole("button", { name: "Add output", exact: true }).click();
  }
  for (const [index, key] of keys.entries()) {
    await dialog.getByLabel(`Key ${index + 1}`, { exact: true }).fill(key);
    await dialog.getByLabel(`Output column ${index + 1}`, { exact: true }).fill(`pivot_${index + 1}`);
  }
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const draft = testing.activeSession()?.metadata.draftStep;
      return (
        draft?.kind === "pivotWider" &&
        draft.params.namesFrom.id === namesFrom.id &&
        draft.params.valuesFrom.id === valuesFrom.id &&
        draft.params.outputs.map((output) => output.name).join(",") ===
          keys.map((_, index) => `pivot_${index + 1}`).join(",")
      );
    },
    30_000,
    "previewing Pivot wider through the installed operation form"
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  const preview = testing.activeSession();
  assert.ok(preview?.metadata.draftStep?.kind === "pivotWider");
  const outputs = keys.map((_, ordinal) => {
    const output = preview.metadata.schema.find((column) => column.name === `pivot_${ordinal + 1}`);
    assert.ok(output, `Pivot wider output ${ordinal + 1} is missing.`);
    assert.equal(output.id, `c:step:${preview.metadata.draftStep!.id}:${ordinal}`);
    return output;
  });
  assert.equal(
    preview.metadata.schema.some((column) => column.id === namesFrom.id),
    false
  );
  assert.equal(
    preview.metadata.schema.some((column) => column.id === valuesFrom.id),
    false
  );
  assert.match(preview.code ?? "", /pivot_/u);

  const previewApp = await synchronizeApp("Pivot wider preview");
  const previewPage = await testing.request({
    kind: "getPage",
    sessionId,
    revision: preview.metadata.revision,
    viewRequestId: `${checkpoint}:preview`,
    offset: 0,
    limit: 1,
    filterModel: preview.viewState.filterModel,
    columnOffset: outputs[0]!.position,
    columnLimit: outputs.length
  });
  if (previewPage.kind !== "page") {
    const detail =
      previewPage.kind === "error"
        ? `${previewPage.code} (recoverable=${String(previewPage.recoverable)}): ${previewPage.message}`
        : `unexpected ${previewPage.kind} response`;
    throw new Error(`Pivot wider preview page did not resolve: ${detail}`);
  }
  assert.deepEqual(
    previewPage.page.columnIds,
    outputs.map((output) => output.id)
  );
  assert.deepEqual(previewPage.page.rows[0]?.values[0], sourceValue);
  for (const missing of previewPage.page.rows[0]?.values.slice(1) ?? []) assert.equal(missing.isNull, true);

  const review = previewApp.getByRole("region", { name: "Draft review" });
  await review.getByText("Pivot wider", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await review.getByRole("button", { name: "Apply step", exact: true }).click();
  await waitFor(
    () => testing.activeSession()?.metadata.steps[0]?.kind === "pivotWider",
    30_000,
    "applying Pivot wider"
  );
  const applied = testing.activeSession();
  assert.ok(applied, "Applied Pivot wider must retain its exact session.");
  const pivotStep = applied.metadata.steps[0];
  assert.ok(pivotStep?.kind === "pivotWider", "Applied Pivot wider must retain its stable step.");
  const retained = applied.metadata.schema.find(
    (column) =>
      initial.metadata.schema.some((sourceColumn) => sourceColumn.id === column.id) &&
      column.id !== namesFrom.id &&
      column.id !== valuesFrom.id
  );
  assert.ok(retained, "Pivot wider lifecycle acceptance requires one retained identifier column.");
  let suffixApp = await synchronizeApp("Pivot wider apply");
  await suffixApp.getByRole("button", { name: "Add step", exact: true }).click();
  const suffixDialog = suffixApp.getByRole("dialog", { name: "Add cleaning step" });
  await suffixDialog.waitFor({ state: "visible", timeout: 10_000 });
  await suffixDialog.getByPlaceholder("Search operations").fill("clone column");
  await suffixDialog.getByRole("button", { name: /^Clone column\b/u }).click();
  await suffixDialog.getByLabel("Column", { exact: true }).selectOption(retained.id);
  await suffixDialog.getByLabel("New name", { exact: true }).fill("pivot_wider_suffix");
  await suffixDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const draft = testing.activeSession()?.metadata.draftStep;
      return (
        draft?.kind === "cloneColumn" &&
        draft.params.column.id === retained.id &&
        draft.params.newName === "pivot_wider_suffix"
      );
    },
    30_000,
    "previewing the installed Pivot wider suffix"
  );
  await suffixDialog.waitFor({ state: "hidden", timeout: 10_000 });
  suffixApp = await synchronizeApp("Pivot wider suffix preview");
  await suffixApp
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active !== undefined &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 2 &&
        active.metadata.steps[0]?.id === pivotStep.id &&
        active.metadata.steps[1]?.kind === "cloneColumn"
      );
    },
    30_000,
    "applying the installed Pivot wider suffix"
  );
  const suffixApplied = testing.activeSession();
  assert.ok(suffixApplied, "Pivot wider suffix apply must retain the exact active session.");
  const suffixStep = suffixApplied.metadata.steps[1];
  assert.ok(suffixStep?.kind === "cloneColumn", "Pivot wider suffix must remain one stable Clone column step.");
  assert.deepEqual(
    suffixApplied.metadata.steps.map((step) => step.id),
    [pivotStep.id, suffixStep.id],
    "Pivot wider suffix ordering changed."
  );

  app = await synchronizeApp("Pivot wider suffix apply");
  const retainedReceipt = testing.panelSynchronizationReceipt(sessionId);
  assert.ok(retainedReceipt, "Pivot wider recovery requires the exact acknowledged renderer receipt.");
  assert.equal(
    testing.retirePanelRenderer(sessionId),
    true,
    "Pivot wider acceptance must retire the exact renderer before saved-form recovery."
  );
  try {
    await app.waitFor({ state: "detached", timeout: 10_000 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("locator.waitFor: Frame was detached")) throw error;
  }
  await waitFor(
    () => {
      const receipt = testing.panelSynchronizationReceipt(sessionId);
      return (
        testing.panelHydrated(sessionId) &&
        receipt?.sessionId === sessionId &&
        receipt.revision === suffixApplied.metadata.revision &&
        receipt.syncId !== retainedReceipt.syncId
      );
    },
    30_000,
    "rehydrating Pivot wider and its suffix in a physically recreated renderer"
  );
  let recoveredApp = await synchronizeApp("Pivot wider renderer recovery");
  await vscode.commands.executeCommand("openWrangler.selectStep", pivotStep.id);
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === pivotStep.id,
    30_000,
    "inspecting the recovered non-latest Pivot wider step"
  );
  const inspection = recoveredApp.getByRole("region", { name: "Selected applied-step inspection" });
  await inspection.getByRole("button", { name: "Edit step", exact: true }).click();
  const editDialog = recoveredApp.getByRole("dialog", { name: "Edit cleaning step" });
  await editDialog.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    await editDialog.getByLabel("Names from", { exact: true }).locator("option:checked").textContent(),
    namesFromName
  );
  assert.equal(
    await editDialog.getByLabel("Values from", { exact: true }).locator("option:checked").textContent(),
    valuesFromName
  );
  for (const [index, key] of keys.entries()) {
    assert.equal(await editDialog.getByLabel(`Key ${index + 1}`, { exact: true }).inputValue(), key);
    assert.equal(
      await editDialog.getByLabel(`Output column ${index + 1}`, { exact: true }).inputValue(),
      `pivot_${index + 1}`
    );
  }
  await editDialog.getByLabel("Output column 1", { exact: true }).fill("pivot_edited_1");
  await editDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.draftReplacesStepId === pivotStep.id &&
        active.metadata.draftStep?.kind === "pivotWider" &&
        active.metadata.draftStep.params.outputs[0]?.name === "pivot_edited_1"
      );
    },
    30_000,
    "previewing the hydrated non-latest Pivot wider replacement"
  );
  const replacementPreview = testing.activeSession();
  assert.ok(replacementPreview?.metadata.draftStep?.kind === "pivotWider");
  recoveredApp = await synchronizeApp("Pivot wider replacement preview");
  await recoveredApp
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active !== undefined &&
        active.metadata.draftStep === undefined &&
        active.metadata.draftReplacesStepId === undefined &&
        active.metadata.steps.map((step) => step.id).join(",") === [pivotStep.id, suffixStep.id].join(",") &&
        active.metadata.schema.some((column) => column.name === "pivot_edited_1")
      );
    },
    30_000,
    "applying the hydrated non-latest Pivot wider replacement"
  );
  const replacementApplied = testing.activeSession();
  assert.ok(replacementApplied, "Edited Pivot wider must retain the exact active session.");
  assert.deepEqual(
    replacementApplied.metadata.steps.map((step) => step.id),
    [pivotStep.id, suffixStep.id],
    "Editing Pivot wider lost or reordered its suffix."
  );
  assert.equal(
    replacementApplied.metadata.schema.find((column) => column.name === "pivot_edited_1")?.id,
    `c:step:${pivotStep.id}:0`,
    "Editing Pivot wider changed its stable first output identity."
  );
  assert.equal(
    replacementApplied.metadata.schema.find((column) => column.name === suffixStep.params.newName)?.id,
    `c:step:${suffixStep.id}:0`,
    "Editing Pivot wider changed the suffix output identity."
  );
  assert.match(replacementApplied.code ?? "", /pivot_edited_1/u);

  let replacementApp = await synchronizeApp("Pivot wider replacement apply");
  await replacementApp.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return active !== undefined && active.metadata.draftStep === undefined && active.metadata.steps.length === 1;
    },
    30_000,
    "undoing the latest committed suffix after editing Pivot wider"
  );
  const suffixUndone = testing.activeSession();
  assert.ok(suffixUndone, "Pivot wider suffix Undo must retain the exact active session.");
  assert.deepEqual(
    suffixUndone.metadata.steps.map((step) => step.id),
    [pivotStep.id]
  );

  replacementApp = await synchronizeApp("Pivot wider suffix undo");
  await replacementApp.getByRole("button", { name: "Add step", exact: true }).click();
  const replaySuffixDialog = replacementApp.getByRole("dialog", { name: "Add cleaning step" });
  await replaySuffixDialog.waitFor({ state: "visible", timeout: 10_000 });
  await replaySuffixDialog.getByPlaceholder("Search operations").fill("clone column");
  await replaySuffixDialog.getByRole("button", { name: /^Clone column\b/u }).click();
  await replaySuffixDialog.getByLabel("Column", { exact: true }).selectOption(retained.id);
  await replaySuffixDialog.getByLabel("New name", { exact: true }).fill("pivot_wider_suffix");
  await replaySuffixDialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => testing.activeSession()?.metadata.draftStep?.kind === "cloneColumn",
    30_000,
    "previewing the replay suffix after Pivot wider Undo"
  );
  await replaySuffixDialog.waitFor({ state: "hidden", timeout: 10_000 });
  replacementApp = await synchronizeApp("Pivot wider replay suffix preview");
  await replacementApp
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => testing.activeSession()?.metadata.steps.length === 2,
    30_000,
    "reapplying the Pivot wider suffix"
  );
  const replaySuffixApplied = testing.activeSession();
  assert.ok(replaySuffixApplied, "Reapplying the Pivot wider suffix must retain the exact session.");
  const replaySuffixStep = replaySuffixApplied.metadata.steps[1];
  assert.ok(replaySuffixStep?.kind === "cloneColumn", "The replayed suffix must remain Clone column.");

  replacementApp = await synchronizeApp("Pivot wider replay suffix apply");
  await vscode.commands.executeCommand("openWrangler.selectStep", pivotStep.id);
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === pivotStep.id,
    30_000,
    "inspecting Pivot wider before installed deletion"
  );
  const deleteInspection = replacementApp.getByRole("region", { name: "Selected applied-step inspection" });
  await deleteInspection.getByRole("button", { name: "Delete step", exact: true }).click();
  await deleteInspection
    .getByRole("group", { name: "Confirm step deletion" })
    .getByRole("button", { name: "Delete" })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return active?.metadata.steps.length === 1 && active.metadata.steps[0]?.id === replaySuffixStep.id;
    },
    30_000,
    "deleting non-latest Pivot wider through the installed inspection transaction"
  );
  const deleted = testing.activeSession();
  assert.ok(deleted, "Deleting non-latest Pivot wider must retain the exact active session.");
  assert.deepEqual(
    deleted.metadata.steps.map((step) => step.id),
    [replaySuffixStep.id]
  );
  assert.equal(
    deleted.metadata.schema.some((column) => column.id.startsWith(`c:step:${pivotStep.id}:`)),
    false,
    "Deleting Pivot wider retained a derived output."
  );
  assert.equal(
    deleted.metadata.schema.find((column) => column.name === replaySuffixStep.params.newName)?.id,
    `c:step:${replaySuffixStep.id}:0`,
    "Deleting Pivot wider changed the replayed suffix identity."
  );
  replacementApp = await synchronizeApp("Pivot wider delete apply");
  await replacementApp.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => testing.activeSession()?.metadata.steps.length === 0,
    30_000,
    "undoing the replayed suffix to restore the immutable source"
  );
  const restored = testing.activeSession();
  assert.ok(restored, "Final Pivot wider lifecycle Undo must retain the exact active session.");
  assert.deepEqual(restored.metadata.steps, []);
  assert.deepEqual(
    restored.metadata.schema.map((column) => ({ id: column.id, name: column.name })),
    initial.metadata.schema.map((column) => ({ id: column.id, name: column.name })),
    "Pivot wider lifecycle did not restore the exact source schema."
  );
  const finalApp = await synchronizeApp("Pivot wider lifecycle complete");
  const restoredPage = await testing.request({
    kind: "getPage",
    sessionId,
    revision: restored.metadata.revision,
    viewRequestId: `${checkpoint}:restored-source`,
    offset: 0,
    limit: 1,
    filterModel: initial.viewState.filterModel,
    columnOffset: valuesFrom.position,
    columnLimit: 1
  });
  assert.equal(restoredPage.kind, "page");
  if (restoredPage.kind !== "page") throw new Error("Restored Pivot wider source page failed.");
  assert.deepEqual(
    restoredPage.page.rows[0]?.values[0],
    sourceValue,
    "Pivot wider lifecycle changed its immutable source value."
  );
  assert.equal(testing.activeSession()?.sessionId, sessionId, "Pivot wider lifecycle lost its exact session.");
  assert.equal(testing.activeSession()?.metadata.draftStep, undefined);
  await finalApp.getByRole("button", { name: "Add step", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  recordAcceptanceProgress(`${checkpoint}:complete`);
}
