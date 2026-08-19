import { vi } from "vitest";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type {
  ColumnSchema,
  DataBackend,
  FilterModel,
  OpenSessionRequest,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionOpenedResponse,
  SessionSource,
  TransformStep
} from "../shared/protocol";

export type CloseRequest = Extract<OpenWranglerRequest, { kind: "closeSession" }>;

export const schema: ColumnSchema[] = [
  {
    id: "c:value",
    name: "value",
    position: 0,
    rawType: "Float64",
    type: "float",
    nullable: false
  }
];

export const initialSource: SessionSource = {
  kind: "file",
  label: "sample.csv",
  path: "/workspace/sample.csv",
  uri: "file:///workspace/sample.csv",
  importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
};

export const replacementSource: SessionSource = {
  ...initialSource,
  importOptions: { delimiter: "💠", encoding: "utf-8", quoteChar: '"', hasHeader: true }
};

export const appliedStep: TransformStep = {
  id: "round-value",
  kind: "roundNumber",
  params: { column: { id: "c:value", name: "value" }, decimals: 1 }
};

export const draftStep: TransformStep = {
  id: "floor-value",
  kind: "floorNumber",
  params: { column: { id: "c:value", name: "value" } }
};

export const savedFilter: FilterModel = {
  filters: [],
  sort: [{ column: "value", direction: "desc", nulls: "last" }]
};

export function openRequest(source: SessionSource): OpenSessionRequest {
  return {
    kind: "openSession",
    source,
    mode: "editing",
    pageSize: 100,
    columnOffset: 0,
    columnLimit: 16
  };
}

export async function open(bridge: OpenWranglerBridge, source: SessionSource): Promise<SessionOpenedResponse> {
  const response = await bridge.request(openRequest(source));
  if (response.kind !== "sessionOpened") throw new Error(`Expected sessionOpened, received ${response.kind}.`);
  return response;
}

export function capabilities(): SessionMetadata["capabilities"] {
  return {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  };
}

export function metadataFor({
  runtimeId,
  source,
  backend = "polars",
  revision = 0,
  steps = [],
  draftStep: draft,
  filterModel = { filters: [], sort: [] }
}: {
  runtimeId: string;
  source: SessionSource;
  backend?: DataBackend;
  revision?: number;
  steps?: TransformStep[];
  draftStep?: TransformStep;
  filterModel?: FilterModel;
}): SessionMetadata {
  return {
    protocolVersion: 2,
    sessionId: runtimeId,
    revision,
    backend,
    mode: "editing",
    source,
    capabilities: capabilities(),
    shape: { rows: 2, columns: 1 },
    filteredShape: { rows: 2, columns: 1 },
    schema,
    filterModel,
    steps,
    ...(steps.length > 0 ? { latestStepInputSchema: schema } : {}),
    ...(draft ? { draftStep: draft } : {})
  };
}

export function openedFor(request: OpenSessionRequest, metadata: SessionMetadata): SessionOpenedResponse {
  return {
    kind: "sessionOpened",
    metadata,
    page: {
      offset: 0,
      limit: request.pageSize,
      totalRows: exactRows(metadata),
      columnIds: schema.map((column) => column.id),
      rows: []
    },
    summaries: []
  };
}

export function pageFor(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  metadata: SessionMetadata
): Extract<OpenWranglerResponse, { kind: "page" }> {
  return {
    kind: "page",
    revision: request.revision,
    viewRequestId: request.viewRequestId,
    metadata,
    page: {
      offset: request.offset,
      limit: request.limit,
      totalRows: exactRows(metadata),
      columnIds: metadata.schema
        .slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id),
      rows: []
    }
  };
}

export function previewFor(
  request: Extract<OpenWranglerRequest, { kind: "previewStep" }>,
  metadata: SessionMetadata,
  code: string
): Extract<OpenWranglerResponse, { kind: "stepPreview" }> {
  return {
    kind: "stepPreview",
    revision: metadata.revision,
    metadata,
    page: {
      offset: request.offset,
      limit: request.limit,
      totalRows: exactRows(metadata),
      columnIds: metadata.schema
        .slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id),
      rows: []
    },
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    },
    code
  };
}

export function appliedFor(
  request: Extract<OpenWranglerRequest, { kind: "applyDraft" }>,
  metadata: SessionMetadata,
  code: string
): Extract<OpenWranglerResponse, { kind: "planUpdated" }> {
  return {
    kind: "planUpdated",
    action: "apply",
    revision: metadata.revision,
    metadata,
    page: {
      offset: request.offset,
      limit: request.limit,
      totalRows: exactRows(metadata),
      columnIds: metadata.schema
        .slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id),
      rows: []
    },
    code
  };
}

export function exactRows(metadata: SessionMetadata): number {
  const rows = metadata.filteredShape.rows;
  if (rows === null) throw new Error("This exact-page test fixture requires a known row count.");
  return rows;
}

export function simpleReconfiguringDelegate(initialRuntimeId: string): {
  request: OpenWranglerBridge["request"];
  openRequests(): OpenSessionRequest[];
} {
  const requests: OpenWranglerRequest[] = [];
  const sources = new Map<string, SessionSource>();
  const request = vi.fn(async (message: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
    requests.push(message);
    if (message.kind === "openSession") {
      const runtimeId = message.requestedSessionId ?? initialRuntimeId;
      sources.set(runtimeId, message.source);
      return openedFor(message, metadataFor({ runtimeId, source: message.source }));
    }
    if (message.kind === "getPage") {
      return pageFor(
        message,
        metadataFor({
          runtimeId: message.sessionId,
          source: sources.get(message.sessionId) ?? initialSource,
          revision: message.revision,
          filterModel: message.filterModel
        })
      );
    }
    if (message.kind === "closeSession") return { kind: "sessionClosed", sessionId: message.sessionId };
    throw new Error(`Unexpected request: ${message.kind}`);
  });
  return {
    request,
    openRequests: () => requests.filter((message): message is OpenSessionRequest => message.kind === "openSession")
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
