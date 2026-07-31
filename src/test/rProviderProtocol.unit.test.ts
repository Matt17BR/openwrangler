import { describe, expect, it } from "vitest";
import { isRProviderResponseEnvelope } from "../extension/r/rProviderProtocol";

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
