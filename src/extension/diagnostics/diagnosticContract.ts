export const OFFLINE_DIAGNOSTIC_SCHEMA = "openwrangler-offline-diagnostics-v1" as const;
export const OFFLINE_DIAGNOSTIC_EVENT_CAPACITY = 128;
export const OFFLINE_DIAGNOSTIC_MAX_BYTES = 64 * 1024;

const MAX_DIAGNOSTIC_COUNT = 2_147_483_647;

export const DIAGNOSTIC_CODE_CONTRACT = Object.freeze({
  runtime: Object.freeze(["start", "ready", "exit", "restart"]),
  session: Object.freeze(["open", "close", "cleanup_failure"]),
  request: Object.freeze(["failure", "cancelled", "stale"]),
  recovery: Object.freeze(["start", "success", "failure"]),
  dependency: Object.freeze(["missing", "install_failure", "environment_uncertain"]),
  environment: Object.freeze(["resolution_failure", "selection_changed"]),
  kernel: Object.freeze(["restart", "unavailable"])
} as const);

export type DiagnosticCategory = keyof typeof DIAGNOSTIC_CODE_CONTRACT;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODE_CONTRACT)[DiagnosticCategory][number];
export type DiagnosticEditor = "vscode" | "cursor" | "other";
export type DiagnosticPlatform = "linux" | "macos" | "windows" | "other";

export interface DiagnosticObservation {
  readonly category: DiagnosticCategory;
  readonly code: DiagnosticCode;
  readonly recoverable: boolean;
}

export interface DiagnosticEvent extends DiagnosticObservation {
  readonly sequence: number;
}

export interface DiagnosticCounter {
  readonly category: DiagnosticCategory;
  readonly code: DiagnosticCode;
  readonly count: number;
}

export interface DiagnosticCapture {
  readonly capacity: typeof OFFLINE_DIAGNOSTIC_EVENT_CAPACITY;
  readonly totalObserved: number;
  readonly dropped: number;
  readonly counters: readonly DiagnosticCounter[];
  readonly events: readonly DiagnosticEvent[];
}

export interface OfflineDiagnosticMetadata {
  readonly extensionVersion: string;
  readonly editor: DiagnosticEditor;
  readonly editorVersion: string;
  readonly platform: DiagnosticPlatform;
  readonly remote: boolean;
  readonly workspaceTrusted: boolean;
  readonly protocolVersion: 2;
}

export interface OfflineDiagnosticBundle {
  readonly schema: typeof OFFLINE_DIAGNOSTIC_SCHEMA;
  readonly metadata: OfflineDiagnosticMetadata;
  readonly capture: DiagnosticCapture;
}

export class DiagnosticContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticContractError";
  }
}

const CATEGORY_ORDER = Object.freeze(Object.keys(DIAGNOSTIC_CODE_CONTRACT) as DiagnosticCategory[]);
const VERSION_TOKEN =
  /^(?:unknown|0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){0,3}(?:-(?:dev|insider|oss|preview)(?:\.[0-9]{1,10})?)?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!isRecord(value)) throw new DiagnosticContractError("Diagnostic values must be plain objects.");
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new DiagnosticContractError("Diagnostic values contain missing or unsupported fields.");
  }
  return value;
}

function isCategory(value: unknown): value is DiagnosticCategory {
  return typeof value === "string" && CATEGORY_ORDER.includes(value as DiagnosticCategory);
}

function validCode(category: DiagnosticCategory, value: unknown): value is DiagnosticCode {
  return typeof value === "string" && (DIAGNOSTIC_CODE_CONTRACT[category] as readonly string[]).includes(value);
}

function validatedObservation(value: unknown): DiagnosticObservation {
  const candidate = exactRecord(value, ["category", "code", "recoverable"]);
  if (!isCategory(candidate.category) || !validCode(candidate.category, candidate.code)) {
    throw new DiagnosticContractError("Diagnostic category and code must be an allowed pair.");
  }
  if (typeof candidate.recoverable !== "boolean") {
    throw new DiagnosticContractError("Diagnostic recoverability must be boolean.");
  }
  return Object.freeze({
    category: candidate.category,
    code: candidate.code,
    recoverable: candidate.recoverable
  });
}

