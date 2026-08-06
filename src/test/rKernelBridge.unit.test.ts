import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type {
  CastColumnTransformStep,
  CloneColumnTransformStep,
  ColumnSummary,
  DataDiff,
  DatasetStats,
  OpenSessionRequest,
  OpenWranglerRequest,
  SelectColumnsTransformStep,
  SourceCapabilities,
  TextLengthTransformStep
} from "../shared/protocol";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import { RKernelBridge, type RKernelBridgeTransport } from "../extension/r/rKernelBridge";
import type { RKernelStepPreviewResult } from "../extension/r/rKernelProtocol";
import {
  R_FRAME_CONTRACT_LIMITS,
  type RColumnSchema,
  type RFrameCell,
  type RFramePageContract
} from "../extension/r/rFrameContract";
import type { RNotebookVariableDescriptor } from "../extension/r/rNotebookVariableDiscovery";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("canonical R kernel bridge", () => {
  it("checks the opened frame flavor against the verified picker selection", async () => {
    const transport = fakeTransport(frameContract());
    const verifiedVariable: RNotebookVariableDescriptor = {
      name: "orders",
      backend: "r",
      dataframeFlavor: "r.tibble"
    };
    const bridge = createBridge(transport, undefined, undefined, verifiedVariable);

    await expect(bridge.request(openRequest())).rejects.toThrow("dataframe changed");
    expect(transport.open).toHaveBeenCalledOnce();
  });

  it("opens a host-owned read-only R session and maps exact R cells", async () => {
    const contract = frameContract();
    const transport = fakeTransport(contract);
    const bridge = createBridge(transport);

    await expect(bridge.request({ kind: "initialize" })).resolves.toEqual({
      kind: "initialized",
      protocolVersion: 2,
      runtimeVersion: "2.0.0-preview.1",
      capabilities: rCapabilities(true)
    });

    const response = await bridge.request(openRequest());

    expect(transport.open).toHaveBeenCalledWith(
      "orders",
      {
        rowOffset: 0,
        rowLimit: 20,
        columnOffset: 0,
        columnLimit: 8,
        view: { filters: [], sorts: [] }
      },
      expect.objectContaining({ requestedSessionId: sessionId })
    );
    expect(response).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        sessionId,
        revision: 0,
        backend: "r",
        rDataframeFlavor: "r.data.frame",
        mode: "viewing",
        capabilities: rCapabilities(),
        shape: { rows: 1, columns: 8 },
        filteredShape: { rows: 1, columns: 8 },
        filterModel: { filters: [], sort: [] },
        steps: []
      },
      summaries: []
    });
    if (response.kind !== "sessionOpened") throw new Error("Expected an R session.");
    expect(response.page.rows[0]?.values).toEqual([
      cell("number", 12.5, "12.5"),
      cell("integer", "9223372036854775807", "9223372036854775807"),
      cell("date", "2026-08-05", "2026-08-05"),
      cell("datetime", "1785945600", "2026-08-05T12:00:00Z"),
      cell("duration", "90", "90 secs"),
      cell("boolean", true, "TRUE"),
      cell("null", null, "NA", true, false),
      { ...cell("infinity", null, "Inf"), sign: 1 }
    ]);
  });

  it("advertises source insertion instead of notebook insertion for a plain R document", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    const request: OpenSessionRequest = {
      ...openRequest("editing"),
      source: {
        kind: "documentVariable",
        label: "orders",
        uri: "file:///workspace/orders.R",
        variableName: "orders"
      }
    };

    const response = await bridge.request(request);

    expect(response).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        backend: "r",
        source: request.source,
        capabilities: {
          notebookInsert: false,
          documentInsert: true
        }
      }
    });
  });

  it("maps explicit R row names into canonical grid row labels", async () => {
    const transport = fakeTransport(frameContract({ explicitRowLabel: "Mazda RX4" }));
    const bridge = createBridge(transport);

    const response = await bridge.request(openRequest());

    expect(response).toMatchObject({
      kind: "sessionOpened",
      page: {
        rows: [{ id: "r:r:0", rowNumber: 0, rowLabel: "Mazda RX4" }]
      }
    });
  });

  it("assigns a host session identity when the panel omits one", async () => {
    const generatedSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const transport = fakeTransport(frameContract(), generatedSessionId);
    const bridge = createBridge(transport, () => generatedSessionId);
    const { requestedSessionId: _omitted, ...request } = openRequest();

    const response = await bridge.request(request);

    expect(response).toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: generatedSessionId }
    });
    expect(transport.open).toHaveBeenCalledWith(
      "orders",
      expect.any(Object),
      expect.objectContaining({ requestedSessionId: generatedSessionId })
    );
  });

  it("resolves compound viewing sorts to stable R column references in priority order", async () => {
    const contract = frameContract();
    const transport = fakeTransport(contract);
    const bridge = createBridge(transport);
    await bridge.request(openRequest());

    const response = await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "view-2",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [],
        sort: [
          { column: "count", direction: "desc", nulls: "last" },
          { column: "when", direction: "asc", nulls: "first" }
        ]
      }
    });

    expect(transport.getPage).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        view: {
          filters: [],
          sorts: [
            { column: { id: "r:c:1", name: "count" }, direction: "desc", nulls: "last" },
            { column: { id: "r:c:3", name: "when" }, direction: "asc", nulls: "first" }
          ]
        }
      }),
      expect.any(Object)
    );
    expect(response).toMatchObject({
      kind: "page",
      revision: 0,
      viewRequestId: "view-2",
      metadata: {
        filterModel: {
          sort: [
            { column: "count", direction: "desc", nulls: "last" },
            { column: "when", direction: "asc", nulls: "first" }
          ]
        }
      }
    });
  });

  it("rejects ambiguous name-addressed sorts before dispatch", async () => {
    const contract = frameContract({ duplicateFirstName: true });
    const transport = fakeTransport(contract);
    const bridge = createBridge(transport);
    await bridge.request(openRequest());

    const response = await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "ambiguous",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [],
        sort: [{ column: "value", direction: "asc", nulls: "last" }]
      }
    });

    expect(response).toMatchObject({
      kind: "error",
      code: "invalid_view",
      sessionId,
      viewRequestId: "ambiguous",
      message: expect.stringContaining("ambiguous")
    });
    expect(transport.getPage).not.toHaveBeenCalled();
  });

  it("binds value search and its complete filter model to stable R columns", async () => {
    const transport = fakeTransport(frameContract());
    transport.getColumnValues.mockResolvedValueOnce({
      column: "count",
      values: [
        {
          value: "9223372036854775807",
          count: 1,
          selectionValue: {
            kind: "typedSelection",
            version: 1,
            columnType: "integer",
            cell: {
              kind: "integer",
              raw: "9223372036854775807",
              display: "9223372036854775807",
              isNull: false,
              isNaN: false
            }
          }
        }
      ],
      hasMore: false
    });
    const bridge = createBridge(transport);
    await bridge.request(openRequest());

    const response = await bridge.request({
      kind: "getColumnValues",
      sessionId,
      revision: 0,
      viewRequestId: "values-1",
      column: "count",
      search: "9223",
      limit: 10,
      filterModel: {
        logic: "or",
        filters: [
          {
            column: "value",
            type: "float",
            logic: "or",
            valueFilter: { kind: "values", selectedValues: [12.5], includeNulls: true, includeNaN: true },
            predicates: [{ kind: "predicate", operator: "between", value: 1, secondValue: 20 }]
          }
        ],
        sort: [{ column: "when", direction: "desc", nulls: "first" }]
      }
    });

    expect(transport.getColumnValues).toHaveBeenCalledWith(
      sessionId,
      { id: "r:c:1", name: "count" },
      expect.objectContaining({
        logic: "or",
        filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" }, type: "float" })],
        sorts: [expect.objectContaining({ column: { id: "r:c:3", name: "when" } })]
      }),
      "9223",
      10,
      expect.any(Object)
    );
    expect(response).toMatchObject({
      kind: "columnValues",
      viewRequestId: "values-1",
      column: "count",
      values: [{ value: "9223372036854775807", count: 1 }],
      hasMore: false
    });

    transport.getColumnValues.mockResolvedValueOnce({
      column: "count",
      values: [
        {
          value: "1",
          count: 1,
          selectionValue: {
            kind: "typedSelection",
            version: 1,
            columnType: "float",
            cell: { kind: "number", raw: 1, display: "1", isNull: false, isNaN: false }
          }
        }
      ],
      hasMore: false
    });
    await expect(
      bridge.request({
        kind: "getColumnValues",
        sessionId,
        revision: 0,
        viewRequestId: "values-wrong-type",
        column: "count",
        limit: 10,
        filterModel: { filters: [], sort: [] }
      })
    ).rejects.toThrow("incompatible typed selections");
  });

  it("maps projected native R profiles and dataset statistics to the current view", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());

    const summary = await bridge.request({
      kind: "getSummary",
      sessionId,
      revision: 0,
      viewRequestId: "summary-1",
      filterModel: {
        filters: [],
        sort: [{ column: "count", direction: "desc", nulls: "last" }]
      },
      columnIds: ["r:c:0"]
    });
    expect(transport.getSummary).toHaveBeenCalledWith(
      sessionId,
      [{ id: "r:c:0", name: "value" }],
      expect.objectContaining({ sorts: [expect.objectContaining({ column: { id: "r:c:1", name: "count" } })] }),
      expect.any(Object)
    );
    expect(summary).toMatchObject({
      kind: "summary",
      revision: 0,
      viewRequestId: "summary-1",
      summaries: [{ columnId: "r:c:0", column: "value", type: "float", totalCount: 1 }]
    });

    const stats = await bridge.request({
      kind: "getDatasetStats",
      sessionId,
      revision: 0,
      viewRequestId: "stats-1",
      filterModel: { filters: [], sort: [] }
    });
    expect(transport.getDatasetStats).toHaveBeenCalledWith(sessionId, { filters: [], sorts: [] }, expect.any(Object));
    expect(stats).toMatchObject({
      kind: "datasetStats",
      revision: 0,
      viewRequestId: "stats-1",
      stats: { missingCells: 1, missingRows: 1, duplicateRows: 0 }
    });
  });

  it("binds filtered R profile work to stable column identities and rejects mis-correlation", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());

    await expect(
      bridge.request({
        kind: "getSummary",
        sessionId,
        revision: 0,
        viewRequestId: "filtered-summary",
        filterModel: {
          filters: [
            {
              column: "value",
              type: "float",
              predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
            }
          ],
          sort: []
        },
        columnIds: ["r:c:0"]
      })
    ).resolves.toMatchObject({ kind: "summary", viewRequestId: "filtered-summary" });
    expect(transport.getSummary).toHaveBeenCalledWith(
      sessionId,
      [{ id: "r:c:0", name: "value" }],
      expect.objectContaining({
        filters: [
          expect.objectContaining({
            column: { id: "r:c:0", name: "value" },
            type: "float",
            predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
          })
        ]
      }),
      expect.any(Object)
    );

    transport.getSummary.mockResolvedValueOnce([
      {
        ...summaryFor(frameContract(), { id: "r:c:0", name: "value" }),
        columnId: "r:c:1"
      }
    ]);
    await expect(
      bridge.request({
        kind: "getSummary",
        sessionId,
        revision: 0,
        viewRequestId: "wrong-summary",
        filterModel: { filters: [], sort: [] },
        columnIds: ["r:c:0"]
      })
    ).rejects.toThrow("active dataframe");

    transport.getDatasetStats.mockResolvedValueOnce({
      totalRows: 1,
      stats: {
        ...datasetStatsFor(frameContract()),
        duplicateRows: 1
      }
    });
    await expect(
      bridge.request({
        kind: "getDatasetStats",
        sessionId,
        revision: 0,
        viewRequestId: "wrong-stats",
        filterModel: { filters: [], sort: [] }
      })
    ).rejects.toThrow("active dataframe shape");
  });

  it("rejects dataset statistics that exceed their correlated filtered row count", async () => {
    const contract = frameContract({ totalRows: 3 });
    const transport = fakeTransport(contract);
    const bridge = createBridge(transport);
    await bridge.request(openRequest());
    const stats = datasetStatsFor(contract);
    transport.getDatasetStats.mockResolvedValueOnce({
      totalRows: 1,
      stats: {
        ...stats,
        missingCells: 2,
        missingRows: 2,
        missingValuesByColumn: stats.missingValuesByColumn.map((entry, index) => ({
          ...entry,
          count: index === 0 ? 2 : 0
        }))
      }
    });

    await expect(
      bridge.request({
        kind: "getDatasetStats",
        sessionId,
        revision: 0,
        viewRequestId: "filtered-stats",
        filterModel: {
          filters: [
            {
              column: "value",
              type: "float",
              predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
            }
          ],
          sort: []
        }
      })
    ).rejects.toThrow("active dataframe shape");
  });

  it("keeps mutations out of viewing sessions and unsupported exports out of IRkernel", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());
    const requests: OpenWranglerRequest[] = [
      {
        kind: "applyDraft",
        sessionId,
        revision: 0,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      },
      {
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/tmp/out.csv",
        format: "csv"
      }
    ];

    await expect(bridge.request(requests[0] as OpenWranglerRequest)).resolves.toMatchObject({
      kind: "error",
      code: "unsupported_mode",
      sessionId
    });
    await expect(bridge.request(requests[1] as OpenWranglerRequest)).resolves.toMatchObject({
      kind: "error",
      code: "unsupported_operation",
      sessionId
    });
    expect(transport.getPage).not.toHaveBeenCalled();
    expect(transport.getSummary).not.toHaveBeenCalled();
    expect(transport.getDatasetStats).not.toHaveBeenCalled();
    expect(transport.open).toHaveBeenCalledTimes(1);
  });

  it("publishes one native R rename draft, applied plan, inspection, and undo atomically", async () => {
    const source = frameContract();
    const renamed = renameContract(source, "r:c:0", "amount");
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    const opened = await bridge.request(openRequest("editing"));
    expect(opened).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        mode: "editing",
        capabilities: {
          editable: true,
          supportedOperations: [
            "selectColumns",
            "dropColumns",
            "renameColumn",
            "cloneColumn",
            "castColumn",
            "textLength",
            "lowerText"
          ]
        }
      }
    });

    transport.getPage.mockResolvedValueOnce(source);
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: "filtered-before-draft",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: {
          filters: [
            {
              column: "value",
              type: "float",
              predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
            }
          ],
          sort: [{ column: "value", direction: "desc", nulls: "last" }]
        }
      })
    ).resolves.toMatchObject({ kind: "page", revision: 0 });

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: renamed,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders"
    });
    const preview = await bridge.request(renamePreviewRequest(0));
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      {
        id: "r-step-1",
        kind: "renameColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "amount" }
      },
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:0", name: "amount" } })],
          sorts: [expect.objectContaining({ column: { id: "r:c:0", name: "amount" } })]
        }
      }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      metadata: {
        revision: 1,
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:0", name: "amount" })]),
        filterModel: {
          filters: expect.arrayContaining([expect.objectContaining({ column: "amount" })]),
          sort: expect.arrayContaining([expect.objectContaining({ column: "amount" })])
        },
        steps: [],
        draftStep: { id: "r-step-1", kind: "renameColumn" }
      },
      code: "open_wrangler_result <- orders"
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: renamed,
      code: "open_wrangler_result <- orders"
    });
    const applied = await bridge.request(planRequest("applyDraft", 1));
    expect(applied).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2,
      metadata: {
        revision: 2,
        steps: [{ id: "r-step-1", kind: "renameColumn" }],
        latestStepInputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:0", name: "value" })]),
        filterModel: {
          filters: expect.arrayContaining([expect.objectContaining({ column: "amount" })]),
          sort: expect.arrayContaining([expect.objectContaining({ column: "amount" })])
        }
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-step-1",
      stepIndex: 0,
      inputPage: source,
      outputPage: renamed,
      inputSchema: source.schema,
      outputSchema: renamed.schema,
      code: "open_wrangler_result <- orders"
    });
    const inspection = await bridge.request({
      kind: "inspectStep",
      sessionId,
      revision: 2,
      stepId: "r-step-1",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.inspectStep).toHaveBeenCalledWith(
      sessionId,
      2,
      "r-step-1",
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      expect.any(Array),
      expect.any(Array),
      expect.any(Object)
    );
    expect(inspection).toMatchObject({
      kind: "stepInspection",
      revision: 2,
      stepId: "r-step-1",
      stepIndex: 0,
      inputSchema: expect.arrayContaining([expect.objectContaining({ name: "value" })]),
      outputSchema: expect.arrayContaining([expect.objectContaining({ name: "amount" })])
    });

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 3,
      page: source,
      code: ""
    });
    const undone = await bridge.request(planRequest("undoStep", 2));
    expect(transport.undoStep).toHaveBeenCalledWith(
      sessionId,
      2,
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })],
          sorts: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })]
        }
      }),
      expect.any(Object)
    );
    expect(undone).toMatchObject({
      kind: "planUpdated",
      action: "undo",
      revision: 3,
      metadata: {
        steps: [],
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:0", name: "value" })]),
        filterModel: {
          filters: expect.arrayContaining([expect.objectContaining({ column: "value" })]),
          sort: expect.arrayContaining([expect.objectContaining({ column: "value" })])
        }
      }
    });
  });

  it("drops exact R columns without renumbering survivors and restores the view on undo", async () => {
    const source = frameContract();
    const dropped = dropContract(source, ["r:c:0"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.getPage.mockResolvedValueOnce(source);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "drop-view",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [
          {
            column: "value",
            type: "float",
            predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
          }
        ],
        sort: [{ column: "count", direction: "desc", nulls: "last" }]
      }
    });

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: dropped,
      diff: dropDiff("value"),
      code: "open_wrangler_result <- orders"
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: {
        id: "r-drop-1",
        kind: "dropColumns",
        params: { columns: [{ id: "r:c:0", name: "value" }] }
      },
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      {
        id: "r-drop-1",
        kind: "dropColumns",
        params: { columns: [{ id: "r:c:0", name: "value" }] }
      },
      expect.objectContaining({
        view: {
          filters: [],
          sorts: [expect.objectContaining({ column: { id: "r:c:1", name: "count" } })]
        }
      }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      metadata: {
        shape: { rows: 1, columns: 7 },
        filteredShape: { rows: 1, columns: 7 },
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:1", name: "count", position: 0 })]),
        filterModel: { filters: [], sort: [expect.objectContaining({ column: "count" })] },
        draftStep: { id: "r-drop-1", kind: "dropColumns" }
      },
      diff: { removedColumns: ["value"] }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: dropped,
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: { steps: [{ id: "r-drop-1", kind: "dropColumns" }] }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-drop-1",
      stepIndex: 0,
      inputPage: source,
      outputPage: dropped,
      inputSchema: source.schema,
      outputSchema: dropped.schema,
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-drop-1",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "stepInspection", diff: { removedColumns: ["value"] } });

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 3,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("undoStep", 2))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        shape: { rows: 1, columns: 8 },
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "count" })]
        }
      }
    });
  });

  it("selects and reorders exact R columns through the complete mutation lifecycle", async () => {
    const source = dataTableContract(frameContract(), ["r:c:0", "r:c:1"]);
    const selected = selectContract(source, ["r:c:3", "r:c:1", "r:c:0"]);
    const editedSelection = selectContract(source, ["r:c:0", "r:c:1"]);
    const firstRemoved = ["date", "elapsed", "flag", "missing", "infinite"];
    const editedRemoved = ["date", "when", "elapsed", "flag", "missing", "infinite"];
    const selectStep: SelectColumnsTransformStep = {
      id: "r-select-1",
      kind: "selectColumns",
      params: {
        columns: [
          { id: "r:c:3", name: "when" },
          { id: "r:c:1", name: "count" },
          { id: "r:c:0", name: "value" }
        ]
      }
    };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.getPage.mockResolvedValueOnce(source);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "select-view",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [
          {
            column: "value",
            type: "float",
            predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
          }
        ],
        sort: [
          { column: "date", direction: "asc", nulls: "first" },
          { column: "count", direction: "desc", nulls: "last" }
        ]
      }
    });

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: selected,
      diff: dropDiff(...firstRemoved),
      code: "open_wrangler_result <- orders[c(4L, 2L, 1L)]"
    });
    const previewRequest = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step: selectStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    };
    const preview = await bridge.request(previewRequest);
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      selectStep,
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })],
          sorts: [expect.objectContaining({ column: { id: "r:c:1", name: "count" } })]
        }
      }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      metadata: {
        shape: { rows: 1, columns: 3 },
        schema: [
          { id: "r:c:3", name: "when", position: 0, type: "datetime", nullable: true },
          { id: "r:c:1", name: "count", position: 1, type: "integer", nullable: true },
          { id: "r:c:0", name: "value", position: 2, type: "float", nullable: true }
        ],
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "count" })]
        },
        draftStep: { id: "r-select-1", kind: "selectColumns" }
      },
      diff: { removedColumns: firstRemoved }
    });

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 2,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("discardDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "date" }), expect.objectContaining({ column: "count" })]
        }
      }
    });

    transport.queuePreview({
      sessionId,
      revision: 3,
      page: selected,
      diff: dropDiff(...firstRemoved),
      code: "open_wrangler_result <- orders[c(4L, 2L, 1L)]"
    });
    await bridge.request({ ...previewRequest, revision: 2 });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 4,
      page: selected,
      code: "open_wrangler_result <- orders[c(4L, 2L, 1L)]"
    });
    await expect(bridge.request(planRequest("applyDraft", 3))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: { steps: [{ id: "r-select-1", kind: "selectColumns" }] }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 4,
      stepId: "r-select-1",
      stepIndex: 0,
      inputPage: source,
      outputPage: selected,
      inputSchema: source.schema,
      outputSchema: selected.schema,
      code: "open_wrangler_result <- orders[c(4L, 2L, 1L)]"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 4,
        stepId: "r-select-1",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      outputSchema: [
        expect.objectContaining({ id: "r:c:3", position: 0 }),
        expect.objectContaining({ id: "r:c:1", position: 1 }),
        expect.objectContaining({ id: "r:c:0", position: 2 })
      ],
      diff: { removedColumns: firstRemoved }
    });

    const replacementStep: SelectColumnsTransformStep = {
      id: "r-select-1",
      kind: "selectColumns",
      params: {
        columns: [
          { id: "r:c:0", name: "value" },
          { id: "r:c:1", name: "count" }
        ]
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 5,
      page: editedSelection,
      diff: dropDiff(...editedRemoved),
      code: "open_wrangler_result <- orders[c(1L, 2L)]"
    });
    await expect(
      bridge.request({
        ...previewRequest,
        revision: 4,
        replaceStepId: "r-select-1",
        step: replacementStep
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: {
        draftReplacesStepId: "r-select-1",
        draftStep: { id: "r-select-1", kind: "selectColumns" },
        latestStepInputSchema: [
          expect.objectContaining({ id: "r:c:0", name: "value", position: 0 }),
          expect.objectContaining({ id: "r:c:1", name: "count", position: 1 }),
          expect.objectContaining({ id: "r:c:2", name: "date", position: 2 }),
          expect.objectContaining({ id: "r:c:3", name: "when", position: 3 }),
          expect.objectContaining({ id: "r:c:4", name: "elapsed", position: 4 }),
          expect.objectContaining({ id: "r:c:5", name: "flag", position: 5 }),
          expect.objectContaining({ id: "r:c:6", name: "missing", position: 6 }),
          expect.objectContaining({ id: "r:c:7", name: "infinite", position: 7 })
        ]
      }
    });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 6,
      page: editedSelection,
      code: "open_wrangler_result <- orders[c(1L, 2L)]"
    });
    await bridge.request(planRequest("applyDraft", 5));

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 7,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("undoStep", 6))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [],
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "date" }), expect.objectContaining({ column: "count" })]
        }
      }
    });
  });

  it("clones one exact R column with stable lineage through preview, apply, inspection, edit, and undo", async () => {
    const source = dataTableContract(frameContract(), ["r:c:0", "r:c:1"]);
    const cloned = cloneContract(source, "r:c:0", "value_copy", "r-clone-1");
    const edited = cloneContract(source, "r:c:0", "value_duplicate", "r-clone-1");
    const cloneStep: CloneColumnTransformStep = {
      id: "r-clone-1",
      kind: "cloneColumn",
      params: { column: { id: "r:c:0", name: "value" }, newName: "value_copy" }
    };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.getPage.mockResolvedValueOnce(source);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "clone-view",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [
          {
            column: "value",
            type: "float",
            predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
          }
        ],
        sort: [{ column: "count", direction: "desc", nulls: "last" }]
      }
    });

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloned,
      diff: cloneDiff("value_copy"),
      code: "open_wrangler_result <- orders"
    });
    const previewRequest = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step: cloneStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    };
    const preview = await bridge.request(previewRequest);
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      cloneStep,
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })],
          sorts: [expect.objectContaining({ column: { id: "r:c:1", name: "count" } })]
        }
      }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      metadata: {
        shape: { rows: 1, columns: 9 },
        schema: expect.arrayContaining([
          {
            id: "c:step:r-clone-1:0",
            name: "value_copy",
            position: 8,
            rawType: "double",
            type: "float",
            nullable: true
          }
        ]),
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "count" })]
        },
        draftStep: cloneStep
      },
      diff: { addedColumns: ["value_copy"], removedColumns: [] }
    });
    cloneStep.params.newName = "tampered_after_preview";
    expect(preview).toMatchObject({
      metadata: { draftStep: { kind: "cloneColumn", params: { newName: "value_copy" } } }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: cloned,
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [{ id: "r-clone-1", kind: "cloneColumn", params: { newName: "value_copy" } }],
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "count" })]
        }
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-clone-1",
      stepIndex: 0,
      inputPage: source,
      outputPage: cloned,
      inputSchema: source.schema,
      outputSchema: cloned.schema,
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-clone-1",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      outputSchema: expect.arrayContaining([
        expect.objectContaining({ id: "c:step:r-clone-1:0", name: "value_copy", position: 8 })
      ]),
      diff: { addedColumns: ["value_copy"], removedColumns: [] }
    });

    const replacement: CloneColumnTransformStep = {
      id: "r-clone-1",
      kind: "cloneColumn",
      params: { column: { id: "r:c:0", name: "value" }, newName: "value_duplicate" }
    };
    transport.queuePreview({
      sessionId,
      revision: 3,
      page: edited,
      diff: cloneDiff("value_duplicate"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({ ...previewRequest, revision: 2, replaceStepId: "r-clone-1", step: replacement })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: {
        steps: [{ id: "r-clone-1", params: { newName: "value_copy" } }],
        draftStep: { id: "r-clone-1", params: { newName: "value_duplicate" } },
        draftReplacesStepId: "r-clone-1",
        latestStepInputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:0", name: "value" })]),
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "c:step:r-clone-1:0", name: "value_duplicate", position: 8 })
        ])
      }
    });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 4,
      page: edited,
      code: "open_wrangler_result <- orders"
    });
    await bridge.request(planRequest("applyDraft", 3));

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 5,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("undoStep", 4))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [],
        schema: expect.not.arrayContaining([expect.objectContaining({ id: "c:step:r-clone-1:0" })]),
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "count" })]
        }
      }
    });
  });

  it("rejects invalid R clone references, names, identities, and structural diffs before publication", async () => {
    const source = frameContract();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const preview = (step: CloneColumnTransformStep) =>
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });
    for (const step of [
      {
        id: "stale-clone",
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "stale" }, newName: "copy" }
      },
      {
        id: "colliding-clone",
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "count" }
      },
      {
        id: "private-clone",
        kind: "cloneColumn",
        params: {
          column: { id: "r:c:0", name: "value" },
          newName: "__OPEN_WRANGLER_INTERNAL_ROW_ID_forged"
        }
      },
      {
        id: "long-name-clone",
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "é".repeat(513) }
      },
      {
        id: "x".repeat(R_FRAME_CONTRACT_LIMITS.columnIdBytes),
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "copy" }
      }
    ] satisfies CloneColumnTransformStep[]) {
      await expect(preview(step)).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    }
    expect(transport.previewStep).not.toHaveBeenCalled();

    const cloned = cloneContract(source, "r:c:0", "value_copy", "bad-diff-clone");
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloned,
      diff: cloneDiff("wrong_name"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      preview({
        id: "bad-diff-clone",
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "value_copy" }
      })
    ).rejects.toThrow("mutation diff");
  });

  it("rejects cloning a case-insensitive reserved R source column before transport", async () => {
    const base = frameContract();
    const reservedName = "__Open_Wrangler_Internal_Row_Id_source";
    const source = {
      ...base,
      schema: base.schema.map((entry, index) => (index === 0 ? { ...entry, name: reservedName } : entry))
    } satisfies RFramePageContract;
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "reserved-source-clone",
          kind: "cloneColumn",
          params: { column: { id: "r:c:0", name: reservedName }, newName: "copy" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("rejects cloning an R frame at the column limit before transport", async () => {
    const base = frameContract();
    const schema = [
      ...base.schema,
      ...Array.from({ length: R_FRAME_CONTRACT_LIMITS.columns - base.schema.length }, (_, index) => {
        const position = base.schema.length + index;
        return column(position, `extra_${position}`, "double", "float", true, "double");
      })
    ];
    const source = {
      ...base,
      shape: { ...base.shape, columns: R_FRAME_CONTRACT_LIMITS.columns },
      schema
    } satisfies RFramePageContract;
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "maximum-width-clone",
          kind: "cloneColumn",
          params: { column: { id: "r:c:0", name: "value" }, newName: "copy" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("creates native R character lengths with stable lineage and preserves the active view", async () => {
    const source = dataTableContract(frameContract(), ["r:c:0", "r:c:1"]);
    const transformed = textLengthContract(source, "r:c:6", "missing_length", "r-text-length-1");
    const step: TextLengthTransformStep = {
      id: "r-text-length-1",
      kind: "textLength",
      params: { column: { id: "r:c:6", name: "missing" }, newColumn: "missing_length" }
    };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.getPage.mockResolvedValueOnce(source);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "text-length-view",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [
          {
            column: "missing",
            type: "string",
            predicates: [{ kind: "predicate", operator: "contains", value: "a" }]
          }
        ],
        sort: [{ column: "missing", direction: "asc", nulls: "last" }]
      }
    });

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: transformed,
      diff: cloneDiff("missing_length"),
      code: "open_wrangler_result <- orders"
    });
    const previewRequest = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    };
    const preview = await bridge.request(previewRequest);
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      {
        id: "r-text-length-1",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "missing_length" }
      },
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:6", name: "missing" }, type: "string" })],
          sorts: [expect.objectContaining({ column: { id: "r:c:6", name: "missing" } })]
        }
      }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      metadata: {
        shape: { rows: 1, columns: 9 },
        schema: expect.arrayContaining([
          {
            id: "c:step:r-text-length-1:0",
            name: "missing_length",
            position: 8,
            rawType: "integer",
            type: "integer",
            nullable: true
          }
        ]),
        filterModel: {
          filters: [expect.objectContaining({ column: "missing", type: "string" })],
          sort: [expect.objectContaining({ column: "missing" })]
        },
        draftStep: step
      },
      diff: { addedColumns: ["missing_length"], removedColumns: [] }
    });
    step.params.newColumn = "tampered_after_preview";
    expect(preview).toMatchObject({ metadata: { draftStep: { params: { newColumn: "missing_length" } } } });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: transformed,
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [{ id: "r-text-length-1", kind: "textLength", params: { newColumn: "missing_length" } }],
        filterModel: {
          filters: [expect.objectContaining({ column: "missing" })],
          sort: [expect.objectContaining({ column: "missing" })]
        }
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-text-length-1",
      stepIndex: 0,
      inputPage: source,
      outputPage: transformed,
      inputSchema: source.schema,
      outputSchema: transformed.schema,
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-text-length-1",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      outputSchema: expect.arrayContaining([
        expect.objectContaining({ id: "c:step:r-text-length-1:0", name: "missing_length", type: "integer" })
      ]),
      diff: { addedColumns: ["missing_length"], removedColumns: [] }
    });
  });

  it("rejects invalid R Text Length inputs and malformed results before publication", async () => {
    const source = frameContract();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const preview = (step: TextLengthTransformStep) =>
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });

    for (const step of [
      {
        id: "stale-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "stale" }, newColumn: "length" }
      },
      {
        id: "numeric-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:0", name: "value" }, newColumn: "length" }
      },
      {
        id: "colliding-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "count" }
      },
      {
        id: "private-text-length",
        kind: "textLength",
        params: {
          column: { id: "r:c:6", name: "missing" },
          newColumn: "__OPEN_WRANGLER_INTERNAL_ROW_ID_forged"
        }
      },
      {
        id: "long-output-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "é".repeat(513) }
      },
      {
        id: "x".repeat(R_FRAME_CONTRACT_LIMITS.columnIdBytes),
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "length" }
      }
    ] satisfies TextLengthTransformStep[]) {
      await expect(preview(step)).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    }
    expect(transport.previewStep).not.toHaveBeenCalled();

    const validContract = textLengthContract(source, "r:c:6", "missing_length", "bad-schema-text-length");
    const malformed = {
      ...validContract,
      schema: validContract.schema.map((column, index) =>
        index === 8 ? { ...column, rawType: "double", type: "float" as const } : column
      )
    } satisfies RFramePageContract;
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: malformed,
      diff: cloneDiff("missing_length"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      preview({
        id: "bad-schema-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "missing_length" }
      })
    ).rejects.toThrow("schema");

    const diffTransport = fakeTransport(source);
    const diffBridge = createBridge(diffTransport);
    await diffBridge.request(openRequest("editing"));
    diffTransport.queuePreview({
      sessionId,
      revision: 1,
      page: textLengthContract(source, "r:c:6", "missing_length", "bad-diff-text-length"),
      diff: cloneDiff("wrong_name"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      diffBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "bad-diff-text-length",
          kind: "textLength",
          params: { column: { id: "r:c:6", name: "missing" }, newColumn: "missing_length" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("mutation diff");
  });

  it("rejects R Text Length at the frame width limit", async () => {
    const base = frameContract();
    const schema = [
      ...base.schema,
      ...Array.from({ length: R_FRAME_CONTRACT_LIMITS.columns - base.schema.length }, (_, index) => {
        const position = base.schema.length + index;
        return column(position, `extra_${position}`, "double", "float", true, "double");
      })
    ];
    const source = {
      ...base,
      shape: { ...base.shape, columns: R_FRAME_CONTRACT_LIMITS.columns },
      schema
    } satisfies RFramePageContract;
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "maximum-width-text-length",
          kind: "textLength",
          params: { column: { id: "r:c:6", name: "missing" }, newColumn: "length" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("converts native R columns to each supported type with stable identity", async () => {
    const cases = [
      {
        dtype: "string" as const,
        source: { kind: "boolean", raw: true, display: "TRUE", isNull: false, isNaN: false } as RFrameCell,
        after: { kind: "string", raw: "TRUE", display: "TRUE", isNull: false, isNaN: false } as RFrameCell,
        rawType: "character",
        type: "string" as const
      },
      {
        dtype: "integer" as const,
        source: { kind: "string", raw: "42.9", display: "42.9", isNull: false, isNaN: false } as RFrameCell,
        after: { kind: "integer", raw: "42", display: "42", isNull: false, isNaN: false } as RFrameCell,
        rawType: "integer",
        type: "integer" as const
      },
      {
        dtype: "float" as const,
        source: { kind: "string", raw: "42.5", display: "42.5", isNull: false, isNaN: false } as RFrameCell,
        after: { kind: "number", raw: "42.5", display: "42.5", isNull: false, isNaN: false } as RFrameCell,
        rawType: "double",
        type: "float" as const
      },
      {
        dtype: "boolean" as const,
        source: { kind: "string", raw: "true", display: "true", isNull: false, isNaN: false } as RFrameCell,
        after: { kind: "boolean", raw: true, display: "TRUE", isNull: false, isNaN: false } as RFrameCell,
        rawType: "logical",
        type: "boolean" as const
      },
      {
        dtype: "date" as const,
        source: {
          kind: "string",
          raw: "2026-08-05",
          display: "2026-08-05",
          isNull: false,
          isNaN: false
        } as RFrameCell,
        after: {
          kind: "date",
          raw: "2026-08-05",
          display: "2026-08-05",
          isNull: false,
          isNaN: false
        } as RFrameCell,
        rawType: "Date",
        type: "date" as const
      },
      {
        dtype: "datetime" as const,
        source: {
          kind: "string",
          raw: "2026-08-05T12:00:00Z",
          display: "2026-08-05T12:00:00Z",
          isNull: false,
          isNaN: false
        } as RFrameCell,
        after: {
          kind: "datetime",
          raw: "1785931200",
          display: "2026-08-05T12:00:00Z",
          isNull: false,
          isNaN: false
        } as RFrameCell,
        rawType: "POSIXct",
        type: "datetime" as const
      }
    ];

    for (const candidate of cases) {
      const columnId = candidate.dtype === "string" ? "r:c:5" : "r:c:6";
      const columnName = candidate.dtype === "string" ? "flag" : "missing";
      const base = withColumnNullable(frameContract(), columnId, false);
      const source = replaceContractCell(base, columnId, candidate.source);
      const transformed = castContract(source, columnId, candidate.rawType, candidate.type, candidate.after, false);
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: transformed,
        diff: castDiff(columnId, columnName, candidate.source, candidate.after),
        code: "open_wrangler_result <- orders"
      });
      const step: CastColumnTransformStep = {
        id: `r-cast-${candidate.dtype}`,
        kind: "castColumn",
        params: { column: { id: columnId, name: columnName }, dtype: candidate.dtype }
      };
      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({
        kind: "stepPreview",
        metadata: {
          schema: expect.arrayContaining([
            expect.objectContaining({
              id: columnId,
              name: columnName,
              rawType: candidate.rawType,
              type: candidate.type,
              nullable: false
            })
          ]),
          draftStep: step
        },
        diff: { changedCells: 1, cells: [expect.objectContaining({ columnId, column: columnName })] }
      });
      expect(transport.previewStep).toHaveBeenCalledWith(
        sessionId,
        0,
        step,
        expect.any(Object),
        expect.any(Array),
        undefined,
        expect.any(Object)
      );
    }
  });

  it("drops stale typed views, accepts conversion-created NA, and rejects unsafe R casts", async () => {
    const base = withColumnNullable(frameContract(), "r:c:6", false);
    const source = replaceContractCell(base, "r:c:6", {
      kind: "string",
      raw: "not a number",
      display: "not a number",
      isNull: false,
      isNaN: false
    });
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.getPage.mockResolvedValueOnce(source);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "cast-view",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [
          {
            column: "missing",
            type: "string",
            predicates: [{ kind: "predicate", operator: "contains", value: "number" }]
          }
        ],
        sort: [{ column: "missing", direction: "asc", nulls: "last" }]
      }
    });

    const missing: RFrameCell = { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false };
    const transformed = castContract(source, "r:c:6", "integer", "integer", missing, true);
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: transformed,
      diff: castDiff("r:c:6", "missing", source.page.rows[0]!.values[6] as RFrameCell, missing),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-cast-invalid-text",
          kind: "castColumn",
          params: { column: { id: "r:c:6", name: "missing" }, dtype: "integer" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:6", type: "integer", nullable: true })]),
        filterModel: { filters: [], sort: [] }
      }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: transformed,
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2
    });
    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-cast-invalid-text",
      stepIndex: 0,
      inputPage: source,
      outputPage: transformed,
      inputSchema: source.schema,
      outputSchema: transformed.schema,
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-cast-invalid-text",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      diff: {
        changedCells: 1,
        truncated: false,
        cells: [
          expect.objectContaining({
            columnId: "r:c:6",
            column: "missing",
            before: expect.objectContaining({ kind: "string", raw: "not a number" }),
            after: expect.objectContaining({ kind: "null", raw: null })
          })
        ]
      }
    });
    const projectedSource = projectContract(source, 0, 6);
    const projectedOutput = projectContract(transformed, 0, 6);
    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-cast-invalid-text",
      stepIndex: 0,
      inputPage: projectedSource,
      outputPage: projectedOutput,
      inputSchema: source.schema,
      outputSchema: transformed.schema,
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-cast-invalid-text",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 6
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      diff: { changedCells: 0, cells: [], truncated: true }
    });

    for (const [contract, step] of [
      [
        dataTableContract(frameContract(), ["r:c:6"]),
        {
          id: "r-cast-key",
          kind: "castColumn",
          params: { column: { id: "r:c:6", name: "missing" }, dtype: "integer" }
        }
      ],
      [
        frameContract(),
        {
          id: "r-cast-duration",
          kind: "castColumn",
          params: { column: { id: "r:c:4", name: "elapsed" }, dtype: "float" }
        }
      ]
    ] as const) {
      const rejectedTransport = fakeTransport(contract);
      const rejectedBridge = createBridge(rejectedTransport);
      await rejectedBridge.request(openRequest("editing"));
      await expect(
        rejectedBridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
      expect(rejectedTransport.previewStep).not.toHaveBeenCalled();
    }
  });

  it("lowercases native R text in place or into a stable derived column", async () => {
    const base = frameContract();
    const source = replaceContractCell(base, "r:c:6", {
      kind: "string",
      raw: "MiXeD",
      display: "MiXeD",
      isNull: false,
      isNaN: false
    });
    const inPlace = lowerTextContract(source, "r:c:6", "r-lower-in-place");
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: inPlace,
      diff: lowerDiff("r:c:6", "missing", "MiXeD", "mixed"),
      code: "open_wrangler_result <- orders"
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: {
        id: "r-lower-in-place",
        kind: "lowerText",
        params: { column: { id: "r:c:6", name: "missing" } }
      },
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      {
        id: "r-lower-in-place",
        kind: "lowerText",
        params: { column: { id: "r:c:6", name: "missing" } }
      },
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "r:c:6", name: "missing", rawType: "character", type: "string" })
        ]),
        draftStep: {
          id: "r-lower-in-place",
          kind: "lowerText",
          params: { column: { id: "r:c:6", name: "missing" } }
        }
      },
      diff: {
        addedColumns: [],
        removedColumns: [],
        changedCells: 1,
        cells: [expect.objectContaining({ rowNumber: 0, columnId: "r:c:6", column: "missing" })]
      }
    });

    const derivedTransport = fakeTransport(source);
    const derivedBridge = createBridge(derivedTransport);
    await derivedBridge.request(openRequest("editing"));
    const derived = lowerTextContract(source, "r:c:6", "r-lower-derived", "missing_lower");
    derivedTransport.queuePreview({
      sessionId,
      revision: 1,
      page: derived,
      diff: cloneDiff("missing_lower"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      derivedBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-lower-derived",
          kind: "lowerText",
          params: { column: { id: "r:c:6", name: "missing" }, newColumn: "missing_lower" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "c:step:r-lower-derived:0", name: "missing_lower", type: "string" })
        ])
      },
      diff: { addedColumns: ["missing_lower"], changedCells: 0, cells: [] }
    });
  });

  it("rejects unsafe native R lowercase requests and mismatched cell diffs", async () => {
    const keyed = dataTableContract(frameContract(), ["r:c:6"]);
    const keyedTransport = fakeTransport(keyed);
    const keyedBridge = createBridge(keyedTransport);
    await keyedBridge.request(openRequest("editing"));
    await expect(
      keyedBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-lower-keyed",
          kind: "lowerText",
          params: { column: { id: "r:c:6", name: "missing" } }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request", message: expect.stringContaining("keyed") });
    expect(keyedTransport.previewStep).not.toHaveBeenCalled();

    const source = replaceContractCell(frameContract(), "r:c:6", {
      kind: "string",
      raw: "MiXeD",
      display: "MiXeD",
      isNull: false,
      isNaN: false
    });
    const rejectDiff = async (diff: DataDiff) => {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: lowerTextContract(source, "r:c:6", "r-lower-wrong-diff"),
        diff,
        code: "open_wrangler_result <- orders"
      });
      return bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-lower-wrong-diff",
          kind: "lowerText",
          params: { column: { id: "r:c:6", name: "missing" } }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });
    };
    await expect(rejectDiff(lowerDiff("r:c:5", "flag", "MiXeD", "mixed"))).rejects.toThrow("mutation diff");
    const wrongRow = lowerDiff("r:c:6", "missing", "MiXeD", "mixed");
    wrongRow.cells[0]!.rowNumber = 1;
    await expect(rejectDiff(wrongRow)).rejects.toThrow("mutation diff");
    await expect(rejectDiff(lowerDiff("r:c:6", "missing", "MiXeD", "wrong"))).rejects.toThrow("mutation diff");
    await expect(
      rejectDiff({
        ...lowerDiff("r:c:6", "missing", "MiXeD", "mixed"),
        changedCells: 2,
        truncated: true
      })
    ).rejects.toThrow("mutation diff");

    const projectedTransport = fakeTransport(source);
    const projectedBridge = createBridge(projectedTransport);
    await projectedBridge.request(openRequest("editing"));
    projectedTransport.queuePreview({
      sessionId,
      revision: 1,
      page: projectContract(lowerTextContract(source, "r:c:6", "r-lower-projected-away"), 0, 6),
      diff: renameDiff(),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      projectedBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-lower-projected-away",
          kind: "lowerText",
          params: { column: { id: "r:c:6", name: "missing" } }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 6
      })
    ).rejects.toThrow("mutation diff");
  });

  it("rejects Select Columns responses with the wrong retained data-table key prefix", async () => {
    const source = dataTableContract(frameContract(), ["r:c:0", "r:c:1"]);
    const selected = selectContract(source, ["r:c:3", "r:c:1", "r:c:0"]);
    const invalidKeys = {
      ...selected,
      frameSemantics: { ...selected.frameSemantics, keyColumnIds: ["r:c:1"] }
    } satisfies RFramePageContract;
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: invalidKeys,
      diff: dropDiff("date", "elapsed", "flag", "missing", "infinite"),
      code: "open_wrangler_result <- orders[c(4L, 2L, 1L)]"
    });

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-select-invalid-keys",
          kind: "selectColumns",
          params: {
            columns: [
              { id: "r:c:3", name: "when" },
              { id: "r:c:1", name: "count" },
              { id: "r:c:0", name: "value" }
            ]
          }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("key columns");
  });

  it("rejects dropping every R column before kernel dispatch", async () => {
    const source = frameContract();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const response = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: {
        id: "r-drop-all",
        kind: "dropColumns",
        params: { columns: source.schema.map(({ id, name }) => ({ id, name })) as [{ id: string; name: string }] }
      },
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });

    expect(response).toMatchObject({ kind: "error", code: "invalid_request" });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("keeps a view changed during an R draft and reconciles it back by stable column ID", async () => {
    const source = frameContract();
    const renamed = renameContract(source, "r:c:0", "amount");
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: renamed,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders"
    });
    await bridge.request(renamePreviewRequest(0));

    transport.getPage.mockResolvedValueOnce(renamed);
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId,
        revision: 1,
        viewRequestId: "draft-view",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: {
          filters: [
            {
              column: "amount",
              type: "float",
              predicates: [{ kind: "predicate", operator: "gte", value: 10 }]
            }
          ],
          sort: [{ column: "amount", direction: "asc", nulls: "first" }]
        }
      })
    ).resolves.toMatchObject({ kind: "page", revision: 1 });

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 2,
      page: source,
      code: ""
    });
    const discarded = await bridge.request(planRequest("discardDraft", 1));
    expect(transport.discardDraft).toHaveBeenCalledWith(
      sessionId,
      1,
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })],
          sorts: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })]
        }
      }),
      expect.any(Object)
    );
    expect(discarded).toMatchObject({
      kind: "planUpdated",
      action: "discard",
      metadata: {
        schema: expect.arrayContaining([expect.objectContaining({ name: "value" })]),
        filterModel: {
          filters: expect.arrayContaining([expect.objectContaining({ column: "value" })]),
          sort: expect.arrayContaining([expect.objectContaining({ column: "value" })])
        }
      }
    });
    if (discarded.kind !== "planUpdated") throw new Error("Expected an R plan update.");
    expect(discarded.metadata).not.toHaveProperty("draftStep");
  });

  it("rejects an R rename response that narrows the live session nullability contract", async () => {
    const source = frameContract();
    const renamed = renameContract(source, "r:c:0", "amount");
    const narrowed = {
      ...renamed,
      schema: renamed.schema.map((column, index) => (index === 0 ? { ...column, nullable: false } : { ...column }))
    } satisfies RFramePageContract;
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: narrowed,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders"
    });

    await expect(bridge.request(renamePreviewRequest(0))).rejects.toThrow(
      "did not match the requested session state: schema"
    );
  });

  it("edits only the latest R step while retaining its ID and original input schema", async () => {
    const source = frameContract();
    const amount = renameContract(source, "r:c:0", "amount");
    const netAmount = renameContract(source, "r:c:0", "net_amount");
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: amount,
      diff: renameDiff(),
      code: "amount"
    });
    await bridge.request(renamePreviewRequest(0));
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: amount,
      code: "amount"
    });
    await bridge.request(planRequest("applyDraft", 1));

    transport.queuePreview({
      sessionId,
      revision: 3,
      page: netAmount,
      diff: renameDiff(),
      code: "net_amount"
    });
    const replacement = await bridge.request({
      ...renamePreviewRequest(2),
      replaceStepId: "r-step-1",
      step: {
        id: "r-step-1",
        kind: "renameColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "net_amount" }
      }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      2,
      expect.objectContaining({ id: "r-step-1", params: expect.objectContaining({ newName: "net_amount" }) }),
      expect.any(Object),
      expect.any(Array),
      "r-step-1",
      expect.any(Object)
    );
    expect(replacement).toMatchObject({
      kind: "stepPreview",
      revision: 3,
      metadata: {
        steps: [{ id: "r-step-1", params: expect.objectContaining({ newName: "amount" }) }],
        draftStep: { id: "r-step-1", params: expect.objectContaining({ newName: "net_amount" }) },
        draftReplacesStepId: "r-step-1",
        latestStepInputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:0", name: "value" })]),
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:0", name: "net_amount" })])
      }
    });
  });

  it("rejects stale R mutations before dispatch and invalidates an uncorrelated committed response", async () => {
    const source = frameContract();
    const renamed = renameContract(source, "r:c:0", "amount");
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(bridge.request(renamePreviewRequest(1))).resolves.toMatchObject({
      kind: "error",
      code: "stale_revision",
      sessionId
    });
    expect(transport.previewStep).not.toHaveBeenCalled();

    transport.queuePreview({
      sessionId,
      revision: 7,
      page: renamed,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(renamePreviewRequest(0))).rejects.toThrow("mismatched step preview");
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: "after-uncorrelated-mutation",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: { filters: [], sort: [] }
      })
    ).resolves.toMatchObject({ kind: "error", code: "r_kernel_changed" });
  });

  it("does not migrate a restart-invalidated session and performs terminal cleanup once", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());

    transport.isSessionMapped.mockReturnValue(false);
    transport.invalidate();
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: "after-restart",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: { filters: [], sort: [] }
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "r_kernel_changed",
      sessionId,
      viewRequestId: "after-restart"
    });
    expect(transport.getPage).not.toHaveBeenCalled();

    const close = { kind: "closeSession", sessionId, revision: 0 } as const;
    await expect(Promise.all([bridge.request(close), bridge.request(close)])).resolves.toEqual([
      { kind: "sessionClosed", sessionId },
      { kind: "sessionClosed", sessionId }
    ]);
    expect(transport.close).not.toHaveBeenCalled();

    bridge.onIdle();
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledTimes(1));
    await Promise.all([bridge.dispose(), bridge.dispose()]);
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "cancellation"] as const)(
    "closes the mapped R session after a detached %s mutation settles",
    async (reason) => {
      const source = frameContract();
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      const lateMutation = deferred<void>();
      transport.previewStep.mockRejectedValueOnce(
        new DetachedBridgeRequestError(`R mutation detached after ${reason}.`, reason, true, lateMutation.promise)
      );

      await expect(bridge.request(renamePreviewRequest(0))).rejects.toMatchObject({
        name: "DetachedBridgeRequestError",
        reason,
        dispatched: true
      });
      await expect(
        bridge.request({
          kind: "getPage",
          sessionId,
          revision: 0,
          viewRequestId: `after-detached-${reason}`,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8,
          filterModel: { filters: [], sort: [] }
        })
      ).resolves.toMatchObject({ kind: "error", code: "r_kernel_changed" });

      lateMutation.resolve();
      await lateMutation.promise;
      const close = { kind: "closeSession", sessionId, revision: 0 } as const;
      await expect(bridge.request(close)).resolves.toEqual({ kind: "sessionClosed", sessionId });
      expect(transport.close).toHaveBeenCalledTimes(1);
      expect(transport.close).toHaveBeenCalledWith(sessionId, {
        timeoutMs: undefined,
        cancellation: undefined
      });
    }
  );

  it("dispatches at most one close for concurrent requests", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());
    let releaseClose: (() => void) | undefined;
    transport.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        })
    );

    const close = { kind: "closeSession", sessionId, revision: 0 } as const;
    const first = bridge.request(close);
    const second = bridge.request(close);
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledTimes(1));
    bridge.onIdle();
    expect(transport.dispose).not.toHaveBeenCalled();
    releaseClose?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "sessionClosed", sessionId },
      { kind: "sessionClosed", sessionId }
    ]);
    expect(transport.close).toHaveBeenCalledTimes(1);
    bridge.onIdle();
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledTimes(1));
  });

  it("keeps an unconfirmed close retryable instead of synthesizing success", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());
    transport.close.mockRejectedValueOnce(new Error("close transport failed"));

    const close = { kind: "closeSession", sessionId, revision: 0 } as const;
    await expect(bridge.request(close)).rejects.toThrow("close transport failed");
    await expect(bridge.request(close)).resolves.toEqual({ kind: "sessionClosed", sessionId });

    expect(transport.close).toHaveBeenCalledTimes(2);
  });

  it("releases an idle bridge only after a detached close is authoritatively retired", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());
    const lateClose = deferred<void>();
    let mapped = true;
    transport.isSessionMapped.mockImplementation(() => mapped);
    transport.close.mockRejectedValueOnce(
      new DetachedBridgeRequestError("R close is still settling.", "timeout", true, lateClose.promise)
    );

    const close = { kind: "closeSession", sessionId, revision: 0 } as const;
    await expect(bridge.request(close)).rejects.toBeInstanceOf(DetachedBridgeRequestError);
    bridge.onIdle();
    expect(transport.dispose).not.toHaveBeenCalled();

    mapped = false;
    lateClose.resolve();
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledTimes(1));
  });

  it("reports idle-disposal cleanup failures", async () => {
    const transport = fakeTransport(frameContract());
    const diagnostics = vi.fn();
    const bridge = createBridge(transport, undefined, diagnostics);
    await bridge.request(openRequest());
    await bridge.request({ kind: "closeSession", sessionId, revision: 0 });
    transport.dispose.mockRejectedValueOnce(new Error("kernel cleanup failed"));

    bridge.onIdle();

    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining("kernel cleanup failed")));
  });
});

