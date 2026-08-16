import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { codePreviewDocumentReceipt } from "./extensionHost/playwrightLifecycle";
import type { TestApi } from "./extensionHost/extensionHostTestApi";
import { createReleasedRCloneState } from "./extensionHost/releasedRCloneState";

function fakeTesting() {
  let revision = 7;
  let runtimeId = "runtime-r";
  const activeSession = vi.fn(() => ({
    sessionId: "session-r",
    metadata: {
      revision,
      draftStep: {
        id: "draft-clone",
        kind: "cloneColumn",
        params: { column: { id: "c:score", name: "score" }, newName: "score_copy" }
      },
      steps: [{ id: "step-drop", kind: "dropColumns", params: { columns: [{ id: "c:old", name: "old" }] } }],
      schema: [
        {
          id: "c:score",
          name: "score",
          position: 0,
          type: "number",
          rawType: "double",
          nullable: true
        }
      ]
    },
    code: "x <- 1",
    stepInspectionActive: true,
    stepInspection: { stepId: "step-drop" }
  }));
  const testing = {
    activeSession,
    diagnostics: () => ({
      activeSessionId: "session-r",
      sessionCount: 1,
      sessions: [
        {
          publicId: "session-r",
          runtimeId,
          publicRevision: revision,
          runtimeRevision: revision,
          sourceLabel: "orders"
        }
      ]
    }),
    sessionSchedulerState: () => ({ sessionId: "session-r", quiescent: true }),
    panelHydrated: () => true,
    panelSynchronizable: () => false,
    panelSynchronizationReceipt: () => ({
      syncId: "sync-r",
      sessionId: "session-r",
      revision,
      layoutTransitionPending: false
    })
  } as unknown as TestApi;
  return {
    activeSession,
    setRevision: (value: number) => {
      revision = value;
    },
    setRuntimeId: (value: string) => {
      runtimeId = value;
    },
    testing
  };
}

const workbench = {} as Page;

describe("released R clone state", () => {
  it("captures the bounded coordinator, session, scheduler, panel, and code state", () => {
    const { testing } = fakeTesting();
    const state = createReleasedRCloneState({
      visibleOpenWranglerPanelAlert: vi.fn(),
      waitFor: vi.fn()
    });

    expect(state.releasedRCloneFailureSnapshot(testing, "session-r")).toEqual({
      requestedSessionId: "session-r",
      activeSessionId: "session-r",
      sessionCount: 1,
      coordinator: {
        publicId: "session-r",
        runtimeId: "runtime-r",
        publicRevision: 7,
        runtimeRevision: 7,
        sourceLabel: "orders"
      },
      active: {
        sessionId: "session-r",
        revision: 7,
        draft: {
          id: "draft-clone",
          kind: "cloneColumn",
          params: { column: { id: "c:score", name: "score" }, newName: "score_copy" }
        },
        steps: [
          {
            id: "step-drop",
            kind: "dropColumns",
            params: { columns: [{ id: "c:old", name: "old" }] }
          }
        ],
        schema: [
          {
            id: "c:score",
            name: "score",
            position: 0,
            type: "number",
            rawType: "double",
            nullable: true
          }
        ],
        codeReceipt: codePreviewDocumentReceipt("x <- 1"),
        stepInspectionActive: true,
        inspectedStepId: "step-drop"
      },
      scheduler: { sessionId: "session-r", quiescent: true },
      panel: {
        hydrated: true,
        synchronizable: false,
        synchronizationReceipt: {
          syncId: "sync-r",
          sessionId: "session-r",
          revision: 7,
          layoutTransitionPending: false
        }
      }
    });
  });

  it("accepts only an exact one-revision advance on the same coordinator runtime", () => {
    const fixture = fakeTesting();
    const state = createReleasedRCloneState({
      visibleOpenWranglerPanelAlert: vi.fn(),
      waitFor: vi.fn()
    });
    const before = state.releasedRCloneFailureSnapshot(fixture.testing, "session-r");

    fixture.setRevision(8);
    const advanced = state.releasedRCloneFailureSnapshot(fixture.testing, "session-r");
    expect(state.releasedRCloneMutationRevisionAdvanced(before, advanced)).toBe(true);

    fixture.setRevision(9);
    expect(
      state.releasedRCloneMutationRevisionAdvanced(
        before,
        state.releasedRCloneFailureSnapshot(fixture.testing, "session-r")
      )
    ).toBe(false);

    fixture.setRevision(8);
    fixture.setRuntimeId("replacement-runtime");
    expect(
      state.releasedRCloneMutationRevisionAdvanced(
        before,
        state.releasedRCloneFailureSnapshot(fixture.testing, "session-r")
      )
    ).toBe(false);
  });

  it("polls the current snapshot under the exact clone timeout and expectation", async () => {
    const fixture = fakeTesting();
    const waitFor = vi.fn(async (predicate: () => boolean, timeoutMs: number, expectation: string) => {
      expect(timeoutMs).toBe(30_000);
      expect(expectation).toBe("applying the clone");
      expect(predicate()).toBe(false);
      fixture.setRevision(8);
      expect(predicate()).toBe(true);
    });
    const state = createReleasedRCloneState({ visibleOpenWranglerPanelAlert: vi.fn(), waitFor });
    const before = state.releasedRCloneFailureSnapshot(fixture.testing, "session-r");

    await state.waitForReleasedRCloneState(
      fixture.testing,
      workbench,
      "session-r",
      before,
      (last) => state.releasedRCloneMutationRevisionAdvanced(before, last),
      "applying the clone"
    );
    expect(waitFor).toHaveBeenCalledOnce();
  });

  it("adds the latest bounded state and visible alert while retaining the poll failure as cause", async () => {
    const fixture = fakeTesting();
    const pollFailure = new Error("poll failed");
    const visibleOpenWranglerPanelAlert = vi.fn(async () => "Clone failed visibly");
    const state = createReleasedRCloneState({
      visibleOpenWranglerPanelAlert,
      waitFor: vi.fn(async () => {
        throw pollFailure;
      })
    });
    const before = state.releasedRCloneFailureSnapshot(fixture.testing, "session-r");

    const failure = await state
      .waitForReleasedRCloneState(fixture.testing, workbench, "session-r", before, () => false, "undoing the clone")
      .catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.cause).toBe(pollFailure);
    expect(String(failure)).toContain("undoing the clone");
    expect(String(failure)).toContain('"visibleAlert":"Clone failed visibly"');
    expect(visibleOpenWranglerPanelAlert).toHaveBeenCalledExactlyOnceWith(workbench);
  });
});
