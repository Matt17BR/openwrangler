import { performance } from "node:perf_hooks";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonicalDurableJson, publishDurableStudyJsonExclusive } from "./durable-study-json.mjs";

export const DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL = "openwrangler-data-wrangler-study-bridge-request-v1";
export const DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL = "openwrangler-data-wrangler-study-bridge-ack-v1";
export const DATA_WRANGLER_STUDY_BRIDGE_ABANDONMENT_PROTOCOL = "openwrangler-data-wrangler-study-bridge-abandonment-v1";
export const DATA_WRANGLER_STUDY_BRIDGE_ENVIRONMENT = Object.freeze({
  request: "OPEN_WRANGLER_STUDY_REQUEST",
  acknowledgement: "OPEN_WRANGLER_STUDY_ACK",
  source: "OPEN_WRANGLER_STUDY_SOURCE"
});
export const DATA_WRANGLER_STUDY_BRIDGE_KINDS = Object.freeze([
  "source-verified",
  "cold-cache-evicted",
  "measurement-ready",
  "sampling-origin",
  "inline-baseline",
  "workbench-baseline",
  "profile-baseline",
  "sampling-stop",
  "cleanup-census"
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PHASE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const MONOTONIC_NANOSECONDS = /^[1-9]\d{0,29}$/u;
const MAXIMUM_SEQUENCE = 4_096;
const MAXIMUM_ENVELOPE_BYTES = 2_048;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 10;

export class DataWranglerStudyBridgeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DataWranglerStudyBridgeError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new DataWranglerStudyBridgeError(code, message, options);
}

function abortError() {
  return new DataWranglerStudyBridgeError("aborted", "Study bridge request wait was aborted.");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail("malformed-envelope", `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("malformed-envelope", `${label} has missing or unknown fields.`);
  }
}

function validateCorrelation({ runId, phase }) {
  if (typeof runId !== "string" || !UUID.test(runId)) {
    fail("invalid-correlation", "Study bridge run ID must be a version-4 UUID.");
  }
  if (typeof phase !== "string" || !PHASE.test(phase)) {
    fail("invalid-correlation", "Study bridge phase is malformed or exceeds its bound.");
  }
  return Object.freeze({ runId, phase });
}

function validateSequence(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAXIMUM_SEQUENCE) {
    fail("invalid-sequence", "Study bridge sequence is outside its fixed range.");
  }
  return sequence;
}

function validateKind(kind) {
  if (!DATA_WRANGLER_STUDY_BRIDGE_KINDS.includes(kind)) {
    fail("invalid-kind", "Study bridge message kind is not part of the fixed handshake protocol.");
  }
  return kind;
}

function validateMonotonicNanoseconds(value) {
  if (typeof value !== "string" || !MONOTONIC_NANOSECONDS.test(value)) {
    fail("invalid-clock", "Study bridge monotonic timestamp is malformed or exceeds its bound.");
  }
  return value;
}

function validateOptionalAbortSignal(signal) {
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    fail("invalid-dependency", "Study bridge request wait requires an AbortSignal when one is provided.");
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function waitForPollOrAbort(waitResult, signal) {
  throwIfAborted(signal);
  if (signal === undefined) {
    await waitResult;
    return;
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    try {
      await Promise.race([waitResult, aborted]);
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  throwIfAborted(signal);
}

function createEnvelope(protocol, { runId, phase, sequence, kind, monotonicNanoseconds }) {
  validateCorrelation({ runId, phase });
  validateSequence(sequence);
  validateKind(kind);
  validateMonotonicNanoseconds(monotonicNanoseconds);
  return Object.freeze({ protocol, runId, phase, sequence, kind, monotonicNanoseconds });
}

export function createDataWranglerStudyBridgeRequest(input) {
  return createEnvelope(DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL, input);
}

export function createDataWranglerStudyBridgeAcknowledgement(input) {
  return createEnvelope(DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL, input);
}

function validateEnvelope(value, protocol, label) {
  exactKeys(value, ["protocol", "runId", "phase", "sequence", "kind", "monotonicNanoseconds"], label);
  if (value.protocol !== protocol) {
    fail("stale-envelope", `${label} uses the wrong protocol version.`);
  }
  return createEnvelope(protocol, value);
}

export function validateDataWranglerStudyBridgeRequest(value) {
  return validateEnvelope(value, DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL, "Study bridge request");
}

export function validateDataWranglerStudyBridgeAcknowledgement(value) {
  return validateEnvelope(value, DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL, "Study bridge acknowledgement");
}

function assertTimeouts(timeoutMs, pollIntervalMs) {
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
}

function currentUserOwns(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function assertPrivateDirectory(metadata, label) {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o700n
  ) {
    fail("invalid-path", `${label} must be an owned mode-0700 directory.`);
  }
}

function assertPrivateFile(metadata, label) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o600n ||
    metadata.size < 1n ||
    metadata.size > BigInt(MAXIMUM_ENVELOPE_BYTES)
  ) {
    fail("invalid-entry", `${label} must be one private bounded regular file.`);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

function assertBridgePath(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/u.test(path)) {
    fail("invalid-path", `${label} must be an absolute path.`);
  }
  const normalized = resolve(path);
  const name = basename(normalized);
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    Buffer.byteLength(name, "utf8") > 180 ||
    /[/\\]/u.test(name)
  ) {
    fail("invalid-path", `${label} has an invalid file name.`);
  }
  return normalized;
}

function validateBridgePaths(requestPath, acknowledgementPath) {
  const request = assertBridgePath(requestPath, "Study bridge request path");
  const acknowledgement = assertBridgePath(acknowledgementPath, "Study bridge acknowledgement path");
  if (request === acknowledgement || dirname(request) !== dirname(acknowledgement)) {
    fail("invalid-path", "Study bridge request and acknowledgement must be distinct siblings.");
  }
  return Object.freeze({ request, acknowledgement });
}

function openParent(path) {
  const parentPath = dirname(path);
  let descriptor;
  try {
    const named = lstatSync(parentPath, { bigint: true });
    assertPrivateDirectory(named, "Study bridge parent");
    descriptor = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    assertPrivateDirectory(opened, "Opened study bridge parent");
    if (!sameIdentity(named, opened)) fail("parent-rebound", "Study bridge parent changed while it opened.");
    return { descriptor, identity: opened, parentPath };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original validation failure remains authoritative.
      }
    }
    if (error instanceof DataWranglerStudyBridgeError) throw error;
    fail("filesystem", "Study bridge parent could not be opened safely.", { cause: error });
  }
}

function anchoredPath(parentDescriptor, path) {
  return `/proc/self/fd/${parentDescriptor}/${basename(path)}`;
}

function verifyNamedParent(parent) {
  const opened = fstatSync(parent.descriptor, { bigint: true });
  const named = lstatSync(parent.parentPath, { bigint: true });
  assertPrivateDirectory(opened, "Opened study bridge parent");
  assertPrivateDirectory(named, "Named study bridge parent");
  if (!sameIdentity(opened, parent.identity) || !sameIdentity(named, parent.identity)) {
    fail("parent-rebound", "Study bridge parent changed before the file operation settled.");
  }
}

function readEntry(path, validate, { optional = false, consume = false } = {}) {
  const parent = openParent(path);
  let descriptor;
  let operationError;
  let result;
  try {
    const anchored = anchoredPath(parent.descriptor, path);
    let named;
    let absent = false;
    try {
      named = lstatSync(anchored, { bigint: true });
    } catch (error) {
      if (optional && error?.code === "ENOENT") {
        absent = true;
      } else {
        throw error;
      }
    }
    if (absent) {
      verifyNamedParent(parent);
      result = null;
    } else {
      assertPrivateFile(named, "Study bridge entry");
      descriptor = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor, { bigint: true });
      assertPrivateFile(opened, "Opened study bridge entry");
      if (!sameFileSnapshot(named, opened)) fail("entry-changed", "Study bridge entry changed while it opened.");
      const text = readFileSync(descriptor, "utf8");
      const after = fstatSync(descriptor, { bigint: true });
      const entry = lstatSync(anchored, { bigint: true });
      if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(after, entry)) {
        fail("entry-changed", "Study bridge entry changed while it was read.");
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        fail("malformed-envelope", "Study bridge entry is not valid JSON.", { cause: error });
      }
      if (canonicalDurableJson(parsed) !== text) {
        fail("malformed-envelope", "Study bridge entry is not canonical JSON.");
      }
      const envelope = validate(parsed);
      if (consume) {
        verifyNamedParent(parent);
        const beforeUnlink = lstatSync(anchored, { bigint: true });
        if (!sameFileSnapshot(after, beforeUnlink)) {
          fail("entry-changed", "Study bridge entry changed before it could be consumed.");
        }
        unlinkSync(anchored);
        fsyncSync(parent.descriptor);
        try {
          lstatSync(anchored);
          fail("entry-changed", "Study bridge entry remained after it was consumed.");
        } catch (error) {
          if (error instanceof DataWranglerStudyBridgeError) throw error;
          if (error?.code !== "ENOENT") throw error;
        }
        verifyNamedParent(parent);
      } else {
        verifyNamedParent(parent);
      }
      result = Object.freeze({ envelope, metadata: after });
    }
  } catch (error) {
    operationError =
      error instanceof DataWranglerStudyBridgeError
        ? error
        : new DataWranglerStudyBridgeError("filesystem", "Study bridge entry could not be read safely.", {
            cause: error
          });
  }
  const closeErrors = [];
  for (const value of [descriptor, parent.descriptor]) {
    if (value === undefined) continue;
    try {
      closeSync(value);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (operationError !== undefined || closeErrors.length > 0) {
    if (operationError !== undefined && closeErrors.length === 0) throw operationError;
    throw new AggregateError(
      [operationError, ...closeErrors].filter(Boolean),
      "Study bridge entry validation did not close cleanly."
    );
  }
  return result;
}

function entryExists(path) {
  const parent = openParent(path);
  try {
    try {
      lstatSync(anchoredPath(parent.descriptor, path));
      verifyNamedParent(parent);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      verifyNamedParent(parent);
      return false;
    }
  } finally {
    closeSync(parent.descriptor);
  }
}

function publishEnvelope(path, envelope, publicationOptions) {
  return publishDurableStudyJsonExclusive(path, envelope, {
    maximumBytes: MAXIMUM_ENVELOPE_BYTES,
    ...publicationOptions
  });
}

function readRequest(path, options) {
  return readEntry(path, validateDataWranglerStudyBridgeRequest, options);
}

function readAcknowledgement(path, options) {
  return readEntry(path, validateDataWranglerStudyBridgeAcknowledgement, options);
}

function assertExpectedEnvelope(envelope, expected, label) {
  if (
    envelope.runId !== expected.runId ||
    envelope.phase !== expected.phase ||
    envelope.sequence !== expected.sequence ||
    envelope.kind !== expected.kind
  ) {
    fail("stale-envelope", `${label} is stale, out of order, or belongs to another trial.`);
  }
}

function assertSameEnvelope(left, right, label) {
  if (canonicalDurableJson(left) !== canonicalDurableJson(right)) {
    fail("entry-changed", `${label} changed between validation and consumption.`);
  }
}

function assertSameMetadata(left, right, label) {
  if (!sameFileSnapshot(left, right)) {
    fail("entry-changed", `${label} changed identity after it was first read.`);
  }
}

function assertPublicationIdentity(publication, metadata, label) {
  if (
    publication?.identity?.device !== metadata.dev.toString() ||
    publication?.identity?.inode !== metadata.ino.toString()
  ) {
    fail("entry-changed", `${label} no longer has its publication identity.`);
  }
}

function clockText(clock) {
  let value;
  try {
    value = clock();
  } catch (error) {
    fail("clock", "Study bridge monotonic clock failed.", { cause: error });
  }
  if (typeof value !== "bigint" || value <= 0n) {
    fail("clock", "Study bridge monotonic clock must return a positive bigint.");
  }
  return validateMonotonicNanoseconds(value.toString());
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function elapsedBeforeDeadline(now, startedAt, timeoutMs, message) {
  const elapsed = now() - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeoutMs) {
    fail("timeout", message);
  }
  return elapsed;
}

function assertOpenPaths(paths) {
  if (entryExists(paths.request) || entryExists(paths.acknowledgement)) {
    fail("stale-entry", "Study bridge paths contain an unconsumed request or acknowledgement.");
  }
}

export function createDataWranglerStudyBridgeController(
  { requestPath, acknowledgementPath, runId, phase },
  {
    clock = process.hrtime.bigint,
    now = () => performance.now(),
    wait = delay,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    requestPublicationOptions
  } = {}
) {
  const paths = validateBridgePaths(requestPath, acknowledgementPath);
  const correlation = validateCorrelation({ runId, phase });
  assertTimeouts(timeoutMs, pollIntervalMs);
  if (typeof clock !== "function" || typeof now !== "function" || typeof wait !== "function") {
    fail("invalid-dependency", "Study bridge controller requires callable clock and wait functions.");
  }
  assertOpenPaths(paths);
  let sequence = 0;
  let busy = false;
  let closed = false;

  return Object.freeze({
    async exchange(kind) {
      if (closed) fail("closed", "Study bridge controller is closed.");
      if (busy) fail("busy", "Study bridge controller already has a request in flight.");
      validateKind(kind);
      validateSequence(sequence);
      assertOpenPaths(paths);
      busy = true;
      const request = createDataWranglerStudyBridgeRequest({
        ...correlation,
        sequence,
        kind,
        monotonicNanoseconds: clockText(clock)
      });
      try {
        const requestPublication = publishEnvelope(paths.request, request, requestPublicationOptions);
        const startedAt = now();
        while (true) {
          elapsedBeforeDeadline(
            now,
            startedAt,
            timeoutMs,
            `Study bridge acknowledgement did not arrive within ${timeoutMs} ms.`
          );
          const acknowledgement = readAcknowledgement(paths.acknowledgement, { optional: true });
          if (acknowledgement !== null) {
            elapsedBeforeDeadline(
              now,
              startedAt,
              timeoutMs,
              `Study bridge acknowledgement did not arrive within ${timeoutMs} ms.`
            );
            assertExpectedEnvelope(acknowledgement.envelope, request, "Study bridge acknowledgement");
            if (BigInt(acknowledgement.envelope.monotonicNanoseconds) < BigInt(request.monotonicNanoseconds)) {
              fail("clock-regression", "Study bridge acknowledgement predates its request.");
            }
            const consumedAcknowledgement = readAcknowledgement(paths.acknowledgement, { consume: true });
            assertExpectedEnvelope(consumedAcknowledgement.envelope, request, "Study bridge acknowledgement");
            assertSameEnvelope(
              consumedAcknowledgement.envelope,
              acknowledgement.envelope,
              "Study bridge acknowledgement"
            );
            assertSameMetadata(
              consumedAcknowledgement.metadata,
              acknowledgement.metadata,
              "Study bridge acknowledgement"
            );
            const consumedRequest = readRequest(paths.request, { consume: true });
            assertExpectedEnvelope(consumedRequest.envelope, request, "Study bridge request");
            assertSameEnvelope(consumedRequest.envelope, request, "Study bridge request");
            assertPublicationIdentity(requestPublication, consumedRequest.metadata, "Study bridge request");
            sequence += 1;
            return Object.freeze({ request, acknowledgement: acknowledgement.envelope });
          }
          const elapsed = elapsedBeforeDeadline(
            now,
            startedAt,
            timeoutMs,
            `Study bridge acknowledgement did not arrive within ${timeoutMs} ms.`
          );
          const waitResult = wait(Math.min(pollIntervalMs, Math.max(1, timeoutMs - elapsed)));
          if (!waitResult || typeof waitResult.then !== "function") {
            fail("invalid-dependency", "Study bridge wait function must return a promise.");
          }
          await waitResult;
        }
      } finally {
        busy = false;
      }
    },
    nextSequence() {
      return sequence;
    },
    close() {
      if (busy) fail("busy", "Study bridge controller cannot close with a request in flight.");
      if (!closed) assertOpenPaths(paths);
      closed = true;
    }
  });
}

export function createDataWranglerStudyBridgeResponder(
  { requestPath, acknowledgementPath, runId, phase },
  {
    clock = process.hrtime.bigint,
    now = () => performance.now(),
    wait = delay,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    acknowledgementPublicationOptions
  } = {}
) {
  const paths = validateBridgePaths(requestPath, acknowledgementPath);
  const correlation = validateCorrelation({ runId, phase });
  assertTimeouts(timeoutMs, pollIntervalMs);
  if (typeof clock !== "function" || typeof now !== "function" || typeof wait !== "function") {
    fail("invalid-dependency", "Study bridge responder requires callable clock and wait functions.");
  }
  let lastAcknowledged;
  const acceptedRequests = new WeakMap();

  return Object.freeze({
    async waitForRequest(expectedSequence, expectedKind, signal) {
      validateSequence(expectedSequence);
      validateKind(expectedKind);
      validateOptionalAbortSignal(signal);
      throwIfAborted(signal);
      const startedAt = now();
      while (true) {
        throwIfAborted(signal);
        elapsedBeforeDeadline(now, startedAt, timeoutMs, `Study bridge request did not arrive within ${timeoutMs} ms.`);
        const candidate = readRequest(paths.request, { optional: true });
        if (candidate !== null) {
          elapsedBeforeDeadline(
            now,
            startedAt,
            timeoutMs,
            `Study bridge request did not arrive within ${timeoutMs} ms.`
          );
          const request = candidate.envelope;
          if (
            lastAcknowledged !== undefined &&
            request.sequence === lastAcknowledged.sequence &&
            canonicalDurableJson(request) === canonicalDurableJson(lastAcknowledged)
          ) {
            // The controller consumes the acknowledged request. Until then it
            // is the same known message, not a second request.
          } else {
            assertExpectedEnvelope(
              request,
              { ...correlation, sequence: expectedSequence, kind: expectedKind },
              "Study bridge request"
            );
            acceptedRequests.set(request, candidate.metadata);
            return request;
          }
        }
        const elapsed = elapsedBeforeDeadline(
          now,
          startedAt,
          timeoutMs,
          `Study bridge request did not arrive within ${timeoutMs} ms.`
        );
        const waitResult = wait(Math.min(pollIntervalMs, Math.max(1, timeoutMs - elapsed)));
        if (!waitResult || typeof waitResult.then !== "function") {
          fail("invalid-dependency", "Study bridge wait function must return a promise.");
        }
        throwIfAborted(signal);
        await waitForPollOrAbort(waitResult, signal);
        throwIfAborted(signal);
      }
    },
    acknowledge(request) {
      const acceptedMetadata = acceptedRequests.get(request);
      if (acceptedMetadata === undefined) {
        fail("inauthentic-request", "Study bridge responder can acknowledge only a request it read itself.");
      }
      if (request.runId !== correlation.runId || request.phase !== correlation.phase) {
        fail("stale-envelope", "Study bridge request belongs to another trial.");
      }
      if (entryExists(paths.acknowledgement)) {
        fail("stale-entry", "Study bridge acknowledgement path is already occupied.");
      }
      const currentRequest = readRequest(paths.request);
      assertSameEnvelope(currentRequest.envelope, request, "Study bridge request");
      assertSameMetadata(currentRequest.metadata, acceptedMetadata, "Study bridge request");
      const acknowledgement = createDataWranglerStudyBridgeAcknowledgement({
        ...correlation,
        sequence: request.sequence,
        kind: request.kind,
        monotonicNanoseconds: clockText(clock)
      });
      if (BigInt(acknowledgement.monotonicNanoseconds) < BigInt(request.monotonicNanoseconds)) {
        fail("clock-regression", "Study bridge acknowledgement predates its request.");
      }
      publishEnvelope(paths.acknowledgement, acknowledgement, acknowledgementPublicationOptions);
      acceptedRequests.delete(request);
      lastAcknowledged = request;
      return acknowledgement;
    },
    abandon(request) {
      const acceptedMetadata = acceptedRequests.get(request);
      if (acceptedMetadata === undefined) {
        fail("inauthentic-request", "Study bridge responder can abandon only a request it read itself.");
      }
      if (request.runId !== correlation.runId || request.phase !== correlation.phase) {
        fail("stale-envelope", "Study bridge request belongs to another trial.");
      }
      if (entryExists(paths.acknowledgement)) {
        fail("stale-entry", "Study bridge acknowledgement path is already occupied.");
      }
      const currentRequest = readRequest(paths.request);
      assertSameEnvelope(currentRequest.envelope, request, "Study bridge request");
      assertSameMetadata(currentRequest.metadata, acceptedMetadata, "Study bridge request");
      const abandonedMonotonicNanoseconds = clockText(clock);
      if (BigInt(abandonedMonotonicNanoseconds) < BigInt(request.monotonicNanoseconds)) {
        fail("clock-regression", "Study bridge abandonment predates its request.");
      }
      if (entryExists(paths.acknowledgement)) {
        fail("stale-entry", "Study bridge acknowledgement path is already occupied.");
      }
      const consumedRequest = readRequest(paths.request, { consume: true });
      assertSameEnvelope(consumedRequest.envelope, request, "Study bridge request");
      assertSameMetadata(consumedRequest.metadata, acceptedMetadata, "Study bridge request");
      assertOpenPaths(paths);
      acceptedRequests.delete(request);
      return Object.freeze({
        protocol: DATA_WRANGLER_STUDY_BRIDGE_ABANDONMENT_PROTOCOL,
        runId: request.runId,
        phase: request.phase,
        sequence: request.sequence,
        kind: request.kind,
        requestMonotonicNanoseconds: request.monotonicNanoseconds,
        abandonedMonotonicNanoseconds
      });
    }
  });
}

export function createDataWranglerStudyBridgeEnvironment({ requestPath, acknowledgementPath, sourcePath }) {
  const paths = validateBridgePaths(requestPath, acknowledgementPath);
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath) || /[\0\r\n]/u.test(sourcePath)) {
    fail("invalid-path", "Study bridge source path must be absolute.");
  }
  return Object.freeze({
    [DATA_WRANGLER_STUDY_BRIDGE_ENVIRONMENT.request]: paths.request,
    [DATA_WRANGLER_STUDY_BRIDGE_ENVIRONMENT.acknowledgement]: paths.acknowledgement,
    [DATA_WRANGLER_STUDY_BRIDGE_ENVIRONMENT.source]: resolve(sourcePath)
  });
}
