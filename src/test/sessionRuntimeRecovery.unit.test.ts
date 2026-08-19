import { describe, expect, it, vi } from "vitest";
import type { OpenWranglerRequest, PageResponse, SessionMetadata } from "../shared/protocol";
import { DetachedBridgeRequestError, type OpenWranglerBridge } from "../extension/dataBridge";
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
      columnWidths: new Map([["c:value", 240]]),
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
      viewState: { columnWidths: new Map(), viewport: { firstVisibleRow: 0, scrollLeft: 19 } }
    });
    expect(requests).toContainEqual({ kind: "closeSession", sessionId: "runtime-old", revision: 0 });
    expect(recoveryHooks.clearPublishedStepInspection).toHaveBeenCalledOnce();
    expect(recoveryHooks.publishActive).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "R document",
      source: {
        kind: "documentVariable" as const,
        label: "orders",
        variableName: "orders",
        uri: "file:///workspace/orders.R"
      }
    },
    {
      label: "interactive R",
      source: { kind: "rInteractiveVariable" as const, label: "orders", variableName: "orders" }
    }
  ])("replays an ordinary $label session on its existing delegate", async ({ source }) => {
    const requests: OpenWranglerRequest[] = [];
    const opened = openedResponse("runtime-new", "r");
    opened.metadata = { ...opened.metadata, source };
    const delegate = bridge(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") return opened;
      if (request.kind === "getPage") return pageResponseForMetadata(request, opened.metadata);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected ordinary R recovery request: ${request.kind}`);
    });
    const session = runtimeSession(delegate, "r");
    session.openRequest = { ...session.openRequest, source };
    session.metadata = { ...session.metadata, source };
    const cleanup = new SessionRuntimeCleanup((candidate) => candidate === session.delegate);
    const recovery = new SessionRuntimeRecovery(cleanup, new SessionRuntimeStateRestorer());

    await expect(recovery.replay(session, undefined, hooks(), true, session.metadata.schema)).resolves.toBe(true);
    await cleanup.waitForTracked();

    expect(session.delegate).toBe(delegate);
    expect(session).toMatchObject({ runtimeId: "runtime-new", metadata: { source } });
    expect(requests.filter((request) => request.kind === "openSession")).toHaveLength(1);
    expect(requests).toContainEqual({ kind: "closeSession", sessionId: "runtime-old", revision: 0 });
  });

  it("publishes one fresh verified R delegate before a late invalidated-delegate cleanup", async () => {
    const oldRequests: OpenWranglerRequest[] = [];
    const candidateRequests: OpenWranglerRequest[] = [];
    let resolveOldClose!: () => void;
    const oldCloseCanFinish = new Promise<void>((resolve) => {
      resolveOldClose = resolve;
    });
    const oldIdle = vi.fn();
    const oldDelegate = bridge(async (request) => {
      oldRequests.push(request);
      if (request.kind === "closeSession") {
        await oldCloseCanFinish;
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error("The verified R notebook kernel changed before Open Wrangler opened the dataframe.");
    });
    oldDelegate.onIdle = oldIdle;
    const candidateDelegate = bridge(async (request) => {
      candidateRequests.push(request);
      if (request.kind === "openSession") {
        expect(request.requestedSessionId).toBeUndefined();
        return openedResponse("runtime-candidate", "r");
      }
      if (request.kind === "getPage") {
        return pageResponseForMetadata(request, openedResponse(request.sessionId, "r").metadata);
      }
      if (request.kind === "closeSession") {
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const disposeCandidate = vi.fn(async () => undefined);
    const createRuntimeRecoveryDelegate = vi.fn(async () => ({
      delegate: candidateDelegate,
      dispose: disposeCandidate
    }));
    Object.assign(oldDelegate, {
      supportsVerifiedRuntimeRecoveryDelegate: true,
      createRuntimeRecoveryDelegate
    });
    const session = runtimeSession(oldDelegate, "r");
    const publicState = {
      publicId: session.publicId,
      publicRevision: session.publicRevision,
      metadata: session.metadata,
      code: session.code,
      viewState: session.viewState
    };
    const cleanup = new SessionRuntimeCleanup((delegate) => session.delegate === delegate);
    const recovery = new SessionRuntimeRecovery(cleanup, new SessionRuntimeStateRestorer());

    await expect(recovery.replay(session, undefined, hooks(), true, session.metadata.schema)).resolves.toBe(true);
    expect(session).toMatchObject({
      publicId: publicState.publicId,
      publicRevision: publicState.publicRevision,
      runtimeId: "runtime-candidate",
      runtimeRevision: 0,
      metadata: { sessionId: "runtime-candidate", schema: publicState.metadata.schema },
      code: publicState.code,
      viewState: publicState.viewState
    });
    expect(session.delegate).toBe(candidateDelegate);

    const nextPageRequest: Extract<OpenWranglerRequest, { kind: "getPage" }> = {
      kind: "getPage",
      sessionId: session.runtimeId,
      revision: session.runtimeRevision,
      viewRequestId: "after-recovery",
      offset: 0,
      limit: 1,
      columnOffset: 0,
      columnLimit: 1,
      filterModel: session.metadata.filterModel
    };
    await expect(session.delegate.request(nextPageRequest)).resolves.toMatchObject({
      kind: "page",
      viewRequestId: "after-recovery",
      metadata: { sessionId: "runtime-candidate" }
    });

    resolveOldClose();
    await cleanup.waitForTracked();
    expect(createRuntimeRecoveryDelegate).toHaveBeenCalledOnce();
    expect(candidateRequests.filter((request) => request.kind === "openSession")).toHaveLength(1);
    expect(
      oldRequests.filter((request) => request.kind === "closeSession" && request.sessionId === "runtime-old")
    ).toEqual([{ kind: "closeSession", sessionId: "runtime-old", revision: 0 }]);
    expect(candidateRequests.some((request) => request.kind === "closeSession")).toBe(false);
    expect(oldIdle).toHaveBeenCalledOnce();
    expect(disposeCandidate).not.toHaveBeenCalled();
  });

  it("returns from a detached R candidate open and defers its disposal behind the exact settlement barrier", async () => {
    const candidateSettlement = deferred<void>();
    const candidateDelegate = bridge(async (request) => {
      if (request.kind === "openSession") {
        throw new DetachedBridgeRequestError(
          "The replacement R kernel open exceeded its host deadline.",
          "timeout",
          true,
          candidateSettlement.promise
        );
      }
      throw new Error(`Unexpected recovery candidate request: ${request.kind}`);
    });
    const disposeCandidate = vi.fn(async () => undefined);
    const oldDelegate = bridge(async (request) => {
      throw new Error(`Unexpected old-runtime request: ${request.kind}`);
    });
    Object.assign(oldDelegate, {
      supportsVerifiedRuntimeRecoveryDelegate: true,
      createRuntimeRecoveryDelegate: vi.fn(async () => ({
        delegate: candidateDelegate,
        dispose: disposeCandidate
      }))
    });
    const session = runtimeSession(oldDelegate, "r");
    const cleanup = new SessionRuntimeCleanup((delegate) => session.delegate === delegate);
    const recoveryHooks = hooks();
    const recovery = new SessionRuntimeRecovery(cleanup, new SessionRuntimeStateRestorer());

    await expect(recovery.replay(session, undefined, recoveryHooks, true, session.metadata.schema)).resolves.toBe(
      false
    );

    expect(session.delegate).toBe(oldDelegate);
    expect(disposeCandidate).not.toHaveBeenCalled();
    expect(recoveryHooks.installRuntimeSettlement).toHaveBeenCalledOnce();
    const installedBarrier = recoveryHooks.installRuntimeSettlement.mock.calls[0]?.[0];
    expect(installedBarrier).toBeInstanceOf(Promise);

    candidateSettlement.resolve();
    await installedBarrier;
    await cleanup.waitForTracked();
    expect(disposeCandidate).toHaveBeenCalledOnce();
  });

  it("rejects an aliased R recovery delegate without disposing the published delegate", async () => {
    const requests: OpenWranglerRequest[] = [];
    const oldDelegate = bridge(async (request) => {
      requests.push(request);
      if (request.kind === "getPage") {
        return pageResponseForMetadata(request, openedResponse(request.sessionId, "r").metadata);
      }
      throw new Error(`Unexpected aliased-delegate request: ${request.kind}`);
    });
    const disposeAliasedDelegate = vi.fn(async () => undefined);
    const createRuntimeRecoveryDelegate = vi.fn(async () => ({
      delegate: oldDelegate,
      dispose: disposeAliasedDelegate
    }));
    Object.assign(oldDelegate, {
      supportsVerifiedRuntimeRecoveryDelegate: true,
      createRuntimeRecoveryDelegate
    });
    const session = runtimeSession(oldDelegate, "r");
    const previous = {
      runtimeId: session.runtimeId,
      runtimeRevision: session.runtimeRevision,
      delegate: session.delegate,
      metadata: session.metadata,
      code: session.code,
      viewState: session.viewState
    };
    const recoveryHooks = hooks();
    const cleanup = new SessionRuntimeCleanup((delegate) => session.delegate === delegate);
    const recovery = new SessionRuntimeRecovery(cleanup, new SessionRuntimeStateRestorer());

    await expect(recovery.replay(session, undefined, recoveryHooks, true, session.metadata.schema)).resolves.toBe(
      false
    );

    expect(session).toMatchObject(previous);
    expect(createRuntimeRecoveryDelegate).toHaveBeenCalledOnce();
    expect(disposeAliasedDelegate).not.toHaveBeenCalled();
    expect(recoveryHooks.publishActive).not.toHaveBeenCalled();
    expect(requests).toEqual([]);

    const nextPageRequest: Extract<OpenWranglerRequest, { kind: "getPage" }> = {
      kind: "getPage",
      sessionId: session.runtimeId,
      revision: session.runtimeRevision,
      viewRequestId: "after-aliased-recovery",
      offset: 0,
      limit: 1,
      columnOffset: 0,
      columnLimit: 1,
      filterModel: session.metadata.filterModel
    };
    await expect(session.delegate.request(nextPageRequest)).resolves.toMatchObject({
      kind: "page",
      viewRequestId: "after-aliased-recovery"
    });
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
      if (request.kind === "getPage") return pageResponseForMetadata(request, candidate.metadata);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const session = runtimeSession(delegate, "pyspark");
    const cleanup = new SessionRuntimeCleanup(() => true);
    const recovery = new SessionRuntimeRecovery(cleanup, new SessionRuntimeStateRestorer());
    const recoveryHooks = hooks();
    const previous = {
      runtimeId: session.runtimeId,
      runtimeRevision: session.runtimeRevision,
      metadata: session.metadata,
      code: session.code,
      viewState: session.viewState
    };

    await expect(recovery.replay(session, undefined, recoveryHooks, true, session.metadata.schema)).resolves.toBe(
      false
    );

    expect(session).toMatchObject(previous);
    expect(
      requests.filter((request) => request.kind === "closeSession" && request.sessionId === "runtime-new")
    ).toEqual([{ kind: "closeSession", sessionId: "runtime-new", revision: 0 }]);
    expect(requests.some((request) => request.kind === "closeSession" && request.sessionId === "runtime-old")).toBe(
      false
    );
    expect(recoveryHooks.publishActive).not.toHaveBeenCalled();
  });

  it("validates the required transformed schema after replaying the recovery candidate", async () => {
    const oldRequests: OpenWranglerRequest[] = [];
    const candidateRequests: OpenWranglerRequest[] = [];
    const candidate = openedResponse("runtime-new", "r");
    const oldDelegate = bridge(async (request) => {
      oldRequests.push(request);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected old-runtime request: ${request.kind}`);
    });
    const candidateDelegate = bridge(async (request) => {
      candidateRequests.push(request);
      if (request.kind === "openSession") return candidate;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected candidate request: ${request.kind}`);
    });
    Object.assign(oldDelegate, {
      supportsVerifiedRuntimeRecoveryDelegate: true,
      createRuntimeRecoveryDelegate: vi.fn(async () => ({
        delegate: candidateDelegate,
        dispose: vi.fn(async () => undefined)
      }))
    });
    const session = runtimeSession(oldDelegate, "r");
    const requiredSchema = [
      { id: "c:replayed", name: "replayed", position: 0, rawType: "integer", type: "integer", nullable: false }
    ] satisfies SessionMetadata["schema"];
    session.metadata = { ...session.metadata, schema: requiredSchema };
    const restoredPage: PageResponse = {
      kind: "page",
      revision: 0,
      viewRequestId: "recovered-view",
      metadata: { ...candidate.metadata, schema: requiredSchema },
      page: {
        offset: 0,
        limit: 1,
        totalRows: 0,
        columnIds: ["c:replayed"],
        rows: []
      }
    };
    const restoreRuntimeState = vi.fn<SessionRuntimeStateRestorer["restoreRuntimeState"]>(async (candidateState) => {
      candidateState.metadata = restoredPage.metadata;
      return restoredPage;
    });
    const cleanup = new SessionRuntimeCleanup(() => true);
    const recoveryHooks = hooks();
    const recovery = new SessionRuntimeRecovery(cleanup, {
      restoreRuntimeState
    } as unknown as SessionRuntimeStateRestorer);

    await expect(recovery.replay(session, undefined, recoveryHooks, true, requiredSchema)).resolves.toBe(true);
    await cleanup.waitForTracked();

    expect(candidate.metadata.schema).not.toEqual(requiredSchema);
    expect(restoreRuntimeState).toHaveBeenCalledOnce();
    expect(session).toMatchObject({
      publicId: "public-session",
      runtimeId: "runtime-new",
      metadata: { sessionId: "runtime-new", schema: requiredSchema }
    });
    expect(session.delegate).toBe(candidateDelegate);
    expect(recoveryHooks.publishActive).toHaveBeenCalledOnce();
    expect(
      oldRequests.filter((request) => request.kind === "closeSession" && request.sessionId === "runtime-old")
    ).toEqual([{ kind: "closeSession", sessionId: "runtime-old", revision: 0 }]);
    expect(candidateRequests.some((request) => request.kind === "closeSession")).toBe(false);
  });

  it.each(["origin", "currentness", "replay", "schema", "cleanup"] as const)(
    "keeps the old R delegate and disposes one unpublished %s-failed candidate",
    async (failure) => {
      const oldRequests: OpenWranglerRequest[] = [];
      const candidateRequests: OpenWranglerRequest[] = [];
      const oldDelegate = bridge(async (request) => {
        oldRequests.push(request);
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        throw new Error(`Unexpected old-runtime request: ${request.kind}`);
      });
      const candidateOpened = openedResponse("runtime-candidate", "r");
      const candidateDelegate = bridge(async (request) => {
        candidateRequests.push(request);
        if (request.kind === "openSession") return candidateOpened;
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        throw new Error(`Unexpected candidate request: ${request.kind}`);
      });
      const candidateDiagnostic = vi.fn();
      candidateDelegate.reportDiagnostic = candidateDiagnostic;
      const disposeCandidate = vi.fn(async () => {
        if (failure === "cleanup") throw new Error("Candidate disposal failed.");
      });
      const createRuntimeRecoveryDelegate = vi.fn(async () => ({
        delegate: candidateDelegate,
        dispose: disposeCandidate
      }));
      Object.assign(oldDelegate, {
        supportsVerifiedRuntimeRecoveryDelegate: true,
        createRuntimeRecoveryDelegate
      });
      const session = runtimeSession(oldDelegate, "r");
      const previous = {
        runtimeId: session.runtimeId,
        runtimeRevision: session.runtimeRevision,
        delegate: session.delegate,
        metadata: session.metadata,
        code: session.code,
        viewState: session.viewState
      };
      let originChecks = 0;
      const recoveryHooks: RuntimeRecoveryHooks = hooks();
      recoveryHooks.originMismatch = vi.fn(() => {
        originChecks += 1;
        return failure === "origin" && originChecks > 2 ? "The source changed." : undefined;
      });
      const restoreRuntimeState = vi.fn<SessionRuntimeStateRestorer["restoreRuntimeState"]>(async (candidateState) => {
        if (failure === "replay" || failure === "cleanup") throw new Error("Replay failed.");
        if (failure === "schema") {
          candidateState.metadata = {
            ...candidateState.metadata,
            schema: [
              {
                id: "c:changed",
                name: "changed",
                position: 0,
                rawType: "string",
                type: "string",
                nullable: true
              }
            ]
          };
        }
        return {
          kind: "page",
          revision: candidateState.runtimeRevision,
          viewRequestId: "candidate-page",
          metadata: candidateState.metadata,
          page: { offset: 0, limit: 1, totalRows: 0, columnIds: [], rows: [] }
        };
      });
      const cleanup = new SessionRuntimeCleanup((delegate) => session.delegate === delegate);
      const recovery = new SessionRuntimeRecovery(cleanup, {
        restoreRuntimeState
      } as unknown as SessionRuntimeStateRestorer);
      let currentChecks = 0;
      const isStillCurrent = (): boolean => {
        currentChecks += 1;
        return failure !== "currentness" || currentChecks <= 2;
      };

      await expect(
        recovery.replay(session, undefined, recoveryHooks, true, session.metadata.schema, isStillCurrent)
      ).resolves.toBe(false);

      expect(session).toMatchObject(previous);
      expect(createRuntimeRecoveryDelegate).toHaveBeenCalledOnce();
      expect(
        candidateRequests.filter(
          (request) => request.kind === "closeSession" && request.sessionId === "runtime-candidate"
        )
      ).toEqual([{ kind: "closeSession", sessionId: "runtime-candidate", revision: 0 }]);
      expect(disposeCandidate).toHaveBeenCalledOnce();
      if (failure === "cleanup") {
        expect(candidateDiagnostic).toHaveBeenCalledWith(
          "Open Wrangler could not finish cleanup of an unpublished recovery delegate: Candidate disposal failed."
        );
      } else {
        expect(candidateDiagnostic).not.toHaveBeenCalled();
      }
      expect(oldRequests).toEqual([]);
      expect(recoveryHooks.publishActive).not.toHaveBeenCalled();
    }
  );

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
  const installRuntimeSettlement = vi.fn((_settlement: Promise<void>) => undefined);
  const replayAfterRuntimeLoss = vi.fn<RuntimeRecoveryHooks["replayAfterRuntimeLoss"]>(async () => false);
  return {
    isCurrent: () => true,
    originMismatch: () => undefined,
    clearPublishedStepInspection,
    publishActive,
    installRuntimeSettlement,
    replayAfterRuntimeLoss
  } satisfies RuntimeRecoveryHooks;
}

function bridge(request: OpenWranglerBridge["request"]): OpenWranglerBridge {
  return { request };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete as (value?: T) => void;
  });
  return { promise, resolve };
}
