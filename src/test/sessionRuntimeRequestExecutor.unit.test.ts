import { describe, expect, it, vi } from "vitest";
import type {
  FilterModel,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionBoundRequest,
  SessionMetadata,
  TransformStep
} from "../shared/protocol";
import { DetachedBridgeRequestError, type OpenWranglerBridge } from "../extension/dataBridge";
import { SessionPersistenceStore } from "../extension/sessionPersistenceStore";
import { SessionResponseCommitter } from "../extension/sessionResponseCommitter";
import {
  SessionRuntimeRequestExecutor,
  type RuntimeRequestHooks,
  type RuntimeRequestSession
} from "../extension/sessionRuntimeRequestExecutor";
import type { SessionRequestScheduler } from "../extension/sessionRequestScheduler";
import { initialViewingState } from "../extension/sessionRuntimeStateRestorer";

const emptyFilter: FilterModel = { filters: [], sort: [] };
const schema: SessionMetadata["schema"] = [
  { id: "c:value", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }
];
const step: TransformStep = {
  id: "round",
  kind: "roundNumber",
  params: { column: { id: "c:value", name: "value" }, decimals: 1 }
};

describe("SessionRuntimeRequestExecutor", () => {
  it("rejects stale queued and reconnect-blocked work before runtime dispatch", async () => {
    const request = statsRequest(0);
    const executor = runtimeExecutor();
    const delegate = bridge(vi.fn());
    const stale = runtimeSession(delegate, { publicRevision: 1 });

    await expect(executor.execute(stale, request, undefined, hooks())).resolves.toMatchObject({
      kind: "error",
      code: "stale_request"
    });

    const reconnect = runtimeSession(delegate, { liveReconnectRequired: true });
    await expect(executor.execute(reconnect, request, undefined, hooks())).resolves.toMatchObject({
      kind: "error",
      code: "pyspark_connect_state_lost"
    });
    expect(delegate.request).not.toHaveBeenCalled();
  });

  it("restores a previously ambiguous mutation before dispatch or fails closed", async () => {
    const request = statsRequest(0);
    const response = datasetStatsResponse();
    const delegate = bridge(vi.fn(async () => response));
    const failedSession = runtimeSession(delegate, { recoveryRequired: true });
    const failedHooks = hooks({ replay: vi.fn(async () => false) });
    const executor = runtimeExecutor();

    await expect(executor.execute(failedSession, request, undefined, failedHooks)).resolves.toMatchObject({
      kind: "error",
      code: "runtime_recovery_failed"
    });
    expect(delegate.request).not.toHaveBeenCalled();

    const recoveredSession = runtimeSession(delegate, { recoveryRequired: true });
    const recoveredHooks = hooks({ replay: vi.fn(async () => true) });
    await expect(executor.execute(recoveredSession, request, undefined, recoveredHooks)).resolves.toMatchObject({
      kind: "datasetStats",
      revision: 0
    });
    expect(recoveredSession.recoveryRequired).toBe(false);
    expect(recoveredHooks.replay).toHaveBeenCalledWith({ priority: "interactive" });
  });

  it("records detached and thrown mutation ambiguity without replaying it", async () => {
    const request = previewRequest();
    const settlement = Promise.resolve();
    const detached = new DetachedBridgeRequestError("host deadline", "timeout", true, settlement);
    const detachedSession = runtimeSession(bridge(vi.fn(async () => Promise.reject(detached))));
    const detachedHooks = hooks();
    const executor = runtimeExecutor();

    await expect(executor.execute(detachedSession, request, undefined, detachedHooks)).rejects.toBe(detached);
    expect(detachedSession.recoveryRequired).toBe(true);
    expect(detachedHooks.installRuntimeSettlement).toHaveBeenCalledWith(settlement);
    expect(detachedHooks.replayAfterRuntimeLoss).not.toHaveBeenCalled();

    const transportError = new Error("connection lost");
    const thrownSession = runtimeSession(bridge(vi.fn(async () => Promise.reject(transportError))));
    const thrownHooks = hooks();
    await expect(executor.execute(thrownSession, request, undefined, thrownHooks)).rejects.toBe(transportError);
    expect(thrownSession.recoveryRequired).toBe(true);
    expect(thrownHooks.replayAfterRuntimeLoss).not.toHaveBeenCalled();
  });

  it("replays and reissues an idempotent read after transport loss", async () => {
    const request = statsRequest(0);
    const calls: OpenWranglerRequest[] = [];
    const session = runtimeSession(
      bridge(
        vi.fn(async (runtimeRequest) => {
          calls.push(runtimeRequest);
          if (calls.length === 1) throw new Error("transport lost");
          return datasetStatsResponse();
        })
      ),
      { activeViewContextId: "view", latestRequestedViewContextId: "view" }
    );
    const replay = vi.fn(async () => {
      replaceRuntime(session);
      return true;
    });
    const requestHooks = hooks({ replayAfterRuntimeLoss: replay });

    await expect(
      runtimeExecutor().execute(session, request, { viewContextId: "view" }, requestHooks)
    ).resolves.toMatchObject({ kind: "datasetStats", revision: 0 });
    expect(calls.map((candidate) => candidate.sessionId)).toEqual(["runtime-session", "runtime-2"]);
    expect(replay).toHaveBeenCalledWith("runtime-session", {
      priority: "interactive",
      viewContextId: "view"
    });
  });

  it("replays an exact current unknown-session response and rejects a miscorrelated one", async () => {
    const request = statsRequest(0);
    let calls = 0;
    const session = runtimeSession(
      bridge(
        vi.fn(async (runtimeRequest) => {
          calls += 1;
          if (calls === 1) {
            return {
              kind: "error",
              code: "unknown_session",
              message: "Unknown session",
              recoverable: true,
              sessionId: runtimeRequest.sessionId,
              viewRequestId: request.viewRequestId
            };
          }
          return datasetStatsResponse();
        })
      ),
      { activeViewContextId: "view", latestRequestedViewContextId: "view" }
    );
    const replay = vi.fn(async () => {
      replaceRuntime(session);
      return true;
    });
    const requestHooks = hooks({ replayAfterRuntimeLoss: replay });

    await expect(
      runtimeExecutor().execute(session, request, { priority: "background", viewContextId: "view" }, requestHooks)
    ).resolves.toMatchObject({ kind: "datasetStats" });
    expect(replay).toHaveBeenCalledOnce();

    const mismatched = runtimeSession(
      bridge(
        vi.fn(async (runtimeRequest) => ({
          kind: "error",
          code: "unknown_session",
          message: "Unknown session",
          recoverable: true,
          sessionId: runtimeRequest.sessionId,
          viewRequestId: "wrong-view"
        }))
      ),
      { activeViewContextId: "view", latestRequestedViewContextId: "view" }
    );
    const mismatchedHooks = hooks();
    await expect(
      runtimeExecutor().execute(mismatched, request, { priority: "background", viewContextId: "view" }, mismatchedHooks)
    ).resolves.toMatchObject({ kind: "error", code: "invalid_runtime_response" });
    expect(mismatchedHooks.replayAfterRuntimeLoss).not.toHaveBeenCalled();
  });

  it.each([
    { label: "cancelled", cancel: true, supersede: false, expectedCode: "unknown_session" },
    { label: "superseded", cancel: false, supersede: true, expectedCode: "stale_response" }
  ])(
    "does not reissue a background read $label during unknown-session replay",
    async ({ cancel, supersede, expectedCode }) => {
      const request = statsRequest(0);
      let runtimeCalls = 0;
      let cancelled = false;
      const scheduler = schedulerStub(() => cancelled);
      const session = runtimeSession(
        bridge(
          vi.fn(async (runtimeRequest) => {
            runtimeCalls += 1;
            return {
              kind: "error",
              code: "unknown_session",
              message: "Unknown session",
              recoverable: true,
              sessionId: runtimeRequest.sessionId,
              viewRequestId: request.viewRequestId
            };
          })
        ),
        {
          scheduler,
          activeViewContextId: "view",
          latestRequestedViewContextId: "view"
        }
      );
      const replay = vi.fn(async () => {
        replaceRuntime(session);
        cancelled = cancel;
        if (supersede) {
          session.activeViewContextId = "new-view";
          session.latestRequestedViewContextId = "new-view";
        }
        return true;
      });

      await expect(
        runtimeExecutor().execute(
          session,
          request,
          { priority: "background", viewContextId: "view" },
          hooks({ replayAfterRuntimeLoss: replay })
        )
      ).resolves.toMatchObject({ kind: "error", code: expectedCode, sessionId: "public-session" });
      expect(runtimeCalls).toBe(1);
    }
  );

  it("rebinds an exact current invalidated live page with exact-kernel and schema guards", async () => {
    const request = pageRequest("page", 0);
    let calls = 0;
    const session = runtimeSession(
      bridge(
        vi.fn(async (runtimeRequest) => {
          calls += 1;
          if (calls === 1) {
            return {
              kind: "error",
              code: "live_source_invalidated",
              message: "The live source changed.",
              recoverable: true,
              sessionId: runtimeRequest.sessionId,
              viewRequestId: request.viewRequestId
            };
          }
          if (runtimeRequest.kind !== "getPage") throw new Error("Expected a page reissue.");
          return pageResponse(runtimeRequest, session.metadata);
        })
      ),
      {
        latestRequestedPageRequestId: "page",
        activeViewContextId: "view",
        latestRequestedViewContextId: "view"
      }
    );
    const replay = vi.fn(async (_id, _options, requiredSchema, isStillCurrent) => {
      expect(requiredSchema).toEqual(schema);
      expect(isStillCurrent?.()).toBe(true);
      replaceRuntime(session);
      return true;
    });

    await expect(
      runtimeExecutor().execute(session, request, { viewContextId: "view" }, hooks({ replayAfterRuntimeLoss: replay }))
    ).resolves.toMatchObject({ kind: "page", metadata: { sessionId: "public-session" } });
    expect(replay).toHaveBeenCalledWith(
      "runtime-session",
      { priority: "interactive", requiredKernelSessionId: "runtime-session", viewContextId: "view" },
      schema,
      expect.any(Function)
    );
    expect(calls).toBe(2);
  });

  it("rejects an invalidated page or values request once its owner is stale", async () => {
    const page = pageRequest("stale-page", 0);
    const pageSession = runtimeSession(
      bridge(
        vi.fn(async (runtimeRequest) => ({
          kind: "error",
          code: "live_source_invalidated",
          message: "The live source changed.",
          recoverable: true,
          sessionId: runtimeRequest.sessionId,
          viewRequestId: page.viewRequestId
        }))
      ),
      { latestRequestedPageRequestId: "newer-page", latestRequestedViewContextId: "view" }
    );
    const pageHooks = hooks();
    await expect(
      runtimeExecutor().execute(pageSession, page, { viewContextId: "view" }, pageHooks)
    ).resolves.toMatchObject({ kind: "error", code: "stale_response" });
    expect(pageHooks.replayAfterRuntimeLoss).not.toHaveBeenCalled();

    const valuesRequest: SessionBoundRequest = {
      kind: "getColumnValues",
      sessionId: "public-session",
      revision: 0,
      viewRequestId: "values",
      column: "value",
      filterModel: emptyFilter,
      offset: 0,
      limit: 10
    };
    const valuesSession = runtimeSession(
      bridge(
        vi.fn(async (runtimeRequest) => ({
          kind: "error",
          code: "live_source_invalidated",
          message: "The live source changed.",
          recoverable: true,
          sessionId: runtimeRequest.sessionId,
          viewRequestId: "values"
        }))
      ),
      {
        scheduler: schedulerStub(() => true),
        activeViewContextId: "view",
        latestRequestedViewContextId: "view"
      }
    );
    await expect(
      runtimeExecutor().execute(valuesSession, valuesRequest, { viewContextId: "view" }, hooks())
    ).resolves.toMatchObject({ kind: "error", code: "stale_response" });
  });

  it("rejects a response from a runtime replaced during dispatch", async () => {
    const request = statsRequest(0);
    const session = runtimeSession(
      bridge(
        vi.fn(async () => {
          replaceRuntime(session);
          return datasetStatsResponse();
        })
      )
    );

    await expect(runtimeExecutor().execute(session, request, undefined, hooks())).resolves.toMatchObject({
      kind: "error",
      code: "stale_response"
    });
  });

  it("latches invalid mutation responses and Spark Connect loss", async () => {
    const mutation = previewRequest();
    const mutationSession = runtimeSession(
      bridge(
        vi.fn(async () => ({
          kind: "error",
          code: "engine_error",
          message: "wrong session",
          recoverable: true,
          sessionId: "other-runtime"
        }))
      )
    );

    await expect(runtimeExecutor().execute(mutationSession, mutation, undefined, hooks())).resolves.toMatchObject({
      kind: "error",
      code: "invalid_runtime_response"
    });
    expect(mutationSession.recoveryRequired).toBe(true);

    const request = pageRequest("spark-page", 0);
    const scheduler = schedulerStub();
    const sparkSession = runtimeSession(
      bridge(
        vi.fn(async (runtimeRequest) => ({
          kind: "error",
          code: "pyspark_connect_state_lost",
          message: "Spark server restarted.",
          recoverable: true,
          sessionId: runtimeRequest.sessionId,
          viewRequestId: "spark-page"
        }))
      ),
      { scheduler, latestRequestedPageRequestId: "spark-page" }
    );
    await expect(runtimeExecutor().execute(sparkSession, request, undefined, hooks())).resolves.toMatchObject({
      kind: "error",
      code: "pyspark_connect_state_lost",
      sessionId: "public-session"
    });
    expect(sparkSession.liveReconnectRequired).toBe(true);
    expect(scheduler.cancelBackground).toHaveBeenCalledOnce();
  });

  it("routes terminal close through the coordinator-owned cleanup hook", async () => {
    const session = runtimeSession(bridge(vi.fn()));
    const request: SessionBoundRequest = { kind: "closeSession", sessionId: session.publicId, revision: 0 };
    const close = vi.fn(async () => ({ kind: "sessionClosed" as const, sessionId: session.publicId }));

    await expect(runtimeExecutor().execute(session, request, { timeoutMs: 17 }, hooks({ close }))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: session.publicId
    });
    expect(close).toHaveBeenCalledWith({ timeoutMs: 17 });
    expect(session.delegate.request).not.toHaveBeenCalled();
  });
});

