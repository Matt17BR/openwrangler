import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type {
  FilterModel,
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
    session.viewState = {
      ...session.viewState,
      selectedColumnId: "c:value",
      columnWidths: { "c:value": 240 },
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
        columnWidths: { "c:value": 240 },
        viewport: { firstVisibleRow: 100, scrollLeft: 19 }
      }
    });
    expect(stored[persistenceKey(session.openRequest.source, "polars")]).toMatchObject({
      view: { filterModel, viewport: { firstVisibleRow: 100, scrollLeft: 19 } }
    });
    expect(callbacks.activate).toHaveBeenCalledOnce();

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
    expect(update).toHaveBeenCalledOnce();
  });

  it("publishes preview, apply, and undo as one public revision stream", async () => {
    const committer = new SessionResponseCommitter(new SessionPersistenceStore());
    const callbacks = callbackSpies();
    const session = responseState({
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
    const previewMetadata = metadata({ revision: 1, draftStep: step });
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
      committer.commit(session, previewRequest, preview, 0, emptyFilter, undefined, callbacks)
    ).resolves.toMatchObject({ kind: "stepPreview", revision: 1 });
    expect(session).toMatchObject({
      publicRevision: 1,
      runtimeRevision: 1,
      code: "# preview",
      draftBaseFilterModel: emptyFilter,
      draftPresentation: { warnings: ["review"], beforeSchema: schema }
    });
    expect(session.activeViewContextId).toBeUndefined();
    expect(session.latestRequestedPageRequestId).toBeUndefined();

    const appliedFilter: FilterModel = {
      filters: [],
      sort: [{ column: "value", direction: "asc", nulls: "first" }]
    };
    const applyRequest: SessionBoundRequest = {
      kind: "applyDraft",
      sessionId: session.publicId,
      revision: 1,
      offset: 0,
      limit: 10,
      columnOffset: 0,
      columnLimit: 1
    };
    const appliedMetadata = metadata({ revision: 2, steps: [step], filterModel: appliedFilter });
    await committer.commit(
      session,
      applyRequest,
      planResponse("apply", appliedMetadata, "# applied"),
      1,
      emptyFilter,
      undefined,
      callbacks
    );
    expect(session).toMatchObject({
      publicRevision: 2,
      runtimeRevision: 2,
      metadata: { steps: [step], filterModel: appliedFilter },
      code: "# applied"
    });
    expect(session.draftBaseFilterModel).toBeUndefined();
    expect(session.draftPresentation).toBeUndefined();

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
      planResponse("undo", metadata({ revision: 3 }), "# original"),
      2,
      appliedFilter,
      undefined,
      callbacks
    );
    expect(session).toMatchObject({
      publicRevision: 3,
      runtimeRevision: 3,
      metadata: { steps: [], filterModel: emptyFilter },
      code: "# original"
    });
    expect(callbacks.activate).toHaveBeenCalledTimes(3);
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
    page: {
      ...gridPage(request.offset, request.limit, totalRows),
      ...(totalRows === null ? { hasMore: true } : {})
    }
  };
}

function planResponse(
  action: "apply" | "undo",
  confirmed: SessionMetadata,
  code: string
): Extract<OpenWranglerResponse, { kind: "planUpdated" }> {
  return {
    kind: "planUpdated",
    action,
    revision: confirmed.revision,
    metadata: confirmed,
    page: gridPage(0, 10, confirmed.filteredShape.rows),
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
    inputSchema: schema,
    outputSchema: schema,
    diff: emptyDiff(),
    code: "# inspection"
  };
}

function gridPage(offset: number, limit: number, totalRows: number | null) {
  return { offset, limit, totalRows, columnIds: ["c:value"], rows: [] };
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
