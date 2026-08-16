import * as vscode from "vscode";
import type { NotebookDocument, TextDocument } from "vscode";
import type {
  GridPage,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionOpenedResponse,
  TransformStep
} from "../shared/protocol";

export const openRequest = {
  kind: "openSession",
  source: { kind: "file", label: "sample.csv", path: "/workspace/sample.csv" },
  backend: "polars",
  mode: "editing",
  pageSize: 100,
  columnOffset: 0,
  columnLimit: 16
} as const;

export const columnWindow = { columnOffset: 0, columnLimit: 16 } as const;

export const inspectionStep: TransformStep = {
  id: "round-sales",
  kind: "roundNumber",
  params: { column: { id: "c:sales", name: "sales" }, decimals: 0 }
};

export type ExactSessionOpenedResponse = Omit<SessionOpenedResponse, "page"> & { page: GridPage };

export function openedResponse(
  sessionId = "runtime-session",
  backend: SessionMetadata["backend"] = "polars"
): ExactSessionOpenedResponse {
  const metadata: SessionMetadata = {
    protocolVersion: 2,
    sessionId,
    revision: 0,
    backend,
    mode: "editing",
    source: openRequest.source,
    capabilities: {
      editable: true,
      lazy: true,
      cancel: true,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: false
    },
    shape: { rows: 0, columns: 0 },
    filteredShape: { rows: 0, columns: 0 },
    schema: [],
    filterModel: { filters: [], sort: [] },
    steps: []
  };
  return {
    kind: "sessionOpened",
    metadata,
    page: { offset: 0, limit: openRequest.pageSize, totalRows: 0, columnIds: [], rows: [] },
    summaries: []
  };
}

export function pageResponse(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  sessionId = "runtime-session",
  backend: SessionMetadata["backend"] = "polars"
): Extract<OpenWranglerResponse, { kind: "page" }> {
  const opened = openedResponse(sessionId, backend);
  return {
    kind: "page",
    revision: opened.metadata.revision,
    viewRequestId: request.viewRequestId,
    metadata: { ...opened.metadata, filterModel: request.filterModel },
    page: { ...opened.page, offset: request.offset, limit: request.limit }
  };
}

export function projectedPage(
  request: Extract<
    OpenWranglerRequest,
    { kind: "getPage" | "previewStep" | "applyDraft" | "discardDraft" | "undoStep" }
  >,
  metadata: SessionMetadata
): GridPage {
  return {
    offset: request.offset,
    limit: request.limit,
    totalRows: exactRows(metadata),
    columnIds: metadata.schema
      .slice(request.columnOffset, request.columnOffset + request.columnLimit)
      .map((column) => column.id),
    rows: []
  };
}

export function pageResponseForMetadata(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  metadata: SessionMetadata
): Extract<OpenWranglerResponse, { kind: "page" }> {
  return {
    kind: "page",
    revision: request.revision,
    viewRequestId: request.viewRequestId,
    metadata: {
      ...metadata,
      sessionId: request.sessionId,
      revision: request.revision,
      filterModel: request.filterModel
    },
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

export function exactRows(metadata: SessionMetadata): number {
  const rows = metadata.filteredShape.rows;
  if (rows === null) throw new Error("This exact-page test fixture requires a known row count.");
  return rows;
}

export function stepPreviewResponse(
  revision: number,
  step: TransformStep,
  sessionId = "runtime-session",
  code = "# preview"
): Extract<OpenWranglerResponse, { kind: "stepPreview" }> {
  const opened = openedResponse(sessionId);
  return {
    kind: "stepPreview",
    revision,
    metadata: { ...opened.metadata, revision, draftStep: step },
    page: opened.page,
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

export function stepInspectionResponse(
  request: Extract<OpenWranglerRequest, { kind: "inspectStep" }>,
  stepIndex = 0,
  code = "# inspection"
): Extract<OpenWranglerResponse, { kind: "stepInspection" }> {
  const inspectionPage = {
    offset: request.offset,
    limit: request.limit,
    totalRows: 0,
    columnIds: [],
    rows: []
  };
  return {
    kind: "stepInspection",
    revision: request.revision,
    stepId: request.stepId,
    stepIndex,
    inputPage: inspectionPage,
    outputPage: inspectionPage,
    inputSchema: [],
    outputSchema: [],
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

export function planUpdatedResponse(
  revision: number,
  steps: TransformStep[],
  sessionId = "runtime-session",
  code = "# applied"
): Extract<OpenWranglerResponse, { kind: "planUpdated" }> {
  const opened = openedResponse(sessionId);
  return {
    kind: "planUpdated",
    action: "apply",
    revision,
    metadata: { ...opened.metadata, revision, steps },
    page: opened.page,
    code
  };
}

export function summaryResponse(viewRequestId: string): Extract<OpenWranglerResponse, { kind: "summary" }> {
  return { kind: "summary", revision: 0, viewRequestId, summaries: [] };
}

export function datasetStatsResponse(viewRequestId: string): Extract<OpenWranglerResponse, { kind: "datasetStats" }> {
  return {
    kind: "datasetStats",
    revision: 0,
    viewRequestId,
    stats: { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] }
  };
}

export function setOpenNotebookDocuments(...documents: NotebookDocument[]): void {
  Object.defineProperty(vscode.workspace, "notebookDocuments", {
    configurable: true,
    value: documents
  });
}

export function setOpenTextDocuments(...documents: TextDocument[]): void {
  Object.defineProperty(vscode.workspace, "textDocuments", {
    configurable: true,
    value: documents
  });
}

export function rTextDocument(uri: string): TextDocument {
  return {
    uri: vscode.Uri.parse(uri),
    version: 1,
    isClosed: false,
    isUntitled: false
  } as TextDocument;
}

export function rDocumentSource(document: TextDocument) {
  return {
    kind: "documentVariable" as const,
    label: "orders",
    variableName: "orders",
    uri: document.uri.toString()
  };
}

export function rDocumentOpened(source: ReturnType<typeof rDocumentSource>): SessionOpenedResponse {
  const opened = openedResponse("r-document-runtime", "r");
  return {
    ...opened,
    metadata: {
      ...opened.metadata,
      backend: "r",
      rDataframeFlavor: "r.data.frame",
      source,
      capabilities: {
        editable: true,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false,
        documentInsert: true
      }
    }
  };
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
