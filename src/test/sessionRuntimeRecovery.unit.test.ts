import { describe, expect, it, vi } from "vitest";
import type { OpenWranglerRequest, PageResponse, SessionMetadata } from "../shared/protocol";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type { SessionRequestScheduler } from "../extension/sessionRequestScheduler";
import { SessionRuntimeCleanup } from "../extension/sessionRuntimeCleanup";
import {
  SessionRuntimeRecovery,
  type RuntimeRecoveryHooks,
  type RuntimeRecoverySession
} from "../extension/sessionRuntimeRecovery";
import { SessionRuntimeStateRestorer, initialViewingState } from "../extension/sessionRuntimeStateRestorer";
import { openRequest, openedResponse, pageResponseForMetadata } from "./sessionCoordinatorTestFixtures";

describe("SessionRuntimeRecovery", () => {
  it("replays the pinned runtime contract and retires the replaced runtime", async () => {
    const requests: OpenWranglerRequest[] = [];
    const candidate = openedResponse("runtime-new", "polars");
    const delegate = bridge(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") return candidate;
      if (request.kind === "getPage") return pageResponseForMetadata(request, candidate.metadata);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const session = runtimeSession(delegate);
    session.viewState = {
      ...session.viewState,
      selectedColumnId: undefined,
      columnWidths: { "c:value": 240 },
      viewport: { firstVisibleRow: 7, scrollLeft: 19 }
    };
    const cleanup = new SessionRuntimeCleanup(() => true);
    const recovery = new SessionRuntimeRecovery(cleanup, new SessionRuntimeStateRestorer());
    const recoveryHooks = hooks();

    await expect(recovery.replay(session, undefined, recoveryHooks)).resolves.toBe(true);
    await cleanup.waitForTracked();

    expect(requests[0]).toMatchObject({ kind: "openSession", backend: "polars", mode: "editing" });
    expect(session).toMatchObject({
      runtimeId: "runtime-new",
      runtimeRevision: 0,
      viewState: { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 19 } }
    });
    expect(requests).toContainEqual({ kind: "closeSession", sessionId: "runtime-old", revision: 0 });
    expect(recoveryHooks.clearPublishedStepInspection).toHaveBeenCalledOnce();
    expect(recoveryHooks.publishActive).toHaveBeenCalledOnce();
  });

  it("closes a recovery candidate whose required live schema changed", async () => {
    const requests: OpenWranglerRequest[] = [];
    const candidate = openedResponse("runtime-new", "pyspark");
    candidate.metadata = {
      ...candidate.metadata,
      schema: [{ id: "c:changed", name: "changed", position: 0, rawType: "string", type: "string", nullable: true }]
    };
    const delegate = bridge(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") return candidate;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const session = runtimeSession(delegate, "pyspark");
    const recovery = new SessionRuntimeRecovery(
      new SessionRuntimeCleanup(() => true),
      new SessionRuntimeStateRestorer()
    );

    await expect(recovery.replay(session, undefined, hooks(), true, [])).resolves.toBe(false);

    expect(session.runtimeId).toBe("runtime-old");
    expect(requests).toContainEqual({ kind: "closeSession", sessionId: "runtime-new", revision: 0 });
  });

  it("publishes one manual reconnect after the exact replacement page is restored", async () => {
    const session = runtimeSession(
      bridge(async () => openedResponse()),
      "pyspark"
    );
    session.liveReconnectRequired = true;
    const restored = openedResponse("runtime-new", "pyspark");
    const restoredPage: PageResponse = {
      kind: "page",
      revision: 0,
      viewRequestId: "reconnect",
      metadata: restored.metadata,
      page: restored.page
    };
    const recoveryHooks = hooks();
    recoveryHooks.replayAfterRuntimeLoss.mockImplementation(async (_id, options, schema, publishPage) => {
      expect(options).toMatchObject({ priority: "interactive", requiredKernelSessionId: "runtime-old" });
      expect(schema).toEqual(session.metadata.schema);
      session.runtimeId = "runtime-new";
      session.metadata = restored.metadata;
      publishPage(restoredPage);
      return true;
    });
    const recovery = new SessionRuntimeRecovery(
      new SessionRuntimeCleanup(() => true),
      new SessionRuntimeStateRestorer()
    );

    await expect(recovery.reconnect(session, 0, undefined, recoveryHooks)).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: "public-session", backend: "pyspark" },
      page: restored.page
    });

    expect(session.liveReconnectRequired).toBe(false);
    expect(session.reconnecting).toBe(false);
    expect(session.scheduler.cancelBackground).toHaveBeenCalledOnce();
    expect(session.scheduler.waitForIdle).toHaveBeenCalledOnce();
  });

  it("rejects stale or unnecessary reconnects before replay", async () => {
    const session = runtimeSession(
      bridge(async () => openedResponse()),
      "pyspark"
    );
    const recoveryHooks = hooks();
    const recovery = new SessionRuntimeRecovery(
      new SessionRuntimeCleanup(() => true),
      new SessionRuntimeStateRestorer()
    );

    await expect(recovery.reconnect(session, 1, undefined, recoveryHooks)).resolves.toMatchObject({
      kind: "error",
      code: "pyspark_connect_state_lost"
    });
    await expect(recovery.reconnect(session, 0, undefined, recoveryHooks)).resolves.toMatchObject({
      kind: "error",
      code: "pyspark_connect_reconnect_not_required"
    });
    expect(recoveryHooks.replayAfterRuntimeLoss).not.toHaveBeenCalled();
  });
});

function runtimeSession(
  delegate: OpenWranglerBridge,
  backend: SessionMetadata["backend"] = "polars"
): RuntimeRecoverySession {
  const opened = openedResponse("runtime-old", backend);
  return {
    publicId: "public-session",
    runtimeId: "runtime-old",
    publicRevision: 0,
    runtimeRevision: 0,
    openRequest: { ...openRequest, backend },
    delegate,
    scheduler: {
      cancelBackground: vi.fn(),
      waitForIdle: vi.fn(async () => undefined)
    } as unknown as SessionRequestScheduler,
    metadata: opened.metadata,
    code: "",
    viewState: initialViewingState(opened.metadata),
    closing: false,
    reconfiguring: false,
    reconnecting: false,
    liveReconnectRequired: false
  };
}

function hooks() {
  const clearPublishedStepInspection = vi.fn(() => undefined);
  const publishActive = vi.fn(() => undefined);
  const replayAfterRuntimeLoss = vi.fn<RuntimeRecoveryHooks["replayAfterRuntimeLoss"]>(async () => false);
  return {
    isCurrent: () => true,
    originMismatch: () => undefined,
    clearPublishedStepInspection,
    publishActive,
    replayAfterRuntimeLoss
  } satisfies RuntimeRecoveryHooks;
}

function bridge(request: OpenWranglerBridge["request"]): OpenWranglerBridge {
  return { request };
}
