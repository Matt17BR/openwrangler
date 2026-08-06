import {
  decodeRFramePage,
  R_FRAME_CONTRACT_LIMITS,
  type RColumnSchema,
  type RColumnType,
  type RFramePageContract
} from "./rFrameContract";
import { supportsViewPredicate } from "../../shared/filterModel";
import type { ColumnSummary, DataDiff, DatasetStats, PredicateFilter, ValueCount } from "../../shared/protocol";
import { isOpenWranglerResponse } from "../../shared/protocolValidation";

export const R_KERNEL_TRANSPORT_VERSION = 2 as const;
export const R_KERNEL_MAX_REQUEST_BYTES = 16 * 1_024 * 1_024;
export const R_KERNEL_MAX_RESPONSE_BYTES = 17 * 1_024 * 1_024;

const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumVariableNameBytes = 1_024;
const maximumDiagnosticBytes = 4_096;
const maximumGeneratedCodeBytes = 4 * 1_024 * 1_024;
const maximumStepIdBytes = R_FRAME_CONTRACT_LIMITS.stepIdBytes;

export const R_KERNEL_DIAGNOSTIC_CODES = Object.freeze([
  "duplicate_session",
  "invalid_request",
  "missing_package",
  "page_too_large",
  "profile_too_large",
  "runtime_error",
  "stale_column",
  "stale_revision",
  "unknown_session",
  "unknown_variable",
  "unsupported_operation",
  "unsupported_frame"
] as const);

export type RKernelDiagnosticCode = (typeof R_KERNEL_DIAGNOSTIC_CODES)[number];
const rKernelDiagnosticCodes = new Set<string>(R_KERNEL_DIAGNOSTIC_CODES);

export interface RKernelSortRule {
  readonly column: Readonly<{ id: string; name: string }>;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

export interface RKernelColumnFilter {
  readonly column: RKernelColumnReference;
  readonly type: RColumnType;
  readonly logic?: "and" | "or";
  readonly valueFilter?: Readonly<{
    kind: "values";
    selectedValues: readonly unknown[];
    includeNulls: boolean;
    includeNaN: boolean;
    search?: string;
  }>;
  readonly predicates: readonly Readonly<PredicateFilter>[];
}

export interface RKernelViewQuery {
  readonly logic?: "and" | "or";
  readonly filters: readonly RKernelColumnFilter[];
  readonly sorts: readonly RKernelSortRule[];
}

export interface RKernelPageWindow {
  readonly rowOffset: number;
  readonly rowLimit: number;
  readonly columnOffset: number;
  readonly columnLimit: number;
  readonly view: RKernelViewQuery;
}

export interface RKernelDatasetStatsResult {
  readonly totalRows: number;
  readonly stats: DatasetStats;
}

export interface RKernelColumnReference {
  readonly id: string;
  readonly name: string;
}

export interface RKernelRenameColumnStep {
  readonly id: string;
  readonly kind: "renameColumn";
  readonly params: Readonly<{
    column: RKernelColumnReference;
    newName: string;
  }>;
}

export interface RKernelCloneColumnStep {
  readonly id: string;
  readonly kind: "cloneColumn";
  readonly params: Readonly<{
    column: RKernelColumnReference;
    newName: string;
  }>;
}

export interface RKernelTextLengthStep {
  readonly id: string;
  readonly kind: "textLength";
  readonly params: Readonly<{
    column: RKernelColumnReference;
    newColumn: string;
  }>;
}

export interface RKernelDropColumnsStep {
  readonly id: string;
  readonly kind: "dropColumns";
  readonly params: Readonly<{
    columns: readonly [RKernelColumnReference, ...RKernelColumnReference[]];
  }>;
}

export interface RKernelSelectColumnsStep {
  readonly id: string;
  readonly kind: "selectColumns";
  readonly params: Readonly<{
    columns: readonly [RKernelColumnReference, ...RKernelColumnReference[]];
  }>;
}

export type RKernelTransformStep =
  | RKernelRenameColumnStep
  | RKernelCloneColumnStep
  | RKernelTextLengthStep
  | RKernelDropColumnsStep
  | RKernelSelectColumnsStep;

export interface RKernelStepPreviewResult {
  readonly sessionId: string;
  readonly revision: number;
  readonly page: RFramePageContract;
  readonly diff: DataDiff;
  readonly code: string;
}

export interface RKernelPlanUpdatedResult {
  readonly sessionId: string;
  readonly action: "apply" | "discard" | "undo";
  readonly revision: number;
  readonly page: RFramePageContract;
  readonly code: string;
}

export interface RKernelStepInspectionResult {
  readonly sessionId: string;
  readonly revision: number;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly inputPage: RFramePageContract;
  readonly outputPage: RFramePageContract;
  readonly inputSchema: readonly RColumnSchema[];
  readonly outputSchema: readonly RColumnSchema[];
  readonly diff: DataDiff;
  readonly code: string;
}

export type RKernelRequest =
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "openSession";
      payload: Readonly<{ sessionId: string; variableName: string; page: RKernelPageWindow }>;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "getPage";
      payload: Readonly<{ sessionId: string; page: RKernelPageWindow }>;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "getSummary";
      payload: Readonly<{
        sessionId: string;
        columns: readonly RKernelColumnReference[];
        view: RKernelViewQuery;
      }>;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "getDatasetStats";
      payload: Readonly<{ sessionId: string; view: RKernelViewQuery }>;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "getColumnValues";
      payload: Readonly<{
        sessionId: string;
        column: RKernelColumnReference;
        view: RKernelViewQuery;
        search: string | null;
        limit: number;
      }>;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "previewStep";
      payload: Readonly<{
        sessionId: string;
        revision: number;
        step: RKernelTransformStep;
        replaceStepId?: string;
        page: RKernelPageWindow;
      }>;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "applyDraft" | "discardDraft" | "undoStep";
      payload: Readonly<{
        sessionId: string;
        revision: number;
        page: RKernelPageWindow;
      }>;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "inspectStep";
      payload: Readonly<{
        sessionId: string;
        revision: number;
        stepId: string;
        page: RKernelPageWindow;
      }>;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "closeSession";
      payload: Readonly<{ sessionId: string }>;
    }>;