function runtimeExecutor(): SessionRuntimeRequestExecutor {
  return new SessionRuntimeRequestExecutor(new SessionResponseCommitter(new SessionPersistenceStore()));
}

function runtimeSession(
  delegate: OpenWranglerBridge,
  overrides: Partial<RuntimeRequestSession> = {}
): RuntimeRequestSession {
  const confirmed = overrides.metadata ?? metadata();
  return {
    publicId: "public-session",
    publicRevision: 0,
    runtimeId: confirmed.sessionId,
    runtimeRevision: confirmed.revision,
    delegate,
    metadata: confirmed,
    code: "",
    viewState: initialViewingState(confirmed),
    openRequest: {
      kind: "openSession",
      source: { kind: "file", label: "sample.csv", path: "/workspace/sample.csv" },
      backend: confirmed.backend,
      mode: confirmed.mode,
      pageSize: 100,
      columnOffset: 0,
      columnLimit: 1
    },
    scheduler: schedulerStub(),
    closing: false,
    liveReconnectRequired: false,
    recoveryRequired: false,
    ...overrides
  };
}

function hooks(overrides: Partial<RuntimeRequestHooks> = {}): RuntimeRequestHooks {
  return {
    isCoordinatorAvailable: vi.fn(() => true),
    waitForRuntimeSettlement: vi.fn(async () => undefined),
    installRuntimeSettlement: vi.fn(),
    replay: vi.fn(async () => false),
    replayAfterRuntimeLoss: vi.fn(async () => false),
    close: vi.fn(async () => ({ kind: "sessionClosed", sessionId: "public-session" })),
    responseCallbacks: { activate: vi.fn(), publishInspection: vi.fn() },
    ...overrides
  };
}

