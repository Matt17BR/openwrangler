import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { GridPage } from "../../shared/protocol";
import type { TestApi } from "./extensionHostTestApi";
import { assertReleasedRCustomCodeGeneratedCode, assertReleasedRGeneratedCode } from "./releasedRGeneratedCode";

export interface ReleasedRRepresentativeEditingDependencies {
  readonly RELEASED_R_CUSTOM_CODE: string;
  readonly RELEASED_R_SUPPORTED_OPERATIONS: readonly string[];
  readonly assertReleasedRRuntimeBinding: (
    notebook: vscode.NotebookDocument,
    expected: boolean,
    checkpoint: string
  ) => Promise<void>;
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<Readonly<{ app: Locator; dialog: Locator }>>;
  readonly previewReleasedRRename: (
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    sourceName: string,
    newName: string
  ) => Promise<Readonly<{ app: Locator; stepId: string }>>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedRFirstVisibleRow: (
    testing: TestApi,
    sessionId: string,
    requestId: string
  ) => Promise<GridPage["rows"][number]>;
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    description: string
  ) => Promise<Locator>;
  readonly releasedRVisibleRows: (
    testing: TestApi,
    sessionId: string,
    requestId: string,
    limit: number
  ) => Promise<GridPage["rows"]>;
  readonly requireFreshExactSessionPanelHydration: (
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<void>;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
}

