import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type {
  FilterModel,
  GridPage,
  OpenWranglerResponse,
  SessionBoundRequest,
  SessionMetadata,
  StepInspectionResponse,
  TransformStep
} from "../shared/protocol";
import { persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import { SessionPersistenceStore } from "../extension/sessionPersistenceStore";
import {
  SessionResponseCommitter,
  stepInspectionKey,
  type SessionResponseCallbacks,
  type SessionResponseState
} from "../extension/sessionResponseCommitter";
import { initialViewingState } from "../extension/sessionRuntimeStateRestorer";

const emptyFilter: FilterModel = { filters: [], sort: [] };
const nonemptyFilter: FilterModel = {
  logic: "and",
  filters: [
    {
      column: "value",
      type: "integer",
      predicates: [{ kind: "predicate", operator: "gte", value: 2 }]
    }
  ],
  sort: [{ column: "value", direction: "desc", nulls: "last" }]
};
const schema: SessionMetadata["schema"] = [
  { id: "c:value", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }
];
const step: TransformStep = {
  id: "round",
  kind: "roundNumber",
  params: { column: { id: "c:value", name: "value" }, decimals: 1 }
};

describe("SessionResponseCommitter", () => {
  it("publishes only the current exactly indexed applied-step inspection", async () => {
    const session = responseState({ metadata: metadata({ steps: [step] }), publicRevision: 7 });
    const request: Extract<SessionBoundRequest, { kind: "inspectStep" }> = {
      kind: "inspectStep",
      sessionId: session.publicId,
      revision: 7,
      stepId: step.id,
      offset: 0,
      limit: 10,
      columnOffset: 0,
      columnLimit: 1
    };
    session.latestStepInspectionKey = stepInspectionKey(request);
    const response = inspectionResponse(0);
    const callbacks = callbackSpies();
    const committer = new SessionResponseCommitter(new SessionPersistenceStore());

    await expect(committer.commit(session, request, response, 0, emptyFilter, undefined, callbacks)).resolves.toEqual({
      ...response,
      revision: 7
    });
    expect(session.stepInspection).toEqual({ ...response, revision: 7 });
    expect(callbacks.publishInspection).toHaveBeenCalledOnce();

    session.latestStepInspectionKey = undefined;
    await expect(
      committer.commit(session, request, response, 0, emptyFilter, undefined, callbacks)
    ).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      sessionId: session.publicId
    });
    await expect(
      committer.commit(session, request, inspectionResponse(2), 0, emptyFilter, undefined, callbacks)
    ).resolves.toMatchObject({ kind: "error", code: "invalid_runtime_response" });
    expect(callbacks.publishInspection).toHaveBeenCalledOnce();
  });

  it("atomically persists and publishes only the latest changed page", async () => {
    let stored: Record<string, unknown> = {};
    const writes: Record<string, unknown>[] = [];
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      writes.push(value);
      stored = value;
    });
    const persistence = new SessionPersistenceStore(memento(() => stored, update));
    const committer = new SessionResponseCommitter(persistence);
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "value", direction: "desc", nulls: "last" }]
    };
    const session = responseState({
      publicRevision: 4,
      activeViewContextId: "old-view",
      latestRequestedViewContextId: "next-view",
      latestRequestedPageRequestId: "current-page"
    });
    session.viewState = {
      ...session.viewState,
      selectedColumnId: "c:value",
      columnWidths: new Map([["c:value", 240]]),
      viewport: { firstVisibleRow: 0, scrollLeft: 19 }
    };
    const request = pageRequest(session, "current-page", filterModel, 100);
    const nextMetadata = metadata({
      filterModel,
      shape: { rows: 240, columns: 1 },
      filteredShape: { rows: 240, columns: 1 }
    });
    const callbacks = callbackSpies();

    const response = await committer.commit(
      session,
      request,
      pageResponse(request, nextMetadata, 240),
      0,
      emptyFilter,
      { viewContextId: "next-view" },
      callbacks
    );

    expect(response).toMatchObject({
      kind: "page",
      revision: 4,
      metadata: { sessionId: "public-session", revision: 4, filterModel }
    });
    expect(session).toMatchObject({
      publicRevision: 4,
      runtimeRevision: 0,
      activeViewContextId: "next-view",
      metadata: { filterModel },
      viewState: {
        selectedColumnId: "c:value",
        columnWidths: new Map([["c:value", 240]]),
        viewport: { firstVisibleRow: 100, scrollLeft: 19 }
      }
    });
    expect(stored[persistenceKey(session.openRequest.source, "polars")]).toMatchObject({
      view: {
        filterModel,
        columnWidths: [["c:value", 240]],
        viewport: { firstVisibleRow: 100, scrollLeft: 19 }
      }
    });
    expect(callbacks.activate).toHaveBeenCalledOnce();
    const key = persistenceKey(session.openRequest.source, "polars");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[key]).toHaveProperty("pendingCurrentCommit");
    expect(
      new SessionPersistenceStore(memento(() => writes[0] ?? {}, vi.fn())).load(session.openRequest.source, "polars")
    ).toBeUndefined();
    expect(writes[1]?.[key]).toEqual(stored[key]);

    const stale = responseState({ latestRequestedPageRequestId: "newer-page" });
    await expect(
      committer.commit(
        stale,
        request,
        pageResponse(request, nextMetadata, 240),
        0,
        emptyFilter,
        { viewContextId: "next-view" },
        callbackSpies()
      )
    ).resolves.toMatchObject({ kind: "error", code: "stale_response", viewRequestId: "current-page" });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("returns an actionable availability error without publishing a page after a persistence read failure", async () => {
    const persistence = new SessionPersistenceStore(
      memento(() => {
        throw Object.assign(new Error("cannot read /private/workspace/state.json"), { code: "EACCES" });
      }, vi.fn())
    );
    const committer = new SessionResponseCommitter(persistence);
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "value", direction: "desc", nulls: "last" }]
    };
    const session = responseState({
      latestRequestedViewContextId: "current-view",
      latestRequestedPageRequestId: "current-page"
    });
    const request = pageRequest(session, "current-page", filterModel, 100);
    const callbacks = callbackSpies();

    const response = await committer.commit(
      session,
      request,
      pageResponse(request, metadata({ filterModel }), 240),
      0,
      emptyFilter,
      { viewContextId: "current-view" },
      callbacks
    );

    expect(response).toEqual({
      kind: "error",
      code: "persistence_unavailable",
      message:
        "Open Wrangler could not save workspace recovery state, so the active session was left unchanged. Retry after workspace storage is available.",
      recoverable: true,
      sessionId: session.publicId,
      viewRequestId: "current-page"
    });
    expect(JSON.stringify(response)).not.toContain("/private/workspace");
    expect(session.metadata.filterModel).toEqual(emptyFilter);
    expect(session.activeViewContextId).toBeUndefined();
    expect(callbacks.activate).not.toHaveBeenCalled();
  });

  it.each(["stage", "read", "final"] as const)(
    "restores a changed page after its persistence %s fails",
    async (failurePoint) => {
      let stored: Record<string, unknown> = {};
      let reads = 0;
      const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
        const attempt = update.mock.calls.length;
        if ((failurePoint === "stage" && attempt === 1) || (failurePoint === "final" && attempt === 2)) {
          throw new Error(`${failurePoint} page persistence unavailable`);
        }
        stored = value;
      });
      const committer = new SessionResponseCommitter(
        new SessionPersistenceStore(
          memento(() => {
            reads += 1;
            if (failurePoint === "read" && reads === 2) throw new Error("page persistence read unavailable");
            return stored;
          }, update)
        )
      );
      const filterModel: FilterModel = {
        filters: [],
        sort: [{ column: "value", direction: "desc", nulls: "last" }]
      };
      const session = responseState({
        publicRevision: 4,
        activeViewContextId: "old-view",
        latestRequestedViewContextId: "next-view",
        latestRequestedPageRequestId: "current-page"
      });
      const previousMetadata = session.metadata;
      const previousViewState = session.viewState;
      const callbacks = callbackSpies();
      const request = pageRequest(session, "current-page", filterModel, 100);

      await expect(
        committer.commit(
          session,
          request,
          pageResponse(request, metadata({ filterModel }), 240),
          0,
          emptyFilter,
          { viewContextId: "next-view" },
          callbacks
        )
      ).resolves.toMatchObject({ kind: "error", code: "persistence_unavailable" });

      expect(session.publicRevision).toBe(4);
      expect(session.activeViewContextId).toBe("old-view");
      expect(session.metadata).toBe(previousMetadata);
      expect(session.viewState).toBe(previousViewState);
      expect(callbacks.activate).toHaveBeenCalledTimes(failurePoint === "final" ? 1 : 0);
    }
  );

  it("preserves a reentrant newer view when a page's final persistence write fails", async () => {
    let stored: Record<string, unknown> = {};
    const session = responseState({
      latestRequestedViewContextId: "current-view",
      latestRequestedPageRequestId: "current-page"
    });
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 2) {
        session.latestRequestedPageRequestId = "newer-page";
        session.viewState = {
          ...session.viewState,
          viewport: { ...session.viewState.viewport, scrollLeft: 999 }
        };
        throw new Error("final page persistence unavailable");
      }
      stored = value;
    });
    const committer = new SessionResponseCommitter(new SessionPersistenceStore(memento(() => stored, update)));
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "value", direction: "desc", nulls: "last" }]
    };
    const request = pageRequest(session, "current-page", filterModel, 100);

    const response = await committer.commit(
      session,
      request,
      pageResponse(request, metadata({ filterModel }), 240),
      0,
      emptyFilter,
      { viewContextId: "current-view" },
      callbackSpies()
    );

    expect(response).toMatchObject({ kind: "error", code: "persistence_unavailable" });
    expect(response).toHaveProperty(
      "message",
      "The page is active, but Open Wrangler could not save its workspace recovery state. Retry after workspace storage is available."
    );
    expect(session.latestRequestedPageRequestId).toBe("newer-page");
    expect(session.viewState.viewport.scrollLeft).toBe(999);
    expect(session.metadata.filterModel).toEqual(filterModel);
  });

  it("restores the confirmed page state when its publication callback rejects", async () => {
    let stored: Record<string, unknown> = {};
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      stored = value;
    });
    const persistence = new SessionPersistenceStore(memento(() => stored, update));
    const committer = new SessionResponseCommitter(persistence);
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "value", direction: "desc", nulls: "last" }]
    };
    const session = responseState({
      publicRevision: 4,
      activeViewContextId: "old-view",
      latestRequestedViewContextId: "next-view",
      latestRequestedPageRequestId: "current-page"
    });
    const previousMetadata = session.metadata;
    const previousViewState = session.viewState;
    const previousViewChangeEpoch = session.viewChangeEpoch;
    const request = pageRequest(session, "current-page", filterModel, 100);
    const callbackFailure = new Error("unexpected activation callback failure");
    const callbacks = callbackSpies();
    let publicationOwner = "confirmed";
    vi.mocked(callbacks.activate).mockImplementation((registerRollback) => {
      registerRollback?.(() => {
        publicationOwner = "confirmed";
      });
      publicationOwner = "candidate";
      throw callbackFailure;
    });

    await expect(
      committer.commit(
        session,
        request,
        pageResponse(request, metadata({ filterModel }), 240),
        0,
        emptyFilter,
        { viewContextId: "next-view" },
        callbacks
      )
    ).rejects.toBe(callbackFailure);

    expect(session).toMatchObject({
      publicRevision: 4,
      runtimeRevision: 0,
      activeViewContextId: "old-view"
    });
    expect(session.viewChangeEpoch).toBe(previousViewChangeEpoch);
    expect(session.metadata).toBe(previousMetadata);
    expect(session.viewState).toBe(previousViewState);
    expect(publicationOwner).toBe("confirmed");
    const key = persistenceKey(session.openRequest.source, "polars");
    expect(stored[key]).toBeUndefined();
    expect(persistence.load(session.openRequest.source, "polars")).toBeUndefined();
  });

  it("returns a current ephemeral clipboard page without committing visible view state", async () => {
    const session = responseState({
      publicRevision: 4,
      activeViewContextId: "current-view",
      latestRequestedViewContextId: "current-view",
      latestRequestedPageRequestId: "visible-page"
    });
    const request = pageRequest(session, "clipboard-page", emptyFilter, 100);
    const callbacks = callbackSpies();
    const before = {
      activeViewContextId: session.activeViewContextId,
      latestRequestedPageRequestId: session.latestRequestedPageRequestId,
      metadata: session.metadata,
      publicRevision: session.publicRevision,
      runtimeRevision: session.runtimeRevision,
      viewState: session.viewState
    };
    const response = pageResponse(request, metadata({ filteredShape: { rows: 240, columns: 1 } }), 240);
    const committer = new SessionResponseCommitter(new SessionPersistenceStore());

    await expect(
      committer.commit(
        session,
        request,
        response,
        0,
        emptyFilter,
        { viewContextId: "current-view", ephemeralPage: true },
        callbacks
      )
    ).resolves.toMatchObject({
      kind: "page",
      revision: 4,
      viewRequestId: "clipboard-page",
      metadata: { sessionId: "public-session", revision: 4, filteredShape: { rows: 240 } }
    });
    expect(session).toMatchObject(before);
    expect(callbacks.activate).not.toHaveBeenCalled();

    await expect(
      committer.commit(
        session,
        request,
        response,
        0,
        emptyFilter,
        { viewContextId: "stale-view", ephemeralPage: true },
        callbacks
      )
    ).resolves.toMatchObject({ kind: "error", code: "stale_response", viewRequestId: "clipboard-page" });
    await expect(
      committer.commit(
        session,
        request,
        { ...response, revision: 1 },
        0,
        emptyFilter,
        { viewContextId: "current-view", ephemeralPage: true },
        callbacks
      )
    ).resolves.toMatchObject({ kind: "error", code: "stale_response", viewRequestId: "clipboard-page" });
  });

  it("persists one nonempty draft view through preview, apply, and discard", async () => {
    let stored: Record<string, unknown> = {};
    const persistence = new SessionPersistenceStore(
      memento(
        () => stored,
        async (_key, value) => {
          stored = value;
        }
      )
    );
    const committer = new SessionResponseCommitter(persistence);
    const callbacks = callbackSpies();
    const session = responseState({
      metadata: metadata({ filterModel: nonemptyFilter }),
      activeViewContextId: "view",
      latestRequestedViewContextId: "view",
      latestRequestedPageRequestId: "page"
    });
    const previewRequest: SessionBoundRequest = {
      kind: "previewStep",
      sessionId: session.publicId,
      revision: 0,
      step,
      offset: 0,
      limit: 10,
      columnOffset: 0,
      columnLimit: 1
    };
    const previewMetadata = metadata({ revision: 1, draftStep: step, filterModel: nonemptyFilter });
    const preview = {
      kind: "stepPreview" as const,
      revision: 1,
      metadata: previewMetadata,
      page: gridPage(0, 10, 10),
      diff: emptyDiff(),
      warnings: ["review"],
      code: "# preview"
    };

    await expect(
      committer.commit(session, previewRequest, preview, 0, nonemptyFilter, undefined, callbacks)
    ).resolves.toMatchObject({ kind: "stepPreview", revision: 1 });
    expect(session).toMatchObject({
      publicRevision: 1,
      runtimeRevision: 1,
      code: "# preview",
      draftBaseFilterModel: nonemptyFilter,
      draftPresentation: { warnings: ["review"], beforeSchema: schema }
    });
    expect(persistence.load(session.openRequest.source, "polars")).toMatchObject({
      cleaning: { steps: [], draftStep: step, draftBaseFilterModel: nonemptyFilter },
      view: { filterModel: nonemptyFilter }
    });
    expect(session.activeViewContextId).toBeUndefined();
    expect(session.latestRequestedPageRequestId).toBeUndefined();

    const applyRequest: SessionBoundRequest = {
      kind: "applyDraft",
      sessionId: session.publicId,
      revision: 1,
      offset: 0,
      limit: 10,
      columnOffset: 0,
      columnLimit: 1
    };
    const appliedMetadata = metadata({ revision: 2, steps: [step], filterModel: nonemptyFilter });
    await committer.commit(
      session,
      applyRequest,
      planResponse("apply", appliedMetadata, "# applied"),
      1,
      nonemptyFilter,
      undefined,
      callbacks
    );
    expect(session).toMatchObject({
      publicRevision: 2,
      runtimeRevision: 2,
      metadata: { steps: [step], filterModel: nonemptyFilter },
      code: "# applied"
    });
    expect(session.draftBaseFilterModel).toBeUndefined();
    expect(session.draftPresentation).toBeUndefined();
    expect(persistence.load(session.openRequest.source, "polars")?.cleaning).toMatchObject({ steps: [step] });
    expect(persistence.load(session.openRequest.source, "polars")?.cleaning.draftBaseFilterModel).toBeUndefined();

    const undoRequest: SessionBoundRequest = {
      kind: "undoStep",
      sessionId: session.publicId,
      revision: 2,
      offset: 0,
      limit: 10,
      columnOffset: 0,
      columnLimit: 1
    };
    await committer.commit(
      session,
      undoRequest,
      planResponse("undo", metadata({ revision: 3, filterModel: nonemptyFilter }), "# original"),
      2,
      nonemptyFilter,
      undefined,
      callbacks
    );
    expect(session).toMatchObject({
      publicRevision: 3,
      runtimeRevision: 3,
      metadata: { steps: [], filterModel: nonemptyFilter },
      code: "# original"
    });

    const discardPreviewRequest: SessionBoundRequest = { ...previewRequest, revision: 3 };
    await committer.commit(
      session,
      discardPreviewRequest,
      { ...preview, revision: 4, metadata: metadata({ revision: 4, draftStep: step, filterModel: nonemptyFilter }) },
      3,
      nonemptyFilter,
      undefined,
      callbacks
    );
    expect(persistence.load(session.openRequest.source, "polars")?.cleaning.draftBaseFilterModel).toEqual(
      nonemptyFilter
    );

    const discardRequest: SessionBoundRequest = {
      kind: "discardDraft",
      sessionId: session.publicId,
      revision: 4,
      offset: 0,
      limit: 10,
      columnOffset: 0,
      columnLimit: 1
    };
    await committer.commit(
      session,
      discardRequest,
      planResponse("discard", metadata({ revision: 5, filterModel: nonemptyFilter }), "# discarded"),
      4,
      nonemptyFilter,
      undefined,
      callbacks
    );
    expect(session).toMatchObject({
      publicRevision: 5,
      runtimeRevision: 5,
      metadata: { steps: [], filterModel: nonemptyFilter },
      code: "# discarded"
    });
    expect(session.draftBaseFilterModel).toBeUndefined();
    expect(persistence.load(session.openRequest.source, "polars")?.cleaning.draftBaseFilterModel).toBeUndefined();
    expect(callbacks.activate).toHaveBeenCalledTimes(5);
  });

  it("commits a terminal Spark shape even without a filter, plan, or revision change", async () => {
    const sparkMetadata = metadata({
      backend: "pyspark",
      mode: "viewing",
      shape: { rows: null, columns: 1 },
      filteredShape: { rows: null, columns: 1 }
    });
    const session = responseState({
      metadata: sparkMetadata,
      latestRequestedPageRequestId: "terminal",
      latestRequestedViewContextId: "view",
      activeViewContextId: "view"
    });
    const request = pageRequest(session, "terminal", emptyFilter, 100);
    const terminalMetadata = metadata({
      backend: "pyspark",
      mode: "viewing",
      shape: { rows: 120, columns: 1 },
      filteredShape: { rows: 120, columns: 1 }
    });
    const callbacks = callbackSpies();

    await new SessionResponseCommitter(new SessionPersistenceStore()).commit(
      session,
      request,
      pageResponse(request, terminalMetadata, 120),
      0,
      emptyFilter,
      { viewContextId: "view" },
      callbacks
    );

    expect(session.metadata).toMatchObject({ shape: { rows: 120 }, filteredShape: { rows: 120 } });
    expect(callbacks.activate).toHaveBeenCalledOnce();
  });

  it("drops stale dataset statistics and publishes current statistics under the public revision", async () => {
    const session = responseState({
      publicRevision: 5,
      activeViewContextId: "current-view",
      latestRequestedViewContextId: "current-view"
    });
    const request: SessionBoundRequest = {
      kind: "getDatasetStats",
      sessionId: session.publicId,
      revision: 5,
      viewRequestId: "stats",
      filterModel: emptyFilter
    };
    const stats = { missingCells: 1, missingRows: 1, duplicateRows: 0, missingValuesByColumn: [] };
    const response: Extract<OpenWranglerResponse, { kind: "datasetStats" }> = {
      kind: "datasetStats",
      revision: 0,
      viewRequestId: "stats",
      stats
    };
    const callbacks = callbackSpies();
    const committer = new SessionResponseCommitter(new SessionPersistenceStore());

    await expect(
      committer.commit(session, request, response, 0, emptyFilter, { viewContextId: "old-view" }, callbacks)
    ).resolves.toMatchObject({ kind: "error", code: "stale_response" });
    expect(session.metadata.stats).toBeUndefined();

    await expect(
      committer.commit(session, request, response, 0, emptyFilter, { viewContextId: "current-view" }, callbacks)
    ).resolves.toMatchObject({ kind: "datasetStats", revision: 5, stats });
    expect(session.metadata.stats).toEqual(stats);
    expect(callbacks.activate).toHaveBeenCalledOnce();
  });

  it("removes statistics when a current page adopts a different logical view", async () => {
    const session = responseState({
      metadata: metadata({
        stats: { missingCells: 1, missingRows: 1, duplicateRows: 0, missingValuesByColumn: [] }
      }),
      activeViewContextId: "old-view",
      latestRequestedViewContextId: "new-view",
      latestRequestedPageRequestId: "new-page"
    });
    const request = pageRequest(session, "new-page", emptyFilter, 0);
    const callbacks = callbackSpies();

    await new SessionResponseCommitter(new SessionPersistenceStore()).commit(
      session,
      request,
      pageResponse(request, session.metadata, 10),
      0,
      emptyFilter,
      { viewContextId: "new-view" },
      callbacks
    );

    expect(session.activeViewContextId).toBe("new-view");
    expect(session.metadata.stats).toBeUndefined();
    expect(callbacks.activate).toHaveBeenCalledOnce();
  });

  it("translates correlated runtime identities without changing response meaning", async () => {
    const session = responseState({ publicRevision: 9 });
    const request: SessionBoundRequest = {
      kind: "getSummary",
      sessionId: session.publicId,
      revision: 9,
      viewRequestId: "summary",
      filterModel: emptyFilter,
      columnIds: ["c:value"]
    };
    const committer = new SessionResponseCommitter(new SessionPersistenceStore());

    await expect(
      committer.commit(
        session,
        request,
        { kind: "summary", revision: 0, viewRequestId: "summary", summaries: [] },
        0,
        emptyFilter,
        undefined,
        callbackSpies()
      )
    ).resolves.toMatchObject({ kind: "summary", revision: 9 });
    await expect(
      committer.commit(
        session,
        request,
        {
          kind: "error",
          code: "engine_error",
          message: "runtime failure",
          recoverable: true,
          sessionId: "runtime-session"
        },
        0,
        emptyFilter,
        undefined,
        callbackSpies()
      )
    ).resolves.toMatchObject({ kind: "error", sessionId: "public-session" });
  });
});