export type RKernelResponse =
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "page";
      sessionId: string;
      page: RFramePageContract;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "closed";
      sessionId: string;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "summary";
      sessionId: string;
      summaries: readonly ColumnSummary[];
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "datasetStats";
      sessionId: string;
      totalRows: number;
      stats: DatasetStats;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "columnValues";
      sessionId: string;
      column: string;
      values: readonly ValueCount[];
      hasMore: boolean;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "stepPreview";
      sessionId: string;
      revision: number;
      page: RFramePageContract;
      diff: DataDiff;
      code: string;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "planUpdated";
      sessionId: string;
      action: "apply" | "discard" | "undo";
      revision: number;
      page: RFramePageContract;
      code: string;
    }>
  | Readonly<{
      transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
      requestId: string;
      kind: "stepInspection";
      sessionId: string;
      revision: number;
      stepId: string;
      stepIndex: number;
      inputPage: RFramePageContract;
      outputPage: RFramePageContract;
      inputSchema: readonly RColumnSchema[];
      outputSchema: readonly RColumnSchema[];
      diff: DataDiff;
      code: string;
    }>
  | RKernelErrorResponse;

export interface RKernelErrorResponse {
  readonly transportVersion: typeof R_KERNEL_TRANSPORT_VERSION;
  readonly requestId: string;
  readonly kind: "error";
  readonly code: RKernelDiagnosticCode;
  readonly message: string;
  readonly recoverable: boolean;
}

export function encodeRKernelRequest(request: RKernelRequest): string {
  validateRequest(request);
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded, "utf8") > R_KERNEL_MAX_REQUEST_BYTES) {
    fail("R kernel request exceeds the byte limit.");
  }
  return encoded;
}

