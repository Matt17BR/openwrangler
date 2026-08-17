import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import { operationKinds } from "../../shared/operationCatalog.generated";
import {
  PROTOCOL_VERSION,
  type ColumnSchema,
  type ColumnSummary,
  type DatasetStatsRequest,
  type ErrorResponse,
  type ExportDataRequest,
  type FilterModel,
  type InspectStepRequest,
  type OpenSessionRequest,
  type OperationKind,
  type OpenWranglerRequest,
  type OpenWranglerResponse,
  type PageRequest,
  type PreviewStepRequest,
  type RetainedTransformStep,
  type RowAxis,
  type SessionMetadata,
  type SessionMode,
  type SessionSource,
  type SummaryRequest,
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
import {
  type RKernelColumnReference,
  type RKernelDataExportResult,
  type RKernelDatasetStatsResult,
  type RKernelExportFormat,
  type RKernelPageWindow,
  type RKernelPlanUpdatedResult,
  type RKernelTransformStep,
  type RKernelStepInspectionResult,
  type RKernelStepPreviewResult,
  type RKernelViewQuery
} from "./rKernelProtocol";
import {
  R_FRAME_CONTRACT_LIMITS,
  type RColumnSchema,
  type RDataframeFlavor,
  type RFramePageContract
} from "./rFrameContract";
import {
  copyRSchema as copySchema,
  emptyRViewQuery,
  gridPageFromRContract as gridPageFromContract,
  rPageWindow as pageWindow,
  sameRSchema as sameSchema,
  schemaFromRContract as schemaFromContract,
  validateRPageWindow as validatePageWindow
} from "./rKernelFrameMapping";
import { reconcileFilterModelById } from "./rKernelColumnSchema";
import { rTransformStep, type RTransformStep } from "./rKernelTransformBinding";
import {
  assertMutationDiff,
  categoricalRetainedSchema,
  copyDiff,
  inspectionDiff,
  isRCategoricalTransformStep
} from "./rKernelMutationDiff";
import {
  acceptRetainedByExampleStep,
  assertCustomDerivedRowIdentities,
  customRowIdentityConstraintAfterRStep,
  dynamicByExampleSchema,
  dynamicCategoricalSchema,
  dynamicCustomCodeSchema,
  keyColumnsAfterRStep,
  rowCountAfterRStep,
  rowIdentityDomainAfterRStep,
  rowNamesAfterRStep,
  schemaAfterRStep,
  type RCustomRowIdentityConstraint
} from "./rKernelMutationSchema";
import { copyRetainedStep, copyRTransformStep } from "./rKernelTransformState";
import {
  assertRColumnValuesContract as assertColumnValuesContract,
  assertRDatasetStatsContract as assertDatasetStatsContract,
  assertRSummaryContract as assertSummaryContract,
  resolveNamedRColumn as resolveNamedColumn,
  resolveRProfileColumns as resolveProfileColumns,
  resolveRViewQuery as resolveViewQuery
} from "./rKernelViewContract";
import {
  claimVerifiedRNotebookVariableSelection,
  type RNotebookVariableDescriptor,
  type VerifiedRNotebookVariableSelection
} from "./rNotebookVariableDiscovery";

const CLOSED_SESSION_LIMIT = 1_024;
const R_DATA_EXPORT_TIMEOUT_MS = 30 * 60_000;

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
  supportedOperations: operationKinds as OperationKind[]
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
  committedRowNames: RFramePageContract["frameSemantics"]["rowNames"];
  committedCustomRowIdentities: RCustomRowIdentityConstraint | undefined;
  filterModel: FilterModel;
  rows: number;
  identityRows: number;
  keyColumnIds: readonly string[];
  customRowIdentities: RCustomRowIdentityConstraint | undefined;
  steps: readonly RetainedTransformStep[];
  planInputSchemas: readonly (readonly ColumnSchema[])[];
  planInputRSchemas: readonly (readonly RColumnSchema[])[];
  planInputRows: readonly number[];
  planInputIdentityRows: readonly number[];
  planInputKeyColumnIds: readonly (readonly string[])[];
  planInputRowNames: readonly RFramePageContract["frameSemantics"]["rowNames"][];
  planInputCustomRowIdentities: readonly (RCustomRowIdentityConstraint | undefined)[];
  draftStep?: RTransformStep;
  draftReplacesStepId?: string;
  draftInputSchema?: readonly ColumnSchema[];
  draftInputRSchema?: readonly RColumnSchema[];
  draftInputRows?: number;
  draftInputIdentityRows?: number;
  draftInputKeyColumnIds?: readonly string[];
  draftInputRowNames?: RFramePageContract["frameSemantics"]["rowNames"];
  draftInputCustomRowIdentities: RCustomRowIdentityConstraint | undefined;
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
      assertCustomDerivedRowIdentities(contract, session.customRowIdentities, view);
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
    const requestedStepKind: string = request.step.kind;
    if (
      request.step.kind !== "sortRows" &&
      request.step.kind !== "filterRows" &&
      request.step.kind !== "dropMissingRows" &&
      request.step.kind !== "fillMissingValues" &&
      request.step.kind !== "dropDuplicates" &&
      request.step.kind !== "renameColumn" &&
      request.step.kind !== "cloneColumn" &&
      request.step.kind !== "castColumn" &&
      request.step.kind !== "formula" &&
      request.step.kind !== "textLength" &&
      request.step.kind !== "oneHotEncode" &&
      request.step.kind !== "multiLabelBinarize" &&
      request.step.kind !== "findReplace" &&
      request.step.kind !== "stripText" &&
      request.step.kind !== "splitText" &&
      request.step.kind !== "capitalizeText" &&
      request.step.kind !== "lowerText" &&
      request.step.kind !== "upperText" &&
      request.step.kind !== "minMaxScale" &&
      request.step.kind !== "roundNumber" &&
      request.step.kind !== "floorNumber" &&
      request.step.kind !== "ceilNumber" &&
      request.step.kind !== "formatDatetime" &&
      request.step.kind !== "groupBy" &&
      request.step.kind !== "byExample" &&
      request.step.kind !== "customCode" &&
      request.step.kind !== "dropColumns" &&
      request.step.kind !== "selectColumns"
    ) {
      return errorResponse(
        "unsupported_operation",
        `The native R runtime does not support ${requestedStepKind}.`,
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
    let inputCustomRowIdentities: RCustomRowIdentityConstraint | undefined;
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
      inputRowNames = confirmed.planInputRowNames.at(-1) ?? confirmed.sourceRowNames;
      inputCustomRowIdentities = confirmed.planInputCustomRowIdentities.at(-1);
    } else {
      if (confirmed.steps.some((step) => step.id === request.step.id)) {
        return errorResponse("invalid_request", "Applied R step IDs must be unique.", true, request.sessionId);
      }
      inputSchema = confirmed.committedSchema;
      inputRSchema = confirmed.committedRSchema;
      inputRows = confirmed.committedRows;
      inputIdentityRows = confirmed.committedIdentityRows;
      inputKeyColumnIds = confirmed.committedKeyColumnIds;
      inputRowNames = confirmed.committedRowNames;
      inputCustomRowIdentities = confirmed.committedCustomRowIdentities;
    }

    let targetSchema: readonly ColumnSchema[];
    let targetKeyColumnIds: readonly string[];
    let nextFilterModel: FilterModel;
    let view: RKernelViewQuery;
    let rStep: RKernelTransformStep;
    let retainedStep: RTransformStep;
    let targetRowNames: RFramePageContract["frameSemantics"]["rowNames"];
    try {
      targetSchema =
        request.step.kind === "byExample" || request.step.kind === "customCode"
          ? Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })))
          : isRCategoricalTransformStep(request.step)
            ? categoricalRetainedSchema(inputSchema, request.step)
            : schemaAfterRStep(inputSchema, request.step, inputKeyColumnIds);
      targetKeyColumnIds = keyColumnsAfterRStep(inputKeyColumnIds, targetSchema, request.step);
      rStep = rTransformStep(request.step, inputSchema);
      targetRowNames = rowNamesAfterRStep(inputRowNames, request.step);
      nextFilterModel =
        request.step.kind === "customCode"
          ? copyFilterModel(confirmed.filterModel)
          : reconcileFilterModelById(confirmed.filterModel, confirmed.schema, targetSchema);
      view = resolveViewQuery(nextFilterModel, request.step.kind === "customCode" ? confirmed.schema : targetSchema);
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
      if ((request.step.kind === "customCode") !== (result.effectiveView !== undefined)) {
        throw new Error("The R kernel returned an effective view for the wrong draft operation.");
      }
      if (isRCategoricalTransformStep(request.step)) {
        targetSchema = dynamicCategoricalSchema(inputSchema, inputRSchema, request.step, result.page);
        targetKeyColumnIds = keyColumnsAfterRStep(inputKeyColumnIds, targetSchema, request.step);
        const resolvedView = resolveViewQuery(nextFilterModel, targetSchema);
        if (!isDeepStrictEqual(resolvedView, view)) {
          throw new Error("The R categorical schema changed the pre-dispatch viewing query.");
        }
      }
      if (request.step.kind === "customCode") {
        const effectiveView = result.effectiveView;
        if (effectiveView === undefined) {
          throw new Error("The R custom-code preview omitted its effective view.");
        }
        if (result.retainedStep !== undefined) {
          throw new Error("The R kernel returned a retained step for the wrong draft operation.");
        }
        retainedStep = copyRTransformStep(request.step);
        targetSchema = dynamicCustomCodeSchema(inputSchema, request.step, result.page);
        targetKeyColumnIds = Object.freeze([...result.page.frameSemantics.keyColumnIds]);
        targetRowNames = result.page.frameSemantics.rowNames;
        nextFilterModel = reconcileFilterModelById(confirmed.filterModel, confirmed.schema, targetSchema);
        const resolvedView = resolveViewQuery(nextFilterModel, targetSchema);
        if (!isDeepStrictEqual(resolvedView, effectiveView)) {
          throw new Error("The R custom-code preview returned a mismatched effective view.");
        }
        view = effectiveView;
      } else if (request.step.kind === "byExample") {
        retainedStep = acceptRetainedByExampleStep(result.retainedStep, rStep, inputSchema);
        targetSchema = dynamicByExampleSchema(inputSchema, inputRSchema, retainedStep, result.page);
        targetKeyColumnIds = keyColumnsAfterRStep(inputKeyColumnIds, targetSchema, retainedStep);
        const resolvedView = resolveViewQuery(nextFilterModel, targetSchema);
        if (!isDeepStrictEqual(resolvedView, view)) {
          throw new Error("The R by-example schema changed the pre-dispatch viewing query.");
        }
      } else {
        if (result.retainedStep !== undefined) {
          throw new Error("The R kernel returned a retained step for the wrong draft operation.");
        }
        retainedStep = copyRTransformStep(request.step);
      }
      const targetRows = rowCountAfterRStep(request.step, inputRows, result.diff);
      const targetIdentityRows = rowIdentityDomainAfterRStep(request.step, inputIdentityRows, targetRows);
      const targetCustomRowIdentities = customRowIdentityConstraintAfterRStep(
        request.step,
        inputCustomRowIdentities,
        inputIdentityRows,
        targetRows
      );
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
          : request.step.kind === "minMaxScale"
            ? {
                columnId:
                  request.step.params.newColumn === undefined ||
                  request.step.params.newColumn === request.step.params.column.name
                    ? request.step.params.column.id
                    : `c:step:${request.step.id}:0`,
                mode: "mayAdd"
              }
            : request.step.kind === "splitText"
              ? { columnId: `c:step:${request.step.id}:0`, mode: "mayAdd" }
              : request.step.kind === "fillMissingValues" && request.step.params.replacement.kind === "fallbackColumns"
                ? { columnId: request.step.params.column.id, mode: "mayRemove" }
                : undefined
      );
      assertMutationDiff(
        retainedStep,
        inputSchema,
        targetSchema,
        inputRows,
        targetRows,
        result.page,
        result.diff,
        view
      );
      assertCustomDerivedRowIdentities(result.page, targetCustomRowIdentities, view);
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
      confirmed.customRowIdentities = targetCustomRowIdentities;
      confirmed.rowNames = targetRowNames;
      confirmed.filterModel = nextFilterModel;
      confirmed.draftStep = copyRTransformStep(retainedStep);
      confirmed.draftReplacesStepId = request.replaceStepId;
      confirmed.draftInputSchema = copySchema(inputSchema);
      confirmed.draftInputRSchema = inputRSchema;
      confirmed.draftInputRows = inputRows;
      confirmed.draftInputIdentityRows = inputIdentityRows;
      confirmed.draftInputKeyColumnIds = Object.freeze([...inputKeyColumnIds]);
      confirmed.draftInputRowNames = inputRowNames;
      confirmed.draftInputCustomRowIdentities = inputCustomRowIdentities;
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
          retainedStep.kind === "byExample"
            ? [...retainedStep.params.warnings]
            : fallbackFillTargetId !== undefined &&
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
    let targetCustomRowIdentities: RCustomRowIdentityConstraint | undefined;
    let nextFilterModel: FilterModel;
    if (request.kind === "applyDraft") {
      if (
        !confirmed.draftStep ||
        !confirmed.draftInputSchema ||
        !confirmed.draftInputRSchema ||
        confirmed.draftInputRows === undefined ||
        confirmed.draftInputIdentityRows === undefined ||
        !confirmed.draftInputKeyColumnIds ||
        confirmed.draftInputRowNames === undefined
      ) {
        return errorResponse("invalid_request", "There is no R draft step to apply.", true, request.sessionId);
      }
      targetSchema = confirmed.schema;
      targetRSchema = confirmed.rSchema;
      targetRows = confirmed.rows;
      targetIdentityRows = confirmed.identityRows;
      targetKeyColumnIds = confirmed.keyColumnIds;
      targetRowNames = confirmed.rowNames;
      targetCustomRowIdentities = confirmed.customRowIdentities;
      nextFilterModel = copyFilterModel(confirmed.filterModel);
    } else if (request.kind === "discardDraft") {
      if (
        !confirmed.draftStep ||
        !confirmed.draftInputSchema ||
        !confirmed.draftInputRSchema ||
        confirmed.draftInputRows === undefined ||
        confirmed.draftInputIdentityRows === undefined ||
        !confirmed.draftInputKeyColumnIds ||
        confirmed.draftInputRowNames === undefined
      ) {
        return errorResponse("invalid_request", "There is no R draft step to discard.", true, request.sessionId);
      }
      targetSchema = confirmed.committedSchema;
      targetRSchema = confirmed.committedRSchema;
      targetRows = confirmed.committedRows;
      targetIdentityRows = confirmed.committedIdentityRows;
      targetKeyColumnIds = confirmed.committedKeyColumnIds;
      targetRowNames = confirmed.committedRowNames;
      targetCustomRowIdentities = confirmed.committedCustomRowIdentities;
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
      targetRowNames = confirmed.planInputRowNames.at(-1) ?? confirmed.sourceRowNames;
      targetCustomRowIdentities = confirmed.planInputCustomRowIdentities.at(-1);
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
      assertCustomDerivedRowIdentities(result.page, targetCustomRowIdentities, view);
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
        const draftInputRowNames = confirmed.draftInputRowNames as RFramePageContract["frameSemantics"]["rowNames"];
        const draftInputCustomRowIdentities = confirmed.draftInputCustomRowIdentities;
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
          confirmed.planInputRowNames = [...confirmed.planInputRowNames, draftInputRowNames];
          confirmed.planInputCustomRowIdentities = [
            ...confirmed.planInputCustomRowIdentities,
            draftInputCustomRowIdentities
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
          confirmed.planInputRowNames = [...confirmed.planInputRowNames.slice(0, -1), draftInputRowNames];
          confirmed.planInputCustomRowIdentities = [
            ...confirmed.planInputCustomRowIdentities.slice(0, -1),
            draftInputCustomRowIdentities
          ];
        }
        confirmed.committedSchema = schemaFromContract(result.page);
        confirmed.committedRSchema = result.page.schema;
        confirmed.committedRows = targetRows;
        confirmed.committedIdentityRows = targetIdentityRows;
        confirmed.committedKeyColumnIds = Object.freeze([...targetKeyColumnIds]);
        confirmed.committedRowNames = targetRowNames;
        confirmed.committedCustomRowIdentities = targetCustomRowIdentities;
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
        confirmed.planInputRowNames = confirmed.planInputRowNames.slice(0, -1);
        confirmed.planInputCustomRowIdentities = confirmed.planInputCustomRowIdentities.slice(0, -1);
        confirmed.committedSchema = schemaFromContract(result.page);
        confirmed.committedRSchema = result.page.schema;
        confirmed.committedRows = targetRows;
        confirmed.committedIdentityRows = targetIdentityRows;
        confirmed.committedKeyColumnIds = Object.freeze([...targetKeyColumnIds]);
        confirmed.committedRowNames = targetRowNames;
        confirmed.committedCustomRowIdentities = targetCustomRowIdentities;
        confirmed.lastAppliedViewRestore = undefined;
      }

      confirmed.revision = result.revision;
      confirmed.schema = schemaFromContract(result.page);
      confirmed.rSchema = result.page.schema;
      confirmed.rows = targetRows;
      confirmed.identityRows = targetIdentityRows;
      confirmed.keyColumnIds = Object.freeze([...targetKeyColumnIds]);
      confirmed.rowNames = targetRowNames;
      confirmed.customRowIdentities = targetCustomRowIdentities;
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
    const inputRowNames = session.planInputRowNames[stepIndex];
    if (inputRowNames === undefined) throw new Error("The R bridge is missing applied-step input row-name metadata.");
    const inputCustomRowIdentities = session.planInputCustomRowIdentities[stepIndex];
    const appliedStep = session.steps[stepIndex] as RTransformStep;
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
    const outputCustomRowIdentities = customRowIdentityConstraintAfterRStep(
      appliedStep,
      inputCustomRowIdentities,
      inputIdentityRows,
      outputRows
    );
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
    const outputRowNames =
      session.planInputRowNames[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedRowNames : undefined);
    if (outputRowNames === undefined) throw new Error("The R bridge is missing applied-step output row-name metadata.");
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
      assertCustomDerivedRowIdentities(result.inputPage, inputCustomRowIdentities, emptyRViewQuery());
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
      assertCustomDerivedRowIdentities(result.outputPage, outputCustomRowIdentities, emptyRViewQuery());
      if (
        !sameSchema(inputSchema, result.inputSchema) ||
        !sameSchema(outputSchema, result.outputSchema) ||
        !isDeepStrictEqual(inputRSchema, result.inputSchema) ||
        !isDeepStrictEqual(outputRSchema, result.outputSchema)
      ) {
        throw new Error("The R kernel returned mismatched applied-step schemas.");
      }
      const diff = inspectionDiff(
        appliedStep,
        inputSchema,
        outputSchema,
        result.inputPage,
        result.outputPage,
        inputRows,
        outputRows
      );
      assertMutationDiff(
        appliedStep,
        inputSchema,
        outputSchema,
        inputRows,
        outputRows,
        result.outputPage,
        diff,
        emptyRViewQuery()
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
        inputRowAxis: rowAxisFromRRowNames(inputRowNames),
        outputRowAxis: rowAxisFromRRowNames(outputRowNames),
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
    if (request.rowAxisPolicy !== undefined) {
      return errorResponse(
        "invalid_request",
        "R export does not accept a Pandas row-axis policy.",
        true,
        request.sessionId
      );
    }
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

function validateProfileRequest(
  request: SummaryRequest | DatasetStatsRequest,
  session: RBridgeSession | undefined
): ErrorResponse | undefined {
  if (!session) return unknownSessionError(request.sessionId, request.viewRequestId);
  if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
  return staleRevisionError(session, request.revision, request.viewRequestId);
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
    committedRowNames: contract.frameSemantics.rowNames,
    committedCustomRowIdentities: undefined,
    schema,
    rSchema: contract.schema,
    rows: contract.page.totalRows,
    identityRows: contract.shape.rows,
    keyColumnIds: Object.freeze([...contract.frameSemantics.keyColumnIds]),
    customRowIdentities: undefined,
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
    planInputRowNames: Object.freeze([]),
    planInputCustomRowIdentities: Object.freeze([]),
    draftInputCustomRowIdentities: undefined,
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

function clearDraft(session: RBridgeSession): void {
  session.draftStep = undefined;
  session.draftReplacesStepId = undefined;
  session.draftInputSchema = undefined;
  session.draftInputRSchema = undefined;
  session.draftInputRows = undefined;
  session.draftInputIdentityRows = undefined;
  session.draftInputKeyColumnIds = undefined;
  session.draftInputRowNames = undefined;
  session.draftInputCustomRowIdentities = undefined;
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

function rowAxisFromRRowNames(rowNames: RFramePageContract["frameSemantics"]["rowNames"]): RowAxis {
  return rowNames === "explicit" ? { kind: "index", levelNames: [null] } : { kind: "positional", levelNames: [] };
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