function createBridge(
  transport: FakeRTransport,
  createSessionId?: () => string,
  diagnosticSink?: (message: string) => void,
  verifiedVariable?: RNotebookVariableDescriptor
): RKernelBridge {
  const context = {
    extension: { packageJSON: { version: "2.0.0-preview.1" } },
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
  return new RKernelBridge(context, transport, createSessionId, diagnosticSink, verifiedVariable);
}

function openRequest(mode: OpenSessionRequest["mode"] = "viewing"): OpenSessionRequest {
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
    mode,
    pageSize: 20,
    columnOffset: 0,
    columnLimit: 8
  };
}

function renamePreviewRequest(revision: number): Extract<OpenWranglerRequest, { kind: "previewStep" }> {
  return {
    kind: "previewStep",
    sessionId,
    revision,
    step: {
      id: "r-step-1",
      kind: "renameColumn",
      params: { column: { id: "r:c:0", name: "value" }, newName: "amount" }
    },
    offset: 0,
    limit: 20,
    columnOffset: 0,
    columnLimit: 8
  };
}

function planRequest(
  kind: "applyDraft" | "discardDraft" | "undoStep",
  revision: number
): Extract<OpenWranglerRequest, { kind: "applyDraft" | "discardDraft" | "undoStep" }> {
  return { kind, sessionId, revision, offset: 0, limit: 20, columnOffset: 0, columnLimit: 8 };
}

