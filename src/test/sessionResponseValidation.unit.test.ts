import { describe, expect, it } from "vitest";
import type {
  ColumnSchema,
  DataDiff,
  FilterModel,
  GridPage,
  OpenSessionRequest,
  OpenWranglerResponse,
  SessionBoundRequest,
  SessionMetadata,
  SessionOpenedResponse
} from "../shared/protocol";
import { responseMismatch, sessionOpenedResponseMismatch } from "../extension/sessionResponseValidation";

const runtimeSessionId = "runtime-session";
const filterModel: FilterModel = { filters: [], sort: [] };
const schema: ColumnSchema[] = [
  { id: "column:a", name: "sales", position: 0, rawType: "Int64", type: "integer", nullable: false },
  { id: "column:b", name: "region", position: 1, rawType: "string", type: "string", nullable: true }
];
const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: runtimeSessionId,
  revision: 4,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sales.csv", path: "/workspace/sales.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 1, columns: 2 },
  filteredShape: { rows: 1, columns: 2 },
  schema,
  filterModel,
  steps: []
};
const page: GridPage = {
  offset: 0,
  limit: 10,
  totalRows: 1,
  columnIds: schema.map((column) => column.id),
  rows: [
    {
      id: "row:0",
      rowNumber: 0,
      values: [
        { kind: "integer", raw: 10, display: "10", isNull: false, isNaN: false },
        { kind: "string", raw: "west", display: "west", isNull: false, isNaN: false }
      ]
    }
  ]
};

