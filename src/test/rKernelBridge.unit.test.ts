import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type {
  ColumnSummary,
  DataDiff,
  DatasetStats,
  OpenSessionRequest,
  OpenWranglerRequest,
  SourceCapabilities
} from "../shared/protocol";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import { RKernelBridge, type RKernelBridgeTransport } from "../extension/r/rKernelBridge";
import type { RColumnSchema, RFrameCell, RFramePageContract } from "../extension/r/rFrameContract";
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
      capabilities: rCapabilities()
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
      metadata: { mode: "editing", capabilities: { editable: true, supportedOperations: ["renameColumn"] } }
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

    transport.previewStep.mockResolvedValueOnce({
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
      diff: renameDiff(),
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

  it("keeps a view changed during an R draft and reconciles it back by stable column ID", async () => {
    const source = frameContract();
    const renamed = renameContract(source, "r:c:0", "amount");
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.previewStep.mockResolvedValueOnce({
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
    transport.previewStep.mockResolvedValueOnce({
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
    transport.previewStep.mockResolvedValueOnce({
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

    transport.previewStep.mockResolvedValueOnce({
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

    transport.previewStep.mockResolvedValueOnce({
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

  it("does not migrate an invalidated session and performs terminal cleanup once", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());

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
  return new RKernelBridge(
    context,
    {} as vscode.NotebookDocument,
    transport,
    createSessionId,
    diagnosticSink,
    verifiedVariable
  );
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
  return {
    onDidInvalidateKernel: emitter.event,
    open: vi.fn(async () => ({ sessionId: openedSessionId, page: contract })),
    getPage: vi.fn(async () => contract),
    getSummary: vi.fn(async (_sessionId, columns) => columns.map((column) => summaryFor(contract, column))),
    getDatasetStats: vi.fn(async () => ({ totalRows: contract.shape.rows, stats: datasetStatsFor(contract) })),
    getColumnValues: vi.fn(async (_sessionId, column) => ({ column: column.name, values: [], hasMore: false })),
    previewStep: vi.fn(async () => {
      throw new Error("Unexpected R step preview.");
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
    invalidate: () => emitter.fire()
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
    contractVersion: 3,
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

function rCapabilities(): SourceCapabilities {
  return {
    editable: true,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: false,
    filter: true,
    sort: true,
    profile: true,
    columnValues: true,
    supportedOperations: ["renameColumn"]
  };
}