function responseState(overrides: Partial<SessionResponseState> = {}): SessionResponseState {
  const confirmed = overrides.metadata ?? metadata();
  return {
    publicId: "public-session",
    publicRevision: 0,
    runtimeId: confirmed.sessionId,
    runtimeRevision: confirmed.revision,
    delegate: { request: vi.fn() },
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
    ...overrides
  };
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

function pageRequest(
  session: SessionResponseState,
  viewRequestId: string,
  filterModel: FilterModel,
  offset: number
): Extract<SessionBoundRequest, { kind: "getPage" }> {
  return {
    kind: "getPage",
    sessionId: session.publicId,
    revision: session.publicRevision,
    viewRequestId,
    offset,
    limit: 100,
    columnOffset: 0,
    columnLimit: 1,
    filterModel
  };
}

function pageResponse(
  request: Extract<SessionBoundRequest, { kind: "getPage" }>,
  confirmed: SessionMetadata,
  totalRows: number | null
): Extract<OpenWranglerResponse, { kind: "page" }> {
  return {
    kind: "page",
    revision: confirmed.revision,
    viewRequestId: request.viewRequestId,
    metadata: confirmed,
    page:
      totalRows === null
        ? {
            offset: request.offset,
            limit: request.limit,
            totalRows: null,
            hasMore: true,
            columnIds: ["c:value"],
            rows: []
          }
        : gridPage(request.offset, request.limit, totalRows)
  };
}

function planResponse(
  action: "apply" | "discard" | "undo",
  confirmed: SessionMetadata,
  code: string
): Extract<OpenWranglerResponse, { kind: "planUpdated" }> {
  return {
    kind: "planUpdated",
    action,
    revision: confirmed.revision,
    metadata: confirmed,
    page: gridPage(0, 10, exactRows(confirmed)),
    code
  };
}

function inspectionResponse(stepIndex: number): StepInspectionResponse {
  return {
    kind: "stepInspection",
    revision: 0,
    stepId: step.id,
    stepIndex,
    inputPage: gridPage(0, 10, 10),
    outputPage: gridPage(0, 10, 10),
    inputRowAxis: { kind: "positional", levelNames: [] },
    outputRowAxis: { kind: "positional", levelNames: [] },
    inputSchema: schema,
    outputSchema: schema,
    diff: emptyDiff(),
    code: "# inspection"
  };
}

function gridPage(offset: number, limit: number, totalRows: number): GridPage {
  return { offset, limit, totalRows, columnIds: ["c:value"], rows: [] };
}

function exactRows(confirmed: SessionMetadata): number {
  const rows = confirmed.filteredShape.rows;
  if (rows === null) throw new Error("This response fixture requires an exact row count.");
  return rows;
}

function emptyDiff() {
  return {
    addedRows: 0,
    removedRows: 0,
    addedColumns: [],
    removedColumns: [],
    changedCells: 0,
    cells: [],
    truncated: false
  };
}

function callbackSpies(): SessionResponseCallbacks {
  return { activate: vi.fn(), publishInspection: vi.fn() };
}

function memento(
  read: () => Record<string, unknown>,
  update: (key: string, value: Record<string, unknown>) => Promise<void>
): Memento {
  return {
    get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? read() : fallback)),
    update,
    keys: vi.fn(() => [SESSION_STORAGE_KEY])
  } as unknown as Memento;
}
