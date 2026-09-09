import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import {
  acquireCurrentExactCodePreviewGeneration,
  assertExactCodePreviewReceipt,
  ensureCodePreviewHeight,
  revealCodePreviewExactLogicalLine,
  revealCodePreviewText,
  waitForCodePreview
} from "./codePreview";
import type { TestApi } from "./extensionHostTestApi";
import { codePreviewDocumentReceipt } from "./playwrightLifecycle";
import {
  assertReleasedRCastGeneratedCode,
  assertReleasedRDropGeneratedCode,
  assertReleasedRFindReplaceCodeSurface,
  assertReleasedRFindReplaceGeneratedCode,
  assertReleasedRGeneratedCode,
  assertReleasedRSelectGeneratedCode,
  assertReleasedRTextLengthGeneratedCode
} from "./releasedRGeneratedCode";

interface ReleasedROperationPickerResult {
  readonly app: Locator;
  readonly dialog: Locator;
}

export interface ReleasedROperationPreviewDependencies {
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<ReleasedROperationPickerResult>;
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
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, description: string) => Promise<void>;
  readonly WORKBENCH_PLAYWRIGHT_TIMEOUT_MS: number;
}

export function createReleasedROperationPreviews(dependencies: ReleasedROperationPreviewDependencies) {
  const {
    openReleasedROperationPicker,
    recordAcceptanceProgress,
    releasedRSessionApp,
    requireFreshExactSessionPanelHydration,
    waitFor,
    WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
  } = dependencies;

  async function previewReleasedRSortRows(testing: TestApi, workbench: Page, sessionId: string): Promise<string> {
    const { dialog } = await openReleasedROperationPicker(testing, workbench, sessionId);
    await dialog.getByRole("button", { name: /^Sort rows/u }).click();
    await dialog.getByLabel("Column 1", { exact: true }).selectOption({ label: "group" });
    await dialog.getByLabel("Direction", { exact: true }).nth(0).selectOption("asc");
    await dialog.getByLabel("Missing", { exact: true }).nth(0).selectOption("last");
    await dialog.getByRole("button", { name: "Add sort column", exact: true }).click();
    await dialog.getByLabel("Column 2", { exact: true }).selectOption({ label: "score" });
    await dialog.getByLabel("Direction", { exact: true }).nth(1).selectOption("desc");
    await dialog.getByLabel("Missing", { exact: true }).nth(1).selectOption("last");
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "sortRows" &&
          draft.params.rules.length === 2 &&
          draft.params.rules[0]?.column.name === "group" &&
          draft.params.rules[1]?.column.name === "score" &&
          active.metadata.steps.length === 0 &&
          active.metadata.shape.rows === 1_205
        );
      },
      30_000,
      "the native R Sort rows preview"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Sort rows preview must reach its exact renderer."
    );
    const draft = testing.activeSession()?.metadata.draftStep;
    assert.ok(draft?.kind === "sortRows", "The native R Sort rows preview must retain its draft.");
    return draft.id;
  }

  async function previewReleasedRFilterRows(testing: TestApi, workbench: Page, sessionId: string): Promise<string> {
    const { dialog } = await openReleasedROperationPicker(testing, workbench, sessionId);
    await dialog.getByRole("button", { name: /^Filter rows/u }).click();
    await dialog.getByText("1 filters", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByText("2 sorts", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "filterRows" &&
          draft.params.filterModel.filters.length === 1 &&
          draft.params.filterModel.filters[0]?.column.name === "group" &&
          draft.params.filterModel.sort.map((rule) => rule.column.name).join(",") === "score,group" &&
          active.metadata.steps.length === 0 &&
          active.metadata.shape.rows === 603
        );
      },
      30_000,
      "the native R Filter rows preview"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Filter rows preview must reach its exact renderer."
    );
    const draft = testing.activeSession()?.metadata.draftStep;
    assert.ok(draft?.kind === "filterRows", "The native R Filter rows preview must retain its draft.");
    return draft.id;
  }

  async function previewReleasedRDropMissingRows(
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ): Promise<string> {
    const { dialog } = await openReleasedROperationPicker(testing, workbench, sessionId);
    await dialog.getByRole("button", { name: /^Drop missing rows/u }).click();
    await dialog.getByLabel("Drop when", { exact: true }).selectOption("any");
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "dropMissingRows" &&
          draft.params.columns === undefined &&
          draft.params.how === "any" &&
          active.metadata.steps.length === 0 &&
          active.metadata.shape.rows === 1_203
        );
      },
      30_000,
      "the native R Drop missing rows preview"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Drop missing rows preview must reach its exact renderer."
    );
    const draft = testing.activeSession()?.metadata.draftStep;
    assert.ok(draft?.kind === "dropMissingRows");
    return draft.id;
  }

  async function previewReleasedRDropDuplicates(testing: TestApi, workbench: Page, sessionId: string): Promise<string> {
    const { dialog } = await openReleasedROperationPicker(testing, workbench, sessionId);
    await dialog.getByRole("button", { name: /^Drop duplicates/u }).click();
    await dialog.getByRole("checkbox", { name: "group", exact: true }).check();
    await dialog.getByLabel("Keep", { exact: true }).selectOption("first");
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "dropDuplicates" &&
          draft.params.columns?.length === 1 &&
          draft.params.columns[0]?.name === "group" &&
          draft.params.keep === "first" &&
          active.metadata.steps.length === 0 &&
          active.metadata.shape.rows === 2
        );
      },
      30_000,
      "the native R Drop duplicates preview"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Drop duplicates preview must reach its exact renderer."
    );
    const draft = testing.activeSession()?.metadata.draftStep;
    assert.ok(draft?.kind === "dropDuplicates");
    return draft.id;
  }

  async function previewReleasedRTextLength(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    sourceName: string,
    newColumn: string,
    variableName = "orders_frame"
  ): Promise<Readonly<{ app: Locator; stepId: string }>> {
    const { dialog } = await openReleasedROperationPicker(testing, workbench, sessionId);
    await dialog.getByRole("button", { name: /^Text length/u }).click();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const column = dialog.getByLabel("Text column", { exact: true });
    await column.waitFor({ state: "visible", timeout: 10_000 });
    await column.selectOption({ label: sourceName });
    const target = dialog.getByLabel("New column", { exact: true });
    await target.fill(newColumn);
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        const output = active?.metadata.schema.at(-1);
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "textLength" &&
          draft.params.column.name === sourceName &&
          draft.params.newColumn === newColumn &&
          output?.id === `c:step:${draft.id}:0` &&
          output.name === newColumn &&
          output.type === "integer" &&
          active.metadata.draftReplacesStepId === undefined &&
          active.metadata.steps.length === 0
        );
      },
      30_000,
      "the native R Text Length preview"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const active = testing.activeSession();
    assert.ok(
      active?.metadata.draftStep?.kind === "textLength",
      "The native R Text Length preview must retain its draft."
    );
    const stepId = active.metadata.draftStep.id;
    assertReleasedRTextLengthGeneratedCode(active.code ?? "", sourceName, newColumn, variableName);
    const codePreview = await waitForCodePreview(workbench, undefined, "R");
    assertReleasedRTextLengthGeneratedCode(
      await revealCodePreviewText(codePreview, newColumn),
      sourceName,
      newColumn,
      variableName
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Text Length preview must be acknowledged by its exact renderer."
    );
    return {
      app: await releasedRSessionApp(workbench, testing, sessionId, "the native R Text Length preview"),
      stepId
    };
  }

  async function previewReleasedRFindReplace(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    sourceName: string,
    find: string,
    replacement: string
  ): Promise<Readonly<{ app: Locator; stepId: string }>> {
    const { dialog } = await openReleasedROperationPicker(testing, workbench, sessionId);
    await dialog.getByRole("button", { name: /^Find and replace/u }).click();
    await dialog.getByLabel("Text column", { exact: true }).selectOption({ label: sourceName });
    await dialog.getByLabel("Find (blank matches empty boundaries)", { exact: true }).fill(find);
    await dialog.getByLabel("Replace with", { exact: true }).fill(replacement);
    await dialog.getByRole("checkbox", { name: "Use regular expression", exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "findReplace" &&
          draft.params.column.name === sourceName &&
          draft.params.find === find &&
          draft.params.replacement === replacement &&
          draft.params.regex === false &&
          draft.params.newColumn === undefined &&
          active.metadata.steps.length === 0
        );
      },
      30_000,
      "the native R Find and replace preview"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const active = testing.activeSession();
    assert.ok(
      active?.metadata.draftStep?.kind === "findReplace",
      "The native R Find and replace preview must retain its draft."
    );
    assertReleasedRFindReplaceGeneratedCode(active.code ?? "", sourceName, find, replacement, false);
    const codePreview = await waitForCodePreview(workbench, undefined, "R");
    const visibleCode = await revealCodePreviewText(
      codePreview,
      `.ow_text_replacement <- ${JSON.stringify(replacement)}`
    );
    assertReleasedRFindReplaceCodeSurface(visibleCode, sourceName, find, replacement, false);
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Find and replace preview must be acknowledged by its exact renderer."
    );
    return {
      app: await releasedRSessionApp(workbench, testing, sessionId, "the native R Find and replace preview"),
      stepId: active.metadata.draftStep.id
    };
  }

  async function previewReleasedRCast(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    sourceName: string,
    dtype: "string" | "integer" | "float" | "boolean" | "date" | "datetime",
    variableName = "orders_frame"
  ): Promise<Readonly<{ app: Locator; stepId: string }>> {
    const before = testing.activeSession();
    const input = before?.metadata.schema.find((column) => column.name === sourceName);
    assert.ok(input, `The native R Convert type preview requires ${JSON.stringify(sourceName)}.`);
    const { dialog } = await openReleasedROperationPicker(testing, workbench, sessionId);
    await dialog.getByRole("button", { name: /^Convert type/u }).click();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByLabel("Column", { exact: true }).selectOption({ label: sourceName });
    await dialog.getByLabel("Target type", { exact: true }).selectOption(dtype);
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        const output = active?.metadata.schema.find((column) => column.id === input.id);
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "castColumn" &&
          draft.params.column.id === input.id &&
          draft.params.column.name === sourceName &&
          draft.params.dtype === dtype &&
          output?.name === sourceName &&
          output.position === input.position &&
          output.type === dtype &&
          active.metadata.draftReplacesStepId === undefined &&
          active.metadata.steps.length === 0
        );
      },
      30_000,
      "the native R Convert type preview"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const active = testing.activeSession();
    assert.ok(
      active?.metadata.draftStep?.kind === "castColumn",
      "The native R Convert type preview must retain its draft."
    );
    const stepId = active.metadata.draftStep.id;
    assertReleasedRCastGeneratedCode(active.code ?? "", sourceName, dtype, variableName);
    const codePreview = await waitForCodePreview(workbench, undefined, "R");
    assert.match(await revealCodePreviewText(codePreview, ".ow_cast_kind"), /\.ow_cast_kind/u);
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Convert type preview must be acknowledged by its exact renderer."
    );
    return {
      app: await releasedRSessionApp(workbench, testing, sessionId, "the native R Convert type preview"),
      stepId
    };
  }

  async function previewReleasedRSelect(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    selectedNames: readonly string[],
    variableName = "orders_frame"
  ): Promise<Readonly<{ app: Locator; stepId: string }>> {
    const { dialog } = await openReleasedROperationPicker(testing, workbench, sessionId);
    await dialog.getByRole("button", { name: /^Select columns/u }).click();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const columns = dialog.getByRole("group", { name: "Columns to keep", exact: true });
    for (const name of selectedNames) {
      await columns.getByRole("checkbox", { name, exact: true }).check();
    }
    await dialog
      .getByText(`Selected order: ${selectedNames.join(" → ")}`, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "selectColumns" &&
          draft.params.columns.map((column) => column.name).join("\u0000") === selectedNames.join("\u0000") &&
          active.metadata.schema.map((column) => column.name).join("\u0000") === selectedNames.join("\u0000")
        );
      },
      30_000,
      "the native R Select Columns preview"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const active = testing.activeSession();
    assert.ok(active?.metadata.draftStep?.kind === "selectColumns", "The native R selection must retain its draft.");
    const stepId = active.metadata.draftStep.id;
    assertReleasedRSelectGeneratedCode(active.code ?? "", selectedNames, variableName);
    const expectedCode = selectedNames[0] ?? ".ow_select_positions";
    const codePreview = await waitForCodePreview(workbench, undefined, "R");
    assertReleasedRSelectGeneratedCode(
      await revealCodePreviewText(codePreview, expectedCode),
      selectedNames,
      variableName
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Select Columns preview must be acknowledged by its exact renderer."
    );
    return {
      app: await releasedRSessionApp(workbench, testing, sessionId, "the native R Select Columns preview"),
      stepId
    };
  }

  async function previewReleasedRDrop(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    sourceName: string,
    variableName = "orders_frame",
    checkpointPrefix = "jupyter-r:editing:drop-code-preview"
  ): Promise<Readonly<{ app: Locator; stepId: string }>> {
    const { dialog } = await openReleasedROperationPicker(testing, workbench, sessionId);
    await dialog.getByRole("button", { name: /^Drop columns/u }).click();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog
      .getByRole("group", { name: "Columns to drop", exact: true })
      .getByRole("checkbox", { name: sourceName, exact: true })
      .check();
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "dropColumns" &&
          draft.params.columns.some((column) => column.name === sourceName) &&
          !active.metadata.schema.some((column) => column.name === sourceName)
        );
      },
      30_000,
      "the native R Drop Columns preview"
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const active = testing.activeSession();
    assert.ok(active?.metadata.draftStep?.kind === "dropColumns", "The native R drop preview must retain its draft.");
    const stepId = active.metadata.draftStep.id;
    assertReleasedRDropGeneratedCode(active.code ?? "", sourceName, variableName);
    recordAcceptanceProgress(`${checkpointPrefix}:locator-start`);
    const codePreview = await waitForCodePreview(workbench, undefined, "R");
    recordAcceptanceProgress(`${checkpointPrefix}:locator-ready`);
    recordAcceptanceProgress(`${checkpointPrefix}:size-start`);
    const exactCodePreview = await ensureCodePreviewHeight(workbench, codePreview, 180);
    recordAcceptanceProgress(`${checkpointPrefix}:size-ready`);
    recordAcceptanceProgress(`${checkpointPrefix}:reveal-start`);
    const sourceLine = `  .ow_drop_names <- c(${JSON.stringify(sourceName)})`;
    assertReleasedRDropGeneratedCode(
      await revealCodePreviewExactLogicalLine(exactCodePreview, sourceLine),
      sourceName,
      variableName
    );
    recordAcceptanceProgress(`${checkpointPrefix}:reveal-complete`);
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Drop Columns preview must be acknowledged by its exact renderer."
    );
    return {
      app: await releasedRSessionApp(workbench, testing, sessionId, "the native R Drop Columns preview"),
      stepId
    };
  }

  async function previewReleasedRRename(
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    sourceName: string,
    newName: string,
    replacement?: Readonly<{ replaceStepId: string; previousName: string }>,
    variableName = "orders_frame"
  ): Promise<Readonly<{ app: Locator; stepId: string }>> {
    let dialog: Locator;
    if (replacement) {
      await app.getByRole("button", { name: "Edit latest", exact: true }).click();
      dialog = app.getByRole("dialog", { name: "Edit cleaning step" });
    } else {
      const opened = await openReleasedROperationPicker(testing, workbench, sessionId);
      app = opened.app;
      dialog = opened.dialog;
      await dialog.getByRole("button", { name: /^Rename column/u }).click();
    }
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const column = dialog.getByLabel("Column", { exact: true });
    await column.waitFor({ state: "visible", timeout: 10_000 });
    if (replacement) {
      assert.equal((await column.locator("option:checked").innerText()).trim(), sourceName);
    } else {
      await column.selectOption({ label: sourceName });
    }
    const target = dialog.getByLabel("New name", { exact: true });
    if (replacement) assert.equal(await target.inputValue(), replacement.previousName);
    await target.fill(newName);
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        const draft = active?.metadata.draftStep;
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "renameColumn" &&
          draft.params.column.name === sourceName &&
          draft.params.newName === newName &&
          active.metadata.schema[0]?.name === newName &&
          (replacement
            ? active.metadata.draftReplacesStepId === replacement.replaceStepId &&
              draft.id === replacement.replaceStepId &&
              active.metadata.steps.length === 1
            : active.metadata.draftReplacesStepId === undefined && active.metadata.steps.length === 0)
        );
      },
      30_000,
      `the native R ${replacement ? "replacement" : "new"} rename preview`
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const active = testing.activeSession();
    assert.ok(active?.metadata.draftStep, "The native R rename preview must retain its draft step.");
    const stepId = active.metadata.draftStep.id;
    if (replacement) assert.equal(stepId, replacement.replaceStepId);
    const expectedCode = active.code ?? "";
    assertReleasedRGeneratedCode(expectedCode, newName, variableName);
    const expectedCodeReceipt = codePreviewDocumentReceipt(expectedCode);
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R rename preview must be acknowledged by its exact renderer."
    );
    const acknowledged = testing.activeSession();
    assert.equal(
      acknowledged?.sessionId,
      sessionId,
      "The acknowledged R rename preview must retain its exact session."
    );
    assertExactCodePreviewReceipt(
      codePreviewDocumentReceipt(acknowledged?.code ?? ""),
      expectedCodeReceipt,
      "The acknowledged R rename host document"
    );
    const exactCodePreview = await acquireCurrentExactCodePreviewGeneration(
      workbench,
      "R",
      expectedCodeReceipt,
      Date.now() + WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
    );
    assertReleasedRGeneratedCode(await revealCodePreviewText(exactCodePreview, newName), newName, variableName);
    return {
      app: await releasedRSessionApp(workbench, testing, sessionId, "the native R rename preview"),
      stepId
    };
  }

  return Object.freeze({
    previewReleasedRSortRows,
    previewReleasedRFilterRows,
    previewReleasedRDropMissingRows,
    previewReleasedRDropDuplicates,
    previewReleasedRTextLength,
    previewReleasedRFindReplace,
    previewReleasedRCast,
    previewReleasedRSelect,
    previewReleasedRDrop,
    previewReleasedRRename
  });
}
