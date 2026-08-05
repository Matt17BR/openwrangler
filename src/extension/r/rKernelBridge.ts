import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  PROTOCOL_VERSION,
  type CellValue,
  type ColumnSchema,
  type ErrorResponse,
  type FilterModel,
  type GridPage,
  type OpenSessionRequest,
  type OpenWranglerRequest,
  type OpenWranglerResponse,
  type PageRequest,
  type SessionMetadata,
  type SessionSource,
  type SourceCapabilities
} from "../../shared/protocol";
import { DetachedBridgeRequestError, type BridgeRequestOptions, type OpenWranglerBridge } from "../dataBridge";
import {
  RKernelDiagnosticError,
  RKernelSessionTransport,
  type RKernelOpenResult,
  type RKernelRequestOptions
} from "./rKernelTransport";
import type { RKernelPageWindow, RKernelSortRule } from "./rKernelProtocol";
import {
  R_FRAME_CONTRACT_LIMITS,
  type RDataframeFlavor,
  type RFrameCell,
  type RFramePageContract
} from "./rFrameContract";

const CLOSED_SESSION_LIMIT = 1_024;

const R_CAPABILITIES: SourceCapabilities = Object.freeze({
  editable: false,
  lazy: false,
  cancel: false,
  exportCsv: false,
  exportParquet: false,
  notebookInsert: false,
  filter: false,
  sort: true,
  profile: false,
  columnValues: false
});

/** Narrow transport surface used by the canonical bridge and its contract tests. */
export interface RKernelBridgeTransport {
  readonly onDidInvalidateKernel: vscode.Event<void>;
  open(variableName: string, page: RKernelPageWindow, options?: RKernelRequestOptions): Promise<RKernelOpenResult>;
  getPage(sessionId: string, page: RKernelPageWindow, options?: RKernelRequestOptions): Promise<RFramePageContract>;
  close(sessionId: string, options?: RKernelRequestOptions): Promise<void>;
  isSessionMapped(sessionId: string): boolean;
  dispose(): Promise<void>;
}

interface RBridgeSession {
  readonly sessionId: string;
  readonly source: SessionSource;
  readonly dataframeFlavor: RDataframeFlavor;
  readonly shape: Readonly<{ rows: number; columns: number }>;
  readonly schema: readonly ColumnSchema[];
  invalidated: boolean;
}

/**
 * Adapts the deliberately small native-R kernel contract to protocol v2.
 *
 * The first R slice is read-only. Keeping unsupported requests out of the
 * kernel makes that boundary explicit and prevents accidental Python-style
 * fallbacks while the R operation surface is still being built.
 */