interface FakeRTransport extends RKernelBridgeTransport {
  open: ReturnType<typeof vi.fn<RKernelBridgeTransport["open"]>>;
  getPage: ReturnType<typeof vi.fn<RKernelBridgeTransport["getPage"]>>;
  getSummary: ReturnType<typeof vi.fn<RKernelBridgeTransport["getSummary"]>>;
  getDatasetStats: ReturnType<typeof vi.fn<RKernelBridgeTransport["getDatasetStats"]>>;
  getColumnValues: ReturnType<typeof vi.fn<RKernelBridgeTransport["getColumnValues"]>>;
  previewStep: ReturnType<typeof vi.fn<RKernelBridgeTransport["previewStep"]>>;
  queuePreview(result: RKernelStepPreviewResult): void;
  applyDraft: ReturnType<typeof vi.fn<RKernelBridgeTransport["applyDraft"]>>;
  discardDraft: ReturnType<typeof vi.fn<RKernelBridgeTransport["discardDraft"]>>;
  undoStep: ReturnType<typeof vi.fn<RKernelBridgeTransport["undoStep"]>>;
  inspectStep: ReturnType<typeof vi.fn<RKernelBridgeTransport["inspectStep"]>>;
  close: ReturnType<typeof vi.fn<RKernelBridgeTransport["close"]>>;
  isSessionMapped: ReturnType<typeof vi.fn<RKernelBridgeTransport["isSessionMapped"]>>;
  dispose: ReturnType<typeof vi.fn<RKernelBridgeTransport["dispose"]>>;
  invalidate(): void;
}