export function decodeRKernelResponseJson(payload: string, expectedRequestId: string): RKernelResponse {
  if (typeof payload !== "string") fail("R kernel response must be a string.");
  if (Buffer.byteLength(payload, "utf8") > R_KERNEL_MAX_RESPONSE_BYTES) {
    fail("R kernel response exceeds the byte limit.");
  }
  const expected = identifier(expectedRequestId, "expected request ID");
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    fail("R kernel response is not valid JSON.");
  }
  if (!isRecord(value)) fail("R kernel response must be an object.");
  const kind = value.kind;
  if (kind === "page") {
    const record = exactRecord(value, ["transportVersion", "requestId", "kind", "sessionId", "page"]);
    validateEnvelope(record, expected);
    return Object.freeze({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: expected,
      kind: "page" as const,
      sessionId: identifier(record.sessionId, "response.sessionId"),
      page: decodeRFramePage(record.page)
    });
  }
  if (kind === "summary") {
    const record = exactRecord(value, ["transportVersion", "requestId", "kind", "sessionId", "summaries"]);
    validateEnvelope(record, expected);
    const candidate: unknown = {
      kind: "summary",
      revision: 0,
      viewRequestId: "r-kernel-profile",
      summaries: record.summaries
    };
    if (!isOpenWranglerResponse(candidate) || candidate.kind !== "summary") {
      fail("R kernel summary response is invalid.");
    }
    if (
      candidate.summaries.length === 0 ||
      candidate.summaries.length > R_FRAME_CONTRACT_LIMITS.profileColumns ||
      candidate.summaries.some(
        (summary) =>
          summary.topValues.length > R_FRAME_CONTRACT_LIMITS.topValues ||
          (summary.visualization?.kind === "numeric" &&
            summary.visualization.bins.length > R_FRAME_CONTRACT_LIMITS.histogramBins) ||
          (summary.visualization?.kind === "categorical" &&
            summary.visualization.categories.length > R_FRAME_CONTRACT_LIMITS.topValues)
      )
    ) {
      fail("R kernel summary response exceeds its profile limits.");
    }
    validateRColumnSummaries(candidate.summaries);
    return Object.freeze({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: expected,
      kind: "summary" as const,
      sessionId: identifier(record.sessionId, "response.sessionId"),
      summaries: Object.freeze(candidate.summaries)
    });
  }
  if (kind === "datasetStats") {
    const record = exactRecord(value, ["transportVersion", "requestId", "kind", "sessionId", "totalRows", "stats"]);
    validateEnvelope(record, expected);
    const totalRows = boundedInteger(record.totalRows, "response.totalRows", R_FRAME_CONTRACT_LIMITS.rows);
    const candidate: unknown = {
      kind: "datasetStats",
      revision: 0,
      viewRequestId: "r-kernel-profile",
      stats: record.stats
    };
    if (!isOpenWranglerResponse(candidate) || candidate.kind !== "datasetStats") {
      fail("R kernel dataset-statistics response is invalid.");
    }
    if (candidate.stats.missingValuesByColumn.length > R_FRAME_CONTRACT_LIMITS.columns) {
      fail("R kernel dataset-statistics response exceeds the column limit.");
    }
    validateRDatasetStats(candidate.stats, totalRows);
    return Object.freeze({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: expected,
      kind: "datasetStats" as const,
      sessionId: identifier(record.sessionId, "response.sessionId"),
      totalRows,
      stats: Object.freeze(candidate.stats)
    });
  }
  if (kind === "columnValues") {
    const record = exactRecord(value, [
      "transportVersion",
      "requestId",
      "kind",
      "sessionId",
      "column",
      "values",
      "hasMore"
    ]);
    validateEnvelope(record, expected);
    const candidate: unknown = {
      kind: "columnValues",
      revision: 0,
      viewRequestId: "r-kernel-values",
      column: record.column,
      values: record.values,
      hasMore: record.hasMore
    };
    if (!isOpenWranglerResponse(candidate) || candidate.kind !== "columnValues") {
      fail("R kernel column-values response is invalid.");
    }
    if (candidate.values.length > 10_000) fail("R kernel column-values response exceeds the value limit.");
    for (const [index, entry] of candidate.values.entries()) {
      boundedText(entry.value, `response.values[${index}].value`, R_FRAME_CONTRACT_LIMITS.textBytes, true);
      if (entry.count <= 0 || entry.selectionValue === undefined) {
        fail("R kernel column-values response requires a typed selection for every value.");
      }
    }
    return Object.freeze({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: expected,
      kind: "columnValues" as const,
      sessionId: identifier(record.sessionId, "response.sessionId"),
      column: boundedText(record.column, "response.column", maximumVariableNameBytes, true),
      values: Object.freeze(candidate.values),
      hasMore: candidate.hasMore
    });
  }
  if (kind === "stepPreview") {
    const record = exactRecord(value, [
      "transportVersion",
      "requestId",
      "kind",
      "sessionId",
      "revision",
      "page",
      "diff",
      "code"
    ]);
    validateEnvelope(record, expected);
    return Object.freeze({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: expected,
      kind: "stepPreview" as const,
      sessionId: identifier(record.sessionId, "response.sessionId"),
      revision: boundedInteger(record.revision, "response.revision", 2_147_483_647),
      page: decodeRFramePage(record.page),
      diff: validateStructuralDiff(record.diff),
      code: boundedText(record.code, "response.code", maximumGeneratedCodeBytes, false)
    });
  }
  if (kind === "planUpdated") {
    const record = exactRecord(value, [
      "transportVersion",
      "requestId",
      "kind",
      "sessionId",
      "action",
      "revision",
      "page",
      "code"
    ]);
    validateEnvelope(record, expected);
    if (record.action !== "apply" && record.action !== "discard" && record.action !== "undo") {
      fail("R kernel plan response has an invalid action.");
    }
    return Object.freeze({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: expected,
      kind: "planUpdated" as const,
      sessionId: identifier(record.sessionId, "response.sessionId"),
      action: record.action,
      revision: boundedInteger(record.revision, "response.revision", 2_147_483_647),
      page: decodeRFramePage(record.page),
      code: boundedText(record.code, "response.code", maximumGeneratedCodeBytes, true)
    });
  }
  if (kind === "stepInspection") {
    const record = exactRecord(value, [
      "transportVersion",
      "requestId",
      "kind",
      "sessionId",
      "revision",
      "stepId",
      "stepIndex",
      "inputPage",
      "outputPage",
      "inputSchema",
      "outputSchema",
      "diff",
      "code"
    ]);
    validateEnvelope(record, expected);
    const inputPage = decodeRFramePage(record.inputPage);
    const outputPage = decodeRFramePage(record.outputPage);
    const inputSchema = inspectionSchema(record.inputSchema, inputPage.schema, "response.inputSchema");
    const outputSchema = inspectionSchema(record.outputSchema, outputPage.schema, "response.outputSchema");
    return Object.freeze({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: expected,
      kind: "stepInspection" as const,
      sessionId: identifier(record.sessionId, "response.sessionId"),
      revision: boundedInteger(record.revision, "response.revision", 2_147_483_647),
      stepId: boundedText(record.stepId, "response.stepId", maximumStepIdBytes, false),
      stepIndex: boundedInteger(record.stepIndex, "response.stepIndex", R_FRAME_CONTRACT_LIMITS.columns - 1),
      inputPage,
      outputPage,
      inputSchema,
      outputSchema,
      diff: validateStructuralDiff(record.diff),
      code: boundedText(record.code, "response.code", maximumGeneratedCodeBytes, false)
    });
  }
  if (kind === "closed") {
    const record = exactRecord(value, ["transportVersion", "requestId", "kind", "sessionId"]);
    validateEnvelope(record, expected);
    return Object.freeze({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: expected,
      kind: "closed" as const,
      sessionId: identifier(record.sessionId, "response.sessionId")
    });
  }
  if (kind === "error") {
    const record = exactRecord(value, ["transportVersion", "requestId", "kind", "code", "message", "recoverable"]);
    validateEnvelope(record, expected);
    if (typeof record.code !== "string" || !rKernelDiagnosticCodes.has(record.code)) {
      fail("R kernel response has an invalid diagnostic code.");
    }
    if (typeof record.recoverable !== "boolean") fail("R kernel response has an invalid recovery flag.");
    return Object.freeze({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: expected,
      kind: "error" as const,
      code: record.code as RKernelDiagnosticCode,
      message: boundedText(record.message, "response.message", maximumDiagnosticBytes, false),
      recoverable: record.recoverable
    });
  }
  fail("R kernel response has an unsupported kind.");
}