function schedulerStub(isCancelled: () => boolean = () => false): SessionRequestScheduler {
  return {
    isCancelled: vi.fn(isCancelled),
    cancelBackground: vi.fn()
  } as unknown as SessionRequestScheduler;
}

function bridge(request: OpenWranglerBridge["request"]): OpenWranglerBridge {
  return { request };
}

function replaceRuntime(session: RuntimeRequestSession): void {
  session.runtimeId = "runtime-2";
  session.runtimeRevision = 0;
  session.metadata = { ...session.metadata, sessionId: "runtime-2", revision: 0 };
}

function metadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    protocolVersion: 2,
    sessionId: "runtime-session",
    revision: 0,
    backend: "polars",
    mode: "editing",
    source: { kind: "file", label: "sample.csv", path: "/workspace/sample.csv" },
    capabilities: {
      editable: true,
      lazy: true,
      cancel: true,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: false
    },
    shape: { rows: 10, columns: 1 },
    filteredShape: { rows: 10, columns: 1 },
    schema,
    filterModel: emptyFilter,
    steps: [],
    ...overrides
  };
}

function statsRequest(revision: number): Extract<SessionBoundRequest, { kind: "getDatasetStats" }> {
  return {
    kind: "getDatasetStats",
    sessionId: "public-session",
    revision,
    viewRequestId: "stats",
    filterModel: emptyFilter
  };
}

