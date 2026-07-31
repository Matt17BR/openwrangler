import type { CellValue, ColumnSchema, GridPage } from "../../shared/protocol";
import { isColumnSchemaArray, isGridPage } from "../../shared/protocolValidation";

export const R_PROVIDER_PROTOCOL_VERSION = 1 as const;

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
    readonly dataFrameClasses: readonly string[];
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
    !isNonEmptyString(envelope.requestId)
  ) {
    return false;
  }
  return isRProviderResponse(envelope.response);
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
    !isNonEmptyString(candidate.runtimeVersion) ||
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
    capabilities.dataFrameClasses.length > 0 &&
    capabilities.dataFrameClasses.every(isNonEmptyString) &&
    new Set(capabilities.dataFrameClasses).size === capabilities.dataFrameClasses.length &&
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
  return isGridPage(candidate.page, candidate.metadata.schema);
}

function isPage(value: unknown): value is RProviderPage {
  const candidate = exactRecord(value, ["kind", "sessionId", "revision", "viewRequestId", "page"]);
  return (
    candidate !== undefined &&
    candidate.kind === "page" &&
    isNonEmptyString(candidate.sessionId) &&
    candidate.revision === 0 &&
    isNonEmptyString(candidate.viewRequestId) &&
    isGridPage(candidate.page)
  );
}

function isSessionClosed(value: unknown): value is RProviderSessionClosed {
  const candidate = exactRecord(value, ["kind", "sessionId"]);
  return candidate !== undefined && candidate.kind === "sessionClosed" && isNonEmptyString(candidate.sessionId);
}

function isError(value: unknown): value is RProviderError {
  const candidate = exactRecord(value, ["kind", "code", "message", "recoverable"]);
  return (
    candidate !== undefined &&
    candidate.kind === "error" &&
    isNonEmptyString(candidate.code) &&
    isNonEmptyString(candidate.message) &&
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
    !isNonEmptyString(candidate.sessionId) ||
    candidate.backend !== "r" ||
    candidate.mode !== "viewing" ||
    !isOneOf(candidate.sourceClass, ["data.frame", "tbl_df", "data.table"]) ||
    !isShape(candidate.shape) ||
    !isColumnSchemaArray(candidate.schema)
  ) {
    return false;
  }
  const source = exactRecord(candidate.source, ["kind", "label", "variableName"]);
  return (
    source !== undefined &&
    source.kind === "notebookVariable" &&
    isNonEmptyString(source.label) &&
    isNonEmptyString(source.variableName) &&
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
    !isNonEmptyString(session.sessionId) ||
    session.revision !== 0 ||
    !isShape(session.shape) ||
    !isColumnSchemaArray(session.schema) ||
    session.shape.columns !== session.schema.length ||
    !isPageWindow(window) ||
    !isGridPage(page, session.schema) ||
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
    isSafeIntegerInRange(value.limit, 1, 10_000) &&
    isSafeIntegerInRange(value.columnOffset, 0, Number.MAX_SAFE_INTEGER) &&
    isSafeIntegerInRange(value.columnLimit, 1, 256)
  );
}

function isRProviderCellForColumn(cell: CellValue, column: ColumnSchema): boolean {
  const hasRaw = Object.hasOwn(cell, "raw");
  const hasSign = Object.hasOwn(cell, "sign");
  if (!hasRaw) return false;

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
        /^-?(?:0|[1-9][0-9]*)$/u.test(cell.raw) &&
        cell.display === cell.raw &&
        !hasSign
      );
    case "string":
      return column.type === "string" && typeof cell.raw === "string" && cell.display === cell.raw && !hasSign;
    case "datetime":
      return (
        column.type === "datetime" &&
        typeof cell.raw === "string" &&
        cell.raw.length > 0 &&
        cell.display === cell.raw &&
        !hasSign
      );
    case "date":
      return (
        column.type === "date" &&
        typeof cell.raw === "string" &&
        cell.raw.length > 0 &&
        cell.display === cell.raw &&
        !hasSign
      );
    case "duration":
      return (
        column.type === "duration" &&
        typeof cell.raw === "string" &&
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
  return (
    candidate !== undefined &&
    Number.isSafeInteger(candidate.rows) &&
    Number(candidate.rows) >= 0 &&
    Number.isSafeInteger(candidate.columns) &&
    Number(candidate.columns) >= 0
  );
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
