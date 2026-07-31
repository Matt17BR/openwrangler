import { Buffer } from "node:buffer";
import type { CellValue, ColumnSchema, GridPage } from "../../shared/protocol";
import { isColumnSchemaArray, isGridPage } from "../../shared/protocolValidation";

export const R_PROVIDER_PROTOCOL_VERSION = 1 as const;
export const R_PROVIDER_LIMITS = Object.freeze({
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 33_554_432,
  maxPageRows: 10_000,
  maxPageColumns: 256,
  maxPageCells: 100_000,
  maxPageEstimatedBytes: 16_777_216,
  maxSchemaEstimatedBytes: 8_388_608,
  maxTextCodePoints: 65_536,
  maxShapeRows: 2_147_483_647,
  maxShapeColumns: 16_384
});

export interface RProviderInitializeRequest {
  readonly kind: "initialize";
}

export interface RProviderOpenSessionRequest {
  readonly kind: "openSession";
  readonly source: {
    readonly kind: "notebookVariable";
    readonly label: string;
    readonly variableName: string;
  };
  readonly requestedSessionId: string;
  readonly backend?: "r";
  readonly mode?: "viewing";
  readonly pageSize: number;
  readonly columnOffset: number;
  readonly columnLimit: number;
}

export interface RProviderGetPageRequest {
  readonly kind: "getPage";
  readonly sessionId: string;
  readonly revision: 0;
  readonly viewRequestId: string;
  readonly offset: number;
  readonly limit: number;
  readonly columnOffset: number;
  readonly columnLimit: number;
  readonly filterModel: {
    readonly logic: "and";
    readonly filters: readonly [];
    readonly sort: readonly [];
  };
}

export interface RProviderCloseSessionRequest {
  readonly kind: "closeSession";
  readonly sessionId: string;
  readonly revision: 0;
}

export type RProviderRequest =
  RProviderInitializeRequest | RProviderOpenSessionRequest | RProviderGetPageRequest | RProviderCloseSessionRequest;

export interface RProviderInitialized {
  readonly kind: "initialized";
  readonly runtimeVersion: string;
  readonly language: "r";
  readonly transport: "inProcessR";
  readonly capabilities: {
    readonly sourceKinds: readonly ["notebookVariable"];
    readonly dataFrameClasses: readonly ["data.frame", "tbl_df", "data.table"];
    readonly paging: true;
    readonly filtering: false;
    readonly sorting: false;
    readonly editing: false;
  };
}

export interface RProviderSessionMetadata {
  readonly providerProtocolVersion: typeof R_PROVIDER_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly backend: "r";
  readonly mode: "viewing";
  readonly source: {
    readonly kind: "notebookVariable";
    readonly label: string;
    readonly variableName: string;
  };
  readonly sourceClass: string;
  readonly shape: { readonly rows: number; readonly columns: number };
  readonly schema: readonly ColumnSchema[];
}

export interface RProviderConfirmedSession {
  readonly sessionId: string;
  readonly revision: 0;
  readonly shape: { readonly rows: number; readonly columns: number };
  readonly schema: readonly ColumnSchema[];
}

export type RProviderDispatchContext =
  | {
      readonly requestId: string;
      readonly request: RProviderInitializeRequest;
    }
  | {
      readonly requestId: string;
      readonly request: RProviderOpenSessionRequest;
    }
  | {
      readonly requestId: string;
      readonly request: RProviderGetPageRequest;
      readonly session: RProviderConfirmedSession;
    }
  | {
      readonly requestId: string;
      readonly request: RProviderCloseSessionRequest;
      readonly session: RProviderConfirmedSession;
    };

export interface RProviderSessionOpened {
  readonly kind: "sessionOpened";
  readonly metadata: RProviderSessionMetadata;
  readonly page: GridPage;
}

export interface RProviderPage {
  readonly kind: "page";
  readonly sessionId: string;
  readonly revision: 0;
  readonly viewRequestId: string;
  readonly page: GridPage;
}

