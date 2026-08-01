import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  R_PROVIDER_LIMITS,
  R_PROVIDER_PROTOCOL_VERSION,
  type RProviderConfirmedSession,
  type RProviderGetPageRequest,
  type RProviderOpenSessionRequest,
  isRProviderPageDimensionsWithinLimits,
  isRProviderPageEstimatedBytesWithinLimit,
  isRProviderRequestPayloadWithinLimit,
  isRProviderResponsePayloadWithinLimit,
  isRProviderResponseEnvelope,
  isRProviderResponseEnvelopeForDispatch,
  isRProviderSchemaEstimatedBytesWithinLimit,
  isRProviderShapeWithinLimits,
  isRProviderTextWithinLimit,
  parseRProviderResponseJsonForDispatch
} from "../extension/r/rProviderProtocol";

const schema = [
  {
    id: "r:c:0",
    name: "id",
    position: 0,
    rawType: "integer<integer>",
    type: "integer",
    nullable: false
  },
  {
    id: "r:c:1",
    name: "label",
    position: 1,
    rawType: "character<character>",
    type: "string",
    nullable: true
  }
] as const;

const page = {
  offset: 0,
  limit: 20,
  totalRows: 1,
  columnIds: ["r:c:0", "r:c:1"],
  rows: [
    {
      id: "r:row:0",
      rowNumber: 0,
      values: [
        { kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false },
        { kind: "null", raw: null, display: "", isNull: true, isNaN: false }
      ]
    }
  ]
};

const metadata = {
  providerProtocolVersion: R_PROVIDER_PROTOCOL_VERSION,
  sessionId: "r-session",
  backend: "r",
  mode: "viewing",
  source: {
    kind: "notebookVariable",
    label: "orders",
    variableName: "orders",
    discoveryId: "r:d:1:1"
  },
  sourceClass: "tbl_df",
  shape: { rows: 1, columns: 2 },
  schema
} as const;

const confirmedSession: RProviderConfirmedSession = {
  sessionId: "r-session",
  revision: 0,
  shape: metadata.shape,
  schema
};

const openRequest: RProviderOpenSessionRequest = {
  kind: "openSession",
  source: metadata.source,
  requestedSessionId: "r-session",
  backend: "r",
  mode: "viewing",
  pageSize: 20,
  columnOffset: 0,
  columnLimit: 2
};

const pageRequest: RProviderGetPageRequest = {
  kind: "getPage",
  sessionId: "r-session",
  revision: 0,
  viewRequestId: "view-2",
  offset: 0,
  limit: 20,
  columnOffset: 0,
  columnLimit: 2,
  filterModel: { logic: "and", filters: [], sort: [] }
};

