import * as assert from "node:assert/strict";
import type { Locator } from "playwright-core";
import type { CellValue, ColumnReference } from "../../shared/protocol";
import type { TestApi } from "./extensionHostTestApi";

export interface PivotLongerJourneyDependencies {
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
}

export async function exercisePivotLongerJourney(
  app: Locator,
  testing: TestApi,
  sessionId: string,
  selectedColumnNames: readonly [string, string],
  synchronizeApp: (phase: string) => Promise<Locator>,
  dependencies: PivotLongerJourneyDependencies
): Promise<void> {
  const { recordAcceptanceProgress, waitFor } = dependencies;
  const checkpoint = `pivot-longer:${selectedColumnNames.join("-")}`;
  recordAcceptanceProgress(`${checkpoint}:start`);
  const initial = testing.activeSession();
  assert.ok(initial?.sessionId === sessionId, "Pivot longer requires the exact active dataframe session.");
  assert.equal(initial.metadata.draftStep, undefined);
  assert.equal(initial.metadata.steps.length, 0);
  const firstSelected = initial.metadata.schema.find((column) => column.name === selectedColumnNames[0]);
  const secondSelected = initial.metadata.schema.find((column) => column.name === selectedColumnNames[1]);
  assert.ok(firstSelected && secondSelected, "The installed Pivot longer journey requires both selected columns.");
  const selected = [firstSelected, secondSelected] as const;
  assert.equal(
    selected[0].type,
    selected[1].type,
    "The installed Pivot longer fixture must use one exact public type."
  );
  assert.equal(
    selected[0].rawType,
    selected[1].rawType,
    "The installed Pivot longer fixture must use one exact runtime type."
  );
  const selectedReferences = selected.map(({ id, name }) => ({ id, name })) as [ColumnReference, ColumnReference];
  const sourceRows = initial.metadata.shape.rows;
  assert.ok(typeof sourceRows === "number" && Number.isSafeInteger(sourceRows) && sourceRows >= 0);
  const sourceValues: (CellValue | undefined)[] = [];
  for (const [index, column] of selected.entries()) {
    const response = await testing.request({
      kind: "getPage",
      sessionId,
      revision: initial.metadata.revision,
      viewRequestId: `${checkpoint}:source-${index}`,
      offset: 0,
      limit: 1,
      filterModel: initial.viewState.filterModel,
      columnOffset: column.position,
      columnLimit: 1
    });
    assert.equal(response.kind, "page");
    if (response.kind !== "page") throw new Error(`Pivot longer source column ${column.name} did not resolve.`);
    sourceValues.push(response.page.rows[0]?.values[0]);
  }
  assert.ok(
    sourceValues.every((value) => value !== undefined),
    "Pivot longer requires both first-row source values."
  );

  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("pivot longer");
  await dialog.getByRole("button", { name: /^Pivot longer\b/u }).click();
  for (const column of selected) {
    await dialog.getByRole("checkbox", { name: column.name, exact: true }).check();
  }
  await dialog.getByText(`Selected order: ${selectedColumnNames.join(" → ")}`, { exact: true }).waitFor({
    state: "visible",
    timeout: 10_000
  });
  await dialog.getByLabel("Label column", { exact: true }).fill("pivot_metric");
  await dialog.getByLabel("Value column", { exact: true }).fill("pivot_value");
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const draft = active?.metadata.draftStep;
      return (
        active?.sessionId === sessionId &&
        draft?.kind === "pivotLonger" &&
        draft.params.columns.map((column) => column.id).join(",") ===
          selectedReferences.map((column) => column.id).join(",") &&
        draft.params.labelColumn === "pivot_metric" &&
        draft.params.valueColumn === "pivot_value"
      );
    },
    30_000,
    "previewing Pivot longer through the installed operation form"
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  const preview = testing.activeSession();
  assert.ok(preview?.metadata.draftStep?.kind === "pivotLonger");
  const labelOutput = preview.metadata.schema.find((column) => column.name === "pivot_metric");
  const valueOutput = preview.metadata.schema.find((column) => column.name === "pivot_value");
  assert.ok(labelOutput && valueOutput, "Pivot longer must publish both output columns atomically.");
  assert.equal(labelOutput.id, `c:step:${preview.metadata.draftStep.id}:0`);
  assert.equal(valueOutput.id, `c:step:${preview.metadata.draftStep.id}:1`);
  assert.equal(
    preview.metadata.schema.some((column) => selectedReferences.some((selected) => selected.id === column.id)),
    false,
    "Pivot longer must replace the selected columns while retaining the immutable source dataframe."
  );
  assert.match(preview.code ?? "", /pivot_metric/u);
  assert.match(preview.code ?? "", /pivot_value/u);

  const previewApp = await synchronizeApp("Pivot longer preview");
  for (const [selectedIndex, expectedValue] of sourceValues.entries()) {
    const response = await testing.request({
      kind: "getPage",
      sessionId,
      revision: preview.metadata.revision,
      viewRequestId: `${checkpoint}:preview-${selectedIndex}`,
      offset: selectedIndex * sourceRows,
      limit: 1,
      filterModel: preview.viewState.filterModel,
      columnOffset: labelOutput.position,
      columnLimit: 2
    });
    assert.equal(response.kind, "page");
    if (response.kind !== "page") throw new Error(`Pivot longer output block ${selectedIndex} did not resolve.`);
    assert.deepEqual(response.page.columnIds, [labelOutput.id, valueOutput.id]);
    assert.equal(response.page.rows[0]?.values[0]?.raw, selectedColumnNames[selectedIndex]);
    assert.deepEqual(response.page.rows[0]?.values[1], expectedValue);
  }

  const review = previewApp.getByRole("region", { name: "Draft review" });
  await review.getByText("Pivot longer", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await review.getByRole("button", { name: "Apply step", exact: true }).click();
  await waitFor(
    () => testing.activeSession()?.metadata.steps[0]?.kind === "pivotLonger",
    30_000,
    "applying Pivot longer"
  );
  const appliedApp = await synchronizeApp("Pivot longer apply");
  await appliedApp.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        selectedReferences.every((selected) => active.metadata.schema.some((column) => column.id === selected.id)) &&
        active.metadata.schema.every((column) => column.name !== "pivot_metric" && column.name !== "pivot_value")
      );
    },
    30_000,
    "undoing Pivot longer without mutating the source"
  );
  recordAcceptanceProgress(`${checkpoint}:complete`);
}
