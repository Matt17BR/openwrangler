import * as assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { assertReleasedRCloneGeneratedCode } from "./releasedRGeneratedCode";
import type { createReleasedRCloneState } from "./releasedRCloneState";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRCloneState = ReturnType<typeof createReleasedRCloneState>;

interface ReleasedRCloneEditingDependencies {
  readonly arrangePackagedProductSidebar: (workbench: Page, scene: "inspection") => Promise<Locator>;
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
  readonly waitForReleasedRCloneState: ReleasedRCloneState["waitForReleasedRCloneState"];
}

export function createReleasedRCloneEditingJourney({
  arrangePackagedProductSidebar,
  previewReleasedRClone,
  recordAcceptanceProgress,
  releasedRCloneFailureSnapshot,
  releasedRCloneMutationRevisionAdvanced,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  waitFor,
  waitForReleasedRCloneState
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
    await requireFreshExactSessionPanelHydration(
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
