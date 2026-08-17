import { describe, expect, it, vi } from "vitest";
import type { DatasetStatsRequest, FilterModel, PageRequest, SummaryRequest, ValuesRequest } from "../shared/protocol";
import type { RFramePageContract } from "../extension/r/rFrameContract";
import { sessionFromContract, type RBridgeSession } from "../extension/r/rKernelBridgeContract";
import { RKernelReadQueries, type RKernelReadTransport } from "../extension/r/rKernelReadQueries";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("R kernel read queries", () => {
  it("publishes an exact projected page and updates only copied view state", async () => {
    const contract = frameContract();
    const session = createSession(contract);
    const transport = fakeTransport(contract);
    const queries = new RKernelReadQueries(transport, new Map([[sessionId, session]]));
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "value", direction: "desc", nulls: "last" }]
    };

    await expect(queries.getPage(pageRequest("view-1", filterModel), { timeoutMs: 321 })).resolves.toMatchObject({
      kind: "page",
      revision: 0,
      viewRequestId: "view-1",
      page: { totalRows: 1, columnIds: ["r:c:0"] },
      metadata: { sessionId, filteredShape: { rows: 1 } }
    });
    expect(transport.getPage).toHaveBeenCalledWith(
      sessionId,
      {
        rowOffset: 0,
        rowLimit: 1,
        columnOffset: 0,
        columnLimit: 1,
        view: {
          filters: [],
          sorts: [{ column: { id: "r:c:0", name: "value" }, direction: "desc", nulls: "last" }]
        }
      },
      { cancellation: undefined, timeoutMs: 321 }
    );
    expect(session.filterModel).toEqual(filterModel);
    expect(session.filterModel).not.toBe(filterModel);
    expect(session.filterModel.sort[0]).not.toBe(filterModel.sort[0]);
    expect(session.viewChangeEpoch).toBe(1);
  });

  it("fails closed before dispatch for missing, invalidated, and stale sessions", async () => {
    const contract = frameContract();
    for (const [boundary, expectedCode] of [
      ["missing", "unknown_session"],
      ["invalidated", "r_kernel_changed"],
      ["stale", "stale_revision"]
    ] as const) {
      const session = createSession(contract);
      if (boundary === "invalidated") session.invalidated = true;
      if (boundary === "stale") session.revision = 1;
      const sessions = boundary === "missing" ? new Map<string, RBridgeSession>() : new Map([[sessionId, session]]);
      const transport = fakeTransport(contract);
      const queries = new RKernelReadQueries(transport, sessions);

      const responses = await Promise.all([
        queries.getPage(pageRequest(`${boundary}-page`), {}),
        queries.getSummary(summaryRequest(`${boundary}-summary`), {}),
        queries.getDatasetStats(datasetStatsRequest(`${boundary}-stats`), {}),
        queries.getColumnValues(valuesRequest(`${boundary}-values`), {})
      ]);

      for (const response of responses)
        expect(response).toMatchObject({ kind: "error", code: expectedCode, sessionId });
      for (const method of Object.values(transport)) expect(method).not.toHaveBeenCalled();
    }
  });

  it("suppresses a page whose exact session revision changes while awaiting transport", async () => {
    const contract = frameContract();
    const session = createSession(contract);
    const pending = deferred<RFramePageContract>();
    const transport = fakeTransport(contract);
    transport.getPage.mockImplementationOnce(async () => pending.promise);
    const queries = new RKernelReadQueries(transport, new Map([[sessionId, session]]));
    const response = queries.getPage(pageRequest("view-2"), {});
    session.revision = 1;
    pending.resolve(contract);

    await expect(response).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      sessionId,
      viewRequestId: "view-2"
    });
  });

  it("suppresses every in-flight read after the exact session is invalidated", async () => {
    const contract = frameContract();
    const session = createSession(contract);
    const page = deferred<Awaited<ReturnType<RKernelReadTransport["getPage"]>>>();
    const summary = deferred<Awaited<ReturnType<RKernelReadTransport["getSummary"]>>>();
    const stats = deferred<Awaited<ReturnType<RKernelReadTransport["getDatasetStats"]>>>();
    const values = deferred<Awaited<ReturnType<RKernelReadTransport["getColumnValues"]>>>();
    const transport = fakeTransport(contract);
    transport.getPage.mockImplementationOnce(async () => page.promise);
    transport.getSummary.mockImplementationOnce(async () => summary.promise);
    transport.getDatasetStats.mockImplementationOnce(async () => stats.promise);
    transport.getColumnValues.mockImplementationOnce(async () => values.promise);
    const queries = new RKernelReadQueries(transport, new Map([[sessionId, session]]));
    const responses = [
      queries.getPage(pageRequest("invalidated-page"), {}),
      queries.getSummary(summaryRequest("invalidated-summary"), {}),
      queries.getDatasetStats(datasetStatsRequest("invalidated-stats"), {}),
      queries.getColumnValues(valuesRequest("invalidated-values"), {})
    ];

    session.invalidated = true;
    page.resolve(contract);
    summary.resolve(summaryResult);
    stats.resolve(datasetResult);
    values.resolve(columnValuesResult);

    for (const response of await Promise.all(responses)) {
      expect(response).toMatchObject({ kind: "error", code: "r_kernel_changed", sessionId });
    }
  });

  it("returns an empty requested summary without dispatch", async () => {
    const contract = frameContract();
    const session = createSession(contract);
    const transport = fakeTransport(contract);
    const queries = new RKernelReadQueries(transport, new Map([[sessionId, session]]));

    await expect(queries.getSummary(summaryRequest("summary-empty", []), {})).resolves.toEqual({
      kind: "summary",
      revision: 0,
      viewRequestId: "summary-empty",
      summaries: []
    });
    expect(transport.getSummary).not.toHaveBeenCalled();
  });

  it("binds profile and value dispatch and isolates each mutable result collection", async () => {
    const contract = frameContract();
    const session = createSession(contract);
    const transport = fakeTransport(contract);
    const queries = new RKernelReadQueries(transport, new Map([[sessionId, session]]));
    const options = { timeoutMs: 654 };

    const summary = await queries.getSummary(summaryRequest("summary-1"), options);
    expect(summary).toMatchObject({
      kind: "summary",
      summaries: [{ columnId: "r:c:0", column: "value", totalCount: 1 }]
    });
    if (summary.kind !== "summary") throw new Error("Expected a column summary.");
    expect(summary.summaries).not.toBe(summaryResult);
    expect(summary.summaries[0]).not.toBe(summaryResult[0]);
    expect(transport.getSummary).toHaveBeenCalledWith(
      sessionId,
      [{ id: "r:c:0", name: "value" }],
      { filters: [], sorts: [] },
      { cancellation: undefined, timeoutMs: 654 }
    );

    const stats = await queries.getDatasetStats(datasetStatsRequest("stats-1"), options);
    expect(stats).toMatchObject({
      kind: "datasetStats",
      stats: { missingCells: 0, missingValuesByColumn: [{ column: "value", count: 0 }] }
    });
    if (stats.kind !== "datasetStats") throw new Error("Expected dataset statistics.");
    expect(stats.stats).not.toBe(datasetResult.stats);
    expect(stats.stats.missingValuesByColumn).not.toBe(datasetResult.stats.missingValuesByColumn);
    expect(stats.stats.missingValuesByColumn[0]).not.toBe(datasetResult.stats.missingValuesByColumn[0]);
    expect(transport.getDatasetStats).toHaveBeenCalledWith(
      sessionId,
      { filters: [], sorts: [] },
      { cancellation: undefined, timeoutMs: 654 }
    );

    const values = await queries.getColumnValues(valuesRequest("values-1"), options);
    expect(values).toMatchObject({
      kind: "columnValues",
      column: "value",
      values: [{ value: "1", count: 1 }],
      hasMore: false
    });
    if (values.kind !== "columnValues") throw new Error("Expected column values.");
    expect(values.values).not.toBe(columnValuesResult.values);
    expect(values.values[0]).not.toBe(columnValuesResult.values[0]);
    expect(transport.getColumnValues).toHaveBeenCalledWith(
      sessionId,
      { id: "r:c:0", name: "value" },
      { filters: [], sorts: [] },
      "1",
      5,
      { cancellation: undefined, timeoutMs: 654 }
    );
  });
});

