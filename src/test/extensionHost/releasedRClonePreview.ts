import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { assertReleasedRCloneGeneratedCode } from "./releasedRGeneratedCode";
import type { TestApi } from "./extensionHostTestApi";

interface ReleasedRClonePreviewDependencies {
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ) => Promise<Readonly<{ app: Locator; dialog: Locator }>>;
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
  readonly revealCodePreviewText: (codePreview: Locator, expectedText: string) => Promise<string>;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
  readonly waitForCodePreview: (
    workbench: Page,
    expectedCode: string | undefined,
    language: "Python" | "R"
  ) => Promise<Locator>;
}

export function createReleasedRClonePreview({
  openReleasedROperationPicker,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  revealCodePreviewText,
  waitFor,
  waitForCodePreview
}: ReleasedRClonePreviewDependencies) {
  return async function previewReleasedRClone(
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
      await dialog.getByRole("button", { name: /^Clone column/u }).click();
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
        const clone = active?.metadata.schema.at(-1);
        return (
          active?.sessionId === sessionId &&
          draft?.kind === "cloneColumn" &&
          draft.params.column.name === sourceName &&
          draft.params.newName === newName &&
          clone?.id === `c:step:${draft.id}:0` &&
          clone.name === newName &&
          (replacement
            ? active.metadata.draftReplacesStepId === replacement.replaceStepId &&
              draft.id === replacement.replaceStepId &&
              active.metadata.steps.length === 1
            : active.metadata.draftReplacesStepId === undefined && active.metadata.steps.length === 0)
        );
      },
      30_000,
      `the native R ${replacement ? "replacement" : "new"} clone preview`
    );
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const active = testing.activeSession();
    assert.ok(active?.metadata.draftStep?.kind === "cloneColumn", "The native R clone preview must retain its draft.");
    const stepId = active.metadata.draftStep.id;
    if (replacement) assert.equal(stepId, replacement.replaceStepId);
    assertReleasedRCloneGeneratedCode(active.code ?? "", sourceName, newName, variableName);
    const codePreview = await waitForCodePreview(workbench, undefined, "R");
    assertReleasedRCloneGeneratedCode(
      await revealCodePreviewText(codePreview, newName),
      sourceName,
      newName,
      variableName
    );
    await requireFreshExactSessionPanelHydration(
      testing,
      sessionId,
      "The native R Clone Column preview must be acknowledged by its exact renderer."
    );
    return {
      app: await releasedRSessionApp(workbench, testing, sessionId, "the native R Clone Column preview"),
      stepId
    };
  };
}
