import { describe, expect, it } from "vitest";
import type { LiveGridPage, RuntimeResponseEnvelope, SessionMetadata } from "../shared/protocol";
import { openWranglerResponseShapes } from "../shared/protocol";
import {
  isOpenWranglerResponse,
  isRetainedTransformStep,
  isRuntimeResponseEnvelope,
  isTransformStep
} from "../shared/protocolValidation";
import { MAX_VIEW_VALUE_TEXT_CHARACTERS } from "../shared/viewValueLimits";
import {
  capabilities,
  metadata,
  page,
  responses,
  summaries,
  validateTransportSchema,
  valueReference
} from "./protocolValidation.fixtures";

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

  it("keeps the generated response-shape catalog directly frozen", () => {
    expect(openWranglerResponseShapes.map(({ kind }) => kind)).toEqual(responses.map(({ kind }) => kind));
    expect(Object.isFrozen(openWranglerResponseShapes)).toBe(true);
    for (const definition of openWranglerResponseShapes) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.required)).toBe(true);
      expect(Object.isFrozen(definition.optional)).toBe(true);
    }

    const first = openWranglerResponseShapes[0];
    expect(Reflect.set(openWranglerResponseShapes, 0, first)).toBe(false);
    expect(Reflect.set(first, "kind", "changed")).toBe(false);
    expect(Reflect.set(first.required, 0, "changed")).toBe(false);
  });

  it.each(responses.map((response) => [response.kind, response] as const))(
    "rejects missing required and unknown top-level keys for %s",
    (kind, response) => {
      const definition = openWranglerResponseShapes.find((candidate) => candidate.kind === kind);
      expect(definition).toBeDefined();
      if (definition === undefined) return;

      for (const requiredKey of definition.required) {
        const missingRequired = { ...response } as Record<string, unknown>;
        Reflect.deleteProperty(missingRequired, requiredKey);
        expect(isOpenWranglerResponse(missingRequired)).toBe(false);
      }
      expect(isOpenWranglerResponse({ ...response, unknownTopLevelKey: true })).toBe(false);
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

  it("binds Pandas row-axis metadata to every published page", () => {
    const pandasMetadata: SessionMetadata = {
      ...metadata,
      backend: "pandas",
      rowAxis: { kind: "index", levelNames: ["account"] }
    };
    const indexedPage = {
      ...page,
      rows: page.rows.map((row) => ({ ...row, rowLabel: "account-1" }))
    };
    const opened = { kind: "sessionOpened", metadata: pandasMetadata, page: indexedPage, summaries };

    expect(isOpenWranglerResponse(opened)).toBe(true);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "pandas-index", response: opened })).toBe(true);

    const { rowAxis: _rowAxis, ...pandasWithoutAxis } = pandasMetadata;
    expect(isOpenWranglerResponse({ ...opened, metadata: pandasWithoutAxis })).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "pandas-missing-index",
        response: { ...opened, metadata: pandasWithoutAxis }
      })
    ).toBe(false);
    expect(isOpenWranglerResponse({ ...opened, metadata: { ...metadata, rowAxis: pandasMetadata.rowAxis } })).toBe(
      false
    );
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "non-pandas-index",
        response: { ...opened, metadata: { ...metadata, rowAxis: pandasMetadata.rowAxis } }
      })
    ).toBe(false);

    for (const rowAxis of [
      { kind: "positional", levelNames: ["unexpected"] },
      { kind: "index", levelNames: [] },
      { kind: "index", levelNames: ["first", "second"] },
      { kind: "multiIndex", levelNames: ["only-one"] },
      { kind: "multiIndex", levelNames: Array.from({ length: 65 }, () => null) },
      { kind: "index", levelNames: ["x".repeat(1_025)] }
    ]) {
      expect(isOpenWranglerResponse({ ...opened, metadata: { ...pandasMetadata, rowAxis } })).toBe(false);
    }

    expect(isOpenWranglerResponse({ ...opened, page })).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...opened,
        metadata: { ...pandasMetadata, rowAxis: { kind: "positional", levelNames: [] } }
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...opened,
        metadata: { ...pandasMetadata, rowAxis: { kind: "positional", levelNames: [] } },
        page
      })
    ).toBe(true);
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

  it("accepts remaining missing-value counts only for fill previews", () => {
    const preview = responses.find((response) => response.kind === "stepPreview");
    expect(preview?.kind).toBe("stepPreview");
    if (preview?.kind !== "stepPreview") return;
    const fillPreview = {
      ...preview,
      metadata: {
        ...preview.metadata,
        draftStep: {
          id: "fill-1",
          kind: "fillMissingValues",
          params: { column: valueReference, replacement: { kind: "integer", value: "0" } }
        }
      },
      remainingMissingCells: 1
    };

    expect(isOpenWranglerResponse(fillPreview)).toBe(true);
    expect(isOpenWranglerResponse({ ...fillPreview, remainingMissingCells: undefined })).toBe(false);
    expect(isOpenWranglerResponse({ ...fillPreview, remainingMissingCells: -1 })).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...fillPreview,
        remainingMissingCells: fillPreview.metadata.shape.rows! + 1
      })
    ).toBe(false);
    expect(isOpenWranglerResponse({ ...preview, remainingMissingCells: 0 })).toBe(false);
  });

  it("accepts an explicit sample size only for a bounded sampled duplicate count", () => {
    const response = responses.find((candidate) => candidate.kind === "datasetStats");
    expect(response?.kind).toBe("datasetStats");
    if (response?.kind !== "datasetStats") return;

    expect(
      isOpenWranglerResponse({
        ...response,
        stats: { ...response.stats, duplicateRows: 2, duplicateRowsSampleSize: 100 }
      })
    ).toBe(true);
    expect(
      isOpenWranglerResponse({
        ...response,
        stats: { ...response.stats, duplicateRowsSampleSize: 0 }
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...response,
        stats: { ...response.stats, duplicateRows: 10, duplicateRowsSampleSize: 10 }
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
        inputRowAxis: { kind: "positional", levelNames: [] },
        outputRowAxis: { kind: "positional", levelNames: [] },
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
    expect(isOpenWranglerResponse({ ...response, hasMore: true, sampleSize: 4 })).toBe(true);
    expect(isOpenWranglerResponse({ ...response, sampleSize: 4 })).toBe(false);
    expect(isOpenWranglerResponse({ ...response, hasMore: true, sampleSize: 0 })).toBe(false);
    expect(isOpenWranglerResponse({ ...response, hasMore: true, sampleSize: 3 })).toBe(false);
    expect(isOpenWranglerResponse({ ...response, hasMore: true, sampleSize: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
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
