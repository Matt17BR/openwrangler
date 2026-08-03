#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoIndeterminateDataWranglerStudyAction,
  authorizeDataWranglerStudyTrialAction,
  buildDataWranglerStudyManifest,
  buildDataWranglerStudyResult,
  captureDataWranglerStudyMethodReceipt,
  canonicalStudyJson,
  createOrLoadDataWranglerStudyFinalizationIntent,
  digestStudyValue,
  inspectDataWranglerStudyTrialIntents,
  loadDataWranglerStudyFragments,
  pendingDataWranglerStudyTrials,
  prepareDataWranglerStudyTrialIntent,
  publishDataWranglerStudyFragment,
  readDataWranglerStudyManifestPublication,
  validateDataWranglerStudyFragment,
  validateDataWranglerStudyResultEvidence,
  writeDataWranglerStudyJsonExclusive,
  DATA_WRANGLER_STUDY_TRIAL_INTENT_PROTOCOL
} from "./data-wrangler-comparison-study.mjs";
import { recoverDurableStudyJsonPublication } from "./durable-study-json.mjs";
import { captureDataWranglerComparisonStudyV2Toolchain } from "./data-wrangler-comparison-cache-controller.mjs";
import { loadDataWranglerComparisonPreparationReceipt } from "./data-wrangler-comparison-preparation.mjs";
import {
  assertCurrentDataWranglerComparisonPreregistration,
  createDataWranglerComparisonPreregistrationReceipt,
  readDataWranglerComparisonPreregistration
} from "./data-wrangler-comparison-preregistration.mjs";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_EXECUTION_LOCK_BYTES = 4 * 1024;
const EXECUTION_LOCK_SUFFIX = ".run-next.lock";
const EXECUTION_LOCK_SOCKET_PREFIX = "openwrangler-study-run-next-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NON_NEGATIVE_INTEGER_TEXT = /^(?:0|[1-9]\d*)$/u;

export const DATA_WRANGLER_STUDY_EXECUTION_LOCK_PROTOCOL = "openwrangler-data-wrangler-study-execution-lock-v1";

function usage() {
  return [
    "Usage:",
    "  node scripts/run-data-wrangler-comparison-study.mjs plan --spec <spec.json> --out <manifest.json> --preregistration <preregistration.json> --preparation <preparation.json> --cache-controller <source_cache_control.py> --python <python>",
    "  node scripts/run-data-wrangler-comparison-study.mjs run-next --manifest <manifest.json> --fragments <dir> --intents <dir> --preparation <preparation.json>",
    "  node scripts/run-data-wrangler-comparison-study.mjs record --manifest <manifest.json> --fragments <dir> --fragment <fragment.json>",
    "  node scripts/run-data-wrangler-comparison-study.mjs status --manifest <manifest.json> --fragments <dir>",
    "  node scripts/run-data-wrangler-comparison-study.mjs finalize --manifest <manifest.json> --fragments <dir> --out <result.json>"
  ].join("\n");
}

function parseArguments(argv, cwd = process.cwd()) {
  const [command, ...rest] = argv;
  if (!["plan", "run-next", "record", "status", "finalize"].includes(command)) {
    throw new TypeError(usage());
  }
  const allowed = {
    plan: new Set(["--spec", "--out", "--preregistration", "--preparation", "--cache-controller", "--python"]),
    "run-next": new Set(["--manifest", "--fragments", "--intents", "--preparation"]),
    record: new Set(["--manifest", "--fragments", "--fragment"]),
    status: new Set(["--manifest", "--fragments"]),
    finalize: new Set(["--manifest", "--fragments", "--out"])
  }[command];
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) {
      throw new TypeError(`Unknown or incomplete study argument ${flag ?? "<missing>"}.\n${usage()}`);
    }
    const key = flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (options[key] !== undefined) {
      throw new TypeError(`Study argument ${flag} may appear only once.`);
    }
    options[key] = resolve(cwd, value);
  }
  for (const flag of allowed) {
    const key = flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (options[key] === undefined) {
      throw new TypeError(`Study command ${command} requires ${flag}.`);
    }
  }
  return options;
}

function sameInputIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameInputMetadata(left, right) {
  return (
    sameInputIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function assertBoundedJsonInput(metadata, label) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(MAX_INPUT_BYTES)
  ) {
    throw new TypeError(`${label} must be one bounded, singly linked regular JSON file.`);
  }
}

