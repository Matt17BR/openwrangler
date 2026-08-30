import * as assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type { Frame, Page } from "playwright-core";
import type { ColumnReference, SessionMetadata } from "../../shared/protocol";
import { exactSessionApp } from "./acknowledgedRenderer";
import { assertExactBytes } from "./acceptanceSourceFixture";
import { revealCodePreviewOperationLine, waitForCodePreview } from "./codePreview";
import type { TestApi } from "./extensionHostTestApi";

export interface PackagedLinearInterpolationJourneyDependencies {
  readonly columnReference: (metadata: SessionMetadata, name: string) => ColumnReference;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForAutomaticDelimitedImport: (
    page: Page,
    testing: TestApi,
    expectedSource: vscode.Uri,
    checkpointPrefix: string
  ) => Promise<void>;
  readonly waitForOpenWranglerGridTarget: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string
  ) => Promise<Readonly<{ frame: Frame }>>;
}

export function packagedLinearInterpolationFixtureCsv(): string {
  return [
    "source_row,coordinate,measurement",
    "r4,20,",
    "r1,0,10.0",
    "r5,40,50.0",
    "r2,5,",
    "r6,50,",
    "r3,15,",
    "r7,60,70.0",
    ""
  ].join("\n");
}

export function createPackagedLinearInterpolationJourney(
  dependencies: PackagedLinearInterpolationJourneyDependencies
): (testing: TestApi, workbench: Page, fixture: vscode.Uri, editorName: string) => Promise<void> {
  const {
    columnReference,
    recordAcceptanceProgress,
    waitFor,
    waitForAutomaticDelimitedImport,
    waitForOpenWranglerGridTarget
  } = dependencies;

  return async function exercisePackagedLinearInterpolationJourney(
    testing: TestApi,
    workbench: Page,
    fixture: vscode.Uri,
    editorName: string
  ): Promise<void> {
    recordAcceptanceProgress("platform-smoke:fill-linear-interpolation");
    const sourceBytes = await vscode.workspace.fs.readFile(fixture);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      15_000,
      `the ${editorName} session to close before linear interpolation`
    );

    await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitForAutomaticDelimitedImport(workbench, testing, fixture, "platform-smoke:fill-linear-import");
    const opened = testing.activeSession();
    assert.ok(opened, "The linear-interpolation fixture must open one dataframe session.");
    assert.equal(opened.metadata.backend, "polars");
    assert.deepEqual(opened.metadata.shape, { rows: 7, columns: 3 });
    const sourceRow = columnReference(opened.metadata, "source_row");
    const coordinate = columnReference(opened.metadata, "coordinate");
    const measurement = columnReference(opened.metadata, "measurement");
    const measurementPosition = opened.metadata.schema.findIndex((column) => column.id === measurement.id);
    assert.equal(measurementPosition, 2);
    assert.equal(opened.metadata.schema[measurementPosition]?.type, "float");

    const sourcePage = await testing.request({
      kind: "getPage",
      sessionId: opened.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "platform-smoke-fill-linear-source",
      offset: 0,
      limit: 7,
      filterModel: opened.viewState.filterModel,
      columnOffset: 0,
      columnLimit: 3
    });
    assert.equal(sourcePage.kind, "page");
    if (sourcePage.kind !== "page") throw new Error("The linear-interpolation source page did not resolve.");
    assert.deepEqual(sourcePage.page.columnIds, [sourceRow.id, coordinate.id, measurement.id]);
    assert.deepEqual(
      sourcePage.page.rows.map((row) => ({
        sourceRow: row.values[0]?.display,
        coordinate: Number(row.values[1]?.raw),
        measurement: row.values[2]?.isNull ? null : Number(row.values[2]?.raw)
      })),
      [
        { sourceRow: "r4", coordinate: 20, measurement: null },
        { sourceRow: "r1", coordinate: 0, measurement: 10 },
        { sourceRow: "r5", coordinate: 40, measurement: 50 },
        { sourceRow: "r2", coordinate: 5, measurement: null },
        { sourceRow: "r6", coordinate: 50, measurement: null },
        { sourceRow: "r3", coordinate: 15, measurement: null },
        { sourceRow: "r7", coordinate: 60, measurement: 70 }
      ],
      "The source must be shuffled while its interpolation coordinate remains irregular."
    );
    const sourceRowIds = sourcePage.page.rows.map((row) => row.id);

    const target = await waitForOpenWranglerGridTarget(workbench, testing, opened.sessionId);
    let app = await exactSessionApp(target.frame, opened.sessionId);
    assert.ok(app, "The linear-interpolation fixture must expose its exact Open Wrangler renderer.");
    await app.getByRole("button", { name: "Add step", exact: true }).click();
    const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByPlaceholder("Search operations").fill("fill missing");
    await dialog.getByRole("button", { name: /^Fill missing values/u }).click();
    await dialog.getByLabel("Column", { exact: true }).selectOption(measurement.id);
    const method = dialog.getByLabel("Method", { exact: true });
    await method.locator('option[value="linearInterpolation"]').waitFor({ state: "attached", timeout: 10_000 });
    await method.selectOption("linearInterpolation");
    await dialog.getByLabel("Coordinate column", { exact: true }).selectOption(coordinate.id);
    await dialog.getByLabel("Maximum missing cells in a run (optional)", { exact: true }).fill("3");
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const draft = testing.activeSession()?.metadata.draftStep;
        return (
          draft?.kind === "fillMissingValues" &&
          draft.params.column.id === measurement.id &&
          isDeepStrictEqual(draft.params.replacement, {
            kind: "linearInterpolation",
            coordinate,
            maxGap: 3
          })
        );
      },
      30_000,
      "previewing linear interpolation through the installed operation form"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });

    const code = testing.activeSession()?.code ?? "";
    assert.match(code, /^import polars as pl$/mu);
    assert.ok(
      code.includes("df = _ow_polars_fill_missing_linear_interpolation(df, 'measurement', 'coordinate', 3)"),
      "Generated Polars code must call linear interpolation with the exact selected columns and gap limit."
    );
    assert.doesNotMatch(code, /\b(?:pandas|duckdb|Rscript)\b/iu);
    const codePreview = await waitForCodePreview(workbench, "import polars as pl");
    await revealCodePreviewOperationLine(
      codePreview,
      "_ow_polars_fill_missing_linear_interpolation(df, 'measurement', 'coordinate', 3)",
      "return df"
    );

    const refreshedTarget = await waitForOpenWranglerGridTarget(workbench, testing, opened.sessionId);
    app = await exactSessionApp(refreshedTarget.frame, opened.sessionId);
    assert.ok(app, "The linear-interpolation preview must retain its exact renderer.");
    const preview = testing.activeSession();
    assert.ok(preview?.metadata.draftStep?.kind === "fillMissingValues");
    const previewPage = await testing.request({
      kind: "getPage",
      sessionId: opened.sessionId,
      revision: preview.metadata.revision,
      viewRequestId: "platform-smoke-fill-linear-preview",
      offset: 0,
      limit: 7,
      filterModel: preview.viewState.filterModel,
      columnOffset: measurementPosition,
      columnLimit: 1
    });
    assert.equal(previewPage.kind, "page");
    if (previewPage.kind !== "page") throw new Error("The linear-interpolation preview page did not resolve.");
    assert.deepEqual(previewPage.page.columnIds, [measurement.id]);
    assert.deepEqual(
      previewPage.page.rows.map((row) => row.id),
      sourceRowIds,
      "Interpolation must preserve source order."
    );
    assert.deepEqual(
      previewPage.page.rows.map((row) => Number(row.values[0]?.raw)),
      [30, 10, 50, 15, 60, 25, 70],
      "Interpolation must use coordinate distance rather than source-row distance."
    );
    assert.equal(
      previewPage.page.rows.every(
        (row) => row.values[0]?.kind === "number" && !row.values[0].isNull && !row.values[0].isNaN
      ),
      true
    );
    const review = app.getByRole("region", { name: "Draft review" });
    await review.waitFor({ state: "visible", timeout: 10_000 });
    await review
      .locator('[aria-label="Data diff summary"]')
      .getByText("4 existing cells changed", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });

    await review.getByRole("button", { name: "Apply step", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const step = active?.metadata.steps[0];
        return (
          active?.metadata.draftStep === undefined &&
          active?.metadata.steps.length === 1 &&
          step?.kind === "fillMissingValues" &&
          isDeepStrictEqual(step.params.replacement, {
            kind: "linearInterpolation",
            coordinate,
            maxGap: 3
          })
        );
      },
      30_000,
      "applying linear interpolation through Draft review"
    );
    const applied = testing.activeSession();
    assert.ok(applied, "Applying linear interpolation must retain the active session.");
    const appliedPage = await testing.request({
      kind: "getPage",
      sessionId: opened.sessionId,
      revision: applied.metadata.revision,
      viewRequestId: "platform-smoke-fill-linear-applied",
      offset: 0,
      limit: 7,
      filterModel: applied.viewState.filterModel,
      columnOffset: measurementPosition,
      columnLimit: 1
    });
    assert.equal(appliedPage.kind, "page");
    if (appliedPage.kind !== "page") throw new Error("The applied linear-interpolation page did not resolve.");
    assert.deepEqual(
      appliedPage.page.rows.map((row) => row.id),
      sourceRowIds
    );
    assert.deepEqual(
      appliedPage.page.rows.map((row) => Number(row.values[0]?.raw)),
      [30, 10, 50, 15, 60, 25, 70]
    );
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "Applying linear interpolation must not modify the source CSV."
    );

    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.steps.length === 0 && active.metadata.draftStep === undefined && (active.code ?? "") === ""
        );
      },
      30_000,
      "undoing linear interpolation through the installed editor"
    );
    const restored = testing.activeSession();
    assert.ok(restored, "Undoing linear interpolation must retain the active session.");
    const restoredPage = await testing.request({
      kind: "getPage",
      sessionId: opened.sessionId,
      revision: restored.metadata.revision,
      viewRequestId: "platform-smoke-fill-linear-restored",
      offset: 0,
      limit: 7,
      filterModel: restored.viewState.filterModel,
      columnOffset: 0,
      columnLimit: 3
    });
    assert.equal(restoredPage.kind, "page");
    if (restoredPage.kind !== "page") throw new Error("The undone linear-interpolation page did not resolve.");
    assert.deepEqual(restoredPage.page.columnIds, sourcePage.page.columnIds);
    assert.deepEqual(
      restoredPage.page.rows,
      sourcePage.page.rows,
      "Undo must restore the exact source values and row order."
    );
    assertExactBytes(
      await vscode.workspace.fs.readFile(fixture),
      sourceBytes,
      "Previewing, applying, and undoing linear interpolation must preserve the source CSV bytes."
    );

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      15_000,
      `the ${editorName} linear-interpolation session and runtime to terminate`
    );
  };
}
