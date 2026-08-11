import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import { supportsViewPredicate } from "../../shared/filterModel";
import {
  PROTOCOL_VERSION,
  type CellValue,
  type CastColumnTransformStep,
  type CapitalizeTextTransformStep,
  type CloneColumnTransformStep,
  type ColumnSchema,
  type ColumnSummary,
  type DataDiff,
  type DatasetStatsRequest,
  type DropColumnsTransformStep,
  type DropDuplicatesTransformStep,
  type DropMissingRowsTransformStep,
  type ErrorResponse,
  type ExportDataRequest,
  type CeilNumberTransformStep,
  type FindReplaceTransformStep,
  type FillMissingReplacement,
  type FillMissingValuesTransformStep,
  type FilterModel,
  type FilterRowsTransformStep,
  type FloorNumberTransformStep,
  type GridPage,
  type GroupByTransformStep,
  type InspectStepRequest,
  type LowerTextTransformStep,
  type OpenSessionRequest,
  type OperationKind,
  type OpenWranglerRequest,
  type OpenWranglerResponse,
  type PageRequest,
  type PreviewStepRequest,
  type RenameColumnTransformStep,
  type RetainedTransformStep,
  type RoundNumberTransformStep,
  type SelectColumnsTransformStep,
  type SessionMetadata,
  type SessionMode,
  type SessionSource,
  type SummaryRequest,
  type SortRowsTransformStep,
  type SplitTextTransformStep,
  type StripTextTransformStep,
  type TextLengthTransformStep,
  type UpperTextTransformStep,
  type SourceCapabilities,
  type ValueCount,
  type ValuesRequest
} from "../../shared/protocol";
import { DetachedBridgeRequestError, type BridgeRequestOptions, type OpenWranglerBridge } from "../dataBridge";
import { beginAtomicFileTransaction, type AtomicFileTransaction } from "../files/safeFileExport";
import {
  RKernelDiagnosticError,
  RKernelSessionTransport,
  type RKernelOpenResult,
  type RKernelRequestOptions
} from "./rKernelTransport";
import type {
  RKernelColumnFilter,
  RKernelColumnReference,
  RKernelDataExportResult,
  RKernelDatasetStatsResult,
  RKernelExportFormat,
  RKernelGroupByStep,
  RKernelPageWindow,
  RKernelPlanUpdatedResult,
  RKernelFillMissingReplacement,
  RKernelTransformStep,
  RKernelSortRule,
  RKernelStepInspectionResult,
  RKernelStepPreviewResult,
  RKernelTransformFilterModel,
  RKernelViewQuery
} from "./rKernelProtocol";
import {
  R_FRAME_CONTRACT_LIMITS,
  type RColumnSchema,
  type RColumnType,
  type RDataframeFlavor,
  type RFrameCell,
  type RFramePageContract
} from "./rFrameContract";
import {
  claimVerifiedRNotebookVariableSelection,
  type RNotebookVariableDescriptor,
  type VerifiedRNotebookVariableSelection
} from "./rNotebookVariableDiscovery";

const CLOSED_SESSION_LIMIT = 1_024;
const R_DATA_EXPORT_TIMEOUT_MS = 30 * 60_000;
const R_PRIVATE_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_";
const R_SUPPORTED_OPERATIONS = Object.freeze([
  "sortRows",
  "filterRows",
  "dropMissingRows",
  "fillMissingValues",
  "dropDuplicates",
  "selectColumns",
  "dropColumns",
  "renameColumn",
  "cloneColumn",
  "castColumn",
  "textLength",
  "findReplace",
  "stripText",
  "splitText",
  "capitalizeText",
  "lowerText",
  "upperText",
  "roundNumber",
  "floorNumber",
  "ceilNumber",
  "groupBy"
] as OperationKind[]) as OperationKind[];

type RTransformStep =
  | SortRowsTransformStep
  | FilterRowsTransformStep
  | DropMissingRowsTransformStep
  | FillMissingValuesTransformStep
  | DropDuplicatesTransformStep
  | RenameColumnTransformStep
  | CloneColumnTransformStep
  | CastColumnTransformStep
  | TextLengthTransformStep
  | FindReplaceTransformStep
  | StripTextTransformStep
  | SplitTextTransformStep
  | CapitalizeTextTransformStep
  | LowerTextTransformStep
  | UpperTextTransformStep
  | RoundNumberTransformStep
  | FloorNumberTransformStep
  | CeilNumberTransformStep
  | GroupByTransformStep
  | DropColumnsTransformStep
  | SelectColumnsTransformStep;

const R_BASE_CAPABILITIES = Object.freeze({
  editable: true,
  lazy: false,
  cancel: false,
  exportCsv: false,
  exportParquet: false,
  filter: true,
  sort: true,
  profile: true,
  columnValues: true,
  supportedOperations: R_SUPPORTED_OPERATIONS
} satisfies Omit<SourceCapabilities, "notebookInsert" | "documentInsert">);

const R_BRIDGE_CAPABILITIES: SourceCapabilities = Object.freeze({
  ...R_BASE_CAPABILITIES,
  notebookInsert: true,
  documentInsert: true
});

export interface RKernelBridgeFileOperations {
  readonly beginTransaction?: typeof beginAtomicFileTransaction;
}

/** Narrow transport surface used by the canonical bridge and its contract tests. */
export interface RKernelBridgeTransport {
  readonly onDidInvalidateKernel: vscode.Event<void>;
  open(variableName: string, page: RKernelPageWindow, options?: RKernelRequestOptions): Promise<RKernelOpenResult>;
  getPage(sessionId: string, page: RKernelPageWindow, options?: RKernelRequestOptions): Promise<RFramePageContract>;
  getSummary(
    sessionId: string,
    columns: readonly RKernelColumnReference[],
    view: RKernelViewQuery,
    options?: RKernelRequestOptions
  ): Promise<readonly ColumnSummary[]>;
  getDatasetStats(
    sessionId: string,
    view: RKernelViewQuery,
    options?: RKernelRequestOptions
  ): Promise<RKernelDatasetStatsResult>;
  getColumnValues(
    sessionId: string,
    column: RKernelColumnReference,
    view: RKernelViewQuery,
    search: string | undefined,
    limit: number,
    options?: RKernelRequestOptions
  ): Promise<Readonly<{ column: string; values: readonly ValueCount[]; hasMore: boolean; sampleSize?: number }>>;
  previewStep(
    sessionId: string,
    revision: number,
    step: RKernelTransformStep,
    page: RKernelPageWindow,
    inputSchema: readonly RColumnSchema[],
    replaceStepId?: string,
    options?: RKernelRequestOptions
  ): Promise<RKernelStepPreviewResult>;
  applyDraft(
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options?: RKernelRequestOptions
  ): Promise<RKernelPlanUpdatedResult>;
  discardDraft(
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options?: RKernelRequestOptions
  ): Promise<RKernelPlanUpdatedResult>;
  undoStep(
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options?: RKernelRequestOptions
  ): Promise<RKernelPlanUpdatedResult>;
  inspectStep(
    sessionId: string,
    revision: number,
    stepId: string,
    page: RKernelPageWindow,
    inputSchema: readonly RColumnSchema[],
    outputSchema: readonly RColumnSchema[],
    options?: RKernelRequestOptions
  ): Promise<RKernelStepInspectionResult>;
  exportData?(
    sessionId: string,
    revision: number,
    format: RKernelExportFormat,
    writeChunk: (chunk: Uint8Array) => Promise<void>,
    options?: RKernelRequestOptions
  ): Promise<RKernelDataExportResult>;
  close(sessionId: string, options?: RKernelRequestOptions): Promise<void>;
  isSessionMapped(sessionId: string): boolean;
  dispose(): Promise<void>;
}

interface RBridgeSession {
  readonly sessionId: string;
  readonly source: SessionSource;
  readonly dataframeFlavor: RDataframeFlavor;
  /** Original source row count and initial row-identity domain. */
  readonly sourceRows: number;
  readonly sourceSchema: readonly ColumnSchema[];
  readonly sourceRSchema: readonly RColumnSchema[];
  readonly sourceKeyColumnIds: readonly string[];
  readonly exportCsv: boolean;
  readonly exportParquet: boolean;
  readonly sourceRowNames: RFramePageContract["frameSemantics"]["rowNames"];
  rowNames: RFramePageContract["frameSemantics"]["rowNames"];
  mode: SessionMode;
  revision: number;
  schema: readonly ColumnSchema[];
  rSchema: readonly RColumnSchema[];
  committedSchema: readonly ColumnSchema[];
  committedRSchema: readonly RColumnSchema[];
  committedRows: number;
  committedIdentityRows: number;
  committedKeyColumnIds: readonly string[];
  filterModel: FilterModel;
  rows: number;
  identityRows: number;
  keyColumnIds: readonly string[];
  steps: readonly RetainedTransformStep[];
  planInputSchemas: readonly (readonly ColumnSchema[])[];
  planInputRSchemas: readonly (readonly RColumnSchema[])[];
  planInputRows: readonly number[];
  planInputIdentityRows: readonly number[];
  planInputKeyColumnIds: readonly (readonly string[])[];
  draftStep?: RTransformStep;
  draftReplacesStepId?: string;
  draftInputSchema?: readonly ColumnSchema[];
  draftInputRSchema?: readonly RColumnSchema[];
  draftInputRows?: number;
  draftInputIdentityRows?: number;
  draftInputKeyColumnIds?: readonly string[];
  draftBaseFilterModel?: FilterModel;
  draftBaseViewChangeEpoch?: number;
  viewChangeEpoch: number;
  lastAppliedViewRestore?: Readonly<{
    stepId: string;
    before: FilterModel;
    after: FilterModel;
    viewChangeEpoch: number;
  }>;
  invalidated: boolean;
}