function readExactBoundedDescriptor(descriptor, expectedSize, label) {
  const expectedBytes = Number(expectedSize);
  const bytes = Buffer.alloc(expectedBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (count === 0) {
      break;
    }
    offset += count;
  }
  if (offset !== expectedBytes) {
    throw new TypeError(`${label} changed size while it was read.`);
  }
  return bytes.subarray(0, offset).toString("utf8");
}

function readBoundedJson(path, label, { faultInjector } = {}) {
  let descriptor;
  let operationError;
  let text;
  try {
    const before = lstatSync(path, { bigint: true });
    assertBoundedJsonInput(before, label);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    assertBoundedJsonInput(opened, label);
    if (!sameInputMetadata(before, opened)) {
      throw new TypeError(`${label} changed while it opened.`);
    }
    if (faultInjector !== undefined) {
      if (typeof faultInjector !== "function") {
        throw new TypeError("Study input fault injector must be a function.");
      }
      faultInjector("file-opened", label);
    }
    text = readExactBoundedDescriptor(descriptor, opened.size, label);
    const after = fstatSync(descriptor, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    assertBoundedJsonInput(after, label);
    assertBoundedJsonInput(entry, label);
    if (!sameInputMetadata(opened, after) || !sameInputMetadata(after, entry)) {
      throw new TypeError(`${label} changed while it was read.`);
    }
  } catch (error) {
    operationError =
      error instanceof TypeError ? error : new TypeError(`${label} could not be opened and read safely as JSON.`);
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined || closeError !== undefined) {
    if (operationError !== undefined && closeError === undefined) {
      throw operationError;
    }
    if (operationError === undefined) {
      throw closeError;
    }
    throw new AggregateError([operationError, closeError], `${label} failed and its descriptor did not close cleanly.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`${label} is not valid JSON.`);
  }
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLockMetadata(left, right) {
  return (
    sameFilesystemIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function currentUserOwns(metadata) {
  return typeof process.getuid === "function" && metadata.uid === BigInt(process.getuid());
}

function assertPrivateLockParent(metadata) {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o700n
  ) {
    throw new TypeError("Study execution-lock parent must be one owned mode-0700 directory.");
  }
}

function assertPrivateLockFile(metadata) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o600n ||
    metadata.nlink !== 1n ||
    metadata.size < 1n ||
    metadata.size > BigInt(MAX_EXECUTION_LOCK_BYTES)
  ) {
    throw new TypeError("Study execution lock is not one private, bounded, singly linked regular file.");
  }
}

function openPrivateLockParent(path) {
  const parentPath = resolve(path);
  const before = lstatSync(parentPath, { bigint: true });
  assertPrivateLockParent(before);
  const descriptor = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertPrivateLockParent(opened);
    if (!sameFilesystemIdentity(before, opened)) {
      throw new TypeError("Study execution-lock parent changed while it opened.");
    }
    return { descriptor, identity: opened, path: parentPath };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyPrivateLockParent(lease) {
  const opened = fstatSync(lease.descriptor, { bigint: true });
  const named = lstatSync(lease.path, { bigint: true });
  assertPrivateLockParent(opened);
  assertPrivateLockParent(named);
  if (!sameFilesystemIdentity(opened, lease.identity) || !sameFilesystemIdentity(named, lease.identity)) {
    throw new TypeError("Study execution-lock parent identity changed while the lock was held.");
  }
}

function anchoredLockPath(parentDescriptor, name) {
  return `/proc/self/fd/${parentDescriptor}/${name}`;
}

function readExactLockDescriptor(descriptor, size) {
  const expectedBytes = Number(size);
  const bytes = Buffer.alloc(expectedBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== expectedBytes) {
    throw new TypeError("Study execution lock changed size while it was read.");
  }
  return bytes.subarray(0, offset).toString("utf8");
}

function exactObjectKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function validateExecutionLockRecord(record) {
  if (
    !exactObjectKeys(record, ["protocol", "pid", "startTimeTicks", "bootId", "token", "acquiredAtUtc"]) ||
    record.protocol !== DATA_WRANGLER_STUDY_EXECUTION_LOCK_PROTOCOL ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    !NON_NEGATIVE_INTEGER_TEXT.test(record.startTimeTicks ?? "") ||
    !UUID.test(record.bootId ?? "") ||
    !UUID.test(record.token ?? "") ||
    typeof record.acquiredAtUtc !== "string" ||
    !record.acquiredAtUtc.endsWith("Z") ||
    !Number.isFinite(Date.parse(record.acquiredAtUtc))
  ) {
    throw new TypeError("Study execution lock owner record is malformed; ownership is ambiguous.");
  }
  return record;
}

function readExecutionLockRecord(parentLease, name) {
  const path = anchoredLockPath(parentLease.descriptor, name);
  const before = lstatSync(path, { bigint: true });
  assertPrivateLockFile(before);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertPrivateLockFile(opened);
    if (!sameLockMetadata(before, opened)) {
      throw new TypeError("Study execution lock changed while it opened; ownership is ambiguous.");
    }
    const text = readExactLockDescriptor(descriptor, opened.size);
    const after = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!sameLockMetadata(opened, after) || !sameLockMetadata(after, named)) {
      throw new TypeError("Study execution lock changed while it was read; ownership is ambiguous.");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TypeError("Study execution lock owner record is not valid JSON; ownership is ambiguous.");
    }
    return { record: validateExecutionLockRecord(parsed), identity: opened };
  } finally {
    closeSync(descriptor);
  }
}

function readLinuxBootId() {
  const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!UUID.test(value)) {
    throw new TypeError("Linux boot identity is unavailable or malformed.");
  }
  return value.toLowerCase();
}

function parseLinuxProcessIdentity(text, pid) {
  if (typeof text !== "string" || text.length === 0 || text.length > 16 * 1024) {
    throw new TypeError(`Linux process identity for PID ${pid} is missing or too large.`);
  }
  const closingParenthesis = text.lastIndexOf(")");
  if (!text.startsWith(`${pid} (`) || closingParenthesis <= 0) {
    throw new TypeError(`Linux process identity for PID ${pid} is malformed.`);
  }
  const fields = text
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const startTimeTicks = fields[19];
  if (!/^\S$/u.test(state ?? "") || !NON_NEGATIVE_INTEGER_TEXT.test(startTimeTicks ?? "")) {
    throw new TypeError(`Linux process identity for PID ${pid} is malformed.`);
  }
  return { state, startTimeTicks };
}

function readLinuxProcessIdentity(pid) {
  try {
    return parseLinuxProcessIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}

function executionLockSocketAddress(scope) {
  const digest = createHash("sha256").update(scope).digest("hex");
  return `\0${EXECUTION_LOCK_SOCKET_PREFIX}${digest}`;
}

async function acquireExecutionSocket(scope, createSocketServer = createServer) {
  const server = createSocketServer();
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      if (error?.code === "EADDRINUSE") {
        rejectListen(new Error("Another run-next study execution already owns the Linux execution lock."));
      } else {
        rejectListen(error);
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(executionLockSocketAddress(scope));
  });
  return server;
}

async function closeExecutionSocket(server) {
  if (server === undefined) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function classifyExecutionLockOwner(record, currentBootId, processIdentityReader) {
  if (record.bootId.toLowerCase() !== currentBootId.toLowerCase()) {
    return "dead";
  }
  let observed;
  try {
    observed = processIdentityReader(record.pid);
  } catch (error) {
    throw new TypeError("Study execution lock owner cannot be inspected unambiguously.", { cause: error });
  }
  if (observed === null || observed.startTimeTicks !== record.startTimeTicks) {
    return "dead";
  }
  if (["X", "x", "Z"].includes(observed.state)) {
    return "dead";
  }
  return "live";
}

function removeProvenDeadExecutionLock(parentLease, name, inspected) {
  const path = anchoredLockPath(parentLease.descriptor, name);
  const named = lstatSync(path, { bigint: true });
  if (!sameLockMetadata(named, inspected.identity)) {
    throw new TypeError("Study execution lock changed before stale recovery; ownership is ambiguous.");
  }
  unlinkSync(path);
  fsyncSync(parentLease.descriptor);
}

function createExecutionLockFile(parentLease, name, record) {
  validateExecutionLockRecord(record);
  const path = anchoredLockPath(parentLease.descriptor, name);
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, canonicalStudyJson(record), { encoding: "utf8" });
    fsyncSync(descriptor);
    const identity = fstatSync(descriptor, { bigint: true });
    assertPrivateLockFile(identity);
    fsyncSync(parentLease.descriptor);
    return { descriptor, identity };
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the original failure; the named lock remains fail-closed.
    }
    throw error;
  }
}

function releaseExecutionLockFile(parentLease, name, held) {
  const path = anchoredLockPath(parentLease.descriptor, name);
  const opened = fstatSync(held.descriptor, { bigint: true });
  const named = lstatSync(path, { bigint: true });
  assertPrivateLockFile(opened);
  assertPrivateLockFile(named);
  if (!sameLockMetadata(opened, held.identity) || !sameLockMetadata(named, held.identity)) {
    throw new TypeError("Study execution lock identity changed while it was held; it was not removed.");
  }
  const retained = readExecutionLockRecord(parentLease, name);
  if (
    !sameLockMetadata(retained.identity, held.identity) ||
    canonicalStudyJson(retained.record) !== canonicalStudyJson(held.record)
  ) {
    throw new TypeError("Study execution lock owner changed while it was held; it was not removed.");
  }
  unlinkSync(path);
  fsyncSync(parentLease.descriptor);
}

export function dataWranglerStudyExecutionLockPath(manifestPath) {
  const target = resolve(manifestPath);
  return resolve(dirname(target), `.${basename(target)}${EXECUTION_LOCK_SUFFIX}`);
}

async function acquireDataWranglerStudyExecutionLock(
  manifestPath,
  {
    platform = process.platform,
    pid = process.pid,
    now = () => new Date(),
    tokenFactory = randomUUID,
    bootIdReader = readLinuxBootId,
    processIdentityReader = readLinuxProcessIdentity,
    createSocketServer = createServer
  } = {}
) {
  if (platform !== "linux") {
    throw new Error("Data Wrangler study run-next execution is supported only on Linux.");
  }
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError("Study execution lock PID must be positive.");
  }
  const lockPath = dataWranglerStudyExecutionLockPath(manifestPath);
  const parentLease = openPrivateLockParent(dirname(lockPath));
  let socket;
  let held;
  try {
    socket = await acquireExecutionSocket(
      `${parentLease.identity.dev}:${parentLease.identity.ino}:${basename(lockPath)}`,
      createSocketServer
    );
    const bootId = bootIdReader();
    if (!UUID.test(bootId ?? "")) {
      throw new TypeError("Linux boot identity is unavailable or malformed.");
    }
    const self = processIdentityReader(pid);
    if (
      self === null ||
      !NON_NEGATIVE_INTEGER_TEXT.test(self.startTimeTicks ?? "") ||
      !/^\S$/u.test(self.state ?? "") ||
      ["X", "x", "Z"].includes(self.state)
    ) {
      throw new TypeError("The run-next process identity cannot be proven before lock acquisition.");
    }
    const name = basename(lockPath);
    try {
      held = createExecutionLockFile(parentLease, name, {
        protocol: DATA_WRANGLER_STUDY_EXECUTION_LOCK_PROTOCOL,
        pid,
        startTimeTicks: self.startTimeTicks,
        bootId: bootId.toLowerCase(),
        token: tokenFactory(),
        acquiredAtUtc: now().toISOString()
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readExecutionLockRecord(parentLease, name);
      if (classifyExecutionLockOwner(existing.record, bootId, processIdentityReader) !== "dead") {
        throw new Error(
          `Another run-next study execution owns the lock as PID ${existing.record.pid} with start time ${existing.record.startTimeTicks}.`
        );
      }
      removeProvenDeadExecutionLock(parentLease, name, existing);
      held = createExecutionLockFile(parentLease, name, {
        protocol: DATA_WRANGLER_STUDY_EXECUTION_LOCK_PROTOCOL,
        pid,
        startTimeTicks: self.startTimeTicks,
        bootId: bootId.toLowerCase(),
        token: tokenFactory(),
        acquiredAtUtc: now().toISOString()
      });
    }
    held.record = readExecutionLockRecord(parentLease, name).record;
    verifyPrivateLockParent(parentLease);
    return {
      async release() {
        const errors = [];
        try {
          verifyPrivateLockParent(parentLease);
          releaseExecutionLockFile(parentLease, basename(lockPath), held);
        } catch (error) {
          errors.push(error);
        }
        try {
          closeSync(held.descriptor);
        } catch (error) {
          errors.push(error);
        }
        try {
          verifyPrivateLockParent(parentLease);
        } catch (error) {
          errors.push(error);
        }
        try {
          closeSync(parentLease.descriptor);
        } catch (error) {
          errors.push(error);
        }
        try {
          await closeExecutionSocket(socket);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Study execution lock did not release cleanly.");
      }
    };
  } catch (error) {
    const cleanupErrors = [];
    if (held !== undefined) {
      try {
        closeSync(held.descriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      closeSync(parentLease.descriptor);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await closeExecutionSocket(socket);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length === 0) throw error;
    throw new AggregateError([error, ...cleanupErrors], "Study execution lock acquisition failed during cleanup.");
  }
}

async function withDataWranglerStudyExecutionLock(manifestPath, callback, options = {}) {
  const lock = await acquireDataWranglerStudyExecutionLock(manifestPath, options);
  let result;
  let operationError;
  try {
    result = await callback();
  } catch (error) {
    operationError = error;
  }
  let releaseError;
  try {
    await lock.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [operationError, releaseError],
      "Study run-next failed and its execution lock was not released."
    );
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result;
}

function requireRunNextPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be one non-empty filesystem path.`);
  }
  return resolve(value);
}

function isoTimestamp(now, label) {
  if (typeof now !== "function") {
    throw new TypeError("Study run-next clock must be a function.");
  }
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new TypeError(`${label} clock did not return a valid Date.`);
  }
  return value.toISOString();
}

function fragmentLedgerDigest(fragments) {
  return digestStudyValue(fragments.map((fragment) => digestStudyValue(fragment)));
}

export function manifestDeclaresDataWranglerPolarsUndetermined(manifest, entry) {
  if (entry.product !== "data-wrangler" || entry.engine !== "polars") return false;
  const fixture = manifest.fixtures.find((candidate) => candidate.format === entry.format);
  if (fixture === undefined) {
    throw new TypeError("The scheduled Data Wrangler Polars entry has no matching fixture.");
  }
  const capability = manifest.provenance.capabilities.find(
    (candidate) =>
      candidate.product === "data-wrangler" && candidate.engine === "polars" && candidate.fixtureId === fixture.id
  );
  if (capability === undefined) {
    throw new TypeError("The scheduled Data Wrangler Polars entry has no matching capability receipt.");
  }
  return capability.availability === "undetermined";
}

export async function runNextDataWranglerComparisonStudyTrial(
  { manifestPath, fragmentsDirectory, intentsDirectory } = {},
  {
    executeTrial,
    now = () => new Date(),
    runIdFactory = randomUUID,
    fragmentIdFactory = randomUUID,
    expectedEntryId,
    lockOptions = {},
    readOptions = {},
    publicationOptions = {}
  } = {}
) {
  const resolvedManifestPath = requireRunNextPath(manifestPath, "Study run-next manifest");
  const resolvedFragmentsDirectory = requireRunNextPath(fragmentsDirectory, "Study run-next fragment directory");
  const resolvedIntentsDirectory = requireRunNextPath(intentsDirectory, "Study run-next intent directory");
  if (typeof runIdFactory !== "function" || typeof fragmentIdFactory !== "function") {
    throw new TypeError("Study run-next identity factories must be functions.");
  }
  if (
    expectedEntryId !== undefined &&
    (typeof expectedEntryId !== "string" || expectedEntryId.length === 0 || /[\0\r\n]/u.test(expectedEntryId))
  ) {
    throw new TypeError("Study run-next expected entry ID must be one non-empty string.");
  }

  return await withDataWranglerStudyExecutionLock(
    resolvedManifestPath,
    async () => {
      const manifest = readDataWranglerStudyManifestPublication(resolvedManifestPath, readOptions.manifest);
      const manifestSha256 = digestStudyValue(manifest);
      const fragments = loadDataWranglerStudyFragments(resolvedFragmentsDirectory, manifest, readOptions.fragments);
      assertNoIndeterminateDataWranglerStudyAction({
        directory: resolvedIntentsDirectory,
        manifest,
        fragments,
        options: readOptions.intents
      });
      const next = pendingDataWranglerStudyTrials(manifest, fragments)[0];
      if (expectedEntryId !== undefined && next?.id !== expectedEntryId) {
        throw new Error(
          `Study run-next expected ${expectedEntryId}, but the durable ledger selected ${next?.id ?? "<complete>"}.`
        );
      }
      if (next === undefined) {
        return { command: "run-next", status: "complete", receipt: null, output: null };
      }
      if (manifestDeclaresDataWranglerPolarsUndetermined(manifest, next)) {
        throw new Error(
          "The Data Wrangler Polars capability check reached its deadline without a launch action. " +
            "That result is undetermined, so the study remains release-incomplete until a public action is observed or separate reviewed public evidence establishes that the surface is unsupported."
        );
      }

      const prepared = prepareDataWranglerStudyTrialIntent({
        directory: resolvedIntentsDirectory,
        manifest,
        fragments,
        runId: runIdFactory(),
        preparedAtUtc: isoTimestamp(now, "Study trial preparation"),
        options: publicationOptions.intentPreparation
      });
      let authorization;
      let expectedAuthorizedIntent;
      let acceptingAuthorization = true;
      const verifyCurrentLedger = () => {
        const currentManifest = readDataWranglerStudyManifestPublication(resolvedManifestPath, readOptions.manifest);
        const currentFragments = loadDataWranglerStudyFragments(
          resolvedFragmentsDirectory,
          currentManifest,
          readOptions.fragments
        );
        if (
          digestStudyValue(currentManifest) !== manifestSha256 ||
          fragmentLedgerDigest(currentFragments) !== fragmentLedgerDigest(fragments)
        ) {
          throw new Error("Study ledger changed before product-action authorization could be resolved.");
        }
        return { currentManifest, currentFragments };
      };
      const authorizeAction = (...arguments_) => {
        if (arguments_.length !== 0) {
          throw new TypeError("Study product-action authorization accepts no arguments.");
        }
        if (!acceptingAuthorization) {
          throw new Error("Study product-action authorization is no longer available for this execution.");
        }
        if (authorization !== undefined) {
          throw new Error("Study product action may be authorized only once.");
        }
        verifyCurrentLedger();
        const authorizedAtUtc = isoTimestamp(now, "Study product-action authorization");
        expectedAuthorizedIntent = Object.freeze({
          protocol: DATA_WRANGLER_STUDY_TRIAL_INTENT_PROTOCOL,
          stage: "action-authorized",
          runId: prepared.intent.runId,
          manifestSha256: prepared.intent.manifestSha256,
          executionIndex: prepared.intent.executionIndex,
          scheduleEntryId: prepared.intent.scheduleEntryId,
          attempt: prepared.intent.attempt,
          effectiveBlockId: prepared.intent.effectiveBlockId,
          product: prepared.intent.product,
          ledgerSha256: prepared.intent.ledgerSha256,
          preparedSha256: digestStudyValue(prepared.intent),
          authorizedAtUtc
        });
        authorization = authorizeDataWranglerStudyTrialAction({
          directory: resolvedIntentsDirectory,
          manifest,
          fragments,
          preparedIntent: prepared.intent,
          authorizedAtUtc,
          options: publicationOptions.actionAuthorization
        });
        return structuredClone(authorization);
      };
      const reinspectActionAuthorization = (...arguments_) => {
        if (arguments_.length !== 0) {
          throw new TypeError("Study product-action authorization reinspection accepts no arguments.");
        }
        if (!acceptingAuthorization) {
          throw new Error("Study product-action authorization reinspection is no longer available for this execution.");
        }
        if (authorization === undefined && expectedAuthorizedIntent !== undefined) {
          recoverDurableStudyJsonPublication(
            resolve(resolvedIntentsDirectory, `${expectedAuthorizedIntent.runId}.action-authorized.intent`),
            digestStudyValue(expectedAuthorizedIntent),
            { ...publicationOptions.actionAuthorization, parentLease: undefined }
          );
        }
        const { currentManifest, currentFragments } = verifyCurrentLedger();
        const inspection = inspectDataWranglerStudyTrialIntents({
          directory: resolvedIntentsDirectory,
          manifest: currentManifest,
          fragments: currentFragments,
          options: readOptions.intents
        });
        if (!Array.isArray(inspection?.unresolved)) {
          throw new Error("Study product-action authorization journal returned malformed evidence.");
        }
        if (inspection.unresolved.length === 0) {
          if (authorization !== undefined) {
            throw new Error("Study product-action authorization disappeared from its durable journal.");
          }
          return Object.freeze({ status: "not-authorized" });
        }
        if (inspection.unresolved.length !== 1) {
          throw new Error("Study product-action authorization journal is ambiguous.");
        }
        const intent = inspection.unresolved[0];
        if (
          intent.stage !== "action-authorized" ||
          intent.runId !== prepared.intent.runId ||
          intent.manifestSha256 !== prepared.intent.manifestSha256 ||
          intent.executionIndex !== prepared.intent.executionIndex ||
          intent.scheduleEntryId !== prepared.intent.scheduleEntryId ||
          intent.attempt !== prepared.intent.attempt ||
          intent.effectiveBlockId !== prepared.intent.effectiveBlockId ||
          intent.product !== prepared.intent.product ||
          intent.ledgerSha256 !== prepared.intent.ledgerSha256 ||
          intent.preparedSha256 !== digestStudyValue(prepared.intent)
        ) {
          throw new Error("Study product-action authorization journal does not match the prepared execution.");
        }
        if (authorization !== undefined && canonicalStudyJson(authorization.intent) !== canonicalStudyJson(intent)) {
          throw new Error("Study product-action authorization conflicts with its durable journal.");
        }
        if (authorization === undefined) {
          authorization = Object.freeze({
            intent: Object.freeze(structuredClone(intent)),
            publication: Object.freeze({ status: "recovered", sha256: digestStudyValue(intent) })
          });
        }
        return Object.freeze({ status: "authorized", authorization: structuredClone(authorization) });
      };

      let fragment;
      try {
        if (typeof executeTrial !== "function") {
          throw new TypeError("Study run-next requires an executeTrial function for a supported entry.");
        }
        fragment = await executeTrial({
          manifest: structuredClone(manifest),
          scheduleEntry: structuredClone(next),
          executionIndex: fragments.length,
          preparedIntent: structuredClone(prepared.intent),
          authorizeAction,
          reinspectActionAuthorization
        });
      } finally {
        acceptingAuthorization = false;
      }

      if (fragment?.outcome?.actionStarted === true && authorization === undefined) {
        throw new Error("Study executor reported a product action without durable authorization.");
      }
      if (authorization !== undefined && fragment?.outcome?.actionStarted !== true) {
        throw new Error("Study executor authorized a product action without retaining action-started evidence.");
      }
      validateDataWranglerStudyFragment(fragment, manifest);

      const currentManifest = readDataWranglerStudyManifestPublication(resolvedManifestPath, readOptions.manifest);
      const currentFragments = loadDataWranglerStudyFragments(
        resolvedFragmentsDirectory,
        currentManifest,
        readOptions.fragments
      );
      if (
        digestStudyValue(currentManifest) !== manifestSha256 ||
        fragmentLedgerDigest(currentFragments) !== fragmentLedgerDigest(fragments)
      ) {
        throw new Error("Study ledger changed while the trial was executing; its fragment was not published.");
      }
      const receipt = publishDataWranglerStudyFragment(
        resolvedFragmentsDirectory,
        fragment,
        manifest,
        publicationOptions.fragment
      );
      const published = loadDataWranglerStudyFragments(resolvedFragmentsDirectory, manifest, readOptions.fragments);
      if (
        published.length !== fragments.length + 1 ||
        canonicalStudyJson(published.at(-1)) !== canonicalStudyJson(fragment)
      ) {
        throw new Error("Study run-next did not publish one exact fragment.");
      }
      assertNoIndeterminateDataWranglerStudyAction({
        directory: resolvedIntentsDirectory,
        manifest,
        fragments: published,
        options: readOptions.intents
      });
      return { command: "run-next", status: "recorded", receipt, output: fragment };
    },
    { ...lockOptions, now: lockOptions.now ?? now }
  );
}

export function runDataWranglerComparisonStudy(
  argv,
  {
    cwd = process.cwd(),
    inputReadOptions = {},
    now = () => new Date(),
    publicationOptions = {},
    captureCacheToolchain = captureDataWranglerComparisonStudyV2Toolchain,
    captureMethodology = captureDataWranglerStudyMethodReceipt,
    readPreregistration = readDataWranglerComparisonPreregistration,
    assertCurrentPreregistration = assertCurrentDataWranglerComparisonPreregistration,
    loadPreparation = loadDataWranglerComparisonPreparationReceipt
  } = {}
) {
  const options = parseArguments(argv, cwd);
  if (options.command === "run-next") {
    throw new TypeError("Study run-next is asynchronous and must be invoked through the public CLI.");
  }
  if (options.command === "plan") {
    const specification = readBoundedJson(options.spec, "Study specification", inputReadOptions);
    const preregistration = readPreregistration(options.preregistration);
    assertCurrentPreregistration(preregistration);
    const preparation = loadPreparation(options.preparation);
    const preregistrationReceipt = createDataWranglerComparisonPreregistrationReceipt(preregistration);
    if (
      preparation.preregistrationPath !== options.preregistration ||
      preparation.preregistrationSha256 !== digestStudyValue(preregistration) ||
      preparation.specificationPath !== options.spec ||
      preparation.specificationSha256 !== digestStudyValue(specification) ||
      preparation.manifestPath !== options.out ||
      canonicalStudyJson(preparation.specification) !== canonicalStudyJson(specification) ||
      canonicalStudyJson(specification?.preregistration) !== canonicalStudyJson(preregistrationReceipt)
    ) {
      throw new Error("Study plan is not authorized by the exact preregistration and preparation journal.");
    }
    if (typeof captureCacheToolchain !== "function" || typeof captureMethodology !== "function") {
      throw new TypeError("Study plan methodology and cache-toolchain capture must be functions.");
    }
    const observedMethod = captureMethodology();
    if (canonicalStudyJson(specification?.method) !== canonicalStudyJson(observedMethod)) {
      throw new Error("Study specification methodology does not match the checked-in reviewed document.");
    }
    const observedCacheToolchain = captureCacheToolchain({
      controllerPath: options.cacheController,
      pythonExecutablePath: options.python
    });
    const suppliedCacheToolchain = specification?.provenance?.cacheToolchain;
    if (
      suppliedCacheToolchain !== undefined &&
      canonicalStudyJson(suppliedCacheToolchain) !== canonicalStudyJson(observedCacheToolchain)
    ) {
      throw new Error("Study specification source-cache toolchain does not match the plan-time observed files.");
    }
    const preparedSpecification = structuredClone(specification);
    if (
      preparedSpecification === null ||
      typeof preparedSpecification !== "object" ||
      Array.isArray(preparedSpecification) ||
      preparedSpecification.provenance === null ||
      typeof preparedSpecification.provenance !== "object" ||
      Array.isArray(preparedSpecification.provenance)
    ) {
      throw new TypeError("Study specification provenance must be an object.");
    }
    preparedSpecification.provenance.cacheToolchain = structuredClone(observedCacheToolchain);
    const manifest = buildDataWranglerStudyManifest(preparedSpecification);
    if (digestStudyValue(manifest) !== preparation.manifestSha256) {
      throw new Error("Study plan does not reconstruct the manifest authorized by preparation.");
    }
    return {
      command: options.command,
      receipt: writeDataWranglerStudyJsonExclusive(options.out, manifest, publicationOptions.manifest),
      output: manifest
    };
  }
  const manifest = readDataWranglerStudyManifestPublication(options.manifest);
  if (options.command === "record") {
    const fragment = validateDataWranglerStudyFragment(
      readBoundedJson(options.fragment, "Study fragment input", inputReadOptions),
      manifest
    );
    return {
      command: options.command,
      receipt: publishDataWranglerStudyFragment(options.fragments, fragment, manifest, publicationOptions.fragment),
      output: fragment
    };
  }
  const fragments = loadDataWranglerStudyFragments(options.fragments, manifest);
  if (options.command === "status") {
    const pending = pendingDataWranglerStudyTrials(manifest, fragments);
    return {
      command: options.command,
      receipt: null,
      output: {
        manifestSha256: digestStudyValue(manifest),
        fragmentCount: fragments.length,
        pendingCount: pending.length,
        pending
      }
    };
  }
  const pending = pendingDataWranglerStudyTrials(manifest, fragments);
  if (pending.length !== 0) {
    throw new Error("Study result cannot be finalized while planned pair work remains.");
  }
  const intent = createOrLoadDataWranglerStudyFinalizationIntent({
    outputPath: options.out,
    manifest,
    fragments,
    finalizedAtUtc: now().toISOString(),
    publicationOptions: publicationOptions.finalizationIntent
  });
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: intent.finalizedAtUtc
  });
  validateDataWranglerStudyResultEvidence({ manifest, fragments, result });
  return {
    command: options.command,
    receipt: writeDataWranglerStudyJsonExclusive(options.out, result, publicationOptions.result),
    output: result
  };
}

export async function runDataWranglerComparisonStudyCli(arguments_ = process.argv.slice(2)) {
  const parsed = parseArguments(arguments_);
  const result =
    parsed.command === "run-next"
      ? await import("./run-data-wrangler-comparison-prepared.mjs").then(({ runPreparedDataWranglerComparisonEntry }) =>
          runPreparedDataWranglerComparisonEntry({
            manifestPath: parsed.manifest,
            fragmentsDirectory: parsed.fragments,
            intentsDirectory: parsed.intents,
            preparationPath: parsed.preparation
          })
        )
      : runDataWranglerComparisonStudy(arguments_);
  process.stdout.write(
    canonicalStudyJson({
      command: result.command,
      receipt: result.receipt === null ? null : { sha256: result.receipt.sha256 },
      output: result.output
    })
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDataWranglerComparisonStudyCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments as parseDataWranglerComparisonStudyArguments };
