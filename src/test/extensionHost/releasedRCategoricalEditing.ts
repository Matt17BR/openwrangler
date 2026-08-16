import * as assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { ElementHandle, Locator, Page } from "playwright-core";
import { sameRendererSynchronizationReceipt } from "./acknowledgedRenderer";
import { revealCodePreviewText, waitForCodePreview } from "./codePreview";
import type { TestApi } from "./extensionHostTestApi";
import {
  AcceptanceActionNotDispatchedError,
  activateExactAcceptanceElementOnce,
  runFailClosedCategoricalUndo
} from "./playwrightLifecycle";
import { assertReleasedRCategoricalGeneratedCode, releasedRCategoricalGeneratedCall } from "./releasedRGeneratedCode";

export interface ReleasedRCategoricalEditingDependencies {
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<Readonly<{ app: Locator; dialog: Locator }>>;
  readonly reacquireAcknowledgedSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<Locator>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    description: string
  ) => Promise<Locator>;
  readonly requireFreshExactSessionPanelHydration: (
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<void>;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
  readonly waitForLocatorText: (
    locator: Locator,
    predicate: (text: string) => boolean,
    timeoutMs: number,
    expectation: string
  ) => Promise<void>;
  readonly QUEUED_RUNTIME_MUTATION_ACCEPTANCE_TIMEOUT_MS: number;
  readonly WORKBENCH_PLAYWRIGHT_TIMEOUT_MS: number;
}

export interface ReleasedRCategoricalEditingInput {
  readonly testing: TestApi;
  readonly workbench: Page;
  readonly sessionId: string;
}

