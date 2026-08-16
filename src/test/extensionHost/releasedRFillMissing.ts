import * as assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { Locator, Page } from "playwright-core";
import type { TestApi } from "./extensionHostTestApi";

interface ReleasedRFillMissingDependencies {
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<Readonly<{ app: Locator; dialog: Locator }>>;
  readonly recordAcceptanceProgress: (stage: string) => void;
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<Locator>;
  readonly requireFreshExactSessionPanelHydration: (
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<void>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
}

export function createReleasedRFillMissingJourney({
  openReleasedROperationPicker,
  recordAcceptanceProgress,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor
}: ReleasedRFillMissingDependencies) {
  return async function exerciseReleasedRFillMissingJourney(
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    phase: "jupyter-r"
  ): Promise<void> {
    recordAcceptanceProgress(`${phase}:editing:fill-missing-preview-apply-undo`);
    const original = testing.activeSession();
    assert.equal(original?.sessionId, sessionId, "The packaged R fill journey must retain its exact session.");
    assert.ok(original, "The packaged R fill journey requires one active session.");
    assert.equal(original.metadata.steps.length, 0, "The packaged R fill journey must start from the original frame.");
    const target = original.metadata.schema.find((column) => column.name === "fractional_score");
    assert.ok(target, "The packaged R fill journey requires the nullable fractional_score column.");
    assert.equal(target.type, "float");
    assert.equal(target.rawType, "double");
    assert.equal(target.nullable, true);
    const sourceGap = await testing.request({
      kind: "getPage",
      sessionId,
      revision: original.metadata.revision,
      viewRequestId: `${phase}-fill-mean-source-gap`,
      offset: 602,
      limit: 1,
      filterModel: original.viewState.filterModel,
      columnOffset: target.position,
      columnLimit: 1
    });
    assert.equal(sourceGap.kind, "page");
    if (sourceGap.kind !== "page") throw new Error("The native R mean-fill source page did not resolve.");
    assert.deepEqual(sourceGap.page.columnIds, [target.id]);
    assert.equal(sourceGap.page.rows[0]?.values[0]?.isNull, true);

    const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await columnSearch.fill(target.name);
    await app
      .getByRole("option", { name: new RegExp(`^${target.name},`, "u") })
      .first()
      .waitFor({
        state: "visible",
        timeout: 10_000
      });
    await columnSearch.press("Enter");
    await waitFor(
      () => testing.activeSession()?.viewState.selectedColumnId === target.id,
      10_000,
      "navigating to the nullable R column before filling it"
    );
    const fillPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
    app = fillPicker.app;
    const dialog = fillPicker.dialog;
    await dialog.getByPlaceholder("Search operations").fill("fill missing");
    await dialog.getByRole("button", { name: /^Fill missing values/u }).click();
    const fillColumn = dialog.getByLabel("Column", { exact: true });
    await fillColumn.waitFor({ state: "visible", timeout: 10_000 });
    await fillColumn.selectOption(target.id);
    const fillMode = dialog.getByLabel("Method", { exact: true });
    await fillMode.waitFor({ state: "visible", timeout: 10_000 });
    await fillMode.locator('option[value="mean"]').waitFor({ state: "attached", timeout: 10_000 });
    assert.equal(await fillMode.inputValue(), "median", "A floating-point R column should default to Median.");
    assert.deepEqual(await fillMode.locator("option").allTextContents(), [
      "Median",
      "Mean",
      "Median within groups",
      "Mean within groups",
      "Linear interpolation",
      "Previous value",
      "Next value",
      "Fallback columns (same row)",
      "Specific value"
    ]);
    await fillMode.selectOption("mean");
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "fillMissingValues" &&
          draft.params.column.id === target.id &&
          draft.params.column.name === target.name &&
          isDeepStrictEqual(draft.params.replacement, { kind: "mean" }) &&
          active.metadata.schema.find((column) => column.id === target.id)?.nullable === false
        );
      },
      30_000,
      "previewing native R Fill missing values through its operation form"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });

    app = await releasedRSessionApp(workbench, testing, sessionId, "the native R Fill missing values preview");

    const preview = testing.activeSession();
    assert.ok(preview?.metadata.draftStep?.kind === "fillMissingValues");
    const stepId = preview.metadata.draftStep.id;
    assert.match(preview.code ?? "", /\.ow_fill_values/u);
    assert.match(preview.code ?? "", /mean\(\.ow_present \/ \.ow_scale\)/u);
    assert.doesNotMatch(preview.code ?? "", /\b(?:pandas|polars|python)\b/iu);
    const previewGap = await testing.request({
      kind: "getPage",
      sessionId,
      revision: preview.metadata.revision,
      viewRequestId: `${phase}-fill-mean-preview-gap`,
      offset: 602,
      limit: 1,
      filterModel: preview.viewState.filterModel,
      columnOffset: target.position,
      columnLimit: 1
    });
    assert.equal(previewGap.kind, "page");
    if (previewGap.kind !== "page") throw new Error("The native R mean-fill preview page did not resolve.");
    assert.deepEqual(previewGap.page.columnIds, [target.id]);
    const previewValue = previewGap.page.rows[0]?.values[0];
    assert.ok(previewValue?.kind === "number");
    assert.equal(previewValue.isNull, false);
    assert.equal(previewValue.isNaN, false);
    assert.equal(Number.isFinite(previewValue.raw), true);
    const review = app.getByRole("region", { name: "Draft review" });
    await review.waitFor({ state: "visible", timeout: 10_000 });
    await review.getByText("Fill missing values", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await review
      .locator('[aria-label="Data diff summary"]')
      .getByText("No value changes in this block", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });

    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const step = active?.metadata.steps[0];
        return (
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          step?.id === stepId &&
          step.kind === "fillMissingValues" &&
          isDeepStrictEqual(step.params.replacement, { kind: "mean" }) &&
          active.metadata.schema.find((column) => column.id === target.id)?.nullable === false
        );
      },
      30_000,
      "applying native R Fill missing values through Draft review"
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the applied native R Fill missing values step");
    await app.getByRole("group", { name: "Cleaning plan" }).getByText("1 applied step").waitFor({
      state: "visible",
      timeout: 10_000
    });
    const applied = testing.activeSession();
    assert.ok(applied, "The applied R Fill missing values step must retain its exact session.");
    assert.match(applied.code ?? "", /\.ow_fill_values/u);
    assert.match(applied.code ?? "", /mean\(\.ow_present \/ \.ow_scale\)/u);

    await app.getByRole("button", { name: "Undo", exact: true }).click();
    const undoState = (): Record<string, unknown> => {
      const active = testing.activeSession();
      return {
        revision: active?.metadata.revision,
        appliedRevision: applied.metadata.revision,
        stepCount: active?.metadata.steps.length,
        draft: active?.metadata.draftStep?.kind,
        targetNullable: active?.metadata.schema.find((column) => column.id === target.id)?.nullable,
        codeEmpty: (active?.code ?? "") === "",
        scheduler: testing.sessionSchedulerState(sessionId)
      };
    };
    await waitFor(
      () => {
        const active = testing.activeSession();
        const scheduler = testing.sessionSchedulerState(sessionId);
        return (
          (active?.metadata.revision ?? applied.metadata.revision) > applied.metadata.revision ||
          scheduler?.activeForegroundOperation === true ||
          (scheduler?.interactiveQueueLength ?? 0) > 0
        );
      },
      5_000,
      "the native R Fill missing values Undo click to dispatch once",
      () => JSON.stringify(undoState())
    );
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.steps.length === 0 &&
          active.metadata.draftStep === undefined &&
          active.metadata.schema.find((column) => column.id === target.id)?.nullable === true &&
          (active.code ?? "") === ""
        );
      },
      30_000,
      "undoing native R Fill missing values through the editor",
      () => JSON.stringify(undoState())
    );
    const restored = testing.activeSession();
    assert.ok(restored, "The undone native R mean-fill session must remain active.");
    const restoredGap = await testing.request({
      kind: "getPage",
      sessionId,
      revision: restored.metadata.revision,
      viewRequestId: `${phase}-fill-mean-restored-gap`,
      offset: 602,
      limit: 1,
      filterModel: restored.viewState.filterModel,
      columnOffset: target.position,
      columnLimit: 1
    });
    assert.equal(restoredGap.kind, "page");
    if (restoredGap.kind !== "page") throw new Error("The undone native R mean-fill page did not resolve.");
    assert.deepEqual(restoredGap.page.columnIds, [target.id]);
    assert.equal(restoredGap.page.rows[0]?.values[0]?.isNull, true);
    const returnColumn = original.metadata.schema.find((column) => column.name === "row_id");
    assert.ok(returnColumn, "The packaged R fill journey must be able to return to the first editing column.");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the R session after undoing Fill missing values");
    const returnSearch = app.getByRole("combobox", { name: "Column", exact: true });
    await returnSearch.fill(returnColumn.name);
    await app
      .getByRole("option", { name: new RegExp(`^${returnColumn.name},`, "u") })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await returnSearch.press("Enter");
    await waitFor(
      () => testing.activeSession()?.viewState.selectedColumnId === returnColumn.id,
      10_000,
      "returning to the first R column after the fill journey"
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The first R column must be visible before the unrelated rename journey starts."
    );
  };
}
