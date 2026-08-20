import Ajv from "ajv";
import transportSchema from "../../protocol/openwrangler.v2.schema.json";
import type { GridPage, OpenWranglerRequest, OpenWranglerResponse, SessionMetadata } from "../shared/protocol";

const validateTransportSchema = new Ajv({ strict: false })
  .addKeyword({
    keyword: "x-openwrangler-utf8MaxBytes",
    type: "string",
    schemaType: ["number"],
    validate: (maximumBytes: number, value: string) => new TextEncoder().encode(value).byteLength <= maximumBytes
  })
  .compile(transportSchema);

const capabilities = {
  editable: true,
  lazy: true,
  cancel: true,
  exportCsv: true,
  exportParquet: true,
  notebookInsert: false
};

const valueReference = { id: "column:0", name: "value" };
const otherReference = { id: "column:1", name: "other" };

const page: GridPage = {
  offset: 0,
  limit: 50,
  totalRows: 1,
  columnIds: ["column:0"],
  rows: [
    {
      id: "row:0",
      rowNumber: 0,
      values: [{ kind: "integer", raw: "9007199254740993", display: "9007199254740993", isNull: false, isNaN: false }]
    }
  ]
};

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session-1",
  revision: 3,
  backend: "polars",
  mode: "editing",
  source: {
    kind: "file",
    label: "fixture.csv",
    path: "/tmp/fixture.csv",
    importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
  },
  capabilities,
  shape: { rows: 1, columns: 1 },
  filteredShape: { rows: 1, columns: 1 },
  schema: [{ id: "column:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }],
  filterModel: {
    logic: "and",
    filters: [
      {
        column: "value",
        type: "integer",
        logic: "and",
        valueFilter: {
          kind: "values",
          selectedValues: [1],
          includeNulls: false,
          includeNaN: false,
          search: "1"
        },
        predicates: [{ kind: "predicate", operator: "gte", value: 1 }]
      }
    ],
    sort: [{ column: "value", direction: "asc", nulls: "last" }]
  },
  steps: [{ id: "step-1", kind: "roundNumber", params: { column: valueReference, decimals: 0 } }],
  latestStepInputSchema: [
    { id: "column:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }
  ],
  stats: {
    missingCells: 0,
    missingRows: 0,
    duplicateRows: 0,
    missingValuesByColumn: [{ column: "value", count: 0 }]
  }
};

const summaries = [
  {
    columnId: "column:0",
    column: "value",
    type: "integer" as const,
    rawType: "Int64",
    totalCount: 1,
    nullCount: 0,
    nanCount: 0,
    distinctCount: 1,
    numeric: {
      min: 1,
      max: 1,
      mean: 1,
      median: 1,
      std: 0,
      sum: 1,
      exactSum: { kind: "integer" as const, raw: 1, display: "1", isNull: false, isNaN: false }
    },
    visualization: { kind: "numeric" as const, bins: [{ min: 1, max: 1, count: 1 }], sampled: false },
    topValues: [{ value: "1", count: 1 }]
  }
];

const responses: OpenWranglerResponse[] = [
  { kind: "initialized", protocolVersion: 2, runtimeVersion: "0.3.0", capabilities },
  { kind: "sessionOpened", metadata, page, summaries },
  { kind: "page", revision: 3, viewRequestId: "view-1", page, metadata },
  { kind: "summary", revision: 3, viewRequestId: "view-1", summaries },
  {
    kind: "datasetStats",
    revision: 3,
    viewRequestId: "view-1",
    stats: { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] }
  },
  {
    kind: "columnValues",
    revision: 3,
    viewRequestId: "view-1",
    column: "value",
    values: [{ value: "1", count: 1 }],
    hasMore: false
  },
  {
    kind: "stepPreview",
    revision: 3,
    metadata: {
      ...metadata,
      draftStep: { id: "draft-1", kind: "floorNumber", params: { column: valueReference } }
    },
    page,
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 1,
      cells: [
        {
          rowNumber: 0,
          columnId: "column:0",
          column: "value",
          before: { kind: "number", raw: 1.2, display: "1.2", isNull: false, isNaN: false },
          after: { kind: "number", raw: 1, display: "1", isNull: false, isNaN: false }
        }
      ],
      truncated: false
    },
    code: "df.with_columns(...)\n",
    warnings: []
  },
  {
    kind: "stepInspection",
    revision: 3,
    stepId: "step-1",
    stepIndex: 0,
    inputPage: page,
    outputPage: page,
    inputRowAxis: { kind: "positional", levelNames: [] },
    outputRowAxis: { kind: "positional", levelNames: [] },
    inputSchema: metadata.schema,
    outputSchema: metadata.schema,
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    },
    code: "def clean_data(df):\n    return df\n"
  },
  { kind: "planUpdated", action: "apply", revision: 4, metadata, page, code: "df\n" },
  { kind: "dataExported", revision: 3, path: "/tmp/export.parquet", format: "parquet", shape: { rows: 1, columns: 1 } },
  { kind: "sessionClosed", sessionId: "session-1" },
  { kind: "cancelled", targetRequestId: "request-1", viewRequestId: "view-1" },
  {
    kind: "error",
    code: "source_changed",
    message: "The source changed.",
    detail: "Reopen the source.",
    recoverable: true,
    sessionId: "session-1",
    viewRequestId: "view-1"
  }
];

const requests: OpenWranglerRequest[] = [
  { kind: "initialize" },
  {
    kind: "openSession",
    source: metadata.source,
    requestedSessionId: "runtime-candidate",
    cloneFrom: { sessionId: "session-1", revision: 3 },
    backend: "polars",
    mode: "editing",
    pageSize: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "getPage",
    sessionId: "session-1",
    revision: 3,
    viewRequestId: "page-1",
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16,
    filterModel: metadata.filterModel
  },
  {
    kind: "getSummary",
    sessionId: "session-1",
    revision: 3,
    viewRequestId: "summary-1",
    filterModel: metadata.filterModel,
    columnIds: ["column:0"]
  },
  {
    kind: "getDatasetStats",
    sessionId: "session-1",
    revision: 3,
    viewRequestId: "stats-1",
    filterModel: metadata.filterModel
  },
  {
    kind: "getColumnValues",
    sessionId: "session-1",
    revision: 3,
    viewRequestId: "values-1",
    column: "value",
    filterModel: metadata.filterModel,
    search: "1",
    limit: 50
  },
  {
    kind: "previewStep",
    sessionId: "session-1",
    revision: 3,
    step: { id: "rename", kind: "renameColumn", params: { column: valueReference, newName: "amount" } },
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "inspectStep",
    sessionId: "session-1",
    revision: 3,
    stepId: "step-1",
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "applyDraft",
    sessionId: "session-1",
    revision: 3,
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "discardDraft",
    sessionId: "session-1",
    revision: 3,
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "undoStep",
    sessionId: "session-1",
    revision: 3,
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "exportData",
    sessionId: "session-1",
    revision: 3,
    path: "/tmp/out.csv",
    options: { format: "csv", delimiter: ",", quoteChar: '"', encoding: "utf-8", header: true }
  },
  {
    kind: "exportData",
    sessionId: "session-1",
    revision: 3,
    path: "/tmp/.openwrangler-export.tmp",
    options: { format: "parquet" },
    targetIdentity: { device: "7", inode: "11" }
  },
  { kind: "closeSession", sessionId: "session-1", revision: 3 },
  { kind: "cancelRequest", targetRequestId: "request-1" }
];

export {
  capabilities,
  metadata,
  otherReference,
  page,
  requests,
  responses,
  summaries,
  validateTransportSchema,
  valueReference
};