async function undoReleasedRCategoricalStep(
  testing: TestApi,
  workbench: Page,
  sessionId: string,
  appliedRevision: number,
  checkpointPrefix: "jupyter-r:editing:one-hot" | "jupyter-r:editing:multi-label",
  restored: (active: NonNullable<ReturnType<TestApi["activeSession"]>>) => boolean,
  dependencies: ReleasedRCategoricalEditingDependencies
): Promise<void> {
  type RendererReceipt = NonNullable<ReturnType<TestApi["panelSynchronizationReceipt"]>>;
  type UndoTarget = Readonly<{ element: ElementHandle<unknown>; receipt: RendererReceipt }>;
  const {
    reacquireAcknowledgedSessionApp,
    recordAcceptanceProgress,
    QUEUED_RUNTIME_MUTATION_ACCEPTANCE_TIMEOUT_MS,
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
  } = dependencies;
  const snapshot = () => {
    const active = testing.activeSession();
    return {
      sessionId: active?.sessionId,
      revision: active?.metadata.revision,
      panelReceipt: testing.panelSynchronizationReceipt(sessionId),
      scheduler: testing.sessionSchedulerState(sessionId),
      restored: active?.sessionId === sessionId && active !== undefined && restored(active)
    };
  };
  await runFailClosedCategoricalUndo({
    sessionId,
    appliedRevision,
    snapshot,
    acquire: async (): Promise<UndoTarget> => {
      const app = await reacquireAcknowledgedSessionApp(
        workbench,
        testing,
        sessionId,
        "Categorical Undo requires the current acknowledged R renderer."
      );
      const receipt = testing.panelSynchronizationReceipt(sessionId);
      assert.ok(receipt, "Categorical Undo requires one exact current renderer receipt.");
      const element = await app
        .getByRole("button", { name: "Undo", exact: true })
        .elementHandle({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      assert.ok(element, "Categorical Undo requires one exact visible Undo action.");
      return { element, receipt };
    },
    activate: ({ element, receipt }) =>
      activateExactAcceptanceElementOnce(element, WORKBENCH_PLAYWRIGHT_TIMEOUT_MS, () => {
        const current = testing.panelSynchronizationReceipt(sessionId);
        if (
          !sameRendererSynchronizationReceipt(receipt, current) ||
          current?.revision !== appliedRevision ||
          current.layoutTransitionPending !== false
        ) {
          throw new AcceptanceActionNotDispatchedError(
            "The categorical Undo renderer changed immediately before its click",
            new Error("The exact fresh applied-revision renderer receipt changed.")
          );
        }
      }),
    dispose: ({ element }) => element.dispose(),
    checkpoint: (stage) => recordAcceptanceProgress(`${checkpointPrefix}:${stage}`),
    readyTimeoutMs: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
    dispatchTimeoutMs: 5_000,
    confirmationTimeoutMs: QUEUED_RUNTIME_MUTATION_ACCEPTANCE_TIMEOUT_MS,
    description: `the exact ${checkpointPrefix.endsWith("one-hot") ? "One-hot" : "Multi-label"} Undo action`
  });
}

async function exerciseReleasedROneHotJourney(
  input: ReleasedRCategoricalEditingInput,
  dependencies: ReleasedRCategoricalEditingDependencies
): Promise<void> {
  const { testing, workbench, sessionId } = input;
  const {
    openReleasedROperationPicker,
    recordAcceptanceProgress,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor,
    waitForLocatorText
  } = dependencies;
  recordAcceptanceProgress("jupyter-r:editing:one-hot-preview-apply-undo");
  const base = testing.activeSession();
  assert.ok(base, "The restored R session must remain available for One-hot encode.");
  assert.equal(base.metadata.steps.length, 0);
  assert.equal(base.metadata.draftStep, undefined);
  const group = base.metadata.schema.find((column) => column.name === "group");
  assert.ok(group, "The packaged R One-hot encode journey requires the group column.");

  const picker = await openReleasedROperationPicker(testing, workbench, sessionId);
  const dialog = picker.dialog;
  await dialog.getByPlaceholder("Search operations").fill("one-hot");
  await dialog.getByRole("button", { name: /^One-hot encode\b/u }).click();
  await dialog
    .getByRole("group", { name: "Categorical columns", exact: true })
    .locator(`input[type="checkbox"][value="${group.id}"]`)
    .check();
  await dialog.getByLabel("Prefix separator", { exact: true }).fill("_");
  assert.equal(await dialog.getByLabel("Drop original columns", { exact: true }).isChecked(), true);
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const draft = active?.metadata.draftStep;
      const outputs = active?.metadata.schema.slice(-2).map((column) => column.name);
      return (
        active?.sessionId === sessionId &&
        draft?.kind === "oneHotEncode" &&
        draft.params.columns.length === 1 &&
        draft.params.columns[0]?.id === group.id &&
        draft.params.prefixSeparator === "_" &&
        draft.params.dropOriginal === true &&
        !active.metadata.schema.some((column) => column.id === group.id) &&
        outputs?.join(",") === "group_A,group_B"
      );
    },
    30_000,
    "previewing native R One-hot encode through its visible form"
  );
  const preview = testing.activeSession();
  assert.ok(preview?.metadata.draftStep?.kind === "oneHotEncode");
  const outputA = preview.metadata.schema.at(-2);
  const outputB = preview.metadata.schema.at(-1);
  assert.ok(outputA && outputB, "The R One-hot encode preview must append its indicator columns.");
  for (const [ordinal, output, name] of [
    [0, outputA, "group_A"],
    [1, outputB, "group_B"]
  ] as const) {
    assert.equal(output.id, `c:step:${preview.metadata.draftStep.id}:${ordinal}`);
    assert.equal(output.name, name);
    assert.equal(output.type, "integer");
    assert.equal(output.rawType, "integer");
    assert.equal(output.nullable, false);
  }
  const generatedExpectation = {
    kind: "oneHotEncode",
    sourceId: group.id,
    sourceName: group.name,
    sourcePosition: group.position + 1,
    sourceKind: "character",
    sourceStorageMode: "character",
    sourceClasses: ["character"],
    sourceTimezone: null,
    sourceUnits: null,
    prefixSeparator: "_",
    dropOriginal: true,
    stepId: preview.metadata.draftStep.id
  } as const;
  const generatedCall = releasedRCategoricalGeneratedCall(generatedExpectation);
  assertReleasedRCategoricalGeneratedCode(preview.code ?? "", generatedExpectation);
  const codePreview = await waitForCodePreview(workbench, generatedCall, "R");
  const visibleCode = await revealCodePreviewText(codePreview, generatedCall);
  assertReleasedRCategoricalGeneratedCode(visibleCode, generatedExpectation);
  const previewPage = await testing.request({
    kind: "getPage",
    sessionId,
    revision: preview.metadata.revision,
    viewRequestId: "jupyter-r-one-hot-preview-page",
    offset: 601,
    limit: 2,
    filterModel: preview.viewState.filterModel,
    columnOffset: outputA.position,
    columnLimit: 2
  });
  assert.equal(previewPage.kind, "page");
  if (previewPage.kind !== "page") throw new Error("The packaged R One-hot encode preview did not return its page.");
  assert.deepEqual(previewPage.page.columnIds, [outputA.id, outputB.id]);
  assert.deepEqual(
    previewPage.page.rows.map((row) => row.values.map((value) => value.raw)),
    [
      ["1", "0"],
      ["0", "1"]
    ]
  );
  await requireFreshExactSessionPanelHydration(testing, sessionId, "The R One-hot preview must reach its renderer.");
  let app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R One-hot preview");
  await app
    .getByRole("region", { name: "Draft review" })
    .getByText("One-hot encode", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  const outputSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await outputSearch.fill(outputA.name);
  await app
    .getByRole("option", { name: /^group_A,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await outputSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === outputA.id,
    10_000,
    "revealing the visible R One-hot output"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R One-hot preview");
  await waitForLocatorText(
    app.locator(`td[data-grid-row="0"][data-grid-column="${outputA.position}"]`),
    (text) => text.trim() === "1",
    10_000,
    "the visible R One-hot value"
  );
  await waitForLocatorText(
    app.locator(`td[data-grid-row="0"][data-grid-column="${outputB.position}"]`),
    (text) => text.trim() === "0",
    10_000,
    "the visible R One-hot complementary value"
  );
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        active.metadata.steps[0]?.kind === "oneHotEncode" &&
        active.metadata.schema.at(-2)?.id === outputA.id &&
        active.metadata.schema.at(-1)?.id === outputB.id
      );
    },
    30_000,
    "applying native R One-hot encode"
  );
  const applied = testing.activeSession();
  assert.ok(applied, "The applied R One-hot encode must retain its session.");
  assertReleasedRCategoricalGeneratedCode(applied.code ?? "", generatedExpectation);
  await requireFreshExactSessionPanelHydration(testing, sessionId, "The applied R One-hot step must settle.");
  await undoReleasedRCategoricalStep(
    testing,
    workbench,
    sessionId,
    applied.metadata.revision,
    "jupyter-r:editing:one-hot",
    (active) =>
      active.metadata.steps.length === 0 &&
      active.metadata.draftStep === undefined &&
      isDeepStrictEqual(active.metadata.schema, base.metadata.schema) &&
      isDeepStrictEqual(active.metadata.shape, base.metadata.shape) &&
      (active.code ?? "") === (base.code ?? ""),
    dependencies
  );
}

