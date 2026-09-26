import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import type { DataBackend, RLibrary } from "../../shared/protocol";
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
  waitForReleasedRCloneState
}: ReleasedRCloneEditingDependencies) {
  async function switchFileEngine(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    from: string,
    to: string,
    backend: DataBackend
  ): Promise<void> {
    const before = testing.activeSession();
    assert.equal(before?.sessionId, sessionId);
    const app = await releasedRSessionApp(workbench, testing, sessionId, `the file session before choosing ${to}`);
    await app.getByRole("button", { name: `Change dataframe engine. Current engine: ${from}`, exact: true }).click();
    const picker = workbench.locator(".quick-input-widget:visible").filter({ hasText: "Dataframe engine" }).last();
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    const option = picker
      .locator(".quick-input-list [role='option'] .label-name:visible")
      .filter({ hasText: new RegExp(`^${to}$`, "u") });
    assert.equal(await option.count(), 1, `The engine picker must offer ${to} once.`);
    await option.first().click();
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === sessionId &&
          active.metadata.backend === backend &&
          active.metadata.revision > before!.metadata.revision
        );
      },
      30_000,
      `switching the file tab from ${from} to ${to} without a dialog`
    );
    assert.deepEqual(
      testing.activeSession()?.metadata.schema.map((column) => column.name),
      ["city", "count"]
    );
  }

  async function exerciseFileEngineSwitch(testing: TestApi, workbench: Page): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "ow-file-engine-switch-"));
    const csv = vscode.Uri.file(join(directory, "engines.csv"));
    writeFileSync(csv.fsPath, "city,count\nParis,3\nRome,5\n");
    const configuration = vscode.workspace.getConfiguration("openWrangler", csv);
    const originalBackend = configuration.inspect<string>("defaultBackend")?.workspaceValue;
    const originalRscriptPath = configuration.inspect<string>("rscriptPath")?.workspaceValue;
    let fileSessionId: string | undefined;
    try {
      await configuration.update(
        "rscriptPath",
        process.env.OPEN_WRANGLER_TEST_RSCRIPT,
        vscode.ConfigurationTarget.Workspace
      );
      await configuration.update("defaultBackend", "polars", vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand("openWrangler.openFile", csv);
      await waitFor(
        () => testing.activeSession()?.metadata.source.uri === csv.toString(),
        30_000,
        "the Polars file session to open"
      );
      const opened = testing.activeSession();
      assert.ok(opened);
      assert.equal(opened.metadata.backend, "polars");
      fileSessionId = opened.sessionId;
      const sessions = testing.diagnostics().sessionCount;
      await switchFileEngine(testing, workbench, fileSessionId, "Python · Polars", "R · base", "r");
      await switchFileEngine(testing, workbench, fileSessionId, "R · base", "Python · Polars", "polars");
      assert.equal(testing.diagnostics().sessionCount, sessions, "Engine switches must stay in the same tab.");
    } finally {
      if (fileSessionId) await disposePackagedSessionPanel(testing, fileSessionId, "the engine-switch file session");
      await configuration.update("defaultBackend", originalBackend, vscode.ConfigurationTarget.Workspace);
      await configuration.update("rscriptPath", originalRscriptPath, vscode.ConfigurationTarget.Workspace);
      rmSync(directory, { recursive: true, force: true });
    }
  }

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
      recordAcceptanceProgress(`${phase}:editing:library-switch:start`);
      const originalMetadata = structuredClone(reappliedClone.metadata);
      const switchLibrary = async (from: RLibrary, to: RLibrary, index: number) => {
        const before = releasedRCloneFailureSnapshot(testing, sessionId);
        app = await releasedRSessionApp(workbench, testing, sessionId, `the R source before choosing R · ${to}`);
        await app
          .getByRole("button", { name: `Change dataframe engine. Current engine: R · ${from}`, exact: true })
          .click();
        const picker = workbench.locator(".quick-input-widget:visible").filter({ hasText: "Dataframe engine" }).last();
        await picker.waitFor({ state: "visible", timeout: 10_000 });
        const choices = picker.getByRole("option");
        await choices.nth(3).waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(await choices.count(), 4);
        const labels = await Promise.all(
          [0, 1, 2, 3].map((choice) => choices.nth(choice).locator(".label-name:visible").first().innerText())
        );
        assert.deepEqual(labels, ["R · base", "R · dplyr", "R · data.table", "R · collapse"]);
        await choices.nth(index).click();
        await waitForReleasedRCloneState(
          testing,
          workbench,
          sessionId,
          before,
          (last) => last.active?.sessionId === sessionId && last.active.rLibrary === to,
          `switching this tab to R · ${to} without a dialog`,
          10_000
        );
        const switched = testing.activeSession();
        assert.ok(switched);
        assert.equal(switched.metadata.backend, "r");
        assert.equal(switched.metadata.mode, "editing");
        assert.deepEqual(switched.metadata.source, originalMetadata.source);
        assert.deepEqual(switched.metadata.schema, originalMetadata.schema);
        assert.deepEqual(switched.metadata.steps, originalMetadata.steps);
        assert.ok(switched.code?.includes(`.ow_library <- "${to}"`), `The generated plan must select ${to}.`);
        await app
          .getByRole("button", { name: `Change dataframe engine. Current engine: R · ${to}`, exact: true })
          .waitFor({ state: "visible", timeout: 10_000 });
        return switched;
      };
      const dplyr = await switchLibrary("base", "dplyr", 1);
      assert.ok(dplyr.code?.includes("dplyr::"), "The switched plan must provide generated package code.");
      await switchLibrary("dplyr", "base", 0);
      recordAcceptanceProgress(`${phase}:editing:library-switch:complete`);
      recordAcceptanceProgress(`${phase}:editing:file-engine-switch:start`);
      await exerciseFileEngineSwitch(testing, workbench);
      await waitFor(
        () => testing.activeSession()?.sessionId === sessionId,
        10_000,
        "the live R editor after the file session closes"
      );
      recordAcceptanceProgress(`${phase}:editing:file-engine-switch:complete`);
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
