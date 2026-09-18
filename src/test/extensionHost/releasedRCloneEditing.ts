import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { assertReleasedRCloneGeneratedCode } from "./releasedRGeneratedCode";
import type { createReleasedRCloneState } from "./releasedRCloneState";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRCloneState = ReturnType<typeof createReleasedRCloneState>;

interface ReleasedRCloneEditingDependencies {
  readonly arrangePackagedProductSidebar: (workbench: Page, scene: "inspection") => Promise<Locator>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly previewReleasedRClone: (
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    sourceName: string,
    newName: string,
    replacement?: Readonly<{ replaceStepId: string; previousName: string }>,
    variableName?: string
  ) => Promise<Readonly<{ app: Locator; stepId: string }>>;
  readonly recordAcceptanceProgress: (stage: string) => void;
  readonly releasedRCloneFailureSnapshot: ReleasedRCloneState["releasedRCloneFailureSnapshot"];
  readonly releasedRCloneMutationRevisionAdvanced: ReleasedRCloneState["releasedRCloneMutationRevisionAdvanced"];
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<Locator>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForReleasedRCloneState: ReleasedRCloneState["waitForReleasedRCloneState"];
  readonly waitForVisibleEditorDialog: (workbench: Page, text: string) => Promise<{ page: Page; dialog: Locator }>;
}

