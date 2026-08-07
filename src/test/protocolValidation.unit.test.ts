import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import transportSchema from "../../protocol/openwrangler.v2.schema.json";
import type {
  GridPage,
  LiveGridPage,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeResponseEnvelope,
  SessionMetadata
} from "../shared/protocol";
import {
  isOpenWranglerRequest,
  isOpenWranglerResponse,
  isRetainedTransformStep,
  isRuntimeRequestEnvelope,
  isRuntimeResponseEnvelope,
  isTransformStep
} from "../shared/protocolValidation";
import {
  hasAtMostViewValueTextCodePoints,
  MAX_VIEW_VALUE_TEXT_CHARACTERS,
  truncateViewValueTextToCodePoints
} from "../shared/viewValueLimits";
import { runtimeIdentityForDataBackend } from "../shared/runtimeIdentity";

const validateTransportSchema = new Ajv({ strict: false }).compile(transportSchema);

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
    numeric: { min: 1, max: 1, mean: 1, median: 1, std: 0 },
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

describe("protocol-v2 response validation", () => {
  it.each(responses.map((response) => [response.kind, response] as const))(
    "accepts a structurally complete %s response",
    (_kind, response) => {
      expect(isOpenWranglerResponse(response)).toBe(true);
      expect(isRuntimeResponseEnvelope({ protocolVersion: 2, requestId: `request-${response.kind}`, response })).toBe(
        true
      );
    }
  );

  it.each([
    {},
    { protocolVersion: 2, requestId: "request-1", response: {} },
    { protocolVersion: 2, requestId: "request-1", response: { kind: "futureResponse" } },
    { protocolVersion: 2, requestId: "", response: responses[0] },
    { protocolVersion: 1, requestId: "request-1", response: responses[0] },
    { protocolVersion: 2, requestId: "request-1", response: responses[0], unexpected: true }
  ])("rejects a malformed envelope: %j", (candidate) => {
    expect(isRuntimeResponseEnvelope(candidate)).toBe(false);
  });

  it("rejects malformed metadata before it can enter session state", () => {
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: { ...metadata, schema: [{ ...metadata.schema[0], nullable: "sometimes" }] },
        page,
        summaries
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...responses[1],
        metadata: {
          ...metadata,
          filterModel: {
            filters: [],
            sort: [
              { column: "value", direction: "asc", nulls: "last" },
              { column: "value", direction: "desc", nulls: "first" }
            ]
          }
        }
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "page",
        revision: 3,
        viewRequestId: "view-1",
        metadata: { ...metadata, capabilities: {} },
        page
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "page",
        revision: 3,
        viewRequestId: "view-1",
        metadata: { ...metadata, unknownField: true },
        page
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: {
          ...metadata,
          steps: [{ id: "cross-kind", kind: "renameColumn", params: { columns: ["value"] } }]
        },
        page,
        summaries
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: {
          ...metadata,
          draftStep: {
            id: "bad-program",
            kind: "byExample",
            params: {
              sourceColumns: [{ id: "column:0", name: "value" }],
              newColumn: "clean",
              examples: [
                { inputs: ["a"], output: "A" },
                { inputs: ["b"], output: "B" }
              ],
              program: {
                kind: "case",
                style: "sideways",
                input: { kind: "column", column: { id: "column:0", name: "value" } }
              }
            }
          }
        },
        page,
        summaries
      })
    ).toBe(false);
    const unsynthesizedByExample = {
      id: "unsynthesized-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };
    expect(isTransformStep(unsynthesizedByExample)).toBe(true);
    expect(isRetainedTransformStep(unsynthesizedByExample)).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: { ...metadata, steps: [unsynthesizedByExample] },
        page,
        summaries
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: { ...metadata, draftStep: unsynthesizedByExample },
        page,
        summaries
      })
    ).toBe(false);
  });

  it("accepts optional viewing capabilities and rejects malformed flags", () => {
    const opened = responses[1];
    if (opened?.kind !== "sessionOpened") throw new Error("Expected the session-opened fixture.");
    const partialCapabilities = {
      ...capabilities,
      filter: false,
      sort: true,
      profile: false,
      columnValues: false
    };
    const partial = {
      ...opened,
      metadata: { ...opened.metadata, capabilities: partialCapabilities }
    };

    expect(isOpenWranglerResponse(partial)).toBe(true);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "partial-capabilities", response: partial })).toBe(
      true
    );
    expect(isOpenWranglerResponse(opened)).toBe(true);
    expect(
      isOpenWranglerResponse({
        ...partial,
        metadata: { ...partial.metadata, capabilities: { ...partialCapabilities, profile: "no" } }
      })
    ).toBe(false);
  });

  it("accepts a unique supported-operation list and rejects malformed catalogs", () => {
    const opened = responses[1];
    if (opened?.kind !== "sessionOpened") throw new Error("Expected the session-opened fixture.");
    const limited = {
      ...opened,
      metadata: {
        ...opened.metadata,
        capabilities: { ...capabilities, supportedOperations: ["renameColumn"] }
      }
    };

    expect(isOpenWranglerResponse(limited)).toBe(true);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "limited-operations", response: limited })).toBe(
      true
    );
    for (const supportedOperations of [["renameColumn", "renameColumn"], ["futureOperation"], "renameColumn"]) {
      const malformed = {
        ...limited,
        metadata: {
          ...limited.metadata,
          capabilities: { ...limited.metadata.capabilities, supportedOperations }
        }
      };
      expect(isOpenWranglerResponse(malformed)).toBe(false);
      expect(
        validateTransportSchema({ protocolVersion: 2, requestId: "malformed-operations", response: malformed })
      ).toBe(false);
    }
  });

  it("rejects empty, duplicate, or positionally ambiguous schema identities", () => {
    const otherColumn = {
      id: "column:1",
      name: "other",
      position: 1,
      rawType: "String",
      type: "string" as const,
      nullable: false
    };
    const malformedSchemas = [
      [{ ...metadata.schema[0], id: "" }],
      [metadata.schema[0], { ...otherColumn, id: metadata.schema[0].id }],
      [metadata.schema[0], { ...otherColumn, position: 0 }],
      [metadata.schema[0], { ...otherColumn, position: 2 }],
      [
        { ...metadata.schema[0], position: 1 },
        { ...otherColumn, position: 0 }
      ]
    ];

    for (const schema of malformedSchemas) {
      expect(
        isOpenWranglerResponse({
          kind: "sessionOpened",
          metadata: { ...metadata, schema },
          page,
          summaries
        })
      ).toBe(false);
      expect(
        isOpenWranglerResponse({
          kind: "sessionOpened",
          metadata: { ...metadata, latestStepInputSchema: schema },
          page,
          summaries
        })
      ).toBe(false);
    }

    const inspection = responses.find((response) => response.kind === "stepInspection");
    expect(inspection).toBeDefined();
    expect(
      isOpenWranglerResponse({
        ...inspection,
        outputSchema: [metadata.schema[0], { ...otherColumn, id: metadata.schema[0].id }]
      })
    ).toBe(false);
  });

  it("requires a recorded latest-step input schema only when applied steps exist", () => {
    const metadataWithoutLatest = { ...metadata };
    delete metadataWithoutLatest.latestStepInputSchema;

    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: metadataWithoutLatest,
        page,
        summaries
      })
    ).toBe(false);

    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: {
          ...metadataWithoutLatest,
          steps: [],
          draftStep: { id: "first-draft", kind: "floorNumber", params: { column: valueReference } }
        },
        page,
        summaries
      })
    ).toBe(true);
  });

  it("rejects malformed pages, rows, and typed cells", () => {
    const pageResponse = (invalidPage: unknown): unknown => ({
      kind: "page",
      revision: 3,
      viewRequestId: "view-1",
      metadata,
      page: invalidPage
    });
    expect(isOpenWranglerResponse(pageResponse({ ...page, limit: 0 }))).toBe(false);
    expect(isOpenWranglerResponse(pageResponse({ ...page, columnIds: ["column:0", "column:0"] }))).toBe(false);
    expect(isOpenWranglerResponse(pageResponse({ ...page, columnIds: ["unknown"] }))).toBe(false);
    expect(isOpenWranglerResponse(pageResponse({ ...page, rows: [{ ...page.rows[0], rowLabel: "Mazda RX4" }] }))).toBe(
      true
    );
    expect(
      isOpenWranglerResponse(pageResponse({ ...page, rows: [{ ...page.rows[0], rowLabel: "🚙".repeat(1_024) }] }))
    ).toBe(true);
    expect(
      isOpenWranglerResponse(pageResponse({ ...page, rows: [{ ...page.rows[0], rowLabel: "x".repeat(1_025) }] }))
    ).toBe(false);
    expect(isOpenWranglerResponse(pageResponse({ ...page, rows: [{ ...page.rows[0], rowLabel: 1 }] }))).toBe(false);
    expect(isOpenWranglerResponse(pageResponse({ ...page, rows: [{ id: "row:0", rowNumber: -1, values: [] }] }))).toBe(
      false
    );
    expect(
      isOpenWranglerResponse(
        pageResponse({
          ...page,
          rows: [
            {
              id: "row:0",
              rowNumber: 0,
              values: [{ kind: "integer", display: 1, isNull: false, isNaN: false }]
            }
          ]
        })
      )
    ).toBe(false);
  });

  it("accepts unknown totals only for full progressive PySpark pages", () => {
    const { latestStepInputSchema: _latestStepInputSchema, stats: _stats, ...metadataWithoutEditingState } = metadata;
    const sparkMetadata: SessionMetadata = {
      ...metadataWithoutEditingState,
      backend: "pyspark",
      mode: "viewing",
      source: { kind: "notebookVariable", label: "spark_df", variableName: "spark_df" },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: null, columns: 1 },
      filteredShape: { rows: null, columns: 1 },
      filterModel: { logic: "and", filters: [], sort: [] },
      steps: []
    };
    const progressivePage: LiveGridPage = { ...page, limit: 1, totalRows: null, hasMore: true };
    const opened = { kind: "sessionOpened", metadata: sparkMetadata, page: progressivePage, summaries: [] };

    expect(isOpenWranglerResponse(opened)).toBe(true);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "spark-open", response: opened })).toBe(true);
    expect(isOpenWranglerResponse({ ...opened, metadata: { ...sparkMetadata, backend: "polars" } })).toBe(false);
    expect(isOpenWranglerResponse({ ...opened, page: { ...progressivePage, hasMore: false } })).toBe(false);
    expect(isOpenWranglerResponse({ ...opened, page: { ...progressivePage, rows: [] } })).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...opened,
        metadata: {
          ...sparkMetadata,
          shape: { rows: 1, columns: 1 },
          filteredShape: { rows: 1, columns: 1 }
        },
        page
      })
    ).toBe(true);
  });

  it("requires projected columns to follow schema order with exact row widths", () => {
    const secondColumn = {
      id: "column:1",
      name: "other",
      position: 1,
      rawType: "String",
      type: "string" as const,
      nullable: false
    };
    const projectedMetadata = {
      ...metadata,
      shape: { rows: 1, columns: 2 },
      filteredShape: { rows: 1, columns: 2 },
      schema: [metadata.schema[0], secondColumn]
    };
    const projectedResponse = (columnIds: string[], width = columnIds.length): unknown => ({
      kind: "page",
      revision: 3,
      viewRequestId: "view-1",
      metadata: projectedMetadata,
      page: {
        ...page,
        columnIds,
        rows: [{ ...page.rows[0], values: Array.from({ length: width }, () => page.rows[0].values[0]) }]
      }
    });

    expect(isOpenWranglerResponse(projectedResponse(["column:0", "column:1"]))).toBe(true);
    expect(isOpenWranglerResponse(projectedResponse(["column:1", "column:0"]))).toBe(false);
    expect(isOpenWranglerResponse(projectedResponse(["column:0", "column:1"], 1))).toBe(false);
  });

  it("requires summary identities and session-open summaries to match their schema", () => {
    const response = { kind: "summary", revision: 3, viewRequestId: "view-1", summaries } as const;
    const summary = summaries[0];
    expect(isOpenWranglerResponse({ ...response, summaries: [{ ...summary, columnId: undefined }] })).toBe(false);
    expect(isOpenWranglerResponse({ ...response, summaries: [summary, summary] })).toBe(false);
    expect(isOpenWranglerResponse({ ...response, summaries: [{ ...summary, sampled: false }] })).toBe(false);

    for (const changed of [
      { ...summary, columnId: "unknown" },
      { ...summary, column: "other" },
      { ...summary, type: "string" as const },
      { ...summary, rawType: "String" }
    ]) {
      expect(
        isOpenWranglerResponse({
          kind: "sessionOpened",
          metadata,
          page,
          summaries: [changed]
        })
      ).toBe(false);
    }
  });

  it("accepts paired lossless integer and decimal extrema and rejects incompatible or malformed pairs", () => {
    const response = (summary: unknown): unknown => ({
      kind: "summary",
      revision: 3,
      viewRequestId: "view-exact-extrema",
      summaries: [summary]
    });
    const integerCell = (value: string) => ({
      kind: "integer",
      raw: value,
      display: value,
      isNull: false,
      isNaN: false
    });
    const decimalCell = (value: string) => ({
      kind: "decimal",
      raw: value,
      display: value,
      isNull: false,
      isNaN: false
    });
    const integerSummary = {
      ...summaries[0],
      numeric: {
        ...summaries[0].numeric,
        exactMin: integerCell("-900719925474099312345678901"),
        exactMax: integerCell("900719925474099312345678902")
      }
    };
    const decimalSummary = {
      ...integerSummary,
      type: "decimal" as const,
      rawType: "Decimal(38,18)",
      numeric: {
        min: -1.2345678901234567,
        max: 9.876543210987654,
        exactMin: decimalCell("-1.234567890123456789"),
        exactMax: decimalCell("9.876543210987654321")
      }
    };

    expect(isOpenWranglerResponse(response(integerSummary))).toBe(true);
    expect(isOpenWranglerResponse(response(decimalSummary))).toBe(true);
    expect(
      isOpenWranglerResponse(
        response({
          ...decimalSummary,
          numeric: {
            exactMin: decimalCell("-9E+999999999999999999"),
            exactMax: decimalCell("9E+999999999999999999")
          }
        })
      )
    ).toBe(true);
    expect(
      isOpenWranglerResponse(
        response({
          ...decimalSummary,
          numeric: { min: 1 }
        })
      )
    ).toBe(true);

    const malformedPairs = [
      { ...integerSummary.numeric, exactMax: undefined },
      { ...integerSummary.numeric, exactMin: undefined },
      {
        ...integerSummary.numeric,
        exactMin: { ...integerSummary.numeric.exactMin, isNull: true, kind: "null", raw: null, display: "" }
      },
      {
        ...integerSummary.numeric,
        exactMin: { ...integerSummary.numeric.exactMin, isNaN: true, kind: "nan", raw: null, display: "NaN" }
      },
      {
        ...integerSummary.numeric,
        exactMin: { ...integerSummary.numeric.exactMin, raw: 9_007_199_254_740_992, display: "9007199254740992" }
      },
      {
        ...integerSummary.numeric,
        exactMin: integerCell("900719925474099312345678903"),
        exactMax: integerCell("900719925474099312345678902")
      },
      {
        ...integerSummary.numeric,
        exactMin: { ...integerSummary.numeric.exactMin, unexpected: true }
      }
    ];
    for (const numeric of malformedPairs) {
      expect(isOpenWranglerResponse(response({ ...integerSummary, numeric }))).toBe(false);
    }

    expect(
      isOpenWranglerResponse(
        response({
          ...integerSummary,
          type: "float",
          rawType: "Float64"
        })
      )
    ).toBe(false);
    expect(
      isOpenWranglerResponse(
        response({
          ...decimalSummary,
          numeric: {
            ...decimalSummary.numeric,
            exactMin: decimalCell("2.000000000000000000"),
            exactMax: decimalCell("1.999999999999999999")
          }
        })
      )
    ).toBe(false);
    expect(
      isOpenWranglerResponse(
        response({
          ...decimalSummary,
          numeric: {
            ...decimalSummary.numeric,
            exactMin: decimalCell("not-a-decimal")
          }
        })
      )
    ).toBe(false);
    expect(
      isOpenWranglerResponse(
        response({
          ...decimalSummary,
          numeric: {
            exactMin: decimalCell("10e9007199254740991"),
            exactMax: decimalCell("1e9007199254740991")
          }
        })
      )
    ).toBe(false);
    for (const [exactMin, exactMax] of [
      [decimalCell("-Infinity"), decimalCell("1")],
      [decimalCell("1"), decimalCell("Infinity")],
      [decimalCell("-Infinity"), decimalCell("Infinity")]
    ]) {
      expect(
        isOpenWranglerResponse(
          response({
            ...decimalSummary,
            numeric: { exactMin, exactMax }
          })
        )
      ).toBe(false);
    }

    const maximumLengthDecimal = "9".repeat(65_536);
    expect(
      isOpenWranglerResponse(
        response({
          ...decimalSummary,
          numeric: {
            exactMin: decimalCell(`-${"9".repeat(65_535)}`),
            exactMax: decimalCell(maximumLengthDecimal)
          }
        })
      )
    ).toBe(true);
    expect(
      isOpenWranglerResponse(
        response({
          ...decimalSummary,
          numeric: {
            exactMin: decimalCell("0"),
            exactMax: decimalCell(`${maximumLengthDecimal}9`)
          }
        })
      )
    ).toBe(false);
  });

  it("accepts backward-compatible and exact text summaries while rejecting malformed metrics", () => {
    const response = (summary: unknown): unknown => ({
      kind: "summary",
      revision: 3,
      viewRequestId: "view-1",
      summaries: [summary]
    });
    const textSummary = {
      columnId: "column:text",
      column: "text",
      type: "string" as const,
      rawType: "String",
      totalCount: 6,
      nullCount: 1,
      nanCount: 0,
      distinctCount: 5,
      topValues: [],
      text: { emptyCount: 1, minLength: 0, maxLength: 2, meanLength: 1 }
    };

    expect(isOpenWranglerResponse(response(textSummary))).toBe(true);
    const { text: omittedText, ...legacySummary } = textSummary;
    expect(omittedText.emptyCount).toBe(1);
    expect(isOpenWranglerResponse(response(legacySummary))).toBe(true);
    expect(
      isOpenWranglerResponse(
        response({
          ...textSummary,
          totalCount: 2,
          nullCount: 2,
          distinctCount: 0,
          text: { emptyCount: 0 }
        })
      )
    ).toBe(true);
    expect(
      isOpenWranglerResponse(
        response({
          ...textSummary,
          text: { emptyCount: 5, minLength: 0, maxLength: 0, meanLength: 0 }
        })
      )
    ).toBe(true);

    for (const text of [
      { emptyCount: -1, minLength: 0, maxLength: 2, meanLength: 1 },
      { emptyCount: 1, minLength: -1, maxLength: 2, meanLength: 1 },
      { emptyCount: 1, minLength: 0 },
      { emptyCount: 1, minLength: 0, maxLength: 2 },
      { emptyCount: 1, minLength: 0, maxLength: 2, meanLength: -1 },
      { emptyCount: 1, minLength: 0, maxLength: 2, meanLength: 3 },
      { emptyCount: 6, minLength: 0, maxLength: 2, meanLength: 1 },
      { emptyCount: 0, minLength: 0, maxLength: 2, meanLength: 1 },
      { emptyCount: 1, minLength: 1, maxLength: 2, meanLength: 1.5 },
      { emptyCount: 5, minLength: 0, maxLength: 2, meanLength: 1 }
    ]) {
      expect(isOpenWranglerResponse(response({ ...textSummary, text }))).toBe(false);
    }

    expect(isOpenWranglerResponse(response({ ...textSummary, text: { emptyCount: 1 } }))).toBe(false);
    expect(
      isOpenWranglerResponse(
        response({
          ...textSummary,
          totalCount: 2,
          nullCount: 2,
          distinctCount: 0,
          text: { emptyCount: 0, minLength: 0, maxLength: 0, meanLength: 0 }
        })
      )
    ).toBe(false);
    expect(isOpenWranglerResponse(response({ ...summaries[0], text: textSummary.text }))).toBe(false);
  });

  it("binds changed-cell identities and labels to the output schema", () => {
    const preview = responses.find((response) => response.kind === "stepPreview");
    expect(preview?.kind).toBe("stepPreview");
    if (preview?.kind !== "stepPreview") return;
    const cell = preview.diff.cells[0];

    expect(
      isOpenWranglerResponse({ ...preview, diff: { ...preview.diff, cells: [{ ...cell, columnId: "unknown" }] } })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({ ...preview, diff: { ...preview.diff, cells: [{ ...cell, column: "other" }] } })
    ).toBe(false);

    const inspection = responses.find((response) => response.kind === "stepInspection");
    expect(inspection?.kind).toBe("stepInspection");
    if (inspection?.kind !== "stepInspection") return;
    expect(
      isOpenWranglerResponse({
        ...inspection,
        diff: {
          ...inspection.diff,
          changedCells: 1,
          cells: [{ rowNumber: 0, columnId: "unknown", column: "value", before: null, after: null }]
        }
      })
    ).toBe(false);
  });

  it("rejects incomplete and cross-variant response payloads", () => {
    expect(isOpenWranglerResponse({ kind: "summary", revision: 1, viewRequestId: "view-1" })).toBe(false);
    expect(isOpenWranglerResponse({ kind: "datasetStats", revision: 1, viewRequestId: "view-1", stats: {} })).toBe(
      false
    );
    expect(
      isOpenWranglerResponse({
        kind: "columnValues",
        revision: 1,
        viewRequestId: "view-1",
        column: "value",
        values: [{ value: "1", count: -1 }],
        hasMore: false
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({ kind: "planUpdated", action: "preview", revision: 1, metadata, page, code: "" })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "stepInspection",
        revision: 3,
        stepId: "step-1",
        stepIndex: 0,
        inputPage: page,
        outputPage: page,
        inputSchema: metadata.schema,
        outputSchema: [{ ...metadata.schema[0], position: -1 }],
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
      })
    ).toBe(false);
    expect(isOpenWranglerResponse({ kind: "error", code: "bad", message: "bad", recoverable: "yes" })).toBe(false);
  });

  it("accepts only versioned, bounded, type-compatible value-selection tokens", () => {
    const token = {
      kind: "typedSelection",
      version: 1,
      columnType: "string",
      cell: { kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }
    };
    const response = {
      kind: "columnValues",
      revision: 1,
      viewRequestId: "view-1",
      column: "value",
      values: [{ value: "1", count: 4, selectionValue: token }],
      hasMore: false
    };
    const astralAtLimit = "😀".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS);
    expect(isOpenWranglerResponse(response)).toBe(true);
    expect(
      isOpenWranglerResponse({
        ...response,
        values: [
          {
            value: "astral",
            count: 1,
            selectionValue: {
              ...token,
              cell: { kind: "string", raw: astralAtLimit, display: astralAtLimit, isNull: false, isNaN: false }
            }
          }
        ]
      })
    ).toBe(true);
    expect(
      isOpenWranglerResponse({
        ...response,
        values: [
          {
            value: "2024-01-01",
            count: 1,
            selectionValue: {
              ...token,
              cell: {
                kind: "date",
                raw: "2024-01-01",
                display: "2024-01-01",
                isNull: false,
                isNaN: false
              }
            }
          }
        ]
      })
    ).toBe(true);
    expect(
      isOpenWranglerResponse({
        ...response,
        values: [{ value: "1", count: 4, selectionValue: { ...token, version: 2 } }]
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...response,
        values: [
          {
            value: "astral",
            count: 1,
            selectionValue: {
              ...token,
              cell: {
                kind: "string",
                raw: `${astralAtLimit}😀`,
                display: `${astralAtLimit}😀`,
                isNull: false,
                isNaN: false
              }
            }
          }
        ]
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...response,
        values: [
          {
            value: "nested",
            count: 1,
            selectionValue: {
              ...token,
              cell: { kind: "struct", raw: { value: 1 }, display: '{"value":1}', isNull: false, isNaN: false }
            }
          }
        ]
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...response,
        values: [{ value: "1", count: 4, selectionValue: { ...token, columnType: "float" } }]
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...response,
        values: [
          {
            value: "1",
            count: 4,
            selectionValue: { ...token, cell: { ...token.cell, display: "x".repeat(65_537) } }
          }
        ]
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...response,
        values: [
          {
            value: "1",
            count: 4,
            selectionValue: { ...token, cell: { ...token.cell, isNull: true } }
          }
        ]
      })
    ).toBe(false);
  });

  it("does not accept a response as an envelope", () => {
    const responseEnvelope: RuntimeResponseEnvelope = {
      protocolVersion: 2,
      requestId: "request-1",
      response: responses[0]
    };
    expect(isOpenWranglerResponse(responseEnvelope)).toBe(false);
  });
});

