import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import { performance } from "node:perf_hooks";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export const DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL = "openwrangler-data-wrangler-study-bridge-request-v1";
export const DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL = "openwrangler-data-wrangler-study-bridge-ack-v1";
export const DATA_WRANGLER_STUDY_BRIDGE_KINDS = [
  "source-verified",
  "cold-cache-evicted",
  "measurement-ready",
  "sampling-origin",
  "inline-baseline",
  "workbench-baseline",
  "profile-baseline",
  "sampling-stop",
  "cleanup-census"
] as const;

export type DataWranglerStudyBridgeKind = (typeof DATA_WRANGLER_STUDY_BRIDGE_KINDS)[number];

export interface DataWranglerStudyBridgeEnvelope {
  readonly protocol:
    typeof DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL | typeof DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL;
  readonly runId: string;
  readonly phase: string;
  readonly sequence: number;
  readonly kind: DataWranglerStudyBridgeKind;
  readonly monotonicNanoseconds: string;
}

export interface DataWranglerStudyBridgeExchange {
  readonly request: DataWranglerStudyBridgeEnvelope;
  readonly acknowledgement: DataWranglerStudyBridgeEnvelope;
}

export interface DataWranglerStudyControlBridge {
  exchange(kind: DataWranglerStudyBridgeKind): Promise<DataWranglerStudyBridgeExchange>;
  nextSequence(): number;
  close(): void;
}

export interface DataWranglerStudyControlBridgeOptions {
  readonly clock?: () => bigint;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PHASE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const NANOSECONDS = /^[1-9]\d{0,29}$/u;
const MAXIMUM_SEQUENCE = 4_096;
const MAXIMUM_ENVELOPE_BYTES = 2_048;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 10;

export class DataWranglerStudyControlBridgeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DataWranglerStudyControlBridgeError";
  }
}

function fail(code: string, message: string, options?: ErrorOptions): never {
  throw new DataWranglerStudyControlBridgeError(code, message, options);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("malformed-envelope", `${label} has missing or unknown fields.`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("malformed-envelope", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function validateCorrelation(runId: unknown, phase: unknown): { readonly runId: string; readonly phase: string } {
  if (typeof runId !== "string" || !UUID.test(runId)) {
    fail("invalid-correlation", "Study bridge run ID must be a version-4 UUID.");
  }
  if (typeof phase !== "string" || !PHASE.test(phase)) {
    fail("invalid-correlation", "Study bridge phase is malformed or exceeds its bound.");
  }
  return { runId, phase };
}

function validateSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAXIMUM_SEQUENCE) {
    fail("invalid-sequence", "Study bridge sequence is outside its fixed range.");
  }
  return value as number;
}

function validateKind(value: unknown): DataWranglerStudyBridgeKind {
  if (!DATA_WRANGLER_STUDY_BRIDGE_KINDS.includes(value as DataWranglerStudyBridgeKind)) {
    fail("invalid-kind", "Study bridge message kind is not part of the fixed handshake protocol.");
  }
  return value as DataWranglerStudyBridgeKind;
}

function validateClockText(value: unknown): string {
  if (typeof value !== "string" || !NANOSECONDS.test(value)) {
    fail("invalid-clock", "Study bridge monotonic timestamp is malformed or exceeds its bound.");
  }
  return value;
}

export function validateDataWranglerStudyBridgeEnvelope(
  value: unknown,
  expectedProtocol: typeof DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL | typeof DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL
): DataWranglerStudyBridgeEnvelope {
  const envelope = requireRecord(value, "Study bridge envelope");
  exactKeys(
    envelope,
    ["protocol", "runId", "phase", "sequence", "kind", "monotonicNanoseconds"],
    "Study bridge envelope"
  );
  if (envelope.protocol !== expectedProtocol) {
    fail("stale-envelope", "Study bridge envelope uses the wrong protocol version.");
  }
  const correlation = validateCorrelation(envelope.runId, envelope.phase);
  return Object.freeze({
    protocol: expectedProtocol,
    ...correlation,
    sequence: validateSequence(envelope.sequence),
    kind: validateKind(envelope.kind),
    monotonicNanoseconds: validateClockText(envelope.monotonicNanoseconds)
  });
}

function canonicalJson(value: DataWranglerStudyBridgeEnvelope): string {
  const ordered = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key as keyof DataWranglerStudyBridgeEnvelope]])
  );
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function currentUserOwns(metadata: BigIntStats): boolean {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

function assertPrivateDirectory(metadata: BigIntStats): void {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o700n
  ) {
    fail("invalid-path", "Study bridge parent must be an owned mode-0700 directory.");
  }
}