function fakeTransport(contract: RFramePageContract, openedSessionId = sessionId): FakeRTransport {
  const emitter = new vscode.EventEmitter<void>();
  const previewQueue: RKernelStepPreviewResult[] = [];
  return {
    onDidInvalidateKernel: emitter.event,
    open: vi.fn(async () => ({ sessionId: openedSessionId, page: contract })),
    getPage: vi.fn(async () => contract),
    getSummary: vi.fn(async (_sessionId, columns) => columns.map((column) => summaryFor(contract, column))),
    getDatasetStats: vi.fn(async () => ({ totalRows: contract.shape.rows, stats: datasetStatsFor(contract) })),
    getColumnValues: vi.fn(async (_sessionId, column) => ({ column: column.name, values: [], hasMore: false })),
    previewStep: vi.fn(async () => {
      const next = previewQueue.shift();
      if (!next) throw new Error("Unexpected R step preview.");
      return next;
    }),
    applyDraft: vi.fn(async () => {
      throw new Error("Unexpected R draft apply.");
    }),
    discardDraft: vi.fn(async () => {
      throw new Error("Unexpected R draft discard.");
    }),
    undoStep: vi.fn(async () => {
      throw new Error("Unexpected R undo.");
    }),
    inspectStep: vi.fn(async () => {
      throw new Error("Unexpected R step inspection.");
    }),
    close: vi.fn(async () => undefined),
    isSessionMapped: vi.fn(() => true),
    dispose: vi.fn(async () => undefined),
    invalidate: () => emitter.fire(),
    queuePreview: (result) => previewQueue.push(result)
  };
}

