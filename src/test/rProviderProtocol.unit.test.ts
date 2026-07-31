import { describe, expect, it } from "vitest";
import {
  type RProviderConfirmedSession,
  type RProviderGetPageRequest,
  type RProviderOpenSessionRequest,
  isRProviderResponseEnvelope,
  isRProviderResponseEnvelopeForDispatch
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
  providerProtocolVersion: 1,
  sessionId: "r-session",
  backend: "r",
  mode: "viewing",
  source: {
    kind: "notebookVariable",
    label: "orders",
    variableName: "orders"
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
  it("accepts the bounded native-R initialization contract", () => {
    expect(
      isRProviderResponseEnvelope({
        protocolVersion: 1,
        requestId: "initialize",
        response: {
          kind: "initialized",
          runtimeVersion: "0.1.0",
          language: "r",
          transport: "inProcessR",
          capabilities: {
            sourceKinds: ["notebookVariable"],
            dataFrameClasses: ["data.frame", "tbl_df", "data.table"],
            paging: true,
            filtering: false,
            sorting: false,
            editing: false
          }
        }
      })
    ).toBe(true);
  });

  it("accepts a full-width schema with a projected page", () => {
    expect(
      isRProviderResponseEnvelope({
        protocolVersion: 1,
        requestId: "open",
        response: {
          kind: "sessionOpened",
          metadata: {
            providerProtocolVersion: 1,
            sessionId: "r-session",
            backend: "r",
            mode: "viewing",
            source: {
              kind: "notebookVariable",
              label: "orders",
              variableName: "orders"
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

  it("accepts a correlated projected page", () => {
    expect(
      isRProviderResponseEnvelope({
        protocolVersion: 1,
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

  it("accepts only responses correlated to the exact dispatched request and confirmed session", () => {
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: 1,
          requestId: "initialize",
          response: {
            kind: "initialized",
            runtimeVersion: "0.1.0",
            language: "r",
            transport: "inProcessR",
            capabilities: {
              sourceKinds: ["notebookVariable"],
              dataFrameClasses: ["data.frame", "tbl_df", "data.table"],
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
          protocolVersion: 1,
          requestId: "open",
          response: { kind: "sessionOpened", metadata, page }
        },
        { requestId: "open", request: openRequest }
      )
    ).toBe(true);
    expect(
      isRProviderResponseEnvelopeForDispatch(
        {
          protocolVersion: 1,
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
          protocolVersion: 1,
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
      protocolVersion: 1,
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
          protocolVersion: 1,
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
          protocolVersion: 1,
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
          protocolVersion: 1,
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
      protocolVersion: 2,
      requestId: "initialize",
      response: { kind: "sessionClosed", sessionId: "r-session" }
    },
    {
      protocolVersion: 1,
      requestId: "open",
      response: {
        kind: "sessionOpened",
        metadata: {
          providerProtocolVersion: 1,
          sessionId: "r-session",
          backend: "r",
          mode: "viewing",
          source: { kind: "notebookVariable", label: "orders", variableName: "orders" },
          sourceClass: "data.frame",
          shape: { rows: 1, columns: 2 },
          schema: [schema[1], schema[0]]
        },
        page
      }
    },
    {
      protocolVersion: 1,
      requestId: "open",
      response: {
        kind: "sessionOpened",
        metadata: {
          providerProtocolVersion: 1,
          sessionId: "r-session",
          backend: "r",
          mode: "viewing",
          source: { kind: "notebookVariable", label: "orders", variableName: "orders" },
          sourceClass: "data.frame",
          shape: { rows: 1, columns: 2 },
          schema
        },
        page: { ...page, columnIds: ["r:c:1", "r:c:0"] }
      }
    },
    {
      protocolVersion: 1,
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
      protocolVersion: 1,
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