function validateRequest(request: RKernelRequest): void {
  const record = exactRecord(request, ["transportVersion", "requestId", "kind", "payload"], "R kernel request");
  if (record.transportVersion !== R_KERNEL_TRANSPORT_VERSION) fail("R kernel request version is unsupported.");
  identifier(record.requestId, "request.requestId");
  if (record.kind === "openSession") {
    const payload = exactRecord(record.payload, ["sessionId", "variableName", "page"], "R kernel open payload");
    identifier(payload.sessionId, "request.payload.sessionId");
    const variableName = boundedText(
      payload.variableName,
      "request.payload.variableName",
      maximumVariableNameBytes,
      false
    );
    if (variableName.length === 0) fail("R variable name may not be empty.");
    validatePage(payload.page);
    return;
  }
  if (record.kind === "getPage") {
    const payload = exactRecord(record.payload, ["sessionId", "page"], "R kernel page payload");
    identifier(payload.sessionId, "request.payload.sessionId");
    validatePage(payload.page);
    return;
  }
  if (record.kind === "getSummary") {
    const payload = exactRecord(record.payload, ["sessionId", "columns", "view"], "R kernel summary payload");
    identifier(payload.sessionId, "request.payload.sessionId");
    validateColumnReferences(payload.columns);
    validateViewQuery(payload.view);
    return;
  }
  if (record.kind === "getDatasetStats") {
    const payload = exactRecord(record.payload, ["sessionId", "view"], "R kernel dataset-statistics payload");
    identifier(payload.sessionId, "request.payload.sessionId");
    validateViewQuery(payload.view);
    return;
  }
  if (record.kind === "getColumnValues") {
    const payload = exactRecord(
      record.payload,
      ["sessionId", "column", "view", "search", "limit"],
      "R kernel column-values payload"
    );
    identifier(payload.sessionId, "request.payload.sessionId");
    validateColumnReference(payload.column, "request.payload.column");
    validateViewQuery(payload.view);
    if (payload.search !== null) {
      boundedText(payload.search, "request.payload.search", R_FRAME_CONTRACT_LIMITS.textBytes, true);
    }
    if (boundedInteger(payload.limit, "request.payload.limit", 10_000) < 1) {
      fail("request.payload.limit must be positive.");
    }
    return;
  }
  if (record.kind === "previewStep") {
    const payload = exactRecord(
      record.payload,
      ["sessionId", "revision", "step", "page"],
      ["replaceStepId"],
      "R kernel preview payload"
    );
    identifier(payload.sessionId, "request.payload.sessionId");
    boundedInteger(payload.revision, "request.payload.revision", 2_147_483_647);
    validateTransformStep(payload.step);
    if (payload.replaceStepId !== undefined) {
      boundedText(payload.replaceStepId, "request.payload.replaceStepId", maximumStepIdBytes, false);
    }
    validatePage(payload.page);
    return;
  }
  if (record.kind === "applyDraft" || record.kind === "discardDraft" || record.kind === "undoStep") {
    const payload = exactRecord(record.payload, ["sessionId", "revision", "page"], "R kernel plan payload");
    identifier(payload.sessionId, "request.payload.sessionId");
    boundedInteger(payload.revision, "request.payload.revision", 2_147_483_647);
    validatePage(payload.page);
    return;
  }
  if (record.kind === "inspectStep") {
    const payload = exactRecord(
      record.payload,
      ["sessionId", "revision", "stepId", "page"],
      "R kernel inspection payload"
    );
    identifier(payload.sessionId, "request.payload.sessionId");
    boundedInteger(payload.revision, "request.payload.revision", 2_147_483_647);
    boundedText(payload.stepId, "request.payload.stepId", maximumStepIdBytes, false);
    validatePage(payload.page);
    return;
  }
  if (record.kind === "closeSession") {
    const payload = exactRecord(record.payload, ["sessionId"], "R kernel close payload");
    identifier(payload.sessionId, "request.payload.sessionId");
    return;
  }
  fail("R kernel request has an unsupported kind.");
}