function assertPrivateFile(metadata: BigIntStats, expectedLinks: bigint): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== expectedLinks ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o600n ||
    metadata.size < 1n ||
    metadata.size > BigInt(MAXIMUM_ENVELOPE_BYTES)
  ) {
    fail("invalid-entry", "Study bridge entry is not one private bounded regular file.");
  }
}

function validatePath(value: string, label: string): string {
  if (!isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    fail("invalid-path", `${label} must be an absolute path.`);
  }
  const normalized = resolve(value);
  const name = basename(normalized);
  if (name.length === 0 || name === "." || name === ".." || Buffer.byteLength(name, "utf8") > 180) {
    fail("invalid-path", `${label} has an invalid file name.`);
  }
  return normalized;
}

interface OpenParent {
  readonly descriptor: number;
  readonly path: string;
  readonly identity: BigIntStats;
}

function openParent(path: string): OpenParent {
  const parentPath = dirname(path);
  const named = lstatSync(parentPath, { bigint: true });
  assertPrivateDirectory(named);
  const descriptor = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertPrivateDirectory(opened);
    if (!sameIdentity(named, opened)) fail("parent-rebound", "Study bridge parent changed while it opened.");
    return { descriptor, path: parentPath, identity: opened };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function anchored(parent: OpenParent, path: string): string {
  return `/proc/self/fd/${parent.descriptor}/${basename(path)}`;
}

function verifyParent(parent: OpenParent): void {
  const opened = fstatSync(parent.descriptor, { bigint: true });
  const named = lstatSync(parent.path, { bigint: true });
  assertPrivateDirectory(opened);
  assertPrivateDirectory(named);
  if (!sameIdentity(opened, parent.identity) || !sameIdentity(named, parent.identity)) {
    fail("parent-rebound", "Study bridge parent changed during an exchange.");
  }
}

function entryExists(path: string): boolean {
  const parent = openParent(path);
  try {
    try {
      lstatSync(anchored(parent, path), { bigint: true });
      verifyParent(parent);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      verifyParent(parent);
      return false;
    }
  } finally {
    closeSync(parent.descriptor);
  }
}

interface ReadEntry {
  readonly envelope: DataWranglerStudyBridgeEnvelope;
  readonly metadata: BigIntStats;
}

function readEntry(
  path: string,
  protocol: typeof DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL | typeof DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL,
  options: { readonly optional?: boolean; readonly consume?: boolean } = {}
): ReadEntry | null {
  const parent = openParent(path);
  let descriptor: number | undefined;
  try {
    const name = anchored(parent, path);
    let named: BigIntStats;
    try {
      named = lstatSync(name, { bigint: true });
    } catch (error) {
      if (options.optional === true && (error as NodeJS.ErrnoException).code === "ENOENT") {
        verifyParent(parent);
        return null;
      }
      throw error;
    }
    assertPrivateFile(named, 1n);
    descriptor = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    assertPrivateFile(opened, 1n);
    if (!sameSnapshot(named, opened)) fail("entry-changed", "Study bridge entry changed while it opened.");
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    const finalNamed = lstatSync(name, { bigint: true });
    if (!sameSnapshot(opened, after) || !sameSnapshot(after, finalNamed)) {
      fail("entry-changed", "Study bridge entry changed while it was read.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      fail("malformed-envelope", "Study bridge entry is not valid JSON.", { cause: error });
    }
    const envelope = validateDataWranglerStudyBridgeEnvelope(parsed, protocol);
    if (canonicalJson(envelope) !== text) {
      fail("malformed-envelope", "Study bridge entry is not canonical JSON.");
    }
    if (options.consume === true) {
      verifyParent(parent);
      const beforeUnlink = lstatSync(name, { bigint: true });
      if (!sameSnapshot(after, beforeUnlink)) fail("entry-changed", "Study bridge entry changed before consumption.");
      unlinkSync(name);
      fsyncSync(parent.descriptor);
      verifyParent(parent);
    } else {
      verifyParent(parent);
    }
    return { envelope, metadata: after };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeSync(parent.descriptor);
  }
}

interface PublicationIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

function publishEnvelope(path: string, envelope: DataWranglerStudyBridgeEnvelope): PublicationIdentity {
  const serialized = canonicalJson(envelope);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_ENVELOPE_BYTES) {
    fail("invalid-entry", "Study bridge envelope exceeds its byte bound.");
  }
  const parent = openParent(path);
  const temporaryName = `.ow-study-${randomBytes(16).toString("hex")}.tmp`;
  const temporaryPath = `/proc/self/fd/${parent.descriptor}/${temporaryName}`;
  const targetPath = anchored(parent, path);
  let descriptor: number | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  try {
    if (entryExists(path)) fail("stale-entry", "Study bridge request path is already occupied.");
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    temporaryIdentity = fstatSync(descriptor, { bigint: true });
    assertPrivateFile(temporaryIdentity, 1n);
    closeSync(descriptor);
    descriptor = undefined;
    verifyParent(parent);
    linkSync(temporaryPath, targetPath);
    fsyncSync(parent.descriptor);
    const linked = lstatSync(targetPath, { bigint: true });
    assertPrivateFile(linked, 2n);
    if (!sameIdentity(linked, temporaryIdentity)) fail("entry-changed", "Study bridge publication changed identity.");
    unlinkSync(temporaryPath);
    fsyncSync(parent.descriptor);
    const published = lstatSync(targetPath, { bigint: true });
    assertPrivateFile(published, 1n);
    if (!sameIdentity(published, temporaryIdentity))
      fail("entry-changed", "Study bridge publication changed identity.");
    verifyParent(parent);
    temporaryIdentity = undefined;
    return { device: published.dev, inode: published.ino };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryIdentity !== undefined) {
      try {
        const candidate = lstatSync(temporaryPath, { bigint: true });
        if (sameIdentity(candidate, temporaryIdentity)) {
          unlinkSync(temporaryPath);
          fsyncSync(parent.descriptor);
        }
      } catch {
        // The publication failure remains authoritative.
      }
    }
    closeSync(parent.descriptor);
  }
}

