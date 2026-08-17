import * as vscode from "vscode";
import { vi } from "vitest";
import type {
  ColumnSummary,
  DataDiff,
  DatasetStats,
  GroupByTransformStep,
  OpenSessionRequest,
  OpenWranglerRequest
} from "../shared/protocol";
import type { AtomicFileTransaction } from "../extension/files/safeFileExport";
import { RKernelBridge } from "../extension/r/rKernelBridge";
import type { RKernelBridgeFileOperations } from "../extension/r/rKernelDataExport";
import type { RKernelBridgeTransport } from "../extension/r/rKernelBridgeTransport";
import type { RKernelStepPreviewResult } from "../extension/r/rKernelProtocol";
import type { RColumnSchema, RFrameCell, RFramePageContract } from "../extension/r/rFrameContract";
import type { RNotebookVariableDescriptor } from "../extension/r/rNotebookVariableDiscovery";

export const rKernelBridgeSessionId = "11111111-1111-4111-8111-111111111111";

export interface FakeRTransport extends RKernelBridgeTransport {
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

export function createRKernelBridge(
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

export function fakeAtomicTransaction(): {
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

export function rKernelOpenRequest(mode: OpenSessionRequest["mode"] = "viewing"): OpenSessionRequest {
  return {
    kind: "openSession",
    source: {
      kind: "notebookVariable",
      label: "orders",
      uri: "file:///workspace/orders.ipynb",
      variableName: "orders"
    },
    requestedSessionId: rKernelBridgeSessionId,
    backend: "r",
    mode,
    pageSize: 20,
    columnOffset: 0,
    columnLimit: 8
  };
}

export function rKernelDocumentOpenRequest(
  mode: OpenSessionRequest["mode"] = "editing",
  uri = "file:///workspace/orders.R"
): OpenSessionRequest {
  return {
    ...rKernelOpenRequest(mode),
    source: {
      kind: "documentVariable",
      label: "orders",
      uri,
      variableName: "orders"
    }
  };
}

export function rKernelRenamePreviewRequest(revision: number): Extract<OpenWranglerRequest, { kind: "previewStep" }> {
  return {
    kind: "previewStep",
    sessionId: rKernelBridgeSessionId,
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

export function fakeRKernelTransport(
  contract: RFramePageContract,
  openedSessionId = rKernelBridgeSessionId,
  exportFormats: readonly ("csv" | "parquet")[] = ["csv"]
): FakeRTransport {
  const emitter = new vscode.EventEmitter<void>();
  const previewQueue: RKernelStepPreviewResult[] = [];
  return {
    onDidInvalidateKernel: emitter.event,
    open: vi.fn(async () => ({ sessionId: openedSessionId, page: contract, exportFormats })),
    getPage: vi.fn(async () => contract),
    getSummary: vi.fn(async (_sessionId, columns) => columns.map((column) => rKernelSummaryFor(contract, column))),
    getDatasetStats: vi.fn(async () => ({
      totalRows: contract.shape.rows,
      stats: rKernelDatasetStatsFor(contract)
    })),
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

export function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next as (value?: T) => void;
  });
  return { promise, resolve };
}

export function rKernelFrameContract(
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
    rKernelTestColumn(0, names[0] as string, "double", "float", true, "double"),
    rKernelTestColumn(1, names[1] as string, "integer64", "integer", true, "integer64"),
    rKernelTestColumn(2, names[2] as string, "Date", "date", true, "date"),
    rKernelTestColumn(3, names[3] as string, "POSIXct", "datetime", true, "datetime"),
    rKernelTestColumn(4, names[4] as string, "difftime", "duration", true, "difftime"),
    rKernelTestColumn(5, names[5] as string, "logical", "boolean", true, "logical"),
    rKernelTestColumn(6, names[6] as string, "character", "string", true, "character"),
    rKernelTestColumn(7, names[7] as string, "double", "float", true, "double")
  ];
  const values: RFrameCell[] = [
    rKernelTestCell("number", "12.5", "12.5"),
    rKernelTestCell("integer", "9223372036854775807", "9223372036854775807"),
    rKernelTestCell("date", "2026-08-05", "2026-08-05"),
    rKernelTestCell("datetime", "1785945600", "2026-08-05T12:00:00Z"),
    rKernelTestCell("duration", "90", "90 secs"),
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

export function rKernelRenameContract(source: RFramePageContract, columnId: string, name: string): RFramePageContract {
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

export function rKernelRenameDiff(): DataDiff {
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

export function rKernelSummaryFor(
  contract: RFramePageContract,
  reference: Readonly<{ id: string; name: string }>
): ColumnSummary {
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

export function rKernelDatasetStatsFor(contract: RFramePageContract): DatasetStats {
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

export function rKernelTestColumn(
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

export function rKernelTestCell(
  kind: "number" | "integer" | "date" | "datetime" | "duration" | "boolean",
  raw: string | boolean,
  display: string
): RFrameCell {
  return { kind, raw, display, isNull: false, isNaN: false } as RFrameCell;
}
export function rKernelPlanRequest(
  kind: "applyDraft" | "discardDraft" | "undoStep",
  revision: number
): Extract<OpenWranglerRequest, { kind: "applyDraft" | "discardDraft" | "undoStep" }> {
  return {
    kind,
    sessionId: rKernelBridgeSessionId,
    revision,
    offset: 0,
    limit: 20,
    columnOffset: 0,
    columnLimit: 8
  };
}

export function rKernelDataTableContract(
  source: RFramePageContract,
  keyColumnIds: readonly string[]
): RFramePageContract {
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

export function rKernelRowOrderContract(
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

export function rKernelGroupContract(
  source: RFramePageContract,
  step: GroupByTransformStep,
  rows: number
): RFramePageContract {
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
        rKernelTestCell("boolean", true, "TRUE"),
        rKernelTestCell("integer", "2", "2"),
        rKernelTestCell("number", "12.5", "12.5"),
        { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false }
      ]
    },
    {
      id: `r:r:${source.shape.rows + 1}`,
      rowNumber: 1,
      values: [
        rKernelTestCell("boolean", false, "FALSE"),
        rKernelTestCell("integer", "1", "1"),
        rKernelTestCell("number", "8", "8"),
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

export function rKernelGroupDiff(
  source: RFramePageContract,
  output: RFramePageContract,
  step: GroupByTransformStep
): DataDiff {
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

export function rKernelRowDiff(removedRows = 0): DataDiff {
  return { ...rKernelRenameDiff(), removedRows };
}
