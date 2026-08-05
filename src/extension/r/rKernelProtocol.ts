import { decodeRFramePage, R_FRAME_CONTRACT_LIMITS, type RFramePageContract } from "./rFrameContract";

export const R_KERNEL_TRANSPORT_VERSION = 1 as const;
export const R_KERNEL_MAX_RESPONSE_BYTES = 17 * 1_024 * 1_024;

const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumVariableNameBytes = 1_024;
const maximumDiagnosticBytes = 4_096;

export const R_KERNEL_DIAGNOSTIC_CODES = Object.freeze([
  "duplicate_session",
  "invalid_request",
  "missing_package",
  "page_too_large",
  "runtime_error",
  "stale_column",
  "unknown_session",
  "unknown_variable",
  "unsupported_frame"
] as const);

export type RKernelDiagnosticCode = (typeof R_KERNEL_DIAGNOSTIC_CODES)[number];
const rKernelDiagnosticCodes = new Set<string>(R_KERNEL_DIAGNOSTIC_CODES);

export interface RKernelSortRule {
  readonly column: Readonly<{ id: string; name: string }>;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

export interface RKernelPageWindow {
  readonly rowOffset: number;
  readonly rowLimit: number;
  readonly columnOffset: number;
  readonly columnLimit: number;
  readonly sorts: readonly RKernelSortRule[];
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
  return JSON.stringify(request);
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
  if (record.kind === "closeSession") {
    const payload = exactRecord(record.payload, ["sessionId"], "R kernel close payload");
    identifier(payload.sessionId, "request.payload.sessionId");
    return;
  }
  fail("R kernel request has an unsupported kind.");
}

function validatePage(value: unknown): void {
  const page = exactRecord(value, ["rowOffset", "rowLimit", "columnOffset", "columnLimit", "sorts"], "R kernel page");
  boundedInteger(page.rowOffset, "page.rowOffset", R_FRAME_CONTRACT_LIMITS.rows);
  boundedInteger(page.rowLimit, "page.rowLimit", R_FRAME_CONTRACT_LIMITS.pageRows);
  boundedInteger(page.columnOffset, "page.columnOffset", R_FRAME_CONTRACT_LIMITS.columns);
  boundedInteger(page.columnLimit, "page.columnLimit", R_FRAME_CONTRACT_LIMITS.pageColumns);
  if (!Array.isArray(page.sorts) || page.sorts.length > R_FRAME_CONTRACT_LIMITS.sortRules) {
    fail("R page sorts exceed the supported limit.");
  }
  const seen = new Set<string>();
  for (const [index, value] of page.sorts.entries()) {
    const rule = exactRecord(value, ["column", "direction", "nulls"], `R kernel page sort ${index}`);
    const column = exactRecord(rule.column, ["id", "name"], `R kernel page sort ${index} column`);
    const id = boundedText(column.id, `page.sorts[${index}].column.id`, 128, false);
    boundedText(column.name, `page.sorts[${index}].column.name`, maximumVariableNameBytes, true);
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

function exactRecord(value: unknown, fields: readonly string[], label = "R kernel response"): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
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