function validateTransformStep(value: unknown): void {
  const step = exactRecord(value, ["id", "kind", "params"], "R kernel transform step");
  boundedText(step.id, "request.payload.step.id", maximumStepIdBytes, false);
  if (step.kind === "renameColumn" || step.kind === "cloneColumn") {
    const operation = step.kind === "renameColumn" ? "rename" : "clone";
    const params = exactRecord(step.params, ["column", "newName"], `R kernel ${operation} parameters`);
    validateColumnReference(params.column, "request.payload.step.params.column");
    boundedText(params.newName, "request.payload.step.params.newName", maximumVariableNameBytes, false);
    return;
  }
  if (step.kind === "textLength") {
    const params = exactRecord(step.params, ["column", "newColumn"], "R kernel text-length parameters");
    validateColumnReference(params.column, "request.payload.step.params.column");
    boundedText(params.newColumn, "request.payload.step.params.newColumn", maximumVariableNameBytes, false);
    return;
  }
  if (step.kind === "dropColumns") {
    const params = exactRecord(step.params, ["columns"], "R kernel drop parameters");
    validateTransformColumnReferences(params.columns, "drop");
    return;
  }
  if (step.kind === "selectColumns") {
    const params = exactRecord(step.params, ["columns"], "R kernel select parameters");
    validateTransformColumnReferences(params.columns, "select");
    return;
  }
  fail("R kernel transform step has an unsupported operation.");
}

function validateTransformColumnReferences(value: unknown, operation: "drop" | "select"): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > R_FRAME_CONTRACT_LIMITS.columns) {
    fail(`R kernel ${operation} columns must be a bounded non-empty array.`);
  }
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const reference = validateColumnReference(candidate, `request.payload.step.params.columns[${index}]`);
    if (seen.has(reference.id)) fail(`R kernel ${operation} columns contain a repeated identity.`);
    seen.add(reference.id);
  }
}

function validateStructuralDiff(value: unknown): DataDiff {
  const diff = exactRecord(value, [
    "addedRows",
    "removedRows",
    "addedColumns",
    "removedColumns",
    "changedCells",
    "cells",
    "truncated"
  ]);
  if (
    diff.addedRows !== 0 ||
    diff.removedRows !== 0 ||
    diff.changedCells !== 0 ||
    diff.truncated !== false ||
    !Array.isArray(diff.addedColumns) ||
    diff.addedColumns.length > R_FRAME_CONTRACT_LIMITS.columns ||
    !Array.isArray(diff.removedColumns) ||
    diff.removedColumns.length > R_FRAME_CONTRACT_LIMITS.columns ||
    !Array.isArray(diff.cells) ||
    diff.cells.length !== 0
  ) {
    fail("R kernel structural diff is invalid.");
  }
  const addedColumns = diff.addedColumns.map((column, index) =>
    boundedText(column, `response.diff.addedColumns[${index}]`, maximumVariableNameBytes, true)
  );
  const removedColumns = diff.removedColumns.map((column, index) =>
    boundedText(column, `response.diff.removedColumns[${index}]`, maximumVariableNameBytes, true)
  );
  const result: DataDiff = {
    addedRows: 0,
    removedRows: 0,
    addedColumns,
    removedColumns,
    changedCells: 0,
    cells: [],
    truncated: false
  };
  Object.freeze(result.addedColumns);
  Object.freeze(result.removedColumns);
  Object.freeze(result.cells);
  return Object.freeze(result);
}