function summaryFor(contract: RFramePageContract, reference: Readonly<{ id: string; name: string }>): ColumnSummary {
  const schema = contract.schema.find((column) => column.id === reference.id);
  if (!schema || schema.name !== reference.name) throw new Error("Unknown fake R profile column.");
  const cell = contract.page.rows[0]?.values[schema.position];
  const nullCount = cell?.isNull ? 1 : 0;
  const nanCount = cell?.isNaN ? 1 : 0;
  return {
    columnId: schema.id,
    column: schema.name,
    type: schema.type,
    rawType: schema.rawType,
    totalCount: contract.shape.rows,
    nullCount,
    nanCount,
    distinctCount: contract.shape.rows - nullCount - nanCount,
    topValues: cell && !cell.isNull && !cell.isNaN ? [{ value: cell.display, count: 1 }] : []
  };
}

function datasetStatsFor(contract: RFramePageContract): DatasetStats {
  const missingValuesByColumn = contract.schema.map((schema) => ({
    column: schema.name,
    count: contract.page.rows[0]?.values[schema.position]?.isNull ? 1 : 0
  }));
  return {
    missingCells: missingValuesByColumn.reduce((total, entry) => total + entry.count, 0),
    missingRows: missingValuesByColumn.some((entry) => entry.count > 0) ? 1 : 0,
    duplicateRows: 0,
    missingValuesByColumn
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next as (value?: T) => void;
  });
  return { promise, resolve };
}