export class RKernelBridge implements OpenWranglerBridge {
  private readonly transport: RKernelBridgeTransport;
  private readonly invalidationSubscription: vscode.Disposable;
  private readonly sessions = new Map<string, RBridgeSession>();
  private readonly openingSessionIds = new Set<string>();
  private readonly closeOperations = new Map<string, Promise<OpenWranglerResponse>>();
  private readonly closedSessionIds = new Set<string>();
  private readonly diagnosticSink: (message: string) => void;
  private readonly runtimeVersion: string;
  private kernelGeneration = 0;
  private idleRequested = false;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    context: vscode.ExtensionContext,
    notebookDocument: vscode.NotebookDocument,
    transport: RKernelBridgeTransport = new RKernelSessionTransport(context, notebookDocument),
    private readonly createSessionId: () => string = randomUUID,
    diagnosticSink?: (message: string) => void
  ) {
    this.transport = transport;
    this.diagnosticSink = diagnosticSink ?? ((message) => appendRDiagnostic(context, message));
    const version = context.extension?.packageJSON?.version;
    this.runtimeVersion = typeof version === "string" && version.length > 0 ? version : "0.0.0";
    this.invalidationSubscription = transport.onDidInvalidateKernel(() => {
      this.kernelGeneration += 1;
      for (const session of this.sessions.values()) session.invalidated = true;
    });
  }

  async request(request: OpenWranglerRequest, options: BridgeRequestOptions = {}): Promise<OpenWranglerResponse> {
    if (this.disposed) throw new Error("The Open Wrangler R bridge has been disposed.");
    this.idleRequested = false;

    switch (request.kind) {
      case "initialize":
        return {
          kind: "initialized",
          protocolVersion: PROTOCOL_VERSION,
          runtimeVersion: this.runtimeVersion,
          capabilities: R_CAPABILITIES
        };
      case "openSession":
        return this.openSession(withHostSessionIdentity(request, this.createSessionId), options);
      case "getPage":
        return this.getPage(request, options);
      case "closeSession":
        return this.closeSession(request.sessionId, options);
      default:
        return unsupportedRequest(request);
    }
  }

  onIdle(): void {
    this.idleRequested = true;
    this.releaseIdleStateIfSafe();
  }

  reportDiagnostic(message: string): void {
    try {
      this.diagnosticSink(message);
    } catch {
      // Diagnostics must not change a request or cleanup outcome.
    }
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.invalidationSubscription.dispose();
      this.disposal = this.disposeOnce();
    }
    return this.disposal;
  }

  private async openSession(request: OpenSessionRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const invalid = validateOpenRequest(request);
    if (invalid) return invalid;
    const sessionId = request.requestedSessionId as string;
    if (
      this.sessions.has(sessionId) ||
      this.openingSessionIds.has(sessionId) ||
      this.closeOperations.has(sessionId) ||
      this.closedSessionIds.has(sessionId)
    ) {
      return errorResponse("duplicate_session", `R session ${sessionId} is already in use.`, false, sessionId);
    }

    this.openingSessionIds.add(sessionId);
    const generation = this.kernelGeneration;
    try {
      const result = await this.transport.open(
        request.source.variableName as string,
        pageWindow(0, request.pageSize, request.columnOffset, request.columnLimit, []),
        transportOptions(options, sessionId)
      );
      if (generation !== this.kernelGeneration) {
        return kernelChangedError(sessionId);
      }
      if (result.sessionId !== sessionId) {
        throw new Error("The R kernel returned a different session identity from the host-owned identity.");
      }
      const session = sessionFromContract(sessionId, request.source, result.page);
      this.sessions.set(sessionId, session);
      return {
        kind: "sessionOpened",
        metadata: metadataFor(session, emptyFilterModel()),
        page: gridPageFromContract(result.page),
        summaries: []
      };
    } catch (error) {
      if (generation !== this.kernelGeneration) return kernelChangedError(sessionId);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, sessionId);
      throw error;
    } finally {
      this.openingSessionIds.delete(sessionId);
    }
  }

  private async getPage(request: PageRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) return unknownSessionError(request.sessionId, request.viewRequestId);
    if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
    if (request.revision !== 0) {
      return errorResponse(
        "stale_revision",
        "This R session is read-only and has revision 0.",
        true,
        request.sessionId,
        request.viewRequestId
      );
    }
    if (request.filterModel.filters.length > 0) return unsupportedRequest(request);

    let sorts: readonly RKernelSortRule[];
    try {
      sorts = resolveSorts(request.filterModel, session.schema);
      validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
    } catch (error) {
      return errorResponse(
        "invalid_view",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId,
        request.viewRequestId
      );
    }

    try {
      const contract = await this.transport.getPage(
        request.sessionId,
        pageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit, sorts),
        transportOptions(options)
      );
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      assertSameSessionContract(session, contract, request);
      return {
        kind: "page",
        revision: 0,
        viewRequestId: request.viewRequestId,
        page: gridPageFromContract(contract),
        metadata: metadataFor(session, copyFilterModel(request.filterModel))
      };
    } catch (error) {
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (error instanceof RKernelDiagnosticError) {
        return diagnosticResponse(error, request.sessionId, request.viewRequestId);
      }
      throw error;
    }
  }

  private async closeSession(sessionId: string, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const existingClose = this.closeOperations.get(sessionId);
    if (existingClose) return existingClose;
    if (this.closedSessionIds.has(sessionId)) return { kind: "sessionClosed", sessionId };
    const session = this.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);

    const completion = this.closeSessionOnce(session, options);
    this.closeOperations.set(sessionId, completion);
    try {
      return await completion;
    } finally {
      this.closeOperations.delete(sessionId);
    }
  }

  private async closeSessionOnce(
    session: RBridgeSession,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const sessionId = session.sessionId;
    if (session.invalidated) {
      this.sessions.delete(sessionId);
      this.rememberClosedSession(sessionId);
      return { kind: "sessionClosed", sessionId };
    }

    try {
      await this.transport.close(sessionId, {
        timeoutMs: options.timeoutMs,
        cancellation: options.cancellation
      });
      this.sessions.delete(sessionId);
      this.rememberClosedSession(sessionId);
      return { kind: "sessionClosed", sessionId };
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError) this.observeDetachedClose(sessionId, error);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, sessionId);
      throw error;
    }
  }

  private observeDetachedClose(sessionId: string, detached: DetachedBridgeRequestError): void {
    void detached.settlement.then(() => {
      if (this.disposed || !this.sessions.has(sessionId)) return;
      if (this.transport.isSessionMapped(sessionId)) {
        this.reportDiagnostic(
          `Open Wrangler could not confirm the late R kernel close for session ${sessionId}; the exact kernel mapping remains retained.`
        );
        return;
      }
      this.sessions.delete(sessionId);
      this.rememberClosedSession(sessionId);
      this.releaseIdleStateIfSafe();
    });
  }

  private rememberClosedSession(sessionId: string): void {
    this.closedSessionIds.add(sessionId);
    while (this.closedSessionIds.size > CLOSED_SESSION_LIMIT) {
      const oldest = this.closedSessionIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.closedSessionIds.delete(oldest);
    }
  }

  private async disposeOnce(): Promise<void> {
    await Promise.allSettled([...this.closeOperations.values()]);
    this.sessions.clear();
    this.openingSessionIds.clear();
    await this.transport.dispose();
  }

  private releaseIdleStateIfSafe(): void {
    if (
      !this.idleRequested ||
      this.disposed ||
      this.sessions.size > 0 ||
      this.openingSessionIds.size > 0 ||
      this.closeOperations.size > 0
    ) {
      return;
    }
    // Transport disposal waits for accepted work and owns its exact-kernel
    // terminal cleanup. Keep failures visible in the R diagnostics channel.
    void this.dispose().catch((error: unknown) => {
      this.reportDiagnostic(
        `Open Wrangler could not finish R kernel cleanup: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}

let rDiagnosticOutput: vscode.OutputChannel | undefined;

function appendRDiagnostic(context: vscode.ExtensionContext, message: string): void {
  if (!rDiagnosticOutput) {
    rDiagnosticOutput = vscode.window.createOutputChannel("Open Wrangler R");
    context.subscriptions.push(rDiagnosticOutput);
  }
  rDiagnosticOutput.appendLine(message);
}

function withHostSessionIdentity(request: OpenSessionRequest, createId: () => string): OpenSessionRequest {
  return request.requestedSessionId ? request : { ...request, requestedSessionId: createId() };
}

function validateOpenRequest(request: OpenSessionRequest): ErrorResponse | undefined {
  const sessionId = request.requestedSessionId;
  if (request.source.kind !== "notebookVariable" || !request.source.variableName) {
    return errorResponse(
      "unsupported_source",
      "R sessions currently open named variables from an R notebook.",
      true,
      sessionId
    );
  }
  if (request.backend !== undefined && request.backend !== "r") {
    return errorResponse("unsupported_backend", "An R notebook session requires the R backend.", true, sessionId);
  }
  if (request.mode !== undefined && request.mode !== "viewing") {
    return errorResponse("unsupported_mode", "R notebook sessions are currently read-only.", true, sessionId);
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return errorResponse(
      "invalid_session_id",
      "The extension host must assign an R session identity before kernel dispatch.",
      false
    );
  }
  try {
    validatePageWindow(0, request.pageSize, request.columnOffset, request.columnLimit);
  } catch (error) {
    return errorResponse("invalid_page", error instanceof Error ? error.message : String(error), true, sessionId);
  }
  return undefined;
}

function validatePageWindow(rowOffset: number, rowLimit: number, columnOffset: number, columnLimit: number): void {
  if (!Number.isSafeInteger(rowOffset) || rowOffset < 0 || rowOffset > R_FRAME_CONTRACT_LIMITS.rows) {
    throw new TypeError("The R row offset is outside the supported range.");
  }
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > R_FRAME_CONTRACT_LIMITS.pageRows) {
    throw new TypeError(`R pages may contain at most ${R_FRAME_CONTRACT_LIMITS.pageRows} rows.`);
  }
  if (!Number.isSafeInteger(columnOffset) || columnOffset < 0 || columnOffset > R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("The R column offset is outside the supported range.");
  }
  if (!Number.isSafeInteger(columnLimit) || columnLimit < 1 || columnLimit > R_FRAME_CONTRACT_LIMITS.pageColumns) {
    throw new TypeError(`R pages may contain at most ${R_FRAME_CONTRACT_LIMITS.pageColumns} columns.`);
  }
  if (rowLimit * columnLimit > R_FRAME_CONTRACT_LIMITS.pageCells) {
    throw new TypeError(`R pages may contain at most ${R_FRAME_CONTRACT_LIMITS.pageCells} cells.`);
  }
}

function pageWindow(
  rowOffset: number,
  rowLimit: number,
  columnOffset: number,
  columnLimit: number,
  sorts: readonly RKernelSortRule[]
): RKernelPageWindow {
  return Object.freeze({ rowOffset, rowLimit, columnOffset, columnLimit, sorts });
}

function resolveSorts(filterModel: FilterModel, schema: readonly ColumnSchema[]): readonly RKernelSortRule[] {
  if (filterModel.sort.length > R_FRAME_CONTRACT_LIMITS.sortRules) {
    throw new TypeError(`R views support at most ${R_FRAME_CONTRACT_LIMITS.sortRules} sort rules.`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    filterModel.sort.map((rule) => {
      const matches = schema.filter((column) => column.name === rule.column);
      if (matches.length !== 1) {
        throw new TypeError(
          matches.length === 0
            ? `The sort column ${JSON.stringify(rule.column)} is no longer in this R dataframe.`
            : `The sort column ${JSON.stringify(rule.column)} is ambiguous because that name is repeated.`
        );
      }
      const column = matches[0] as ColumnSchema;
      if (seen.has(column.id)) throw new TypeError(`The sort column ${JSON.stringify(rule.column)} is repeated.`);
      seen.add(column.id);
      return Object.freeze({
        column: Object.freeze({ id: column.id, name: column.name }),
        direction: rule.direction,
        nulls: rule.nulls
      });
    })
  );
}

function sessionFromContract(sessionId: string, source: SessionSource, contract: RFramePageContract): RBridgeSession {
  const schema = Object.freeze(
    contract.schema.map<ColumnSchema>((column) =>
      Object.freeze({
        id: column.id,
        name: column.name,
        position: column.position,
        rawType: column.rawType,
        type: column.type,
        nullable: column.nullable
      })
    )
  );
  return {
    sessionId,
    source: copySource(source),
    dataframeFlavor: contract.dataframeFlavor,
    shape: Object.freeze({ ...contract.shape }),
    schema,
    invalidated: false
  };
}

function metadataFor(session: RBridgeSession, filterModel: FilterModel): SessionMetadata {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: session.sessionId,
    revision: 0,
    backend: "r",
    rDataframeFlavor: session.dataframeFlavor,
    mode: "viewing",
    source: copySource(session.source),
    capabilities: R_CAPABILITIES,
    shape: { ...session.shape },
    filteredShape: { ...session.shape },
    schema: session.schema.map((column) => ({ ...column })),
    filterModel,
    steps: []
  };
}

function gridPageFromContract(contract: RFramePageContract): GridPage {
  return {
    offset: contract.page.offset,
    limit: contract.page.limit,
    totalRows: contract.page.totalRows,
    columnIds: [...contract.page.columnIds],
    rows: contract.page.rows.map((row) => ({
      id: row.id,
      rowNumber: row.rowNumber,
      values: row.values.map(cellValueFromR)
    }))
  };
}

function cellValueFromR(cell: RFrameCell): CellValue {
  if (cell.kind === "number") {
    const raw = Number(cell.raw);
    if (!Number.isFinite(raw)) throw new TypeError("The R frame returned a non-finite value as a finite double.");
    return { ...cell, raw };
  }
  return { ...cell };
}

function assertSameSessionContract(session: RBridgeSession, contract: RFramePageContract, request: PageRequest): void {
  if (
    contract.dataframeFlavor !== session.dataframeFlavor ||
    contract.shape.rows !== session.shape.rows ||
    contract.shape.columns !== session.shape.columns ||
    contract.page.offset !== request.offset ||
    contract.page.limit !== request.limit ||
    contract.page.totalRows !== session.shape.rows ||
    contract.page.columnOffset !== request.columnOffset ||
    contract.page.columnLimit !== request.columnLimit ||
    !sameSchema(session.schema, contract.schema)
  ) {
    throw new Error("The R dataframe contract changed during a read-only session.");
  }
}

function sameSchema(expected: readonly ColumnSchema[], actual: RFramePageContract["schema"]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((column, index) => {
      const candidate = actual[index];
      return (
        candidate !== undefined &&
        candidate.id === column.id &&
        candidate.name === column.name &&
        candidate.position === column.position &&
        candidate.rawType === column.rawType &&
        candidate.type === column.type &&
        candidate.nullable === column.nullable
      );
    })
  );
}

function transportOptions(options: BridgeRequestOptions, requestedSessionId?: string): RKernelRequestOptions {
  return {
    cancellation: options.cancellation,
    timeoutMs: options.timeoutMs,
    ...(requestedSessionId ? { requestedSessionId } : {})
  };
}

function copySource(source: SessionSource): SessionSource {
  return {
    ...source,
    ...(source.importOptions ? { importOptions: { ...source.importOptions } } : {})
  };
}

function emptyFilterModel(): FilterModel {
  return { filters: [], sort: [] };
}

function copyFilterModel(model: FilterModel): FilterModel {
  return {
    ...(model.logic ? { logic: model.logic } : {}),
    filters: model.filters.map((filter) => ({
      ...filter,
      predicates: filter.predicates.map((predicate) => ({ ...predicate })),
      ...(filter.valueFilter
        ? { valueFilter: { ...filter.valueFilter, selectedValues: [...filter.valueFilter.selectedValues] } }
        : {})
    })),
    sort: model.sort.map((rule) => ({ ...rule }))
  };
}

function unsupportedRequest(request: OpenWranglerRequest): ErrorResponse {
  const sessionId = "sessionId" in request ? request.sessionId : undefined;
  const viewRequestId = "viewRequestId" in request ? request.viewRequestId : undefined;
  return errorResponse(
    "unsupported_operation",
    "This operation is not available for read-only R sessions yet.",
    true,
    sessionId,
    viewRequestId
  );
}

function unknownSessionError(sessionId: string, viewRequestId?: string): ErrorResponse {
  return errorResponse(
    "unknown_session",
    `Open Wrangler has no live R session named ${sessionId}.`,
    true,
    sessionId,
    viewRequestId
  );
}

function kernelChangedError(sessionId: string, viewRequestId?: string): ErrorResponse {
  return errorResponse(
    "r_kernel_changed",
    "The originating R kernel changed. Reopen the variable from its notebook.",
    true,
    sessionId,
    viewRequestId
  );
}

function diagnosticResponse(error: RKernelDiagnosticError, sessionId?: string, viewRequestId?: string): ErrorResponse {
  return errorResponse(
    error.diagnostic.code,
    error.diagnostic.message,
    error.diagnostic.recoverable,
    sessionId,
    viewRequestId
  );
}

function errorResponse(
  code: string,
  message: string,
  recoverable: boolean,
  sessionId?: string,
  viewRequestId?: string
): ErrorResponse {
  return {
    kind: "error",
    code,
    message,
    recoverable,
    ...(sessionId ? { sessionId } : {}),
    ...(viewRequestId ? { viewRequestId } : {})
  };
}
