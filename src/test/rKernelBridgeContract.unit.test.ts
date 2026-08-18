import { describe, expect, it } from "vitest";
import type { OpenSessionRequest } from "../shared/protocol";
import type { RFramePageContract } from "../extension/r/rFrameContract";
import {
  R_BRIDGE_CAPABILITIES,
  assertMutationContract,
  assertRExportResult,
  assertSessionContract,
  clearDraft,
  copyFilterModel,
  errorResponse,
  isExportableRSource,
  metadataFor,
  rExportProtectedSourceUris,
  sessionFromContract,
  staleRevisionError,
  validateMutationRequest,
  validateOpenRequest,
  withHostSessionIdentity
} from "../extension/r/rKernelBridgeContract";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("R kernel bridge contract", () => {
  it("assigns and validates exact host-owned open-session identity", () => {
    const request = openRequest();
    expect(withHostSessionIdentity(request, () => "unused")).toBe(request);
    expect(
      withHostSessionIdentity({ ...request, requestedSessionId: undefined }, () => sessionId).requestedSessionId
    ).toBe(sessionId);
    expect(validateOpenRequest(request)).toBeUndefined();
    expect(validateOpenRequest({ ...request, backend: "pandas" })).toMatchObject({
      kind: "error",
      code: "unsupported_backend",
      sessionId
    });
    expect(validateOpenRequest({ ...request, requestedSessionId: "" })).toMatchObject({
      code: "invalid_session_id",
      recoverable: false
    });
    expect(validateOpenRequest({ ...request, pageSize: 0 })).toMatchObject({ code: "invalid_page" });
  });

  it("builds isolated session metadata and exact source capabilities", () => {
    const contract = frameContract();
    const session = sessionFromContract(sessionId, openRequest().source, "editing", contract, ["csv"]);
    session.filterModel = {
      filters: [
        {
          column: "value",
          type: "float",
          predicates: [{ kind: "predicate", operator: "gt", value: 1 }],
          valueFilter: { kind: "values", selectedValues: [1], includeNulls: false, includeNaN: false }
        }
      ],
      sort: []
    };
    const metadata = metadataFor(session);
    expect(metadata).toMatchObject({
      protocolVersion: 2,
      sessionId,
      backend: "r",
      mode: "editing",
      capabilities: { exportCsv: true, exportParquet: false, notebookInsert: true },
      shape: { rows: 1, columns: 1 }
    });
    expect(metadata.source).not.toBe(session.source);
    expect(metadata.schema).not.toBe(session.schema);
    expect(metadata.filterModel).not.toBe(session.filterModel);
    expect(metadata.filterModel.filters[0]?.predicates).not.toBe(session.filterModel.filters[0]?.predicates);
    expect(metadata.filterModel.filters[0]?.valueFilter?.selectedValues).not.toBe(
      session.filterModel.filters[0]?.valueFilter?.selectedValues
    );
    expect(R_BRIDGE_CAPABILITIES).toMatchObject({ editable: true, notebookInsert: true, documentInsert: true });
  });

  it("validates projected session contracts and bounded dynamic nullability", () => {
    const contract = frameContract();
    const session = sessionFromContract(sessionId, openRequest().source, "editing", contract, []);
    const window = { offset: 0, limit: 1, columnOffset: 0, columnLimit: 1 };
    expect(() =>
      assertSessionContract(session, contract, window, session.schema, 1, 1, [], "positional", emptyView)
    ).not.toThrow();
    expect(() =>
      assertSessionContract(
        session,
        { ...contract, page: { ...contract.page, columnIds: ["wrong"] } },
        window,
        session.schema,
        1,
        1,
        [],
        "positional",
        emptyView
      )
    ).toThrow("column projection");

    const expected = [{ ...session.schema[0]!, nullable: true }];
    const actual = {
      ...contract,
      schema: [{ ...contract.schema[0]!, nullable: false }]
    };
    expect(() =>
      assertMutationContract(session, actual, window, expected, 1, 1, [], "positional", emptyView, {
        columnId: "r:c:0",
        mode: "mayRemove"
      })
    ).not.toThrow();
    expect(() =>
      assertMutationContract(
        session,
        contract,
        window,
        [{ ...session.schema[0]!, nullable: false }],
        1,
        1,
        [],
        "positional",
        emptyView,
        {
          columnId: "r:c:0",
          mode: "mayRemove"
        }
      )
    ).toThrow("invalid nullability");
  });

  it("owns edit preconditions, stale revisions, and complete draft cleanup", () => {
    const session = sessionFromContract(sessionId, openRequest().source, "viewing", frameContract(), []);
    expect(
      validateMutationRequest(session, 0, {
        sessionId,
        offset: 0,
        limit: 1,
        columnOffset: 0,
        columnLimit: 1
      })
    ).toMatchObject({ code: "unsupported_mode" });
    session.mode = "editing";
    session.revision = 2;
    expect(staleRevisionError(session, 1, "view-1")).toEqual({
      kind: "error",
      code: "stale_revision",
      message: "This R session is at revision 2, not 1.",
      recoverable: true,
      sessionId,
      viewRequestId: "view-1"
    });
    expect(
      validateMutationRequest(session, 2, {
        sessionId,
        offset: 0,
        limit: 1,
        columnOffset: 0,
        columnLimit: 1
      })
    ).toBeUndefined();

    session.draftStep = {
      id: "rename",
      kind: "renameColumn",
      params: { column: { id: "r:c:0", name: "value" }, newName: "renamed" }
    };
    session.draftReplacesStepId = "old";
    session.draftInputSchema = session.schema;
    session.draftBaseFilterModel = { filters: [], sort: [] };
    clearDraft(session);
    expect(session).toMatchObject({ draftInputCustomRowIdentities: undefined });
    expect(session.draftStep).toBeUndefined();
    expect(session.draftReplacesStepId).toBeUndefined();
    expect(session.draftInputSchema).toBeUndefined();
    expect(session.draftBaseFilterModel).toBeUndefined();
  });

  it("guards source authority and exact export receipts", () => {
    const source = openRequest().source;
    expect(isExportableRSource(source)).toBe(true);
    expect(rExportProtectedSourceUris(source).map((uri) => uri.toString())).toEqual(["file:///workspace/orders.ipynb"]);
    expect(isExportableRSource({ ...source, uri: "vscode-remote://host/workspace/orders.ipynb" })).toBe(false);
    expect(() => rExportProtectedSourceUris({ ...source, uri: "vscode-remote://host/workspace/orders.ipynb" })).toThrow(
      "requires a local R notebook"
    );
    expect(() =>
      assertRExportResult({ sessionId, revision: 3, format: "csv", rows: 1, columns: 1 }, sessionId, 3, "csv", 1, 1)
    ).not.toThrow();
    expect(() =>
      assertRExportResult({ sessionId, revision: 3, format: "csv", rows: 2, columns: 1 }, sessionId, 3, "csv", 1, 1)
    ).toThrow("mismatched cleaned-data export result");
  });

  it("deep-copies filter state and omits absent error correlations", () => {
    const model = {
      logic: "and" as const,
      filters: [
        {
          column: "value",
          type: "float" as const,
          predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 1 }],
          valueFilter: { kind: "values" as const, selectedValues: [1], includeNulls: false, includeNaN: false }
        }
      ],
      sort: [{ column: "value", direction: "asc" as const, nulls: "last" as const }]
    };
    const copied = copyFilterModel(model);
    expect(copied).toEqual(model);
    expect(copied.filters[0]?.predicates).not.toBe(model.filters[0]?.predicates);
    expect(copied.filters[0]?.valueFilter?.selectedValues).not.toBe(model.filters[0]?.valueFilter?.selectedValues);
    expect(errorResponse("failed", "no", false)).toEqual({
      kind: "error",
      code: "failed",
      message: "no",
      recoverable: false
    });
  });
});

function openRequest(): OpenSessionRequest {
  return {
    kind: "openSession",
    source: {
      kind: "notebookVariable",
      label: "orders",
      uri: "file:///workspace/orders.ipynb",
      variableName: "orders"
    },
    requestedSessionId: sessionId,
    backend: "r",
    mode: "editing",
    pageSize: 1,
    columnOffset: 0,
    columnLimit: 1
  };
}

function frameContract(): RFramePageContract {
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: 1, columns: 1 },
    frameSemantics: { classes: ["data.frame"], rowNames: "positional", keyColumnIds: [] },
    schema: [
      {
        id: "r:c:0",
        name: "value",
        position: 0,
        rawType: "double",
        type: "float",
        nullable: true,
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

const emptyView = Object.freeze({ filters: Object.freeze([]), sorts: Object.freeze([]) });