function datasetStatsResponse(): Extract<OpenWranglerResponse, { kind: "datasetStats" }> {
  return {
    kind: "datasetStats",
    revision: 0,
    viewRequestId: "stats",
    stats: { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] }
  };
}

function pageRequest(viewRequestId: string, revision: number): Extract<SessionBoundRequest, { kind: "getPage" }> {
  return {
    kind: "getPage",
    sessionId: "public-session",
    revision,
    viewRequestId,
    offset: 0,
    limit: 100,
    columnOffset: 0,
    columnLimit: 1,
    filterModel: emptyFilter
  };
}

function pageResponse(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  confirmed: SessionMetadata
): Extract<OpenWranglerResponse, { kind: "page" }> {
  return {
    kind: "page",
    revision: request.revision,
    viewRequestId: request.viewRequestId,
    metadata: { ...confirmed, revision: request.revision, filterModel: request.filterModel },
    page: {
      offset: request.offset,
      limit: request.limit,
      totalRows: 10,
      columnIds: ["c:value"],
      rows: []
    }
  };
}

function previewRequest(): Extract<SessionBoundRequest, { kind: "previewStep" }> {
  return {
    kind: "previewStep",
    sessionId: "public-session",
    revision: 0,
    step,
    offset: 0,
    limit: 10,
    columnOffset: 0,
    columnLimit: 1
  };
}
