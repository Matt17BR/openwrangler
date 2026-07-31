import type { ColumnSchema, GridPage } from "../../shared/protocol";
import { isColumnSchemaArray, isGridPage } from "../../shared/protocolValidation";

export const R_PROVIDER_PROTOCOL_VERSION = 1 as const;

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
    !isNonEmptyString(candidate.sourceClass) ||
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