function inspectionSchema(value: unknown, expected: readonly RColumnSchema[], label: string): readonly RColumnSchema[] {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(`${label} must match its frame schema.`);
  }
  return expected;
}

function validateColumnReferences(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > R_FRAME_CONTRACT_LIMITS.profileColumns) {
    fail("R kernel summary columns exceed the supported limit.");
  }
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const reference = validateColumnReference(candidate, `request.payload.columns[${index}]`);
    const id = reference.id;
    if (seen.has(id)) fail("R kernel summary columns contain a repeated identity.");
    seen.add(id);
  }
}

function validateColumnReference(value: unknown, label: string): Readonly<{ id: string; name: string }> {
  const reference = exactRecord(value, ["id", "name"], label);
  return Object.freeze({
    id: boundedText(reference.id, `${label}.id`, R_FRAME_CONTRACT_LIMITS.columnIdBytes, false),
    name: boundedText(reference.name, `${label}.name`, maximumVariableNameBytes, true)
  });
}

function validateViewQuery(value: unknown): void {
  const view = exactRecord(value, ["filters", "sorts"], ["logic"], "R kernel view query");
  if (view.logic !== undefined && view.logic !== "and" && view.logic !== "or") {
    fail("R kernel view logic is invalid.");
  }
  if (!Array.isArray(view.filters) || view.filters.length > R_FRAME_CONTRACT_LIMITS.filters) {
    fail("R kernel view filters exceed the supported limit.");
  }
  for (const [index, value] of view.filters.entries()) {
    const filter = exactRecord(
      value,
      ["column", "type", "predicates"],
      ["logic", "valueFilter"],
      `R kernel view filter ${index}`
    );
    validateColumnReference(filter.column, `request.view.filters[${index}].column`);
    if (!isRColumnType(filter.type)) fail("R kernel view filter type is invalid.");
    if (filter.logic !== undefined && filter.logic !== "and" && filter.logic !== "or") {
      fail("R kernel column-filter logic is invalid.");
    }
    if (!Array.isArray(filter.predicates) || filter.predicates.length > R_FRAME_CONTRACT_LIMITS.predicatesPerFilter) {
      fail("R kernel view predicates exceed the supported limit.");
    }
    for (const [predicateIndex, predicate] of filter.predicates.entries()) {
      validatePredicate(predicate, `request.view.filters[${index}].predicates[${predicateIndex}]`, filter.type);
    }
    if (filter.valueFilter !== undefined) {
      validateValueFilter(filter.valueFilter, `request.view.filters[${index}].valueFilter`, filter.type);
    }
  }
  validateSorts(view.sorts, "request.view.sorts");
}

function validatePredicate(value: unknown, label: string, columnType: RColumnType): void {
  const predicate = exactRecord(value, ["kind", "operator"], ["value", "secondValue"], label);
  if (
    predicate.kind !== "predicate" ||
    !isPredicateOperator(predicate.operator) ||
    !supportsViewPredicate(columnType, predicate.operator)
  ) {
    fail(`${label} is invalid.`);
  }
  const nullary = new Set(["isNull", "isNotNull", "isNaN", "isNotNaN"]);
  if (!nullary.has(predicate.operator) && !("value" in predicate)) fail(`${label}.value is required.`);
  if (predicate.operator === "between" && !("secondValue" in predicate)) fail(`${label}.secondValue is required.`);
  if ("value" in predicate) validateViewValue(predicate.value, `${label}.value`, columnType);
  if ("secondValue" in predicate) validateViewValue(predicate.secondValue, `${label}.secondValue`, columnType);
}

function validateValueFilter(value: unknown, label: string, columnType: RColumnType): void {
  const filter = exactRecord(value, ["kind", "selectedValues", "includeNulls", "includeNaN"], ["search"], label);
  if (
    filter.kind !== "values" ||
    typeof filter.includeNulls !== "boolean" ||
    typeof filter.includeNaN !== "boolean" ||
    !Array.isArray(filter.selectedValues) ||
    filter.selectedValues.length > R_FRAME_CONTRACT_LIMITS.selectedValuesPerFilter
  ) {
    fail(`${label} is invalid.`);
  }
  for (const [index, selected] of filter.selectedValues.entries()) {
    validateViewValue(selected, `${label}.selectedValues[${index}]`, columnType);
  }
  if (filter.search !== undefined)
    boundedText(filter.search, `${label}.search`, R_FRAME_CONTRACT_LIMITS.textBytes, true);
}

