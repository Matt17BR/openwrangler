import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionMetadata, TransformStep } from "../shared/protocol";
import {
  appliedFor,
  deferred,
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
    expect(harness.candidateOpenRequests()).toEqual([
      expect.objectContaining({
        cloneFrom: { sessionId: "runtime-old", revision: 7 },
        requestedSessionId: expect.any(String)
      })
    ]);
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

  it("rejects a candidate whose backend drifts during suffix replay", async () => {
    const harness = rewriteHarness({ draft: replacement, replayBackend: "pandas" });
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
    expect(harness.closedRuntimeIds()).toHaveLength(1);
  });

  it("keeps a confirmed view change that arrives after the replacement draft", async () => {
    const harness = rewriteHarness({ draft: replacement });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);
    const currentFilter = {
      logic: "and" as const,
      filters: [],
      sort: [{ column: "value", direction: "asc" as const, nulls: "last" as const }]
    };

    const page = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 100,
      columnOffset: 0,
      columnLimit: 16,
      filterModel: currentFilter,
      viewRequestId: "view-after-preview"
    });
    expect(page).toMatchObject({ kind: "page", metadata: { filterModel: currentFilter } });

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({ kind: "planUpdated", metadata: { filterModel: currentFilter } });
    expect(harness.candidatePageRequests()).toEqual([expect.objectContaining({ filterModel: currentFilter })]);
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
        activeStepsDuringPersistence ??= coordinatorRef.current?.activeSession()?.metadata.steps;
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

  it("settles a failed final save before terminal close resolves its runtime target", async () => {
    const harness = rewriteHarness({ draft: replacement });
    let stored: Record<string, unknown> = {};
    let updateCount = 0;
    const finalWriteStarted = deferred<void>();
    const releaseFinalWrite = deferred<void>();
    const workspaceState = {
      keys: () => [],
      get: <T>(_key: string, defaultValue?: T): T | undefined =>
        (Object.keys(stored).length > 0 ? stored : defaultValue) as T | undefined,
      update: vi.fn(async (_key: string, value: unknown) => {
        updateCount += 1;
        if (updateCount === 1) {
          stored = value as Record<string, unknown>;
          return;
        }
        finalWriteStarted.resolve();
        await releaseFinalWrite.promise;
        throw new Error("final persistence unavailable");
      })
    } as unknown as Memento;
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);

    const rewrite = bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );
    await finalWriteStarted.promise;
    const candidateId = harness.candidateOpenRequests()[0]?.requestedSessionId;
    expect(candidateId).toEqual(expect.any(String));

    const close = bridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });
    await Promise.resolve();
    expect(harness.closedRuntimeIds()).toEqual([]);

    releaseFinalWrite.resolve();
    await expect(rewrite).resolves.toMatchObject({ kind: "error", code: "session_closing" });
    await expect(close).resolves.toEqual({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    expect(harness.closedRuntimeIds()).toEqual([candidateId, "runtime-old"]);
    expect(coordinator.activeSession()).toBeUndefined();
  });

  it("does not deadlock close behind an active foreground request and a waiting rewrite", async () => {
    const foregroundPage = deferred<OpenWranglerResponse>();
    const harness = rewriteHarness({ draft: replacement, oldPage: foregroundPage.promise });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);
    const pageRequest = {
      kind: "getPage" as const,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "foreground-before-rewrite",
      offset: 0,
      limit: 100,
      columnOffset: 0,
      columnLimit: 16,
      filterModel: opened.metadata.filterModel
    };

    const page = bridge.request(pageRequest);
    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "getPage", sessionId: "runtime-old" }),
        undefined
      )
    );
    const rewrite = bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );
    const close = bridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });

    foregroundPage.resolve(
      pageFor(
        { ...pageRequest, sessionId: "runtime-old" },
        metadataFor({
          runtimeId: "runtime-old",
          source: initialSource,
          revision: opened.metadata.revision,
          steps: [first, second, third],
          draftStep: replacement
        })
      )
    );

    await expect(page).resolves.toMatchObject({ kind: "page" });
    await expect(close).resolves.toEqual({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    await expect(rewrite).resolves.toMatchObject({ kind: "error", code: "session_closing" });
    expect(harness.candidateOpenRequests()).toEqual([]);
    expect(harness.closedRuntimeIds()).toEqual(["runtime-old"]);
  });
});

function rewriteHarness(
  options: {
    draft?: TransformStep;
    rejectStepId?: string;
    replayBackend?: "pandas" | "polars";
    oldPage?: Promise<OpenWranglerResponse>;
  } = {}
) {
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
    if (message.kind === "getPage" && message.sessionId === "runtime-old") {
      if (options.oldPage) return options.oldPage;
      return pageFor(message, { ...initialMetadata, filterModel: message.filterModel });
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
            backend: options.replayBackend,
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
          backend: options.replayBackend,
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
          backend: options.replayBackend,
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
    closedRuntimeIds: () => closed,
    candidateOpenRequests: () =>
      requests.filter(
        (request): request is Extract<OpenWranglerRequest, { kind: "openSession" }> =>
          request.kind === "openSession" && request.requestedSessionId !== undefined
      ),
    candidatePageRequests: () =>
      requests.filter(
        (request): request is Extract<OpenWranglerRequest, { kind: "getPage" }> =>
          request.kind === "getPage" && request.sessionId === candidateId
      )
  };
}