const requests: OpenWranglerRequest[] = [
  { kind: "initialize" },
  {
    kind: "openSession",
    source: metadata.source,
    requestedSessionId: "runtime-candidate",
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
  { kind: "exportData", sessionId: "session-1", revision: 3, path: "/tmp/out.csv", format: "csv" },
  { kind: "closeSession", sessionId: "session-1", revision: 3 },
  { kind: "cancelRequest", targetRequestId: "request-1" }
];

describe("protocol-v2 request validation", () => {
  it.each(requests.map((request) => [request.kind, request] as const))(
    "accepts a structurally complete %s request",
    (_kind, request) => {
      expect(isOpenWranglerRequest(request)).toBe(true);
      expect(
        isRuntimeRequestEnvelope({
          protocolVersion: 2,
          requestId: `request-${request.kind}`,
          priority: "interactive",
          request
        })
      ).toBe(true);
    }
  );

  it("keeps host runtime identity outside every protocol-v2 payload", () => {
    const runtimeIdentity = runtimeIdentityForDataBackend("polars");
    const openRequest = requests.find((request) => request.kind === "openSession");
    const openedResponse = responses.find((response) => response.kind === "sessionOpened");
    if (!openRequest || !openedResponse) throw new Error("Expected canonical open fixtures.");

    expect(isOpenWranglerRequest({ ...openRequest, runtimeIdentity })).toBe(false);
    expect(isOpenWranglerResponse({ ...openedResponse, runtimeIdentity })).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...openedResponse,
        metadata: { ...openedResponse.metadata, runtimeIdentity }
      })
    ).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "request-private-runtime-identity",
        priority: "interactive",
        request: { ...openRequest, runtimeIdentity }
      })
    ).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "response-private-runtime-identity",
        response: { ...openedResponse, runtimeIdentity }
      })
    ).toBe(false);
  });

  it("accepts DuckDB as a first-class file backend", () => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source: metadata.source,
        backend: "duckdb",
        mode: "editing",
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(true);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: { ...metadata, backend: "duckdb" } })).toBe(true);
  });

  it("accepts PySpark only for live notebook variables", () => {
    const source = {
      kind: "notebookVariable" as const,
      label: "spark_frame",
      variableName: "spark_frame",
      uri: "file:///workspace/notebook.ipynb"
    };
    const request = {
      kind: "openSession" as const,
      source,
      backend: "pyspark" as const,
      mode: "viewing" as const,
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    };
    const sparkMetadata = {
      ...metadata,
      backend: "pyspark" as const,
      mode: "viewing" as const,
      source,
      capabilities: {
        editable: false,
        lazy: true,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      steps: []
    };

    expect(isOpenWranglerRequest(request)).toBe(true);
    expect(isOpenWranglerRequest({ ...request, mode: "editing" })).toBe(false);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: sparkMetadata })).toBe(true);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: { ...sparkMetadata, mode: "editing" } })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, source: metadata.source })).toBe(false);
    expect(
      isOpenWranglerRequest({
        ...request,
        source: { kind: "notebookOutput", label: "saved Spark output" }
      })
    ).toBe(false);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: { ...sparkMetadata, source: metadata.source } })).toBe(
      false
    );
  });

  it("keeps identified live R notebook frames valid in either session mode", () => {
    const source = {
      kind: "notebookVariable" as const,
      label: "r_frame",
      variableName: "r_frame",
      uri: "file:///workspace/notebook.ipynb"
    };
    const request = {
      kind: "openSession" as const,
      source,
      backend: "r" as const,
      mode: "viewing" as const,
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    };
    const { latestStepInputSchema: _latest, stats: _stats, ...viewingMetadata } = metadata;
    const rMetadata = {
      ...viewingMetadata,
      backend: "r" as const,
      rDataframeFlavor: "r.tibble" as const,
      mode: "viewing" as const,
      source,
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false,
        filter: false,
        sort: true,
        profile: true,
        columnValues: false,
        supportedOperations: ["renameColumn"]
      },
      filterModel: { logic: "and" as const, filters: [], sort: [] },
      steps: []
    };
    const opened = { ...responses[1], metadata: rMetadata, summaries: [] };

    expect(isOpenWranglerRequest(request)).toBe(true);
    expect(isOpenWranglerRequest({ ...request, mode: "editing" })).toBe(true);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-editing-open",
        priority: "interactive",
        request: { ...request, mode: "editing" }
      })
    ).toBe(true);
    expect(isOpenWranglerRequest({ ...request, source: metadata.source })).toBe(false);
    expect(isOpenWranglerResponse(opened)).toBe(true);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "r-open", response: opened })).toBe(true);
    for (const invalidSource of [
      { kind: "file" as const, label: "frame.csv", path: "/workspace/frame.csv" },
      { kind: "notebookOutput" as const, label: "saved R output" }
    ]) {
      const invalidOpened = { ...opened, metadata: { ...rMetadata, source: invalidSource } };
      expect(isOpenWranglerResponse(invalidOpened)).toBe(false);
      expect(
        validateTransportSchema({ protocolVersion: 2, requestId: `r-${invalidSource.kind}`, response: invalidOpened })
      ).toBe(false);
    }
    const { rDataframeFlavor: _rDataframeFlavor, ...rMetadataWithoutFlavor } = rMetadata;
    const rWithoutFlavor = { ...opened, metadata: rMetadataWithoutFlavor };
    expect(isOpenWranglerResponse(rWithoutFlavor)).toBe(false);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "r-no-flavor", response: rWithoutFlavor })).toBe(
      false
    );
    const editingOpened = { ...opened, metadata: { ...rMetadata, mode: "editing" as const } };
    expect(isOpenWranglerResponse(editingOpened)).toBe(true);
    expect(
      validateTransportSchema({ protocolVersion: 2, requestId: "r-editing-opened", response: editingOpened })
    ).toBe(true);
    const nonRWithFlavor = { ...responses[1], metadata: { ...metadata, rDataframeFlavor: "r.tibble" as const } };
    expect(isOpenWranglerResponse(nonRWithFlavor)).toBe(false);
    expect(
      validateTransportSchema({ protocolVersion: 2, requestId: "python-r-flavor", response: nonRWithFlavor })
    ).toBe(false);
    const insertableNotebookOpened = {
      ...opened,
      metadata: {
        ...rMetadata,
        capabilities: { ...rMetadata.capabilities, notebookInsert: true, documentInsert: false }
      }
    };
    expect(isOpenWranglerResponse(insertableNotebookOpened)).toBe(true);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-notebook-insertion",
        response: insertableNotebookOpened
      })
    ).toBe(true);
    const notebookWithDocumentInsertion = {
      ...opened,
      metadata: { ...rMetadata, capabilities: { ...rMetadata.capabilities, documentInsert: true } }
    };
    expect(isOpenWranglerResponse(notebookWithDocumentInsertion)).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-notebook-wrong-insertion",
        response: notebookWithDocumentInsertion
      })
    ).toBe(false);
  });

  it("accepts an identified R document variable only with its canonical source URI", () => {
    const source = {
      kind: "documentVariable" as const,
      label: "orders",
      variableName: "orders",
      uri: "file:///workspace/analysis.R"
    };
    const request = {
      kind: "openSession" as const,
      source,
      backend: "r" as const,
      mode: "editing" as const,
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    };
    const rMetadata = {
      ...metadata,
      backend: "r" as const,
      rDataframeFlavor: "r.data.table" as const,
      source,
      capabilities: { ...metadata.capabilities, documentInsert: true }
    };
    const opened = { ...responses[1], metadata: rMetadata };
    const requestEnvelope = (candidate: unknown) => ({
      protocolVersion: 2,
      requestId: "r-document-open",
      priority: "interactive",
      request: candidate
    });

    expect(isOpenWranglerRequest(request)).toBe(true);
    expect(validateTransportSchema(requestEnvelope(request))).toBe(true);
    expect(isOpenWranglerResponse(opened)).toBe(true);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "r-document-opened", response: opened })).toBe(
      true
    );

    const remoteSource = {
      ...source,
      uri: "vscode-remote://ssh-remote+workstation/workspace/analysis.R"
    };
    expect(isOpenWranglerRequest({ ...request, source: remoteSource })).toBe(true);
    expect(validateTransportSchema(requestEnvelope({ ...request, source: remoteSource }))).toBe(true);
    const encodedSource = { ...source, uri: "file:///workspace/r%C3%A9sum%C3%A9%20analysis.R" };
    expect(isOpenWranglerRequest({ ...request, source: encodedSource })).toBe(true);
    expect(validateTransportSchema(requestEnvelope({ ...request, source: encodedSource }))).toBe(true);

    const documentInsertionDisabled = {
      ...opened,
      metadata: { ...rMetadata, capabilities: { ...rMetadata.capabilities, documentInsert: false } }
    };
    expect(isOpenWranglerResponse(documentInsertionDisabled)).toBe(true);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-document-insertion-disabled",
        response: documentInsertionDisabled
      })
    ).toBe(true);
    const malformedDocumentInsertion = {
      ...opened,
      metadata: { ...rMetadata, capabilities: { ...rMetadata.capabilities, documentInsert: "yes" } }
    };
    expect(isOpenWranglerResponse(malformedDocumentInsertion)).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-document-insertion-malformed",
        response: malformedDocumentInsertion
      })
    ).toBe(false);
    const documentWithNotebookInsertion = {
      ...opened,
      metadata: { ...rMetadata, capabilities: { ...rMetadata.capabilities, notebookInsert: true } }
    };
    expect(isOpenWranglerResponse(documentWithNotebookInsertion)).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-document-wrong-insertion",
        response: documentWithNotebookInsertion
      })
    ).toBe(false);

    const invalidSources: unknown[] = [
      { kind: "documentVariable", label: "orders", uri: source.uri },
      { kind: "documentVariable", label: "orders", variableName: "", uri: source.uri },
      { kind: "documentVariable", label: "orders", variableName: "orders" },
      { ...source, uri: "" },
      { ...source, uri: "/workspace/analysis.R" },
      { ...source, uri: "FILE:///workspace/analysis.R" },
      { ...source, uri: "file:///workspace/analysis data.R" },
      { ...source, uri: "file:///workspace/%zz.R" },
      { ...source, path: "/workspace/analysis.R" },
      { ...source, importOptions: {} }
    ];
    for (const invalidSource of invalidSources) {
      const invalidRequest = { ...request, source: invalidSource };
      const invalidOpened = { ...opened, metadata: { ...rMetadata, source: invalidSource } };
      expect(isOpenWranglerRequest(invalidRequest)).toBe(false);
      expect(validateTransportSchema(requestEnvelope(invalidRequest))).toBe(false);
      expect(isOpenWranglerResponse(invalidOpened)).toBe(false);
      expect(
        validateTransportSchema({ protocolVersion: 2, requestId: "invalid-r-document-opened", response: invalidOpened })
      ).toBe(false);
    }

    const sparkRequest = { ...request, backend: "pyspark" as const, mode: "viewing" as const };
    expect(isOpenWranglerRequest(sparkRequest)).toBe(false);
    expect(validateTransportSchema(requestEnvelope(sparkRequest))).toBe(false);
    const { rDataframeFlavor: _rDataframeFlavor, ...metadataWithoutRFlavor } = rMetadata;
    const sparkOpened = {
      ...opened,
      metadata: { ...metadataWithoutRFlavor, backend: "pyspark" as const, mode: "viewing" as const }
    };
    expect(isOpenWranglerResponse(sparkOpened)).toBe(false);
    expect(
      validateTransportSchema({ protocolVersion: 2, requestId: "spark-document-opened", response: sparkOpened })
    ).toBe(false);
  });

  it("accepts only unique, non-empty stable IDs in summary projections", () => {
    const request = requests.find((candidate) => candidate.kind === "getSummary");
    expect(request?.kind).toBe("getSummary");
    if (request?.kind !== "getSummary") return;

    expect(isOpenWranglerRequest({ ...request, columnIds: ["column:0", "column:1"] })).toBe(true);
    expect(isOpenWranglerRequest({ ...request, columnIds: [] })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, columnIds: ["column:0", "column:0"] })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, columnIds: [""] })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, columns: ["value"] })).toBe(false);
  });

  it.each(["getPage", "getSummary", "getDatasetStats", "getColumnValues"] as const)(
    "rejects duplicate viewing sort columns in %s requests",
    (kind) => {
      const request = requests.find((candidate) => candidate.kind === kind);
      expect(request?.kind).toBe(kind);
      if (!request || !("filterModel" in request)) return;

      expect(
        isOpenWranglerRequest({
          ...request,
          filterModel: {
            filters: [],
            sort: [
              { column: "value", direction: "asc", nulls: "last" },
              { column: "value", direction: "desc", nulls: "first" }
            ]
          }
        })
      ).toBe(false);
    }
  );

  it("validates aggregate, same-row fallback, and typed fill-missing replacements", () => {
    const fillStep = (replacement: unknown) => ({
      id: "fill-value",
      kind: "fillMissingValues",
      params: { column: valueReference, replacement }
    });
    const previewEnvelope = (replacement: unknown) => ({
      protocolVersion: 2,
      requestId: "preview-fill",
      priority: "interactive",
      request: {
        kind: "previewStep",
        sessionId: "session-1",
        revision: 0,
        step: fillStep(replacement),
        offset: 0,
        limit: 200,
        columnOffset: 0,
        columnLimit: 64
      }
    });
    const validReplacements = [
      { kind: "median" },
      { kind: "mostFrequent" },
      {
        kind: "fallbackColumns",
        columns: [otherReference, { id: "column:2", name: "third" }]
      },
      { kind: "string", value: "" },
      { kind: "integer", value: "99999999999999999999999999999999999999" },
      { kind: "float", value: "-1.25e+3" },
      { kind: "decimal", value: "0.00000000000000000000000000000000000001" },
      { kind: "boolean", value: true },
      { kind: "date", value: "2024-02-29" },
      { kind: "datetime", value: "2026-08-05T18:20:00+02:00" }
    ];

    for (const replacement of validReplacements) {
      expect(isTransformStep(fillStep(replacement)), replacement.kind).toBe(true);
      expect(validateTransportSchema(previewEnvelope(replacement)), replacement.kind).toBe(true);
    }

    for (const replacement of [
      { kind: "median", value: 1 },
      { kind: "mostFrequent", value: "x" },
      { kind: "integer", value: "01" },
      { kind: "integer", value: "100000000000000000000000000000000000000" },
      { kind: "float", value: "NaN" },
      { kind: "decimal", value: "999999999999999999999999999999999999999" },
      { kind: "boolean", value: "true" },
      { kind: "date", value: "2023-02-29" },
      { kind: "datetime", value: "2026-08-05T25:00" },
      { kind: "future", value: "x" },
      { kind: "string", value: "x", extra: true },
      { kind: "fallbackColumns", columns: [] },
      { kind: "fallbackColumns", columns: ["other"] },
      { kind: "fallbackColumns", columns: [otherReference], extra: true }
    ]) {
      expect(isTransformStep(fillStep(replacement)), JSON.stringify(replacement)).toBe(false);
    }

    const duplicateFallback = { kind: "fallbackColumns", columns: [otherReference, otherReference] };
    expect(isTransformStep(fillStep(duplicateFallback))).toBe(false);
    expect(validateTransportSchema(previewEnvelope(duplicateFallback))).toBe(false);

    expect(
      isTransformStep(
        fillStep({
          kind: "fallbackColumns",
          columns: [otherReference, { id: otherReference.id, name: "renamed-other" }]
        })
      )
    ).toBe(false);
    expect(isTransformStep(fillStep({ kind: "fallbackColumns", columns: [valueReference] }))).toBe(false);

    const tooManyFallbacks = {
      kind: "fallbackColumns",
      columns: Array.from({ length: 65 }, (_, index) => ({ id: `column:${index + 1}`, name: `fallback_${index}` }))
    };
    expect(isTransformStep(fillStep(tooManyFallbacks))).toBe(false);
    expect(validateTransportSchema(previewEnvelope(tooManyFallbacks))).toBe(false);

    for (const replacement of [null, [], { kind: "string" }]) {
      expect(isTransformStep(fillStep(replacement))).toBe(false);
      expect(validateTransportSchema(previewEnvelope(replacement))).toBe(false);
    }
  });

  it("bounds viewing and transform scalar text by Unicode code points across TypeScript and JSON Schema", () => {
    const request = requests.find((candidate) => candidate.kind === "getPage");
    expect(request?.kind).toBe("getPage");
    if (request?.kind !== "getPage") return;

    const filterModel = (value: string, secondValue: string, selectedValue: string) => ({
      filters: [
        {
          column: "value",
          type: "decimal" as const,
          valueFilter: {
            kind: "values" as const,
            selectedValues: [selectedValue],
            includeNulls: false,
            includeNaN: false
          },
          predicates: [{ kind: "predicate" as const, operator: "between" as const, value, secondValue }]
        }
      ],
      sort: []
    });

    const transformStep = (value: string, secondValue: string, selectedValue: string) => ({
      id: "filter-bounded",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [
            {
              column: valueReference,
              type: "decimal",
              valueFilter: {
                kind: "values",
                selectedValues: [selectedValue],
                includeNulls: false,
                includeNaN: false
              },
              predicates: [{ kind: "predicate", operator: "between", value, secondValue }]
            }
          ],
          sort: []
        }
      }
    });
    const transportEnvelope = (requestValue: unknown) => ({
      protocolVersion: 2,
      requestId: "bounded-filter",
      priority: "interactive",
      request: requestValue
    });
    const previewRequest = (value: string, secondValue: string, selectedValue: string) => ({
      kind: "previewStep",
      sessionId: "session-1",
      revision: 0,
      step: transformStep(value, secondValue, selectedValue),
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 64
    });
    const cases = [
      {
        label: "BMP",
        atLimit: `1e${"9".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS - 2)}`,
        overLimit: `1e${"9".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS - 1)}`
      },
      {
        label: "non-BMP",
        atLimit: "😀".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS),
        overLimit: "😀".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS + 1)
      }
    ];

    for (const { label, atLimit, overLimit } of cases) {
      const validModel = filterModel(atLimit, atLimit, atLimit);
      expect(isOpenWranglerRequest({ ...request, filterModel: validModel }), label).toBe(true);
      expect(validateTransportSchema(transportEnvelope({ ...request, filterModel: validModel })), label).toBe(true);
      expect(isOpenWranglerRequest({ ...request, filterModel: filterModel(overLimit, atLimit, atLimit) }), label).toBe(
        false
      );
      expect(
        validateTransportSchema(
          transportEnvelope({ ...request, filterModel: filterModel(overLimit, atLimit, atLimit) })
        ),
        label
      ).toBe(false);
      expect(isOpenWranglerRequest({ ...request, filterModel: filterModel(atLimit, overLimit, atLimit) }), label).toBe(
        false
      );
      expect(
        validateTransportSchema(
          transportEnvelope({ ...request, filterModel: filterModel(atLimit, overLimit, atLimit) })
        ),
        label
      ).toBe(false);
      expect(isOpenWranglerRequest({ ...request, filterModel: filterModel(atLimit, atLimit, overLimit) }), label).toBe(
        false
      );
      expect(
        validateTransportSchema(
          transportEnvelope({ ...request, filterModel: filterModel(atLimit, atLimit, overLimit) })
        ),
        label
      ).toBe(false);

      const validStep = transformStep(atLimit, atLimit, atLimit);
      expect(isTransformStep(validStep), label).toBe(true);
      expect(validateTransportSchema(transportEnvelope(previewRequest(atLimit, atLimit, atLimit))), label).toBe(true);
      for (const invalidValues of [
        [overLimit, atLimit, atLimit],
        [atLimit, overLimit, atLimit],
        [atLimit, atLimit, overLimit]
      ] as const) {
        expect(isTransformStep(transformStep(...invalidValues)), label).toBe(false);
        expect(validateTransportSchema(transportEnvelope(previewRequest(...invalidValues))), label).toBe(false);
      }
    }
  });

  it("counts and truncates view-value limits without splitting Unicode code points", () => {
    const astralAtLimit = "😀".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS);
    const astralOverLimit = `${astralAtLimit}😀`;
    const bmpAtLimit = "x".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS);
    const bmpOverLimit = `${bmpAtLimit}x`;

    expect(hasAtMostViewValueTextCodePoints(bmpAtLimit)).toBe(true);
    expect(hasAtMostViewValueTextCodePoints(bmpOverLimit)).toBe(false);
    expect(hasAtMostViewValueTextCodePoints(astralAtLimit)).toBe(true);
    expect(hasAtMostViewValueTextCodePoints(astralOverLimit)).toBe(false);
    expect(truncateViewValueTextToCodePoints(bmpOverLimit)).toBe(bmpAtLimit);
    expect(truncateViewValueTextToCodePoints(astralOverLimit)).toBe(astralAtLimit);
  });

  it("accepts exact import options with one-code-point Unicode delimiters and explicit Excel selectors", () => {
    const requestWithOptions = (importOptions: unknown, fileName = "fixture.csv"): unknown => ({
      kind: "openSession",
      source: {
        kind: "file",
        label: fileName,
        path: `/tmp/${fileName}`,
        importOptions
      },
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    });

    expect(
      isOpenWranglerRequest(
        requestWithOptions({
          delimiter: "💠",
          encoding: " utf-8 ",
          quoteChar: "“",
          hasHeader: true
        })
      )
    ).toBe(true);
    expect(isOpenWranglerRequest(requestWithOptions({}))).toBe(true);
    expect(isOpenWranglerRequest(requestWithOptions({ sheetName: " résumé " }, "fixture.xlsx"))).toBe(true);
    expect(isOpenWranglerRequest(requestWithOptions({ sheetIndex: 0 }, "fixture.xls"))).toBe(true);
  });

  it.each([
    [
      "a literal fragment marker in a raw path",
      {
        kind: "file",
        label: "fallback.parquet",
        path: "/tmp/data#1.csv",
        uri: "file:///tmp/fallback.xlsx?download=1",
        importOptions: { delimiter: ";" }
      }
    ],
    [
      "a literal query marker in a raw path",
      {
        kind: "file",
        label: "fallback.csv",
        path: "/tmp/data?1.xlsx",
        uri: "file:///tmp/fallback.csv?download=1",
        importOptions: { sheetIndex: 0 }
      }
    ],
    [
      "a literal fragment marker in a raw label",
      { kind: "file", label: "data#1.csv", importOptions: { encoding: "utf-8" } }
    ],
    [
      "a literal query marker in a raw label",
      { kind: "file", label: "data?1.xlsx", importOptions: { sheetName: "Sheet1" } }
    ],
    [
      "a query and fragment after a delimited URI path",
      {
        kind: "file",
        label: "fallback.xlsx",
        uri: "file:///tmp/data.csv?download=1#section",
        importOptions: { quoteChar: '"' }
      }
    ],
    [
      "a query and fragment after an Excel URI path",
      {
        kind: "file",
        label: "fallback.csv",
        path: "",
        uri: "file:///tmp/data.XLSX#section?download=1",
        importOptions: { sheetName: "Sheet1" }
      }
    ]
  ])("accepts import options resolved from %s", (_description, source) => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source,
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(true);
  });

  it.each([
    [
      "a raw path whose apparent extension is only before a literal query marker",
      {
        kind: "file",
        label: "fallback.csv",
        path: "/tmp/data.csv?download=1",
        uri: "file:///tmp/fallback.csv",
        importOptions: { delimiter: "," }
      }
    ],
    [
      "a URI whose extension occurs only inside its query",
      {
        kind: "file",
        label: "fallback.csv",
        uri: "file:///tmp/download?name=data.csv",
        importOptions: { delimiter: "," }
      }
    ],
    [
      "a lower-precedence compatible URI when the path is incompatible",
      {
        kind: "file",
        label: "fallback.xlsx",
        path: "/tmp/data.parquet",
        uri: "file:///tmp/data.xlsx",
        importOptions: { sheetIndex: 0 }
      }
    ],
    [
      "a hidden filename made only of an apparent extension",
      {
        kind: "file",
        label: ".csv",
        importOptions: { delimiter: "," }
      }
    ]
  ])("rejects import options resolved from %s", (_description, source) => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source,
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(false);
  });

  it("allows empty import options on non-file sources but rejects configured file imports there", () => {
    const requestWithOptions = (importOptions: unknown): unknown => ({
      kind: "openSession",
      source: {
        kind: "notebookVariable",
        label: "frame.csv",
        variableName: "frame",
        importOptions
      },
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    });

    expect(isOpenWranglerRequest(requestWithOptions({}))).toBe(true);
    expect(isOpenWranglerRequest(requestWithOptions({ delimiter: "," }))).toBe(false);
  });

  it.each([
    ["Excel selectors on a delimited source", "fixture.csv", { sheetName: "Sheet1" }],
    ["delimited controls on an Excel source", "fixture.xlsx", { delimiter: "," }],
    ["import values on a non-configurable source", "fixture.parquet", { encoding: "utf-8" }]
  ])("rejects %s", (_description, fileName, importOptions) => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source: {
          kind: "file",
          label: fileName,
          path: `/tmp/${fileName}`,
          importOptions
        },
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(false);
  });

  it.each([
    ["non-object options", null],
    ["array options", []],
    ["an unknown option", { delimiter: ",", extra: true }],
    ["the legacy ambiguous sheet option", { sheet: 0 }],
    ["a non-string delimiter", { delimiter: 1 }],
    ["an empty delimiter", { delimiter: "" }],
    ["a multi-code-point delimiter", { delimiter: "||" }],
    ["a lone high-surrogate delimiter", { delimiter: "\uD800" }],
    ["a lone low-surrogate delimiter", { delimiter: "\uDFFF" }],
    ["a non-string quote character", { quoteChar: 1 }],
    ["an empty quote character", { quoteChar: "" }],
    ["a multi-code-point quote character", { quoteChar: '""' }],
    ["a lone high-surrogate quote character", { quoteChar: "\uD800" }],
    ["a lone low-surrogate quote character", { quoteChar: "\uDFFF" }],
    ["a non-string encoding", { encoding: 1 }],
    ["a blank encoding", { encoding: " \t " }],
    ["a byte-order-mark-only encoding", { encoding: "\uFEFF" }],
    ["a non-boolean header flag", { hasHeader: "yes" }],
    ["a non-string sheet name", { sheetName: 1 }],
    ["a blank sheet name", { sheetName: " \n " }],
    ["a byte-order-mark-only sheet name", { sheetName: "\uFEFF" }],
    ["a negative sheet index", { sheetIndex: -1 }],
    ["a fractional sheet index", { sheetIndex: 1.5 }],
    ["a boolean sheet index", { sheetIndex: true }],
    ["an unsafe sheet index", { sheetIndex: Number.MAX_SAFE_INTEGER + 1 }],
    ["both Excel selectors", { sheetName: "Sheet1", sheetIndex: 0 }],
    ["a sheet name mixed with a delimiter", { sheetName: "Sheet1", delimiter: "," }],
    ["a sheet index mixed with an encoding", { sheetIndex: 0, encoding: "utf-8" }],
    ["a sheet name mixed with a quote character", { sheetName: "Sheet1", quoteChar: '"' }],
    ["a sheet index mixed with a header flag", { sheetIndex: 0, hasHeader: true }]
  ])("rejects import options containing %s", (_description, importOptions) => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source: {
          kind: "file",
          label: "fixture.csv",
          path: "/tmp/fixture.csv",
          importOptions
        },
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(false);
  });

  it.each([
    {
      id: "sort-rows",
      kind: "sortRows",
      params: { rules: [{ column: valueReference, direction: "asc", nulls: "last" }] }
    },
    {
      id: "filter-rows",
      kind: "filterRows",
      params: {
        filterModel: {
          logic: "and",
          filters: [
            {
              column: valueReference,
              type: "integer",
              predicates: [{ kind: "predicate", operator: "gte", value: 1 }]
            }
          ],
          sort: [{ column: valueReference, direction: "desc", nulls: "first" }]
        }
      }
    },
    { id: "drop-missing", kind: "dropMissingRows", params: { columns: [], how: "any" } },
    { id: "drop-duplicates", kind: "dropDuplicates", params: { columns: [valueReference], keep: "first" } },
    { id: "select", kind: "selectColumns", params: { columns: [valueReference, otherReference] } },
    { id: "drop", kind: "dropColumns", params: { columns: [valueReference] } },
    { id: "rename", kind: "renameColumn", params: { column: valueReference, newName: "amount" } },
    { id: "clone", kind: "cloneColumn", params: { column: valueReference, newName: "value_copy" } },
    { id: "cast", kind: "castColumn", params: { column: valueReference, dtype: "float" } },
    {
      id: "formula-value",
      kind: "formula",
      params: { leftColumn: valueReference, operator: "multiply", value: 2, newColumn: "doubled" }
    },
    {
      id: "formula-column",
      kind: "formula",
      params: { leftColumn: valueReference, operator: "add", rightColumn: otherReference, newColumn: "total" }
    },
    { id: "length", kind: "textLength", params: { column: { id: "column:2", name: "" }, newColumn: "length" } },
    {
      id: "one-hot",
      kind: "oneHotEncode",
      params: {
        columns: [valueReference, { id: "column:2", name: "value" }],
        prefixSeparator: "",
        dropOriginal: true
      }
    },
    {
      id: "multi-label",
      kind: "multiLabelBinarize",
      params: { column: valueReference, delimiter: ",", prefix: "label", dropOriginal: false }
    },
    {
      id: "find-replace",
      kind: "findReplace",
      params: { column: valueReference, find: "old", replacement: "new", regex: false }
    },
    { id: "strip-null", kind: "stripText", params: { column: valueReference, characters: null } },
    { id: "strip-omitted", kind: "stripText", params: { column: valueReference } },
    {
      id: "split",
      kind: "splitText",
      params: { column: valueReference, delimiter: ",", index: 0, newColumn: "first" }
    },
    { id: "capitalize", kind: "capitalizeText", params: { column: valueReference } },
    { id: "lower", kind: "lowerText", params: { column: valueReference, newColumn: "lower" } },
    { id: "upper", kind: "upperText", params: { column: valueReference } },
    { id: "scale", kind: "minMaxScale", params: { column: valueReference } },
    { id: "round", kind: "roundNumber", params: { column: valueReference, decimals: 2 } },
    { id: "floor", kind: "floorNumber", params: { column: valueReference } },
    { id: "ceil", kind: "ceilNumber", params: { column: valueReference } },
    { id: "format", kind: "formatDatetime", params: { column: valueReference, format: "%Y-%m-%d" } },
    {
      id: "group",
      kind: "groupBy",
      params: {
        keys: [valueReference],
        aggregations: [
          { column: otherReference, operation: "sum", alias: "total" },
          { column: otherReference, operation: "mean", alias: "average" }
        ]
      }
    },
    {
      id: "example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference, otherReference],
        newColumn: "combined",
        examples: [
          { inputs: ["a", 1], output: "a1" },
          { inputs: ["b", 2], output: "b2" }
        ],
        program: {
          kind: "concat",
          parts: [
            { kind: "column", column: valueReference },
            { kind: "column", column: otherReference }
          ]
        },
        warnings: [],
        candidateCount: 1
      }
    }
  ])("accepts canonical column references for $kind", (step) => {
    expect(isTransformStep(step)).toBe(true);
  });

  it.each([
    {
      id: "sort-legacy-name",
      kind: "sortRows",
      params: { rules: [{ column: "value", direction: "asc", nulls: "last" }] }
    },
    {
      id: "filter-legacy-name",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [{ column: "value", type: "integer", predicates: [] }],
          sort: []
        }
      }
    },
    { id: "drop-missing-legacy", kind: "dropMissingRows", params: { columns: ["value"] } },
    { id: "drop-duplicates-empty", kind: "dropDuplicates", params: { columns: [] } },
    { id: "drop-duplicates-legacy", kind: "dropDuplicates", params: { columns: ["value"] } },
    { id: "select-string", kind: "selectColumns", params: { columns: ["value"] } },
    { id: "drop-empty", kind: "dropColumns", params: { columns: [] } },
    { id: "rename-string", kind: "renameColumn", params: { column: "value", newName: "amount" } },
    { id: "clone-name-only", kind: "cloneColumn", params: { column: { name: "value" }, newName: "copy" } },
    { id: "cast-id-only", kind: "castColumn", params: { column: { id: "column:0" }, dtype: "float" } },
    {
      id: "formula-string",
      kind: "formula",
      params: { leftColumn: "value", operator: "add", rightColumn: "other", newColumn: "total" }
    },
    {
      id: "length-extra",
      kind: "textLength",
      params: { column: { ...valueReference, position: 0 }, newColumn: "length" }
    },
    { id: "length-empty-id", kind: "textLength", params: { column: { id: "", name: "value" }, newColumn: "length" } },
    {
      id: "length-non-string-name",
      kind: "textLength",
      params: { column: { id: "column:0", name: 42 }, newColumn: "length" }
    },
    {
      id: "rename-name-field",
      kind: "renameColumn",
      params: { columnName: "value", newName: "amount" }
    },
    { id: "one-hot-string", kind: "oneHotEncode", params: { columns: ["value"] } },
    {
      id: "one-hot-duplicate-id",
      kind: "oneHotEncode",
      params: { columns: [valueReference, { id: valueReference.id, name: "renamed" }] }
    },
    {
      id: "sort-duplicate-id",
      kind: "sortRows",
      params: {
        rules: [
          { column: valueReference, direction: "asc", nulls: "last" },
          { column: { id: valueReference.id, name: "renamed" }, direction: "desc", nulls: "first" }
        ]
      }
    },
    {
      id: "filter-duplicate-id",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [
            { column: valueReference, type: "integer", predicates: [] },
            { column: { id: valueReference.id, name: "renamed" }, type: "integer", predicates: [] }
          ],
          sort: []
        }
      }
    },
    {
      id: "filter-sort-duplicate-id",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [],
          sort: [
            { column: valueReference, direction: "asc", nulls: "last" },
            { column: { id: valueReference.id, name: "renamed" }, direction: "desc", nulls: "first" }
          ]
        }
      }
    },
    { id: "multi-label-string", kind: "multiLabelBinarize", params: { column: "value", delimiter: "," } },
    {
      id: "find-replace-string",
      kind: "findReplace",
      params: { column: "value", find: "old", replacement: "new" }
    },
    { id: "strip-string", kind: "stripText", params: { column: "value" } },
    { id: "strip-empty-characters", kind: "stripText", params: { column: valueReference, characters: "" } },
    {
      id: "split-string",
      kind: "splitText",
      params: { column: "value", delimiter: ",", index: 0, newColumn: "first" }
    },
    { id: "capitalize-string", kind: "capitalizeText", params: { column: "value" } },
    { id: "lower-string", kind: "lowerText", params: { column: "value" } },
    { id: "upper-string", kind: "upperText", params: { column: "value" } },
    { id: "scale-string", kind: "minMaxScale", params: { column: "value" } },
    { id: "round-string", kind: "roundNumber", params: { column: "value" } },
    { id: "floor-string", kind: "floorNumber", params: { column: "value" } },
    { id: "ceil-string", kind: "ceilNumber", params: { column: "value" } },
    { id: "format-string", kind: "formatDatetime", params: { column: "value", format: "%Y" } },
    {
      id: "group-legacy",
      kind: "groupBy",
      params: { keys: ["value"], aggregations: [{ column: "other", operation: "sum", alias: "total" }] }
    },
    {
      id: "group-position",
      kind: "groupBy",
      params: {
        keys: [{ ...valueReference, position: 0 }],
        aggregations: [{ column: otherReference, operation: "sum", alias: "total" }]
      }
    },
    {
      id: "group-duplicate-key",
      kind: "groupBy",
      params: {
        keys: [valueReference, valueReference],
        aggregations: [{ column: otherReference, operation: "sum", alias: "total" }]
      }
    },
    {
      id: "group-alias-key",
      kind: "groupBy",
      params: {
        keys: [valueReference],
        aggregations: [{ column: otherReference, operation: "sum", alias: "value" }]
      }
    },
    {
      id: "example-legacy",
      kind: "byExample",
      params: {
        sourceColumns: ["value"],
        newColumn: "clean",
        examples: [
          { inputs: { value: "a" }, output: "A" },
          { inputs: { value: "b" }, output: "B" }
        ]
      }
    },
    {
      id: "example-duplicate-source",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference, valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a", "a"], output: "A" },
          { inputs: ["b", "b"], output: "B" }
        ]
      }
    },
    {
      id: "example-wrong-arity",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference, otherReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    },
    {
      id: "example-outside-source",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "column", column: otherReference }
      }
    },
    {
      id: "example-negative-slice",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "a" },
          { inputs: ["b"], output: "b" }
        ],
        program: { kind: "slice", input: { kind: "column", column: valueReference }, start: -1 }
      }
    },
    {
      id: "example-negative-split",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "a" },
          { inputs: ["b"], output: "b" }
        ],
        program: { kind: "split", input: { kind: "column", column: valueReference }, delimiter: ",", index: -1 }
      }
    }
  ])("rejects legacy or malformed column references for $kind", (step) => {
    expect(isTransformStep(step)).toBe(false);
  });

  it("bounds by-example sources, examples, concat programs, depth, and scalar values", () => {
    const sources = Array.from({ length: 17 }, (_, index) => ({ id: `column:${index}`, name: `value_${index}` }));
    const example = (width: number) => ({ inputs: Array.from({ length: width }, () => "x"), output: "x" });
    const base = {
      id: "bounded-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [example(1), example(1)]
      }
    };
    const oversizedProgram = {
      kind: "concat",
      parts: Array.from({ length: 64 }, () => ({
        kind: "concat",
        parts: Array.from({ length: 4 }, () => ({ kind: "column", column: valueReference }))
      }))
    };
    let deepProgram: unknown = { kind: "column", column: valueReference };
    for (let index = 0; index < 65; index += 1) deepProgram = { kind: "slice", input: deepProgram, start: 0 };

    const malformed = [
      { ...base, params: { ...base.params, sourceColumns: sources, examples: [example(17), example(17)] } },
      { ...base, params: { ...base.params, examples: Array.from({ length: 65 }, () => example(1)) } },
      {
        ...base,
        params: {
          ...base.params,
          program: {
            kind: "concat",
            parts: Array.from({ length: 65 }, () => ({ kind: "column", column: valueReference }))
          }
        }
      },
      { ...base, params: { ...base.params, program: oversizedProgram } },
      { ...base, params: { ...base.params, program: deepProgram } },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "slice", input: { kind: "column", column: valueReference }, start: 2, stop: 1 }
        }
      },
      { ...base, params: { ...base.params, examples: [{ inputs: [Number.NaN], output: "x" }, example(1)] } },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "literal", value: Number.POSITIVE_INFINITY }
        }
      }
    ];

    for (const step of malformed) expect(isTransformStep(step)).toBe(false);
  });

  it("rejects over-wide by-example containers before traversing their contents", () => {
    const base = {
      id: "container-bounded-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };
    const hugeLength = 100_000;
    const malformed = [
      {
        ...base,
        params: {
          ...base.params,
          sourceColumns: Array.from({ length: hugeLength }, () => valueReference)
        }
      },
      {
        ...base,
        params: {
          ...base.params,
          program: {
            kind: "concat",
            parts: Array.from({ length: hugeLength }, () => ({ kind: "column", column: valueReference }))
          }
        }
      },
      { ...base, params: { ...base.params, warnings: Array.from({ length: hugeLength }, () => "") } }
    ];

    for (const step of malformed) {
      expect(() => isTransformStep(step)).not.toThrow();
      expect(isTransformStep(step)).toBe(false);
    }
  });

  it("caps saved by-example warnings independently of their UTF-8 payload", () => {
    const base = {
      id: "warning-bounded-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };

    expect(
      isTransformStep({ ...base, params: { ...base.params, warnings: Array.from({ length: 64 }, () => "") } })
    ).toBe(true);
    expect(
      isTransformStep({ ...base, params: { ...base.params, warnings: Array.from({ length: 65 }, () => "") } })
    ).toBe(false);
  });

  it("bounds every by-example string by strict UTF-8 bytes", () => {
    const stepWithInput = (input: string) => ({
      id: "utf8-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c", name: "" }],
        newColumn: "n",
        examples: [
          { inputs: [input], output: null },
          { inputs: [null], output: null }
        ]
      }
    });

    for (const accepted of ["a".repeat(8192), "é".repeat(4096), "🙂".repeat(2048)]) {
      expect(isTransformStep(stepWithInput(accepted))).toBe(true);
    }
    for (const rejected of ["a".repeat(8193), "é".repeat(4097), "🙂".repeat(2049), "\ud800"]) {
      expect(() => isTransformStep(stepWithInput(rejected))).not.toThrow();
      expect(isTransformStep(stepWithInput(rejected))).toBe(false);
    }
  });

  it("rejects by-example integer scalars that cannot survive the JSON transport exactly", () => {
    const stepWithValues = (input: number, output: number) => ({
      id: "numeric-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "result",
        examples: [
          { inputs: [input], output },
          { inputs: [1], output: 2 }
        ]
      }
    });

    expect(isTransformStep(stepWithValues(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER))).toBe(true);
    expect(isTransformStep(stepWithValues(Number.MAX_SAFE_INTEGER + 1, 1))).toBe(false);
    expect(isTransformStep(stepWithValues(1, Number.MIN_SAFE_INTEGER - 1))).toBe(false);
    expect(isTransformStep(stepWithValues(1.25, 2.5))).toBe(true);
  });

  it("caps the aggregate by-example text envelope at 64 KiB", () => {
    const stringsAtLimit = ["a".repeat(8190), ...Array.from({ length: 7 }, () => "b".repeat(8192))];
    const stepWithStrings = (strings: string[]) => ({
      id: "aggregate-utf8-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c", name: "" }],
        newColumn: "n",
        examples: Array.from({ length: 4 }, (_, index) => ({
          inputs: [strings[index * 2]],
          output: strings[index * 2 + 1]
        }))
      }
    });

    expect(isTransformStep(stepWithStrings(stringsAtLimit))).toBe(true);
    expect(isTransformStep(stepWithStrings([`x${stringsAtLimit[0]}`, ...stringsAtLimit.slice(1)]))).toBe(false);
  });

  it("counts references, program text, and warnings in the by-example envelope", () => {
    const column = { id: "c", name: "value" };
    const base = {
      id: "text-fields-example",
      kind: "byExample",
      params: {
        sourceColumns: [column],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };
    const oversized = "x".repeat(8193);
    const columnProgram = { kind: "column", column };
    const malformed = [
      { ...base, params: { ...base.params, sourceColumns: [{ id: "c", name: oversized }] } },
      { ...base, params: { ...base.params, newColumn: oversized } },
      { ...base, params: { ...base.params, program: { kind: "literal", value: oversized } } },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "split", input: columnProgram, delimiter: oversized, index: 0 }
        }
      },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "regexReplace", input: columnProgram, pattern: oversized, replacement: "" }
        }
      },
      {
        ...base,
        params: {
          ...base.params,
          program: {
            kind: "datetimeFormat",
            input: columnProgram,
            inputFormat: "%Y",
            outputFormat: oversized
          }
        }
      },
      { ...base, params: { ...base.params, warnings: [oversized] } },
      { ...base, params: { ...base.params, warnings: ["\udfff"] } }
    ];

    for (const step of malformed) {
      expect(() => isTransformStep(step)).not.toThrow();
      expect(isTransformStep(step)).toBe(false);
    }
  });

  it("rejects cyclic by-example programs without throwing", () => {
    const cyclic: Record<string, unknown> = { kind: "case", style: "upper" };
    cyclic.input = cyclic;
    const step = {
      id: "cyclic-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: cyclic
      }
    };

    expect(() => isTransformStep(step)).not.toThrow();
    expect(isTransformStep(step)).toBe(false);
  });

  it.each([
    {
      kind: "openSession",
      source: metadata.source,
      requestedSessionId: "",
      backend: "polars",
      mode: "editing",
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "previewStep",
      sessionId: "session-1",
      revision: 3,
      step: { id: "bad", kind: "renameColumn", params: { columns: ["value"] } },
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "inspectStep",
      sessionId: "session-1",
      revision: 3,
      stepId: "",
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
      offset: -1,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "previewStep",
      sessionId: "session-1",
      revision: 3,
      step: { id: "bad", kind: "customCode", params: { code: "   " } },
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    { kind: "exportData", sessionId: "session-1", revision: 3, path: "", format: "csv" },
    { kind: "exportData", sessionId: "session-1", revision: 3, path: "/tmp/out.csv", format: "json" },
    { kind: "closeSession", sessionId: 17, revision: 3 },
    { kind: "closeSession", sessionId: "session-1", revision: -1 },
    { kind: "closeSession", sessionId: "session-1", revision: 3, force: true }
  ])("rejects malformed boundary input: %j", (request) => {
    expect(isOpenWranglerRequest(request)).toBe(false);
  });

  it("rejects missing, fractional, negative, zero, and oversized column windows", () => {
    const getPage = requests.find((request) => request.kind === "getPage");
    expect(getPage?.kind).toBe("getPage");
    if (getPage?.kind !== "getPage") return;

    const { columnOffset: _columnOffset, ...withoutOffset } = getPage;
    expect(isOpenWranglerRequest(withoutOffset)).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnOffset: -1 })).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnOffset: 0.5 })).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnLimit: 0 })).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnLimit: 257 })).toBe(false);
  });

  it("rejects unknown request kinds and malformed request envelopes", () => {
    expect(isOpenWranglerRequest({ kind: "futureRequest" })).toBe(false);
    expect(
      isRuntimeRequestEnvelope({
        protocolVersion: 2,
        requestId: "request-1",
        priority: "urgent",
        request: requests[0]
      })
    ).toBe(false);
    expect(
      isRuntimeRequestEnvelope({
        protocolVersion: 2,
        requestId: "request-1",
        priority: "interactive",
        request: requests[0],
        extra: true
      })
    ).toBe(false);
  });
});
