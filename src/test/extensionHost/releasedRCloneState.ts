import type { Page } from "playwright-core";
import type { TransformStep } from "../../shared/protocol";
import { codePreviewDocumentReceipt } from "./playwrightLifecycle";
import type { TestApi } from "./extensionHostTestApi";

interface ReleasedRCloneStateDependencies {
  readonly visibleOpenWranglerPanelAlert: (workbench: Page) => Promise<string | undefined>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
}

export function createReleasedRCloneState({ visibleOpenWranglerPanelAlert, waitFor }: ReleasedRCloneStateDependencies) {
  function releasedRCloneFailureSnapshot(testing: TestApi, sessionId: string) {
    const active = testing.activeSession();
    const diagnostics = testing.diagnostics();
    const coordinator = diagnostics.sessions.find((session) => session.publicId === sessionId);
    const operation = (step: TransformStep | undefined) =>
      step === undefined ? null : { id: step.id, kind: step.kind, params: step.params };
    return {
      requestedSessionId: sessionId,
      activeSessionId: diagnostics.activeSessionId ?? null,
      sessionCount: diagnostics.sessionCount,
      coordinator: coordinator ?? null,
      active:
        active === undefined
          ? null
          : {
              sessionId: active.sessionId,
              revision: active.metadata.revision,
              draft: operation(active.metadata.draftStep),
              steps: active.metadata.steps.map((step) => operation(step)),
              schema: active.metadata.schema.map((column) => ({
                id: column.id,
                name: column.name,
                position: column.position,
                type: column.type,
                rawType: column.rawType,
                nullable: column.nullable
              })),
              codeReceipt: codePreviewDocumentReceipt(active.code ?? ""),
              stepInspectionActive: active.stepInspectionActive ?? false,
              inspectedStepId: active.stepInspection?.stepId ?? null
            },
      scheduler: testing.sessionSchedulerState(sessionId) ?? null,
      panel: {
        hydrated: testing.panelHydrated(sessionId),
        synchronizable: testing.panelSynchronizable(sessionId),
        synchronizationReceipt: testing.panelSynchronizationReceipt(sessionId) ?? null
      }
    };
  }

  async function waitForReleasedRCloneState(
    testing: TestApi,
    workbench: Page,
    sessionId: string,
    before: ReturnType<typeof releasedRCloneFailureSnapshot>,
    predicate: (last: ReturnType<typeof releasedRCloneFailureSnapshot>) => boolean,
    expectation: string
  ): Promise<void> {
    let last = releasedRCloneFailureSnapshot(testing, sessionId);
    try {
      await waitFor(
        () => {
          last = releasedRCloneFailureSnapshot(testing, sessionId);
          return predicate(last);
        },
        30_000,
        expectation,
        () => JSON.stringify({ before, last })
      );
    } catch (error) {
      last = releasedRCloneFailureSnapshot(testing, sessionId);
      const visibleAlert = await visibleOpenWranglerPanelAlert(workbench);
      throw new Error(
        `The native R Clone Column lifecycle did not settle while ${expectation}. ${JSON.stringify({
          before,
          last,
          visibleAlert: visibleAlert ?? null
        })}`,
        { cause: error }
      );
    }
  }

  function releasedRCloneMutationRevisionAdvanced(
    before: ReturnType<typeof releasedRCloneFailureSnapshot>,
    last: ReturnType<typeof releasedRCloneFailureSnapshot>
  ): boolean {
    return (
      before.active !== null &&
      before.coordinator !== null &&
      last.active?.revision === before.active.revision + 1 &&
      last.coordinator?.runtimeId === before.coordinator.runtimeId
    );
  }

  return {
    releasedRCloneFailureSnapshot,
    releasedRCloneMutationRevisionAdvanced,
    waitForReleasedRCloneState
  };
}