function pageRequest(viewRequestId: string, filterModel: FilterModel = emptyFilterModel()): PageRequest {
  return {
    kind: "getPage",
    sessionId,
    revision: 0,
    viewRequestId,
    offset: 0,
    limit: 1,
    columnOffset: 0,
    columnLimit: 1,
    filterModel
  };
}

function summaryRequest(viewRequestId: string, columnIds: readonly string[] = ["r:c:0"]): SummaryRequest {
  return {
    kind: "getSummary",
    sessionId,
    revision: 0,
    viewRequestId,
    columnIds: [...columnIds],
    filterModel: emptyFilterModel()
  };
}

function datasetStatsRequest(viewRequestId: string): DatasetStatsRequest {
  return {
    kind: "getDatasetStats",
    sessionId,
    revision: 0,
    viewRequestId,
    filterModel: emptyFilterModel()
  };
}

function valuesRequest(viewRequestId: string): ValuesRequest {
  return {
    kind: "getColumnValues",
    sessionId,
    revision: 0,
    viewRequestId,
    column: "value",
    search: "1",
    limit: 5,
    filterModel: emptyFilterModel()
  };
}

function emptyFilterModel(): FilterModel {
  return { filters: [], sort: [] };
}

function createSession(contract: RFramePageContract): RBridgeSession {
  return sessionFromContract(
    sessionId,
    {
      kind: "notebookVariable",
      label: "orders",
      uri: "file:///workspace/orders.ipynb",
      variableName: "orders"
    },
    "viewing",
    contract,
    []
  );
}