function frameContract(
  options: Readonly<{ duplicateFirstName?: boolean; explicitRowLabel?: string; totalRows?: number }> = {}
): RFramePageContract {
  const names = [
    "value",
    options.duplicateFirstName ? "value" : "count",
    "date",
    "when",
    "elapsed",
    "flag",
    "missing",
    "infinite"
  ];
  const schemas: RColumnSchema[] = [
    column(0, names[0] as string, "double", "float", true, "double"),
    column(1, names[1] as string, "integer64", "integer", true, "integer64"),
    column(2, names[2] as string, "Date", "date", true, "date"),
    column(3, names[3] as string, "POSIXct", "datetime", true, "datetime"),
    column(4, names[4] as string, "difftime", "duration", true, "difftime"),
    column(5, names[5] as string, "logical", "boolean", true, "logical"),
    column(6, names[6] as string, "character", "string", true, "character"),
    column(7, names[7] as string, "double", "float", true, "double")
  ];
  const values: RFrameCell[] = [
    rCell("number", "12.5", "12.5"),
    rCell("integer", "9223372036854775807", "9223372036854775807"),
    rCell("date", "2026-08-05", "2026-08-05"),
    rCell("datetime", "1785945600", "2026-08-05T12:00:00Z"),
    rCell("duration", "90", "90 secs"),
    { kind: "boolean", raw: true, display: "TRUE", isNull: false, isNaN: false },
    { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false },
    { kind: "infinity", raw: null, display: "Inf", isNull: false, isNaN: false, sign: 1 }
  ];
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: options.totalRows ?? 1, columns: 8 },
    frameSemantics: {
      classes: ["data.frame"],
      rowNames: options.explicitRowLabel === undefined ? "positional" : "explicit",
      keyColumnIds: []
    },
    schema: schemas,
    page: {
      offset: 0,
      limit: 20,
      totalRows: options.totalRows ?? 1,
      columnOffset: 0,
      columnLimit: 8,
      columnIds: schemas.map((column) => column.id),
      rows: [
        {
          id: "r:r:0",
          rowNumber: 0,
          ...(options.explicitRowLabel === undefined ? {} : { rowLabel: options.explicitRowLabel }),
          values
        }
      ]
    }
  };
}