function assertNoStaleEntries(requestPath: string, acknowledgementPath: string): void {
  if (entryExists(requestPath) || entryExists(acknowledgementPath)) {
    fail("stale-entry", "Study bridge paths contain an unconsumed request or acknowledgement.");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function createDataWranglerStudyControlBridge(
  input: {
    readonly requestPath: string;
    readonly acknowledgementPath: string;
    readonly runId: string;
    readonly phase: string;
  },
  options: DataWranglerStudyControlBridgeOptions = {}
): DataWranglerStudyControlBridge {
  if (process.platform !== "linux") fail("unsupported-platform", "The study control bridge requires Linux.");
  const requestPath = validatePath(input.requestPath, "Study bridge request path");
  const acknowledgementPath = validatePath(input.acknowledgementPath, "Study bridge acknowledgement path");
  if (requestPath === acknowledgementPath || dirname(requestPath) !== dirname(acknowledgementPath)) {
    fail("invalid-path", "Study bridge request and acknowledgement must be distinct siblings.");
  }
  const correlation = validateCorrelation(input.runId, input.phase);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 1_000 ||
    pollIntervalMs > timeoutMs
  ) {
    fail("invalid-timeout", "Study bridge timeout and polling interval are invalid.");
  }
  const clock = options.clock ?? process.hrtime.bigint;
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? delay;
  assertNoStaleEntries(requestPath, acknowledgementPath);
  let sequence = 0;
  let closed = false;
  let busy = false;
  let lastAcknowledgement = 0n;

  return Object.freeze({
    async exchange(kind: DataWranglerStudyBridgeKind): Promise<DataWranglerStudyBridgeExchange> {
      if (closed) fail("closed", "Study bridge controller is closed.");
      if (busy) fail("busy", "Study bridge controller already has a request in flight.");
      validateKind(kind);
      validateSequence(sequence);
      assertNoStaleEntries(requestPath, acknowledgementPath);
      busy = true;
      try {
        const clockValue = clock();
        if (typeof clockValue !== "bigint" || clockValue <= lastAcknowledgement) {
          fail("clock-regression", "Study bridge request clock did not advance beyond the previous acknowledgement.");
        }
        const request: DataWranglerStudyBridgeEnvelope = Object.freeze({
          protocol: DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL,
          ...correlation,
          sequence,
          kind,
          monotonicNanoseconds: validateClockText(clockValue.toString())
        });
        const publication = publishEnvelope(requestPath, request);
        const startedAt = now();
        while (true) {
          const elapsedBeforeRead = now() - startedAt;
          if (!Number.isFinite(elapsedBeforeRead) || elapsedBeforeRead < 0 || elapsedBeforeRead >= timeoutMs) {
            fail("timeout", `Study bridge acknowledgement did not arrive within ${timeoutMs} ms.`);
          }
          const acknowledgementEntry = readEntry(acknowledgementPath, DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL, {
            optional: true
          });
          const elapsedAfterRead = now() - startedAt;
          if (!Number.isFinite(elapsedAfterRead) || elapsedAfterRead < 0 || elapsedAfterRead >= timeoutMs) {
            fail("timeout", `Study bridge acknowledgement did not arrive within ${timeoutMs} ms.`);
          }
          if (acknowledgementEntry !== null) {
            const acknowledgement = acknowledgementEntry.envelope;
            if (
              acknowledgement.runId !== request.runId ||
              acknowledgement.phase !== request.phase ||
              acknowledgement.sequence !== request.sequence ||
              acknowledgement.kind !== request.kind
            ) {
              fail("stale-envelope", "Study bridge acknowledgement is stale or belongs to another trial.");
            }
            const acknowledgementTime = BigInt(acknowledgement.monotonicNanoseconds);
            if (acknowledgementTime < clockValue) {
              fail("clock-regression", "Study bridge acknowledgement predates its request.");
            }
            const consumedAcknowledgement = readEntry(acknowledgementPath, DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL, {
              consume: true
            });
            if (
              consumedAcknowledgement === null ||
              canonicalJson(consumedAcknowledgement.envelope) !== canonicalJson(acknowledgement) ||
              !sameSnapshot(consumedAcknowledgement.metadata, acknowledgementEntry.metadata)
            ) {
              fail("entry-changed", "Study bridge acknowledgement changed before consumption.");
            }
            const consumedRequest = readEntry(requestPath, DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL, {
              consume: true
            });
            if (
              consumedRequest === null ||
              canonicalJson(consumedRequest.envelope) !== canonicalJson(request) ||
              consumedRequest.metadata.dev !== publication.device ||
              consumedRequest.metadata.ino !== publication.inode
            ) {
              fail("entry-changed", "Study bridge request changed before consumption.");
            }
            lastAcknowledgement = acknowledgementTime;
            sequence += 1;
            return Object.freeze({ request, acknowledgement });
          }
          await wait(Math.min(pollIntervalMs, Math.max(1, timeoutMs - elapsedAfterRead)));
        }
      } finally {
        busy = false;
      }
    },
    nextSequence(): number {
      return sequence;
    },
    close(): void {
      if (busy) fail("busy", "Study bridge controller cannot close with a request in flight.");
      if (!closed) assertNoStaleEntries(requestPath, acknowledgementPath);
      closed = true;
    }
  });
}

export function createDataWranglerStudyControlBridgeFromEnvironment(
  options?: DataWranglerStudyControlBridgeOptions
): DataWranglerStudyControlBridge {
  const requireEnvironment = (key: string): string => {
    const value = process.env[key];
    if (!value) fail("missing-environment", `Study control bridge requires ${key}.`);
    return value;
  };
  return createDataWranglerStudyControlBridge(
    {
      requestPath: requireEnvironment("OPEN_WRANGLER_STUDY_REQUEST"),
      acknowledgementPath: requireEnvironment("OPEN_WRANGLER_STUDY_ACK"),
      runId: requireEnvironment("OPEN_WRANGLER_TEST_RUN_ID"),
      phase: requireEnvironment("OPEN_WRANGLER_TEST_PHASE")
    },
    options
  );
}