function validatedMetadata(value: unknown): OfflineDiagnosticMetadata {
  const candidate = exactRecord(value, [
    "extensionVersion",
    "editor",
    "editorVersion",
    "platform",
    "remote",
    "workspaceTrusted",
    "protocolVersion"
  ]);
  if (typeof candidate.extensionVersion !== "string" || !VERSION_TOKEN.test(candidate.extensionVersion)) {
    throw new DiagnosticContractError("The extension version is not an allowed version token.");
  }
  if (typeof candidate.editorVersion !== "string" || !VERSION_TOKEN.test(candidate.editorVersion)) {
    throw new DiagnosticContractError("The editor version is not an allowed version token.");
  }
  if (candidate.editor !== "vscode" && candidate.editor !== "cursor" && candidate.editor !== "other") {
    throw new DiagnosticContractError("The editor must use an allowed identifier.");
  }
  if (
    candidate.platform !== "linux" &&
    candidate.platform !== "macos" &&
    candidate.platform !== "windows" &&
    candidate.platform !== "other"
  ) {
    throw new DiagnosticContractError("The platform must use an allowed identifier.");
  }
  if (typeof candidate.remote !== "boolean" || typeof candidate.workspaceTrusted !== "boolean") {
    throw new DiagnosticContractError("Diagnostic environment flags must be boolean.");
  }
  if (candidate.protocolVersion !== 2) {
    throw new DiagnosticContractError("Offline diagnostics support protocol version 2 only.");
  }
  return Object.freeze({
    extensionVersion: candidate.extensionVersion,
    editor: candidate.editor,
    editorVersion: candidate.editorVersion,
    platform: candidate.platform,
    remote: candidate.remote,
    workspaceTrusted: candidate.workspaceTrusted,
    protocolVersion: 2
  });
}

function counterKey(category: DiagnosticCategory, code: DiagnosticCode): string {
  return `${category}\u0000${code}`;
}

function incrementBounded(value: number): number {
  if (value >= MAX_DIAGNOSTIC_COUNT) {
    throw new DiagnosticContractError("The diagnostic counter reached its fixed supported limit.");
  }
  return value + 1;
}

export class DiagnosticLedger {
  private readonly events: DiagnosticEvent[] = [];
  private readonly counts = new Map<string, number>();
  private totalObserved = 0;

  record(value: unknown): DiagnosticEvent {
    const observation = validatedObservation(value);
    const sequence = incrementBounded(this.totalObserved);
    const event = Object.freeze({ sequence, ...observation });
    this.totalObserved = sequence;
    const key = counterKey(observation.category, observation.code);
    this.counts.set(key, incrementBounded(this.counts.get(key) ?? 0));
    this.events.push(event);
    if (this.events.length > OFFLINE_DIAGNOSTIC_EVENT_CAPACITY) this.events.shift();
    return event;
  }

  snapshot(): DiagnosticCapture {
    const counters: DiagnosticCounter[] = [];
    for (const category of CATEGORY_ORDER) {
      for (const code of DIAGNOSTIC_CODE_CONTRACT[category]) {
        const count = this.counts.get(counterKey(category, code));
        if (count !== undefined) counters.push(Object.freeze({ category, code, count }));
      }
    }
    const events = Object.freeze(this.events.map((event) => Object.freeze({ ...event })));
    return Object.freeze({
      capacity: OFFLINE_DIAGNOSTIC_EVENT_CAPACITY,
      totalObserved: this.totalObserved,
      dropped: this.totalObserved - events.length,
      counters: Object.freeze(counters),
      events
    });
  }
}