export interface RProviderSessionClosed {
  readonly kind: "sessionClosed";
  readonly sessionId: string;
}

export interface RProviderError {
  readonly kind: "error";
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export type RProviderResponse =
  RProviderInitialized | RProviderSessionOpened | RProviderPage | RProviderSessionClosed | RProviderError;

export interface RProviderResponseEnvelope {
  readonly protocolVersion: typeof R_PROVIDER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly response: RProviderResponse;
}

export function isRProviderResponseEnvelope(value: unknown): value is RProviderResponseEnvelope {
  const envelope = exactRecord(value, ["protocolVersion", "requestId", "response"]);
  if (
    envelope === undefined ||
    envelope.protocolVersion !== R_PROVIDER_PROTOCOL_VERSION ||
    !isNonEmptyBoundedString(envelope.requestId, 256)
  ) {
    return false;
  }
  return isRProviderResponse(envelope.response);
}

/**
 * Parses a transport response only after applying the raw UTF-8 byte ceiling.
 *
 * The size check intentionally precedes JSON.parse so an untrusted R helper
 * cannot force an unbounded parsed object allocation in the extension host.
 */
export function parseRProviderResponseJsonForDispatch(
  payload: string,
  context: RProviderDispatchContext
): RProviderResponseEnvelope | undefined {
  if (!isRProviderResponsePayloadWithinLimit(payload)) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    return isRProviderResponseEnvelopeForDispatch(value, context) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isRProviderRequestPayloadWithinLimit(payload: unknown): payload is string {
  return (
    typeof payload === "string" &&
    Buffer.byteLength(payload, "utf8") > 0 &&
    Buffer.byteLength(payload, "utf8") <= R_PROVIDER_LIMITS.maxRequestBytes
  );
}

export function isRProviderResponsePayloadWithinLimit(payload: unknown): payload is string {
  return (
    typeof payload === "string" &&
    Buffer.byteLength(payload, "utf8") > 0 &&
    Buffer.byteLength(payload, "utf8") <= R_PROVIDER_LIMITS.maxResponseBytes
  );
}

export function isRProviderTextWithinLimit(value: unknown): value is string {
  return typeof value === "string" && hasAtMostCodePoints(value, R_PROVIDER_LIMITS.maxTextCodePoints);
}

export function isRProviderShapeWithinLimits(rows: unknown, columns: unknown): boolean {
  return (
    typeof rows === "number" &&
    isSafeIntegerInRange(rows, 0, R_PROVIDER_LIMITS.maxShapeRows) &&
    typeof columns === "number" &&
    isSafeIntegerInRange(columns, 0, R_PROVIDER_LIMITS.maxShapeColumns)
  );
}

export function isRProviderPageDimensionsWithinLimits(rows: unknown, columns: unknown): boolean {
  return (
    typeof rows === "number" &&
    isSafeIntegerInRange(rows, 0, R_PROVIDER_LIMITS.maxPageRows) &&
    typeof columns === "number" &&
    isSafeIntegerInRange(columns, 0, R_PROVIDER_LIMITS.maxPageColumns) &&
    rows * columns <= R_PROVIDER_LIMITS.maxPageCells
  );
}

export function isRProviderSchemaEstimatedBytesWithinLimit(bytes: unknown): boolean {
  return typeof bytes === "number" && isSafeIntegerInRange(bytes, 0, R_PROVIDER_LIMITS.maxSchemaEstimatedBytes);
}

export function isRProviderPageEstimatedBytesWithinLimit(bytes: unknown): boolean {
  return typeof bytes === "number" && isSafeIntegerInRange(bytes, 0, R_PROVIDER_LIMITS.maxPageEstimatedBytes);
}

/**
 * Validates a provider response against the exact request that was dispatched.
 *
 * Transport code must use this contextual guard rather than relying on the
 * structural guard alone. It rejects correctly shaped but stale, misrouted, or
 * semantically contradictory responses before they can enter coordinator state.
 */
export function isRProviderResponseEnvelopeForDispatch(
  value: unknown,
  context: RProviderDispatchContext
): value is RProviderResponseEnvelope {
  if (!isRProviderResponseEnvelope(value) || value.requestId !== context.requestId) {
    return false;
  }
  if (value.response.kind === "error") {
    return true;
  }

  switch (context.request.kind) {
    case "initialize":
      return value.response.kind === "initialized";
    case "openSession":
      return value.response.kind === "sessionOpened" && isOpenedResponseForRequest(value.response, context.request);
    case "getPage":
      return (
        "session" in context &&
        value.response.kind === "page" &&
        context.session.sessionId === context.request.sessionId &&
        context.session.revision === context.request.revision &&
        value.response.sessionId === context.request.sessionId &&
        value.response.revision === context.request.revision &&
        value.response.viewRequestId === context.request.viewRequestId &&
        isPageForWindow(value.response.page, context.session, {
          offset: context.request.offset,
          limit: context.request.limit,
          columnOffset: context.request.columnOffset,
          columnLimit: context.request.columnLimit
        })
      );
    case "closeSession":
      return (
        "session" in context &&
        value.response.kind === "sessionClosed" &&
        context.session.sessionId === context.request.sessionId &&
        context.session.revision === context.request.revision &&
        value.response.sessionId === context.request.sessionId
      );
  }
}

function isRProviderResponse(value: unknown): value is RProviderResponse {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as Record<string, unknown>).kind;
  switch (kind) {
    case "initialized":
      return isInitialized(value);
    case "sessionOpened":
      return isSessionOpened(value);
    case "page":
      return isPage(value);
    case "sessionClosed":
      return isSessionClosed(value);
    case "error":
      return isError(value);
    default:
      return false;
  }
}

function isInitialized(value: unknown): value is RProviderInitialized {
  const candidate = exactRecord(value, ["kind", "runtimeVersion", "language", "transport", "capabilities"]);
  if (
    candidate === undefined ||
    candidate.kind !== "initialized" ||
    !isNonEmptyBoundedString(candidate.runtimeVersion, R_PROVIDER_LIMITS.maxTextCodePoints) ||
    candidate.language !== "r" ||
    candidate.transport !== "inProcessR"
  ) {
    return false;
  }
  const capabilities = exactRecord(candidate.capabilities, [
    "sourceKinds",
    "dataFrameClasses",
    "paging",
    "filtering",
    "sorting",
    "editing"
  ]);
  return (
    capabilities !== undefined &&
    Array.isArray(capabilities.sourceKinds) &&
    capabilities.sourceKinds.length === 1 &&
    capabilities.sourceKinds[0] === "notebookVariable" &&
    Array.isArray(capabilities.dataFrameClasses) &&
    capabilities.dataFrameClasses.length === 3 &&
    capabilities.dataFrameClasses[0] === "data.frame" &&
    capabilities.dataFrameClasses[1] === "tbl_df" &&
    capabilities.dataFrameClasses[2] === "data.table" &&
    capabilities.paging === true &&
    capabilities.filtering === false &&
    capabilities.sorting === false &&
    capabilities.editing === false
  );
}

function isSessionOpened(value: unknown): value is RProviderSessionOpened {
  const candidate = exactRecord(value, ["kind", "metadata", "page"]);
  if (candidate === undefined || candidate.kind !== "sessionOpened" || !isSessionMetadata(candidate.metadata)) {
    return false;
  }
  return isBoundedGridPage(candidate.page, candidate.metadata.schema);
}

function isPage(value: unknown): value is RProviderPage {
  const candidate = exactRecord(value, ["kind", "sessionId", "revision", "viewRequestId", "page"]);
  return (
    candidate !== undefined &&
    candidate.kind === "page" &&
    isNonEmptyBoundedString(candidate.sessionId, 256) &&
    candidate.revision === 0 &&
    isNonEmptyBoundedString(candidate.viewRequestId, 256) &&
    isBoundedGridPage(candidate.page)
  );
}

function isSessionClosed(value: unknown): value is RProviderSessionClosed {
  const candidate = exactRecord(value, ["kind", "sessionId"]);
  return (
    candidate !== undefined && candidate.kind === "sessionClosed" && isNonEmptyBoundedString(candidate.sessionId, 256)
  );
}

function isError(value: unknown): value is RProviderError {
  const candidate = exactRecord(value, ["kind", "code", "message", "recoverable"]);
  return (
    candidate !== undefined &&
    candidate.kind === "error" &&
    isNonEmptyBoundedString(candidate.code, 256) &&
    isNonEmptyBoundedString(candidate.message, R_PROVIDER_LIMITS.maxTextCodePoints) &&
    typeof candidate.recoverable === "boolean"
  );
}

function isSessionMetadata(value: unknown): value is RProviderSessionMetadata {
  const candidate = exactRecord(value, [
    "providerProtocolVersion",
    "sessionId",
    "backend",
    "mode",
    "source",
    "sourceClass",
    "shape",
    "schema"
  ]);
  if (
    candidate === undefined ||
    candidate.providerProtocolVersion !== R_PROVIDER_PROTOCOL_VERSION ||
    !isNonEmptyBoundedString(candidate.sessionId, 256) ||
    candidate.backend !== "r" ||
    candidate.mode !== "viewing" ||
    !isOneOf(candidate.sourceClass, ["data.frame", "tbl_df", "data.table"]) ||
    !isShape(candidate.shape) ||
    !isBoundedRProviderSchema(candidate.schema)
  ) {
    return false;
  }
  const source = exactRecord(candidate.source, ["kind", "label", "variableName"]);
  return (
    source !== undefined &&
    source.kind === "notebookVariable" &&
    isNonEmptyBoundedString(source.label, R_PROVIDER_LIMITS.maxTextCodePoints) &&
    isNonEmptyBoundedString(source.variableName, 1_024) &&
    candidate.shape.columns === candidate.schema.length
  );
}

function isOpenedResponseForRequest(response: RProviderSessionOpened, request: RProviderOpenSessionRequest): boolean {
  const metadata = response.metadata;
  if (
    metadata.sessionId !== request.requestedSessionId ||
    metadata.source.kind !== request.source.kind ||
    metadata.source.label !== request.source.label ||
    metadata.source.variableName !== request.source.variableName
  ) {
    return false;
  }
  return isPageForWindow(
    response.page,
    {
      sessionId: metadata.sessionId,
      revision: 0,
      shape: metadata.shape,
      schema: metadata.schema
    },
    {
      offset: 0,
      limit: request.pageSize,
      columnOffset: request.columnOffset,
      columnLimit: request.columnLimit
    }
  );
}

interface RProviderPageWindow {
  readonly offset: number;
  readonly limit: number;
  readonly columnOffset: number;
  readonly columnLimit: number;
}

function isPageForWindow(page: GridPage, session: RProviderConfirmedSession, window: RProviderPageWindow): boolean {
  if (
    !isNonEmptyBoundedString(session.sessionId, 256) ||
    session.revision !== 0 ||
    !isShape(session.shape) ||
    !isBoundedRProviderSchema(session.schema) ||
    session.shape.columns !== session.schema.length ||
    !isPageWindow(window) ||
    !isBoundedGridPage(page, session.schema) ||
    page.offset !== window.offset ||
    page.limit !== window.limit ||
    page.totalRows !== session.shape.rows
  ) {
    return false;
  }

  const projectedColumns = session.schema.slice(
    Math.min(window.columnOffset, session.schema.length),
    Math.min(window.columnOffset + window.columnLimit, session.schema.length)
  );
  if (
    page.columnIds.length !== projectedColumns.length ||
    page.columnIds.some((columnId, index) => columnId !== projectedColumns[index]?.id)
  ) {
    return false;
  }

  const expectedRows = Math.min(window.limit, Math.max(0, session.shape.rows - window.offset));
  if (page.rows.length !== expectedRows) {
    return false;
  }
  return page.rows.every(
    (row, rowIndex) =>
      row.rowNumber === window.offset + rowIndex &&
      row.id === `r:row:${window.offset + rowIndex}` &&
      row.values.every((cell, columnIndex) => {
        const column = projectedColumns[columnIndex];
        return column !== undefined && isRProviderCellForColumn(cell, column);
      })
  );
}

function isPageWindow(value: RProviderPageWindow): boolean {
  return (
    isSafeIntegerInRange(value.offset, 0, Number.MAX_SAFE_INTEGER) &&
    isSafeIntegerInRange(value.limit, 1, R_PROVIDER_LIMITS.maxPageRows) &&
    isSafeIntegerInRange(value.columnOffset, 0, Number.MAX_SAFE_INTEGER) &&
    isSafeIntegerInRange(value.columnLimit, 1, R_PROVIDER_LIMITS.maxPageColumns)
  );
}

function isRProviderCellForColumn(cell: CellValue, column: ColumnSchema): boolean {
  const hasRaw = Object.hasOwn(cell, "raw");
  const hasSign = Object.hasOwn(cell, "sign");
  if (!hasRaw || !isRProviderTextWithinLimit(cell.display)) return false;

  if (cell.kind === "null") {
    return (
      column.nullable &&
      cell.raw === null &&
      cell.display === "" &&
      cell.isNull === true &&
      cell.isNaN === false &&
      !hasSign
    );
  }
  if (cell.isNull || cell.isNaN !== (cell.kind === "nan")) {
    return false;
  }

  switch (cell.kind) {
    case "nan":
      return column.type === "float" && cell.raw === null && cell.display === "NaN" && !hasSign;
    case "infinity":
      return (
        column.type === "float" &&
        cell.raw === null &&
        (cell.sign === -1 || cell.sign === 1) &&
        cell.display === (cell.sign === -1 ? "-Infinity" : "Infinity")
      );
    case "boolean":
      return (
        column.type === "boolean" &&
        typeof cell.raw === "boolean" &&
        cell.display === (cell.raw ? "true" : "false") &&
        !hasSign
      );
    case "number":
      return column.type === "float" && typeof cell.raw === "number" && Number.isFinite(cell.raw) && !hasSign;
    case "integer":
      return (
        column.type === "integer" &&
        typeof cell.raw === "string" &&
        isRProviderTextWithinLimit(cell.raw) &&
        /^-?(?:0|[1-9][0-9]*)$/u.test(cell.raw) &&
        cell.display === cell.raw &&
        !hasSign
      );
    case "string":
      return (
        column.type === "string" &&
        typeof cell.raw === "string" &&
        isRProviderTextWithinLimit(cell.raw) &&
        cell.display === cell.raw &&
        !hasSign
      );
    case "datetime":
      return (
        column.type === "datetime" &&
        typeof cell.raw === "string" &&
        isRProviderTextWithinLimit(cell.raw) &&
        cell.raw.length > 0 &&
        cell.display === cell.raw &&
        !hasSign
      );
    case "date":
      return (
        column.type === "date" &&
        typeof cell.raw === "string" &&
        isRProviderTextWithinLimit(cell.raw) &&
        cell.raw.length > 0 &&
        cell.display === cell.raw &&
        !hasSign
      );
    case "duration":
      return (
        column.type === "duration" &&
        typeof cell.raw === "string" &&
        isRProviderTextWithinLimit(cell.raw) &&
        cell.raw.length > 0 &&
        cell.display === cell.raw &&
        !hasSign
      );
    case "unknown":
      return column.type === "unknown" && cell.raw === null && cell.display.length > 0 && !hasSign;
    default:
      return false;
  }
}

function isShape(value: unknown): value is { rows: number; columns: number } {
  const candidate = exactRecord(value, ["rows", "columns"]);
  return candidate !== undefined && isRProviderShapeWithinLimits(candidate.rows, candidate.columns);
}

function isBoundedRProviderSchema(value: unknown): value is readonly ColumnSchema[] {
  if (!isColumnSchemaArray(value) || value.length > R_PROVIDER_LIMITS.maxShapeColumns) return false;
  let estimatedBytes = 1_024;
  for (const column of value) {
    if (
      column.id !== `r:c:${column.position}` ||
      !isRProviderTextWithinLimit(column.name) ||
      !isNonEmptyBoundedString(column.rawType, R_PROVIDER_LIMITS.maxTextCodePoints) ||
      !isRProviderRawTypeForColumn(column)
    ) {
      return false;
    }
    estimatedBytes += 256 + 6 * (Buffer.byteLength(column.name, "utf8") + Buffer.byteLength(column.rawType, "utf8"));
    if (!isRProviderSchemaEstimatedBytesWithinLimit(estimatedBytes)) return false;
  }
  return true;
}

const R_PROVIDER_RAW_TYPE_PATTERN =
  /^(logical|integer|double|character)<([A-Za-z][A-Za-z0-9._]*(?:,[A-Za-z][A-Za-z0-9._]*)*)>$/u;

function isRProviderRawTypeForColumn(column: ColumnSchema): boolean {
  const match = R_PROVIDER_RAW_TYPE_PATTERN.exec(column.rawType);
  if (match === null) return false;
  const storage = match[1];
  const classes = new Set((match[2] ?? "").split(","));
  let emittedType: ColumnSchema["type"] | undefined;
  if (classes.has("POSIXt")) {
    emittedType = storage === "double" ? "datetime" : undefined;
  } else if (classes.has("Date")) {
    emittedType = storage === "double" ? "date" : undefined;
  } else if (classes.has("difftime")) {
    emittedType = storage === "double" ? "duration" : undefined;
  } else if (classes.has("factor")) {
    emittedType = storage === "character" || storage === "integer" ? "string" : undefined;
  } else if (storage === "character") {
    emittedType = "string";
  } else if (storage === "logical") {
    emittedType = "boolean";
  } else if (storage === "integer") {
    emittedType = "integer";
  } else if (classes.has("integer64") && storage === "double") {
    emittedType = "integer";
  } else if (storage === "double") {
    emittedType = "float";
  }
  return emittedType === column.type;
}

function isBoundedGridPage(value: unknown, schema?: readonly ColumnSchema[]): value is GridPage {
  if (!isGridPage(value, schema)) return false;
  const page = value;
  if (
    !isSafeIntegerInRange(page.offset, 0, R_PROVIDER_LIMITS.maxShapeRows) ||
    !isSafeIntegerInRange(page.limit, 1, R_PROVIDER_LIMITS.maxPageRows) ||
    !isSafeIntegerInRange(page.totalRows, 0, R_PROVIDER_LIMITS.maxShapeRows) ||
    !isRProviderPageDimensionsWithinLimits(page.rows.length, page.columnIds.length)
  ) {
    return false;
  }
  if (!page.columnIds.every((columnId) => isNonEmptyBoundedString(columnId, R_PROVIDER_LIMITS.maxTextCodePoints))) {
    return false;
  }

  let estimatedBytes = 1_024 + 64 * page.columnIds.length;
  for (const row of page.rows) {
    if (!isNonEmptyBoundedString(row.id, R_PROVIDER_LIMITS.maxTextCodePoints)) return false;
    estimatedBytes += 128;
    for (const cell of row.values) {
      if (!isRProviderTextWithinLimit(cell.display)) return false;
      const rawBytes =
        typeof cell.raw === "string"
          ? isRProviderTextWithinLimit(cell.raw)
            ? Buffer.byteLength(cell.raw, "utf8")
            : Number.POSITIVE_INFINITY
          : 0;
      estimatedBytes += 128 + 6 * (Buffer.byteLength(cell.display, "utf8") + rawBytes);
      if (!isRProviderPageEstimatedBytesWithinLimit(estimatedBytes)) return false;
    }
  }
  return true;
}

function isSafeIntegerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const actualKeys = Object.keys(candidate);
  if (actualKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(candidate, key))) return undefined;
  return candidate;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyBoundedString(value: unknown, maximumCodePoints: number): value is string {
  return isNonEmptyString(value) && hasAtMostCodePoints(value, maximumCodePoints);
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}