export function createReleasedRRepresentativeEditingJourney(
  dependencies: ReleasedRRepresentativeEditingDependencies
): (
  testing: TestApi,
  workbench: Page,
  sessionId: string,
  notebook: vscode.NotebookDocument,
  phase: "jupyter-r" | "jupyter-r-remote"
) => Promise<void> {
  const {
    RELEASED_R_CUSTOM_CODE,
    RELEASED_R_SUPPORTED_OPERATIONS,
    assertReleasedRRuntimeBinding,
    openReleasedROperationPicker,
    previewReleasedRRename,
    recordAcceptanceProgress,
    releasedRFirstVisibleRow,
    releasedRSessionApp,
    releasedRVisibleRows,
    requireFreshExactSessionPanelHydration,
    waitFor
  } = dependencies;

  async function exerciseReleasedRCustomCodeJourney(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    notebook: vscode.NotebookDocument,
    phase: "jupyter-r" | "jupyter-r-remote"
  ): Promise<void> {
    recordAcceptanceProgress(`${phase}:editing:custom-code:picker`);
    const operationPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
    const customChoice = operationPicker.dialog.getByRole("button", { name: /^Custom code\b/u });
    assert.equal(await customChoice.count(), 1, "The native R picker must expose exactly one Custom code operation.");
    await customChoice.click();
    await operationPicker.dialog.waitFor({ state: "visible", timeout: 10_000 });
    const codeEditor = operationPicker.dialog.getByLabel("Engine-native R", { exact: true });
    await codeEditor.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await codeEditor.inputValue(), "result <- df", "Native R Custom code must start with valid R syntax.");
    await codeEditor.fill(RELEASED_R_CUSTOM_CODE);

    recordAcceptanceProgress(`${phase}:editing:custom-code:preview`);
    await operationPicker.dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "customCode" &&
          draft.params.code === RELEASED_R_CUSTOM_CODE &&
          active.metadata.steps.length === 0 &&
          active.metadata.shape.rows === 3 &&
          active.metadata.shape.columns === 3 &&
          active.metadata.schema.map((column) => column.name).join(",") === "row_id,score,score_plus_one"
        );
      },
      30_000,
      "previewing native R Custom code through its operation form"
    );
    await operationPicker.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const previewed = testing.activeSession();
    assert.ok(
      previewed?.metadata.draftStep?.kind === "customCode",
      "The native R custom preview must retain its draft."
    );
    const stepId = previewed.metadata.draftStep.id;
    assertReleasedRCustomCodeGeneratedCode(previewed.code ?? "", RELEASED_R_CUSTOM_CODE);
    const previewRows = await releasedRVisibleRows(testing, sessionId, `${phase}-custom-code-preview`, 3);
    assert.equal(previewRows.length, 3);
    assert.deepEqual(
      previewRows.map((row) => row.values.map((value) => value.display)),
      [
        ["1", "1", "2"],
        ["2", "2", "3"],
        ["3", "3", "4"]
      ]
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Custom code preview must be acknowledged before apply."
    );
    let app = await releasedRSessionApp(workbench, testing, sessionId, "the native R Custom code preview");
    const draftReview = app.getByRole("region", { name: "Draft review" });
    await draftReview.getByText("Custom code", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    recordAcceptanceProgress(`${phase}:editing:custom-code:apply`);
    await draftReview.getByRole("button", { name: "Apply step", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const step = active?.metadata.steps[0];
        return (
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          step?.kind === "customCode" &&
          step.id === stepId &&
          step.params.code === RELEASED_R_CUSTOM_CODE &&
          active.metadata.shape.rows === 3 &&
          active.metadata.shape.columns === 3 &&
          active.metadata.schema.map((column) => column.name).join(",") === "row_id,score,score_plus_one"
        );
      },
      30_000,
      "applying native R Custom code"
    );
    const applied = testing.activeSession();
    assertReleasedRCustomCodeGeneratedCode(applied?.code ?? "", RELEASED_R_CUSTOM_CODE);
    await assertReleasedRRuntimeBinding(notebook, true, `${phase}:custom-code-source-after-apply`);

    recordAcceptanceProgress(`${phase}:editing:custom-code:undo`);
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The applied native R Custom code step must be acknowledged before undo."
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the native R Custom code session before undo");
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.steps.length === 0 &&
          active.metadata.draftStep === undefined &&
          active.metadata.shape.rows === 1_205 &&
          active.metadata.shape.columns === 25 &&
          active.metadata.schema[0]?.name === "row_id" &&
          (active.code ?? "") === ""
        );
      },
      30_000,
      "undoing native R Custom code"
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The undone native R Custom code step must reach its renderer before checking restored cells."
    );
    app = await releasedRSessionApp(workbench, testing, sessionId, "the native R Custom code session after undo");
    const restoredDisplays = ["1", "A", "1"] as const;
    for (const [column, display] of restoredDisplays.entries()) {
      await app
        .locator(`td[data-grid-row="0"][data-grid-column="${column}"][aria-label=${JSON.stringify(display)}]`)
        .waitFor({ state: "visible", timeout: 10_000 });
    }
    assert.deepEqual(
      await Promise.all(
        restoredDisplays.map((_, column) =>
          app.locator(`td[data-grid-row="0"][data-grid-column="${column}"] .gridCellText`).innerText()
        )
      ),
      restoredDisplays
    );
    recordAcceptanceProgress(`${phase}:editing:custom-code:complete`);
  }

  return async function exerciseReleasedRRepresentativeEditingJourney(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    notebook: vscode.NotebookDocument,
    phase: "jupyter-r" | "jupyter-r-remote"
  ): Promise<void> {
    recordAcceptanceProgress(`${phase}:editing:representative:open`);
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The representative editable R renderer must acknowledge its first complete host snapshot."
    );
    let app = await releasedRSessionApp(workbench, testing, sessionId, "the representative editable R session");
    const opened = testing.activeSession();
    assert.ok(opened, "The representative R editing journey requires one active session.");
    assert.equal(opened.sessionId, sessionId);
    assert.equal(opened.metadata.backend, "r");
    assert.equal(opened.metadata.rDataframeFlavor, "r.data.frame");
    assert.equal(opened.metadata.mode, "editing");
    assert.equal(opened.metadata.capabilities.editable, true);
    assert.deepEqual(opened.metadata.capabilities.supportedOperations, RELEASED_R_SUPPORTED_OPERATIONS);
    assert.equal(opened.metadata.capabilities.supportedOperations.length, 28);
    assert.equal(opened.metadata.capabilities.supportedOperations.includes("byExample"), true);
    assert.equal(opened.metadata.capabilities.supportedOperations.includes("customCode"), true);

    recordAcceptanceProgress(`${phase}:editing:representative:operation-catalog`);
    const operationPicker = await openReleasedROperationPicker(testing, workbench, sessionId);
    app = operationPicker.app;
    const operationCatalog = operationPicker.dialog.getByRole("navigation", { name: "Operation catalog" });
    assert.equal(
      await operationCatalog.locator("button.operationChoice").count(),
      RELEASED_R_SUPPORTED_OPERATIONS.length,
      "The representative R picker must expose exactly its advertised operation catalog."
    );
    assert.equal(await operationCatalog.getByRole("button", { name: /^Transform by example\b/u }).count(), 1);
    assert.equal(await operationCatalog.getByRole("button", { name: /^Custom code\b/u }).count(), 1);
    await operationPicker.dialog.getByRole("button", { name: "Close operation picker" }).click();
    await operationPicker.dialog.waitFor({ state: "hidden", timeout: 10_000 });

    recordAcceptanceProgress(`${phase}:editing:representative:preview-discard`);
    const discarded = await previewReleasedRRename(testing, workbench, app, sessionId, "row_id", "record_id");
    app = discarded.app;
    const discardedReview = app.getByRole("region", { name: "Draft review" });
    await discardedReview.getByText("Rename column", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await discardedReview
      .locator('[aria-label="Data diff summary"]')
      .getByText("No value changes in this block", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    assertReleasedRGeneratedCode(testing.activeSession()?.code ?? "", "record_id");
    await discardedReview.getByRole("button", { name: "Discard", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 0 &&
          active.metadata.schema[0]?.name === "row_id" &&
          (active.code ?? "") === ""
        );
      },
      30_000,
      "discarding the representative native R rename preview"
    );

    recordAcceptanceProgress(`${phase}:editing:representative:preview-apply`);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the representative R session after discard");
    const previewed = await previewReleasedRRename(testing, workbench, app, sessionId, "row_id", "record_id");
    app = previewed.app;
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
          step?.kind === "renameColumn" &&
          step.id === previewed.stepId &&
          step.params.column.name === "row_id" &&
          step.params.newName === "record_id" &&
          active.metadata.schema[0]?.name === "record_id"
        );
      },
      30_000,
      "applying the representative native R rename"
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The representative applied R rename must be acknowledged before inspection."
    );
    assertReleasedRGeneratedCode(testing.activeSession()?.code ?? "", "record_id");

    recordAcceptanceProgress(`${phase}:editing:representative:inspect`);
    await vscode.commands.executeCommand("openWrangler.selectStep", previewed.stepId);
    await waitFor(
      () => testing.activeSession()?.stepInspection?.stepId === previewed.stepId,
      30_000,
      "the representative applied native R rename inspection"
    );
    const inspection = testing.activeSession()?.stepInspection;
    assert.ok(inspection, "The representative R rename must publish its inspection.");
    assert.deepEqual(inspection.diff, {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    });
    assertReleasedRGeneratedCode(inspection.code, "record_id");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the representative inspected R rename");
    await app
      .getByRole("region", { name: "Selected applied-step inspection" })
      .getByRole("button", { name: "Show confirmed data", exact: true })
      .click();
    await waitFor(
      () => testing.activeSession()?.stepInspection === undefined,
      10_000,
      "returning from the representative native R rename inspection"
    );

    recordAcceptanceProgress(`${phase}:editing:representative:undo`);
    app = await releasedRSessionApp(workbench, testing, sessionId, "the representative R rename before undo");
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.steps.length === 0 &&
          active.metadata.draftStep === undefined &&
          active.metadata.schema[0]?.name === "row_id" &&
          (active.code ?? "") === ""
        );
      },
      30_000,
      "undoing the representative native R rename"
    );
    const restored = await releasedRFirstVisibleRow(testing, sessionId, `${phase}-representative-rename-restored`);
    assert.equal(restored.values[0]?.display, "1");
    await exerciseReleasedRCustomCodeJourney(testing, workbench, sessionId, notebook, phase);
    recordAcceptanceProgress(`${phase}:editing:representative:complete`);
  };
}