function validateViewValue(value: unknown, label: string, columnType: RColumnType): void {
  if (typeof value === "string") {
    boundedText(value, label, 65_536, true);
    return;
  }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (!isRecord(value)) fail(`${label} is not a supported view value.`);
  const token = exactRecord(value, ["kind", "version", "columnType", "cell"], label);
  if (token.kind !== "typedSelection" || token.version !== 1 || token.columnType !== columnType) {
    fail(`${label} is not a valid typed selection.`);
  }
  const candidate: unknown = {
    kind: "columnValues",
    revision: 0,
    viewRequestId: "r-kernel-request-validation",
    column: "value",
    values: [{ value: "value", count: 1, selectionValue: value }],
    hasMore: false
  };
  if (!isOpenWranglerResponse(candidate)) fail(`${label} is not a valid typed selection.`);
}

function isRColumnType(value: unknown): value is RColumnType {
  return new Set<RColumnType>(["string", "integer", "float", "boolean", "datetime", "date", "duration"]).has(
    value as RColumnType
  );
}

function isPredicateOperator(value: unknown): value is PredicateFilter["operator"] {
  return new Set<PredicateFilter["operator"]>([
    "equals",
    "notEquals",
    "contains",
    "startsWith",
    "endsWith",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "isNull",
    "isNotNull",
    "isNaN",
    "isNotNaN"
  ]).has(value as PredicateFilter["operator"]);
}

function validateRColumnSummaries(summaries: readonly ColumnSummary[]): void {
  for (const [index, summary] of summaries.entries()) {
    const label = `R kernel summary ${index}`;
    boundedText(summary.columnId, `${label}.columnId`, R_FRAME_CONTRACT_LIMITS.columnIdBytes, false);
    boundedText(summary.column, `${label}.column`, maximumVariableNameBytes, true);
    boundedText(summary.rawType, `${label}.rawType`, maximumVariableNameBytes, false);
    if (summary.totalCount > R_FRAME_CONTRACT_LIMITS.profileRows) {
      fail(`${label} exceeds the row profiling limit.`);
    }
    const present = summary.totalCount - summary.nullCount - summary.nanCount;
    if (
      present < 0 ||
      summary.distinctCount === undefined ||
      (summary.distinctCount !== undefined && summary.distinctCount > present) ||
      (summary.distinctCount !== undefined &&
        summary.topValues.length !== Math.min(R_FRAME_CONTRACT_LIMITS.topValues, summary.distinctCount))
    ) {
      fail(`${label} has inconsistent value counts.`);
    }
    let topValueCount = 0;
    for (const [valueIndex, entry] of summary.topValues.entries()) {
      boundedText(entry.value, `${label}.topValues[${valueIndex}].value`, R_FRAME_CONTRACT_LIMITS.textBytes, true);
      if (entry.count <= 0 || entry.selectionValue !== undefined) {
        fail(`${label} has an invalid native R top value.`);
      }
      topValueCount += entry.count;
    }
    if (topValueCount > present) fail(`${label} has top-value counts outside the column.`);
    if ((summary.type === "string") !== (summary.text !== undefined)) {
      fail(`${label} has text statistics for the wrong column type.`);
    }

    const visualization = summary.visualization;
    if (!visualization) {
      if (
        summary.type === "boolean" ||
        summary.type === "string" ||
        summary.type === "date" ||
        summary.type === "datetime"
      ) {
        fail(`${label} is missing its native R visualization.`);
      }
      continue;
    }
    if (visualization.kind === "numeric") {
      if (summary.type !== "integer" && summary.type !== "float" && summary.type !== "duration") {
        fail(`${label} has a numeric visualization for the wrong column type.`);
      }
      let binCount = 0;
      let previousMaximum: number | undefined;
      for (const bin of visualization.bins) {
        if (bin.min > bin.max || (previousMaximum !== undefined && bin.min !== previousMaximum)) {
          fail(`${label} has unordered numeric histogram bins.`);
        }
        previousMaximum = bin.max;
        binCount += bin.count;
      }
      if (binCount > present) fail(`${label} has histogram counts outside the column.`);
    } else if (visualization.kind === "boolean") {
      if (summary.type !== "boolean" || visualization.trueCount + visualization.falseCount !== present) {
        fail(`${label} has inconsistent boolean counts.`);
      }
    } else if (visualization.kind === "categorical") {
      const categoryValues = new Set(visualization.categories.map((entry) => entry.value));
      if (
        summary.type !== "string" ||
        categoryValues.size !== visualization.categories.length ||
        visualization.categories.length !== summary.topValues.length ||
        visualization.categories.some(
          (entry, categoryIndex) =>
            entry.value !== summary.topValues[categoryIndex]?.value ||
            entry.count !== summary.topValues[categoryIndex]?.count ||
            entry.selectionValue !== undefined
        ) ||
        visualization.categories.reduce((count, entry) => count + entry.count, 0) + visualization.otherCount !== present
      ) {
        fail(`${label} has inconsistent categorical counts.`);
      }
    } else {
      if (summary.type !== "date" && summary.type !== "datetime") {
        fail(`${label} has a datetime visualization for the wrong column type.`);
      }
      const hasMinimum = visualization.min !== undefined;
      const hasMaximum = visualization.max !== undefined;
      if ((present === 0 && (hasMinimum || hasMaximum)) || (present > 0 && (!hasMinimum || !hasMaximum))) {
        fail(`${label} has inconsistent datetime bounds.`);
      }
      if (visualization.min !== undefined && visualization.max !== undefined) {
        boundedText(visualization.min, `${label}.visualization.min`, R_FRAME_CONTRACT_LIMITS.textBytes, false);
        boundedText(visualization.max, `${label}.visualization.max`, R_FRAME_CONTRACT_LIMITS.textBytes, false);
      }
    }
  }
}