/**
 * Adapts the native-R kernel contract to protocol v2 without converting the
 * dataframe through Python.
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
  private readonly beginFileTransaction: typeof beginAtomicFileTransaction;
  private kernelGeneration = 0;
  private idleRequested = false;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  static fromVerifiedSelection(
    context: vscode.ExtensionContext,
    notebookDocument: vscode.NotebookDocument,
    verifiedSelection: VerifiedRNotebookVariableSelection,
    diagnosticSink?: (message: string) => void
  ): RKernelBridge {
    const binding = claimVerifiedRNotebookVariableSelection(notebookDocument, verifiedSelection);
    try {
      const transport = new RKernelSessionTransport(context, notebookDocument, randomUUID, randomUUID(), binding);
      return new RKernelBridge(context, transport, randomUUID, diagnosticSink, binding.variable);
    } catch (error) {
      binding.dispose();
      throw error;
    }
  }

  constructor(
    context: vscode.ExtensionContext,
    transport: RKernelBridgeTransport,
    private readonly createSessionId: () => string = randomUUID,
    diagnosticSink?: (message: string) => void,
    private readonly verifiedVariable?: RNotebookVariableDescriptor,
    fileOperations: RKernelBridgeFileOperations = {}
  ) {
    this.transport = transport;
    this.diagnosticSink = diagnosticSink ?? ((message) => appendRDiagnostic(context, message));
    const version = context.extension?.packageJSON?.version;
    this.runtimeVersion = typeof version === "string" && version.length > 0 ? version : "0.0.0";
    this.beginFileTransaction = fileOperations.beginTransaction ?? beginAtomicFileTransaction;
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
          capabilities: R_BRIDGE_CAPABILITIES
        };
      case "openSession":
        return this.openSession(withHostSessionIdentity(request, this.createSessionId), options);
      case "getPage":
        return this.getPage(request, options);
      case "getSummary":
        return this.getSummary(request, options);
      case "getDatasetStats":
        return this.getDatasetStats(request, options);
      case "getColumnValues":
        return this.getColumnValues(request, options);
      case "previewStep":
        return this.previewStep(request, options);
      case "applyDraft":
      case "discardDraft":
      case "undoStep":
        return this.updatePlan(request, options);
      case "inspectStep":
        return this.inspectStep(request, options);
      case "exportData":
        return this.exportData(request, options);
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
    if (this.verifiedVariable && request.source.variableName !== this.verifiedVariable.name) {
      return errorResponse(
        "r_variable_changed",
        "The R variable no longer matches the selected dataframe.",
        true,
        sessionId
      );
    }
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
        pageWindow(0, request.pageSize, request.columnOffset, request.columnLimit, emptyRViewQuery()),
        transportOptions(options, sessionId)
      );
      if (generation !== this.kernelGeneration) {
        return kernelChangedError(sessionId);
      }
      if (result.sessionId !== sessionId) {
        throw new Error("The R kernel returned a different session identity from the host-owned identity.");
      }
      if (this.verifiedVariable && result.page.dataframeFlavor !== this.verifiedVariable.dataframeFlavor) {
        throw new Error("The selected R dataframe changed before Open Wrangler opened it.");
      }
      const session = sessionFromContract(
        sessionId,
        request.source,
        request.mode ?? "viewing",
        result.page,
        isExportableRSource(request.source) && this.transport.exportData !== undefined ? result.exportFormats : []
      );
      this.sessions.set(sessionId, session);
      return {
        kind: "sessionOpened",
        metadata: metadataFor(session),
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
    const stale = staleRevisionError(session, request.revision, request.viewRequestId);
    if (stale) return stale;
    const expectedRevision = session.revision;
    const expectedSchema = session.schema;
    let view: RKernelViewQuery;
    try {
      view = resolveViewQuery(request.filterModel, session.schema);
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
        pageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit, view),
        transportOptions(options)
      );
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (session.revision !== expectedRevision || session.schema !== expectedSchema) {
        return staleResponseError(request.sessionId, request.viewRequestId);
      }
      assertSessionContract(
        session,
        contract,
        request,
        expectedSchema,
        session.rows,
        session.identityRows,
        session.keyColumnIds,
        session.rowNames,
        view
      );
      const nextFilterModel = copyFilterModel(request.filterModel);
      if (!isDeepStrictEqual(session.filterModel, nextFilterModel)) session.viewChangeEpoch += 1;
      session.filterModel = nextFilterModel;
      return {
        kind: "page",
        revision: session.revision,
        viewRequestId: request.viewRequestId,
        page: gridPageFromContract(contract),
        metadata: metadataFor(session, contract.page.totalRows)
      };
    } catch (error) {
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (error instanceof RKernelDiagnosticError) {
        return diagnosticResponse(error, request.sessionId, request.viewRequestId);
      }
      throw error;
    }
  }

  private async getSummary(request: SummaryRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    const invalid = validateProfileRequest(request, session);
    if (invalid) return invalid;
    const confirmed = session as RBridgeSession;
    const expectedRevision = confirmed.revision;
    const expectedSchema = confirmed.schema;
    const requestedIds = request.columnIds ?? confirmed.schema.map((column) => column.id);
    if (requestedIds.length === 0) {
      return { kind: "summary", revision: confirmed.revision, viewRequestId: request.viewRequestId, summaries: [] };
    }
    if (requestedIds.length > R_FRAME_CONTRACT_LIMITS.profileColumns) {
      return errorResponse(
        "profile_too_large",
        `R profile requests may contain at most ${R_FRAME_CONTRACT_LIMITS.profileColumns} columns.`,
        true,
        request.sessionId,
        request.viewRequestId
      );
    }

    let columns: readonly RKernelColumnReference[];
    let view: RKernelViewQuery;
    try {
      columns = resolveProfileColumns(requestedIds, confirmed.schema);
      view = resolveViewQuery(request.filterModel, confirmed.schema);
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
      const summaries = await this.transport.getSummary(request.sessionId, columns, view, transportOptions(options));
      if (confirmed.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (confirmed.revision !== expectedRevision || confirmed.schema !== expectedSchema) {
        return staleResponseError(request.sessionId, request.viewRequestId);
      }
      assertSummaryContract(confirmed, columns, summaries, view);
      return {
        kind: "summary",
        revision: confirmed.revision,
        viewRequestId: request.viewRequestId,
        summaries: summaries.map((summary) => ({ ...summary }))
      };
    } catch (error) {
      if (confirmed.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (error instanceof RKernelDiagnosticError) {
        return diagnosticResponse(error, request.sessionId, request.viewRequestId);
      }
      throw error;
    }
  }

  private async getDatasetStats(
    request: DatasetStatsRequest,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    const invalid = validateProfileRequest(request, session);
    if (invalid) return invalid;
    const confirmed = session as RBridgeSession;
    const expectedRevision = confirmed.revision;
    const expectedSchema = confirmed.schema;
    let view: RKernelViewQuery;
    try {
      view = resolveViewQuery(request.filterModel, confirmed.schema);
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
      const result = await this.transport.getDatasetStats(request.sessionId, view, transportOptions(options));
      if (confirmed.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (confirmed.revision !== expectedRevision || confirmed.schema !== expectedSchema) {
        return staleResponseError(request.sessionId, request.viewRequestId);
      }
      assertDatasetStatsContract(confirmed, result, view);
      return {
        kind: "datasetStats",
        revision: confirmed.revision,
        viewRequestId: request.viewRequestId,
        stats: {
          ...result.stats,
          missingValuesByColumn: result.stats.missingValuesByColumn.map((entry) => ({ ...entry }))
        }
      };
    } catch (error) {
      if (confirmed.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (error instanceof RKernelDiagnosticError) {
        return diagnosticResponse(error, request.sessionId, request.viewRequestId);
      }
      throw error;
    }
  }

  private async getColumnValues(request: ValuesRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) return unknownSessionError(request.sessionId, request.viewRequestId);
    if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
    const stale = staleRevisionError(session, request.revision, request.viewRequestId);
    if (stale) return stale;
    const expectedRevision = session.revision;
    const expectedSchema = session.schema;

    let column: RKernelColumnReference;
    let view: RKernelViewQuery;
    try {
      column = resolveNamedColumn(request.column, session.schema, "values");
      view = resolveViewQuery(request.filterModel, session.schema);
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
      const result = await this.transport.getColumnValues(
        request.sessionId,
        column,
        view,
        request.search,
        request.limit,
        transportOptions(options)
      );
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (session.revision !== expectedRevision || session.schema !== expectedSchema) {
        return staleResponseError(request.sessionId, request.viewRequestId);
      }
      assertColumnValuesContract(session, column, result, request.limit, request.search);
      return {
        kind: "columnValues",
        revision: session.revision,
        viewRequestId: request.viewRequestId,
        column: result.column,
        values: result.values.map((entry) => ({ ...entry })),
        hasMore: result.hasMore,
        ...(result.sampleSize === undefined ? {} : { sampleSize: result.sampleSize })
      };
    } catch (error) {
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (error instanceof RKernelDiagnosticError) {
        return diagnosticResponse(error, request.sessionId, request.viewRequestId);
      }
      throw error;
    }
  }

  private async previewStep(request: PreviewStepRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    const invalid = validateMutationRequest(session, request.revision, request);
    if (invalid) return invalid;
    const confirmed = session as RBridgeSession;
    if (confirmed.draftStep) {
      return errorResponse(
        "invalid_request",
        "Apply or discard the current R draft before previewing another step.",
        true,
        request.sessionId
      );
    }
    if (
      request.step.kind !== "sortRows" &&
      request.step.kind !== "filterRows" &&
      request.step.kind !== "dropMissingRows" &&
      request.step.kind !== "fillMissingValues" &&
      request.step.kind !== "dropDuplicates" &&
      request.step.kind !== "renameColumn" &&
      request.step.kind !== "cloneColumn" &&
      request.step.kind !== "castColumn" &&
      request.step.kind !== "textLength" &&
      request.step.kind !== "findReplace" &&
      request.step.kind !== "stripText" &&
      request.step.kind !== "splitText" &&
      request.step.kind !== "capitalizeText" &&
      request.step.kind !== "lowerText" &&
      request.step.kind !== "upperText" &&
      request.step.kind !== "roundNumber" &&
      request.step.kind !== "floorNumber" &&
      request.step.kind !== "ceilNumber" &&
      request.step.kind !== "groupBy" &&
      request.step.kind !== "dropColumns" &&
      request.step.kind !== "selectColumns"
    ) {
      return errorResponse(
        "unsupported_operation",
        `The native R runtime does not support ${request.step.kind}.`,
        true,
        request.sessionId
      );
    }

    let inputSchema: readonly ColumnSchema[];
    let inputRSchema: readonly RColumnSchema[];
    let inputRows: number;
    let inputIdentityRows: number;
    let inputKeyColumnIds: readonly string[];
    let inputRowNames: RFramePageContract["frameSemantics"]["rowNames"];
    if (request.replaceStepId !== undefined) {
      const latest = confirmed.steps.at(-1);
      if (!latest || latest.id !== request.replaceStepId || request.step.id !== request.replaceStepId) {
        return errorResponse(
          "invalid_request",
          "Only the latest applied R step can be edited, and it must retain its step ID.",
          true,
          request.sessionId
        );
      }
      inputSchema = confirmed.planInputSchemas.at(-1) ?? confirmed.committedSchema;
      inputRSchema = confirmed.planInputRSchemas.at(-1) ?? confirmed.committedRSchema;
      inputRows = confirmed.planInputRows.at(-1) ?? confirmed.committedRows;
      inputIdentityRows = confirmed.planInputIdentityRows.at(-1) ?? confirmed.committedIdentityRows;
      inputKeyColumnIds = confirmed.planInputKeyColumnIds.at(-1) ?? confirmed.committedKeyColumnIds;
      inputRowNames = rowNamesAfterPlan(confirmed.sourceRowNames, confirmed.steps.slice(0, -1));
    } else {
      if (confirmed.steps.some((step) => step.id === request.step.id)) {
        return errorResponse("invalid_request", "Applied R step IDs must be unique.", true, request.sessionId);
      }
      inputSchema = confirmed.committedSchema;
      inputRSchema = confirmed.committedRSchema;
      inputRows = confirmed.committedRows;
      inputIdentityRows = confirmed.committedIdentityRows;
      inputKeyColumnIds = confirmed.committedKeyColumnIds;
      inputRowNames = rowNamesAfterPlan(confirmed.sourceRowNames, confirmed.steps);
    }

    let targetSchema: readonly ColumnSchema[];
    let targetKeyColumnIds: readonly string[];
    let nextFilterModel: FilterModel;
    let view: RKernelViewQuery;
    let rStep: RKernelTransformStep;
    let targetRowNames: RFramePageContract["frameSemantics"]["rowNames"];
    try {
      targetSchema = schemaAfterRStep(inputSchema, request.step, inputKeyColumnIds);
      targetKeyColumnIds = keyColumnsAfterRStep(inputKeyColumnIds, targetSchema, request.step);
      rStep = rTransformStep(request.step, inputSchema);
      targetRowNames = rowNamesAfterRStep(inputRowNames, request.step);
      nextFilterModel = reconcileFilterModelById(confirmed.filterModel, confirmed.schema, targetSchema);
      view = resolveViewQuery(nextFilterModel, targetSchema);
      validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId
      );
    }

    const expectedRevision = confirmed.revision;
    const expectedSchema = confirmed.schema;
    const draftBaseFilterModel = copyFilterModel(confirmed.filterModel);
    const draftBaseViewChangeEpoch = confirmed.viewChangeEpoch;
    try {
      const result = await this.transport.previewStep(
        request.sessionId,
        expectedRevision,
        rStep,
        pageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit, view),
        inputRSchema,
        request.replaceStepId,
        transportOptions(options)
      );
      if (confirmed.invalidated) return kernelChangedError(request.sessionId);
      if (result.sessionId !== request.sessionId || result.revision !== expectedRevision + 1) {
        throw new Error("The R kernel returned a mismatched step preview.");
      }
      if (confirmed.revision !== expectedRevision || confirmed.schema !== expectedSchema) {
        confirmed.invalidated = true;
        return staleResponseError(request.sessionId);
      }
      const targetRows = rowCountAfterRStep(request.step, inputRows, result.diff);
      const targetIdentityRows = rowIdentityDomainAfterRStep(request.step, inputIdentityRows, targetRows);
      assertMutationContract(
        confirmed,
        result.page,
        request,
        targetSchema,
        targetRows,
        targetIdentityRows,
        targetKeyColumnIds,
        targetRowNames,
        view,
        request.step.kind === "castColumn"
          ? { columnId: request.step.params.column.id, mode: "mayAdd" }
          : request.step.kind === "splitText"
            ? { columnId: `c:step:${request.step.id}:0`, mode: "mayAdd" }
            : request.step.kind === "fillMissingValues" && request.step.params.replacement.kind === "fallbackColumns"
              ? { columnId: request.step.params.column.id, mode: "mayRemove" }
              : undefined
      );
      assertMutationDiff(request.step, inputSchema, targetSchema, inputRows, targetRows, result.page, result.diff);
      if ((request.step.kind === "fillMissingValues") !== (result.remainingMissingCells !== undefined)) {
        throw new Error("The R kernel returned a missing-value count for the wrong draft operation.");
      }
      if (result.remainingMissingCells !== undefined && result.remainingMissingCells > targetRows) {
        throw new Error("The R kernel returned more missing values than rows in the dataframe.");
      }

      confirmed.revision = result.revision;
      confirmed.schema = schemaFromContract(result.page);
      confirmed.rSchema = result.page.schema;
      confirmed.rows = targetRows;
      confirmed.identityRows = targetIdentityRows;
      confirmed.keyColumnIds = Object.freeze([...targetKeyColumnIds]);
      confirmed.rowNames = targetRowNames;
      confirmed.filterModel = nextFilterModel;
      confirmed.draftStep = copyRTransformStep(request.step);
      confirmed.draftReplacesStepId = request.replaceStepId;
      confirmed.draftInputSchema = copySchema(inputSchema);
      confirmed.draftInputRSchema = inputRSchema;
      confirmed.draftInputRows = inputRows;
      confirmed.draftInputIdentityRows = inputIdentityRows;
      confirmed.draftInputKeyColumnIds = Object.freeze([...inputKeyColumnIds]);
      confirmed.draftBaseFilterModel = draftBaseFilterModel;
      confirmed.draftBaseViewChangeEpoch = draftBaseViewChangeEpoch;
      const fallbackFillTargetId =
        request.step.kind === "fillMissingValues" && request.step.params.replacement.kind === "fallbackColumns"
          ? request.step.params.column.id
          : undefined;
      return {
        kind: "stepPreview",
        revision: confirmed.revision,
        metadata: metadataFor(confirmed, result.page.page.totalRows),
        page: gridPageFromContract(result.page),
        diff: copyDiff(result.diff),
        code: result.code,
        ...(result.remainingMissingCells === undefined ? {} : { remainingMissingCells: result.remainingMissingCells }),
        warnings:
          fallbackFillTargetId !== undefined &&
          result.page.schema.find((column) => column.id === fallbackFillTargetId)?.nullable === true
            ? ["Some values are still missing because every selected fallback column is missing in those rows."]
            : []
      };
    } catch (error) {
      if (confirmed.invalidated) return kernelChangedError(request.sessionId);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, request.sessionId);
      confirmed.invalidated = true;
      throw error;
    }
  }

  private async updatePlan(
    request: Extract<OpenWranglerRequest, { kind: "applyDraft" | "discardDraft" | "undoStep" }>,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    const invalid = validateMutationRequest(session, request.revision, request);
    if (invalid) return invalid;
    const confirmed = session as RBridgeSession;

    let targetSchema: readonly ColumnSchema[];
    let targetRSchema: readonly RColumnSchema[];
    let targetRows: number;
    let targetIdentityRows: number;
    let targetKeyColumnIds: readonly string[];
    let targetRowNames: RFramePageContract["frameSemantics"]["rowNames"];
    let nextFilterModel: FilterModel;
    if (request.kind === "applyDraft") {
      if (
        !confirmed.draftStep ||
        !confirmed.draftInputSchema ||
        !confirmed.draftInputRSchema ||
        confirmed.draftInputRows === undefined ||
        confirmed.draftInputIdentityRows === undefined ||
        !confirmed.draftInputKeyColumnIds
      ) {
        return errorResponse("invalid_request", "There is no R draft step to apply.", true, request.sessionId);
      }
      targetSchema = confirmed.schema;
      targetRSchema = confirmed.rSchema;
      targetRows = confirmed.rows;
      targetIdentityRows = confirmed.identityRows;
      targetKeyColumnIds = confirmed.keyColumnIds;
      targetRowNames = confirmed.rowNames;
      nextFilterModel = copyFilterModel(confirmed.filterModel);
    } else if (request.kind === "discardDraft") {
      if (
        !confirmed.draftStep ||
        !confirmed.draftInputSchema ||
        !confirmed.draftInputRSchema ||
        confirmed.draftInputRows === undefined ||
        confirmed.draftInputIdentityRows === undefined ||
        !confirmed.draftInputKeyColumnIds
      ) {
        return errorResponse("invalid_request", "There is no R draft step to discard.", true, request.sessionId);
      }
      targetSchema = confirmed.committedSchema;
      targetRSchema = confirmed.committedRSchema;
      targetRows = confirmed.committedRows;
      targetIdentityRows = confirmed.committedIdentityRows;
      targetKeyColumnIds = confirmed.committedKeyColumnIds;
      targetRowNames = rowNamesAfterPlan(confirmed.sourceRowNames, confirmed.steps);
      nextFilterModel =
        confirmed.draftBaseViewChangeEpoch === confirmed.viewChangeEpoch && confirmed.draftBaseFilterModel
          ? copyFilterModel(confirmed.draftBaseFilterModel)
          : reconcileFilterModelById(confirmed.filterModel, confirmed.schema, targetSchema);
    } else {
      if (confirmed.draftStep) {
        return errorResponse(
          "invalid_request",
          "Discard the R draft before undoing an applied step.",
          true,
          request.sessionId
        );
      }
      if (confirmed.steps.length === 0) {
        return errorResponse("invalid_request", "There is no applied R step to undo.", true, request.sessionId);
      }
      targetSchema = confirmed.planInputSchemas.at(-1) ?? confirmed.sourceSchema;
      targetRSchema = confirmed.planInputRSchemas.at(-1) ?? confirmed.sourceRSchema;
      targetRows = confirmed.planInputRows.at(-1) ?? confirmed.sourceRows;
      targetIdentityRows = confirmed.planInputIdentityRows.at(-1) ?? confirmed.sourceRows;
      targetKeyColumnIds = confirmed.planInputKeyColumnIds.at(-1) ?? confirmed.sourceKeyColumnIds;
      targetRowNames = rowNamesAfterPlan(confirmed.sourceRowNames, confirmed.steps.slice(0, -1));
      const latest = confirmed.steps.at(-1) as RetainedTransformStep;
      const restore = confirmed.lastAppliedViewRestore;
      nextFilterModel =
        restore?.stepId === latest.id &&
        restore.viewChangeEpoch === confirmed.viewChangeEpoch &&
        isDeepStrictEqual(restore.after, confirmed.filterModel)
          ? copyFilterModel(restore.before)
          : reconcileFilterModelById(confirmed.filterModel, confirmed.schema, targetSchema);
    }

    let view: RKernelViewQuery;
    try {
      view = resolveViewQuery(nextFilterModel, targetSchema);
      validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId
      );
    }

    const expectedRevision = confirmed.revision;
    const page = pageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit, view);
    try {
      const result = await (request.kind === "applyDraft"
        ? this.transport.applyDraft(request.sessionId, expectedRevision, page, transportOptions(options))
        : request.kind === "discardDraft"
          ? this.transport.discardDraft(request.sessionId, expectedRevision, page, transportOptions(options))
          : this.transport.undoStep(request.sessionId, expectedRevision, page, transportOptions(options)));
      if (confirmed.invalidated) return kernelChangedError(request.sessionId);
      const expectedAction =
        request.kind === "applyDraft" ? "apply" : request.kind === "discardDraft" ? "discard" : "undo";
      if (
        result.sessionId !== request.sessionId ||
        result.revision !== expectedRevision + 1 ||
        result.action !== expectedAction
      ) {
        throw new Error("The R kernel returned a mismatched cleaning-plan update.");
      }
      if (confirmed.revision !== expectedRevision) {
        confirmed.invalidated = true;
        return staleResponseError(request.sessionId);
      }
      assertMutationContract(
        confirmed,
        result.page,
        request,
        targetSchema,
        targetRows,
        targetIdentityRows,
        targetKeyColumnIds,
        targetRowNames,
        view
      );
      if (!isDeepStrictEqual(targetRSchema, result.page.schema)) {
        throw new Error("The R kernel returned a cleaning-plan update for the wrong R schema.");
      }

      const priorRestore = confirmed.lastAppliedViewRestore;
      if (request.kind === "applyDraft") {
        const draftStep = confirmed.draftStep as RTransformStep;
        const draftInputSchema = confirmed.draftInputSchema as readonly ColumnSchema[];
        const draftInputRSchema = confirmed.draftInputRSchema as readonly RColumnSchema[];
        const draftInputRows = confirmed.draftInputRows as number;
        const draftInputIdentityRows = confirmed.draftInputIdentityRows as number;
        const draftInputKeyColumnIds = confirmed.draftInputKeyColumnIds as readonly string[];
        if (confirmed.draftReplacesStepId === undefined) {
          confirmed.steps = [...confirmed.steps, copyRTransformStep(draftStep)];
          confirmed.planInputSchemas = [...confirmed.planInputSchemas, copySchema(draftInputSchema)];
          confirmed.planInputRSchemas = [...confirmed.planInputRSchemas, draftInputRSchema];
          confirmed.planInputRows = [...confirmed.planInputRows, draftInputRows];
          confirmed.planInputIdentityRows = [...confirmed.planInputIdentityRows, draftInputIdentityRows];
          confirmed.planInputKeyColumnIds = [
            ...confirmed.planInputKeyColumnIds,
            Object.freeze([...draftInputKeyColumnIds])
          ];
        } else {
          confirmed.steps = [...confirmed.steps.slice(0, -1), copyRTransformStep(draftStep)];
          confirmed.planInputSchemas = [...confirmed.planInputSchemas.slice(0, -1), copySchema(draftInputSchema)];
          confirmed.planInputRSchemas = [...confirmed.planInputRSchemas.slice(0, -1), draftInputRSchema];
          confirmed.planInputRows = [...confirmed.planInputRows.slice(0, -1), draftInputRows];
          confirmed.planInputIdentityRows = [...confirmed.planInputIdentityRows.slice(0, -1), draftInputIdentityRows];
          confirmed.planInputKeyColumnIds = [
            ...confirmed.planInputKeyColumnIds.slice(0, -1),
            Object.freeze([...draftInputKeyColumnIds])
          ];
        }
        confirmed.committedSchema = schemaFromContract(result.page);
        confirmed.committedRSchema = result.page.schema;
        confirmed.committedRows = targetRows;
        confirmed.committedIdentityRows = targetIdentityRows;
        confirmed.committedKeyColumnIds = Object.freeze([...targetKeyColumnIds]);
        const chainedRestore =
          confirmed.draftReplacesStepId === draftStep.id &&
          priorRestore?.stepId === draftStep.id &&
          priorRestore.viewChangeEpoch === confirmed.viewChangeEpoch &&
          isDeepStrictEqual(priorRestore.after, confirmed.draftBaseFilterModel)
            ? priorRestore
            : undefined;
        const replacementLostOriginalView =
          confirmed.draftReplacesStepId === draftStep.id && chainedRestore === undefined;
        if (
          confirmed.draftBaseViewChangeEpoch === confirmed.viewChangeEpoch &&
          confirmed.draftBaseFilterModel &&
          !replacementLostOriginalView
        ) {
          confirmed.lastAppliedViewRestore = {
            stepId: draftStep.id,
            before: copyFilterModel(chainedRestore?.before ?? confirmed.draftBaseFilterModel),
            after: copyFilterModel(nextFilterModel),
            viewChangeEpoch: confirmed.viewChangeEpoch
          };
        } else {
          confirmed.lastAppliedViewRestore = undefined;
        }
      } else if (request.kind === "undoStep") {
        confirmed.steps = confirmed.steps.slice(0, -1);
        confirmed.planInputSchemas = confirmed.planInputSchemas.slice(0, -1);
        confirmed.planInputRSchemas = confirmed.planInputRSchemas.slice(0, -1);
        confirmed.planInputRows = confirmed.planInputRows.slice(0, -1);
        confirmed.planInputIdentityRows = confirmed.planInputIdentityRows.slice(0, -1);
        confirmed.planInputKeyColumnIds = confirmed.planInputKeyColumnIds.slice(0, -1);
        confirmed.committedSchema = schemaFromContract(result.page);
        confirmed.committedRSchema = result.page.schema;
        confirmed.committedRows = targetRows;
        confirmed.committedIdentityRows = targetIdentityRows;
        confirmed.committedKeyColumnIds = Object.freeze([...targetKeyColumnIds]);
        confirmed.lastAppliedViewRestore = undefined;
      }

      confirmed.revision = result.revision;
      confirmed.schema = schemaFromContract(result.page);
      confirmed.rSchema = result.page.schema;
      confirmed.rows = targetRows;
      confirmed.identityRows = targetIdentityRows;
      confirmed.keyColumnIds = Object.freeze([...targetKeyColumnIds]);
      confirmed.rowNames = targetRowNames;
      confirmed.filterModel = nextFilterModel;
      clearDraft(confirmed);
      return {
        kind: "planUpdated",
        action: result.action,
        revision: confirmed.revision,
        metadata: metadataFor(confirmed, result.page.page.totalRows),
        page: gridPageFromContract(result.page),
        code: result.code
      };
    } catch (error) {
      if (confirmed.invalidated) return kernelChangedError(request.sessionId);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, request.sessionId);
      confirmed.invalidated = true;
      throw error;
    }
  }

  private async inspectStep(request: InspectStepRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) return unknownSessionError(request.sessionId);
    if (session.invalidated) return kernelChangedError(request.sessionId);
    const stale = staleRevisionError(session, request.revision);
    if (stale) return stale;
    const stepIndex = session.steps.findIndex((step) => step.id === request.stepId);
    if (stepIndex < 0 || session.steps.filter((step) => step.id === request.stepId).length !== 1) {
      return errorResponse("invalid_request", "The requested R cleaning step is not applied.", true, request.sessionId);
    }
    try {
      validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId
      );
    }
    const inputSchema = session.planInputSchemas[stepIndex] as readonly ColumnSchema[];
    const inputRSchema = session.planInputRSchemas[stepIndex] as readonly RColumnSchema[];
    const inputRows = session.planInputRows[stepIndex];
    if (inputRows === undefined) throw new Error("The R bridge is missing an applied-step input row count.");
    const inputIdentityRows = session.planInputIdentityRows[stepIndex];
    if (inputIdentityRows === undefined) {
      throw new Error("The R bridge is missing an applied-step input row-identity domain.");
    }
    const inputKeyColumnIds = session.planInputKeyColumnIds[stepIndex];
    if (!inputKeyColumnIds) throw new Error("The R bridge is missing applied-step input key metadata.");
    const inputRowNames = rowNamesAfterPlan(session.sourceRowNames, session.steps.slice(0, stepIndex));
    const outputSchema =
      session.planInputSchemas[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedSchema : undefined);
    if (!outputSchema) throw new Error("The R bridge is missing an applied-step output schema.");
    const outputRSchema =
      session.planInputRSchemas[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedRSchema : undefined);
    if (!outputRSchema) throw new Error("The R bridge is missing an applied-step output R schema.");
    const outputRows =
      session.planInputRows[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedRows : undefined);
    if (outputRows === undefined) throw new Error("The R bridge is missing an applied-step output row count.");
    const outputIdentityRows =
      session.planInputIdentityRows[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedIdentityRows : undefined);
    if (outputIdentityRows === undefined) {
      throw new Error("The R bridge is missing an applied-step output row-identity domain.");
    }
    const outputKeyColumnIds =
      session.planInputKeyColumnIds[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedKeyColumnIds : undefined);
    if (!outputKeyColumnIds) throw new Error("The R bridge is missing applied-step output key metadata.");
    const outputRowNames = rowNamesAfterPlan(session.sourceRowNames, session.steps.slice(0, stepIndex + 1));
    const expectedRevision = session.revision;
    const page = pageWindow(
      request.offset,
      request.limit,
      request.columnOffset,
      request.columnLimit,
      emptyRViewQuery()
    );
    try {
      const result = await this.transport.inspectStep(
        request.sessionId,
        expectedRevision,
        request.stepId,
        page,
        inputRSchema,
        outputRSchema,
        transportOptions(options)
      );
      if (session.invalidated) return kernelChangedError(request.sessionId);
      if (
        result.sessionId !== request.sessionId ||
        result.revision !== expectedRevision ||
        result.stepId !== request.stepId
      ) {
        throw new Error("The R kernel returned a mismatched applied-step inspection.");
      }
      if (session.revision !== expectedRevision) return staleResponseError(request.sessionId);
      if (result.stepIndex !== stepIndex || result.stepId !== request.stepId) {
        throw new Error("The R kernel inspected a different cleaning step.");
      }
      assertMutationContract(
        session,
        result.inputPage,
        request,
        inputSchema,
        inputRows,
        inputIdentityRows,
        inputKeyColumnIds,
        inputRowNames,
        emptyRViewQuery()
      );
      assertMutationContract(
        session,
        result.outputPage,
        request,
        outputSchema,
        outputRows,
        outputIdentityRows,
        outputKeyColumnIds,
        outputRowNames,
        emptyRViewQuery()
      );
      if (
        !sameSchema(inputSchema, result.inputSchema) ||
        !sameSchema(outputSchema, result.outputSchema) ||
        !isDeepStrictEqual(inputRSchema, result.inputSchema) ||
        !isDeepStrictEqual(outputRSchema, result.outputSchema)
      ) {
        throw new Error("The R kernel returned mismatched applied-step schemas.");
      }
      const diff = inspectionDiff(
        session.steps[stepIndex] as RTransformStep,
        inputSchema,
        outputSchema,
        result.inputPage,
        result.outputPage,
        inputRows,
        outputRows
      );
      assertMutationDiff(
        session.steps[stepIndex] as RTransformStep,
        inputSchema,
        outputSchema,
        inputRows,
        outputRows,
        result.outputPage,
        diff
      );
      return {
        kind: "stepInspection",
        revision: session.revision,
        stepId: request.stepId,
        stepIndex,
        inputPage: gridPageFromContract(result.inputPage),
        outputPage: gridPageFromContract(result.outputPage),
        inputSchema: copySchema(inputSchema),
        outputSchema: copySchema(outputSchema),
        diff: copyDiff(diff),
        code: result.code
      };
    } catch (error) {
      if (session.invalidated) return kernelChangedError(request.sessionId);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, request.sessionId);
      throw error;
    }
  }

  private async exportData(request: ExportDataRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) return unknownSessionError(request.sessionId);
    if (session.invalidated) return kernelChangedError(request.sessionId);
    const writer = this.transport.exportData;
    const supportsFormat = request.format === "csv" ? session.exportCsv : session.exportParquet;
    if (!supportsFormat || !writer) {
      return errorResponse(
        "unsupported_operation",
        request.format === "parquet"
          ? "Parquet export requires nanoparquet 0.5.1 or newer in the selected local R runtime."
          : "Cleaned-data export is available for local R notebook and document sessions opened in Editing mode.",
        true,
        request.sessionId
      );
    }
    if (session.mode !== "editing") {
      return errorResponse(
        "unsupported_mode",
        "Change this R session to Editing mode before exporting cleaned data.",
        true,
        request.sessionId
      );
    }
    const stale = staleRevisionError(session, request.revision);
    if (stale) return stale;
    if (session.draftStep) {
      return errorResponse(
        "invalid_request",
        "Apply or discard the current R draft before exporting cleaned data.",
        true,
        request.sessionId
      );
    }
    if (!path.isAbsolute(request.path)) {
      return errorResponse(
        "invalid_request",
        "Choose an absolute file-system destination for the R export.",
        true,
        request.sessionId
      );
    }

    const expectedGeneration = this.kernelGeneration;
    const expectedRevision = session.revision;
    const expectedRows = session.committedRows;
    const expectedColumns = session.committedSchema.length;
    let transaction: AtomicFileTransaction | undefined;
    let settled = false;
    try {
      transaction = await this.beginFileTransaction({
        destination: vscode.Uri.file(request.path),
        protectedSources: rExportProtectedSourceUris(session.source)
      });
      const output = transaction;
      if (this.disposed || this.sessions.get(request.sessionId) !== session) {
        await transaction.rollback();
        settled = true;
        return unknownSessionError(request.sessionId);
      }
      if (session.invalidated || expectedGeneration !== this.kernelGeneration) {
        await transaction.rollback();
        settled = true;
        return kernelChangedError(request.sessionId);
      }
      if (session.revision !== expectedRevision) {
        await transaction.rollback();
        settled = true;
        return staleResponseError(request.sessionId);
      }
      const result = await writer.call(
        this.transport,
        request.sessionId,
        expectedRevision,
        request.format,
        (chunk) => output.write(chunk),
        transportOptions({
          ...options,
          timeoutMs: options.timeoutMs ?? R_DATA_EXPORT_TIMEOUT_MS
        })
      );

      if (this.disposed || this.sessions.get(request.sessionId) !== session) {
        await transaction.rollback();
        settled = true;
        return unknownSessionError(request.sessionId);
      }
      if (session.invalidated || expectedGeneration !== this.kernelGeneration) {
        await transaction.rollback();
        settled = true;
        return kernelChangedError(request.sessionId);
      }
      if (session.revision !== expectedRevision) {
        await transaction.rollback();
        settled = true;
        return staleResponseError(request.sessionId);
      }
      assertRExportResult(result, request.sessionId, expectedRevision, request.format, expectedRows, expectedColumns);
      await transaction.commit();
      settled = true;
      return {
        kind: "dataExported",
        revision: expectedRevision,
        path: request.path,
        format: request.format,
        shape: { rows: result.rows, columns: result.columns }
      };
    } catch (error) {
      if (transaction && !settled) {
        try {
          await transaction.rollback();
          settled = true;
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "R data export failed and its unpublished temporary file could not be settled safely."
          );
        }
      }
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, request.sessionId);
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
    // A kernel restart retires its process-local mapping, but a detached
    // mutation only invalidates the bridge view while the transport still
    // owns the live session. The latter must receive a real terminal close.
    if (session.invalidated && !this.transport.isSessionMapped(sessionId)) {
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
  if (
    (request.source.kind !== "notebookVariable" &&
      request.source.kind !== "documentVariable" &&
      request.source.kind !== "rInteractiveVariable") ||
    !request.source.variableName
  ) {
    return errorResponse(
      "unsupported_source",
      "R sessions open named variables from a notebook, an R document, or the active R session.",
      true,
      sessionId
    );
  }
  if (request.backend !== undefined && request.backend !== "r") {
    return errorResponse("unsupported_backend", "An R notebook session requires the R backend.", true, sessionId);
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
  view: RKernelViewQuery
): RKernelPageWindow {
  return Object.freeze({ rowOffset, rowLimit, columnOffset, columnLimit, view });
}

function emptyRViewQuery(): RKernelViewQuery {
  return Object.freeze({ filters: Object.freeze([]), sorts: Object.freeze([]) });
}

function resolveViewQuery(filterModel: FilterModel, schema: readonly ColumnSchema[]): RKernelViewQuery {
  const filters = Object.freeze(
    filterModel.filters.map<RKernelColumnFilter>((filter) => {
      const column = resolveNamedColumn(filter.column, schema, "filter");
      const schemaColumn = schema.find((candidate) => candidate.id === column.id) as ColumnSchema;
      const columnType = requireRColumnType(schemaColumn.type);
      if (filter.type !== columnType) {
        throw new TypeError(
          `The filter for ${JSON.stringify(filter.column)} declares ${filter.type}, but the R column is ${schemaColumn.type}.`
        );
      }
      return Object.freeze({
        column,
        type: columnType,
        ...(filter.logic ? { logic: filter.logic } : {}),
        ...(filter.valueFilter
          ? {
              valueFilter: Object.freeze({
                ...filter.valueFilter,
                selectedValues: Object.freeze([...filter.valueFilter.selectedValues])
              })
            }
          : {}),
        predicates: Object.freeze(filter.predicates.map((predicate) => Object.freeze({ ...predicate })))
      });
    })
  );
  return Object.freeze({
    ...(filterModel.logic ? { logic: filterModel.logic } : {}),
    filters,
    sorts: resolveSorts(filterModel, schema)
  });
}

function assertColumnValuesContract(
  session: RBridgeSession,
  requested: RKernelColumnReference,
  result: Readonly<{ column: string; values: readonly ValueCount[]; hasMore: boolean; sampleSize?: number }>,
  limit: number,
  search: string | undefined
): void {
  const schema = session.schema.find((column) => column.id === requested.id);
  if (!schema || schema.name !== requested.name || result.column !== requested.name || result.values.length > limit) {
    throw new Error("The R kernel returned values for the wrong column or request limit.");
  }
  const expectedType = requireRColumnType(schema.type);
  if (
    result.sampleSize !== undefined &&
    (result.sampleSize !== R_FRAME_CONTRACT_LIMITS.profileSampleRows ||
      result.sampleSize >= session.rows ||
      (search !== undefined && search !== "") ||
      !result.hasMore)
  ) {
    throw new Error("The R kernel returned an invalid column-value sample size.");
  }
  const countDomain = result.sampleSize ?? session.rows;
  let returnedCount = 0;
  for (const entry of result.values) {
    if (
      !Number.isSafeInteger(entry.count) ||
      entry.count < 1 ||
      entry.count > countDomain ||
      entry.count > countDomain - returnedCount ||
      entry.selectionValue === undefined ||
      entry.selectionValue.columnType !== expectedType
    ) {
      throw new Error("The R kernel returned values with incompatible typed selections or row counts.");
    }
    returnedCount += entry.count;
  }
}

function requireRColumnType(type: ColumnSchema["type"]): RColumnType {
  if (
    type === "string" ||
    type === "integer" ||
    type === "float" ||
    type === "boolean" ||
    type === "datetime" ||
    type === "date" ||
    type === "duration"
  ) {
    return type;
  }
  throw new TypeError(`The R dataframe exposed an unsupported ${type} column type.`);
}

function resolveNamedColumn(
  name: string,
  schema: readonly ColumnSchema[],
  purpose: "filter" | "sort" | "values"
): RKernelColumnReference {
  const matches = schema.filter((column) => column.name === name);
  if (matches.length !== 1) {
    throw new TypeError(
      matches.length === 0
        ? `The ${purpose} column ${JSON.stringify(name)} is no longer in this R dataframe.`
        : `The ${purpose} column ${JSON.stringify(name)} is ambiguous because that name is repeated.`
    );
  }
  const column = matches[0] as ColumnSchema;
  return Object.freeze({ id: column.id, name: column.name });
}

function resolveSorts(filterModel: FilterModel, schema: readonly ColumnSchema[]): readonly RKernelSortRule[] {
  if (filterModel.sort.length > R_FRAME_CONTRACT_LIMITS.sortRules) {
    throw new TypeError(`R views support at most ${R_FRAME_CONTRACT_LIMITS.sortRules} sort rules.`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    filterModel.sort.map((rule) => {
      const reference = resolveNamedColumn(rule.column, schema, "sort");
      const column = schema.find((candidate) => candidate.id === reference.id) as ColumnSchema;
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

function resolveTransformSortRules(
  rules: readonly SortRowsTransformStep["params"]["rules"][number][],
  schema: readonly ColumnSchema[],
  purpose: string
): readonly RKernelSortRule[] {
  if (rules.length > R_FRAME_CONTRACT_LIMITS.sortRules) {
    throw new TypeError(`${purpose} supports at most ${R_FRAME_CONTRACT_LIMITS.sortRules} sort rules.`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    rules.map((rule) => {
      const column = requireTransformColumn(rule.column, schema, purpose);
      if (seen.has(column.id)) throw new TypeError(`${purpose} repeats the same R column identity.`);
      seen.add(column.id);
      return Object.freeze({
        column: Object.freeze({ id: column.id, name: column.name }),
        direction: rule.direction,
        nulls: rule.nulls
      });
    })
  );
}

function resolveTransformFilterModel(
  model: FilterRowsTransformStep["params"]["filterModel"],
  schema: readonly ColumnSchema[]
): RKernelTransformFilterModel {
  if (model.filters.length > R_FRAME_CONTRACT_LIMITS.filters) {
    throw new TypeError(`Filter rows supports at most ${R_FRAME_CONTRACT_LIMITS.filters} column filters.`);
  }
  const seen = new Set<string>();
  const filters = Object.freeze(
    model.filters.map<RKernelColumnFilter>((filter) => {
      const column = requireTransformColumn(filter.column, schema, "Filter rows");
      if (seen.has(column.id)) throw new TypeError("Filter rows repeats the same R column identity.");
      seen.add(column.id);
      const type = requireRColumnType(column.type);
      if (filter.type !== type) {
        throw new TypeError(
          `Filter rows declares ${filter.type} for ${JSON.stringify(column.name)}, but the R column is ${type}.`
        );
      }
      if (filter.predicates.length > R_FRAME_CONTRACT_LIMITS.predicatesPerFilter) {
        throw new TypeError(
          `Filter rows supports at most ${R_FRAME_CONTRACT_LIMITS.predicatesPerFilter} predicates per column.`
        );
      }
      for (const predicate of filter.predicates) {
        if (!supportsViewPredicate(type, predicate.operator)) {
          throw new TypeError(`The ${predicate.operator} predicate is not available for R ${type} columns.`);
        }
      }
      if (
        filter.valueFilter &&
        filter.valueFilter.selectedValues.length > R_FRAME_CONTRACT_LIMITS.selectedValuesPerFilter
      ) {
        throw new TypeError(
          `Filter rows supports at most ${R_FRAME_CONTRACT_LIMITS.selectedValuesPerFilter} selected values per column.`
        );
      }
      return Object.freeze({
        column: Object.freeze({ id: column.id, name: column.name }),
        type,
        ...(filter.logic ? { logic: filter.logic } : {}),
        ...(filter.valueFilter
          ? {
              valueFilter: Object.freeze({
                ...filter.valueFilter,
                selectedValues: Object.freeze([...filter.valueFilter.selectedValues])
              })
            }
          : {}),
        predicates: Object.freeze(filter.predicates.map((predicate) => Object.freeze({ ...predicate })))
      });
    })
  );
  return Object.freeze({
    ...(model.logic ? { logic: model.logic } : {}),
    filters,
    sort: resolveTransformSortRules(model.sort, schema, "Filter rows")
  });
}

function requireTransformColumn(
  reference: Readonly<{ id: string; name: string }>,
  schema: readonly ColumnSchema[],
  purpose: string
): ColumnSchema {
  const matches = schema.filter((column) => column.id === reference.id && column.name === reference.name);
  if (matches.length !== 1) {
    throw new TypeError(`${purpose} contains a stale or mismatched R column reference.`);
  }
  const column = matches[0] as ColumnSchema;
  if (column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  return column;
}

function validateProfileRequest(
  request: SummaryRequest | DatasetStatsRequest,
  session: RBridgeSession | undefined
): ErrorResponse | undefined {
  if (!session) return unknownSessionError(request.sessionId, request.viewRequestId);
  if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
  return staleRevisionError(session, request.revision, request.viewRequestId);
}

function resolveProfileColumns(
  columnIds: readonly string[],
  schema: readonly ColumnSchema[]
): readonly RKernelColumnReference[] {
  if (columnIds.length === 0 || new Set(columnIds).size !== columnIds.length) {
    throw new TypeError("R profile columns must be a non-empty unique list.");
  }
  const schemaById = new Map(schema.map((column) => [column.id, column]));
  return Object.freeze(
    columnIds.map((columnId) => {
      const column = schemaById.get(columnId);
      if (!column) throw new TypeError(`The profile column ${JSON.stringify(columnId)} is no longer available.`);
      return Object.freeze({ id: column.id, name: column.name });
    })
  );
}

function assertSummaryContract(
  session: RBridgeSession,
  requested: readonly RKernelColumnReference[],
  summaries: readonly ColumnSummary[],
  view: RKernelViewQuery
): void {
  if (summaries.length !== requested.length) {
    throw new Error("The R kernel returned summaries for the wrong column projection.");
  }
  const schemaById = new Map(session.schema.map((column) => [column.id, column]));
  const totalRows = summaries[0]?.totalCount ?? 0;
  if (
    totalRows > session.rows ||
    (view.filters.length === 0 && totalRows !== session.rows) ||
    summaries.some((summary) => summary.totalCount !== totalRows)
  ) {
    throw new Error("The R kernel returned summaries for inconsistent filtered views.");
  }
  for (const [index, summary] of summaries.entries()) {
    const reference = requested[index] as RKernelColumnReference;
    const schema = schemaById.get(reference.id);
    if (
      !schema ||
      summary.columnId !== reference.id ||
      summary.column !== reference.name ||
      summary.column !== schema.name ||
      summary.type !== schema.type ||
      summary.rawType !== schema.rawType ||
      summary.totalCount !== totalRows ||
      summary.nullCount + summary.nanCount > totalRows ||
      (summary.distinctCount !== undefined &&
        summary.distinctCount > totalRows - summary.nullCount - summary.nanCount) ||
      summary.topValues.reduce((count, value) => count + value.count, 0) >
        totalRows - summary.nullCount - summary.nanCount
    ) {
      throw new Error("The R kernel returned a summary that does not match the active dataframe.");
    }
    if (
      summary.visualization?.kind === "boolean" &&
      summary.visualization.trueCount + summary.visualization.falseCount !==
        totalRows - summary.nullCount - summary.nanCount
    ) {
      throw new Error("The R kernel returned inconsistent boolean profile counts.");
    }
  }
}

function assertDatasetStatsContract(
  session: RBridgeSession,
  result: RKernelDatasetStatsResult,
  view: RKernelViewQuery
): void {
  const rows = result.totalRows;
  const columns = session.schema.length;
  const duplicateRowsDomain = result.stats.duplicateRowsSampleSize ?? rows;
  if (
    rows > session.rows ||
    (view.filters.length === 0 && rows !== session.rows) ||
    result.stats.missingRows > rows ||
    duplicateRowsDomain > rows ||
    result.stats.duplicateRows > Math.max(0, duplicateRowsDomain - 1) ||
    result.stats.missingCells > rows * columns ||
    result.stats.missingValuesByColumn.length !== columns
  ) {
    throw new Error("The R kernel returned dataset statistics outside the active dataframe shape.");
  }
  let missingCells = 0;
  for (const [index, entry] of result.stats.missingValuesByColumn.entries()) {
    if (entry.column !== session.schema[index]?.name || entry.count > rows) {
      throw new Error("The R kernel returned dataset statistics for the wrong column projection.");
    }
    missingCells += entry.count;
  }
  if (missingCells !== result.stats.missingCells) {
    throw new Error("The R kernel returned inconsistent missing-value totals.");
  }
}

function sessionFromContract(
  sessionId: string,
  source: SessionSource,
  mode: SessionMode,
  contract: RFramePageContract,
  exportFormats: readonly RKernelExportFormat[]
): RBridgeSession {
  const schema = schemaFromContract(contract);
  return {
    sessionId,
    source: copySource(source),
    dataframeFlavor: contract.dataframeFlavor,
    sourceRows: contract.shape.rows,
    sourceSchema: schema,
    sourceRSchema: contract.schema,
    sourceKeyColumnIds: Object.freeze([...contract.frameSemantics.keyColumnIds]),
    exportCsv: exportFormats.includes("csv"),
    exportParquet: exportFormats.includes("parquet"),
    committedSchema: schema,
    committedRSchema: contract.schema,
    committedRows: contract.page.totalRows,
    committedIdentityRows: contract.shape.rows,
    committedKeyColumnIds: Object.freeze([...contract.frameSemantics.keyColumnIds]),
    schema,
    rSchema: contract.schema,
    rows: contract.page.totalRows,
    identityRows: contract.shape.rows,
    keyColumnIds: Object.freeze([...contract.frameSemantics.keyColumnIds]),
    sourceRowNames: contract.frameSemantics.rowNames,
    rowNames: contract.frameSemantics.rowNames,
    mode,
    revision: 0,
    filterModel: emptyFilterModel(),
    steps: Object.freeze([]),
    planInputSchemas: Object.freeze([]),
    planInputRSchemas: Object.freeze([]),
    planInputRows: Object.freeze([]),
    planInputIdentityRows: Object.freeze([]),
    planInputKeyColumnIds: Object.freeze([]),
    viewChangeEpoch: 0,
    invalidated: false
  };
}

function metadataFor(session: RBridgeSession, filteredRows: number = session.rows): SessionMetadata {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: session.sessionId,
    revision: session.revision,
    backend: "r",
    rDataframeFlavor: session.dataframeFlavor,
    mode: session.mode,
    source: copySource(session.source),
    capabilities: rCapabilitiesForSource(
      session.source,
      session.mode === "editing" && session.exportCsv,
      session.mode === "editing" && session.exportParquet
    ),
    shape: { rows: session.rows, columns: session.schema.length },
    filteredShape: { rows: filteredRows, columns: session.schema.length },
    schema: copySchema(session.schema),
    filterModel: copyFilterModel(session.filterModel),
    steps: session.steps.map(copyRetainedStep),
    ...(session.planInputSchemas.length > 0
      ? { latestStepInputSchema: copySchema(session.planInputSchemas.at(-1) as readonly ColumnSchema[]) }
      : {}),
    ...(session.draftStep ? { draftStep: copyRTransformStep(session.draftStep) } : {}),
    ...(session.draftReplacesStepId ? { draftReplacesStepId: session.draftReplacesStepId } : {})
  };
}

function rCapabilitiesForSource(source: SessionSource, exportCsv: boolean, exportParquet: boolean): SourceCapabilities {
  return {
    ...R_BASE_CAPABILITIES,
    exportCsv,
    exportParquet,
    notebookInsert: source.kind === "notebookVariable",
    ...(source.kind === "documentVariable" ? { documentInsert: true } : {})
  };
}

function rExportProtectedSourceUris(source: SessionSource): readonly vscode.Uri[] {
  if (source.kind === "rInteractiveVariable") return [];
  if ((source.kind !== "documentVariable" && source.kind !== "notebookVariable") || !source.uri) {
    throw new TypeError("R data export requires an originating R notebook or document URI.");
  }
  const uri = vscode.Uri.parse(source.uri, true);
  if (uri.scheme === "file" && uri.fsPath) return [uri];
  if (source.kind === "notebookVariable" && uri.scheme === "untitled") return [];
  throw new TypeError("R data export requires a local R notebook or document source.");
}

function isExportableRSource(source: SessionSource): boolean {
  if (source.kind === "rInteractiveVariable") return true;
  if ((source.kind !== "documentVariable" && source.kind !== "notebookVariable") || !source.uri) return false;
  try {
    const uri = vscode.Uri.parse(source.uri, true);
    // The public export request currently retains only a filesystem path, not
    // the Save-dialog URI authority. Do not advertise remote export until the
    // host can preserve and revalidate that authority end to end.
    return (
      (uri.scheme === "file" && Boolean(uri.fsPath)) ||
      (source.kind === "notebookVariable" && uri.scheme === "untitled")
    );
  } catch {
    return false;
  }
}

function assertRExportResult(
  result: RKernelDataExportResult,
  sessionId: string,
  revision: number,
  format: RKernelExportFormat,
  rows: number,
  columns: number
): void {
  if (
    result.sessionId !== sessionId ||
    result.revision !== revision ||
    result.format !== format ||
    !Number.isSafeInteger(result.rows) ||
    result.rows < 0 ||
    result.rows !== rows ||
    !Number.isSafeInteger(result.columns) ||
    result.columns < 0 ||
    result.columns !== columns
  ) {
    throw new Error("The R runtime returned a mismatched cleaned-data export result.");
  }
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
      ...(row.rowLabel === undefined ? {} : { rowLabel: row.rowLabel }),
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

type PageWindowCoordinates = Readonly<{
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
}>;

function assertSessionContract(
  session: RBridgeSession,
  contract: RFramePageContract,
  request: PageWindowCoordinates,
  expectedSchema: readonly ColumnSchema[],
  expectedRows: number,
  expectedIdentityRows: number,
  expectedKeyColumnIds: readonly string[],
  expectedRowNames: RFramePageContract["frameSemantics"]["rowNames"],
  view: RKernelViewQuery
): void {
  const resolvedColumnOffset = Math.min(request.columnOffset, expectedSchema.length);
  const expectedColumnIds = expectedSchema
    .slice(resolvedColumnOffset, resolvedColumnOffset + request.columnLimit)
    .map((column) => column.id);
  const mismatches = [
    contract.dataframeFlavor === session.dataframeFlavor ? undefined : "dataframe flavor",
    contract.shape.rows === expectedIdentityRows ? undefined : "row-identity domain",
    contract.shape.columns === expectedSchema.length ? undefined : "column count",
    contract.frameSemantics.rowNames === expectedRowNames ? undefined : "row-name semantics",
    isDeepStrictEqual(contract.frameSemantics.keyColumnIds, expectedKeyColumnIds) ? undefined : "key columns",
    contract.page.offset === request.offset ? undefined : "row offset",
    contract.page.limit === request.limit ? undefined : "row limit",
    contract.page.totalRows <= expectedRows ? undefined : "filtered row count",
    view.filters.length > 0 || contract.page.totalRows === expectedRows ? undefined : "active row count",
    contract.page.columnOffset === resolvedColumnOffset ? undefined : "column offset",
    contract.page.columnLimit === request.columnLimit ? undefined : "column limit",
    sameSchema(expectedSchema, contract.schema) ? undefined : "schema",
    isDeepStrictEqual(contract.page.columnIds, expectedColumnIds) ? undefined : "column projection"
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`The R dataframe contract did not match the requested session state: ${mismatches.join(", ")}.`);
  }
}

function assertMutationContract(
  session: RBridgeSession,
  contract: RFramePageContract,
  request: PageWindowCoordinates,
  expectedSchema: readonly ColumnSchema[],
  expectedRows: number,
  expectedIdentityRows: number,
  expectedKeyColumnIds: readonly string[],
  expectedRowNames: RFramePageContract["frameSemantics"]["rowNames"],
  view: RKernelViewQuery,
  dynamicNullability?: Readonly<{ columnId: string; mode: "mayAdd" | "mayRemove" }>
): void {
  if (dynamicNullability === undefined) {
    assertSessionContract(
      session,
      contract,
      request,
      expectedSchema,
      expectedRows,
      expectedIdentityRows,
      expectedKeyColumnIds,
      expectedRowNames,
      view
    );
    return;
  }
  const dynamicNullableColumnId = dynamicNullability.columnId;
  const actualTarget = contract.schema.find((column) => column.id === dynamicNullableColumnId);
  const expectedTarget = expectedSchema.find((column) => column.id === dynamicNullableColumnId);
  const invalidTransition =
    !actualTarget ||
    !expectedTarget ||
    (dynamicNullability.mode === "mayAdd"
      ? expectedTarget.nullable && !actualTarget.nullable
      : !expectedTarget.nullable && actualTarget.nullable);
  if (invalidTransition) {
    throw new Error("The R dataframe contract returned invalid nullability for the transformed column.");
  }
  const normalized = Object.freeze(
    expectedSchema.map((column) =>
      column.id === dynamicNullableColumnId ? Object.freeze({ ...column, nullable: actualTarget.nullable }) : column
    )
  );
  assertSessionContract(
    session,
    contract,
    request,
    normalized,
    expectedRows,
    expectedIdentityRows,
    expectedKeyColumnIds,
    expectedRowNames,
    view
  );
}

function rowNamesAfterRStep(
  input: RFramePageContract["frameSemantics"]["rowNames"],
  step: RTransformStep
): RFramePageContract["frameSemantics"]["rowNames"] {
  return step.kind === "groupBy" ? "positional" : input;
}

function rowNamesAfterPlan(
  source: RFramePageContract["frameSemantics"]["rowNames"],
  steps: readonly { readonly kind: string }[]
): RFramePageContract["frameSemantics"]["rowNames"] {
  return steps.some((step) => step.kind === "groupBy") ? "positional" : source;
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

function schemaFromContract(contract: RFramePageContract): readonly ColumnSchema[] {
  return Object.freeze(
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
}

function copySchema(schema: readonly ColumnSchema[]): ColumnSchema[] {
  return schema.map((column) => ({ ...column }));
}

function schemaAfterRStep(
  inputSchema: readonly ColumnSchema[],
  step: RTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  if (
    step.kind === "sortRows" ||
    step.kind === "filterRows" ||
    step.kind === "dropMissingRows" ||
    step.kind === "dropDuplicates"
  ) {
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  if (step.kind === "selectColumns") return schemaAfterSelect(inputSchema, step);
  if (step.kind === "dropColumns") return schemaAfterDrop(inputSchema, step);
  if (step.kind === "groupBy") return schemaAfterGroupBy(inputSchema, step);
  if (step.kind === "cloneColumn") return schemaAfterClone(inputSchema, step);
  if (step.kind === "fillMissingValues") return schemaAfterFillMissing(inputSchema, step, activeKeyColumnIds);
  if (step.kind === "castColumn") return schemaAfterCast(inputSchema, step, activeKeyColumnIds);
  if (isRNumericRoundingStep(step)) return schemaAfterNumericRounding(inputSchema, step, activeKeyColumnIds);
  if (step.kind === "textLength") return schemaAfterTextLength(inputSchema, step);
  if (
    step.kind === "findReplace" ||
    step.kind === "stripText" ||
    step.kind === "splitText" ||
    step.kind === "capitalizeText" ||
    step.kind === "lowerText" ||
    step.kind === "upperText"
  ) {
    return schemaAfterTextTransform(inputSchema, step, activeKeyColumnIds);
  }
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The rename column reference no longer matches the active R dataframe.");
  }
  if (step.params.newName.length === 0) throw new TypeError("The new R column name may not be empty.");
  const target = matches[0] as ColumnSchema;
  if (inputSchema.some((column) => column.id !== target.id && column.name === step.params.newName)) {
    throw new TypeError(`The R column name ${JSON.stringify(step.params.newName)} already exists.`);
  }
  return Object.freeze(
    inputSchema.map((column) =>
      Object.freeze(column.id === target.id ? { ...column, name: step.params.newName } : { ...column })
    )
  );
}

const rGroupScalarRawTypes = new Set([
  "character",
  "factor",
  "ordered factor",
  "integer",
  "integer64",
  "double",
  "logical",
  "Date",
  "POSIXct",
  "difftime"
]);

function schemaAfterGroupBy(inputSchema: readonly ColumnSchema[], step: GroupByTransformStep): readonly ColumnSchema[] {
  if (step.params.keys.length === 0 || step.params.aggregations.length === 0) {
    throw new TypeError("Group and aggregate requires at least one key and one aggregation.");
  }
  if (step.params.keys.length + step.params.aggregations.length > R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Group and aggregate exceeds the R frame contract column limit.");
  }
  const byId = new Map(inputSchema.map((column) => [column.id, column]));
  const seenKeys = new Set<string>();
  const keys = step.params.keys.map((reference) => {
    const column = byId.get(reference.id);
    if (!column || column.name !== reference.name) {
      throw new TypeError("A Group and aggregate key no longer matches the active R dataframe.");
    }
    if (seenKeys.has(column.id)) throw new TypeError("Group and aggregate cannot repeat a key column.");
    if (!rGroupScalarRawTypes.has(column.rawType)) {
      throw new TypeError(`R ${column.rawType} columns cannot be used as group keys.`);
    }
    if (column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
      throw new TypeError("Open Wrangler's reserved private row-identity column may not be grouped.");
    }
    seenKeys.add(column.id);
    return Object.freeze({ ...column });
  });

  const keyNames = new Set(keys.map((column) => column.name));
  const aliases = new Set<string>();
  const outputIds = new Set(keys.map((column) => column.id));
  const aggregations = step.params.aggregations.map((aggregation, index) => {
    const source = byId.get(aggregation.column.id);
    if (!source || source.name !== aggregation.column.name) {
      throw new TypeError("A Group and aggregate input no longer matches the active R dataframe.");
    }
    const alias = aggregation.alias;
    if (alias.length === 0 || Buffer.byteLength(alias, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
      throw new TypeError("A Group and aggregate alias is empty or exceeds the R frame contract limit.");
    }
    if (alias.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
      throw new TypeError("A Group and aggregate alias uses Open Wrangler's reserved private row-identity prefix.");
    }
    if (aliases.has(alias) || keyNames.has(alias)) {
      throw new TypeError("Group and aggregate aliases must be unique and cannot duplicate a key name.");
    }
    aliases.add(alias);

    const numeric = source.rawType === "integer" || source.rawType === "integer64" || source.rawType === "double";
    const ordered = rGroupScalarRawTypes.has(source.rawType);
    if (
      ((aggregation.operation === "sum" || aggregation.operation === "mean" || aggregation.operation === "median") &&
        !numeric) ||
      ((aggregation.operation === "min" || aggregation.operation === "max") && !ordered) ||
      ((aggregation.operation === "count" ||
        aggregation.operation === "nUnique" ||
        aggregation.operation === "first" ||
        aggregation.operation === "last") &&
        !ordered)
    ) {
      throw new TypeError(`R ${source.rawType} columns cannot use the ${aggregation.operation} group aggregation.`);
    }

    const id = `c:step:${step.id}:${index}`;
    if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes || outputIds.has(id)) {
      throw new TypeError("A Group and aggregate output identity is invalid or already exists.");
    }
    outputIds.add(id);
    const outputType =
      aggregation.operation === "count" || aggregation.operation === "nUnique"
        ? { rawType: "integer", type: "integer" as const, nullable: false }
        : aggregation.operation === "mean" || aggregation.operation === "median"
          ? { rawType: "double", type: "float" as const, nullable: source.nullable }
          : (aggregation.operation === "min" || aggregation.operation === "max") && source.rawType === "factor"
            ? { rawType: "character", type: "string" as const, nullable: source.nullable }
            : aggregation.operation === "sum"
              ? { rawType: source.rawType, type: source.type, nullable: false }
              : { rawType: source.rawType, type: source.type, nullable: source.nullable };
    return Object.freeze({
      id,
      name: alias,
      position: keys.length + index,
      ...outputType
    });
  });
  return Object.freeze([...keys.map((column, position) => Object.freeze({ ...column, position })), ...aggregations]);
}

function schemaAfterNumericRounding(
  inputSchema: readonly ColumnSchema[],
  step: RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const label = numericRoundingLabel(step);
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError(`The ${label.toLowerCase()} column reference no longer matches the active R dataframe.`);
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (source.rawType !== "integer" && source.rawType !== "double" && source.rawType !== "integer64") {
    throw new TypeError(`${label} requires an R integer, double, or integer64 column.`);
  }
  if (
    step.kind === "roundNumber" &&
    step.params.decimals !== undefined &&
    (!Number.isSafeInteger(step.params.decimals) || Math.abs(step.params.decimals) > 2_147_483_647)
  ) {
    throw new TypeError("Round requires a decimal-place count within R's integer range.");
  }

  const outputName = step.params.newColumn;
  if (outputName !== undefined && outputName.length === 0) {
    throw new TypeError(`The ${label.toLowerCase()} R column name may not be empty.`);
  }
  const inPlace = outputName === undefined || outputName === source.name;
  const targetType =
    source.rawType === "integer64"
      ? { rawType: "integer64", type: "integer" as const }
      : { rawType: "double", type: "float" as const };
  if (inPlace) {
    if (activeKeyColumnIds.includes(source.id)) {
      throw new TypeError(`${label} cannot replace a keyed data.table column in place. Choose a new output column.`);
    }
    return Object.freeze(
      inputSchema.map((column) => Object.freeze(column.id === source.id ? { ...column, ...targetType } : { ...column }))
    );
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError(`${label} exceeds the R frame contract column limit.`);
  }
  if (Buffer.byteLength(outputName, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError(`The ${label.toLowerCase()} R column name exceeds the frame contract limit.`);
  }
  if (outputName.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError(
      `The ${label.toLowerCase()} R column name uses Open Wrangler's reserved private row-identity prefix.`
    );
  }
  if (inputSchema.some((column) => column.name === outputName)) {
    throw new TypeError(`The R column name ${JSON.stringify(outputName)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError(`The ${label.toLowerCase()} R column identity exceeds the frame contract limit.`);
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError(`The ${label.toLowerCase()} R column identity already exists in the active dataframe.`);
  }
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name: outputName,
      position: inputSchema.length,
      ...targetType,
      nullable: source.nullable
    })
  ]);
}

function isRNumericRoundingStep(
  step: RTransformStep
): step is RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep {
  return step.kind === "roundNumber" || step.kind === "floorNumber" || step.kind === "ceilNumber";
}

function isRNumericRoundingInPlace(
  step: RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep
): boolean {
  return step.params.newColumn === undefined || step.params.newColumn === step.params.column.name;
}

function numericRoundingLabel(
  step: RoundNumberTransformStep | FloorNumberTransformStep | CeilNumberTransformStep
): "Round" | "Floor" | "Ceiling" {
  if (step.kind === "roundNumber") return "Round";
  if (step.kind === "floorNumber") return "Floor";
  return "Ceiling";
}

function keyColumnsAfterRStep(
  inputKeyColumnIds: readonly string[],
  outputSchema: readonly ColumnSchema[],
  step: RTransformStep
): readonly string[] {
  if (step.kind === "groupBy") return Object.freeze([]);
  if (step.kind === "sortRows" || (step.kind === "filterRows" && step.params.filterModel.sort.length > 0)) {
    return Object.freeze([]);
  }
  return Object.freeze([...retainedKeyPrefix(inputKeyColumnIds, outputSchema)]);
}

function rowCountAfterRStep(step: RTransformStep, inputRows: number, diff: DataDiff): number {
  if (step.kind === "groupBy") {
    if (diff.removedRows !== inputRows || diff.addedRows > inputRows) {
      throw new Error("The R kernel returned invalid row counts for Group and aggregate.");
    }
    return diff.addedRows;
  }
  if (isRRowReductionStep(step)) {
    if (diff.addedRows !== 0 || diff.removedRows > inputRows) {
      throw new Error(`The R kernel returned invalid row counts for ${rowOperationLabel(step)}.`);
    }
    return inputRows - diff.removedRows;
  }
  if (diff.addedRows !== 0 || diff.removedRows !== 0) {
    throw new Error(`The R kernel returned an unexpected row-count change for ${step.kind}.`);
  }
  return inputRows;
}

function rowIdentityDomainAfterRStep(step: RTransformStep, inputIdentityRows: number, outputRows: number): number {
  if (step.kind !== "groupBy") return inputIdentityRows;
  const outputIdentityRows = inputIdentityRows + outputRows;
  if (!Number.isSafeInteger(outputIdentityRows) || outputIdentityRows > R_FRAME_CONTRACT_LIMITS.rows) {
    throw new Error("The grouped R dataframe exceeds the supported row-identity range.");
  }
  return outputIdentityRows;
}

function isRRowReductionStep(
  step: RTransformStep
): step is FilterRowsTransformStep | DropMissingRowsTransformStep | DropDuplicatesTransformStep {
  return step.kind === "filterRows" || step.kind === "dropMissingRows" || step.kind === "dropDuplicates";
}

function rowOperationLabel(
  step: FilterRowsTransformStep | DropMissingRowsTransformStep | DropDuplicatesTransformStep
): string {
  if (step.kind === "filterRows") return "Filter rows";
  if (step.kind === "dropMissingRows") return "Drop missing rows";
  return "Drop duplicates";
}

function schemaAfterFillMissing(
  inputSchema: readonly ColumnSchema[],
  step: FillMissingValuesTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The fill-missing column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (activeKeyColumnIds.includes(source.id)) {
    throw new TypeError("Fill Missing Values cannot replace a data.table key column. Clone the column first.");
  }
  const replacement = step.params.replacement;
  if (replacement.kind === "linearInterpolation") {
    if (source.type !== "float") {
      throw new TypeError(`Linear interpolation cannot fill R ${source.rawType}.`);
    }
    if (
      replacement.maxGap !== undefined &&
      (!Number.isSafeInteger(replacement.maxGap) || replacement.maxGap < 1 || replacement.maxGap > 1_000_000)
    ) {
      throw new TypeError("Linear interpolation requires a maximum gap between 1 and 1,000,000 when supplied.");
    }
    const coordinate = requireTransformColumn(replacement.coordinate, inputSchema, "Linear interpolation");
    if (coordinate.id === source.id) {
      throw new TypeError("The fill target cannot also be the interpolation coordinate.");
    }
    if (coordinate.rawType === "integer64" || !new Set(["integer", "float", "date", "datetime"]).has(coordinate.type)) {
      throw new TypeError(`R ${coordinate.rawType} columns cannot be used as interpolation coordinates.`);
    }
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  if (replacement.kind === "groupedStatistic") {
    const compatible =
      (replacement.statistic === "mean" && source.type === "float") ||
      (replacement.statistic === "median" && (source.type === "integer" || source.type === "float")) ||
      (replacement.statistic === "mostFrequent" && (source.type === "string" || source.type === "boolean"));
    if (!compatible) {
      throw new TypeError(`Grouped ${replacement.statistic} cannot fill R ${source.rawType}.`);
    }
    if (replacement.keys.length === 0 || replacement.keys.length > R_FRAME_CONTRACT_LIMITS.columns) {
      throw new TypeError("Grouped fill requires at least one grouping column.");
    }
    const supportedKeyTypes = new Set(["string", "integer", "float", "boolean", "date", "datetime", "duration"]);
    const seen = new Set<string>();
    for (const reference of replacement.keys) {
      const key = requireTransformColumn(reference, inputSchema, "Grouped fill");
      if (key.id === source.id) throw new TypeError("The fill target cannot also be a grouping column.");
      if (seen.has(key.id)) throw new TypeError("Grouped fill repeats the same R column identity.");
      if (!supportedKeyTypes.has(key.type)) {
        throw new TypeError(`R ${key.rawType} columns cannot be used as grouped-fill keys.`);
      }
      seen.add(key.id);
    }
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  if (replacement.kind === "directional") {
    if (replacement.direction !== "forward" && replacement.direction !== "backward") {
      throw new TypeError("Directional fill requires a forward or backward direction.");
    }
    if (
      !Number.isSafeInteger(replacement.maxGap ?? 1) ||
      (replacement.maxGap ?? 1) < 1 ||
      (replacement.maxGap ?? 1) > 1_000_000
    ) {
      throw new TypeError("Directional fill requires a maximum gap between 1 and 1,000,000 when supplied.");
    }
    const orderBy = resolveTransformSortRules(replacement.orderBy, inputSchema, "Directional fill");
    if (orderBy.length === 0) throw new TypeError("Directional fill requires at least one ordering column.");
    if (orderBy.some((rule) => rule.column.id === source.id)) {
      throw new TypeError("The fill target cannot also be a directional ordering column.");
    }
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  if (replacement.kind === "fallbackColumns") {
    if (replacement.columns.length === 0 || replacement.columns.length > 64) {
      throw new TypeError("Fill Missing Values requires between 1 and 64 fallback columns.");
    }
    if (!["string", "integer", "float", "boolean", "date", "datetime"].includes(source.type)) {
      throw new TypeError(`Fallback columns cannot fill R ${source.rawType}.`);
    }
    const seen = new Set<string>();
    for (const reference of replacement.columns) {
      if (reference.id === source.id) {
        throw new TypeError("The fill target cannot also be a fallback column.");
      }
      if (seen.has(reference.id)) {
        throw new TypeError("Fill Missing Values cannot use the same fallback column more than once.");
      }
      seen.add(reference.id);
      const fallbackMatches = inputSchema.filter(
        (column) => column.id === reference.id && column.name === reference.name
      );
      if (fallbackMatches.length !== 1) {
        throw new TypeError("A fallback column reference no longer matches the active R dataframe.");
      }
      const fallback = fallbackMatches[0] as ColumnSchema;
      if (fallback.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
        throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
      }
      if (fallback.type !== source.type) {
        throw new TypeError(
          `Fallback column ${JSON.stringify(fallback.name)} is incompatible with R ${source.rawType}.`
        );
      }
    }
    return Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })));
  }
  const compatible =
    (source.type === "string" && (replacement.kind === "mostFrequent" || replacement.kind === "string")) ||
    (source.type === "integer" && (replacement.kind === "median" || replacement.kind === "integer")) ||
    (source.type === "float" &&
      (replacement.kind === "mean" ||
        replacement.kind === "median" ||
        replacement.kind === "integer" ||
        replacement.kind === "float")) ||
    (source.type === "boolean" && (replacement.kind === "mostFrequent" || replacement.kind === "boolean")) ||
    (source.type === "date" && replacement.kind === "date") ||
    (source.type === "datetime" && replacement.kind === "datetime");
  if (!compatible) {
    throw new TypeError(`The ${replacement.kind} replacement is incompatible with R ${source.rawType}.`);
  }
  if (
    replacement.kind === "string" &&
    Buffer.byteLength(replacement.value, "utf8") > R_FRAME_CONTRACT_LIMITS.textBytes
  ) {
    throw new TypeError("The R replacement text exceeds the frame contract limit.");
  }
  return Object.freeze(
    inputSchema.map((column) => Object.freeze(column.id === source.id ? { ...column, nullable: false } : { ...column }))
  );
}

function schemaAfterCast(
  inputSchema: readonly ColumnSchema[],
  step: CastColumnTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The converted column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (activeKeyColumnIds.includes(source.id)) {
    throw new TypeError(
      "Convert type cannot replace a data.table key column. Clone the column first, then convert it."
    );
  }

  const target = rCastTarget(source.rawType, step.params.dtype);
  return Object.freeze(
    inputSchema.map((column) =>
      Object.freeze(
        column.id === source.id
          ? { ...column, rawType: target.rawType, type: target.type, nullable: source.nullable }
          : { ...column }
      )
    )
  );
}

function rCastTarget(
  sourceRawType: string,
  dtype: CastColumnTransformStep["params"]["dtype"]
): Readonly<{ rawType: string; type: ColumnSchema["type"] }> {
  const factor = sourceRawType === "factor" || sourceRawType === "ordered factor";
  const text = sourceRawType === "character" || factor;
  const ordinaryScalar =
    sourceRawType === "logical" || sourceRawType === "integer" || sourceRawType === "double" || text;
  if (dtype === "string") {
    if (
      !ordinaryScalar &&
      sourceRawType !== "Date" &&
      sourceRawType !== "POSIXct" &&
      sourceRawType !== "difftime" &&
      sourceRawType !== "integer64"
    ) {
      throw new TypeError(`Convert type does not support R ${sourceRawType} columns.`);
    }
    return { rawType: "character", type: "string" };
  }
  if (dtype === "integer") {
    if (sourceRawType === "integer64") return { rawType: "integer64", type: "integer" };
    if (!ordinaryScalar) throw unsupportedRCast(sourceRawType, dtype);
    return { rawType: "integer", type: "integer" };
  }
  if (dtype === "float") {
    if (!ordinaryScalar) throw unsupportedRCast(sourceRawType, dtype);
    return { rawType: "double", type: "float" };
  }
  if (dtype === "boolean") {
    if (!ordinaryScalar) throw unsupportedRCast(sourceRawType, dtype);
    return { rawType: "logical", type: "boolean" };
  }
  if (dtype === "date") {
    if (!text && sourceRawType !== "Date" && sourceRawType !== "POSIXct") {
      throw unsupportedRCast(sourceRawType, dtype);
    }
    return { rawType: "Date", type: "date" };
  }
  if (dtype === "datetime") {
    if (!text && sourceRawType !== "Date" && sourceRawType !== "POSIXct") {
      throw unsupportedRCast(sourceRawType, dtype);
    }
    return { rawType: "POSIXct", type: "datetime" };
  }
  throw new TypeError("Convert type received an unsupported R target type.");
}

function unsupportedRCast(sourceRawType: string, dtype: string): TypeError {
  return new TypeError(`Convert type cannot safely convert R ${sourceRawType} values to ${dtype}.`);
}

function schemaAfterTextTransform(
  inputSchema: readonly ColumnSchema[],
  step:
    | FindReplaceTransformStep
    | StripTextTransformStep
    | SplitTextTransformStep
    | CapitalizeTextTransformStep
    | LowerTextTransformStep
    | UpperTextTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const label = textTransformLabel(step);
  const description = label.toLowerCase();
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError(`The ${description} column reference no longer matches the active R dataframe.`);
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (source.type !== "string") throw new TypeError(`${label} requires an R string or factor column.`);
  const outputName = step.params.newColumn;
  if (outputName !== undefined && outputName.length === 0) {
    throw new TypeError(`The ${description} R column name may not be empty.`);
  }
  const inPlace = outputName === undefined || outputName === source.name;
  if (step.kind === "splitText" && inPlace) {
    throw new TypeError("Split text requires a new output column.");
  }
  if (inPlace) {
    if (activeKeyColumnIds.includes(source.id)) {
      throw new TypeError(
        `${label} cannot replace a keyed data.table column in place. Choose a new output column instead.`
      );
    }
    return Object.freeze(
      inputSchema.map((column) =>
        Object.freeze(
          column.id === source.id ? { ...column, rawType: "character", type: "string" as const } : { ...column }
        )
      )
    );
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError(`${label} exceeds the R frame contract column limit.`);
  }
  if (Buffer.byteLength(outputName, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError(`The ${description} R column name exceeds the frame contract limit.`);
  }
  if (outputName.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError(`The ${description} R column name uses Open Wrangler's reserved private row-identity prefix.`);
  }
  if (inputSchema.some((column) => column.name === outputName)) {
    throw new TypeError(`The R column name ${JSON.stringify(outputName)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError(`The ${description} R column identity exceeds the frame contract limit.`);
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError(`The ${description} R column identity already exists in the active dataframe.`);
  }
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name: outputName,
      position: inputSchema.length,
      rawType: "character",
      type: "string" as const,
      nullable: source.nullable
    })
  ]);
}

function textTransformLabel(
  step:
    | FindReplaceTransformStep
    | StripTextTransformStep
    | SplitTextTransformStep
    | CapitalizeTextTransformStep
    | LowerTextTransformStep
    | UpperTextTransformStep
): "Find and Replace" | "Strip text" | "Split text" | "Capitalize" | "Lowercase" | "Uppercase" {
  if (step.kind === "findReplace") return "Find and Replace";
  if (step.kind === "stripText") return "Strip text";
  if (step.kind === "splitText") return "Split text";
  if (step.kind === "capitalizeText") return "Capitalize";
  if (step.kind === "lowerText") return "Lowercase";
  return "Uppercase";
}

function schemaAfterTextLength(
  inputSchema: readonly ColumnSchema[],
  step: TextLengthTransformStep
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The text-length column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (source.type !== "string") {
    throw new TypeError("Text Length requires an R string column.");
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Text Length exceeds the R frame contract column limit.");
  }
  if (step.params.newColumn.length === 0) throw new TypeError("The text-length R column name may not be empty.");
  if (Buffer.byteLength(step.params.newColumn, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError("The text-length R column name exceeds the frame contract limit.");
  }
  if (step.params.newColumn.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("The text-length R column name uses Open Wrangler's reserved private row-identity prefix.");
  }
  if (inputSchema.some((column) => column.name === step.params.newColumn)) {
    throw new TypeError(`The R column name ${JSON.stringify(step.params.newColumn)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError("The text-length R column identity exceeds the frame contract limit.");
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError("The text-length R column identity already exists in the active dataframe.");
  }
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name: step.params.newColumn,
      position: inputSchema.length,
      rawType: "integer",
      type: "integer" as const,
      nullable: source.nullable
    })
  ]);
}

function schemaAfterClone(
  inputSchema: readonly ColumnSchema[],
  step: CloneColumnTransformStep
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The clone column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be cloned.");
  }
  if (inputSchema.length >= R_FRAME_CONTRACT_LIMITS.columns) {
    throw new TypeError("Clone Column exceeds the R frame contract column limit.");
  }
  if (step.params.newName.length === 0) throw new TypeError("The cloned R column name may not be empty.");
  if (Buffer.byteLength(step.params.newName, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError("The cloned R column name exceeds the frame contract limit.");
  }
  if (step.params.newName.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("The cloned R column name uses Open Wrangler's reserved private row-identity prefix.");
  }
  if (inputSchema.some((column) => column.name === step.params.newName)) {
    throw new TypeError(`The R column name ${JSON.stringify(step.params.newName)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError("The cloned R column identity exceeds the frame contract limit.");
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError("The cloned R column identity already exists in the active dataframe.");
  }
  return Object.freeze([
    ...inputSchema.map((column) => Object.freeze({ ...column })),
    Object.freeze({
      id,
      name: step.params.newName,
      position: inputSchema.length,
      rawType: source.rawType,
      type: source.type,
      nullable: source.nullable
    })
  ]);
}

function schemaAfterSelect(
  inputSchema: readonly ColumnSchema[],
  step: SelectColumnsTransformStep
): readonly ColumnSchema[] {
  if (
    !Array.isArray(step.params.columns) ||
    step.params.columns.length === 0 ||
    step.params.columns.length > R_FRAME_CONTRACT_LIMITS.columns
  ) {
    throw new TypeError("Select Columns requires a bounded non-empty R column list.");
  }
  const inputById = new Map(inputSchema.map((column) => [column.id, column]));
  const selectedIds = new Set<string>();
  return Object.freeze(
    step.params.columns.map((reference, position) => {
      const column = inputById.get(reference.id);
      if (!column || column.name !== reference.name) {
        throw new TypeError("A selected column reference no longer matches the active R dataframe.");
      }
      if (selectedIds.has(reference.id)) {
        throw new TypeError("Select Columns contains a repeated R column identity.");
      }
      selectedIds.add(reference.id);
      return Object.freeze({ ...column, position });
    })
  );
}

function schemaAfterDrop(
  inputSchema: readonly ColumnSchema[],
  step: DropColumnsTransformStep
): readonly ColumnSchema[] {
  if (!Array.isArray(step.params.columns) || step.params.columns.length === 0) {
    throw new TypeError("Drop Columns requires at least one R column.");
  }
  const inputById = new Map(inputSchema.map((column) => [column.id, column]));
  const droppedIds = new Set<string>();
  for (const reference of step.params.columns) {
    const column = inputById.get(reference.id);
    if (!column || column.name !== reference.name) {
      throw new TypeError("A drop column reference no longer matches the active R dataframe.");
    }
    if (droppedIds.has(reference.id)) throw new TypeError("Drop Columns contains a repeated R column identity.");
    droppedIds.add(reference.id);
  }
  if (droppedIds.size >= inputSchema.length) {
    throw new TypeError("Drop Columns must leave at least one visible R column.");
  }
  return Object.freeze(
    inputSchema
      .filter((column) => !droppedIds.has(column.id))
      .map((column, position) => Object.freeze({ ...column, position }))
  );
}

function reconcileFilterModelById(
  model: FilterModel,
  previousSchema: readonly ColumnSchema[],
  nextSchema: readonly ColumnSchema[]
): FilterModel {
  const uniquePreviousByName = uniqueColumnsByName(previousSchema);
  const nextById = new Map(nextSchema.map((column) => [column.id, column]));
  const uniqueNextByName = uniqueColumnsByName(nextSchema);
  const filters = model.filters.flatMap((filter) => {
    const previous = uniquePreviousByName.get(filter.column);
    const next = previous ? nextById.get(previous.id) : undefined;
    if (
      !previous ||
      !next ||
      uniqueNextByName.get(next.name)?.id !== next.id ||
      previous.type !== filter.type ||
      next.type !== filter.type
    ) {
      return [];
    }
    return [
      {
        ...filter,
        column: next.name,
        predicates: filter.predicates.map((predicate) => ({ ...predicate })),
        ...(filter.valueFilter
          ? { valueFilter: { ...filter.valueFilter, selectedValues: [...filter.valueFilter.selectedValues] } }
          : {})
      }
    ];
  });
  const sort = model.sort.flatMap((rule) => {
    const previous = uniquePreviousByName.get(rule.column);
    const next = previous ? nextById.get(previous.id) : undefined;
    if (!previous || !next || uniqueNextByName.get(next.name)?.id !== next.id || previous.type !== next.type) return [];
    return [{ ...rule, column: next.name }];
  });
  return {
    ...(model.logic ? { logic: model.logic } : {}),
    filters,
    sort
  };
}

function uniqueColumnsByName(schema: readonly ColumnSchema[]): Map<string, ColumnSchema> {
  const grouped = new Map<string, ColumnSchema[]>();
  for (const column of schema) grouped.set(column.name, [...(grouped.get(column.name) ?? []), column]);
  return new Map(
    [...grouped.entries()].flatMap(([name, columns]) =>
      columns.length === 1 ? [[name, columns[0] as ColumnSchema]] : []
    )
  );
}

type FallbackFillMissingReplacement = Extract<FillMissingReplacement, { kind: "fallbackColumns" }>;
type DirectionalFillMissingReplacement = Extract<FillMissingReplacement, { kind: "directional" }>;
type GroupedFillMissingReplacement = Extract<FillMissingReplacement, { kind: "groupedStatistic" }>;
type LinearInterpolationFillMissingReplacement = Extract<FillMissingReplacement, { kind: "linearInterpolation" }>;

function copyFillMissingReplacement(replacement: FillMissingReplacement): FillMissingReplacement {
  if (replacement.kind === "linearInterpolation") {
    return {
      kind: "linearInterpolation",
      coordinate: { ...replacement.coordinate },
      ...(replacement.maxGap === undefined ? {} : { maxGap: replacement.maxGap })
    };
  }
  if (replacement.kind === "groupedStatistic") {
    const keys = replacement.keys.map((key) => ({ ...key }));
    if (!keys[0]) throw new TypeError("Grouped fill requires at least one grouping column.");
    return {
      kind: "groupedStatistic",
      statistic: replacement.statistic,
      keys: keys as GroupedFillMissingReplacement["keys"]
    };
  }
  if (replacement.kind === "directional") {
    const orderBy = replacement.orderBy.map((rule) => ({ ...rule, column: { ...rule.column } }));
    if (!orderBy[0]) throw new TypeError("Directional fill requires at least one ordering column.");
    return {
      kind: "directional",
      direction: replacement.direction,
      orderBy: orderBy as DirectionalFillMissingReplacement["orderBy"],
      ...(replacement.maxGap === undefined ? {} : { maxGap: replacement.maxGap })
    };
  }
  if (replacement.kind !== "fallbackColumns") return { ...replacement };
  const columns = replacement.columns.map((column) => ({ ...column }));
  if (!columns[0]) throw new TypeError("Fill Missing Values requires at least one fallback column.");
  return {
    kind: "fallbackColumns",
    columns: columns as FallbackFillMissingReplacement["columns"]
  };
}

function freezeFillMissingReplacement(
  replacement: FillMissingReplacement,
  inputSchema: readonly ColumnSchema[],
  targetColumnId: string
): RKernelFillMissingReplacement {
  const copied = copyFillMissingReplacement(replacement);
  if (copied.kind === "linearInterpolation") {
    const coordinate = requireTransformColumn(copied.coordinate, inputSchema, "Linear interpolation");
    if (coordinate.id === targetColumnId) {
      throw new TypeError("The fill target cannot also be the interpolation coordinate.");
    }
    return Object.freeze({
      kind: "linearInterpolation",
      coordinate: Object.freeze({ id: coordinate.id, name: coordinate.name }),
      ...(copied.maxGap === undefined ? {} : { maxGap: copied.maxGap })
    } satisfies LinearInterpolationFillMissingReplacement);
  }
  if (copied.kind === "groupedStatistic") {
    const seen = new Set<string>();
    const keys = copied.keys.map((reference) => {
      const key = requireTransformColumn(reference, inputSchema, "Grouped fill");
      if (key.id === targetColumnId) throw new TypeError("The fill target cannot also be a grouping column.");
      if (seen.has(key.id)) throw new TypeError("Grouped fill repeats the same R column identity.");
      seen.add(key.id);
      return Object.freeze({ id: key.id, name: key.name });
    });
    if (!keys[0]) throw new TypeError("Grouped fill requires at least one grouping column.");
    return Object.freeze({
      kind: "groupedStatistic",
      statistic: copied.statistic,
      keys: Object.freeze(keys) as readonly [RKernelColumnReference, ...RKernelColumnReference[]]
    });
  }
  if (copied.kind === "directional") {
    const orderBy = resolveTransformSortRules(copied.orderBy, inputSchema, "Directional fill");
    if (orderBy.length === 0) throw new TypeError("Directional fill requires at least one ordering column.");
    if (orderBy.some((rule) => rule.column.id === targetColumnId)) {
      throw new TypeError("The fill target cannot also be a directional ordering column.");
    }
    return Object.freeze({
      kind: "directional",
      direction: copied.direction,
      orderBy: orderBy as readonly [RKernelSortRule, ...RKernelSortRule[]],
      ...(copied.maxGap === undefined ? {} : { maxGap: copied.maxGap })
    });
  }
  if (copied.kind === "fallbackColumns") {
    for (const column of copied.columns) Object.freeze(column);
    Object.freeze(copied.columns);
  }
  return Object.freeze(copied);
}

function rTransformStep(step: RTransformStep, inputSchema: readonly ColumnSchema[]): RKernelTransformStep {
  if (step.kind === "sortRows") {
    const rules = resolveTransformSortRules(step.params.rules, inputSchema, "Sort rows");
    const first = rules[0];
    if (!first) throw new TypeError("Sort rows requires at least one R sort rule.");
    return Object.freeze({
      id: step.id,
      kind: "sortRows" as const,
      params: Object.freeze({
        rules: rules as readonly [RKernelSortRule, ...RKernelSortRule[]]
      })
    });
  }
  if (step.kind === "filterRows") {
    return Object.freeze({
      id: step.id,
      kind: "filterRows" as const,
      params: Object.freeze({ filterModel: resolveTransformFilterModel(step.params.filterModel, inputSchema) })
    });
  }
  if (step.kind === "dropMissingRows") {
    const columns = resolveRowReductionColumns(step.params.columns, inputSchema, "Drop missing rows", true);
    return Object.freeze({
      id: step.id,
      kind: "dropMissingRows" as const,
      params: Object.freeze({
        ...(columns === undefined ? {} : { columns }),
        ...(step.params.how === undefined ? {} : { how: step.params.how })
      })
    });
  }
  if (step.kind === "dropDuplicates") {
    const columns = resolveRowReductionColumns(step.params.columns, inputSchema, "Drop duplicates", false);
    return Object.freeze({
      id: step.id,
      kind: "dropDuplicates" as const,
      params: Object.freeze({
        ...(columns === undefined
          ? {}
          : { columns: columns as readonly [RKernelColumnReference, ...RKernelColumnReference[]] }),
        ...(step.params.keep === undefined ? {} : { keep: step.params.keep })
      })
    });
  }
  if (step.kind === "groupBy") {
    const keys = step.params.keys.map((column) => Object.freeze({ ...column }));
    const firstKey = keys[0];
    const aggregations = step.params.aggregations.map((aggregation) =>
      Object.freeze({
        column: Object.freeze({ ...aggregation.column }),
        operation: aggregation.operation,
        alias: aggregation.alias
      })
    );
    const firstAggregation = aggregations[0];
    if (!firstKey || !firstAggregation) throw new TypeError("Group and aggregate requires a key and an aggregation.");
    return Object.freeze({
      id: step.id,
      kind: "groupBy" as const,
      params: Object.freeze({
        keys: Object.freeze(keys) as readonly [RKernelColumnReference, ...RKernelColumnReference[]],
        aggregations: Object.freeze(aggregations) as RKernelGroupByStep["params"]["aggregations"]
      })
    });
  }
  if (step.kind === "selectColumns") {
    const columns = step.params.columns.map((column) => Object.freeze({ ...column }));
    if (!columns[0]) throw new TypeError("Select Columns requires at least one R column.");
    return Object.freeze({
      id: step.id,
      kind: "selectColumns" as const,
      params: Object.freeze({
        columns: Object.freeze(columns) as readonly [RKernelColumnReference, ...RKernelColumnReference[]]
      })
    });
  }
  if (step.kind === "dropColumns") {
    const columns = step.params.columns.map((column) => Object.freeze({ ...column }));
    if (!columns[0]) throw new TypeError("Drop Columns requires at least one R column.");
    return Object.freeze({
      id: step.id,
      kind: "dropColumns" as const,
      params: Object.freeze({
        columns: Object.freeze(columns) as readonly [RKernelColumnReference, ...RKernelColumnReference[]]
      })
    });
  }
  if (step.kind === "cloneColumn") {
    return Object.freeze({
      id: step.id,
      kind: "cloneColumn" as const,
      params: Object.freeze({ column: Object.freeze({ ...step.params.column }), newName: step.params.newName })
    });
  }
  if (step.kind === "fillMissingValues") {
    return Object.freeze({
      id: step.id,
      kind: "fillMissingValues" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        replacement: freezeFillMissingReplacement(step.params.replacement, inputSchema, step.params.column.id)
      })
    });
  }
  if (step.kind === "castColumn") {
    return Object.freeze({
      id: step.id,
      kind: "castColumn" as const,
      params: Object.freeze({ column: Object.freeze({ ...step.params.column }), dtype: step.params.dtype })
    });
  }
  if (step.kind === "textLength") {
    return Object.freeze({
      id: step.id,
      kind: "textLength" as const,
      params: Object.freeze({ column: Object.freeze({ ...step.params.column }), newColumn: step.params.newColumn })
    });
  }
  if (step.kind === "capitalizeText") {
    return Object.freeze({
      id: step.id,
      kind: "capitalizeText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "stripText") {
    return Object.freeze({
      id: step.id,
      kind: "stripText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.params.characters === undefined ? {} : { characters: step.params.characters }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "splitText") {
    return Object.freeze({
      id: step.id,
      kind: "splitText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        delimiter: step.params.delimiter,
        index: step.params.index,
        newColumn: step.params.newColumn
      })
    });
  }
  if (step.kind === "lowerText") {
    return Object.freeze({
      id: step.id,
      kind: "lowerText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "upperText") {
    return Object.freeze({
      id: step.id,
      kind: "upperText" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (step.kind === "findReplace") {
    return Object.freeze({
      id: step.id,
      kind: "findReplace" as const,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        find: step.params.find,
        replacement: step.params.replacement,
        ...(step.params.regex === undefined ? {} : { regex: step.params.regex }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  if (isRNumericRoundingStep(step)) {
    return Object.freeze({
      id: step.id,
      kind: step.kind,
      params: Object.freeze({
        column: Object.freeze({ ...step.params.column }),
        ...(step.kind === "roundNumber" && step.params.decimals !== undefined
          ? { decimals: step.params.decimals }
          : {}),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      })
    });
  }
  return Object.freeze({
    id: step.id,
    kind: "renameColumn" as const,
    params: Object.freeze({ column: Object.freeze({ ...step.params.column }), newName: step.params.newName })
  });
}

function resolveRowReductionColumns(
  columns: readonly RKernelColumnReference[] | undefined,
  inputSchema: readonly ColumnSchema[],
  operation: "Drop missing rows" | "Drop duplicates",
  allowEmpty: boolean
): readonly RKernelColumnReference[] | undefined {
  if (columns === undefined) return undefined;
  if (allowEmpty && columns.length === 0) return undefined;
  if ((!allowEmpty && columns.length === 0) || columns.length > inputSchema.length) {
    throw new TypeError(`${operation} requires a bounded${allowEmpty ? "" : " non-empty"} R column selection.`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    columns.map((reference) => {
      if (seen.has(reference.id)) throw new TypeError(`${operation} cannot target the same R column more than once.`);
      seen.add(reference.id);
      const matches = inputSchema.filter((column) => column.id === reference.id && column.name === reference.name);
      if (matches.length !== 1) {
        throw new TypeError(`${operation} contains a column reference that no longer matches the active R dataframe.`);
      }
      const column = matches[0] as ColumnSchema;
      if (column.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
        throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
      }
      return Object.freeze({ id: column.id, name: column.name });
    })
  );
}

function copyRTransformStep(step: RTransformStep): RTransformStep {
  if (step.kind === "sortRows") {
    const rules = step.params.rules.map((rule) => ({ ...rule, column: { ...rule.column } }));
    const first = rules[0];
    if (!first) throw new TypeError("Sort rows requires at least one R sort rule.");
    return {
      id: step.id,
      kind: "sortRows",
      params: { rules: rules as SortRowsTransformStep["params"]["rules"] }
    };
  }
  if (step.kind === "filterRows") {
    return {
      id: step.id,
      kind: "filterRows",
      params: { filterModel: copyTransformFilterModel(step.params.filterModel) }
    };
  }
  if (step.kind === "dropMissingRows") {
    return {
      id: step.id,
      kind: "dropMissingRows",
      params: {
        ...(step.params.columns === undefined ? {} : { columns: step.params.columns.map((column) => ({ ...column })) }),
        ...(step.params.how === undefined ? {} : { how: step.params.how })
      }
    };
  }
  if (step.kind === "dropDuplicates") {
    const columns = step.params.columns?.map((column) => ({ ...column }));
    if (columns !== undefined && !columns[0]) {
      throw new TypeError("Drop duplicates requires at least one R column when a selection is supplied.");
    }
    return {
      id: step.id,
      kind: "dropDuplicates",
      params: {
        ...(columns === undefined
          ? {}
          : {
              columns: columns as [RKernelColumnReference, ...RKernelColumnReference[]]
            }),
        ...(step.params.keep === undefined ? {} : { keep: step.params.keep })
      }
    };
  }
  if (step.kind === "groupBy") {
    const keys = step.params.keys.map((column) => ({ ...column }));
    const aggregations = step.params.aggregations.map((aggregation) => ({
      column: { ...aggregation.column },
      operation: aggregation.operation,
      alias: aggregation.alias
    }));
    if (!keys[0] || !aggregations[0]) throw new TypeError("Group and aggregate requires a key and an aggregation.");
    return {
      id: step.id,
      kind: "groupBy",
      params: {
        keys: keys as GroupByTransformStep["params"]["keys"],
        aggregations: aggregations as GroupByTransformStep["params"]["aggregations"]
      }
    };
  }
  if (step.kind === "selectColumns") {
    const columns = step.params.columns.map((column) => ({ ...column }));
    if (!columns[0]) throw new TypeError("Select Columns requires at least one R column.");
    return {
      id: step.id,
      kind: "selectColumns",
      params: { columns: columns as [RKernelColumnReference, ...RKernelColumnReference[]] }
    };
  }
  if (step.kind === "dropColumns") {
    const columns = step.params.columns.map((column) => ({ ...column }));
    if (!columns[0]) throw new TypeError("Drop Columns requires at least one R column.");
    return {
      id: step.id,
      kind: "dropColumns",
      params: { columns: columns as [RKernelColumnReference, ...RKernelColumnReference[]] }
    };
  }
  if (step.kind === "cloneColumn") {
    return {
      id: step.id,
      kind: "cloneColumn",
      params: { column: { ...step.params.column }, newName: step.params.newName }
    };
  }
  if (step.kind === "fillMissingValues") {
    return {
      id: step.id,
      kind: "fillMissingValues",
      params: { column: { ...step.params.column }, replacement: copyFillMissingReplacement(step.params.replacement) }
    };
  }
  if (step.kind === "castColumn") {
    return {
      id: step.id,
      kind: "castColumn",
      params: { column: { ...step.params.column }, dtype: step.params.dtype }
    };
  }
  if (step.kind === "textLength") {
    return {
      id: step.id,
      kind: "textLength",
      params: { column: { ...step.params.column }, newColumn: step.params.newColumn }
    };
  }
  if (step.kind === "capitalizeText") {
    return {
      id: step.id,
      kind: "capitalizeText",
      params: {
        column: { ...step.params.column },
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "stripText") {
    return {
      id: step.id,
      kind: "stripText",
      params: {
        column: { ...step.params.column },
        ...(step.params.characters === undefined ? {} : { characters: step.params.characters }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "splitText") {
    return {
      id: step.id,
      kind: "splitText",
      params: {
        column: { ...step.params.column },
        delimiter: step.params.delimiter,
        index: step.params.index,
        newColumn: step.params.newColumn
      }
    };
  }
  if (step.kind === "lowerText") {
    return {
      id: step.id,
      kind: "lowerText",
      params: {
        column: { ...step.params.column },
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "upperText") {
    return {
      id: step.id,
      kind: "upperText",
      params: {
        column: { ...step.params.column },
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (step.kind === "findReplace") {
    return {
      id: step.id,
      kind: "findReplace",
      params: {
        column: { ...step.params.column },
        find: step.params.find,
        replacement: step.params.replacement,
        ...(step.params.regex === undefined ? {} : { regex: step.params.regex }),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  if (isRNumericRoundingStep(step)) {
    return {
      id: step.id,
      kind: step.kind,
      params: {
        column: { ...step.params.column },
        ...(step.kind === "roundNumber" && step.params.decimals !== undefined
          ? { decimals: step.params.decimals }
          : {}),
        ...(step.params.newColumn === undefined ? {} : { newColumn: step.params.newColumn })
      }
    };
  }
  return {
    id: step.id,
    kind: "renameColumn",
    params: { column: { ...step.params.column }, newName: step.params.newName }
  };
}

function copyTransformFilterModel(
  model: FilterRowsTransformStep["params"]["filterModel"]
): FilterRowsTransformStep["params"]["filterModel"] {
  return {
    ...(model.logic ? { logic: model.logic } : {}),
    filters: model.filters.map((filter) => ({
      ...filter,
      column: { ...filter.column },
      predicates: filter.predicates.map((predicate) => ({ ...predicate })),
      ...(filter.valueFilter
        ? {
            valueFilter: {
              ...filter.valueFilter,
              selectedValues: [...filter.valueFilter.selectedValues]
            }
          }
        : {})
    })),
    sort: model.sort.map((rule) => ({ ...rule, column: { ...rule.column } }))
  };
}

function copyRetainedStep(step: RetainedTransformStep): RetainedTransformStep {
  if (
    step.kind !== "sortRows" &&
    step.kind !== "filterRows" &&
    step.kind !== "dropMissingRows" &&
    step.kind !== "fillMissingValues" &&
    step.kind !== "dropDuplicates" &&
    step.kind !== "renameColumn" &&
    step.kind !== "cloneColumn" &&
    step.kind !== "castColumn" &&
    step.kind !== "textLength" &&
    step.kind !== "findReplace" &&
    step.kind !== "stripText" &&
    step.kind !== "splitText" &&
    step.kind !== "capitalizeText" &&
    step.kind !== "lowerText" &&
    step.kind !== "upperText" &&
    step.kind !== "roundNumber" &&
    step.kind !== "floorNumber" &&
    step.kind !== "ceilNumber" &&
    step.kind !== "groupBy" &&
    step.kind !== "dropColumns" &&
    step.kind !== "selectColumns"
  ) {
    throw new TypeError("The R bridge retained an unsupported cleaning step.");
  }
  return copyRTransformStep(step);
}

function retainedKeyPrefix(sourceKeyColumnIds: readonly string[], schema: readonly ColumnSchema[]): readonly string[] {
  const ids = new Set(schema.map((column) => column.id));
  const retained: string[] = [];
  for (const id of sourceKeyColumnIds) {
    if (!ids.has(id)) break;
    retained.push(id);
  }
  return retained;
}

function inspectionDiff(
  step: RTransformStep,
  inputSchema: readonly ColumnSchema[],
  outputSchema: readonly ColumnSchema[],
  inputPage: RFramePageContract,
  outputPage: RFramePageContract,
  inputRows: number,
  outputRows: number
): DataDiff {
  if (step.kind === "groupBy") {
    const inputIds = new Set(inputSchema.map((column) => column.id));
    const outputIds = new Set(outputSchema.map((column) => column.id));
    const fullyRepresented =
      inputPage.page.offset === 0 &&
      inputPage.page.totalRows === inputRows &&
      inputPage.page.rows.length === inputRows &&
      outputPage.page.offset === 0 &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    return {
      addedRows: outputRows,
      removedRows: inputRows,
      addedColumns: outputSchema.filter((column) => !inputIds.has(column.id)).map((column) => column.name),
      removedColumns: inputSchema.filter((column) => !outputIds.has(column.id)).map((column) => column.name),
      changedCells: 0,
      cells: [],
      truncated: !fullyRepresented
    };
  }
  if (step.kind === "sortRows" || isRRowReductionStep(step)) {
    const fullyRepresented =
      inputPage.page.offset === 0 &&
      outputPage.page.offset === 0 &&
      inputPage.page.totalRows === inputRows &&
      inputPage.page.rows.length === inputRows &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    return {
      addedRows: 0,
      removedRows: step.kind === "sortRows" ? 0 : inputRows - outputRows,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: !fullyRepresented
    };
  }
  if (
    inputPage.page.totalRows !== outputPage.page.totalRows ||
    inputPage.page.rows.length !== outputPage.page.rows.length ||
    inputPage.page.rows.some((row, index) => {
      const outputRow = outputPage.page.rows[index];
      return !outputRow || outputRow.id !== row.id || outputRow.rowNumber !== row.rowNumber;
    })
  ) {
    throw new Error("The R kernel returned inspection pages for different rows.");
  }
  const inputIds = new Set(inputSchema.map((column) => column.id));
  const outputIds = new Set(outputSchema.map((column) => column.id));
  const addedColumns = outputSchema.filter((column) => !inputIds.has(column.id)).map((column) => column.name);
  const removedColumns = inputSchema.filter((column) => !outputIds.has(column.id)).map((column) => column.name);
  const textTransformInPlace = isRTextTransformStep(step) && isRTextTransformInPlace(step);
  const numericRoundingInPlace = isRNumericRoundingStep(step) && isRNumericRoundingInPlace(step);
  const changedInPlace =
    step.kind === "castColumn" || step.kind === "fillMissingValues" || textTransformInPlace || numericRoundingInPlace;
  if (!changedInPlace) {
    return {
      addedRows: 0,
      removedRows: 0,
      addedColumns,
      removedColumns,
      changedCells: 0,
      cells: [],
      truncated: false
    };
  }

  const columnId = step.params.column.id;
  const inputPosition = inputPage.page.columnIds.indexOf(columnId);
  const outputPosition = outputPage.page.columnIds.indexOf(columnId);
  if (inputPosition < 0 || outputPosition < 0) {
    return {
      addedRows: 0,
      removedRows: 0,
      addedColumns,
      removedColumns,
      changedCells: 0,
      cells: [],
      truncated: true
    };
  }

  const inputRowsById = new Map(inputPage.page.rows.map((row) => [row.id, row]));
  const matchedInputIds = new Set<string>();
  const cells: DataDiff["cells"] = [];
  let changedCells = 0;
  for (const outputRow of outputPage.page.rows) {
    const inputRow = inputRowsById.get(outputRow.id);
    if (!inputRow) continue;
    matchedInputIds.add(inputRow.id);
    const before = cellValueFromR(inputRow.values[inputPosition] as RFrameCell);
    const after = cellValueFromR(outputRow.values[outputPosition] as RFrameCell);
    if (isDeepStrictEqual(before, after)) continue;
    changedCells += 1;
    if (cells.length < 500) {
      cells.push({
        rowNumber: outputRow.rowNumber,
        columnId,
        column: step.params.column.name,
        before,
        after
      });
    }
  }
  const unmatchedRows =
    matchedInputIds.size !== inputPage.page.rows.length || matchedInputIds.size !== outputPage.page.rows.length;
  return {
    addedRows: 0,
    removedRows: 0,
    addedColumns,
    removedColumns,
    changedCells,
    cells,
    truncated:
      unmatchedRows ||
      inputPage.page.totalRows > inputPage.page.rows.length ||
      outputPage.page.totalRows > outputPage.page.rows.length ||
      changedCells > cells.length
  };
}

function assertMutationDiff(
  step: RTransformStep,
  inputSchema: readonly ColumnSchema[],
  outputSchema: readonly ColumnSchema[],
  inputRows: number,
  outputRows: number,
  outputPage: RFramePageContract,
  diff: DataDiff
): void {
  if (step.kind === "groupBy") {
    const keyIds = new Set(step.params.keys.map((column) => column.id));
    const expectedOutputIds = [
      ...step.params.keys.map((column) => column.id),
      ...step.params.aggregations.map((_aggregation, index) => `c:step:${step.id}:${index}`)
    ];
    const expectedAdded = step.params.aggregations.map((aggregation) => aggregation.alias);
    const expectedRemoved = inputSchema.filter((column) => !keyIds.has(column.id)).map((column) => column.name);
    const outputFullyRepresented =
      outputPage.page.offset === 0 &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    const inputFullyRepresented = outputPage.page.offset === 0 && outputPage.page.limit >= inputRows;
    const expectedTruncated = !(inputFullyRepresented && outputFullyRepresented);
    const valid =
      isDeepStrictEqual(
        outputSchema.map((column) => column.id),
        expectedOutputIds
      ) &&
      diff.addedRows === outputRows &&
      diff.removedRows === inputRows &&
      isDeepStrictEqual(diff.addedColumns, expectedAdded) &&
      isDeepStrictEqual(diff.removedColumns, expectedRemoved) &&
      diff.changedCells === 0 &&
      diff.cells.length === 0 &&
      diff.truncated === expectedTruncated;
    if (!valid) throw new Error("The R kernel returned an invalid Group and aggregate diff.");
    return;
  }
  if (step.kind === "sortRows" || isRRowReductionStep(step)) {
    const expectedRemovedRows = step.kind === "sortRows" ? 0 : inputRows - outputRows;
    const fullyRepresented =
      outputPage.page.offset === 0 &&
      outputPage.page.totalRows === outputRows &&
      outputPage.page.rows.length === outputRows;
    const valid =
      isDeepStrictEqual(inputSchema, outputSchema) &&
      diff.addedRows === 0 &&
      diff.removedRows === expectedRemovedRows &&
      diff.addedColumns.length === 0 &&
      diff.removedColumns.length === 0 &&
      diff.changedCells === 0 &&
      diff.cells.length === 0 &&
      (fullyRepresented || diff.truncated);
    if (!valid) throw new Error("The R kernel returned an invalid row-operation diff.");
    return;
  }
  const outputIds = outputSchema.map((column) => column.id);
  const outputIdSet = new Set(outputIds);
  const inputIds = inputSchema.map((column) => column.id);
  const expectedRemoved = inputSchema.filter((column) => !outputIdSet.has(column.id)).map((column) => column.name);
  const textTransformInPlace = isRTextTransformStep(step) && isRTextTransformInPlace(step);
  const numericRoundingInPlace = isRNumericRoundingStep(step) && isRNumericRoundingInPlace(step);
  const changedInPlace =
    textTransformInPlace || numericRoundingInPlace || step.kind === "fillMissingValues" || step.kind === "castColumn";
  const expectedAdded =
    step.kind === "cloneColumn"
      ? [step.params.newName]
      : step.kind === "textLength"
        ? [step.params.newColumn]
        : isRTextTransformStep(step) && !textTransformInPlace
          ? [step.params.newColumn as string]
          : isRNumericRoundingStep(step) && !numericRoundingInPlace
            ? [step.params.newColumn as string]
            : [];
  const stepMatches =
    step.kind === "selectColumns"
      ? isDeepStrictEqual(
          outputIds,
          step.params.columns.map((column) => column.id)
        ) && expectedRemoved.length === inputSchema.length - step.params.columns.length
      : step.kind === "dropColumns"
        ? isDeepStrictEqual(
            outputIds,
            inputIds.filter((id) => !step.params.columns.some((column) => column.id === id))
          ) && expectedRemoved.length === step.params.columns.length
        : step.kind === "cloneColumn"
          ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
          : step.kind === "textLength"
            ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
            : isRTextTransformStep(step) && !textTransformInPlace
              ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
              : isRNumericRoundingStep(step) && !numericRoundingInPlace
                ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
                : isDeepStrictEqual(outputIds, inputIds) && expectedRemoved.length === 0;
  const projectedPosition = changedInPlace ? outputPage.page.columnIds.indexOf(step.params.column.id) : -1;
  const changedInput = changedInPlace
    ? inputSchema.find((column) => column.id === step.params.column.id && column.name === step.params.column.name)
    : undefined;
  const outputRowsByNumber = new Map(outputPage.page.rows.map((row) => [row.rowNumber, row]));
  const cellsMatch =
    changedInPlace && changedInput
      ? diff.changedCells <= outputPage.page.rows.length &&
        (projectedPosition >= 0 || (diff.changedCells === 0 && diff.cells.length === 0 && diff.truncated)) &&
        diff.cells.every((cell) => {
          const outputRow = outputRowsByNumber.get(cell.rowNumber);
          return (
            projectedPosition >= 0 &&
            outputRow !== undefined &&
            cell.columnId === step.params.column.id &&
            cell.column === step.params.column.name &&
            cell.before !== null &&
            cell.after !== null &&
            isCellCompatibleWithColumn(cell.before, changedInput) &&
            !isDeepStrictEqual(cell.before, cell.after) &&
            isDeepStrictEqual(cell.after, cellValueFromR(outputRow.values[projectedPosition] as RFrameCell))
          );
        }) &&
        diff.changedCells >= diff.cells.length &&
        (diff.truncated || diff.changedCells === diff.cells.length)
      : diff.changedCells === 0 && diff.cells.length === 0 && diff.truncated === false;
  const valid =
    diff.addedRows === 0 &&
    diff.removedRows === 0 &&
    isDeepStrictEqual(diff.addedColumns, expectedAdded) &&
    isDeepStrictEqual(diff.removedColumns, expectedRemoved) &&
    cellsMatch &&
    stepMatches;
  if (!valid) throw new Error("The R kernel returned a mutation diff for the wrong columns or cells.");
}

function isRTextTransformStep(
  step: RTransformStep
): step is
  | FindReplaceTransformStep
  | StripTextTransformStep
  | SplitTextTransformStep
  | CapitalizeTextTransformStep
  | LowerTextTransformStep
  | UpperTextTransformStep {
  return (
    step.kind === "findReplace" ||
    step.kind === "stripText" ||
    step.kind === "splitText" ||
    step.kind === "capitalizeText" ||
    step.kind === "lowerText" ||
    step.kind === "upperText"
  );
}

function isRTextTransformInPlace(
  step:
    | FindReplaceTransformStep
    | StripTextTransformStep
    | SplitTextTransformStep
    | CapitalizeTextTransformStep
    | LowerTextTransformStep
    | UpperTextTransformStep
): boolean {
  return step.params.newColumn === undefined || step.params.newColumn === step.params.column.name;
}

function isCellCompatibleWithColumn(cell: CellValue, column: ColumnSchema): boolean {
  if (cell.isNull) return column.nullable && cell.kind === "null";
  if (cell.isNaN) return column.type === "float" && cell.kind === "nan";
  if (cell.kind === "infinity") return column.type === "float";
  const expectedKinds: Readonly<Record<ColumnSchema["type"], readonly CellValue["kind"][]>> = {
    string: ["string"],
    integer: ["integer"],
    float: ["number"],
    decimal: ["decimal"],
    boolean: ["boolean"],
    datetime: ["datetime"],
    date: ["date"],
    duration: ["duration"],
    binary: [],
    list: [],
    struct: [],
    unknown: []
  };
  return cell.isNull === false && cell.isNaN === false && expectedKinds[column.type].includes(cell.kind);
}

function copyDiff(diff: DataDiff): DataDiff {
  return {
    addedRows: diff.addedRows,
    removedRows: diff.removedRows,
    addedColumns: [...diff.addedColumns],
    removedColumns: [...diff.removedColumns],
    changedCells: diff.changedCells,
    cells: diff.cells.map((cell) => ({
      ...cell,
      before: cell.before ? { ...cell.before } : null,
      after: cell.after ? { ...cell.after } : null
    })),
    truncated: diff.truncated
  };
}

function clearDraft(session: RBridgeSession): void {
  session.draftStep = undefined;
  session.draftReplacesStepId = undefined;
  session.draftInputSchema = undefined;
  session.draftInputRSchema = undefined;
  session.draftInputRows = undefined;
  session.draftInputIdentityRows = undefined;
  session.draftInputKeyColumnIds = undefined;
  session.draftBaseFilterModel = undefined;
  session.draftBaseViewChangeEpoch = undefined;
}

function validateMutationRequest(
  session: RBridgeSession | undefined,
  revision: number,
  request: PageWindowCoordinates & Readonly<{ sessionId: string }>
): ErrorResponse | undefined {
  if (!session) return unknownSessionError(request.sessionId);
  if (session.invalidated) return kernelChangedError(request.sessionId);
  if (session.mode !== "editing") {
    return errorResponse(
      "unsupported_mode",
      "Change this R session to Editing mode before adding cleaning steps.",
      true,
      request.sessionId
    );
  }
  const stale = staleRevisionError(session, revision);
  if (stale) return stale;
  try {
    validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
  } catch (error) {
    return errorResponse(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
      true,
      request.sessionId
    );
  }
  return undefined;
}

function staleRevisionError(
  session: RBridgeSession,
  revision: number,
  viewRequestId?: string
): ErrorResponse | undefined {
  return revision === session.revision
    ? undefined
    : errorResponse(
        "stale_revision",
        `This R session is at revision ${session.revision}, not ${revision}.`,
        true,
        session.sessionId,
        viewRequestId
      );
}

function staleResponseError(sessionId: string, viewRequestId?: string): ErrorResponse {
  return errorResponse(
    "stale_response",
    "Ignored an R kernel response for an older session state.",
    true,
    sessionId,
    viewRequestId
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
    "This operation is not available for R sessions yet.",
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
    "The originating R runtime changed. Reopen the variable from its source.",
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
