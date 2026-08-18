import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import { operationKinds } from "../../shared/operationCatalog.generated";
import {
  PROTOCOL_VERSION,
  type ColumnSchema,
  type DatasetStatsRequest,
  type ErrorResponse,
  type FilterModel,
  type OpenSessionRequest,
  type OpenWranglerRequest,
  type OperationKind,
  type RetainedTransformStep,
  type SessionMetadata,
  type SessionMode,
  type SessionSource,
  type SourceCapabilities,
  type SummaryRequest
} from "../../shared/protocol";
import type { BridgeRequestOptions } from "../dataBridge";
import { RKernelDiagnosticError, type RKernelRequestOptions } from "./rKernelTransport";
import type { RKernelDataExportResult, RKernelExportFormat, RKernelViewQuery } from "./rKernelProtocol";
import type { RColumnSchema, RDataframeFlavor, RFramePageContract } from "./rFrameContract";
import {
  copyRSchema as copySchema,
  sameRSchema as sameSchema,
  schemaFromRContract as schemaFromContract,
  validateRPageWindow as validatePageWindow
} from "./rKernelFrameMapping";
import type { RTransformStep } from "./rKernelTransformBinding";
import type { RCustomRowIdentityConstraint } from "./rKernelMutationSchema";
import { copyRetainedStep, copyRTransformStep } from "./rKernelTransformState";

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

export const R_BRIDGE_CAPABILITIES: SourceCapabilities = Object.freeze({
  ...R_BASE_CAPABILITIES,
  notebookInsert: true,
  documentInsert: true
});

export interface RBridgeSession {
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

export function withHostSessionIdentity(request: OpenSessionRequest, createId: () => string): OpenSessionRequest {
  return request.requestedSessionId ? request : { ...request, requestedSessionId: createId() };
}

export function validateOpenRequest(request: OpenSessionRequest): ErrorResponse | undefined {
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

export function validateProfileRequest(
  request: SummaryRequest | DatasetStatsRequest,
  session: RBridgeSession | undefined
): ErrorResponse | undefined {
  if (!session) return unknownSessionError(request.sessionId, request.viewRequestId);
  if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
  return staleRevisionError(session, request.revision, request.viewRequestId);
}

export function sessionFromContract(
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

export function metadataFor(session: RBridgeSession, filteredRows: number = session.rows): SessionMetadata {
  const replacementIndex = session.draftReplacesStepId
    ? session.steps.findIndex((step) => step.id === session.draftReplacesStepId)
    : -1;
  const inputSchemaIndex = replacementIndex >= 0 ? replacementIndex : session.planInputSchemas.length - 1;
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
    ...(inputSchemaIndex >= 0
      ? { latestStepInputSchema: copySchema(session.planInputSchemas[inputSchemaIndex] as readonly ColumnSchema[]) }
      : {}),
    ...(session.draftStep ? { draftStep: copyRTransformStep(session.draftStep) } : {}),
    ...(session.draftReplacesStepId ? { draftReplacesStepId: session.draftReplacesStepId } : {})
  };
}

export function rCapabilitiesForSource(
  source: SessionSource,
  exportCsv: boolean,
  exportParquet: boolean
): SourceCapabilities {
  return {
    ...R_BASE_CAPABILITIES,
    exportCsv,
    exportParquet,
    notebookInsert: source.kind === "notebookVariable",
    ...(source.kind === "documentVariable" ? { documentInsert: true } : {})
  };
}

export function rExportProtectedSourceUris(source: SessionSource): readonly vscode.Uri[] {
  if (source.kind === "rInteractiveVariable") return [];
  if ((source.kind !== "documentVariable" && source.kind !== "notebookVariable") || !source.uri) {
    throw new TypeError("R data export requires an originating R notebook or document URI.");
  }
  const uri = vscode.Uri.parse(source.uri, true);
  if (uri.scheme === "file" && uri.fsPath) return [uri];
  if (source.kind === "notebookVariable" && uri.scheme === "untitled") return [];
  throw new TypeError("R data export requires a local R notebook or document source.");
}

export function isExportableRSource(source: SessionSource): boolean {
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

export function assertRExportResult(
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

export function assertSessionContract(
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

export function assertMutationContract(
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

export function clearDraft(session: RBridgeSession): void {
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

export function validateMutationRequest(
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

export function staleRevisionError(
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

export function staleResponseError(sessionId: string, viewRequestId?: string): ErrorResponse {
  return errorResponse(
    "stale_response",
    "Ignored an R kernel response for an older session state.",
    true,
    sessionId,
    viewRequestId
  );
}

export function transportOptions(options: BridgeRequestOptions, requestedSessionId?: string): RKernelRequestOptions {
  return {
    cancellation: options.cancellation,
    timeoutMs: options.timeoutMs,
    ...(requestedSessionId ? { requestedSessionId } : {})
  };
}

export function copySource(source: SessionSource): SessionSource {
  return {
    ...source,
    ...(source.importOptions ? { importOptions: { ...source.importOptions } } : {})
  };
}

export function emptyFilterModel(): FilterModel {
  return { filters: [], sort: [] };
}

export function copyFilterModel(model: FilterModel): FilterModel {
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

export function unsupportedRequest(request: OpenWranglerRequest): ErrorResponse {
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

export function unknownSessionError(sessionId: string, viewRequestId?: string): ErrorResponse {
  return errorResponse(
    "unknown_session",
    `Open Wrangler has no live R session named ${sessionId}.`,
    true,
    sessionId,
    viewRequestId
  );
}

export function kernelChangedError(sessionId: string, viewRequestId?: string): ErrorResponse {
  return errorResponse(
    "r_kernel_changed",
    "The originating R runtime changed. Reopen the variable from its source.",
    true,
    sessionId,
    viewRequestId
  );
}

export function diagnosticResponse(
  error: RKernelDiagnosticError,
  sessionId?: string,
  viewRequestId?: string
): ErrorResponse {
  return errorResponse(
    error.diagnostic.code,
    error.diagnostic.message,
    error.diagnostic.recoverable,
    sessionId,
    viewRequestId
  );
}

export function errorResponse(
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
