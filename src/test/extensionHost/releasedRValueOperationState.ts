import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { codePreviewDocumentReceipt } from "./playwrightLifecycle";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRValueCheckpoint =
  "entry" | "formula-undo-restored" | "strip-discard-restored" | "split-discard-restored" | "exit";

type ReleasedRValueOperation =
  | "find-replace"
  | "formula"
  | "format-datetime"
  | "min-max-scale"
  | "round"
  | "floor"
  | "ceiling"
  | "capitalize"
  | "lowercase"
  | "uppercase"
  | "strip"
  | "split";

export interface ReleasedRValueOperationStateDependencies {
  readonly RELEASED_R_SUPPORTED_OPERATIONS: readonly string[];
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    description: string
  ) => Promise<Locator>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
}

export function createReleasedRValueOperationState(dependencies: ReleasedRValueOperationStateDependencies): Readonly<{
  assertReleasedRValueOperationsCleanState: (
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    checkpoint: ReleasedRValueCheckpoint
  ) => Promise<void>;
  recordReleasedRValueOperationCheckpoint: (operation: ReleasedRValueOperation, boundary: "start" | "complete") => void;
}> {
  const { RELEASED_R_SUPPORTED_OPERATIONS, recordAcceptanceProgress, releasedRSessionApp, waitFor } = dependencies;

  async function assertReleasedRValueOperationsCleanState(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    checkpoint: ReleasedRValueCheckpoint
  ): Promise<void> {
    const active = testing.activeSession();
    assert.equal(
      active?.sessionId,
      sessionId,
      `The focused R value catalog must retain its exact session at ${checkpoint}.`
    );
    assert.ok(active, `The focused R value catalog requires one active session at ${checkpoint}.`);
    assert.equal(active.metadata.backend, "r");
    assert.deepEqual(active.metadata.capabilities.supportedOperations, RELEASED_R_SUPPORTED_OPERATIONS);
    assert.equal(
      active.metadata.steps.length,
      0,
      `The focused R value catalog must have no applied step at ${checkpoint}.`
    );
    assert.equal(
      active.metadata.draftStep,
      undefined,
      `The focused R value catalog must have no draft at ${checkpoint}.`
    );
    assert.equal(active.code ?? "", "", `The focused R value catalog must have no generated code at ${checkpoint}.`);
    assert.deepEqual(active.viewState.filterModel.filters, []);
    assert.deepEqual(active.viewState.filterModel.sort, []);
    const expectedSchema = [
      "row_id",
      "group",
      "score",
      "label",
      "fractional_score",
      ...Array.from({ length: 20 }, (_value, index) => `extra_${String(index + 1).padStart(2, "0")}`)
    ];
    assert.deepEqual(active.metadata.shape, { rows: 1_205, columns: expectedSchema.length });
    assert.deepEqual(
      active.metadata.schema.map((column) => column.name),
      expectedSchema,
      `The focused R value catalog must restore its exact source schema at ${checkpoint}.`
    );
    const requiresRendererSettlement = checkpoint === "entry" || checkpoint === "formula-undo-restored";
    if (requiresRendererSettlement) {
      const rowIdColumn = active.metadata.schema[0];
      assert.equal(
        rowIdColumn?.name,
        "row_id",
        `The focused R value catalog must retain row_id first at ${checkpoint}.`
      );
      assert.ok(rowIdColumn, `The focused R value catalog requires its stable first column at ${checkpoint}.`);
      let app = await releasedRSessionApp(
        workbench,
        testing,
        sessionId,
        `the focused R value catalog restored grid at ${checkpoint}`
      );
      const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
      await columnSearch.waitFor({ state: "visible", timeout: 10_000 });
      await columnSearch.fill(rowIdColumn.name);
      await app
        .getByRole("option", { name: /^row_id,/u })
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await columnSearch.press("Enter");
      await waitFor(
        () => {
          const current = testing.activeSession();
          return current?.sessionId === sessionId && current.viewState.selectedColumnId === rowIdColumn.id;
        },
        10_000,
        `the focused R value catalog to select its exact restored row_id column at ${checkpoint}`
      );
      app = await releasedRSessionApp(
        workbench,
        testing,
        sessionId,
        `the focused R value catalog selected row_id grid at ${checkpoint}`
      );
      const firstRestoredCell = app.locator('td[data-grid-row="0"][data-grid-column="0"]').first();
      await firstRestoredCell.getByText("1", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(
        (await firstRestoredCell.textContent())?.trim(),
        "1",
        `The focused R value catalog must render its first restored cell at ${checkpoint}.`
      );
    }
    await waitFor(
      () => {
        const scheduler = testing.sessionSchedulerState(sessionId);
        return (
          scheduler?.sessionId === sessionId &&
          scheduler.activeForegroundOperation === false &&
          scheduler.interactiveQueueLength === 0
        );
      },
      10_000,
      `the focused R value catalog foreground lane to settle at ${checkpoint}`,
      () =>
        JSON.stringify({
          selectedColumnId: testing.activeSession()?.viewState.selectedColumnId,
          scheduler: testing.sessionSchedulerState(sessionId),
          panelReceipt: testing.panelSynchronizationReceipt(sessionId)
        })
    );
    const restored = testing.activeSession();
    assert.equal(restored?.sessionId, sessionId, `The focused R value catalog must remain active at ${checkpoint}.`);
    assert.ok(restored, `The focused R value catalog requires its restored session at ${checkpoint}.`);
    const page = await testing.request({
      kind: "getPage",
      sessionId,
      revision: restored.metadata.revision,
      viewRequestId: `jupyter-r-value-${checkpoint}`,
      offset: 0,
      limit: 1,
      filterModel: restored.viewState.filterModel,
      columnOffset: 0,
      columnLimit: 4
    });
    if (page.kind !== "page") {
      const diagnostic = {
        kind: page.kind,
        code: page.kind === "error" ? page.code : null,
        recoverable: page.kind === "error" ? page.recoverable : null,
        viewRequestId: "viewRequestId" in page && typeof page.viewRequestId === "string" ? page.viewRequestId : null,
        messageReceipt: page.kind === "error" ? codePreviewDocumentReceipt(page.message) : null
      };
      assert.fail(`The focused R value catalog page did not resolve at ${checkpoint}: ${JSON.stringify(diagnostic)}.`);
    }
    assert.equal(page.kind, "page", `The focused R value catalog must return its restored page at ${checkpoint}.`);
    assert.deepEqual(
      page.page.columnIds,
      restored.metadata.schema.slice(0, 4).map((column) => column.id)
    );
    assert.deepEqual(
      page.page.rows[0]?.values.map((value) => value.display),
      ["1", "A", "1", "row-0001"]
    );
    recordAcceptanceProgress(`jupyter-r:editing:value-operations:${checkpoint}`);
  }

  function recordReleasedRValueOperationCheckpoint(
    operation: ReleasedRValueOperation,
    boundary: "start" | "complete"
  ): void {
    recordAcceptanceProgress(`jupyter-r:editing:value-operations:${operation}:${boundary}`);
  }

  return Object.freeze({ assertReleasedRValueOperationsCleanState, recordReleasedRValueOperationCheckpoint });
}