describe("session response validation", () => {
  it("accepts one exact page and rejects every independent projection/correlation boundary", () => {
    const request = pageRequest();
    const response = pageResponse();
    expect(responseMismatch(request, response, runtimeSessionId, schema)).toBeUndefined();

    const cases: Array<[string, OpenWranglerResponse]> = [
      ["runtime returned summary", summaryResponse("page-request")],
      ["page correlation did not match", { ...response, viewRequestId: "other" }],
      ["page revision 5 did not match 4", { ...response, revision: 5 }],
      [
        "metadata named runtime session other instead of runtime-session",
        { ...response, metadata: { ...metadata, sessionId: "other" } }
      ],
      [
        "metadata revision 3 did not match response revision 4",
        { ...response, metadata: { ...metadata, revision: 3 } }
      ],
      [
        "page metadata schema changed without a revision",
        { ...response, metadata: { ...metadata, schema: schema.slice(0, 1) } }
      ],
      ["page offset 1 did not match 0", { ...response, page: { ...page, offset: 1 } }],
      ["page limit 11 did not match 10", { ...response, page: { ...page, limit: 11 } }],
      [
        "page column identities did not match the requested projection",
        { ...response, page: { ...page, columnIds: [schema[1]!.id, schema[0]!.id] } }
      ],
      [
        "page row width did not match its projected column identities",
        { ...response, page: { ...page, rows: [{ ...page.rows[0]!, values: page.rows[0]!.values.slice(0, 1) }] } }
      ]
    ];
    for (const [expected, candidate] of cases) {
      expect(responseMismatch(request, candidate, runtimeSessionId, schema)).toBe(expected);
    }
  });

  it("binds summaries to the requested stable-column projection and confirmed schema", () => {
    const request: SessionBoundRequest = {
      kind: "getSummary",
      sessionId: runtimeSessionId,
      revision: 4,
      viewRequestId: "summary-request",
      filterModel,
      columnIds: [schema[1]!.id]
    };
    const summary = {
      columnId: schema[1]!.id,
      column: schema[1]!.name,
      type: schema[1]!.type,
      rawType: schema[1]!.rawType,
      totalCount: 1,
      nullCount: 0,
      nanCount: 0,
      topValues: []
    };
    const response: OpenWranglerResponse = {
      kind: "summary",
      revision: 4,
      viewRequestId: "summary-request",
      summaries: [summary]
    };

    expect(responseMismatch(request, response, runtimeSessionId, schema)).toBeUndefined();
    expect(responseMismatch(request, { ...response, summaries: [summary, summary] }, runtimeSessionId, schema)).toBe(
      "summary column identities did not match the requested projection"
    );
    expect(
      responseMismatch(request, { ...response, summaries: [{ ...summary, column: "wrong" }] }, runtimeSessionId, schema)
    ).toBe(`summary for ${schema[1]!.id} did not match the confirmed schema`);
  });

  it("validates mutation action, revision, metadata, projection, and diff identities", () => {
    const request: SessionBoundRequest = {
      kind: "applyDraft",
      sessionId: runtimeSessionId,
      revision: 3,
      offset: 0,
      limit: 10,
      columnOffset: 0,
      columnLimit: 2
    };
    const response: OpenWranglerResponse = {
      kind: "planUpdated",
      action: "apply",
      revision: 4,
      metadata,
      page,
      code: "# applied"
    };
    expect(responseMismatch(request, response, runtimeSessionId)).toBeUndefined();
    expect(responseMismatch(request, { ...response, action: "undo" }, runtimeSessionId)).toBe(
      "runtime reported undo instead of apply"
    );
    expect(responseMismatch(request, { ...response, revision: 3 }, runtimeSessionId)).toBe(
      "plan revision 3 did not follow 3"
    );

    const previewRequest: SessionBoundRequest = {
      kind: "previewStep",
      sessionId: runtimeSessionId,
      revision: 3,
      step: { id: "drop", kind: "dropColumns", params: { columns: [{ id: "column:a", name: "sales" }] } },
      offset: 0,
      limit: 10,
      columnOffset: 0,
      columnLimit: 2
    };
    const diff: DataDiff = {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 1,
      cells: [{ rowNumber: 0, columnId: "missing", column: "missing", before: null, after: null }],
      truncated: false
    };
    const preview: OpenWranglerResponse = {
      kind: "stepPreview",
      revision: 4,
      metadata,
      page,
      diff,
      code: "# preview"
    };
    expect(responseMismatch(previewRequest, preview, runtimeSessionId)).toBe(
      "diff cell named unknown output column identity missing"
    );
  });

  it("retains view correlation on errors/cancellation and exact export/close facts", () => {
    const request = pageRequest();
    expect(
      responseMismatch(
        request,
        { kind: "error", code: "failed", message: "failed", recoverable: true, viewRequestId: "other" },
        runtimeSessionId,
        schema
      )
    ).toBe("error did not retain view request page-request");
    expect(
      responseMismatch(
        request,
        { kind: "cancelled", targetRequestId: "page", viewRequestId: "other" },
        runtimeSessionId
      )
    ).toBe("cancellation did not retain view request page-request");

    const exportRequest: SessionBoundRequest = {
      kind: "exportData",
      sessionId: runtimeSessionId,
      revision: 4,
      path: "/tmp/export.csv",
      options: { format: "csv", delimiter: ",", quoteChar: '"', encoding: "utf-8", header: true }
    };
    expect(
      responseMismatch(
        exportRequest,
        { kind: "dataExported", revision: 4, path: "/tmp/other.csv", format: "csv", shape: { rows: 1, columns: 2 } },
        runtimeSessionId
      )
    ).toBe("runtime reported a different export path");
    expect(
      responseMismatch(
        { kind: "closeSession", sessionId: runtimeSessionId, revision: 4 },
        { kind: "sessionClosed", sessionId: "other" },
        runtimeSessionId
      )
    ).toBe("runtime acknowledged session other instead of runtime-session");
  });

  it("validates the initial page plus strict requested session, backend, mode, and source", () => {
    const request: OpenSessionRequest = {
      kind: "openSession",
      source: metadata.source,
      requestedSessionId: runtimeSessionId,
      backend: "polars",
      mode: "editing",
      pageSize: 10,
      columnOffset: 0,
      columnLimit: 2
    };
    const response: SessionOpenedResponse = { kind: "sessionOpened", metadata, page, summaries: [] };
    expect(sessionOpenedResponseMismatch(request, response, true)).toBeUndefined();

    const cases: Array<[string, SessionOpenedResponse]> = [
      [
        "metadata named runtime session other instead of requested session runtime-session",
        { ...response, metadata: { ...metadata, sessionId: "other" } }
      ],
      [
        "metadata reported backend pandas instead of requested backend polars",
        { ...response, metadata: { ...metadata, backend: "pandas" } }
      ],
      [
        "metadata reported mode viewing instead of requested mode editing",
        { ...response, metadata: { ...metadata, mode: "viewing" } }
      ],
      [
        "metadata reported a different immutable source",
        { ...response, metadata: { ...metadata, source: { ...metadata.source, label: "other" } } }
      ],
      ["metadata reported invalid revision -1", { ...response, metadata: { ...metadata, revision: -1 } }],
      ["page offset 1 did not match 0", { ...response, page: { ...page, offset: 1 } }]
    ];
    for (const [expected, candidate] of cases) {
      expect(sessionOpenedResponseMismatch(request, candidate, true)).toBe(expected);
    }
  });
});

function pageRequest(): Extract<SessionBoundRequest, { kind: "getPage" }> {
  return {
    kind: "getPage",
    sessionId: runtimeSessionId,
    revision: 4,
    viewRequestId: "page-request",
    offset: 0,
    limit: 10,
    columnOffset: 0,
    columnLimit: 2,
    filterModel
  };
}

function pageResponse(): Extract<OpenWranglerResponse, { kind: "page" }> {
  return { kind: "page", revision: 4, viewRequestId: "page-request", metadata, page };
}

function summaryResponse(viewRequestId: string): Extract<OpenWranglerResponse, { kind: "summary" }> {
  return { kind: "summary", revision: 4, viewRequestId, summaries: [] };
}