describe("native R provider protocol guard", () => {
  it("keeps the host protocol version and resource ceilings mechanically aligned with the R producer", () => {
    const runtime = readFileSync(resolve(process.cwd(), "r", "openwrangler_runtime", "kernel_agent.R"), "utf8");
    expect(runtime).toMatch(new RegExp(`^\\.ow_r_provider_protocol_version <- ${R_PROVIDER_PROTOCOL_VERSION}L$`, "mu"));
    const mirrored = {
      ".ow_r_max_request_bytes": R_PROVIDER_LIMITS.maxRequestBytes,
      ".ow_r_max_response_bytes": R_PROVIDER_LIMITS.maxResponseBytes,
      ".ow_r_max_discovery_response_bytes": R_PROVIDER_LIMITS.maxDiscoveryResponseBytes,
      ".ow_r_max_discovery_variables": R_PROVIDER_LIMITS.maxDiscoveryVariables,
      ".ow_r_max_discovery_scanned_bindings": R_PROVIDER_LIMITS.maxDiscoveryScannedBindings,
      ".ow_r_max_discovery_name_characters": R_PROVIDER_LIMITS.maxDiscoveryNameCodePoints,
      ".ow_r_max_discovery_name_bytes": R_PROVIDER_LIMITS.maxDiscoveryNameBytes,
      ".ow_r_max_page_rows": R_PROVIDER_LIMITS.maxPageRows,
      ".ow_r_max_page_columns": R_PROVIDER_LIMITS.maxPageColumns,
      ".ow_r_max_page_cells": R_PROVIDER_LIMITS.maxPageCells,
      ".ow_r_max_page_estimated_bytes": R_PROVIDER_LIMITS.maxPageEstimatedBytes,
      ".ow_r_max_schema_estimated_bytes": R_PROVIDER_LIMITS.maxSchemaEstimatedBytes,
      ".ow_r_max_text_characters": R_PROVIDER_LIMITS.maxTextCodePoints,
      ".ow_r_max_shape_rows": R_PROVIDER_LIMITS.maxShapeRows,
      ".ow_r_max_shape_columns": R_PROVIDER_LIMITS.maxShapeColumns
    };
    for (const [name, value] of Object.entries(mirrored)) {
      const escapedName = name.replaceAll(".", "\\.");
      expect(runtime).toMatch(new RegExp(`^${escapedName} <- ${value}(?:L)?$`, "mu"));
    }
  });

  it("enforces every raw, text, shape, page, and estimated-byte ceiling at its boundary", () => {
    expect(isRProviderRequestPayloadWithinLimit("x".repeat(R_PROVIDER_LIMITS.maxRequestBytes))).toBe(true);
    expect(isRProviderRequestPayloadWithinLimit("x".repeat(R_PROVIDER_LIMITS.maxRequestBytes + 1))).toBe(false);
    expect(isRProviderResponsePayloadWithinLimit("x".repeat(R_PROVIDER_LIMITS.maxResponseBytes))).toBe(true);
    expect(isRProviderResponsePayloadWithinLimit("x".repeat(R_PROVIDER_LIMITS.maxResponseBytes + 1))).toBe(false);

    const exactText = "😀".repeat(R_PROVIDER_LIMITS.maxTextCodePoints);
    expect(isRProviderTextWithinLimit(exactText)).toBe(true);
    expect(isRProviderTextWithinLimit(`${exactText}😀`)).toBe(false);

    expect(isRProviderShapeWithinLimits(R_PROVIDER_LIMITS.maxShapeRows, R_PROVIDER_LIMITS.maxShapeColumns)).toBe(true);
    expect(isRProviderShapeWithinLimits(R_PROVIDER_LIMITS.maxShapeRows + 1, 1)).toBe(false);
    expect(isRProviderShapeWithinLimits(1, R_PROVIDER_LIMITS.maxShapeColumns + 1)).toBe(false);

    expect(isRProviderPageDimensionsWithinLimits(R_PROVIDER_LIMITS.maxPageRows, 10)).toBe(true);
    expect(isRProviderPageDimensionsWithinLimits(R_PROVIDER_LIMITS.maxPageRows, 11)).toBe(false);
    expect(isRProviderPageDimensionsWithinLimits(R_PROVIDER_LIMITS.maxPageRows + 1, 1)).toBe(false);
    expect(isRProviderPageDimensionsWithinLimits(1, R_PROVIDER_LIMITS.maxPageColumns + 1)).toBe(false);

    expect(isRProviderSchemaEstimatedBytesWithinLimit(R_PROVIDER_LIMITS.maxSchemaEstimatedBytes)).toBe(true);
    expect(isRProviderSchemaEstimatedBytesWithinLimit(R_PROVIDER_LIMITS.maxSchemaEstimatedBytes + 1)).toBe(false);
    expect(isRProviderPageEstimatedBytesWithinLimit(R_PROVIDER_LIMITS.maxPageEstimatedBytes)).toBe(true);
    expect(isRProviderPageEstimatedBytesWithinLimit(R_PROVIDER_LIMITS.maxPageEstimatedBytes + 1)).toBe(false);
  });

  it("checks raw response bytes before parsing and still requires exact dispatch correlation", () => {
    const response = JSON.stringify({
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "initialize",
      response: {
        kind: "initialized",
        runtimeVersion: "0.1.0",
        language: "r",
        transport: "inProcessR",
        capabilities: {
          sourceKinds: ["notebookVariable"],
          dataFrameClasses: ["data.frame", "tbl_df", "data.table"],
          variableDiscovery: true,
          paging: true,
          filtering: false,
          sorting: false,
          editing: false
        }
      }
    });
    const exact = response + " ".repeat(R_PROVIDER_LIMITS.maxResponseBytes - Buffer.byteLength(response, "utf8"));
    expect(Buffer.byteLength(exact, "utf8")).toBe(R_PROVIDER_LIMITS.maxResponseBytes);
    expect(
      parseRProviderResponseJsonForDispatch(exact, {
        requestId: "initialize",
        request: { kind: "initialize" }
      })?.response.kind
    ).toBe("initialized");
    expect(
      parseRProviderResponseJsonForDispatch(`${exact} `, {
        requestId: "initialize",
        request: { kind: "initialize" }
      })
    ).toBeUndefined();
    expect(
      parseRProviderResponseJsonForDispatch(response, {
        requestId: "stale",
        request: { kind: "initialize" }
      })
    ).toBeUndefined();
  });

  it("accepts only bounded, unambiguous picker metadata for the exact discovery request", () => {
    const context = { requestId: "discover-r", request: { kind: "discoverVariables" } } as const;
    const discovered = {
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "discover-r",
      response: {
        kind: "variablesDiscovered",
        truncated: false,
        variables: [
          { discoveryId: "r:d:1:1", name: "base_orders", sourceClass: "data.frame", shape: { rows: 3, columns: 2 } },
          { discoveryId: "r:d:1:2", name: "table_orders", sourceClass: "data.table", shape: { rows: 4, columns: 3 } },
          { discoveryId: "r:d:1:3", name: "tibble_orders", sourceClass: "tbl_df", shape: { rows: 5, columns: 4 } }
        ]
      }
    } as const;

    expect(isRProviderResponseEnvelopeForDispatch(discovered, context)).toBe(true);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          ...discovered,
          response: {
            ...discovered.response,
            variables: [...discovered.response.variables, discovered.response.variables[0]]
          }
        },
        context
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          ...discovered,
          response: {
            ...discovered.response,
            variables: [
              discovered.response.variables[0],
              {
                ...discovered.response.variables[1],
                discoveryId: discovered.response.variables[0].discoveryId
              }
            ]
          }
        },
        context
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          ...discovered,
          response: {
            ...discovered.response,
            variables: [
              { discoveryId: "r:d:1:4", name: "orders", sourceClass: "grouped_df", shape: { rows: 1, columns: 1 } }
            ]
          }
        },
        context
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          ...discovered,
          response: {
            ...discovered.response,
            variables: [
              { discoveryId: "r:d:1:4", name: "orders", sourceClass: "data.frame", shape: { rows: -1, columns: 1 } }
            ]
          }
        },
        context
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          ...discovered,
          response: {
            ...discovered.response,
            variables: [
              {
                discoveryId: "r:d:1:4",
                name: "x".repeat(R_PROVIDER_LIMITS.maxDiscoveryNameCodePoints + 1),
                sourceClass: "data.frame",
                shape: { rows: 1, columns: 1 }
              }
            ]
          }
        },
        context
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          ...discovered,
          response: {
            ...discovered.response,
            variables: Array.from({ length: R_PROVIDER_LIMITS.maxDiscoveryVariables + 1 }, (_, index) => ({
              discoveryId: `r:d:1:${index + 1}`,
              name: `frame_${index}`,
              sourceClass: "data.frame",
              shape: { rows: 1, columns: 1 }
            }))
          }
        },
        context
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          ...discovered,
          response: {
            ...discovered.response,
            variables: [{ ...discovered.response.variables[0], label: "not picker metadata" }]
          }
        },
        context
      )
    ).toBe(false);

    const encoded = JSON.stringify(discovered);
    const exact =
      encoded + " ".repeat(R_PROVIDER_LIMITS.maxDiscoveryResponseBytes - Buffer.byteLength(encoded, "utf8"));
    expect(parseRProviderResponseJsonForDispatch(exact, context)).toEqual(discovered);
    expect(parseRProviderResponseJsonForDispatch(`${exact} `, context)).toBeUndefined();
    expect(
      parseRProviderResponseJsonForDispatch(JSON.stringify({ ...discovered, requestId: "stale-discovery" }), context)
    ).toBeUndefined();
  });

  it("accepts the bounded native-R initialization contract", () => {
    const initialized = {
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "initialize",
      response: {
        kind: "initialized",
        runtimeVersion: "0.1.0",
        language: "r",
        transport: "inProcessR",
        capabilities: {
          sourceKinds: ["notebookVariable"],
          dataFrameClasses: ["data.frame", "tbl_df", "data.table"],
          variableDiscovery: true,
          paging: true,
          filtering: false,
          sorting: false,
          editing: false
        }
      }
    } as const;
    expect(isRProviderResponseEnvelope(initialized)).toBe(true);
    expect(
      isRProviderResponseEnvelope({
        ...initialized,
        protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
        extra: true
      })
    ).toBe(false);
    expect(isRProviderResponseEnvelope({ ...initialized, protocolVersion: 1 })).toBe(false);
  });

  it("accepts a full-width schema with a projected page", () => {
    expect(
      isRProviderResponseEnvelope({
        protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
        requestId: "open",
        response: {
          kind: "sessionOpened",
          metadata: {
            providerProtocolVersion: R_PROVIDER_PROTOCOL_VERSION,
            sessionId: "r-session",
            backend: "r",
            mode: "viewing",
            source: {
              kind: "notebookVariable",
              label: "orders",
              variableName: "orders",
              discoveryId: "r:d:1:1"
            },
            sourceClass: "tbl_df",
            shape: { rows: 1, columns: 2 },
            schema
          },
          page
        }
      })
    ).toBe(true);
  });

  it("accepts only canonical producer-emittable schemas for correlated zero-row opens", () => {
    const zeroSchema = [
      {
        id: "r:c:0",
        name: "",
        position: 0,
        rawType: "character<character>",
        type: "string",
        nullable: false
      }
    ] as const;
    const zeroMetadata = {
      ...metadata,
      sourceClass: "data.frame" as const,
      shape: { rows: 0, columns: 1 },
      schema: zeroSchema
    };
    const zeroPage = {
      offset: 0,
      limit: 20,
      totalRows: 0,
      columnIds: ["r:c:0"],
      rows: []
    };
    const zeroRequest = {
      ...openRequest,
      pageSize: 20,
      columnOffset: 0,
      columnLimit: 1
    };
    const responseFor = (candidateSchema: readonly unknown[]) => ({
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "zero-open",
      response: {
        kind: "sessionOpened",
        metadata: { ...zeroMetadata, schema: candidateSchema },
        page: zeroPage
      }
    });
    const context = { requestId: "zero-open", request: zeroRequest } as const;

    expect(isRProviderResponseEnvelopeForDispatch(responseFor(zeroSchema), context)).toBe(true);
    for (const forgedSchema of [
      [{ ...zeroSchema[0], id: "forged" }],
      [{ ...zeroSchema[0], id: "r:c:1" }],
      [{ ...zeroSchema[0], rawType: "" }],
      [{ ...zeroSchema[0], rawType: "raw<raw>", type: "binary" }],
      [{ ...zeroSchema[0], rawType: "list<list>", type: "list" }],
      [{ ...zeroSchema[0], rawType: "double<numeric>" }],
      [{ ...zeroSchema[0], rawType: "logical<Date>", type: "boolean" }],
      [{ ...zeroSchema[0], rawType: "integer<Date>", type: "integer" }],
      [{ ...zeroSchema[0], rawType: "character<POSIXt>", type: "string" }],
      [{ ...zeroSchema[0], rawType: "character<character>", type: "unknown" }]
    ]) {
      expect(isRProviderResponseEnvelopeForDispatch(responseFor(forgedSchema), context)).toBe(false);
    }
  });

  it.each([
    ["boolean", "logical<logical>"],
    ["integer", "integer<integer>"],
    ["integer", "double<integer64>"],
    ["float", "double<numeric>"],
    ["string", "integer<factor>"],
    ["date", "double<Date>"],
    ["datetime", "double<POSIXct,POSIXt>"],
    ["duration", "double<difftime>"]
  ] as const)("accepts the zero-row %s schema emitted as %s", (type, rawType) => {
    const candidateSchema = [{ id: "r:c:0", name: "value", position: 0, rawType, type, nullable: false }];
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "zero-open",
          response: {
            kind: "sessionOpened",
            metadata: {
              ...metadata,
              sourceClass: "data.frame",
              shape: { rows: 0, columns: 1 },
              schema: candidateSchema
            },
            page: {
              offset: 0,
              limit: 20,
              totalRows: 0,
              columnIds: ["r:c:0"],
              rows: []
            }
          }
        },
        {
          requestId: "zero-open",
          request: { ...openRequest, pageSize: 20, columnOffset: 0, columnLimit: 1 }
        }
      )
    ).toBe(true);
  });

  it("accepts a correlated projected page", () => {
    expect(
      isRProviderResponseEnvelope({
        protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
        requestId: "page",
        response: {
          kind: "page",
          sessionId: "r-session",
          revision: 0,
          viewRequestId: "view-2",
          page
        }
      })
    ).toBe(true);
  });

  it.each([
    ["integer<integer>", "-2147483647", true],
    ["integer<integer>", "2147483647", true],
    ["integer<integer>", "-2147483648", false],
    ["integer<integer>", "2147483648", false],
    ["integer<integer>", "-0", false],
    ["double<integer64>", "-9223372036854775807", true],
    ["double<integer64>", "9223372036854775807", true],
    ["double<integer64>", "-9223372036854775808", false],
    ["double<integer64>", "9223372036854775808", false],
    ["double<integer64>", "999999999999999999999", false]
  ] as const)("validates %s cell %s against its native R bounds", (rawType, raw, expected) => {
    const integerSchema = [
      {
        id: "r:c:0",
        name: "value",
        position: 0,
        rawType,
        type: "integer",
        nullable: false
      }
    ] as const;
    const integerPage = {
      offset: 0,
      limit: 20,
      totalRows: 1,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:row:0",
          rowNumber: 0,
          values: [{ kind: "integer", raw, display: raw, isNull: false, isNaN: false }]
        }
      ]
    } as const;

    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "bounded-integer-open",
          response: {
            kind: "sessionOpened",
            metadata: {
              ...metadata,
              sourceClass: "data.frame",
              shape: { rows: 1, columns: 1 },
              schema: integerSchema
            },
            page: integerPage
          }
        },
        {
          requestId: "bounded-integer-open",
          request: { ...openRequest, pageSize: 20, columnOffset: 0, columnLimit: 1 }
        }
      )
    ).toBe(expected);
  });

  it("accepts only responses correlated to the exact dispatched request and confirmed session", () => {
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "initialize",
          response: {
            kind: "initialized",
            runtimeVersion: "0.1.0",
            language: "r",
            transport: "inProcessR",
            capabilities: {
              sourceKinds: ["notebookVariable"],
              dataFrameClasses: ["data.frame", "tbl_df", "data.table"],
              variableDiscovery: true,
              paging: true,
              filtering: false,
              sorting: false,
              editing: false
            }
          }
        },
        { requestId: "initialize", request: { kind: "initialize" } }
      )
    ).toBe(true);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "open",
          response: { kind: "sessionOpened", metadata, page }
        },
        { requestId: "open", request: openRequest }
      )
    ).toBe(true);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "page",
          response: {
            kind: "page",
            sessionId: "r-session",
            revision: 0,
            viewRequestId: "view-2",
            page
          }
        },
        { requestId: "page", request: pageRequest, session: confirmedSession }
      )
    ).toBe(true);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "close",
          response: { kind: "sessionClosed", sessionId: "r-session" }
        },
        {
          requestId: "close",
          request: { kind: "closeSession", sessionId: "r-session", revision: 0 },
          session: confirmedSession
        }
      )
    ).toBe(true);
  });

  it("rejects stale IDs, wrong projections, range drift, and contradictory typed cells", () => {
    const response = {
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "page",
      response: {
        kind: "page",
        sessionId: "r-session",
        revision: 0,
        viewRequestId: "view-2",
        page
      }
    } as const;
    const context = { requestId: "page", request: pageRequest, session: confirmedSession } as const;

    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "open",
          response: { kind: "sessionOpened", metadata, page }
        },
        {
          requestId: "open",
          request: {
            ...openRequest,
            source: { ...openRequest.source, variableName: "replacement" }
          }
        }
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "open",
          response: { kind: "sessionOpened", metadata, page }
        },
        {
          requestId: "open",
          request: {
            ...openRequest,
            source: { ...openRequest.source, discoveryId: "r:d:other" }
          }
        }
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "open",
          response: { kind: "sessionOpened", metadata, page }
        },
        {
          requestId: "open",
          request: { ...openRequest, columnOffset: 1, columnLimit: 1 }
        }
      )
    ).toBe(false);
    expect(isRProviderResponseEnvelopeForDispatch({ ...response, requestId: "stale" }, context)).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        { ...response, response: { ...response.response, sessionId: "other-session" } },
        context
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        { ...response, response: { ...response.response, viewRequestId: "stale-view" } },
        context
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(response, {
        ...context,
        request: { ...pageRequest, columnOffset: 1, columnLimit: 1 }
      })
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          ...response,
          response: { ...response.response, page: { ...page, totalRows: 2 } }
        },
        context
      )
    ).toBe(false);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          ...response,
          response: {
            ...response.response,
            page: { ...page, rows: [{ ...page.rows[0], rowNumber: 1 }] }
          }
        },
        context
      )
    ).toBe(false);

    const contradictory = {
      ...response,
      response: {
        ...response.response,
        page: {
          ...page,
          rows: [
            {
              ...page.rows[0],
              values: [{ kind: "string", raw: "1", display: "1", isNull: false, isNaN: false }, page.rows[0].values[1]]
            }
          ]
        }
      }
    };
    expect(isRProviderResponseEnvelope(contradictory)).toBe(true);
    expect(isRProviderResponseEnvelopeForDispatch(contradictory, context)).toBe(false);

    const impossibleNull = {
      ...response,
      response: {
        ...response.response,
        page: {
          ...page,
          rows: [
            {
              ...page.rows[0],
              values: [{ kind: "null", raw: null, display: "", isNull: true, isNaN: false }, page.rows[0].values[1]]
            }
          ]
        }
      }
    };
    expect(isRProviderResponseEnvelope(impossibleNull)).toBe(true);
    expect(isRProviderResponseEnvelopeForDispatch(impossibleNull, context)).toBe(false);

    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          requestId: "page",
          response: {
            kind: "error",
            code: "invalid_request",
            message: "failed",
            recoverable: false
          }
        },
        context
      )
    ).toBe(true);
  });

  it.each([
    {
      protocolVersion: 1,
      requestId: "initialize",
      response: { kind: "sessionClosed", sessionId: "r-session" }
    },
    {
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "open",
      response: {
        kind: "sessionOpened",
        metadata: {
          providerProtocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          sessionId: "r-session",
          backend: "r",
          mode: "viewing",
          source: {
            kind: "notebookVariable",
            label: "orders",
            variableName: "orders",
            discoveryId: "r:d:1:1"
          },
          sourceClass: "data.frame",
          shape: { rows: 1, columns: 2 },
          schema: [schema[1], schema[0]]
        },
        page
      }
    },
    {
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "open",
      response: {
        kind: "sessionOpened",
        metadata: {
          providerProtocolVersion: R_PROVIDER_PROTOCOL_VERSION,
          sessionId: "r-session",
          backend: "r",
          mode: "viewing",
          source: {
            kind: "notebookVariable",
            label: "orders",
            variableName: "orders",
            discoveryId: "r:d:1:1"
          },
          sourceClass: "data.frame",
          shape: { rows: 1, columns: 2 },
          schema
        },
        page: { ...page, columnIds: ["r:c:1", "r:c:0"] }
      }
    },
    {
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "error",
      response: {
        kind: "error",
        code: "invalid_request",
        message: "bad request",
        recoverable: false,
        detail: "unexpected"
      }
    },
    {
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "page",
      response: {
        kind: "page",
        sessionId: "r-session",
        revision: 0,
        page
      }
    }
  ])("rejects malformed or non-canonical provider data", (value) => {
    expect(isRProviderResponseEnvelope(value)).toBe(false);
  });
});