function validateRDatasetStats(stats: DatasetStats, totalRows: number): void {
  if (
    stats.missingRows > totalRows ||
    stats.duplicateRows > Math.max(0, totalRows - 1) ||
    stats.missingCells > totalRows * stats.missingValuesByColumn.length
  ) {
    fail("R kernel dataset statistics exceed the filtered row count.");
  }
  let missingCells = 0;
  for (const [index, entry] of stats.missingValuesByColumn.entries()) {
    boundedText(entry.column, `R kernel dataset stats column ${index}`, maximumVariableNameBytes, true);
    if (entry.count > totalRows) fail("R kernel dataset statistics exceed the filtered row count.");
    missingCells += entry.count;
  }
  if (missingCells !== stats.missingCells) {
    fail("R kernel dataset statistics have inconsistent missing-value totals.");
  }
}

function validatePage(value: unknown): void {
  const page = exactRecord(value, ["rowOffset", "rowLimit", "columnOffset", "columnLimit", "view"], "R kernel page");
  boundedInteger(page.rowOffset, "page.rowOffset", R_FRAME_CONTRACT_LIMITS.rows);
  boundedInteger(page.rowLimit, "page.rowLimit", R_FRAME_CONTRACT_LIMITS.pageRows);
  boundedInteger(page.columnOffset, "page.columnOffset", R_FRAME_CONTRACT_LIMITS.columns);
  boundedInteger(page.columnLimit, "page.columnLimit", R_FRAME_CONTRACT_LIMITS.pageColumns);
  validateViewQuery(page.view);
}

function validateSorts(values: unknown, label: string): void {
  if (!Array.isArray(values) || values.length > R_FRAME_CONTRACT_LIMITS.sortRules) {
    fail("R page sorts exceed the supported limit.");
  }
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const rule = exactRecord(value, ["column", "direction", "nulls"], `R kernel page sort ${index}`);
    const column = exactRecord(rule.column, ["id", "name"], `R kernel page sort ${index} column`);
    const id = boundedText(column.id, `${label}[${index}].column.id`, R_FRAME_CONTRACT_LIMITS.columnIdBytes, false);
    boundedText(column.name, `${label}[${index}].column.name`, maximumVariableNameBytes, true);
    if (seen.has(id)) fail("R page sorts contain a repeated column identity.");
    seen.add(id);
    if (rule.direction !== "asc" && rule.direction !== "desc") fail("R page sort direction is invalid.");
    if (rule.nulls !== "first" && rule.nulls !== "last") fail("R page null placement is invalid.");
  }
}

function validateEnvelope(record: Record<string, unknown>, expectedRequestId: string): void {
  if (record.transportVersion !== R_KERNEL_TRANSPORT_VERSION) fail("R kernel response version is unsupported.");
  if (identifier(record.requestId, "response.requestId") !== expectedRequestId) {
    fail("R kernel response is stale or mis-correlated.");
  }
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  optionalFieldsOrLabel: readonly string[] | string = [],
  suppliedLabel?: string
): Record<string, unknown> {
  const optionalFields = typeof optionalFieldsOrLabel === "string" ? [] : optionalFieldsOrLabel;
  const label =
    typeof optionalFieldsOrLabel === "string" ? optionalFieldsOrLabel : (suppliedLabel ?? "R kernel response");
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const keys = Object.keys(value);
  if (
    fields.some((field) => !Object.prototype.hasOwnProperty.call(value, field)) ||
    keys.some((key) => !fields.includes(key) && !optionalFields.includes(key))
  ) {
    fail(`${label} has invalid fields.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) fail(`${label} must be a canonical UUID.`);
  return value;
}

function boundedText(value: unknown, label: string, maximumBytes: number, allowEmpty: boolean): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.includes("\u0000") ||
    hasUnpairedSurrogate(value)
  ) {
    fail(`${label} must be a bounded string.`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail(`${label} exceeds its UTF-8 byte limit.`);
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(`${label} is outside its supported range.`);
  }
  return value;
}

function fail(message: string): never {
  throw new TypeError(message);
}