function renameContract(source: RFramePageContract, columnId: string, name: string): RFramePageContract {
  const position = source.schema.findIndex((column) => column.id === columnId);
  if (position < 0) throw new Error("Unknown fake R rename column.");
  const schema = source.schema.map((column) => (column.id === columnId ? { ...column, name } : { ...column }));
  return {
    ...source,
    schema,
    page: {
      ...source.page,
      columnIds: [...source.page.columnIds],
      rows: source.page.rows.map((row) => ({
        ...row,
        values: row.values.map((value) => ({ ...value }))
      }))
    }
  };
}

function dropContract(source: RFramePageContract, columnIds: readonly string[]): RFramePageContract {
  const dropped = new Set(columnIds);
  const sourcePositions = source.schema
    .map((column, position) => ({ column, position }))
    .filter(({ column }) => !dropped.has(column.id));
  const schema = sourcePositions.map(({ column }, position) => ({ ...column, position }));
  const retainedIds = new Set(schema.map((column) => column.id));
  const keyColumnIds: string[] = [];
  for (const id of source.frameSemantics.keyColumnIds) {
    if (!retainedIds.has(id)) break;
    keyColumnIds.push(id);
  }
  const projectedPositions = source.page.columnIds.flatMap((id, position) => (retainedIds.has(id) ? [position] : []));
  return {
    ...source,
    shape: { ...source.shape, columns: schema.length },
    frameSemantics: { ...source.frameSemantics, keyColumnIds },
    schema,
    page: {
      ...source.page,
      columnOffset: Math.min(source.page.columnOffset, schema.length),
      columnIds: source.page.columnIds.filter((id) => retainedIds.has(id)),
      rows: source.page.rows.map((row) => ({
        ...row,
        values: projectedPositions.map((position) => ({ ...(row.values[position] as RFrameCell) }))
      }))
    }
  };
}

function selectContract(source: RFramePageContract, columnIds: readonly string[]): RFramePageContract {
  const sourceSchemaById = new Map(source.schema.map((column) => [column.id, column]));
  const pagePositionById = new Map(source.page.columnIds.map((id, position) => [id, position]));
  const schema = columnIds.map((id, position) => {
    const column = sourceSchemaById.get(id);
    if (!column) throw new Error(`Unknown fake R select column ${id}.`);
    return { ...column, position };
  });
  const retainedIds = new Set(columnIds);
  const keyColumnIds: string[] = [];
  for (const id of source.frameSemantics.keyColumnIds) {
    if (!retainedIds.has(id)) break;
    keyColumnIds.push(id);
  }
  const projectedPositions = columnIds.map((id) => {
    const position = pagePositionById.get(id);
    if (position === undefined) throw new Error(`Fake R select page does not contain ${id}.`);
    return position;
  });
  return {
    ...source,
    shape: { ...source.shape, columns: schema.length },
    frameSemantics: { ...source.frameSemantics, keyColumnIds },
    schema,
    page: {
      ...source.page,
      columnOffset: 0,
      columnIds: [...columnIds],
      rows: source.page.rows.map((row) => ({
        ...row,
        values: projectedPositions.map((position) => ({ ...(row.values[position] as RFrameCell) }))
      }))
    }
  };
}

function cloneContract(
  source: RFramePageContract,
  columnId: string,
  newName: string,
  stepId: string
): RFramePageContract {
  const sourceColumn = source.schema.find((column) => column.id === columnId);
  if (!sourceColumn) throw new Error(`Unknown fake R clone column ${columnId}.`);
  const clonedId = `c:step:${stepId}:0`;
  return {
    ...source,
    shape: { ...source.shape, columns: source.schema.length + 1 },
    frameSemantics: { ...source.frameSemantics, keyColumnIds: [...source.frameSemantics.keyColumnIds] },
    schema: [
      ...source.schema.map((column) => ({ ...column })),
      { ...sourceColumn, id: clonedId, name: newName, position: source.schema.length }
    ],
    page: {
      ...source.page,
      columnIds: [...source.page.columnIds],
      rows: source.page.rows.map((row) => ({
        ...row,
        values: row.values.map((value) => ({ ...value }))
      }))
    }
  };
}

