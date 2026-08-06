import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import {
  PROTOCOL_VERSION,
  type CellValue,
  type CloneColumnTransformStep,
  type ColumnSchema,
  type ColumnSummary,
  type DataDiff,
  type DatasetStatsRequest,
  type DropColumnsTransformStep,
  type ErrorResponse,
  type FilterModel,
  type GridPage,
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
  type SelectColumnsTransformStep,
  type SessionMetadata,
  type SessionMode,
  type SessionSource,
  type SummaryRequest,
  type TextLengthTransformStep,
  type SourceCapabilities,
  type ValueCount,
  type ValuesRequest
} from "../../shared/protocol";
import { DetachedBridgeRequestError, type BridgeRequestOptions, type OpenWranglerBridge } from "../dataBridge";
import {
  RKernelDiagnosticError,
  RKernelSessionTransport,
  type RKernelOpenResult,
  type RKernelRequestOptions
} from "./rKernelTransport";
import type {
  RKernelColumnFilter,
  RKernelColumnReference,
  RKernelDatasetStatsResult,
  RKernelPageWindow,
  RKernelPlanUpdatedResult,
  RKernelTransformStep,
  RKernelSortRule,
  RKernelStepInspectionResult,
  RKernelStepPreviewResult,
  RKernelViewQuery
} from "./rKernelProtocol";
import {
  R_FRAME_CONTRACT_LIMITS,
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
const R_PRIVATE_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_";
const R_SUPPORTED_OPERATIONS = Object.freeze([
  "selectColumns",
  "dropColumns",
  "renameColumn",
  "cloneColumn",
  "textLength",
  "lowerText"
] as OperationKind[]) as OperationKind[];

type RTransformStep =
  | RenameColumnTransformStep
  | CloneColumnTransformStep
  | TextLengthTransformStep
  | LowerTextTransformStep
  | DropColumnsTransformStep
  | SelectColumnsTransformStep;

const R_CAPABILITIES: SourceCapabilities = Object.freeze({
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
  supportedOperations: R_SUPPORTED_OPERATIONS
});

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
  ): Promise<Readonly<{ column: string; values: readonly ValueCount[]; hasMore: boolean }>>;
  previewStep(
    sessionId: string,
    revision: number,
    step: RKernelTransformStep,
    page: RKernelPageWindow,
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
    options?: RKernelRequestOptions
  ): Promise<RKernelStepInspectionResult>;
  close(sessionId: string, options?: RKernelRequestOptions): Promise<void>;
  isSessionMapped(sessionId: string): boolean;
  dispose(): Promise<void>;
}

