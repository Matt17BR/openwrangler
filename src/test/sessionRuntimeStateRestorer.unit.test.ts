import { describe, expect, it, vi } from "vitest";
import type {
  DataBackend,
  FilterModel,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  TransformStep
} from "../shared/protocol";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import {
  RuntimeStateRestoreError,
  SessionRuntimeStateRestorer,
  initialViewingState,
  reconcileViewingState,
  type RuntimeSessionState
} from "../extension/sessionRuntimeStateRestorer";

const emptyFilter: FilterModel = { filters: [], sort: [] };
const schema: SessionMetadata["schema"] = [
  { id: "c:value", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }
];

describe("SessionRuntimeStateRestorer", () => {
  it("replays exact committed steps and restores a draft against its confirmed base view", async () => {
    const groupStep: TransformStep = {
      id: "group",
      kind: "groupBy",
      params: {
        keys: [{ id: "c:value", name: "value" }],
        aggregations: [{ column: { id: "c:value", name: "value" }, operation: "sum", alias: "total" }]
      }
    };
    const exampleStep: TransformStep = {
      id: "example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c:step:group:0", name: "total" }],
        newColumn: "label",
        examples: [
          { inputs: [1], output: "one" },
          { inputs: [2], output: "two" }
        ],
        program: { kind: "column", column: { id: "c:step:group:0", name: "total" } },
        warnings: [],
        candidateCount: 1
      }
    };
    const draftStep: TransformStep = {
      id: "round",
      kind: "roundNumber",
      params: { column: { id: "c:step:group:0", name: "total" }, decimals: 1 }
    };
    const draftBaseFilter: FilterModel = {
      filters: [],
      sort: [{ column: "total", direction: "desc", nulls: "last" }]
    };
    const requests: OpenWranglerRequest[] = [];
    let confirmedSteps: TransformStep[] = [];
    let pendingStep: TransformStep | undefined;
    let currentFilter = emptyFilter;
    const delegate = bridge(async (request) => {
      requests.push(request);
      if (request.kind === "previewStep") {
        pendingStep = request.step;
        const next = metadata({
          revision: request.revision + 1,
          steps: confirmedSteps,
          draftStep: request.step,
          draftReplacesStepId: request.replaceStepId,
          filterModel: currentFilter
        });
        return previewResponse(request, next);
      }
      if (request.kind === "applyDraft") {
        if (!pendingStep) throw new Error("Expected a pending step.");
        confirmedSteps = [...confirmedSteps, pendingStep];
        pendingStep = undefined;
        const next = metadata({ revision: request.revision + 1, steps: confirmedSteps, filterModel: currentFilter });
        return planResponse(request, next);
      }
      if (request.kind === "getPage") {
        currentFilter = request.filterModel;
        return pageResponse(
          request,
          metadata({ revision: request.revision, steps: confirmedSteps, filterModel: currentFilter })
        );
      }
      throw new Error(`Unexpected restore request: ${request.kind}`);
    });
    const session = runtimeSession(delegate);
    const restorer = new SessionRuntimeStateRestorer();

    await restorer.restoreCleaningState(
      session,
      {
        steps: [groupStep, exampleStep],
        draftStep,
        draftBaseFilterModel: draftBaseFilter
      },
      0,
      1
    );

    expect(requests.map((request) => request.kind)).toEqual([
      "previewStep",
      "applyDraft",
      "previewStep",
      "applyDraft",
      "getPage",
      "previewStep"
    ]);
    expect(
      requests
        .filter(
          (request): request is Extract<OpenWranglerRequest, { kind: "previewStep" }> => request.kind === "previewStep"
        )
        .map((request) => request.step)
    ).toEqual([groupStep, exampleStep, draftStep]);
    expect(session).toMatchObject({
      runtimeRevision: 5,
      metadata: { steps: [groupStep, exampleStep], draftStep, filterModel: draftBaseFilter },
      draftBaseFilterModel: draftBaseFilter,
      draftPresentation: { warnings: [], beforeSchema: schema }
    });
  });

  it("falls back from an invalid saved view to one empty confirmed view", async () => {
    const savedFilter: FilterModel = {
      filters: [],
      sort: [{ column: "removed", direction: "asc", nulls: "last" }]
    };
    const requestedFilters: FilterModel[] = [];
    const delegate = bridge(async (request) => {
      if (request.kind !== "getPage") throw new Error(`Unexpected restore request: ${request.kind}`);
      requestedFilters.push(request.filterModel);
      if (request.filterModel === savedFilter) {
        return {
          kind: "error",
          code: "engine_error",
          message: "The saved view is stale.",
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      return pageResponse(request, metadata({ revision: request.revision, filterModel: request.filterModel }));
    });
    const session = runtimeSession(delegate);

    const page = await new SessionRuntimeStateRestorer().restoreViewingState(
      session,
      {
        filterModel: savedFilter,
        columnWidths: { removed: 260 },
        selectedColumnId: "removed",
        viewport: { firstVisibleRow: 40, scrollLeft: 120 }
      },
      100,
      0,
      1
    );

    expect(page.page.offset).toBe(0);
    expect(requestedFilters).toEqual([savedFilter, emptyFilter]);
    expect(session.viewState).toEqual({
      filterModel: emptyFilter,
      columnWidths: {},
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
  });

  it("bounds a shrunken saved viewport to the final page without issuing profile work", async () => {
    const offsets: number[] = [];
    const reducedMetadata = metadata({
      shape: { rows: 120, columns: 1 },
      filteredShape: { rows: 120, columns: 1 }
    });
    const delegate = bridge(async (request) => {
      if (request.kind !== "getPage") throw new Error(`Unexpected restore request: ${request.kind}`);
      offsets.push(request.offset);
      return pageResponse(request, reducedMetadata, 120);
    });
    const session = runtimeSession(delegate, reducedMetadata);

    const page = await new SessionRuntimeStateRestorer().restoreOneViewingState(
      session,
      {
        filterModel: emptyFilter,
        columnWidths: { "c:value": 240, removed: 300 },
        selectedColumnId: "c:value",
        viewport: { firstVisibleRow: 450, scrollLeft: 30 }
      },
      100,
      0,
      1,
      "saved"
    );

    expect(offsets).toEqual([400, 100]);
    expect(page.page.offset).toBe(100);
    expect(session.viewState).toEqual({
      filterModel: emptyFilter,
      columnWidths: { "c:value": 240 },
      selectedColumnId: "c:value",
      viewport: { firstVisibleRow: 119, scrollLeft: 30 }
    });
  });

  it("rebuilds nearby PySpark page anchors progressively", async () => {
    const offsets: number[] = [];
    const sparkMetadata = metadata({
      backend: "pyspark",
      mode: "viewing",
      shape: { rows: null, columns: 1 },
      filteredShape: { rows: null, columns: 1 }
    });
    const delegate = bridge(async (request) => {
      if (request.kind !== "getPage") throw new Error(`Unexpected restore request: ${request.kind}`);
      offsets.push(request.offset);
      return pageResponse(request, sparkMetadata, null);
    });
    const session = runtimeSession(delegate, sparkMetadata);

    await new SessionRuntimeStateRestorer().restoreOneViewingState(
      session,
      {
        filterModel: emptyFilter,
        columnWidths: { "c:value": 200 },
        viewport: { firstVisibleRow: 250, scrollLeft: 7 }
      },
      100,
      0,
      1,
      "saved"
    );

    expect(offsets).toEqual([0, 100, 200]);
    expect(session.viewState.viewport).toEqual({ firstVisibleRow: 250, scrollLeft: 7 });
  });

  it("bounds distant PySpark viewport replay to one page", async () => {
    const offsets: number[] = [];
    const sparkMetadata = metadata({
      backend: "pyspark",
      mode: "viewing",
      shape: { rows: null, columns: 1 },
      filteredShape: { rows: null, columns: 1 }
    });
    const delegate = bridge(async (request) => {
      if (request.kind !== "getPage") throw new Error(`Unexpected restore request: ${request.kind}`);
      offsets.push(request.offset);
      return pageResponse(request, sparkMetadata, null);
    });
    const session = runtimeSession(delegate, sparkMetadata);

    await new SessionRuntimeStateRestorer().restoreOneViewingState(
      session,
      {
        filterModel: emptyFilter,
        columnWidths: {},
        viewport: { firstVisibleRow: 2_000, scrollLeft: 11 }
      },
      100,
      0,
      1,
      "saved"
    );

    expect(offsets).toEqual([0]);
    expect(session.viewState.viewport).toEqual({ firstVisibleRow: 0, scrollLeft: 11 });
  });

  it("requires an exact view when recovery cannot safely fall back", async () => {
    const delegate = bridge(vi.fn());
    const session = runtimeSession(delegate);

    await expect(
      new SessionRuntimeStateRestorer().restoreRuntimeState(
        session,
        { backend: "polars", cleaning: { steps: [] } },
        100,
        0,
        1,
        undefined,
        true
      )
    ).rejects.toThrow(RuntimeStateRestoreError);
    expect(delegate.request).not.toHaveBeenCalled();
  });

  it("checks candidate freshness after a response before mutating restored state", async () => {
    const nextMetadata = metadata({ revision: 0, filterModel: emptyFilter });
    const delegate = bridge(async (request) => {
      if (request.kind !== "getPage") throw new Error(`Unexpected restore request: ${request.kind}`);
      return pageResponse(request, nextMetadata);
    });
    const session = runtimeSession(delegate);
    const metadataBeforeRestore = session.metadata;
    let checks = 0;

    await expect(
      new SessionRuntimeStateRestorer().restoreOneViewingState(
        session,
        { filterModel: emptyFilter, columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } },
        100,
        0,
        1,
        "saved",
        undefined,
        () => {
          checks += 1;
          if (checks === 2) throw new Error("superseded");
        }
      )
    ).rejects.toThrow("superseded");

    expect(checks).toBe(2);
    expect(session.runtimeRevision).toBe(0);
    expect(session.metadata).toBe(metadataBeforeRestore);
  });

  it("reconciles presentation fields against the confirmed schema and row bound", () => {
    const confirmed = metadata({ filteredShape: { rows: 2, columns: 1 } });
    expect(
      reconcileViewingState(
        {
          filterModel: emptyFilter,
          columnWidths: { "c:value": 200, removed: 300 },
          selectedColumnId: "removed",
          viewport: { firstVisibleRow: 9, scrollLeft: 17 }
        },
        confirmed
      )
    ).toEqual({
      filterModel: confirmed.filterModel,
      columnWidths: { "c:value": 200 },
      viewport: { firstVisibleRow: 1, scrollLeft: 17 }
    });
  });
});

function runtimeSession(delegate: OpenWranglerBridge, confirmed = metadata()): RuntimeSessionState {
  return {
    publicId: "public-session",
    runtimeId: confirmed.sessionId,
    runtimeRevision: confirmed.revision,
    delegate,
    metadata: confirmed,
    code: "",
    viewState: initialViewingState(confirmed)
  };
}

function bridge(request: OpenWranglerBridge["request"]): OpenWranglerBridge {
  return { request };
}

function metadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  const backend: DataBackend = overrides.backend ?? "polars";
  return {
    protocolVersion: 2,
    sessionId: "runtime-session",
    revision: 0,
    backend,
    mode: overrides.mode ?? "editing",
    source: { kind: "file", label: "sample.csv", path: "/workspace/sample.csv" },
    capabilities: {
      editable: backend !== "pyspark",
      lazy: backend !== "pyspark",
      cancel: backend !== "pyspark",
      exportCsv: backend !== "pyspark",
      exportParquet: backend !== "pyspark",
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

function pageResponse(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  confirmed: SessionMetadata,
  totalRows: number | null = confirmed.filteredShape.rows
): Extract<OpenWranglerResponse, { kind: "page" }> {
  const next = { ...confirmed, revision: request.revision, filterModel: request.filterModel };
  return {
    kind: "page",
    revision: request.revision,
    viewRequestId: request.viewRequestId,
    metadata: next,
    page:
      totalRows === null
        ? {
            offset: request.offset,
            limit: request.limit,
            totalRows: null,
            hasMore: true,
            columnIds: next.schema
              .slice(request.columnOffset, request.columnOffset + request.columnLimit)
              .map((column) => column.id),
            rows: []
          }
        : {
            offset: request.offset,
            limit: request.limit,
            totalRows,
            columnIds: next.schema
              .slice(request.columnOffset, request.columnOffset + request.columnLimit)
              .map((column) => column.id),
            rows: []
          }
  };
}

function previewResponse(
  request: Extract<OpenWranglerRequest, { kind: "previewStep" }>,
  confirmed: SessionMetadata
): Extract<OpenWranglerResponse, { kind: "stepPreview" }> {
  return {
    kind: "stepPreview",
    revision: confirmed.revision,
    metadata: confirmed,
    page: projectedPage(request, confirmed),
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    },
    code: `# preview ${request.step.id}`
  };
}

function planResponse(
  request: Extract<OpenWranglerRequest, { kind: "applyDraft" }>,
  confirmed: SessionMetadata
): Extract<OpenWranglerResponse, { kind: "planUpdated" }> {
  return {
    kind: "planUpdated",
    action: "apply",
    revision: confirmed.revision,
    metadata: confirmed,
    page: projectedPage(request, confirmed),
    code: "# applied"
  };
}

function projectedPage(
  request: { offset: number; limit: number; columnOffset: number; columnLimit: number },
  confirmed: SessionMetadata
) {
  const totalRows = confirmed.filteredShape.rows;
  if (totalRows === null) throw new Error("This projected-page fixture requires an exact row count.");
  return {
    offset: request.offset,
    limit: request.limit,
    totalRows,
    columnIds: confirmed.schema
      .slice(request.columnOffset, request.columnOffset + request.columnLimit)
      .map((column) => column.id),
    rows: []
  };
}