function textLengthContract(
  source: RFramePageContract,
  columnId: string,
  newColumn: string,
  stepId: string
): RFramePageContract {
  const sourceColumn = source.schema.find((column) => column.id === columnId);
  if (!sourceColumn) throw new Error(`Unknown fake R text-length column ${columnId}.`);
  return {
    ...source,
    shape: { ...source.shape, columns: source.schema.length + 1 },
    frameSemantics: { ...source.frameSemantics, keyColumnIds: [...source.frameSemantics.keyColumnIds] },
    schema: [
      ...source.schema.map((column) => ({ ...column })),
      {
        id: `c:step:${stepId}:0`,
        name: newColumn,
        position: source.schema.length,
        rawType: "integer",
        type: "integer",
        nullable: sourceColumn.nullable,
        semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
      }
    ],
    page: {
      ...source.page,
      columnIds: [...source.page.columnIds],
      rows: source.page.rows.map((row) => ({
        ...row,
        values: row.values.map((value) => ({ ...value }))
      }))
    }
  };
}

function replaceContractCell(source: RFramePageContract, columnId: string, value: RFrameCell): RFramePageContract {
  const pagePosition = source.page.columnIds.indexOf(columnId);
  if (pagePosition < 0) throw new Error(`Fake R page does not contain ${columnId}.`);
  return {
    ...source,
    page: {
      ...source.page,
      columnIds: [...source.page.columnIds],
      rows: source.page.rows.map((row) => ({
        ...row,
        values: row.values.map((candidate, index) => ({ ...(index === pagePosition ? value : candidate) }))
      }))
    }
  };
}

function withColumnNullable(source: RFramePageContract, columnId: string, nullable: boolean): RFramePageContract {
  return {
    ...source,
    schema: source.schema.map((column) => (column.id === columnId ? { ...column, nullable } : { ...column })),
    page: {
      ...source.page,
      columnIds: [...source.page.columnIds],
      rows: source.page.rows.map((row) => ({
        ...row,
        values: row.values.map((value) => ({ ...value }))
      }))
    }
  };
}

function castContract(
  source: RFramePageContract,
  columnId: string,
  rawType: string,
  type: RColumnSchema["type"],
  value: RFrameCell,
  nullable: boolean
): RFramePageContract {
  const sourceColumn = source.schema.find((column) => column.id === columnId);
  if (!sourceColumn) throw new Error(`Unknown fake R cast column ${columnId}.`);
  const semantics: RColumnSchema["semantics"] =
    rawType === "integer"
      ? { kind: "integer", storageMode: "integer", classes: ["integer"] }
      : rawType === "double"
        ? { kind: "double", storageMode: "double", classes: ["numeric"] }
        : rawType === "logical"
          ? { kind: "logical", storageMode: "logical", classes: ["logical"] }
          : rawType === "Date"
            ? { kind: "date", storageMode: "double", classes: ["Date"] }
            : rawType === "POSIXct"
              ? { kind: "datetime", storageMode: "double", classes: ["POSIXct", "POSIXt"], timezone: "UTC" }
              : { kind: "character", storageMode: "character", classes: ["character"] };
  const pagePosition = source.page.columnIds.indexOf(columnId);
  if (pagePosition < 0) throw new Error(`Fake R cast page does not contain ${columnId}.`);
  return {
    ...source,
    schema: source.schema.map((column) =>
      column.id === columnId ? { ...column, rawType, type, nullable, semantics } : { ...column }
    ),
    page: {
      ...source.page,
      columnIds: [...source.page.columnIds],
      rows: source.page.rows.map((row) => ({
        ...row,
        values: row.values.map((candidate, index) => ({ ...(index === pagePosition ? value : candidate) }))
      }))
    }
  };
}

function projectContract(source: RFramePageContract, columnOffset: number, columnLimit: number): RFramePageContract {
  const projectedSchema = source.schema.slice(columnOffset, columnOffset + columnLimit);
  const sourcePagePosition = new Map(source.page.columnIds.map((id, position) => [id, position]));
  return {
    ...source,
    page: {
      ...source.page,
      columnOffset,
      columnLimit,
      columnIds: projectedSchema.map((column) => column.id),
      rows: source.page.rows.map((row) => ({
        ...row,
        values: projectedSchema.map((column) => {
          const position = sourcePagePosition.get(column.id);
          if (position === undefined) throw new Error(`Fake R projection does not contain ${column.id}.`);
          return { ...(row.values[position] as RFrameCell) };
        })
      }))
    }
  };
}

function lowerTextContract(
  source: RFramePageContract,
  columnId: string,
  stepId: string,
  newColumn?: string
): RFramePageContract {
  const sourceColumn = source.schema.find((column) => column.id === columnId);
  if (!sourceColumn) throw new Error(`Unknown fake R lowercase column ${columnId}.`);
  const inPlace = newColumn === undefined || newColumn === sourceColumn.name;
  const loweredColumn: RColumnSchema = {
    id: inPlace ? sourceColumn.id : `c:step:${stepId}:0`,
    name: inPlace ? sourceColumn.name : newColumn,
    position: inPlace ? sourceColumn.position : source.schema.length,
    rawType: "character",
    type: "string",
    nullable: sourceColumn.nullable,
    semantics: { kind: "character", storageMode: "character", classes: ["character"] }
  };
  const pagePosition = source.page.columnIds.indexOf(columnId);
  const rows = source.page.rows.map((row) => {
    const sourceValue = pagePosition < 0 ? undefined : row.values[pagePosition];
    const lowered =
      sourceValue?.kind === "string"
        ? ({ ...sourceValue, raw: sourceValue.raw.toLowerCase(), display: sourceValue.display.toLowerCase() } as const)
        : sourceValue
          ? { ...sourceValue }
          : undefined;
    if (inPlace && pagePosition >= 0 && lowered) {
      return {
        ...row,
        values: row.values.map((value, index) => ({ ...(index === pagePosition ? lowered : value) }))
      };
    }
    return { ...row, values: row.values.map((value) => ({ ...value })) };
  });
  return {
    ...source,
    shape: { ...source.shape, columns: source.schema.length + (inPlace ? 0 : 1) },
    schema: inPlace
      ? source.schema.map((column) => (column.id === columnId ? loweredColumn : { ...column }))
      : [...source.schema.map((column) => ({ ...column })), loweredColumn],
    page: { ...source.page, columnIds: [...source.page.columnIds], rows }
  };
}

function dataTableContract(source: RFramePageContract, keyColumnIds: readonly string[]): RFramePageContract {
  return {
    ...source,
    dataframeFlavor: "r.data.table",
    frameSemantics: {
      ...source.frameSemantics,
      classes: ["data.table", "data.frame"],
      keyColumnIds: [...keyColumnIds]
    }
  };
}

function renameDiff(): DataDiff {
  return {
    addedRows: 0,
    removedRows: 0,
    addedColumns: [],
    removedColumns: [],
    changedCells: 0,
    cells: [],
    truncated: false
  };
}

function dropDiff(...removedColumns: string[]): DataDiff {
  return { ...renameDiff(), removedColumns };
}

function cloneDiff(newName: string): DataDiff {
  return { ...renameDiff(), addedColumns: [newName] };
}

function lowerDiff(columnId: string, column: string, before: string, after: string): DataDiff {
  return {
    ...renameDiff(),
    changedCells: 1,
    cells: [
      {
        rowNumber: 0,
        columnId,
        column,
        before: { kind: "string", raw: before, display: before, isNull: false, isNaN: false },
        after: { kind: "string", raw: after, display: after, isNull: false, isNaN: false }
      }
    ]
  };
}

function castDiff(columnId: string, column: string, before: RFrameCell, after: RFrameCell): DataDiff {
  return {
    ...renameDiff(),
    changedCells: 1,
    cells: [
      {
        rowNumber: 0,
        columnId,
        column,
        before: { ...before, ...(before.kind === "number" ? { raw: Number(before.raw) } : {}) },
        after: { ...after, ...(after.kind === "number" ? { raw: Number(after.raw) } : {}) }
      }
    ]
  };
}

function column(
  position: number,
  name: string,
  rawType: string,
  type: RColumnSchema["type"],
  nullable: boolean,
  kind: "double" | "integer64" | "date" | "datetime" | "difftime" | "logical" | "character"
): RColumnSchema {
  const semantics =
    kind === "datetime"
      ? ({ kind, storageMode: "double", classes: ["POSIXct", "POSIXt"], timezone: "UTC" } as const)
      : kind === "difftime"
        ? ({ kind, storageMode: "double", classes: ["difftime"], units: "secs" } as const)
        : kind === "integer64"
          ? ({ kind, storageMode: "double", classes: ["integer64"] } as const)
          : kind === "double"
            ? ({ kind, storageMode: "double", classes: ["numeric"] } as const)
            : kind === "date"
              ? ({ kind, storageMode: "double", classes: ["Date"] } as const)
              : kind === "logical"
                ? ({ kind, storageMode: "logical", classes: ["logical"] } as const)
                : ({ kind, storageMode: "character", classes: ["character"] } as const);
  return { id: `r:c:${position}`, name, position, rawType, type, nullable, semantics };
}

function rCell(
  kind: "number" | "integer" | "date" | "datetime" | "duration" | "boolean",
  raw: string | boolean,
  display: string
): RFrameCell {
  return { kind, raw, display, isNull: false, isNaN: false } as RFrameCell;
}

function cell(kind: string, raw: unknown, display: string, isNull = false, isNaN = false): Record<string, unknown> {
  return { kind, raw, display, isNull, isNaN };
}

function rCapabilities(bridge = false): SourceCapabilities {
  return {
    editable: true,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: true,
    ...(bridge ? { documentInsert: true } : {}),
    filter: true,
    sort: true,
    profile: true,
    columnValues: true,
    supportedOperations: [
      "selectColumns",
      "dropColumns",
      "renameColumn",
      "cloneColumn",
      "castColumn",
      "textLength",
      "lowerText"
    ]
  };
}