interface RBridgeSession {
  readonly sessionId: string;
  readonly source: SessionSource;
  readonly dataframeFlavor: RDataframeFlavor;
  readonly shape: Readonly<{ rows: number; columns: number }>;
  readonly sourceSchema: readonly ColumnSchema[];
  readonly sourceKeyColumnIds: readonly string[];
  readonly rowNames: RFramePageContract["frameSemantics"]["rowNames"];
  mode: SessionMode;
  revision: number;
  schema: readonly ColumnSchema[];
  committedSchema: readonly ColumnSchema[];
  filterModel: FilterModel;
  steps: readonly RetainedTransformStep[];
  planInputSchemas: readonly (readonly ColumnSchema[])[];
  draftStep?: RTransformStep;
  draftReplacesStepId?: string;
  draftInputSchema?: readonly ColumnSchema[];
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
      return new RKernelBridge(context, notebookDocument, transport, randomUUID, diagnosticSink, binding.variable);
    } catch (error) {
      binding.dispose();
      throw error;
    }
  }

  constructor(
    context: vscode.ExtensionContext,
    notebookDocument: vscode.NotebookDocument,
    transport: RKernelBridgeTransport,
    private readonly createSessionId: () => string = randomUUID,
    diagnosticSink?: (message: string) => void,
    private readonly verifiedVariable?: RNotebookVariableDescriptor
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
        "The R variable no longer matches the dataframe selected from the notebook picker.",
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
      const session = sessionFromContract(sessionId, request.source, request.mode ?? "viewing", result.page);
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
      assertSessionContract(session, contract, request, expectedSchema);
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
      assertSummaryContract(confirmed, columns, summaries);
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
      assertColumnValuesContract(session, column, result, request.limit);
      return {
        kind: "columnValues",
        revision: session.revision,
        viewRequestId: request.viewRequestId,
        column: result.column,
        values: result.values.map((entry) => ({ ...entry })),
        hasMore: result.hasMore
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
      request.step.kind !== "renameColumn" &&
      request.step.kind !== "cloneColumn" &&
      request.step.kind !== "textLength" &&
      request.step.kind !== "lowerText" &&
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
    } else {
      if (confirmed.steps.some((step) => step.id === request.step.id)) {
        return errorResponse("invalid_request", "Applied R step IDs must be unique.", true, request.sessionId);
      }
      inputSchema = confirmed.committedSchema;
    }

    let targetSchema: readonly ColumnSchema[];
    let nextFilterModel: FilterModel;
    let view: RKernelViewQuery;
    try {
      targetSchema = schemaAfterRStep(
        inputSchema,
        request.step,
        retainedKeyPrefix(confirmed.sourceKeyColumnIds, inputSchema)
      );
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
    const rStep = rTransformStep(request.step);
    try {
      const result = await this.transport.previewStep(
        request.sessionId,
        expectedRevision,
        rStep,
        pageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit, view),
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
      assertMutationContract(confirmed, result.page, request, targetSchema);
      assertMutationDiff(request.step, inputSchema, targetSchema, result.page, result.diff);

      confirmed.revision = result.revision;
      confirmed.schema = schemaFromContract(result.page);
      confirmed.filterModel = nextFilterModel;
      confirmed.draftStep = copyRTransformStep(request.step);
      confirmed.draftReplacesStepId = request.replaceStepId;
      confirmed.draftInputSchema = copySchema(inputSchema);
      confirmed.draftBaseFilterModel = draftBaseFilterModel;
      confirmed.draftBaseViewChangeEpoch = draftBaseViewChangeEpoch;
      return {
        kind: "stepPreview",
        revision: confirmed.revision,
        metadata: metadataFor(confirmed, result.page.page.totalRows),
        page: gridPageFromContract(result.page),
        diff: copyDiff(result.diff),
        code: result.code,
        warnings: []
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
    let nextFilterModel: FilterModel;
    if (request.kind === "applyDraft") {
      if (!confirmed.draftStep || !confirmed.draftInputSchema) {
        return errorResponse("invalid_request", "There is no R draft step to apply.", true, request.sessionId);
      }
      targetSchema = confirmed.schema;
      nextFilterModel = copyFilterModel(confirmed.filterModel);
    } else if (request.kind === "discardDraft") {
      if (!confirmed.draftStep || !confirmed.draftInputSchema) {
        return errorResponse("invalid_request", "There is no R draft step to discard.", true, request.sessionId);
      }
      targetSchema = confirmed.committedSchema;
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
      assertMutationContract(confirmed, result.page, request, targetSchema);

      const priorRestore = confirmed.lastAppliedViewRestore;
      if (request.kind === "applyDraft") {
        const draftStep = confirmed.draftStep as RTransformStep;
        const draftInputSchema = confirmed.draftInputSchema as readonly ColumnSchema[];
        if (confirmed.draftReplacesStepId === undefined) {
          confirmed.steps = [...confirmed.steps, copyRTransformStep(draftStep)];
          confirmed.planInputSchemas = [...confirmed.planInputSchemas, copySchema(draftInputSchema)];
        } else {
          confirmed.steps = [...confirmed.steps.slice(0, -1), copyRTransformStep(draftStep)];
          confirmed.planInputSchemas = [...confirmed.planInputSchemas.slice(0, -1), copySchema(draftInputSchema)];
        }
        confirmed.committedSchema = schemaFromContract(result.page);
        if (confirmed.draftBaseViewChangeEpoch === confirmed.viewChangeEpoch && confirmed.draftBaseFilterModel) {
          let before = copyFilterModel(confirmed.draftBaseFilterModel);
          if (
            confirmed.draftReplacesStepId === draftStep.id &&
            priorRestore?.stepId === draftStep.id &&
            priorRestore.viewChangeEpoch === confirmed.viewChangeEpoch &&
            isDeepStrictEqual(priorRestore.after, confirmed.draftBaseFilterModel)
          ) {
            before = copyFilterModel(priorRestore.before);
          }
          confirmed.lastAppliedViewRestore = {
            stepId: draftStep.id,
            before,
            after: copyFilterModel(nextFilterModel),
            viewChangeEpoch: confirmed.viewChangeEpoch
          };
        } else {
          confirmed.lastAppliedViewRestore = undefined;
        }
      } else if (request.kind === "undoStep") {
        confirmed.steps = confirmed.steps.slice(0, -1);
        confirmed.planInputSchemas = confirmed.planInputSchemas.slice(0, -1);
        confirmed.committedSchema = schemaFromContract(result.page);
        confirmed.lastAppliedViewRestore = undefined;
      }

      confirmed.revision = result.revision;
      confirmed.schema = schemaFromContract(result.page);
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
    const outputSchema =
      session.planInputSchemas[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedSchema : undefined);
    if (!outputSchema) throw new Error("The R bridge is missing an applied-step output schema.");
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
      assertMutationContract(session, result.inputPage, request, inputSchema);
      assertMutationContract(session, result.outputPage, request, outputSchema);
      if (!sameSchema(inputSchema, result.inputSchema) || !sameSchema(outputSchema, result.outputSchema)) {
        throw new Error("The R kernel returned mismatched applied-step schemas.");
      }
      assertMutationDiff(
        session.steps[stepIndex] as RTransformStep,
        inputSchema,
        outputSchema,
        result.outputPage,
        result.diff
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
        diff: copyDiff(result.diff),
        code: result.code
      };
    } catch (error) {
      if (session.invalidated) return kernelChangedError(request.sessionId);
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
  result: Readonly<{ column: string; values: readonly ValueCount[]; hasMore: boolean }>,
  limit: number
): void {
  const schema = session.schema.find((column) => column.id === requested.id);
  if (!schema || schema.name !== requested.name || result.column !== requested.name || result.values.length > limit) {
    throw new Error("The R kernel returned values for the wrong column or request limit.");
  }
  const expectedType = requireRColumnType(schema.type);
  if (
    result.values.some(
      (entry) =>
        !Number.isSafeInteger(entry.count) ||
        entry.count < 1 ||
        entry.selectionValue === undefined ||
        entry.selectionValue.columnType !== expectedType
    )
  ) {
    throw new Error("The R kernel returned values with incompatible typed selections.");
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
  summaries: readonly ColumnSummary[]
): void {
  if (summaries.length !== requested.length) {
    throw new Error("The R kernel returned summaries for the wrong column projection.");
  }
  const schemaById = new Map(session.schema.map((column) => [column.id, column]));
  const totalRows = summaries[0]?.totalCount ?? 0;
  if (totalRows > session.shape.rows || summaries.some((summary) => summary.totalCount !== totalRows)) {
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
  if (
    rows > session.shape.rows ||
    (view.filters.length === 0 && rows !== session.shape.rows) ||
    result.stats.missingRows > rows ||
    result.stats.duplicateRows > Math.max(0, rows - 1) ||
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
  contract: RFramePageContract
): RBridgeSession {
  const schema = schemaFromContract(contract);
  return {
    sessionId,
    source: copySource(source),
    dataframeFlavor: contract.dataframeFlavor,
    shape: Object.freeze({ ...contract.shape }),
    sourceSchema: schema,
    sourceKeyColumnIds: Object.freeze([...contract.frameSemantics.keyColumnIds]),
    committedSchema: schema,
    schema,
    rowNames: contract.frameSemantics.rowNames,
    mode,
    revision: 0,
    filterModel: emptyFilterModel(),
    steps: Object.freeze([]),
    planInputSchemas: Object.freeze([]),
    viewChangeEpoch: 0,
    invalidated: false
  };
}

function metadataFor(session: RBridgeSession, filteredRows: number = session.shape.rows): SessionMetadata {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: session.sessionId,
    revision: session.revision,
    backend: "r",
    rDataframeFlavor: session.dataframeFlavor,
    mode: session.mode,
    source: copySource(session.source),
    capabilities: R_CAPABILITIES,
    shape: { rows: session.shape.rows, columns: session.schema.length },
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
  expectedSchema: readonly ColumnSchema[]
): void {
  const resolvedColumnOffset = Math.min(request.columnOffset, expectedSchema.length);
  const expectedColumnIds = expectedSchema
    .slice(resolvedColumnOffset, resolvedColumnOffset + request.columnLimit)
    .map((column) => column.id);
  const expectedKeyColumnIds = retainedKeyPrefix(session.sourceKeyColumnIds, expectedSchema);
  const mismatches = [
    contract.dataframeFlavor === session.dataframeFlavor ? undefined : "dataframe flavor",
    contract.shape.rows === session.shape.rows ? undefined : "row count",
    contract.shape.columns === expectedSchema.length ? undefined : "column count",
    contract.frameSemantics.rowNames === session.rowNames ? undefined : "row-name semantics",
    isDeepStrictEqual(contract.frameSemantics.keyColumnIds, expectedKeyColumnIds) ? undefined : "key columns",
    contract.page.offset === request.offset ? undefined : "row offset",
    contract.page.limit === request.limit ? undefined : "row limit",
    contract.page.totalRows <= session.shape.rows ? undefined : "filtered row count",
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
  expectedSchema: readonly ColumnSchema[]
): void {
  assertSessionContract(session, contract, request, expectedSchema);
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
  if (step.kind === "selectColumns") return schemaAfterSelect(inputSchema, step);
  if (step.kind === "dropColumns") return schemaAfterDrop(inputSchema, step);
  if (step.kind === "cloneColumn") return schemaAfterClone(inputSchema, step);
  if (step.kind === "textLength") return schemaAfterTextLength(inputSchema, step);
  if (step.kind === "lowerText") return schemaAfterLowerText(inputSchema, step, activeKeyColumnIds);
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

function schemaAfterLowerText(
  inputSchema: readonly ColumnSchema[],
  step: LowerTextTransformStep,
  activeKeyColumnIds: readonly string[]
): readonly ColumnSchema[] {
  const matches = inputSchema.filter(
    (column) => column.id === step.params.column.id && column.name === step.params.column.name
  );
  if (matches.length !== 1) {
    throw new TypeError("The lowercase column reference no longer matches the active R dataframe.");
  }
  const source = matches[0] as ColumnSchema;
  if (source.name.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("Open Wrangler's reserved private row-identity column may not be transformed.");
  }
  if (source.type !== "string") throw new TypeError("Lowercase requires an R string or factor column.");
  const outputName = step.params.newColumn;
  if (outputName !== undefined && outputName.length === 0) {
    throw new TypeError("The lowercase R column name may not be empty.");
  }
  const inPlace = outputName === undefined || outputName === source.name;
  if (inPlace) {
    if (activeKeyColumnIds.includes(source.id)) {
      throw new TypeError(
        "Lowercase cannot replace a keyed data.table column in place. Choose a new output column instead."
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
    throw new TypeError("Lowercase exceeds the R frame contract column limit.");
  }
  if (Buffer.byteLength(outputName, "utf8") > R_FRAME_CONTRACT_LIMITS.nameBytes) {
    throw new TypeError("The lowercase R column name exceeds the frame contract limit.");
  }
  if (outputName.toLowerCase().startsWith(R_PRIVATE_ROW_ID_PREFIX)) {
    throw new TypeError("The lowercase R column name uses Open Wrangler's reserved private row-identity prefix.");
  }
  if (inputSchema.some((column) => column.name === outputName)) {
    throw new TypeError(`The R column name ${JSON.stringify(outputName)} already exists.`);
  }
  const id = `c:step:${step.id}:0`;
  if (Buffer.byteLength(id, "utf8") > R_FRAME_CONTRACT_LIMITS.columnIdBytes) {
    throw new TypeError("The lowercase R column identity exceeds the frame contract limit.");
  }
  if (inputSchema.some((column) => column.id === id)) {
    throw new TypeError("The lowercase R column identity already exists in the active dataframe.");
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

function rTransformStep(step: RTransformStep): RKernelTransformStep {
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
  if (step.kind === "textLength") {
    return Object.freeze({
      id: step.id,
      kind: "textLength" as const,
      params: Object.freeze({ column: Object.freeze({ ...step.params.column }), newColumn: step.params.newColumn })
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
  return Object.freeze({
    id: step.id,
    kind: "renameColumn" as const,
    params: Object.freeze({ column: Object.freeze({ ...step.params.column }), newName: step.params.newName })
  });
}

function copyRTransformStep(step: RTransformStep): RTransformStep {
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
  if (step.kind === "textLength") {
    return {
      id: step.id,
      kind: "textLength",
      params: { column: { ...step.params.column }, newColumn: step.params.newColumn }
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
  return {
    id: step.id,
    kind: "renameColumn",
    params: { column: { ...step.params.column }, newName: step.params.newName }
  };
}

function copyRetainedStep(step: RetainedTransformStep): RetainedTransformStep {
  if (
    step.kind !== "renameColumn" &&
    step.kind !== "cloneColumn" &&
    step.kind !== "textLength" &&
    step.kind !== "lowerText" &&
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

function assertMutationDiff(
  step: RTransformStep,
  inputSchema: readonly ColumnSchema[],
  outputSchema: readonly ColumnSchema[],
  outputPage: RFramePageContract,
  diff: DataDiff
): void {
  const outputIds = outputSchema.map((column) => column.id);
  const outputIdSet = new Set(outputIds);
  const inputIds = inputSchema.map((column) => column.id);
  const expectedRemoved = inputSchema.filter((column) => !outputIdSet.has(column.id)).map((column) => column.name);
  const lowerInPlace =
    step.kind === "lowerText" &&
    (step.params.newColumn === undefined || step.params.newColumn === step.params.column.name);
  const expectedAdded =
    step.kind === "cloneColumn"
      ? [step.params.newName]
      : step.kind === "textLength"
        ? [step.params.newColumn]
        : step.kind === "lowerText" && !lowerInPlace
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
            : step.kind === "lowerText" && !lowerInPlace
              ? isDeepStrictEqual(outputIds, [...inputIds, `c:step:${step.id}:0`]) && expectedRemoved.length === 0
              : isDeepStrictEqual(outputIds, inputIds) && expectedRemoved.length === 0;
  const projectedPosition = lowerInPlace ? outputPage.page.columnIds.indexOf(step.params.column.id) : -1;
  const outputRowsByNumber = new Map(outputPage.page.rows.map((row) => [row.rowNumber, row]));
  const cellsMatch = lowerInPlace
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
