import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { operationKinds } from "../shared/operationCatalog.generated";
import type {
  ByExampleProgram,
  ByExampleTransformStep,
  CapitalizeTextTransformStep,
  CastColumnTransformStep,
  CeilNumberTransformStep,
  CloneColumnTransformStep,
  ColumnSummary,
  CustomCodeTransformStep,
  DataDiff,
  DatasetStats,
  FillMissingValuesTransformStep,
  FormulaTransformStep,
  FormatDatetimeTransformStep,
  FloorNumberTransformStep,
  GroupByTransformStep,
  MinMaxScaleTransformStep,
  MultiLabelBinarizeTransformStep,
  OneHotEncodeTransformStep,
  OpenSessionRequest,
  OpenWranglerRequest,
  RoundNumberTransformStep,
  SelectColumnsTransformStep,
  SourceCapabilities,
  SplitTextTransformStep,
  StripTextTransformStep,
  TextLengthTransformStep,
  TransformStep
} from "../shared/protocol";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import type { AtomicFileTransaction } from "../extension/files/safeFileExport";
import { RKernelBridge, type RKernelBridgeFileOperations } from "../extension/r/rKernelBridge";
import type { RKernelBridgeTransport } from "../extension/r/rKernelBridgeTransport";
import type { RKernelStepPreviewResult, RKernelTransformStep } from "../extension/r/rKernelProtocol";
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

  it("bounds native R value counts by the active cleaned row count", async () => {
    const source = rowOrderContract(frameContract({ totalRows: 3 }), ["r:r:0", "r:r:1", "r:r:2"], 3);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    const integerValue = (value: string, count: number) => ({
      value,
      count,
      selectionValue: {
        kind: "typedSelection" as const,
        version: 1 as const,
        columnType: "integer" as const,
        cell: { kind: "integer" as const, raw: value, display: value, isNull: false, isNaN: false }
      }
    });
    const valuesRequest = (viewRequestId: string, limit = 10) => ({
      kind: "getColumnValues" as const,
      sessionId,
      revision: 0,
      viewRequestId,
      column: "count",
      limit,
      filterModel: { filters: [], sort: [] }
    });
    await bridge.request(openRequest());

    transport.getColumnValues.mockResolvedValueOnce({
      column: "count",
      values: [integerValue("1", 2)],
      hasMore: true
    });
    await expect(bridge.request(valuesRequest("values-partial", 1))).resolves.toMatchObject({
      kind: "columnValues",
      values: [{ value: "1", count: 2 }],
      hasMore: true
    });

    transport.getColumnValues.mockResolvedValueOnce({
      column: "count",
      values: [integerValue("1", 2)],
      hasMore: true,
      sampleSize: 2
    });
    await expect(bridge.request(valuesRequest("values-invalid-sample"))).rejects.toThrow("sample size");

    transport.getColumnValues.mockResolvedValueOnce({
      column: "count",
      values: [integerValue("1", 4)],
      hasMore: false
    });
    await expect(bridge.request(valuesRequest("values-count-too-large"))).rejects.toThrow("row counts");

    transport.getColumnValues.mockResolvedValueOnce({
      column: "count",
      values: [integerValue("1", 2), integerValue("2", 2)],
      hasMore: false
    });
    await expect(bridge.request(valuesRequest("values-sum-too-large"))).rejects.toThrow("row counts");
  });

  it("accepts native R value samples only for initial discovery at the fixed sample size", async () => {
    const sampleSize = R_FRAME_CONTRACT_LIMITS.profileSampleRows;
    const transport = fakeTransport(frameContract({ totalRows: sampleSize + 1 }));
    const bridge = createBridge(transport);
    const sampledValue = {
      value: "1",
      count: sampleSize,
      selectionValue: {
        kind: "typedSelection" as const,
        version: 1 as const,
        columnType: "integer" as const,
        cell: { kind: "integer" as const, raw: "1", display: "1", isNull: false, isNaN: false }
      }
    };
    const valuesRequest = (viewRequestId: string, search?: string) => ({
      kind: "getColumnValues" as const,
      sessionId,
      revision: 0,
      viewRequestId,
      column: "count",
      ...(search === undefined ? {} : { search }),
      limit: 1,
      filterModel: { filters: [], sort: [] }
    });
    await bridge.request(openRequest());

    transport.getColumnValues.mockResolvedValueOnce({
      column: "count",
      values: [sampledValue],
      hasMore: true,
      sampleSize
    });
    await expect(bridge.request(valuesRequest("values-sampled"))).resolves.toMatchObject({
      kind: "columnValues",
      values: [{ value: "1", count: sampleSize }],
      hasMore: true,
      sampleSize
    });

    transport.getColumnValues.mockResolvedValueOnce({
      column: "count",
      values: [sampledValue],
      hasMore: true,
      sampleSize
    });
    await expect(bridge.request(valuesRequest("values-sampled-search", "1"))).rejects.toThrow("sample size");

    transport.getColumnValues.mockResolvedValueOnce({
      column: "count",
      values: [{ ...sampledValue, count: 1 }],
      hasMore: true,
      sampleSize: sampleSize - 1
    });
    await expect(bridge.request(valuesRequest("values-wrong-sample-size"))).rejects.toThrow("sample size");
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

  it("accepts bounded sampled duplicate statistics and rejects a sample outside the active view", async () => {
    const contract = frameContract({ totalRows: 3 });
    const transport = fakeTransport(contract);
    const bridge = createBridge(transport);
    await bridge.request(openRequest());
    const stats = datasetStatsFor(contract);
    transport.getDatasetStats.mockResolvedValueOnce({
      totalRows: 3,
      stats: { ...stats, duplicateRows: 1, duplicateRowsSampleSize: 2 }
    });

    await expect(
      bridge.request({
        kind: "getDatasetStats",
        sessionId,
        revision: 0,
        viewRequestId: "sampled-stats",
        filterModel: { filters: [], sort: [] }
      })
    ).resolves.toMatchObject({
      kind: "datasetStats",
      stats: { duplicateRows: 1, duplicateRowsSampleSize: 2 }
    });

    transport.getDatasetStats.mockResolvedValueOnce({
      totalRows: 3,
      stats: { ...stats, duplicateRows: 1, duplicateRowsSampleSize: 4 }
    });
    await expect(
      bridge.request({
        kind: "getDatasetStats",
        sessionId,
        revision: 0,
        viewRequestId: "oversized-sample",
        filterModel: { filters: [], sort: [] }
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

  it("exports the committed result of an editing R document through an extension-owned atomic CSV transaction", async () => {
    const contract = frameContract();
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async (...args) => {
      await args[3](new TextEncoder().encode("value,count\n"));
      await args[3](new TextEncoder().encode("12.5,9223372036854775807\n"));
      return {
        sessionId: args[0],
        revision: args[1],
        format: "csv",
        rows: contract.shape.rows,
        columns: contract.shape.columns
      };
    });
    const transport = { ...fakeTransport(contract), exportData };
    const atomic = fakeAtomicTransaction();
    const beginTransaction = vi.fn(async () => atomic.transaction);
    const bridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });

    await expect(bridge.request(documentOpenRequest("editing"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { capabilities: { exportCsv: true, exportParquet: false } }
    });
    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/rejected.csv",
        format: "csv",
        rowAxisPolicy: "preserve"
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    expect(beginTransaction).not.toHaveBeenCalled();
    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/orders.cleaned.csv",
        format: "csv"
      })
    ).resolves.toEqual({
      kind: "dataExported",
      revision: 0,
      path: "/workspace/orders.cleaned.csv",
      format: "csv",
      shape: { rows: 1, columns: 8 }
    });

    expect(beginTransaction).toHaveBeenCalledWith({
      destination: expect.objectContaining({ scheme: "file", fsPath: "/workspace/orders.cleaned.csv" }),
      protectedSources: [expect.objectContaining({ scheme: "file", fsPath: "/workspace/orders.R" })]
    });
    expect(exportData).toHaveBeenCalledWith(
      sessionId,
      0,
      "csv",
      expect.any(Function),
      expect.objectContaining({ timeoutMs: 30 * 60_000 })
    );
    expect(atomic.write).toHaveBeenNthCalledWith(1, new TextEncoder().encode("value,count\n"));
    expect(atomic.write).toHaveBeenNthCalledWith(2, new TextEncoder().encode("12.5,9223372036854775807\n"));
    expect(atomic.prepareExternalWriter).not.toHaveBeenCalled();
    expect(atomic.commit).toHaveBeenCalledOnce();
    expect(atomic.rollback).not.toHaveBeenCalled();
    expect(atomic.abandon).not.toHaveBeenCalled();
  });

  it("exports an active R-session dataframe without inventing a protected source file", async () => {
    const contract = frameContract();
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async (...args) => {
      await args[3](new TextEncoder().encode("value,count\n"));
      return {
        sessionId: args[0],
        revision: args[1],
        format: "csv",
        rows: contract.shape.rows,
        columns: contract.shape.columns
      };
    });
    const transport = { ...fakeTransport(contract), exportData };
    const atomic = fakeAtomicTransaction();
    const beginTransaction = vi.fn(async () => atomic.transaction);
    const bridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });
    const request: OpenSessionRequest = {
      ...openRequest("editing"),
      source: { kind: "rInteractiveVariable", label: "orders", variableName: "orders" }
    };

    const opened = await bridge.request(request);
    expect(opened).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        source: request.source,
        capabilities: { exportCsv: true, notebookInsert: false }
      }
    });
    if (opened.kind !== "sessionOpened") throw new Error("Expected an active R session.");
    expect(opened.metadata.capabilities.documentInsert).not.toBe(true);
    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/orders.cleaned.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "dataExported", path: "/workspace/orders.cleaned.csv", format: "csv" });

    expect(beginTransaction).toHaveBeenCalledWith({
      destination: expect.objectContaining({ scheme: "file", fsPath: "/workspace/orders.cleaned.csv" }),
      protectedSources: []
    });
  });

  it("advertises and atomically exports Parquet only when the selected R runtime supports it", async () => {
    const contract = frameContract();
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async (...args) => {
      await args[3](new TextEncoder().encode("PAR1native-r-parquetPAR1"));
      return {
        sessionId: args[0],
        revision: args[1],
        format: "parquet",
        rows: contract.shape.rows,
        columns: contract.shape.columns
      };
    });
    const transport = {
      ...fakeTransport(contract, sessionId, ["csv", "parquet"]),
      exportData
    };
    const atomic = fakeAtomicTransaction();
    const beginTransaction = vi.fn(async () => atomic.transaction);
    const bridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });

    await expect(bridge.request(documentOpenRequest("editing"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { capabilities: { exportCsv: true, exportParquet: true } }
    });
    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/orders.cleaned.parquet",
        format: "parquet"
      })
    ).resolves.toEqual({
      kind: "dataExported",
      revision: 0,
      path: "/workspace/orders.cleaned.parquet",
      format: "parquet",
      shape: { rows: 1, columns: 8 }
    });

    expect(exportData).toHaveBeenCalledWith(
      sessionId,
      0,
      "parquet",
      expect.any(Function),
      expect.objectContaining({ timeoutMs: 30 * 60_000 })
    );
    expect(atomic.write).toHaveBeenCalledWith(new TextEncoder().encode("PAR1native-r-parquetPAR1"));
    expect(atomic.commit).toHaveBeenCalledOnce();
    expect(atomic.rollback).not.toHaveBeenCalled();
  });

  it("advertises R export formats only for eligible local notebook and document sessions", async () => {
    const contract = frameContract();
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async (...args) => {
      await args[3](new TextEncoder().encode("value\n12.5\n"));
      return {
        sessionId: args[0],
        revision: args[1],
        format: "csv",
        rows: contract.shape.rows,
        columns: contract.shape.columns
      };
    });
    const transport = { ...fakeTransport(contract), exportData };
    const beginTransaction = vi.fn(async () => fakeAtomicTransaction().transaction);

    const viewingBridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });
    const viewing = await viewingBridge.request(documentOpenRequest("viewing"));
    expect(viewing).toMatchObject({ kind: "sessionOpened", metadata: { capabilities: { exportCsv: false } } });
    await expect(
      viewingBridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/out.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "error", code: "unsupported_mode" });

    const notebookTransport = { ...fakeTransport(contract), exportData: vi.fn(exportData) };
    const notebookBridge = createBridge(notebookTransport, undefined, undefined, undefined, { beginTransaction });
    const notebook = await notebookBridge.request(openRequest("editing"));
    expect(notebook).toMatchObject({
      kind: "sessionOpened",
      metadata: { capabilities: { exportCsv: true, exportParquet: false } }
    });
    await expect(
      notebookBridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/out.parquet",
        format: "parquet"
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "unsupported_operation",
      message: expect.stringContaining("nanoparquet 0.5.1")
    });
    await expect(
      notebookBridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/out.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "dataExported", path: "/workspace/out.csv", format: "csv" });

    const untitledTransport = { ...fakeTransport(contract), exportData: vi.fn(exportData) };
    const untitledBridge = createBridge(untitledTransport, undefined, undefined, undefined, { beginTransaction });
    const untitled = await untitledBridge.request(documentOpenRequest("editing", "untitled:orders.R"));
    expect(untitled).toMatchObject({ kind: "sessionOpened", metadata: { capabilities: { exportCsv: false } } });
    await expect(
      untitledBridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/out.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "error", code: "unsupported_operation" });

    const remoteTransport = { ...fakeTransport(contract), exportData: vi.fn(exportData) };
    const remoteBridge = createBridge(remoteTransport, undefined, undefined, undefined, { beginTransaction });
    const remote = await remoteBridge.request(
      documentOpenRequest("editing", "vscode-remote://ssh-remote+host/workspace/orders.R")
    );
    expect(remote).toMatchObject({ kind: "sessionOpened", metadata: { capabilities: { exportCsv: false } } });

    expect(beginTransaction).toHaveBeenCalledOnce();
    expect(beginTransaction).toHaveBeenCalledWith({
      destination: expect.objectContaining({ scheme: "file", fsPath: "/workspace/out.csv" }),
      protectedSources: [expect.objectContaining({ scheme: "file", fsPath: "/workspace/orders.ipynb" })]
    });
  });

  it("rolls back the host transaction immediately when the private R export detaches", async () => {
    const contract = frameContract();
    const lateWriter = deferred<void>();
    const transport = {
      ...fakeTransport(contract),
      exportData: vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async () => {
        throw new DetachedBridgeRequestError("R export is still settling.", "timeout", true, lateWriter.promise);
      })
    };
    const atomic = fakeAtomicTransaction();
    const diagnostics = vi.fn();
    const bridge = createBridge(transport, undefined, diagnostics, undefined, {
      beginTransaction: vi.fn(async () => atomic.transaction)
    });
    await bridge.request(documentOpenRequest("editing"));

    const exportRequest = bridge.request({
      kind: "exportData",
      sessionId,
      revision: 0,
      path: "/workspace/out.csv",
      format: "csv"
    });
    await expect(exportRequest).rejects.toBeInstanceOf(DetachedBridgeRequestError);
    expect(atomic.rollback).toHaveBeenCalledOnce();
    expect(atomic.abandon).not.toHaveBeenCalled();

    lateWriter.resolve();
    await Promise.resolve();
    expect(atomic.rollback).toHaveBeenCalledOnce();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("rolls back instead of publishing when the R runtime generation changes during export", async () => {
    const contract = frameContract();
    const lateResult = deferred<{
      sessionId: string;
      revision: number;
      format: "csv";
      rows: number;
      columns: number;
    }>();
    const transport = {
      ...fakeTransport(contract),
      exportData: vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async () => lateResult.promise)
    };
    const atomic = fakeAtomicTransaction();
    const bridge = createBridge(transport, undefined, undefined, undefined, {
      beginTransaction: vi.fn(async () => atomic.transaction)
    });
    await bridge.request(documentOpenRequest("editing"));

    const pending = bridge.request({
      kind: "exportData",
      sessionId,
      revision: 0,
      path: "/workspace/out.csv",
      format: "csv"
    });
    await vi.waitFor(() => expect(transport.exportData).toHaveBeenCalledOnce());
    transport.invalidate();
    lateResult.resolve({
      sessionId,
      revision: 0,
      format: "csv",
      rows: 1,
      columns: 8
    });

    await expect(pending).resolves.toMatchObject({ kind: "error", code: "r_kernel_changed" });
    expect(atomic.rollback).toHaveBeenCalledOnce();
    expect(atomic.commit).not.toHaveBeenCalled();
  });

  it("rolls back an R export whose pinned revision changes before the writer returns", async () => {
    const source = frameContract();
    const renamed = renameContract(source, "r:c:0", "amount");
    const lateResult = deferred<{
      sessionId: string;
      revision: number;
      format: "csv";
      rows: number;
      columns: number;
    }>();
    const transport = {
      ...fakeTransport(source),
      exportData: vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async () => lateResult.promise)
    };
    const atomic = fakeAtomicTransaction();
    const bridge = createBridge(transport, undefined, undefined, undefined, {
      beginTransaction: vi.fn(async () => atomic.transaction)
    });
    await bridge.request(documentOpenRequest("editing"));

    const pending = bridge.request({
      kind: "exportData",
      sessionId,
      revision: 0,
      path: "/workspace/out.csv",
      format: "csv"
    });
    await vi.waitFor(() => expect(transport.exportData).toHaveBeenCalledOnce());
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: renamed,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(renamePreviewRequest(0))).resolves.toMatchObject({ kind: "stepPreview", revision: 1 });
    lateResult.resolve({
      sessionId,
      revision: 0,
      format: "csv",
      rows: 1,
      columns: 8
    });

    await expect(pending).resolves.toMatchObject({ kind: "error", code: "stale_response" });
    expect(atomic.rollback).toHaveBeenCalledOnce();
    expect(atomic.commit).not.toHaveBeenCalled();
  });

  it("does not reserve an R export file while a draft is open", async () => {
    const source = frameContract();
    const renamed = renameContract(source, "r:c:0", "amount");
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>();
    const transport = { ...fakeTransport(source), exportData };
    const beginTransaction = vi.fn(async () => fakeAtomicTransaction().transaction);
    const bridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });
    await bridge.request(documentOpenRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: renamed,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders"
    });
    await bridge.request(renamePreviewRequest(0));

    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 1,
        path: "/workspace/out.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    expect(beginTransaction).not.toHaveBeenCalled();
    expect(exportData).not.toHaveBeenCalled();
  });

  it("keeps stable R row identities through compound sort preview, apply, edit, discard, inspection, and undo", async () => {
    const original = dataTableContract(
      rowOrderContract(frameContract({ totalRows: 4 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3"], 4),
      ["r:c:0"]
    );
    const firstSorted = dataTableContract(rowOrderContract(original, ["r:r:2", "r:r:0", "r:r:3", "r:r:1"], 4), []);
    const editedSorted = dataTableContract(rowOrderContract(original, ["r:r:1", "r:r:3", "r:r:0", "r:r:2"], 4), []);
    const transport = fakeTransport(original);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const firstStep = {
      id: "sort-step",
      kind: "sortRows" as const,
      params: {
        rules: [
          { column: { id: "r:c:0", name: "value" }, direction: "asc" as const, nulls: "last" as const },
          { column: { id: "r:c:1", name: "count" }, direction: "desc" as const, nulls: "first" as const }
        ] as [
          {
            column: { id: string; name: string };
            direction: "asc";
            nulls: "last";
          },
          {
            column: { id: string; name: string };
            direction: "desc";
            nulls: "first";
          }
        ]
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: firstSorted,
      diff: rowDiff(),
      code: "open_wrangler_result <- sorted_orders"
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: firstStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      firstStep,
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      page: { totalRows: 4, rows: [{ id: "r:r:2" }, { id: "r:r:0" }, { id: "r:r:3" }, { id: "r:r:1" }] },
      metadata: {
        shape: { rows: 4, columns: 8 },
        draftStep: { id: "sort-step", kind: "sortRows" },
        steps: []
      }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: firstSorted,
      code: "open_wrangler_result <- sorted_orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2,
      metadata: { steps: [{ id: "sort-step", kind: "sortRows" }], shape: { rows: 4, columns: 8 } }
    });

    const editedStep = {
      ...firstStep,
      params: {
        rules: [{ column: { id: "r:c:1", name: "count" }, direction: "asc" as const, nulls: "last" as const }] as [
          {
            column: { id: string; name: string };
            direction: "asc";
            nulls: "last";
          }
        ]
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 3,
      page: editedSorted,
      diff: rowDiff(),
      code: "open_wrangler_result <- edited_sort"
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 2,
        step: editedStep,
        replaceStepId: "sort-step",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      revision: 3,
      metadata: { draftStep: { id: "sort-step", kind: "sortRows" }, steps: [{ id: "sort-step" }] }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      2,
      editedStep,
      expect.any(Object),
      expect.any(Array),
      "sort-step",
      expect.any(Object)
    );

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 4,
      page: firstSorted,
      code: "open_wrangler_result <- sorted_orders"
    });
    const discarded = await bridge.request(planRequest("discardDraft", 3));
    expect(discarded).toMatchObject({
      kind: "planUpdated",
      action: "discard",
      revision: 4,
      metadata: { steps: [{ id: "sort-step", kind: "sortRows" }] }
    });
    if (discarded.kind !== "planUpdated") throw new Error("Expected the R sort draft to be discarded.");
    expect(discarded.page.rows.map(({ id }) => id)).toEqual(["r:r:2", "r:r:0", "r:r:3", "r:r:1"]);
    expect(discarded.metadata.draftStep).toBeUndefined();

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 4,
      stepId: "sort-step",
      stepIndex: 0,
      inputPage: original,
      outputPage: firstSorted,
      inputSchema: original.schema,
      outputSchema: firstSorted.schema,
      code: "open_wrangler_result <- sorted_orders"
    });
    const inspection = await bridge.request({
      kind: "inspectStep",
      sessionId,
      revision: 4,
      stepId: "sort-step",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(inspection).toMatchObject({
      kind: "stepInspection",
      stepId: "sort-step",
      diff: { addedRows: 0, removedRows: 0, changedCells: 0, truncated: false }
    });
    if (inspection.kind !== "stepInspection") throw new Error("Expected an R sort-step inspection.");
    expect(inspection.inputRowAxis).toEqual({ kind: "positional", levelNames: [] });
    expect(inspection.outputRowAxis).toEqual({ kind: "positional", levelNames: [] });
    expect(inspection.inputPage.rows.map(({ id }) => id)).toEqual(["r:r:0", "r:r:1", "r:r:2", "r:r:3"]);
    expect(inspection.outputPage.rows.map(({ id }) => id)).toEqual(["r:r:2", "r:r:0", "r:r:3", "r:r:1"]);

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 5,
      page: original,
      code: ""
    });
    const undone = await bridge.request(planRequest("undoStep", 4));
    expect(undone).toMatchObject({
      kind: "planUpdated",
      action: "undo",
      revision: 5,
      metadata: { steps: [], shape: { rows: 4, columns: 8 } }
    });
    if (undone.kind !== "planUpdated") throw new Error("Expected the R sort step to be undone.");
    expect(undone.page.rows.map(({ id }) => id)).toEqual(["r:r:0", "r:r:1", "r:r:2", "r:r:3"]);
  });

  it("binds committed R filters by exact identity and tracks removed rows through apply and inspection", async () => {
    const source = rowOrderContract(
      frameContract({ duplicateFirstName: true, totalRows: 4 }),
      ["r:r:0", "r:r:1", "r:r:2", "r:r:3"],
      4
    );
    const filtered = rowOrderContract(source, ["r:r:1", "r:r:3"], 2);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const filterStep = {
      id: "filter-step",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          logic: "or" as const,
          filters: [
            {
              column: { id: "r:c:0", name: "value" },
              type: "float" as const,
              logic: "or" as const,
              predicates: [
                { kind: "predicate" as const, operator: "isNull" as const },
                { kind: "predicate" as const, operator: "isNaN" as const }
              ]
            },
            {
              column: { id: "r:c:6", name: "missing" },
              type: "string" as const,
              predicates: [],
              valueFilter: {
                kind: "values" as const,
                selectedValues: ["keep"],
                includeNulls: false,
                includeNaN: false
              }
            }
          ],
          sort: [{ column: { id: "r:c:1", name: "value" }, direction: "desc" as const, nulls: "last" as const }]
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: filtered,
      diff: rowDiff(2),
      code: "open_wrangler_result <- filtered_orders"
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: filterStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      filterStep,
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      page: { totalRows: 2, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] },
      diff: { addedRows: 0, removedRows: 2, changedCells: 0, truncated: false },
      metadata: { shape: { rows: 2, columns: 8 }, draftStep: { id: "filter-step", kind: "filterRows" } }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: filtered,
      code: "open_wrangler_result <- filtered_orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      revision: 2,
      metadata: { shape: { rows: 2, columns: 8 }, steps: [{ id: "filter-step", kind: "filterRows" }] }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "filter-step",
      stepIndex: 0,
      inputPage: source,
      outputPage: filtered,
      inputSchema: source.schema,
      outputSchema: filtered.schema,
      code: "open_wrangler_result <- filtered_orders"
    });
    const inspection = await bridge.request({
      kind: "inspectStep",
      sessionId,
      revision: 2,
      stepId: "filter-step",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(inspection).toMatchObject({
      kind: "stepInspection",
      diff: { addedRows: 0, removedRows: 2, changedCells: 0, truncated: false },
      outputPage: { totalRows: 2, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] }
    });
    if (inspection.kind !== "stepInspection") throw new Error("Expected an R filter-step inspection.");
    expect(inspection.inputPage.rows.map(({ id }) => id)).toEqual(["r:r:0", "r:r:1", "r:r:2", "r:r:3"]);

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 3,
      page: source,
      code: ""
    });
    const undone = await bridge.request(planRequest("undoStep", 2));
    expect(undone).toMatchObject({
      kind: "planUpdated",
      revision: 3,
      page: { totalRows: 4 },
      metadata: { shape: { rows: 4, columns: 8 }, steps: [] }
    });
    if (undone.kind !== "planUpdated") throw new Error("Expected the R filter step to be undone.");
    expect(undone.page.rows.map(({ id }) => id)).toEqual(["r:r:0", "r:r:1", "r:r:2", "r:r:3"]);
  });

  it("retains native R missing-row and duplicate-row steps through apply, inspection, and undo", async () => {
    const source = dataTableContract(
      rowOrderContract(frameContract({ totalRows: 5 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3", "r:r:4"], 5),
      ["r:c:0"]
    );
    const withoutMissing = dataTableContract(rowOrderContract(source, ["r:r:0", "r:r:2", "r:r:4"], 3), ["r:c:0"]);
    const withoutDuplicates = dataTableContract(rowOrderContract(source, ["r:r:0", "r:r:4"], 2), ["r:c:0"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const missingStep = {
      id: "drop-missing-step",
      kind: "dropMissingRows" as const,
      params: {
        columns: [{ id: "r:c:6", name: "missing" }],
        how: "any" as const
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: withoutMissing,
      diff: rowDiff(2),
      code: "open_wrangler_result <- orders[!is.na(orders[[7L]]), , drop = FALSE]"
    });
    const missingPreview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: missingStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      missingStep,
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(missingPreview).toMatchObject({
      kind: "stepPreview",
      diff: { addedRows: 0, removedRows: 2, changedCells: 0 },
      metadata: {
        shape: { rows: 3, columns: 8 },
        draftStep: {
          id: "drop-missing-step",
          kind: "dropMissingRows",
          params: { columns: [{ id: "r:c:6", name: "missing" }], how: "any" }
        }
      }
    });

    missingStep.params.columns[0]!.name = "tampered after preview";
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: withoutMissing,
      code: "open_wrangler_result <- orders[!is.na(orders[[7L]]), , drop = FALSE]"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        shape: { rows: 3 },
        steps: [
          {
            id: "drop-missing-step",
            kind: "dropMissingRows",
            params: { columns: [{ id: "r:c:6", name: "missing" }], how: "any" }
          }
        ]
      }
    });

    const duplicateStep = {
      id: "drop-duplicates-step",
      kind: "dropDuplicates" as const,
      params: { keep: "last" as const }
    };
    transport.queuePreview({
      sessionId,
      revision: 3,
      page: withoutDuplicates,
      diff: rowDiff(1),
      code: "open_wrangler_result <- open_wrangler_input[!duplicated(open_wrangler_input, fromLast = TRUE), ]"
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 2,
        step: duplicateStep,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      diff: { removedRows: 1 },
      metadata: {
        shape: { rows: 2 },
        steps: [{ id: "drop-missing-step" }],
        draftStep: { id: "drop-duplicates-step", kind: "dropDuplicates", params: { keep: "last" } }
      }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      2,
      duplicateStep,
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 4,
      page: withoutDuplicates,
      code: "open_wrangler_result <- open_wrangler_input[!duplicated(open_wrangler_input, fromLast = TRUE), ]"
    });
    await expect(bridge.request(planRequest("applyDraft", 3))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        shape: { rows: 2 },
        steps: [{ id: "drop-missing-step" }, { id: "drop-duplicates-step", params: { keep: "last" } }]
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 4,
      stepId: "drop-missing-step",
      stepIndex: 0,
      inputPage: source,
      outputPage: withoutMissing,
      inputSchema: source.schema,
      outputSchema: withoutMissing.schema,
      code: "drop missing"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 4,
        stepId: "drop-missing-step",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      diff: { removedRows: 2, changedCells: 0, truncated: false },
      outputPage: { rows: [{ id: "r:r:0" }, { id: "r:r:2" }, { id: "r:r:4" }] }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 4,
      stepId: "drop-duplicates-step",
      stepIndex: 1,
      inputPage: withoutMissing,
      outputPage: withoutDuplicates,
      inputSchema: withoutMissing.schema,
      outputSchema: withoutDuplicates.schema,
      code: "drop duplicates"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 4,
        stepId: "drop-duplicates-step",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      diff: { removedRows: 1, changedCells: 0, truncated: false },
      outputPage: { rows: [{ id: "r:r:0" }, { id: "r:r:4" }] }
    });

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 5,
      page: withoutMissing,
      code: "drop missing"
    });
    await expect(bridge.request(planRequest("undoStep", 4))).resolves.toMatchObject({
      kind: "planUpdated",
      page: { totalRows: 3 },
      metadata: { shape: { rows: 3 }, steps: [{ id: "drop-missing-step" }] }
    });

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 6,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("undoStep", 5))).resolves.toMatchObject({
      kind: "planUpdated",
      page: { totalRows: 5 },
      metadata: { shape: { rows: 5 }, steps: [] }
    });
  });

  it("normalizes an empty R drop-missing selection to all columns at the kernel boundary", async () => {
    const source = rowOrderContract(frameContract({ totalRows: 3 }), ["r:r:0", "r:r:1", "r:r:2"], 3);
    const reduced = rowOrderContract(source, ["r:r:1", "r:r:2"], 2);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: reduced,
      diff: rowDiff(1),
      code: "drop missing across all columns"
    });

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: { id: "drop-missing-all", kind: "dropMissingRows", params: { columns: [], how: "any" } },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: { draftStep: { params: { columns: [], how: "any" } } }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      { id: "drop-missing-all", kind: "dropMissingRows", params: { how: "any" } },
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
  });

  it("rejects stale native R row-reduction columns and impossible row diffs", async () => {
    const source = rowOrderContract(frameContract({ totalRows: 3 }), ["r:r:0", "r:r:1", "r:r:2"], 3);
    const reduced = rowOrderContract(source, ["r:r:0", "r:r:2"], 2);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "stale-drop-missing",
          kind: "dropMissingRows",
          params: { columns: [{ id: "r:c:6", name: "old name" }] }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("no longer matches")
    });
    expect(transport.previewStep).not.toHaveBeenCalled();

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: reduced,
      diff: { ...rowDiff(4), truncated: true },
      code: "bad result"
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: { id: "bad-drop-duplicates", kind: "dropDuplicates", params: {} },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("invalid row counts for Drop duplicates");
  });

  it("accepts an explicit-row-name R dataframe filtered to zero rows", async () => {
    const source = frameContract({ explicitRowLabel: "named-row", totalRows: 1 });
    const empty = rowOrderContract(source, [], 0);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const step = {
      id: "empty-named-filter-step",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          filters: [
            {
              column: { id: "r:c:0", name: "value" },
              type: "float" as const,
              predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 100 }]
            }
          ],
          sort: []
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: empty,
      diff: rowDiff(1),
      code: "open_wrangler_result <- orders[orders[[1L]] > 100, , drop = FALSE]"
    });

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
      page: { totalRows: 0, rows: [] },
      metadata: { shape: { rows: 0 }, filteredShape: { rows: 0 } },
      diff: { removedRows: 1, truncated: false }
    });
  });

  it.each([false, true])(
    "accepts a complete filtered output even when the page is smaller than the input (truncated: %s)",
    async (truncated) => {
      const source = rowOrderContract(frameContract({ totalRows: 4 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3"], 4);
      const filtered = rowOrderContract(source, ["r:r:1", "r:r:3"], 2);
      const completeOutput = { ...filtered, page: { ...filtered.page, limit: 2 } };
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));

      transport.getPage.mockResolvedValueOnce(completeOutput);
      await expect(
        bridge.request({
          kind: "getPage",
          sessionId,
          revision: 0,
          viewRequestId: "current-filter",
          offset: 0,
          limit: 2,
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
            sort: []
          }
        })
      ).resolves.toMatchObject({ kind: "page", page: { totalRows: 2, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] } });

      const filterStep = {
        id: "current-filter-step",
        kind: "filterRows" as const,
        params: {
          filterModel: {
            logic: "and" as const,
            filters: [
              {
                column: { id: "r:c:0", name: "value" },
                type: "float" as const,
                predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 0 }]
              }
            ],
            sort: []
          }
        }
      };
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: completeOutput,
        diff: { ...rowDiff(2), truncated },
        code: "open_wrangler_result <- orders[orders[[1L]] > 0, , drop = FALSE]"
      });

      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step: filterStep,
          offset: 0,
          limit: 2,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({
        kind: "stepPreview",
        page: { totalRows: 2, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] },
        diff: { removedRows: 2, truncated }
      });
      expect(transport.previewStep).toHaveBeenLastCalledWith(
        sessionId,
        0,
        filterStep,
        expect.objectContaining({
          rowLimit: 2,
          view: { filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })], sorts: [] }
        }),
        expect.any(Array),
        undefined,
        expect.any(Object)
      );
    }
  );

  it.each([true, false])("requires an incomplete filtered output to be marked truncated (%s)", async (truncated) => {
    const source = rowOrderContract(frameContract({ totalRows: 4 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3"], 4);
    const incompleteOutput = rowOrderContract(source, ["r:r:1", "r:r:3"], 3);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const filterStep = {
      id: "incomplete-filter-step",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          filters: [
            {
              column: { id: "r:c:0", name: "value" },
              type: "float" as const,
              predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 0 }]
            }
          ],
          sort: []
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: { ...incompleteOutput, page: { ...incompleteOutput.page, limit: 2 } },
      diff: { ...rowDiff(1), truncated },
      code: "open_wrangler_result <- orders[orders[[1L]] > 0, , drop = FALSE]"
    });
    const request = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step: filterStep,
      offset: 0,
      limit: 2,
      columnOffset: 0,
      columnLimit: 8
    };

    if (truncated) {
      await expect(bridge.request(request)).resolves.toMatchObject({
        kind: "stepPreview",
        page: { totalRows: 3, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] },
        diff: { removedRows: 1, truncated: true }
      });
    } else {
      await expect(bridge.request(request)).rejects.toThrow("invalid row-operation diff");
    }
  });

  it("keeps native R Group By lineage, replacement diffs, inspection, replay, and undo atomic", async () => {
    const source = rowOrderContract(frameContract({ totalRows: 4 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3"], 4);
    const step: GroupByTransformStep = {
      id: "r-group-1",
      kind: "groupBy",
      params: {
        keys: [{ id: "r:c:5", name: "flag" }],
        aggregations: [
          { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
          { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "average_value" },
          { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
        ]
      }
    };
    const grouped = groupContract(source, step, 2);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: grouped,
      diff: groupDiff(source, grouped, step),
      code: "open_wrangler_result <- grouped_orders"
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });

    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      {
        id: "r-group-1",
        kind: "groupBy",
        params: {
          keys: [{ id: "r:c:5", name: "flag" }],
          aggregations: [
            { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
            { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "average_value" },
            { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
          ]
        }
      },
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      diff: {
        addedRows: 2,
        removedRows: 4,
        addedColumns: ["rows_present", "average_value", "first_label"],
        removedColumns: ["value", "count", "date", "when", "elapsed", "missing", "infinite"],
        changedCells: 0
      },
      metadata: {
        schema: [
          expect.objectContaining({ id: "r:c:5", name: "flag", position: 0 }),
          expect.objectContaining({ id: "c:step:r-group-1:0", name: "rows_present", type: "integer" }),
          expect.objectContaining({ id: "c:step:r-group-1:1", name: "average_value", type: "float" }),
          expect.objectContaining({ id: "c:step:r-group-1:2", name: "first_label", type: "string" })
        ],
        draftStep: { id: "r-group-1", kind: "groupBy" }
      }
    });

    step.params.aggregations[0]!.alias = "tampered after preview";
    expect(preview).toMatchObject({
      metadata: {
        draftStep: {
          params: {
            aggregations: [{ alias: "rows_present" }, { alias: "average_value" }, { alias: "first_label" }]
          }
        }
      }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: grouped,
      code: "open_wrangler_result <- grouped_orders"
    });
    const applied = await bridge.request(planRequest("applyDraft", 1));
    expect(applied).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      metadata: {
        steps: [{ id: "r-group-1", kind: "groupBy" }],
        latestStepInputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:5", name: "flag" })])
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-group-1",
      stepIndex: 0,
      inputPage: source,
      outputPage: grouped,
      inputSchema: source.schema,
      outputSchema: grouped.schema,
      code: "open_wrangler_result <- grouped_orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-group-1",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      diff: { addedRows: 2, removedRows: 4, changedCells: 0 },
      outputSchema: expect.arrayContaining([expect.objectContaining({ id: "c:step:r-group-1:0" })])
    });

    transport.undoStep.mockResolvedValueOnce({ sessionId, action: "undo", revision: 3, page: source, code: "" });
    await expect(bridge.request(planRequest("undoStep", 2))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "undo",
      metadata: { steps: [], schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:5" })]) }
    });
  });

  it.each([true, false])(
    "requires a Group By diff to cover both its input and output row windows (truncated: %s)",
    async (truncated) => {
      const source = frameContract({ totalRows: 25 });
      const step: GroupByTransformStep = {
        id: "r-group-bounded-diff",
        kind: "groupBy",
        params: {
          keys: [{ id: "r:c:5", name: "flag" }],
          aggregations: [
            { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
            { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "average_value" },
            { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
          ]
        }
      };
      const grouped = groupContract(source, step, 2);
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: grouped,
        diff: { ...groupDiff(source, grouped, step), truncated },
        code: "open_wrangler_result <- grouped_orders"
      });
      const request = {
        kind: "previewStep" as const,
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      };

      if (truncated) {
        await expect(bridge.request(request)).resolves.toMatchObject({
          kind: "stepPreview",
          diff: { addedRows: 2, removedRows: 25, truncated: true }
        });
      } else {
        await expect(bridge.request(request)).rejects.toThrow("invalid Group and aggregate diff");
      }
    }
  );

  it("tracks explicit R row names across the complete Group By lifecycle", async () => {
    const source = frameContract({ explicitRowLabel: "source-row", totalRows: 1 });
    const step: GroupByTransformStep = {
      id: "r-group-row-names",
      kind: "groupBy",
      params: {
        keys: [{ id: "r:c:5", name: "flag" }],
        aggregations: [
          { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
          { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "average_value" },
          { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
        ]
      }
    };
    const grouped = groupContract(source, step, 1);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
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

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: grouped,
      diff: groupDiff(source, grouped, step),
      code: "open_wrangler_result <- grouped_orders"
    });
    await expect(bridge.request(previewRequest)).resolves.toMatchObject({
      kind: "stepPreview",
      page: { rows: [expect.not.objectContaining({ rowLabel: expect.anything() })] }
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
      page: { rows: [expect.objectContaining({ rowLabel: "source-row" })] }
    });

    transport.queuePreview({
      sessionId,
      revision: 3,
      page: grouped,
      diff: groupDiff(source, grouped, step),
      code: "open_wrangler_result <- grouped_orders"
    });
    await bridge.request({ ...previewRequest, revision: 2 });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 4,
      page: grouped,
      code: "open_wrangler_result <- grouped_orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 3))).resolves.toMatchObject({ kind: "planUpdated" });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 4,
      stepId: step.id,
      stepIndex: 0,
      inputPage: source,
      outputPage: grouped,
      inputSchema: source.schema,
      outputSchema: grouped.schema,
      code: "open_wrangler_result <- grouped_orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 4,
        stepId: step.id,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      inputPage: { rows: [expect.objectContaining({ rowLabel: "source-row" })] },
      outputPage: { rows: [expect.not.objectContaining({ rowLabel: expect.anything() })] }
    });

    transport.undoStep.mockResolvedValueOnce({ sessionId, action: "undo", revision: 5, page: source, code: "" });
    await expect(bridge.request(planRequest("undoStep", 4))).resolves.toMatchObject({
      kind: "planUpdated",
      page: { rows: [expect.objectContaining({ rowLabel: "source-row" })] }
    });
  });

  it.each(["filter", "sort"] as const)(
    "retains an aggregation-output %s while replacing and undoing the latest R Group By",
    async (viewKind) => {
      const source = frameContract({ totalRows: 2 });
      const step: GroupByTransformStep = {
        id: "r-group-retained-view",
        kind: "groupBy",
        params: {
          keys: [{ id: "r:c:5", name: "flag" }],
          aggregations: [
            { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
            { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "value" },
            { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
          ]
        }
      };
      const replacement: GroupByTransformStep = {
        id: step.id,
        kind: "groupBy",
        params: {
          keys: [{ id: "r:c:5", name: "flag" }],
          aggregations: [
            { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
            { column: { id: "r:c:0", name: "value" }, operation: "median", alias: "value" },
            { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
          ]
        }
      };
      const grouped = groupContract(source, step, 2);
      const viewedGrouped =
        viewKind === "filter"
          ? ({
              ...grouped,
              page: { ...grouped.page, totalRows: 1, rows: grouped.page.rows.slice(0, 1) }
            } satisfies RFramePageContract)
          : grouped;
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));

      transport.queuePreview({
        sessionId,
        revision: 1,
        page: grouped,
        diff: groupDiff(source, grouped, step),
        code: "open_wrangler_result <- grouped_orders"
      });
      await bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });
      transport.applyDraft.mockResolvedValueOnce({
        sessionId,
        action: "apply",
        revision: 2,
        page: grouped,
        code: "open_wrangler_result <- grouped_orders"
      });
      await bridge.request(planRequest("applyDraft", 1));

      transport.getPage.mockResolvedValueOnce(viewedGrouped);
      const filterModel =
        viewKind === "filter"
          ? {
              filters: [
                {
                  column: "value",
                  type: "float" as const,
                  predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 2 }]
                },
                {
                  column: "flag",
                  type: "boolean" as const,
                  predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: true }]
                }
              ],
              sort: []
            }
          : {
              filters: [],
              sort: [
                { column: "value", direction: "desc" as const, nulls: "last" as const },
                { column: "flag", direction: "asc" as const, nulls: "last" as const }
              ]
            };
      await bridge.request({
        kind: "getPage",
        sessionId,
        revision: 2,
        viewRequestId: "group-output-view",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel
      });

      transport.queuePreview({
        sessionId,
        revision: 3,
        page: viewedGrouped,
        diff: { ...groupDiff(source, grouped, replacement), truncated: viewKind === "filter" },
        code: "open_wrangler_result <- grouped_orders_with_median"
      });
      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 2,
          replaceStepId: step.id,
          step: replacement,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({
        kind: "stepPreview",
        metadata: { filterModel },
        page: { totalRows: viewKind === "filter" ? 1 : 2 }
      });
      expect(transport.previewStep).toHaveBeenLastCalledWith(
        sessionId,
        2,
        expect.objectContaining({ id: step.id, kind: "groupBy" }),
        expect.objectContaining({
          view: {
            filters:
              viewKind === "filter"
                ? [
                    expect.objectContaining({ column: { id: `c:step:${step.id}:1`, name: "value" } }),
                    expect.objectContaining({ column: { id: "r:c:5", name: "flag" } })
                  ]
                : [],
            sorts:
              viewKind === "sort"
                ? [
                    expect.objectContaining({ column: { id: `c:step:${step.id}:1`, name: "value" } }),
                    expect.objectContaining({ column: { id: "r:c:5", name: "flag" } })
                  ]
                : []
          }
        }),
        expect.any(Array),
        step.id,
        expect.any(Object)
      );

      transport.applyDraft.mockResolvedValueOnce({
        sessionId,
        action: "apply",
        revision: 4,
        page: viewedGrouped,
        code: "open_wrangler_result <- grouped_orders_with_median"
      });
      await expect(bridge.request(planRequest("applyDraft", 3))).resolves.toMatchObject({
        kind: "planUpdated",
        action: "apply",
        metadata: {
          filterModel,
          steps: [
            {
              id: step.id,
              kind: "groupBy",
              params: {
                aggregations: expect.arrayContaining([expect.objectContaining({ operation: "median" })])
              }
            }
          ]
        }
      });

      transport.undoStep.mockResolvedValueOnce({ sessionId, action: "undo", revision: 5, page: source, code: "" });
      await expect(bridge.request(planRequest("undoStep", 4))).resolves.toMatchObject({
        kind: "planUpdated",
        action: "undo",
        metadata: {
          filterModel:
            viewKind === "filter"
              ? { filters: [expect.objectContaining({ column: "flag" })], sort: [] }
              : { filters: [], sort: [expect.objectContaining({ column: "flag" })] },
          steps: []
        }
      });
      expect(transport.undoStep).toHaveBeenLastCalledWith(
        sessionId,
        4,
        expect.objectContaining({
          view:
            viewKind === "filter"
              ? {
                  filters: [expect.objectContaining({ column: { id: "r:c:5", name: "flag" } })],
                  sorts: []
                }
              : {
                  filters: [],
                  sorts: [expect.objectContaining({ column: { id: "r:c:5", name: "flag" } })]
                }
        }),
        expect.any(Object)
      );
    }
  );

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
          supportedOperations: operationKinds
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

  it("retains the exact normalized native R by-example program and runtime-derived output schema", async () => {
    const source = frameContract();
    const step = byExampleTransformStep();
    const output = cloneContract(source, "r:c:1", step.params.newColumn, step.id);
    const retainedStep = retainedByExampleTransformStep(step);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: output,
      diff: cloneDiff(step.params.newColumn),
      code: "orders[['count copy']] <- orders[['count']]",
      retainedStep
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });

    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      step,
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      warnings: ["2 programs match; Open Wrangler selected the simplest deterministic program."],
      metadata: {
        shape: { rows: 1, columns: 9 },
        schema: expect.arrayContaining([
          expect.objectContaining({
            id: "c:step:by-example-step:0",
            name: "count copy",
            rawType: "integer64",
            type: "integer"
          })
        ]),
        draftStep: {
          id: "by-example-step",
          kind: "byExample",
          params: {
            program: { kind: "column", column: { id: "r:c:1", name: "count" } },
            candidateCount: 2
          }
        }
      },
      diff: { addedColumns: ["count copy"], addedRows: 0, removedRows: 0 }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: output,
      code: "orders[['count copy']] <- orders[['count']]"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [
          {
            id: "by-example-step",
            kind: "byExample",
            params: { program: { kind: "column" }, warnings: expect.any(Array), candidateCount: 2 }
          }
        ]
      }
    });
  });

  it.each([
    {
      label: "factor",
      source: factorContract(frameContract(), "r:c:6", ["alpha", "beta"]),
      sourceColumn: { id: "r:c:6", name: "missing" },
      examples: [
        { inputs: ["alpha"], output: "alpha" },
        { inputs: ["beta"], output: "beta" }
      ] as ByExampleTransformStep["params"]["examples"],
      rawType: "factor"
    },
    {
      label: "difftime",
      source: frameContract(),
      sourceColumn: { id: "r:c:4", name: "elapsed" },
      examples: [
        { inputs: [90], output: 90 },
        { inputs: [120], output: 120 }
      ] as ByExampleTransformStep["params"]["examples"],
      rawType: "difftime"
    }
  ])("preserves a direct $label output's native R contract", async ({ source, sourceColumn, examples, rawType }) => {
    const step: ByExampleTransformStep = {
      id: `direct-${rawType}`,
      kind: "byExample",
      params: {
        sourceColumns: [sourceColumn],
        newColumn: `${sourceColumn.name} copy`,
        examples
      }
    };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloneContract(source, sourceColumn.id, step.params.newColumn, step.id),
      diff: cloneDiff(step.params.newColumn),
      code: "open_wrangler_result <- orders",
      retainedStep: retainedByExampleTransformStep(step)
    });

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
          expect.objectContaining({ id: `c:step:${step.id}:0`, name: step.params.newColumn, rawType })
        ])
      }
    });
  });

  it.each([
    { label: "observed nonmissing", outputNullable: false },
    { label: "observed missing", outputNullable: true }
  ])(
    "accepts runtime-derived $label direct-result nullability from a conservatively nullable source",
    async ({ outputNullable }) => {
      const base = frameContract();
      const source = outputNullable
        ? replaceContractCell(base, "r:c:1", {
            kind: "null",
            raw: null,
            display: "NA",
            isNull: true,
            isNaN: false
          })
        : base;
      expect(source.schema[1]).toMatchObject({ id: "r:c:1", nullable: true });
      const step = byExampleTransformStep();
      const outputId = `c:step:${step.id}:0`;
      const output = withColumnNullable(
        cloneContract(source, "r:c:1", step.params.newColumn, step.id),
        outputId,
        outputNullable
      );
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: output,
        diff: cloneDiff(step.params.newColumn),
        code: "open_wrangler_result <- orders",
        retainedStep: retainedByExampleTransformStep(step)
      });

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
          schema: expect.arrayContaining([expect.objectContaining({ id: outputId, nullable: outputNullable })])
        }
      });
    }
  );

  it.each([
    {
      label: "null",
      value: null,
      source: frameContract(),
      outputColumnId: "r:c:5",
      rawType: "logical"
    },
    {
      label: "logical",
      value: true,
      source: frameContract(),
      outputColumnId: "r:c:5",
      rawType: "logical"
    },
    {
      label: "character",
      value: "fixed",
      source: frameContract(),
      outputColumnId: "r:c:6",
      rawType: "character"
    },
    {
      label: "R integer maximum",
      value: 2_147_483_647,
      source: castContract(
        frameContract(),
        "r:c:1",
        "integer",
        "integer",
        rCell("integer", "2147483647", "2147483647"),
        false
      ),
      outputColumnId: "r:c:1",
      rawType: "integer"
    },
    {
      label: "reserved R integer minimum",
      value: -2_147_483_648,
      source: frameContract(),
      outputColumnId: "r:c:1",
      rawType: "integer64"
    },
    {
      label: "maximum safe integer",
      value: Number.MAX_SAFE_INTEGER,
      source: frameContract(),
      outputColumnId: "r:c:1",
      rawType: "integer64"
    },
    {
      label: "non-whole number",
      value: 1.5,
      source: frameContract(),
      outputColumnId: "r:c:0",
      rawType: "double"
    }
  ])("derives the exact native R $label literal result", async ({ value, source, outputColumnId, rawType }) => {
    const baseStep = byExampleTransformStep();
    const step: ByExampleTransformStep = {
      ...baseStep,
      id: `literal-${rawType}-${String(value)}`,
      params: {
        ...baseStep.params,
        newColumn: `literal ${rawType}`,
        examples: [
          { inputs: [1], output: value },
          { inputs: [2], output: value }
        ]
      }
    };
    const program: ByExampleProgram = { kind: "literal", value };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloneContract(source, outputColumnId, step.params.newColumn, step.id),
      diff: cloneDiff(step.params.newColumn),
      code: "open_wrangler_result <- orders",
      retainedStep: retainedByExampleTransformStep(step, program)
    });

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
          expect.objectContaining({ id: `c:step:${step.id}:0`, name: step.params.newColumn, rawType })
        ])
      }
    });
  });

  it.each([
    {
      label: "direct integer64 program as factor",
      program: { kind: "column", column: { id: "r:c:1", name: "count" } } as ByExampleProgram,
      outputColumnId: "r:c:6"
    },
    {
      label: "computed text program as integer64",
      program: {
        kind: "case",
        style: "upper",
        input: { kind: "column", column: { id: "r:c:1", name: "count" } }
      } as ByExampleProgram,
      outputColumnId: "r:c:1"
    },
    {
      label: "integer arithmetic program as double",
      program: {
        kind: "arithmetic",
        left: { kind: "column", column: { id: "r:c:1", name: "count" } },
        operator: "add",
        right: { kind: "literal", value: 1 }
      } as ByExampleProgram,
      outputColumnId: "r:c:0"
    }
  ])("rejects an allowed native raw type that mismatches a $label", async ({ program, outputColumnId }) => {
    const source = factorContract(frameContract(), "r:c:6", ["one", "two"]);
    const step = byExampleTransformStep();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloneContract(source, outputColumnId, step.params.newColumn, step.id),
      diff: cloneDiff(step.params.newColumn),
      code: "open_wrangler_result <- orders",
      retainedStep: retainedByExampleTransformStep(step, program)
    });

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
    ).rejects.toThrow("does not match the retained program");
  });

  it.each(["factor levels", "difftime units"])("rejects direct by-example %s drift", async (drift) => {
    const source =
      drift === "factor levels" ? factorContract(frameContract(), "r:c:6", ["alpha", "beta"]) : frameContract();
    const sourceColumn =
      drift === "factor levels" ? { id: "r:c:6", name: "missing" } : { id: "r:c:4", name: "elapsed" };
    const baseStep = byExampleTransformStep();
    const step: ByExampleTransformStep = {
      ...baseStep,
      id: drift === "factor levels" ? "factor-level-drift" : "difftime-unit-drift",
      params: {
        ...baseStep.params,
        sourceColumns: [sourceColumn],
        newColumn: `${sourceColumn.name} copy`
      }
    };
    const outputId = `c:step:${step.id}:0`;
    const cloned = cloneContract(source, sourceColumn.id, step.params.newColumn, step.id);
    const sourceRColumn = source.schema.find((column) => column.id === sourceColumn.id);
    if (!sourceRColumn) throw new Error("Fake direct by-example source column is missing.");
    let driftedSemantics: RColumnSchema["semantics"];
    if (drift === "factor levels") {
      if (sourceRColumn.semantics.kind !== "factor") throw new Error("Fake factor semantics are missing.");
      driftedSemantics = { ...sourceRColumn.semantics, levels: ["alpha", "gamma"] };
    } else {
      if (sourceRColumn.semantics.kind !== "difftime") throw new Error("Fake difftime semantics are missing.");
      driftedSemantics = { ...sourceRColumn.semantics, units: "mins" };
    }
    const drifted = replaceColumnSemantics(cloned, outputId, driftedSemantics);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: drifted,
      diff: cloneDiff(step.params.newColumn),
      code: "open_wrangler_result <- orders",
      retainedStep: retainedByExampleTransformStep(step)
    });

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
    ).rejects.toThrow("changed the native semantics");
  });

  it.each(["program literal", "example value"])("rejects an unsafe whole-number by-example %s", async (location) => {
    const baseStep = byExampleTransformStep();
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    const step: ByExampleTransformStep = {
      ...baseStep,
      id: `unsafe-${location.replace(" ", "-")}`,
      params: {
        ...baseStep.params,
        ...(location === "program literal" ? { program: { kind: "literal", value: unsafeInteger } as const } : {}),
        ...(location === "example value"
          ? {
              examples: [
                { inputs: [unsafeInteger], output: 1 },
                { inputs: [2], output: 2 }
              ] as ByExampleTransformStep["params"]["examples"]
            }
          : {})
      }
    };
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

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
      kind: "error",
      code: "invalid_request"
    });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it.each(["program literal", "example value"])(
    "rejects a negative-zero by-example %s before transport",
    async (location) => {
      const baseStep = byExampleTransformStep();
      const step: ByExampleTransformStep = {
        ...baseStep,
        id: `negative-zero-${location.replace(" ", "-")}`,
        params: {
          ...baseStep.params,
          ...(location === "program literal" ? { program: { kind: "literal", value: -0 } as const } : {}),
          ...(location === "example value"
            ? {
                examples: [
                  { inputs: [-0], output: 0 },
                  { inputs: [2], output: 2 }
                ] as ByExampleTransformStep["params"]["examples"]
              }
            : {})
        }
      };
      const transport = fakeTransport(frameContract());
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));

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
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
      expect(transport.previewStep).not.toHaveBeenCalled();
    }
  );

  it("rejects embedded NUL in native R by-example strings before transport dispatch", async () => {
    const baseStep = byExampleTransformStep();
    const step: ByExampleTransformStep = {
      ...baseStep,
      params: {
        ...baseStep.params,
        program: {
          kind: "regexReplace",
          input: { kind: "column", column: { id: "r:c:1", name: "count" } },
          pattern: "1",
          replacement: "one\u0000truncated"
        }
      }
    };
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

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
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("U+0000")
    });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("rejects a native R by-example source whose raw type is unsupported", async () => {
    const base = frameContract();
    const source: RFramePageContract = {
      ...base,
      schema: base.schema.map((column) => (column.id === "r:c:6" ? { ...column, rawType: "raw" } : { ...column }))
    };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const step: ByExampleTransformStep = {
      id: "unsupported-raw-by-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "r:c:6", name: "missing" }],
        newColumn: "raw copy",
        examples: [
          { inputs: ["00"], output: "00" },
          { inputs: ["ff"], output: "ff" }
        ]
      }
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
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("unsupported R raw values")
    });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("fails closed on stale, type-incompatible, or mis-correlated native R by-example state", async () => {
    const source = frameContract();
    const staleTransport = fakeTransport(source);
    const staleBridge = createBridge(staleTransport);
    await staleBridge.request(openRequest("editing"));
    const stale = byExampleTransformStep();
    stale.params.sourceColumns[0] = { id: "r:c:404", name: "count" };
    await expect(
      staleBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: stale,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request", message: expect.stringContaining("stale") });
    expect(staleTransport.previewStep).not.toHaveBeenCalled();

    const incompatibleTransport = fakeTransport(source);
    const incompatibleBridge = createBridge(incompatibleTransport);
    await incompatibleBridge.request(openRequest("editing"));
    const incompatible: ByExampleTransformStep = {
      id: "bad-by-example-step",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "r:c:5", name: "flag" }],
        newColumn: "bad output",
        examples: [
          { inputs: [true], output: "TRUE" },
          { inputs: [false], output: "FALSE" }
        ],
        program: {
          kind: "case",
          style: "upper",
          input: { kind: "column", column: { id: "r:c:5", name: "flag" } }
        }
      }
    };
    await expect(
      incompatibleBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: incompatible,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("portable text-coercible")
    });
    expect(incompatibleTransport.previewStep).not.toHaveBeenCalled();

    const mismatchedTransport = fakeTransport(source);
    const mismatchedBridge = createBridge(mismatchedTransport);
    await mismatchedBridge.request(openRequest("editing"));
    const requestStep = byExampleTransformStep();
    const returnedStep = retainedByExampleTransformStep(requestStep);
    mismatchedTransport.queuePreview({
      sessionId,
      revision: 1,
      page: cloneContract(source, "r:c:1", requestStep.params.newColumn, requestStep.id),
      diff: cloneDiff(requestStep.params.newColumn),
      code: "orders[['count copy']] <- orders[['count']]",
      retainedStep: {
        ...returnedStep,
        params: {
          ...returnedStep.params,
          examples: [{ inputs: [999], output: 999 }, ...returnedStep.params.examples.slice(1)]
        }
      }
    });
    await expect(
      mismatchedBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: requestStep,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("does not match the exact preview request");
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

  it("fills missing native R values and keeps applied and edited steps independent", async () => {
    const source = frameContract();
    const firstValue: RFrameCell = {
      kind: "string",
      raw: "unknown",
      display: "unknown",
      isNull: false,
      isNaN: false
    };
    const firstOutput = fillMissingContract(source, "r:c:6", firstValue);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const step: FillMissingValuesTransformStep = {
      id: "r-fill-missing",
      kind: "fillMissingValues",
      params: {
        column: { id: "r:c:6", name: "missing" },
        replacement: { kind: "string", value: "unknown" }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: firstOutput,
      diff: fillMissingDiff("r:c:6", "missing", firstValue),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: 0
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
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
    expect(preview).toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "r:c:6", name: "missing", type: "string", nullable: false })
        ]),
        draftStep: {
          id: "r-fill-missing",
          kind: "fillMissingValues",
          params: { replacement: { kind: "string", value: "unknown" } }
        }
      },
      diff: {
        changedCells: 1,
        cells: [
          expect.objectContaining({
            rowNumber: 0,
            columnId: "r:c:6",
            column: "missing",
            before: expect.objectContaining({ kind: "null", raw: null }),
            after: expect.objectContaining({ kind: "string", raw: "unknown" })
          })
        ]
      },
      remainingMissingCells: 0
    });

    if (step.params.replacement.kind !== "string") throw new Error("expected a string replacement");
    step.params.replacement.value = "caller mutation";
    expect(preview).toMatchObject({
      metadata: { draftStep: { params: { replacement: { value: "unknown" } } } }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: firstOutput,
      code: "open_wrangler_result <- orders"
    });
    const applied = await bridge.request(planRequest("applyDraft", 1));
    expect(applied).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2,
      metadata: {
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:6", nullable: false })]),
        latestStepInputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:6", nullable: true })]),
        steps: [
          {
            id: "r-fill-missing",
            kind: "fillMissingValues",
            params: { replacement: { kind: "string", value: "unknown" } }
          }
        ]
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-fill-missing",
      stepIndex: 0,
      inputPage: source,
      outputPage: firstOutput,
      inputSchema: source.schema,
      outputSchema: firstOutput.schema,
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-fill-missing",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      inputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:6", nullable: true })]),
      outputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:6", nullable: false })]),
      diff: {
        changedCells: 1,
        cells: [
          expect.objectContaining({
            columnId: "r:c:6",
            before: expect.objectContaining({ kind: "null" }),
            after: expect.objectContaining({ kind: "string", raw: "unknown" })
          })
        ]
      }
    });

    const editedValue: RFrameCell = {
      kind: "string",
      raw: "N/A",
      display: "N/A",
      isNull: false,
      isNaN: false
    };
    transport.queuePreview({
      sessionId,
      revision: 3,
      page: fillMissingContract(source, "r:c:6", editedValue),
      diff: fillMissingDiff("r:c:6", "missing", editedValue),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: 0
    });
    const edited = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 2,
      replaceStepId: "r-fill-missing",
      step: {
        id: "r-fill-missing",
        kind: "fillMissingValues",
        params: {
          column: { id: "r:c:6", name: "missing" },
          replacement: { kind: "string", value: "N/A" }
        }
      },
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(edited).toMatchObject({
      kind: "stepPreview",
      metadata: {
        steps: [{ params: { replacement: { value: "unknown" } } }],
        draftStep: { params: { replacement: { value: "N/A" } } },
        draftReplacesStepId: "r-fill-missing",
        latestStepInputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:6", nullable: true })])
      }
    });
  });

  it("rejects an impossible missing-value count from the R runtime", async () => {
    const source = frameContract();
    const firstValue: RFrameCell = {
      kind: "string",
      raw: "unknown",
      display: "unknown",
      isNull: false,
      isNaN: false
    };
    const output = fillMissingContract(source, "r:c:6", firstValue);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: output,
      diff: fillMissingDiff("r:c:6", "missing", firstValue),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: output.shape.rows + 1
    });

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-fill-invalid-count",
          kind: "fillMissingValues",
          params: {
            column: { id: "r:c:6", name: "missing" },
            replacement: { kind: "string", value: "unknown" }
          }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("more missing values than rows");
  });

  it("previews a native R mean fill for a floating-point column", async () => {
    const source = replaceContractCell(frameContract(), "r:c:0", {
      kind: "null",
      raw: null,
      display: "NA",
      isNull: true,
      isNaN: false
    });
    const meanValue = rCell("number", "3", "3");
    const output = fillMissingContract(source, "r:c:0", meanValue);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const step: FillMissingValuesTransformStep = {
      id: "r-fill-mean",
      kind: "fillMissingValues",
      params: {
        column: { id: "r:c:0", name: "value" },
        replacement: { kind: "mean" }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: output,
      diff: fillMissingDiff("r:c:0", "value", meanValue),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: 0
    });

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
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:0", type: "float", nullable: false })]),
        draftStep: { params: { replacement: { kind: "mean" } } }
      }
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
  });

  it("fills native R values from ordered fallback columns with dynamic nullability and isolated drafts", async () => {
    const fallbackValue: RFrameCell = {
      kind: "string",
      raw: "backup",
      display: "backup",
      isNull: false,
      isNaN: false
    };
    const source = castContract(frameContract(), "r:c:7", "character", "string", fallbackValue, false);
    const unresolved = withColumnNullable(source, "r:c:6", true);
    const complete = fillMissingContract(source, "r:c:6", fallbackValue);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const step: FillMissingValuesTransformStep = {
      id: "r-fill-fallback",
      kind: "fillMissingValues",
      params: {
        column: { id: "r:c:6", name: "missing" },
        replacement: {
          kind: "fallbackColumns",
          columns: [{ id: "r:c:7", name: "infinite" }]
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: unresolved,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: 1
    });
    const partialPreview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(partialPreview).toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:6", nullable: true })]),
        draftStep: {
          params: {
            replacement: {
              kind: "fallbackColumns",
              columns: [{ id: "r:c:7", name: "infinite" }]
            }
          }
        }
      },
      warnings: [expect.stringContaining("still missing")]
    });
    const dispatched = transport.previewStep.mock.calls[0]?.[2] as RKernelTransformStep | undefined;
    if (!dispatched || dispatched.kind !== "fillMissingValues") throw new Error("expected a dispatched fill step");
    expect(Object.isFrozen(dispatched)).toBe(true);
    expect(Object.isFrozen(dispatched.params.replacement)).toBe(true);
    if (dispatched.params.replacement.kind !== "fallbackColumns") throw new Error("expected fallback columns");
    expect(Object.isFrozen(dispatched.params.replacement.columns)).toBe(true);
    expect(Object.isFrozen(dispatched.params.replacement.columns[0])).toBe(true);

    if (step.params.replacement.kind !== "fallbackColumns") throw new Error("expected fallback columns");
    step.params.replacement.columns[0].name = "caller mutation";
    expect(partialPreview).toMatchObject({
      metadata: {
        draftStep: {
          params: { replacement: { columns: [{ id: "r:c:7", name: "infinite" }] } }
        }
      }
    });

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 2,
      page: source,
      code: ""
    });
    await bridge.request(planRequest("discardDraft", 1));

    transport.queuePreview({
      sessionId,
      revision: 3,
      page: complete,
      diff: fillMissingDiff("r:c:6", "missing", fallbackValue),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: 0
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 2,
        step: {
          id: "r-fill-fallback-complete",
          kind: "fillMissingValues",
          params: {
            column: { id: "r:c:6", name: "missing" },
            replacement: {
              kind: "fallbackColumns",
              columns: [{ id: "r:c:7", name: "infinite" }]
            }
          }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: { schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:6", nullable: false })]) },
      warnings: []
    });
  });

  it("dispatches directional R fills with explicit stable ordering and conservative nullability", async () => {
    const source = frameContract();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const step: FillMissingValuesTransformStep = {
      id: "r-fill-directional",
      kind: "fillMissingValues",
      params: {
        column: { id: "r:c:6", name: "missing" },
        replacement: {
          kind: "directional",
          direction: "forward",
          orderBy: [
            {
              column: { id: "r:c:0", name: "value" },
              direction: "asc",
              nulls: "last"
            }
          ],
          maxGap: 2
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: source,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: 1
    });

    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(preview).toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:6", nullable: true })]),
        draftStep: {
          params: {
            replacement: {
              kind: "directional",
              direction: "forward",
              orderBy: [{ column: { id: "r:c:0", name: "value" } }],
              maxGap: 2
            }
          }
        }
      }
    });

    const dispatched = transport.previewStep.mock.calls[0]?.[2] as RKernelTransformStep | undefined;
    if (!dispatched || dispatched.kind !== "fillMissingValues") throw new Error("expected a dispatched fill step");
    if (dispatched.params.replacement.kind !== "directional") throw new Error("expected a directional fill");
    expect(Object.isFrozen(dispatched.params.replacement)).toBe(true);
    expect(Object.isFrozen(dispatched.params.replacement.orderBy)).toBe(true);
    expect(Object.isFrozen(dispatched.params.replacement.orderBy[0])).toBe(true);
    expect(Object.isFrozen(dispatched.params.replacement.orderBy[0].column)).toBe(true);

    if (step.params.replacement.kind !== "directional") throw new Error("expected a directional fill");
    step.params.replacement.orderBy[0].column.name = "caller mutation";
    expect(preview).toMatchObject({
      metadata: {
        draftStep: {
          params: { replacement: { orderBy: [{ column: { id: "r:c:0", name: "value" } }] } }
        }
      }
    });
  });

  it("rejects invalid directional R ordering before dispatch", async () => {
    const invalidReplacements = [
      {
        kind: "directional",
        direction: "forward",
        orderBy: [{ column: { id: "r:c:6", name: "missing" }, direction: "asc", nulls: "last" }]
      },
      {
        kind: "directional",
        direction: "backward",
        orderBy: [{ column: { id: "r:c:0", name: "stale" }, direction: "asc", nulls: "last" }]
      },
      {
        kind: "directional",
        direction: "forward",
        orderBy: [{ column: { id: "r:c:0", name: "value" }, direction: "asc", nulls: "last" }],
        maxGap: 0
      },
      {
        kind: "directional",
        direction: "sideways",
        orderBy: [{ column: { id: "r:c:0", name: "value" }, direction: "asc", nulls: "last" }]
      }
    ] as const;

    for (const [index, replacement] of invalidReplacements.entries()) {
      const transport = fakeTransport(frameContract());
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step: {
            id: `r-fill-invalid-directional-${index}`,
            kind: "fillMissingValues",
            params: {
              column: { id: "r:c:6", name: "missing" },
              replacement
            }
          } as unknown as FillMissingValuesTransformStep,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
      expect(transport.previewStep).not.toHaveBeenCalled();
    }
  });

  it("dispatches R linear interpolation with one stable coordinate and conservative nullability", async () => {
    const source = frameContract();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const step: FillMissingValuesTransformStep = {
      id: "r-fill-linear",
      kind: "fillMissingValues",
      params: {
        column: { id: "r:c:7", name: "infinite" },
        replacement: {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:2", name: "date" },
          maxGap: 3
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: source,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: 0
    });

    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(preview).toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:7", nullable: true })]),
        draftStep: {
          params: {
            replacement: {
              kind: "linearInterpolation",
              coordinate: { id: "r:c:2", name: "date" },
              maxGap: 3
            }
          }
        }
      }
    });

    const dispatched = transport.previewStep.mock.calls[0]?.[2] as RKernelTransformStep | undefined;
    if (!dispatched || dispatched.kind !== "fillMissingValues") throw new Error("expected a dispatched fill step");
    if (dispatched.params.replacement.kind !== "linearInterpolation") {
      throw new Error("expected linear interpolation");
    }
    expect(Object.isFrozen(dispatched.params.replacement)).toBe(true);
    expect(Object.isFrozen(dispatched.params.replacement.coordinate)).toBe(true);

    if (step.params.replacement.kind !== "linearInterpolation") throw new Error("expected linear interpolation");
    step.params.replacement.coordinate.name = "caller mutation";
    expect(preview).toMatchObject({
      metadata: {
        draftStep: {
          params: { replacement: { coordinate: { id: "r:c:2", name: "date" } } }
        }
      }
    });
  });

  it("rejects invalid R linear interpolation before dispatch", async () => {
    const invalidSteps = [
      {
        column: { id: "r:c:7", name: "infinite" },
        replacement: {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:7", name: "infinite" }
        }
      },
      {
        column: { id: "r:c:7", name: "infinite" },
        replacement: {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:1", name: "count" }
        }
      },
      {
        column: { id: "r:c:7", name: "infinite" },
        replacement: {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:2", name: "stale" }
        }
      },
      {
        column: { id: "r:c:6", name: "missing" },
        replacement: {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:2", name: "date" }
        }
      },
      {
        column: { id: "r:c:7", name: "infinite" },
        replacement: {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:2", name: "date" },
          maxGap: 0
        }
      }
    ] as const;

    for (const [index, params] of invalidSteps.entries()) {
      const transport = fakeTransport(frameContract());
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step: {
            id: `r-fill-invalid-linear-${index}`,
            kind: "fillMissingValues",
            params
          } as unknown as FillMissingValuesTransformStep,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
      expect(transport.previewStep).not.toHaveBeenCalled();
    }
  });

  it("dispatches grouped R fills with stable keys and conservative nullability", async () => {
    const source = frameContract();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const step: FillMissingValuesTransformStep = {
      id: "r-fill-grouped",
      kind: "fillMissingValues",
      params: {
        column: { id: "r:c:7", name: "infinite" },
        replacement: {
          kind: "groupedStatistic",
          statistic: "mean",
          keys: [
            { id: "r:c:2", name: "date" },
            { id: "r:c:5", name: "flag" }
          ]
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: source,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: 0
    });

    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(preview).toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:7", nullable: true })]),
        draftStep: {
          params: {
            replacement: {
              kind: "groupedStatistic",
              statistic: "mean",
              keys: [
                { id: "r:c:2", name: "date" },
                { id: "r:c:5", name: "flag" }
              ]
            }
          }
        }
      }
    });

    const dispatched = transport.previewStep.mock.calls[0]?.[2] as RKernelTransformStep | undefined;
    if (!dispatched || dispatched.kind !== "fillMissingValues") throw new Error("expected a dispatched fill step");
    if (dispatched.params.replacement.kind !== "groupedStatistic") throw new Error("expected a grouped fill");
    expect(Object.isFrozen(dispatched.params.replacement)).toBe(true);
    expect(Object.isFrozen(dispatched.params.replacement.keys)).toBe(true);
    expect(Object.isFrozen(dispatched.params.replacement.keys[0])).toBe(true);

    if (step.params.replacement.kind !== "groupedStatistic") throw new Error("expected a grouped fill");
    step.params.replacement.keys[0].name = "caller mutation";
    expect(preview).toMatchObject({
      metadata: {
        draftStep: {
          params: {
            replacement: {
              keys: [
                { id: "r:c:2", name: "date" },
                { id: "r:c:5", name: "flag" }
              ]
            }
          }
        }
      }
    });
  });

  it("rejects invalid grouped R fills before dispatch", async () => {
    const invalidSteps = [
      {
        column: { id: "r:c:7", name: "infinite" },
        replacement: {
          kind: "groupedStatistic",
          statistic: "mean",
          keys: [{ id: "r:c:7", name: "infinite" }]
        }
      },
      {
        column: { id: "r:c:7", name: "infinite" },
        replacement: {
          kind: "groupedStatistic",
          statistic: "mean",
          keys: [
            { id: "r:c:2", name: "date" },
            { id: "r:c:2", name: "date" }
          ]
        }
      },
      {
        column: { id: "r:c:7", name: "infinite" },
        replacement: {
          kind: "groupedStatistic",
          statistic: "mean",
          keys: [{ id: "r:c:2", name: "stale" }]
        }
      },
      {
        column: { id: "r:c:6", name: "missing" },
        replacement: {
          kind: "groupedStatistic",
          statistic: "mean",
          keys: [{ id: "r:c:2", name: "date" }]
        }
      }
    ] as const;

    for (const [index, params] of invalidSteps.entries()) {
      const transport = fakeTransport(frameContract());
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step: {
            id: `r-fill-invalid-grouped-${index}`,
            kind: "fillMissingValues",
            params
          } as unknown as FillMissingValuesTransformStep,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
      expect(transport.previewStep).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid R fallback-column references before dispatch and accepts a keyed fallback", async () => {
    const fallbackValue: RFrameCell = {
      kind: "string",
      raw: "backup",
      display: "backup",
      isNull: false,
      isNaN: false
    };
    const source = castContract(frameContract(), "r:c:7", "character", "string", fallbackValue, false);
    const invalidColumns = [
      [{ id: "r:c:6", name: "missing" }],
      [
        { id: "r:c:7", name: "infinite" },
        { id: "r:c:7", name: "infinite" }
      ],
      [{ id: "r:c:7", name: "stale" }],
      [{ id: "r:c:0", name: "value" }]
    ] as const;

    for (const [index, columns] of invalidColumns.entries()) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step: {
            id: `r-fill-invalid-fallback-${index}`,
            kind: "fillMissingValues",
            params: {
              column: { id: "r:c:6", name: "missing" },
              replacement: { kind: "fallbackColumns", columns: [...columns] }
            }
          },
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
      expect(transport.previewStep).not.toHaveBeenCalled();
    }

    const keyedSource = dataTableContract(source, ["r:c:7"]);
    const keyedTransport = fakeTransport(keyedSource);
    const keyedBridge = createBridge(keyedTransport);
    await keyedBridge.request(openRequest("editing"));
    keyedTransport.queuePreview({
      sessionId,
      revision: 1,
      page: fillMissingContract(keyedSource, "r:c:6", fallbackValue),
      diff: fillMissingDiff("r:c:6", "missing", fallbackValue),
      code: "open_wrangler_result <- orders",
      remainingMissingCells: 0
    });
    await expect(
      keyedBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-fill-keyed-fallback",
          kind: "fillMissingValues",
          params: {
            column: { id: "r:c:6", name: "missing" },
            replacement: {
              kind: "fallbackColumns",
              columns: [{ id: "r:c:7", name: "infinite" }]
            }
          }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "stepPreview" });
    expect(keyedTransport.previewStep).toHaveBeenCalledOnce();
  });

  it("accepts most common value for R text and boolean columns and rejects numeric columns", async () => {
    const cases = [
      {
        column: { id: "r:c:6", name: "missing" },
        value: { kind: "string", raw: "ready", display: "ready", isNull: false, isNaN: false } as RFrameCell
      },
      {
        column: { id: "r:c:5", name: "flag" },
        value: { kind: "boolean", raw: true, display: "TRUE", isNull: false, isNaN: false } as RFrameCell
      }
    ] as const;

    for (const testCase of cases) {
      const source = frameContract();
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: fillMissingContract(source, testCase.column.id, testCase.value),
        diff: fillMissingDiff(testCase.column.id, testCase.column.name, testCase.value),
        code: "open_wrangler_result <- orders",
        remainingMissingCells: 0
      });

      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step: {
            id: `r-fill-most-${testCase.column.id}`,
            kind: "fillMissingValues",
            params: { column: testCase.column, replacement: { kind: "mostFrequent" } }
          },
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({
        kind: "stepPreview",
        metadata: {
          schema: expect.arrayContaining([expect.objectContaining({ id: testCase.column.id, nullable: false })]),
          draftStep: { params: { replacement: { kind: "mostFrequent" } } }
        }
      });
    }

    const numericSource = frameContract();
    const numericTransport = fakeTransport(numericSource);
    const numericBridge = createBridge(numericTransport);
    await numericBridge.request(openRequest("editing"));
    await expect(
      numericBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-fill-most-number",
          kind: "fillMissingValues",
          params: {
            column: { id: "r:c:0", name: "value" },
            replacement: { kind: "mostFrequent" }
          }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("incompatible")
    });
    expect(numericTransport.previewStep).not.toHaveBeenCalled();
  });

  it("rejects Fill Missing Values on a native R data.table key before dispatch", async () => {
    const source = dataTableContract(frameContract(), ["r:c:6"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-fill-key",
          kind: "fillMissingValues",
          params: {
            column: { id: "r:c:6", name: "missing" },
            replacement: { kind: "string", value: "unknown" }
          }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("key column")
    });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("previews native R Round, Floor, and Ceiling in place or under stable appended identities", async () => {
    const cases: ReadonlyArray<{
      step: RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep;
      source: RFramePageContract;
      after: RFrameCell;
      expectedRawType: "double" | "integer64";
      expectedType: "float" | "integer";
    }> = [
      {
        step: {
          id: "r-round-in-place",
          kind: "roundNumber",
          params: { column: { id: "r:c:0", name: "value" }, decimals: 1 }
        },
        source: replaceContractCell(frameContract(), "r:c:0", rCell("number", "12.56", "12.56")),
        after: rCell("number", "12.6", "12.6"),
        expectedRawType: "double",
        expectedType: "float"
      },
      {
        step: {
          id: "r-floor-appended-integer64",
          kind: "floorNumber",
          params: { column: { id: "r:c:1", name: "count" }, newColumn: "floored_count" }
        },
        source: dataTableContract(frameContract(), ["r:c:1"]),
        after: rCell("integer", "9223372036854775807", "9223372036854775807"),
        expectedRawType: "integer64",
        expectedType: "integer"
      },
      {
        step: {
          id: "r-ceiling-in-place",
          kind: "ceilNumber",
          params: { column: { id: "r:c:0", name: "value" } }
        },
        source: replaceContractCell(frameContract(), "r:c:0", rCell("number", "-12.1", "-12.1")),
        after: rCell("number", "-12", "-12"),
        expectedRawType: "double",
        expectedType: "float"
      }
    ];

    for (const testCase of cases) {
      const transport = fakeTransport(testCase.source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      const inPlace = testCase.step.params.newColumn === undefined;
      const output = inPlace
        ? castContract(
            testCase.source,
            testCase.step.params.column.id,
            testCase.expectedRawType,
            testCase.expectedType,
            testCase.after,
            true
          )
        : cloneContract(
            testCase.source,
            testCase.step.params.column.id,
            testCase.step.params.newColumn as string,
            testCase.step.id
          );
      const outputId = inPlace ? testCase.step.params.column.id : `c:step:${testCase.step.id}:0`;
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: output,
        diff: inPlace
          ? numericRoundingDiff(
              testCase.step.params.column.id,
              testCase.step.params.column.name,
              testCase.source.page.rows[0]?.values[
                testCase.source.page.columnIds.indexOf(testCase.step.params.column.id)
              ] as RFrameCell,
              testCase.after
            )
          : cloneDiff(testCase.step.params.newColumn as string),
        code: "open_wrangler_result <- orders"
      });

      const response = await bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: testCase.step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });

      expect(transport.previewStep).toHaveBeenCalledWith(
        sessionId,
        0,
        testCase.step,
        expect.any(Object),
        expect.any(Array),
        undefined,
        expect.any(Object)
      );
      expect(response).toMatchObject({
        kind: "stepPreview",
        revision: 1,
        metadata: {
          shape: { columns: testCase.source.shape.columns + (inPlace ? 0 : 1) },
          schema: expect.arrayContaining([
            expect.objectContaining({
              id: outputId,
              name: inPlace ? testCase.step.params.column.name : testCase.step.params.newColumn,
              rawType: testCase.expectedRawType,
              type: testCase.expectedType
            })
          ]),
          draftStep: testCase.step
        },
        diff: inPlace
          ? { addedColumns: [], changedCells: 1, cells: [expect.objectContaining({ columnId: outputId })] }
          : { addedColumns: [testCase.step.params.newColumn], changedCells: 0, cells: [] }
      });
    }
  });

  it("previews native R Min-max scale as nullable doubles in place or under stable appended identities", async () => {
    const cases: ReadonlyArray<{
      step: MinMaxScaleTransformStep;
      source: RFramePageContract;
      output: RFramePageContract;
      diff: DataDiff;
      outputId: string;
      outputName: string;
    }> = [
      (() => {
        const step: MinMaxScaleTransformStep = {
          id: "r-scale-finite-in-place",
          kind: "minMaxScale",
          params: { column: { id: "r:c:1", name: "count" } }
        };
        const source = withColumnNullable(frameContract(), "r:c:1", false);
        const after: RFrameCell = { kind: "number", raw: "0", display: "0", isNull: false, isNaN: false };
        return {
          step,
          source,
          output: castContract(source, "r:c:1", "double", "float", after, true),
          diff: castDiff("r:c:1", "count", source.page.rows[0]?.values[1] as RFrameCell, after),
          outputId: "r:c:1",
          outputName: "count"
        };
      })(),
      (() => {
        const step: MinMaxScaleTransformStep = {
          id: "r-scale-in-place",
          kind: "minMaxScale",
          params: { column: { id: "r:c:7", name: "infinite" } }
        };
        const source = withColumnNullable(frameContract(), "r:c:7", false);
        const after = { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false } as RFrameCell;
        return {
          step,
          source,
          output: castContract(source, "r:c:7", "double", "float", after, true),
          diff: castDiff("r:c:7", "infinite", source.page.rows[0]?.values[7] as RFrameCell, after),
          outputId: "r:c:7",
          outputName: "infinite"
        };
      })(),
      (() => {
        const step: MinMaxScaleTransformStep = {
          id: "r-scale-derived",
          kind: "minMaxScale",
          params: { column: { id: "r:c:1", name: "count" }, newColumn: "count_scaled" }
        };
        const source = dataTableContract(withColumnNullable(frameContract(), "r:c:1", false), ["r:c:1"]);
        return {
          step,
          source,
          output: minMaxScaleContract(source, "r:c:1", step.id, "count_scaled"),
          diff: cloneDiff("count_scaled"),
          outputId: `c:step:${step.id}:0`,
          outputName: "count_scaled"
        };
      })()
    ];

    for (const testCase of cases) {
      const transport = fakeTransport(testCase.source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: testCase.output,
        diff: testCase.diff,
        code: "open_wrangler_result <- orders"
      });

      const response = await bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: testCase.step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });

      expect(transport.previewStep).toHaveBeenCalledWith(
        sessionId,
        0,
        testCase.step,
        expect.any(Object),
        expect.any(Array),
        undefined,
        expect.any(Object)
      );
      expect(response).toMatchObject({
        kind: "stepPreview",
        revision: 1,
        metadata: {
          shape: { columns: testCase.source.shape.columns + (testCase.step.params.newColumn === undefined ? 0 : 1) },
          schema: expect.arrayContaining([
            expect.objectContaining({
              id: testCase.outputId,
              name: testCase.outputName,
              rawType: "double",
              type: "float",
              nullable: testCase.output.schema.find((column) => column.id === testCase.outputId)?.nullable
            })
          ]),
          draftStep: testCase.step
        },
        diff: testCase.diff
      });
    }
  });

  it("rejects invalid native R Min-max scale inputs before transport", async () => {
    const source = dataTableContract(frameContract(), ["r:c:0"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const invalidSteps = [
      {
        id: "stale-scale",
        kind: "minMaxScale",
        params: { column: { id: "r:c:0", name: "stale" } }
      },
      {
        id: "date-scale",
        kind: "minMaxScale",
        params: { column: { id: "r:c:2", name: "date" } }
      },
      {
        id: "colliding-scale",
        kind: "minMaxScale",
        params: { column: { id: "r:c:0", name: "value" }, newColumn: "count" }
      },
      {
        id: "private-scale",
        kind: "minMaxScale",
        params: {
          column: { id: "r:c:0", name: "value" },
          newColumn: "__OPEN_WRANGLER_INTERNAL_ROW_ID_forged"
        }
      },
      {
        id: "keyed-scale",
        kind: "minMaxScale",
        params: { column: { id: "r:c:0", name: "value" } }
      }
    ] satisfies MinMaxScaleTransformStep[];

    for (const step of invalidSteps) {
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
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    }
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("publishes native R Formula scalar and right-column drafts with exact generated payloads", async () => {
    const source = castContract(
      castContract(frameContract(), "r:c:0", "integer", "integer", rCell("integer", "12", "12"), false),
      "r:c:1",
      "integer",
      "integer",
      rCell("integer", "4", "4"),
      true
    );
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const scalarStep: FormulaTransformStep = {
      id: "r-formula-scalar",
      kind: "formula",
      params: {
        leftColumn: { id: "r:c:0", name: "value" },
        operator: "divide",
        value: 2,
        newColumn: "value_half"
      }
    };
    const scalarOutput = formulaContract(source, scalarStep, "double", "float", false);
    const scalarCode =
      "open_wrangler_result <- open_wrangler_formula_column_at(orders, 1L, 'value', 'divide', 'value_half', right_value = 2)";
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: scalarOutput,
      diff: cloneDiff("value_half"),
      code: scalarCode
    });

    const scalarPreview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: scalarStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });

    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      {
        id: "r-formula-scalar",
        kind: "formula",
        params: {
          leftColumn: { id: "r:c:0", name: "value" },
          operator: "divide",
          value: 2,
          newColumn: "value_half"
        }
      },
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    const dispatchedScalar = transport.previewStep.mock.calls.at(-1)?.[2];
    expect(Object.isFrozen(dispatchedScalar)).toBe(true);
    expect(Object.isFrozen(dispatchedScalar?.params)).toBe(true);
    expect(scalarPreview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      code: scalarCode,
      metadata: {
        shape: { rows: 1, columns: 9 },
        schema: expect.arrayContaining([
          {
            id: "c:step:r-formula-scalar:0",
            name: "value_half",
            position: 8,
            rawType: "double",
            type: "float",
            nullable: false
          }
        ]),
        draftStep: scalarStep
      },
      diff: { addedColumns: ["value_half"], removedColumns: [], changedCells: 0, cells: [] }
    });
    scalarStep.params.value = 99;
    expect(scalarPreview).toMatchObject({ metadata: { draftStep: { params: { value: 2 } } } });

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 2,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("discardDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "discard",
      revision: 2,
      metadata: { shape: { columns: 8 }, steps: [] }
    });

    const columnStep: FormulaTransformStep = {
      id: "r-formula-columns",
      kind: "formula",
      params: {
        leftColumn: { id: "r:c:0", name: "value" },
        operator: "multiply",
        rightColumn: { id: "r:c:1", name: "count" },
        newColumn: "value_times_count"
      }
    };
    const columnOutput = formulaContract(source, columnStep, "integer", "integer", true);
    const columnCode =
      "open_wrangler_result <- open_wrangler_formula_column_at(orders, 1L, 'value', 'multiply', 'value_times_count', 2L, 'count')";
    transport.queuePreview({
      sessionId,
      revision: 3,
      page: columnOutput,
      diff: cloneDiff("value_times_count"),
      code: columnCode
    });
    const columnPreview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 2,
      step: columnStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });

    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      2,
      {
        id: "r-formula-columns",
        kind: "formula",
        params: {
          leftColumn: { id: "r:c:0", name: "value" },
          operator: "multiply",
          rightColumn: { id: "r:c:1", name: "count" },
          newColumn: "value_times_count"
        }
      },
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(columnPreview).toMatchObject({
      kind: "stepPreview",
      code: columnCode,
      metadata: {
        schema: expect.arrayContaining([
          expect.objectContaining({
            id: "c:step:r-formula-columns:0",
            name: "value_times_count",
            rawType: "integer",
            type: "integer",
            nullable: true
          })
        ])
      },
      diff: cloneDiff("value_times_count")
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 4,
      page: columnOutput,
      code: columnCode
    });
    await expect(bridge.request(planRequest("applyDraft", 3))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 4,
      code: columnCode,
      metadata: {
        steps: [
          {
            id: "r-formula-columns",
            kind: "formula",
            params: {
              rightColumn: { id: "r:c:1", name: "count" },
              newColumn: "value_times_count"
            }
          }
        ],
        latestStepInputSchema: expect.arrayContaining([
          expect.objectContaining({ id: "r:c:0", name: "value", rawType: "integer" })
        ])
      }
    });
  });

  it("rejects stale, nonnumeric, colliding, and non-finite native R Formula requests before dispatch", async () => {
    const source = frameContract();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const leftColumn = { id: "r:c:0", name: "value" } as const;
    const invalidSteps = [
      {
        id: "r-formula-stale-left",
        kind: "formula",
        params: { leftColumn: { id: "r:c:0", name: "stale" }, operator: "add", value: 1, newColumn: "sum" }
      },
      {
        id: "r-formula-stale-right",
        kind: "formula",
        params: {
          leftColumn,
          operator: "subtract",
          rightColumn: { id: "r:c:7", name: "stale" },
          newColumn: "difference"
        }
      },
      {
        id: "r-formula-date",
        kind: "formula",
        params: {
          leftColumn: { id: "r:c:2", name: "date" },
          operator: "add",
          value: 1,
          newColumn: "tomorrow"
        }
      },
      {
        id: "r-formula-collision",
        kind: "formula",
        params: { leftColumn, operator: "multiply", value: 2, newColumn: "count" }
      },
      {
        id: "r-formula-infinite",
        kind: "formula",
        params: { leftColumn, operator: "divide", value: Number.POSITIVE_INFINITY, newColumn: "ratio" }
      },
      {
        id: "r-formula-nan",
        kind: "formula",
        params: { leftColumn, operator: "power", value: Number.NaN, newColumn: "power" }
      },
      {
        id: "r-formula-both-operands",
        kind: "formula",
        params: {
          leftColumn,
          operator: "add",
          rightColumn: { id: "r:c:7", name: "infinite" },
          value: 1,
          newColumn: "ambiguous"
        }
      },
      {
        id: "r-formula-no-operand",
        kind: "formula",
        params: { leftColumn, operator: "add", newColumn: "missing_operand" }
      },
      {
        id: "r-formula-private-output",
        kind: "formula",
        params: {
          leftColumn,
          operator: "add",
          value: 1,
          newColumn: "__OPEN_WRANGLER_INTERNAL_ROW_ID_formula"
        }
      }
    ] satisfies FormulaTransformStep[];

    for (const step of invalidSteps) {
      let response;
      try {
        response = await bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        });
      } catch (error) {
        throw new Error(`Formula case ${step.id} unexpectedly reached transport.`, { cause: error });
      }
      expect(response, step.id).toMatchObject({ kind: "error", code: "invalid_request" });
    }
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("requires exact integer64 and widening schemas for native R Formula", async () => {
    const integer64Value = rCell("integer", "9007199254740993", "9007199254740993");
    const source = castContract(
      castContract(frameContract(), "r:c:0", "integer64", "integer", integer64Value, false),
      "r:c:1",
      "integer64",
      "integer",
      rCell("integer", "2", "2"),
      false
    );
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const exactStep: FormulaTransformStep = {
      id: "r-formula-integer64-exact",
      kind: "formula",
      params: {
        leftColumn: { id: "r:c:0", name: "value" },
        operator: "add",
        rightColumn: { id: "r:c:1", name: "count" },
        newColumn: "exact_sum"
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: formulaContract(source, exactStep, "integer64", "integer", false),
      diff: cloneDiff("exact_sum"),
      code: "open_wrangler_result <- exact_sum"
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: exactStep,
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
            id: "c:step:r-formula-integer64-exact:0",
            rawType: "integer64",
            type: "integer"
          })
        ])
      }
    });

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 2,
      page: source,
      code: ""
    });
    await bridge.request(planRequest("discardDraft", 1));

    let revision = 2;
    for (const [id, operator, value] of [
      ["r-formula-integer64-divide", "divide", 2],
      ["r-formula-integer64-double", "add", 0.5],
      ["r-formula-integer64-power", "power", 2]
    ] as const) {
      const step: FormulaTransformStep = {
        id,
        kind: "formula",
        params: {
          leftColumn: { id: "r:c:0", name: "value" },
          operator,
          value,
          newColumn: `${operator}_result`
        }
      };
      transport.queuePreview({
        sessionId,
        revision: revision + 1,
        page: formulaContract(source, step, "double", "float", false),
        diff: cloneDiff(`${operator}_result`),
        code: `open_wrangler_result <- ${operator}_result`
      });
      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision,
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
            expect.objectContaining({ id: `c:step:${id}:0`, rawType: "double", type: "float" })
          ])
        }
      });
      transport.discardDraft.mockResolvedValueOnce({
        sessionId,
        action: "discard",
        revision: revision + 2,
        page: source,
        code: ""
      });
      await bridge.request(planRequest("discardDraft", revision + 1));
      revision += 2;
    }
  });

  it("formats native R Date and POSIXct columns in place or under a stable appended identity", async () => {
    const source = frameContract();
    const formattedDate: RFrameCell = {
      kind: "string",
      raw: "05 Aug 2026",
      display: "05 Aug 2026",
      isNull: false,
      isNaN: false
    };
    const inPlace = castContract(source, "r:c:2", "character", "string", formattedDate, true);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const inPlaceStep: FormatDatetimeTransformStep = {
      id: "r-format-date-in-place",
      kind: "formatDatetime",
      params: { column: { id: "r:c:2", name: "date" }, format: "%d %b %Y" }
    };
    const inPlaceCode =
      "open_wrangler_result <- open_wrangler_format_datetime_column_at(orders, 3L, 'date', '%d %b %Y')";
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: inPlace,
      diff: castDiff("r:c:2", "date", source.page.rows[0]?.values[2] as RFrameCell, formattedDate),
      code: inPlaceCode
    });

    const inPlacePreview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: inPlaceStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      {
        id: "r-format-date-in-place",
        kind: "formatDatetime",
        params: { column: { id: "r:c:2", name: "date" }, format: "%d %b %Y" }
      },
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(inPlacePreview).toMatchObject({
      kind: "stepPreview",
      code: inPlaceCode,
      metadata: {
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "r:c:2", name: "date", rawType: "character", type: "string" })
        ])
      },
      diff: {
        addedColumns: [],
        changedCells: 1,
        cells: [
          expect.objectContaining({
            columnId: "r:c:2",
            column: "date",
            after: expect.objectContaining({ raw: "05 Aug 2026" })
          })
        ]
      }
    });

    const keyedSource = dataTableContract(source, ["r:c:3"]);
    const keyedTransport = fakeTransport(keyedSource);
    const keyedBridge = createBridge(keyedTransport);
    await keyedBridge.request(openRequest("editing"));
    const appendedStep: FormatDatetimeTransformStep = {
      id: "r-format-datetime-appended",
      kind: "formatDatetime",
      params: {
        column: { id: "r:c:3", name: "when" },
        format: "%Y-%m-%d %H:%M",
        newColumn: "when_label"
      }
    };
    const appended = formattedDatetimeContract(keyedSource, appendedStep);
    keyedTransport.queuePreview({
      sessionId,
      revision: 1,
      page: appended,
      diff: cloneDiff("when_label"),
      code: "open_wrangler_result <- open_wrangler_format_datetime_column_at(orders, 4L, 'when', '%Y-%m-%d %H:%M', 'when_label')"
    });
    await expect(
      keyedBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: appendedStep,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([
          {
            id: "c:step:r-format-datetime-appended:0",
            name: "when_label",
            position: 8,
            rawType: "character",
            type: "string",
            nullable: true
          }
        ])
      },
      diff: { addedColumns: ["when_label"], changedCells: 0, cells: [] }
    });
    expect(keyedTransport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      appendedStep,
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
  });

  it("rejects unsafe native R Format Datetime inputs and malformed diffs", async () => {
    const source = dataTableContract(frameContract(), ["r:c:2"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const invalidSteps = [
      {
        id: "r-format-stale",
        kind: "formatDatetime",
        params: { column: { id: "r:c:2", name: "stale" }, format: "%Y" }
      },
      {
        id: "r-format-number",
        kind: "formatDatetime",
        params: { column: { id: "r:c:0", name: "value" }, format: "%Y" }
      },
      {
        id: "r-format-empty",
        kind: "formatDatetime",
        params: { column: { id: "r:c:3", name: "when" }, format: "" }
      },
      {
        id: "r-format-oversized",
        kind: "formatDatetime",
        params: {
          column: { id: "r:c:3", name: "when" },
          format: "x".repeat(R_FRAME_CONTRACT_LIMITS.textBytes + 1)
        }
      },
      {
        id: "r-format-collision",
        kind: "formatDatetime",
        params: { column: { id: "r:c:3", name: "when" }, format: "%Y", newColumn: "count" }
      },
      {
        id: "r-format-private",
        kind: "formatDatetime",
        params: {
          column: { id: "r:c:3", name: "when" },
          format: "%Y",
          newColumn: "__OPEN_WRANGLER_INTERNAL_ROW_ID_date"
        }
      },
      {
        id: "r-format-key-in-place",
        kind: "formatDatetime",
        params: { column: { id: "r:c:2", name: "date" }, format: "%Y-%m-%d" }
      }
    ] satisfies FormatDatetimeTransformStep[];

    for (const step of invalidSteps) {
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
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    }
    expect(transport.previewStep).not.toHaveBeenCalled();

    const diffSource = frameContract();
    const diffTransport = fakeTransport(diffSource);
    const diffBridge = createBridge(diffTransport);
    await diffBridge.request(openRequest("editing"));
    const step: FormatDatetimeTransformStep = {
      id: "r-format-bad-diff",
      kind: "formatDatetime",
      params: { column: { id: "r:c:3", name: "when" }, format: "%Y", newColumn: "year" }
    };
    diffTransport.queuePreview({
      sessionId,
      revision: 1,
      page: formattedDatetimeContract(diffSource, step),
      diff: cloneDiff("wrong_name"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      diffBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("mutation diff");
  });

  it("publishes arbitrary custom R schemas with name-pooled lineage and exact code persistence", async () => {
    const source = frameContract();
    const step: CustomCodeTransformStep = {
      id: "r-custom",
      kind: "customCode",
      params: {
        code: "result <- data.frame(value = as.character(df$missing), value = df$missing, fresh = df$flag, check.names = FALSE)\n"
      }
    };
    const transformed = customCodeContract(
      source,
      step.id,
      [
        { name: "value", sourcePosition: 6 },
        { name: "value", sourcePosition: 6 },
        { name: "fresh", sourcePosition: 5 }
      ],
      { rows: 2, rowNames: "explicit" }
    );
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: transformed,
      diff: customCodeDiff(source, transformed),
      code: "open_wrangler_result <- local({ ... })\n",
      effectiveView: { filters: [], sorts: [] }
    });

    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      step,
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      source.schema,
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      metadata: {
        shape: { rows: 2, columns: 3 },
        schema: [
          expect.objectContaining({ id: "r:c:0", name: "value", position: 0, type: "string" }),
          expect.objectContaining({ id: "c:step:r-custom:0", name: "value", position: 1, type: "string" }),
          expect.objectContaining({ id: "c:step:r-custom:1", name: "fresh", position: 2, type: "boolean" })
        ],
        draftStep: step
      },
      diff: {
        addedRows: 2,
        removedRows: 1,
        addedColumns: ["value", "fresh"],
        removedColumns: ["count", "date", "when", "elapsed", "flag", "missing", "infinite"]
      }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: transformed,
      code: "open_wrangler_result <- local({ ... })\n"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: { steps: [step] }
    });

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 3,
      page: source,
      code: "open_wrangler_result <- orders\n"
    });
    await expect(bridge.request(planRequest("undoStep", 2))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "undo",
      metadata: { shape: { rows: 1, columns: 8 }, steps: [] }
    });
  });

  it("edits latest custom R code against its original input while preserving surviving output views", async () => {
    const source = frameContract();
    const stepId = "r-custom-edit";
    const firstStep: CustomCodeTransformStep = {
      id: stepId,
      kind: "customCode",
      params: { code: "result <- data.frame(value = df$value, fresh = df$count)\n" }
    };
    const first = customCodeContract(source, stepId, [
      { name: "value", sourcePosition: 0 },
      { name: "fresh", sourcePosition: 1 }
    ]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: first,
      diff: customCodeDiff(source, first),
      code: "first\n",
      effectiveView: { filters: [], sorts: [] }
    });
    await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: firstStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: first,
      code: "first\n"
    });
    await bridge.request(planRequest("applyDraft", 1));

    const filterModel = {
      filters: [
        {
          column: "fresh",
          type: "integer" as const,
          predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 0 }]
        }
      ],
      sort: [{ column: "fresh", direction: "desc" as const, nulls: "last" as const }]
    };
    transport.getPage.mockResolvedValueOnce(first);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 2,
      viewRequestId: "custom-edit-view",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel
    });

    const replacementStep: CustomCodeTransformStep = {
      id: stepId,
      kind: "customCode",
      params: { code: "result <- data.frame(count = df$count, fresh = df$count, novel = df$flag)\n" }
    };
    const replacement = customCodeContract(source, stepId, [
      { name: "count", sourcePosition: 1 },
      { name: "fresh", sourcePosition: 1 },
      { name: "novel", sourcePosition: 5 }
    ]);
    const effectiveView = {
      filters: [
        {
          column: { id: `c:step:${stepId}:0`, name: "fresh" },
          type: "integer" as const,
          predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 0 }]
        }
      ],
      sorts: [
        {
          column: { id: `c:step:${stepId}:0`, name: "fresh" },
          direction: "desc" as const,
          nulls: "last" as const
        }
      ]
    };
    transport.queuePreview({
      sessionId,
      revision: 3,
      page: replacement,
      diff: { ...customCodeDiff(source, replacement), truncated: true },
      code: "replacement\n",
      effectiveView
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 2,
      replaceStepId: stepId,
      step: replacementStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });

    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      2,
      replacementStep,
      expect.objectContaining({ view: effectiveView }),
      source.schema,
      stepId,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      diff: { truncated: true },
      metadata: {
        filterModel,
        draftStep: replacementStep,
        draftReplacesStepId: stepId,
        latestStepInputSchema: source.schema.map(({ semantics: _semantics, ...column }) => column)
      }
    });
  });

  it("accepts the exact effective view after custom R code prunes missing viewed columns", async () => {
    const source = frameContract();
    const step: CustomCodeTransformStep = {
      id: "r-custom-pruned-view",
      kind: "customCode",
      params: { code: "result <- data.frame(count = df$count)\n" }
    };
    const output = customCodeContract(source, step.id, [{ name: "count", sourcePosition: 1 }]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.getPage.mockResolvedValueOnce(source);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "custom-pruned-source-view",
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
        sort: [{ column: "value", direction: "asc", nulls: "last" }]
      }
    });
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: output,
      diff: customCodeDiff(source, output),
      code: "generated\n",
      effectiveView: { filters: [], sorts: [] }
    });

    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      step,
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })],
          sorts: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })]
        }
      }),
      source.schema,
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      metadata: { filterModel: { filters: [], sort: [] } }
    });
  });

  it("rejects unsafe custom R source before dispatch", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    for (const code of ["result <- df\u0000", "# comment only\r # still a comment", "x".repeat(64 * 1_024 + 1)]) {
      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step: { id: "r-custom-invalid", kind: "customCode", params: { code } },
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    }
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("fails closed on mismatched custom R lineage, flavor, diff, and effective views", async () => {
    const source = frameContract();
    const step: CustomCodeTransformStep = {
      id: "r-custom-invalid-response",
      kind: "customCode",
      params: { code: "result <- data.frame(value = df$value, fresh = df$count)\n" }
    };
    const valid = customCodeContract(source, step.id, [
      { name: "value", sourcePosition: 0 },
      { name: "fresh", sourcePosition: 1 }
    ]);
    const request = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    };
    const cases: readonly Readonly<{
      label: string;
      page: RFramePageContract;
      diff: DataDiff;
      effectiveView?: RKernelStepPreviewResult["effectiveView"];
    }>[] = [
      {
        label: "empty schema",
        page: {
          ...valid,
          shape: { ...valid.shape, columns: 0 },
          schema: [],
          page: {
            ...valid.page,
            columnIds: [],
            rows: valid.page.rows.map((row) => ({ ...row, values: [] }))
          }
        },
        diff: customCodeDiff(source, valid),
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "private name",
        page: {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === 1 ? { ...column, name: "__OPEN_WRANGLER_INTERNAL_ROW_ID_hidden" } : { ...column }
          )
        },
        diff: customCodeDiff(source, valid),
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "lineage",
        page: {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === 1 ? { ...column, id: `c:step:${step.id}:1` } : { ...column }
          ),
          page: {
            ...valid.page,
            columnIds: valid.page.columnIds.map((id, index) => (index === 1 ? `c:step:${step.id}:1` : id))
          }
        },
        diff: customCodeDiff(source, valid),
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "flavor",
        page: {
          ...valid,
          dataframeFlavor: "r.tibble",
          frameSemantics: { ...valid.frameSemantics, classes: ["tbl_df", "tbl", "data.frame"] }
        },
        diff: customCodeDiff(source, valid),
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "diff",
        page: valid,
        diff: { ...customCodeDiff(source, valid), addedRows: 0 },
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "effective view",
        page: valid,
        diff: customCodeDiff(source, valid),
        effectiveView: {
          filters: [],
          sorts: [{ column: { id: "r:c:0", name: "value" }, direction: "asc", nulls: "last" }]
        }
      },
      { label: "missing effective view", page: valid, diff: customCodeDiff(source, valid) }
    ];

    for (const candidate of cases) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: candidate.page,
        diff: candidate.diff,
        code: "generated\n",
        ...(candidate.effectiveView === undefined ? {} : { effectiveView: candidate.effectiveView })
      });
      await expect(bridge.request(request), candidate.label).rejects.toThrow();
      expect(transport.previewStep, candidate.label).toHaveBeenCalledOnce();
    }
  });

  it("requires custom R rows to use the fresh identity suffix while allowing valid sorted order", async () => {
    const source = frameContract();
    const step: CustomCodeTransformStep = {
      id: "r-custom-row-identities",
      kind: "customCode",
      params: { code: "result <- df[c(1L, 1L, 1L), , drop = FALSE]\n" }
    };
    const valid = customCodeContract(source, step.id, [{ name: "value", sourcePosition: 0 }], { rows: 3 });
    const request = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    };
    for (const [label, rowIds] of [
      ["stale", ["r:r:0", "r:r:2", "r:r:3"]],
      ["out-of-suffix", ["r:r:1", "r:r:2", "r:r:4"]],
      ["duplicate", ["r:r:1", "r:r:1", "r:r:3"]],
      ["unordered full page", ["r:r:2", "r:r:1", "r:r:3"]]
    ] as const) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      const malformed = contractWithRowIds(valid, rowIds);
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: malformed,
        diff: customCodeDiff(source, malformed),
        code: "generated\n",
        effectiveView: { filters: [], sorts: [] }
      });
      await expect(bridge.request(request), label).rejects.toThrow(/row identit|physical output order/u);
    }

    const partialRequest = { ...request, offset: 1, limit: 1 };
    for (const [label, rowId, accepts] of [
      ["misbound partial page", "r:r:3", false],
      ["exact partial page", "r:r:2", true]
    ] as const) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      const partial = {
        ...valid,
        page: {
          ...valid.page,
          offset: 1,
          limit: 1,
          rows: [{ ...(valid.page.rows[1] as RFramePageContract["page"]["rows"][number]), id: rowId }]
        }
      };
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: partial,
        diff: customCodeDiff(source, partial),
        code: "generated\n",
        effectiveView: { filters: [], sorts: [] }
      });
      const result = bridge.request(partialRequest);
      if (accepts) await expect(result, label).resolves.toMatchObject({ kind: "stepPreview" });
      else await expect(result, label).rejects.toThrow("physical output order");
    }

    const filteredTransport = fakeTransport(source);
    const filteredBridge = createBridge(filteredTransport);
    await filteredBridge.request(openRequest("editing"));
    filteredTransport.getPage.mockResolvedValueOnce(source);
    await filteredBridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "custom-filtered-row-identities",
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
        sort: []
      }
    });
    const filtered = {
      ...valid,
      page: {
        ...valid.page,
        totalRows: 2,
        rows: [
          { ...(valid.page.rows[2] as RFramePageContract["page"]["rows"][number]), rowNumber: 0 },
          { ...(valid.page.rows[0] as RFramePageContract["page"]["rows"][number]), rowNumber: 1 }
        ]
      }
    };
    const filteredEffectiveView = {
      filters: [
        {
          column: { id: "r:c:0", name: "value" },
          type: "float" as const,
          predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 0 }]
        }
      ],
      sorts: []
    };
    filteredTransport.queuePreview({
      sessionId,
      revision: 1,
      page: filtered,
      diff: { ...customCodeDiff(source, valid), truncated: true },
      code: "generated\n",
      effectiveView: filteredEffectiveView
    });
    await expect(filteredBridge.request(request)).rejects.toThrow("physical output order");

    const sortedTransport = fakeTransport(source);
    const sortedBridge = createBridge(sortedTransport);
    await sortedBridge.request(openRequest("editing"));
    sortedTransport.getPage.mockResolvedValueOnce(source);
    await sortedBridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "custom-sorted-row-identities",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [],
        sort: [{ column: "value", direction: "desc", nulls: "last" }]
      }
    });
    const sorted = contractWithRowIds(valid, ["r:r:3", "r:r:2", "r:r:1"]);
    const effectiveView = {
      filters: [],
      sorts: [{ column: { id: "r:c:0", name: "value" }, direction: "desc" as const, nulls: "last" as const }]
    };
    sortedTransport.queuePreview({
      sessionId,
      revision: 1,
      page: sorted,
      diff: customCodeDiff(source, sorted),
      code: "generated\n",
      effectiveView
    });
    await expect(sortedBridge.request(request)).resolves.toMatchObject({
      kind: "stepPreview",
      page: { rows: [{ id: "r:r:3" }, { id: "r:r:2" }, { id: "r:r:1" }] }
    });
  });

  it("retains exact custom row identities across later pages and partial applied-step inspection", async () => {
    const source = frameContract();
    const step: CustomCodeTransformStep = {
      id: "r-custom-retained-identities",
      kind: "customCode",
      params: { code: "result <- df[c(1L, 1L, 1L), , drop = FALSE]\n" }
    };
    const output = customCodeContract(source, step.id, [{ name: "value", sourcePosition: 0 }], { rows: 3 });
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: output,
      diff: customCodeDiff(source, output),
      code: "generated\n",
      effectiveView: { filters: [], sorts: [] }
    });
    await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: output,
      code: "generated\n"
    });
    await bridge.request(planRequest("applyDraft", 1));

    transport.getPage.mockResolvedValueOnce(contractWithRowIds(output, ["r:r:0", "r:r:2", "r:r:3"]));
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId,
        revision: 2,
        viewRequestId: "custom-stale-page",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: { filters: [], sort: [] }
      })
    ).rejects.toThrow("out-of-suffix row identity");

    const inputPartial = {
      ...source,
      page: { ...source.page, offset: 1, limit: 1, rows: [] }
    };
    const outputPartial = {
      ...output,
      page: {
        ...output.page,
        offset: 1,
        limit: 1,
        rows: [{ ...(output.page.rows[1] as RFramePageContract["page"]["rows"][number]), id: "r:r:3" }]
      }
    };
    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: step.id,
      stepIndex: 0,
      inputPage: inputPartial,
      outputPage: outputPartial,
      inputSchema: source.schema,
      outputSchema: output.schema,
      code: "generated\n"
    });
    const inspectionRequest = {
      kind: "inspectStep" as const,
      sessionId,
      revision: 2,
      stepId: step.id,
      offset: 1,
      limit: 1,
      columnOffset: 0,
      columnLimit: 8
    };
    await expect(bridge.request(inspectionRequest)).rejects.toThrow("physical output order");

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: step.id,
      stepIndex: 0,
      inputPage: inputPartial,
      outputPage: contractWithRowIds(outputPartial, ["r:r:2"]),
      inputSchema: source.schema,
      outputSchema: output.schema,
      code: "generated\n"
    });
    await expect(bridge.request(inspectionRequest)).resolves.toMatchObject({
      kind: "stepInspection",
      outputPage: { rows: [{ id: "r:r:2", rowNumber: 1 }] }
    });
  });

  it.each(["discard", "undo"] as const)(
    "rejects stale source row identities when %s returns to a custom-derived committed frame",
    async (action) => {
      const source = frameContract();
      const customStep: CustomCodeTransformStep = {
        id: `r-custom-${action}-identity`,
        kind: "customCode",
        params: { code: "result <- data.frame(value = df$value)\n" }
      };
      const customOutput = customCodeContract(source, customStep.id, [{ name: "value", sourcePosition: 0 }]);
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: customOutput,
        diff: customCodeDiff(source, customOutput),
        code: "custom\n",
        effectiveView: { filters: [], sorts: [] }
      });
      await bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: customStep,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });
      transport.applyDraft.mockResolvedValueOnce({
        sessionId,
        action: "apply",
        revision: 2,
        page: customOutput,
        code: "custom\n"
      });
      await bridge.request(planRequest("applyDraft", 1));

      const renameStep = {
        id: `r-custom-${action}-rename`,
        kind: "renameColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "renamed" }
      } as const;
      const renamed = renameContract(customOutput, "r:c:0", "renamed");
      transport.queuePreview({
        sessionId,
        revision: 3,
        page: renamed,
        diff: renameDiff(),
        code: "renamed\n"
      });
      await bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 2,
        step: renameStep,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });
      const staleCustomOutput = contractWithRowIds(customOutput, ["r:r:0"]);
      if (action === "discard") {
        transport.discardDraft.mockResolvedValueOnce({
          sessionId,
          action: "discard",
          revision: 4,
          page: staleCustomOutput,
          code: "custom\n"
        });
        await expect(bridge.request(planRequest("discardDraft", 3))).rejects.toThrow("out-of-suffix row identity");
      } else {
        transport.applyDraft.mockResolvedValueOnce({
          sessionId,
          action: "apply",
          revision: 4,
          page: renamed,
          code: "renamed\n"
        });
        await bridge.request(planRequest("applyDraft", 3));
        transport.undoStep.mockResolvedValueOnce({
          sessionId,
          action: "undo",
          revision: 5,
          page: staleCustomOutput,
          code: "custom\n"
        });
        await expect(bridge.request(planRequest("undoStep", 4))).rejects.toThrow("out-of-suffix row identity");
      }
    }
  );

  it("requires a truncated custom diff when a surviving filter excludes input before including output", async () => {
    const source = replaceContractCell(frameContract(), "r:c:0", rCell("number", "-1", "-1"));
    const step: CustomCodeTransformStep = {
      id: "r-custom-filtered-replacement",
      kind: "customCode",
      params: { code: "result <- transform(df, value = abs(value))\n" }
    };
    const output = replaceContractCell(
      customCodeContract(source, step.id, [{ name: "value", sourcePosition: 0 }]),
      "r:c:0",
      rCell("number", "1", "1")
    );
    const filteredSource = {
      ...source,
      page: { ...source.page, totalRows: 0, rows: [] }
    };
    const filterModel = {
      filters: [
        {
          column: "value",
          type: "float" as const,
          predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 0 }]
        }
      ],
      sort: []
    };
    const effectiveView = {
      filters: [
        {
          column: { id: "r:c:0", name: "value" },
          type: "float" as const,
          predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 0 }]
        }
      ],
      sorts: []
    };
    const request = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    };

    for (const truncated of [false, true]) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.getPage.mockResolvedValueOnce(filteredSource);
      await bridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: `custom-filtered-replacement-${String(truncated)}`,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel
      });
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: output,
        diff: { ...customCodeDiff(source, output), truncated },
        code: "generated\n",
        effectiveView
      });
      const result = bridge.request(request);
      if (truncated) await expect(result).resolves.toMatchObject({ kind: "stepPreview", diff: { truncated: true } });
      else await expect(result).rejects.toThrow("invalid custom-code diff");
    }
  });

  it("retains a valid runtime-derived data.table key across custom preview and apply", async () => {
    const source = dataTableContract(frameContract(), ["r:c:0"]);
    const step: CustomCodeTransformStep = {
      id: "r-custom-key",
      kind: "customCode",
      params: { code: "result <- data.table::copy(df)\n" }
    };
    const output = customCodeContract(
      source,
      step.id,
      [
        { name: "value", sourcePosition: 0 },
        { name: "count", sourcePosition: 1 }
      ],
      { keyColumnIds: ["r:c:0"] }
    );
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: output,
      diff: customCodeDiff(source, output),
      code: "generated\n",
      effectiveView: { filters: [], sorts: [] }
    });
    await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: output,
      code: "generated\n"
    });
    await bridge.request(planRequest("applyDraft", 1));
    transport.getPage.mockResolvedValueOnce(output);
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId,
        revision: 2,
        viewRequestId: "custom-key-view",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: { filters: [], sort: [] }
      })
    ).resolves.toMatchObject({ kind: "page", revision: 2 });
  });

  it("publishes dynamic native R one-hot schemas with duplicate removed labels atomically", async () => {
    const source = frameContract({ duplicateFirstName: true });
    const step: OneHotEncodeTransformStep = {
      id: "r-one-hot-dynamic",
      kind: "oneHotEncode",
      params: {
        columns: [
          { id: "r:c:0", name: "value" },
          { id: "r:c:1", name: "value" }
        ],
        prefixSeparator: "_",
        dropOriginal: true
      }
    };
    const encoded = categoricalContract(source, step.id, ["r:c:0", "r:c:1"], true, ["value_false", "value_true"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: encoded,
      diff: categoricalDiff(["value_false", "value_true"], ["value", "value"]),
      code: "open_wrangler_result <- open_wrangler_one_hot_encode_columns(orders)"
    });

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
      revision: 1,
      metadata: { shape: { rows: 1, columns: 8 } },
      diff: { addedColumns: ["value_false", "value_true"], removedColumns: ["value", "value"] }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      {
        id: step.id,
        kind: "oneHotEncode",
        params: {
          columns: [
            { id: "r:c:0", name: "value" },
            { id: "r:c:1", name: "value" }
          ],
          prefixSeparator: "_",
          dropOriginal: true
        }
      },
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      source.schema,
      undefined,
      expect.any(Object)
    );

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: encoded,
      code: "open_wrangler_result <- open_wrangler_one_hot_encode_columns(orders)"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2,
      metadata: { steps: [step] }
    });
    transport.undoStep.mockResolvedValueOnce({ sessionId, action: "undo", revision: 3, page: source, code: "" });
    await expect(bridge.request(planRequest("undoStep", 2))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "undo",
      revision: 3,
      metadata: { steps: [] }
    });
  });

  it("rejects a retained-only native R categorical schema before publishing a draft", async () => {
    const source = frameContract();
    const step: MultiLabelBinarizeTransformStep = {
      id: "r-multi-label-requires-output",
      kind: "multiLabelBinarize",
      params: {
        column: { id: "r:c:6", name: "missing" },
        delimiter: ",",
        prefix: "tag_",
        dropOriginal: false
      }
    };
    const request = {
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    } as const;

    const encoded = categoricalContract(source, step.id, [step.params.column.id], false, ["tag_alpha"]);
    const validTransport = fakeTransport(source);
    const validBridge = createBridge(validTransport);
    await validBridge.request(openRequest("editing"));
    validTransport.queuePreview({
      sessionId,
      revision: 1,
      page: encoded,
      diff: categoricalDiff(["tag_alpha"], []),
      code: "open_wrangler_result <- open_wrangler_multi_label_binarize_column(orders)"
    });
    await expect(validBridge.request(request)).resolves.toMatchObject({
      kind: "stepPreview",
      revision: 1,
      metadata: {
        shape: { rows: 1, columns: source.schema.length + 1 },
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "r:c:0", position: 0 }),
          expect.objectContaining({ id: `c:step:${step.id}:0`, name: "tag_alpha", position: source.schema.length })
        ])
      },
      diff: { addedColumns: ["tag_alpha"], removedColumns: [] }
    });

    const maliciousTransport = fakeTransport(source);
    const maliciousBridge = createBridge(maliciousTransport);
    await maliciousBridge.request(openRequest("editing"));
    maliciousTransport.queuePreview({
      sessionId,
      revision: 1,
      page: source,
      diff: categoricalDiff([], []),
      code: "open_wrangler_result <- orders"
    });
    await expect(maliciousBridge.request(request)).rejects.toThrow("without a generated output");
    await expect(maliciousBridge.request(planRequest("applyDraft", 0))).resolves.toMatchObject({
      kind: "error",
      code: "r_kernel_changed"
    });
    expect(maliciousTransport.applyDraft).not.toHaveBeenCalled();
  });

  it("does not resurrect a generated categorical view while editing the latest step", async () => {
    const source = frameContract();
    const step: OneHotEncodeTransformStep = {
      id: "r-one-hot-edit-view",
      kind: "oneHotEncode",
      params: {
        columns: [{ id: "r:c:0", name: "value" }],
        prefixSeparator: "_",
        dropOriginal: false
      }
    };
    const encoded = categoricalContract(source, step.id, ["r:c:0"], false, ["value_false", "value_true"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: encoded,
      diff: categoricalDiff(["value_false", "value_true"], []),
      code: "open_wrangler_result <- open_wrangler_one_hot_encode_columns(orders)"
    });
    await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: encoded,
      code: "open_wrangler_result <- open_wrangler_one_hot_encode_columns(orders)"
    });
    await bridge.request(planRequest("applyDraft", 1));

    transport.getPage.mockResolvedValueOnce(encoded);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 2,
      viewRequestId: "categorical-generated-view",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [
          {
            column: "value_false",
            type: "integer",
            predicates: [{ kind: "predicate", operator: "gte", value: 1 }]
          }
        ],
        sort: [{ column: "value_false", direction: "desc", nulls: "last" }]
      }
    });

    transport.queuePreview({
      sessionId,
      revision: 3,
      page: encoded,
      diff: categoricalDiff(["value_false", "value_true"], []),
      code: "open_wrangler_result <- open_wrangler_one_hot_encode_columns(orders)"
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 2,
        replaceStepId: step.id,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      revision: 3,
      metadata: { filterModel: { filters: [], sort: [] } }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      2,
      expect.objectContaining({ id: step.id }),
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      source.schema,
      step.id,
      expect.any(Object)
    );

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 4,
      page: encoded,
      code: "open_wrangler_result <- open_wrangler_one_hot_encode_columns(orders)"
    });
    await expect(bridge.request(planRequest("discardDraft", 3))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "discard",
      revision: 4,
      metadata: {
        filterModel: {
          filters: [expect.objectContaining({ column: "value_false" })],
          sort: [expect.objectContaining({ column: "value_false" })]
        }
      }
    });
    expect(transport.discardDraft).toHaveBeenCalledWith(
      sessionId,
      3,
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: `c:step:${step.id}:0`, name: "value_false" } })],
          sorts: [expect.objectContaining({ column: { id: `c:step:${step.id}:0`, name: "value_false" } })]
        }
      }),
      expect.any(Object)
    );
  });

  it("reconciles dropped native R multi-label filters and restores them on discard", async () => {
    const source = frameContract();
    const step: MultiLabelBinarizeTransformStep = {
      id: "r-multi-label-dynamic",
      kind: "multiLabelBinarize",
      params: {
        column: { id: "r:c:6", name: "missing" },
        delimiter: "::",
        prefix: "tag_",
        dropOriginal: true
      }
    };
    const encoded = categoricalContract(source, step.id, ["r:c:6"], true, ["tag_alpha", "tag_beta"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.getPage.mockResolvedValueOnce(source);
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: "multi-label-filter",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: {
          filters: [
            {
              column: "missing",
              type: "string",
              predicates: [{ kind: "predicate", operator: "contains", value: "alpha" }]
            }
          ],
          sort: []
        }
      })
    ).resolves.toMatchObject({ kind: "page" });
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: encoded,
      diff: categoricalDiff(["tag_alpha", "tag_beta"], ["missing"]),
      code: "open_wrangler_result <- open_wrangler_multi_label_binarize_column(orders)"
    });

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
      metadata: { filterModel: { filters: [], sort: [] }, shape: { rows: 1, columns: 9 } },
      diff: { addedColumns: ["tag_alpha", "tag_beta"], removedColumns: ["missing"] }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      expect.objectContaining({ kind: "multiLabelBinarize" }),
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      source.schema,
      undefined,
      expect.any(Object)
    );

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 2,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("discardDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "discard",
      metadata: {
        filterModel: {
          filters: [expect.objectContaining({ column: "missing" })],
          sort: []
        }
      }
    });
  });

  it("rejects malformed dynamic native R categorical schemas before publication", async () => {
    const source = frameContract();
    const step: MultiLabelBinarizeTransformStep = {
      id: "r-multi-label-invalid-schema",
      kind: "multiLabelBinarize",
      params: {
        column: { id: "r:c:6", name: "missing" },
        delimiter: ",",
        prefix: "tag_",
        dropOriginal: false
      }
    };
    const valid = categoricalContract(source, step.id, ["r:c:6"], false, ["tag_alpha", "tag_beta"]);
    const invalidContracts: ReadonlyArray<readonly [string, RFramePageContract]> = [
      [
        "generated identity",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length ? { ...column, id: "c:step:wrong:0" } : { ...column }
          )
        }
      ],
      [
        "generated nullability",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length ? { ...column, nullable: true } : { ...column }
          )
        }
      ],
      [
        "generated type",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length
              ? {
                  ...column,
                  rawType: "character",
                  type: "string",
                  semantics: { kind: "character", storageMode: "character", classes: ["character"] }
                }
              : { ...column }
          ) as RColumnSchema[]
        }
      ],
      [
        "generated prefix",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length ? { ...column, name: "wrong_alpha" } : { ...column }
          )
        }
      ],
      [
        "generated order",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length
              ? { ...column, name: "tag_beta" }
              : index === source.schema.length + 1
                ? { ...column, name: "tag_alpha" }
                : { ...column }
          )
        }
      ],
      [
        "retained column",
        {
          ...valid,
          schema: valid.schema.map((column, index) => (index === 0 ? { ...column, name: "changed" } : { ...column }))
        }
      ]
    ];

    for (const [label, page] of invalidContracts) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page,
        diff: categoricalDiff(["tag_alpha", "tag_beta"], []),
        code: "open_wrangler_result <- orders"
      });
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
        }),
        label
      ).rejects.toThrow(/categorical|retained column/u);
    }
  });

  it("rejects invalid native R categorical inputs before transport", async () => {
    const source = frameContract();
    const invalidSteps: TransformStep[] = [
      {
        id: "r-one-hot-stale",
        kind: "oneHotEncode",
        params: { columns: [{ id: "r:c:0", name: "stale" }] }
      },
      {
        id: "r-one-hot-duplicate",
        kind: "oneHotEncode",
        params: {
          columns: [
            { id: "r:c:0", name: "value" },
            { id: "r:c:0", name: "value" }
          ]
        }
      },
      {
        id: "r-multi-label-numeric",
        kind: "multiLabelBinarize",
        params: { column: { id: "r:c:0", name: "value" }, delimiter: "," }
      },
      {
        id: "r-multi-label-empty-delimiter",
        kind: "multiLabelBinarize",
        params: { column: { id: "r:c:6", name: "missing" }, delimiter: "" }
      }
    ];
    for (const step of invalidSteps) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
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
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
      expect(transport.previewStep).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid native R numeric rounding inputs before transport", async () => {
    const source = dataTableContract(frameContract(), ["r:c:0"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const invalidSteps = [
      {
        id: "stale-round",
        kind: "roundNumber",
        params: { column: { id: "r:c:0", name: "stale" }, decimals: 1 }
      },
      {
        id: "date-floor",
        kind: "floorNumber",
        params: { column: { id: "r:c:2", name: "date" } }
      },
      {
        id: "colliding-ceiling",
        kind: "ceilNumber",
        params: { column: { id: "r:c:0", name: "value" }, newColumn: "count" }
      },
      {
        id: "private-floor",
        kind: "floorNumber",
        params: {
          column: { id: "r:c:0", name: "value" },
          newColumn: "__OPEN_WRANGLER_INTERNAL_ROW_ID_forged"
        }
      },
      {
        id: "wide-round",
        kind: "roundNumber",
        params: { column: { id: "r:c:0", name: "value" }, decimals: 2_147_483_648 }
      },
      {
        id: "keyed-round",
        kind: "roundNumber",
        params: { column: { id: "r:c:0", name: "value" }, decimals: -2 }
      }
    ] satisfies Array<RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep>;
    for (const step of invalidSteps) {
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
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    }
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

  it("uppercases R factors in place and retains an isolated draft", async () => {
    const original = replaceContractCell(frameContract(), "r:c:6", {
      kind: "string",
      raw: "MiXeD élan",
      display: "MiXeD élan",
      isNull: false,
      isNaN: false
    });
    const source = factorContract(original, "r:c:6", ["MiXeD élan"]);
    const output = upperTextContract(source, "r:c:6", "r-upper-in-place");
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: output,
      diff: lowerDiff("r:c:6", "missing", "MiXeD élan", "MIXED ÉLAN"),
      code: "open_wrangler_result <- orders"
    });
    const step: {
      id: string;
      kind: "upperText";
      params: { column: { id: string; name: string }; newColumn?: string };
    } = {
      id: "r-upper-in-place",
      kind: "upperText",
      params: { column: { id: "r:c:6", name: "missing" } }
    };
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      {
        id: "r-upper-in-place",
        kind: "upperText",
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
          id: "r-upper-in-place",
          kind: "upperText",
          params: { column: { id: "r:c:6", name: "missing" } }
        }
      },
      diff: { addedColumns: [], changedCells: 1 }
    });

    step.params.column.name = "mutated outside bridge";
    step.params.newColumn = "also mutated";
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: output,
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [
          {
            id: "r-upper-in-place",
            kind: "upperText",
            params: { column: { id: "r:c:6", name: "missing" } }
          }
        ]
      }
    });
  });

  it("passes literal, regex, and blank native R replacements without changing their parameters", async () => {
    const source = replaceContractCell(factorContract(frameContract(), "r:c:6", ["a.b 42"]), "r:c:6", {
      kind: "string",
      raw: "a.b 42",
      display: "a.b 42",
      isNull: false,
      isNaN: false
    });
    const cases: ReadonlyArray<{
      readonly id: string;
      readonly params: Readonly<{ find: string; replacement: string; regex?: boolean; newColumn?: string }>;
      readonly after: string;
    }> = [
      {
        id: "r-replace-literal",
        params: { find: ".", replacement: "!", regex: false, newColumn: "literal result" },
        after: "a!b 42"
      },
      {
        id: "r-replace-regex",
        params: { find: "[0-9]+", replacement: "#", regex: true, newColumn: "regex result" },
        after: "a.b #"
      },
      {
        id: "r-replace-blank",
        params: { find: "", replacement: "_" },
        after: "_a_._b_ _4_2_"
      }
    ];

    for (const candidate of cases) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      const output = findReplaceContract(
        source,
        "r:c:6",
        candidate.id,
        candidate.params.find,
        candidate.params.replacement,
        candidate.params.regex ?? false,
        candidate.params.newColumn
      );
      const outputName = candidate.params.newColumn;
      const inPlace = outputName === undefined;
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: output,
        diff: inPlace ? lowerDiff("r:c:6", "missing", "a.b 42", candidate.after) : cloneDiff(outputName),
        code: "open_wrangler_result <- orders"
      });
      const preview = await bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: candidate.id,
          kind: "findReplace",
          params: { column: { id: "r:c:6", name: "missing" }, ...candidate.params }
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
          id: candidate.id,
          kind: "findReplace",
          params: { column: { id: "r:c:6", name: "missing" }, ...candidate.params }
        },
        expect.any(Object),
        expect.any(Array),
        undefined,
        expect.any(Object)
      );
      expect(preview).toMatchObject({
        kind: "stepPreview",
        metadata: {
          draftStep: {
            id: candidate.id,
            kind: "findReplace",
            params: { column: { id: "r:c:6", name: "missing" }, ...candidate.params }
          }
        },
        diff: inPlace ? { addedColumns: [], changedCells: 1 } : { addedColumns: [outputName], changedCells: 0 }
      });
    }
  });

  it("rejects unsafe native R uppercase and find-and-replace schemas and diffs", async () => {
    for (const step of [
      {
        id: "r-upper-keyed",
        kind: "upperText" as const,
        params: { column: { id: "r:c:6", name: "missing" } }
      },
      {
        id: "r-replace-keyed",
        kind: "findReplace" as const,
        params: { column: { id: "r:c:6", name: "missing" }, find: "x", replacement: "y" }
      }
    ]) {
      const keyedTransport = fakeTransport(dataTableContract(frameContract(), ["r:c:6"]));
      const keyedBridge = createBridge(keyedTransport);
      await keyedBridge.request(openRequest("editing"));
      await expect(
        keyedBridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request", message: expect.stringContaining("keyed") });
      expect(keyedTransport.previewStep).not.toHaveBeenCalled();
    }

    const source = replaceContractCell(frameContract(), "r:c:6", {
      kind: "string",
      raw: "MiXeD",
      display: "MiXeD",
      isNull: false,
      isNaN: false
    });
    const collisionTransport = fakeTransport(source);
    const collisionBridge = createBridge(collisionTransport);
    await collisionBridge.request(openRequest("editing"));
    await expect(
      collisionBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-upper-collision",
          kind: "upperText",
          params: { column: { id: "r:c:6", name: "missing" }, newColumn: "flag" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request", message: expect.stringContaining("exists") });
    expect(collisionTransport.previewStep).not.toHaveBeenCalled();

    const identityCollision = cloneContract(source, "r:c:5", "existing", "r-replace-id-collision");
    const identityTransport = fakeTransport(identityCollision);
    const identityBridge = createBridge(identityTransport);
    await identityBridge.request(openRequest("editing"));
    await expect(
      identityBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-replace-id-collision",
          kind: "findReplace",
          params: {
            column: { id: "r:c:6", name: "missing" },
            find: "x",
            replacement: "y",
            newColumn: "replaced"
          }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 9
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request", message: expect.stringContaining("identity") });
    expect(identityTransport.previewStep).not.toHaveBeenCalled();

    const diffTransport = fakeTransport(source);
    const diffBridge = createBridge(diffTransport);
    await diffBridge.request(openRequest("editing"));
    diffTransport.queuePreview({
      sessionId,
      revision: 1,
      page: upperTextContract(source, "r:c:6", "r-upper-wrong-diff"),
      diff: lowerDiff("r:c:5", "flag", "MiXeD", "MIXED"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      diffBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "r-upper-wrong-diff",
          kind: "upperText",
          params: { column: { id: "r:c:6", name: "missing" } }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("mutation diff");
  });

  it("bridges native R capitalize, strip, and split with stable text identities", async () => {
    type TextStep = CapitalizeTextTransformStep | StripTextTransformStep | SplitTextTransformStep;
    const base = replaceContractCell(frameContract(), "r:c:6", {
      kind: "string",
      raw: "mIXed::CASE",
      display: "mIXed::CASE",
      isNull: false,
      isNaN: false
    });
    const factor = factorContract(base, "r:c:6", ["mIXed::CASE"]);
    const cases: ReadonlyArray<{
      readonly keyed: boolean;
      readonly step: TextStep;
      readonly page: (source: RFramePageContract) => RFramePageContract;
      readonly diff: DataDiff;
      readonly outputId: string;
      readonly outputName: string;
    }> = [
      {
        keyed: false,
        step: {
          id: "r-capitalize",
          kind: "capitalizeText",
          params: { column: { id: "r:c:6", name: "missing" } }
        },
        page: (source) => capitalizeTextContract(source, "r:c:6", "r-capitalize"),
        diff: lowerDiff("r:c:6", "missing", "mIXed::CASE", "Mixed::case"),
        outputId: "r:c:6",
        outputName: "missing"
      },
      {
        keyed: true,
        step: {
          id: "r-strip-derived",
          kind: "stripText",
          params: { column: { id: "r:c:6", name: "missing" }, characters: null, newColumn: "trimmed" }
        },
        page: (source) => textTransformContract(source, "r:c:6", "r-strip-derived", "trimmed", (value) => value),
        diff: cloneDiff("trimmed"),
        outputId: "c:step:r-strip-derived:0",
        outputName: "trimmed"
      },
      {
        keyed: false,
        step: {
          id: "r-split-derived",
          kind: "splitText",
          params: { column: { id: "r:c:6", name: "missing" }, delimiter: "::", index: 2, newColumn: "part" }
        },
        page: (source) =>
          withColumnNullable(
            textTransformContract(source, "r:c:6", "r-split-derived", "part", (value) => value),
            "c:step:r-split-derived:0",
            true
          ),
        diff: cloneDiff("part"),
        outputId: "c:step:r-split-derived:0",
        outputName: "part"
      }
    ];

    for (const candidate of cases) {
      const source = candidate.keyed
        ? dataTableContract(factor, ["r:c:6"])
        : candidate.step.kind === "splitText"
          ? withColumnNullable(factor, "r:c:6", false)
          : factor;
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: candidate.page(source),
        diff: candidate.diff,
        code: "open_wrangler_result <- orders"
      });
      const preview = await bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: candidate.step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });
      expect(transport.previewStep).toHaveBeenCalledWith(
        sessionId,
        0,
        candidate.step,
        expect.any(Object),
        expect.any(Array),
        undefined,
        expect.any(Object)
      );
      expect(preview).toMatchObject({
        kind: "stepPreview",
        metadata: {
          schema: expect.arrayContaining([
            expect.objectContaining({
              id: candidate.outputId,
              name: candidate.outputName,
              rawType: "character",
              type: "string"
            })
          ])
        },
        diff: {
          addedColumns: candidate.outputId === "r:c:6" ? [] : [candidate.outputName],
          changedCells: candidate.outputId === "r:c:6" ? 1 : 0
        }
      });
    }

    for (const step of [
      {
        id: "r-strip-keyed",
        kind: "stripText" as const,
        params: { column: { id: "r:c:6", name: "missing" } }
      },
      {
        id: "r-split-in-place",
        kind: "splitText" as const,
        params: {
          column: { id: "r:c:6", name: "missing" },
          delimiter: "-",
          index: 0,
          newColumn: "missing"
        }
      },
      {
        id: "r-split-private",
        kind: "splitText" as const,
        params: {
          column: { id: "r:c:6", name: "missing" },
          delimiter: "-",
          index: 0,
          newColumn: "__open_wrangler_internal_row_id_public"
        }
      }
    ]) {
      const source = step.kind === "stripText" ? dataTableContract(factor, ["r:c:6"]) : factor;
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
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
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
      expect(transport.previewStep).not.toHaveBeenCalled();
    }
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
  verifiedVariable?: RNotebookVariableDescriptor,
  fileOperations?: RKernelBridgeFileOperations
): RKernelBridge {
  const context = {
    extension: { packageJSON: { version: "2.0.0-preview.1" } },
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
  return new RKernelBridge(context, transport, createSessionId, diagnosticSink, verifiedVariable, fileOperations);
}

function fakeAtomicTransaction(): {
  transaction: AtomicFileTransaction;
  write: ReturnType<typeof vi.fn>;
  prepareExternalWriter: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  abandon: ReturnType<typeof vi.fn>;
} {
  const write = vi.fn(async (_contents: Uint8Array) => undefined);
  const prepareExternalWriter = vi.fn(async () => ({
    path: "/workspace/.openwrangler-export.tmp",
    identity: { dev: 101n, ino: 202n }
  }));
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const abandon = vi.fn(async () => undefined);
  return {
    transaction: {
      temporaryPath: "/workspace/.openwrangler-export.tmp",
      write,
      prepareExternalWriter,
      commit,
      rollback,
      abandon
    },
    write,
    prepareExternalWriter,
    commit,
    rollback,
    abandon
  };
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

function documentOpenRequest(
  mode: OpenSessionRequest["mode"] = "editing",
  uri = "file:///workspace/orders.R"
): OpenSessionRequest {
  return {
    ...openRequest(mode),
    source: {
      kind: "documentVariable",
      label: "orders",
      uri,
      variableName: "orders"
    }
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

function byExampleTransformStep(): ByExampleTransformStep {
  return {
    id: "by-example-step",
    kind: "byExample",
    params: {
      sourceColumns: [{ id: "r:c:1", name: "count" }],
      newColumn: "count copy",
      examples: [
        { inputs: [1], output: 1 },
        { inputs: [2], output: 2 }
      ]
    }
  };
}

function retainedByExampleTransformStep(
  step: ByExampleTransformStep,
  program?: ByExampleProgram
): NonNullable<RKernelStepPreviewResult["retainedStep"]> {
  const sourceColumn = step.params.sourceColumns[0];
  if (!sourceColumn) throw new Error("Fake retained by-example step requires one source column.");
  return {
    id: step.id,
    kind: "byExample",
    params: {
      sourceColumns: step.params.sourceColumns.map((column) => ({
        ...column
      })) as ByExampleTransformStep["params"]["sourceColumns"],
      newColumn: step.params.newColumn,
      examples: step.params.examples.map((example) => ({
        inputs: [...example.inputs],
        output: example.output
      })) as ByExampleTransformStep["params"]["examples"],
      program: program ?? { kind: "column", column: { ...sourceColumn } },
      warnings: ["2 programs match; Open Wrangler selected the simplest deterministic program."],
      candidateCount: 2
    }
  };
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

function fakeTransport(
  contract: RFramePageContract,
  openedSessionId = sessionId,
  exportFormats: readonly ("csv" | "parquet")[] = ["csv"]
): FakeRTransport {
  const emitter = new vscode.EventEmitter<void>();
  const previewQueue: RKernelStepPreviewResult[] = [];
  return {
    onDidInvalidateKernel: emitter.event,
    open: vi.fn(async () => ({ sessionId: openedSessionId, page: contract, exportFormats })),
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

function customCodeContract(
  source: RFramePageContract,
  stepId: string,
  outputs: readonly Readonly<{ name: string; sourcePosition: number }>[],
  options: Readonly<{
    rows?: number;
    rowNames?: "positional" | "explicit";
    keyColumnIds?: readonly string[];
  }> = {}
): RFramePageContract {
  const idsByName = new Map<string, string[]>();
  for (const input of source.schema) {
    idsByName.set(input.name, [...(idsByName.get(input.name) ?? []), input.id]);
  }
  let createdOrdinal = 0;
  const schema = outputs.map((output, position) => {
    const template = source.schema[output.sourcePosition];
    if (!template) throw new Error("Unknown fake R custom-code source position.");
    const retainedId = idsByName.get(output.name)?.shift();
    const id = retainedId ?? `c:step:${stepId}:${createdOrdinal++}`;
    return { ...template, id, name: output.name, position };
  });
  const rows = options.rows ?? 1;
  const rowNames = options.rowNames ?? source.frameSemantics.rowNames;
  const columnOffset = Math.min(source.page.columnOffset, schema.length);
  const projected = schema.slice(columnOffset, columnOffset + source.page.columnLimit);
  const sourceRow = source.page.rows[0];
  if (!sourceRow && rows > 0) throw new Error("Fake R custom-code output requires one source row template.");
  return {
    ...source,
    shape: { rows: source.shape.rows + rows, columns: schema.length },
    frameSemantics: {
      ...source.frameSemantics,
      rowNames,
      keyColumnIds: [...(options.keyColumnIds ?? [])]
    },
    schema,
    page: {
      ...source.page,
      offset: 0,
      totalRows: rows,
      columnOffset,
      columnIds: projected.map((column) => column.id),
      rows: Array.from({ length: rows }, (_, rowNumber) => ({
        id: `r:r:${source.shape.rows + rowNumber}`,
        rowNumber,
        ...(rowNames === "explicit" ? { rowLabel: `custom-${rowNumber + 1}` } : {}),
        values: projected.map((column) => {
          const output = outputs[column.position] as { sourcePosition: number };
          return { ...(sourceRow?.values[output.sourcePosition] as RFrameCell) };
        })
      }))
    }
  };
}

function customCodeDiff(source: RFramePageContract, output: RFramePageContract): DataDiff {
  const inputIds = new Set(source.schema.map((column) => column.id));
  const outputIds = new Set(output.schema.map((column) => column.id));
  return {
    addedRows: output.page.totalRows,
    removedRows: source.page.totalRows,
    addedColumns: output.schema.filter((column) => !inputIds.has(column.id)).map((column) => column.name),
    removedColumns: source.schema.filter((column) => !outputIds.has(column.id)).map((column) => column.name),
    changedCells: 0,
    cells: [],
    truncated:
      output.page.offset !== 0 ||
      output.page.limit < source.page.totalRows ||
      output.page.totalRows !== output.page.rows.length
  };
}

function contractWithRowIds(source: RFramePageContract, rowIds: readonly string[]): RFramePageContract {
  if (rowIds.length !== source.page.rows.length) throw new Error("Fake R row IDs must match the page row count.");
  return {
    ...source,
    page: {
      ...source.page,
      rows: source.page.rows.map((row, index) => ({ ...row, id: rowIds[index] as string }))
    }
  };
}

function minMaxScaleContract(
  source: RFramePageContract,
  columnId: string,
  stepId: string,
  newColumn: string
): RFramePageContract {
  if (!source.schema.some((column) => column.id === columnId)) {
    throw new Error(`Unknown fake R Min-max scale column ${columnId}.`);
  }
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
        rawType: "double",
        type: "float",
        nullable: true,
        semantics: { kind: "double", storageMode: "double", classes: ["numeric"] }
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

function formulaContract(
  source: RFramePageContract,
  step: FormulaTransformStep,
  rawType: "integer" | "double" | "integer64",
  type: "integer" | "float",
  nullable: boolean
): RFramePageContract {
  const outputId = `c:step:${step.id}:0`;
  return {
    ...source,
    shape: { ...source.shape, columns: source.schema.length + 1 },
    frameSemantics: { ...source.frameSemantics, keyColumnIds: [...source.frameSemantics.keyColumnIds] },
    schema: [
      ...source.schema.map((column) => ({ ...column })),
      {
        id: outputId,
        name: step.params.newColumn,
        position: source.schema.length,
        rawType,
        type,
        nullable,
        semantics:
          rawType === "integer"
            ? { kind: "integer", storageMode: "integer", classes: ["integer"] }
            : rawType === "integer64"
              ? { kind: "integer64", storageMode: "double", classes: ["integer64"] }
              : { kind: "double", storageMode: "double", classes: ["numeric"] }
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

function formattedDatetimeContract(source: RFramePageContract, step: FormatDatetimeTransformStep): RFramePageContract {
  const sourceColumn = source.schema.find(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (!sourceColumn) throw new Error("Unknown fake R datetime-format column.");
  if (step.params.newColumn === undefined || step.params.newColumn === sourceColumn.name) {
    throw new Error("The fake appended datetime-format contract requires a distinct output name.");
  }
  return {
    ...source,
    shape: { ...source.shape, columns: source.schema.length + 1 },
    frameSemantics: { ...source.frameSemantics, keyColumnIds: [...source.frameSemantics.keyColumnIds] },
    schema: [
      ...source.schema.map((column) => ({ ...column })),
      {
        id: `c:step:${step.id}:0`,
        name: step.params.newColumn,
        position: source.schema.length,
        rawType: "character",
        type: "string",
        nullable: sourceColumn.nullable,
        semantics: { kind: "character", storageMode: "character", classes: ["character"] }
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

function categoricalContract(
  source: RFramePageContract,
  stepId: string,
  selectedColumnIds: readonly string[],
  dropOriginal: boolean,
  generatedNames: readonly string[]
): RFramePageContract {
  const selectedIds = new Set(selectedColumnIds);
  const retained = source.schema
    .filter((column) => !dropOriginal || !selectedIds.has(column.id))
    .map((column, position) => ({ ...column, position }));
  const generated: RColumnSchema[] = generatedNames.map((name, ordinal) => ({
    id: `c:step:${stepId}:${ordinal}`,
    name,
    position: retained.length + ordinal,
    rawType: "integer",
    type: "integer",
    nullable: false,
    semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
  }));
  const schema = [...retained, ...generated];
  const keyColumnIds: string[] = [];
  const retainedIds = new Set(retained.map((column) => column.id));
  for (const id of source.frameSemantics.keyColumnIds) {
    if (!retainedIds.has(id)) break;
    keyColumnIds.push(id);
  }
  const projected = schema.slice(source.page.columnOffset, source.page.columnOffset + source.page.columnLimit);
  const sourcePagePosition = new Map(source.page.columnIds.map((id, position) => [id, position]));
  return {
    ...source,
    shape: { ...source.shape, columns: schema.length },
    frameSemantics: { ...source.frameSemantics, keyColumnIds },
    schema,
    page: {
      ...source.page,
      columnIds: projected.map((column) => column.id),
      rows: source.page.rows.map((row) => ({
        ...row,
        values: projected.map((column) => {
          const position = sourcePagePosition.get(column.id);
          return position === undefined
            ? ({ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false } as const)
            : { ...(row.values[position] as RFrameCell) };
        })
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

function fillMissingContract(source: RFramePageContract, columnId: string, value: RFrameCell): RFramePageContract {
  return withColumnNullable(replaceContractCell(source, columnId, value), columnId, false);
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
      : rawType === "integer64"
        ? { kind: "integer64", storageMode: "double", classes: ["integer64"] }
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
  return textTransformContract(source, columnId, stepId, newColumn, (value) => value.toLowerCase());
}

function upperTextContract(
  source: RFramePageContract,
  columnId: string,
  stepId: string,
  newColumn?: string
): RFramePageContract {
  return textTransformContract(source, columnId, stepId, newColumn, (value) => value.toUpperCase());
}

function capitalizeTextContract(
  source: RFramePageContract,
  columnId: string,
  stepId: string,
  newColumn?: string
): RFramePageContract {
  return textTransformContract(
    source,
    columnId,
    stepId,
    newColumn,
    (value) => value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase()
  );
}

function findReplaceContract(
  source: RFramePageContract,
  columnId: string,
  stepId: string,
  find: string,
  replacement: string,
  regex: boolean,
  newColumn?: string
): RFramePageContract {
  return textTransformContract(source, columnId, stepId, newColumn, (value) =>
    regex ? value.replace(new RegExp(find, "gu"), replacement) : value.replaceAll(find, replacement)
  );
}

function textTransformContract(
  source: RFramePageContract,
  columnId: string,
  stepId: string,
  newColumn: string | undefined,
  transform: (value: string) => string
): RFramePageContract {
  const sourceColumn = source.schema.find((column) => column.id === columnId);
  if (!sourceColumn) throw new Error(`Unknown fake R text column ${columnId}.`);
  const inPlace = newColumn === undefined || newColumn === sourceColumn.name;
  const transformedColumn: RColumnSchema = {
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
    const transformed =
      sourceValue?.kind === "string"
        ? ({ ...sourceValue, raw: transform(sourceValue.raw), display: transform(sourceValue.display) } as const)
        : sourceValue
          ? { ...sourceValue }
          : undefined;
    if (inPlace && pagePosition >= 0 && transformed) {
      return {
        ...row,
        values: row.values.map((value, index) => ({ ...(index === pagePosition ? transformed : value) }))
      };
    }
    return { ...row, values: row.values.map((value) => ({ ...value })) };
  });
  return {
    ...source,
    shape: { ...source.shape, columns: source.schema.length + (inPlace ? 0 : 1) },
    schema: inPlace
      ? source.schema.map((column) => (column.id === columnId ? transformedColumn : { ...column }))
      : [...source.schema.map((column) => ({ ...column })), transformedColumn],
    page: { ...source.page, columnIds: [...source.page.columnIds], rows }
  };
}

function factorContract(source: RFramePageContract, columnId: string, levels: readonly string[]): RFramePageContract {
  return {
    ...source,
    schema: source.schema.map((column) =>
      column.id === columnId
        ? {
            ...column,
            rawType: "factor",
            type: "string" as const,
            semantics: {
              kind: "factor" as const,
              storageMode: "integer" as const,
              classes: ["factor"],
              levels: [...levels],
              ordered: false
            }
          }
        : { ...column }
    ),
    page: {
      ...source.page,
      columnIds: [...source.page.columnIds],
      rows: source.page.rows.map((row) => ({ ...row, values: row.values.map((value) => ({ ...value })) }))
    }
  };
}

function replaceColumnSemantics(
  source: RFramePageContract,
  columnId: string,
  semantics: RColumnSchema["semantics"]
): RFramePageContract {
  if (!source.schema.some((column) => column.id === columnId)) {
    throw new Error(`Unknown fake R semantics column ${columnId}.`);
  }
  return {
    ...source,
    schema: source.schema.map((column) => (column.id === columnId ? { ...column, semantics } : { ...column })),
    page: {
      ...source.page,
      columnIds: [...source.page.columnIds],
      rows: source.page.rows.map((row) => ({ ...row, values: row.values.map((value) => ({ ...value })) }))
    }
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

function rowOrderContract(
  source: RFramePageContract,
  rowIds: readonly string[],
  totalRows: number
): RFramePageContract {
  const template = source.page.rows[0];
  if (!template) throw new Error("Fake R row contract requires one template row.");
  return {
    ...source,
    page: {
      ...source.page,
      totalRows,
      rows: rowIds.map((id, rowNumber) => ({
        ...template,
        id,
        rowNumber,
        values: template.values.map((value) => ({ ...value }))
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

function rowDiff(removedRows = 0): DataDiff {
  return { ...renameDiff(), removedRows };
}

function dropDiff(...removedColumns: string[]): DataDiff {
  return { ...renameDiff(), removedColumns };
}

function cloneDiff(newName: string): DataDiff {
  return { ...renameDiff(), addedColumns: [newName] };
}

function categoricalDiff(addedColumns: readonly string[], removedColumns: readonly string[]): DataDiff {
  return { ...renameDiff(), addedColumns: [...addedColumns], removedColumns: [...removedColumns] };
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

function fillMissingDiff(columnId: string, column: string, after: RFrameCell): DataDiff {
  return {
    ...renameDiff(),
    changedCells: 1,
    cells: [
      {
        rowNumber: 0,
        columnId,
        column,
        before: { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false },
        after: { ...after, ...(after.kind === "number" ? { raw: Number(after.raw) } : {}) }
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

function numericRoundingDiff(columnId: string, column: string, before: RFrameCell, after: RFrameCell): DataDiff {
  return castDiff(columnId, column, before, after);
}

function groupContract(source: RFramePageContract, step: GroupByTransformStep, rows: number): RFramePageContract {
  const key = source.schema.find(
    (column) => column.id === step.params.keys[0].id && column.name === step.params.keys[0].name
  );
  if (!key) throw new Error("Unknown fake R Group By key.");
  const schema: RColumnSchema[] = [
    { ...key, position: 0 },
    {
      id: `c:step:${step.id}:0`,
      name: step.params.aggregations[0].alias,
      position: 1,
      rawType: "integer",
      type: "integer",
      nullable: false,
      semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
    },
    {
      id: `c:step:${step.id}:1`,
      name: step.params.aggregations[1].alias,
      position: 2,
      rawType: "double",
      type: "float",
      nullable: true,
      semantics: { kind: "double", storageMode: "double", classes: ["numeric"] }
    },
    {
      id: `c:step:${step.id}:2`,
      name: step.params.aggregations[2].alias,
      position: 3,
      rawType: "character",
      type: "string",
      nullable: true,
      semantics: { kind: "character", storageMode: "character", classes: ["character"] }
    }
  ];
  const identityRows = source.shape.rows + rows;
  const pageRows: RFramePageContract["page"]["rows"] = [
    {
      id: `r:r:${source.shape.rows}`,
      rowNumber: 0,
      values: [
        rCell("boolean", true, "TRUE"),
        rCell("integer", "2", "2"),
        rCell("number", "12.5", "12.5"),
        { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false }
      ]
    },
    {
      id: `r:r:${source.shape.rows + 1}`,
      rowNumber: 1,
      values: [
        rCell("boolean", false, "FALSE"),
        rCell("integer", "1", "1"),
        rCell("number", "8", "8"),
        { kind: "string", raw: "ready", display: "ready", isNull: false, isNaN: false }
      ]
    }
  ];
  return {
    contractVersion: source.contractVersion,
    dataframeFlavor: source.dataframeFlavor,
    shape: { rows: identityRows, columns: schema.length },
    frameSemantics: { ...source.frameSemantics, rowNames: "positional", keyColumnIds: [] },
    schema,
    page: {
      offset: 0,
      limit: 20,
      totalRows: rows,
      columnOffset: 0,
      columnLimit: 8,
      columnIds: schema.map((column) => column.id),
      rows: pageRows.slice(0, rows)
    }
  };
}

function groupDiff(source: RFramePageContract, output: RFramePageContract, step: GroupByTransformStep): DataDiff {
  const keyIds = new Set(step.params.keys.map((column) => column.id));
  return {
    addedRows: output.page.totalRows,
    removedRows: source.page.totalRows,
    addedColumns: step.params.aggregations.map((aggregation) => aggregation.alias),
    removedColumns: source.schema.filter((column) => !keyIds.has(column.id)).map((column) => column.name),
    changedCells: 0,
    cells: [],
    truncated:
      output.page.offset !== 0 ||
      output.page.limit < source.page.totalRows ||
      output.page.totalRows !== output.page.rows.length
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
    supportedOperations: [...operationKinds]
  };
}