export function createReleasedRCloneEditingJourney({
  arrangePackagedProductSidebar,
  disposePackagedSessionPanel,
  previewReleasedRClone,
  recordAcceptanceProgress,
  releasedRCloneFailureSnapshot,
  releasedRCloneMutationRevisionAdvanced,
  releasedRSessionApp,
  waitFor,
  waitForReleasedRCloneState,
  waitForVisibleEditorDialog
}: ReleasedRCloneEditingDependencies) {
  return async function exerciseReleasedRCloneEditingLifecycle(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    phase: "jupyter-r" | "jupyter-r-remote"
  ): Promise<void> {
    const base = testing.activeSession();
    assert.equal(base?.sessionId, sessionId, "The native R Clone Column lifecycle must retain its exact session.");
    assert.ok(base, "The native R Clone Column lifecycle requires one active session.");
    assert.equal(base.metadata.draftStep, undefined);
    assert.deepEqual(base.metadata.steps, []);
    assert.deepEqual(
      base.metadata.schema.slice(0, 4).map((column) => column.name),
      ["row_id", "group", "score", "label"]
    );
    assert.equal(base.code ?? "", "");

    recordAcceptanceProgress(`${phase}:editing:clone-preview-apply-inspect-edit-undo`);
    let app = await releasedRSessionApp(
      workbench,
      testing,
      sessionId,
      "the restored R session before applying Clone Column"
    );
    const cloned = await previewReleasedRClone(testing, workbench, app, sessionId, "score", "score_copy");
    app = cloned.app;
    const firstApplyBefore = releasedRCloneFailureSnapshot(testing, sessionId);
    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitForReleasedRCloneState(
      testing,
      workbench,
      sessionId,
      firstApplyBefore,
      (last) => {
        const active = testing.activeSession();
        const step = active?.metadata.steps[0];
        const sourceColumn = active?.metadata.schema.find((column) => column.name === "score");
        const clone = active?.metadata.schema.at(-1);
        return (
          releasedRCloneMutationRevisionAdvanced(firstApplyBefore, last) &&
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          step?.kind === "cloneColumn" &&
          step.id === cloned.stepId &&
          step.params.column.name === "score" &&
          step.params.newName === "score_copy" &&
          clone?.id === `c:step:${cloned.stepId}:0` &&
          clone.name === "score_copy" &&
          clone.type === sourceColumn?.type &&
          clone.rawType === sourceColumn.rawType &&
          clone.nullable === sourceColumn.nullable
        );
      },
      "applying the native R Clone Column step"
    );
    await releasedRSessionApp(
      workbench,
      testing,
      sessionId,
      "The applied R Clone Column step must be acknowledged before inspection."
    );
    const firstClone = testing.activeSession();
    assert.ok(firstClone, "The applied native R clone must retain its session.");
    assertReleasedRCloneGeneratedCode(firstClone.code ?? "", "score", "score_copy");
    const sidebar = await arrangePackagedProductSidebar(workbench, "inspection");
    const cleaningSteps = sidebar.getByRole("tree", { name: /Cleaning Steps/u }).first();
    const appliedClone = cleaningSteps.getByRole("treeitem", { name: /^1\. Clone column/u }).first();
    await appliedClone.waitFor({ state: "visible", timeout: 10_000 });
    const inspectionBefore = releasedRCloneFailureSnapshot(testing, sessionId);
    await appliedClone.click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return active?.stepInspectionActive || active?.stepInspection?.stepId === cloned.stepId;
      },
      10_000,
      "dispatching the applied native R Clone Column inspection",
      () => JSON.stringify({ before: inspectionBefore, last: releasedRCloneFailureSnapshot(testing, sessionId) })
    );
    await waitForReleasedRCloneState(
      testing,
      workbench,
      sessionId,
      inspectionBefore,
      () => testing.activeSession()?.stepInspection?.stepId === cloned.stepId,
      "the applied native R Clone Column inspection"
    );
    const cloneInspection = testing.activeSession()?.stepInspection;
    assert.ok(cloneInspection, "Selecting the applied R Clone Column step must publish its inspection.");
    assert.deepEqual(cloneInspection.diff, {
      addedRows: 0,
      removedRows: 0,
      addedColumns: ["score_copy"],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    });
    assert.equal(
      cloneInspection.inputSchema.some((column) => column.name === "score_copy"),
      false
    );
    const inspectedClone = cloneInspection.outputSchema.at(-1);
    assert.ok(inspectedClone, "The R Clone Column inspection must include its derived output.");
    assert.equal(inspectedClone.id, `c:step:${cloned.stepId}:0`);
    assert.equal(inspectedClone.name, "score_copy");
    assertReleasedRCloneGeneratedCode(cloneInspection.code, "score", "score_copy");
    app = await releasedRSessionApp(workbench, testing, sessionId, "the inspected R Clone Column session");
    await app
      .getByRole("region", { name: "Selected applied-step inspection" })
      .getByRole("button", { name: "Show confirmed data", exact: true })
      .click();
    await waitFor(
      () => testing.activeSession()?.stepInspection === undefined,
      10_000,
      "returning from the native R Clone Column inspection"
    );

    app = await releasedRSessionApp(workbench, testing, sessionId, "the confirmed R Clone Column session");
    const editedClone = await previewReleasedRClone(testing, workbench, app, sessionId, "score", "score_duplicate", {
      replaceStepId: cloned.stepId,
      previousName: "score_copy"
    });
    assert.equal(editedClone.stepId, cloned.stepId);
    app = editedClone.app;
    const editedApplyBefore = releasedRCloneFailureSnapshot(testing, sessionId);
    await app
      .getByRole("region", { name: "Draft review" })
      .getByRole("button", { name: "Apply step", exact: true })
      .click();
    await waitForReleasedRCloneState(
      testing,
      workbench,
      sessionId,
      editedApplyBefore,
      (last) => {
        const active = testing.activeSession();
        const step = active?.metadata.steps[0];
        const clone = active?.metadata.schema.at(-1);
        return (
          releasedRCloneMutationRevisionAdvanced(editedApplyBefore, last) &&
          active?.sessionId === sessionId &&
          active.metadata.draftStep === undefined &&
          active.metadata.steps.length === 1 &&
          step?.kind === "cloneColumn" &&
          step.id === cloned.stepId &&
          step.params.newName === "score_duplicate" &&
          clone?.id === `c:step:${cloned.stepId}:0` &&
          clone.name === "score_duplicate"
        );
      },
      "applying the edited native R Clone Column step"
    );
    const reappliedClone = testing.activeSession();
    assert.ok(reappliedClone, "The edited native R clone must retain its session.");
    assertReleasedRCloneGeneratedCode(reappliedClone.code ?? "", "score", "score_duplicate");
    if (phase === "jupyter-r" && process.platform === "linux" && process.env.OPEN_WRANGLER_TEST_EDITOR !== "cursor") {
      recordAcceptanceProgress(`${phase}:editing:library-copy:start`);
      const originalMetadata = structuredClone(reappliedClone.metadata);
      const originalView = structuredClone(reappliedClone.viewState);
      const libraryCopyBefore = releasedRCloneFailureSnapshot(testing, sessionId);
      app = await releasedRSessionApp(workbench, testing, sessionId, "the R source before choosing a cleaning library");
      await app
        .getByRole("button", {
          name: "Change dataframe engine. Current engine: Base R",
          exact: true
        })
        .click();
      const picker = workbench.locator(".quick-input-widget:visible").filter({ hasText: "Dataframe engine" }).last();
      await picker.waitFor({ state: "visible", timeout: 10_000 });
      const choices = picker.getByRole("option");
      await choices.nth(3).waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await choices.count(), 4);
      const labels = await Promise.all(
        [0, 1, 2, 3].map((index) => choices.nth(index).locator(".label-name:visible").first().innerText())
      );
      assert.deepEqual(labels, ["Base R", "R · dplyr", "R · data.table", "R · collapse"]);
      await choices.nth(1).click();
      const confirmation = await waitForVisibleEditorDialog(workbench, "Open an editing copy with dplyr?");
      await confirmation.page.bringToFront();
      await confirmation.dialog.getByRole("button", { name: "Open editing copy", exact: true }).click();
      await waitForReleasedRCloneState(
        testing,
        workbench,
        sessionId,
        libraryCopyBefore,
        (last) => last.active !== null && last.active.sessionId !== sessionId && last.active.rLibrary === "dplyr",
        "opening the confirmed dplyr editing copy",
        10_000
      );
      const copied = testing.activeSession();
      assert.ok(copied);
      assert.equal(copied.metadata.backend, "r");
      assert.equal(copied.metadata.mode, "editing");
      assert.deepEqual(copied.metadata.source, originalMetadata.source);
      assert.deepEqual(copied.metadata.schema, originalMetadata.schema);
      assert.deepEqual(copied.metadata.steps, originalMetadata.steps);
      assert.equal(copied.metadata.draftStep, undefined);
      assert.equal(copied.metadata.canRedo, false);
      assert.ok(copied.code?.includes("dplyr::"), "The copied plan must provide generated package code.");
      assert.ok(copied.code?.includes('.ow_library <- "dplyr"'), "The generated plan must select dplyr.");
      const copyApp = await releasedRSessionApp(workbench, testing, copied.sessionId, "the confirmed dplyr editor");
      await copyApp
        .getByRole("button", {
          name: "Change dataframe engine. Current engine: R · dplyr",
          exact: true
        })
        .waitFor({ state: "visible", timeout: 10_000 });
      assert.deepEqual(testing.sessionSnapshot(sessionId)?.metadata, originalMetadata);
      assert.deepEqual(testing.sessionSnapshot(sessionId)?.viewState, originalView);
      await disposePackagedSessionPanel(testing, copied.sessionId, "the dplyr editing copy");
      await waitFor(
        () => testing.activeSession()?.sessionId === sessionId,
        10_000,
        "the original R editor after its copy closes"
      );
      recordAcceptanceProgress(`${phase}:editing:library-copy:complete`);
    }
    app = await releasedRSessionApp(workbench, testing, sessionId, "the edited R Clone Column session before undo");
    const undoBefore = releasedRCloneFailureSnapshot(testing, sessionId);
    await app.getByRole("button", { name: "Undo", exact: true }).click();
    await waitForReleasedRCloneState(
      testing,
      workbench,
      sessionId,
      undoBefore,
      (last) => {
        const active = testing.activeSession();
        return (
          releasedRCloneMutationRevisionAdvanced(undoBefore, last) &&
          active?.sessionId === sessionId &&
          active.metadata.steps.length === 0 &&
          active.metadata.draftStep === undefined &&
          !active.metadata.schema.some((column) => column.id === `c:step:${cloned.stepId}:0`) &&
          active.metadata.schema
            .slice(0, 4)
            .map((column) => column.name)
            .join("\u0000") === "row_id\u0000group\u0000score\u0000label" &&
          (active.code ?? "") === ""
        );
      },
      "undoing the edited native R Clone Column step"
    );
  };
}
