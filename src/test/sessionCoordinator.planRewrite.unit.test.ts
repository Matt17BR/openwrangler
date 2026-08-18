import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionMetadata, TransformStep } from "../shared/protocol";
import {
  appliedFor,
  initialSource,
  metadataFor,
  open,
  openedFor,
  pageFor,
  previewFor
} from "./sessionReconfigurationTestFixtures";

const first: TransformStep = {
  id: "round-value",
  kind: "roundNumber",
  params: { column: { id: "c:value", name: "value" }, decimals: 1 }
};
const replacement: TransformStep = {
  ...first,
  params: { column: { id: "c:value", name: "value" }, decimals: 2 }
};
const second: TransformStep = {
  id: "floor-value",
  kind: "floorNumber",
  params: { column: { id: "c:value", name: "value" } }
};
const third: TransformStep = {
  id: "clone-value",
  kind: "cloneColumn",
  params: { column: { id: "c:value", name: "value" }, newName: "copy" }
};

describe("SessionCoordinator earlier-step plan rewrites", () => {
  it("publishes one stable-ID replacement only after replaying the unchanged suffix", async () => {
    const harness = rewriteHarness({ draft: replacement });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: opened.metadata.revision + 1,
      metadata: { sessionId: opened.metadata.sessionId, steps: [replacement, second, third] }
    });
    expect(harness.replayedStepIds()).toEqual([first.id, second.id, third.id]);
    expect(harness.replayedSteps()[0]).toEqual(replacement);
    expect(coordinator.activeSession()).toMatchObject({
      sessionId: opened.metadata.sessionId,
      metadata: { steps: [replacement, second, third] },
      code: "# applied clone-value"
    });
    expect(coordinator.activeSession()?.metadata).not.toHaveProperty("draftStep");
    expect(harness.closedRuntimeIds()).toContain("runtime-old");
  });

  it("deletes exactly one stable-ID target and retains every suffix ID", async () => {
    const harness = rewriteHarness();
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      second.id,
      "deleteStep",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      metadata: { steps: [first, third] }
    });
    expect(harness.replayedStepIds()).toEqual([first.id, third.id]);
  });

  it("leaves the confirmed runtime, plan, draft, view, revision, and code unchanged when a suffix rejects", async () => {
    const harness = rewriteHarness({ draft: replacement, rejectStepId: second.id });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);
    const before = coordinator.activeSession();

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({ kind: "error", code: "plan_rewrite_failed", recoverable: true });
    expect(coordinator.activeSession()).toEqual(before);
    expect(harness.closedRuntimeIds()).toEqual([expect.stringMatching(/.+/u)]);
    expect(harness.closedRuntimeIds()).not.toContain("runtime-old");
  });

  it("persists the complete candidate before publishing it once", async () => {
    const harness = rewriteHarness({ draft: replacement });
    let stored: Record<string, unknown> = {};
    const coordinatorRef: { current?: SessionCoordinator } = {};
    let activeStepsDuringPersistence: readonly TransformStep[] | undefined;
    const workspaceState = {
      keys: () => [],
      get: <T>(_key: string, defaultValue?: T): T | undefined =>
        (Object.keys(stored).length > 0 ? stored : defaultValue) as T | undefined,
      update: vi.fn(async (_key: string, value: unknown) => {
        activeStepsDuringPersistence = coordinatorRef.current?.activeSession()?.metadata.steps;
        stored = value as Record<string, unknown>;
      })
    } as unknown as Memento;
    const coordinator = new SessionCoordinator(workspaceState);
    coordinatorRef.current = coordinator;
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({ kind: "planUpdated", metadata: { steps: [replacement, second, third] } });
    expect(activeStepsDuringPersistence).toEqual([first, second, third]);
    const persisted = Object.values(stored)[0] as { cleaning?: { steps?: TransformStep[]; draftStep?: unknown } };
    expect(persisted.cleaning?.steps).toEqual([replacement, second, third]);
    expect(persisted.cleaning?.draftStep).toBeUndefined();
    expect(coordinator.activeSession()?.metadata.steps).toEqual([replacement, second, third]);
  });
});

function rewriteHarness(options: { draft?: TransformStep; rejectStepId?: string } = {}) {
  const requests: OpenWranglerRequest[] = [];
  const closed: string[] = [];
  const replayed: TransformStep[] = [];
  let candidateId = "";
  let candidateSteps: TransformStep[] = [];
  const initialMetadata: SessionMetadata = {
    ...metadataFor({
      runtimeId: "runtime-old",
      source: initialSource,
      revision: 7,
      steps: [first, second, third],
      draftStep: options.draft
    }),
    ...(options.draft ? { draftReplacesStepId: first.id } : {})
  };

  const request = vi.fn(async (message: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
    requests.push(message);
    if (message.kind === "openSession" && !message.requestedSessionId) {
      return openedFor(message, initialMetadata);
    }
    if (message.kind === "openSession") {
      candidateId = message.requestedSessionId ?? "";
      candidateSteps = [];
      return openedFor(message, metadataFor({ runtimeId: candidateId, source: initialSource }));
    }
    if (message.kind === "previewStep" && message.sessionId === candidateId) {
      replayed.push(message.step);
      if (message.step.id === options.rejectStepId) {
        return {
          kind: "error",
          code: "invalid_step",
          message: "The unchanged suffix no longer binds.",
          recoverable: true,
          sessionId: candidateId
        };
      }
      return previewFor(
        message,
        {
          ...metadataFor({
            runtimeId: candidateId,
            source: initialSource,
            revision: message.revision + 1,
            steps: candidateSteps,
            draftStep: message.step
          }),
          latestStepInputSchema: initialMetadata.schema
        },
        `# preview ${message.step.id}`
      );
    }
    if (message.kind === "applyDraft" && message.sessionId === candidateId) {
      const step = replayed.at(-1);
      if (!step) throw new Error("Apply arrived without a replayed preview.");
      candidateSteps = [...candidateSteps, step];
      return appliedFor(
        message,
        metadataFor({
          runtimeId: candidateId,
          source: initialSource,
          revision: message.revision + 1,
          steps: candidateSteps
        }),
        `# applied ${step.id}`
      );
    }
    if (message.kind === "getPage" && message.sessionId === candidateId) {
      return pageFor(
        message,
        metadataFor({
          runtimeId: candidateId,
          source: initialSource,
          revision: message.revision,
          steps: candidateSteps,
          filterModel: message.filterModel
        })
      );
    }
    if (message.kind === "closeSession") {
      closed.push(message.sessionId);
      return { kind: "sessionClosed", sessionId: message.sessionId };
    }
    throw new Error(`Unexpected request: ${message.kind}`);
  });
  return {
    request,
    replayedStepIds: () => replayed.map((step) => step.id),
    replayedSteps: () => replayed,
    closedRuntimeIds: () => closed
  };
}