function validatedCapture(value: unknown): DiagnosticCapture {
  const candidate = exactRecord(value, ["capacity", "totalObserved", "dropped", "counters", "events"]);
  if (candidate.capacity !== OFFLINE_DIAGNOSTIC_EVENT_CAPACITY) {
    throw new DiagnosticContractError("The diagnostic capture capacity is invalid.");
  }
  if (
    typeof candidate.totalObserved !== "number" ||
    !Number.isSafeInteger(candidate.totalObserved) ||
    candidate.totalObserved < 0 ||
    candidate.totalObserved > MAX_DIAGNOSTIC_COUNT ||
    typeof candidate.dropped !== "number" ||
    !Number.isSafeInteger(candidate.dropped) ||
    candidate.dropped < 0
  ) {
    throw new DiagnosticContractError("The diagnostic capture counts are invalid.");
  }
  const totalObserved = candidate.totalObserved;
  const dropped = candidate.dropped;
  if (!Array.isArray(candidate.events) || candidate.events.length > OFFLINE_DIAGNOSTIC_EVENT_CAPACITY) {
    throw new DiagnosticContractError("The diagnostic event window is invalid.");
  }
  const expectedEventCount = Math.min(totalObserved, OFFLINE_DIAGNOSTIC_EVENT_CAPACITY);
  if (candidate.events.length !== expectedEventCount || dropped !== totalObserved - expectedEventCount) {
    throw new DiagnosticContractError("The diagnostic event window does not match the aggregate counts.");
  }
  const events = candidate.events.map((entry) => {
    const event = exactRecord(entry, ["sequence", "category", "code", "recoverable"]);
    if (
      typeof event.sequence !== "number" ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 1 ||
      event.sequence > totalObserved
    ) {
      throw new DiagnosticContractError("A diagnostic event sequence is invalid.");
    }
    return Object.freeze({
      sequence: event.sequence,
      ...validatedObservation({
        category: event.category,
        code: event.code,
        recoverable: event.recoverable
      })
    });
  });
  if (events.some((event, index) => index > 0 && events[index - 1].sequence >= event.sequence)) {
    throw new DiagnosticContractError("Diagnostic events must be strictly ordered.");
  }
  if (events.some((event, index) => event.sequence !== dropped + index + 1)) {
    throw new DiagnosticContractError("Diagnostic events must be the exact consecutive retained tail.");
  }
  if (!Array.isArray(candidate.counters)) {
    throw new DiagnosticContractError("Diagnostic counters must be an array.");
  }
  const expectedCounters = new Map<string, number>();
  for (const event of events) {
    const key = counterKey(event.category, event.code);
    expectedCounters.set(key, (expectedCounters.get(key) ?? 0) + 1);
  }
  const seenCounters = new Set<string>();
  const suppliedCounters = new Map<string, DiagnosticCounter>();
  candidate.counters.forEach((entry) => {
    const counter = exactRecord(entry, ["category", "code", "count"]);
    if (!isCategory(counter.category) || !validCode(counter.category, counter.code)) {
      throw new DiagnosticContractError("A diagnostic counter has an invalid category or code.");
    }
    if (
      typeof counter.count !== "number" ||
      !Number.isSafeInteger(counter.count) ||
      counter.count < 1 ||
      counter.count > totalObserved
    ) {
      throw new DiagnosticContractError("A diagnostic counter value is invalid.");
    }
    const key = counterKey(counter.category, counter.code);
    if (seenCounters.has(key)) throw new DiagnosticContractError("Diagnostic counters must be unique.");
    seenCounters.add(key);
    suppliedCounters.set(key, Object.freeze({ category: counter.category, code: counter.code, count: counter.count }));
  });
  const counters: DiagnosticCounter[] = [];
  for (const category of CATEGORY_ORDER) {
    for (const code of DIAGNOSTIC_CODE_CONTRACT[category]) {
      const counter = suppliedCounters.get(counterKey(category, code));
      if (counter) counters.push(counter);
    }
  }
  for (const [key, windowCount] of expectedCounters) {
    const aggregate = counters.find((counter) => counterKey(counter.category, counter.code) === key)?.count;
    if (aggregate === undefined || aggregate < windowCount) {
      throw new DiagnosticContractError("Diagnostic counters do not cover the retained event window.");
    }
  }
  if (counters.reduce((total, counter) => total + counter.count, 0) !== totalObserved) {
    throw new DiagnosticContractError("Diagnostic counters do not match the total event count.");
  }
  return Object.freeze({
    capacity: OFFLINE_DIAGNOSTIC_EVENT_CAPACITY,
    totalObserved,
    dropped,
    counters: Object.freeze(counters),
    events: Object.freeze(events)
  });
}

export function createOfflineDiagnosticBundle(
  metadata: unknown,
  capture: unknown
): Readonly<{ bundle: OfflineDiagnosticBundle; json: string; byteLength: number }> {
  const bundle = Object.freeze({
    schema: OFFLINE_DIAGNOSTIC_SCHEMA,
    metadata: validatedMetadata(metadata),
    capture: validatedCapture(capture)
  });
  const json = `${JSON.stringify(bundle)}\n`;
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > OFFLINE_DIAGNOSTIC_MAX_BYTES) {
    throw new DiagnosticContractError("The offline diagnostic bundle exceeds its fixed byte limit.");
  }
  return Object.freeze({ bundle, json, byteLength });
}