const summaryResult = [
  {
    columnId: "r:c:0",
    column: "value",
    type: "float" as const,
    rawType: "double",
    totalCount: 1,
    nullCount: 0,
    nanCount: 0,
    distinctCount: 1,
    topValues: [{ value: "1", count: 1 }]
  }
];

const datasetResult = {
  totalRows: 1,
  stats: {
    missingCells: 0,
    missingRows: 0,
    duplicateRows: 0,
    missingValuesByColumn: [{ column: "value", count: 0 }]
  }
};

const columnValuesResult = {
  column: "value",
  values: [
    {
      value: "1",
      count: 1,
      selectionValue: {
        kind: "typedSelection" as const,
        version: 1 as const,
        columnType: "float" as const,
        cell: { kind: "number" as const, raw: 1, display: "1", isNull: false, isNaN: false }
      }
    }
  ],
  hasMore: false
};

function fakeTransport(contract: RFramePageContract): {
  [K in keyof RKernelReadTransport]: ReturnType<typeof vi.fn<RKernelReadTransport[K]>>;
} {
  return {
    getPage: vi.fn(async () => contract),
    getSummary: vi.fn(async () => summaryResult),
    getDatasetStats: vi.fn(async () => datasetResult),
    getColumnValues: vi.fn(async () => columnValuesResult)
  };
}

function frameContract(): RFramePageContract {
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: 1, columns: 1 },
    frameSemantics: { classes: ["data.frame"], rowNames: "automatic", keyColumnIds: [] },
    schema: [
      {
        id: "r:c:0",
        name: "value",
        position: 0,
        rawType: "double",
        type: "float",
        nullable: false,
        semantics: { kind: "double", storageMode: "double", classes: ["numeric"] }
      }
    ],
    page: {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnOffset: 0,
      columnLimit: 1,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:r:0",
          rowNumber: 0,
          values: [{ kind: "number", raw: "1", display: "1", isNull: false, isNaN: false }]
        }
      ]
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