async function exerciseReleasedRMultiLabelJourney(
  input: ReleasedRCategoricalEditingInput,
  dependencies: ReleasedRCategoricalEditingDependencies
): Promise<void> {
  const { testing, workbench, sessionId } = input;
  const {
    openReleasedROperationPicker,
    recordAcceptanceProgress,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor,
    waitForLocatorText
  } = dependencies;
  recordAcceptanceProgress("jupyter-r:editing:multi-label-preview-apply-undo");
  const base = testing.activeSession();
  assert.ok(base, "The restored R session must remain available for Multi-label binarize.");
  assert.equal(base.metadata.steps.length, 0);
  assert.equal(base.metadata.draftStep, undefined);
  const labels = base.metadata.schema.find((column) => column.name === "extra_18");
  assert.ok(labels, "The packaged R Multi-label journey requires its delimiter-bearing labels column.");

  const picker = await openReleasedROperationPicker(testing, workbench, sessionId);
  const dialog = picker.dialog;
  await dialog.getByPlaceholder("Search operations").fill("multi-label");
  await dialog.getByRole("button", { name: /^Multi-label binarize\b/u }).click();
  await dialog.getByLabel("Labels column", { exact: true }).selectOption(labels.id);
  await dialog.getByLabel("Delimiter", { exact: true }).fill("|");
  assert.equal(await dialog.getByLabel("Drop original column", { exact: true }).isChecked(), false);
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      const draft = active?.metadata.draftStep;
      return (
        active?.sessionId === sessionId &&
        draft?.kind === "multiLabelBinarize" &&
        draft.params.column.id === labels.id &&
        draft.params.delimiter === "|" &&
        draft.params.prefix === undefined &&
        draft.params.dropOriginal === false &&
        active.metadata.schema
          .slice(-2)
          .map((column) => column.name)
          .join(",") === "extra_18_A,extra_18_B"
      );
    },
    30_000,
    "previewing native R Multi-label binarize through its visible form"
  );
  const preview = testing.activeSession();
  assert.ok(preview?.metadata.draftStep?.kind === "multiLabelBinarize");
  const outputA = preview.metadata.schema.at(-2);
  const outputB = preview.metadata.schema.at(-1);
  assert.ok(outputA && outputB, "The R Multi-label preview must append its indicator columns.");
  for (const [ordinal, output, name] of [
    [0, outputA, "extra_18_A"],
    [1, outputB, "extra_18_B"]
  ] as const) {
    assert.equal(output.id, `c:step:${preview.metadata.draftStep.id}:${ordinal}`);
    assert.equal(output.name, name);
    assert.equal(output.type, "integer");
    assert.equal(output.rawType, "integer");
    assert.equal(output.nullable, false);
  }
  const generatedExpectation = {
    kind: "multiLabelBinarize",
    sourceId: labels.id,
    sourceName: labels.name,
    sourcePosition: labels.position + 1,
    sourceKind: "character",
    sourceStorageMode: "character",
    sourceClasses: ["character"],
    sourceTimezone: null,
    sourceUnits: null,
    delimiter: "|",
    prefix: `${labels.name}_`,
    dropOriginal: false,
    stepId: preview.metadata.draftStep.id
  } as const;
  const generatedCall = releasedRCategoricalGeneratedCall(generatedExpectation);
  assertReleasedRCategoricalGeneratedCode(preview.code ?? "", generatedExpectation);
  const codePreview = await waitForCodePreview(workbench, generatedCall, "R");
  const visibleCode = await revealCodePreviewText(codePreview, generatedCall);
  assertReleasedRCategoricalGeneratedCode(visibleCode, generatedExpectation);
  const previewPage = await testing.request({
    kind: "getPage",
    sessionId,
    revision: preview.metadata.revision,
    viewRequestId: "jupyter-r-multi-label-preview-page",
    offset: 0,
    limit: 2,
    filterModel: preview.viewState.filterModel,
    columnOffset: outputA.position,
    columnLimit: 2
  });
  assert.equal(previewPage.kind, "page");
  if (previewPage.kind !== "page") {
    throw new Error("The packaged R Multi-label binarize preview did not return its page.");
  }
  assert.deepEqual(previewPage.page.columnIds, [outputA.id, outputB.id]);
  assert.deepEqual(
    previewPage.page.rows.map((row) => row.values.map((value) => value.raw)),
    [
      ["1", "1"],
      ["0", "1"]
    ]
  );
  await requireFreshExactSessionPanelHydration(
    testing,
    sessionId,
    "The R Multi-label preview must reach its renderer."
  );
  let app = await releasedRSessionApp(workbench, testing, sessionId, "the visible R Multi-label preview");
  await app
    .getByRole("region", { name: "Draft review" })
    .getByText("Multi-label binarize", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  const outputSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await outputSearch.fill(outputA.name);
  await app
    .getByRole("option", { name: /^extra_18_A,/u })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await outputSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === outputA.id,
    10_000,
    "revealing the visible R Multi-label output"
  );
  app = await releasedRSessionApp(workbench, testing, sessionId, "the selected R Multi-label preview");
  await waitForLocatorText(
    app.locator(`td[data-grid-row="0"][data-grid-column="${outputA.position}"]`),
    (text) => text.trim() === "1",
    10_000,
    "the visible R Multi-label value"
  );
  for (const [row, column, expectedValue] of [
    [0, outputB.position, "1"],
    [1, outputA.position, "0"],
    [1, outputB.position, "1"]
  ] as const) {
    await waitForLocatorText(
      app.locator(`td[data-grid-row="${row}"][data-grid-column="${column}"]`),
      (text) => text.trim() === expectedValue,
      10_000,
      `the visible R Multi-label row ${row} column ${column} value`
    );
  }
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === sessionId &&
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        active.metadata.steps[0]?.kind === "multiLabelBinarize" &&
        active.metadata.schema.at(-2)?.id === outputA.id &&
        active.metadata.schema.at(-1)?.id === outputB.id
      );
    },
    30_000,
    "applying native R Multi-label binarize"
  );
  const applied = testing.activeSession();
  assert.ok(applied, "The applied R Multi-label binarize must retain its session.");
  assertReleasedRCategoricalGeneratedCode(applied.code ?? "", generatedExpectation);
  await requireFreshExactSessionPanelHydration(testing, sessionId, "The applied R Multi-label step must settle.");
  await undoReleasedRCategoricalStep(
    testing,
    workbench,
    sessionId,
    applied.metadata.revision,
    "jupyter-r:editing:multi-label",
    (active) =>
      active.metadata.steps.length === 0 &&
      active.metadata.draftStep === undefined &&
      isDeepStrictEqual(active.metadata.schema, base.metadata.schema) &&
      isDeepStrictEqual(active.metadata.shape, base.metadata.shape) &&
      (active.code ?? "") === (base.code ?? ""),
    dependencies
  );
}

export async function exerciseReleasedRCategoricalEditingJourney(
  input: ReleasedRCategoricalEditingInput,
  dependencies: ReleasedRCategoricalEditingDependencies
): Promise<void> {
  await exerciseReleasedROneHotJourney(input, dependencies);
  await exerciseReleasedRMultiLabelJourney(input, dependencies);
}
